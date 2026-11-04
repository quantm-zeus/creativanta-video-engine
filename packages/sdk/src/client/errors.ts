/**
 * Typed Errors for Creativanta Client & Webhook Integration (Tasks P5-03 & P5-04).
 */

export class CreativantaClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreativantaClientError';
  }
}

export interface ApiErrorDetail {
  pointer?: string;
  code?: string;
  message?: string;
}

export class CreativantaApiError extends CreativantaClientError {
  public readonly status: number;
  public readonly code: string;
  public readonly requestId?: string;
  public readonly retryable: boolean;
  public readonly details: ApiErrorDetail[];
  public readonly isReplayed: boolean;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    requestId?: string;
    retryable?: boolean;
    details?: ApiErrorDetail[];
    isReplayed?: boolean;
  }) {
    super(`[${options.code}] ${options.message} (HTTP ${options.status}${options.requestId ? `, Request-ID: ${options.requestId}` : ''})`);
    this.name = 'CreativantaApiError';
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? [];
    this.isReplayed = options.isReplayed ?? false;
  }
}

export class BadRequestError extends CreativantaApiError {
  constructor(message = 'Bad Request', code = 'BAD_REQUEST', requestId?: string, details?: ApiErrorDetail[]) {
    super({
      status: 400,
      code,
      message,
      requestId,
      retryable: false,
      details,
    });
    this.name = 'BadRequestError';
  }
}

export class IdempotencyKeyRequiredError extends BadRequestError {
  constructor(message = 'Idempotency-Key header is required for POST mutations', requestId?: string) {
    super(message, 'IDEMPOTENCY_KEY_REQUIRED', requestId);
    this.name = 'IdempotencyKeyRequiredError';
  }
}

export class InvalidIdempotencyKeyError extends BadRequestError {
  constructor(message = 'Invalid Idempotency-Key format: must be 1-128 ASCII [A-Za-z0-9._:-]', requestId?: string) {
    super(message, 'INVALID_IDEMPOTENCY_KEY', requestId);
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export class AuthenticationError extends CreativantaApiError {
  constructor(message = 'Unauthenticated: valid API key required', requestId?: string) {
    super({
      status: 401,
      code: 'UNAUTHENTICATED',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'AuthenticationError';
  }
}

export class ForbiddenError extends CreativantaApiError {
  constructor(message = 'Insufficient scope or tenant suspended', code = 'INSUFFICIENT_SCOPE', requestId?: string) {
    super({
      status: 403,
      code,
      message,
      requestId,
      retryable: false,
    });
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends CreativantaApiError {
  constructor(message = 'Resource not found', requestId?: string) {
    super({
      status: 404,
      code: 'NOT_FOUND',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'NotFoundError';
  }
}

export class IdempotencyConflictError extends CreativantaApiError {
  constructor(message = 'Idempotency conflict: differing payload for existing idempotency key', requestId?: string) {
    super({
      status: 409,
      code: 'IDEMPOTENCY_CONFLICT',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyInProgressError extends CreativantaApiError {
  constructor(message = 'Idempotency operation in progress, retry after delay', requestId?: string) {
    super({
      status: 409,
      code: 'IDEMPOTENCY_IN_PROGRESS',
      message,
      requestId,
      retryable: true,
    });
    this.name = 'IdempotencyInProgressError';
  }
}

export class RevisionConflictError extends CreativantaApiError {
  constructor(message = 'Revision conflict: base_revision is stale', requestId?: string) {
    super({
      status: 409,
      code: 'REVISION_CONFLICT',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'RevisionConflictError';
  }
}

export class JobTerminalError extends CreativantaApiError {
  constructor(message = 'Cannot cancel terminal job: job has already completed or failed', requestId?: string) {
    super({
      status: 409,
      code: 'JOB_TERMINAL',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'JobTerminalError';
  }
}

export class GrantExpiredError extends CreativantaApiError {
  constructor(message = 'Artifact download grant has expired', requestId?: string) {
    super({
      status: 410,
      code: 'GRANT_EXPIRED',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'GrantExpiredError';
  }
}

export class ResourceExpiredError extends CreativantaApiError {
  constructor(message = 'Requested resource has expired and is no longer available', code = 'ARTIFACT_EXPIRED', requestId?: string) {
    super({
      status: 410,
      code,
      message,
      requestId,
      retryable: false,
    });
    this.name = 'ResourceExpiredError';
  }
}

export class PayloadTooLargeError extends CreativantaApiError {
  constructor(message = 'Payload size exceeds 1 MiB HTTP body limit', requestId?: string) {
    super({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message,
      requestId,
      retryable: false,
    });
    this.name = 'PayloadTooLargeError';
  }
}

export class ValidationError extends CreativantaApiError {
  constructor(message = 'Validation failed', details?: ApiErrorDetail[], requestId?: string) {
    super({
      status: 422,
      code: 'VALIDATION_FAILED',
      message,
      requestId,
      retryable: false,
      details,
    });
    this.name = 'ValidationError';
  }
}

export class UnsupportedCapabilityError extends CreativantaApiError {
  constructor(message = 'Unsupported capability or profile constraint violated', details?: ApiErrorDetail[], requestId?: string) {
    super({
      status: 422,
      code: 'UNSUPPORTED_CAPABILITY',
      message,
      requestId,
      retryable: false,
      details,
    });
    this.name = 'UnsupportedCapabilityError';
  }
}

export class RateLimitedError extends CreativantaApiError {
  public readonly retryAfterSeconds?: number;

  constructor(message = 'Rate limit exceeded, retry after specified delay', retryAfterSeconds?: number, requestId?: string) {
    super({
      status: 429,
      code: 'RATE_LIMITED',
      message,
      requestId,
      retryable: true,
    });
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ServiceUnavailableError extends CreativantaApiError {
  public readonly retryAfterSeconds?: number;

  constructor(message = 'Service temporarily unavailable, retry later', retryAfterSeconds?: number, requestId?: string) {
    super({
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message,
      requestId,
      retryable: true,
    });
    this.name = 'ServiceUnavailableError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class DownloadIntegrityError extends CreativantaClientError {
  public readonly expectedSha256?: string;
  public readonly actualSha256?: string;
  public readonly expectedBytes?: number;
  public readonly actualBytes?: number;

  constructor(message: string, info?: { expectedSha256?: string; actualSha256?: string; expectedBytes?: number; actualBytes?: number }) {
    super(message);
    this.name = 'DownloadIntegrityError';
    this.expectedSha256 = info?.expectedSha256;
    this.actualSha256 = info?.actualSha256;
    this.expectedBytes = info?.expectedBytes;
    this.actualBytes = info?.actualBytes;
  }
}

export class ReconciliationTimeoutError extends CreativantaClientError {
  public readonly jobId: string;
  public readonly elapsedMs: number;
  public readonly lastState?: string;

  constructor(jobId: string, elapsedMs: number, lastState?: string) {
    super(`Job ${jobId} did not reach terminal state within reconciliation timeout of ${elapsedMs}ms (last state: ${lastState ?? 'unknown'})`);
    this.name = 'ReconciliationTimeoutError';
    this.jobId = jobId;
    this.elapsedMs = elapsedMs;
    this.lastState = lastState;
  }
}

export class WebhookVerificationError extends CreativantaClientError {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(message: string, code = 'WEBHOOK_VERIFICATION_FAILED', httpStatus = 400) {
    super(`Webhook verification failed: [${code}] ${message}`);
    this.name = 'WebhookVerificationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
