/**
 * Signed Upload Grant & Quarantine Token Generator / Validator (Task P3-02).
 *
 * Canonical specifications:
 *   - docs/API.md ("Asset intake", lines 87-92)
 *   - docs/SECURITY.md ("Tenant identity và secrets", lines 19-24)
 */

import crypto from 'node:crypto';

export interface SignedUploadGrantPayload {
  tenantId: string;
  assetId: string;
  filename: string;
  mimeType: string;
  sha256: string;
  declaredBytes: number;
  maxBytes: number;
  expiresAt: string; // ISO 8601 UTC
}

export interface SignedUploadGrant extends SignedUploadGrantPayload {
  token: string;
  uploadUrl: string;
  requiredHeaders: Record<string, string>;
}

export class UploadGrantError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;

  constructor(message: string, httpStatus = 403, code = 'INVALID_UPLOAD_GRANT') {
    super(message);
    this.name = 'UploadGrantError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * Creates an HMAC-SHA256 signature over grant components to prevent tampering.
 */
function computeGrantSignature(
  payload: Omit<SignedUploadGrantPayload, 'token'>,
  pepper: string,
): string {
  const hmac = crypto.createHmac('sha256', pepper);
  const data = [
    payload.tenantId,
    payload.assetId,
    payload.filename,
    payload.mimeType,
    payload.sha256,
    String(payload.declaredBytes),
    String(payload.maxBytes),
    payload.expiresAt,
  ].join(':');
  hmac.update(data, 'utf8');
  return hmac.digest('hex');
}

/**
 * Generates a signed upload grant with a 10-minute expiry window.
 */
export function generateSignedUploadGrant(
  payload: {
    tenantId: string;
    assetId: string;
    filename: string;
    mimeType: string;
    sha256: string;
    declaredBytes: number;
    maxBytes: number;
    ttlSeconds?: number;
  },
  options: {
    pepper: string;
    baseUrl: string;
    now?: Date;
  },
): SignedUploadGrant {
  const now = options.now ?? new Date();
  const ttlSeconds = Math.min(payload.ttlSeconds ?? 600, 600); // Max 10 minutes per docs/SECURITY.md
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const grantPayload: SignedUploadGrantPayload = {
    tenantId: payload.tenantId,
    assetId: payload.assetId,
    filename: payload.filename,
    mimeType: payload.mimeType,
    sha256: payload.sha256,
    declaredBytes: payload.declaredBytes,
    maxBytes: payload.maxBytes,
    expiresAt,
  };

  const sig = computeGrantSignature(grantPayload, options.pepper);

  const envelope = {
    ...grantPayload,
    sig,
  };

  const token = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');

  const cleanBaseUrl = options.baseUrl.replace(/\/+$/, '');
  const uploadUrl = `${cleanBaseUrl}/assets/upload-quarantine/${token}`;

  return {
    ...grantPayload,
    token,
    uploadUrl,
    requiredHeaders: {
      'content-type': payload.mimeType,
    },
  };
}

/**
 * Verifies and decodes a signed upload grant token.
 * Constant-time signature verification prevents timing oracle side-channels.
 */
export function verifySignedUploadGrant(
  token: string,
  options: {
    pepper: string;
    now?: Date;
    revocationStore?: StorageGrantRevocationStore;
  },
): SignedUploadGrantPayload {
  let envelope: (SignedUploadGrantPayload & { sig: string }) | null = null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    envelope = JSON.parse(jsonStr) as SignedUploadGrantPayload & { sig: string };
  } catch {
    throw new UploadGrantError('Malformed upload grant token', 400, 'MALFORMED_UPLOAD_TOKEN');
  }

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.sig !== 'string' ||
    typeof envelope.tenantId !== 'string' ||
    typeof envelope.assetId !== 'string' ||
    typeof envelope.expiresAt !== 'string' ||
    typeof envelope.sha256 !== 'string' ||
    typeof envelope.maxBytes !== 'number'
  ) {
    throw new UploadGrantError('Invalid upload grant token structure', 400, 'INVALID_UPLOAD_TOKEN');
  }

  const expectedSig = computeGrantSignature(
    {
      tenantId: envelope.tenantId,
      assetId: envelope.assetId,
      filename: envelope.filename,
      mimeType: envelope.mimeType,
      sha256: envelope.sha256,
      declaredBytes: envelope.declaredBytes,
      maxBytes: envelope.maxBytes,
      expiresAt: envelope.expiresAt,
    },
    options.pepper,
  );

  const providedSigBuf = Buffer.from(envelope.sig, 'hex');
  const expectedSigBuf = Buffer.from(expectedSig, 'hex');

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    throw new UploadGrantError('Upload grant signature verification failed', 403, 'INVALID_GRANT_SIGNATURE');
  }

  if (options.revocationStore?.isGrantRevoked(envelope.tenantId, envelope.assetId, envelope.sig)) {
    throw new UploadGrantError('Upload grant has been revoked', 410, 'GRANT_REVOKED');
  }

  const nowTime = (options.now ?? new Date()).getTime();
  const expiryTime = Date.parse(envelope.expiresAt);

  if (Number.isNaN(expiryTime) || nowTime > expiryTime) {
    throw new UploadGrantError('Upload grant has expired', 410, 'UPLOAD_GRANT_EXPIRED');
  }

  return {
    tenantId: envelope.tenantId,
    assetId: envelope.assetId,
    filename: envelope.filename,
    mimeType: envelope.mimeType,
    sha256: envelope.sha256,
    declaredBytes: envelope.declaredBytes,
    maxBytes: envelope.maxBytes,
    expiresAt: envelope.expiresAt,
  };
}

