/**
 * Postgres/SQLite Job Dispatcher, Lease Manager (60s/15s DB Clock), Monotonic Fencing Token,
 * Fair Multi-Tenant Scheduler, Attempt/Event State Machine, and Atomic Fenced Publisher (Task P4-02).
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Flow chuẩn", "Worker, sandbox và render", "Queue và dữ liệu", "State machine và lỗi")
 *   - docs/API.md ("Render jobs và previews", "GET /v1/jobs/{id}", "GET /v1/jobs/{id}/events")
 *   - docs/SECURITY.md ("Retention, webhook và supply chain" — asset revocation blocks publication)
 *   - evidence/P0-04/report.md (AMB-003 cancel reaper, AMB-004 retry_wait slot retention, AMB-009 DB clock leases)
 */

import crypto from 'node:crypto';
import { CompositionSpec } from '@creativanta/contracts';
import { SYSTEM_CATALOG_TENANT_ID } from '../db/migration-runner.js';
import { TenantConnectionPool, TenantTransactionContext } from '../db/tenant-pool.js';
import { TenantRepository, ResourceNotFoundError } from '../db/repository.js';
import { QuarantineStore } from '../assets/quarantine-store.js';

export const CVE_LEASE_DURATION_SECONDS = 60;
export const CVE_HEARTBEAT_INTERVAL_SECONDS = 15;
export const DEFAULT_MAX_GLOBAL_SLOTS = 4;

export const RETRYABLE_JOB_ERROR_CODES = [
  'RENDER_TIMEOUT',
  'FRAME_READINESS_TIMEOUT',
  'WORKER_LOST',
  'STORAGE_TRANSIENT_ERROR',
  'INTERNAL_WORKER_ERROR',
] as const;

export const NON_RETRYABLE_JOB_ERROR_CODES = [
  'SANDBOX_RESOURCE_LIMIT',
  'SANDBOX_SECURITY_VIOLATION',
  'MEDIA_DECODE_FAILED',
  'ENCODE_VERIFICATION_FAILED',
  'TEXT_OVERFLOW',
  'MISSING_GLYPH',
  'ASSET_REVOKED',
  'JOB_DEADLINE_EXCEEDED',
] as const;

export type RetryableJobErrorCode = (typeof RETRYABLE_JOB_ERROR_CODES)[number];
export type NonRetryableJobErrorCode = (typeof NON_RETRYABLE_JOB_ERROR_CODES)[number];
export type CanonicalJobErrorCode = RetryableJobErrorCode | NonRetryableJobErrorCode;

const RETRYABLE_SET = new Set<string>(RETRYABLE_JOB_ERROR_CODES);
const NON_RETRYABLE_SET = new Set<string>(NON_RETRYABLE_JOB_ERROR_CODES);

export function isRetryableJobErrorCode(code: string): boolean {
  if (NON_RETRYABLE_SET.has(code)) {
    return false;
  }
  return RETRYABLE_SET.has(code);
}

export function isCanonicalJobErrorCode(code: string): code is CanonicalJobErrorCode {
  return RETRYABLE_SET.has(code) || NON_RETRYABLE_SET.has(code);
}

/**
 * Computes canonical retry backoff per docs/ARCHITECTURE.md line 63:
 *   - After attempt 1: 5s (5,000 ms)
 *   - After attempt 2: 30s (30,000 ms) + deterministic jitter (0..2,000 ms)
 */
