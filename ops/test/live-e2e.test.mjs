/**
 * Test Suite: Non-Mock Live Staging E2E Verifier
 *
 * Deterministic unit tests for:
 *   - Target endpoint safety validation and refusal of public/production targets
 *   - Token masking and secret redaction
 *   - Fail-closed preflight behavior on unreachable/offline services
 *   - Structured missing-dependency reporting
 *   - Full 10-stage verification workflow with injected local test double (TestDoubleHttpServer)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  isLoopbackHost,
  isRfc1918PrivateIp,
  isApprovedInternalDomain,
  validateTargetEndpoint,
  TargetEndpointSecurityError,
  loadStagingE2EConfig,
  STAGING_SAFETY_INVARIANTS,
} from '../staging/config.mjs';
import {
  maskSecret,
  sanitizeUrl,
  redactObject,
  RedactedLogger,
} from '../staging/redaction.mjs';
import {
  SYNTHETIC_LICENSED_SVG_BUFFER,
  SYNTHETIC_LICENSED_SVG_SHA256,
  inspectMp4Boxes,
  verifyArtifactIntegrity,
} from '../staging/media-verify.mjs';
import { runStagingPreflight, deriveServerOrigin } from '../staging/preflight.mjs';
import { LiveStagingE2EVerifier } from '../staging/live-e2e.mjs';

/**
 * Minimal valid MP4 container buffer for testing box inspection.
 * Structure:
 *   - ftyp box: 4 bytes size (16), 4 bytes 'ftyp', 4 bytes 'isom', 4 bytes version
 *   - moov box: 4 bytes size (8), 4 bytes 'moov'
 */
function createMinimalTestMp4Buffer() {
  const ftypBox = Buffer.alloc(16);
  ftypBox.writeUInt32BE(16, 0);
  ftypBox.write('ftyp', 4, 'ascii');
  ftypBox.write('isom', 8, 'ascii');
  ftypBox.writeUInt32BE(512, 12);

  const moovBox = Buffer.alloc(8);
  moovBox.writeUInt32BE(8, 0);
  moovBox.write('moov', 4, 'ascii');

  return Buffer.concat([ftypBox, moovBox]);
}

/**
 * Injected Local HTTP Test Double Server (clearly labeled test double).
 * Emulates the live REST API v1 endpoints for deterministic unit tests.
 */