// ==============================================================================
// Signed Download Grants & Revocation Management (Task P3-05)
// ==============================================================================

export interface SignedDownloadGrantPayload {
  tenantId: string;
  assetId: string;
  version: number;
  filename: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  expiresAt: string; // ISO 8601 UTC
  grantKind: 'download';
}

export interface SignedDownloadGrant extends SignedDownloadGrantPayload {
  token: string;
  downloadUrl: string;
}

export class DownloadGrantError extends Error {
  public readonly httpStatus: number;
  public readonly code: string;

  constructor(message: string, httpStatus = 403, code = 'INVALID_DOWNLOAD_GRANT') {
    super(message);
    this.name = 'DownloadGrantError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

/**
 * Creates an HMAC-SHA256 signature for download grant parameters.
 */
function computeDownloadGrantSignature(
  payload: Omit<SignedDownloadGrantPayload, 'token'>,
  pepper: string,
): string {
  const hmac = crypto.createHmac('sha256', pepper);
  const data = [
    payload.tenantId,
    payload.assetId,
    String(payload.version),
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
 * Generates a signed download grant with a max 5-minute (300s) TTL per docs/DEPLOYMENT.md.
 */
export function generateSignedDownloadGrant(
  payload: {
    tenantId: string;
    assetId: string;
    version: number;
    filename: string;
    mimeType: string;
    sha256: string;
    bytes: number;
    ttlSeconds?: number;
  },
  options: {
    pepper: string;
    baseUrl: string;
    now?: Date;
  },
): SignedDownloadGrant {
  const now = options.now ?? new Date();
  // Maximum 300 seconds (5 minutes) per docs/SECURITY.md:23 & docs/DEPLOYMENT.md:97
  const ttlSeconds = Math.min(payload.ttlSeconds ?? 300, 300);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const grantPayload: SignedDownloadGrantPayload = {
    tenantId: payload.tenantId,
    assetId: payload.assetId,
    version: payload.version,
    filename: payload.filename,
    mimeType: payload.mimeType,
    sha256: payload.sha256,
    bytes: payload.bytes,
    expiresAt,
    grantKind: 'download',
  };

  const sig = computeDownloadGrantSignature(grantPayload, options.pepper);
  const envelope = {
    ...grantPayload,
    sig,
  };

  const token = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
  const cleanBaseUrl = options.baseUrl.replace(/\/+$/, '');
  const downloadUrl = `${cleanBaseUrl}/assets/download/${token}`;

  return {
    ...grantPayload,
    token,
    downloadUrl,
  };
}

/**
 * Verifies and decodes a signed download grant token in constant time.
 */
export function verifySignedDownloadGrant(
  token: string,
  options: {
    pepper: string;
    now?: Date;
    revocationStore?: StorageGrantRevocationStore;
  },
): SignedDownloadGrantPayload {
  let envelope: (SignedDownloadGrantPayload & { sig: string }) | null = null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    envelope = JSON.parse(jsonStr) as SignedDownloadGrantPayload & { sig: string };
  } catch {
    throw new DownloadGrantError('Malformed download grant token', 400, 'MALFORMED_DOWNLOAD_TOKEN');
  }

  if (
    !envelope ||
    typeof envelope !== 'object' ||
    typeof envelope.sig !== 'string' ||
    typeof envelope.tenantId !== 'string' ||
    typeof envelope.assetId !== 'string' ||
    typeof envelope.version !== 'number' ||
    typeof envelope.filename !== 'string' ||
    typeof envelope.mimeType !== 'string' ||
    typeof envelope.sha256 !== 'string' ||
    typeof envelope.bytes !== 'number' ||
    typeof envelope.expiresAt !== 'string' ||
    envelope.grantKind !== 'download'
  ) {
    throw new DownloadGrantError('Invalid download grant token structure', 400, 'INVALID_DOWNLOAD_TOKEN');
  }

  const expectedSig = computeDownloadGrantSignature(
    {
      tenantId: envelope.tenantId,
      assetId: envelope.assetId,
      version: envelope.version,
      filename: envelope.filename,
      mimeType: envelope.mimeType,
      sha256: envelope.sha256,
      bytes: envelope.bytes,
      expiresAt: envelope.expiresAt,
      grantKind: 'download',
    },
    options.pepper,
  );

  const providedSigBuf = Buffer.from(envelope.sig, 'hex');
  const expectedSigBuf = Buffer.from(expectedSig, 'hex');

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    throw new DownloadGrantError('Download grant signature verification failed', 403, 'INVALID_GRANT_SIGNATURE');
  }

  if (options.revocationStore?.isGrantRevoked(envelope.tenantId, envelope.assetId, envelope.sig)) {
    throw new DownloadGrantError('Download grant has been revoked', 410, 'GRANT_REVOKED');
  }

  const nowTime = (options.now ?? new Date()).getTime();
  const expiryTime = Date.parse(envelope.expiresAt);

  if (Number.isNaN(expiryTime) || nowTime > expiryTime) {
    throw new DownloadGrantError('Download grant has expired', 410, 'DOWNLOAD_GRANT_EXPIRED');
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
    grantKind: 'download',
  };
}

/**
 * Durable in-memory storage grant revocation store.
 * Tracks revoked tokens and revoked asset IDs across tenant operations.
 */
export class StorageGrantRevocationStore {
  private readonly revokedSignatures = new Set<string>();
  private readonly revokedAssetTimestamps = new Map<string, number>();

  public revokeTokenSignature(sig: string): void {
    if (sig) {
      this.revokedSignatures.add(sig);
    }
  }

  public revokeAssetGrants(tenantId: string, assetId: string, now = Date.now()): void {
    this.revokedAssetTimestamps.set(`${tenantId}:${assetId}`, now);
  }

  public isGrantRevoked(tenantId: string, assetId: string, sig?: string): boolean {
    if (sig && this.revokedSignatures.has(sig)) {
      return true;
    }
    const assetKey = `${tenantId}:${assetId}`;
    if (this.revokedAssetTimestamps.has(assetKey)) {
      return true;
    }
    return false;
  }

  public sweepExpired(now = Date.now(), maxAgeMs = 86400000): number {
    let swept = 0;
    for (const [key, timestamp] of this.revokedAssetTimestamps.entries()) {
      if (now - timestamp > maxAgeMs) {
        this.revokedAssetTimestamps.delete(key);
        swept++;
      }
    }
    return swept;
  }

  public clear(): void {
    this.revokedSignatures.clear();
    this.revokedAssetTimestamps.clear();
  }
}

export const defaultGrantRevocationStore = new StorageGrantRevocationStore();

