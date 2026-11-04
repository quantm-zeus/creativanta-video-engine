/**
 * Creativanta Video Engine - Redacted Structured Logger
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("Logs JSON chứa timestamps/stage/error category và IDs...", line 37)
 *   - docs/SECURITY.md ("Log redaction trước sink... Signed URLs strip query trong logs", line 23)
 *   - docs/OPERATIONS.md ("Worker stderr capped 64KiB/attempt sau redaction", line 37)
 */

export const MAX_STDERR_BYTES_PER_ATTEMPT = 64 * 1024; // 64 KiB

// Patterns for credential detection
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi;
const API_KEY_PREFIX_REGEX = /\b(cve_(?:live|test|migrator|api|sender|dispatcher)_[0-9a-zA-Z_]{12,128})\b/g;
const WEBHOOK_SECRET_REGEX = /\b(whsec_[0-9a-zA-Z_]{8,128})\b/g;
const EXTERNAL_SECRET_REGEX = /\b(sk-[0-9a-zA-Z_-]{16,128}|gh[pousr]_[0-9a-zA-Z]{20,128}|AKIA[0-9A-Z]{16})\b/g;
const PRIVATE_KEY_BLOCK_REGEX = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const CONNECTION_URI_CREDENTIALS_REGEX = /((?:postgres(?:ql)?|redis|amqp|mongodb(?:\+srv)?):\/\/[^:\s/]+:)([^@\s]+)(@)/gi;
const GENERIC_HEX_KEY_REGEX = /\b([0-9a-f]{32,64})\b/gi;
const SIGNED_URL_REGEX = /(https?:\/\/[^\s"'<>]+)(\?[^\s"'<>]+)/gi;

const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'api_key',
  'apikey',
  'secret',
  'webhook_secret',
  'signing_secret',
  'client_secret',
  'secret_key',
  'private_key',
  'signing_key',
  'encryption_key',
  'master_key',
  'access_key',
  'password',
  'pepper',
  'token',
  'access_token',
  'refresh_token',
  'database_url',
  'upload_url',
  'download_url',
  'signed_url',
  'prompt',
  'voice_text',
  'script',
  'script_source',
  'subtitles',
  'raw_caption',
]);

function isSensitiveKeyName(lowerKey) {
  if (SENSITIVE_KEY_NAMES.has(lowerKey)) return true;
  if (
    lowerKey.endsWith('_secret') ||
    lowerKey.endsWith('_token') ||
    lowerKey.endsWith('_password') ||
    lowerKey.endsWith('_pepper')
  ) {
    return true;
  }
  return false;
}

/**
 * Strips sensitive query strings from signed URLs while preserving scheme and path.
 */
export function redactSignedUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.search) {
      return `${parsed.origin}${parsed.pathname}?[REDACTED_QUERY]`;
    }
    return urlStr;
  } catch {
    return urlStr.replace(SIGNED_URL_REGEX, '$1?[REDACTED_QUERY]');
  }
}

/**
 * Sanitizes arbitrary text strings by removing keys, tokens, and signed query params.
 */
export function redactString(str) {
  if (typeof str !== 'string') return str;

  let sanitized = str
    .replace(PRIVATE_KEY_BLOCK_REGEX, '[REDACTED_PRIVATE_KEY]')
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED_TOKEN]')
    .replace(API_KEY_PREFIX_REGEX, '[REDACTED_API_KEY]')
    .replace(WEBHOOK_SECRET_REGEX, '[REDACTED_WEBHOOK_SECRET]')
    .replace(EXTERNAL_SECRET_REGEX, '[REDACTED_EXTERNAL_SECRET]')
    .replace(CONNECTION_URI_CREDENTIALS_REGEX, '$1[REDACTED_PASSWORD]$3');

  // Redact URLs with query parameters that resemble signed capabilities
  sanitized = sanitized.replace(SIGNED_URL_REGEX, (match, base) => {
    return `${base}?[REDACTED_QUERY]`;
  });

  return sanitized;
}

/**
 * Recursively deep-redacts objects, masking known sensitive fields.
 */
export function redactObject(obj, depth = 0) {
  if (depth > 8) return '[MAX_DEPTH_REACHED]';
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return redactString(obj);
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, depth + 1));
  }

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    if (isSensitiveKeyName(lowerKey)) {
      if (lowerKey.includes('url') && lowerKey !== 'database_url') {
        result[key] = typeof value === 'string' ? redactSignedUrl(value) : '[REDACTED_URL]';
      } else if (lowerKey.includes('prompt') || lowerKey.includes('script') || lowerKey.includes('voice')) {
        result[key] = '[REDACTED_PROMPT_OR_SCRIPT]';
      } else {
        result[key] = '[REDACTED_CREDENTIAL]';
      }
    } else {
      result[key] = redactObject(value, depth + 1);
    }
  }
  return result;
}

/**
 * Enforces worker stderr bounding of 64KiB per attempt after redaction.
 */
export function sanitizeAndCapStderr(stderrText, maxBytes = MAX_STDERR_BYTES_PER_ATTEMPT) {
  if (!stderrText) return '';
  const sanitized = redactString(stderrText);
  const buf = Buffer.from(sanitized, 'utf-8');

  if (buf.length <= maxBytes) {
    return sanitized;
  }

  const truncatedBuf = buf.subarray(0, maxBytes);
  const truncatedText = truncatedBuf.toString('utf-8');
  return `${truncatedText}\n[STDERR_TRUNCATED_MAX_64KIB]`;
}

export class RedactedLogger {
  constructor(service = 'creativanta-video-engine', sink = console.log) {
    this.service = service;
    this.sink = sink;
    this.entries = []; // In-memory buffer for testing/verification
  }

  log(level, stage, message, fields = {}) {
    const {
      requestId = null,
      jobId = null,
      attemptId = null,
      leaseEpoch = null,
      artifactIds = [],
      eventId = null,
      deliveryId = null,
      errorCode = null,
      details = null,
    } = fields;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      stage,
      request_id: requestId,
      job_id: jobId,
      attempt_id: attemptId,
      lease_epoch: leaseEpoch,
      artifact_ids: artifactIds.length > 0 ? artifactIds : undefined,
      event_id: eventId,
      delivery_id: deliveryId,
      message: redactString(message),
      error_code: errorCode || undefined,
      details: details ? redactObject(details) : undefined,
    };

    this.entries.push(entry);
    const jsonStr = JSON.stringify(entry);
    if (this.sink) {
      this.sink(jsonStr);
    }
    return entry;
  }

  debug(stage, message, fields) {
    return this.log('debug', stage, message, fields);
  }

  info(stage, message, fields) {
    return this.log('info', stage, message, fields);
  }

  warn(stage, message, fields) {
    return this.log('warn', stage, message, fields);
  }

  error(stage, message, fields) {
    return this.log('error', stage, message, fields);
  }

  getEntries() {
    return [...this.entries];
  }

  clear() {
    this.entries = [];
  }
}

export const defaultLogger = new RedactedLogger('cve-runtime');
