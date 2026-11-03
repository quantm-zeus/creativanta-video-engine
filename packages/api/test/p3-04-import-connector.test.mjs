/**
 * Comprehensive Adversarial Test Suite for Task P3-04:
 * Remote Import Connector behind Off Flag, Multi-Tier SSRF Defenses, Tenant Allowlists & Rights Provenance.
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("URL allowlists và SSRF", lines 25-33; "Threat model", lines 7-18)
 *   - docs/API.md ("Asset intake", lines 35, 87-92)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P3-04)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  MigrationRunner,
  QuarantineStore,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  ImportConnector,
  SsrSecurityError,
  validateAndNormalizeImportUrl,
  checkTenantImportAllowlist,
  resolveAndAuditHostDns,
  isProhibitedIp,
  isIpLiteralOrNumericHost,
  MAX_IMPORT_BYTES,
} from '../dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'test_pepper_0123456789abcdef0123456789abcdef';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Minimal valid PNG image fixture (100x100 RGBA)
function buildValidPng(width = 100, height = 100) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  ihdr.writeUInt8(0, 18);
  ihdr.writeUInt8(0, 19);
  ihdr.writeUInt8(0, 20);
  ihdr.writeUInt32BE(0x12345678, 21);

  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  ]);

  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  return Buffer.concat([header, ihdr, idat, iend]);
}

// Minimal valid MP4 container with ftyp atom
function buildValidMp4() {
  const ftyp = Buffer.alloc(32);
  ftyp.writeUInt32BE(32, 0); // atom size
  ftyp.write('ftyp', 4, 'ascii');
  ftyp.write('isom', 8, 'ascii'); // major brand
  ftyp.writeUInt32BE(512, 12); // minor version
  ftyp.write('isom', 16, 'ascii');
  ftyp.write('iso2', 20, 'ascii');
  ftyp.write('avc1', 24, 'ascii');
  ftyp.write('mp41', 28, 'ascii');

  const moov = Buffer.alloc(16);
  moov.writeUInt32BE(16, 0);
  moov.write('moov', 4, 'ascii');

  return Buffer.concat([ftyp, moov]);
}

describe('P3-04: Remote Import Connector & Multi-Tier SSRF Defenses', () => {
  let db;
  let pool;
  let repo;
  let tempStorageDir;
  let quarantineStore;
  let tenantAKey;
  let tenantBKey;

  // Servers
  let apiServerEnabled;
  let apiServerDisabled;
  let baseUrlEnabled;
  let baseUrlDisabled;

  // Mock HTTPS Origin Server & Self-Signed Certs
  let mockTlsDir;
  let mockHttpsServer;
  let mockHttpsPort;
  let mockCaCert;

  // Mock DNS Lookup mapping
  const mockDnsRecords = {
    'approved-stock.example.invalid': { ipv4: ['127.0.0.1'] },
    'cdn.partner-stock.com': { ipv4: ['151.101.1.140'] },
    'loopback-127-1.example.invalid': { ipv4: ['127.0.0.1'] },
    'loopback-127-other.example.invalid': { ipv4: ['127.0.1.5'] },
    'rfc1918-10.example.invalid': { ipv4: ['10.0.1.5'] },
    'rfc1918-172.example.invalid': { ipv4: ['172.16.50.1'] },
    'rfc1918-192.example.invalid': { ipv4: ['192.168.1.100'] },
    'metadata-aws.example.invalid': { ipv4: ['169.254.169.254'] },
    'metadata-ali.example.invalid': { ipv4: ['100.100.100.200'] },
    'cgnat.example.invalid': { ipv4: ['100.64.0.1'] },
    'multicast.example.invalid': { ipv4: ['224.0.0.1'] },
    'broadcast.example.invalid': { ipv4: ['255.255.255.255'] },
    'ipv6-loopback.example.invalid': { ipv6: ['::1'] },
    'ipv6-mapped-private.example.invalid': { ipv6: ['::ffff:192.168.1.1'] },
    'ipv6-mapped-metadata.example.invalid': { ipv6: ['::ffff:169.254.169.254'] },
    'ipv6-ula.example.invalid': { ipv6: ['fc00::1'] },
    'ipv6-linklocal.example.invalid': { ipv6: ['fe80::1'] },
    'multihomed-attack.example.invalid': { ipv4: ['93.184.216.34', '127.0.0.1'] },
  };

  const customTestDnsResolver = async (hostname) => {
    const rec = mockDnsRecords[hostname.toLowerCase()];
    if (rec) return rec;
    return { ipv4: ['93.184.216.34'] }; // Default fallback to safe public IP
  };

  before(async () => {
    // 1. Setup SQLite database with migrations
    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 4 });
    repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

    repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
    repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

    tenantAKey = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha_p304',
      scopes: ['assets:read', 'assets:write', 'jobs:read', 'jobs:write'],
    }).plaintextKey;

    tenantBKey = repo.issueApiKey({
      tenantId: TENANT_B_ID,
      keyId: 'key_beta_p304',
      scopes: ['assets:read', 'assets:write', 'jobs:read', 'jobs:write'],
    }).plaintextKey;

    // Set custom allowlist for Tenant A
    repo.setTenantImportAllowlist(TENANT_A_ID, [
      'https://approved-stock.example.invalid/assets/',
      'https://approved-stock.example.invalid/media/',
      'cdn.partner-stock.com/footage/',
    ]);

    // Set separate allowlist for Tenant B (isolation check)
    repo.setTenantImportAllowlist(TENANT_B_ID, [
      'https://tenant-b-exclusive.example.invalid/assets/',
    ]);

    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p304-storage-'));
    quarantineStore = new QuarantineStore(tempStorageDir);

    // 2. Generate self-signed certificate for mock HTTPS origin
    mockTlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p304-tls-'));
    const keyPath = path.join(mockTlsDir, 'key.pem');
    const certPath = path.join(mockTlsDir, 'cert.pem');

    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -sha256 -subj '/CN=approved-stock.example.invalid' -days 1 -keyout "${keyPath}" -out "${certPath}" 2>/dev/null`,
    );
    mockCaCert = fs.readFileSync(certPath);

    // 3. Start Mock HTTPS Origin Server
    const validMp4 = buildValidMp4();
    const validMp4Sha = sha256Hex(validMp4);

    mockHttpsServer = https.createServer(
      {
        key: fs.readFileSync(keyPath),
        cert: mockCaCert,
      },
      (req, res) => {
        const reqUrl = new URL(req.url, `https://${req.headers.host}`);

        // Route: /assets/clip.mp4 (Valid 200)
        if (reqUrl.pathname === '/assets/clip.mp4') {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': validMp4.length,
          });
          res.end(validMp4);
          return;
        }

        // Route: /assets/html-fake-video.mp4 (HTML error page masquerading as video)
        if (reqUrl.pathname === '/assets/html-fake-video.mp4') {
          const html = '<html><body><h1>404 Not Found (Masquerading HTML)</h1></body></html>';
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': Buffer.byteLength(html),
          });
          res.end(html);
          return;
        }

        // Route: /assets/redirect-to-clip (Valid redirect hop 1 -> /assets/clip.mp4)
        if (reqUrl.pathname === '/assets/redirect-to-clip') {
          res.writeHead(302, { Location: '/assets/clip.mp4' });
          res.end();
          return;
        }

        // Route: /assets/redirect-to-private (Malicious redirect to cloud metadata)
        if (reqUrl.pathname === '/assets/redirect-to-private') {
          res.writeHead(302, { Location: 'https://metadata-aws.example.invalid/clip.mp4' });
          res.end();
          return;
        }

        // Route: /assets/redirect-to-unallowlisted (Redirect to unapproved host)
        if (reqUrl.pathname === '/assets/redirect-to-unallowlisted') {
          res.writeHead(302, { Location: 'https://evil-unapproved.com/clip.mp4' });
          res.end();
          return;
        }

        // Route: /assets/redirect-loop (Infinite redirect loop)
        if (reqUrl.pathname === '/assets/redirect-loop') {
          res.writeHead(302, { Location: '/assets/redirect-loop' });
          res.end();
          return;
        }

        // Route: /assets/oversized-header.mp4 (Content-Length declares > 100 MiB)
        if (reqUrl.pathname === '/assets/oversized-header.mp4') {
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': String(MAX_IMPORT_BYTES + 1024),
          });
          res.end('oversized');
          return;
        }

        // Default 404
        res.writeHead(404);
        res.end('Not found');
      },
    );

    await new Promise((resolve) => {
      mockHttpsServer.listen(0, '127.0.0.1', () => {
        const addr = mockHttpsServer.address();
        mockHttpsPort = addr.port;
        resolve();
      });
    });

    // 4. Create import connector configured for tests
    const importConnector = new ImportConnector({
      quarantineStore,
      dnsResolver: customTestDnsResolver,
      connectTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      maxRedirects: 3,
      allowInsecureTlsForTesting: false,
      allowCustomPortForTesting: true,
      allowLoopbackForTesting: true,
      caCert: mockCaCert,
    });

    // 5. Create API server with CVE_REMOTE_IMPORT_ENABLED = true
    const configEnabled = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_REMOTE_IMPORT_ENABLED: 'true',
    });

    apiServerEnabled = createServer({
      config: configEnabled,
      repository: repo,
      quarantineStore,
      importConnector,
    });

    await new Promise((resolve) => {
      apiServerEnabled.listen(0, '127.0.0.1', () => {
        const addr = apiServerEnabled.address();
        baseUrlEnabled = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    // 6. Create API server with CVE_REMOTE_IMPORT_ENABLED = false (off by default)
    const configDisabled = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_REMOTE_IMPORT_ENABLED: 'false',
    });

    apiServerDisabled = createServer({
      config: configDisabled,
      repository: repo,
      quarantineStore,
      importConnector,
    });

    await new Promise((resolve) => {
      apiServerDisabled.listen(0, '127.0.0.1', () => {
        const addr = apiServerDisabled.address();
        baseUrlDisabled = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await Promise.all([
      new Promise((res) => apiServerEnabled.close(res)),
      new Promise((res) => apiServerDisabled.close(res)),
      new Promise((res) => mockHttpsServer.close(res)),
    ]);
    db.close();

    try {
      fs.rmSync(tempStorageDir, { recursive: true, force: true });
      fs.rmSync(mockTlsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Feature Flag & Admission Gate
  // ---------------------------------------------------------------------------
  describe('1. Feature Flag & Admission Gate', () => {
    it('1.1 POST /v1/assets/imports returns 403 CAPABILITY_DISABLED when disabled by policy', async () => {
      const res = await fetch(`${baseUrlDisabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-flag-off-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: '0'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock Partner', attribution: 'Acme' },
        }),
      });

      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'CAPABILITY_DISABLED');
      assert.strictEqual(body.error.message, 'Remote import connector is disabled by policy');
    });

    it('1.2 POST /v1/assets/imports requires assets:write scope', async () => {
      const readOnlyKey = repo.issueApiKey({
        tenantId: TENANT_A_ID,
        keyId: 'key_readonly',
        scopes: ['assets:read'],
      }).plaintextKey;

      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${readOnlyKey}`,
          'Idempotency-Key': 'idem-scope-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: '0'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.ok(['FORBIDDEN', 'INSUFFICIENT_SCOPE'].includes(body.error.code));
    });

    it('1.3 POST /v1/assets/imports enforces valid Idempotency-Key header', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: '0'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 400);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

      const badKeyRes = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'invalid key spaces!@#',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: '0'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(badKeyRes.status, 400);
      const badKeyBody = await badKeyRes.json();
      assert.strictEqual(badKeyBody.error.code, 'INVALID_IDEMPOTENCY_KEY');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Syntactic URL Security & Parser Differential Defenses (docs/SECURITY.md)
  // ---------------------------------------------------------------------------
  describe('2. Syntactic URL Security & Parser Differential Defenses', () => {
    const dangerousSchemes = [
      'http://approved-stock.example.invalid/assets/clip.mp4',
      'ftp://approved-stock.example.invalid/assets/clip.mp4',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'gopher://approved-stock.example.invalid:70/',
      'blob:https://approved-stock.example.invalid/uuid',
    ];

    for (const badScheme of dangerousSchemes) {
      it(`2.1 Rejects non-HTTPS scheme: ${badScheme.split(':')[0]}`, async () => {
        const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAKey}`,
            'Idempotency-Key': `idem-scheme-${crypto.randomBytes(4).toString('hex')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: badScheme,
            expected_sha256: 'a'.repeat(64),
            rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
          }),
        });

        assert.strictEqual(res.status, 422);
        const body = await res.json();
        assert.strictEqual(body.error.code, 'UNSUPPORTED_SCHEME');
      });
    }

    it('2.2 Rejects non-443 ports in strict mode', () => {
      assert.throws(
        () => validateAndNormalizeImportUrl('https://approved-stock.example.invalid:8080/clip.mp4'),
        (err) => err instanceof SsrSecurityError && err.code === 'UNSUPPORTED_PORT',
      );
      assert.throws(
        () => validateAndNormalizeImportUrl('https://approved-stock.example.invalid:80/clip.mp4'),
        (err) => err instanceof SsrSecurityError && err.code === 'UNSUPPORTED_PORT',
      );
      assert.throws(
        () => validateAndNormalizeImportUrl('https://approved-stock.example.invalid:22/clip.mp4'),
        (err) => err instanceof SsrSecurityError && err.code === 'UNSUPPORTED_PORT',
      );
    });

    it('2.3 Rejects userinfo / credentials in URL', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-userinfo-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://user:password@approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'USERINFO_PROHIBITED');
    });

    it('2.4 Rejects URL fragments (#)', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-fragment-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4#injection',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'URL_FRAGMENT_PROHIBITED');
    });

    it('2.5 Rejects backslashes in URL to prevent parser differential attacks', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-backslash-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid\\evil.com/assets/clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INVALID_URL_SYNTAX');
    });

    it('2.6 Rejects control characters and NULL bytes in URL', () => {
      assert.throws(
        () => validateAndNormalizeImportUrl('https://approved-stock.example.invalid/assets/\x00clip.mp4'),
        (err) => err instanceof SsrSecurityError && err.code === 'INVALID_URL_SYNTAX',
      );
      assert.throws(
        () => validateAndNormalizeImportUrl('https://approved-stock.example.invalid/assets/\r\nclip.mp4'),
        (err) => err instanceof SsrSecurityError && err.code === 'INVALID_URL_SYNTAX',
      );
    });

    it('2.7 Rejects path traversal (..) in URL pathname', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-traversal-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/../../etc/passwd',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.ok(['VALIDATION_FAILED', 'PATH_TRAVERSAL_DETECTED'].includes(body.error.code));
      assert.strictEqual(body.error.details[0].code, 'PATH_TRAVERSAL_DETECTED');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. IP Literal & Numeric Alternate Encoding Defenses (docs/SECURITY.md)
  // ---------------------------------------------------------------------------
  describe('3. IP Literal & Numeric Alternate Encoding Defenses', () => {
    const forbiddenIpHosts = [
      // Standard IPv4
      '127.0.0.1',
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      // Standard IPv6
      '[::1]',
      '[fe80::1]',
      '[::ffff:127.0.0.1]',
      // DWORD decimal integer (127.0.0.1 = 2130706433)
      '2130706433',
      // Hexadecimal IPv4 (0x7f000001, 0x7f.0.0.1)
      '0x7f000001',
      '0x7f.0.0.1',
      // Octal IPv4 (0177.0.0.1)
      '0177.0.0.1',
      // Mixed representations (127.0x0.01)
      '127.0x0.01',
      '127.1',
    ];

    for (const host of forbiddenIpHosts) {
      it(`3.1 Correctly detects IP literal or numeric representation: ${host}`, () => {
        assert.strictEqual(isIpLiteralOrNumericHost(host), true);
      });

      it(`3.2 Rejects IP literal import target in API: https://${host}/clip.mp4`, async () => {
        const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAKey}`,
            'Idempotency-Key': `idem-ip-literal-${crypto.randomBytes(4).toString('hex')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: `https://${host}/clip.mp4`,
            expected_sha256: 'a'.repeat(64),
            rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
          }),
        });

        assert.strictEqual(res.status, 422);
        const body = await res.json();
        assert.strictEqual(body.error.code, 'IP_LITERAL_PROHIBITED');
      });
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Server-Managed Tenant Allowlist Defenses (docs/SECURITY.md)
  // ---------------------------------------------------------------------------
  describe('4. Server-Managed Tenant Allowlist Defenses', () => {
    it('4.1 Rejects domains not in tenant allowlist with 422 URL_NOT_ALLOWLISTED', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-allowlist-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://evil-unapproved.com/assets/clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.ok(['VALIDATION_FAILED', 'URL_NOT_ALLOWLISTED'].includes(body.error.code));
      assert.strictEqual(body.error.details[0].code, 'URL_NOT_ALLOWLISTED');
    });

    it('4.2 Rejects domain suffix hijacking (no wildcard suffix without boundary)', async () => {
      // Attacker appends legitimate domain as subdomain prefix or suffix
      const suffixAttacks = [
        'https://approved-stock.example.invalid.attacker.com/assets/clip.mp4',
        'https://not-approved-stock.example.invalid/assets/clip.mp4',
        'https://attacker-approved-stock.example.invalid/assets/clip.mp4',
      ];

      for (const target of suffixAttacks) {
        const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantAKey}`,
            'Idempotency-Key': `idem-suffix-${crypto.randomBytes(4).toString('hex')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: target,
            expected_sha256: 'a'.repeat(64),
            rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
          }),
        });

        assert.strictEqual(res.status, 422);
        const body = await res.json();
        assert.ok(['VALIDATION_FAILED', 'URL_NOT_ALLOWLISTED'].includes(body.error.code));
        assert.strictEqual(body.error.details[0].code, 'URL_NOT_ALLOWLISTED');
      }
    });

    it('4.3 Rejects unauthorized path prefix on allowlisted domain', async () => {
      // Tenant A allowlist allows /assets/ and /media/, but NOT /internal/ or /admin/
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-path-mismatch-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/internal/private-clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.ok(['VALIDATION_FAILED', 'URL_NOT_ALLOWLISTED'].includes(body.error.code));
      assert.strictEqual(body.error.details[0].code, 'URL_NOT_ALLOWLISTED');
    });

    it('4.4 Enforces per-tenant allowlist isolation', () => {
      const url = new URL('https://approved-stock.example.invalid/assets/clip.mp4');
      const tenantAAllowlist = repo.getTenantImportAllowlist(TENANT_A_ID);
      const tenantBAllowlist = repo.getTenantImportAllowlist(TENANT_B_ID);

      assert.strictEqual(checkTenantImportAllowlist(url, tenantAAllowlist).allowed, true);
      assert.strictEqual(checkTenantImportAllowlist(url, tenantBAllowlist).allowed, false);
    });

    it('4.5 Rejects tenant attempting to self-whitelist private IP endpoints', () => {
      const privateIp = '127.0.0.1';
      const check = isProhibitedIp(privateIp);
      assert.strictEqual(check.prohibited, true);
      assert.match(check.reason, /Loopback/);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. DNS Resolution & Prohibited IP Address Defenses (docs/SECURITY.md)
  // ---------------------------------------------------------------------------
  describe('5. DNS Resolution & Prohibited IP Address Defenses', () => {
    it('5.1 Blocks domain resolving to Loopback (127.0.0.1)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('loopback-127-1.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.2 Blocks domain resolving to RFC 1918 Private networks (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)', async () => {
      const privateHosts = [
        'rfc1918-10.example.invalid',
        'rfc1918-172.example.invalid',
        'rfc1918-192.example.invalid',
      ];

      for (const host of privateHosts) {
        await assert.rejects(
          async () => resolveAndAuditHostDns(host, customTestDnsResolver),
          (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
        );
      }
    });

    it('5.3 Blocks domain resolving to Cloud Metadata endpoints (169.254.169.254, 100.100.100.200)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('metadata-aws.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
      await assert.rejects(
        async () => resolveAndAuditHostDns('metadata-ali.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.4 Blocks domain resolving to Carrier-grade NAT (100.64.0.0/10)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('cgnat.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.5 Blocks domain resolving to IPv6 Loopback (::1) and ULA (fc00::/7)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('ipv6-loopback.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
      await assert.rejects(
        async () => resolveAndAuditHostDns('ipv6-ula.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.6 Blocks domain resolving to IPv4-mapped IPv6 prohibited ranges (::ffff:192.168.1.1)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('ipv6-mapped-private.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.7 Blocks multi-homed DNS response (public IP + private IP attack vector)', async () => {
      await assert.rejects(
        async () => resolveAndAuditHostDns('multihomed-attack.example.invalid', customTestDnsResolver),
        (err) => err instanceof SsrSecurityError && err.code === 'SSRF_PROHIBITED_IP',
      );
    });

    it('5.8 Fails fast in API endpoint when host resolves to prohibited IP', async () => {
      // Temporarily permit host in allowlist to verify that SSRF defense blocks it
      repo.setTenantImportAllowlist(TENANT_A_ID, [
        ...repo.getTenantImportAllowlist(TENANT_A_ID),
        'metadata-aws.example.invalid',
      ]);

      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-dns-block-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://metadata-aws.example.invalid/latest/meta-data',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.ok(['VALIDATION_FAILED', 'SSRF_PROHIBITED_IP'].includes(body.error.code));
      assert.strictEqual(body.error.details[0].code, 'SSRF_PROHIBITED_IP');
      assert.match(body.error.message, /169\.254\.169\.254/);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Connect-Time IP Pinning & Anti-DNS-Rebinding
  // ---------------------------------------------------------------------------
  describe('6. Connect-Time IP Pinning & Anti-DNS-Rebinding', () => {
    it('6.1 Pinned IP selection successfully isolates approved IP', async () => {
      const pinning = await resolveAndAuditHostDns(
        'approved-stock.example.invalid',
        customTestDnsResolver,
        { allowLoopbackForTesting: true },
      );
      assert.strictEqual(pinning.pinnedIp, '127.0.0.1');
      assert.deepStrictEqual(pinning.allResolvedIps, ['127.0.0.1']);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Redirect Defenses (docs/SECURITY.md line 29)
  // ---------------------------------------------------------------------------
  describe('7. Redirect Defenses', () => {
    it('7.1 Blocks redirect from allowed domain to loopback / private IP', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_red_priv',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/redirect-to-private`,
        expectedSha256: 'a'.repeat(64),
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid', 'metadata-aws.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'SSRF_PROHIBITED_IP');
      assert.match(res.error.message, /169\.254\.169\.254/);
    });

    it('7.2 Blocks redirect to non-allowlisted target domain', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_red_unallow',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/redirect-to-unallowlisted`,
        expectedSha256: 'a'.repeat(64),
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'REDIRECT_NOT_ALLOWLISTED');
    });

    it('7.3 Blocks redirect loops exceeding max 3 redirects', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_red_loop',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/redirect-loop`,
        expectedSha256: 'a'.repeat(64),
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'MAX_REDIRECTS_EXCEEDED');
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Payload & Streaming Boundary Defenses (docs/SECURITY.md line 31)
  // ---------------------------------------------------------------------------
  describe('8. Payload & Streaming Boundary Defenses', () => {
    it('8.1 Rejects remote asset when Content-Length exceeds 100 MiB limit', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_oversized',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/oversized-header.mp4`,
        expectedSha256: 'a'.repeat(64),
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'PAYLOAD_TOO_LARGE');
    });

    it('8.2 Rejects asset when downloaded SHA-256 does not match expected_sha256', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_hash_mismatch',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/clip.mp4`,
        expectedSha256: 'f'.repeat(64), // Deliberately incorrect checksum
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      assert.strictEqual(res.error.code, 'CHECKSUM_MISMATCH');
    });

    it('8.3 Sandbox probe traps HTML masquerading as video', async () => {
      const fakeHtml = '<html><body><h1>404 Not Found (Masquerading HTML)</h1></body></html>';
      const fakeSha = sha256Hex(Buffer.from(fakeHtml));

      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_fake_html',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/html-fake-video.mp4`,
        expectedSha256: fakeSha,
        rights: { basis: 'licensed', source: 'Stock', attribution: 'Stock' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, false);
      // Malformed MP4 missing ftyp atom trapped by sandbox probe
      assert.ok(['INVALID_MEDIA_SIGNATURE', 'MALFORMED_MEDIA'].includes(res.error.code));
    });
  });

  // ---------------------------------------------------------------------------
  // 9. Rights Provenance & Query String Redaction (docs/SECURITY.md line 31)
  // ---------------------------------------------------------------------------
  describe('9. Rights Provenance & Query String Redaction', () => {
    it('9.1 Rejects invalid rights basis with 422 VALIDATION_FAILED', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-rights-basis-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: { basis: 'unlicensed_pirate', source: 'Torrents', attribution: 'Unknown' },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.strictEqual(body.error.details[0].code, 'INVALID_RIGHTS_BASIS');
    });

    it('9.2 Rejects expired license rights with 422 RIGHTS_EXPIRED', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-rights-exp-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: 'a'.repeat(64),
          rights: {
            basis: 'licensed',
            source: 'Stock Partner',
            attribution: 'Acme',
            expires_at: pastDate,
          },
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.strictEqual(body.error.details[0].code, 'RIGHTS_EXPIRED');
    });

    it('9.3 Strips sensitive query string tokens from persisted source URL', async () => {
      const validMp4 = buildValidMp4();
      const validSha = sha256Hex(validMp4);

      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        maxRedirects: 3,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const res = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: 'ast_redact_query',
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/clip.mp4?secret_token=super_secret_oauth_token&signature=xyz123`,
        expectedSha256: validSha,
        rights: { basis: 'licensed', source: 'Stock Partner', attribution: 'Acme' },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(res.success, true);
      // Query parameters stripped
      assert.strictEqual(
        res.sanitizedSourceUrl,
        `https://approved-stock.example.invalid:${mockHttpsPort}/assets/clip.mp4`,
      );
      assert.strictEqual(
        res.sanitizedRights.source,
        `https://approved-stock.example.invalid:${mockHttpsPort}/assets/clip.mp4`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // 10. End-to-End Import Lifecycle & Foreign Asset 404 Guarantee (AMB-007)
  // ---------------------------------------------------------------------------
  describe('10. End-to-End Import Lifecycle & IDOR Guarantee (AMB-007)', () => {
    const validMp4 = buildValidMp4();
    const validSha = sha256Hex(validMp4);
    let importedAssetId;

    it('10.1 POST /v1/assets/imports queues import with 202 and initial status processing', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-e2e-import-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: validSha,
          rights: {
            basis: 'licensed',
            source: 'Stock Partner Library',
            attribution: 'Studio X',
          },
        }),
      });

      assert.strictEqual(res.status, 202);
      const body = await res.json();
      assert.ok(body.id.startsWith('ast_'));
      assert.strictEqual(body.status, 'processing');
      importedAssetId = body.id;
    });

    it('10.2 Replaying idempotent POST /v1/assets/imports returns replayed 202', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/imports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tenantAKey}`,
          'Idempotency-Key': 'idem-e2e-import-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://approved-stock.example.invalid/assets/clip.mp4',
          expected_sha256: validSha,
          rights: {
            basis: 'licensed',
            source: 'Stock Partner Library',
            attribution: 'Studio X',
          },
        }),
      });

      assert.strictEqual(res.status, 202);
      assert.strictEqual(res.headers.get('idempotency-replayed'), 'true');
      const body = await res.json();
      assert.strictEqual(body.id, importedAssetId);
    });

    it('10.3 ImportConnector completes transfer, passes probe, and transitions to ready', async () => {
      const connector = new ImportConnector({
        quarantineStore,
        dnsResolver: customTestDnsResolver,
        allowCustomPortForTesting: true,
        allowLoopbackForTesting: true,
        caCert: mockCaCert,
      });

      const result = await connector.executeImport({
        tenantId: TENANT_A_ID,
        assetId: importedAssetId,
        url: `https://approved-stock.example.invalid:${mockHttpsPort}/assets/clip.mp4`,
        expectedSha256: validSha,
        rights: {
          basis: 'licensed',
          source: 'Stock Partner Library',
          attribution: 'Studio X',
        },
        allowlist: ['approved-stock.example.invalid'],
      });

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.sha256, validSha);

      // Promote in repo
      repo.updateAssetStatus(TENANT_A_ID, importedAssetId, {
        status: 'ready',
        mimeType: result.mimeType,
        probeMetadata: result.probeMetadata,
        normalizedSha256: result.sha256,
        bytes: result.bytes,
      });

      // Verify GET /v1/assets/{id} returns ready
      const getRes = await fetch(`${baseUrlEnabled}/v1/assets/${importedAssetId}`, {
        headers: { Authorization: `Bearer ${tenantAKey}` },
      });

      assert.strictEqual(getRes.status, 200);
      const asset = await getRes.json();
      assert.strictEqual(asset.id, importedAssetId);
      assert.strictEqual(asset.status, 'ready');
      assert.strictEqual(asset.mime_type, 'video/mp4');
      assert.strictEqual(asset.sha256, validSha);
      assert.strictEqual(asset.bytes, validMp4.length);
      assert.ok(asset.metadata);
    });

    it('10.4 Tenant B probing Tenant A imported asset ID returns 404 NOT_FOUND (never 403 - AMB-007)', async () => {
      const res = await fetch(`${baseUrlEnabled}/v1/assets/${importedAssetId}`, {
        headers: { Authorization: `Bearer ${tenantBKey}` },
      });

      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });
  });
});
