/**
 * Test Suite for Task P3-02: Asset Ingestion Pipeline & Security Guards.
 *
 * Scope & Acceptance:
 *   - Signed upload / quarantine / complete / probe / normalize / ready pipeline
 *   - Size / hash / rights / font / SVG / image / media guards
 *   - Malformed media does NOT escape sandbox
 *   - Foreign asset returns 404 NOT_FOUND (never 403) across all endpoints
 *   - Idempotency replay and conflict handling
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { loadEnvConfig, canonicalizeJson } from '@creativanta/contracts';
import {
  MigrationRunner,
  QuarantineStore,
  SYSTEM_CATALOG_TENANT_ID,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  generateApiKeyMaterial,
} from '../dist/index.js';

import { DatabaseSync } from 'node:sqlite';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'test_pepper_0123456789abcdef0123456789abcdef';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// -----------------------------------------------------------------------------
// Binary Fixture Generators
// -----------------------------------------------------------------------------

function buildValidPng(width = 100, height = 100) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // length
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // bit depth
  ihdr.writeUInt8(6, 17); // color type RGBA
  ihdr.writeUInt8(0, 18); // compression
  ihdr.writeUInt8(0, 19); // filter
  ihdr.writeUInt8(0, 20); // interlace
  ihdr.writeUInt32BE(0x12345678, 21); // crc placeholder

  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  ]);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

  return Buffer.concat([header, ihdr, idat, iend]);
}

function buildValidTtfFont() {
  // Valid sfnt header: 0x00010000, 5 tables: cmap, head, hhea, hmtx, maxp
  const numTables = 5;
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0); // sfntVersion
  header.writeUInt16BE(numTables, 4);  // numTables
  header.writeUInt16BE(64, 6);         // searchRange
  header.writeUInt16BE(2, 8);          // entrySelector
  header.writeUInt16BE(16, 10);        // rangeShift

  const tables = ['cmap', 'head', 'hhea', 'hmtx', 'maxp'];
  const tableDir = Buffer.alloc(numTables * 16);
  const tableDataList = [];

  let currentOffset = 12 + numTables * 16;
  for (let i = 0; i < numTables; i++) {
    const tag = tables[i];
    const data = Buffer.alloc(32, i + 1); // 32 bytes mock table data
    tableDir.write(tag, i * 16, 'ascii');
    tableDir.writeUInt32BE(0x11111111, i * 16 + 4); // checksum
    tableDir.writeUInt32BE(currentOffset, i * 16 + 8); // offset
    tableDir.writeUInt32BE(data.length, i * 16 + 12);  // length
    tableDataList.push(data);
    currentOffset += data.length;
  }

  return Buffer.concat([header, tableDir, ...tableDataList]);
}

function buildValidMp4() {
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii');
  ftyp.writeUInt32BE(512, 12);
  ftyp.write('isom', 16, 'ascii');
  ftyp.write('iso2', 20, 'ascii');

  const moov = Buffer.alloc(16);
  moov.writeUInt32BE(16, 0);
  moov.write('moov', 4, 'ascii');

  return Buffer.concat([ftyp, moov]);
}

function buildValidWav() {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32BE(36, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32BE(16, 16); // subchunk1 size
  buf.writeUInt16LE(1, 20);  // PCM format
  buf.writeUInt16LE(2, 22);  // 2 channels
  buf.writeUInt32LE(44100, 24); // sample rate
  buf.writeUInt32LE(176400, 28); // byte rate
  buf.writeUInt16LE(4, 32);  // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32BE(0, 40);
  return buf;
}

describe('P3-02: Asset Ingestion Pipeline & Security Guards', () => {
  let db;
  let pool;
  let repo;
  let server;
  let baseUrl;
  let tempStorageDir;
  let quarantineStore;

  let tenantAKey;
  let tenantBKey;

  before(async () => {
    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p3-02-test-'));
    quarantineStore = new QuarantineStore(tempStorageDir);

    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 4 });
    repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

    repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
    repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

    tenantAKey = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha',
      scopes: ['assets:read', 'assets:write', 'jobs:read', 'jobs:write'],
    }).plaintextKey;

    tenantBKey = repo.issueApiKey({
      tenantId: TENANT_B_ID,
      keyId: 'key_beta',
      scopes: ['assets:read', 'assets:write', 'jobs:read', 'jobs:write'],
    }).plaintextKey;

    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });

    server = createServer({
      config,
      repository: repo,
      quarantineStore,
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    db.close();
    try {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Full Ingestion Lifecycle: Upload -> Quarantine -> Complete -> Ready
  // ---------------------------------------------------------------------------
  describe('1. Full Lifecycle Pipeline (PNG Image)', () => {
    const pngBuffer = buildValidPng(100, 100);
    const pngSha256 = sha256Hex(pngBuffer);
    let assetId;
    let uploadUrl;

    it('1.1 POST /v1/assets/uploads creates asset in uploading status and returns signed grant', async () => {
      const payload = {
        filename: 'product-hero.png',
        mime_type: 'image/png',
        bytes: pngBuffer.length,
        sha256: pngSha256,
        rights: {
          basis: 'owned',
          source: 'Internal Brand Kit',
          attribution: 'Acme Corp',
        },
      };

      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-upload-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 201);
      const body = await res.json();

      assert.ok(body.asset_id.startsWith('ast_'));
      assert.strictEqual(body.upload_method, 'PUT');
      assert.ok(body.upload_url.includes('/assets/upload-quarantine/'));
      assert.strictEqual(body.required_headers['content-type'], 'image/png');
      assert.ok(Date.parse(body.expires_at) > Date.now());
      assert.strictEqual(body.max_bytes, 104857600);

      assetId = body.asset_id;
      uploadUrl = body.upload_url;

      // Verify asset state in DB
      const asset = repo.getAsset(TENANT_A_ID, assetId);
      assert.strictEqual(asset.status, 'uploading');
      assert.strictEqual(asset.filename, 'product-hero.png');
      assert.strictEqual(asset.mime_type, 'image/png');
      assert.strictEqual(asset.bytes, pngBuffer.length);
    });

    it('1.2 Idempotency: replaying POST /v1/assets/uploads returns identical response with header', async () => {
      const payload = {
        filename: 'product-hero.png',
        mime_type: 'image/png',
        bytes: pngBuffer.length,
        sha256: pngSha256,
        rights: {
          basis: 'owned',
          source: 'Internal Brand Kit',
          attribution: 'Acme Corp',
        },
      };

      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-upload-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.headers.get('idempotency-replayed'), 'true');
      const body = await res.json();
      assert.strictEqual(body.asset_id, assetId);
    });

    it('1.3 POST /v1/assets/{id}/upload-url refreshes the signed upload grant', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${assetId}/upload-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-refresh-001',
        },
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.upload_url.includes('/assets/upload-quarantine/'));
      assert.ok(Date.parse(body.expires_at) > Date.now());
      assert.strictEqual(body.required_headers['content-type'], 'image/png');
      uploadUrl = body.upload_url; // Use refreshed URL
    });

    it('1.4 PUT to upload_url streams bytes into quarantine storage', async () => {
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(pngBuffer.length),
        },
        body: pngBuffer,
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'uploaded');
      assert.strictEqual(body.asset_id, assetId);
      assert.strictEqual(body.bytes, pngBuffer.length);
      assert.strictEqual(body.sha256, pngSha256);

      // Quarantine store has the file
      const q = quarantineStore.getQuarantined(TENANT_A_ID, assetId);
      assert.ok(q);
      assert.strictEqual(q.bytes, pngBuffer.length);
      assert.strictEqual(q.sha256, pngSha256);
    });

    it('1.5 POST /v1/assets/{id}/complete probes image and transitions to ready', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${assetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-complete-001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: pngSha256 }),
      });

      const body = await res.json();
      assert.strictEqual(res.status, 202);
      assert.strictEqual(body.id, assetId);
      assert.strictEqual(body.status, 'ready');

      // Verify asset in DB
      const asset = repo.getAsset(TENANT_A_ID, assetId);
      assert.strictEqual(asset.status, 'ready');
      assert.deepStrictEqual(asset.metadata, {
        mimeType: 'image/png',
        width: 100,
        height: 100,
        format: 'png',
      });
    });

    it('1.6 GET /v1/assets/{id} returns ready status with safe metadata', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${assetId}`, {
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
        },
      });

      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.id, assetId);
      assert.strictEqual(body.status, 'ready');
      assert.strictEqual(body.filename, 'product-hero.png');
      assert.strictEqual(body.mime_type, 'image/png');
      assert.strictEqual(body.bytes, pngBuffer.length);
      assert.strictEqual(body.sha256, pngSha256);
      assert.strictEqual(body.metadata.width, 100);
      assert.strictEqual(body.metadata.height, 100);
    });

    it('1.7 Repeated POST complete on ready asset returns 409 REVISION_CONFLICT', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${assetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-complete-new',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: pngSha256 }),
      });

      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'REVISION_CONFLICT');
    });

    it('1.8 Repeated POST upload-url on ready asset returns 409 REVISION_CONFLICT', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${assetId}/upload-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-refresh-new',
        },
      });

      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'REVISION_CONFLICT');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Foreign Asset 404 Isolation (AMB-007)
  // ---------------------------------------------------------------------------
  describe('2. Foreign Asset 404 Guarantee (AMB-007: Path 404 vs Body 422)', () => {
    let foreignAssetId;

    before(async () => {
      // Create asset owned by Tenant A
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-foreign-init',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'alpha-private.png',
          mime_type: 'image/png',
          bytes: 100,
          sha256: 'a'.repeat(64),
          rights: { basis: 'owned', source: 'Internal', attribution: 'Alpha' },
        }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      foreignAssetId = body.asset_id;
    });

    it('2.1 Tenant B probing Tenant A asset ID via GET returns 404 NOT_FOUND (never 403)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${foreignAssetId}`, {
        headers: { Authorization: `Bearer ${tenantBKey}` },
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('2.2 Tenant B probing Tenant A asset ID via POST upload-url returns 404 NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${foreignAssetId}/upload-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantBKey}`,
          'Idempotency-Key': 'idem-probe-b1',
        },
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('2.3 Tenant B probing Tenant A asset ID via POST complete returns 404 NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${foreignAssetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantBKey}`,
          'Idempotency-Key': 'idem-probe-b2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: 'a'.repeat(64) }),
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('2.4 Tenant B probing Tenant A asset ID via DELETE returns 404 NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${foreignAssetId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tenantBKey}` },
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('2.5 Forged or tampered upload grant token is rejected with 403 INVALID_GRANT_SIGNATURE', async () => {
      const fakeToken = Buffer.from(
        JSON.stringify({
          tenantId: TENANT_A_ID,
          assetId: foreignAssetId,
          filename: 'alpha-private.png',
          mimeType: 'image/png',
          sha256: 'a'.repeat(64),
          declaredBytes: 100,
          maxBytes: 1000,
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          sig: 'bad_signature_hex_0123456789abcdef0123456789abcdef0123456789abcdef',
        }),
      ).toString('base64url');

      const res = await fetch(`${baseUrl}/v1/assets/upload-quarantine/${fakeToken}`, {
        method: 'PUT',
        body: Buffer.from('hello'),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_GRANT_SIGNATURE');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Size Guards & Bounds Enforcement
  // ---------------------------------------------------------------------------
  describe('3. Size Guards & Limits Enforcement (docs/SECURITY.md)', () => {
    it('3.1 Rejects upload request with bytes > 100 MiB (413 PAYLOAD_TOO_LARGE)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-size-101mib',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'huge.mp4',
          mime_type: 'video/mp4',
          bytes: 105 * 1024 * 1024, // 105 MiB
          sha256: 'b'.repeat(64),
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });

      assert.strictEqual(res.status, 413);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'PAYLOAD_TOO_LARGE');
    });

    it('3.2 Rejects font upload with bytes > 32 MiB (413 OVERSIZED_FONT)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-font-33mib',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'huge-font.ttf',
          mime_type: 'font/ttf',
          bytes: 34 * 1024 * 1024, // 34 MiB
          sha256: 'c'.repeat(64),
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });

      assert.strictEqual(res.status, 413);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'OVERSIZED_FONT');
    });

    it('3.3 Rejects SVG upload with bytes > 5 MiB (413 OVERSIZED_SVG)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-svg-6mib',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'huge-vector.svg',
          mime_type: 'image/svg+xml',
          bytes: 6 * 1024 * 1024, // 6 MiB
          sha256: 'd'.repeat(64),
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });

      assert.strictEqual(res.status, 413);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'OVERSIZED_SVG');
    });

    it('3.4 PUT stream exceeding maxBytes is aborted with 413 PAYLOAD_TOO_LARGE', async () => {
      // Create grant for 100 bytes
      const res1 = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-stream-limit',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'small.png',
          mime_type: 'image/png',
          bytes: 100,
          sha256: 'e'.repeat(64),
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      assert.strictEqual(res1.status, 201);
      const grant = await res1.json();

      // Attempt PUT with 105 MiB Content-Length header using http.request
      const parsed = new URL(grant.upload_url);
      const res2 = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'PUT',
            headers: {
              'Content-Length': String(105 * 1024 * 1024),
              'Content-Type': 'image/png',
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => {
              data += c;
            });
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode, body: JSON.parse(data) });
              } catch (e) {
                reject(e);
              }
            });
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.strictEqual(res2.status, 413);
      assert.strictEqual(res2.body.error.code, 'PAYLOAD_TOO_LARGE');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Checksum & Byte Count Integrity Mismatch Guards
  // ---------------------------------------------------------------------------
  describe('4. Checksum & Byte Count Mismatch Guards', () => {
    it('4.1 Marks asset as rejected when uploaded SHA-256 does not match complete declaration', async () => {
      const validBuf = buildValidPng(50, 50);
      const declaredSha = '1'.repeat(64);

      // Create upload session
      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-mismatch-hash',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'mismatch.png',
          mime_type: 'image/png',
          bytes: validBuf.length,
          sha256: declaredSha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      // PUT actual buffer (which has different sha256)
      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: validBuf,
      });

      // Complete with declaredSha
      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-mismatch-comp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: declaredSha }),
      });

      assert.strictEqual(compRes.status, 202);
      const compBody = await compRes.json();
      assert.strictEqual(compBody.status, 'rejected');

      const asset = repo.getAsset(TENANT_A_ID, grant.asset_id);
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'CHECKSUM_MISMATCH');
    });

    it('4.2 Marks asset as rejected when uploaded byte count does not match declared bytes', async () => {
      const validBuf = buildValidPng(50, 50);
      const actualSha = sha256Hex(validBuf);

      // Create upload session declaring 99999 bytes
      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-mismatch-bytes',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'mismatch-bytes.png',
          mime_type: 'image/png',
          bytes: 99999, // Wrong byte count!
          sha256: actualSha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      // PUT actual buffer
      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: validBuf,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-mismatch-bytes-comp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: actualSha }),
      });

      assert.strictEqual(compRes.status, 202);
      const compBody = await compRes.json();
      assert.strictEqual(compBody.status, 'rejected');

      const asset = repo.getAsset(TENANT_A_ID, grant.asset_id);
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'BYTE_COUNT_MISMATCH');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Rights Metadata Guards
  // ---------------------------------------------------------------------------
  describe('5. Rights Metadata Guards', () => {
    it('5.1 Rejects invalid rights basis (422 VALIDATION_FAILED)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-bad-rights-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'bad.png',
          mime_type: 'image/png',
          bytes: 100,
          sha256: '2'.repeat(64),
          rights: {
            basis: 'pirated', // INVALID!
            source: 'Dark Web',
            attribution: 'Unknown',
          },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'INVALID_RIGHTS_BASIS'));
    });

    it('5.2 Rejects expired license rights (422 VALIDATION_FAILED)', async () => {
      const pastDate = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-bad-rights-2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'expired.png',
          mime_type: 'image/png',
          bytes: 100,
          sha256: '3'.repeat(64),
          rights: {
            basis: 'licensed',
            source: 'Shutterstock',
            attribution: 'Creator',
            expires_at: pastDate,
          },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'RIGHTS_EXPIRED'));
    });
  });

  // ---------------------------------------------------------------------------
  // 6. SVG Security Guards & Malformed Sanitizer
  // ---------------------------------------------------------------------------
  describe('6. SVG Security Guards & Sanitization (docs/SECURITY.md lines 57-58)', () => {
    async function uploadAndCompleteSvg(svgText, testName) {
      const buf = Buffer.from(svgText, 'utf8');
      const sha = sha256Hex(buf);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-svg-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: `${testName}.svg`,
          mime_type: 'image/svg+xml',
          bytes: buf.length,
          sha256: sha,
          rights: { basis: 'public_domain', source: 'SVG Test', attribution: 'Test' },
        }),
      });
      assert.strictEqual(upRes.status, 201);
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/svg+xml' },
        body: buf,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-svg-comp-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      return repo.getAsset(TENANT_A_ID, grant.asset_id);
    }

    it('6.1 Rejects SVG with XXE <!DOCTYPE / <!ENTITY declaration', async () => {
      const svg = `<?xml version="1.0"?>
<!DOCTYPE svg [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'xxe');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'XXE_HAZARD');
    });

    it('6.2 Rejects SVG with dangerous <script> tag', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="10"/></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'script-tag');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'FORBIDDEN_TAG');
    });

    it('6.3 Rejects SVG with dangerous <foreignObject> tag', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="50"><div>pwn</div></foreignObject></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'foreign-object');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'FORBIDDEN_TAG');
    });

    it('6.4 Rejects SVG with inline event handler (onload)', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('http://evil.com')"><rect width="10" height="10"/></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'inline-handler');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'INLINE_EVENT_HANDLER');
    });

    it('6.5 Rejects SVG with external href reference (SSRF vector)', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://internal.metadata.invalid/secret.png"/></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'external-href');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'EXTERNAL_HREF');
    });

    it('6.6 Rejects SVG with external CSS @import rule', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url('https://evil.com/style.css');</style></svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'css-import');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'EXTERNAL_CSS');
    });

    it('6.7 Rejects SVG exceeding nesting depth of 16', async () => {
      let nested = '<circle r="5"/>';
      for (let i = 0; i < 20; i++) {
        nested = `<g id="level-${i}">${nested}</g>`;
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg">${nested}</svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'tree-depth');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'TREE_DEPTH_LIMIT_EXCEEDED');
    });

    it('6.8 Accepts clean, safe SVG with valid shapes and Vietnamese labels', async () => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#101828"/>
  <circle cx="50" cy="50" r="40" fill="#3B82F6"/>
  <text x="50" y="55" font-size="12" fill="#FFFFFF" text-anchor="middle">Sáng tạo Việt</text>
</svg>`;
      const asset = await uploadAndCompleteSvg(svg, 'clean-vietnamese');
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.metadata.sanitized, true);
      assert.ok(asset.metadata.nodeCount > 0);
      assert.ok(asset.metadata.maxDepth <= 16);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Font Security Guards (TTF/OTF/WOFF2)
  // ---------------------------------------------------------------------------
  describe('7. Font Security Guards & Table Integrity', () => {
    async function uploadAndCompleteFont(buffer, testName, mimeType = 'font/ttf') {
      const sha = sha256Hex(buffer);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-font-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: `${testName}.ttf`,
          mime_type: mimeType,
          bytes: buffer.length,
          sha256: sha,
          rights: { basis: 'licensed', source: 'OFL 1.1', attribution: 'Google Fonts' },
        }),
      });
      assert.strictEqual(upRes.status, 201);
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: buffer,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-font-comp-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      return repo.getAsset(TENANT_A_ID, grant.asset_id);
    }

    it('7.1 Rejects font with invalid magic bytes', async () => {
      const badBuf = Buffer.from('NOT_A_VALID_FONT_SIGNATURE_AT_ALL');
      const asset = await uploadAndCompleteFont(badBuf, 'bad-magic');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'INVALID_FONT_SIGNATURE');
    });

    it('7.2 Rejects font with table offset extending beyond file size (out-of-bounds table)', async () => {
      const ttf = buildValidTtfFont();
      // Corrupt offset of first table (byte 12 + 8) to point beyond end of file
      ttf.writeUInt32BE(ttf.length + 5000, 20);
      const asset = await uploadAndCompleteFont(ttf, 'oob-table');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'MALFORMED_FONT');
    });

    it('7.3 Rejects font missing essential table (e.g. cmap)', async () => {
      const ttf = buildValidTtfFont();
      // Rename 'cmap' table to 'xxxx'
      ttf.write('xxxx', 12, 'ascii');
      const asset = await uploadAndCompleteFont(ttf, 'missing-cmap');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'MISSING_FONT_TABLE');
    });

    it('7.4 Accepts valid TrueType font with required tables', async () => {
      const ttf = buildValidTtfFont();
      const asset = await uploadAndCompleteFont(ttf, 'valid-ttf');
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.metadata.format, 'ttf');
      assert.strictEqual(asset.metadata.numTables, 5);
      assert.ok(asset.metadata.tables.includes('cmap'));
      assert.ok(asset.metadata.tables.includes('head'));
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Image Dimension & Pixel Guards (40MP / 8192px)
  // ---------------------------------------------------------------------------
  describe('8. Image Dimensions & Pixel Guards (docs/SECURITY.md lines 56-58)', () => {
    async function uploadAndCompleteImg(buffer, testName) {
      const sha = sha256Hex(buffer);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-img-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: `${testName}.png`,
          mime_type: 'image/png',
          bytes: buffer.length,
          sha256: sha,
          rights: { basis: 'owned', source: 'Camera', attribution: 'Alpha' },
        }),
      });
      assert.strictEqual(upRes.status, 201);
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: buffer,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': `idem-img-comp-${testName}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      return repo.getAsset(TENANT_A_ID, grant.asset_id);
    }

    it('8.1 Rejects image with dimension > 8192 px (e.g. 9000x100)', async () => {
      const hugePng = buildValidPng(9000, 100);
      const asset = await uploadAndCompleteImg(hugePng, 'dim-9000');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'DIMENSION_LIMIT_EXCEEDED');
    });

    it('8.2 Rejects image with total pixels > 40 MP (e.g. 8000x6000 = 48 MP)', async () => {
      const hugePng = buildValidPng(8000, 6000);
      const asset = await uploadAndCompleteImg(hugePng, 'pixels-48mp');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'PIXEL_COUNT_EXCEEDED');
    });

    it('8.3 Rejects malformed image missing SOF or truncated IHDR', async () => {
      const corrupted = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);
      const asset = await uploadAndCompleteImg(corrupted, 'corrupt-png');
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'MALFORMED_IMAGE');
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Sandbox Probing: Malformed Media Does NOT Escape
  // ---------------------------------------------------------------------------
  describe('9. Sandbox Probing: Malformed Media Trap (docs/SECURITY.md line 39)', () => {
    it('9.1 Rejects malformed MP4 missing ftyp atom in sandbox', async () => {
      const badMp4 = Buffer.from('NOT_AN_MP4_CORRUPT_BYTES_FOR_SANDBOX_TESTING');
      const sha = sha256Hex(badMp4);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-bad-mp4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'corrupted.mp4',
          mime_type: 'video/mp4',
          bytes: badMp4.length,
          sha256: sha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        body: badMp4,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-bad-mp4-comp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      const asset = repo.getAsset(TENANT_A_ID, grant.asset_id);
      assert.strictEqual(asset.status, 'rejected');
      assert.strictEqual(asset.metadata.error, 'INVALID_MEDIA_SIGNATURE');
    });

    it('9.2 Probes valid MP4 container in sandbox and marks ready', async () => {
      const mp4 = buildValidMp4();
      const sha = sha256Hex(mp4);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-valid-mp4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'valid.mp4',
          mime_type: 'video/mp4',
          bytes: mp4.length,
          sha256: sha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'video/mp4' },
        body: mp4,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-valid-mp4-comp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      const asset = repo.getAsset(TENANT_A_ID, grant.asset_id);
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.metadata.format, 'mp4');
    });

    it('9.3 Probes valid WAV audio container in sandbox and marks ready', async () => {
      const wav = buildValidWav();
      const sha = sha256Hex(wav);

      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-valid-wav',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'valid.wav',
          mime_type: 'audio/wav',
          bytes: wav.length,
          sha256: sha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      await fetch(grant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });

      const compRes = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-valid-wav-comp',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: sha }),
      });

      assert.strictEqual(compRes.status, 202);
      const asset = repo.getAsset(TENANT_A_ID, grant.asset_id);
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.metadata.format, 'wav');
    });
  });

  // ---------------------------------------------------------------------------
  // 10. Remote Import Connector Flag & Deletion Cascade
  // ---------------------------------------------------------------------------
  describe('10. Remote Import Connector Flag & Asset Deletion', () => {
    it('10.1 POST /v1/assets/imports returns 403 CAPABILITY_DISABLED when disabled by policy', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-import-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/clip.mp4',
          expected_sha256: '0'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'CAPABILITY_DISABLED');
    });

    it('10.2 DELETE /v1/assets/{id} cascades deletion and repeated DELETE returns 202', async () => {
      // Create asset
      const png = buildValidPng(10, 10);
      const sha = sha256Hex(png);
      const upRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-del-test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'to-delete.png',
          mime_type: 'image/png',
          bytes: png.length,
          sha256: sha,
          rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
        }),
      });
      const grant = await upRes.json();

      // First DELETE
      const del1 = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(del1.status, 202);
      const body1 = await del1.json();
      assert.strictEqual(body1.status, 'deleted');

      // Repeated DELETE returns 202
      const del2 = await fetch(`${baseUrl}/v1/assets/${grant.asset_id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(del2.status, 202);
      const body2 = await del2.json();
      assert.strictEqual(body2.status, 'deleted');

      // Storage cleaned up
      assert.strictEqual(quarantineStore.getQuarantined(TENANT_A_ID, grant.asset_id), null);
    });
  });
});