export function calculateRetryBackoffMs(
  attemptCount: number,
  jobId: string,
  options: { includeJitter?: boolean } = {},
): number {
  if (attemptCount <= 1) {
    return 5_000;
  }
  const baseMs = 30_000;
  if (options.includeJitter === false) {
    return baseMs;
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${jobId}:${attemptCount}`, 'utf8')
    .digest();
  const jitterMs = digest.readUInt16BE(0) % 2001;
  return baseMs + jitterMs;
}

export type ActiveWorkerJobState = 'preparing' | 'rendering' | 'encoding' | 'verifying';

const ALLOWED_ACTIVE_TRANSITIONS: Readonly<
  Record<ActiveWorkerJobState, ReadonlyArray<ActiveWorkerJobState>>
> = Object.freeze({
  preparing: ['preparing', 'rendering'],
  rendering: ['rendering', 'encoding'],
  encoding: ['encoding', 'verifying'],
  verifying: ['verifying'],
});

export class InvalidStateTransitionError extends Error {
  public readonly code = 'INVALID_STATE_TRANSITION';
  public readonly fromState: string;
  public readonly toState: string;

  constructor(fromState: string, toState: string, message?: string) {
    super(
      message ?? `Invalid job state machine transition from '${fromState}' to '${toState}'`,
    );
    this.name = 'InvalidStateTransitionError';
    this.fromState = fromState;
    this.toState = toState;
  }
}

export class StaleWorkerFenceError extends Error {
  public readonly code = 'STALE_WORKER_FENCED';
  public readonly jobId: string;
  public readonly attemptId: string;
  public readonly leaseEpoch: number;

  constructor(
    jobId: string,
    attemptId: string,
    leaseEpoch: number,
    message = 'Stale worker attempt or lease_epoch rejected by fencing guard',
  ) {
    super(message);
    this.name = 'StaleWorkerFenceError';
    this.jobId = jobId;
    this.attemptId = attemptId;
    this.leaseEpoch = leaseEpoch;
  }
}

export interface PinnedJobSnapshot {
  schema_version?: string;
  kind?: 'render' | 'preview';
  profile?: 'mp4-720p-v1' | 'preview-360p-v1';
  composition_id?: string;
  composition_revision?: number;
  render_hash?: string;
  compiler_version?: string;
  seed?: number;
  required_capabilities?: string[];
  resolved_assets?: Array<{
    asset_id: string;
    version: number;
    kind: string;
    sha256: string;
    bytes: number;
    mime_type: string;
  }>;
  total_input_bytes?: number;
  preview?: {
    mode: 'frame' | 'keyframes' | 'clip';
    frame_index: number | null;
    start_frame: number | null;
    duration_frames: number | null;
  };
  spec: CompositionSpec;
}

export interface DispatchedJobLease {
  tenantId: string;
  jobId: string;
  attemptId: string;
  leaseEpoch: number;
  workerId: string;
  kind: 'render' | 'preview';
  profile: 'mp4-720p-v1' | 'preview-360p-v1';
  state: ActiveWorkerJobState;
  stage: string;
  stateVersion: number;
  attemptCount: number;
  maxAttempts: number;
  compositionId: string;
  compositionRevision: number;
  leaseExpiresAt: string;
  heartbeatAt: string;
  deadlineAt: string;
  snapshot: PinnedJobSnapshot;
}

export interface LeaseRenewalResult {
  renewed: boolean;
  shouldAbortWorker: boolean;
  reason?:
    | 'OK'
    | 'STALE_LEASE_OR_EPOCH'
    | 'LEASE_EXPIRED'
    | 'CANCEL_REQUESTED'
    | 'JOB_DEADLINE_EXCEEDED'
    | 'JOB_TERMINAL'
    | 'JOB_NOT_FOUND';
  state: string;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  workerClockSkewMs: number | null;
}

export interface StageAdvanceResult {
  transitioned: boolean;
  shouldAbortWorker: boolean;
  reason?:
    | 'OK'
    | 'STALE_LEASE_OR_EPOCH'
    | 'LEASE_EXPIRED'
    | 'CANCEL_REQUESTED'
    | 'JOB_DEADLINE_EXCEEDED'
    | 'JOB_TERMINAL'
    | 'JOB_NOT_FOUND';
  state: string;
  stage: string;
  stateVersion: number;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
}

export interface StagedArtifactDescriptor {
  id?: string;
  kind: 'video' | 'manifest' | 'thumbnail' | 'captions' | 'quality_report';
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  buffer?: Buffer;
}

export interface PublishAttemptResult {
  published: boolean;
  shouldAbortWorker: boolean;
  reason:
    | 'PUBLISHED'
    | 'STALE_LEASE_OR_EPOCH'
    | 'LEASE_EXPIRED'
    | 'INVALID_STATE_FOR_PUBLISH'
    | 'CANCEL_REQUESTED'
    | 'ASSET_REVOKED'
    | 'JOB_DEADLINE_EXCEEDED'
    | 'JOB_NOT_FOUND';
  state: string;
  stateVersion: number;
  leaseEpoch: number;
  artifacts: Array<{
    id: string;
    kind: string;
    mime_type: string;
    sha256: string;
    bytes: number;
    storage_key: string;
  }>;
}

export interface ReclaimedLeaseRecord {
  tenantId: string;
  jobId: string;
  previousAttemptId: string | null;
  previousLeaseEpoch: number;
  newLeaseEpoch: number;
  newState: 'retry_wait' | 'failed' | 'canceled';
  reason: string;
}

export interface JobDispatcherOptions {
  repository: TenantRepository;
  quarantineStore?: QuarantineStore;
  maxGlobalSlots?: number;
  leaseDurationSeconds?: number;
  heartbeatIntervalSeconds?: number;
  includeRetryJitter?: boolean;
  /**
   * Optional authoritative database server clock override (`SELECT now()`) for deterministic testing.
   * When omitted, queries SQLite/Postgres `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` directly.
   */
  dbClock?: () => Date;
}

export class JobDispatcher {
  private readonly repository: TenantRepository;
  private readonly pool: TenantConnectionPool;
  private readonly quarantineStore?: QuarantineStore;
  private maxGlobalSlots: number;
  private readonly leaseDurationSeconds: number;
  private readonly heartbeatIntervalSeconds: number;
  private readonly includeRetryJitter: boolean;
  private dbClockOverride?: () => Date;

  // Fair scheduling state: round-robin tenant cursor + 2:1 preview-to-render cadence counter
  private lastDispatchedTenantId: string | null = null;
  private previewDispatchStreak = 0;

  constructor(options: JobDispatcherOptions) {
    this.repository = options.repository;
    this.pool = options.repository.getPool();
    this.quarantineStore = options.quarantineStore ?? options.repository.getQuarantineStore();
    this.maxGlobalSlots = Math.max(1, options.maxGlobalSlots ?? DEFAULT_MAX_GLOBAL_SLOTS);
    this.leaseDurationSeconds = Math.max(
      1,
      options.leaseDurationSeconds ?? CVE_LEASE_DURATION_SECONDS,
    );
    this.heartbeatIntervalSeconds = Math.max(
      1,
      options.heartbeatIntervalSeconds ?? CVE_HEARTBEAT_INTERVAL_SECONDS,
    );
    this.includeRetryJitter = options.includeRetryJitter ?? true;
    this.dbClockOverride = options.dbClock;
  }

  public getRepository(): TenantRepository {
    return this.repository;
  }

  public getQuarantineStore(): QuarantineStore | undefined {
    return this.quarantineStore;
  }

  public getLeaseDurationSeconds(): number {
    return this.leaseDurationSeconds;
  }

  public getHeartbeatIntervalSeconds(): number {
    return this.heartbeatIntervalSeconds;
  }

  public getMaxGlobalSlots(): number {
    return this.maxGlobalSlots;
  }

  public setMaxGlobalSlots(slots: number): void {
    this.maxGlobalSlots = Math.max(1, slots);
  }

  public setDbClock(clockFn: (() => Date) | undefined): void {
    this.dbClockOverride = clockFn;
  }

  /**
   * Authoritative Database Server Clock (`SELECT now()`).
   * Never uses worker-supplied local timestamps (`AMB-009`).
   */
  public getDbNow(): Date {
    if (this.dbClockOverride) {
      return new Date(this.dbClockOverride().getTime());
    }
    const db = this.pool.getDatabase();
    const row = db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS db_now")
      .get() as { db_now: string } | undefined;
    return row?.db_now ? new Date(row.db_now) : new Date();
  }

  /**
   * Promotes eligible `retry_wait` jobs whose retry backoff window has elapsed back into `queued`,
   * retaining their existing non-terminal slot and usage reservation (`AMB-004`).
   * If `deadline_at` has passed or an input asset was revoked, transitions to `failed`.
   */
  public promoteEligibleRetryWaitJobs(options: { forceIgnoreBackoff?: boolean } = {}): Array<{
    tenantId: string;
    jobId: string;
    outcome: 'queued' | 'failed';
    reason?: string;
  }> {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const db = this.pool.getDatabase();

    const candidateRows = db
      .prepare(
        `SELECT tenant_id, id
         FROM jobs
         WHERE state = 'retry_wait'
         ORDER BY created_at ASC, id ASC`,
      )
      .all() as Array<{ tenant_id: string; id: string }>;

    const results: Array<{
      tenantId: string;
      jobId: string;
      outcome: 'queued' | 'failed';
      reason?: string;
    }> = [];

    for (const candidate of candidateRows) {
      const outcome = this.pool.withTransaction(
        { tenantId: candidate.tenant_id, role: 'cve_dispatcher' },
        (tx) => {
          const jobs = tx.selectScoped<{
            id: string;
            state: string;
            state_version: number;
            lease_epoch: number;
            deadline_at: string;
            updated_at: string;
            snapshot_json: string;
          }>('jobs', 'id = ?', [candidate.id]);

          const job = jobs[0];
          if (!job || job.state !== 'retry_wait') {
            return null;
          }

          // 1. Check job deadline
          if (Date.parse(job.deadline_at) <= dbNow.getTime()) {
            this.transitionJobToTerminalFailedInTx(tx, {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              stateVersion: job.state_version,
              leaseEpoch: Number(job.lease_epoch),
              errorCode: 'JOB_DEADLINE_EXCEEDED',
              message: `Job exceeded deadline_at (${job.deadline_at}) while in retry_wait`,
              dbNowIso,
            });
            return {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              outcome: 'failed' as const,
              reason: 'JOB_DEADLINE_EXCEEDED',
            };
          }

          // 2. Check asset revocation
          const revokedAssetId = this.findRevokedAssetInSnapshotInTx(tx, job.snapshot_json);
          if (revokedAssetId) {
            this.transitionJobToTerminalFailedInTx(tx, {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              stateVersion: job.state_version,
              leaseEpoch: Number(job.lease_epoch),
              errorCode: 'ASSET_REVOKED',
              message: `Input asset '${revokedAssetId}' was revoked or deleted while job was in retry_wait`,
              dbNowIso,
            });
            return {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              outcome: 'failed' as const,
              reason: 'ASSET_REVOKED',
            };
          }

          // 3. Check whether retry backoff has elapsed
          if (!options.forceIgnoreBackoff) {
            const events = tx.selectScoped<{
              event_seq: number;
              event_type: string;
              payload_json: string;
              created_at: string;
            }>('job_events', 'job_id = ?', [job.id], 'event_seq DESC');

            const lastRetryEvent = events.find((e) => e.event_type === 'job.retry_wait');
            if (lastRetryEvent) {
              try {
                const payload = JSON.parse(lastRetryEvent.payload_json) as {
                  next_retry_at?: string;
                };
                if (
                  payload.next_retry_at &&
                  Date.parse(payload.next_retry_at) > dbNow.getTime()
                ) {
                  return null;
                }
              } catch {
                // fallback to immediate promotion if malformed
              }
            }
          }

          const nextStateVersion = job.state_version + 1;
          tx.updateScoped(
            'jobs',
            {
              state: 'queued',
              stage: 'queued',
              state_version: nextStateVersion,
              active_attempt_id: null,
              lease_expires_at: null,
              updated_at: dbNowIso,
            },
            'id = ?',
            [job.id],
          );

          const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
          tx.insertScoped('job_events', {
            tenant_id: candidate.tenant_id,
            job_id: job.id,
            event_seq: nextEventSeq,
            state: 'queued',
            state_version: nextStateVersion,
            event_type: 'job.queued',
            payload_json: JSON.stringify({
              stage: 'queued',
              progress_percent: 0,
              message: 'Retry backoff elapsed; job re-queued for execution',
            }),
            created_at: dbNowIso,
          });

          return {
            tenantId: candidate.tenant_id,
            jobId: job.id,
            outcome: 'queued' as const,
          };
        },
      );

      if (outcome) {
        results.push(outcome);
      }
    }

    return results;
  }

  /**
   * Reclaims expired worker leases (`lease_expires_at <= db_now`) across all active jobs.
   *   - `cancel_requested` with expired lease -> transitions to `canceled` (AMB-003).
   *   - `preparing/rendering/encoding/verifying` with expired lease:
   *     - If `attempt_count < max_attempts` and `db_now < deadline_at` -> transitions to `retry_wait`
   *       and increments `lease_epoch` to fence off the stalled worker (`WORKER_LOST`).
   *     - Otherwise -> transitions to terminal `failed` (`WORKER_LOST` or `JOB_DEADLINE_EXCEEDED`),
   *       increments `lease_epoch`, and releases `usage_reservations`.
   */
  public reclaimExpiredLeases(): ReclaimedLeaseRecord[] {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const db = this.pool.getDatabase();

    const expiredCandidates = db
      .prepare(
        `SELECT tenant_id, id
         FROM jobs
         WHERE state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC, id ASC`,
      )
      .all(dbNowIso) as Array<{ tenant_id: string; id: string }>;

    const reclaimed: ReclaimedLeaseRecord[] = [];

    for (const candidate of expiredCandidates) {
      const record = this.pool.withTransaction(
        { tenantId: candidate.tenant_id, role: 'cve_dispatcher' },
        (tx) => {
          const jobs = tx.selectScoped<{
            id: string;
            state: string;
            stage: string;
            state_version: number;
            attempt_count: number;
            max_attempts: number;
            active_attempt_id: string | null;
            lease_epoch: number;
            lease_expires_at: string | null;
            deadline_at: string;
          }>('jobs', 'id = ?', [candidate.id]);

          const job = jobs[0];
          if (
            !job ||
            !['preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested'].includes(
              job.state,
            ) ||
            !job.lease_expires_at ||
            Date.parse(job.lease_expires_at) > dbNow.getTime()
          ) {
            return null;
          }

          const previousAttemptId = job.active_attempt_id;
          const previousLeaseEpoch = Number(job.lease_epoch);
          const nextLeaseEpoch = previousLeaseEpoch + 1;
          const nextStateVersion = job.state_version + 1;

          // Clean up any temp files from the stalled attempt
          if (previousAttemptId && this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              candidate.tenant_id,
              job.id,
              previousAttemptId,
            );
          }

          // Case 1: cancel_requested + lease expired -> canceled (AMB-003)
          if (job.state === 'cancel_requested') {
            if (previousAttemptId) {
              tx.updateScoped(
                'job_attempts',
                {
                  state: 'canceled',
                  ended_at: dbNowIso,
                  error_json: JSON.stringify({
                    code: 'WORKER_LOST',
                    message: 'Worker lease expired after cancel_requested; reaper finalized cancel',
                    retryable: false,
                  }),
                },
                'job_id = ? AND attempt_id = ?',
                [job.id, previousAttemptId],
              );
            }

            tx.updateScoped(
              'jobs',
              {
                state: 'canceled',
                stage: 'canceled',
                state_version: nextStateVersion,
                lease_epoch: nextLeaseEpoch,
                active_attempt_id: null,
                lease_expires_at: null,
                completed_at: dbNowIso,
                updated_at: dbNowIso,
              },
              'id = ?',
              [job.id],
            );

            tx.updateScoped(
              'usage_reservations',
              { state: 'released', settled_at: dbNowIso },
              "job_id = ? AND state = 'reserved'",
              [job.id],
            );

            const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
            tx.insertScoped('job_events', {
              tenant_id: candidate.tenant_id,
              job_id: job.id,
              event_seq: nextEventSeq,
              state: 'canceled',
              state_version: nextStateVersion,
              event_type: 'job.canceled',
              payload_json: JSON.stringify({
                stage: 'canceled',
                message: 'Reaper finalized job cancellation after worker lease expired',
              }),
              created_at: dbNowIso,
            });

            tx.insertScoped('outbox', {
              tenant_id: candidate.tenant_id,
              id: `out_${crypto.randomBytes(6).toString('hex')}`,
              event_type: 'job.canceled',
              job_id: job.id,
              state_version: nextStateVersion,
              payload_json: JSON.stringify({
                job_id: job.id,
                state: 'canceled',
                state_version: nextStateVersion,
              }),
              created_at: dbNowIso,
              processed_at: null,
            });

            return {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              previousAttemptId,
              previousLeaseEpoch,
              newLeaseEpoch: nextLeaseEpoch,
              newState: 'canceled' as const,
              reason: 'CANCEL_REQUESTED_LEASE_EXPIRED',
            };
          }

          // Case 2: Active attempt lease expired -> check deadline and max_attempts
          const isPastDeadline = Date.parse(job.deadline_at) <= dbNow.getTime();
          const attemptsExhausted = job.attempt_count >= job.max_attempts;

          if (isPastDeadline || attemptsExhausted) {
            const errorCode: CanonicalJobErrorCode = isPastDeadline
              ? 'JOB_DEADLINE_EXCEEDED'
              : 'WORKER_LOST';
            const errorMessage = isPastDeadline
              ? `Worker lease expired and job deadline (${job.deadline_at}) was exceeded`
              : `Worker lease expired and max_attempts (${job.max_attempts}) exhausted`;

            if (previousAttemptId) {
              tx.updateScoped(
                'job_attempts',
                {
                  state: 'failed',
                  ended_at: dbNowIso,
                  error_json: JSON.stringify({
                    code: errorCode,
                    message: errorMessage,
                    retryable: false,
                  }),
                },
                'job_id = ? AND attempt_id = ?',
                [job.id, previousAttemptId],
              );
            }

            this.transitionJobToTerminalFailedInTx(tx, {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              stateVersion: job.state_version,
              leaseEpoch: previousLeaseEpoch,
              errorCode,
              message: errorMessage,
              dbNowIso,
            });

            return {
              tenantId: candidate.tenant_id,
              jobId: job.id,
              previousAttemptId,
              previousLeaseEpoch,
              newLeaseEpoch: nextLeaseEpoch,
              newState: 'failed' as const,
              reason: errorCode,
            };
          }

          // Case 3: Retryable WORKER_LOST -> transition to retry_wait with incremented lease_epoch
          const backoffMs = calculateRetryBackoffMs(job.attempt_count, job.id, {
            includeJitter: this.includeRetryJitter,
          });
          const nextRetryAtIso = new Date(dbNow.getTime() + backoffMs).toISOString();
          const retryError = {
            code: 'WORKER_LOST',
            message: `Worker lease expired at ${job.lease_expires_at} without heartbeat; fenced epoch ${previousLeaseEpoch} -> ${nextLeaseEpoch}`,
            retryable: true,
          };

          if (previousAttemptId) {
            tx.updateScoped(
              'job_attempts',
              {
                state: 'retry_wait',
                ended_at: dbNowIso,
                error_json: JSON.stringify(retryError),
              },
              'job_id = ? AND attempt_id = ?',
              [job.id, previousAttemptId],
            );
          }

          tx.updateScoped(
            'jobs',
            {
              state: 'retry_wait',
              stage: 'retry_wait',
              state_version: nextStateVersion,
              lease_epoch: nextLeaseEpoch,
              active_attempt_id: null,
              lease_expires_at: null,
              error_json: JSON.stringify(retryError),
              updated_at: dbNowIso,
            },
            'id = ?',
            [job.id],
          );

          const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
          tx.insertScoped('job_events', {
            tenant_id: candidate.tenant_id,
            job_id: job.id,
            event_seq: nextEventSeq,
            state: 'retry_wait',
            state_version: nextStateVersion,
            event_type: 'job.retry_wait',
            payload_json: JSON.stringify({
              stage: 'retry_wait',
              progress_percent: 0,
              error_code: 'WORKER_LOST',
              backoff_ms: backoffMs,
              next_retry_at: nextRetryAtIso,
              fenced_lease_epoch: previousLeaseEpoch,
              new_lease_epoch: nextLeaseEpoch,
              message: retryError.message,
            }),
            created_at: dbNowIso,
          });

          return {
            tenantId: candidate.tenant_id,
            jobId: job.id,
            previousAttemptId,
            previousLeaseEpoch,
            newLeaseEpoch: nextLeaseEpoch,
            newState: 'retry_wait' as const,
            reason: 'WORKER_LOST',
          };
        },
      );

      if (record) {
        reclaimed.push(record);
      }
    }

    return reclaimed;
  }

  /**
   * Fair Multi-Tenant Scheduler & Atomic Lease Acquisition (`queued -> preparing`).
   *
   * Enforces:
   *   1. Global slot cap (`maxGlobalSlots`).
   *   2. Per-tenant active slot cap (`active_job_slots_max`, default 2).
   *   3. Preview vs Render 2:1 weighted priority (`[preview, preview, render]`),
   *      capped at `<= 50%` global preview slots (`Math.floor(maxGlobalSlots * 0.5)`)
   *      whenever `maxGlobalSlots >= 2` and a render job is waiting (`queued`),
   *      so previews never starve render jobs.
   *   4. Round-robin selection across eligible tenants; FIFO (`created_at ASC, id ASC`)
   *      within each tenant.
   *   5. Monotonic fencing token `(job_id, attempt_id, lease_epoch = lease_epoch + 1)`
   *      and 60s lease expiration computed from DB clock `now()`.
   */
  public claimNextJob(input: {
    workerId: string;
    attemptId?: string;
    autoReclaimExpiredLeases?: boolean;
    autoPromoteRetryWait?: boolean;
    workerLocalTime?: Date;
  }): DispatchedJobLease | null {
    if (input.autoReclaimExpiredLeases !== false) {
      this.reclaimExpiredLeases();
    }
    if (input.autoPromoteRetryWait !== false) {
      this.promoteEligibleRetryWaitJobs();
    }

    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const leaseExpiresIso = new Date(
      dbNow.getTime() + this.leaseDurationSeconds * 1000,
    ).toISOString();

    const db = this.pool.getDatabase();

    // 1. Inspect global active jobs across all tenants
    const activeRows = db
      .prepare(
        `SELECT tenant_id, id, kind, state
         FROM jobs
         WHERE state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested')`,
      )
      .all() as Array<{ tenant_id: string; id: string; kind: 'render' | 'preview'; state: string }>;

    if (activeRows.length >= this.maxGlobalSlots) {
      return null;
    }

    const globalActivePreviewCount = activeRows.filter((r) => r.kind === 'preview').length;
    const activeCountByTenant = new Map<string, number>();
    for (const row of activeRows) {
      activeCountByTenant.set(
        row.tenant_id,
        (activeCountByTenant.get(row.tenant_id) ?? 0) + 1,
      );
    }

    // 2. Inspect queued jobs across active tenants
    const queuedRows = db
      .prepare(
        `SELECT j.tenant_id, j.id, j.kind, j.created_at
         FROM jobs j
         JOIN tenants t ON t.id = j.tenant_id
         WHERE j.state = 'queued'
           AND t.status = 'active'
           AND j.tenant_id <> ?
         ORDER BY j.created_at ASC, j.id ASC`,
      )
      .all(SYSTEM_CATALOG_TENANT_ID) as Array<{
      tenant_id: string;
      id: string;
      kind: 'render' | 'preview';
      created_at: string;
    }>;

    if (queuedRows.length === 0) {
      return null;
    }

    // 3. Filter tenants that still have available per-tenant active job slots (default 2)
    const distinctTenantIds = Array.from(new Set(queuedRows.map((r) => r.tenant_id))).sort();
    const eligibleTenantIds = new Set<string>();

    for (const tenantId of distinctTenantIds) {
      const limits = this.repository.getTenantPolicyLimits(tenantId);
      const currentActive = activeCountByTenant.get(tenantId) ?? 0;
      if (currentActive < limits.active_job_slots_max) {
        eligibleTenantIds.add(tenantId);
      }
    }

    if (eligibleTenantIds.size === 0) {
      return null;
    }

    const eligibleQueuedRows = queuedRows.filter((r) => eligibleTenantIds.has(r.tenant_id));
    if (eligibleQueuedRows.length === 0) {
      return null;
    }

    // 4. Determine target job kind (2:1 preview-to-render priority + <=50% preview cap when render waiting)
    const hasWaitingPreview = eligibleQueuedRows.some((r) => r.kind === 'preview');
    const hasWaitingRender = eligibleQueuedRows.some((r) => r.kind === 'render');

    let targetKind: 'preview' | 'render';
    if (hasWaitingPreview && hasWaitingRender) {
      const previewSlotCapWhenRenderWaiting =
        this.maxGlobalSlots >= 2 ? Math.floor(this.maxGlobalSlots * 0.5) : 1;

      if (
        this.maxGlobalSlots >= 2 &&
        globalActivePreviewCount >= previewSlotCapWhenRenderWaiting
      ) {
        // Preview is already using >= 50% of global slots while render is waiting -> schedule render
        targetKind = 'render';
      } else if (this.previewDispatchStreak < 2) {
        targetKind = 'preview';
      } else {
        targetKind = 'render';
      }
    } else if (hasWaitingPreview) {
      targetKind = 'preview';
    } else {
      targetKind = 'render';
    }

    // 5. Round-robin tenant order starting strictly after lastDispatchedTenantId
    const orderedEligibleTenants = Array.from(eligibleTenantIds).sort();
    let rotatedTenants = orderedEligibleTenants;
    if (this.lastDispatchedTenantId !== null) {
      const lastIdx = orderedEligibleTenants.findIndex(
        (t) => t > this.lastDispatchedTenantId!,
      );
      if (lastIdx !== -1) {
        rotatedTenants = [
          ...orderedEligibleTenants.slice(lastIdx),
          ...orderedEligibleTenants.slice(0, lastIdx),
        ];
      }
    }

    // Find first tenant in round-robin order that has a queued job of targetKind
    let chosenTenantId: string | null = null;
    for (const tenantId of rotatedTenants) {
      if (eligibleQueuedRows.some((r) => r.tenant_id === tenantId && r.kind === targetKind)) {
        chosenTenantId = tenantId;
        break;
      }
    }

    // Fallback if no tenant had targetKind
    if (!chosenTenantId) {
      chosenTenantId = rotatedTenants[0]!;
    }

    // Within chosenTenantId, pick oldest FIFO queued job matching targetKind (or oldest overall)
    const chosenCandidate =
      eligibleQueuedRows.find(
        (r) => r.tenant_id === chosenTenantId && r.kind === targetKind,
      ) ?? eligibleQueuedRows.find((r) => r.tenant_id === chosenTenantId)!;

    // 6. Atomically claim the job in a tenant-scoped cve_dispatcher transaction
    const claimed = this.pool.withTransaction(
      { tenantId: chosenCandidate.tenant_id, role: 'cve_dispatcher' },
      (tx) => {
        const limits = this.repository.getTenantPolicyLimitsInTx(tx);
        const activeInTenant = tx.selectScoped<{ id: string }>(
          'jobs',
          "state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested')",
          [],
        );
        if (activeInTenant.length >= limits.active_job_slots_max) {
          return null;
        }

        const jobs = tx.selectScoped<{
          id: string;
          kind: 'render' | 'preview';
          profile: 'mp4-720p-v1' | 'preview-360p-v1';
          state: string;
          state_version: number;
          attempt_count: number;
          max_attempts: number;
          composition_id: string;
          composition_revision: number;
          lease_epoch: number;
          deadline_at: string;
          snapshot_json: string;
        }>('jobs', 'id = ?', [chosenCandidate.id]);

        const job = jobs[0];
        if (!job || job.state !== 'queued') {
          return null;
        }

        // Verify deadline and asset readiness before starting attempt
        if (Date.parse(job.deadline_at) <= dbNow.getTime()) {
          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: chosenCandidate.tenant_id,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: Number(job.lease_epoch),
            errorCode: 'JOB_DEADLINE_EXCEEDED',
            message: `Job deadline (${job.deadline_at}) expired before worker claim`,
            dbNowIso,
          });
          return null;
        }

        const revokedAssetId = this.findRevokedAssetInSnapshotInTx(tx, job.snapshot_json);
        if (revokedAssetId) {
          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: chosenCandidate.tenant_id,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: Number(job.lease_epoch),
            errorCode: 'ASSET_REVOKED',
            message: `Input asset '${revokedAssetId}' was revoked or deleted before worker claim`,
            dbNowIso,
          });
          return null;
        }

        const nextLeaseEpoch = Number(job.lease_epoch) + 1;
        const nextAttemptCount = job.attempt_count + 1;
        const nextStateVersion = job.state_version + 1;
        const attemptId =
          input.attemptId ?? `att_${job.id}_${nextAttemptCount}_${nextLeaseEpoch}`;

        tx.updateScoped(
          'jobs',
          {
            state: 'preparing',
            stage: 'preparing',
            progress: 0.05,
            state_version: nextStateVersion,
            attempt_count: nextAttemptCount,
            active_attempt_id: attemptId,
            lease_epoch: nextLeaseEpoch,
            lease_expires_at: leaseExpiresIso,
            heartbeat_at: dbNowIso,
            updated_at: dbNowIso,
          },
          "id = ? AND state = 'queued'",
          [job.id],
        );

        tx.insertScoped('job_attempts', {
          tenant_id: chosenCandidate.tenant_id,
          job_id: job.id,
          attempt_id: attemptId,
          lease_epoch: nextLeaseEpoch,
          worker_id: input.workerId,
          state: 'preparing',
          started_at: dbNowIso,
          heartbeat_at: dbNowIso,
          lease_expires_at: leaseExpiresIso,
          ended_at: null,
          cpu_seconds: null,
          peak_rss_bytes: null,
          error_json: null,
        });

        const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
        tx.insertScoped('job_events', {
          tenant_id: chosenCandidate.tenant_id,
          job_id: job.id,
          event_seq: nextEventSeq,
          state: 'preparing',
          state_version: nextStateVersion,
          event_type: 'job.preparing',
          payload_json: JSON.stringify({
            stage: 'preparing',
            progress_percent: 5,
            attempt_id: attemptId,
            attempt: nextAttemptCount,
            lease_epoch: nextLeaseEpoch,
            worker_id: input.workerId,
            message: `Worker ${input.workerId} claimed job (attempt ${nextAttemptCount}, lease_epoch ${nextLeaseEpoch})`,
          }),
          created_at: dbNowIso,
        });

        const parsedSnapshot = this.parseJobSnapshot(job.snapshot_json, job);

        return {
          tenantId: chosenCandidate.tenant_id,
          jobId: job.id,
          attemptId,
          leaseEpoch: nextLeaseEpoch,
          workerId: input.workerId,
          kind: job.kind,
          profile: job.profile,
          state: 'preparing' as const,
          stage: 'preparing',
          stateVersion: nextStateVersion,
          attemptCount: nextAttemptCount,
          maxAttempts: job.max_attempts,
          compositionId: job.composition_id,
          compositionRevision: job.composition_revision,
          leaseExpiresAt: leaseExpiresIso,
          heartbeatAt: dbNowIso,
          deadlineAt: job.deadline_at,
          snapshot: parsedSnapshot,
        };
      },
    );

    if (claimed) {
      this.lastDispatchedTenantId = claimed.tenantId;
      if (claimed.kind === 'preview') {
        this.previewDispatchStreak += 1;
      } else {
        this.previewDispatchStreak = 0;
      }
    }

    return claimed;
  }

  /**
   * Heartbeat & Lease Renewal (`15s` cadence, extending lease to `db_now + 60s`).
   *
   * Strictly uses database server clock `getDbNow()`, ignoring any skewed `workerLocalTime`.
   * If `(job_id, attempt_id, lease_epoch)` does not match or the lease has expired or the job
   * was canceled, returns `{ renewed: false, shouldAbortWorker: true }` (0 rows renewed)
   * so the worker immediately self-aborts.
   */
  public renewLease(input: {
    tenantId: string;
    jobId: string;
    attemptId: string;
    leaseEpoch: number;
    workerId: string;
    progress?: number;
    workerLocalTime?: Date;
  }): LeaseRenewalResult {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const leaseExpiresIso = new Date(
      dbNow.getTime() + this.leaseDurationSeconds * 1000,
    ).toISOString();
    const workerClockSkewMs = input.workerLocalTime
      ? input.workerLocalTime.getTime() - dbNow.getTime()
      : null;

    return this.pool.withTransaction(
      { tenantId: input.tenantId, role: 'cve_dispatcher' },
      (tx) => {
        const jobs = tx.selectScoped<{
          id: string;
          state: string;
          state_version: number;
          active_attempt_id: string | null;
          lease_epoch: number;
          lease_expires_at: string | null;
          heartbeat_at: string | null;
          deadline_at: string;
        }>('jobs', 'id = ?', [input.jobId]);

        const job = jobs[0];
        if (!job) {
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'JOB_NOT_FOUND',
            state: 'unknown',
            leaseEpoch: input.leaseEpoch,
            leaseExpiresAt: null,
            heartbeatAt: null,
            workerClockSkewMs,
          };
        }

        const currentEpoch = Number(job.lease_epoch);

        // Fence check 1: Must match active_attempt_id and monotonic lease_epoch
        if (job.active_attempt_id !== input.attemptId || currentEpoch !== input.leaseEpoch) {
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'STALE_LEASE_OR_EPOCH',
            state: job.state,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
            heartbeatAt: job.heartbeat_at,
            workerClockSkewMs,
          };
        }

        // Fence check 2: If cancel_requested, finalize cancellation and tell worker to abort
        if (job.state === 'cancel_requested') {
          this.finalizeCancelRequestedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            attemptId: input.attemptId,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            dbNowIso,
          });
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'CANCEL_REQUESTED',
            state: 'canceled',
            leaseEpoch: currentEpoch + 1,
            leaseExpiresAt: null,
            heartbeatAt: dbNowIso,
            workerClockSkewMs,
          };
        }

        // Fence check 3: Must be in an active worker execution state
        if (!['preparing', 'rendering', 'encoding', 'verifying'].includes(job.state)) {
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'JOB_TERMINAL',
            state: job.state,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
            heartbeatAt: job.heartbeat_at,
            workerClockSkewMs,
          };
        }

        // Fence check 4: Lease must not be expired according to DB clock now()
        if (!job.lease_expires_at || Date.parse(job.lease_expires_at) <= dbNow.getTime()) {
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'LEASE_EXPIRED',
            state: job.state,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
            heartbeatAt: job.heartbeat_at,
            workerClockSkewMs,
          };
        }

        // Fence check 5: Job deadline must not be exceeded
        if (Date.parse(job.deadline_at) <= dbNow.getTime()) {
          tx.updateScoped(
            'job_attempts',
            {
              state: 'failed',
              ended_at: dbNowIso,
              error_json: JSON.stringify({
                code: 'JOB_DEADLINE_EXCEEDED',
                message: `Job deadline (${job.deadline_at}) exceeded during heartbeat renewal`,
                retryable: false,
              }),
            },
            'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
            [job.id, input.attemptId, input.leaseEpoch],
          );

          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            errorCode: 'JOB_DEADLINE_EXCEEDED',
            message: `Job deadline (${job.deadline_at}) exceeded during heartbeat renewal`,
            dbNowIso,
          });

          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'JOB_DEADLINE_EXCEEDED',
            state: 'failed',
            leaseEpoch: currentEpoch + 1,
            leaseExpiresAt: null,
            heartbeatAt: dbNowIso,
            workerClockSkewMs,
          };
        }

        const jobUpdates: Record<string, string | number | null> = {
          lease_expires_at: leaseExpiresIso,
          heartbeat_at: dbNowIso,
          updated_at: dbNowIso,
        };
        if (
          typeof input.progress === 'number' &&
          input.progress >= 0 &&
          input.progress <= 1
        ) {
          jobUpdates['progress'] = input.progress;
        }

        const updatedJobs = tx.updateScoped(
          'jobs',
          jobUpdates,
          'id = ? AND active_attempt_id = ? AND lease_epoch = ? AND lease_expires_at > ?',
          [job.id, input.attemptId, input.leaseEpoch, dbNowIso],
        );

        if (updatedJobs === 0) {
          return {
            renewed: false,
            shouldAbortWorker: true,
            reason: 'STALE_LEASE_OR_EPOCH',
            state: job.state,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
            heartbeatAt: job.heartbeat_at,
            workerClockSkewMs,
          };
        }

        tx.updateScoped(
          'job_attempts',
          {
            heartbeat_at: dbNowIso,
            lease_expires_at: leaseExpiresIso,
          },
          'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
          [job.id, input.attemptId, input.leaseEpoch],
        );

        return {
          renewed: true,
          shouldAbortWorker: false,
          reason: 'OK',
          state: job.state,
          leaseEpoch: currentEpoch,
          leaseExpiresAt: leaseExpiresIso,
          heartbeatAt: dbNowIso,
          workerClockSkewMs,
        };
      },
    );
  }

  /**
   * Advances a leased job through the canonical active worker pipeline:
   * `preparing -> rendering -> encoding -> verifying`.
   *
   * Rejects stale `(attempt_id, lease_epoch)` or expired leases.
   */
  public advanceJobStage(input: {
    tenantId: string;
    jobId: string;
    attemptId: string;
    leaseEpoch: number;
    targetState: ActiveWorkerJobState;
    stage?: string;
    progress?: number;
    message?: string;
    workerLocalTime?: Date;
  }): StageAdvanceResult {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const leaseExpiresIso = new Date(
      dbNow.getTime() + this.leaseDurationSeconds * 1000,
    ).toISOString();

    return this.pool.withTransaction(
      { tenantId: input.tenantId, role: 'cve_dispatcher' },
      (tx) => {
        const jobs = tx.selectScoped<{
          id: string;
          state: string;
          stage: string;
          progress: number;
          state_version: number;
          active_attempt_id: string | null;
          lease_epoch: number;
          lease_expires_at: string | null;
          deadline_at: string;
        }>('jobs', 'id = ?', [input.jobId]);

        const job = jobs[0];
        if (!job) {
          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'JOB_NOT_FOUND',
            state: 'unknown',
            stage: 'unknown',
            stateVersion: 0,
            leaseEpoch: input.leaseEpoch,
            leaseExpiresAt: null,
          };
        }

        const currentEpoch = Number(job.lease_epoch);

        if (job.active_attempt_id !== input.attemptId || currentEpoch !== input.leaseEpoch) {
          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'STALE_LEASE_OR_EPOCH',
            state: job.state,
            stage: job.stage,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
          };
        }

        if (job.state === 'cancel_requested') {
          this.finalizeCancelRequestedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            attemptId: input.attemptId,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            dbNowIso,
          });
          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'CANCEL_REQUESTED',
            state: 'canceled',
            stage: 'canceled',
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
            leaseExpiresAt: null,
          };
        }

        if (!job.lease_expires_at || Date.parse(job.lease_expires_at) <= dbNow.getTime()) {
          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'LEASE_EXPIRED',
            state: job.state,
            stage: job.stage,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
          };
        }

        if (Date.parse(job.deadline_at) <= dbNow.getTime()) {
          tx.updateScoped(
            'job_attempts',
            {
              state: 'failed',
              ended_at: dbNowIso,
              error_json: JSON.stringify({
                code: 'JOB_DEADLINE_EXCEEDED',
                message: `Job deadline (${job.deadline_at}) exceeded before advancing to ${input.targetState}`,
                retryable: false,
              }),
            },
            'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
            [job.id, input.attemptId, input.leaseEpoch],
          );

          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            errorCode: 'JOB_DEADLINE_EXCEEDED',
            message: `Job deadline (${job.deadline_at}) exceeded before advancing to ${input.targetState}`,
            dbNowIso,
          });

          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'JOB_DEADLINE_EXCEEDED',
            state: 'failed',
            stage: 'failed',
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
            leaseExpiresAt: null,
          };
        }

        const allowedTargets =
          ALLOWED_ACTIVE_TRANSITIONS[job.state as ActiveWorkerJobState];
        if (!allowedTargets || !allowedTargets.includes(input.targetState)) {
          throw new InvalidStateTransitionError(job.state, input.targetState);
        }

        const defaultProgressByState: Record<ActiveWorkerJobState, number> = {
          preparing: 0.1,
          rendering: 0.5,
          encoding: 0.8,
          verifying: 0.95,
        };
        const progress =
          typeof input.progress === 'number'
            ? Math.min(1, Math.max(0, input.progress))
            : defaultProgressByState[input.targetState];
        const stage = input.stage ?? input.targetState;
        const nextStateVersion = job.state_version + 1;

        const updated = tx.updateScoped(
          'jobs',
          {
            state: input.targetState,
            stage,
            progress,
            state_version: nextStateVersion,
            lease_expires_at: leaseExpiresIso,
            heartbeat_at: dbNowIso,
            updated_at: dbNowIso,
          },
          'id = ? AND active_attempt_id = ? AND lease_epoch = ? AND lease_expires_at > ?',
          [job.id, input.attemptId, input.leaseEpoch, dbNowIso],
        );

        if (updated === 0) {
          return {
            transitioned: false,
            shouldAbortWorker: true,
            reason: 'STALE_LEASE_OR_EPOCH',
            state: job.state,
            stage: job.stage,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            leaseExpiresAt: job.lease_expires_at,
          };
        }

        tx.updateScoped(
          'job_attempts',
          {
            state: input.targetState,
            heartbeat_at: dbNowIso,
            lease_expires_at: leaseExpiresIso,
          },
          'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
          [job.id, input.attemptId, input.leaseEpoch],
        );

        const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
        tx.insertScoped('job_events', {
          tenant_id: input.tenantId,
          job_id: job.id,
          event_seq: nextEventSeq,
          state: input.targetState,
          state_version: nextStateVersion,
          event_type: `job.${input.targetState}`,
          payload_json: JSON.stringify({
            stage,
            progress_percent: Math.round(progress * 100),
            attempt_id: input.attemptId,
            lease_epoch: input.leaseEpoch,
            message: input.message ?? `Job advanced to ${input.targetState}`,
          }),
          created_at: dbNowIso,
        });

        return {
          transitioned: true,
          shouldAbortWorker: false,
          reason: 'OK',
          state: input.targetState,
          stage,
          stateVersion: nextStateVersion,
          leaseEpoch: currentEpoch,
          leaseExpiresAt: leaseExpiresIso,
        };
      },
    );
  }

  /**
   * Handles worker attempt failure with canonical retry classification, backoff scheduling,
   * operational usage metering, and fencing.
   */
  public failOrRetryAttempt(input: {
    tenantId: string;
    jobId: string;
    attemptId: string;
    leaseEpoch: number;
    errorCode: CanonicalJobErrorCode;
    message: string;
    retryable?: boolean;
    cpuSeconds?: number;
    peakRssBytes?: number;
  }): {
    handled: boolean;
    newState: 'retry_wait' | 'failed' | 'canceled' | 'stale';
    stateVersion: number;
    leaseEpoch: number;
    backoffMs?: number;
    nextRetryAt?: string;
  } {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();

    return this.pool.withTransaction(
      { tenantId: input.tenantId, role: 'cve_dispatcher' },
      (tx) => {
        const jobs = tx.selectScoped<{
          id: string;
          state: string;
          state_version: number;
          attempt_count: number;
          max_attempts: number;
          active_attempt_id: string | null;
          lease_epoch: number;
          lease_expires_at: string | null;
          deadline_at: string;
        }>('jobs', 'id = ?', [input.jobId]);

        const job = jobs[0];
        if (!job) {
          throw new ResourceNotFoundError(`Job ${input.jobId} not found`);
        }

        const currentEpoch = Number(job.lease_epoch);
        if (job.active_attempt_id !== input.attemptId || currentEpoch !== input.leaseEpoch) {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          return {
            handled: false,
            newState: 'stale' as const,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
          };
        }

        if (this.quarantineStore) {
          this.quarantineStore.cleanupAttemptTempDir(
            input.tenantId,
            input.jobId,
            input.attemptId,
          );
        }

        const cpuSeconds = Math.max(0, Number((input.cpuSeconds ?? 0.05).toFixed(6)));
        const peakRssBytes = Math.max(0, Math.round(input.peakRssBytes ?? 64 * 1024 * 1024));

        // Record operational cpu_seconds usage entry for this attempt
        this.insertOperationalCpuUsageInTx(tx, {
          tenantId: input.tenantId,
          jobId: job.id,
          attemptId: input.attemptId,
          cpuSeconds,
          reason: `attempt_${job.attempt_count}_failure:${input.errorCode}`,
          dbNowIso,
        });

        // If cancel_requested, finalize to canceled
        if (job.state === 'cancel_requested') {
          this.finalizeCancelRequestedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            attemptId: input.attemptId,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            cpuSeconds,
            peakRssBytes,
            dbNowIso,
          });
          return {
            handled: true,
            newState: 'canceled' as const,
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
          };
        }

        const isPastDeadline = Date.parse(job.deadline_at) <= dbNow.getTime();
        const effectiveErrorCode: CanonicalJobErrorCode = isPastDeadline
          ? 'JOB_DEADLINE_EXCEEDED'
          : input.errorCode;
        const canRetry =
          !isPastDeadline &&
          isRetryableJobErrorCode(effectiveErrorCode) &&
          input.retryable !== false &&
          job.attempt_count < job.max_attempts;

        const nextLeaseEpoch = currentEpoch + 1;
        const nextStateVersion = job.state_version + 1;

        if (canRetry) {
          const backoffMs = calculateRetryBackoffMs(job.attempt_count, job.id, {
            includeJitter: this.includeRetryJitter,
          });
          const nextRetryAtIso = new Date(dbNow.getTime() + backoffMs).toISOString();
          const errPayload = {
            code: effectiveErrorCode,
            message: input.message,
            retryable: true,
          };

          tx.updateScoped(
            'job_attempts',
            {
              state: 'retry_wait',
              ended_at: dbNowIso,
              cpu_seconds: cpuSeconds,
              peak_rss_bytes: peakRssBytes,
              error_json: JSON.stringify(errPayload),
            },
            'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
            [job.id, input.attemptId, input.leaseEpoch],
          );

          tx.updateScoped(
            'jobs',
            {
              state: 'retry_wait',
              stage: 'retry_wait',
              state_version: nextStateVersion,
              lease_epoch: nextLeaseEpoch,
              active_attempt_id: null,
              lease_expires_at: null,
              error_json: JSON.stringify(errPayload),
              updated_at: dbNowIso,
            },
            'id = ?',
            [job.id],
          );

          const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
          tx.insertScoped('job_events', {
            tenant_id: input.tenantId,
            job_id: job.id,
            event_seq: nextEventSeq,
            state: 'retry_wait',
            state_version: nextStateVersion,
            event_type: 'job.retry_wait',
            payload_json: JSON.stringify({
              stage: 'retry_wait',
              progress_percent: 0,
              attempt_id: input.attemptId,
              attempt: job.attempt_count,
              error_code: effectiveErrorCode,
              backoff_ms: backoffMs,
              next_retry_at: nextRetryAtIso,
              message: input.message,
            }),
            created_at: dbNowIso,
          });

          return {
            handled: true,
            newState: 'retry_wait' as const,
            stateVersion: nextStateVersion,
            leaseEpoch: nextLeaseEpoch,
            backoffMs,
            nextRetryAt: nextRetryAtIso,
          };
        }

        // Terminal failure
        const terminalError = {
          code: effectiveErrorCode,
          message: input.message,
          retryable: false,
        };

        tx.updateScoped(
          'job_attempts',
          {
            state: 'failed',
            ended_at: dbNowIso,
            cpu_seconds: cpuSeconds,
            peak_rss_bytes: peakRssBytes,
            error_json: JSON.stringify(terminalError),
          },
          'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
          [job.id, input.attemptId, input.leaseEpoch],
        );

        this.transitionJobToTerminalFailedInTx(tx, {
          tenantId: input.tenantId,
          jobId: job.id,
          stateVersion: job.state_version,
          leaseEpoch: currentEpoch,
          errorCode: effectiveErrorCode,
          message: input.message,
          dbNowIso,
        });

        return {
          handled: true,
          newState: 'failed' as const,
          stateVersion: nextStateVersion,
          leaseEpoch: nextLeaseEpoch,
        };
      },
    );
  }

  /**
   * Fenced Atomic Job Publication (`verifying -> succeeded`).
   *
   * Guarantees (`stale worker không publish`):
   *   1. Verifies `(job_id, active_attempt_id, lease_epoch)` and `lease_expires_at > db_now`
   *      and `job.state === 'verifying'`.
   *   2. If a worker is stale (e.g. lease expired and reaper/worker-2 incremented `lease_epoch`),
   *      publication is strictly rejected (`published: false`, `reason: 'STALE_LEASE_OR_EPOCH'`),
   *      its attempt-scoped temp directory is cleaned up, and ZERO rows are written to
   *      `artifacts`, `usage_entries`, `job_events`, or `outbox`.
   *   3. Verifies that no referenced input asset was revoked/deleted (`ASSET_REVOKED`).
   *   4. Atomically promotes staged temp files to permanent storage, inserts `artifacts`,
   *      settles `usage_reservations`, records `operational` + `billable` `usage_entries`,
   *      transitions `job_attempts` and `jobs` to `succeeded`, and writes `job.succeeded`
   *      to `job_events` and `outbox`.
   */
  public publishJobAttempt(input: {
    tenantId: string;
    jobId: string;
    attemptId: string;
    leaseEpoch: number;
    artifacts: StagedArtifactDescriptor[];
    cpuSeconds: number;
    peakRssBytes: number;
    outputSeconds?: number;
    artifactRetentionDays?: number;
    workerLocalTime?: Date;
  }): PublishAttemptResult {
    const dbNow = this.getDbNow();
    const dbNowIso = dbNow.toISOString();
    const retentionDays = input.artifactRetentionDays ?? 7;
    const artifactExpiresIso = new Date(
      dbNow.getTime() + retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    return this.pool.withTransaction(
      { tenantId: input.tenantId, role: 'cve_dispatcher' },
      (tx) => {
        const jobs = tx.selectScoped<{
          id: string;
          kind: 'render' | 'preview';
          profile: string;
          state: string;
          stage: string;
          state_version: number;
          attempt_count: number;
          active_attempt_id: string | null;
          lease_epoch: number;
          lease_expires_at: string | null;
          deadline_at: string;
          snapshot_json: string;
        }>('jobs', 'id = ?', [input.jobId]);

        const job = jobs[0];
        if (!job) {
          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'JOB_NOT_FOUND',
            state: 'unknown',
            stateVersion: 0,
            leaseEpoch: input.leaseEpoch,
            artifacts: [],
          };
        }

        const currentEpoch = Number(job.lease_epoch);

        // 1. Stale worker fencing check (attempt_id & monotonic lease_epoch)
        if (job.active_attempt_id !== input.attemptId || currentEpoch !== input.leaseEpoch) {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'STALE_LEASE_OR_EPOCH',
            state: job.state,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            artifacts: [],
          };
        }

        // 2. Cancellation check
        if (job.state === 'cancel_requested') {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          this.finalizeCancelRequestedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            attemptId: input.attemptId,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            cpuSeconds: input.cpuSeconds,
            peakRssBytes: input.peakRssBytes,
            dbNowIso,
          });
          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'CANCEL_REQUESTED',
            state: 'canceled',
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
            artifacts: [],
          };
        }

        // 3. Lease expiration check using DB server clock now()
        if (!job.lease_expires_at || Date.parse(job.lease_expires_at) <= dbNow.getTime()) {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'LEASE_EXPIRED',
            state: job.state,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            artifacts: [],
          };
        }

        // 4. State machine check: only `verifying` can transition to `succeeded`
        if (job.state !== 'verifying') {
          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'INVALID_STATE_FOR_PUBLISH',
            state: job.state,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            artifacts: [],
          };
        }

        // 5. Deadline check
        if (Date.parse(job.deadline_at) <= dbNow.getTime()) {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          tx.updateScoped(
            'job_attempts',
            {
              state: 'failed',
              ended_at: dbNowIso,
              cpu_seconds: input.cpuSeconds,
              peak_rss_bytes: input.peakRssBytes,
              error_json: JSON.stringify({
                code: 'JOB_DEADLINE_EXCEEDED',
                message: `Job deadline (${job.deadline_at}) exceeded before publication`,
                retryable: false,
              }),
            },
            'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
            [job.id, input.attemptId, input.leaseEpoch],
          );

          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            errorCode: 'JOB_DEADLINE_EXCEEDED',
            message: `Job deadline (${job.deadline_at}) exceeded before publication`,
            dbNowIso,
          });

          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'JOB_DEADLINE_EXCEEDED',
            state: 'failed',
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
            artifacts: [],
          };
        }

        // 6. Asset revocation check before publication (docs/SECURITY.md line 61)
        const revokedAssetId = this.findRevokedAssetInSnapshotInTx(tx, job.snapshot_json);
        if (revokedAssetId) {
          if (this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(
              input.tenantId,
              input.jobId,
              input.attemptId,
            );
          }
          tx.updateScoped(
            'job_attempts',
            {
              state: 'failed',
              ended_at: dbNowIso,
              cpu_seconds: input.cpuSeconds,
              peak_rss_bytes: input.peakRssBytes,
              error_json: JSON.stringify({
                code: 'ASSET_REVOKED',
                message: `Referenced asset '${revokedAssetId}' was revoked before publication`,
                retryable: false,
              }),
            },
            'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
            [job.id, input.attemptId, input.leaseEpoch],
          );

          this.transitionJobToTerminalFailedInTx(tx, {
            tenantId: input.tenantId,
            jobId: job.id,
            stateVersion: job.state_version,
            leaseEpoch: currentEpoch,
            errorCode: 'ASSET_REVOKED',
            message: `Referenced asset '${revokedAssetId}' was revoked before publication`,
            dbNowIso,
          });

          return {
            published: false,
            shouldAbortWorker: true,
            reason: 'ASSET_REVOKED',
            state: 'failed',
            stateVersion: job.state_version + 1,
            leaseEpoch: currentEpoch + 1,
            artifacts: [],
          };
        }

        // 7. Promote temp files and insert artifact records (fenced by attempt_id)
        const publishedArtifacts: Array<{
          id: string;
          kind: string;
          mime_type: string;
          sha256: string;
          bytes: number;
          storage_key: string;
        }> = [];

        for (const descriptor of input.artifacts) {
          const artifactId =
            descriptor.id ?? `art_${job.id}_${descriptor.kind}`;
          let storageKey = `tenant/${input.tenantId}/job/${job.id}/${input.attemptId}/${descriptor.filename}`;
          let finalBytes = descriptor.bytes;
          let finalSha256 = descriptor.sha256;

          if (this.quarantineStore) {
            const promoted = this.quarantineStore.promoteAttemptArtifactToPermanent(
              input.tenantId,
              job.id,
              input.attemptId,
              descriptor.filename,
              descriptor.buffer,
            );
            storageKey = promoted.storageKey;
            finalBytes = promoted.bytes;
            finalSha256 = promoted.sha256;
          }

          tx.insertScoped('artifacts', {
            tenant_id: input.tenantId,
            id: artifactId,
            job_id: job.id,
            attempt_id: input.attemptId,
            kind: descriptor.kind,
            mime_type: descriptor.mimeType,
            sha256: finalSha256,
            bytes: finalBytes,
            storage_key: storageKey,
            expires_at: artifactExpiresIso,
            revoked_at: null,
            created_at: dbNowIso,
          });

          publishedArtifacts.push({
            id: artifactId,
            kind: descriptor.kind,
            mime_type: descriptor.mimeType,
            sha256: finalSha256,
            bytes: finalBytes,
            storage_key: storageKey,
          });
        }

        if (this.quarantineStore) {
          this.quarantineStore.cleanupAttemptTempDir(
            input.tenantId,
            job.id,
            input.attemptId,
          );
        }

        const cpuSeconds = Math.max(0, Number(input.cpuSeconds.toFixed(6)));
        const peakRssBytes = Math.max(0, Math.round(input.peakRssBytes));
        const nextStateVersion = job.state_version + 1;

        // 8. Update job_attempts to succeeded
        tx.updateScoped(
          'job_attempts',
          {
            state: 'succeeded',
            heartbeat_at: dbNowIso,
            ended_at: dbNowIso,
            cpu_seconds: cpuSeconds,
            peak_rss_bytes: peakRssBytes,
          },
          'job_id = ? AND attempt_id = ? AND lease_epoch = ?',
          [job.id, input.attemptId, input.leaseEpoch],
        );

        // 9. Settle usage_reservations and write operational + billable usage_entries
        const reservations = tx.selectScoped<{
          reserved_vcpu_seconds: number;
          reserved_output_seconds: number;
        }>('usage_reservations', 'job_id = ?', [job.id]);
        const reservedOutputSeconds = Number(
          reservations[0]?.reserved_output_seconds ?? input.outputSeconds ?? 0,
        );
        const effectiveOutputSeconds =
          typeof input.outputSeconds === 'number'
            ? input.outputSeconds
            : reservedOutputSeconds;

        tx.updateScoped(
          'usage_reservations',
          {
            state: 'settled',
            settled_at: dbNowIso,
          },
          "job_id = ? AND state = 'reserved'",
          [job.id],
        );

        this.insertOperationalCpuUsageInTx(tx, {
          tenantId: input.tenantId,
          jobId: job.id,
          attemptId: input.attemptId,
          cpuSeconds,
          reason: `attempt_${job.attempt_count}_succeeded`,
          dbNowIso,
        });

        const billableOutputMinutes = Number((effectiveOutputSeconds / 60).toFixed(6));
        tx.insertScoped('usage_entries', {
          tenant_id: input.tenantId,
          id: `use_bill_${job.id}`,
          job_id: job.id,
          attempt_id: input.attemptId,
          usage_class: 'billable',
          meter: 'billable_output_minutes',
          ledger_version: 1,
          quantity: billableOutputMinutes,
          rate_version: 'starter-v1',
          reason: 'terminal_succeeded_settlement',
          created_at: dbNowIso,
        });

        // 10. Update jobs to terminal succeeded
        const updatedJobs = tx.updateScoped(
          'jobs',
          {
            state: 'succeeded',
            stage: 'complete',
            progress: 1.0,
            state_version: nextStateVersion,
            active_attempt_id: null,
            lease_expires_at: null,
            heartbeat_at: dbNowIso,
            completed_at: dbNowIso,
            error_json: null,
            updated_at: dbNowIso,
          },
          "id = ? AND active_attempt_id = ? AND lease_epoch = ? AND state = 'verifying'",
          [job.id, input.attemptId, input.leaseEpoch],
        );

        if (updatedJobs === 0) {
          throw new StaleWorkerFenceError(job.id, input.attemptId, input.leaseEpoch);
        }

        // 11. Append monotonic job.succeeded event and transactional outbox record
        const nextEventSeq = this.getNextEventSeqInTx(tx, job.id);
        tx.insertScoped('job_events', {
          tenant_id: input.tenantId,
          job_id: job.id,
          event_seq: nextEventSeq,
          state: 'succeeded',
          state_version: nextStateVersion,
          event_type: 'job.succeeded',
          payload_json: JSON.stringify({
            stage: 'complete',
            progress_percent: 100,
            attempt_id: input.attemptId,
            lease_epoch: input.leaseEpoch,
            artifacts: publishedArtifacts.map((a) => ({
              id: a.id,
              kind: a.kind,
              mime_type: a.mime_type,
            })),
            message: 'Job verified and published successfully',
          }),
          created_at: dbNowIso,
        });

        tx.insertScoped('outbox', {
          tenant_id: input.tenantId,
          id: `out_${crypto.randomBytes(6).toString('hex')}`,
          event_type: 'job.succeeded',
          job_id: job.id,
          state_version: nextStateVersion,
          payload_json: JSON.stringify({
            job_id: job.id,
            kind: job.kind,
            profile: job.profile,
            state: 'succeeded',
            state_version: nextStateVersion,
            attempt_id: input.attemptId,
            lease_epoch: input.leaseEpoch,
            artifacts: publishedArtifacts.map((a) => ({
              id: a.id,
              kind: a.kind,
              mime_type: a.mime_type,
              sha256: a.sha256,
              bytes: a.bytes,
            })),
          }),
          created_at: dbNowIso,
          processed_at: null,
        });

        return {
          published: true,
          shouldAbortWorker: false,
          reason: 'PUBLISHED',
          state: 'succeeded',
          stateVersion: nextStateVersion,
          leaseEpoch: currentEpoch,
          artifacts: publishedArtifacts,
        };
      },
    );
  }

  // --------------------------------------------------------------------------
  // Internal Transaction Helpers
  // --------------------------------------------------------------------------

  private getNextEventSeqInTx(tx: TenantTransactionContext, jobId: string): number {
    const existing = tx.selectScoped<{ event_seq: number }>(
      'job_events',
      'job_id = ?',
      [jobId],
      'event_seq DESC',
    );
    return (existing[0]?.event_seq ?? 0) + 1;
  }

  private insertOperationalCpuUsageInTx(
    tx: TenantTransactionContext,
    input: {
      tenantId: string;
      jobId: string;
      attemptId: string;
      cpuSeconds: number;
      reason: string;
      dbNowIso: string;
    },
  ): void {
    const existingCpu = tx.selectScoped<{ ledger_version: number }>(
      'usage_entries',
      "job_id = ? AND meter = 'cpu_seconds'",
      [input.jobId],
      'ledger_version DESC',
    );
    const nextLedgerVersion = Number(existingCpu[0]?.ledger_version ?? 0) + 1;

    tx.insertScoped('usage_entries', {
      tenant_id: input.tenantId,
      id: `use_cpu_${input.jobId}_v${nextLedgerVersion}`,
      job_id: input.jobId,
      attempt_id: input.attemptId,
      usage_class: 'operational',
      meter: 'cpu_seconds',
      ledger_version: nextLedgerVersion,
      quantity: Number(input.cpuSeconds.toFixed(6)),
      rate_version: 'starter-v1',
      reason: input.reason,
      created_at: input.dbNowIso,
    });
  }

  private finalizeCancelRequestedInTx(
    tx: TenantTransactionContext,
    input: {
      tenantId: string;
      jobId: string;
      attemptId: string;
      stateVersion: number;
      leaseEpoch: number;
      cpuSeconds?: number;
      peakRssBytes?: number;
      dbNowIso: string;
    },
  ): void {
    const nextStateVersion = input.stateVersion + 1;
    const nextLeaseEpoch = input.leaseEpoch + 1;

    tx.updateScoped(
      'job_attempts',
      {
        state: 'canceled',
        ended_at: input.dbNowIso,
        ...(input.cpuSeconds !== undefined ? { cpu_seconds: input.cpuSeconds } : {}),
        ...(input.peakRssBytes !== undefined ? { peak_rss_bytes: input.peakRssBytes } : {}),
      },
      'job_id = ? AND attempt_id = ?',
      [input.jobId, input.attemptId],
    );

    tx.updateScoped(
      'jobs',
      {
        state: 'canceled',
        stage: 'canceled',
        state_version: nextStateVersion,
        lease_epoch: nextLeaseEpoch,
        active_attempt_id: null,
        lease_expires_at: null,
        completed_at: input.dbNowIso,
        updated_at: input.dbNowIso,
      },
      'id = ?',
      [input.jobId],
    );

    tx.updateScoped(
      'usage_reservations',
      { state: 'released', settled_at: input.dbNowIso },
      "job_id = ? AND state = 'reserved'",
      [input.jobId],
    );

    const nextEventSeq = this.getNextEventSeqInTx(tx, input.jobId);
    tx.insertScoped('job_events', {
      tenant_id: input.tenantId,
      job_id: input.jobId,
      event_seq: nextEventSeq,
      state: 'canceled',
      state_version: nextStateVersion,
      event_type: 'job.canceled',
      payload_json: JSON.stringify({
        stage: 'canceled',
        attempt_id: input.attemptId,
        message: 'Active worker aborted execution on cancel_requested',
      }),
      created_at: input.dbNowIso,
    });

    tx.insertScoped('outbox', {
      tenant_id: input.tenantId,
      id: `out_${crypto.randomBytes(6).toString('hex')}`,
      event_type: 'job.canceled',
      job_id: input.jobId,
      state_version: nextStateVersion,
      payload_json: JSON.stringify({
        job_id: input.jobId,
        state: 'canceled',
        state_version: nextStateVersion,
      }),
      created_at: input.dbNowIso,
      processed_at: null,
    });
  }

  private transitionJobToTerminalFailedInTx(
    tx: TenantTransactionContext,
    input: {
      tenantId: string;
      jobId: string;
      stateVersion: number;
      leaseEpoch: number;
      errorCode: CanonicalJobErrorCode;
      message: string;
      dbNowIso: string;
    },
  ): void {
    const nextStateVersion = input.stateVersion + 1;
    const nextLeaseEpoch = input.leaseEpoch + 1;
    const errorPayload = {
      code: input.errorCode,
      message: input.message,
      retryable: false,
    };

    tx.updateScoped(
      'jobs',
      {
        state: 'failed',
        stage: 'failed',
        state_version: nextStateVersion,
        lease_epoch: nextLeaseEpoch,
        active_attempt_id: null,
        lease_expires_at: null,
        error_json: JSON.stringify(errorPayload),
        completed_at: input.dbNowIso,
        updated_at: input.dbNowIso,
      },
      'id = ?',
      [input.jobId],
    );

    tx.updateScoped(
      'usage_reservations',
      { state: 'released', settled_at: input.dbNowIso },
      "job_id = ? AND state = 'reserved'",
      [input.jobId],
    );

    const nextEventSeq = this.getNextEventSeqInTx(tx, input.jobId);
    tx.insertScoped('job_events', {
      tenant_id: input.tenantId,
      job_id: input.jobId,
      event_seq: nextEventSeq,
      state: 'failed',
      state_version: nextStateVersion,
      event_type: 'job.failed',
      payload_json: JSON.stringify({
        stage: 'failed',
        progress_percent: 0,
        error_code: input.errorCode,
        message: input.message,
      }),
      created_at: input.dbNowIso,
    });

    tx.insertScoped('outbox', {
      tenant_id: input.tenantId,
      id: `out_${crypto.randomBytes(6).toString('hex')}`,
      event_type: 'job.failed',
      job_id: input.jobId,
      state_version: nextStateVersion,
      payload_json: JSON.stringify({
        job_id: input.jobId,
        state: 'failed',
        state_version: nextStateVersion,
        error: errorPayload,
      }),
      created_at: input.dbNowIso,
      processed_at: null,
    });
  }

  private findRevokedAssetInSnapshotInTx(
    tx: TenantTransactionContext,
    snapshotJson: string,
  ): string | null {
    try {
      const parsed = JSON.parse(snapshotJson) as Record<string, unknown>;
      const assetIds = new Set<string>();

      if (Array.isArray(parsed['resolved_assets'])) {
        for (const item of parsed['resolved_assets'] as Array<{ asset_id?: string }>) {
          if (item?.asset_id) {
            assetIds.add(item.asset_id);
          }
        }
      }

      const spec = (parsed['spec'] ?? parsed) as CompositionSpec | undefined;
      if (spec && typeof spec === 'object') {
        for (const font of spec.fonts ?? []) {
          if (font?.asset_id) assetIds.add(font.asset_id);
        }
        for (const track of spec.audio_tracks ?? []) {
          if (track?.asset_id) assetIds.add(track.asset_id);
        }
        for (const scene of spec.scenes ?? []) {
          const layers = 'layers' in scene && Array.isArray(scene.layers) ? scene.layers : [];
          for (const layer of layers) {
            const content = layer.content as unknown as Record<string, unknown>;
            if (
              (layer.type === 'image' || layer.type === 'video' || layer.type === 'svg') &&
              typeof content?.['asset_id'] === 'string'
            ) {
              assetIds.add(content['asset_id']);
            }
          }
        }
      }

      for (const assetId of assetIds) {
        const rows = tx.selectScoped<{
          id: string;
          status: string;
          deleted_at: string | null;
        }>('assets', 'id = ?', [assetId]);
        const asset = rows[0];
        if (!asset || asset.status !== 'ready' || asset.deleted_at !== null) {
          return assetId;
        }
      }
    } catch {
      // ignore parse errors
    }
    return null;
  }

  private parseJobSnapshot(
    snapshotJson: string,
    jobRow: {
      kind: 'render' | 'preview';
      profile: 'mp4-720p-v1' | 'preview-360p-v1';
      composition_id: string;
      composition_revision: number;
    },
  ): PinnedJobSnapshot {
    const parsed = JSON.parse(snapshotJson) as Record<string, unknown>;
    if (parsed['spec'] && typeof parsed['spec'] === 'object') {
      return parsed as unknown as PinnedJobSnapshot;
    }
    return {
      schema_version: '1.0',
      kind: jobRow.kind,
      profile: jobRow.profile,
      composition_id: jobRow.composition_id,
      composition_revision: jobRow.composition_revision,
      spec: parsed as unknown as CompositionSpec,
    };
  }
}
