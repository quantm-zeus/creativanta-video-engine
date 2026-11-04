/**
 * Typed Errors for Creativanta Client & Webhook Integration (Task P5-03).
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
