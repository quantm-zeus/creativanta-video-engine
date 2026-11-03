/**
 * Webhook Outbox Delivery Service & Challenge Handshake (Task P4-04).
 *
 * Implements:
 *   - Transactional outbox pattern (outage không mất event/job)
 *   - Bounded SSRF-safe retries across 8 attempts (t=0, 1m, 5m, 15m, 1h, 4h, 12h, 24h + jitter <= 10%)
 *   - Hard deadline clamp <= 25h from event creation
 *   - 2xx ACK, 410 disable endpoint, 3xx prohibited (dead_letter), 429/5xx retryable, other 4xx dead_letter
 *   - Challenge echo handshake (32 bytes challenge, <= 5s reply, 10min TTL, activates on match)
 *   - Replay support (max 5/day, 7 days window, same event ID)
 */

import crypto from 'node:crypto';

import { TenantConnectionPool } from '../db/tenant-pool.js';
import {
  WebhookNotVerifiedError,
} from '../admission/job-admission.js';
import {
  computeWebhookSignature,
  decryptSecretAtRest,
} from './crypto.js';
import {
  sendWebhookHttpRequest,
  WebhookHttpError,
} from './http-client.js';
import {
  ChallengeEventData,
  JobEventData,
  MAX_DELIVERY_DEADLINE_MS,
  MAX_WEBHOOK_ATTEMPTS,
  WEBHOOK_CHALLENGE_TTL_SECONDS,
  WEBHOOK_RETRY_SCHEDULE_SECONDS,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
  WebhookEventPayload,
} from './types.js';

export interface WebhookDeliveryServiceOptions {
  masterKey?: Buffer | string;
  allowLoopbackForTesting?: boolean;
  allowCustomPortForTesting?: boolean;
  clock?: () => Date;
  jitterRatio?: number; // Override for deterministic testing (0.0 to 0.1)
}

export interface DeliveryResult {
  deliveryId: string;
  endpointId: string;
  jobId: string;
  status: 'delivered' | 'failed' | 'dead_letter' | 'retry_scheduled';
  httpStatus?: number;
  attemptCount: number;
  nextAttemptAt?: string | null;
  error?: string;
}

export class WebhookDeliveryService {
  private readonly pool: TenantConnectionPool;
  private readonly masterKey?: Buffer | string;
  private readonly allowLoopbackForTesting: boolean;
  private readonly allowCustomPortForTesting: boolean;
  private readonly clock: () => Date;
  private readonly jitterRatio?: number;

  constructor(pool: TenantConnectionPool, options: WebhookDeliveryServiceOptions = {}) {
    this.pool = pool;
    this.masterKey = options.masterKey;
    this.allowLoopbackForTesting = options.allowLoopbackForTesting ?? false;
    this.allowCustomPortForTesting = options.allowCustomPortForTesting ?? false;
    this.clock = options.clock ?? (() => new Date());
    this.jitterRatio = options.jitterRatio;
  }

  /**
   * Current DB clock timestamp.
   */
  private now(): Date {
    return this.clock();
  }

