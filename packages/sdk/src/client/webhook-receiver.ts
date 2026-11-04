/**
 * Creativanta Signed Webhook Receiver (Task P5-03).
 *
 * Canonical specification (docs/API.md line 149):
 *   "Headers X-CVE-Event-Id, X-CVE-Timestamp (Unix seconds), X-CVE-Key-Id, X-CVE-Signature: v1=<hex>.
 *    Ký HMAC-SHA256(secret, timestamp + '.' + raw_body_bytes); timestamp là ASCII decimal, body UTF-8 exact bytes.
 *    Receiver constant-time compare, reject clock skew > 300s, dedupe event ID >= 7 ngày,
 *    ghi event bền trước 2xx, rồi GET authoritative job theo tenant key. Không reserialize JSON trước verify.
 *    Retry dùng timestamp/signature mới, cùng event ID/body; replay cũng cùng event ID.
 *    state_version giúp bỏ event cũ; ordering không được bảo đảm."
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { WebhookVerificationError } from './errors.js';
import type {
  JobEventData,
  WebhookEventPayload,
  WebhookReceiverConfig,
  WebhookSecretConfig,
  WebhookVerificationResult,
} from './types.js';

export const DEFAULT_TOLERANCE_SECONDS = 300; // 5 minutes max clock skew
export const DEFAULT_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class CreativantaWebhookReceiver extends EventEmitter {
  private readonly secrets: WebhookSecretConfig[];
  private readonly maxSkewSeconds: number;
  private readonly retentionMs: number;
  private readonly clock: () => Date;

  // In-memory deduplication cache: eventId -> { processedAtMs }
  private readonly processedEvents = new Map<string, number>();
  // Monotonic state version tracking: jobId -> stateVersion
  private readonly jobStateVersions = new Map<string, number>();

  constructor(config: WebhookReceiverConfig) {
    super();

    if (typeof config.secrets === 'string') {
      this.secrets = [{ keyId: 'default', secret: config.secrets }];
    } else if (Array.isArray(config.secrets) && config.secrets.length > 0) {
      this.secrets = config.secrets;
    } else {
      throw new WebhookVerificationError('Webhook receiver requires at least one signing secret');
    }

    this.maxSkewSeconds = config.maxSkewSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    this.retentionMs = config.retentionMs ?? DEFAULT_DEDUPE_RETENTION_MS;
    this.clock = config.clock ?? (() => new Date());
  }

  /**
   * Pure verification of incoming raw webhook bytes and headers.
   * Performs constant-time HMAC check, clock-skew enforcement, deduplication,
   * and monotonic state_version verification without JSON reserialization.
   */
  public verifyAndProcess(
    headers: Record<string, string | string[] | undefined> | Headers,
    rawBodyBytes: Buffer | Uint8Array | string,
  ): WebhookVerificationResult {
    const getHeader = (name: string): string | undefined => {
      if (headers instanceof Headers) {
        return headers.get(name) ?? undefined;
      }
      const val = headers[name.toLowerCase()] ?? headers[name];
      if (Array.isArray(val)) return val[0];
      return val;
    };

    const signatureHeader = getHeader('x-cve-signature');
    const timestampHeader = getHeader('x-cve-timestamp');
    const eventId = getHeader('x-cve-event-id');
    const keyId = getHeader('x-cve-key-id');

    if (!signatureHeader) {
      throw new WebhookVerificationError('Missing X-CVE-Signature header', 'MISSING_SIGNATURE_HEADER', 400);
    }
    if (!timestampHeader) {
      throw new WebhookVerificationError('Missing X-CVE-Timestamp header', 'MISSING_TIMESTAMP_HEADER', 400);
    }
    if (!eventId) {
      throw new WebhookVerificationError('Missing X-CVE-Event-Id header', 'MISSING_EVENT_ID_HEADER', 400);
    }

    // 1. Clock skew verification (Unix seconds)
    const timestampSec = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(timestampSec)) {
      throw new WebhookVerificationError('Invalid X-CVE-Timestamp header: must be integer seconds', 'INVALID_TIMESTAMP', 400);
    }

    const nowSec = Math.floor(this.clock().getTime() / 1000);
    if (Math.abs(nowSec - timestampSec) > this.maxSkewSeconds) {
      throw new WebhookVerificationError(
        `Clock skew too high: timestamp=${timestampSec}, current=${nowSec}, drift=${Math.abs(nowSec - timestampSec)}s (max allowed ${this.maxSkewSeconds}s)`,
        'CLOCK_SKEW_EXCEEDED',
        400,
      );
    }

    // 2. Signature extraction: v1=<hex>
    const match = /^v1=([a-fA-F0-9]{64})$/.exec(signatureHeader.trim());
    if (!match || !match[1]) {
      throw new WebhookVerificationError('Invalid X-CVE-Signature format, expected v1=<64_hex_digits>', 'INVALID_SIGNATURE_FORMAT', 400);
    }
    const signatureHex = match[1].toLowerCase();

    // 3. Prepare raw signature payload: timestamp + "." + raw_body_bytes
    const bodyBuf = Buffer.isBuffer(rawBodyBytes)
      ? rawBodyBytes
      : typeof rawBodyBytes === 'string'
        ? Buffer.from(rawBodyBytes, 'utf8')
        : Buffer.from(rawBodyBytes);

    const prefixBuf = Buffer.from(`${timestampHeader}.`, 'utf8');
    const signedPayloadBuf = Buffer.concat([prefixBuf, bodyBuf]);

    // 4. Secret resolution: check keyId if provided, else check all active secrets
    const now = this.clock();
    const candidateSecrets = this.secrets.filter((s) => {
      if (s.expiresAt) {
        const exp = s.expiresAt instanceof Date ? s.expiresAt : new Date(s.expiresAt);
        if (exp.getTime() < now.getTime()) return false;
      }
      if (keyId && s.keyId && s.keyId !== keyId) {
        return false;
      }
      return true;
    });

    if (candidateSecrets.length === 0) {
      throw new WebhookVerificationError(`No active signing secret found for keyId '${keyId ?? 'unspecified'}'`, 'SECRET_NOT_FOUND', 401);
    }

    let signatureValid = false;
    for (const sec of candidateSecrets) {
      const expectedHmac = crypto.createHmac('sha256', sec.secret).update(signedPayloadBuf).digest('hex').toLowerCase();
      if (
        signatureHex.length === expectedHmac.length &&
        crypto.timingSafeEqual(Buffer.from(signatureHex, 'utf8'), Buffer.from(expectedHmac, 'utf8'))
      ) {
        signatureValid = true;
        break;
      }
    }

    if (!signatureValid) {
      throw new WebhookVerificationError('HMAC-SHA256 signature verification failed', 'INVALID_SIGNATURE', 401);
    }

    // 5. Parse JSON payload ONLY after signature verification passes
    let payload: WebhookEventPayload<JobEventData>;
    try {
      payload = JSON.parse(bodyBuf.toString('utf8')) as WebhookEventPayload<JobEventData>;
    } catch (err) {
      throw new WebhookVerificationError(
        `Failed to parse signed body as JSON: ${err instanceof Error ? err.message : String(err)}`,
        'MALFORMED_WEBHOOK_JSON',
        400,
      );
    }

    // 6. Deduplication check (7-day window)
    const nowMs = now.getTime();
    this.pruneExpired(now);

    let isDuplicate = false;
    const existingTime = this.processedEvents.get(eventId);
    if (existingTime !== undefined && nowMs - existingTime < this.retentionMs) {
      isDuplicate = true;
    } else {
      this.processedEvents.set(eventId, nowMs);
    }

    // 7. Monotonic state_version guard per job ID (docs/API.md line 149)
    let isStaleStateVersion = false;
    const jobId = payload.data?.job_id;
    const stateVersion = payload.data?.state_version;
    if (jobId && typeof stateVersion === 'number') {
      const lastVersion = this.jobStateVersions.get(jobId);
      if (lastVersion !== undefined && stateVersion <= lastVersion) {
        isStaleStateVersion = true;
      } else {
        this.jobStateVersions.set(jobId, stateVersion);
      }
    }

    const result: WebhookVerificationResult = {
      verified: true,
      eventId,
      timestamp: timestampSec,
      keyId,
      isDuplicate,
      isStaleStateVersion,
      payload,
    };

    // Dispatch events only for non-duplicate, non-stale events
    if (!isDuplicate && !isStaleStateVersion) {
      this.emit('event', payload);
      this.emit(payload.type, payload);
    }

    return result;
  }

  /**
   * HTTP request handler compatible with Node.js http.createServer or Express middleware.
   * Automatically handles:
   *   - Ingestion of raw body bytes
   *   - Signature verification & deduplication
   *   - Endpoint challenge handshake: replies {"challenge": "<received_value>"}
   *   - Dispatching event listeners
   *   - Responding 200 OK or appropriate error HTTP status
   */
  public async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<WebhookVerificationResult | null> {
    try {
      const rawBody = await this.readRawBody(req);
      const result = this.verifyAndProcess(req.headers, rawBody);

      // Check if this is an endpoint ownership challenge handshake
      if (result.payload.type === 'endpoint.challenge' || result.payload.data?.challenge) {
        const challenge = result.payload.data?.challenge || (result.payload.data as any)?.token;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge }));
        return result;
      }

      // Normal event acknowledgement
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'acknowledged',
        event_id: result.eventId,
        duplicate: result.isDuplicate,
        stale: result.isStaleStateVersion,
      }));
      return result;
    } catch (err: unknown) {
      if (err instanceof WebhookVerificationError) {
        res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
          },
        }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'INTERNAL_RECEIVER_ERROR',
            message: err instanceof Error ? err.message : String(err),
          },
        }));
      }
      return null;
    }
  }

  public getKnownJobStateVersion(jobId: string): number | undefined {
    return this.jobStateVersions.get(jobId);
  }

  public clearDedupeCache(): void {
    this.processedEvents.clear();
    this.jobStateVersions.clear();
  }

  /**
   * Dynamically updates signing secrets (e.g. upon secret rotation or endpoint verification).
   */
  public updateSecrets(secrets: WebhookSecretConfig[] | string): void {
    if (typeof secrets === 'string') {
      this.secrets.length = 0;
      this.secrets.push({ keyId: 'default', secret: secrets });
    } else if (Array.isArray(secrets) && secrets.length > 0) {
      this.secrets.length = 0;
      this.secrets.push(...secrets);
    }
  }

  private pruneExpired(now: Date): void {
    const nowMs = now.getTime();
    for (const [id, time] of this.processedEvents.entries()) {
      if (nowMs - time >= this.retentionMs) {
        this.processedEvents.delete(id);
      }
    }
  }

  private readRawBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', (err) => reject(err));
    });
  }
}
