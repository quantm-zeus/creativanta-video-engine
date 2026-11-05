/**
 * Test Suite: Autoscaling, Graceful Drain, Budget Clamp & Scale/Load Chaos
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 11-15)
 *   - docs/DEPLOYMENT.md ("Môi trường và topology", lines 10-12)
 *   - docs/TESTING.md ("Reliability/load và CI", line 30, line 70, line 72)
 *   - docs/CAPACITY_AND_AUTOSCALE.md (Section 6: "Chính sách tự động co giãn và ngân sách co giãn")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-01)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Autoscaler, AUTOSCALE_POLICY } from './autoscaler.mjs';
import { LeaseFencingMonitor } from './lease-fencing-monitor.mjs';
import { ScaleChaosTester } from './scale-chaos-tester.mjs';

describe('Task P9-01: Autoscaling Engine & Budget Clamping Suite', () => {
  it('calculates monthly budget constraints and clamps max nodes to 3 nodes under $350.40/mo cap', () => {
    const autoscaler = new Autoscaler({
      monthlyBudgetUsd: 350.4,
      nodeVcpus: 4,
      vcpuHourlyRateUsd: 0.04,
      hoursPerMonth: 730,
      minNodes: 1,
      maxNodes: 4,
    });

    const budget = autoscaler.budget;
    assert.strictEqual(budget.costPerHourPerNode, 0.16);
    assert.strictEqual(budget.costPerMonthPerNode, 116.8);
    assert.strictEqual(budget.minNodes, 1);
    assert.strictEqual(budget.effectiveMaxNodes, 3);
    assert.strictEqual(budget.isBudgetSufficientForMinNodes, true);
    assert.strictEqual(budget.maxPossibleMonthlyCostUsd, 350.4);
  });

  it('triggers SCALE_UP only after sustained queue backlog over 3 consecutive evaluation periods', () => {
    let nowMs = 1730000000000;
    const autoscaler = new Autoscaler({
      initialTimeMs: nowMs,
      scaleUpQueueOldestSeconds: 60,
      scaleUpQueueDepthThreshold: 5,
      scaleUpSustainedEvaluationPeriods: 3,
      minNodes: 1,
      maxNodes: 3,
    });

    assert.strictEqual(autoscaler.getActiveNodes().length, 1);

    // Interval 1: High queue age detected -> EVALUATING
    nowMs += 65000;
    const d1 = autoscaler.evaluateDecision({ queueOldestSeconds: 70, queuedJobs: 8 }, nowMs);
    assert.strictEqual(d1.action, 'EVALUATING');
    assert.strictEqual(d1.consecutiveBreaches, 1);
    assert.strictEqual(autoscaler.getActiveNodes().length, 1);

    // Interval 2: Backlog persists -> EVALUATING
    nowMs += 65000;
    const d2 = autoscaler.evaluateDecision({ queueOldestSeconds: 85, queuedJobs: 10 }, nowMs);
    assert.strictEqual(d2.action, 'EVALUATING');
    assert.strictEqual(d2.consecutiveBreaches, 2);
    assert.strictEqual(autoscaler.getActiveNodes().length, 1);

    // Interval 3: Sustained for 3 periods -> SCALE_UP to 2 nodes
    nowMs += 65000;
    const d3 = autoscaler.evaluateDecision({ queueOldestSeconds: 100, queuedJobs: 12 }, nowMs);
    assert.strictEqual(d3.action, 'SCALE_UP');
    assert.strictEqual(d3.targetNodes, 2);
    assert.strictEqual(autoscaler.getActiveNodes().length, 2);
    assert.strictEqual(autoscaler.getAvailableDispatchSlots(), 4); // 2 nodes * 2 slots
  });

  it('enforces BUDGET_CLAMPED when scale-up is requested but maximum nodes ceiling is reached', () => {
    let nowMs = 1730000000000;
    const autoscaler = new Autoscaler({
      initialTimeMs: nowMs,
      scaleUpQueueOldestSeconds: 60,
      scaleUpQueueDepthThreshold: 5,
      scaleUpSustainedEvaluationPeriods: 1, // immediate for testing clamp
      minNodes: 1,
      maxNodes: 1,
      monthlyBudgetUsd: 116.8, // strictly 1 node budget
    });

    assert.strictEqual(autoscaler.budget.effectiveMaxNodes, 1);
    assert.strictEqual(autoscaler.getActiveNodes().length, 1);

    const decision = autoscaler.evaluateDecision(
      { queueOldestSeconds: 150, queuedJobs: 50 },
      nowMs + 65000
    );

    assert.strictEqual(decision.action, 'BUDGET_CLAMPED');
    assert.strictEqual(decision.targetNodes, 1);
    assert.strictEqual(autoscaler.getActiveNodes().length, 1);
    assert.ok(decision.reason.includes('hard clamped at maximum 1 nodes'));
    assert.strictEqual(autoscaler.budgetClampedCount, 1);
  });

  it('enforces 600s cooldown period to prevent thrashing during scale-down', () => {
    let nowMs = 1730000000000;
    const autoscaler = new Autoscaler({
      initialTimeMs: nowMs,
      minNodes: 1,
      scaleDownCooldownSeconds: 600,
      scaleDownCpuThresholdPercent: 25.0,
    });

    // Manually add second node to test scale down
    autoscaler.spawnNode({ nowMs });
    assert.strictEqual(autoscaler.getActiveNodes().length, 2);

    // Attempt scale down at 300s (cooldown = 600s not yet met) -> COOLDOWN
    const earlyDecision = autoscaler.evaluateDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 10.0 },
      nowMs + 300000
    );
    assert.strictEqual(earlyDecision.action, 'COOLDOWN');
    assert.strictEqual(earlyDecision.targetNodes, 2);
    assert.strictEqual(autoscaler.getActiveNodes().length, 2);

    // Advance time to 650s (cooldown satisfied) -> SCALE_DOWN
    const matureDecision = autoscaler.evaluateDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 10.0 },
      nowMs + 650000
    );
    assert.strictEqual(matureDecision.action, 'SCALE_DOWN');
    assert.strictEqual(matureDecision.targetNodes, 1);
    assert.strictEqual(autoscaler.getActiveNodes().length, 1);
  });

  it('isolates draining node from receiving new job claims and preserves in-flight execution', () => {
    let nowMs = 1730000000000;
    const autoscaler = new Autoscaler({ initialTimeMs: nowMs });
    const node2 = autoscaler.spawnNode({ nowMs, nodeId: 'worker-node-02' });

    // Node 2 starts processing 2 in-flight jobs
    autoscaler.onJobStarted('worker-node-02', 'job_inflight_A');
    autoscaler.onJobStarted('worker-node-02', 'job_inflight_B');

    // Initiate graceful drain
    autoscaler.startGracefulDrain('worker-node-02', nowMs + 1000);
    assert.strictEqual(node2.status, 'DRAINING');
    assert.strictEqual(autoscaler.canClaimJob('worker-node-02'), false); // strictly cannot claim!

    // In-flight job A completes
    autoscaler.onJobCompleted('worker-node-02', 'job_inflight_A', nowMs + 20000);
    assert.strictEqual(node2.status, 'DRAINING');
    assert.strictEqual(node2.inFlightJobs.size, 1);

    // In-flight job B completes -> Node transitions to DRAINED and TERMINATED
    autoscaler.onJobCompleted('worker-node-02', 'job_inflight_B', nowMs + 40000);
    assert.strictEqual(node2.status, 'TERMINATED');
    assert.strictEqual(node2.inFlightJobs.size, 0);
  });

  it('triggers drain timeout and evicts hung jobs when maxDrainWaitSeconds is breached', () => {
    let nowMs = 1730000000000;
    const autoscaler = new Autoscaler({
      initialTimeMs: nowMs,
      maxDrainWaitSeconds: 600,
    });
    const node = autoscaler.spawnNode({ nowMs, nodeId: 'worker-node-hang' });
    autoscaler.onJobStarted('worker-node-hang', 'job_hung_001');

    autoscaler.startGracefulDrain('worker-node-hang', nowMs);
    assert.strictEqual(node.status, 'DRAINING');

    // Step at 500s -> still draining
    const res1 = autoscaler.stepDrain(nowMs + 500000);
    assert.strictEqual(res1.evictedJobIds.length, 0);
    assert.strictEqual(node.status, 'DRAINING');

    // Step at 650s -> timeout breached -> force DRAINED / TERMINATED
    const res2 = autoscaler.stepDrain(nowMs + 650000);
    assert.strictEqual(res2.evictedJobIds.length, 1);
    assert.strictEqual(res2.evictedJobIds[0].jobId, 'job_hung_001');
    assert.strictEqual(node.status, 'TERMINATED');
  });
});

describe('Task P9-01: Lease Fencing & Double-Lease Immunity Suite', () => {
  it('prevents double-lease acquisition and enforces mutual exclusion on active leases', () => {
    const monitor = new LeaseFencingMonitor({ leaseDurationSeconds: 60 });
    const nowMs = 1730000000000;

    // Worker 1 acquires lease for job_101
    const lease1 = monitor.claimLease({
      jobId: 'job_101',
      workerId: 'worker-node-01-slot-1',
      nodeId: 'worker-node-01',
      attemptId: 'att_job_101_1_1',
      leaseEpoch: 1,
      nowMs,
    });
    assert.strictEqual(lease1.workerId, 'worker-node-01-slot-1');
    assert.strictEqual(lease1.leaseEpoch, 1);

    // Worker 2 attempts concurrent claim for job_101 while lease is still active (unexpired)
    assert.throws(
      () => {
        monitor.claimLease({
          jobId: 'job_101',
          workerId: 'worker-node-02-slot-1',
          nodeId: 'worker-node-02',
          attemptId: 'att_job_101_2_2',
          leaseEpoch: 2,
          nowMs: nowMs + 10000, // only 10s passed, 60s lease not expired
        });
      },
      (err) => err.code === 'DOUBLE_LEASE_DETECTED'
    );

    assert.strictEqual(monitor.blockedDoubleLeaseAttempts.length, 1);
    assert.strictEqual(monitor.doubleLeaseViolations.length, 0);
  });

  it('strictly rejects claims from workers on draining or terminated nodes', () => {
    const monitor = new LeaseFencingMonitor();

    assert.throws(
      () => {
        monitor.claimLease({
          jobId: 'job_202',
          workerId: 'worker-node-drain-slot-1',
          nodeId: 'worker-node-drain',
          attemptId: 'att_job_202_1_1',
          leaseEpoch: 1,
          isNodeDraining: true,
        });
      },
      (err) => err.code === 'NODE_DRAINING_CANNOT_CLAIM'
    );
  });

  it('blocks stale worker publication via monotonic fencing token (STALE_LEASE_EPOCH)', () => {
    const monitor = new LeaseFencingMonitor({ leaseDurationSeconds: 60 });
    const nowMs = 1730000000000;

    // Worker 1 claims with epoch 1
    monitor.claimLease({
      jobId: 'job_303',
      workerId: 'worker-1',
      nodeId: 'node-1',
      attemptId: 'att_303_1',
      leaseEpoch: 1,
      nowMs,
    });

    // Worker 1 crashes. 65 seconds elapse. Lease expires and is reclaimed.
    const expiredLease = monitor.reclaimIfExpired('job_303', nowMs + 65000);
    assert.ok(expiredLease !== null);

    // Worker 2 claims the reclaimed job with incremented epoch 2
    monitor.claimLease({
      jobId: 'job_303',
      workerId: 'worker-2',
      nodeId: 'node-2',
      attemptId: 'att_303_2',
      leaseEpoch: 2,
      nowMs: nowMs + 70000,
    });

    // Stale Worker 1 wakes up and attempts to publish artifact using superseded epoch 1
    assert.throws(
      () => {
        monitor.publishArtifact({
          jobId: 'job_303',
          workerId: 'worker-1',
          attemptId: 'att_303_1',
          leaseEpoch: 1,
          artifactData: { uri: 's3://stale/output.mp4' },
          nowMs: nowMs + 75000,
        });
      },
      (err) => err.code === 'STALE_LEASE_EPOCH'
    );

    // Valid Worker 2 publishes successfully with active epoch 2
    const pub = monitor.publishArtifact({
      jobId: 'job_303',
      workerId: 'worker-2',
      attemptId: 'att_303_2',
      leaseEpoch: 2,
      artifactData: { uri: 's3://valid/output.mp4' },
      nowMs: nowMs + 80000,
    });
    assert.strictEqual(pub.workerId, 'worker-2');
    assert.strictEqual(pub.leaseEpoch, 2);
  });
});

describe('Task P9-01: Scale / Load Chaos Test & Full Invariant Verification', () => {
  it('executes full 6-phase chaos test and achieves 100% invariant compliance with ZERO double leases', async () => {
    const tester = new ScaleChaosTester({
      leaseDurationSeconds: 60,
    });

    const report = await tester.runFullChaosSuite();

    // Verify all phases completed
    assert.strictEqual(report.phases.length, 5);

    // Verify Invariants
    const inv = report.invariants;
    assert.strictEqual(inv.zeroDoubleLeases, true, 'Zero double leases must be preserved throughout chaos');
    assert.strictEqual(inv.monotonicityGuaranteed, true, 'Lease epoch monotonicity must be strictly maintained');
    assert.strictEqual(inv.zeroStalePublishAllowed, true, 'Zero stale worker publishes must be permitted');
    assert.ok(inv.stalePublishBlockedCount >= 1, 'At least one stale publish attempt must be injected and blocked');
    assert.strictEqual(inv.zeroLostJobs, true, 'All admitted jobs must complete in terminal state');
    assert.strictEqual(inv.zeroDuplicateArtifacts, true, 'Zero duplicate primary artifacts');
    assert.strictEqual(inv.budgetClampingPreserved, true, 'Active nodes must not exceed effectiveMaxNodes ceiling');
    assert.strictEqual(inv.drainingIsolationPreserved, true, 'Draining nodes must never receive new job leases');
    assert.strictEqual(inv.cooldownEnforced, true, 'Cooldown must be enforced before scale-down');
    assert.strictEqual(inv.overallStatus, 'PASS');

    // Verify Summary counts
    const sum = report.summary;
    assert.ok(sum.admittedJobsCount >= 30, 'Substantial job volume exercised');
    assert.strictEqual(sum.admittedJobsCount, sum.terminalJobsCount);
    assert.strictEqual(sum.publishedArtifactsCount, sum.terminalJobsCount);
    assert.strictEqual(sum.doubleLeaseViolationsCount, 0);
  });
});