class TestDoubleHttpServer {
  constructor(options = {}) {
    this.server = null;
    this.port = 0;
    this.options = {
      healthOk: options.healthOk ?? true,
      readyOk: options.readyOk ?? true,
      readySubsystems: options.readySubsystems ?? { database: true, storage: true, renderer: true },
      customCodeEnabled: options.customCodeEnabled ?? false,
      remoteImportEnabled: options.remoteImportEnabled ?? false,
      missingProfiles: options.missingProfiles ?? false,
      artifactBuffer: options.artifactBuffer ?? createMinimalTestMp4Buffer(),
      grantTtlSeconds: options.grantTtlSeconds ?? 300,
    };
    this.idempotencyRecords = new Map();
    this.compositions = new Map();
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}/v1`);
      });
      this.server.on('error', reject);
    });
  }

  async close() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  async handle(req, res) {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // Helper: read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    let jsonBody = {};
    if (bodyStr) {
      try {
        jsonBody = JSON.parse(bodyStr);
      } catch {
        jsonBody = {};
      }
    }

    const authHeader = req.headers['authorization'] || '';
    const isTenantA = authHeader.includes('tenant_a') || authHeader.includes('key_a');
    const isTenantB = authHeader.includes('tenant_b') || authHeader.includes('key_b');
    const tenantId = isTenantA ? 'tenant_a' : isTenantB ? 'tenant_b' : 'anonymous';

    // 1. Liveness: GET /healthz
    if (pathname === '/healthz' && method === 'GET') {
      if (this.options.healthOk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'creativanta-video-engine-api' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Service unhealthy' }));
      }
      return;
    }

    // 2. Readiness: GET /readyz
    if (pathname === '/readyz' && method === 'GET') {
      if (this.options.readyOk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', subsystems: this.options.readySubsystems }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_ready', subsystems: this.options.readySubsystems }));
      }
      return;
    }

    // 3. Capabilities: GET /v1/capabilities
    if (pathname === '/v1/capabilities' && method === 'GET') {
      const profiles = this.options.missingProfiles
        ? {}
        : {
            'mp4-720p-v1': { id: 'mp4-720p-v1', width: 720, height: 1280 },
            'preview-360p-v1': { id: 'preview-360p-v1', width: 360, height: 640 },
          };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          api_version: 'v1',
          engines: ['chromium-frame-v1'],
          profiles,
          features: {
            custom_code: this.options.customCodeEnabled,
            remote_import: this.options.remoteImportEnabled,
            tts: false,
            authoring_adapter: false,
          },
        })
      );
      return;
    }

    // 4. Compositions: POST /v1/compositions
    if (pathname === '/v1/compositions' && method === 'POST') {
      const compId = `cmp_${crypto.randomBytes(4).toString('hex')}`;
      this.compositions.set(compId, { id: compId, revision: 1, owner: tenantId });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: compId, revision: 1 }));
      return;
    }

    // 5. Anti-IDOR Check: GET /v1/compositions/:id
    if (pathname.startsWith('/v1/compositions/') && method === 'GET') {
      const compId = pathname.replace('/v1/compositions/', '');
      const record = this.compositions.get(compId);
      if (!record || record.owner !== tenantId) {
        // Enforce anti-IDOR: return 404 NOT_FOUND
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Composition not found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record));
      return;
    }

    // 6. Assets: POST /v1/assets/uploads
    if (pathname === '/v1/assets/uploads' && method === 'POST') {
      const assetId = `ast_${crypto.randomBytes(4).toString('hex')}`;
      const uploadUrl = `http://127.0.0.1:${this.port}/s3-upload/${assetId}`;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          asset_id: assetId,
          upload_method: 'PUT',
          upload_url: uploadUrl,
          expires_at: new Date(Date.now() + 600000).toISOString(),
        })
      );
      return;
    }

    // Direct S3 Upload Handler
    if (pathname.startsWith('/s3-upload/') && method === 'PUT') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 7. Assets Complete: POST /v1/assets/:id/complete
    if (pathname.startsWith('/v1/assets/') && pathname.endsWith('/complete') && method === 'POST') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'processing' }));
      return;
    }

    // 8. Templates: POST /v1/templates/retail_promo/instantiate
    if (pathname === '/v1/templates/retail_promo/instantiate' && method === 'POST') {
      const compId = `cmp_inst_${crypto.randomBytes(4).toString('hex')}`;
      this.compositions.set(compId, { id: compId, revision: 1, owner: tenantId });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: compId,
          revision: 1,
          template: { id: 'retail_promo', revision: 1 },
        })
      );
      return;
    }

    // 9. Previews: POST /v1/previews
    if (pathname === '/v1/previews' && method === 'POST') {
      const jobId = `job_prev_${crypto.randomBytes(4).toString('hex')}`;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: jobId, kind: 'preview', state: 'queued' }));
      return;
    }

    // 10. Render Jobs: POST /v1/render-jobs (with idempotency support)
    if (pathname === '/v1/render-jobs' && method === 'POST') {
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && this.idempotencyRecords.has(idemKey)) {
        const recorded = this.idempotencyRecords.get(idemKey);
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Idempotency-Replayed': 'true',
        });
        res.end(JSON.stringify(recorded));
        return;
      }

      const jobId = `job_render_${crypto.randomBytes(4).toString('hex')}`;
      const payload = { id: jobId, kind: 'render', state: 'queued' };
      if (idemKey) {
        this.idempotencyRecords.set(idemKey, payload);
      }
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // 11. Job Status: GET /v1/jobs/:id
    if (pathname.startsWith('/v1/jobs/') && !pathname.endsWith('/cancel') && method === 'GET') {
      const jobId = pathname.replace('/v1/jobs/', '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: jobId,
          state: 'succeeded',
          progress: 1,
          artifacts: [
            {
              id: 'art_video_001',
              kind: 'video',
              mime_type: 'video/mp4',
            },
          ],
        })
      );
      return;
    }

    // 12. Job Cancel: POST /v1/jobs/:id/cancel
    if (pathname.startsWith('/v1/jobs/') && pathname.endsWith('/cancel') && method === 'POST') {
      const jobId = pathname.split('/')[3];
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: jobId, state: 'cancel_requested' }));
      return;
    }

    // 13. Webhook endpoints: POST /v1/webhook-endpoints
    if (pathname === '/v1/webhook-endpoints' && method === 'POST') {
      const epId = `wh_${crypto.randomBytes(4).toString('hex')}`;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: epId,
          url: jsonBody.url,
          signing_secret: 'whsec_test_secret_0123456789abcdef0123456789abcdef',
        })
      );
      return;
    }

    if (pathname.startsWith('/v1/webhook-endpoints/') && method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 14. Download Grant: GET /v1/artifacts/:id/download
    if (pathname.startsWith('/v1/artifacts/') && pathname.endsWith('/download') && method === 'GET') {
      const artifactBuffer = this.options.artifactBuffer;
      const sha256 = crypto.createHash('sha256').update(artifactBuffer).digest('hex');
      const downloadUrl = `http://127.0.0.1:${this.port}/s3-download/art_video_001`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          url: downloadUrl,
          expires_at: new Date(Date.now() + this.options.grantTtlSeconds * 1000).toISOString(),
          bytes: artifactBuffer.length,
          sha256,
        })
      );
      return;
    }

    // Direct S3 Download Handler
    if (pathname.startsWith('/s3-download/') && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(this.options.artifactBuffer.length),
      });
      res.end(this.options.artifactBuffer);
      return;
    }

    // 15. Usage: GET /v1/usage
    if (pathname === '/v1/usage' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          operational_jobs: 1,
          billable_jobs: 1,
          billable_output_minutes: 0.05,
        })
      );
      return;
    }

    // Catch-all
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  }
}

