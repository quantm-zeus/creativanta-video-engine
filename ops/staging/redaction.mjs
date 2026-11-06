/**
 * Creativanta Video Engine — Staging Secret Redaction & Token Masking
 * Canonical specifications:
 *   - docs/SECURITY.md (Token exfiltration prevention, URL query stripping, bearer capability protection)
 *   - docs/DEPLOYMENT.md (Telemetry & logging redaction)
 *   - AGENTS.md (No secrets in outputs/logs/evidence)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import { URL } from 'node:url';

/**
 * Sensitive field names that must be redacted when inspecting objects or headers.
 */
const SENSITIVE_KEY_PATTERN = /(?:key|secret|token|password|auth|credential|signature|sig|authorization|cookie|pepper)/i;

/**
 * Masks a sensitive secret or API key, displaying only safe prefix and suffix.
 *
 * @param {string | null | undefined} value
 * @param {number} [prefixLength=4]
 * @param {number} [suffixLength=4]
 * @returns {string}
 */
export function maskSecret(value, prefixLength = 4, suffixLength = 4) {
  if (!value || typeof value !== 'string') {
    return '[REDACTED]';
  }
  const str = value.trim();
  if (str.length === 0) return '';
  if (str.length <= prefixLength + suffixLength + 2) {
    return '[REDACTED]';
  }
  return `${str.slice(0, prefixLength)}...${str.slice(-suffixLength)}`;
}

/**
 * Sanitizes a URL string by stripping userinfo (passwords) and sensitive query parameters
 * (such as signed grant tokens, HMAC signatures, S3 credentials).
 *
 * @param {string | null | undefined} urlStr
 * @returns {string} Sanitized URL
 */
export function sanitizeUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  try {
    const parsed = new URL(urlStr);
    parsed.username = '';
    parsed.password = '';

    const params = new URLSearchParams(parsed.search);
    const keysToDelete = [];

    for (const [key] of params.entries()) {
      if (
        SENSITIVE_KEY_PATTERN.test(key) ||
        key.startsWith('X-Amz-') ||
        key.startsWith('x-cve-') ||
        key === 'Signature' ||
        key === 'token'
      ) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      params.delete(key);
    }

    parsed.search = params.toString() ? `?${params.toString()}` : '';
    parsed.hash = '';

    return parsed.toString();
  } catch {
    // If invalid URL, strip potential query/fragment
    return urlStr.split('?')[0].split('#')[0];
  }
}

/**
 * Recursively redacts sensitive keys from an object or array.
 * Uses ancestor tracking to prevent infinite recursion on true cycles.
 *
 * @param {unknown} input
 * @param {Set<object>} [ancestors=new Set()]
 * @returns {unknown} Redacted deep copy
 */
export function redactObject(input, ancestors = new Set()) {
  if (input === null || typeof input !== 'object') {
    return input;
  }

  if (ancestors.has(input)) {
    return '[CIRCULAR]';
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item, nextAncestors));
  }

  const result = {};
  for (const [key, val] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      result[key] = typeof val === 'string' && val.length > 8 ? maskSecret(val) : '[REDACTED]';
    } else if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
      result[key] = sanitizeUrl(val);
    } else if (typeof val === 'object' && val !== null) {
      result[key] = redactObject(val, nextAncestors);
    } else {
      result[key] = val;
    }
  }

  return result;
}

/**
 * Logger that automatically scrubs known secrets and sensitive patterns before output.
 */
export class RedactedLogger {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.registeredSecrets = new Set();
  }

  /**
   * Registers a secret string so it will always be masked if it appears in any log message.
   * @param {string | undefined} secret
   */
  registerSecret(secret) {
    if (secret && typeof secret === 'string' && secret.trim().length >= 4) {
      this.registeredSecrets.add(secret.trim());
    }
  }

  /**
   * Scrubs any registered secrets and raw token formats from string.
   * @param {string} text
   * @returns {string}
   */
  scrub(text) {
    if (!text || typeof text !== 'string') return '';
    let scrubbed = text;

    for (const sec of this.registeredSecrets) {
      if (sec && scrubbed.includes(sec)) {
        scrubbed = scrubbed.replaceAll(sec, maskSecret(sec));
      }
    }

    // Mask Authorization header formats
    scrubbed = scrubbed.replace(
      /(Bearer\s+)([A-Za-z0-9_\-.~+/=]{8,})/gi,
      (_, prefix, token) => `${prefix}${maskSecret(token)}`
    );

    // Mask URL signatures in logs
    scrubbed = scrubbed.replace(
      /([?&](?:token|signature|sig|X-Amz-Signature)=)[^&\s]+/gi,
      '$1[REDACTED]'
    );

    return scrubbed;
  }

  info(msg, meta) {
    this.log('INFO', msg, meta);
  }

  warn(msg, meta) {
    this.log('WARN', msg, meta);
  }

  error(msg, meta) {
    this.log('ERROR', msg, meta);
  }

  debug(msg, meta) {
    this.log('DEBUG', msg, meta);
  }

  log(level, msg, meta) {
    const time = new Date().toISOString();
    let line = `[${time}] [${level}] ${this.scrub(msg)}`;
    if (meta !== undefined) {
      const redactedMeta = redactObject(meta);
      line += ` ${JSON.stringify(redactedMeta)}`;
    }
    this.stream.write(`${line}\n`);
  }
}
