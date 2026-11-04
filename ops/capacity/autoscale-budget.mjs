/**
 * Creativanta Video Engine - Autoscale Decision & Budget Clamping Engine
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", "Usage/cost ledger và report")
 *   - docs/DEPLOYMENT.md ("Môi trường và topology", "Environment specification")
 *   - docs/TESTING.md ("Reliability/load và CI", "Benchmark protocol và cost")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-03, P9-01)
 */

export const DEFAULT_AUTOSCALE_POLICY = Object.freeze({
  minNodes: 1,
  maxNodes: 4,
  monthlyBudgetUsd: 350.0,
  nodeVcpus: 4,
  vcpuHourlyRateUsd: 0.04,
  hoursPerMonth: 730,
  scaleUpQueueOldestSeconds: 60,
  scaleUpQueueDepthThreshold: 5,
  scaleUpSustainedEvaluationPeriods: 3,
  scaleDownCooldownSeconds: 600, // 10 minutes cooldown to prevent thrashing
  scaleDownCpuThresholdPercent: 25.0,
  maxDrainWaitSeconds: 600, // wait up to CVE_RENDER_TIMEOUT_SECONDS for in-flight jobs
});

/**
 * Calculates budget constraints and maximum permissible nodes under monthly spending cap.
 */
export function calculateAutoscaleBudget(options = {}) {
  const policy = { ...DEFAULT_AUTOSCALE_POLICY, ...options };
  const costPerHourPerNode = policy.nodeVcpus * policy.vcpuHourlyRateUsd; // 4 * $0.04 = $0.16/hr
  const costPerMonthPerNode = costPerHourPerNode * policy.hoursPerMonth; // $0.16 * 730 = $116.80/mo

  const maxNodesUnderBudget = Math.max(
    policy.minNodes,
    Math.floor(policy.monthlyBudgetUsd / costPerMonthPerNode)
  );

  const effectiveMaxNodes = Math.min(policy.maxNodes, maxNodesUnderBudget);
  const baselineMonthlyCostUsd = policy.minNodes * costPerMonthPerNode;
  const maxPossibleMonthlyCostUsd = effectiveMaxNodes * costPerMonthPerNode;
  const autoscaleBufferMonthlyUsd = maxPossibleMonthlyCostUsd - baselineMonthlyCostUsd;

  return {
    monthlyBudgetUsd: policy.monthlyBudgetUsd,
    costPerHourPerNode: Number(costPerHourPerNode.toFixed(4)),
    costPerMonthPerNode: Number(costPerMonthPerNode.toFixed(2)),
    minNodes: policy.minNodes,
    effectiveMaxNodes,
    baselineMonthlyCostUsd: Number(baselineMonthlyCostUsd.toFixed(2)),
    maxPossibleMonthlyCostUsd: Number(maxPossibleMonthlyCostUsd.toFixed(2)),
    autoscaleBufferMonthlyUsd: Number(autoscaleBufferMonthlyUsd.toFixed(2)),
    isBudgetSufficientForMinNodes: policy.monthlyBudgetUsd >= baselineMonthlyCostUsd,
  };
}

/**
 * Evaluates operational telemetry metrics against policy rules to produce an autoscale decision.
 */
