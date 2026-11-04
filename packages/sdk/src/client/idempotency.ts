/**
 * Idempotency Key Management & Canonical Hashing (Task P5-03).
 *
 * Canonical specification (docs/API.md line 9):
 *   "Idempotency-Key bắt buộc mọi POST (1–128 ký tự ASCII [A-Za-z0-9._:-]; sai định dạng trả 400 INVALID_IDEMPOTENCY_KEY,
 *    thiếu trả 400 IDEMPOTENCY_KEY_REQUIRED). Key scoped theo (tenant_id, method, normalized_path, key);
 *    request_hash tính bằng SHA-256 (64 lowercase hex) trên chuỗi JSON canonical hóa theo RFC 8785 (JCS, Unicode NFC,
 *    body rỗng chuẩn hóa thành ''), không tính raw whitespace hay auth token."
 */

import crypto from 'node:crypto';

export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Validates whether an idempotency key conforms to the strict API v1 format.
 */
export function isValidIdempotencyKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  return IDEMPOTENCY_KEY_REGEX.test(key);
}

/**
 * Generates a valid unique Idempotency-Key.
 */
export function generateIdempotencyKey(prefix = 'cve_idem'): string {
  const timestamp = Date.now().toString(36);
  const randomPart = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${timestamp}_${randomPart}`;
}

/**
 * Recursively canonicalizes a value according to RFC 8785 (JSON Canonicalization Scheme - JCS):
 *   - Object keys sorted by UTF-16 code units
 *   - Unicode strings normalized to NFC
 *   - Primitives formatted standardly
 */
export function canonicalizeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return value.normalize('NFC');
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }

  const sortedObj: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) {
    const val = (value as Record<string, unknown>)[k];
    if (val !== undefined) {
      sortedObj[k] = canonicalizeJsonValue(val);
    }
  }
  return sortedObj;
}

/**
 * Computes canonical request hash (64 lowercase hex) per docs/API.md line 9.
 */
export function computeCanonicalRequestHash(body: unknown): string {
  if (body === undefined || body === null || body === '') {
    return crypto.createHash('sha256').update('').digest('hex');
  }

  const canonicalObj = canonicalizeJsonValue(body);
  const canonicalJson = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
