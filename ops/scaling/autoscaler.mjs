/**
 * Creativanta Video Engine - Dynamic Autoscaler & Worker Pool Controller
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", "Usage/cost ledger và report")
 *   - docs/DEPLOYMENT.md ("Môi trường và topology", "Environment specification")
 *   - docs/TESTING.md ("Reliability/load và CI", "Benchmark protocol và cost")
 *   - docs/CAPACITY_AND_AUTOSCALE.md ("Chính sách tự động co giãn và ngân sách co giãn (Autoscale Budget)")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-01: "Autoscaling implementation nếu queue metrics đòi hỏi, cooldown/drain/budget clamp; scale/load chaos test không double leases")
 */

import {
  DEFAULT_AUTOSCALE_POLICY as BASE_POLICY,
  calculateAutoscaleBudget,
} from '../capacity/autoscale-budget.mjs';

export const AUTOSCALE_POLICY = Object.freeze({
  ...BASE_POLICY,
  monthlyBudgetUsd: 350.4, // Supports up to 3 nodes ($116.80/mo * 3 = $350.40) per CAPACITY_AND_AUTOSCALE.md line 142
  slotsPerNode: 2, // 2 render slots per standard 4 vCPU reference host
  scaleUpQueueOldestSeconds: 60,
  scaleUpQueueDepthThreshold: 5,
  scaleUpSustainedEvaluationPeriods: 3,
  scaleDownCooldownSeconds: 600, // 10 minutes cooldown to prevent thrashing
  scaleDownCpuThresholdPercent: 25.0,
  maxDrainWaitSeconds: 600, // 10 minutes matching CVE_RENDER_TIMEOUT_SECONDS
});

export class Autoscaler {
  constructor(options = {}) {
    this.policy = { ...AUTOSCALE_POLICY, ...options };
    this.budget = calculateAutoscaleBudget(this.policy);

    // Node registry: Map<nodeId, NodeRecord>
    this.nodes = new Map();
    this.nodeCounter = 0;

    // Scaling state
    this.lastScaleEventMs = options.initialTimeMs ?? Date.now();
    this.consecutiveScaleUpBreaches = 0;
    this.budgetClampedCount = 0;
    this.cooldownSuppressedCount = 0;
    this.scaleUpCount = 0;
    this.scaleDownCount = 0;
    this.decisionHistory = [];

    // Initialize baseline minimum nodes
    for (let i = 0; i < this.policy.minNodes; i++) {
      this.spawnNode({ nowMs: this.lastScaleEventMs });
    }
  }

  /**
   * Spawns and registers a new worker node in ACTIVE state.
   */
  spawnNode(options = {}) {
    this.nodeCounter += 1;
    const nodeId = options.nodeId ?? `worker-node-${String(this.nodeCounter).padStart(2, '0')}`;
    const nowMs = options.nowMs ?? Date.now();

    const nodeRecord = {
      id: nodeId,
      status: 'ACTIVE', // ACTIVE | DRAINING | DRAINED | TERMINATED
      slots: this.policy.slotsPerNode,
      createdAtMs: nowMs,
      drainingStartedAtMs: null,
      terminatedAtMs: null,
      inFlightJobs: new Set(),
      workerIds: [
        `${nodeId}-slot-1`,
        `${nodeId}-slot-2`,
      ],
    };

    this.nodes.set(nodeId, nodeRecord);
    return nodeRecord;
  }

