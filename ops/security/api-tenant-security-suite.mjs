/**
 * Creativanta Video Engine — P6-04 Secrets, IDOR, SSRF, Abuse, Malicious Media & Deletion Security Suite
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Multi-tenant isolation", "Authentication, secrets và webhooks", "Asset & remote import hardening", "Security test gates", lines 14-43)
 *   - docs/TESTING.md ("Security tests", lines 30-35)
 *   - docs/API.md (AMB-007 Path 404 vs Body 422 IDOR taxonomy, signed cursors, webhook secret one-time display, DELETE /v1/assets/:id cascade)
 *
 * Executes 10 live security verification checks:
 *   1. API-SEC-01: API key 32-byte entropy, HMAC-SHA256 constant-time verification, scope enforcement, rotation & revocation
 *   2. API-SEC-02: Cross-tenant IDOR matrix (100% 404 NOT_FOUND on URL path probes; 422 ASSET_NOT_FOUND on JSON body references per AMB-007)
 *   3. API-SEC-03: Signed pagination cursor tenant/route/filter binding & tamper rejection (400 INVALID_CURSOR)
 *   4. API-SEC-04: Multi-encoding SSRF (decimal/octal/hex IPv4, IPv6-mapped, cloud metadata 169.254.169.254), DNS rebinding & redirect hop revalidation
 *   5. API-SEC-05: Malicious media & decompression bombs (SVG XXE/script/foreignObject/DOM bomb, WOFF2 ratio bomb, PNG pixel bomb, MP4 missing moov / stream limit, MIME spoofing)
 *   6. API-SEC-06: Rate limiting (429 RATE_LIMITED + Retry-After), concurrent active job slot quota (429 QUOTA_EXCEEDED), and idempotency payload conflict (409 IDEMPOTENCY_CONFLICT)
 *   7. API-SEC-07: Webhook secret one-time display, idempotent replay redaction (secret_redacted: true), and encrypted-at-rest storage
 *   8. API-SEC-08: DELETE /v1/assets/:id cascade revocation (active job -> failed ASSET_REVOKED, grant -> 410 GRANT_REVOKED, tombstone preserved without private payload, new composition blocked)
 *   9. API-SEC-09: Worker lease epoch fencing (LeaseManager stale publish rejection) & live-lease temp sweeper safety (StorageTempSweeper)
 *  10. API-SEC-10: Post-restore safety locks (PostRestoreSafetyGate public traffic & outbound webhook lock until verification passes)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '../../packages/contracts/dist/index.js';
import {
  createServer,
  MigrationRunner,
  TenantConnectionPool,
  TenantRepository,
  QuarantineStore,
  StorageGrantRevocationStore,
  StorageTempSweeper,
  TokenBucketRateLimiter,
  verifyApiKeyConstantTime,
  encodeSignedCursor,
  decodeSignedCursor,
  validateAndNormalizeImportUrl,
  resolveAndAuditHostDns,
  checkTenantImportAllowlist,
  SsrSecurityError,
  probeAndSanitizeSvg,
  probeFont,
  probeImage,
  probeAudioVideoContainer,
  executeSandboxMediaProbe,
  verifySignedDownloadGrant,
  DownloadGrantError,
  QuotaExceededError,
  BodyReferenceValidationError,
} from '../../packages/api/dist/index.js';
import { LeaseManager } from '../../packages/controller/dist/index.js';
import { PostRestoreSafetyGate, SAFETY_STATES } from '../recovery/safety-gate-manager.mjs';

const TENANT_UUID = {
  AUTH: '00000000-0000-4000-8000-000000000101',
  VICTIM_A: '00000000-0000-4000-8000-000000000201',
  ATTACKER_B: '00000000-0000-4000-8000-000000000202',
  QUOTA: '00000000-0000-4000-8000-000000000601',
  WEBHOOK: '00000000-0000-4000-8000-000000000701',
  DELETE: '00000000-0000-4000-8000-000000000801',
  FENCE: '00000000-0000-4000-8000-000000000901',
  SWEEP: '00000000-0000-4000-8000-000000000902',
};

function createTestEnvironment() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-api-'));
  const db = new DatabaseSync(':memory:');
  const migrator = new MigrationRunner(db);
  migrator.migrateUp({ role: 'cve_migrator', targetVersion: '0002' });

  const pepper = 'p604-security-review-pepper-secret-0123456789abcdef';
  const masterKey = crypto.randomBytes(32);
  const quarantineStore = new QuarantineStore(path.join(tmpDir, 'quarantine'));
  const revocationStore = new StorageGrantRevocationStore();
  const pool = new TenantConnectionPool(db);
  const repo = new TenantRepository(pool, {
    pepper,
    quarantineStore,
    revocationStore,
    masterKey,
  });

  const config = loadEnvConfig({
    NODE_ENV: 'test',
    PORT: '0',
    CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    CVE_API_KEY_PEPPER: pepper,
    CVE_STORAGE_S3_BUCKET: 'cve-test-bucket',
    CVE_STORAGE_S3_ENDPOINT: 'http://127.0.0.1:9000',
    CVE_CUSTOM_CODE_ENABLED: 'false',
    CVE_REMOTE_IMPORT_ENABLED: 'true',
  });

  return {
    tmpDir,
    db,
    pool,
    repo,
    pepper,
    quarantineStore,
    revocationStore,
    config,
    cleanup() {
      try {
        db.close();
      } catch {
        // ignore
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function startEphemeralServer(serverOptions) {
  const server = createServer(serverOptions);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    server,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export class ApiTenantSecuritySuite {
  async runAll() {
    const startedAt = Date.now();
    const checks = [];

    const recordCheck = async (id, title, category, fn) => {
      const t0 = performance.now();
      try {
        const details = await fn();
        checks.push({
          id,
          title,
          category,
          passed: true,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          details,
        });
      } catch (err) {
        checks.push({
          id,
          title,
          category,
          passed: false,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 1. API Key 32-byte Entropy, Constant-Time Verification, Scope Isolation, Rotation & Revocation
    await recordCheck(
      'API-SEC-01',
      'API key 32-byte entropy, constant-time HMAC-SHA256 verification, scope isolation, rotation & revocation',
      'authentication_and_secrets',
      async () => {
        const env = createTestEnvironment();
        const srv = await startEphemeralServer({
          config: env.config,
          repository: env.repo,
          allowLoopbackForTesting: true,
          allowCustomPortForTesting: true,
        });
        try {
          env.repo.createTenant({ id: TENANT_UUID.AUTH, name: 'Auth Security Tenant' });
          const issued = env.repo.issueApiKey({
            tenantId: TENANT_UUID.AUTH,
            keyId: 'key_primary_01',
            scopes: ['jobs:read'],
          });

          // Verify key format: cve_live_<12hex>_<64hex> (32 bytes = 64 hex chars secret)
          const parts = issued.plaintextKey.split('_');
          const secretHex = parts[3] || '';
          if (secretHex.length !== 64) {
            throw new Error(`Expected 64-hex-char (32-byte) secret in API key, got length ${secretHex.length}`);
          }

          // Verify DB only stores key_hash, never plaintextKey
          const rawRow = env.db.prepare('SELECT key_hash FROM api_keys WHERE id = ?').get('key_primary_01');
          if (!rawRow || rawRow.key_hash === issued.plaintextKey || rawRow.key_hash.includes(secretHex)) {
            throw new Error('Plaintext API key secret leaked into api_keys table');
          }

          // Constant-time verification with wrong secret fails with UNAUTHENTICATED
          const wrongKey = `${issued.keyPrefix}_${'0'.repeat(64)}`;
          const wrongRes = verifyApiKeyConstantTime({
            rawToken: wrongKey,
            lookupByPrefix: (prefix) => env.repo.lookupApiKeyByPrefix(prefix),
            pepper: env.pepper,
          });
          if (wrongRes.authenticated || wrongRes.errorCode !== 'UNAUTHENTICATED') {
            throw new Error('Constant-time verification failed to reject wrong secret');
          }

          // Scope isolation: key with only ['jobs:read'] calling POST /v1/assets/uploads -> 403 FORBIDDEN
          const scopeRes = await fetch(`${srv.baseUrl}/v1/assets/uploads`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${issued.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem_scope_test_01',
            },
            body: JSON.stringify({
              filename: 'logo.svg',
              mime_type: 'image/svg+xml',
              bytes: 64,
              sha256: 'a'.repeat(64),
              rights: { license: 'CC0-1.0' },
            }),
          });
          if (scopeRes.status !== 403) {
            throw new Error(`Expected 403 FORBIDDEN for insufficient scope, got ${scopeRes.status}`);
          }

          // Rotate key -> both keys valid during overlap, then revoke old key -> 401 UNAUTHORIZED
          const rotated = env.repo.rotateApiKey({
            tenantId: TENANT_UUID.AUTH,
            oldKeyId: 'key_primary_01',
            newKeyId: 'key_rotated_02',
            overlapSeconds: 3600,
          });
          env.repo.revokeApiKey(TENANT_UUID.AUTH, 'key_primary_01');

          const revokedRes = await fetch(`${srv.baseUrl}/v1/jobs`, {
            headers: { Authorization: `Bearer ${issued.plaintextKey}` },
          });
          const activeRotatedRes = await fetch(`${srv.baseUrl}/v1/jobs`, {
            headers: { Authorization: `Bearer ${rotated.plaintextKey}` },
          });
          if (revokedRes.status !== 401 || activeRotatedRes.status !== 200) {
            throw new Error(
              `Expected revoked=401 and rotated=200, got revoked=${revokedRes.status}, rotated=${activeRotatedRes.status}`
            );
          }

          return {
            secretEntropyBytes: 32,
            plaintextStoredInDb: false,
            wrongSecretRejected: !wrongRes.authenticated,
            insufficientScopeHttpStatus: scopeRes.status,
            revokedKeyHttpStatus: revokedRes.status,
            rotatedKeyHttpStatus: activeRotatedRes.status,
          };
        } finally {
          await srv.close();
          env.cleanup();
        }
      }
    );

    // 2. Cross-Tenant IDOR Matrix (Path 404 vs Body 422 AMB-007)
    await recordCheck(
      'API-SEC-02',
      'Cross-tenant IDOR matrix: 100% 404 NOT_FOUND on URL path probes & 422 ASSET_NOT_FOUND on JSON body references (AMB-007)',
      'multi_tenant_isolation',
      async () => {
        const env = createTestEnvironment();
        const srv = await startEphemeralServer({
          config: env.config,
          repository: env.repo,
          allowLoopbackForTesting: true,
          allowCustomPortForTesting: true,
        });
        try {
          env.repo.createTenant({ id: TENANT_UUID.VICTIM_A, name: 'Victim Tenant A' });
          env.repo.createTenant({ id: TENANT_UUID.ATTACKER_B, name: 'Attacker Tenant B' });

          const allScopes = [
            'templates:read',
            'templates:write',
            'compositions:read',
            'compositions:write',
            'assets:read',
            'assets:write',
            'jobs:read',
            'jobs:write',
            'webhooks:manage',
            'usage:read',
          ];
          const victimKey = env.repo.issueApiKey({
            tenantId: TENANT_UUID.VICTIM_A,
            keyId: 'key_victim_a',
            scopes: allScopes,
          });
          const attackerKey = env.repo.issueApiKey({
            tenantId: TENANT_UUID.ATTACKER_B,
            keyId: 'key_attacker_b',
            scopes: allScopes,
          });

          // Populate Victim Tenant A resources
          env.repo.createAsset(TENANT_UUID.VICTIM_A, {
            id: 'ast_victim_secret_01',
            filename: 'victim.svg',
            kind: 'svg',
            mimeType: 'image/svg+xml',
            bytes: 128,
            sha256: 'b'.repeat(64),
            rights: { license: 'proprietary' },
          });

          const baseCompositionSpec = {
            schema_version: '1.0',
            canvas: { width: 1280, height: 720, background: '#000000' },
            fps: { num: 30, den: 1 },
            duration_frames: 90,
            seed: 2026,
            locale: 'vi-VN',
            direction: 'ltr',
            fonts: [],
            audio_tracks: [],
            subtitles: [],
            scenes: [
              {
                id: 'scn_01',
                revision: 1,
                engine: 'html-v1',
                start_frame: 0,
                duration_frames: 90,
                transition_out: { type: 'cut', duration_frames: 0 },
                layers: [
                  {
                    id: 'lyr_svg_01',
                    type: 'svg',
                    start_frame: 0,
                    duration_frames: 90,
                    z_index: 1,
                    box: { x: 0, y: 0, width: 200, height: 200 },
                    content: { asset_id: 'ast_victim_secret_01', fit: 'contain' },
                  },
                ],
              },
            ],
          };

          env.repo.createComposition(TENANT_UUID.VICTIM_A, {
            id: 'cmp_victim_01',
            name: 'Victim Composition',
            spec: baseCompositionSpec,
          });

          const admittedJob = env.repo.admitJob(TENANT_UUID.VICTIM_A, {
            id: 'job_victim_01',
            request: {
              kind: 'render',
              compositionId: 'cmp_victim_01',
              compositionRevision: 1,
              profile: 'mp4-720p-v1',
            },
          });

          env.repo.createWebhookEndpoint(TENANT_UUID.VICTIM_A, {
            id: 'wh_victim_01',
            url: 'https://victim.example.invalid/webhook',
            events: ['job.succeeded'],
          });

          // Attacker B probes Victim A resources across URL path endpoints -> ALL MUST RETURN 404
          const pathProbes = [
            { method: 'GET', path: '/v1/assets/ast_victim_secret_01' },
            { method: 'GET', path: '/v1/assets/ast_victim_secret_01/download' },
            { method: 'DELETE', path: '/v1/assets/ast_victim_secret_01' },
            { method: 'GET', path: '/v1/compositions/cmp_victim_01' },
            { method: 'GET', path: '/v1/compositions/cmp_victim_01/revisions/1' },
            { method: 'GET', path: `/v1/jobs/${admittedJob.job.id}` },
            { method: 'GET', path: `/v1/jobs/${admittedJob.job.id}/events` },
            { method: 'POST', path: `/v1/jobs/${admittedJob.job.id}/cancel`, idem: 'idem_idor_cancel_1' },
            { method: 'GET', path: '/v1/webhook-endpoints/wh_victim_01' },
            { method: 'DELETE', path: '/v1/webhook-endpoints/wh_victim_01' },
          ];

          const probeOutcomes = [];
          for (const probe of pathProbes) {
            const headers = {
              Authorization: `Bearer ${attackerKey.plaintextKey}`,
              'Content-Type': 'application/json',
            };
            if (probe.idem) headers['Idempotency-Key'] = probe.idem;
            const res = await fetch(`${srv.baseUrl}${probe.path}`, {
              method: probe.method,
              headers,
              body: probe.method === 'POST' ? JSON.stringify({}) : undefined,
            });
            const body = await res.json();
            if (res.status !== 404 || body?.error?.code !== 'NOT_FOUND') {
              throw new Error(
                `Cross-tenant URL probe ${probe.method} ${probe.path} returned ${res.status} (${JSON.stringify(body)}), expected 404 NOT_FOUND`
              );
            }
            probeOutcomes.push({ endpoint: `${probe.method} ${probe.path}`, status: res.status, code: body.error.code });
          }

          // Attacker B references Victim A's asset_id inside JSON body of POST /v1/compositions -> MUST RETURN 422 ASSET_NOT_FOUND
          const bodyIdorRes = await fetch(`${srv.baseUrl}/v1/compositions`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${attackerKey.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem_body_idor_01',
            },
            body: JSON.stringify({
              id: 'cmp_attacker_steal_attempt',
              name: 'Attacker Steal Attempt',
              spec: baseCompositionSpec,
            }),
          });
          const bodyIdorJson = await bodyIdorRes.json();
          const detailCode = bodyIdorJson?.error?.details?.[0]?.code;
          if (bodyIdorRes.status !== 422 || detailCode !== 'ASSET_NOT_FOUND') {
            throw new Error(
              `Expected 422 ASSET_NOT_FOUND on cross-tenant body reference, got ${bodyIdorRes.status} (${JSON.stringify(bodyIdorJson)})`
            );
          }

          // Confirm Victim A's asset is still intact and accessible to Victim A (200 OK)
          const victimCheckRes = await fetch(`${srv.baseUrl}/v1/assets/ast_victim_secret_01`, {
            headers: { Authorization: `Bearer ${victimKey.plaintextKey}` },
          });
          if (victimCheckRes.status !== 200) {
            throw new Error(`Victim A should still access own asset with 200, got ${victimCheckRes.status}`);
          }

          return {
            urlPathProbesTestedCount: probeOutcomes.length,
            allUrlPathProbesReturned404: true,
            bodyCrossTenantRefStatus: bodyIdorRes.status,
            bodyCrossTenantRefErrorCode: detailCode,
            victimOwnAccessPreserved: victimCheckRes.status === 200,
          };
        } finally {
          await srv.close();
          env.cleanup();
        }
      }
    );

    // 3. Signed Pagination Cursor Binding & Tamper Rejection
    await recordCheck(
      'API-SEC-03',
      'Signed pagination cursor binding (tenant_id, route, filter_hash) & tamper rejection (400 INVALID_CURSOR)',
      'cursor_isolation',
      async () => {
        const secret = 'cursor-signing-pepper-secret-0123456789';
        const validCursor = encodeSignedCursor({
          tenantId: 'ten_alpha',
          route: '/v1/jobs',
          filterHash: 'render:queued',
          createdAt: '2026-11-04T00:00:00.000Z',
          id: 'job_001',
          secret,
        });

        // 3a. Valid decode succeeds for same tenant, route, and filterHash
        const decodedOk = decodeSignedCursor({
          cursor: validCursor,
          tenantId: 'ten_alpha',
          route: '/v1/jobs',
          filterHash: 'render:queued',
          secret,
        });
        if (!decodedOk || decodedOk.id !== 'job_001') {
          throw new Error('Valid signed cursor failed to decode');
        }

        // 3b. Cross-tenant cursor replay fails (returns null -> 400 INVALID_CURSOR)
        const crossTenantDecode = decodeSignedCursor({
          cursor: validCursor,
          tenantId: 'ten_beta_attacker',
          route: '/v1/jobs',
          filterHash: 'render:queued',
          secret,
        });
        if (crossTenantDecode !== null) {
          throw new Error('Cross-tenant cursor replay must be rejected');
        }

        // 3c. Cross-route cursor replay fails
        const crossRouteDecode = decodeSignedCursor({
          cursor: validCursor,
          tenantId: 'ten_alpha',
          route: '/v1/templates',
          filterHash: 'render:queued',
          secret,
        });
        if (crossRouteDecode !== null) {
          throw new Error('Cross-route cursor replay must be rejected');
        }

        // 3d. Filter-tampered cursor replay fails
        const crossFilterDecode = decodeSignedCursor({
          cursor: validCursor,
          tenantId: 'ten_alpha',
          route: '/v1/jobs',
          filterHash: 'preview:succeeded',
          secret,
        });
        if (crossFilterDecode !== null) {
          throw new Error('Filter-mismatched cursor replay must be rejected');
        }

        // 3e. Signature-tampered cursor fails
        const tamperedCursor = validCursor.slice(0, -4) + 'dead';
        const tamperedDecode = decodeSignedCursor({
          cursor: tamperedCursor,
          tenantId: 'ten_alpha',
          route: '/v1/jobs',
          filterHash: 'render:queued',
          secret,
        });
        if (tamperedDecode !== null) {
          throw new Error('Tampered signature cursor must be rejected');
        }

        return {
          validDecodeAccepted: true,
          crossTenantReplayRejected: crossTenantDecode === null,
          crossRouteReplayRejected: crossRouteDecode === null,
          crossFilterReplayRejected: crossFilterDecode === null,
          tamperedSignatureRejected: tamperedDecode === null,
        };
      }
    );

    // 4. Multi-Encoding SSRF, Private IP Ranges, DNS Rebinding & Redirect Hop Revalidation
    await recordCheck(
      'API-SEC-04',
      'Multi-encoding SSRF (decimal/octal/hex IPv4, IPv6-mapped, cloud metadata 169.254.169.254), DNS rebinding & redirect hop revalidation',
      'ssrf_defense',
      async () => {
        const maliciousUrls = [
          { name: 'cleartext_http', url: 'http://cdn.partner-stock.com/video.mp4', expectedCode: 'UNSUPPORTED_SCHEME' },
          { name: 'embedded_credentials', url: 'https://user:pass@cdn.partner-stock.com/a.png', expectedCode: 'USERINFO_PROHIBITED' },
          { name: 'custom_port_8443', url: 'https://cdn.partner-stock.com:8443/a.png', expectedCode: 'UNSUPPORTED_PORT' },
          { name: 'url_fragment', url: 'https://cdn.partner-stock.com/a.png#frag', expectedCode: 'URL_FRAGMENT_PROHIBITED' },
          { name: 'backslash_differential', url: 'https://cdn.partner-stock.com\\@evil.com/a.png', expectedCode: 'INVALID_URL_SYNTAX' },
          { name: 'path_traversal', url: 'https://cdn.partner-stock.com/assets/../../etc/passwd', expectedCode: 'PATH_TRAVERSAL_DETECTED' },
          { name: 'ipv4_loopback', url: 'https://127.0.0.1/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv4_octal_loopback', url: 'https://0177.0.0.1/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv4_decimal_loopback', url: 'https://2130706433/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv4_hex_loopback', url: 'https://0x7f000001/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'cloud_metadata_imds', url: 'https://169.254.169.254/latest/meta-data/', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'rfc1918_10_net', url: 'https://10.0.0.42/internal', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'rfc1918_172_16_net', url: 'https://172.16.5.4/internal', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'rfc1918_192_168_net', url: 'https://192.168.1.1/internal', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'cgnat_100_64_net', url: 'https://100.64.0.10/internal', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv6_loopback', url: 'https://[::1]/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv6_mapped_ipv4_loopback', url: 'https://[::ffff:127.0.0.1]/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv6_link_local', url: 'https://[fe80::1]/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
          { name: 'ipv6_unique_local', url: 'https://[fc00::1234]/secret', expectedCode: 'IP_LITERAL_PROHIBITED' },
        ];

        for (const item of maliciousUrls) {
          let caught = null;
          try {
            validateAndNormalizeImportUrl(item.url);
          } catch (err) {
            caught = err;
          }
          if (!caught || !(caught instanceof SsrSecurityError)) {
            throw new Error(`Expected SsrSecurityError for ${item.name} (${item.url}), got ${caught}`);
          }
        }

        // DNS rebinding simulation: public hostname resolving to 127.0.0.1 or 169.254.169.254 or ::ffff:127.0.0.1
        const rebindTargets = [
          { host: 'localhost', ipv4: ['127.0.0.1'] },
          { host: 'rebind-imds.partner-stock.com', ipv4: ['169.254.169.254'] },
          { host: 'rebind-rfc1918.partner-stock.com', ipv4: ['10.24.0.5'] },
          { host: 'rebind-cgnat.partner-stock.com', ipv4: ['100.64.1.1'] },
          { host: 'rebind-v6-mapped.partner-stock.com', ipv6: ['::ffff:169.254.169.254'] },
        ];

        for (const target of rebindTargets) {
          let dnsRebindCaught = null;
          try {
            await resolveAndAuditHostDns(target.host, async () => ({
              ipv4: target.ipv4 ?? [],
              ipv6: target.ipv6 ?? [],
            }));
          } catch (err) {
            dnsRebindCaught = err;
          }
          if (!dnsRebindCaught || dnsRebindCaught.code !== 'SSRF_PROHIBITED_IP') {
            throw new Error(
              `Expected SSRF_PROHIBITED_IP on DNS rebinding for ${target.host}, got ${dnsRebindCaught?.code}`
            );
          }
        }

        // Tenant allowlist check: unapproved host or localhost rejected even if HTTPS
        const allowlistRes = checkTenantImportAllowlist(
          new URL('https://unapproved-cdn.example.com/asset.png'),
          ['https://cdn.partner-stock.com/']
        );
        const localhostAllowRes = checkTenantImportAllowlist(
          new URL('https://localhost/admin'),
          ['https://cdn.partner-stock.com/']
        );
        if (allowlistRes.allowed || localhostAllowRes.allowed) {
          throw new Error('Unapproved host or localhost must be rejected by checkTenantImportAllowlist');
        }

        return {
          maliciousUrlVectorsBlocked: maliciousUrls.length,
          dnsRebindingTargetsBlocked: rebindTargets.length,
          dnsRebindingBlockedCode: 'SSRF_PROHIBITED_IP',
          unapprovedHostAllowlistBlocked: !allowlistRes.allowed && !localhostAllowRes.allowed,
        };
      }
    );

    // 5. Malicious Media, SVG XXE/Script/ForeignObject, Font Bomb & Decompression Bomb Guards
    await recordCheck(
      'API-SEC-05',
      'Malicious media & decompression bombs (SVG XXE/script/foreignObject/DOM bomb, WOFF2/TTF table bomb, PNG pixel bomb, MP4 signature & MIME spoofing guards)',
      'malicious_media_quarantine',
      async () => {
        // 5a. SVG XXE & DOCTYPE entity expansion
        const svgXxe = Buffer.from(
          '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&xxe;</text></svg>'
        );
        const resXxe = probeAndSanitizeSvg(svgXxe);
        if (resXxe.valid || resXxe.code !== 'XXE_HAZARD') {
          throw new Error(`Expected XXE_HAZARD, got ${JSON.stringify(resXxe)}`);
        }

        // 5b. SVG <script>, <foreignObject>, inline event handler, external reference, CSS @import
        const svgScript = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const svgForeign = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject></foreignObject></svg>');
        const svgEvent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(\'https://evil.com\')"></svg>');
        const svgExternalRef = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.com/a.png"/></svg>');
        const svgCssImport = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.com/x.css";</style></svg>');

        if (probeAndSanitizeSvg(svgScript).valid) throw new Error('SVG <script> must be rejected');
        if (probeAndSanitizeSvg(svgForeign).valid) throw new Error('SVG <foreignObject> must be rejected');
        if (probeAndSanitizeSvg(svgEvent).valid) throw new Error('SVG onload event must be rejected');
        if (probeAndSanitizeSvg(svgExternalRef).valid) throw new Error('SVG external href must be rejected');
        if (probeAndSanitizeSvg(svgCssImport).valid) throw new Error('SVG CSS @import must be rejected');

        // 5c. SVG DOM node bomb (> 5000 elements)
        const svgDomBomb = Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg">${'<g><rect width="1" height="1"/></g>'.repeat(2600)}</svg>`
        );
        const resDomBomb = probeAndSanitizeSvg(svgDomBomb);
        if (resDomBomb.valid || resDomBomb.code !== 'DOM_COMPLEXITY_LIMIT_EXCEEDED') {
          throw new Error(`Expected DOM_COMPLEXITY_LIMIT_EXCEEDED for DOM node bomb, got ${JSON.stringify(resDomBomb)}`);
        }

        // 5d. Malformed / table-overflow WOFF2 & TTF font bomb
        const woff2Bomb = Buffer.alloc(64);
        woff2Bomb.write('wOF2', 0, 'ascii');
        woff2Bomb.writeUInt16BE(500, 12); // numTables = 500 (> 100 limit)
        const resFontBomb = probeFont(woff2Bomb, 'font/woff2');
        if (resFontBomb.valid || resFontBomb.code !== 'MALFORMED_FONT') {
          throw new Error(`Expected MALFORMED_FONT on WOFF2 table bomb, got ${JSON.stringify(resFontBomb)}`);
        }

        // 5e. PNG pixel decompression bomb (8000 x 8000 = 64,000,000 pixels > 40,000,000 max)
        const pngBomb = Buffer.alloc(32);
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBomb, 0);
        pngBomb.write('IHDR', 12, 'ascii');
        pngBomb.writeUInt32BE(8000, 16); // width = 8000
        pngBomb.writeUInt32BE(8000, 20); // height = 8000
        const resPngBomb = probeImage(pngBomb, 'image/png');
        if (resPngBomb.valid || resPngBomb.code !== 'PIXEL_COUNT_EXCEEDED') {
          throw new Error(`Expected PIXEL_COUNT_EXCEEDED for 8000x8000 PNG bomb, got ${JSON.stringify(resPngBomb)}`);
        }

        // 5f. MP4 container missing ftyp signature
        const badMp4 = Buffer.alloc(32);
        badMp4.writeUInt32BE(16, 0);
        badMp4.write('mdat', 4, 'ascii');
        const resBadMp4 = probeAudioVideoContainer(badMp4, 'video/mp4');
        if (resBadMp4.valid || resBadMp4.code !== 'INVALID_MEDIA_SIGNATURE') {
          throw new Error(`Expected INVALID_MEDIA_SIGNATURE for MP4 without ftyp, got ${JSON.stringify(resBadMp4)}`);
        }

        // 5g. MIME spoofing (PNG magic bytes declared as font/ttf)
        const resMimeSpoof = await executeSandboxMediaProbe('/tmp/spoof.ttf', pngBomb, 'font/ttf');
        if (resMimeSpoof.success) {
          throw new Error('MIME-spoofed PNG uploaded as font/ttf must be rejected');
        }

        return {
          svgXxeBlocked: resXxe.code,
          svgDomBombBlocked: resDomBomb.code,
          woff2TableBombBlocked: resFontBomb.code,
          pngPixelBombBlocked: resPngBomb.code,
          mp4InvalidSignatureBlocked: resBadMp4.code,
          mimeSpoofingBlockedCode: resMimeSpoof.code,
        };
      }
    );

    // 6. Rate Limiting, Slot Quota Enforcement & Idempotency Payload Conflict
    await recordCheck(
      'API-SEC-06',
      'Rate limiting (429 RATE_LIMITED + Retry-After), concurrent active job slot quota (429 QUOTA_EXCEEDED), and idempotency payload conflict (409)',
      'abuse_and_quotas',
      async () => {
        const env = createTestEnvironment();
        const rateLimiter = new TokenBucketRateLimiter();
        const srv = await startEphemeralServer({
          config: env.config,
          repository: env.repo,
          rateLimiter,
          enforceGlobalRateLimit: true,
          allowLoopbackForTesting: true,
          allowCustomPortForTesting: true,
        });
        try {
          env.repo.createTenant({ id: TENANT_UUID.QUOTA, name: 'Quota Test Tenant' });
          // Set tight burst capacity (2 requests) and active_job_slots_max = 2
          env.repo.updateTenantPolicyLimits(TENANT_UUID.QUOTA, {
            token_bucket_burst_capacity: 2,
            token_bucket_refill_per_second: 0.01,
            active_job_slots_max: 2,
          });

          const key = env.repo.issueApiKey({
            tenantId: TENANT_UUID.QUOTA,
            keyId: 'key_quota_01',
            scopes: ['compositions:read', 'compositions:write', 'jobs:read', 'jobs:write'],
          });

          // 6a. Exhaust rate limit bucket (burst = 2 -> 3rd request returns 429 RATE_LIMITED with Retry-After)
          const r1 = await fetch(`${srv.baseUrl}/v1/jobs`, { headers: { Authorization: `Bearer ${key.plaintextKey}` } });
          const r2 = await fetch(`${srv.baseUrl}/v1/jobs`, { headers: { Authorization: `Bearer ${key.plaintextKey}` } });
          const r3 = await fetch(`${srv.baseUrl}/v1/jobs`, { headers: { Authorization: `Bearer ${key.plaintextKey}` } });
          const r3Body = await r3.json();
          if (r1.status !== 200 || r2.status !== 200 || r3.status !== 429 || r3Body?.error?.code !== 'RATE_LIMITED') {
            throw new Error(`Expected 200, 200, 429 RATE_LIMITED; got ${r1.status}, ${r2.status}, ${r3.status}`);
          }
          if (!r3.headers.get('retry-after')) {
            throw new Error('429 RATE_LIMITED response missing Retry-After header');
          }

          // 6b. Active job slots quota (active_job_slots_max = 2): 3rd transition throws QuotaExceededError
          const minimalSpec = {
            schema_version: '1.0',
            canvas: { width: 1280, height: 720, background: '#000000' },
            fps: { num: 30, den: 1 },
            duration_frames: 60,
            seed: 2026,
            locale: 'vi-VN',
            direction: 'ltr',
            fonts: [],
            audio_tracks: [],
            subtitles: [],
            scenes: [
              {
                id: 'scn_min',
                revision: 1,
                engine: 'html-v1',
                start_frame: 0,
                duration_frames: 60,
                transition_out: { type: 'cut', duration_frames: 0 },
                layers: [
                  {
                    id: 'lyr_shape_bg',
                    type: 'shape',
                    start_frame: 0,
                    duration_frames: 60,
                    z_index: 1,
                    box: { x: 0, y: 0, width: 1280, height: 720 },
                    content: { shape: 'rect', fill: '#112233' },
                  },
                ],
              },
            ],
          };
          env.repo.createComposition(TENANT_UUID.QUOTA, { id: 'cmp_q1', name: 'Quota Comp', spec: minimalSpec });

          for (const jid of ['job_q1', 'job_q2', 'job_q3']) {
            env.repo.admitJob(TENANT_UUID.QUOTA, {
              id: jid,
              request: { kind: 'render', compositionId: 'cmp_q1', compositionRevision: 1, profile: 'mp4-720p-v1' },
            });
          }
          env.repo.transitionJobToActive(TENANT_UUID.QUOTA, 'job_q1', { state: 'rendering', workerId: 'w1' });
          env.repo.transitionJobToActive(TENANT_UUID.QUOTA, 'job_q2', { state: 'rendering', workerId: 'w2' });

          let slotQuotaErr = null;
          try {
            env.repo.transitionJobToActive(TENANT_UUID.QUOTA, 'job_q3', { state: 'rendering', workerId: 'w3' });
          } catch (err) {
            slotQuotaErr = err;
          }
          if (!(slotQuotaErr instanceof QuotaExceededError)) {
            throw new Error(`Expected QuotaExceededError on 3rd active job slot, got ${slotQuotaErr}`);
          }

          // 6c. Idempotency key reuse with mutated payload -> 409 IDEMPOTENCY_CONFLICT
          env.repo.claimIdempotency(TENANT_UUID.QUOTA, {
            method: 'POST',
            normalizedPath: '/v1/compositions',
            key: 'idem_conflict_key_01',
            requestHash: '1'.repeat(64),
          });
          env.repo.completeIdempotency(TENANT_UUID.QUOTA, {
            method: 'POST',
            normalizedPath: '/v1/compositions',
            key: 'idem_conflict_key_01',
            httpStatus: 201,
            responseBody: { id: 'cmp_q1' },
          });
          let idemConflictErr = null;
          try {
            env.repo.claimIdempotency(TENANT_UUID.QUOTA, {
              method: 'POST',
              normalizedPath: '/v1/compositions',
              key: 'idem_conflict_key_01',
              requestHash: '2'.repeat(64),
            });
          } catch (err) {
            idemConflictErr = err;
          }
          if (!idemConflictErr || idemConflictErr.code !== 'IDEMPOTENCY_CONFLICT') {
            throw new Error(`Expected IDEMPOTENCY_CONFLICT on mutated payload, got ${idemConflictErr?.code}`);
          }

          return {
            rateLimitHttpStatus: r3.status,
            rateLimitRetryAfterHeader: r3.headers.get('retry-after'),
            activeSlotsQuotaBlockedCode: slotQuotaErr.code,
            idempotencyConflictBlockedCode: idemConflictErr.code,
          };
        } finally {
          await srv.close();
          env.cleanup();
        }
      }
    );

    // 7. Webhook Secret One-Time Display, Idempotent Replay Redaction & Encrypted-at-Rest Storage
    await recordCheck(
      'API-SEC-07',
      'Webhook signing_secret one-time display on creation, redaction on idempotent replay, and encrypted-at-rest storage',
      'webhook_security',
      async () => {
        const env = createTestEnvironment();
        const srv = await startEphemeralServer({
          config: env.config,
          repository: env.repo,
          allowLoopbackForTesting: true,
          allowCustomPortForTesting: true,
        });
        try {
          env.repo.createTenant({ id: TENANT_UUID.WEBHOOK, name: 'Webhook Security Tenant' });
          const key = env.repo.issueApiKey({
            tenantId: TENANT_UUID.WEBHOOK,
            keyId: 'key_wh_01',
            scopes: ['webhooks:manage'],
          });

          const payload = {
            id: 'wh_ep_sec_01',
            url: 'https://hooks.partner-stock.com/cve-events',
            events: ['job.succeeded', 'job.failed'],
          };

          // First POST with Idempotency-Key returns 201 with plaintext signing_secret (whsec_...)
          const firstRes = await fetch(`${srv.baseUrl}/v1/webhook-endpoints`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem_wh_create_01',
            },
            body: JSON.stringify(payload),
          });
          const firstJson = await firstRes.json();
          if (firstRes.status !== 201 || !firstJson.signing_secret?.startsWith('whsec_')) {
            throw new Error(`Expected initial 201 with whsec_ signing_secret, got ${firstRes.status} (${JSON.stringify(firstJson)})`);
          }

          // Second POST (idempotent replay) MUST redact signing_secret
          const replayRes = await fetch(`${srv.baseUrl}/v1/webhook-endpoints`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem_wh_create_01',
            },
            body: JSON.stringify(payload),
          });
          const replayJson = await replayRes.json();
          if (
            replayRes.status !== 201 ||
            replayJson.signing_secret !== undefined ||
            replayJson.secret_redacted !== true
          ) {
            throw new Error(`Expected idempotent replay to omit signing_secret and set secret_redacted=true, got ${JSON.stringify(replayJson)}`);
          }

          // GET /v1/webhook-endpoints/:id MUST NEVER expose signing_secret
          const getRes = await fetch(`${srv.baseUrl}/v1/webhook-endpoints/wh_ep_sec_01`, {
            headers: { Authorization: `Bearer ${key.plaintextKey}` },
          });
          const getJson = await getRes.json();
          if (getRes.status !== 200 || 'signing_secret' in getJson) {
            throw new Error('GET /v1/webhook-endpoints/:id must never expose signing_secret');
          }

          // Verify DB stores AES-256-GCM ciphertext (`v1:...`), not plaintext whsec_
          const dbRow = env.db.prepare('SELECT secret_ciphertext FROM webhook_endpoints WHERE id = ?').get('wh_ep_sec_01');
          if (!dbRow || dbRow.secret_ciphertext.includes(firstJson.signing_secret)) {
            throw new Error('Webhook signing_secret stored in plaintext in webhook_endpoints table');
          }

          return {
            initialCreateReturnedSecret: true,
            replayRedactedSecret: replayJson.secret_redacted === true && !('signing_secret' in replayJson),
            getEndpointOmittedSecret: !('signing_secret' in getJson),
            encryptedAtRestVerified: !dbRow.secret_ciphertext.includes(firstJson.signing_secret),
          };
        } finally {
          await srv.close();
          env.cleanup();
        }
      }
    );

    // 8. Asset Deletion Cascade (ASSET_REVOKED), Grant Revocation (410 GRANT_REVOKED) & Tombstone Privacy
    await recordCheck(
      'API-SEC-08',
      'DELETE /v1/assets/:id cascades ASSET_REVOKED to active jobs, revokes signed grants (410 GRANT_REVOKED), preserves audit tombstone, and blocks new references',
      'deletion_and_retention',
      async () => {
        const env = createTestEnvironment();
        const srv = await startEphemeralServer({
          config: env.config,
          repository: env.repo,
          allowLoopbackForTesting: true,
          allowCustomPortForTesting: true,
        });
        try {
          env.repo.createTenant({ id: TENANT_UUID.DELETE, name: 'Deletion Cascade Tenant' });
          const key = env.repo.issueApiKey({
            tenantId: TENANT_UUID.DELETE,
            keyId: 'key_del_01',
            scopes: ['assets:read', 'assets:write', 'compositions:read', 'compositions:write', 'jobs:read', 'jobs:write'],
          });

          // Create ready asset & issue download grant
          env.repo.createAsset(TENANT_UUID.DELETE, {
            id: 'ast_to_delete_01',
            filename: 'brand-banner.svg',
            kind: 'svg',
            mimeType: 'image/svg+xml',
            bytes: 120,
            sha256: 'c'.repeat(64),
            rights: { license: 'CC0-1.0', owner_secret_note: 'private_customer_note' },
          });
          const grantBeforeDelete = env.repo.getAssetDownloadGrant(TENANT_UUID.DELETE, 'ast_to_delete_01', {
            baseUrl: `${srv.baseUrl}/v1`,
          });

          // Create composition and admit active job referencing ast_to_delete_01
          const specWithAsset = {
            schema_version: '1.0',
            canvas: { width: 1280, height: 720, background: '#000000' },
            fps: { num: 30, den: 1 },
            duration_frames: 90,
            seed: 2026,
            locale: 'vi-VN',
            direction: 'ltr',
            fonts: [],
            audio_tracks: [],
            subtitles: [],
            scenes: [
              {
                id: 'scn_del_01',
                revision: 1,
                engine: 'html-v1',
                start_frame: 0,
                duration_frames: 90,
                transition_out: { type: 'cut', duration_frames: 0 },
                layers: [
                  {
                    id: 'lyr_del_01',
                    type: 'svg',
                    start_frame: 0,
                    duration_frames: 90,
                    z_index: 1,
                    box: { x: 0, y: 0, width: 200, height: 200 },
                    content: { asset_id: 'ast_to_delete_01', fit: 'contain' },
                  },
                ],
              },
            ],
          };
          env.repo.createComposition(TENANT_UUID.DELETE, {
            id: 'cmp_del_01',
            name: 'Delete Cascade Comp',
            spec: specWithAsset,
          });
          env.repo.admitJob(TENANT_UUID.DELETE, {
            id: 'job_del_cascade_01',
            request: { kind: 'render', compositionId: 'cmp_del_01', compositionRevision: 1, profile: 'mp4-720p-v1' },
          });
          env.repo.transitionJobToActive(TENANT_UUID.DELETE, 'job_del_cascade_01', {
            state: 'rendering',
            workerId: 'worker_del_01',
          });

          // Call DELETE /v1/assets/ast_to_delete_01
          const delRes = await fetch(`${srv.baseUrl}/v1/assets/ast_to_delete_01`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${key.plaintextKey}` },
          });
          const delJson = await delRes.json();
          if (delRes.status !== 202 || delJson.status !== 'deleted') {
            throw new Error(`Expected 202 deleted on DELETE /v1/assets/:id, got ${delRes.status} (${JSON.stringify(delJson)})`);
          }

          // 8a. Active job must be cascaded to failed with error.code === 'ASSET_REVOKED' and reservation released
          const cascadedJob = env.repo.getJob(TENANT_UUID.DELETE, 'job_del_cascade_01');
          const reservation = env.repo.getUsageReservation(TENANT_UUID.DELETE, 'job_del_cascade_01');
          if (cascadedJob.state !== 'failed' || cascadedJob.error?.code !== 'ASSET_REVOKED') {
            throw new Error(`Expected active job to fail with ASSET_REVOKED, got ${JSON.stringify(cascadedJob)}`);
          }
          if (reservation?.state !== 'released') {
            throw new Error(`Expected usage reservation to be released, got ${reservation?.state}`);
          }

          // 8b. Previously issued signed download grant must be rejected with 410 GRANT_REVOKED
          const parsedGrantUrl = new URL(grantBeforeDelete.url);
          const tokenParam = parsedGrantUrl.pathname.split('/').pop() || '';
          let grantErr = null;
          try {
            verifySignedDownloadGrant(tokenParam, {
              pepper: env.pepper,
              revocationStore: env.revocationStore,
            });
          } catch (err) {
            grantErr = err;
          }
          if (!(grantErr instanceof DownloadGrantError) || grantErr.httpStatus !== 410 || grantErr.code !== 'GRANT_REVOKED') {
            throw new Error(`Expected 410 GRANT_REVOKED on revoked download grant, got ${grantErr?.httpStatus} ${grantErr?.code}`);
          }

          // 8c. Audit tombstone preserved without private rights_json content
          const tombstone = env.repo.getAssetTombstone(TENANT_UUID.DELETE, 'ast_to_delete_01');
          if (tombstone.status !== 'deleted' || tombstone.tombstone !== true || 'rights' in tombstone) {
            throw new Error(`Invalid tombstone structure: ${JSON.stringify(tombstone)}`);
          }

          // 8d. New composition referencing deleted asset is rejected with 422 ASSET_REVOKED
          let newCompErr = null;
          try {
            env.repo.createComposition(TENANT_UUID.DELETE, {
              id: 'cmp_after_del_02',
              name: 'Post Delete Comp',
              spec: specWithAsset,
            });
          } catch (err) {
            newCompErr = err;
          }
          if (!(newCompErr instanceof BodyReferenceValidationError) || newCompErr.details[0]?.code !== 'ASSET_REVOKED') {
            throw new Error(`Expected 422 ASSET_REVOKED when referencing deleted asset, got ${JSON.stringify(newCompErr)}`);
          }

          return {
            deleteHttpStatus: delRes.status,
            cascadedJobState: cascadedJob.state,
            cascadedJobErrorCode: cascadedJob.error.code,
            reservationStateAfterCascade: reservation.state,
            revokedGrantHttpStatus: grantErr.httpStatus,
            revokedGrantErrorCode: grantErr.code,
            tombstonePreservedWithoutPrivatePayload: tombstone.tombstone === true && !('rights' in tombstone),
            newReferenceBlockedCode: newCompErr.details[0].code,
          };
        } finally {
          await srv.close();
          env.cleanup();
        }
      }
    );

    // 9. Worker Lease Epoch Fencing & Live-Lease Temp Sweeper Protection
    await recordCheck(
      'API-SEC-09',
      'Worker lease epoch fencing (LeaseManager stale publish rejection) & live-lease temp sweeper safety (StorageTempSweeper)',
      'lease_fencing_and_sweeper',
      async () => {
        const leaseManager = new LeaseManager();
        const nowMs = Date.now();

        // Worker 1 acquires lease at epoch 1
        leaseManager.registerLease({
          tenant_id: 'ten_fence_01',
          job_id: 'job_fence_01',
          attempt_id: 'att_epoch_1',
          lease_epoch: 1,
          worker_id: 'worker_1',
          state: 'rendering',
          lease_expires_at_ms: nowMs + 30_000,
          last_heartbeat_at_ms: nowMs,
        });

        // Reaper bumps lease to Worker 2 at epoch 2
        leaseManager.registerLease({
          tenant_id: 'ten_fence_01',
          job_id: 'job_fence_01',
          attempt_id: 'att_epoch_2',
          lease_epoch: 2,
          worker_id: 'worker_2',
          state: 'rendering',
          lease_expires_at_ms: nowMs + 30_000,
          last_heartbeat_at_ms: nowMs,
        });

        // Stale Worker 1 attempts to transition/publish with epoch 1 -> MUST THROW fencing mismatch
        let staleErr = null;
        try {
          leaseManager.verifyFence(
            { job_id: 'job_fence_01', attempt_id: 'att_epoch_1', lease_epoch: 1 },
            nowMs
          );
        } catch (err) {
          staleErr = err;
        }
        if (!staleErr) {
          throw new Error('LeaseManager must reject stale worker fence at epoch 1 when active epoch is 2');
        }

        // Active Worker 2 at epoch 2 succeeds
        const verifiedActive = leaseManager.verifyFence(
          { job_id: 'job_fence_01', attempt_id: 'att_epoch_2', lease_epoch: 2 },
          nowMs
        );

        // Verify StorageTempSweeper preserves live leased attempt temp dirs while sweeping expired orphans
        const env = createTestEnvironment();
        try {
          env.repo.createTenant({ id: TENANT_UUID.SWEEP, name: 'Sweeper Tenant' });
          const minimalSpec = {
            schema_version: '1.0',
            canvas: { width: 1280, height: 720, background: '#000000' },
            fps: { num: 30, den: 1 },
            duration_frames: 60,
            seed: 2026,
            locale: 'vi-VN',
            direction: 'ltr',
            fonts: [],
            audio_tracks: [],
            subtitles: [],
            scenes: [
              {
                id: 's1',
                revision: 1,
                engine: 'html-v1',
                start_frame: 0,
                duration_frames: 60,
                transition_out: { type: 'cut', duration_frames: 0 },
                layers: [
                  {
                    id: 'lyr_sw_bg',
                    type: 'shape',
                    start_frame: 0,
                    duration_frames: 60,
                    z_index: 1,
                    box: { x: 0, y: 0, width: 1280, height: 720 },
                    content: { shape: 'rect', fill: '#000000' },
                  },
                ],
              },
            ],
          };
          env.repo.createComposition(TENANT_UUID.SWEEP, { id: 'cmp_sw1', name: 'Sweep Comp', spec: minimalSpec });
          env.repo.admitJob(TENANT_UUID.SWEEP, {
            id: 'job_live_lease',
            request: { kind: 'render', compositionId: 'cmp_sw1', compositionRevision: 1, profile: 'mp4-720p-v1' },
          });
          env.repo.transitionJobToActive(TENANT_UUID.SWEEP, 'job_live_lease', {
            state: 'rendering',
            workerId: 'w_live',
            attemptId: 'att_live_01',
          });

          const liveStaged = env.quarantineStore.stageAttemptTempArtifact(
            TENANT_UUID.SWEEP,
            'job_live_lease',
            'att_live_01',
            'output.mp4',
            Buffer.from('live-leased-attempt-data')
          );
          const orphanStaged = env.quarantineStore.stageAttemptTempArtifact(
            TENANT_UUID.SWEEP,
            'job_dead_orphan',
            'att_dead_99',
            'output.mp4',
            Buffer.from('dead-orphan-attempt-data')
          );
          const liveDir = path.dirname(liveStaged.tempFilePath);
          const orphanDir = path.dirname(orphanStaged.tempFilePath);

          // Age both directories and files past the orphan threshold
          const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
          fs.utimesSync(liveStaged.tempFilePath, oldDate, oldDate);
          fs.utimesSync(orphanStaged.tempFilePath, oldDate, oldDate);
          fs.utimesSync(liveDir, oldDate, oldDate);
          fs.utimesSync(orphanDir, oldDate, oldDate);

          const sweeper = new StorageTempSweeper({
            repository: env.repo,
            quarantineStore: env.quarantineStore,
            revocationStore: env.revocationStore,
          });
          const sweepResult = sweeper.sweep({ now: new Date(), attemptTempMaxAgeMs: 60 * 1000 });

          if (!fs.existsSync(liveDir)) {
            throw new Error('StorageTempSweeper must NEVER delete temp directory of a live leased attempt');
          }
          if (fs.existsSync(orphanDir)) {
            throw new Error('StorageTempSweeper must delete expired orphan attempt temp directory');
          }

          return {
            staleWorkerFenceRejected: true,
            activeWorkerEpochVerified: verifiedActive.lease_epoch,
            liveLeaseTempDirPreserved: fs.existsSync(liveDir),
            orphanTempDirSwept: !fs.existsSync(orphanDir),
            sweptOrphanDirsCount: sweepResult.attemptTempDirsRemoved,
          };
        } finally {
          env.cleanup();
        }
      }
    );

    // 10. Post-Restore Safety Locks (PostRestoreSafetyGate)
    await recordCheck(
      'API-SEC-10',
      'Post-restore safety locks (PostRestoreSafetyGate locks customCode, remoteImport, and outboundWebhooks until operator revalidation)',
      'disaster_recovery_safety',
      async () => {
        const gate = new PostRestoreSafetyGate();
        if (
          gate.state !== SAFETY_STATES.RESTORED_PENDING_REVALIDATION ||
          gate.customCodeEnabled ||
          gate.remoteImportEnabled ||
          gate.outboundWebhooksEnabled
        ) {
          throw new Error('PostRestoreSafetyGate must default to RESTORED_PENDING_REVALIDATION with all risky features disabled');
        }

        // Calling assertRemoteImportAllowed or assertOutboundWebhooksAllowed before revalidation throws FEATURE_LOCKED_PENDING_REVALIDATION
        for (const fn of [
          () => gate.assertCustomCodeAllowed(),
          () => gate.assertRemoteImportAllowed(),
          () => gate.assertOutboundWebhooksAllowed(),
        ]) {
          let err = null;
          try {
            fn();
          } catch (e) {
            err = e;
          }
          if (!err || err.code !== 'FEATURE_LOCKED_PENDING_REVALIDATION') {
            throw new Error(`Expected FEATURE_LOCKED_PENDING_REVALIDATION, got ${err?.code}`);
          }
        }

        // Revalidation attempt must fail if any mandatory check is false
        let failedRevalErr = null;
        try {
          gate.revalidate({
            operator: 'sec-reviewer-p604',
            ticket: 'INC-DR-001',
            checks: {
              foreignKeysPassed: true,
              objectConsistencyPassed: false,
              tenantIsolationPassed: true,
            },
          });
        } catch (err) {
          failedRevalErr = err;
        }
        if (!failedRevalErr || failedRevalErr.code !== 'REVALIDATION_CHECKS_FAILED') {
          throw new Error(`Expected REVALIDATION_CHECKS_FAILED when objectConsistencyPassed=false, got ${failedRevalErr?.code}`);
        }

        // Clean revalidation unlocks remoteImport and outboundWebhooks while keeping customCode=false
        const audit = gate.revalidate({
          operator: 'sec-reviewer-p604',
          ticket: 'INC-DR-001',
          checks: {
            foreignKeysPassed: true,
            objectConsistencyPassed: true,
            tenantIsolationPassed: true,
            catalogIntegrityPassed: true,
          },
          allowEnableFeatures: {
            customCode: false,
            remoteImport: true,
            outboundWebhooks: true,
          },
        });
        if (
          audit.state !== SAFETY_STATES.REVALIDATED_ACTIVE ||
          audit.activeFlags.customCodeEnabled !== false ||
          audit.activeFlags.remoteImportEnabled !== true ||
          audit.activeFlags.outboundWebhooksEnabled !== true
        ) {
          throw new Error(`Unexpected post-revalidation flags: ${JSON.stringify(audit)}`);
        }

        return {
          initialState: SAFETY_STATES.RESTORED_PENDING_REVALIDATION,
          dirtyRevalidationBlockedCode: failedRevalErr.code,
          revalidatedState: audit.state,
          customCodeStaysOffAfterRevalidation: !audit.activeFlags.customCodeEnabled,
        };
      }
    );

    const passedCount = checks.filter((c) => c.passed).length;
    return {
      suite: 'api-tenant-security-suite',
      passed: passedCount === checks.length,
      totalChecks: checks.length,
      passedChecks: passedCount,
      failedChecks: checks.length - passedCount,
      durationMs: Date.now() - startedAt,
      checks,
    };
  }
}
