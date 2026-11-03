/**
 * REST API v1 models and contracts for Creativanta Video Engine.
 * Canonical specification: docs/API.md and packages/contracts/schemas/openapi.json
 */

import { CompositionSpec } from './scene.js';
import { JobKind, JobState } from './job.js';

export interface PaginatedResponse<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ErrorDetail {
  pointer: string;
  code: string;
  message: string;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: ErrorDetail[];
  };
}

// ---------------------------------------------------------------------------
// Template Contracts
// ---------------------------------------------------------------------------

export interface TemplateSummary {
  id: string;
  revision: number;
  name: string;
  visibility: 'curated' | 'tenant';
  created_at: string;
}

export interface TemplateDetail {
  id: string;
  revision: number;
  name: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  composition_spec: Record<string, unknown>;
  supported_locales: string[];
  source_digest: string;
}

export interface TemplateCreateRequest {
  name: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  composition_spec: Record<string, unknown>;
  supported_locales: ('vi-VN' | 'en-US')[];
  source_template?: {
    id: string;
    revision: number;
  };
}

export interface TemplateRevisionCreateRequest {
  base_revision: number;
  change_note: string;
  name: string;
  variables_schema: Record<string, unknown>;
  defaults: Record<string, unknown>;
  composition_spec: Record<string, unknown>;
  supported_locales: ('vi-VN' | 'en-US')[];
}

export interface TemplateCreateResponse {
  id: string;
  revision: number;
  source_digest: string;
}

export interface TemplateInstantiateRequest {
  template_revision: number;
  name: string;
  variables: Record<string, unknown>;
  locale: 'vi-VN' | 'en-US';
}

export interface TemplateInstantiateResponse {
  id: string;
  revision: number;
  template: {
    id: string;
    revision: number;
  };
  schema_version: '1.0';
  editable: boolean;
}

// ---------------------------------------------------------------------------
// Composition Contracts
// ---------------------------------------------------------------------------

export interface CompositionCreateRequest {
  name: string;
  spec: CompositionSpec;
}

export interface CompositionCreateResponse {
  id: string;
  revision: number;
  name: string;
  created_at: string;
}

export interface CompositionSummary {
  id: string;
  current_revision: number;
  name: string;
  created_at: string;
}

export interface CompositionRevisionDetail {
  id: string;
  revision: number;
  spec: CompositionSpec;
  render_hash: string;
  created_at: string;
}

export interface CompositionRevisionCreateRequest {
  base_revision: number;
  change_note?: string;
  spec: CompositionSpec;
}

export interface CompositionRevisionResponse {
  id: string;
  revision: number;
  render_hash: string;
  created_at: string;
}

export interface CompositionValidationRequest {
  spec: CompositionSpec;
  profile?: 'mp4-720p-v1' | 'preview-360p-v1';
  base_composition_id?: string;
  base_revision?: number;
}

export interface CompositionValidationEstimate {
  output_seconds: number;
  estimated_cost: number;
  currency: string;
  rate_version: string;
}

export interface CompositionValidationResponse {
  valid: boolean;
  normalized_spec: CompositionSpec;
  render_hash: string;
  required_capabilities: string[];
  estimate: CompositionValidationEstimate;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Asset Contracts
// ---------------------------------------------------------------------------

export interface AssetRights {
  basis: 'owned' | 'licensed' | 'public_domain';
  source: string;
  attribution: string;
  expires_at?: string | null;
}

export interface AssetUploadRequest {
  filename: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  rights: AssetRights;
}

export interface AssetUploadResponse {
  asset_id: string;
  upload_method: 'PUT';
  upload_url: string;
  required_headers: Record<string, string>;
  expires_at: string;
  max_bytes: number;
}

export interface AssetRefreshUrlResponse {
  upload_url: string;
  expires_at: string;
  required_headers: Record<string, string>;
}

export interface AssetCompleteRequest {
  sha256: string;
}

export interface AssetImportRequest {
  url: string;
  expected_sha256: string;
  rights: AssetRights;
}

export type AssetStatus = 'uploading' | 'processing' | 'ready' | 'rejected' | 'deleted';

export interface AssetSummary {
  id: string;
  status: AssetStatus;
}

export interface AssetDetail {
  id: string;
  status: AssetStatus;
  filename: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Job Contracts
// ---------------------------------------------------------------------------

export interface PreviewJobCreateRequest {
  composition_id: string;
  revision: number;
  mode: 'frame' | 'clip';
  frame_index?: number;
  start_frame?: number;
  duration_frames?: number;
  profile: 'preview-360p-v1';
  webhook_endpoint_id?: string;
}

export interface RenderJobCreateRequest {
  composition_id: string;
  revision: number;
  profile: 'mp4-720p-v1';
  webhook_endpoint_id?: string;
  client_reference?: string;
  metadata?: Record<string, string>;
}

export interface JobSummary {
  id: string;
  kind: JobKind;
  state: JobState;
  state_version: number;
  composition_id: string;
  revision: number;
  profile: string;
  created_at: string;
  status_url: string;
}

export interface ArtifactDetail {
  id: string;
  kind: 'video' | 'manifest' | 'thumbnail' | 'captions' | 'quality_report';
  mime_type: string;
}

export interface JobUsage {
  output_seconds?: number;
  cpu_seconds?: number;
  billable_output_minutes?: number;
}

export interface JobDetail {
  id: string;
  kind: JobKind;
  state: JobState;
  state_version: number;
  stage: string;
  progress: number;
  attempt: number;
  max_attempts: number;
  composition_id: string;
  revision: number;
  profile: string;
  artifacts: ArtifactDetail[];
  usage: JobUsage;
  error: Record<string, unknown> | null;
  created_at: string;
  completed_at?: string | null;
}

export interface JobCancelResponse {
  id: string;
  state: JobState;
  state_version: number;
}

export interface ArtifactDownloadResponse {
  url: string;
  expires_at: string;
  sha256: string;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Webhook Contracts
// ---------------------------------------------------------------------------

export interface WebhookEndpointCreateRequest {
  url: string;
  events: string[];
}

export interface WebhookEndpointCreateResponse {
  id: string;
  url: string;
  state: 'pending_verification' | 'active' | 'disabled';
  signing_secret: string;
  events: string[];
  created_at: string;
}

export interface WebhookVerifyResponse {
  id: string;
  status: 'challenge_dispatched';
}

export interface WebhookEndpointDetail {
  id: string;
  url: string;
  state: 'pending_verification' | 'active' | 'disabled';
  events: string[];
  created_at: string;
  last_delivery_at?: string | null;
}

export interface WebhookRotateSecretResponse {
  id: string;
  new_signing_secret: string;
  previous_valid_until: string;
}

export interface WebhookDeliverySummary {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  status: 'queued' | 'delivered' | 'failed' | 'dead_letter';
  http_status?: number | null;
  created_at: string;
}

export interface WebhookDeliveryReplayResponse {
  delivery_id: string;
  event_id: string;
  status: 'queued';
}

// ---------------------------------------------------------------------------
// Usage Contracts
// ---------------------------------------------------------------------------

export interface UsageResponse {
  from: string;
  to: string;
  operational_attempts: number;
  billable_output_minutes: number;
  estimated_cost: number;
  currency: string;
}
