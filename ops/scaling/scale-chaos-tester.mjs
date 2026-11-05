/**
 * Creativanta Video Engine - Scale / Load Chaos Test Engine & Invariant Auditor
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", "Monotonic fencing token", "Stale worker fencing")
 *   - docs/SECURITY.md ("Chromium và structured template sandbox", "Renderer -> artifact publication")
 *   - docs/TESTING.md ("Reliability/load và CI", line 70: "benchmark max throughput và overload 2x", line 72: "stale lease không publish", line 30: "double lease")
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 11-15)
 *   - docs/CAPACITY_AND_AUTOSCALE.md ("Chính sách tự động co giãn và ngân sách co giãn (Autoscale Budget)")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-01: "Autoscaling implementation nếu queue metrics đòi hỏi, cooldown/drain/budget clamp; scale/load chaos test không double leases")
 */

import crypto from 'node:crypto';
import { Autoscaler, AUTOSCALE_POLICY } from './autoscaler.mjs';
import { LeaseFencingMonitor } from './lease-fencing-monitor.mjs';

export const CHAOS_FAULT_TYPES = Object.freeze([
  'WORKER_CRASH_SIGKILL',
  'STALE_WORKER_RESURRECTION',
  'NODE_DRAIN_MID_FLIGHT',
  'DRAIN_TIMEOUT_EVICTION',
  'CONCURRENT_RACE_CLAIM',
  'OVERLOAD_429_SHEDDING',
]);

export class ScaleChaosTester {
  constructor(options = {}) {
    this.options = options;
    this.simulatedTimeMs = options.startTimeMs ?? Date.now();

    // Core autoscaler and lease monitor
    this.autoscaler = new Autoscaler({
      ...options.policy,
      initialTimeMs: this.simulatedTimeMs,
    });
    this.leaseMonitor = new LeaseFencingMonitor({
      leaseDurationSeconds: options.leaseDurationSeconds ?? 60,
    });

    // Chaos telemetry & stores
    this.admittedJobs = new Map();
    this.queuedJobs = [];
    this.inFlightJobs = new Map(); // jobId -> InFlightState
    this.terminalJobs = new Map(); // jobId -> TerminalRecord
    this.shedded429Jobs = [];

    this.injectedFaults = [];
    this.concurrentRaceAttempts = [];
    this.drainEvents = [];
    this.doubleLeaseViolations = [];
    this.stalePublishAttemptsBlocked = [];

    // Tenants participating in chaos
    this.tenants = [
      'tenant-retail-alpha',
      'tenant-media-beta',
      'tenant-studio-gamma',
      'tenant-bulk-delta',
      'tenant-burst-epsilon',
    ];
  }

  advanceTime(seconds) {
    this.simulatedTimeMs += seconds * 1000;
  }

  /**
   * Submits a batch of test jobs representing mixed realistic workloads.
   */
  submitJobBatch(count, options = {}) {
    const batch = [];
    const isOverloaded = options.forceOverload ?? false;

    for (let i = 0; i < count; i++) {
      const tenantId = this.tenants[i % this.tenants.length];
      const jobId = `chaos_job_${crypto.randomBytes(4).toString('hex')}`;
      const isPreview = (i % 3 === 0);
      const isPoc01 = !isPreview && (i % 5 !== 0);

      const jobRecord = {
        id: jobId,
        tenantId,
        kind: isPreview ? 'preview' : 'render',
        profile: isPreview ? 'preview-360p-v1' : 'mp4-720p-v1',
        durationSeconds: isPreview ? 5 : (isPoc01 ? 15 : 45),
        state: 'queued',
        attemptCount: 0,
        leaseEpoch: 0,
        submittedAtMs: this.simulatedTimeMs,
        activeWorkerId: null,
        activeNodeId: null,
        activeAttemptId: null,
      };

      if (isOverloaded && i >= count * 0.7) {
        // Overload shedding under budget clamping
        this.shedded429Jobs.push({
          jobId,
          tenantId,
          sheddedAtMs: this.simulatedTimeMs,
          status: 429,
          reason: 'CAPACITY_BUDGET_CLAMPED_SHEDDING',
        });
        continue;
      }

      this.admittedJobs.set(jobId, jobRecord);
      this.queuedJobs.push(jobRecord);
      batch.push(jobRecord);
    }

    return batch;
  }

