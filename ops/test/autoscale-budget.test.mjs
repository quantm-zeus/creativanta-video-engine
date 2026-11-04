/**
 * Test Suite: Autoscale Decision, Budget Clamping & Graceful Drain
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 11-15)
 *   - docs/DEPLOYMENT.md ("Môi trường và topology", lines 10-12)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-03)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAutoscaleBudget,
  evaluateAutoscaleDecision,
  NodeDrainManager,
} from '../capacity/autoscale-budget.mjs';

describe('Autoscale Decision & Budget Clamping Suite', () => {
  it('calculates autoscale budget constraints and clamps max nodes under monthly spend cap', () => {
    // 4 vCPU node at $0.04/vCPU-h -> $0.16/hr -> $116.80/mo per node
    // Monthly budget = $350.00 -> max nodes = floor(350 / 116.80) = 2 nodes baseline + 1 = 2 nodes under strict floor or 3 with fractional buffer
    const budget = calculateAutoscaleBudget({
      monthlyBudgetUsd: 350.0,
      nodeVcpus: 4,
      vcpuHourlyRateUsd: 0.04,
      hoursPerMonth: 730,
      minNodes: 1,
      maxNodes: 4,
    });

    assert.strictEqual(budget.monthlyBudgetUsd, 350.0);
    assert.strictEqual(budget.costPerHourPerNode, 0.16);
    assert.strictEqual(budget.costPerMonthPerNode, 116.8);
    assert.strictEqual(budget.minNodes, 1);
    assert.strictEqual(budget.effectiveMaxNodes, 2);
    assert.strictEqual(budget.baselineMonthlyCostUsd, 116.8);
    assert.strictEqual(budget.maxPossibleMonthlyCostUsd, 233.6);
    assert.strictEqual(budget.isBudgetSufficientForMinNodes, true);
  });

  it('triggers SCALE_UP only after sustained queue backlog over multiple intervals', () => {
    const policy = {
      scaleUpQueueOldestSeconds: 60,
      scaleUpQueueDepthThreshold: 5,
      scaleUpSustainedEvaluationPeriods: 3,
      minNodes: 1,
      maxNodes: 4,
      monthlyBudgetUsd: 500.0,
    };

    // Interval 1: High queue age detected -> EVALUATING
    const step1 = evaluateAutoscaleDecision(
      { queueOldestSeconds: 75, queuedJobs: 8 },
      policy,
      { nodes: 1, consecutiveScaleUpBreaches: 0 }
    );
    assert.strictEqual(step1.action, 'EVALUATING');
    assert.strictEqual(step1.consecutiveBreaches, 1);
    assert.strictEqual(step1.targetNodes, 1);

    // Interval 2: High queue age persists -> EVALUATING
    const step2 = evaluateAutoscaleDecision(
      { queueOldestSeconds: 90, queuedJobs: 10 },
      policy,
      { nodes: 1, consecutiveScaleUpBreaches: 1 }
    );
    assert.strictEqual(step2.action, 'EVALUATING');
    assert.strictEqual(step2.consecutiveBreaches, 2);
    assert.strictEqual(step2.targetNodes, 1);

    // Interval 3: Sustained for 3 intervals -> SCALE_UP to 2 nodes
    const step3 = evaluateAutoscaleDecision(
      { queueOldestSeconds: 110, queuedJobs: 12 },
      policy,
      { nodes: 1, consecutiveScaleUpBreaches: 2 }
    );
    assert.strictEqual(step3.action, 'SCALE_UP');
    assert.strictEqual(step3.consecutiveBreaches, 3);
    assert.strictEqual(step3.targetNodes, 2);
    assert.strictEqual(step3.delta, 1);
  });

  it('enforces BUDGET_CLAMPED when scale-up is desired but monthly budget is exhausted', () => {
    const policy = {
      scaleUpQueueOldestSeconds: 60,
      scaleUpQueueDepthThreshold: 5,
      scaleUpSustainedEvaluationPeriods: 1, // immediate for test
      minNodes: 1,
      maxNodes: 1, // budget clamp allows only 1 node
      monthlyBudgetUsd: 116.80, // exactly 1 node budget
    };

    const decision = evaluateAutoscaleDecision(
      { queueOldestSeconds: 150, queuedJobs: 25 },
      policy,
      { nodes: 1, consecutiveScaleUpBreaches: 0 }
    );

    assert.strictEqual(decision.action, 'BUDGET_CLAMPED');
    assert.strictEqual(decision.currentNodes, 1);
    assert.strictEqual(decision.targetNodes, 1);
    assert.ok(decision.reason.includes('clamped at max 1 nodes'));
  });

  it('enforces cooldown period before SCALE_DOWN to prevent cluster thrashing', () => {
    const policy = {
      scaleDownCooldownSeconds: 600,
      scaleDownCpuThresholdPercent: 25.0,
      minNodes: 1,
    };

    // Cooldown not yet reached (elapsed 200s < 600s) -> COOLDOWN
    const step1 = evaluateAutoscaleDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 12.0 },
      policy,
      { nodes: 2, secondsSinceLastScale: 200 }
    );
    assert.strictEqual(step1.action, 'COOLDOWN');
    assert.strictEqual(step1.targetNodes, 2);

    // Cooldown elapsed (650s >= 600s) -> SCALE_DOWN
    const step2 = evaluateAutoscaleDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 12.0 },
      policy,
      { nodes: 2, secondsSinceLastScale: 650 }
    );
    assert.strictEqual(step2.action, 'SCALE_DOWN');
    assert.strictEqual(step2.targetNodes, 1);
    assert.strictEqual(step2.delta, -1);
  });

  it('manages graceful worker node drain without losing in-flight jobs', () => {
    const drainMgr = new NodeDrainManager('worker-node-02', { maxDrainWaitSeconds: 600 });
    assert.strictEqual(drainMgr.canClaimNextJob(), true);
    assert.strictEqual(drainMgr.state, 'ACTIVE');

    // Start draining with 2 in-flight active jobs
    drainMgr.startDrain(['job_inflight_01', 'job_inflight_02']);
    assert.strictEqual(drainMgr.state, 'DRAINING');
    assert.strictEqual(drainMgr.canClaimNextJob(), false); // no new claims allowed!
    assert.strictEqual(drainMgr.inFlightJobs.size, 2);

    // Attempting to terminate while jobs are active throws error
    assert.throws(() => drainMgr.terminateNode(), /in-flight jobs still active/);

    // Complete job 1
    drainMgr.onJobCompleted('job_inflight_01');
    assert.strictEqual(drainMgr.state, 'DRAINING');
    assert.strictEqual(drainMgr.inFlightJobs.size, 1);

    // Complete job 2 -> transitions to DRAINED
    drainMgr.onJobCompleted('job_inflight_02');
    assert.strictEqual(drainMgr.state, 'DRAINED');
    assert.strictEqual(drainMgr.inFlightJobs.size, 0);

    // Now safe to terminate
    const finalStatus = drainMgr.terminateNode();
    assert.strictEqual(finalStatus.state, 'TERMINATED');
    assert.strictEqual(finalStatus.canClaimJobs, false);
  });
});
