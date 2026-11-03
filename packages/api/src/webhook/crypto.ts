/**
 * Webhook Cryptography, At-Rest Encryption & HMAC Signing (Task P4-04).
 *
 * Canonical specifications:
 *   - docs/API.md ("Signed webhooks", lines 141-152)
 *   - docs/SECURITY.md ("Control plane secrets", lines 20-24)
 */

import crypto from 'node:crypto';
import {
  WEBHOOK_MAX_CLOCK_SKEW_SECONDS,
} from './types.js';

export class WebhookCryptoError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(message: string, code = 'WEBHOOK_CRYPTO_ERROR', httpStatus = 400) {
    super(message);
    this.name = 'WebhookCryptoError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class WebhookVerificationError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(message: string, code = 'SIGNATURE_VERIFICATION_FAILED', httpStatus = 401) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const DEFAULT_MASTER_PEPPER = 'creativanta-cve-webhook-master-key-at-rest-v1';

export function deriveMasterKey(rawKey?: Buffer | string): Buffer {
  const source = rawKey || process.env['CVE_SECRET_MASTER_KEY'] || process.env['CVE_JWT_SECRET'] || DEFAULT_MASTER_PEPPER;
  return crypto.createHash('sha256').update(source).digest();
}

/**
 * Encrypts a webhook signing secret at rest using AES-256-GCM.
 * Output format: `enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>`
 */
export function encryptSecretAtRest(plaintext: string, masterKey?: Buffer | string): string {
  const key = deriveMasterKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a webhook signing secret from encrypted storage at rest.
 */
export function decryptSecretAtRest(ciphertext: string, masterKey?: Buffer | string): string {
  if (!ciphertext.startsWith('enc:v1:')) {
    // Return as-is if unencrypted (e.g. in test stubs)
    return ciphertext;
  }

  const parts = ciphertext.split(':');
  if (parts.length === 5) {
    // Standard format: enc:v1:<iv>:<tag>:<ciphertext>
    const [, , ivHex, tagHex, dataHex] = parts;
    if (!ivHex || !tagHex || !dataHex) {
      throw new WebhookCryptoError('Malformed AES-256-GCM encrypted secret ciphertext');
    }
    const key = deriveMasterKey(masterKey);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  if (parts.length === 3) {
    // Fallback for legacy sha256 stub: enc:v1:<hash>
    return ciphertext;
  }

  throw new WebhookCryptoError(`Invalid ciphertext envelope: ${ciphertext}`);
}

/**
 * Generates a high-entropy signing secret (32 random bytes hex encoded).
 */
export function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Computes HMAC-SHA256 signature over exact raw body bytes:
 * Signature = HMAC-SHA256(secret, `${timestamp}.${raw_body_bytes}`)
 *
 * Requirements:
 * - timestamp is ASCII decimal
 * - raw_body_bytes is exact UTF-8 body bytes as sent over HTTP (no reserialization!)
 */
export function computeWebhookSignature(
  secret: string,
  timestampSeconds: number | string,
  rawBodyBytes: Buffer | Uint8Array | string,
): string {
  const tsStr = String(timestampSeconds);
  const bodyBuf = Buffer.isBuffer(rawBodyBytes)
    ? rawBodyBytes
    : typeof rawBodyBytes === 'string'
      ? Buffer.from(rawBodyBytes, 'utf8')
      : Buffer.from(rawBodyBytes);

  const prefixBuf = Buffer.from(`${tsStr}.`, 'utf8');
  const payloadToSign = Buffer.concat([prefixBuf, bodyBuf]);

  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadToSign);
  return hmac.digest('hex');
}

/**
 * Constant-time comparison between two hex signature strings.
 */
export function compareSignaturesConstantTime(actualHex: string, expectedHex: string): boolean {
  if (typeof actualHex !== 'string' || typeof expectedHex !== 'string') {
    return false;
  }
  const actualBuf = Buffer.from(actualHex, 'hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length || actualBuf.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

/**
 * Validates the `X-CVE-Signature` header value (format: `v1=<hex>`).
 */
export function parseSignatureHeader(headerValue: string | undefined): { version: string; signature: string } {
  if (!headerValue || typeof headerValue !== 'string') {
    throw new WebhookVerificationError('Missing X-CVE-Signature header');
  }

  const match = /^([a-zA-Z0-9]+)=([0-9a-fA-F]{64})$/.exec(headerValue.trim());
  if (!match) {
    throw new WebhookVerificationError(
      `Invalid X-CVE-Signature format: "${headerValue}". Expected format: v1=<64 lowercase hex>`,
    );
  }

  return {
    version: match[1]!,
    signature: match[2]!.toLowerCase(),
  };
}

export interface VerifySignatureOptions {
  headers: Record<string, string | string[] | undefined>;
  rawBodyBytes: Buffer | Uint8Array | string;
  secrets: Array<{
    keyId: string;
    secret: string;
    expiresAt?: Date | string | null;
  }>;
  now?: Date;
  maxClockSkewSeconds?: number;
}

export interface VerifySignatureResult {
  valid: true;
  eventId: string;
  timestamp: number;
  keyId: string;
  signature: string;
}

/**
 * Receiver signature validator:
 * 1. Checks timestamp clock skew (|current_time - timestamp| <= 300s)
 * 2. Checks X-CVE-Event-Id, X-CVE-Key-Id, X-CVE-Timestamp
 * 3. Resolves signing secret matching key ID (including active key or rotated previous key within grace period)
 * 4. Compares HMAC-SHA256 signature over exact raw bytes using constant-time comparison
 */
export function verifyWebhookSignature(options: VerifySignatureOptions): VerifySignatureResult {
  const getHeader = (name: string): string | undefined => {
    const direct = options.headers[name] ?? options.headers[name.toLowerCase()];
    return Array.isArray(direct) ? direct[0] : direct;
  };

  const eventId = getHeader('x-cve-event-id');
  if (!eventId || eventId.trim().length === 0) {
    throw new WebhookVerificationError('Missing or empty X-CVE-Event-Id header');
  }

  const timestampStr = getHeader('x-cve-timestamp');
  if (!timestampStr || !/^\d+$/.test(timestampStr)) {
    throw new WebhookVerificationError('Missing or invalid X-CVE-Timestamp header (must be Unix seconds integer)');
  }
  const timestamp = parseInt(timestampStr, 10);

  const now = options.now ?? new Date();
  const currentSeconds = Math.floor(now.getTime() / 1000);
  const maxClockSkew = options.maxClockSkewSeconds ?? WEBHOOK_MAX_CLOCK_SKEW_SECONDS;
  const skew = Math.abs(currentSeconds - timestamp);

  if (skew > maxClockSkew) {
    throw new WebhookVerificationError(
      `Webhook timestamp skew of ${skew}s exceeds maximum allowed clock skew of ${maxClockSkew}s (current=${currentSeconds}, received=${timestamp})`,
    );
  }

  const keyId = getHeader('x-cve-key-id');
  if (!keyId || keyId.trim().length === 0) {
    throw new WebhookVerificationError('Missing or empty X-CVE-Key-Id header');
  }

  const sigHeader = getHeader('x-cve-signature');
  const { version, signature } = parseSignatureHeader(sigHeader);
  if (version !== 'v1') {
    throw new WebhookVerificationError(`Unsupported signature version "${version}". Only v1 is supported`);
  }

  const matchingSecret = options.secrets.find((s) => s.keyId === keyId);
  if (!matchingSecret) {
    throw new WebhookVerificationError(`No matching webhook secret found for key ID "${keyId}"`);
  }

  if (matchingSecret.expiresAt) {
    const expiresAtMs = typeof matchingSecret.expiresAt === 'string'
      ? Date.parse(matchingSecret.expiresAt)
      : matchingSecret.expiresAt.getTime();
    if (now.getTime() > expiresAtMs) {
      throw new WebhookVerificationError(
        `Webhook key ID "${keyId}" expired at ${new Date(expiresAtMs).toISOString()}`,
      );
    }
  }

  const expectedSignature = computeWebhookSignature(matchingSecret.secret, timestamp, options.rawBodyBytes);
  const match = compareSignaturesConstantTime(signature, expectedSignature);

  if (!match) {
    throw new WebhookVerificationError(
      'HMAC signature mismatch: computed signature does not match received X-CVE-Signature',
    );
  }

  return {
    valid: true,
    eventId,
    timestamp,
    keyId,
    signature,
  };
}
