/**
 * Job lifecycle states, transitions, and error codes.
 * Canonical specification: docs/ARCHITECTURE.md and docs/API.md
 */

export type JobKind = 'render' | 'preview';

export type JobState =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'cancel_requested'
  | 'retry_wait';

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set<JobState>([
  'succeeded',
  'failed',
  'canceled',
]);

export function isTerminalJobState(state: JobState): boolean {
  return TERMINAL_JOB_STATES.has(state);
}

export type JobErrorCode =
  | 'JOB_DEADLINE_EXCEEDED'
  | 'ASSET_REVOKED'
  | 'UNSUPPORTED_CAPABILITY'
  | 'PROFILE_CONSTRAINT_VIOLATED'
  | 'CAPABILITY_DISABLED'
  | 'EXECUTION_TIMEOUT'
  | 'RESOURCE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR'
  | 'VALIDATION_FAILED';

export interface JobErrorDetail {
  code: JobErrorCode;
  message: string;
  retryable: boolean;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface JobAttempt {
  attempt_id: string;
  job_id: string;
  tenant_id: string;
  lease_epoch: number;
  worker_id: string;
  started_at: string;
  ended_at?: string;
  state: JobState;
  error?: JobErrorDetail;
}

export interface JobEvent {
  event_seq: number;
  job_id: string;
  tenant_id: string;
  timestamp: string;
  state: JobState;
  stage?: string;
  progress_percent?: number;
  message?: string;
}
