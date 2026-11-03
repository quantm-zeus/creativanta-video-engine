/**
 * Tenant Identity, API Key Hashing, Constant-Time Verification, Scope Guard,
 * and Tenant-Bound Signed Pagination Cursors.
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Tenant identity và secrets", lines 19-23)
 *   - docs/API.md ("Quy tắc chung", lines 7-14)
 */

import crypto from 'node:crypto';

export type ApiScope =
  | 'templates:read'
  | 'templates:write'
  | 'compositions:read'
  | 'compositions:write'
  | 'assets:read'
  | 'assets:write'
  | 'jobs:read'
  | 'jobs:write'
  | 'webhooks:manage'
  | 'usage:read'
  | 'authoring:write';

export const ALL_API_SCOPES: readonly ApiScope[] = Object.freeze([
  'templates:read',
  'templates:write',
  'compositions:read',
  'compositions:write',
  'assets:read',
  'assets:write',
  'jobs:read',
  'jobs:write',
  'webhooks:manage',
  'usage:read',
  'authoring:write',
]);

export interface StoredApiKeyRecord {
  tenant_id: string;
  id: string;
  key_prefix: string;
  key_hash: string;
  pepper_version: string;
  name: string;
  scopes: ApiScope[];
  rotated_from_key_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  tenant_status?: 'active' | 'suspended' | 'deleted';
}

export interface GeneratedApiKeyMaterial {
  plaintextKey: string;
  keyPrefix: string;
  keyHash: string;
  pepperVersion: string;
  entropyBytes: number;
}

export interface ParsedApiKeyToken {
  keyPrefix: string;
  secretHex: string;
  environment: 'live' | 'test';
}

export interface ApiKeyVerificationResult {
  authenticated: boolean;
  errorCode?: 'UNAUTHENTICATED' | 'TENANT_SUSPENDED';
  httpStatus?: 401 | 403;
  reason?: string;
  tenantId?: string;
  keyId?: string;
  scopes?: ApiScope[];
}

const TOKEN_REGEX = /^(cve_(live|test)_[0-9a-f]{12})_([0-9a-f]{64})$/;
const DUMMY_KEY_HASH_HEX = '0'.repeat(64);

/**
 * Computes a keyed HMAC-SHA256 digest (64 lowercase hex characters) binding the
 * pepper version, key prefix, and 32-byte random secret with the server pepper.
 */
export function computeApiKeyHash(
  secretHex: string,
  keyPrefix: string,
  pepper: string,
  pepperVersion = 'v1',
): string {
  if (!pepper || pepper.length < 16) {
    throw new Error('CVE_API_KEY_PEPPER must be at least 16 characters long');
  }
  return crypto
    .createHmac('sha256', Buffer.from(pepper, 'utf8'))
    .update(`${pepperVersion}:${keyPrefix}:${secretHex}`, 'utf8')
    .digest('hex');
}

/**
 * Generates a high-entropy (32 random bytes = 256 bits) API key with an opaque
 * lookup prefix (`cve_live_<12hex>` or `cve_test_<12hex>`) and keyed hash.
 * Plaintext is returned once and must never be persisted to the database.
 */
export function generateApiKeyMaterial(options: {
  environment?: 'live' | 'test';
  pepper: string;
  pepperVersion?: string;
}): GeneratedApiKeyMaterial {
  const envTag = options.environment ?? 'live';
  const pepperVersion = options.pepperVersion ?? 'v1';
  const prefixRandomHex = crypto.randomBytes(6).toString('hex');
  const secretBytes = crypto.randomBytes(32); // 32 bytes high-entropy secret per docs/SECURITY.md
  const secretHex = secretBytes.toString('hex');
  const keyPrefix = `cve_${envTag}_${prefixRandomHex}`;
  const plaintextKey = `${keyPrefix}_${secretHex}`;
  const keyHash = computeApiKeyHash(secretHex, keyPrefix, options.pepper, pepperVersion);

  return {
    plaintextKey,
    keyPrefix,
    keyHash,
    pepperVersion,
    entropyBytes: secretBytes.byteLength,
  };
}

/**
 * Parses a raw Bearer token into its lookup prefix and 32-byte secret hex.
 * Returns null if the token does not match the canonical format.
 */
export function parseApiKeyToken(rawToken: string): ParsedApiKeyToken | null {
  if (typeof rawToken !== 'string') {
    return null;
  }
  const trimmed = rawToken.trim();
  const match = TOKEN_REGEX.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    keyPrefix: match[1]!,
    environment: match[2] as 'live' | 'test',
    secretHex: match[3]!,
  };
}

/**
 * Constant-time hex digest comparison using crypto.timingSafeEqual.
 */