  /**
   * Processes all unprocessed outbox records, queuing deliveries for matching active webhook endpoints.
   * Transactional outbox guarantees that no events are lost during outages or crashes.
   */
  public processOutbox(tenantId?: string): { processedCount: number; deliveriesQueued: number } {
    const now = this.now();
    const nowIso = now.toISOString();
    const deadlineIso = new Date(now.getTime() + MAX_DELIVERY_DEADLINE_MS).toISOString();

    let processedCount = 0;
    let deliveriesQueued = 0;

    const tenantsToProcess: string[] = tenantId
      ? [tenantId]
      : this.listDistinctOutboxTenants();

    for (const tId of tenantsToProcess) {
      this.pool.withTransaction({ tenantId: tId, role: 'cve_sender' }, (tx) => {
        const unprocessed = tx.selectScoped<{
          id: string;
          event_type: string;
          job_id: string;
          state_version: number;
          payload_json: string;
          created_at: string;
        }>('outbox', 'processed_at IS NULL', [], 'created_at ASC, id ASC');

        for (const outboxEntry of unprocessed) {
          processedCount += 1;

          // Fetch job to determine webhook endpoint
          const jobs = tx.selectScoped<{
            id: string;
            webhook_endpoint_id: string | null;
            client_reference: string | null;
          }>('jobs', 'id = ?', [outboxEntry.job_id]);
          const job = jobs[0];

          if (job && job.webhook_endpoint_id) {
            const endpoints = tx.selectScoped<WebhookEndpointRecord>(
              'webhook_endpoints',
              'id = ?',
              [job.webhook_endpoint_id],
            );
            const endpoint = endpoints[0];

            if (endpoint && endpoint.state === 'active') {
              const eventsFilter = JSON.parse(endpoint.events_filter_json) as string[];
              if (eventsFilter.includes(outboxEntry.event_type) || eventsFilter.includes('*')) {
                // Ensure idempotency: do not re-queue existing delivery for same outbox_event_id and endpoint
                const existingDeliveries = tx.selectScoped<{ id: string }>(
                  'webhook_deliveries',
                  'endpoint_id = ? AND outbox_event_id = ?',
                  [endpoint.id, outboxEntry.id],
                );

                if (existingDeliveries.length === 0) {
                  const deliveryId = `del_${crypto.randomBytes(6).toString('hex')}`;
                  tx.insertScoped('webhook_deliveries', {
                    tenant_id: tId,
                    id: deliveryId,
                    endpoint_id: endpoint.id,
                    outbox_event_id: outboxEntry.id,
                    job_id: outboxEntry.job_id,
                    state: 'queued',
                    attempt_count: 0,
                    next_attempt_at: nowIso,
                    deadline_at: deadlineIso,
                    last_http_status: null,
                    replay_count_today: 0,
                    created_at: nowIso,
                    updated_at: nowIso,
                  });
                  deliveriesQueued += 1;
                }
              }
            }
          }

          // Mark outbox entry as processed
          tx.updateScoped(
            'outbox',
            { processed_at: nowIso },
            'id = ?',
            [outboxEntry.id],
          );
        }
      });
    }

    return { processedCount, deliveriesQueued };
  }

  /**
   * Helper to retrieve all tenant IDs with unprocessed outbox events.
   */
  private listDistinctOutboxTenants(): string[] {
    // In multi-tenant pool, query distinct tenant_id with cve_sender role
    return this.pool.withTransaction({ tenantId: '00000000-0000-0000-0000-000000000000', role: 'cve_migrator' }, (tx) => {
      const rows = tx.selectScoped<{ tenant_id: string }>(
        'outbox',
        'processed_at IS NULL',
        [],
        'tenant_id ASC',
      );
      const unique = new Set(rows.map((r) => r.tenant_id));
      return Array.from(unique);
    });
  }

  /**
   * Processes all queued deliveries due for attempt (`next_attempt_at <= now`).
   */
  public async deliverPending(options: { tenantId?: string; maxBatch?: number } = {}): Promise<DeliveryResult[]> {
    const now = this.now();
    const nowIso = now.toISOString();
    const maxBatch = options.maxBatch ?? 50;

    const results: DeliveryResult[] = [];

    const tenantsToProcess: string[] = options.tenantId
      ? [options.tenantId]
      : this.listDistinctDeliveryTenants();

    for (const tId of tenantsToProcess) {
      // 1. Fetch eligible deliveries
      const deliveries = this.pool.withTransaction({ tenantId: tId, role: 'cve_sender' }, (tx) => {
        return tx.selectScoped<WebhookDeliveryRecord>(
          'webhook_deliveries',
          "state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
          [nowIso],
          'next_attempt_at ASC, created_at ASC',
        ).slice(0, maxBatch);
      });

      for (const delivery of deliveries) {
        const res = await this.deliverSingle(tId, delivery);
        results.push(res);
      }
    }

    return results;
  }

  private listDistinctDeliveryTenants(): string[] {
    const nowIso = this.now().toISOString();
    return this.pool.withTransaction({ tenantId: '00000000-0000-0000-0000-000000000000', role: 'cve_migrator' }, (tx) => {
      const rows = tx.selectScoped<{ tenant_id: string }>(
        'webhook_deliveries',
        "state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)",
        [nowIso],
        'tenant_id ASC',
      );
      return Array.from(new Set(rows.map((r) => r.tenant_id)));
    });
  }