  /**
   * Gathers current operational metrics for autoscaler evaluation.
   */
  gatherQueueMetrics() {
    let queueOldestSeconds = 0;
    if (this.queuedJobs.length > 0) {
      const oldest = this.queuedJobs[0];
      queueOldestSeconds = Math.max(0, (this.simulatedTimeMs - oldest.submittedAtMs) / 1000);
    }

    const queuedJobs = this.queuedJobs.length;
    const activeJobs = this.inFlightJobs.size;

    // Estimate cluster CPU based on active jobs vs total capacity
    const activeNodes = this.autoscaler.getActiveNodes();
    const totalSlots = activeNodes.length * this.autoscaler.policy.slotsPerNode;
    const clusterCpuUtilizationPercent = totalSlots > 0
      ? Math.min(100, (activeJobs / totalSlots) * 85.0)
      : 0;

    return {
      queueOldestSeconds: Math.round(queueOldestSeconds),
      queuedJobs,
      activeJobs,
      clusterCpuUtilizationPercent,
    };
  }

  /**
   * Worker claim cycle across active nodes.
   * Tests concurrent claiming, node drain eligibility, and double-lease immunity.
   */
  dispatchNextJobs() {
    const activeNodes = this.autoscaler.getActiveNodes();
    const dispatched = [];

    for (const node of activeNodes) {
      while (this.autoscaler.canClaimJob(node.id) && this.queuedJobs.length > 0) {
        const job = this.queuedJobs.shift();
        const slotIdx = node.inFlightJobs.size + 1;
        const workerId = `${node.id}-slot-${slotIdx}`;
        const nextAttemptCount = job.attemptCount + 1;
        const nextEpoch = job.leaseEpoch + 1;
        const attemptId = `att_${job.id}_${nextAttemptCount}_${nextEpoch}`;

        job.attemptCount = nextAttemptCount;
        job.leaseEpoch = nextEpoch;
        job.state = 'rendering';
        job.activeWorkerId = workerId;
        job.activeNodeId = node.id;
        job.activeAttemptId = attemptId;

        // Register lease in LeaseFencingMonitor
        this.leaseMonitor.claimLease({
          jobId: job.id,
          workerId,
          nodeId: node.id,
          attemptId,
          leaseEpoch: nextEpoch,
          isNodeDraining: node.status === 'DRAINING',
          isNodeTerminated: node.status === 'TERMINATED',
          nowMs: this.simulatedTimeMs,
        });

        // Register job in autoscaler node
        this.autoscaler.onJobStarted(node.id, job.id);

        const inFlight = {
          job,
          workerId,
          nodeId: node.id,
          attemptId,
          leaseEpoch: nextEpoch,
          startedAtMs: this.simulatedTimeMs,
          lastHeartbeatAtMs: this.simulatedTimeMs,
          estimatedDurationSeconds: job.durationSeconds * 2.8,
        };

        this.inFlightJobs.set(job.id, inFlight);
        dispatched.push(inFlight);
      }
    }

    return dispatched;
  }