describe('Non-Mock Live Staging E2E Verifier Suite (P10-B)', () => {
  describe('1. Target Endpoint Security & Refusal Guards', () => {
    it('accepts loopback addresses and normalizes URL', () => {
      assert.strictEqual(validateTargetEndpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
      assert.strictEqual(validateTargetEndpoint('http://localhost:3000'), 'http://localhost:3000');
      assert.strictEqual(validateTargetEndpoint('http://127.0.0.2:9000/v1'), 'http://127.0.0.2:9000/v1');
    });

    it('accepts approved private RFC1918 addresses and internal staging domains', () => {
      assert.strictEqual(
        validateTargetEndpoint('http://10.0.1.5:8080/v1'),
        'http://10.0.1.5:8080/v1'
      );
      assert.strictEqual(
        validateTargetEndpoint('https://staging.creativanta.internal/v1'),
        'https://staging.creativanta.internal/v1'
      );
      assert.strictEqual(
        validateTargetEndpoint('http://worker.local:8080/v1'),
        'http://worker.local:8080/v1'
      );
    });

    it('DENIES public production domain targets by default (fail-closed)', () => {
      assert.throws(
        () => validateTargetEndpoint('https://video.creativanta.com/v1'),
        (err) => err instanceof TargetEndpointSecurityError && err.message.includes('PRODUCTION/PUBLIC TARGET DENIED')
      );
      assert.throws(
        () => validateTargetEndpoint('https://api.creativanta.io'),
        TargetEndpointSecurityError
      );
      assert.throws(
        () => validateTargetEndpoint('http://example.com/v1'),
        TargetEndpointSecurityError
      );
    });

    it('DENIES public IP literals by default', () => {
      assert.throws(
        () => validateTargetEndpoint('http://8.8.8.8:8080/v1'),
        TargetEndpointSecurityError
      );
      assert.throws(
        () => validateTargetEndpoint('http://203.0.113.10:8080/v1'),
        TargetEndpointSecurityError
      );
    });

    it('rejects malformed or empty URLs', () => {
      assert.throws(() => validateTargetEndpoint(''), TargetEndpointSecurityError);
      assert.throws(() => validateTargetEndpoint('ftp://127.0.0.1:21'), TargetEndpointSecurityError);
      assert.throws(() => validateTargetEndpoint('not-a-url'), TargetEndpointSecurityError);
    });

    it('derives server origin correctly', () => {
      assert.strictEqual(deriveServerOrigin('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080');
      assert.strictEqual(deriveServerOrigin('https://staging.creativanta.internal:8443/v1/sub'), 'https://staging.creativanta.internal:8443');
    });
  });

  describe('2. Secret Redaction & Token Masking', () => {
    it('masks long tokens while displaying safe prefix/suffix', () => {
      const token = 'cve_live_staging_smoke_key_0123456789abcdef';
      const masked = maskSecret(token);
      assert.strictEqual(masked, 'cve_...cdef');
      assert.ok(!masked.includes('smoke_key'));
    });

    it('returns [REDACTED] for short or null secrets', () => {
      assert.strictEqual(maskSecret('short'), '[REDACTED]');
      assert.strictEqual(maskSecret(null), '[REDACTED]');
      assert.strictEqual(maskSecret(undefined), '[REDACTED]');
    });

    it('sanitizes URL query parameters containing signatures and tokens', () => {
      const sensitiveUrl = 'https://s3.internal/bucket/file.mp4?token=secret123&X-Amz-Signature=abc456&safeParam=value';
      const clean = sanitizeUrl(sensitiveUrl);
      assert.ok(!clean.includes('secret123'));
      assert.ok(!clean.includes('abc456'));
      assert.ok(clean.includes('safeParam=value'));
    });

    it('strips user credentials from sanitized URLs', () => {
      const credUrl = 'http://admin:superSecret@staging.internal:8080/v1/path';
      const clean = sanitizeUrl(credUrl);
      assert.strictEqual(clean, 'http://staging.internal:8080/v1/path');
    });

    it('recursively redacts sensitive keys from objects', () => {
      const payload = {
        name: 'test',
        api_key: 'cve_live_staging_secret_key_12345',
        nested: {
          signing_secret: 'whsec_very_secret_token_abcde',
          public_info: 'allowed',
        },
      };
      const redacted = redactObject(payload);
      assert.strictEqual(redacted.name, 'test');
      assert.strictEqual(redacted.api_key, 'cve_...2345');
      assert.strictEqual(redacted.nested.signing_secret, 'whse...bcde');
      assert.strictEqual(redacted.nested.public_info, 'allowed');
    });

    it('RedactedLogger scrubs registered secrets and Bearer tokens', () => {
      let output = '';
      const mockStream = {
        write: (str) => {
          output += str;
        },
      };

      const logger = new RedactedLogger(mockStream);
      const secret = 'cve_super_secret_token_value_999';
      logger.registerSecret(secret);

      logger.info(`Sending token ${secret} and Bearer abcdef1234567890`);
      assert.ok(!output.includes('cve_super_secret_token_value_999'));
      assert.ok(output.includes('cve_..._999'));
      assert.ok(!output.includes('abcdef1234567890'));
      assert.ok(output.includes('Bearer abcd...7890'));
    });
  });

  describe('3. Synthetic Media Fixtures & MP4 Integrity', () => {
    it('provides valid synthetic licensed SVG fixture buffer and matching SHA-256', () => {
      assert.ok(Buffer.isBuffer(SYNTHETIC_LICENSED_SVG_BUFFER));
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.length > 0);
      assert.strictEqual(SYNTHETIC_LICENSED_SVG_SHA256.length, 64);
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.toString('utf8').includes('<svg'));
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.toString('utf8').includes('Creativanta'));
    });

    it('inspectMp4Boxes validates valid ISOBMFF ftyp/moov boxes', () => {
      const validMp4 = createMinimalTestMp4Buffer();
      const analysis = inspectMp4Boxes(validMp4);
      assert.strictEqual(analysis.valid, true);
      assert.strictEqual(analysis.majorBrand, 'isom');
      assert.strictEqual(analysis.hasMoov, true);
    });

    it('inspectMp4Boxes rejects malformed non-MP4 buffers', () => {
      const corrupt = Buffer.from('NOT_AN_MP4_FILE_JUST_PLAIN_TEXT');
      const analysis = inspectMp4Boxes(corrupt);
      assert.strictEqual(analysis.valid, false);
      assert.ok(analysis.error.includes("expected 'ftyp' box"));
    });

    it('verifyArtifactIntegrity detects byte length and SHA-256 mismatches', () => {
      const validMp4 = createMinimalTestMp4Buffer();
      const actualSha = crypto.createHash('sha256').update(validMp4).digest('hex');

      const pass = verifyArtifactIntegrity(validMp4, {
        expectedBytes: validMp4.length,
        expectedSha256: actualSha,
        isMp4: true,
      });
      assert.strictEqual(pass.valid, true);
      assert.strictEqual(pass.byteCountMatches, true);
      assert.strictEqual(pass.sha256Matches, true);

      const fail = verifyArtifactIntegrity(validMp4, {
        expectedBytes: validMp4.length + 10,
        expectedSha256: actualSha,
      });
      assert.strictEqual(fail.valid, false);
      assert.strictEqual(fail.byteCountMatches, false);
    });
  });

  describe('4. Fail-Closed Preflight on Absent Services', () => {
    it('fails closed when target API is completely offline (connection refused)', async () => {
      // Choose an unbound loopback port
      const offlineUrl = 'http://127.0.0.1:58761/v1';
      const preflight = await runStagingPreflight({
        baseUrl: offlineUrl,
        apiKeyA: 'test_a',
        apiKeyB: 'test_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.strictEqual(preflight.status, 'NOT_READY');
      assert.strictEqual(preflight.dependencies.api, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.database, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.storage, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.renderer, 'UNAVAILABLE');
      assert.ok(preflight.blockers.some((b) => b.includes('API_SERVICE_UNAVAILABLE')));
    });

    it('LiveStagingE2EVerifier returns structured NOT_READY when services are absent (NO MOCK invoked)', async () => {
      const offlineUrl = 'http://127.0.0.1:58762/v1';
      const verifier = new LiveStagingE2EVerifier({
        baseUrl: offlineUrl,
        apiKeyA: 'test_a',
        apiKeyB: 'test_b',
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'NOT_READY');
      assert.strictEqual(result.decision, 'HOLD_SERVICES_NOT_DEPLOYED');
      assert.strictEqual(result.passedStages, 0);
      assert.strictEqual(result.failedStages, 0);
      assert.strictEqual(result.dependencies.api, 'UNAVAILABLE');
      assert.ok(result.blockers.length > 0);
    });
  });

  describe('5. Preflight Fail-Closed on Degraded Dependencies & Capability Invariants', () => {
    let testDouble = null;

    it('fails closed when /readyz returns 503 (database/storage/renderer not ready)', async () => {
      testDouble = new TestDoubleHttpServer({ readyOk: false });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.strictEqual(preflight.status, 'NOT_READY');
      assert.ok(preflight.blockers.some((b) => b.includes('API_READINESS_FAIL_CLOSED')));

      await testDouble.close();
    });

    it('fails closed when custom code is enabled (violates CVE_CUSTOM_CODE_ENABLED invariant)', async () => {
      testDouble = new TestDoubleHttpServer({ customCodeEnabled: true });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('CVE_CUSTOM_CODE_ENABLED must be false')));

      await testDouble.close();
    });

    it('fails closed when required profile mp4-720p-v1 is missing from capabilities', async () => {
      testDouble = new TestDoubleHttpServer({ missingProfiles: true });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('Missing required profiles')));

      await testDouble.close();
    });

    it('fails closed when tenant API credentials are not provided', async () => {
      testDouble = new TestDoubleHttpServer();
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: '',
        apiKeyB: '',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('MISSING_TENANT_CREDENTIALS')));

      await testDouble.close();
    });
  });

  describe('6. Full Live Staging Verification Workflow (TestDoubleHttpServer)', () => {
    let testDouble = null;
    let baseUrl = '';

    it('executes full 10-stage live E2E verification workflow and achieves 100% PASS', async () => {
      testDouble = new TestDoubleHttpServer({
        healthOk: true,
        readyOk: true,
        customCodeEnabled: false,
        remoteImportEnabled: false,
        grantTtlSeconds: 240, // <= 300s
      });
      baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        webhookSecret: 'whsec_staging_test_secret_0123456789abcdef',
        pollIntervalMs: 10,
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();

      assert.strictEqual(result.status, 'PASS');
      assert.strictEqual(result.decision, 'STAGING_LIVE_E2E_VERIFIED');
      assert.strictEqual(result.totalStages, 10);
      assert.strictEqual(result.passedStages, 10);
      assert.strictEqual(result.failedStages, 0);

      // Verify individual stage IDs
      const stageIds = result.stages.map((s) => s.id);
      assert.deepStrictEqual(stageIds, [
        'LIVE-01',
        'LIVE-02',
        'LIVE-03',
        'LIVE-04',
        'LIVE-05',
        'LIVE-06',
        'LIVE-07',
        'LIVE-08',
        'LIVE-09',
        'LIVE-10',
      ]);

      for (const stage of result.stages) {
        assert.strictEqual(stage.passed, true);
        assert.ok(stage.durationMs >= 0);
      }

      await testDouble.close();
    });

    it('fails when download grant TTL exceeds 300 seconds security constraint', async () => {
      testDouble = new TestDoubleHttpServer({
        grantTtlSeconds: 600, // exceeds 300s limit
      });
      baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage08 = result.stages.find((s) => s.id === 'LIVE-08');
      assert.ok(stage08);
      assert.strictEqual(stage08.passed, false);
      assert.ok(stage08.error.includes('exceeds 300 seconds security cap'));

      await testDouble.close();
    });
  });
});
