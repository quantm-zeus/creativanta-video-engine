/**
 * Job Admission Validation, Capability Enforcement, Resource Reservation,
 * and Snapshot Pinning (Task P4-01).
 *
 * Canonical specifications:
 *   - docs/API.md (lines 9-13, 56, 97-158, 159-170)
 *   - docs/ARCHITECTURE.md (lines 18, 55-63, 88-90)
 *   - docs/PRD.md (lines 108-109)
 *   - docs/SCENE-SPEC.md (lines 13-16, 214)
 */

import { CompositionSpec, ErrorDetail } from '@creativanta/contracts';
import { BodyReferenceValidationError } from '../db/repository.js';

export const DEFAULT_ACTIVE_JOB_SLOTS_MAX = 2;
export const DEFAULT_PENDING_ADMISSION_SLOTS_MAX = 20;
export const DEFAULT_NON_TERMINAL_JOBS_TOTAL_MAX = 22;
export const DEFAULT_MAX_ASSETS_PER_JOB = 50;
export const DEFAULT_MAX_TOTAL_INPUT_BYTES_PER_JOB = 500 * 1024 * 1024; // 500 MiB (524,288,000 bytes)
export const MAX_METADATA_BYTES = 4096;
export const MAX_METADATA_KEYS = 32;
export const MAX_METADATA_KEY_LENGTH = 64;
export const MAX_METADATA_VALUE_LENGTH = 256;
export const MAX_CLIENT_REFERENCE_LENGTH = 128;
export const MAX_PREVIEW_CLIP_DURATION_FRAMES = 300; // 10s at 30fps

export interface TenantPolicyLimits {
  active_job_slots_max: number;
  pending_admission_slots_max: number;
  non_terminal_jobs_total_max: number;
  token_bucket_refill_per_second: number;
  token_bucket_burst_capacity: number;
  api_key_token_bucket_refill_per_second?: number;
  api_key_token_bucket_burst_capacity?: number;
  max_assets_per_job: number;
  max_total_input_bytes_per_job: number;
  max_reserved_vcpu_seconds?: number;
  max_reserved_output_seconds?: number;
  custom_code_enabled?: boolean;
  canvas_engine_enabled?: boolean;
  svg_engine_enabled?: boolean;
  rtl_enabled?: boolean;
}

export class RateLimitedError extends Error {
  public readonly httpStatus = 429;
  public readonly code = 'RATE_LIMITED';
  public readonly retryable = true;
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds = 1, message = 'Request rate limit exceeded; retry after backoff') {
    super(message);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export class QuotaExceededError extends Error {
  public readonly httpStatus = 429;
  public readonly code = 'QUOTA_EXCEEDED';
  public readonly retryable = true;
  public readonly retryAfterSeconds: number;

  constructor(
    message = 'Tenant admission slot or reservation quota exceeded',
    retryAfterSeconds = 5,
  ) {
    super(message);
    this.name = 'QuotaExceededError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export class UnsupportedCapabilityError extends Error {
  public readonly httpStatus = 422;
  public readonly code = 'UNSUPPORTED_CAPABILITY';
  public readonly retryable = false;
  public readonly details: ErrorDetail[];

  constructor(
    details: ErrorDetail[],
    message = 'Composition violates profile constraints or requested capability is disabled',
  ) {
    super(message);
    this.name = 'UnsupportedCapabilityError';
    this.details = details;
  }
}

export class AssetNotReadyError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'ASSET_NOT_READY';
  public readonly retryable = false;

  constructor(message = 'Referenced asset has not completed upload/quarantine verification') {
    super(message);
    this.name = 'AssetNotReadyError';
  }
}

export class WebhookNotVerifiedError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'WEBHOOK_NOT_VERIFIED';
  public readonly retryable = false;

  constructor(message = 'Webhook endpoint has not completed verification or is disabled') {
    super(message);
    this.name = 'WebhookNotVerifiedError';
  }
}

export class JobTerminalError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'JOB_TERMINAL';
  public readonly retryable = false;

  constructor(message = 'Job is already in a terminal state (succeeded or failed) and cannot be canceled') {
    super(message);
    this.name = 'JobTerminalError';
  }
}

