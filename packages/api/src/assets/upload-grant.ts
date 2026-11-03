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