export function evaluateAutoscaleDecision(metrics = {}, policyInput = {}, clusterState = {}) {
  const policy = { ...DEFAULT_AUTOSCALE_POLICY, ...policyInput };
  const budget = calculateAutoscaleBudget(policy);

  const currentNodes = clusterState.nodes ?? policy.minNodes;
  const queueOldestSeconds = Number(metrics.queueOldestSeconds || 0);
  const queueDepth = Number(metrics.queuedJobs || 0);
  const cpuPercent = Number(metrics.clusterCpuUtilizationPercent || 0);
  const activeJobs = Number(metrics.activeJobs || 0);
  const consecutiveBreaches = Number(clusterState.consecutiveScaleUpBreaches || 0);
  const secondsSinceLastScale = Number(clusterState.secondsSinceLastScale || 999999);

  let action = 'NOOP';
  let targetNodes = currentNodes;
  let reason = 'Cluster within nominal operational parameters';
  let updatedBreaches = consecutiveBreaches;

  // 1. Evaluate Scale-Up conditions
  const isOldestQueueBreached = queueOldestSeconds >= policy.scaleUpQueueOldestSeconds;
  const isQueueDepthBreached = queueDepth >= policy.scaleUpQueueDepthThreshold;

  if (isOldestQueueBreached || isQueueDepthBreached) {
    updatedBreaches += 1;
    if (updatedBreaches >= policy.scaleUpSustainedEvaluationPeriods) {
      if (currentNodes < budget.effectiveMaxNodes) {
        action = 'SCALE_UP';
        targetNodes = currentNodes + 1;
        reason = `Sustained backlog detected: queue oldest ${queueOldestSeconds}s (threshold ${policy.scaleUpQueueOldestSeconds}s) and depth ${queueDepth} for ${updatedBreaches} intervals. Scaling up to ${targetNodes} nodes.`;
      } else {
        action = 'BUDGET_CLAMPED';
        targetNodes = currentNodes;
        reason = `Scale-up desired (queue oldest ${queueOldestSeconds}s, depth ${queueDepth}), but clamped at max ${budget.effectiveMaxNodes} nodes by monthly budget of $${budget.monthlyBudgetUsd}. Reject non-priority submissions via 429.`;
      }
    } else {
      action = 'EVALUATING';
      reason = `Backlog detected (${updatedBreaches}/${policy.scaleUpSustainedEvaluationPeriods} intervals): awaiting persistence before scaling.`;
    }
  } else {
    updatedBreaches = 0;

    // 2. Evaluate Scale-Down conditions
    if (
      currentNodes > policy.minNodes &&
      queueDepth === 0 &&
      queueOldestSeconds === 0 &&
      cpuPercent < policy.scaleDownCpuThresholdPercent
    ) {
      if (secondsSinceLastScale >= policy.scaleDownCooldownSeconds) {
        action = 'SCALE_DOWN';
        targetNodes = currentNodes - 1;
        reason = `Idle queue and low CPU (${cpuPercent.toFixed(1)}% < ${policy.scaleDownCpuThresholdPercent}%) after ${secondsSinceLastScale}s cooldown. Initiating graceful drain to scale down to ${targetNodes} nodes.`;
      } else {
        action = 'COOLDOWN';
        reason = `Low load detected, but in cooldown period (${secondsSinceLastScale}s < ${policy.scaleDownCooldownSeconds}s) to prevent thrashing.`;
      }
    }
  }

  return {
    action,
    currentNodes,
    targetNodes,
    delta: targetNodes - currentNodes,
    reason,
    consecutiveBreaches: updatedBreaches,
    budgetConstraints: budget,
    evaluatedMetrics: {
      queueOldestSeconds,
      queueDepth,
      cpuPercent,
      activeJobs,
      secondsSinceLastScale,
    },
  };
}

/**
 * Manages the graceful drain lifecycle for a worker node during scale-down.
 */
export class NodeDrainManager {
  constructor(nodeId, options = {}) {
    this.nodeId = nodeId;
    this.maxDrainWaitSeconds = options.maxDrainWaitSeconds ?? DEFAULT_AUTOSCALE_POLICY.maxDrainWaitSeconds;
    this.state = 'ACTIVE'; // ACTIVE | DRAINING | DRAINED | TERMINATED
    this.drainStartedAt = null;
    this.inFlightJobs = new Set();
  }

  startDrain(activeJobIds = []) {
    if (this.state !== 'ACTIVE') {
      return this.getStatus();
    }
    this.state = 'DRAINING';
    this.drainStartedAt = Date.now();
    for (const id of activeJobIds) {
      this.inFlightJobs.add(id);
    }
    return this.getStatus();
  }

  onJobCompleted(jobId) {
    this.inFlightJobs.delete(jobId);
    if (this.state === 'DRAINING' && this.inFlightJobs.size === 0) {
      this.state = 'DRAINED';
    }
    return this.getStatus();
  }

  canClaimNextJob() {
    // Draining or terminated nodes are strictly prohibited from leasing new jobs
    return this.state === 'ACTIVE';
  }

  checkDrainTimeout(nowMs = Date.now()) {
    if (this.state !== 'DRAINING') {
      return false;
    }
    const elapsedSeconds = (nowMs - this.drainStartedAt) / 1000;
    if (elapsedSeconds > this.maxDrainWaitSeconds) {
      // Force transition to DRAINED with zombie warnings for lingering jobs
      this.state = 'DRAINED';
      return true;
    }
    return false;
  }

  terminateNode() {
    if (this.state !== 'DRAINED' && this.inFlightJobs.size > 0) {
      throw new Error(`Cannot terminate node ${this.nodeId}: in-flight jobs still active [${Array.from(this.inFlightJobs).join(', ')}]`);
    }
    this.state = 'TERMINATED';
    return this.getStatus();
  }

  getStatus() {
    return {
      nodeId: this.nodeId,
      state: this.state,
      inFlightJobCount: this.inFlightJobs.size,
      inFlightJobIds: Array.from(this.inFlightJobs),
      drainStartedAt: this.drainStartedAt ? new Date(this.drainStartedAt).toISOString() : null,
      canClaimJobs: this.canClaimNextJob(),
    };
  }
}
