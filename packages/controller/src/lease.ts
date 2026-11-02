/**
 * Job lease, fence validation, and lifecycle transition enforcement.
 * Canonical specification: docs/ARCHITECTURE.md (lines 39, 58-86)
 */

import { JobState, isTerminalJobState } from '@creativanta/contracts';

export interface LeaseFence {
  job_id: string;
  attempt_id: string;
  lease_epoch: number;
}

export interface ActiveLeaseRecord extends LeaseFence {
  tenant_id: string;
  worker_id: string;
  state: JobState;
  lease_expires_at_ms: number;
  last_heartbeat_at_ms: number;
}

const VALID_TRANSITIONS: Record<JobState, ReadonlySet<JobState>> = {
  queued: new Set<JobState>(['preparing', 'canceled', 'failed']),
  preparing: new Set<JobState>(['rendering', 'retry_wait', 'cancel_requested', 'failed']),
  rendering: new Set<JobState>(['encoding', 'retry_wait', 'cancel_requested', 'failed']),
  encoding: new Set<JobState>(['verifying', 'retry_wait', 'cancel_requested', 'failed']),
  verifying: new Set<JobState>(['succeeded', 'retry_wait', 'cancel_requested', 'failed']),
  cancel_requested: new Set<JobState>(['canceled']),
  retry_wait: new Set<JobState>(['queued', 'canceled', 'failed']),
  succeeded: new Set<JobState>(),
  failed: new Set<JobState>(),
  canceled: new Set<JobState>(),
};

export class LeaseManager {
  private activeLeases = new Map<string, ActiveLeaseRecord>();

  public canTransition(from: JobState, to: JobState): boolean {
    if (isTerminalJobState(from)) return false;
    return VALID_TRANSITIONS[from]?.has(to) ?? false;
  }

  public registerLease(record: ActiveLeaseRecord): void {
    const existing = this.activeLeases.get(record.job_id);
    if (existing && existing.lease_epoch >= record.lease_epoch) {
      throw new Error(
        `Cannot register lease for job ${record.job_id}: active lease epoch ${existing.lease_epoch} >= new epoch ${record.lease_epoch}`,
      );
    }
    this.activeLeases.set(record.job_id, { ...record });
  }

  public verifyFence(fence: LeaseFence, nowMs: number = Date.now()): ActiveLeaseRecord {
    const active = this.activeLeases.get(fence.job_id);
    if (!active) {
      throw new Error(`No active lease found for job ${fence.job_id}`);
    }
    if (active.attempt_id !== fence.attempt_id) {
      throw new Error(
        `Stale attempt_id "${fence.attempt_id}" for job ${fence.job_id}. Current is "${active.attempt_id}"`,
      );
    }
    if (active.lease_epoch !== fence.lease_epoch) {
      throw new Error(
        `Fencing token mismatch for job ${fence.job_id}: lease_epoch ${fence.lease_epoch} != active ${active.lease_epoch}`,
      );
    }
    if (nowMs > active.lease_expires_at_ms) {
      throw new Error(
        `Lease expired for job ${fence.job_id} at ${active.lease_expires_at_ms} (now: ${nowMs})`,
      );
    }
    return active;
  }

  public heartbeat(fence: LeaseFence, durationSeconds: number, nowMs: number = Date.now()): void {
    const active = this.verifyFence(fence, nowMs);
    active.last_heartbeat_at_ms = nowMs;
    active.lease_expires_at_ms = nowMs + durationSeconds * 1000;
  }

  public transition(fence: LeaseFence, newState: JobState, nowMs: number = Date.now()): void {
    const active = this.verifyFence(fence, nowMs);
    if (!this.canTransition(active.state, newState)) {
      throw new Error(`Invalid state transition for job ${fence.job_id}: ${active.state} -> ${newState}`);
    }
    active.state = newState;
    if (isTerminalJobState(newState)) {
      this.activeLeases.delete(fence.job_id);
    }
  }

  public release(jobId: string): void {
    this.activeLeases.delete(jobId);
  }
}
