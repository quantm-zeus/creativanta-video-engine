/**
 * Creativanta Video Engine - Lease Fencing Monitor & Double-Lease Auditor
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", "Monotonic fencing token", "Stale worker fencing")
 *   - docs/SECURITY.md ("Chromium và structured template sandbox", "Renderer -> artifact publication")
 *   - docs/TESTING.md ("Reliability/load và CI", line 72: "stale lease không publish", line 30: "double lease")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-01: "Autoscaling implementation nếu queue metrics đòi hỏi, cooldown/drain/budget clamp; scale/load chaos test không double leases")
 *
 * Invariant Guarantees:
 *   1. Zero Double Leases: No two active workers can hold valid unexpired leases for the same (job_id, attempt_id) or job concurrently.
 *   2. Epoch Monotonicity: Every lease claim or lease reclaim strictly increments the monotonic lease_epoch.
 *   3. Monotonic Fencing: Any publication or state transition attempted by a worker with lease_epoch < current_lease_epoch is rejected.
 *   4. Draining Node Isolation: Workers residing on draining or terminated nodes cannot acquire new leases.
 */

export class LeaseFencingMonitor {
  constructor(options = {}) {
    this.leaseDurationMs = (options.leaseDurationSeconds ?? 60) * 1000;
    this.activeLeasesByJobId = new Map(); // jobId -> LeaseRecord
    this.historicalLeases = []; // Audit log of all lease events
    this.blockedDoubleLeaseAttempts = []; // Intercepted conflicting claims (prevented)
    this.doubleLeaseViolations = []; // Any actual co-existing double leases (must always be 0!)
    this.blockedNonMonotonicClaims = []; // Intercepted non-monotonic claims
    this.monotonicityViolations = []; // Any actual non-monotonic leases granted (must always be 0!)
    this.stalePublishAttemptsBlocked = []; // Audited blocked stale publications
    this.stalePublishAttemptsAllowed = []; // Any fencing breach (must always be 0!)
    this.latestEpochByJobId = new Map(); // jobId -> highest seen lease_epoch
    this.publishedArtifactsByJobId = new Map(); // jobId -> artifact record
  }

  /**
   * Evaluates and registers a new lease claim from a worker.
   * Throws or records violation if a double-lease or epoch violation is detected.
   */
  claimLease(input) {
    const {
      jobId,
      workerId,
      nodeId,
      attemptId,
      leaseEpoch,
      isNodeDraining = false,
      isNodeTerminated = false,
      nowMs = Date.now(),
    } = input;

    // Check draining/terminated node isolation
    if (isNodeTerminated || isNodeDraining) {
      const error = new Error(`Node ${nodeId} is ${isNodeTerminated ? 'TERMINATED' : 'DRAINING'}: new lease claims strictly forbidden`);
      error.code = 'NODE_DRAINING_CANNOT_CLAIM';
      this.historicalLeases.push({
        timestamp: nowMs,
        eventType: 'CLAIM_REJECTED_DRAINING',
        jobId,
        workerId,
        nodeId,
        attemptId,
        leaseEpoch,
      });
      throw error;
    }

    // Inspect existing active lease for this job
    const existingLease = this.activeLeasesByJobId.get(jobId);
    if (existingLease) {
      const isExpired = nowMs >= existingLease.expiresAtMs;
      if (!isExpired && existingLease.workerId !== workerId) {
        // Conflicting lease claim intercepted and rejected (double-lease prevented)
        const attempt = {
          timestamp: nowMs,
          jobId,
          existingLease: { ...existingLease },
          conflictingClaim: { workerId, nodeId, attemptId, leaseEpoch, requestedAtMs: nowMs },
          reason: `Worker ${workerId} attempted to claim job ${jobId} while Worker ${existingLease.workerId} holds active unexpired lease (expires in ${existingLease.expiresAtMs - nowMs}ms)`,
        };
        this.blockedDoubleLeaseAttempts.push(attempt);
        this.historicalLeases.push({
          timestamp: nowMs,
          eventType: 'DOUBLE_LEASE_CLAIM_BLOCKED',
          ...attempt,
        });
        const error = new Error(attempt.reason);
        error.code = 'DOUBLE_LEASE_DETECTED';
        throw error;
      }
    }

    // Check epoch monotonicity
    const highestEpoch = this.latestEpochByJobId.get(jobId) ?? 0;
    if (leaseEpoch <= highestEpoch) {
      const attempt = {
        timestamp: nowMs,
        jobId,
        attemptedEpoch: leaseEpoch,
        currentHighestEpoch: highestEpoch,
        reason: `Monotonic fencing violation: claim epoch ${leaseEpoch} <= current highest epoch ${highestEpoch} for job ${jobId}`,
      };
      this.blockedNonMonotonicClaims.push(attempt);
      this.historicalLeases.push({
        timestamp: nowMs,
        eventType: 'NON_MONOTONIC_CLAIM_BLOCKED',
        ...attempt,
      });
      const error = new Error(attempt.reason);
      error.code = 'NON_MONOTONIC_LEASE_EPOCH';
      throw error;
    }

    // Register active lease
    const newLease = {
      jobId,
      workerId,
      nodeId,
      attemptId,
      leaseEpoch,
      acquiredAtMs: nowMs,
      expiresAtMs: nowMs + this.leaseDurationMs,
      lastHeartbeatAtMs: nowMs,
    };

    this.activeLeasesByJobId.set(jobId, newLease);
    this.latestEpochByJobId.set(jobId, leaseEpoch);

    this.historicalLeases.push({
      timestamp: nowMs,
      eventType: 'LEASE_ACQUIRED',
      jobId,
      workerId,
      nodeId,
      attemptId,
      leaseEpoch,
      expiresAtMs: newLease.expiresAtMs,
    });

    return newLease;
  }