  /**
   * Returns active nodes capable of receiving new claims.
   */
  getActiveNodes() {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'ACTIVE');
  }

  /**
   * Returns nodes currently undergoing graceful drain.
   */
  getDrainingNodes() {
    return Array.from(this.nodes.values()).filter((n) => n.status === 'DRAINING');
  }

  /**
   * Total permissible worker slots currently usable for new dispatches.
   */
  getAvailableDispatchSlots() {
    const activeNodes = this.getActiveNodes();
    let totalSlots = 0;
    for (const node of activeNodes) {
      totalSlots += Math.max(0, node.slots - node.inFlightJobs.size);
    }
    return totalSlots;
  }

  /**
   * Checks whether a worker residing on a node is permitted to claim a new job.
   * Strict invariant: Draining or terminated nodes are prohibited from acquiring new jobs.
   */
  canClaimJob(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    return node.status === 'ACTIVE' && node.inFlightJobs.size < node.slots;
  }

  /**
   * Records that a worker on a given node has commenced execution of a job attempt.
   */
  onJobStarted(nodeId, jobId) {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} not registered in autoscaler`);
    }
    if (node.status !== 'ACTIVE' && node.status !== 'DRAINING') {
      throw new Error(`Cannot start job ${jobId} on node ${nodeId} with status ${node.status}`);
    }
    node.inFlightJobs.add(jobId);
  }

  /**
   * Records that a job attempt completed (succeeded, failed, canceled).
   * If the node is DRAINING and all in-flight jobs have finished, transitions to DRAINED and TERMINATED.
   */
  onJobCompleted(nodeId, jobId, nowMs = Date.now()) {
    const node = this.nodes.get(nodeId);
    if (!node) return { status: 'NOT_FOUND' };

    node.inFlightJobs.delete(jobId);

    if (node.status === 'DRAINING' && node.inFlightJobs.size === 0) {
      node.status = 'DRAINED';
      node.terminatedAtMs = nowMs;
      node.status = 'TERMINATED';
    }

    return {
      nodeId,
      status: node.status,
      inFlightJobCount: node.inFlightJobs.size,
    };
  }

  /**
   * Initiates graceful drain on a target active node.
   */
  startGracefulDrain(nodeId, nowMs = Date.now()) {
    const node = this.nodes.get(nodeId);
    if (!node || node.status !== 'ACTIVE') {
      return null;
    }

    node.status = 'DRAINING';
    node.drainingStartedAtMs = nowMs;

    // If node already had 0 in-flight jobs, immediately transition to DRAINED/TERMINATED
    if (node.inFlightJobs.size === 0) {
      node.status = 'DRAINED';
      node.terminatedAtMs = nowMs;
      node.status = 'TERMINATED';
    }

    return node;
  }

  /**
   * Evaluates operational metrics and determines the appropriate autoscale action.
   */
  evaluateDecision(metrics = {}, nowMs = Date.now()) {
    const queueOldestSeconds = Number(metrics.queueOldestSeconds || 0);
    const queueDepth = Number(metrics.queuedJobs || 0);
    const cpuPercent = Number(metrics.clusterCpuUtilizationPercent || 0);
    const activeJobs = Number(metrics.activeJobs || 0);

    const activeNodes = this.getActiveNodes();
    const currentActiveCount = activeNodes.length;
    const effectiveMaxNodes = this.budget.effectiveMaxNodes;

    const secondsSinceLastScale = (nowMs - this.lastScaleEventMs) / 1000;

    let action = 'NOOP';
    let targetNodes = currentActiveCount;
    let reason = 'Cluster within nominal capacity bounds';
    let spawnedNode = null;
    let drainedNode = null;

    // 1. Evaluate Scale-Up conditions
    const isOldestQueueBreached = queueOldestSeconds >= this.policy.scaleUpQueueOldestSeconds;
    const isQueueDepthBreached = queueDepth >= this.policy.scaleUpQueueDepthThreshold;

    if (isOldestQueueBreached || isQueueDepthBreached) {
      this.consecutiveScaleUpBreaches += 1;

      if (this.consecutiveScaleUpBreaches >= this.policy.scaleUpSustainedEvaluationPeriods) {
        if (currentActiveCount < effectiveMaxNodes) {
          action = 'SCALE_UP';
          targetNodes = currentActiveCount + 1;
          spawnedNode = this.spawnNode({ nowMs });
          this.lastScaleEventMs = nowMs;
          this.scaleUpCount += 1;
          reason = `Sustained backlog: queue oldest ${queueOldestSeconds}s (>=${this.policy.scaleUpQueueOldestSeconds}s) and depth ${queueDepth} (>=${this.policy.scaleUpQueueDepthThreshold}) for ${this.consecutiveScaleUpBreaches} intervals. Scaled up to ${targetNodes} nodes (${spawnedNode.id}).`;
        } else {
          action = 'BUDGET_CLAMPED';
          targetNodes = currentActiveCount;
          this.budgetClampedCount += 1;
          reason = `Scale-up demanded (queue oldest ${queueOldestSeconds}s, depth ${queueDepth}), but hard clamped at maximum ${effectiveMaxNodes} nodes by monthly budget of $${this.policy.monthlyBudgetUsd}. Shed excess submissions via HTTP 429.`;
        }
      } else {
        action = 'EVALUATING';
        reason = `Backlog detected (${this.consecutiveScaleUpBreaches}/${this.policy.scaleUpSustainedEvaluationPeriods} intervals): awaiting persistence window before scaling.`;
      }
    } else {
      this.consecutiveScaleUpBreaches = 0;

      // 2. Evaluate Scale-Down conditions
      if (
        currentActiveCount > this.policy.minNodes &&
        queueDepth === 0 &&
        queueOldestSeconds === 0 &&
        cpuPercent < this.policy.scaleDownCpuThresholdPercent
      ) {
        if (secondsSinceLastScale >= this.policy.scaleDownCooldownSeconds) {
          action = 'SCALE_DOWN';
          targetNodes = currentActiveCount - 1;

          // Select node with fewest in-flight jobs to drain
          const candidate = [...activeNodes].sort((a, b) => a.inFlightJobs.size - b.inFlightJobs.size)[0];
          drainedNode = this.startGracefulDrain(candidate.id, nowMs);
          this.lastScaleEventMs = nowMs;
          this.scaleDownCount += 1;
          reason = `Queue idle and CPU ${cpuPercent.toFixed(1)}% < ${this.policy.scaleDownCpuThresholdPercent}% after ${secondsSinceLastScale.toFixed(0)}s cooldown. Initiated graceful drain on ${candidate.id}.`;
        } else {
          action = 'COOLDOWN';
          this.cooldownSuppressedCount += 1;
          reason = `Idle queue detected, but scaling suppressed by cooldown (${secondsSinceLastScale.toFixed(0)}s < ${this.policy.scaleDownCooldownSeconds}s) to prevent thrashing.`;
        }
      }
    }

    const decisionRecord = {
      timestampMs: nowMs,
      action,
      currentNodes: currentActiveCount,
      targetNodes,
      delta: targetNodes - currentActiveCount,
      reason,
      consecutiveBreaches: this.consecutiveScaleUpBreaches,
      secondsSinceLastScale: Math.round(secondsSinceLastScale),
      spawnedNodeId: spawnedNode?.id ?? null,
      drainedNodeId: drainedNode?.id ?? null,
      metrics: {
        queueOldestSeconds,
        queueDepth,
        cpuPercent,
        activeJobs,
      },
    };

    this.decisionHistory.push(decisionRecord);
    return decisionRecord;
  }

  /**
   * Periodic maintenance step for draining nodes:
   * Checks for drain timeout and evicts lingering in-flight jobs with fencing warnings.
   */
  stepDrain(nowMs = Date.now()) {
    const drainingNodes = this.getDrainingNodes();
    const evictedJobIds = [];

    for (const node of drainingNodes) {
      if (node.inFlightJobs.size === 0) {
        node.status = 'DRAINED';
        node.terminatedAtMs = nowMs;
        node.status = 'TERMINATED';
        continue;
      }

      const elapsedDrainSeconds = (nowMs - node.drainingStartedAtMs) / 1000;
      if (elapsedDrainSeconds >= this.policy.maxDrainWaitSeconds) {
        // Drain timeout exceeded! Force transition to DRAINED/TERMINATED and evict jobs for fencing
        for (const jobId of node.inFlightJobs) {
          evictedJobIds.push({
            nodeId: node.id,
            jobId,
            elapsedSeconds: elapsedDrainSeconds,
          });
        }
        node.inFlightJobs.clear();
        node.status = 'DRAINED';
        node.terminatedAtMs = nowMs;
        node.status = 'TERMINATED';
      }
    }

    return {
      drainingNodesCount: this.getDrainingNodes().length,
      evictedJobIds,
    };
  }

  /**
   * Returns Prometheus-compatible telemetry metric values.
   */
  getTelemetryMetrics() {
    const activeNodes = this.getActiveNodes();
    const drainingNodes = this.getDrainingNodes();
    let totalSlots = 0;
    let inUseSlots = 0;

    for (const n of activeNodes) {
      totalSlots += n.slots;
      inUseSlots += n.inFlightJobs.size;
    }

    return {
      cve_cluster_nodes_active: activeNodes.length,
      cve_cluster_nodes_draining: drainingNodes.length,
      cve_cluster_slots_total: totalSlots,
      cve_cluster_slots_in_use: inUseSlots,
      cve_autoscale_scale_up_total: this.scaleUpCount,
      cve_autoscale_scale_down_total: this.scaleDownCount,
      cve_autoscale_budget_clamped_total: this.budgetClampedCount,
      cve_autoscale_cooldown_suppressed_total: this.cooldownSuppressedCount,
    };
  }

  getStatus() {
    return {
      policy: this.policy,
      budgetConstraints: this.budget,
      activeNodes: this.getActiveNodes().map((n) => ({
        id: n.id,
        status: n.status,
        inFlightJobs: Array.from(n.inFlightJobs),
      })),
      drainingNodes: this.getDrainingNodes().map((n) => ({
        id: n.id,
        status: n.status,
        inFlightJobs: Array.from(n.inFlightJobs),
        drainingStartedAt: new Date(n.drainingStartedAtMs).toISOString(),
      })),
      metrics: this.getTelemetryMetrics(),
    };
  }
}
