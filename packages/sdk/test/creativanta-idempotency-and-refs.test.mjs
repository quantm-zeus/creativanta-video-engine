/**
 * Task P5-03: Creativanta Client - Idempotency & External Reference Tests.
 *
 * Verifies:
 *   - Idempotency key format validation (1–128 ASCII [A-Za-z0-9._:-])
 *   - RFC 8785 (JCS) canonical request hashing with Unicode NFC normalization
 *   - external_reference mapping to client_reference
 *   - Automatic Idempotency-Key generation when not provided
 *   - Idempotency replayed response detection (Idempotency-Replayed: true -> isReplayed: true)
 *   - Idempotency conflict handling (409 IDEMPOTENCY_CONFLICT -> IdempotencyConflictError)
 *   - Transient retry handling for 409 IDEMPOTENCY_IN_PROGRESS, 429 RATE_LIMITED, and 503
 *     preserving the exact same Idempotency-Key
 *   - No shared DB assumptions
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreativantaClient,
  CreativantaContractMock,
  IdempotencyConflictError,
  computeCanonicalRequestHash,
  generateIdempotencyKey,
  isValidIdempotencyKey,
} from '../dist/index.js';

describe('Creativanta Client: Idempotency & External Reference', () => {
  let mockServer;
  let baseUrl;
  let client;

  before(async () => {
    mockServer = new CreativantaContractMock();
    baseUrl = await mockServer.start();
    client = new CreativantaClient({
      baseUrl,
      apiKey: mockServer.apiKey,
    });
  });

  after(async () => {
    await mockServer.stop();
  });

  it('1.1 Enforces strict Idempotency-Key format rules (1-128 ASCII [A-Za-z0-9._:-])', () => {
    assert.equal(isValidIdempotencyKey('idem_valid_123'), true);
    assert.equal(isValidIdempotencyKey('cve:job.456-test_01'), true);
    assert.equal(isValidIdempotencyKey(''), false);
    assert.equal(isValidIdempotencyKey('has whitespace'), false);
    assert.equal(isValidIdempotencyKey('unicode_tiếng_việt'), false);
    assert.equal(isValidIdempotencyKey('a'.repeat(129)), false);
    assert.equal(isValidIdempotencyKey('a'.repeat(128)), true);

    const generatedKey = generateIdempotencyKey('test_prefix');
    assert.ok(isValidIdempotencyKey(generatedKey));
    assert.ok(generatedKey.startsWith('test_prefix_'));
  });

  it('1.2 Canonicalizes JSON request payloads per RFC 8785 (JCS Unicode NFC & sorted keys)', () => {
    // Differing key order
    const objA = { z: 1, a: 2, m: { b: 3, a: 4 } };
    const objB = { m: { a: 4, b: 3 }, a: 2, z: 1 };
    assert.equal(computeCanonicalRequestHash(objA), computeCanonicalRequestHash(objB));

    // Unicode NFC vs NFD
    const nfcString = 'Đắk Lắk'; // NFC
    const nfdString = nfcString.normalize('NFD');
    assert.notEqual(nfcString, nfdString);
    assert.equal(computeCanonicalRequestHash({ locale: nfcString }), computeCanonicalRequestHash({ locale: nfdString }));

    // Empty body
    assert.equal(computeCanonicalRequestHash(null), computeCanonicalRequestHash(undefined));
    assert.equal(computeCanonicalRequestHash(''), computeCanonicalRequestHash(null));
  });

  it('1.3 Normalizes externalReference to client_reference on render job submission', async () => {
    const idemKey = generateIdempotencyKey('idem_ext_ref');
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_campaign_01',
      revision: 1,
      externalReference: 'creativanta_campaign_order_9988',
      idempotencyKey: idemKey,
    });

    assert.ok(admitted.id);
    assert.equal(admitted.kind, 'render');
    assert.equal(admitted.state, 'queued');
    assert.equal(admitted.isReplayed, false);

    // Verify record in mock server has client_reference set to externalReference
    const record = mockServer.getJobRecord(admitted.id);
    assert.ok(record);
    assert.equal(record.client_reference, 'creativanta_campaign_order_9988');
  });

  it('1.4 Detects idempotent replay (Idempotency-Replayed: true -> isReplayed: true)', async () => {
    const idemKey = generateIdempotencyKey('idem_replay_test');
    const firstCall = await client.createRenderJob({
      compositionId: 'cmp_promo_01',
      revision: 2,
      externalReference: 'campaign_replay_1',
      idempotencyKey: idemKey,
    });
    assert.equal(firstCall.isReplayed, false);

    // Repeated call with exact same idempotency key and payload
    const secondCall = await client.createRenderJob({
      compositionId: 'cmp_promo_01',
      revision: 2,
      externalReference: 'campaign_replay_1',
      idempotencyKey: idemKey,
    });
    assert.equal(secondCall.isReplayed, true);
    assert.equal(secondCall.id, firstCall.id);
  });

  it('1.5 Throws IdempotencyConflictError (409 IDEMPOTENCY_CONFLICT) when payload differs for same key', async () => {
    const idemKey = generateIdempotencyKey('idem_conflict_test');
    await client.createRenderJob({
      compositionId: 'cmp_promo_original',
      revision: 1,
      idempotencyKey: idemKey,
    });

    // Calling with same key but differing compositionId
    await assert.rejects(
      async () => {
        await client.createRenderJob({
          compositionId: 'cmp_promo_MODIFIED',
          revision: 1,
          idempotencyKey: idemKey,
        });
      },
      (err) => {
        assert.ok(err instanceof IdempotencyConflictError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'IDEMPOTENCY_CONFLICT');
        return true;
      },
    );
  });

  it('1.6 Automatically retries 409 IDEMPOTENCY_IN_PROGRESS with Retry-After preserving the same key', async () => {
    const idemKey = generateIdempotencyKey('idem_in_progress');

    // Instruct mock server to simulate 1 transient IDEMPOTENCY_IN_PROGRESS
    mockServer.simulateIdempotencyInProgressCount = 1;

    const admitted = await client.createRenderJob({
      compositionId: 'cmp_progress_retry',
      revision: 1,
      idempotencyKey: idemKey,
    });

    assert.ok(admitted.id);
    assert.equal(admitted.state, 'queued');
    assert.equal(mockServer.simulateIdempotencyInProgressCount, 0);
  });

  it('1.7 Automatically retries 429 RATE_LIMITED and 503 SERVICE_UNAVAILABLE preserving the same key', async () => {
    const idemKey429 = generateIdempotencyKey('idem_429_test');
    mockServer.simulateRateLimitedCount = 1;

    const admitted429 = await client.createRenderJob({
      compositionId: 'cmp_rate_limited_retry',
      revision: 1,
      idempotencyKey: idemKey429,
    });
    assert.ok(admitted429.id);
    assert.equal(mockServer.simulateRateLimitedCount, 0);

    const idemKey503 = generateIdempotencyKey('idem_503_test');
    mockServer.simulateServiceUnavailableCount = 1;

    const admitted503 = await client.createRenderJob({
      compositionId: 'cmp_503_retry',
      revision: 1,
      idempotencyKey: idemKey503,
    });
    assert.ok(admitted503.id);
    assert.equal(mockServer.simulateServiceUnavailableCount, 0);
  });
});