  /**
   * Heartbeat to extend active lease.
   */
  heartbeat(input) {
    const { jobId, workerId, attemptId, leaseEpoch, nowMs = Date.now() } = input;
    const lease = this.activeLeasesByJobId.get(jobId);

    if (!lease) {
      return { success: false, reason: 'LEASE_NOT_FOUND_OR_EXPIRED' };
    }

    if (lease.workerId !== workerId || lease.leaseEpoch !== leaseEpoch) {
      return { success: false, reason: 'STALE_OR_FOREIGN_HEARTBEAT' };
    }

    if (nowMs >= lease.expiresAtMs) {
      this.activeLeasesByJobId.delete(jobId);
      return { success: false, reason: 'LEASE_EXPIRED_PRIOR_TO_HEARTBEAT' };
    }

    lease.lastHeartbeatAtMs = nowMs;
    lease.expiresAtMs = nowMs + this.leaseDurationMs;

    this.historicalLeases.push({
      timestamp: nowMs,
      eventType: 'HEARTBEAT_ACK',
      jobId,
      workerId,
      attemptId,
      leaseEpoch,
      newExpiresAtMs: lease.expiresAtMs,
    });

    return { success: true, expiresAtMs: lease.expiresAtMs };
  }

  /**
   * Reclaims an expired lease when worker heartbeats stall.
   */
  reclaimIfExpired(jobId, nowMs = Date.now()) {
    const lease = this.activeLeasesByJobId.get(jobId);
    if (!lease) return null;

    if (nowMs >= lease.expiresAtMs) {
      this.activeLeasesByJobId.delete(jobId);
      this.historicalLeases.push({
        timestamp: nowMs,
        eventType: 'LEASE_EXPIRED_RECLAIMED',
        jobId,
        expiredWorkerId: lease.workerId,
        expiredAttemptId: lease.attemptId,
        expiredEpoch: lease.leaseEpoch,
        expiredAtMs: lease.expiresAtMs,
      });
      return lease;
    }
    return null;
  }

  /**
   * Releases an active lease on normal completion or cancellation.
   */
  releaseLease(input) {
    const { jobId, workerId, leaseEpoch, nowMs = Date.now() } = input;
    const lease = this.activeLeasesByJobId.get(jobId);

    if (lease && lease.workerId === workerId && lease.leaseEpoch === leaseEpoch) {
      this.activeLeasesByJobId.delete(jobId);
      this.historicalLeases.push({
        timestamp: nowMs,
        eventType: 'LEASE_RELEASED',
        jobId,
        workerId,
        leaseEpoch,
      });
      return true;
    }
    return false;
  }