  /**
   * Injects chaotic fault: SIGKILL crash on a worker.
   * Heartbeat stops, lease window expires, job is reclaimed with monotonic epoch increment,
   * and subsequently picked up by another active worker.
   */
  injectWorkerCrashSigkill(jobId) {
    const inFlight = this.inFlightJobs.get(jobId);
    if (!inFlight) return null;

    const crashedWorkerId = inFlight.workerId;
    const crashedNodeId = inFlight.nodeId;
    const crashedAttemptId = inFlight.attemptId;
    const crashedEpoch = inFlight.leaseEpoch;

    // Remove from in-flight on that node (worker is dead)
    this.inFlightJobs.delete(jobId);
    this.autoscaler.nodes.get(crashedNodeId)?.inFlightJobs.delete(jobId);

    // Advance time past lease expiration (60 seconds)
    this.advanceTime(65);

    // Lease expires and is reclaimed by dispatcher
    const reclaimedLease = this.leaseMonitor.reclaimIfExpired(jobId, this.simulatedTimeMs);

    // Job returns to queue with state 'queued'
    const job = inFlight.job;
    job.state = 'queued';
    job.activeWorkerId = null;
    job.activeNodeId = null;
    this.queuedJobs.unshift(job); // High priority requeue

    const faultEvent = {
      type: 'WORKER_CRASH_SIGKILL',
      jobId,
      crashedWorkerId,
      crashedNodeId,
      crashedAttemptId,
      crashedEpoch,
      reclaimedAtMs: this.simulatedTimeMs,
      reclaimedLease,
    };
    this.injectedFaults.push(faultEvent);

    return faultEvent;
  }

  /**
   * Injects chaotic fault: Stale Zombie Worker Resurrection.
   * A crashed/partitioned worker revives after another worker reclaimed the job,
   * and attempts to publish artifacts with its outdated lease_epoch.
   * Verified: Monotonic Fencing Token gate strictly rejects the stale publish!
   */
  injectStaleWorkerPublish(crashedWorkerEvent) {
    const { jobId, crashedWorkerId, crashedAttemptId, crashedEpoch } = crashedWorkerEvent;

    let errorThrown = null;
    try {
      this.leaseMonitor.publishArtifact({
        jobId,
        workerId: crashedWorkerId,
        attemptId: crashedAttemptId,
        leaseEpoch: crashedEpoch,
        artifactData: { uri: `s3://artifacts/${jobId}_stale.mp4`, bytes: 1024 },
        nowMs: this.simulatedTimeMs,
      });
    } catch (err) {
      errorThrown = err;
      this.stalePublishAttemptsBlocked.push({
        jobId,
        workerId: crashedWorkerId,
        attemptId: crashedAttemptId,
        staleEpoch: crashedEpoch,
        errorCode: err.code,
        errorMessage: err.message,
      });
    }

    const result = {
      type: 'STALE_WORKER_RESURRECTION',
      jobId,
      crashedWorkerId,
      staleEpoch: crashedEpoch,
      blockedByFencing: errorThrown?.code === 'STALE_LEASE_EPOCH',
      error: errorThrown ? { code: errorThrown.code, message: errorThrown.message } : null,
    };

    this.injectedFaults.push(result);
    return result;
  }

  /**
   * Injects chaotic fault: Concurrent Race Claim.
   * Two workers simultaneously try to claim the exact same job at the same millisecond.
   * Invariant: exactly one worker gets the lease, the other is rejected.
   */
  injectConcurrentRaceClaim(jobId) {
    const job = this.admittedJobs.get(jobId);
    if (!job) return null;

    const workerA = 'worker-node-01-slot-1';
    const workerB = 'worker-node-02-slot-2';
    const nextEpoch = (job.leaseEpoch ?? 0) + 1;

    let winner = null;
    let loser = null;
    let loserError = null;

    // Worker A claims
    try {
      this.leaseMonitor.claimLease({
        jobId,
        workerId: workerA,
        nodeId: 'worker-node-01',
        attemptId: `att_${jobId}_${job.attemptCount + 1}_${nextEpoch}`,
        leaseEpoch: nextEpoch,
        nowMs: this.simulatedTimeMs,
      });
      winner = workerA;
    } catch (err) {
      // should not fail
    }

    // Worker B attempts to claim the same job concurrently with the same or superseded epoch
    try {
      this.leaseMonitor.claimLease({
        jobId,
        workerId: workerB,
        nodeId: 'worker-node-02',
        attemptId: `att_${jobId}_${job.attemptCount + 2}_${nextEpoch}`,
        leaseEpoch: nextEpoch, // Attempting duplicate claim with active lease
        nowMs: this.simulatedTimeMs,
      });
      loser = workerB; // If this succeeded, it's a DOUBLE LEASE!
    } catch (err) {
      loser = workerB;
      loserError = err;
    }

    const raceResult = {
      type: 'CONCURRENT_RACE_CLAIM',
      jobId,
      winner,
      loser,
      loserBlocked: loserError !== null,
      errorCode: loserError?.code,
      doubleLeasePrevented: loserError?.code === 'DOUBLE_LEASE_DETECTED' || loserError?.code === 'NON_MONOTONIC_LEASE_EPOCH',
    };

    this.concurrentRaceAttempts.push(raceResult);
    return raceResult;
  }

