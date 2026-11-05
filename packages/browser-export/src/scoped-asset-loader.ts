/**
 * Scoped Asset Loader and Offline Grant Cache (Task P8-02).
 *
 * Enforces the strict rule: "offline assets chỉ scoped grants".
 * Client-side browser export may ONLY access media assets (images, audio, fonts)
 * using short-lived, cryptographically signed download grants.
 *
 * Prevents SSRF, cross-tenant data leaks, tampering, and arbitrary URL fetching.
 */

import crypto from 'node:crypto';
import type {
  ScopedAssetGrant,
  ScopedAssetGrantPayload,
  ScopedAssetCacheEntry,
  IScopedAssetLoader,
} from './types.js';

export class ScopedGrantError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;

  constructor(message: string, code: string = 'INVALID_SCOPED_GRANT', httpStatus: number = 403) {
    super(message);
    this.name = 'ScopedGrantError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class AssetIntegrityError extends Error {
  public readonly code = 'ASSET_HASH_MISMATCH';
  public readonly expectedHash: string;
  public readonly actualHash: string;

  constructor(message: string, expectedHash: string, actualHash: string) {
    super(message);
    this.name = 'AssetIntegrityError';
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export class SecurityIsolationError extends Error {
  public readonly code: string;

  constructor(message: string, code: string = 'UNAUTHORIZED_ASSET_SOURCE') {
    super(message);
    this.name = 'SecurityIsolationError';
    this.code = code;
  }
}

/**
 * Computes canonical HMAC-SHA256 signature for a scoped asset grant payload.
 */
export function computeScopedGrantSignature(
  payload: ScopedAssetGrantPayload,
  pepper: string,
): string {
  const hmac = crypto.createHmac('sha256', pepper);
  const data = [
    payload.tenantId,
    payload.assetId,
    String(payload.version ?? 1),
    payload.filename,
    payload.mimeType,
    payload.sha256,
    String(payload.bytes),
    payload.expiresAt,
    payload.grantKind,
  ].join(':');
  hmac.update(data, 'utf8');
  return hmac.digest('hex');
}

/**
 * Generates a signed scoped asset grant for testing or client authorization.
 * TTL is bounded to 300 seconds (5 minutes) maximum per docs/SECURITY.md.
 */
export function generateScopedAssetGrant(
  params: {
    tenantId: string;
    assetId: string;
    version?: number;
    filename: string;
    mimeType: string;
    sha256: string;
    bytes: number;
    ttlSeconds?: number;
    grantKind?: 'download' | 'artifact_download' | 'browser_export_asset';
  },
  options: {
    pepper: string;
    baseUrl?: string;
    now?: Date;
  },
): ScopedAssetGrant {
  const now = options.now ?? new Date();
  const ttlSeconds = Math.min(params.ttlSeconds ?? 300, 300);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const payload: ScopedAssetGrantPayload = {
    tenantId: params.tenantId,
    assetId: params.assetId,
    version: params.version ?? 1,
    filename: params.filename,
    mimeType: params.mimeType,
    sha256: params.sha256.toLowerCase(),
    bytes: params.bytes,
    expiresAt,
    grantKind: params.grantKind ?? 'browser_export_asset',
  };

  const sig = computeScopedGrantSignature(payload, options.pepper);
  const envelope = { ...payload, sig };
  const token = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  const baseUrl = (options.baseUrl ?? 'https://video.example.invalid/v1').replace(/\/+$/, '');
  const downloadUrl = `${baseUrl}/assets/download/${token}`;

  return {
    ...payload,
    token,
    downloadUrl,
    sig,
  };
}

export interface VerifyScopedGrantOptions {
  pepper: string;
  expectedTenantId?: string;
  now?: Date;
  revocationStore?: {
    isGrantRevoked(tenantId: string, assetId: string, sig: string): boolean;
  };
}

/**
 * Cryptographically verifies a scoped asset grant token.
 * Enforces constant-time signature comparison, tenant boundary, and expiration.
 */
export function verifyScopedAssetGrant(
  tokenOrUrl: string,
  options: VerifyScopedGrantOptions,
): ScopedAssetGrantPayload {
  // Extract token from URL if full URL is passed
  let token = tokenOrUrl.trim();
  if (token.startsWith('http://') || token.startsWith('https://')) {
    const urlMatch = /\/(?:assets|artifacts)\/download\/([^/?#]+)/.exec(token);
    if (urlMatch) {
      token = urlMatch[1]!;
    } else {
      throw new SecurityIsolationError(
        `[SECURITY_VIOLATION] Arbitrary external URL rejected: '${tokenOrUrl}'. Offline assets must use scoped download grants only.`,
        'ARBITRARY_URL_REJECTED',
      );
    }
  }

  // Reject local file/socket paths
  if (token.startsWith('file:') || token.startsWith('/') || token.startsWith('../')) {
    throw new SecurityIsolationError(
      `[SECURITY_VIOLATION] Local file access prohibited: '${tokenOrUrl}'. Offline assets must use scoped grants only.`,
      'LOCAL_FILE_ACCESS_PROHIBITED',
    );
  }

  let envelope: (ScopedAssetGrantPayload & { sig: string }) | null = null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    envelope = JSON.parse(jsonStr) as ScopedAssetGrantPayload & { sig: string };
  } catch {
    throw new ScopedGrantError('Malformed scoped asset grant token', 'MALFORMED_GRANT_TOKEN', 400);
  }

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.sig !== 'string' ||
    typeof envelope.tenantId !== 'string' ||
    typeof envelope.assetId !== 'string' ||
    typeof envelope.filename !== 'string' ||
    typeof envelope.mimeType !== 'string' ||
    typeof envelope.sha256 !== 'string' ||
    typeof envelope.bytes !== 'number' ||
    typeof envelope.expiresAt !== 'string'
  ) {
    throw new ScopedGrantError('Invalid scoped grant envelope schema', 'INVALID_GRANT_SCHEMA', 400);
  }

  // Tenant Boundary Check
  if (options.expectedTenantId && envelope.tenantId !== options.expectedTenantId) {
    throw new ScopedGrantError(
      `[SECURITY_VIOLATION] Cross-tenant asset access denied: grant belongs to '${envelope.tenantId}', expected '${options.expectedTenantId}'.`,
      'CROSS_TENANT_ACCESS_DENIED',
      403,
    );
  }

  // Signature verification in constant time
  const expectedSig = computeScopedGrantSignature(
    {
      tenantId: envelope.tenantId,
      assetId: envelope.assetId,
      version: envelope.version,
      filename: envelope.filename,
      mimeType: envelope.mimeType,
      sha256: envelope.sha256,
      bytes: envelope.bytes,
      expiresAt: envelope.expiresAt,
      grantKind: envelope.grantKind,
    },
    options.pepper,
  );

  const providedSigBuf = Buffer.from(envelope.sig, 'hex');
  const expectedSigBuf = Buffer.from(expectedSig, 'hex');

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    throw new ScopedGrantError('Scoped asset grant signature verification failed', 'INVALID_GRANT_SIGNATURE', 403);
  }

  // Revocation check
  if (options.revocationStore?.isGrantRevoked(envelope.tenantId, envelope.assetId, envelope.sig)) {
    throw new ScopedGrantError('Scoped asset grant has been revoked', 'GRANT_REVOKED', 410);
  }

  // Expiration check
  const nowMs = (options.now ?? new Date()).getTime();
  const expiryMs = Date.parse(envelope.expiresAt);
  if (Number.isNaN(expiryMs) || nowMs >= expiryMs) {
    throw new ScopedGrantError('Scoped asset grant has expired', 'GRANT_EXPIRED', 410);
  }

  return {
    tenantId: envelope.tenantId,
    assetId: envelope.assetId,
    version: envelope.version,
    filename: envelope.filename,
    mimeType: envelope.mimeType,
    sha256: envelope.sha256,
    bytes: envelope.bytes,
    expiresAt: envelope.expiresAt,
    grantKind: envelope.grantKind,
  };
}

/**
 * In-memory / OPFS-compatible scoped asset loader and offline cache.
 */
export class ScopedAssetLoader implements IScopedAssetLoader {
  private readonly pepper: string;
  private readonly expectedTenantId?: string;
  private readonly offlineCache = new Map<string, ScopedAssetCacheEntry>();
  private readonly mockByteProvider?: (assetId: string, grant: ScopedAssetGrantPayload) => Uint8Array;

  constructor(options: {
    pepper: string;
    expectedTenantId?: string;
    mockByteProvider?: (assetId: string, grant: ScopedAssetGrantPayload) => Uint8Array;
  }) {
    this.pepper = options.pepper;
    this.expectedTenantId = options.expectedTenantId;
    this.mockByteProvider = options.mockByteProvider;
  }

  private makeCacheKey(tenantId: string, assetId: string, sha256: string): string {
    return `${tenantId}::${assetId}::${sha256.toLowerCase()}`;
  }

  /**
   * Caches verified asset bytes in offline cache.
   */
  public cacheAsset(entry: ScopedAssetCacheEntry): void {
    const key = this.makeCacheKey(entry.tenantId, entry.assetId, entry.sha256);
    this.offlineCache.set(key, entry);
  }

  /**
   * Retrieves an asset from offline cache only after verifying tenant and hash.
   */
  public getCachedAsset(tenantId: string, assetId: string, expectedSha256: string): Uint8Array | null {
    if (this.expectedTenantId && tenantId !== this.expectedTenantId) {
      throw new ScopedGrantError('Cross-tenant offline cache access prohibited', 'CROSS_TENANT_ACCESS_DENIED', 403);
    }
    const key = this.makeCacheKey(tenantId, assetId, expectedSha256);
    const entry = this.offlineCache.get(key);
    return entry ? entry.data : null;
  }

  /**
   * Loads an asset using a scoped grant token or signed URL.
   * Performs cryptographic validation, hash verification, and offline caching.
   */
  public async loadAsset(
    grantTokenOrUrl: string,
    tenantIdOverride?: string,
  ): Promise<{ data: Uint8Array; mimeType: string; sha256: string }> {
    const targetTenant = tenantIdOverride ?? this.expectedTenantId;
    const grant = verifyScopedAssetGrant(grantTokenOrUrl, {
      pepper: this.pepper,
      expectedTenantId: targetTenant,
    });

    // 1. Check offline cache first
    const cached = this.getCachedAsset(grant.tenantId, grant.assetId, grant.sha256);
    if (cached) {
      return {
        data: cached,
        mimeType: grant.mimeType,
        sha256: grant.sha256,
      };
    }

    // 2. Fetch or provide raw asset bytes
    let rawBytes: Uint8Array;
    if (this.mockByteProvider) {
      rawBytes = this.mockByteProvider(grant.assetId, grant);
    } else {
      throw new ScopedGrantError(
        `Asset '${grant.assetId}' not available in offline cache and no network fetch provider configured`,
        'ASSET_NOT_FOUND_IN_CACHE',
        404,
      );
    }

    // 3. Cryptographic Content-Integrity Check (SHA-256)
    const actualHash = crypto.createHash('sha256').update(rawBytes).digest('hex').toLowerCase();
    if (actualHash !== grant.sha256.toLowerCase()) {
      throw new AssetIntegrityError(
        `Asset content hash mismatch for '${grant.assetId}'. Expected ${grant.sha256}, got ${actualHash}`,
        grant.sha256,
        actualHash,
      );
    }

    // 4. Cache verified bytes for offline rendering
    this.cacheAsset({
      tenantId: grant.tenantId,
      assetId: grant.assetId,
      sha256: grant.sha256,
      mimeType: grant.mimeType,
      bytes: rawBytes.byteLength,
      data: rawBytes,
      cachedAt: new Date().toISOString(),
    });

    return {
      data: rawBytes,
      mimeType: grant.mimeType,
      sha256: grant.sha256,
    };
  }
}
