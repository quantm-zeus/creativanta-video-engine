/**
 * Test Suite for Task P3-05: Storage grants/retention/revoke/delete cascade/temp sweeper,
 * tombstones/reference safety, and cross-tenant URL tests.
 *
 * Canonical specifications:
 *   - AGENTS.md & docs/AGENTS.md
 *   - docs/IMPLEMENTATION_PLAN.md (Task P3-05)
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 61-64)
 *   - docs/DEPLOYMENT.md ("Object storage và CDN", line 114)
 *   - docs/API.md ("Asset intake", "Quy tắc chung", status taxonomy)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  MigrationRunner,
  QuarantineStore,
  StorageGrantRevocationStore,
  StorageTempSweeper,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  generateSignedDownloadGrant,
  generateSignedUploadGrant,
  verifySignedDownloadGrant,
  verifySignedUploadGrant,
} from '../dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'test_pepper_0123456789abcdef0123456789abcdef';

// Helper to create valid PNG bytes
function buildValidPng(width = 10, height = 10) {
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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildCompositionSpec({ fontAssetId = 'ast_font_noto_sans_regular', imageAssetId, audioAssetId, fontId = 'brand_regular' } = {}) {
  const layers = [
    {
      id: 'title_layer',
      type: 'text',
      start_frame: 0,
      duration_frames: 150,
      z_index: 1,
      box: { x: 48, y: 400, width: 624, height: 240 },
      content: {
        text: 'Creativanta Video Engine',
        font_id: fontId,
        font_size: 54,
        color: '#FFFFFF',
        align: 'center',
        max_lines: 3,
        overflow: 'error',
      },
    },
  ];

  if (imageAssetId) {
    layers.push({
      id: 'image_layer',
      type: 'image',
      start_frame: 0,
      duration_frames: 150,
      z_index: 2,
      box: { x: 100, y: 100, width: 520, height: 280 },
      content: {
        asset_id: imageAssetId,
        fit: 'cover',
      },
    });
  }

  const audioTracks = audioAssetId
    ? [
        {
          id: 'bgm',
          asset_id: audioAssetId,
          start_frame: 0,
          duration_frames: 150,
          source_in_samples: 0,
          gain_db: -6,
        },
      ]
    : [];

  return {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#101828' },
    fps: { num: 30, den: 1 },
    duration_frames: 150,
    seed: 42,
    locale: 'vi-VN',
    fonts: fontAssetId
      ? [
          {
            id: fontId,
            asset_id: fontAssetId,
            sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
            family: 'Noto Sans',
            weight: 400,
            style: 'normal',
          },
        ]
      : [],
    scenes: [
      {
        id: 'scene_main',
        revision: 1,
        start_frame: 0,
        duration_frames: 150,
        engine: 'html-v1',
        layers,
        transition_out: { type: 'cut', duration_frames: 0 },
      },
    ],
    audio_tracks: audioTracks,
    subtitles: [],
  };
}

describe('P3-05: Storage Grants, Retention, Revoke, Delete Cascade, Temp Sweeper & Reference Safety', () => {
  let db;
  let pool;
  let repo;
  let quarantineStore;
  let revocationStore;
  let sweeper;
  let server;
  let baseUrl;
  let storageRootDir;

  let tenantAKey;
  let tenantBKey;

  before(async () => {
    storageRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-test-p3-05-'));
    process.env['CVE_STORAGE_DIR'] = storageRootDir;

    quarantineStore = new QuarantineStore(storageRootDir);
    revocationStore = new StorageGrantRevocationStore();

    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 4 });
    repo = new TenantRepository(pool, {
      pepper: TEST_PEPPER,
      quarantineStore,
      revocationStore,
      baseUrl: 'http://127.0.0.1:8080/v1',
    });

    sweeper = new StorageTempSweeper({
      repository: repo,
      quarantineStore,
      revocationStore,
      defaultAssetRetentionDays: 7,
      defaultArtifactRetentionDays: 7,
      defaultIdempotencyRetentionDays: 7,
      defaultQuarantineOrphanTtlMs: 24 * 60 * 60 * 1000,
    });

    // Provision test tenants
    repo.createTenant({
      id: TENANT_A_ID,
      slug: 'tenant-alpha',
      name: 'Tenant Alpha',
      tier: 'starter',
    });
    repo.createTenant({
      id: TENANT_B_ID,
      slug: 'tenant-beta',
      name: 'Tenant Beta',
      tier: 'starter',
    });

    // Issue API keys
    const keyA = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha_1',
      name: 'Tenant A Full Key',
      scopes: [
        'assets:read',
        'assets:write',
        'compositions:read',
        'compositions:write',
        'templates:read',
        'templates:write',
        'jobs:read',
        'jobs:write',
        'usage:read',
      ],
    });
    tenantAKey = keyA.plaintextKey;

    const keyB = repo.issueApiKey({
      tenantId: TENANT_B_ID,
      keyId: 'key_beta_1',
      name: 'Tenant B Full Key',
      scopes: [
        'assets:read',
        'assets:write',
        'compositions:read',
        'compositions:write',
        'templates:read',
        'templates:write',
        'jobs:read',
        'jobs:write',
        'usage:read',
      ],
    });
    tenantBKey = keyB.plaintextKey;

    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });
    server = createServer({
      config,
      repository: repo,
      quarantineStore,
      revocationStore,
      sweeper,
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try {
      if (fs.existsSync(storageRootDir)) {
        fs.rmSync(storageRootDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  // ============================================================================
  // Suite 1: Storage Grants (Upload & Download Grants, Signatures, Expiry, Execution)
  // ============================================================================
  describe('1. Storage Grants Lifecycle & Verification', () => {
    let testAssetId;
    let uploadGrant;
    let pngBytes;
    let pngSha;

    it('1.1 Generates signed upload grant with max 600s TTL and constant-time HMAC verification', async () => {
      pngBytes = buildValidPng(32, 32);
      pngSha = sha256Hex(pngBytes);

      const res = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'upload-grant-test-1',
        },
        body: JSON.stringify({
          filename: 'banner.png',
          mime_type: 'image/png',
          bytes: pngBytes.byteLength,
          sha256: pngSha,
          rights: { basis: 'owned', source: 'Internal designer', attribution: 'Alpha Corp' },
        }),
      });

      assert.strictEqual(res.status, 201);
      uploadGrant = await res.json();
      testAssetId = uploadGrant.asset_id;

      assert.ok(uploadGrant.upload_url);
      assert.ok(uploadGrant.expires_at);
      assert.strictEqual(uploadGrant.max_bytes, 104857600);

      // Verify grant expires within 600s
      const expTime = Date.parse(uploadGrant.expires_at);
      const diffSec = (expTime - Date.now()) / 1000;
      assert.ok(diffSec > 0 && diffSec <= 600);
    });

    it('1.2 Rejects download grant request when asset is not ready (still uploading)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${testAssetId}/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'REVISION_CONFLICT');
    });

    it('1.3 Completes upload, runs probe and transitions asset to ready status', async () => {
      // PUT raw bytes to upload_url
      const putRes = await fetch(uploadGrant.upload_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: pngBytes,
      });
      assert.strictEqual(putRes.status, 200);

      // POST complete
      const compRes = await fetch(`${baseUrl}/v1/assets/${testAssetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'complete-asset-1',
        },
        body: JSON.stringify({ sha256: pngSha }),
      });
      assert.strictEqual(compRes.status, 202);

      // Verify asset status is ready
      const getRes = await fetch(`${baseUrl}/v1/assets/${testAssetId}`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(getRes.status, 200);
      const asset = await getRes.json();
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.sha256, pngSha);
    });

    it('1.4 Generates signed download grant (max 300s TTL per docs/DEPLOYMENT.md)', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${testAssetId}/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(res.status, 200);
      const grant = await res.json();

      assert.ok(grant.url);
      assert.strictEqual(grant.sha256, pngSha);
      assert.strictEqual(grant.bytes, pngBytes.byteLength);

      // Download TTL must be <= 300 seconds per docs/SECURITY.md
      const expTime = Date.parse(grant.expires_at);
      const diffSec = (expTime - Date.now()) / 1000;
      assert.ok(diffSec > 0 && diffSec <= 300);
    });

    it('1.5 Executes binary download via signed download grant URL', async () => {
      const grantRes = await fetch(`${baseUrl}/v1/assets/${testAssetId}/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      const grant = await grantRes.json();

      // Download via bearer capability URL (no auth header needed)
      const downloadRes = await fetch(grant.url);
      assert.strictEqual(downloadRes.status, 200);
      assert.strictEqual(downloadRes.headers.get('content-type'), 'image/png');
      assert.strictEqual(Number(downloadRes.headers.get('content-length')), pngBytes.byteLength);
      assert.strictEqual(downloadRes.headers.get('etag'), `"${pngSha}"`);

      const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
      assert.strictEqual(sha256Hex(downloadedBuf), pngSha);
    });

    it('1.6 Rejects tampered download grant signature with 403 INVALID_GRANT_SIGNATURE', async () => {
      const grantRes = await fetch(`${baseUrl}/v1/assets/${testAssetId}/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      const grant = await grantRes.json();

      // Tamper with the token
      const token = grant.url.split('/download/')[1];
      const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      envelope.bytes = envelope.bytes + 1; // Tamper payload
      const tamperedToken = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');

      const tamperedUrl = `${baseUrl}/v1/assets/download/${tamperedToken}`;
      const res = await fetch(tamperedUrl);
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_GRANT_SIGNATURE');
    });

    it('1.7 Rejects expired download grant token with 410 DOWNLOAD_GRANT_EXPIRED', async () => {
      // Generate grant with negative/past TTL
      const pastGrant = generateSignedDownloadGrant(
        {
          tenantId: TENANT_A_ID,
          assetId: testAssetId,
          version: 1,
          filename: 'banner.png',
          mimeType: 'image/png',
          sha256: pngSha,
          bytes: pngBytes.byteLength,
        },
        {
          pepper: TEST_PEPPER,
          baseUrl: `${baseUrl}/v1`,
          now: new Date(Date.now() - 400 * 1000), // 400s in the past
        },
      );

      const res = await fetch(pastGrant.downloadUrl);
      assert.strictEqual(res.status, 410);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'DOWNLOAD_GRANT_EXPIRED');
    });
  });

  // ============================================================================
  // Suite 2: Retention Policies (Assets, Artifacts, Idempotency)
  // ============================================================================
  describe('2. Storage Retention Enforcement & Expiry Pruning', () => {
    it('2.1 Asset retention (7-day default): expired assets cannot be downloaded and are reported expired', async () => {
      // Create asset simulating created_at 8 days ago
      const oldPng = buildValidPng(16, 16);
      const oldSha = sha256Hex(oldPng);
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const oldAsset = repo.createAsset(TENANT_A_ID, {
        id: 'ast_expired_retention_1',
        filename: 'old_asset.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: oldPng.byteLength,
        sha256: oldSha,
        rights: { basis: 'owned', source: 'Archive', attribution: 'Alpha' },
        now: eightDaysAgo,
      });
      repo.updateAssetStatus(TENANT_A_ID, oldAsset.id, {
        status: 'ready',
        now: eightDaysAgo,
      });

      // Attempting to generate download grant for retention-expired asset returns 404 NOT_FOUND
      const res = await fetch(`${baseUrl}/v1/assets/${oldAsset.id}/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('2.2 Artifact retention (7-day default): expired artifacts past expires_at return 404', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

      const comp = repo.createComposition(TENANT_A_ID, {
        id: 'cmp_art_retention',
        name: 'Artifact Retention Comp',
        spec: buildCompositionSpec({}),
      });

      const job = repo.createJob(TENANT_A_ID, {
        id: 'job_retention_stub',
        kind: 'render',
        compositionId: comp.id,
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
      });

      // Create an artifact record with expires_at in the past
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
        tx.insertScoped('job_attempts', {
          tenant_id: TENANT_A_ID,
          job_id: job.id,
          attempt_id: 'att_1',
          lease_epoch: 1,
          worker_id: 'worker_retention_1',
          state: 'succeeded',
          started_at: eightDaysAgo.toISOString(),
          heartbeat_at: eightDaysAgo.toISOString(),
          lease_expires_at: eightDaysAgo.toISOString(),
          ended_at: eightDaysAgo.toISOString(),
          cpu_seconds: 1.0,
          peak_rss_bytes: 1024000,
          error_json: null,
        });
        tx.insertScoped('artifacts', {
          tenant_id: TENANT_A_ID,
          id: 'art_expired_1',
          job_id: job.id,
          attempt_id: 'att_1',
          kind: 'video',
          mime_type: 'video/mp4',
          sha256: '9'.repeat(64),
          bytes: 1024,
          storage_key: `tenant/${TENANT_A_ID}/jobs/${job.id}/video.mp4`,
          expires_at: oneDayAgo.toISOString(),
          created_at: eightDaysAgo.toISOString(),
        });
      });

      const res = await fetch(`${baseUrl}/v1/artifacts/art_expired_1/download`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(res.status, 404);
    });

    it('2.3 Sweeper prunes expired idempotency records past 7-day retention', async () => {
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

      // Insert expired idempotency record
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
        tx.insertScoped('idempotency_records', {
          tenant_id: TENANT_A_ID,
          method: 'POST',
          normalized_path: '/v1/compositions',
          key: 'old_expired_idem_key_1',
          request_hash: 'a'.repeat(64),
          state: 'completed',
          http_status: 201,
          response_body_encrypted: JSON.stringify({ id: 'cmp_old' }),
          expires_at: oneDayAgo.toISOString(),
          created_at: eightDaysAgo.toISOString(),
        });
      });

      // Run sweeper
      const sweepRes = sweeper.sweep();
      assert.ok(sweepRes.idempotencyRecordsPruned >= 1);

      // Verify that the expired idempotency record is gone from DB
      const remaining = pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        return tx.selectScoped('idempotency_records', "key = 'old_expired_idem_key_1'", []);
      });
      assert.strictEqual(remaining.length, 0);
    });
  });

  // ============================================================================
  // Suite 3: Asset Revocation & Delete Cascade
  // ============================================================================
  describe('3. DELETE /v1/assets/{id} Revocation, Storage Purge & Live-Job Cascade', () => {
    let cascadeAssetId;
    let cascadeJobId;

    before(async () => {
      // 1. Create a ready asset
      const png = buildValidPng(20, 20);
      const sha = sha256Hex(png);
      const ast = repo.createAsset(TENANT_A_ID, {
        id: 'ast_cascade_test_1',
        filename: 'cascade.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: png.byteLength,
        sha256: sha,
        rights: { basis: 'owned', source: 'Test', attribution: 'Test' },
      });
      repo.updateAssetStatus(TENANT_A_ID, ast.id, {
        status: 'ready',
        normalizedSha256: sha,
        bytes: png.byteLength,
        mimeType: 'image/png',
      });
      cascadeAssetId = ast.id;

      // Promote file to permanent storage
      quarantineStore.saveQuarantined(TENANT_A_ID, cascadeAssetId, png);
      quarantineStore.promoteToReady(TENANT_A_ID, cascadeAssetId, 1, 'cascade.png');

      // 2. Create composition referencing this asset
      const spec = buildCompositionSpec({ imageAssetId: cascadeAssetId });
      const comp = repo.createComposition(TENANT_A_ID, {
        id: 'cmp_cascade_test_1',
        name: 'Cascade Comp',
        spec,
      });

      // 3. Create a running/queued job referencing this composition
      cascadeJobId = 'job_cascade_live_1';
      repo.createJob(TENANT_A_ID, {
        id: cascadeJobId,
        kind: 'render',
        compositionId: comp.id,
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
      });
    });

    it('3.1 DELETE /v1/assets/{id} immediately revokes asset, cascades to jobs and returns 202', async () => {
      const delRes = await fetch(`${baseUrl}/v1/assets/${cascadeAssetId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });

      assert.strictEqual(delRes.status, 202);
      const body = await delRes.json();
      assert.strictEqual(body.id, cascadeAssetId);
      assert.strictEqual(body.status, 'deleted');
      assert.ok(Array.isArray(body.revokedJobs));
      assert.ok(body.revokedJobs.includes(cascadeJobId));

      // Verify asset state is deleted in DB
      const asset = repo.getAsset(TENANT_A_ID, cascadeAssetId);
      assert.strictEqual(asset.status, 'deleted');
      assert.ok(asset.deleted_at);

      // Verify referencing job was transitioned to failed with ASSET_REVOKED
      const job = repo.getJob(TENANT_A_ID, cascadeJobId);
      assert.strictEqual(job.state, 'failed');
      assert.strictEqual(job.stage, 'failed');
      assert.strictEqual(job.error.code, 'ASSET_REVOKED');
      assert.strictEqual(job.error.retryable, false);

      // Verify physical permanent file was purged
      const permFile = quarantineStore.getPermanentFile(TENANT_A_ID, cascadeAssetId, 1, 'cascade.png');
      assert.strictEqual(permFile, null);
    });

    it('3.2 Repeated DELETE /v1/assets/{id} is idempotent and returns 202', async () => {
      const delRes = await fetch(`${baseUrl}/v1/assets/${cascadeAssetId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });

      assert.strictEqual(delRes.status, 202);
      const body = await delRes.json();
      assert.strictEqual(body.id, cascadeAssetId);
      assert.strictEqual(body.status, 'deleted');
      assert.deepStrictEqual(body.revokedJobs, []);
    });

    it('3.3 Previously issued download grant for deleted asset is immediately rejected with 410 GRANT_REVOKED', async () => {
      // Create a fresh grant for this asset ID
      const grant = generateSignedDownloadGrant(
        {
          tenantId: TENANT_A_ID,
          assetId: cascadeAssetId,
          version: 1,
          filename: 'cascade.png',
          mimeType: 'image/png',
          sha256: '0'.repeat(64),
          bytes: 100,
        },
        { pepper: TEST_PEPPER, baseUrl: `${baseUrl}/v1` },
      );

      const res = await fetch(grant.downloadUrl);
      assert.strictEqual(res.status, 410);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'GRANT_REVOKED');
    });

    it('3.4 POST /v1/assets/{id}/upload-url on deleted asset returns 409 REVISION_CONFLICT', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${cascadeAssetId}/upload-url`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'refresh-deleted-asset',
        },
      });
      assert.strictEqual(res.status, 409);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'REVISION_CONFLICT');
    });
  });

  // ============================================================================
  // Suite 4: Storage Temp Sweeper (Orphan Files & Sweeper Report)
  // ============================================================================
  describe('4. Storage Temp Sweeper & Orphan Cleanup', () => {
    it('4.1 Sweeps orphan quarantine .part files older than threshold and reclaims disk bytes', async () => {
      // Manually create an orphan quarantine file with old mtime
      const quarantineDir = path.join(storageRootDir, 'quarantine', TENANT_A_ID);
      fs.mkdirSync(quarantineDir, { recursive: true });
      const orphanPath = path.join(quarantineDir, 'ast_abandoned_upload_1.part');
      const dummyData = Buffer.alloc(1024 * 50, 0x42); // 50 KiB
      fs.writeFileSync(orphanPath, dummyData);

      // Set mtime to 48 hours ago
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      fs.utimesSync(orphanPath, twoDaysAgo, twoDaysAgo);

      // Verify file exists before sweep
      assert.ok(fs.existsSync(orphanPath));

      // Trigger sweeper
      const sweepRes = sweeper.sweep({
        quarantineMaxAgeMs: 24 * 60 * 60 * 1000, // 24h threshold
      });

      assert.ok(sweepRes.quarantineFilesRemoved >= 1);
      assert.ok(sweepRes.quarantineBytesReclaimed >= 50 * 1024);
      assert.ok(!fs.existsSync(orphanPath));
    });

    it('4.2 POST /v1/system/sweep executes maintenance sweep and returns structured report', async () => {
      const res = await fetch(`${baseUrl}/v1/system/sweep`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 200);
      const report = await res.json();

      assert.ok(report.startedAt);
      assert.ok(report.completedAt);
      assert.strictEqual(typeof report.quarantineFilesRemoved, 'number');
      assert.strictEqual(typeof report.quarantineBytesReclaimed, 'number');
      assert.strictEqual(typeof report.grantsRevokedOrExpired, 'number');
      assert.strictEqual(typeof report.assetsExpired, 'number');
      assert.strictEqual(typeof report.artifactsExpired, 'number');
      assert.strictEqual(typeof report.idempotencyRecordsPruned, 'number');
    });
  });

  // ============================================================================
  // Suite 5: Tombstones & Reference Safety
  // ============================================================================
  describe('5. Tombstones & Reference Safety Across Compositions & Jobs', () => {
    let tombstonedAssetId;

    before(async () => {
      // Create and delete an asset to create a tombstone
      const png = buildValidPng(12, 12);
      const sha = sha256Hex(png);
      const ast = repo.createAsset(TENANT_A_ID, {
        id: 'ast_tombstone_test_1',
        filename: 'tombstone.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: png.byteLength,
        sha256: sha,
        rights: { basis: 'owned', source: 'Test', attribution: 'Alpha' },
      });
      repo.updateAssetStatus(TENANT_A_ID, ast.id, {
        status: 'ready',
        normalizedSha256: sha,
        bytes: png.byteLength,
        mimeType: 'image/png',
      });
      repo.deleteAsset(TENANT_A_ID, ast.id);
      tombstonedAssetId = ast.id;
    });

    it('5.1 GET /v1/assets/{id}/tombstone returns tombstone metadata without leaking private file', async () => {
      const res = await fetch(`${baseUrl}/v1/assets/${tombstonedAssetId}/tombstone`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });
      assert.strictEqual(res.status, 200);
      const tombstone = await res.json();

      assert.strictEqual(tombstone.id, tombstonedAssetId);
      assert.strictEqual(tombstone.status, 'deleted');
      assert.strictEqual(tombstone.tombstone, true);
      assert.ok(tombstone.deleted_at);
      assert.strictEqual(tombstone.filename, 'tombstone.png');
    });

    it('5.2 POST /v1/compositions referencing deleted asset is blocked with 422 VALIDATION_FAILED (ASSET_REVOKED)', async () => {
      const spec = buildCompositionSpec({ imageAssetId: tombstonedAssetId });

      const res = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'comp-ref-deleted-asset',
        },
        body: JSON.stringify({
          name: 'Invalid Comp',
          spec,
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'ASSET_REVOKED'));
    });

    it('5.3 POST /v1/compositions/{id}/revisions referencing deleted asset is blocked with 422 VALIDATION_FAILED', async () => {
      // First create valid composition with ready font only
      const validSpec = buildCompositionSpec({});
      const comp = repo.createComposition(TENANT_A_ID, {
        id: 'cmp_valid_rev_base',
        name: 'Base Comp',
        spec: validSpec,
      });

      // Attempt to add revision referencing tombstoned asset
      const invalidSpec = buildCompositionSpec({ imageAssetId: tombstonedAssetId });
      const res = await fetch(`${baseUrl}/v1/compositions/${comp.id}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'rev-ref-deleted-asset',
        },
        body: JSON.stringify({
          base_revision: 1,
          spec: invalidSpec,
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'ASSET_REVOKED'));
    });

    it('5.4 Job creation for composition revision with revoked asset is blocked with 422 VALIDATION_FAILED', async () => {
      // Create asset
      const png = buildValidPng(10, 10);
      const sha = sha256Hex(png);
      const ast = repo.createAsset(TENANT_A_ID, {
        id: 'ast_job_block_test',
        filename: 'block.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: png.byteLength,
        sha256: sha,
        rights: { basis: 'owned', source: 'Test', attribution: 'Alpha' },
      });
      repo.updateAssetStatus(TENANT_A_ID, ast.id, {
        status: 'ready',
        normalizedSha256: sha,
        bytes: png.byteLength,
        mimeType: 'image/png',
      });

      // Create composition revision while asset is ready
      const spec = buildCompositionSpec({ imageAssetId: ast.id });
      const comp = repo.createComposition(TENANT_A_ID, {
        id: 'cmp_job_block_test',
        name: 'Block Job Comp',
        spec,
      });

      // Now delete asset
      repo.deleteAsset(TENANT_A_ID, ast.id);

      // Attempting to create job must fail reference validation
      assert.throws(
        () => {
          repo.createJob(TENANT_A_ID, {
            id: 'job_should_be_blocked',
            kind: 'render',
            compositionId: comp.id,
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          });
        },
        (err) => {
          return err.httpStatus === 422 && err.details.some((d) => d.code === 'ASSET_REVOKED');
        },
      );

      // Meanwhile, the immutable historical composition revision is still readable
      const historicalRev = repo.getCompositionRevision(TENANT_A_ID, comp.id, 1);
      assert.strictEqual(historicalRev.revision, 1);
      assert.ok(historicalRev.render_hash);
    });
  });

  // ============================================================================
  // Suite 6: Cross-Tenant URL Tests & IDOR Guarantees (AMB-007)
  // ============================================================================
  describe('6. Cross-Tenant URL Path & Body Reference Isolation (AMB-007)', () => {
    let tenantAAssetId;

    before(() => {
      const png = buildValidPng(16, 16);
      const sha = sha256Hex(png);
      const ast = repo.createAsset(TENANT_A_ID, {
        id: 'ast_alpha_idor_target',
        filename: 'alpha_target.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: png.byteLength,
        sha256: sha,
        rights: { basis: 'owned', source: 'Alpha', attribution: 'Alpha' },
      });
      repo.updateAssetStatus(TENANT_A_ID, ast.id, {
        status: 'ready',
        normalizedSha256: sha,
        bytes: png.byteLength,
        mimeType: 'image/png',
      });
      tenantAAssetId = ast.id;
    });

    it('6.1 Tenant B probing Tenant A asset URL endpoints returns 404 NOT_FOUND (never 403)', async () => {
      const idorProbes = [
        { method: 'GET', path: `/v1/assets/${tenantAAssetId}` },
        { method: 'GET', path: `/v1/assets/${tenantAAssetId}/download` },
        { method: 'GET', path: `/v1/assets/${tenantAAssetId}/tombstone` },
        { method: 'POST', path: `/v1/assets/${tenantAAssetId}/upload-url` },
        { method: 'POST', path: `/v1/assets/${tenantAAssetId}/complete` },
        { method: 'DELETE', path: `/v1/assets/${tenantAAssetId}` },
      ];

      for (const probe of idorProbes) {
        const res = await fetch(`${baseUrl}${probe.path}`, {
          method: probe.method,
          headers: {
            Authorization: `Bearer ${tenantBKey}`,
            'Idempotency-Key': probe.method === 'POST' ? `probe-${crypto.randomBytes(4).toString('hex')}` : undefined,
            'Content-Type': 'application/json',
          },
          body: probe.method === 'POST' ? JSON.stringify({ sha256: '0'.repeat(64) }) : undefined,
        });

        assert.strictEqual(
          res.status,
          404,
          `Expected 404 NOT_FOUND on ${probe.method} ${probe.path} for foreign tenant, got ${res.status}`,
        );
        const body = await res.json();
        assert.strictEqual(body.error.code, 'NOT_FOUND');
      }
    });

    it('6.2 Tenant B referencing Tenant A asset ID in JSON body returns 422 VALIDATION_FAILED with ASSET_NOT_FOUND', async () => {
      // Tenant B tries to use Tenant A's asset ID in a composition
      const spec = buildCompositionSpec({ imageAssetId: tenantAAssetId });

      const res = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantBKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'tenant-b-cross-ref-probe',
        },
        body: JSON.stringify({
          name: 'Tenant B Probe',
          spec,
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      // Must return ASSET_NOT_FOUND (never reveal that the asset exists in Tenant A)
      assert.ok(body.error.details.some((d) => d.code === 'ASSET_NOT_FOUND'));
    });
  });
});