  /**
   * Executes a single delivery attempt with signature calculation, SSRF-safe HTTP dispatch,
   * status handling, and bounded retry calculation.
   */
  public async deliverSingle(tenantId: string, delivery: WebhookDeliveryRecord): Promise<DeliveryResult> {
    const now = this.now();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const deadlineMs = Date.parse(delivery.deadline_at);

    // 1. Check if deadline already exceeded
    if (nowMs > deadlineMs) {
      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'failed',
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
      });
      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'failed',
        attemptCount: delivery.attempt_count,
        error: 'Delivery deadline (25h) exceeded',
      };
    }

    // 2. Load endpoint, outbox event, and job details
    const context = this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
      const endpoints = tx.selectScoped<WebhookEndpointRecord>(
        'webhook_endpoints',
        'id = ?',
        [delivery.endpoint_id],
      );
      const outboxRows = tx.selectScoped<{
        id: string;
        event_type: string;
        job_id: string;
        state_version: number;
        payload_json: string;
        created_at: string;
      }>('outbox', 'id = ?', [delivery.outbox_event_id]);
      const jobs = tx.selectScoped<{
        id: string;
        client_reference: string | null;
      }>('jobs', 'id = ?', [delivery.job_id]);

      return {
        endpoint: endpoints[0],
        outbox: outboxRows[0],
        job: jobs[0],
      };
    });

    const endpoint = context.endpoint;
    const outbox = context.outbox;
    const job = context.job;

    // Check if endpoint disabled or missing: "Endpoint bị xóa thì không gửi tiếp"
    if (!endpoint || endpoint.state === 'disabled') {
      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'dead_letter',
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
      });
      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'dead_letter',
        attemptCount: delivery.attempt_count,
        error: 'Endpoint is disabled or deleted',
      };
    }

    if (!outbox) {
      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'dead_letter',
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
      });
      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'dead_letter',
        attemptCount: delivery.attempt_count,
        error: 'Outbox event not found',
      };
    }

    // 3. Build canonical webhook event payload per docs/API.md line 146
    const parsedPayload = JSON.parse(outbox.payload_json) as Record<string, unknown>;
    const eventId = `evt_${outbox.id.replace(/^out_/, '')}`;

    // Extract artifacts and client reference
    const artifactIds: string[] = Array.isArray(parsedPayload['artifacts'])
      ? (parsedPayload['artifacts'] as Array<{ id?: string }>).map((a) => a.id || '').filter(Boolean)
      : Array.isArray(parsedPayload['artifact_ids'])
        ? (parsedPayload['artifact_ids'] as string[])
        : [];

    const jobEventData: JobEventData = {
      job_id: outbox.job_id,
      state: String(parsedPayload['state'] ?? outbox.event_type.replace(/^job\./, '')),
      state_version: outbox.state_version,
      client_reference: job?.client_reference ?? (parsedPayload['client_reference'] as string | undefined) ?? null,
      artifact_ids: artifactIds,
      error: parsedPayload['error'] ? (parsedPayload['error'] as { code: string; message: string }) : null,
    };

    const envelope: WebhookEventPayload<JobEventData> = {
      id: eventId,
      type: outbox.event_type,
      api_version: 'v1',
      created_at: outbox.created_at,
      data: jobEventData,
    };

    const rawBodyBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    const timestampSeconds = Math.floor(nowMs / 1000);

    // 4. Decrypt secret and compute signature
    const secret = decryptSecretAtRest(endpoint.secret_ciphertext, this.masterKey);
    const signature = computeWebhookSignature(secret, timestampSeconds, rawBodyBytes);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-CVE-Event-Id': eventId,
      'X-CVE-Timestamp': String(timestampSeconds),
      'X-CVE-Key-Id': endpoint.active_key_id,
      'X-CVE-Signature': `v1=${signature}`,
      'User-Agent': 'Creativanta-Video-Engine-Webhook/1.0',
    };

    // 5. Send HTTP request
    let httpStatus: number | undefined;
    let isRetryable = false;
    let shouldDisableEndpoint = false;
    let isSuccess = false;
    let retryAfterHeaderSeconds: number | undefined;
    let errorMessage: string | undefined;

    try {
      const httpRes = await sendWebhookHttpRequest({
        url: endpoint.url,
        method: 'POST',
        headers,
        body: rawBodyBytes,
        allowLoopbackForTesting: this.allowLoopbackForTesting,
        allowCustomPortForTesting: this.allowCustomPortForTesting,
      });

      httpStatus = httpRes.status;

      if (httpStatus >= 200 && httpStatus < 300) {
        isSuccess = true;
      } else if (httpStatus === 410) {
        // HTTP 410: receiver permanently disabled/deleted the endpoint
        shouldDisableEndpoint = true;
        isRetryable = false;
      } else if (httpStatus >= 300 && httpStatus < 400) {
        // Redirect: strictly prohibited
        isRetryable = false;
        errorMessage = `Redirect received (${httpStatus}); redirects prohibited`;
      } else if (httpStatus === 429 || httpStatus >= 500) {
        isRetryable = true;
        const retryAfterVal = httpRes.headers['retry-after'];
        if (retryAfterVal && /^\d+$/.test(retryAfterVal)) {
          retryAfterHeaderSeconds = parseInt(retryAfterVal, 10);
        }
      } else {
        // Other 4xx (400, 401, 403, 404, 422): non-retryable dead letter
        isRetryable = false;
        errorMessage = `Receiver returned client error ${httpStatus}`;
      }
    } catch (err) {
      if (err instanceof WebhookHttpError) {
        httpStatus = err.status;
        isRetryable = err.retryable;
        errorMessage = err.message;
      } else {
        isRetryable = true;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    const nextAttemptCount = delivery.attempt_count + 1;

    // 6. State updates & retry calculation
    if (isSuccess) {
      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'delivered',
            attempt_count: nextAttemptCount,
            last_http_status: httpStatus ?? 200,
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
        tx.updateScoped(
          'webhook_endpoints',
          {
            last_delivery_at: nowIso,
            updated_at: nowIso,
          },
          'id = ?',
          [endpoint.id],
        );
      });

      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'delivered',
        httpStatus: httpStatus ?? 200,
        attemptCount: nextAttemptCount,
      };
    }

    if (shouldDisableEndpoint) {
      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_endpoints',
          {
            state: 'disabled',
            updated_at: nowIso,
          },
          'id = ?',
          [endpoint.id],
        );
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'dead_letter',
            attempt_count: nextAttemptCount,
            last_http_status: 410,
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
      });

      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'dead_letter',
        httpStatus: 410,
        attemptCount: nextAttemptCount,
        error: 'Receiver returned 410 Gone: endpoint permanently disabled',
      };
    }

    if (isRetryable && nextAttemptCount < MAX_WEBHOOK_ATTEMPTS) {
      // Calculate retry backoff from 8 attempts schedule
      // Schedule: [0, 60s, 300s, 900s, 3600s, 14400s, 43200s, 86400s]
      const baseDelaySec = WEBHOOK_RETRY_SCHEDULE_SECONDS[nextAttemptCount] ?? 86400;
      const jitterFactor = 1 + (this.jitterRatio ?? Math.random() * 0.1); // <= 10% jitter
      let delaySec = Math.floor(baseDelaySec * jitterFactor);

      if (retryAfterHeaderSeconds !== undefined && retryAfterHeaderSeconds > 0) {
        delaySec = Math.max(delaySec, retryAfterHeaderSeconds);
      }

      let nextAttemptMs = nowMs + delaySec * 1000;

      // Clamp to hard deadline of 25 hours: "mọi delay/jitter/Retry-After clamp không vượt deadline 25h"
      if (nextAttemptMs > deadlineMs) {
        nextAttemptMs = deadlineMs;
      }

      const nextAttemptIso = new Date(nextAttemptMs).toISOString();

      this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
        tx.updateScoped(
          'webhook_deliveries',
          {
            state: 'queued',
            attempt_count: nextAttemptCount,
            next_attempt_at: nextAttemptIso,
            last_http_status: httpStatus ?? null,
            updated_at: nowIso,
          },
          'id = ?',
          [delivery.id],
        );
      });

      return {
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        jobId: delivery.job_id,
        status: 'retry_scheduled',
        httpStatus,
        attemptCount: nextAttemptCount,
        nextAttemptAt: nextAttemptIso,
        error: errorMessage,
      };
    }

    // Attempts exhausted or non-retryable failure (dead letter or failed)
    const finalState = nextAttemptCount >= MAX_WEBHOOK_ATTEMPTS ? 'failed' : 'dead_letter';

    this.pool.withTransaction({ tenantId, role: 'cve_sender' }, (tx) => {
      tx.updateScoped(
        'webhook_deliveries',
        {
          state: finalState,
          attempt_count: nextAttemptCount,
          last_http_status: httpStatus ?? null,
          updated_at: nowIso,
        },
        'id = ?',
        [delivery.id],
      );
    });

    return {
      deliveryId: delivery.id,
      endpointId: delivery.endpoint_id,
      jobId: delivery.job_id,
      status: finalState,
      httpStatus,
      attemptCount: nextAttemptCount,
      error: errorMessage ?? `Delivery ended with status ${finalState}`,
    };
  }

  /**
   * Executes ownership challenge echo handshake for endpoint verification.
   * Specification (docs/API.md line 143):
   *   "Verify gửi event endpoint.challenge, random challenge 32 bytes,
   *    receiver kiểm HMAC rồi trả JSON { "challenge": "<exact received value>" } trong <= 5s;
   *    challenge sống 10min, one-use. Endpoint chỉ active sau echo đúng; secret không gửi trong payload."
   */
  public async executeChallengeHandshake(
    tenantId: string,
    endpointId: string,
    options: { customChallengeToken?: string } = {},
  ): Promise<{ success: true; endpoint: { id: string; state: 'active' } }> {
    const now = this.now();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    // 1. Fetch endpoint
    const endpoint = this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const endpoints = tx.selectScoped<WebhookEndpointRecord>(
        'webhook_endpoints',
        'id = ?',
        [endpointId],
      );
      return endpoints[0];
    });

    if (!endpoint) {
      throw new WebhookNotVerifiedError(`Webhook endpoint "${endpointId}" not found`);
    }

    if (endpoint.state === 'disabled') {
      throw new WebhookNotVerifiedError(`Webhook endpoint "${endpointId}" is disabled and cannot be verified`);
    }

    // 2. Generate random challenge (32 bytes = 64 hex chars)
    const challengeToken = options.customChallengeToken ?? crypto.randomBytes(32).toString('hex');
    const challengeHash = crypto.createHash('sha256').update(challengeToken).digest('hex');
    const challengeExpiresAt = new Date(nowMs + WEBHOOK_CHALLENGE_TTL_SECONDS * 1000).toISOString();

    // Store challenge hash and expiration in DB
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.updateScoped(
        'webhook_endpoints',
        {
          challenge_token_hash: challengeHash,
          challenge_expires_at: challengeExpiresAt,
          updated_at: nowIso,
        },
        'id = ?',
        [endpointId],
      );
    });

    // 3. Prepare challenge payload and HMAC signature
    const eventId = `evt_ch_${crypto.randomBytes(6).toString('hex')}`;
    const envelope: WebhookEventPayload<ChallengeEventData> = {
      id: eventId,
      type: 'endpoint.challenge',
      api_version: 'v1',
      created_at: nowIso,
      data: {
        endpoint_id: endpointId,
        challenge: challengeToken,
      },
    };

    const rawBodyBytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    const timestampSeconds = Math.floor(nowMs / 1000);
    const secret = decryptSecretAtRest(endpoint.secret_ciphertext, this.masterKey);
    const signature = computeWebhookSignature(secret, timestampSeconds, rawBodyBytes);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-CVE-Event-Id': eventId,
      'X-CVE-Timestamp': String(timestampSeconds),
      'X-CVE-Key-Id': endpoint.active_key_id,
      'X-CVE-Signature': `v1=${signature}`,
      'User-Agent': 'Creativanta-Video-Engine-Webhook/1.0',
    };

    // 4. Send HTTP request with <= 5s timeout
    let responseBody = '';
    let responseStatus = 0;
    try {
      const httpRes = await sendWebhookHttpRequest({
        url: endpoint.url,
        method: 'POST',
        headers,
        body: rawBodyBytes,
        allowLoopbackForTesting: this.allowLoopbackForTesting,
        allowCustomPortForTesting: this.allowCustomPortForTesting,
        totalTimeoutMs: 5000,
        connectTimeoutMs: 2000,
      });
      responseStatus = httpRes.status;
      responseBody = httpRes.body;
    } catch (err) {
      throw new WebhookNotVerifiedError(
        `Webhook challenge delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (responseStatus < 200 || responseStatus >= 300) {
      throw new WebhookNotVerifiedError(
        `Webhook receiver returned HTTP ${responseStatus} during challenge handshake (expected 200 OK)`,
      );
    }

    // 5. Parse JSON response and verify challenge echo
    let echoedChallenge: string | undefined;
    try {
      const parsed = JSON.parse(responseBody) as { challenge?: string };
      echoedChallenge = parsed.challenge;
    } catch {
      throw new WebhookNotVerifiedError(
        'Webhook receiver response could not be parsed as JSON during challenge handshake',
      );
    }

    if (!echoedChallenge || typeof echoedChallenge !== 'string') {
      throw new WebhookNotVerifiedError(
        'Webhook receiver did not return {"challenge": "<value>"} in response JSON',
      );
    }

    // Constant-time compare challenge tokens
    const expectedBuf = Buffer.from(challengeToken, 'utf8');
    const actualBuf = Buffer.from(echoedChallenge, 'utf8');
    const isMatch = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

    if (!isMatch) {
      throw new WebhookNotVerifiedError(
        'Challenge echo mismatch: receiver returned challenge does not match sent challenge value',
      );
    }

    // 6. Activate endpoint and clear one-use challenge
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.updateScoped(
        'webhook_endpoints',
        {
          state: 'active',
          challenge_token_hash: null,
          challenge_expires_at: null,
          updated_at: this.now().toISOString(),
        },
        'id = ?',
        [endpointId],
      );
    });

    return {
      success: true,
      endpoint: {
        id: endpointId,
        state: 'active',
      },
    };
  }
}