export class AdmissionServiceUnavailableError extends Error {
  public readonly httpStatus = 503;
  public readonly code = 'SERVICE_UNAVAILABLE';
  public readonly retryable = true;
  public readonly retryAfterSeconds: number;

  constructor(
    message = 'Database admission transaction could not be durably committed',
    retryAfterSeconds = 2,
  ) {
    super(message);
    this.name = 'AdmissionServiceUnavailableError';
    this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
  }
}

export interface ValidatedRenderJobRequest {
  kind: 'render';
  compositionId: string;
  compositionRevision: number;
  profile: 'mp4-720p-v1';
  webhookEndpointId?: string;
  clientReference?: string;
  metadata?: Record<string, string>;
}

export interface ValidatedPreviewJobRequest {
  kind: 'preview';
  compositionId: string;
  compositionRevision: number;
  mode: 'frame' | 'clip';
  frameIndex?: number;
  startFrame?: number;
  durationFrames?: number;
  profile: 'preview-360p-v1';
  webhookEndpointId?: string;
  clientReference?: string;
  metadata?: Record<string, string>;
}

export type ValidatedJobAdmissionRequest =
  | ValidatedRenderJobRequest
  | ValidatedPreviewJobRequest;

const ALLOWED_RENDER_JOB_FIELDS = new Set([
  'composition_id',
  'revision',
  'profile',
  'webhook_endpoint_id',
  'client_reference',
  'metadata',
]);

const ALLOWED_PREVIEW_JOB_FIELDS = new Set([
  'composition_id',
  'revision',
  'mode',
  'frame_index',
  'start_frame',
  'duration_frames',
  'profile',
  'webhook_endpoint_id',
  'client_reference',
  'metadata',
]);

function validateOptionalJobMetadataAndRefs(
  body: Record<string, unknown>,
  errors: ErrorDetail[],
): {
  webhookEndpointId?: string;
  clientReference?: string;
  metadata?: Record<string, string>;
} {
  let webhookEndpointId: string | undefined;
  if (body['webhook_endpoint_id'] !== undefined) {
    if (
      typeof body['webhook_endpoint_id'] !== 'string' ||
      body['webhook_endpoint_id'].trim().length === 0
    ) {
      errors.push({
        pointer: '/webhook_endpoint_id',
        code: 'INVALID_FIELD_TYPE',
        message: 'webhook_endpoint_id must be a non-empty string when provided',
      });
    } else {
      webhookEndpointId = body['webhook_endpoint_id'].trim();
    }
  }

  let clientReference: string | undefined;
  if (body['client_reference'] !== undefined) {
    if (typeof body['client_reference'] !== 'string') {
      errors.push({
        pointer: '/client_reference',
        code: 'INVALID_FIELD_TYPE',
        message: 'client_reference must be a string',
      });
    } else if (body['client_reference'].length > MAX_CLIENT_REFERENCE_LENGTH) {
      errors.push({
        pointer: '/client_reference',
        code: 'VALUE_OUT_OF_RANGE',
        message: `client_reference exceeds maximum length of ${MAX_CLIENT_REFERENCE_LENGTH} characters`,
      });
    } else {
      clientReference = body['client_reference'];
    }
  }

  let metadata: Record<string, string> | undefined;
  if (body['metadata'] !== undefined) {
    const rawMeta = body['metadata'];
    if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
      errors.push({
        pointer: '/metadata',
        code: 'INVALID_FIELD_TYPE',
        message: 'metadata must be a JSON object mapping string keys to string values',
      });
    } else {
      const metaObj = rawMeta as Record<string, unknown>;
      const keys = Object.keys(metaObj);
      const serializedBytes = Buffer.byteLength(JSON.stringify(metaObj), 'utf8');

      if (serializedBytes > MAX_METADATA_BYTES) {
        errors.push({
          pointer: '/metadata',
          code: 'METADATA_LIMIT_EXCEEDED',
          message: `metadata serialized size (${serializedBytes} bytes) exceeds limit of ${MAX_METADATA_BYTES} bytes (4 KiB)`,
        });
      }
      if (keys.length > MAX_METADATA_KEYS) {
        errors.push({
          pointer: '/metadata',
          code: 'METADATA_LIMIT_EXCEEDED',
          message: `metadata key count (${keys.length}) exceeds limit of ${MAX_METADATA_KEYS} keys`,
        });
      }

      const validatedMeta: Record<string, string> = {};
      for (const k of keys) {
        if (k.length === 0 || k.length > MAX_METADATA_KEY_LENGTH) {
          errors.push({
            pointer: `/metadata/${k}`,
            code: 'METADATA_LIMIT_EXCEEDED',
            message: `metadata key '${k}' length must be between 1 and ${MAX_METADATA_KEY_LENGTH} characters`,
          });
        }
        const val = metaObj[k];
        if (typeof val !== 'string') {
          errors.push({
            pointer: `/metadata/${k}`,
            code: 'INVALID_FIELD_TYPE',
            message: `metadata value for key '${k}' must be a string`,
          });
        } else if (val.length > MAX_METADATA_VALUE_LENGTH) {
          errors.push({
            pointer: `/metadata/${k}`,
            code: 'METADATA_LIMIT_EXCEEDED',
            message: `metadata value for key '${k}' exceeds maximum length of ${MAX_METADATA_VALUE_LENGTH} characters`,
          });
        } else {
          validatedMeta[k] = val;
        }
      }
      metadata = validatedMeta;
    }
  }

  return { webhookEndpointId, clientReference, metadata };
}

