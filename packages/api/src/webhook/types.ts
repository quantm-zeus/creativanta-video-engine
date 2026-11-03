/**
 * Webhook Types, Constants & Policies (Task P4-04).
 *
 * Canonical specifications:
 *   - docs/API.md ("Signed webhooks", lines 45-51, 141-152)
 *   - docs/SECURITY.md ("Webhook -> client boundary", lines 25-33)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P4-04)
 */

export type WebhookEndpointState = 'pending_verification' | 'active' | 'disabled';

export type WebhookDeliveryState = 'queued' | 'delivered' | 'failed' | 'dead_letter';

export type WebhookEventType =
  | 'job.succeeded'
  | 'job.failed'
  | 'job.canceled'
  | 'endpoint.challenge';

export const ALLOWED_WEBHOOK_EVENT_TYPES: readonly WebhookEventType[] = [
  'job.succeeded',
  'job.failed',
  'job.canceled',
  'endpoint.challenge',
] as const;

export const DEFAULT_WEBHOOK_EVENTS: readonly string[] = [
  'job.succeeded',
  'job.failed',
  'job.canceled',
] as const;

/**
 * Standard retry backoff schedule in seconds across 8 attempts total:
 * t = 0, 1min, 5min, 15min, 1h, 4h, 12h, 24h (+jitter <= 10%)
 */
export const WEBHOOK_RETRY_SCHEDULE_SECONDS: readonly number[] = [
  0,      // Attempt 1: immediate (t = 0)
  60,     // Attempt 2: 1 min
  300,    // Attempt 3: 5 min
  900,    // Attempt 4: 15 min
  3600,   // Attempt 5: 1 hour
  14400,  // Attempt 6: 4 hours
  43200,  // Attempt 7: 12 hours
  86400,  // Attempt 8: 24 hours
] as const;

export const MAX_WEBHOOK_ATTEMPTS = 8;

/**
 * Hard deadline for all attempts of a single webhook delivery:
 * 25 hours from initial creation (90,000 seconds).
 */
export const MAX_DELIVERY_DEADLINE_SECONDS = 25 * 3600; // 25 hours
export const MAX_DELIVERY_DEADLINE_MS = MAX_DELIVERY_DEADLINE_SECONDS * 1000;

/**
 * Maximum clock skew permitted on webhook timestamp header: 300 seconds (5 minutes).
 */
export const WEBHOOK_MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Maximum lifetime for challenge token: 10 minutes (600 seconds).
 */
export const WEBHOOK_CHALLENGE_TTL_SECONDS = 600;

/**
 * Secret rotation grace period: 24 hours (86,400 seconds).
 */
export const WEBHOOK_SECRET_ROTATION_GRACE_SECONDS = 24 * 3600;

/**
 * Maximum daily replays per delivery: 5 replays/day.
 */
export const MAX_REPLAYS_PER_DAY = 5;

/**
 * Maximum replay retention window from event creation: 7 days.
 */
export const WEBHOOK_REPLAY_RETENTION_DAYS = 7;
export const WEBHOOK_REPLAY_RETENTION_MS = WEBHOOK_REPLAY_RETENTION_DAYS * 24 * 3600 * 1000;

/**
 * Webhook HTTP delivery client timeouts and response limits.
 */
export const WEBHOOK_CONNECT_TIMEOUT_MS = 2000; // 2 seconds
export const WEBHOOK_TOTAL_TIMEOUT_MS = 5000;   // 5 seconds
export const WEBHOOK_MAX_RESPONSE_BYTES = 8192; // 8 KiB cap

export interface WebhookEndpointRecord extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  url: string;
  state: WebhookEndpointState;
  events_filter_json: string;
  active_key_id: string;
  secret_ciphertext: string;
  prev_key_id: string | null;
  prev_secret_ciphertext: string | null;
  prev_secret_expires_at: string | null;
  challenge_token_hash: string | null;
  challenge_expires_at: string | null;
  created_at: string;
  updated_at: string;
  last_delivery_at: string | null;
}

export interface WebhookDeliveryRecord extends Record<string, unknown> {
  tenant_id: string;
  id: string;
  endpoint_id: string;
  outbox_event_id: string;
  job_id: string;
  state: WebhookDeliveryState;
  attempt_count: number;
  next_attempt_at: string | null;
  deadline_at: string;
  last_http_status: number | null;
  replay_count_today: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventPayload<T = unknown> {
  id: string;
  type: string;
  api_version: 'v1';
  created_at: string;
  data: T;
}

export interface JobEventData {
  job_id: string;
  state: string;
  state_version: number;
  client_reference?: string | null;
  artifact_ids?: string[];
  error?: {
    code: string;
    message: string;
  } | null;
}

export interface ChallengeEventData {
  endpoint_id: string;
  challenge: string;
}
