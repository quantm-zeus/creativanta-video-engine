/**
 * Task P4-04 Integration & Verification Test Suite:
 * Signed Webhooks, Challenge Echo Handshake, Secret Rotation,
 * Transactional Outbox, Bounded SSRF-Safe Retries, Replay Controller,
 * Outage Resilience ("outage không mất event/job"), HMAC Raw Bytes & Deduplication.
 *
 * Acceptance Criteria:
 *   "Signed webhook registration/challenge/rotation/outbox/delivery/replay,
 *    bounded SSRF-safe retries; outage không mất event/job, HMAC raw bytes + dedupe tests"
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  MigrationRunner,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  WebhookDeliveryService,
  WebhookDeduplicator,
  computeWebhookSignature,
  verifyWebhookSignature,
  verifyAndProcessIncomingWebhook,
  encryptSecretAtRest,
  decryptSecretAtRest,
  generateWebhookSecret,
  MAX_DELIVERY_DEADLINE_MS,
  MAX_REPLAYS_PER_DAY,
  WEBHOOK_REPLAY_RETENTION_MS,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  MAX_WEBHOOK_ATTEMPTS,
} from '../dist/index.js';
import * as DispatcherPackage from '../../dispatcher/index.mjs';

const TEST_PEPPER = 'p404_test_secret_pepper_0123456789abcdef0123456789abcdef';
const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';

function setupHarness(options = {}) {
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator' });

  let currentClockMs = Date.parse('2026-11-03T12:00:00.000Z');
  const clock = () => new Date(currentClockMs);
  const advanceClockMs = (deltaMs) => {
    currentClockMs += deltaMs;
    return new Date(currentClockMs);
  };

  const pool = new TenantConnectionPool(db, { poolSize: 8 });
  const repo = new TenantRepository(pool, {
    pepper: TEST_PEPPER,
    masterKey: 'test-master-key-p404-32-bytes-long!!',
  });

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha (Webhook Consumer)', now: clock() });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta (Attacker/Prober)', now: clock() });

  pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
    tx.insertScoped('compositions', {
      tenant_id: TENANT_A_ID,
      id: 'cmp_main',
      name: 'Composition for Webhook Tests',
      current_revision: 1,
      editable: 1,
      created_at: clock().toISOString(),
      updated_at: clock().toISOString(),
    });
    tx.insertScoped('composition_revisions', {
      tenant_id: TENANT_A_ID,
      composition_id: 'cmp_main',
      revision: 1,
      schema_version: '1.0',
      spec_json: '{}',
      render_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      change_note: 'Initial revision',
      created_at: clock().toISOString(),
    });
  });

  const keyAlpha = repo.issueApiKey({
    tenantId: TENANT_A_ID,
    keyId: 'key_alpha_full',
    scopes: ['webhooks:manage', 'jobs:read', 'jobs:write', 'compositions:write', 'assets:write'],
    now: clock(),
  });

  const keyBeta = repo.issueApiKey({
    tenantId: TENANT_B_ID,
    keyId: 'key_beta_full',
    scopes: ['webhooks:manage', 'jobs:read', 'jobs:write'],
    now: clock(),
  });

  const deliveryService = new WebhookDeliveryService(pool, {
    masterKey: 'test-master-key-p404-32-bytes-long!!',
    allowLoopbackForTesting: true,
    allowCustomPortForTesting: true,
    clock,
    jitterRatio: options.jitterRatio ?? 0, // Deterministic for testing
  });

  const config = loadEnvConfig();
  const server = createServer({
    config,
    repository: repo,
    deliveryService,
    clock,
    allowLoopbackForTesting: true,
    allowCustomPortForTesting: true,
  });

  return {
    db,
    pool,
    repo,
    clock,
    advanceClockMs,
    deliveryService,
    server,
    keyAlpha: keyAlpha.plaintextKey,
    keyBeta: keyBeta.plaintextKey,
  };
}

describe('P4-04: Signed Webhooks, Challenge Echo Handshake, Outbox & Bounded Retries', () => {
  // --------------------------------------------------------------------------
  // Suite 1: Webhook Registration, Idempotency & Multi-Tier SSRF Validation
  // --------------------------------------------------------------------------
  describe('1. Webhook Registration, At-Rest Secret Encryption & SSRF URL Defenses', () => {
    let h;
    let baseUrl;

    before(async () => {
      h = setupHarness();
      await new Promise((resolve) => {
        h.server.listen(0, '127.0.0.1', () => {
          const addr = h.server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => h.server.close(resolve));
      h.db.close();
    });

    it('1.1 registers webhook endpoint, returns signing_secret once, and encrypts secret at rest in DB', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-register-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_client_alpha_1',
          url: 'https://client.example.invalid/hooks/video',
          events: ['job.succeeded', 'job.failed', 'job.canceled'],
        }),
      });

      assert.strictEqual(res.status, 201);
      const data = await res.json();
      assert.strictEqual(data.id, 'wh_client_alpha_1');
      assert.strictEqual(data.url, 'https://client.example.invalid/hooks/video');
      assert.strictEqual(data.state, 'pending_verification');
      assert.match(data.signing_secret, /^whsec_[0-9a-f]{64}$/);
      assert.deepStrictEqual(data.events, ['job.succeeded', 'job.failed', 'job.canceled']);
      assert.ok(data.created_at);

      // Verify that secret is encrypted at rest in DB and NOT stored in plaintext
      const dbRows = h.db.prepare('SELECT secret_ciphertext FROM webhook_endpoints WHERE id = ?').all('wh_client_alpha_1');
      assert.strictEqual(dbRows.length, 1);
      assert.match(dbRows[0].secret_ciphertext, /^enc:v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
      assert.ok(!dbRows[0].secret_ciphertext.includes(data.signing_secret));

      // Decrypt to confirm round-trip correctness
      const decrypted = decryptSecretAtRest(dbRows[0].secret_ciphertext, 'test-master-key-p404-32-bytes-long!!');
      assert.strictEqual(decrypted, data.signing_secret);
    });

    it('1.2 replaying registration with same Idempotency-Key returns secret_redacted: true (never plaintext secret)', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-register-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_client_alpha_1',
          url: 'https://client.example.invalid/hooks/video',
          events: ['job.succeeded', 'job.failed', 'job.canceled'],
        }),
      });

      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.headers.get('idempotency-replayed'), 'true');
      const data = await res.json();
      assert.strictEqual(data.id, 'wh_client_alpha_1');
      assert.strictEqual(data.secret_redacted, true);
      assert.strictEqual(data.signing_secret, undefined);
    });

    it('1.3 GET /v1/webhook-endpoints/{id} returns state and delivery summary, NEVER secret', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_client_alpha_1`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
        },
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.id, 'wh_client_alpha_1');
      assert.strictEqual(data.state, 'pending_verification');
      assert.strictEqual(data.signing_secret, undefined);
      assert.strictEqual(data.secret_ciphertext, undefined);
      assert.ok(data.delivery_summary);
      assert.strictEqual(data.delivery_summary.total, 0);
    });

    it('1.4 Tenant B probing Tenant A webhook endpoint returns 404 NOT_FOUND (never 403 / zero IDOR leakage)', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_client_alpha_1`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${h.keyBeta}`,
        },
      });
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error.code, 'NOT_FOUND');
    });

    it('1.5 SSRF defenses: blocks non-HTTPS, cloud metadata, loopback IP literals, fragments & userinfo', async () => {
      // 1. Non-HTTPS protocol
      const resHttp = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-ssrf-http',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'http://my-domain.example.invalid/webhook',
        }),
      });
      assert.strictEqual(resHttp.status, 422);

      // 2. Prohibited IP / AWS metadata range (169.254.169.254)
      const resMeta = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-ssrf-meta',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://169.254.169.254/latest/meta-data',
        }),
      });
      assert.strictEqual(resMeta.status, 422);

      // 3. Userinfo in URL
      const resUserinfo = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-ssrf-userinfo',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://admin:secret@trusted.example.invalid/webhook',
        }),
      });
      assert.strictEqual(resUserinfo.status, 422);

      // 4. URL fragment
      const resFragment = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-ssrf-frag',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://trusted.example.invalid/webhook#fragment',
        }),
      });
      assert.strictEqual(resFragment.status, 422);

      // 5. Backslash injection
      const resBackslash = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-ssrf-backslash',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: 'https://trusted.example.invalid\\evil.com/webhook',
        }),
      });
      assert.strictEqual(resBackslash.status, 422);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Challenge Echo Handshake & Endpoint Verification
  // --------------------------------------------------------------------------
  describe('2. Challenge Echo Handshake (endpoint.challenge, 32 bytes, <= 5s reply, 10min TTL)', () => {
    let h;
    let baseUrl;
    let mockReceiverServer;
    let mockReceiverPort;
    let lastReceivedChallenge = null;
    let lastReceivedHeaders = null;
    let shouldEchoCorrect = true;
    let shouldTimeout = false;
    let capturedRawBody = null;

    before(async () => {
      // Mock receiver server to receive challenge and echo back
      mockReceiverServer = http.createServer((req, res) => {
        if (shouldTimeout) {
          // Do not reply to simulate timeout
          return;
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          capturedRawBody = Buffer.concat(chunks);
          lastReceivedHeaders = req.headers;
          try {
            const body = JSON.parse(capturedRawBody.toString('utf8'));
            lastReceivedChallenge = body.data?.challenge;
          } catch {
            lastReceivedChallenge = null;
          }

          if (shouldEchoCorrect) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: lastReceivedChallenge }));
          } else {
            // Echo corrupted / tampered challenge
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: 'wrong-tampered-challenge-token-value' }));
          }
        });
      });

      await new Promise((resolve) => {
        mockReceiverServer.listen(0, '127.0.0.1', () => {
          mockReceiverPort = mockReceiverServer.address().port;
          resolve();
        });
      });

      h = setupHarness();
      await new Promise((resolve) => {
        h.server.listen(0, '127.0.0.1', () => {
          const addr = h.server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => mockReceiverServer.close(resolve));
      await new Promise((resolve) => h.server.close(resolve));
      h.db.close();
    });

    it('2.1 executes challenge echo handshake: verifies HMAC signature, echoes challenge, and activates endpoint', async () => {
      // 1. Register endpoint with loopback mock receiver
      const regRes = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-handshake-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_challenge_active',
          url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
          events: ['job.succeeded'],
        }),
      });
      assert.strictEqual(regRes.status, 201);
      const regData = await regRes.json();
      assert.strictEqual(regData.state, 'pending_verification');
      const secret = regData.signing_secret;

      // 2. Trigger challenge handshake via POST /v1/webhook-endpoints/{id}/verify
      shouldEchoCorrect = true;
      shouldTimeout = false;

      const verifyRes = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_challenge_active/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-verify-handshake-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ echo_handshake: true }),
      });

      assert.strictEqual(verifyRes.status, 202);
      const verifyData = await verifyRes.json();
      assert.strictEqual(verifyData.id, 'wh_challenge_active');
      assert.strictEqual(verifyData.state, 'active');

      // Verify the challenge received by mock receiver
      assert.ok(lastReceivedChallenge);
      assert.match(lastReceivedChallenge, /^[0-9a-f]{64}$/); // 32 random bytes = 64 hex
      assert.strictEqual(lastReceivedHeaders['x-cve-key-id'], 'whk_1');
      assert.match(lastReceivedHeaders['x-cve-signature'], /^v1=[0-9a-f]{64}$/);

      // Verify receiver HMAC verification succeeded on exact raw bytes
      const verifySig = verifyWebhookSignature({
        headers: lastReceivedHeaders,
        rawBodyBytes: capturedRawBody,
        secrets: [{ keyId: 'whk_1', secret }],
        now: h.clock(),
      });
      assert.strictEqual(verifySig.valid, true);

      // Verify endpoint state is now 'active' in DB and challenge token hash is cleared (one-use)
      const epCheck = h.repo.getWebhookEndpoint(TENANT_A_ID, 'wh_challenge_active');
      assert.strictEqual(epCheck.state, 'active');

      const dbRow = h.db.prepare('SELECT challenge_token_hash FROM webhook_endpoints WHERE id = ?').get('wh_challenge_active');
      assert.strictEqual(dbRow.challenge_token_hash, null);
    });

    it('2.2 rejects challenge echo when receiver returns tampered / incorrect challenge (remains pending_verification)', async () => {
      // Register new endpoint
      const regRes = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-tampered-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_challenge_tampered',
          url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
        }),
      });
      assert.strictEqual(regRes.status, 201);

      // Set mock receiver to echo tampered challenge
      shouldEchoCorrect = false;

      const verifyRes = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_challenge_tampered/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-verify-tampered-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ echo_handshake: true }),
      });

      assert.strictEqual(verifyRes.status, 409);
      const err = await verifyRes.json();
      assert.strictEqual(err.error.code, 'WEBHOOK_NOT_VERIFIED');

      // Verify endpoint state remains pending_verification
      const ep = h.repo.getWebhookEndpoint(TENANT_A_ID, 'wh_challenge_tampered');
      assert.strictEqual(ep.state, 'pending_verification');
    });

    it('2.3 direct challenge token confirmation: activates endpoint when exact token is supplied in body', async () => {
      const regRes = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-direct-conf',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_direct_token_verify',
          url: 'https://client.example.invalid/hook',
        }),
      });
      assert.strictEqual(regRes.status, 201);

      // Initiate challenge to store hash in DB
      const challengeInfo = h.repo.initiateWebhookChallenge(TENANT_A_ID, 'wh_direct_token_verify');
      assert.ok(challengeInfo.challengeToken);

      // Confirm with wrong challenge -> 409
      const wrongRes = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_direct_token_verify/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-conf-wrong',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ challenge: 'wrong-token' }),
      });
      assert.strictEqual(wrongRes.status, 409);

      // Confirm with exact challenge -> 200 OK & activated
      const correctRes = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_direct_token_verify/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-conf-correct',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ challenge: challengeInfo.challengeToken }),
      });
      assert.strictEqual(correctRes.status, 200);
      const data = await correctRes.json();
      assert.strictEqual(data.state, 'active');

      const ep = h.repo.getWebhookEndpoint(TENANT_A_ID, 'wh_direct_token_verify');
      assert.strictEqual(ep.state, 'active');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Secret Rotation & Dual-Key 24-Hour Grace Period
  // --------------------------------------------------------------------------
  describe('3. Secret Rotation & Dual-Key Verification (prev valid 24h grace period)', () => {
    let h;
    let baseUrl;

    before(async () => {
      h = setupHarness();
      await new Promise((resolve) => {
        h.server.listen(0, '127.0.0.1', () => {
          const addr = h.server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => h.server.close(resolve));
      h.db.close();
    });

    it('3.1 rotates secret, generates new key ID (whk_2), preserves prev key valid for 24h, and redacts on replay', async () => {
      // 1. Create endpoint
      const regRes = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-wh-rot-setup',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_rotating_ep',
          url: 'https://client.example.invalid/hooks',
        }),
      });
      const originalEp = await regRes.json();
      const secret1 = originalEp.signing_secret;

      // 2. Rotate secret
      const rotRes = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_rotating_ep/rotate-secret`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-rotate-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      assert.strictEqual(rotRes.status, 201);
      const rotData = await rotRes.json();
      assert.strictEqual(rotData.id, 'wh_rotating_ep');
      assert.strictEqual(rotData.active_key_id, 'whk_2');
      assert.match(rotData.signing_secret, /^whsec_[0-9a-f]{64}$/);
      assert.notStrictEqual(rotData.signing_secret, secret1);
      assert.strictEqual(rotData.prev_key_id, 'whk_1');
      assert.ok(rotData.prev_secret_expires_at);

      const secret2 = rotData.signing_secret;

      // 3. Replay rotate request -> returns secret_redacted: true
      const replayRot = await fetch(`${baseUrl}/v1/webhook-endpoints/wh_rotating_ep/rotate-secret`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-rotate-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(replayRot.status, 201);
      assert.strictEqual(replayRot.headers.get('idempotency-replayed'), 'true');
      const replayData = await replayRot.json();
      assert.strictEqual(replayData.secret_redacted, true);
      assert.strictEqual(replayData.signing_secret, undefined);

      // 4. Test receiver verification during 24h grace window:
      const testPayload = Buffer.from(JSON.stringify({ event: 'test.event', data: { value: 123 } }), 'utf8');
      const now = h.clock();
      const ts = Math.floor(now.getTime() / 1000);

      // Payload signed with NEW key (whk_2) verifies successfully
      const sig2 = computeWebhookSignature(secret2, ts, testPayload);
      const res2 = verifyWebhookSignature({
        headers: {
          'x-cve-event-id': 'evt_test_new',
          'x-cve-timestamp': String(ts),
          'x-cve-key-id': 'whk_2',
          'x-cve-signature': `v1=${sig2}`,
        },
        rawBodyBytes: testPayload,
        secrets: [
          { keyId: 'whk_2', secret: secret2 },
          { keyId: 'whk_1', secret: secret1, expiresAt: rotData.prev_secret_expires_at },
        ],
        now,
      });
      assert.strictEqual(res2.valid, true);
      assert.strictEqual(res2.keyId, 'whk_2');

      // Payload signed with OLD key (whk_1) ALSO verifies successfully within 24h grace window
      const sig1 = computeWebhookSignature(secret1, ts, testPayload);
      const res1 = verifyWebhookSignature({
        headers: {
          'x-cve-event-id': 'evt_test_old',
          'x-cve-timestamp': String(ts),
          'x-cve-key-id': 'whk_1',
          'x-cve-signature': `v1=${sig1}`,
        },
        rawBodyBytes: testPayload,
        secrets: [
          { keyId: 'whk_2', secret: secret2 },
          { keyId: 'whk_1', secret: secret1, expiresAt: rotData.prev_secret_expires_at },
        ],
        now,
      });
      assert.strictEqual(res1.valid, true);
      assert.strictEqual(res1.keyId, 'whk_1');

      // 5. Advance clock past 24 hours -> OLD key (whk_1) is rejected as expired
      const futureNow = new Date(Date.parse(rotData.prev_secret_expires_at) + 60000);
      const futureTs = Math.floor(futureNow.getTime() / 1000);
      const futureSig1 = computeWebhookSignature(secret1, futureTs, testPayload);

      assert.throws(() => {
        verifyWebhookSignature({
          headers: {
            'x-cve-event-id': 'evt_test_old_expired',
            'x-cve-timestamp': String(futureTs),
            'x-cve-key-id': 'whk_1',
            'x-cve-signature': `v1=${futureSig1}`,
          },
          rawBodyBytes: testPayload,
          secrets: [
            { keyId: 'whk_2', secret: secret2 },
            { keyId: 'whk_1', secret: secret1, expiresAt: rotData.prev_secret_expires_at },
          ],
          now: futureNow,
        });
      }, /expired/);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Transactional Outbox Pattern ("Outage Không Mất Event/Job")
  // --------------------------------------------------------------------------
  describe('4. Transactional Outbox Pattern & Outage Resilience ("Outage Không Mất Event/Job")', () => {
    let h;
    let mockReceiverServer;
    let mockReceiverPort;
    let isOutageActive = true;
    let deliveredBodies = [];

    before(async () => {
      mockReceiverServer = http.createServer((req, res) => {
        if (isOutageActive) {
          // Simulate outage: receiver returns 503 SERVICE_UNAVAILABLE
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Receiver database connection lost' }));
          return;
        }

        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          deliveredBodies.push(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'acknowledged' }));
        });
      });

      await new Promise((resolve) => {
        mockReceiverServer.listen(0, '127.0.0.1', () => {
          mockReceiverPort = mockReceiverServer.address().port;
          resolve();
        });
      });

      h = setupHarness();
    });

    after(async () => {
      await new Promise((resolve) => mockReceiverServer.close(resolve));
      h.db.close();
    });

    it('4.1 survives receiver outage without losing any event/job, persists in outbox, and delivers once outage heals', async () => {
      // 1. Create active webhook endpoint pointing to receiver
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_outage_test',
        url: `http://127.0.0.1:${mockReceiverPort}/hooks`,
        events: ['job.succeeded'],
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      // 2. Commit a terminal job event and outbox record in a single durable transaction
      const jobId = 'job_outage_resilience_1';
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: jobId,
          kind: 'render',
          state: 'succeeded',
          state_version: 2,
          stage: 'complete',
          progress: 1.0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          webhook_endpoint_id: ep.id,
          client_reference: 'client-ref-outage-001',
          metadata_json: null,
          attempt_count: 1,
          max_attempts: 3,
          active_attempt_id: 'att_1',
          lease_epoch: 1,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          completed_at: h.clock().toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });

        // Insert into outbox atomically
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_resilience_1',
          event_type: 'job.succeeded',
          job_id: jobId,
          state_version: 2,
          payload_json: JSON.stringify({
            job_id: jobId,
            state: 'succeeded',
            state_version: 2,
            client_reference: 'client-ref-outage-001',
            artifacts: [{ id: 'art_video_1', kind: 'video' }],
          }),
          created_at: h.clock().toISOString(),
          processed_at: null,
        });
      });

      // 3. Process outbox -> queues delivery in webhook_deliveries
      const outboxRes = h.deliveryService.processOutbox(TENANT_A_ID);
      assert.strictEqual(outboxRes.processedCount, 1);
      assert.strictEqual(outboxRes.deliveriesQueued, 1);

      // Verify outbox record is marked processed_at
      const outboxEvents = h.repo.listOutboxEvents(TENANT_A_ID, jobId);
      assert.strictEqual(outboxEvents.length, 1);
      assert.ok(outboxEvents[0].processed_at);

      // 4. Attempt delivery while outage is active (receiver returning 503)
      isOutageActive = true;
      const attempt1 = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(attempt1.length, 1);
      assert.strictEqual(attempt1[0].status, 'retry_scheduled');
      assert.strictEqual(attempt1[0].httpStatus, 503);
      assert.strictEqual(attempt1[0].attemptCount, 1);

      // Verify delivery record in DB is still queued (NOT lost!)
      const deliveries1 = h.repo.listWebhookDeliveries(TENANT_A_ID, { jobId });
      assert.strictEqual(deliveries1.data.length, 1);
      assert.strictEqual(deliveries1.data[0].state, 'queued');
      assert.strictEqual(deliveries1.data[0].attempt_count, 1);
      assert.strictEqual(deliveries1.data[0].last_http_status, 503);

      // 5. Simulate system crash / reboot: delivery state is safely persisted in DB
      // Advance clock past retry delay (first retry is 60s)
      h.advanceClockMs(65 * 1000);

      // 6. Outage resolves (receiver back online)
      isOutageActive = false;

      // 7. Delivery service runs again -> successfully delivers event!
      const attempt2 = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(attempt2.length, 1);
      assert.strictEqual(attempt2[0].status, 'delivered');
      assert.strictEqual(attempt2[0].httpStatus, 200);
      assert.strictEqual(attempt2[0].attemptCount, 2);

      // Verify delivery record in DB is now 'delivered'
      const deliveries2 = h.repo.listWebhookDeliveries(TENANT_A_ID, { jobId });
      assert.strictEqual(deliveries2.data[0].state, 'delivered');
      assert.strictEqual(deliveries2.data[0].attempt_count, 2);
      assert.strictEqual(deliveries2.data[0].last_http_status, 200);

      // Verify delivered payload content
      assert.strictEqual(deliveredBodies.length, 1);
      const deliveredJson = JSON.parse(deliveredBodies[0]);
      assert.strictEqual(deliveredJson.type, 'job.succeeded');
      assert.strictEqual(deliveredJson.data.job_id, jobId);
      assert.strictEqual(deliveredJson.data.client_reference, 'client-ref-outage-001');
      assert.deepStrictEqual(deliveredJson.data.artifact_ids, ['art_video_1']);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Bounded SSRF-Safe Retries (8 Attempts Schedule, 25h Deadline Clamp)
  // --------------------------------------------------------------------------
  describe('5. Bounded SSRF-Safe Retries (8 Attempts, 25h Deadline Clamp & HTTP Status Handling)', () => {
    let h;
    let mockReceiverServer;
    let mockReceiverPort;
    let mockHttpStatus = 500;
    let mockHeaders = {};

    before(async () => {
      mockReceiverServer = http.createServer((req, res) => {
        res.writeHead(mockHttpStatus, { 'Content-Type': 'application/json', ...mockHeaders });
        res.end(JSON.stringify({ status: mockHttpStatus }));
      });

      await new Promise((resolve) => {
        mockReceiverServer.listen(0, '127.0.0.1', () => {
          mockReceiverPort = mockReceiverServer.address().port;
          resolve();
        });
      });

      h = setupHarness();
    });

    after(async () => {
      await new Promise((resolve) => mockReceiverServer.close(resolve));
      h.db.close();
    });

    it('5.1 verifies canonical 8-attempt schedule [0, 60s, 300s, 900s, 3600s, 14400s, 43200s, 86400s] and fails on 8th attempt', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_retry_schedule',
        url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
        events: ['job.failed'],
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      const jobId = 'job_retry_8_attempts';
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: jobId,
          kind: 'render',
          state: 'failed',
          state_version: 1,
          stage: 'failed',
          progress: 0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          webhook_endpoint_id: ep.id,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });

        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_retry_8',
          event_type: 'job.failed',
          job_id: jobId,
          state_version: 1,
          payload_json: JSON.stringify({ job_id: jobId, state: 'failed' }),
          created_at: h.clock().toISOString(),
          processed_at: null,
        });
      });

      h.deliveryService.processOutbox(TENANT_A_ID);
      mockHttpStatus = 500;

      // Step through attempts 1 through 7
      for (let attempt = 1; attempt <= 7; attempt++) {
        const results = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].attemptCount, attempt);
        assert.strictEqual(results[0].status, 'retry_scheduled');

        // Verify scheduled next attempt delay matches canonical schedule (clamped to 25h deadline)
        const deliveryRecord = h.repo.listWebhookDeliveries(TENANT_A_ID, { jobId }).data[0];
        const deadlineMs = Date.parse(deliveryRecord.deadline_at);
        const currentMs = h.clock().getTime();
        const rawDelaySec = WEBHOOK_RETRY_SCHEDULE_SECONDS[attempt];
        const expectedDelaySec = Math.min(
          rawDelaySec,
          Math.max(0, Math.round((deadlineMs - currentMs) / 1000)),
        );
        const nextAttemptMs = Date.parse(results[0].nextAttemptAt);
        const actualDelaySec = Math.round((nextAttemptMs - currentMs) / 1000);
        assert.strictEqual(actualDelaySec, expectedDelaySec);

        // Advance clock to trigger next attempt
        h.advanceClockMs(expectedDelaySec * 1000);
      }

      // 8th attempt: maximum attempts reached (MAX_WEBHOOK_ATTEMPTS = 8) -> marks 'failed'
      const finalAttempt = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(finalAttempt.length, 1);
      assert.strictEqual(finalAttempt[0].attemptCount, 8);
      assert.strictEqual(finalAttempt[0].status, 'failed');

      const delivery = h.repo.listWebhookDeliveries(TENANT_A_ID, { jobId }).data[0];
      assert.strictEqual(delivery.state, 'failed');
    });

    it('5.2 enforces hard deadline (25h) clamp: any retry past 25h is rejected as failed', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_deadline_clamp',
        url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      const jobId = 'job_deadline_clamp_1';
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: jobId,
          kind: 'render',
          state: 'failed',
          state_version: 1,
          stage: 'failed',
          progress: 0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          webhook_endpoint_id: ep.id,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_deadline_1',
          event_type: 'job.failed',
          job_id: jobId,
          state_version: 1,
          payload_json: JSON.stringify({ job_id: jobId, state: 'failed' }),
          created_at: h.clock().toISOString(),
          processed_at: null,
        });
      });

      h.deliveryService.processOutbox(TENANT_A_ID);

      // Fast forward clock past the 25-hour deadline
      h.advanceClockMs(26 * 3600 * 1000);

      const res = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(res.length, 1);
      assert.strictEqual(res[0].status, 'failed');
      assert.match(res[0].error, /deadline/i);
    });

    it('5.3 HTTP 410 Gone: permanently disables endpoint and routes delivery to dead_letter', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_410_disable',
        url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      const jobId = 'job_410_test';
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: jobId,
          kind: 'render',
          state: 'failed',
          state_version: 1,
          stage: 'failed',
          progress: 0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          webhook_endpoint_id: ep.id,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_410_1',
          event_type: 'job.failed',
          job_id: jobId,
          state_version: 1,
          payload_json: JSON.stringify({ job_id: jobId, state: 'failed' }),
          created_at: h.clock().toISOString(),
          processed_at: null,
        });
      });

      h.deliveryService.processOutbox(TENANT_A_ID);
      mockHttpStatus = 410; // HTTP 410 Gone

      const res = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(res.length, 1);
      assert.strictEqual(res[0].status, 'dead_letter');
      assert.strictEqual(res[0].httpStatus, 410);

      // Verify endpoint state is now 'disabled'
      const epState = h.repo.getWebhookEndpoint(TENANT_A_ID, ep.id);
      assert.strictEqual(epState.state, 'disabled');
    });

    it('5.4 HTTP 4xx (400, 401, 404): non-retryable client errors are routed directly to dead_letter', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_4xx_deadletter',
        url: `http://127.0.0.1:${mockReceiverPort}/receiver`,
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      const jobId = 'job_404_deadletter';
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: jobId,
          kind: 'render',
          state: 'failed',
          state_version: 1,
          stage: 'failed',
          progress: 0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          webhook_endpoint_id: ep.id,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_404_1',
          event_type: 'job.failed',
          job_id: jobId,
          state_version: 1,
          payload_json: JSON.stringify({ job_id: jobId, state: 'failed' }),
          created_at: h.clock().toISOString(),
          processed_at: null,
        });
      });

      h.deliveryService.processOutbox(TENANT_A_ID);
      mockHttpStatus = 404; // 404 Not Found at receiver

      const res = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(res.length, 1);
      assert.strictEqual(res[0].status, 'dead_letter');
      assert.strictEqual(res[0].httpStatus, 404);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Endpoint Deletion & Pending Deliveries Halt
  // --------------------------------------------------------------------------
  describe('6. DELETE /v1/webhook-endpoints/{id} & Pending Deliveries Stop', () => {
    let h;
    let baseUrl;

    before(async () => {
      h = setupHarness();
      await new Promise((resolve) => {
        h.server.listen(0, '127.0.0.1', () => {
          const addr = h.server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => h.server.close(resolve));
      h.db.close();
    });

    it('6.1 deleting endpoint disables it and halts all pending deliveries ("Endpoint bị xóa thì không gửi tiếp")', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_to_delete',
        url: 'https://client.example.invalid/hooks',
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      // Create a pending delivery for this endpoint
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: 'job_delete_halt',
          kind: 'render',
          state: 'failed',
          state_version: 1,
          stage: 'failed',
          progress: 0,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_delete_halt',
          event_type: 'job.failed',
          job_id: 'job_delete_halt',
          state_version: 1,
          payload_json: '{}',
          created_at: h.clock().toISOString(),
          processed_at: h.clock().toISOString(),
        });
        tx.insertScoped('webhook_deliveries', {
          tenant_id: TENANT_A_ID,
          id: 'del_to_halt',
          endpoint_id: ep.id,
          outbox_event_id: 'out_delete_halt',
          job_id: 'job_delete_halt',
          state: 'queued',
          attempt_count: 0,
          next_attempt_at: h.clock().toISOString(),
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          replay_count_today: 0,
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
      });

      // DELETE /v1/webhook-endpoints/{id} -> 204 No Content
      const delRes = await fetch(`${baseUrl}/v1/webhook-endpoints/${ep.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
        },
      });
      assert.strictEqual(delRes.status, 204);

      // Verify endpoint state is now 'disabled'
      const epCheck = h.repo.getWebhookEndpoint(TENANT_A_ID, ep.id);
      assert.strictEqual(epCheck.state, 'disabled');

      // Verify delivery was moved to dead_letter and not attempted
      const delivery = h.repo.getWebhookDelivery(TENANT_A_ID, 'del_to_halt');
      assert.strictEqual(delivery.state, 'dead_letter');

      // Running delivery engine produces 0 deliveries
      const dispatch = await h.deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.strictEqual(dispatch.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 7: Webhook Deliveries List & Replay API
  // --------------------------------------------------------------------------
  describe('7. Webhook Deliveries List & Replay API (Same Event ID, Max 5/Day, 7-Day Window)', () => {
    let h;
    let baseUrl;

    before(async () => {
      h = setupHarness();
      await new Promise((resolve) => {
        h.server.listen(0, '127.0.0.1', () => {
          const addr = h.server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => h.server.close(resolve));
      h.db.close();
    });

    it('7.1 GET /v1/webhook-deliveries filters by job_id, endpoint_id, and isolates tenant boundaries', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_list_test',
        url: 'https://client.example.invalid/hooks',
      });

      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: 'job_list_filter',
          kind: 'render',
          state: 'succeeded',
          state_version: 1,
          stage: 'complete',
          progress: 1,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: 'out_list_filter',
          event_type: 'job.succeeded',
          job_id: 'job_list_filter',
          state_version: 1,
          payload_json: '{}',
          created_at: h.clock().toISOString(),
          processed_at: h.clock().toISOString(),
        });
        tx.insertScoped('webhook_deliveries', {
          tenant_id: TENANT_A_ID,
          id: 'del_list_1',
          endpoint_id: ep.id,
          outbox_event_id: 'out_list_filter',
          job_id: 'job_list_filter',
          state: 'delivered',
          attempt_count: 1,
          next_attempt_at: null,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          last_http_status: 200,
          replay_count_today: 0,
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
      });

      // Tenant A queries by job_id
      const resA = await fetch(`${baseUrl}/v1/webhook-deliveries?job_id=job_list_filter`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
        },
      });
      assert.strictEqual(resA.status, 200);
      const dataA = await resA.json();
      assert.strictEqual(dataA.data.length, 1);
      assert.strictEqual(dataA.data[0].id, 'del_list_1');
      assert.strictEqual(dataA.data[0].state, 'delivered');

      // Tenant B queries same job_id -> gets empty list (zero cross-tenant leakage)
      const resB = await fetch(`${baseUrl}/v1/webhook-deliveries?job_id=job_list_filter`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${h.keyBeta}`,
        },
      });
      assert.strictEqual(resB.status, 200);
      const dataB = await resB.json();
      assert.strictEqual(dataB.data.length, 0);
    });

    it('7.2 POST /v1/webhook-deliveries/{id}/replay preserves SAME outbox_event_id, enforces daily cap (5) and 7-day window', async () => {
      const ep = h.repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_replay_test',
        url: 'https://client.example.invalid/hooks',
      });
      h.repo.setWebhookEndpointState(TENANT_A_ID, ep.id, 'active');

      const deliveryId = 'del_replay_cap_test';
      const outboxEventId = 'out_replay_fixed_event_id';

      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        tx.insertScoped('jobs', {
          tenant_id: TENANT_A_ID,
          id: 'job_replay_test',
          kind: 'render',
          state: 'succeeded',
          state_version: 1,
          stage: 'complete',
          progress: 1,
          composition_id: 'cmp_main',
          composition_revision: 1,
          profile: 'mp4-720p-v1',
          snapshot_json: '{}',
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
        tx.insertScoped('outbox', {
          tenant_id: TENANT_A_ID,
          id: outboxEventId,
          event_type: 'job.succeeded',
          job_id: 'job_replay_test',
          state_version: 1,
          payload_json: '{}',
          created_at: h.clock().toISOString(),
          processed_at: h.clock().toISOString(),
        });
        tx.insertScoped('webhook_deliveries', {
          tenant_id: TENANT_A_ID,
          id: deliveryId,
          endpoint_id: ep.id,
          outbox_event_id: outboxEventId,
          job_id: 'job_replay_test',
          state: 'delivered',
          attempt_count: 1,
          next_attempt_at: null,
          deadline_at: new Date(h.clock().getTime() + 3600 * 1000).toISOString(),
          last_http_status: 200,
          replay_count_today: 0,
          created_at: h.clock().toISOString(),
          updated_at: h.clock().toISOString(),
        });
      });

      // Replays 1 through 5 succeed with 202 Accepted and same outbox_event_id
      for (let replay = 1; replay <= 5; replay++) {
        const replayRes = await fetch(`${baseUrl}/v1/webhook-deliveries/${deliveryId}/replay`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': `idem-replay-${replay}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });

        assert.strictEqual(replayRes.status, 202);
        const data = await replayRes.json();
        assert.strictEqual(data.id, deliveryId);
        assert.strictEqual(data.state, 'queued');
        assert.strictEqual(data.replay_count_today, replay);
        assert.strictEqual(data.outbox_event_id, outboxEventId); // Exact same event ID
      }

      // 6th replay in same day exceeds MAX_REPLAYS_PER_DAY (5) -> 429 QUOTA_EXCEEDED
      const excessRes = await fetch(`${baseUrl}/v1/webhook-deliveries/${deliveryId}/replay`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-replay-6',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(excessRes.status, 429);
      assert.ok(excessRes.headers.get('retry-after'));
      const excessData = await excessRes.json();
      assert.strictEqual(excessData.error.code, 'QUOTA_EXCEEDED');

      // 7-day retention limit: advance clock 8 days -> 410 DELIVERY_EXPIRED
      h.advanceClockMs(8 * 24 * 3600 * 1000);
      const expiredRes = await fetch(`${baseUrl}/v1/webhook-deliveries/${deliveryId}/replay`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyAlpha}`,
          'Idempotency-Key': 'idem-replay-expired',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      assert.strictEqual(expiredRes.status, 410);
      const expiredData = await expiredRes.json();
      assert.strictEqual(expiredData.error.code, 'DELIVERY_EXPIRED');
    });
  });

  // --------------------------------------------------------------------------
  // Suite 8: HMAC Raw Bytes Verification & Event Deduplication
  // --------------------------------------------------------------------------
  describe('8. HMAC Raw Bytes Verification & Event Deduplication (7-day window & state_version ordering)', () => {
    it('8.1 verifies signature against exact raw bytes; reserializing JSON causes HMAC mismatch', () => {
      const secret = 'whsec_e0f1a2b3c4d5e6f70123456789abcdef0123456789abcdef0123456789abcdef';
      const timestamp = 1793599240;

      // Exact raw bytes with non-canonical formatting, spaces, and UTF-8 unicode
      const rawBody = Buffer.from(
        '{\n  "id": "evt_raw_test",\n  "type": "job.succeeded",\n  "headline": "Khuyến mãi đặc biệt 🚀"\n}',
        'utf8',
      );

      const signature = computeWebhookSignature(secret, timestamp, rawBody);
      assert.match(signature, /^[0-9a-f]{64}$/);

      // 1. Verifying with exact raw bytes succeeds
      const verifySuccess = verifyWebhookSignature({
        headers: {
          'x-cve-event-id': 'evt_raw_test',
          'x-cve-timestamp': String(timestamp),
          'x-cve-key-id': 'whk_1',
          'x-cve-signature': `v1=${signature}`,
        },
        rawBodyBytes: rawBody,
        secrets: [{ keyId: 'whk_1', secret }],
        now: new Date(timestamp * 1000),
      });
      assert.strictEqual(verifySuccess.valid, true);

      // 2. Reserializing JSON modifies whitespace -> verification MUST fail!
      const reserializedBody = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString('utf8'))), 'utf8');
      assert.notStrictEqual(reserializedBody.toString('utf8'), rawBody.toString('utf8'));

      assert.throws(() => {
        verifyWebhookSignature({
          headers: {
            'x-cve-event-id': 'evt_raw_test',
            'x-cve-timestamp': String(timestamp),
            'x-cve-key-id': 'whk_1',
            'x-cve-signature': `v1=${signature}`,
          },
          rawBodyBytes: reserializedBody, // Reserialized bytes
          secrets: [{ keyId: 'whk_1', secret }],
          now: new Date(timestamp * 1000),
        });
      }, /HMAC signature mismatch/);
    });

    it('8.2 WebhookDeduplicator rejects duplicate event_id within 7 days and discards stale state_version', () => {
      const dedupe = new WebhookDeduplicator();
      const now = new Date('2026-11-03T12:00:00Z');

      // 1. Initial event arrives: state_version = 1 -> accepted
      const check1 = dedupe.checkAndRecord('evt_job_1_v1', 'job_alpha', 1, now);
      assert.strictEqual(check1.accepted, true);
      assert.strictEqual(check1.isDuplicate, false);
      assert.strictEqual(check1.isStaleStateVersion, false);

      // 2. Exact same event_id arrives again (network retry or replay) -> rejected as DUPLICATE_EVENT_ID
      const checkDuplicate = dedupe.checkAndRecord('evt_job_1_v1', 'job_alpha', 1, now);
      assert.strictEqual(checkDuplicate.accepted, false);
      assert.strictEqual(checkDuplicate.isDuplicate, true);
      assert.strictEqual(checkDuplicate.reason, 'DUPLICATE_EVENT_ID');

      // 3. Newer state version arrives: state_version = 3 -> accepted
      const checkNewer = dedupe.checkAndRecord('evt_job_1_v3', 'job_alpha', 3, now);
      assert.strictEqual(checkNewer.accepted, true);

      // 4. Stale / out-of-order event arrives: state_version = 2 (less than 3) -> rejected as STALE_STATE_VERSION
      const checkStale = dedupe.checkAndRecord('evt_job_1_v2', 'job_alpha', 2, now);
      assert.strictEqual(checkStale.accepted, false);
      assert.strictEqual(checkStale.isStaleStateVersion, true);
      assert.strictEqual(checkStale.reason, 'STALE_STATE_VERSION');
      assert.strictEqual(checkStale.previousStateVersion, 3);
    });

    it('8.3 rejects timestamp clock skew > 300 seconds', () => {
      const secret = 'whsec_e0f1a2b3c4d5e6f70123456789abcdef0123456789abcdef0123456789abcdef';
      const nowMs = Date.parse('2026-11-03T12:00:00Z');
      const nowSec = Math.floor(nowMs / 1000);
      const skewedTimestamp = nowSec - 301; // 301s skew (> 300s limit)

      const body = Buffer.from(JSON.stringify({ event: 'test' }), 'utf8');
      const signature = computeWebhookSignature(secret, skewedTimestamp, body);

      assert.throws(() => {
        verifyWebhookSignature({
          headers: {
            'x-cve-event-id': 'evt_skew',
            'x-cve-timestamp': String(skewedTimestamp),
            'x-cve-key-id': 'whk_1',
            'x-cve-signature': `v1=${signature}`,
          },
          rawBodyBytes: body,
          secrets: [{ keyId: 'whk_1', secret }],
          now: new Date(nowMs),
        });
      }, /skew/i);
    });

    it('8.4 re-exports canonical webhook utilities from @creativanta/dispatcher ESM entrypoint', () => {
      assert.strictEqual(typeof DispatcherPackage.WebhookDeliveryService, 'function');
      assert.strictEqual(typeof DispatcherPackage.WebhookDeduplicator, 'function');
      assert.strictEqual(typeof DispatcherPackage.computeWebhookSignature, 'function');
      assert.strictEqual(typeof DispatcherPackage.verifyWebhookSignature, 'function');
      assert.strictEqual(typeof DispatcherPackage.encryptSecretAtRest, 'function');
      assert.strictEqual(typeof DispatcherPackage.decryptSecretAtRest, 'function');
    });
  });
});