/**
 * Validates `POST /v1/render-jobs` request payload per docs/API.md lines 100-105.
 */
export function validateRenderJobRequest(
  body: Record<string, unknown>,
): ValidatedRenderJobRequest {
  const errors: ErrorDetail[] = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_RENDER_JOB_FIELDS.has(key)) {
      errors.push({
        pointer: `/${key}`,
        code: 'UNKNOWN_FIELD',
        message: `Field '${key}' is not allowed in render job creation request`,
      });
    }
  }

  const rawCompId = body['composition_id'];
  if (typeof rawCompId !== 'string' || rawCompId.trim().length === 0) {
    errors.push({
      pointer: '/composition_id',
      code: 'MISSING_REQUIRED_FIELD',
      message: 'composition_id is required and must be a non-empty string',
    });
  }

  const rawRevision = body['revision'];
  if (typeof rawRevision !== 'number' || !Number.isInteger(rawRevision) || rawRevision < 1) {
    errors.push({
      pointer: '/revision',
      code: 'INVALID_FIELD_TYPE',
      message: 'revision is required and must be an integer >= 1',
    });
  }

  const rawProfile = body['profile'];
  if (typeof rawProfile !== 'string' || rawProfile.trim().length === 0) {
    errors.push({
      pointer: '/profile',
      code: 'MISSING_REQUIRED_FIELD',
      message: 'profile is required',
    });
  } else if (rawProfile !== 'mp4-720p-v1') {
    throw new UnsupportedCapabilityError(
      [
        {
          pointer: '/profile',
          code: 'PROFILE_CONSTRAINT_VIOLATED',
          message: `Render profile '${rawProfile}' is not supported on /v1/render-jobs; expected 'mp4-720p-v1'`,
        },
      ],
      `Unsupported render profile '${rawProfile}'`,
    );
  }

  const { webhookEndpointId, clientReference, metadata } =
    validateOptionalJobMetadataAndRefs(body, errors);

  if (errors.length > 0) {
    throw new BodyReferenceValidationError(errors, 'Render job request validation failed');
  }

  return {
    kind: 'render',
    compositionId: (rawCompId as string).trim(),
    compositionRevision: rawRevision as number,
    profile: 'mp4-720p-v1',
    webhookEndpointId,
    clientReference,
    metadata,
  };
}

/**
 * Validates `POST /v1/previews` request payload per docs/API.md lines 97-99.
 */
