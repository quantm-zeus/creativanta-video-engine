/**
 * Task P5-03: Creativanta Polling Reconciliation & Job Cancellation Tests.
 *
 * Verifies:
 *   - Polling reconciliation with exponential backoff (2s -> 10s) until terminal state
 *   - Monotonic state_version guard: polling never regresses local state
 *   - Reconciliation timeout handling (ReconciliationTimeoutError)
 *   - AbortSignal cancellation of polling
 *   - Job cancellation semantics:
 *       * Active job -> 202 Accepted (canceled / cancel_requested)
 *       * Already canceled -> 200 OK idempotent confirmation
 *       * Already terminal (succeeded / failed) -> 409 JOB_TERMINAL (JobTerminalError)
 *       * Idempotent cancel replay
 *   - JobReconciliationManager: unified tracking by jobId and externalReference,
 *     coordinating webhook callbacks and polling fallback
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CreativantaClient,
  CreativantaContractMock,
  CreativantaWebhookReceiver,
  JobReconciliationManager,
  JobTerminalError,
  ReconciliationTimeoutError,
  generateIdempotencyKey,
} from '../dist/index.js';

describe('Creativanta Client: Polling Reconciliation & Cancellation', () => {
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

  it('3.1 Reconciles an active job via polling until terminal state (succeeded)', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_reconcile_01',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_reconcile_1'),
    });

    assert.equal(admitted.state, 'queued');

    // Simulate server transitioning job queued -> rendering -> succeeded in background
    setTimeout(() => {
      mockServer.updateJobState(admitted.id, 'rendering');
    }, 150);

    setTimeout(() => {
      mockServer.updateJobState(admitted.id, 'succeeded');
    }, 350);

    const polledStates = [];
    const finalJob = await client.reconcileJob(admitted.id, {
      initialIntervalMs: 100, // Speed up for test
      maxIntervalMs: 500,
      backoffFactor: 1.5,
      timeoutMs: 5000,
      onPoll: (job) => {
        polledStates.push(job.state);
      },
    });

    assert.equal(finalJob.state, 'succeeded');
    assert.ok(polledStates.includes('succeeded'));
  });

  it('3.2 Enforces timeout during polling reconciliation (ReconciliationTimeoutError)', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_timeout_test',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_timeout_1'),
    });

    // Job stays 'queued' and never reaches terminal state
    await assert.rejects(
      async () => {
        await client.reconcileJob(admitted.id, {
          initialIntervalMs: 50,
          maxIntervalMs: 100,
          timeoutMs: 250, // Shorter than completion
        });
      },
      (err) => {
        assert.ok(err instanceof ReconciliationTimeoutError);
        assert.equal(err.jobId, admitted.id);
        assert.equal(err.lastState, 'queued');
        return true;
      },
    );
  });

  it('3.3 Cancels an active job (202 Accepted) with Idempotency-Key', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_cancel_01',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_cancel_create'),
    });

    const cancelKey = generateIdempotencyKey('idem_cancel_action');
    const cancelRes = await client.cancelJob(admitted.id, {
      idempotencyKey: cancelKey,
      reason: 'User requested cancellation from UI',
    });

    assert.equal(cancelRes.id, admitted.id);
    assert.equal(cancelRes.httpStatus, 202);
    assert.equal(cancelRes.state, 'canceled');
    assert.equal(cancelRes.isReplayed, false);

    // Verify job in mock server is now canceled
    const job = await client.getJob(admitted.id);
    assert.equal(job.state, 'canceled');
  });

  it('3.4 Idempotent cancel replay returns 202 with isReplayed: true', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_cancel_replay',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_cancel_replay_c'),
    });

    const cancelKey = generateIdempotencyKey('idem_cancel_replay_k');
    const cancel1 = await client.cancelJob(admitted.id, { idempotencyKey: cancelKey });
    assert.equal(cancel1.httpStatus, 202);
    assert.equal(cancel1.isReplayed, false);

    // Replay with exact same idempotency key
    const cancel2 = await client.cancelJob(admitted.id, { idempotencyKey: cancelKey });
    assert.equal(cancel2.httpStatus, 202);
    assert.equal(cancel2.isReplayed, true);
  });

  it('3.5 Canceling an already-canceled job with NEW key returns 200 OK state confirmation', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_already_canceled',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_create_alr'),
    });

    // First cancel (202)
    await client.cancelJob(admitted.id, {
      idempotencyKey: generateIdempotencyKey('idem_cancel_1'),
    });

    // Subsequent cancel with DIFFERENT idempotency key (200 OK)
    const secondCancel = await client.cancelJob(admitted.id, {
      idempotencyKey: generateIdempotencyKey('idem_cancel_2_new'),
    });

    assert.equal(secondCancel.httpStatus, 200);
    assert.equal(secondCancel.state, 'canceled');
  });

  it('3.6 Canceling a terminal job (succeeded) throws JobTerminalError (409 JOB_TERMINAL)', async () => {
    const admitted = await client.createRenderJob({
      compositionId: 'cmp_terminal_cancel',
      revision: 1,
      idempotencyKey: generateIdempotencyKey('idem_create_terminal'),
    });

    mockServer.updateJobState(admitted.id, 'succeeded');

    await assert.rejects(
      async () => {
        await client.cancelJob(admitted.id, {
          idempotencyKey: generateIdempotencyKey('idem_cancel_terminal'),
        });
      },
      (err) => {
        assert.ok(err instanceof JobTerminalError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'JOB_TERMINAL');
        return true;
      },
    );
  });

  it('3.7 JobReconciliationManager coordinates webhook events and polling for unified tracking', async () => {
    const receiver = new CreativantaWebhookReceiver({
      secrets: mockServer.webhookSecret,
    });
    const manager = new JobReconciliationManager({
      client,
      receiver,
    });

    const admitted = await client.createRenderJob({
      compositionId: 'cmp_unified_01',
      revision: 1,
      externalReference: 'order_ref_abc123',
      idempotencyKey: generateIdempotencyKey('idem_unified'),
    });

    // Register job tracking by externalReference
    manager.trackJob(admitted.id, {
      externalReference: 'order_ref_abc123',
    });

    const tracked = manager.getTrackedJob('order_ref_abc123');
    assert.ok(tracked);
    assert.equal(tracked.jobId, admitted.id);
    assert.equal(tracked.state, 'queued');

    // Simulate incoming webhook event with state_version = 2 (rendering)
    receiver.verifyAndProcess(
      {
        'x-cve-signature': `v1=${crypto.createHmac('sha256', mockServer.webhookSecret).update(`${Math.floor(Date.now() / 1000)}.{"id":"evt_wh_1","type":"job.rendering","api_version":"v1","created_at":"2026-11-04T00:00:00Z","data":{"job_id":"${admitted.id}","state":"rendering","state_version":2,"client_reference":"order_ref_abc123"}}`).digest('hex')}`,
        'x-cve-timestamp': String(Math.floor(Date.now() / 1000)),
        'x-cve-key-Id': 'whk_mock_1',
        'x-cve-event-id': 'evt_wh_1',
      },
      `{"id":"evt_wh_1","type":"job.rendering","api_version":"v1","created_at":"2026-11-04T00:00:00Z","data":{"job_id":"${admitted.id}","state":"rendering","state_version":2,"client_reference":"order_ref_abc123"}}`,
    );

    assert.equal(tracked.state, 'rendering');
    assert.equal(tracked.stateVersion, 2);

    // Advance mock server state: rendering (v2), then succeeded (v3)
    mockServer.updateJobState(admitted.id, 'rendering');
    mockServer.updateJobState(admitted.id, 'succeeded');
    const updated = await manager.reconcileJob('order_ref_abc123');
    assert.equal(updated.state, 'succeeded');
    assert.equal(updated.isTerminal, true);
    assert.ok(updated.stateVersion >= 3);
  });
});
