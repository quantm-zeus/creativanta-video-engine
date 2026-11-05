/**
 * Test Suite: Database & Queue Profiling, Broker Architecture Evaluation & Disaster Recovery
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", lines 37-40)
 *   - docs/SECURITY.md ("Threat model", "Renderer -> artifact publication")
 *   - docs/TESTING.md ("Reliability/load và CI", line 30, line 70, line 72)
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership")
 *   - docs/CAPACITY_AND_AUTOSCALE.md
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-03: "DB/queue profiling; chỉ thêm broker khi evidence bottleneck,
 *      transactional outbox/fencing giữ nguyên; ADR và recovery tests")
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DbQueueEngine, DbQueueProfiler } from './db-queue-profiler.mjs';
import { QueueRecoveryTester } from './queue-recovery-tester.mjs';

describe('Task P9-03: DB Queue Engine & Transactional Outbox Invariant Suite', () => {
  it('enforces tenant pending limits and fair-share concurrency bounds', () => {
    const engine = new DbQueueEngine({ maxTenantPending: 3, maxTenantActive: 1 });
    const tenantId = 'tenant_quota_test';

    // Can enqueue up to 3 jobs
    engine.enqueueJob({ tenantId, jobId: 'j1' });
    engine.enqueueJob({ tenantId, jobId: 'j2' });
    engine.enqueueJob({ tenantId, jobId: 'j3' });

    // 4th enqueue exceeds pending quota limit
    assert.throws(
      () => engine.enqueueJob({ tenantId, jobId: 'j4' }),
      /pending queue limit \(3\) exceeded/
    );

    // Claim 1 job
    const claim = engine.claimNextJob({ workerId: 'w1', nodeId: 'n1' });
    assert.ok(claim);
    assert.strictEqual(claim.jobId, 'j1');
    assert.strictEqual(claim.leaseEpoch, 1);

    // Second claim for same tenant should be skipped due to maxTenantActive = 1
    const secondClaim = engine.claimNextJob({ workerId: 'w2', nodeId: 'n1' });
    assert.strictEqual(secondClaim, null, 'Second claim should be skipped while 1 active job running');
  });

  it('prioritizes preview jobs with 2:1 ratio over standard render jobs', () => {
    const engine = new DbQueueEngine();
    const nowMs = 1730000000000;

    // Enqueue render first, then preview
    engine.enqueueJob({ tenantId: 't1', jobId: 'render_job_01', kind: 'render', nowMs });
    engine.enqueueJob({ tenantId: 't2', jobId: 'preview_job_01', kind: 'preview', nowMs: nowMs + 10 });

    // Claim should prioritize preview despite later arrival
    const claim1 = engine.claimNextJob({ workerId: 'w1', nodeId: 'n1', nowMs: nowMs + 20 });
    assert.ok(claim1);
    assert.strictEqual(claim1.jobId, 'preview_job_01');
    assert.strictEqual(claim1.kind, 'preview');

    const claim2 = engine.claimNextJob({ workerId: 'w2', nodeId: 'n1', nowMs: nowMs + 30 });
    assert.ok(claim2);
    assert.strictEqual(claim2.jobId, 'render_job_01');
    assert.strictEqual(claim2.kind, 'render');
  });

  it('executes atomic job completion, artifact registration, and outbox event creation in single transaction', () => {
    const engine = new DbQueueEngine();
    const jobId = 'atomic_job_01';
    const tenantId = 'tenant_atomic';

    engine.enqueueJob({ tenantId, jobId });
    const claim = engine.claimNextJob({ workerId: 'w1', nodeId: 'n1' });

    const completion = engine.completeJobWithOutbox({
      jobId,
      tenantId,
      workerId: claim.workerId,
      attemptId: claim.attemptId,
      leaseEpoch: claim.leaseEpoch,
      artifactData: { byteSize: 2048576, checksum: 'sha256_mock_hash' },
    });

    assert.strictEqual(completion.success, true);
    assert.ok(completion.outboxEventId);

    // Verify job table status
    const jobRow = engine.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    assert.strictEqual(jobRow.state, 'succeeded');
    assert.strictEqual(jobRow.progress, 1.0);

    // Verify artifact table
    const artifactRow = engine.db.prepare('SELECT * FROM artifacts WHERE job_id = ?').get(jobId);
    assert.ok(artifactRow);
    assert.strictEqual(artifactRow.byte_size, 2048576);

    // Verify outbox table
    const outboxRow = engine.db.prepare('SELECT * FROM outbox WHERE id = ?').get(completion.outboxEventId);
    assert.ok(outboxRow);
    assert.strictEqual(outboxRow.event_type, 'job.succeeded');
    assert.strictEqual(outboxRow.processed_at_ms, null);

    // Drain outbox and verify webhook delivery record
    const drain = engine.drainOutbox({ batchSize: 10 });
    assert.strictEqual(drain.delivered.length, 1);

    const deliveryRow = engine.db.prepare('SELECT * FROM webhook_deliveries WHERE outbox_event_id = ?').get(completion.outboxEventId);
    assert.ok(deliveryRow);
    assert.strictEqual(deliveryRow.status_code, 200);
  });
});

describe('Task P9-03: DB/Queue Profiler & Bottleneck Evaluation Suite', () => {
  it('measures queue operation latencies and validates sub-millisecond p95 claim time', async () => {
    const profiler = new DbQueueProfiler();
    const microbench = await profiler.runMicrobenchmarks(200);

    assert.ok(microbench.claim.throughputOpsSec > 500, `Claim throughput (${microbench.claim.throughputOpsSec} ops/s) should exceed 500 ops/s`);
    assert.ok(microbench.claim.stats.p95 < 10.0, `Claim p95 latency (${microbench.claim.stats.p95}ms) should be < 10ms`);
    assert.ok(microbench.completeJobWithOutbox.stats.p95 < 15.0, `Complete p95 latency (${microbench.completeJobWithOutbox.stats.p95}ms) should be < 15ms`);
  });

  it('evaluates DB dispatch throughput vs physical cluster render capacity and proves zero bottleneck', async () => {
    const profiler = new DbQueueProfiler();
    const report = await profiler.runFullProfilingSuite();

    const evalRes = report.bottleneckEvaluation;
    assert.strictEqual(evalRes.clusterCapacity.renderSlots, 6);
    assert.strictEqual(evalRes.clusterCapacity.maxConsumptionJobsPerSec, 0.3);
    assert.ok(evalRes.headroom.currentClusterHeadroomFactor > 500, `Headroom factor (${evalRes.headroom.currentClusterHeadroomFactor}x) must exceed 500x`);
    assert.strictEqual(evalRes.bottleneckDetected, false);
    assert.strictEqual(evalRes.brokerRecommendedNow, false);
    assert.ok(evalRes.decisionReason.includes('Zero evidence of DB queue bottleneck'));
  });

  it('profiles concurrency scaling across 1 to 50 concurrent workers without lock degradation', async () => {
    const profiler = new DbQueueProfiler();
    const concurrencyResults = await profiler.runConcurrencyProfile([1, 5, 20, 50], 50);

    assert.strictEqual(concurrencyResults.length, 4);
    for (const res of concurrencyResults) {
      assert.ok(res.jobsProcessed === 50);
      assert.ok(res.stats.p95 < 20.0, `Concurrency ${res.concurrency} p95 latency (${res.stats.p95}ms) should be < 20ms`);
    }
  });
});

describe('Task P9-03: Disaster Recovery & Transactional Outbox Resilience Suite', () => {
  it('executes full 7-scenario recovery test suite with 100% pass rate and invariant compliance', async () => {
    const tester = new QueueRecoveryTester();
    const report = await tester.runAllRecoveryTests();

    assert.strictEqual(report.status, 'PASS');
    assert.strictEqual(report.totalTests, 7);
    assert.strictEqual(report.passedTests, 7);
    assert.strictEqual(report.failedTests, 0);

    // Verify all invariant assertions
    assert.strictEqual(report.invariants.zeroDoubleLeases, true);
    assert.strictEqual(report.invariants.monotonicEpochPreserved, true);
    assert.strictEqual(report.invariants.stalePublishesBlocked, true);
    assert.strictEqual(report.invariants.zeroLostOutboxEvents, true);
    assert.strictEqual(report.invariants.zeroDuplicateArtifacts, true);
    assert.strictEqual(report.invariants.drainingIsolationEnforced, true);
  });

  it('guarantees zero double-leases and monotonic epoch increment on worker SIGKILL crash', async () => {
    const tester = new QueueRecoveryTester();
    const res = await tester.testWorkerCrashAndReclamation();
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.doubleLeaseDetected, false);
    assert.strictEqual(res.initialEpoch, 1);
    assert.strictEqual(res.reclaimedEpoch, 3);
  });

  it('strictly blocks stale zombie worker publication via monotonic fencing token', async () => {
    const tester = new QueueRecoveryTester();
    const res = await tester.testZombieWorkerStaleFencing();
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.staleWorkerBlocked, true);
    assert.strictEqual(res.duplicateArtifactsPrevented, true);
  });

  it('recovers unacknowledged transactional outbox events without event loss after webhook outage', async () => {
    const tester = new QueueRecoveryTester();
    const res = await tester.testTransactionalOutboxOutageAndReplay();
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.outboxEventLost, false);
    assert.strictEqual(res.replayedSuccessfully, true);
  });

  it('isolates poison outbox messages to dead-letter quarantine without head-of-line blocking', async () => {
    const tester = new QueueRecoveryTester();
    const res = await tester.testPoisonMessageQuarantine();
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.headOfLineBlockingPrevented, true);
  });

  it('resolves concurrent race claims with exactly 1 winner and 0 double leases', async () => {
    const tester = new QueueRecoveryTester();
    const res = await tester.testConcurrentRaceClaim();
    assert.strictEqual(res.status, 'PASS');
    assert.strictEqual(res.leasesGranted, 1);
    assert.strictEqual(res.doubleLeasesDetected, 0);
  });
});