export function validatePreviewJobRequest(
  body: Record<string, unknown>,
): ValidatedPreviewJobRequest {
  const errors: ErrorDetail[] = [];

  for (const key of Object.keys(body)) {
    if (!ALLOWED_PREVIEW_JOB_FIELDS.has(key)) {
      errors.push({
        pointer: `/${key}`,
        code: 'UNKNOWN_FIELD',
        message: `Field '${key}' is not allowed in preview job creation request`,
      });
    }
  }

  const rawCompId = body['composition_id'];
  if (typeof rawCompId !== 'string' || rawCompId.trim().length === 0) {
    errors.push({
      pointer: '/composition_id',
      code: 'MISSING_REQUIRED_FIELD',
      message: 'composition_id is required and must be a non-empty string',
    });
  }

  const rawRevision = body['revision'];
  if (typeof rawRevision !== 'number' || !Number.isInteger(rawRevision) || rawRevision < 1) {
    errors.push({
      pointer: '/revision',
      code: 'INVALID_FIELD_TYPE',
      message: 'revision is required and must be an integer >= 1',
    });
  }

  const rawProfile = body['profile'];
  if (typeof rawProfile !== 'string' || rawProfile.trim().length === 0) {
    errors.push({
      pointer: '/profile',
      code: 'MISSING_REQUIRED_FIELD',
      message: 'profile is required',
    });
  } else if (rawProfile !== 'preview-360p-v1') {
    throw new UnsupportedCapabilityError(
      [
        {
          pointer: '/profile',
          code: 'PROFILE_CONSTRAINT_VIOLATED',
          message: `Preview profile '${rawProfile}' is not supported on /v1/previews; expected 'preview-360p-v1'`,
        },
      ],
      `Unsupported preview profile '${rawProfile}'`,
    );
  }

  const rawMode = body['mode'];
  if (rawMode !== 'frame' && rawMode !== 'clip') {
    errors.push({
      pointer: '/mode',
      code: 'INVALID_FIELD_TYPE',
      message: "mode is required and must be either 'frame' or 'clip'",
    });
  }

  let frameIndex: number | undefined;
  let startFrame: number | undefined;
  let durationFrames: number | undefined;

  if (rawMode === 'frame') {
    if (body['start_frame'] !== undefined) {
      errors.push({
        pointer: '/start_frame',
        code: 'TIMELINE_BOUNDS',
        message: 'start_frame must not be provided when mode is frame',
      });
    }
    if (body['duration_frames'] !== undefined) {
      errors.push({
        pointer: '/duration_frames',
        code: 'TIMELINE_BOUNDS',
        message: 'duration_frames must not be provided when mode is frame',
      });
    }
    const rawFrameIdx = body['frame_index'];
    if (typeof rawFrameIdx !== 'number' || !Number.isInteger(rawFrameIdx)) {
      errors.push({
        pointer: '/frame_index',
        code: 'MISSING_REQUIRED_FIELD',
        message: 'frame_index is required and must be an integer when mode is frame',
      });
    } else if (rawFrameIdx < 0) {
      errors.push({
        pointer: '/frame_index',
        code: 'TIMELINE_BOUNDS',
        message: `frame_index (${rawFrameIdx}) must be >= 0`,
      });
    } else {
      frameIndex = rawFrameIdx;
    }
  } else if (rawMode === 'clip') {
    if (body['frame_index'] !== undefined) {
      errors.push({
        pointer: '/frame_index',
        code: 'TIMELINE_BOUNDS',
        message: 'frame_index must not be provided when mode is clip',
      });
    }
    const rawStart = body['start_frame'];
    if (typeof rawStart !== 'number' || !Number.isInteger(rawStart)) {
      errors.push({
        pointer: '/start_frame',
        code: 'MISSING_REQUIRED_FIELD',
        message: 'start_frame is required and must be an integer when mode is clip',
      });
    } else if (rawStart < 0) {
      errors.push({
        pointer: '/start_frame',
        code: 'TIMELINE_BOUNDS',
        message: `start_frame (${rawStart}) must be >= 0`,
      });
    } else {
      startFrame = rawStart;
    }

    const rawDur = body['duration_frames'];
    if (typeof rawDur !== 'number' || !Number.isInteger(rawDur)) {
      errors.push({
        pointer: '/duration_frames',
        code: 'MISSING_REQUIRED_FIELD',
        message: 'duration_frames is required and must be an integer when mode is clip',
      });
    } else if (rawDur < 1 || rawDur > MAX_PREVIEW_CLIP_DURATION_FRAMES) {
      errors.push({
        pointer: '/duration_frames',
        code: 'TIMELINE_BOUNDS',
        message: `duration_frames (${rawDur}) must be between 1 and ${MAX_PREVIEW_CLIP_DURATION_FRAMES} frames (<= 10s at 30fps)`,
      });
    } else {
      durationFrames = rawDur;
    }
  }

  const { webhookEndpointId, clientReference, metadata } =
    validateOptionalJobMetadataAndRefs(body, errors);

  if (errors.length > 0) {
    throw new BodyReferenceValidationError(errors, 'Preview job request validation failed');
  }

  return {
    kind: 'preview',
    compositionId: (rawCompId as string).trim(),
    compositionRevision: rawRevision as number,
    mode: rawMode as 'frame' | 'clip',
    frameIndex,
    startFrame,
    durationFrames,
    profile: 'preview-360p-v1',
    webhookEndpointId,
    clientReference,
    metadata,
  };
}

