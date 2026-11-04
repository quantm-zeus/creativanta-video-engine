/**
 * HTTP Transport Client for Creativanta (Tasks P5-03 & P5-04).
 *
 * Implements strict REST API v1 contracts:
 *   - Zero shared DB assumptions: purely HTTP over fetch
 *   - Automatic Idempotency-Key validation & injection for POST requests
 *   - Safe automatic retries for 409 IDEMPOTENCY_IN_PROGRESS, 429 RATE_LIMITED,
 *     429 QUOTA_EXCEEDED, and 503 SERVICE_UNAVAILABLE using the SAME Idempotency-Key
 *   - Idempotency-Replayed header detection
 *   - Exhaustive typed error mapping conforming to docs/API.md
 */

import crypto from 'node:crypto';
import {
  AuthenticationError,
  BadRequestError,
  CreativantaApiError,
  CreativantaClientError,
  ForbiddenError,
  GrantExpiredError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  IdempotencyKeyRequiredError,
  InvalidIdempotencyKeyError,
  JobTerminalError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  ResourceExpiredError,
  RevisionConflictError,
  ServiceUnavailableError,
  UnsupportedCapabilityError,
  ValidationError,
  type ApiErrorDetail,
} from './errors.js';
import { generateIdempotencyKey, isValidIdempotencyKey } from './idempotency.js';
import type { CreativantaClientConfig } from './types.js';

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
  requestId?: string;
  isReplayed: boolean;
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBackoffBaseMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: CreativantaClientConfig) {
    if (!config.baseUrl) {
      throw new CreativantaClientError('Creativanta client baseUrl is required');
    }
    if (!config.apiKey) {
      throw new CreativantaClientError('Creativanta client apiKey is required');
    }

    // Strip trailing slashes
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffBaseMs = config.retryBackoffBaseMs ?? 500;
    this.fetchFn = config.customFetch ?? globalThis.fetch;
  }

  public async request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>> {
    const url = this.buildUrl(options.path, options.query);
    const method = options.method;

    // For POST requests, ensure a valid Idempotency-Key exists
    let idemKey = options.idempotencyKey;
    if (method === 'POST') {
      if (!idemKey) {
        idemKey = generateIdempotencyKey();
      } else if (!isValidIdempotencyKey(idemKey)) {
        throw new InvalidIdempotencyKeyError(
          `Invalid Idempotency-Key format: '${idemKey}'. Must be 1-128 ASCII [A-Za-z0-9._:-]`,
        );
      }
    }

    let attempt = 0;
    while (true) {
      attempt += 1;
      const requestId = `req_${crypto.randomUUID()}`;
      const headers = new Headers(options.headers);

      headers.set('Authorization', `Bearer ${this.apiKey}`);
      headers.set('X-Request-Id', requestId);
      headers.set('Accept', 'application/json');

      if (idemKey) {
        headers.set('Idempotency-Key', idemKey);
      }

      let bodyString: string | undefined;
      if (options.body !== undefined && options.body !== null) {
        headers.set('Content-Type', 'application/json');
        bodyString = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }

      const timeoutMs = options.timeoutMs ?? this.timeoutMs;
      const controller = new AbortController();
      let timeoutId: NodeJS.Timeout | undefined;

      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      }

      // Chain caller's abort signal if supplied
      if (options.signal) {
        if (options.signal.aborted) {
          if (timeoutId) clearTimeout(timeoutId);
          controller.abort();
        } else {
          options.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }

      try {
        const response = await this.fetchFn(url, {
          method,
          headers,
          body: bodyString,
          signal: controller.signal,
        });

        if (timeoutId) clearTimeout(timeoutId);

        const isReplayed = response.headers.get('idempotency-replayed') === 'true';
        const serverRequestId = response.headers.get('x-request-id') ?? requestId;

        // Parse JSON response body if present
        let parsedData: unknown;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            parsedData = await response.json();
          } catch {
            parsedData = null;
          }
        } else if (response.status === 204) {
          parsedData = null;
        } else {
          try {
            parsedData = await response.text();
          } catch {
            parsedData = null;
          }
        }

        // Handle success (2xx)
        if (response.ok) {
          return {
            status: response.status,
            data: parsedData as T,
            headers: response.headers,
            requestId: serverRequestId,
            isReplayed,
          };
        }

        // Handle Errors and Retries
        const errorBody = (parsedData as { error?: { code?: string; message?: string; details?: ApiErrorDetail[]; retryable?: boolean } })?.error;
        const errorCode = errorBody?.code || `HTTP_${response.status}`;
        const errorMessage = errorBody?.message || response.statusText || 'Request failed';
        const isRetryable = errorBody?.retryable ?? false;
        const details = errorBody?.details ?? [];

        // 1. Idempotency In Progress (409 IDEMPOTENCY_IN_PROGRESS): retry with SAME key after Retry-After
        if (response.status === 409 && errorCode === 'IDEMPOTENCY_IN_PROGRESS' && attempt <= this.maxRetries) {
          const retryAfterSec = this.parseRetryAfter(response.headers.get('retry-after'), 1);
          await this.delay(retryAfterSec * 1000);
          continue;
        }

        // 2. Rate Limited / Quota Exceeded (429) or Service Unavailable (503): retry with SAME key per docs/API.md line 10 & 167
        if ((response.status === 429 || response.status === 503) && attempt <= this.maxRetries) {
          const retryAfterSec = this.parseRetryAfter(response.headers.get('retry-after'), Math.min(2 * attempt, 10));
          const jitterMs = Math.floor(Math.random() * 200);
          await this.delay(retryAfterSec * 1000 + jitterMs);
          continue;
        }

        // Non-retrying / exhausted retry typed error mapping
        if (response.status === 400) {
          if (errorCode === 'IDEMPOTENCY_KEY_REQUIRED') {
            throw new IdempotencyKeyRequiredError(errorMessage, serverRequestId);
          }
          if (errorCode === 'INVALID_IDEMPOTENCY_KEY') {
            throw new InvalidIdempotencyKeyError(errorMessage, serverRequestId);
          }
          throw new BadRequestError(errorMessage, errorCode, serverRequestId, details);
        }

        if (response.status === 401) {
          throw new AuthenticationError(errorMessage, serverRequestId);
        }

        if (response.status === 403) {
          throw new ForbiddenError(errorMessage, errorCode, serverRequestId);
        }

        if (response.status === 404) {
          throw new NotFoundError(errorMessage, serverRequestId);
        }

        if (response.status === 409) {
          if (errorCode === 'IDEMPOTENCY_IN_PROGRESS') {
            throw new IdempotencyInProgressError(errorMessage, serverRequestId);
          }
          if (errorCode === 'IDEMPOTENCY_CONFLICT') {
            throw new IdempotencyConflictError(errorMessage, serverRequestId);
          }
          if (errorCode === 'JOB_TERMINAL') {
            throw new JobTerminalError(errorMessage, serverRequestId);
          }
          if (errorCode === 'REVISION_CONFLICT') {
            throw new RevisionConflictError(errorMessage, serverRequestId);
          }
        }

        if (response.status === 410) {
          if (errorCode === 'GRANT_EXPIRED') {
            throw new GrantExpiredError(errorMessage, serverRequestId);
          }
          throw new ResourceExpiredError(errorMessage, errorCode, serverRequestId);
        }

        if (response.status === 413) {
          throw new PayloadTooLargeError(errorMessage, serverRequestId);
        }

        if (response.status === 422) {
          if (errorCode === 'UNSUPPORTED_CAPABILITY') {
            throw new UnsupportedCapabilityError(errorMessage, details, serverRequestId);
          }
          throw new ValidationError(errorMessage, details, serverRequestId);
        }

        if (response.status === 429) {
          const retryAfterSec = this.parseRetryAfter(response.headers.get('retry-after'), 1);
          throw new RateLimitedError(errorMessage, retryAfterSec, serverRequestId);
        }

        if (response.status === 503) {
          const retryAfterSec = this.parseRetryAfter(response.headers.get('retry-after'), 1);
          throw new ServiceUnavailableError(errorMessage, retryAfterSec, serverRequestId);
        }

        // Generic fallback error
        throw new CreativantaApiError({
          status: response.status,
          code: errorCode,
          message: errorMessage,
          requestId: serverRequestId,
          retryable: isRetryable,
          details,
          isReplayed,
        });
      } catch (err: unknown) {
        if (timeoutId) clearTimeout(timeoutId);

        if (err instanceof CreativantaClientError) {
          throw err;
        }

        // Check if aborted by caller signal
        if (options.signal?.aborted) {
          throw new CreativantaClientError('Request aborted by caller signal');
        }

        // Transient network error: retry if attempts remain and request is idempotent
        if (attempt <= this.maxRetries && (method === 'GET' || method === 'DELETE' || idemKey !== undefined)) {
          const backoff = this.retryBackoffBaseMs * Math.pow(2, attempt - 1);
          await this.delay(backoff);
          continue;
        }

        throw new CreativantaClientError(
          `HTTP ${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${cleanPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) {
          url.searchParams.set(k, String(v));
        }
      }
    }
    return url.toString();
  }

  private parseRetryAfter(headerValue: string | null, defaultSec: number): number {
    if (!headerValue) return defaultSec;
    const parsed = Number.parseInt(headerValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSec;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