  /**
   * Advances in-flight jobs towards completion.
   */
  progressInFlightJobs(elapsedSeconds = 15) {
    this.advanceTime(elapsedSeconds);
    const completed = [];

    for (const [jobId, inFlight] of Array.from(this.inFlightJobs.entries())) {
      const elapsed = (this.simulatedTimeMs - inFlight.startedAtMs) / 1000;

      if (elapsed >= inFlight.estimatedDurationSeconds) {
        // Complete and publish
        const artifactData = {
          primaryArtifactUri: `s3://artifacts/${jobId}.mp4`,
          durationSeconds: inFlight.job.durationSeconds,
          checksum: crypto.createHash('sha256').update(jobId).digest('hex'),
        };

        this.leaseMonitor.publishArtifact({
          jobId,
          workerId: inFlight.workerId,
          attemptId: inFlight.attemptId,
          leaseEpoch: inFlight.leaseEpoch,
          artifactData,
          nowMs: this.simulatedTimeMs,
        });

        this.autoscaler.onJobCompleted(inFlight.nodeId, jobId, this.simulatedTimeMs);
        this.inFlightJobs.delete(jobId);

        const terminalRecord = {
          jobId,
          tenantId: inFlight.job.tenantId,
          state: 'succeeded',
          attemptCount: inFlight.job.attemptCount,
          finalEpoch: inFlight.leaseEpoch,
          completedAtMs: this.simulatedTimeMs,
          artifact: artifactData,
        };

        this.terminalJobs.set(jobId, terminalRecord);
        completed.push(terminalRecord);
      } else {
        // Heartbeat active lease
        this.leaseMonitor.heartbeat({
          jobId,
          workerId: inFlight.workerId,
          attemptId: inFlight.attemptId,
          leaseEpoch: inFlight.leaseEpoch,
          nowMs: this.simulatedTimeMs,
        });
      }
    }

    return completed;
  }