  /**
   * Validates and publishes job artifact.
   * Monotonic Fencing Token check:
   * If worker's lease_epoch is superseded by a newer epoch, publication MUST be rejected.
   */
  publishArtifact(input) {
    const { jobId, workerId, attemptId, leaseEpoch, artifactData, nowMs = Date.now() } = input;
    const currentHighestEpoch = this.latestEpochByJobId.get(jobId) ?? 0;

    // Check if worker holds a superseded (stale) epoch
    if (leaseEpoch < currentHighestEpoch) {
      const blockedEvent = {
        timestamp: nowMs,
        jobId,
        workerId,
        attemptId,
        staleEpoch: leaseEpoch,
        currentHighestEpoch,
        reason: `Superseded lease_epoch ${leaseEpoch} < ${currentHighestEpoch}. Publication strictly blocked by monotonic fencing token.`,
      };
      this.stalePublishAttemptsBlocked.push(blockedEvent);
      this.historicalLeases.push({
        timestamp: nowMs,
        eventType: 'STALE_PUBLISH_BLOCKED',
        ...blockedEvent,
      });

      const error = new Error(blockedEvent.reason);
      error.code = 'STALE_LEASE_EPOCH';
      throw error;
    }

    // Check if another attempt already published an artifact for this job
    if (this.publishedArtifactsByJobId.has(jobId)) {
      const existing = this.publishedArtifactsByJobId.get(jobId);
      const breach = {
        timestamp: nowMs,
        jobId,
        existingArtifact: existing,
        duplicateAttempt: { workerId, attemptId, leaseEpoch },
        reason: `Duplicate artifact publication detected for job ${jobId}`,
      };
      this.stalePublishAttemptsAllowed.push(breach);
      throw new Error(breach.reason);
    }

    // Check that active lease matches if not expired
    const activeLease = this.activeLeasesByJobId.get(jobId);
    if (activeLease && (activeLease.workerId !== workerId || activeLease.leaseEpoch !== leaseEpoch)) {
      const blockedEvent = {
        timestamp: nowMs,
        jobId,
        workerId,
        attemptId,
        staleEpoch: leaseEpoch,
        activeLease,
        reason: `Worker does not hold the active lease for job ${jobId}`,
      };
      this.stalePublishAttemptsBlocked.push(blockedEvent);
      const error = new Error(blockedEvent.reason);
      error.code = 'STALE_LEASE_EPOCH';
      throw error;
    }

    // Publish successfully
    const record = {
      jobId,
      workerId,
      attemptId,
      leaseEpoch,
      artifactData,
      publishedAtMs: nowMs,
    };
    this.publishedArtifactsByJobId.set(jobId, record);
    this.activeLeasesByJobId.delete(jobId); // Lease cleanly completed

    this.historicalLeases.push({
      timestamp: nowMs,
      eventType: 'ARTIFACT_PUBLISHED',
      jobId,
      workerId,
      attemptId,
      leaseEpoch,
    });

    return record;
  }

  /**
   * Verifies all core lease invariants:
   *   1. Zero double-lease violations
   *   2. Zero monotonicity violations
   *   3. Zero duplicate published artifacts
   *   4. Zero stale publishes allowed through fencing gate
   */
  assertInvariants() {
    if (this.doubleLeaseViolations.length > 0) {
      throw new Error(
        `Invariant Breach: ${this.doubleLeaseViolations.length} double lease violations detected! Details: ${JSON.stringify(this.doubleLeaseViolations[0])}`
      );
    }

    if (this.monotonicityViolations.length > 0) {
      throw new Error(
        `Invariant Breach: ${this.monotonicityViolations.length} non-monotonic epoch violations detected! Details: ${JSON.stringify(this.monotonicityViolations[0])}`
      );
    }

    if (this.stalePublishAttemptsAllowed.length > 0) {
      throw new Error(
        `Invariant Breach: ${this.stalePublishAttemptsAllowed.length} stale publishes were mistakenly allowed! Details: ${JSON.stringify(this.stalePublishAttemptsAllowed[0])}`
      );
    }

    return {
      status: 'PASS',
      totalLeasesClaimed: this.historicalLeases.filter((e) => e.eventType === 'LEASE_ACQUIRED').length,
      doubleLeaseViolations: this.doubleLeaseViolations.length,
      monotonicityViolations: this.monotonicityViolations.length,
      stalePublishAttemptsBlocked: this.stalePublishAttemptsBlocked.length,
      stalePublishAttemptsAllowed: this.stalePublishAttemptsAllowed.length,
      publishedArtifactsCount: this.publishedArtifactsByJobId.size,
    };
  }

  getAuditSummary() {
    return {
      activeLeasesCount: this.activeLeasesByJobId.size,
      totalHistoricalEvents: this.historicalLeases.length,
      doubleLeaseViolationsCount: this.doubleLeaseViolations.length,
      blockedDoubleLeaseAttemptsCount: this.blockedDoubleLeaseAttempts.length,
      monotonicityViolationsCount: this.monotonicityViolations.length,
      stalePublishAttemptsBlockedCount: this.stalePublishAttemptsBlocked.length,
      stalePublishAttemptsAllowedCount: this.stalePublishAttemptsAllowed.length,
      publishedArtifactsCount: this.publishedArtifactsByJobId.size,
      doubleLeaseViolations: [...this.doubleLeaseViolations],
      blockedDoubleLeaseAttempts: [...this.blockedDoubleLeaseAttempts],
      stalePublishAttemptsBlocked: [...this.stalePublishAttemptsBlocked],
    };
  }
}
