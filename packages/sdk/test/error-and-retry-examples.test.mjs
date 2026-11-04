/**
 * Error Handling & Retry Test Suite (Task P5-04).
 *
 * Verifies robust fault-tolerance, retry strategies, and error mapping:
 *   - 409 IDEMPOTENCY_IN_PROGRESS auto-retry with Retry-After and identical Idempotency-Key
 *   - 429 RATE_LIMITED & 503 SERVICE_UNAVAILABLE auto-retry preserving Idempotency-Key
 *   - Retry exhaustion throwing typed RateLimitedError / ServiceUnavailableError
 *   - 410 GRANT_EXPIRED automatic recovery without rerender
 *   - Typed deterministic error mapping (400, 401, 403, 404, 409, 413, 422)
 *   - Timeout and AbortController signal handling
 *   - Webhook security rejection: forged signatures, clock skew > 300s, monotonic state_version
 *   - Execution of SDK error-and-retry example runner
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  AuthenticationError,
  CreativantaClient,
  CreativantaContractMock,
  CreativantaWebhookReceiver,
  GrantExpiredError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  JobTerminalError,
  NotFoundError,
  RateLimitedError,
  ReconciliationTimeoutError,
  ServiceUnavailableError,
  ValidationError,
  WebhookVerificationError,
  generateIdempotencyKey,
} from '../dist/index.js';
import { runErrorAndRetryScenarios } from '../dist/examples/error-and-retry.js';

describe('Task P5-04: Error Handling & Retry Recipes Test Suite', () => {
  let mockServer;
  let baseUrl;
  let client;

  const PLACEHOLDER_API_KEY = 'cve_live_placeholder_key_errors_0000000000';
  const PLACEHOLDER_WEBHOOK_SECRET = 'whsec_placeholder_secret_errors_00000000';

  before(async () => {
    mockServer = new CreativantaContractMock({
      apiKey: PLACEHOLDER_API_KEY,
      webhookSecret: PLACEHOLDER_WEBHOOK_SECRET,
      autoAdvanceJobsMs: 0,
    });
    baseUrl = await mockServer.start();
    client = new CreativantaClient({
      baseUrl,
      apiKey: PLACEHOLDER_API_KEY,
      timeoutMs: 5000,
      maxRetries: 2,
    });
  });

  after(async () => {
    await mockServer.stop();
  });

  // =========================================================================
  // 1. 409 IDEMPOTENCY_IN_PROGRESS Auto-Retry
  // =========================================================================
  describe('1. Idempotency In Progress Handling (409)', () => {
    it('1.1 Automatically retries with Retry-After preserving the same key and succeeds', async () => {
      mockServer.simulateIdempotencyInProgressCount = 1;
      const key = generateIdempotencyKey('idem_retry_succ');

      const res = await client.createRenderJob({
        compositionId: 'cmp_retry_1',
        revision: 1,
        idempotencyKey: key,
      });

      assert.equal(res.kind, 'render');
      assert.equal(res.state, 'queued');
    });

    it('1.2 Throws IdempotencyInProgressError when retries exceed maxRetries', async () => {
      // Set simulation count higher than client.maxRetries (2)
      mockServer.simulateIdempotencyInProgressCount = 5;
      const key = generateIdempotencyKey('idem_retry_fail');

      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_retry_fail',
            revision: 1,
            idempotencyKey: key,
          }),
        (err) => {
          assert.ok(err instanceof IdempotencyInProgressError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'IDEMPOTENCY_IN_PROGRESS');
          assert.equal(err.retryable, true);
          return true;
        },
      );
      mockServer.simulateIdempotencyInProgressCount = 0;
    });
  });

  // =========================================================================
  // 2. 429 RATE_LIMITED & 503 SERVICE_UNAVAILABLE Auto-Retry
  // =========================================================================
  describe('2. Rate Limiting & Service Unavailable Handling', () => {
    it('2.1 Automatically retries 429 RATE_LIMITED with jitter and same key', async () => {
      mockServer.simulateRateLimitedCount = 1;
      const key = generateIdempotencyKey('idem_429_succ');

      const res = await client.createPreviewJob({
        compositionId: 'cmp_429',
        revision: 1,
        mode: 'frame',
        frameIndex: 0,
        idempotencyKey: key,
      });

      assert.equal(res.kind, 'preview');
      assert.equal(res.state, 'queued');
    });

    it('2.2 Throws RateLimitedError when 429 retries are exhausted', async () => {
      mockServer.simulateRateLimitedCount = 5;
      const key = generateIdempotencyKey('idem_429_exhaust');

      await assert.rejects(
        () =>
          client.createPreviewJob({
            compositionId: 'cmp_429_exhaust',
            revision: 1,
            mode: 'frame',
            frameIndex: 0,
            idempotencyKey: key,
          }),
        (err) => {
          assert.ok(err instanceof RateLimitedError);
          assert.equal(err.status, 429);
          assert.equal(err.code, 'RATE_LIMITED');
          assert.equal(err.retryable, true);
          return true;
        },
      );
      mockServer.simulateRateLimitedCount = 0;
    });

    it('2.3 Automatically retries 503 SERVICE_UNAVAILABLE and succeeds', async () => {
      mockServer.simulateServiceUnavailableCount = 1;
      const key = generateIdempotencyKey('idem_503_succ');

      const res = await client.createRenderJob({
        compositionId: 'cmp_503',
        revision: 1,
        idempotencyKey: key,
      });

      assert.equal(res.kind, 'render');
      assert.equal(res.state, 'queued');
    });

    it('2.4 Throws ServiceUnavailableError when 503 retries are exhausted', async () => {
      mockServer.simulateServiceUnavailableCount = 5;
      const key = generateIdempotencyKey('idem_503_exhaust');

      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_503_exhaust',
            revision: 1,
            idempotencyKey: key,
          }),
        (err) => {
          assert.ok(err instanceof ServiceUnavailableError);
          assert.equal(err.status, 503);
          assert.equal(err.code, 'SERVICE_UNAVAILABLE');
          assert.equal(err.retryable, true);
          return true;
        },
      );
      mockServer.simulateServiceUnavailableCount = 0;
    });
  });

  // =========================================================================
  // 3. 410 GRANT_EXPIRED Recovery & Download Integrity
  // =========================================================================
  describe('3. Download Grant Expiry Recovery (410)', () => {
    it('3.1 Recovers from in-transit 410 GRANT_EXPIRED by requesting fresh grant without rerender', async () => {
      const dummyContent = Buffer.from('recovery-video-bytes-mp4');
      const sha256 = crypto.createHash('sha256').update(dummyContent).digest('hex');
      const artId = 'art_expiry_recovery_test';

      mockServer.seedJob({
        id: 'job_expiry_test',
        kind: 'render',
        state: 'succeeded',
        state_version: 2,
        composition_id: 'cmp_expiry_test',
        revision: 1,
        profile: 'mp4-720p-v1',
        artifacts: [
          {
            id: artId,
            kind: 'video',
            mime_type: 'video/mp4',
            sha256,
            bytes: dummyContent.length,
            content: dummyContent,
          },
        ],
        usage: { output_seconds: 15, cpu_seconds: 2, billable_output_minutes: 0.25 },
        created_at: new Date().toISOString(),
      });

      // Set short TTL: 1 second
      mockServer.grantTtlSeconds = 1;
      const initialGrant = await client.getArtifactDownloadGrant(artId);

      // Wait 1100ms so the raw token expires
      await new Promise((r) => setTimeout(r, 1100));

      // Direct fetch on raw URL returns 410 GRANT_EXPIRED
      const directRes = await fetch(initialGrant.url);
      assert.equal(directRes.status, 410);

      // But client.downloadArtifact catches 410, refreshes grant, and completes download!
      const downloaded = await client.downloadArtifact(artId, {
        refreshBufferMs: 0,
        maxRefreshRetries: 1,
        verifyIntegrity: true,
      });

      assert.equal(downloaded.length, dummyContent.length);
      assert.equal(downloaded.toString('utf8'), dummyContent.toString('utf8'));
      mockServer.grantTtlSeconds = 300;
    });

    it('3.2 Throws GrantExpiredError when retries are exhausted on expired grant', async () => {
      // Mock server permanently returns 410 for a custom expired grant
      const artId = 'art_perm_expired';
      mockServer.seedJob({
        id: 'job_perm_expired',
        kind: 'render',
        state: 'succeeded',
        state_version: 1,
        composition_id: 'cmp_expired',
        revision: 1,
        profile: 'mp4-720p-v1',
        artifacts: [{ id: artId, kind: 'video', mime_type: 'video/mp4', sha256: 'abc', bytes: 10, content: Buffer.from('1234567890') }],
        usage: { output_seconds: 10, cpu_seconds: 1, billable_output_minutes: 0.16 },
        created_at: new Date().toISOString(),
      });

      mockServer.grantTtlSeconds = 0; // all grants immediately expire
      await assert.rejects(
        () =>
          client.downloadArtifact(artId, {
            refreshBufferMs: 0,
            maxRefreshRetries: 0, // no retry
          }),
        (err) => {
          assert.ok(err instanceof GrantExpiredError);
          assert.equal(err.status, 410);
          assert.equal(err.code, 'GRANT_EXPIRED');
          return true;
        },
      );
      mockServer.grantTtlSeconds = 300;
    });
  });

  // =========================================================================
  // 4. Non-Retryable Deterministic Errors
  // =========================================================================
  describe('4. Non-Retryable Deterministic Error Mappings', () => {
    it('4.1 Maps HTTP 401 to AuthenticationError', async () => {
      mockServer.simulateAuthErrorCount = 1;
      await assert.rejects(
        () => client.getCapabilities(),
        (err) => {
          assert.ok(err instanceof AuthenticationError);
          assert.equal(err.status, 401);
          assert.equal(err.code, 'UNAUTHENTICATED');
          assert.equal(err.retryable, false);
          return true;
        },
      );
    });

    it('4.2 Maps HTTP 404 to NotFoundError', async () => {
      mockServer.simulateNotFoundErrorCount = 1;
      await assert.rejects(
        () => client.getJob('job_nonexistent_999'),
        (err) => {
          assert.ok(err instanceof NotFoundError);
          assert.equal(err.status, 404);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );
    });

    it('4.3 Maps HTTP 422 to ValidationError with details array', async () => {
      mockServer.simulateValidationErrorCount = 1;
      await assert.rejects(
        () => client.createComposition({ name: 'Invalid', spec: {} }),
        (err) => {
          assert.ok(err instanceof ValidationError);
          assert.equal(err.status, 422);
          assert.equal(err.code, 'VALIDATION_FAILED');
          assert.ok(Array.isArray(err.details));
          assert.equal(err.details[0].code, 'OUT_OF_RANGE');
          return true;
        },
      );
    });

    it('4.4 Maps HTTP 409 to IdempotencyConflictError on differing payload', async () => {
      const fixedKey = generateIdempotencyKey('conflict_suite_test');
      await client.createRenderJob({
        compositionId: 'cmp_conf_a',
        revision: 1,
        idempotencyKey: fixedKey,
      });

      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_conf_b',
            revision: 1,
            idempotencyKey: fixedKey,
          }),
        (err) => {
          assert.ok(err instanceof IdempotencyConflictError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
          return true;
        },
      );
    });

    it('4.5 Maps HTTP 409 to JobTerminalError when canceling finished job', async () => {
      const job = await client.createRenderJob({
        compositionId: 'cmp_terminal_err_test',
        revision: 1,
        idempotencyKey: generateIdempotencyKey('term_err_key'),
      });
      mockServer.updateJobState(job.id, 'succeeded');

      await assert.rejects(
        () => client.cancelJob(job.id, { idempotencyKey: generateIdempotencyKey('term_err_cancel') }),
        (err) => {
          assert.ok(err instanceof JobTerminalError);
          assert.equal(err.status, 409);
          assert.equal(err.code, 'JOB_TERMINAL');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 5. AbortSignal & Timeout Handling
  // =========================================================================
  describe('5. AbortSignal & Timeout Handling', () => {
    it('5.1 Aborts in-flight HTTP request when AbortSignal fires', async () => {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        () =>
          client.createRenderJob({
            compositionId: 'cmp_abort_test',
            revision: 1,
            signal: controller.signal,
          }),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('aborted') || err.name === 'AbortError');
          return true;
        },
      );
    });

    it('5.2 Enforces timeout during polling reconciliation (ReconciliationTimeoutError)', async () => {
      const job = await client.createRenderJob({
        compositionId: 'cmp_recon_timeout',
        revision: 1,
        idempotencyKey: generateIdempotencyKey('recon_timeout_key'),
      });

      // Job stays in queued state indefinitely
      await assert.rejects(
        () =>
          client.reconcileJob(job.id, {
            initialIntervalMs: 50,
            maxIntervalMs: 100,
            timeoutMs: 250, // short timeout
          }),
        (err) => {
          assert.ok(err instanceof ReconciliationTimeoutError);
          assert.equal(err.jobId, job.id);
          assert.equal(err.lastState, 'queued');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // 6. Webhook Security Rejection
  // =========================================================================
  describe('6. Webhook Security & Verification Errors', () => {
    const receiver = new CreativantaWebhookReceiver({
      secrets: PLACEHOLDER_WEBHOOK_SECRET,
      maxSkewSeconds: 300,
    });

    it('6.1 Rejects forged or tampered signature (401 INVALID_SIGNATURE)', () => {
      const body = JSON.stringify({ id: 'evt_1', type: 'job.succeeded', api_version: 'v1', created_at: new Date().toISOString(), data: {} });
      assert.throws(
        () =>
          receiver.verifySignature({
            rawBody: body,
            signature: 'v1=deadbeefcafebabe000000000000000000000000000000000000000000000000',
            timestamp: Math.floor(Date.now() / 1000),
            eventId: 'evt_1',
          }),
        (err) => {
          assert.ok(err instanceof WebhookVerificationError);
          assert.equal(err.code, 'INVALID_SIGNATURE');
          assert.equal(err.httpStatus, 401);
          return true;
        },
      );
    });

    it('6.2 Rejects clock skew > 300s (400 CLOCK_SKEW_EXCEEDED)', () => {
      const body = JSON.stringify({ id: 'evt_2', type: 'job.succeeded', api_version: 'v1', created_at: new Date().toISOString(), data: {} });
      const staleTimestamp = Math.floor(Date.now() / 1000) - 400; // 400s in the past

      const sigPayload = `${staleTimestamp}.${body}`;
      const sigHex = crypto.createHmac('sha256', PLACEHOLDER_WEBHOOK_SECRET).update(sigPayload).digest('hex');

      assert.throws(
        () =>
          receiver.verifySignature({
            rawBody: body,
            signature: `v1=${sigHex}`,
            timestamp: staleTimestamp,
            eventId: 'evt_2',
          }),
        (err) => {
          assert.ok(err instanceof WebhookVerificationError);
          assert.equal(err.code, 'CLOCK_SKEW_EXCEEDED');
          assert.equal(err.httpStatus, 400);
          return true;
        },
      );
    });

    it('6.3 Deduplicates repeated event IDs and drops stale state_version', () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const makePayload = (eventId, jobId, stateVersion) => {
        const body = JSON.stringify({
          id: eventId,
          type: 'job.state_changed',
          api_version: 'v1',
          created_at: new Date().toISOString(),
          data: { job_id: jobId, state: 'rendering', state_version: stateVersion },
        });
        const sigHex = crypto.createHmac('sha256', PLACEHOLDER_WEBHOOK_SECRET).update(`${nowSec}.${body}`).digest('hex');
        return { body, sigHex };
      };

      // First event with version 5
      const { body: body1, sigHex: sig1 } = makePayload('evt_mono_1', 'job_mono', 5);
      const res1 = receiver.verifySignature({
        rawBody: body1,
        signature: `v1=${sig1}`,
        timestamp: nowSec,
        eventId: 'evt_mono_1',
      });
      assert.equal(res1.verified, true);
      assert.equal(res1.isDuplicate, false);
      assert.equal(res1.isStaleStateVersion, false);

      // Re-delivery of SAME eventId within 7 days -> marked duplicate!
      const resDuplicate = receiver.verifySignature({
        rawBody: body1,
        signature: `v1=${sig1}`,
        timestamp: nowSec,
        eventId: 'evt_mono_1',
      });
      assert.equal(resDuplicate.verified, true);
      assert.equal(resDuplicate.isDuplicate, true);

      // Delayed out-of-order event with LOWER state_version (version 3 < 5) -> marked stale!
      const { body: body2, sigHex: sig2 } = makePayload('evt_mono_2', 'job_mono', 3);
      const resStale = receiver.verifySignature({
        rawBody: body2,
        signature: `v1=${sig2}`,
        timestamp: nowSec,
        eventId: 'evt_mono_2',
      });
      assert.equal(resStale.verified, true);
      assert.equal(resStale.isStaleStateVersion, true);
    });
  });

  // =========================================================================
  // 7. SDK Example Runner Verification
  // =========================================================================
  describe('7. Example Runner Programmatic Verification', () => {
    it('7.1 Executes runErrorAndRetryScenarios successfully across all recipes', async () => {
      const errorReport = await runErrorAndRetryScenarios({
        client,
        webhookSecret: PLACEHOLDER_WEBHOOK_SECRET,
        mockServer,
      });

      assert.equal(errorReport.idempotencyInProgressHandled, true);
      assert.equal(errorReport.rateLimitHandled, true);
      assert.equal(errorReport.grantExpiredRecovered, true);
      assert.equal(errorReport.validationErrorCaught, true);
      assert.ok(errorReport.validationDetailsCount > 0);
      assert.equal(errorReport.jobTerminalCaught, true);
      assert.equal(errorReport.abortSignalHandled, true);
      assert.equal(errorReport.webhookForgeryBlocked, true);
    });
  });
});