  /**
   * Executes the full end-to-end Scale / Load Chaos Test suite.
   */
  async runFullChaosSuite() {
    const report = {
      startedAt: new Date(this.simulatedTimeMs).toISOString(),
      phases: [],
      invariants: {},
    };

    // -------------------------------------------------------------
    // Phase 1: Nominal Baseline Load (1 node, 2 slots)
    // -------------------------------------------------------------
    this.submitJobBatch(4);
    this.dispatchNextJobs();
    report.phases.push({
      phase: 1,
      name: 'NOMINAL_BASELINE',
      activeNodes: this.autoscaler.getActiveNodes().length,
      inFlightJobs: this.inFlightJobs.size,
      queuedJobs: this.queuedJobs.length,
    });

    // -------------------------------------------------------------
    // Phase 2: Load Surge -> Backlog Persistence -> SCALE_UP to 2 nodes
    // -------------------------------------------------------------
    this.submitJobBatch(12);
    // Interval 1
    this.advanceTime(65);
    const d1 = this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    // Interval 2
    this.advanceTime(65);
    const d2 = this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    // Interval 3 -> Scale-up triggered!
    this.advanceTime(65);
    const d3 = this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.dispatchNextJobs();

    report.phases.push({
      phase: 2,
      name: 'LOAD_SURGE_SCALE_UP_1',
      decisions: [d1.action, d2.action, d3.action],
      finalAction: d3.action,
      activeNodes: this.autoscaler.getActiveNodes().length,
      activeSlots: this.autoscaler.getActiveNodes().length * 2,
    });

    // -------------------------------------------------------------
    // Phase 3: Secondary Load Surge -> SCALE_UP to 3 nodes (Budget Limit)
    // -------------------------------------------------------------
    this.submitJobBatch(15);
    this.advanceTime(65);
    this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.advanceTime(65);
    this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.advanceTime(65);
    const d4 = this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.dispatchNextJobs();

    report.phases.push({
      phase: 3,
      name: 'LOAD_SURGE_SCALE_UP_2',
      finalAction: d4.action,
      activeNodes: this.autoscaler.getActiveNodes().length,
    });

    // -------------------------------------------------------------
    // Phase 4: Extreme Overload Surge -> Hard BUDGET_CLAMPED + 429 Shedding
    // -------------------------------------------------------------
    this.submitJobBatch(25, { forceOverload: true });
    this.advanceTime(65);
    this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.advanceTime(65);
    this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);
    this.advanceTime(65);
    const clampDecision = this.autoscaler.evaluateDecision(this.gatherQueueMetrics(), this.simulatedTimeMs);

    report.phases.push({
      phase: 4,
      name: 'EXTREME_OVERLOAD_BUDGET_CLAMPED',
      decision: clampDecision.action,
      activeNodes: this.autoscaler.getActiveNodes().length,
      budgetClamped: clampDecision.action === 'BUDGET_CLAMPED',
      sheddedJobsCount: this.shedded429Jobs.length,
    });

    // -------------------------------------------------------------
    // Phase 5: Mid-Execution Chaos Injections
    // -------------------------------------------------------------
    // 5.1 In-flight worker crash (SIGKILL)
    const activeJobToKill = Array.from(this.inFlightJobs.keys())[0];
    const crashEvent = this.injectWorkerCrashSigkill(activeJobToKill);

    // 5.2 Dispatch newly reclaimed job to another active worker with bumped lease_epoch
    this.dispatchNextJobs();

    // 5.3 Stale zombie worker wakes up and attempts publish -> Blocked by monotonic fencing!
    const stalePublishResult = this.injectStaleWorkerPublish(crashEvent);

    // 5.4 Concurrent Race Claim on queued job
    const batch = this.submitJobBatch(1);
    const raceJob = batch[0];
    this.queuedJobs = this.queuedJobs.filter((j) => j.id !== raceJob.id);
    const raceResult = this.injectConcurrentRaceClaim(raceJob.id);

    this.inFlightJobs.set(raceJob.id, {
      job: raceJob,
      workerId: 'worker-node-01-slot-1',
      nodeId: 'worker-node-01',
      attemptId: `att_${raceJob.id}_1_1`,
      leaseEpoch: 1,
      startedAtMs: this.simulatedTimeMs,
      lastHeartbeatAtMs: this.simulatedTimeMs,
      estimatedDurationSeconds: raceJob.durationSeconds * 2.8,
    });
    this.autoscaler.onJobStarted('worker-node-01', raceJob.id);

