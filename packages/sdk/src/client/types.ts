/**
 * Creativanta Client & Contract Types (Tasks P5-03 & P5-04).
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md: Task P5-03 & P5-04 (Creativanta typed client,
 *     external_reference/idempotency, signed webhook receiver, polling reconciliation,
 *     cancel, download-expiry refresh, v1 compatibility; no shared DB assumptions)
 *   - docs/API.md: REST API v1 contracts, idempotency headers, signed webhook lifecycle,
 *     download grant expiry and refresh semantics.
 */

import type { JobKind, JobState } from '@creativanta/contracts';

export interface CreativantaClientConfig {
  /** API Base URL (e.g. https://video.creativanta.example or http://127.0.0.1:8080/v1) */
  baseUrl: string;
  /** Bearer API Key for tenant authorization (use placeholders in examples/docs) */
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
  /** Optional AbortSignal to cancel in-flight HTTP request */
  signal?: AbortSignal;
}

export interface CreateRenderJobOptions extends IdempotencyOptions {
  compositionId: string;
  revision: number;
  profile?: 'mp4-720p-v1' | string;
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
  profile?: 'preview-360p-v1' | string;
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

// =========================================================================
// Extended Typed API Types (Task P5-04)
// =========================================================================

export interface CapabilitiesProfile {
  id: string;
  dimensions: { width: number; height: number };
  fps: { num: number; den: number };
  container: string;
  codecs: { video: string; audio: string };
  max_duration_seconds: number;
  supported: boolean;
}

export interface CapabilitiesResponse {
  api_version: string;
  scene_schema_versions: string[];
  engines: Record<string, boolean>;
  profiles: CapabilitiesProfile[];
  limits: {
    max_scenes: number;
    max_layers_per_scene: number;
    max_duration_frames: number;
    max_body_bytes: number;
    max_upload_bytes: number;
    max_concurrent_jobs: number;
  };
  features: {
    remote_import_enabled: boolean;
    custom_code_enabled: boolean;
    authoring_provider: string;
    tts_provider: string;
  };
  policy_version?: string;
}

export interface CompositionResponse {
  id: string;
  revision: number;
  name?: string;
  template?: { id: string; revision: number };
  schema_version: string;
  editable: boolean;
  spec?: Record<string, unknown>;
  created_at?: string;
  isReplayed?: boolean;
}

export interface ValidateCompositionOptions extends IdempotencyOptions {
  spec: Record<string, unknown>;
  profile: string;
  baseCompositionId?: string;
  baseRevision?: number;
}

export interface ValidateCompositionResult {
  valid: boolean;
  normalized_spec?: Record<string, unknown>;
  render_hash?: string;
  required_capabilities?: string[];
  estimate?: {
    output_seconds: number;
    estimated_cost?: number;
    currency?: string;
    rate_version?: string;
  };
  warnings?: Array<{ code: string; message: string; pointer?: string }>;
}

export interface CreateCompositionOptions extends IdempotencyOptions {
  name: string;
  spec: Record<string, unknown>;
}

export interface CreateCompositionRevisionOptions extends IdempotencyOptions {
  baseRevision: number;
  spec: Record<string, unknown>;
  changeNote?: string;
}

export interface TemplateResponse {
  id: string;
  name: string;
  current_revision: number;
  visibility: 'curated' | 'tenant';
  created_at?: string;
  updated_at?: string;
}

export interface TemplateRevisionResponse {
  id: string;
  revision: number;
  name: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  composition_spec: Record<string, unknown>;
  supported_locales: string[];
  required_capabilities?: string[];
  source_digest?: string;
}

export interface CreateTemplateOptions extends IdempotencyOptions {
  name: string;
  variablesSchema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  compositionSpec: Record<string, unknown>;
  supportedLocales: string[];
  sourceTemplate?: { id: string; revision: number };
}

export interface CreateTemplateRevisionOptions extends IdempotencyOptions {
  baseRevision: number;
  name?: string;
  variablesSchema?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  compositionSpec?: Record<string, unknown>;
  supportedLocales?: string[];
  changeNote?: string;
}

export interface AssetUploadInitiateOptions extends IdempotencyOptions {
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  rights: {
    basis: 'owned' | 'licensed' | 'public_domain';
    source: string;
    attribution: string;
    expires_at?: string;
  };
}

export interface AssetUploadInitiateResponse {
  asset_id: string;
  upload_method: string;
  upload_url: string;
  expires_at: string;
  max_bytes?: number;
  isReplayed?: boolean;
}

export interface RegisterWebhookEndpointOptions extends IdempotencyOptions {
  url: string;
  events: string[];
  description?: string;
}

export interface WebhookEndpointRecord {
  id: string;
  url: string;
  events: string[];
  status: 'pending' | 'active' | 'disabled';
  created_at: string;
  last_delivery_at?: string | null;
}

export interface RotateSecretResponse {
  endpoint_id: string;
  key_id: string;
  signing_secret: string;
  previous_key_expires_at: string;
}

export interface UsageQueryOptions {
  from: string;
  to: string;
}

export interface UsageResponse {
  from: string;
  to: string;
  operational: {
    total_attempts: number;
    cpu_seconds: number;
  };
  billable: {
    succeeded_jobs: number;
    output_seconds: number;
    billable_output_minutes: number;
  };
}
