/**
 * Creativanta Client & Contract Types (Task P5-03).
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md: Task P5-03 (Creativanta mock/contract client:
 *     external_reference/idempotency, signed webhook receiver, polling reconciliation,
 *     cancel, download-expiry refresh; no shared DB assumptions)
 *   - docs/API.md: REST API v1 contracts, idempotency headers, signed webhook lifecycle,
 *     download grant expiry and refresh semantics.
 */

import type { JobKind, JobState } from '@creativanta/contracts';

export interface CreativantaClientConfig {
  /** API Base URL (e.g. https://video.creativanta.example or http://127.0.0.1:8080/v1) */
  baseUrl: string;
  /** Bearer API Key for tenant authorization */
  apiKey: string;
  /** Default webhook endpoint ID to attach to created jobs */
  defaultWebhookEndpointId?: string;
  /** Default request timeout in milliseconds (default: 10000ms) */
  timeoutMs?: number;
  /** Max automatic retries for transient errors (429, 503, network) with identical Idempotency-Key */
  maxRetries?: number;
  /** Base retry delay in milliseconds (default: 500ms) */
  retryBackoffBaseMs?: number;
  /** Optional custom fetch implementation for mocking or runtime interception */
  customFetch?: typeof fetch;
  /** Optional clock function for time-dependent operations */
  clock?: () => Date;
}

export interface IdempotencyOptions {
  /**
   * Explicit Idempotency-Key (1–128 ASCII [A-Za-z0-9._:-]).
   * If omitted, a unique key (e.g. cve_<uuid>) is automatically generated.
   */
  idempotencyKey?: string;
}

export interface CreateRenderJobOptions extends IdempotencyOptions {
  compositionId: string;
  revision: number;
  profile?: 'mp4-720p-v1';
  webhookEndpointId?: string;
  /** Creativanta internal tracking identifier (maps to client_reference on server) */
  externalReference?: string;
  /** Direct client_reference field */
  clientReference?: string;
  /** Optional key-value metadata string map */
  metadata?: Record<string, string>;
}

export interface CreatePreviewJobOptions extends IdempotencyOptions {
  compositionId: string;
  revision: number;
  mode: 'frame' | 'clip';
  frameIndex?: number;
  startFrame?: number;
  durationFrames?: number;
  profile?: 'preview-360p-v1';
  webhookEndpointId?: string;
  externalReference?: string;
  clientReference?: string;
  metadata?: Record<string, string>;
}

export interface AdmittedJobResponse {
  id: string;
  kind: JobKind;
  state: JobState;
  state_version: number;
  composition_id: string;
  revision: number;
  profile: string;
  created_at: string;
  status_url: string;
  /** Indicates whether this response was replayed from an existing idempotency record */
  isReplayed: boolean;
}

export interface ArtifactSummary {
  id: string;
  kind: 'video' | 'thumbnail' | 'captions' | 'manifest' | 'audio' | string;
  mime_type: string;
  sha256?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration_seconds?: number;
}

export interface JobUsageSummary {
  output_seconds?: number;
  cpu_seconds?: number;
  billable_output_minutes?: number;
}

export interface JobErrorSummary {
  code: string;
  message: string;
  retryable: boolean;
  request_id?: string;
  details?: unknown[];
}

export interface JobResponse {
  id: string;
  kind: JobKind;
  state: JobState;
  state_version: number;
  stage?: string;
  progress?: number;
  attempt?: number;
  max_attempts?: number;
  composition_id: string;
  revision: number;
  profile: string;
  artifacts: ArtifactSummary[];
  usage: JobUsageSummary;
  error?: JobErrorSummary | null;
  created_at: string;
  completed_at?: string | null;
  client_reference?: string;
}

export interface ArtifactDownloadGrant {
  url: string;
  expires_at: string;
  sha256: string;
  bytes: number;
}

export interface CancelJobOptions extends IdempotencyOptions {
  reason?: string;
}

export interface CancelJobResult {
  id: string;
  state: 'canceled' | 'cancel_requested';
  httpStatus: 200 | 202;
  isReplayed: boolean;
}

export interface PollReconcileOptions {
  /** Initial polling interval in milliseconds (default: 2000ms per docs/API.md line 139) */
  initialIntervalMs?: number;
  /** Maximum interval after exponential backoff (default: 10000ms per docs/API.md line 139) */
  maxIntervalMs?: number;
  /** Exponential backoff multiplier (default: 1.5) */
  backoffFactor?: number;
  /** Total maximum reconciliation timeout before failing (default: 60000ms) */
  timeoutMs?: number;
  /** Abort signal to cancel ongoing polling */
  signal?: AbortSignal;
  /** Optional callback invoked on each received status */
  onPoll?: (job: JobResponse) => void;
  /** Terminal states to consider job done (default: ['succeeded', 'failed', 'canceled']) */
  stopOnStates?: JobState[];
  /** Monotonic state version guard; warns or ignores if server regresses */
  knownStateVersion?: number;
}

export interface WebhookSecretConfig {
  keyId: string;
  secret: string;
  expiresAt?: Date | string | null;
}

export interface WebhookReceiverConfig {
  /** One or more valid signing secrets (supports graceful secret rotation) */
  secrets: WebhookSecretConfig[] | string;
  /** Maximum allowable clock skew in seconds (default: 300s per docs/API.md line 149) */
  maxSkewSeconds?: number;
  /** In-memory deduplication retention period in milliseconds (default: 7 days) */
  retentionMs?: number;
  /** Clock source */
  clock?: () => Date;
}

export interface WebhookVerificationResult<T = any> {
  verified: boolean;
  eventId: string;
  timestamp: number;
  keyId?: string;
  isDuplicate: boolean;
  isStaleStateVersion: boolean;
  payload: WebhookEventPayload<T>;
}

export interface WebhookEventPayload<T = any> {
  id: string;
  type: string;
  api_version: string;
  created_at: string;
  data: T;
}

export interface JobEventData {
  job_id: string;
  state: JobState;
  state_version: number;
  client_reference?: string;
  artifact_ids?: string[];
  challenge?: string;
  error?: JobErrorSummary;
}

export interface DownloadArtifactOptions {
  /** Time buffer before expiry to trigger proactive grant refresh (default: 30000ms = 30s) */
  refreshBufferMs?: number;
  /** Maximum retry attempts if download encounters 410 GRANT_EXPIRED (default: 1) */
  maxRefreshRetries?: number;
  /** Whether to verify SHA-256 and byte length (default: true) */
  verifyIntegrity?: boolean;
  /** Optional AbortSignal */
  signal?: AbortSignal;
}