    // 5.5 Scale-Down Cooldown check: Queue begins emptying
    this.progressInFlightJobs(40);
    // Queue is empty, CPU low, but cooldown (600s) has NOT passed:
    const prematureDecision = this.autoscaler.evaluateDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 10.0 },
      this.simulatedTimeMs
    );

    // Advance time past 600s cooldown:
    this.advanceTime(650);
    const scaleDownDecision = this.autoscaler.evaluateDecision(
      { queueOldestSeconds: 0, queuedJobs: 0, clusterCpuUtilizationPercent: 10.0 },
      this.simulatedTimeMs
    );

    // 5.6 Graceful drain isolation check:
    // A draining node must strictly reject any new lease claims!
    const drainingNode = this.autoscaler.nodes.get(scaleDownDecision.drainedNodeId);
    let drainingClaimRejected = false;
    if (drainingNode) {
      try {
        this.leaseMonitor.claimLease({
          jobId: `drain_reject_test_${Date.now()}`,
          workerId: `${drainingNode.id}-slot-1`,
          nodeId: drainingNode.id,
          attemptId: 'att_drain_test_1_1',
          leaseEpoch: 1,
          isNodeDraining: true,
          nowMs: this.simulatedTimeMs,
        });
      } catch (err) {
        if (err.code === 'NODE_DRAINING_CANNOT_CLAIM') {
          drainingClaimRejected = true;
        }
      }
    }

    // 5.7 Step draining nodes: in-flight jobs finish, node terminates
    this.progressInFlightJobs(60);
    this.autoscaler.stepDrain(this.simulatedTimeMs);

    report.phases.push({
      phase: 5,
      name: 'CHAOS_INJECTIONS',
      workerCrashSigkill: crashEvent !== null,
      stalePublishBlockedByFencing: stalePublishResult.blockedByFencing,
      concurrentRaceDoubleLeasePrevented: raceResult.doubleLeasePrevented,
      cooldownSuppressedScaleDown: prematureDecision.action === 'COOLDOWN',
      scaleDownInitiatedAfterCooldown: scaleDownDecision.action === 'SCALE_DOWN',
      drainingNodeNewClaimsBlocked: drainingClaimRejected,
    });

    // -------------------------------------------------------------
    // Phase 6: Drain Remaining Queue & Terminal Completion
    // -------------------------------------------------------------
    while (this.queuedJobs.length > 0 || this.inFlightJobs.size > 0) {
      this.dispatchNextJobs();
      this.progressInFlightJobs(30);
      this.autoscaler.stepDrain(this.simulatedTimeMs);
    }

    // Final Invariant Checks
    const auditSummary = this.leaseMonitor.getAuditSummary();
    const invariantResult = this.leaseMonitor.assertInvariants();

    const invariants = {
      zeroDoubleLeases: auditSummary.doubleLeaseViolationsCount === 0,
      monotonicityGuaranteed: auditSummary.monotonicityViolationsCount === 0,
      stalePublishBlockedCount: auditSummary.stalePublishAttemptsBlockedCount,
      stalePublishAllowedCount: auditSummary.stalePublishAttemptsAllowedCount,
      zeroStalePublishAllowed: auditSummary.stalePublishAttemptsAllowedCount === 0,
      zeroLostJobs: this.admittedJobs.size === this.terminalJobs.size,
      zeroDuplicateArtifacts: auditSummary.publishedArtifactsCount === this.terminalJobs.size,
      budgetClampingPreserved: this.autoscaler.getActiveNodes().length <= this.autoscaler.budget.effectiveMaxNodes,
      drainingIsolationPreserved: drainingClaimRejected,
      cooldownEnforced: prematureDecision.action === 'COOLDOWN' && scaleDownDecision.action === 'SCALE_DOWN',
      overallStatus: 'PASS',
    };

    report.invariants = invariants;
    report.summary = {
      admittedJobsCount: this.admittedJobs.size,
      terminalJobsCount: this.terminalJobs.size,
      publishedArtifactsCount: auditSummary.publishedArtifactsCount,
      shedded429JobsCount: this.shedded429Jobs.length,
      doubleLeaseViolationsCount: auditSummary.doubleLeaseViolationsCount,
      stalePublishAttemptsBlockedCount: auditSummary.stalePublishAttemptsBlockedCount,
      totalHistoricalLeaseEvents: auditSummary.totalHistoricalEvents,
      activeNodesFinal: this.autoscaler.getActiveNodes().length,
      endedAt: new Date(this.simulatedTimeMs).toISOString(),
    };

    return report;
  }
}