/**
 * Validates preview timeline bounds against the loaded composition's `duration_frames`.
 * Per docs/API.md line 97: never silently clamps out-of-range frames; always rejects with
 * 422 VALIDATION_FAILED (TIMELINE_BOUNDS).
 */
export function validatePreviewBoundsAgainstComposition(
  req: ValidatedPreviewJobRequest,
  compositionDurationFrames: number,
): void {
  const errors: ErrorDetail[] = [];

  if (req.mode === 'frame') {
    const idx = req.frameIndex!;
    if (idx < 0 || idx >= compositionDurationFrames) {
      errors.push({
        pointer: '/frame_index',
        code: 'TIMELINE_BOUNDS',
        message: `frame_index (${idx}) is out of bounds for composition duration_frames (${compositionDurationFrames}); expected 0 <= frame_index < ${compositionDurationFrames}`,
      });
    }
  } else {
    const start = req.startFrame!;
    const dur = req.durationFrames!;
    if (start < 0 || start >= compositionDurationFrames) {
      errors.push({
        pointer: '/start_frame',
        code: 'TIMELINE_BOUNDS',
        message: `start_frame (${start}) is out of bounds for composition duration_frames (${compositionDurationFrames})`,
      });
    }
    if (start + dur > compositionDurationFrames) {
      errors.push({
        pointer: '/duration_frames',
        code: 'TIMELINE_BOUNDS',
        message: `Preview clip range [${start}, ${start + dur}) exceeds composition duration_frames (${compositionDurationFrames}); never clamped silently`,
      });
    }
  }

  if (errors.length > 0) {
    throw new BodyReferenceValidationError(errors, 'Preview timeline bounds validation failed');
  }
}

/**
 * Computes deterministic usage reservation quantities (`reserved_vcpu_seconds` and
 * `reserved_output_seconds`) for a newly admitted render or preview job.
 */
export function calculateJobReservation(
  request: ValidatedJobAdmissionRequest,
  spec: CompositionSpec,
): { reservedVcpuSeconds: number; reservedOutputSeconds: number } {
  const fpsNum = spec.fps?.num ?? 30;
  const fpsDen = spec.fps?.den ?? 1;

  if (request.kind === 'render') {
    const outputSeconds = (spec.duration_frames * fpsDen) / fpsNum;
    const reservedOutputSeconds = Number(Math.max(0.033333, outputSeconds).toFixed(6));
    // 2 vCPU worker budget * 4x worst-case attempt/encoding safety factor (e.g., 15s -> 120 vCPU-s)
    const reservedVcpuSeconds = Number(Math.max(1, reservedOutputSeconds * 8).toFixed(6));
    return { reservedVcpuSeconds, reservedOutputSeconds };
  }

  const previewFrames = request.mode === 'frame' ? 1 : (request.durationFrames ?? 1);
  const outputSeconds = (previewFrames * fpsDen) / fpsNum;
  const reservedOutputSeconds = Number(Math.max(0.033333, outputSeconds).toFixed(6));
  const reservedVcpuSeconds = Number(Math.max(1, reservedOutputSeconds * 4).toFixed(6));
  return { reservedVcpuSeconds, reservedOutputSeconds };
}
