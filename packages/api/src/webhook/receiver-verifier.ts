/**
 * Webhook Receiver Verification & Event Deduplication (Task P4-04).
 *
 * Canonical specification (docs/API.md line 149):
 *   "Headers X-CVE-Event-Id, X-CVE-Timestamp (Unix seconds), X-CVE-Key-Id, X-CVE-Signature: v1=<hex>.
 *    Ký HMAC-SHA256(secret, timestamp + "." + raw_body_bytes); timestamp là ASCII decimal, body UTF-8 exact bytes.
 *    Receiver constant-time compare, reject clock skew >300s, dedupe event ID >= 7 ngày,
 *    ghi event bền trước 2xx, rồi GET authoritative job theo tenant key. Không reserialize JSON trước verify.
 *    Retry dùng timestamp/signature mới, cùng event ID/body; replay cũng cùng event ID.
 *    state_version giúp bỏ event cũ; ordering không được bảo đảm."
 */

import {
  VerifySignatureResult,
  WebhookVerificationError,
  verifyWebhookSignature,
} from './crypto.js';
import {
  JobEventData,
  WEBHOOK_REPLAY_RETENTION_MS,
  WebhookEventPayload,
} from './types.js';

export interface DedupeCheckResult {
  accepted: boolean;
  isDuplicate: boolean;
  isStaleStateVersion: boolean;
  reason?: 'DUPLICATE_EVENT_ID' | 'STALE_STATE_VERSION';
  previousStateVersion?: number;
}

/**
 * In-memory / durable event deduplicator keeping processed event IDs for >= 7 days
 * and monotonic state versions per job ID.
 */
export class WebhookDeduplicator {
  private readonly processedEvents = new Map<string, { processedAtMs: number; eventId: string }>();
  private readonly jobStateVersions = new Map<string, number>();
  private readonly retentionMs: number;

  constructor(retentionMs = WEBHOOK_REPLAY_RETENTION_MS) {
    this.retentionMs = retentionMs;
  }

  /**
   * Evaluates if incoming event should be processed or discarded as duplicate/stale.
   */
  public checkAndRecord(
    eventId: string,
    jobId?: string,
    stateVersion?: number,
    now = new Date(),
  ): DedupeCheckResult {
    const nowMs = now.getTime();

    // 1. Check if event ID was already processed within retention window
    const existingEvent = this.processedEvents.get(eventId);
    if (existingEvent) {
      if (nowMs - existingEvent.processedAtMs < this.retentionMs) {
        return {
          accepted: false,
          isDuplicate: true,
          isStaleStateVersion: false,
          reason: 'DUPLICATE_EVENT_ID',
        };
      }
      // If expired (> 7 days), allow replacement
      this.processedEvents.delete(eventId);
    }

    // 2. Check state version ordering if jobId & stateVersion are provided
    if (jobId !== undefined && stateVersion !== undefined) {
      const highestVersion = this.jobStateVersions.get(jobId);
      if (highestVersion !== undefined && stateVersion <= highestVersion) {
        // Discard stale / out-of-order event per docs/API.md line 149
        return {
          accepted: false,
          isDuplicate: false,
          isStaleStateVersion: true,
          reason: 'STALE_STATE_VERSION',
          previousStateVersion: highestVersion,
        };
      }
      this.jobStateVersions.set(jobId, stateVersion);
    }

    // Record as processed
    this.processedEvents.set(eventId, {
      processedAtMs: nowMs,
      eventId,
    });

    return {
      accepted: true,
      isDuplicate: false,
      isStaleStateVersion: false,
    };
  }

  /**
   * Cleans up records older than the retention period (7 days).
   */
  public pruneExpired(now = new Date()): number {
    const nowMs = now.getTime();
    let pruned = 0;
    for (const [id, entry] of this.processedEvents.entries()) {
      if (nowMs - entry.processedAtMs >= this.retentionMs) {
        this.processedEvents.delete(id);
        pruned += 1;
      }
    }
    return pruned;
  }

  public getProcessedCount(): number {
    return this.processedEvents.size;
  }

  public hasEvent(eventId: string): boolean {
    return this.processedEvents.has(eventId);
  }

  public getJobStateVersion(jobId: string): number | undefined {
    return this.jobStateVersions.get(jobId);
  }
}

export interface ReceiverProcessOptions {
  headers: Record<string, string | string[] | undefined>;
  rawBodyBytes: Buffer | Uint8Array | string;
  secrets: Array<{
    keyId: string;
    secret: string;
    expiresAt?: Date | string | null;
  }>;
  deduplicator?: WebhookDeduplicator;
  now?: Date;
}

export interface ReceiverProcessResult {
  verified: true;
  signatureInfo: VerifySignatureResult;
  payload: WebhookEventPayload<JobEventData>;
  dedupeResult: DedupeCheckResult;
}

/**
 * High-level helper for webhook receivers to verify and deduplicate incoming webhooks.
 */
export function verifyAndProcessIncomingWebhook(
  options: ReceiverProcessOptions,
): ReceiverProcessResult {
  // 1. Verify HMAC signature on exact raw bytes with constant-time comparison
  const signatureInfo = verifyWebhookSignature({
    headers: options.headers,
    rawBodyBytes: options.rawBodyBytes,
    secrets: options.secrets,
    now: options.now,
  });

  // 2. Parse payload ONLY after signature verification passes
  const bodyString = Buffer.isBuffer(options.rawBodyBytes)
    ? options.rawBodyBytes.toString('utf8')
    : typeof options.rawBodyBytes === 'string'
      ? options.rawBodyBytes
      : Buffer.from(options.rawBodyBytes).toString('utf8');

  let payload: WebhookEventPayload<JobEventData>;
  try {
    payload = JSON.parse(bodyString) as WebhookEventPayload<JobEventData>;
  } catch (err) {
    throw new WebhookVerificationError(
      `Failed to parse signed webhook body as JSON: ${err instanceof Error ? err.message : String(err)}`,
      'MALFORMED_WEBHOOK_JSON',
      400,
    );
  }

  // 3. Deduplicate by event ID and enforce monotonic state_version
  let dedupeResult: DedupeCheckResult = {
    accepted: true,
    isDuplicate: false,
    isStaleStateVersion: false,
  };

  if (options.deduplicator) {
    const jobId = payload.data?.job_id;
    const stateVersion = payload.data?.state_version;
    dedupeResult = options.deduplicator.checkAndRecord(
      signatureInfo.eventId,
      jobId,
      stateVersion,
      options.now,
    );
  }

  return {
    verified: true,
    signatureInfo,
    payload,
    dedupeResult,
  };
}