export function constantTimeHexEqual(hexA: string, hexB: string): boolean {
  if (hexA.length !== 64 || hexB.length !== 64) {
    return false;
  }
  const bufA = Buffer.from(hexA, 'hex');
  const bufB = Buffer.from(hexB, 'hex');
  if (bufA.byteLength !== 32 || bufB.byteLength !== 32) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a presented API key in constant time against a stored record (or a dummy
 * record when the prefix is not found, preventing prefix enumeration via timing).
 */
export function verifyApiKeyConstantTime(options: {
  rawToken: string | undefined;
  lookupByPrefix: (keyPrefix: string) => StoredApiKeyRecord | null;
  pepper: string;
  previousPeppers?: Record<string, string>;
  now?: Date;
}): ApiKeyVerificationResult {
  const now = options.now ?? new Date();
  const parsed = options.rawToken ? parseApiKeyToken(options.rawToken) : null;

  if (!parsed) {
    // Perform dummy HMAC + timingSafeEqual to equalize CPU work on malformed tokens
    const dummyHash = computeApiKeyHash(
      '0'.repeat(64),
      'cve_live_000000000000',
      options.pepper,
      'v1',
    );
    constantTimeHexEqual(dummyHash, DUMMY_KEY_HASH_HEX);
    return {
      authenticated: false,
      errorCode: 'UNAUTHENTICATED',
      httpStatus: 401,
      reason: 'Missing or malformed API key',
    };
  }

  const record = options.lookupByPrefix(parsed.keyPrefix);
  const activePepperVersion = record?.pepper_version ?? 'v1';
  const effectivePepper =
    (options.previousPeppers && options.previousPeppers[activePepperVersion]) || options.pepper;

  const computedHash = computeApiKeyHash(
    parsed.secretHex,
    parsed.keyPrefix,
    effectivePepper,
    activePepperVersion,
  );
  const expectedHash = record ? record.key_hash : DUMMY_KEY_HASH_HEX;
  const hashMatches = constantTimeHexEqual(computedHash, expectedHash);

  if (!record || !hashMatches) {
    return {
      authenticated: false,
      errorCode: 'UNAUTHENTICATED',
      httpStatus: 401,
      reason: 'Invalid API key',
    };
  }

  if (record.revoked_at !== null) {
    const revokedTime = Date.parse(record.revoked_at);
    if (Number.isNaN(revokedTime) || revokedTime <= now.getTime()) {
      return {
        authenticated: false,
        errorCode: 'UNAUTHENTICATED',
        httpStatus: 401,
        reason: 'API key has been revoked',
      };
    }
  }

  if (record.expires_at !== null) {
    const expiresTime = Date.parse(record.expires_at);
    if (!Number.isNaN(expiresTime) && expiresTime <= now.getTime()) {
      return {
        authenticated: false,
        errorCode: 'UNAUTHENTICATED',
        httpStatus: 401,
        reason: 'API key has expired',
      };
    }
  }

  if (record.tenant_status === 'deleted') {
    return {
      authenticated: false,
      errorCode: 'UNAUTHENTICATED',
      httpStatus: 401,
      reason: 'Tenant does not exist',
    };
  }

  if (record.tenant_status === 'suspended') {
    return {
      authenticated: false,
      errorCode: 'TENANT_SUSPENDED',
      httpStatus: 403,
      reason: 'Tenant account is suspended',
    };
  }

  return {
    authenticated: true,
    tenantId: record.tenant_id,
    keyId: record.id,
    scopes: [...record.scopes],
  };
}

/**
 * Checks whether the authenticated API key possesses all required scopes for an endpoint.
 */
export function hasRequiredScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly ApiScope[],
): boolean {
  const grantedSet = new Set(grantedScopes);
  return requiredScopes.every((req) => grantedSet.has(req));
}

export interface PaginationCursorPayload {
  t: string; // tenantId
  r: string; // route
  f: string; // filterHash
  c: string; // created_at ISO string
  i: string; // resource id
}

/**
 * Creates an opaque, HMAC-signed pagination cursor bound to the tenant, route, and filter.
 * Prevents cross-tenant cursor tampering or replay (docs/API.md line 14, docs/SECURITY.md line 21).
 */
export function encodeSignedCursor(options: {
  tenantId: string;
  route: string;
  filterHash?: string;
  createdAt: string;
  id: string;
  secret: string;
}): string {
  const payload: PaginationCursorPayload = {
    t: options.tenantId,
    r: options.route,
    f: options.filterHash ?? '',
    c: options.createdAt,
    i: options.id,
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', Buffer.from(options.secret, 'utf8'))
    .update(payloadBase64, 'utf8')
    .digest('hex');
  return `${payloadBase64}.${signature}`;
}

/**
 * Verifies and decodes a tenant-bound pagination cursor in constant time.
 * Returns null if the cursor is malformed, tampered with, or belongs to a different tenant/route/filter.
 */
export function decodeSignedCursor(options: {
  cursor: string;
  tenantId: string;
  route: string;
  filterHash?: string;
  secret: string;
}): { createdAt: string; id: string } | null {
  if (!options.cursor || typeof options.cursor !== 'string') {
    return null;
  }
  const parts = options.cursor.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payloadBase64, sigHex] = parts as [string, string];
  if (!payloadBase64 || !sigHex || !/^[0-9a-f]{64}$/.test(sigHex)) {
    return null;
  }

  const expectedSigHex = crypto
    .createHmac('sha256', Buffer.from(options.secret, 'utf8'))
    .update(payloadBase64, 'utf8')
    .digest('hex');

  if (!constantTimeHexEqual(sigHex, expectedSigHex)) {
    return null;
  }

  try {
    const decoded = JSON.parse(
      Buffer.from(payloadBase64, 'base64url').toString('utf8'),
    ) as PaginationCursorPayload;
    if (
      decoded.t !== options.tenantId ||
      decoded.r !== options.route ||
      decoded.f !== (options.filterHash ?? '') ||
      typeof decoded.c !== 'string' ||
      typeof decoded.i !== 'string'
    ) {
      return null;
    }
    return { createdAt: decoded.c, id: decoded.i };
  } catch {
    return null;
  }
}
