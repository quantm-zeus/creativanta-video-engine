/**
 * REST API Server implementation for Creativanta Video Engine.
 * Canonical specification: docs/API.md & docs/SECURITY.md
 */

import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import {
  CapabilitiesResponse,
  CompositionSpec,
  CveEnvConfig,
  ErrorDetail,
  canonicalizeJson,
  compileComposition,
  materializeCompositionDefaults,
  validateCompositionUnified,
} from '@creativanta/contracts';
import {
  ApiScope,
  hasRequiredScopes,
  verifyApiKeyConstantTime,
} from './auth/api-key.js';
import {
  BodyReferenceValidationError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  InvalidCursorError,
  ResourceNotFoundError,
  RevisionConflictError,
  TenantRepository,
} from './db/repository.js';
import {
  DownloadGrantError,
  SignedArtifactDownloadGrantPayload,
  SignedDownloadGrantPayload,
  StorageGrantRevocationStore,
  UploadGrantError,
  defaultGrantRevocationStore,
  generateSignedUploadGrant,
  verifySignedArtifactDownloadGrant,
  verifySignedDownloadGrant,
  verifySignedUploadGrant,
} from './assets/upload-grant.js';
import { StorageTempSweeper } from './storage/sweeper.js';
import {
  QuarantineStorageError,
  QuarantineStore,
} from './assets/quarantine-store.js';
import {
  executeSandboxMediaProbe,
  getAssetKindFromMimeType,
  getMaxBytesForMimeType,
  validateUploadRequestBounds,
} from './assets/media-guard.js';
import {
  ImportConnector,
  inferAssetMimeType,
  sanitizeSourceUrl,
  validateImportRights,
} from './assets/import-connector.js';
import {
  checkTenantImportAllowlist,
  resolveAndAuditHostDns,
  validateAndNormalizeImportUrl,
  SsrSecurityError,
  ValidatedImportUrlResult,
} from './assets/ssrf-guard.js';
import { PoolContextSecurityError } from './db/tenant-pool.js';
import { TokenBucketRateLimiter } from './admission/rate-limiter.js';
import {
  AdmissionServiceUnavailableError,
  AssetNotReadyError,
  JobTerminalError,
  QuotaExceededError,
  RateLimitedError,
  TenantPolicyLimits,
  UnsupportedCapabilityError,
  WebhookNotVerifiedError,
  validatePreviewJobRequest,
  validateRenderJobRequest,
} from './admission/job-admission.js';

export interface CreateServerOptions {
  config: CveEnvConfig;
  repository?: TenantRepository;
  requireAuthOnCapabilities?: boolean;
  quarantineStore?: QuarantineStore;
  importConnector?: ImportConnector;
  revocationStore?: StorageGrantRevocationStore;
  sweeper?: StorageTempSweeper;
  rateLimiter?: TokenBucketRateLimiter;
  enforceGlobalRateLimit?: boolean;
  onAfterIdempotencyClaim?: (ctx: {
    tenantId: string;
    normalizedPath: string;
    key: string;
  }) => Promise<void> | void;
  onBeforeJobCommit?: (ctx: {
    tenantId: string;
    jobId: string;
    kind: 'render' | 'preview';
  }) => void;
  onJobAdmissionCommitted?: (ctx: {
    tenantId: string;
    jobId: string;
    kind: 'render' | 'preview';
    committedAtMs: number;
  }) => void;
}

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_JSON_BODY_BYTES = 1048576; // 1 MiB per docs/PRD.md

export function normalizeIdempotencyPath(rawPathname: string): string {
  if (!rawPathname || rawPathname === '/') {
    return '/';
  }
  const stripped = rawPathname.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
}

export function buildCapabilities(
  config: CveEnvConfig,
  tenantLimits?: TenantPolicyLimits,
): CapabilitiesResponse {
  const customCodeEnabled =
    tenantLimits?.custom_code_enabled !== undefined
      ? Boolean(config.CVE_CUSTOM_CODE_ENABLED && tenantLimits.custom_code_enabled)
      : config.CVE_CUSTOM_CODE_ENABLED;
  return {
    api_version: '1.0.0',
    scene_schema_versions: ['1.0'],
    engines: {
      'html-v1': true,
      'canvas-v1': tenantLimits?.canvas_engine_enabled ?? true,
      'svg-v1': tenantLimits?.svg_engine_enabled ?? true,
      'custom-html-v1': customCodeEnabled,
    },
    profiles: {
      'mp4-720p-v1': {
        id: 'mp4-720p-v1',
        description:
          'Standard 720p H.264 MP4 render (1280x720 landscape or 720x1280 portrait at 30fps)',
        supported: true,
        dimensions: [
          { width: 1280, height: 720 },
          { width: 720, height: 1280 },
        ],
        fps: { num: 30, den: 1 },
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        max_duration_seconds: 180,
      },
      'preview-360p-v1': {
        id: 'preview-360p-v1',
        description: 'Fast 360p preview (scale 0.5 from 720p canvas; PNG frame or MP4 clip)',
        supported: true,
        dimensions: [
          { width: 640, height: 360 },
          { width: 360, height: 640 },
        ],
        fps: { num: 30, den: 1 },
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        max_duration_seconds: 60,
      },
    },
    limits: {
      max_duration_frames: 10800,
      max_scenes: 50,
      max_layers_per_scene: 100,
      max_audio_tracks: 16,
      max_subtitles: 8,
      max_fonts: 16,
      max_upload_bytes: 100 * 1024 * 1024, // 100 MiB
    },
    features: {
      remote_import: config.CVE_REMOTE_IMPORT_ENABLED,
      custom_code: customCodeEnabled,
      authoring_adapter: config.CVE_AUTHORING_PROVIDER !== 'disabled',
      tts: config.CVE_TTS_PROVIDER !== 'disabled',
    },
    policy_version: '2026-11-02-v1',
  };
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  retryable = false,
  details?: ErrorDetail[],
): void {
  res.writeHead(status);
  res.end(
    JSON.stringify({
      error: {
        code,
        message,
        request_id: requestId,
        retryable,
        ...(details ? { details } : {}),
      },
    }),
  );
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; code: string; message: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buf.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'HTTP JSON body exceeds 1 MiB limit',
      };
    }
    chunks.push(buf);
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return { ok: true, data: {} };
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        status: 400,
        code: 'MALFORMED_JSON',
        message: 'Request body must be a JSON object',
      };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      code: 'MALFORMED_JSON',
      message: 'Malformed JSON body',
    };
  }
}

async function readRawBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; buffer: Buffer; bytes: number; sha256: string } | { ok: false; status: number; code: string; message: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const hash = crypto.createHash('sha256');

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    totalBytes += buf.byteLength;
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: `Upload payload exceeds limit of ${maxBytes} bytes`,
      };
    }
    hash.update(buf);
    chunks.push(buf);
  }

  const buffer = Buffer.concat(chunks);
  const sha256 = hash.digest('hex');
  return { ok: true, buffer, bytes: totalBytes, sha256 };
}

export function createServer({
  config,
  repository,
  requireAuthOnCapabilities = false,
  quarantineStore: providedStore,
  importConnector: providedConnector,
  revocationStore: providedRevocationStore,
  sweeper: providedSweeper,
  rateLimiter: providedRateLimiter,
  enforceGlobalRateLimit = false,
  onAfterIdempotencyClaim,
  onBeforeJobCommit,
  onJobAdmissionCommitted,
}: CreateServerOptions): http.Server {
  const startTime = Date.now();
  const quarantineStore = providedStore ?? repository?.getQuarantineStore() ?? new QuarantineStore();
  const revocationStore =
    providedRevocationStore ?? repository?.getRevocationStore() ?? defaultGrantRevocationStore;
  const sweeper =
    providedSweeper ??
    (repository
      ? new StorageTempSweeper({
          repository,
          quarantineStore,
          revocationStore,
        })
      : undefined);
  const importConnector = providedConnector ?? new ImportConnector({ quarantineStore });
  const rateLimiter = providedRateLimiter ?? new TokenBucketRateLimiter();

  const server = http.createServer(async (req, res) => {
    const requestId = `req_${crypto.randomBytes(6).toString('hex')}`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Request-Id', requestId);

    const rawUrl = req.url || '/';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      sendError(res, 400, 'INVALID_REQUEST', 'Malformed URL', requestId);
      return;
    }

    const pathname = normalizeIdempotencyPath(parsedUrl.pathname);
    const method = (req.method ?? 'GET').toUpperCase();

    // Liveness probe
    if (pathname === '/healthz' && method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'creativanta-video-engine-api',
          environment: config.CVE_ENV,
          uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Readiness probe
    if (pathname === '/readyz' && method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ready',
          service: 'creativanta-video-engine-api',
          checks: {
            database: 'ok',
            storage: 'ok',
            renderer: config.CVE_RENDERER_ADAPTER,
          },
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Reject client-supplied X-Tenant-Id header (docs/SECURITY.md line 21)
    if (req.headers['x-tenant-id'] !== undefined) {
      sendError(
        res,
        422,
        'VALIDATION_FAILED',
        'Client must not supply tenant identity via header',
        requestId,
        false,
        [
          {
            pointer: '/headers/x-tenant-id',
            code: 'UNKNOWN_FIELD',
            message: 'Tenant identity is derived strictly from the API key',
          },
        ],
      );
      return;
    }

    const enforceRateLimitForTenant = (tenantId: string, keyId: string): boolean => {
      if (!repository) return true;
      const limits = repository.getTenantPolicyLimits(tenantId);
      const decision = rateLimiter.consume({
        tenantId,
        keyId,
        tenantLimits: {
          refillPerSecond: limits.token_bucket_refill_per_second,
          burstCapacity: limits.token_bucket_burst_capacity,
        },
        keyLimits: {
          refillPerSecond:
            limits.api_key_token_bucket_refill_per_second ??
            limits.token_bucket_refill_per_second,
          burstCapacity:
            limits.api_key_token_bucket_burst_capacity ??
            limits.token_bucket_burst_capacity,
        },
      });
      if (!decision.allowed) {
        res.setHeader('Retry-After', String(decision.retryAfterSeconds));
        sendError(
          res,
          429,
          'RATE_LIMITED',
          `Request rate limit exceeded (${decision.limitedBy ?? 'tenant'} bucket exhausted); retry after ${decision.retryAfterSeconds}s`,
          requestId,
          true,
        );
        return false;
      }
      return true;
    };

    const authenticateAndAuthorize = (
      requiredScopes: readonly ApiScope[],
      options: { enforceRateLimit?: boolean } = {},
    ): { tenantId: string; keyId: string; scopes: ApiScope[] } | null => {
      if (!repository) {
        res.setHeader('Retry-After', '2');
        sendError(
          res,
          503,
          'SERVICE_UNAVAILABLE',
          'Tenant repository is not initialized',
          requestId,
          true,
        );
        return null;
      }

      const authHeader = req.headers['authorization'];
      let rawToken: string | undefined;
      if (typeof authHeader === 'string' && /^Bearer\s+/i.test(authHeader)) {
        rawToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      }

      const verification = verifyApiKeyConstantTime({
        rawToken,
        lookupByPrefix: (prefix) => repository.lookupApiKeyByPrefix(prefix),
        pepper: repository.getPepper(),
      });

      if (!verification.authenticated || !verification.tenantId || !verification.scopes) {
        sendError(
          res,
          verification.httpStatus ?? 401,
          verification.errorCode ?? 'UNAUTHENTICATED',
          verification.reason ?? 'Authentication required',
          requestId,
        );
        return null;
      }

      if (!hasRequiredScopes(verification.scopes, requiredScopes)) {
        sendError(
          res,
          403,
          'INSUFFICIENT_SCOPE',
          `API key lacks required scopes: ${requiredScopes.join(', ')}`,
          requestId,
        );
        return null;
      }

      if (options.enforceRateLimit || enforceGlobalRateLimit) {
        if (!enforceRateLimitForTenant(verification.tenantId, verification.keyId!)) {
          return null;
        }
      }

      return {
        tenantId: verification.tenantId,
        keyId: verification.keyId!,
        scopes: verification.scopes,
      };
    };

    const verifyIdempotencyHeader = (): string | null => {
      const idemHeader = req.headers['idempotency-key'];
      if (idemHeader === undefined || idemHeader === '') {
        sendError(
          res,
          400,
          'IDEMPOTENCY_KEY_REQUIRED',
          'Idempotency-Key header is required on all POST requests',
          requestId,
        );
        return null;
      }
      const keyStr = Array.isArray(idemHeader) ? idemHeader[0]! : idemHeader;
      if (!IDEMPOTENCY_KEY_REGEX.test(keyStr)) {
        sendError(
          res,
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must match ^[A-Za-z0-9._:-]{1,128}$',
          requestId,
        );
        return null;
      }
      return keyStr;
    };

    // Capabilities endpoint
    if (pathname === '/v1/capabilities' && method === 'GET') {
      let tenantLimits: TenantPolicyLimits | undefined;
      if (requireAuthOnCapabilities || req.headers['authorization'] !== undefined) {
        if (repository) {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          tenantLimits = repository.getTenantPolicyLimits(auth.tenantId);
        }
      }
      const caps = buildCapabilities(config, tenantLimits);
      res.writeHead(200);
      res.end(JSON.stringify(caps));
      return;
    }

    // Composition validation endpoint (P1-03)
    if (pathname === '/v1/compositions/validate' && method === 'POST') {
      if (req.headers['authorization'] !== undefined && repository) {
        const auth = authenticateAndAuthorize(['compositions:write']);
        if (!auth) return;
      }

      const bodyRes = await readJsonBody(req);
      if (!bodyRes.ok) {
        sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
        return;
      }

      const spec = bodyRes.data['spec'];
      const profile = (bodyRes.data['profile'] as string | undefined) ?? 'mp4-720p-v1';

      if (!spec || typeof spec !== 'object') {
        sendError(
          res,
          422,
          'VALIDATION_FAILED',
          'Missing or invalid spec property in body',
          requestId,
          false,
          [
            {
              pointer: '/spec',
              code: 'MISSING_REQUIRED_FIELD',
              message: "Required field 'spec' is missing or not an object",
            },
          ],
        );
        return;
      }

      const unified = validateCompositionUnified(spec, {
        profile,
        capabilityOptions: {
          customCodeEnabled: config.CVE_CUSTOM_CODE_ENABLED,
        },
      });

      if (!unified.valid) {
        const hasCapabilityError = unified.all_errors.some((e) => e.stage === 'capability');
        const errorCode = hasCapabilityError ? 'UNSUPPORTED_CAPABILITY' : 'VALIDATION_FAILED';
        const errorMessage = hasCapabilityError
          ? 'Composition violates profile constraints or requested capability is disabled'
          : 'Composition specification validation failed';

        sendError(
          res,
          422,
          errorCode,
          errorMessage,
          requestId,
          false,
          unified.all_errors.map((e) => ({
            pointer: `/spec${e.pointer === '/' ? '' : e.pointer}`,
            code: e.code,
            message: e.message,
          })),
        );
        return;
      }

      const manifest = compileComposition(spec as CompositionSpec, {
        profile,
        compilerVersion: '0.1.0',
      });

      const normalizedSpec = materializeCompositionDefaults(spec as CompositionSpec);
      const estMinutes = manifest.duration_seconds / 60;
      const estCost = Math.round(estMinutes * 0.05 * 10000) / 10000;

      res.writeHead(200);
      res.end(
        JSON.stringify({
          valid: true,
          normalized_spec: normalizedSpec,
          render_hash: manifest.render_hash,
          required_capabilities: manifest.required_capabilities,
          estimate: {
            output_seconds: manifest.duration_seconds,
            estimated_cost: estCost,
            currency: 'USD',
            rate_version: '2026-11-02-v1',
          },
          warnings: unified.warnings,
        }),
      );
      return;
    }

    // Quarantine raw bytes upload endpoint (Bearer capability token in URL, no header needed)
    const quarantineUploadMatch = /^\/v1\/assets\/upload-quarantine\/([^/]+)$/.exec(pathname);
    if (quarantineUploadMatch && method === 'PUT') {
      const token = quarantineUploadMatch[1]!;
      const pepper = repository ? repository.getPepper() : 'default_test_pepper_0123456789abcdef';
      let grantPayload;
      try {
        grantPayload = verifySignedUploadGrant(token, { pepper, revocationStore });
      } catch (err) {
        if (err instanceof UploadGrantError) {
          sendError(res, err.httpStatus, err.code, err.message, requestId);
          return;
        }
        sendError(res, 403, 'INVALID_UPLOAD_GRANT', 'Invalid upload grant token', requestId);
        return;
      }

      if (repository) {
        try {
          const asset = repository.getAsset(grantPayload.tenantId, grantPayload.assetId);
          if (asset.status !== 'uploading') {
            sendError(
              res,
              409,
              'REVISION_CONFLICT',
              `Asset upload session is not open (current status: ${asset.status})`,
              requestId,
            );
            return;
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundError) {
            sendError(res, 404, 'NOT_FOUND', err.message, requestId);
            return;
          }
          throw err;
        }
      }

      // Check Content-Length if provided
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader !== undefined) {
        const contentLength = Number(contentLengthHeader);
        if (!Number.isNaN(contentLength) && contentLength > grantPayload.maxBytes) {
          sendError(
            res,
            413,
            'PAYLOAD_TOO_LARGE',
            `Upload payload exceeds maximum allowed size of ${grantPayload.maxBytes} bytes`,
            requestId,
          );
          return;
        }
      }

      const bodyRes = await readRawBody(req, grantPayload.maxBytes);
      if (!bodyRes.ok) {
        sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
        return;
      }

      const saved = quarantineStore.saveQuarantined(
        grantPayload.tenantId,
        grantPayload.assetId,
        bodyRes.buffer,
      );

      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'uploaded',
          asset_id: grantPayload.assetId,
          bytes: saved.bytes,
          sha256: saved.sha256,
        }),
      );
      return;
    }

    // Scoped Asset Download Execution Endpoint (Bearer capability token in URL, Task P3-05)
    const assetDownloadExecMatch = /^\/v1\/assets\/download\/([^/]+)$/.exec(pathname);
    if (assetDownloadExecMatch && method === 'GET') {
      const token = assetDownloadExecMatch[1]!;
      const pepper = repository ? repository.getPepper() : 'default_test_pepper_0123456789abcdef';
      let grantPayload: SignedDownloadGrantPayload;
      try {
        grantPayload = verifySignedDownloadGrant(token, { pepper, revocationStore });
      } catch (err) {
        if (err instanceof DownloadGrantError) {
          sendError(res, err.httpStatus, err.code, err.message, requestId);
          return;
        }
        sendError(res, 403, 'INVALID_GRANT_SIGNATURE', 'Invalid download grant token', requestId);
        return;
      }

      if (repository) {
        try {
          const asset = repository.getAsset(grantPayload.tenantId, grantPayload.assetId);
          if (asset.status === 'deleted') {
            sendError(res, 410, 'GRANT_REVOKED', 'Asset has been deleted and grant is revoked', requestId);
            return;
          }
          if (asset.status !== 'ready') {
            sendError(
              res,
              409,
              'REVISION_CONFLICT',
              `Asset is not ready for download (current status: ${asset.status})`,
              requestId,
            );
            return;
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundError) {
            sendError(res, 404, 'NOT_FOUND', err.message, requestId);
            return;
          }
          throw err;
        }
      }

      const fileData = quarantineStore.getPermanentFile(
        grantPayload.tenantId,
        grantPayload.assetId,
        grantPayload.version,
        grantPayload.filename,
      );

      if (!fileData) {
        sendError(res, 404, 'STORAGE_OBJECT_NOT_FOUND', 'Asset storage file not found on disk', requestId);
        return;
      }

      // Security: "no raw custom HTML origin" per docs/SECURITY.md
      const isRawHtml =
        grantPayload.mimeType.toLowerCase() === 'text/html' ||
        grantPayload.filename.toLowerCase().endsWith('.html') ||
        grantPayload.filename.toLowerCase().endsWith('.htm');
      const safeMimeType = isRawHtml ? 'application/octet-stream' : grantPayload.mimeType;

      res.writeHead(200, {
        'Content-Type': safeMimeType,
        'Content-Length': fileData.buffer.byteLength,
        'ETag': `"${grantPayload.sha256}"`,
        'Content-Disposition': `attachment; filename="${grantPayload.filename}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'private, no-transform, max-age=300',
      });
      res.end(fileData.buffer);
      return;
    }

    // Scoped Artifact Download Execution Endpoint (Bearer capability token in URL, Task P4-06)
    const artDownloadExecMatch = /^\/v1\/artifacts\/download\/([^/]+)$/.exec(pathname);
    if (artDownloadExecMatch && method === 'GET') {
      const token = artDownloadExecMatch[1]!;
      const pepper = repository ? repository.getPepper() : 'default_test_pepper_0123456789abcdef';
      let grantPayload: SignedArtifactDownloadGrantPayload;
      try {
        grantPayload = verifySignedArtifactDownloadGrant(token, { pepper, revocationStore });
      } catch (err) {
        if (err instanceof DownloadGrantError) {
          sendError(res, err.httpStatus, err.code, err.message, requestId);
          return;
        }
        sendError(res, 403, 'INVALID_GRANT_SIGNATURE', 'Invalid artifact download grant token', requestId);
        return;
      }

      if (repository) {
        try {
          const art = repository.getArtifact(grantPayload.tenantId, grantPayload.artifactId);
          if (art.revoked_at !== null) {
            sendError(res, 410, 'GRANT_REVOKED', 'Artifact has been revoked and grant is invalid', requestId);
            return;
          }
          if (Date.parse(art.expires_at) <= Date.now()) {
            sendError(res, 410, 'ARTIFACT_EXPIRED', 'Artifact retention has expired', requestId);
            return;
          }
        } catch (err) {
          if (err instanceof ResourceNotFoundError) {
            sendError(res, 404, 'NOT_FOUND', err.message, requestId);
            return;
          }
          throw err;
        }
      }

      if (!quarantineStore) {
        sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Storage store is not available', requestId, true);
        return;
      }

      const fileData = quarantineStore.getArtifactFileByStorageKey(grantPayload.storageKey);
      if (!fileData) {
        sendError(res, 404, 'STORAGE_OBJECT_NOT_FOUND', 'Artifact storage file not found on disk', requestId);
        return;
      }

      // Security: "no raw custom HTML origin" per docs/SECURITY.md
      // Never serve raw user/tenant HTML directly on API origin; enforce attachment + strict sandbox CSP
      const isRawHtml =
        grantPayload.mimeType.toLowerCase() === 'text/html' ||
        grantPayload.filename.toLowerCase().endsWith('.html') ||
        grantPayload.filename.toLowerCase().endsWith('.htm');
      const safeMimeType = isRawHtml ? 'application/octet-stream' : grantPayload.mimeType;

      res.writeHead(200, {
        'Content-Type': safeMimeType,
        'Content-Length': fileData.buffer.byteLength,
        'ETag': `"${grantPayload.sha256}"`,
        'Content-Disposition': `attachment; filename="${grantPayload.filename}"`,
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Cache-Control': 'private, no-transform, max-age=300',
      });
      res.end(fileData.buffer);
      return;
    }

    // Tenant-scoped v1 endpoints require repository
    if (pathname.startsWith('/v1/') && repository) {
      let activeIdemClaim: {
        tenantId: string;
        normalizedPath: string;
        key: string;
      } | null = null;

      const computeCanonicalRequestHash = (data: Record<string, unknown>): string => {
        return crypto
          .createHash('sha256')
          .update(canonicalizeJson(data), 'utf8')
          .digest('hex');
      };

      try {
        // 1. GET /v1/templates
        if (pathname === '/v1/templates' && method === 'GET') {
          const auth = authenticateAndAuthorize(['templates:read']);
          if (!auth) return;
          const limitRaw = parsedUrl.searchParams.get('limit');
          const cursor = parsedUrl.searchParams.get('cursor') ?? undefined;
          const limit = limitRaw ? Number(limitRaw) : 20;
          if (Number.isNaN(limit) || limit < 1 || limit > 100) {
            sendError(res, 400, 'INVALID_QUERY_PARAM', 'limit must be between 1 and 100', requestId);
            return;
          }
          const result = repository.listTemplates(auth.tenantId, { limit, cursor });
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }

        // 2. POST /v1/templates
        if (pathname === '/v1/templates' && method === 'POST') {
          const auth = authenticateAndAuthorize(['templates:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/templates',
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = {
            tenantId: auth.tenantId,
            normalizedPath: '/v1/templates',
            key: idemKey,
          };

          const id =
            typeof bodyRes.data['id'] === 'string' && bodyRes.data['id'].length > 0
              ? bodyRes.data['id']
              : `tpl_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createTemplate(auth.tenantId, {
            id,
            name: String(bodyRes.data['name'] ?? ''),
            variables_schema: (bodyRes.data['variables_schema'] as Record<string, unknown>) ?? {},
            defaults: (bodyRes.data['defaults'] as Record<string, unknown>) ?? {},
            composition_spec: (bodyRes.data['composition_spec'] as Record<string, unknown>) ?? {},
            supported_locales: (bodyRes.data['supported_locales'] as string[]) ?? [],
            source_template: bodyRes.data['source_template'] as { id: string; revision: number } | undefined,
          });

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/templates',
            key: idemKey,
            httpStatus: 201,
            responseBody: created,
            resourceId: created.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        // 3. GET /v1/templates/{id}/revisions/{revision}
        const tplRevMatch = /^\/v1\/templates\/([^/]+)\/revisions\/(\d+)$/.exec(pathname);
        if (tplRevMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['templates:read']);
          if (!auth) return;
          const detail = repository.getTemplateRevision(
            auth.tenantId,
            tplRevMatch[1]!,
            Number(tplRevMatch[2]),
          );
          res.writeHead(200);
          res.end(JSON.stringify(detail));
          return;
        }

        // 4. POST /v1/templates/{id}/revisions
        const tplCreateRevMatch = /^\/v1\/templates\/([^/]+)\/revisions$/.exec(pathname);
        if (tplCreateRevMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['templates:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }
          const normalizedPath = `/v1/templates/${tplCreateRevMatch[1]!}/revisions`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const created = repository.createTemplateRevision(auth.tenantId, tplCreateRevMatch[1]!, {
            base_revision: Number(bodyRes.data['base_revision'] ?? 0),
            change_note: bodyRes.data['change_note'] ? String(bodyRes.data['change_note']) : undefined,
            name: String(bodyRes.data['name'] ?? ''),
            variables_schema: (bodyRes.data['variables_schema'] as Record<string, unknown>) ?? {},
            defaults: (bodyRes.data['defaults'] as Record<string, unknown>) ?? {},
            composition_spec: (bodyRes.data['composition_spec'] as Record<string, unknown>) ?? {},
            supported_locales: (bodyRes.data['supported_locales'] as string[]) ?? [],
          });

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 201,
            responseBody: created,
            resourceId: created.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        // 4b. POST /v1/templates/{id}/instantiate
        const tplInstantiateMatch = /^\/v1\/templates\/([^/]+)\/instantiate$/.exec(pathname);
        if (tplInstantiateMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['compositions:write', 'templates:read']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }

          const templateId = tplInstantiateMatch[1]!;
          const normalizedPath = `/v1/templates/${templateId}/instantiate`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const templateRevision = Number(bodyRes.data['template_revision'] ?? 0);
          const name = String(bodyRes.data['name'] ?? '');
          const variables = (bodyRes.data['variables'] as Record<string, unknown> | undefined) ?? {};
          const locale = String(bodyRes.data['locale'] ?? '');

          const instantiated = repository.instantiateTemplate(auth.tenantId, templateId, {
            template_revision: templateRevision,
            name,
            variables,
            locale,
          });

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 201,
            responseBody: instantiated,
            resourceId: instantiated.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(instantiated));
          return;
        }

        // 4c. POST /v1/templates/{id}/fork
        const tplForkMatch = /^\/v1\/templates\/([^/]+)\/fork$/.exec(pathname);
        if (tplForkMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['templates:write', 'templates:read']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }

          const templateId = tplForkMatch[1]!;
          const normalizedPath = `/v1/templates/${templateId}/fork`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const forked = repository.forkTemplate(auth.tenantId, templateId, {
            name: bodyRes.data['name'] ? String(bodyRes.data['name']) : undefined,
            new_id: bodyRes.data['id'] ? String(bodyRes.data['id']) : undefined,
            source_revision: bodyRes.data['revision'] ? Number(bodyRes.data['revision']) : undefined,
          });

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 201,
            responseBody: forked,
            resourceId: forked.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(forked));
          return;
        }

        // 5. Asset Ingestion Pipeline (Task P3-02)

        // 5.1 POST /v1/assets/uploads
        if (pathname === '/v1/assets/uploads' && method === 'POST') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;

          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }

          const reqHash = crypto
            .createHash('sha256')
            .update(canonicalizeJson(bodyRes.data), 'utf8')
            .digest('hex');

          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/assets/uploads',
            key: idemKey,
            requestHash: reqHash,
          });

          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }

          const valResult = validateUploadRequestBounds(bodyRes.data);
          if (!valResult.valid) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/uploads',
              key: idemKey,
            });
            sendError(
              res,
              valResult.httpStatus ?? 422,
              valResult.code ?? 'VALIDATION_FAILED',
              valResult.message ?? 'Invalid upload request',
              requestId,
              false,
              valResult.details,
            );
            return;
          }

          const assetId = `ast_${crypto.randomBytes(6).toString('hex')}`;
          const mimeType = String(bodyRes.data['mime_type']).toLowerCase();
          const kind = getAssetKindFromMimeType(mimeType);
          const declaredBytes = Number(bodyRes.data['bytes']);
          const sha256 = String(bodyRes.data['sha256']).toLowerCase();

          repository.createAssetUpload(auth.tenantId, {
            id: assetId,
            filename: String(bodyRes.data['filename']),
            kind,
            mimeType,
            bytes: declaredBytes,
            sha256,
            rights: bodyRes.data['rights'] as Record<string, unknown>,
          });

          const rawBaseUrl = config.CVE_PUBLIC_BASE_URL;
          const hostHeader = req.headers.host || '127.0.0.1';
          const effectiveBaseUrl =
            !rawBaseUrl || rawBaseUrl.includes(':0')
              ? `http://${hostHeader}/v1`
              : rawBaseUrl;
          const cleanBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');

          const grant = generateSignedUploadGrant(
            {
              tenantId: auth.tenantId,
              assetId,
              filename: String(bodyRes.data['filename']),
              mimeType,
              sha256,
              declaredBytes,
              maxBytes: getMaxBytesForMimeType(mimeType),
              ttlSeconds: 600, // 10 minutes
            },
            {
              pepper: repository.getPepper(),
              baseUrl: cleanBaseUrl,
            },
          );

          const responsePayload = {
            asset_id: assetId,
            upload_method: 'PUT' as const,
            upload_url: grant.uploadUrl,
            required_headers: grant.requiredHeaders,
            expires_at: grant.expiresAt,
            max_bytes: grant.maxBytes,
          };

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/assets/uploads',
            key: idemKey,
            httpStatus: 201,
            responseBody: responsePayload,
            resourceId: assetId,
          });

          res.writeHead(201);
          res.end(JSON.stringify(responsePayload));
          return;
        }

        // 5.2 POST /v1/assets/{id}/upload-url
        const assetUploadUrlMatch = /^\/v1\/assets\/([^/]+)\/upload-url$/.exec(pathname);
        if (assetUploadUrlMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;

          const assetId = assetUploadUrlMatch[1]!;
          const normalizedPath = `/v1/assets/${assetId}/upload-url`;

          const reqHash = crypto.createHash('sha256').update('', 'utf8').digest('hex');
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });

          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }

          const asset = repository.getAsset(auth.tenantId, assetId);
          if (asset.status !== 'uploading') {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
            });
            throw new RevisionConflictError(
              `Asset upload session is not open (current status: ${asset.status})`,
            );
          }

          const rawBaseUrl = config.CVE_PUBLIC_BASE_URL;
          const hostHeader = req.headers.host || '127.0.0.1';
          const effectiveBaseUrl =
            !rawBaseUrl || rawBaseUrl.includes(':0')
              ? `http://${hostHeader}/v1`
              : rawBaseUrl;
          const cleanBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');

          const grant = generateSignedUploadGrant(
            {
              tenantId: auth.tenantId,
              assetId: asset.id,
              filename: asset.filename,
              mimeType: asset.mime_type,
              sha256: asset.sha256,
              declaredBytes: asset.bytes,
              maxBytes: getMaxBytesForMimeType(asset.mime_type),
              ttlSeconds: 600,
            },
            {
              pepper: repository.getPepper(),
              baseUrl: cleanBaseUrl,
            },
          );

          const responsePayload = {
            upload_url: grant.uploadUrl,
            expires_at: grant.expiresAt,
            required_headers: grant.requiredHeaders,
          };

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 200,
            responseBody: responsePayload,
            resourceId: asset.id,
          });

          res.writeHead(200);
          res.end(JSON.stringify(responsePayload));
          return;
        }

        // 5.3 POST /v1/assets/{id}/complete
        const assetCompleteMatch = /^\/v1\/assets\/([^/]+)\/complete$/.exec(pathname);
        if (assetCompleteMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;

          const assetId = assetCompleteMatch[1]!;
          const normalizedPath = `/v1/assets/${assetId}/complete`;

          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          const reqHash = crypto
            .createHash('sha256')
            .update(canonicalizeJson(bodyRes.data), 'utf8')
            .digest('hex');

          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });

          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }

          const asset = repository.getAsset(auth.tenantId, assetId);
          if (asset.status !== 'uploading') {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
            });
            throw new RevisionConflictError(
              `Asset is not in uploading state (current status: ${asset.status})`,
            );
          }

          const declaredSha =
            typeof bodyRes.data['sha256'] === 'string'
              ? bodyRes.data['sha256'].toLowerCase().trim()
              : '';

          if (!/^[0-9a-f]{64}$/.test(declaredSha)) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
            });
            sendError(
              res,
              422,
              'VALIDATION_FAILED',
              'sha256 must be a 64-character lowercase hex string',
              requestId,
              false,
              [
                {
                  pointer: '/sha256',
                  code: 'INVALID_CHECKSUM',
                  message: 'Invalid sha256 checksum string',
                },
              ],
            );
            return;
          }

          const quarantined = quarantineStore.getQuarantined(auth.tenantId, asset.id);
          if (!quarantined) {
            repository.updateAssetStatus(auth.tenantId, asset.id, {
              status: 'rejected',
              mimeType: asset.mime_type,
              probeMetadata: {
                error: 'MISSING_UPLOAD_DATA',
                message: 'No uploaded data found in quarantine for complete step',
              },
            });

            const resp = { id: asset.id, status: 'rejected' as const };
            repository.completeIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              httpStatus: 202,
              responseBody: resp,
              resourceId: asset.id,
            });

            res.writeHead(202);
            res.end(JSON.stringify(resp));
            return;
          }

          // Checksum guard
          if (quarantined.sha256 !== declaredSha || quarantined.sha256 !== asset.sha256.toLowerCase()) {
            repository.updateAssetStatus(auth.tenantId, asset.id, {
              status: 'rejected',
              mimeType: asset.mime_type,
              probeMetadata: {
                error: 'CHECKSUM_MISMATCH',
                message: 'Uploaded data SHA-256 does not match declared checksum',
                declared_in_complete: declaredSha,
                declared_in_upload: asset.sha256,
                actual: quarantined.sha256,
              },
            });
            quarantineStore.removeQuarantined(auth.tenantId, asset.id);

            const resp = { id: asset.id, status: 'rejected' as const };
            repository.completeIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              httpStatus: 202,
              responseBody: resp,
              resourceId: asset.id,
            });

            res.writeHead(202);
            res.end(JSON.stringify(resp));
            return;
          }

          // Byte size guard
          if (quarantined.bytes !== asset.bytes) {
            repository.updateAssetStatus(auth.tenantId, asset.id, {
              status: 'rejected',
              mimeType: asset.mime_type,
              probeMetadata: {
                error: 'BYTE_COUNT_MISMATCH',
                message: 'Uploaded data byte size does not match declared size',
                expected: asset.bytes,
                actual: quarantined.bytes,
              },
            });
            quarantineStore.removeQuarantined(auth.tenantId, asset.id);

            const resp = { id: asset.id, status: 'rejected' as const };
            repository.completeIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              httpStatus: 202,
              responseBody: resp,
              resourceId: asset.id,
            });

            res.writeHead(202);
            res.end(JSON.stringify(resp));
            return;
          }

          // Media Guard & Sandbox Probe (runs isolated)
          const probeRes = await executeSandboxMediaProbe(
            quarantined.filePath,
            quarantined.buffer,
            asset.mime_type,
          );

          if (!probeRes.success) {
            repository.updateAssetStatus(auth.tenantId, asset.id, {
              status: 'rejected',
              mimeType: asset.mime_type,
              probeMetadata: {
                error: probeRes.code ?? 'PROBE_FAILED',
                message: probeRes.reason ?? 'Media probing rejected in isolated sandbox',
              },
            });
            quarantineStore.removeQuarantined(auth.tenantId, asset.id);

            const resp = { id: asset.id, status: 'rejected' as const };
            repository.completeIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              httpStatus: 202,
              responseBody: resp,
              resourceId: asset.id,
            });

            res.writeHead(202);
            res.end(JSON.stringify(resp));
            return;
          }

          // Validated successfully! Promote to permanent storage
          quarantineStore.promoteToReady(auth.tenantId, asset.id, 1, asset.filename);
          repository.updateAssetStatus(auth.tenantId, asset.id, {
            status: 'ready',
            mimeType: asset.mime_type,
            probeMetadata: probeRes.metadata,
            normalizedSha256: quarantined.sha256,
            bytes: quarantined.bytes,
          });

          const resp = { id: asset.id, status: 'ready' as const };
          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 202,
            responseBody: resp,
            resourceId: asset.id,
          });

          res.writeHead(202);
          res.end(JSON.stringify(resp));
          return;
        }

        // 5.4 POST /v1/assets/imports (behind feature flag per docs/API.md line 35)
        if (pathname === '/v1/assets/imports' && method === 'POST') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;

          if (!config.CVE_REMOTE_IMPORT_ENABLED) {
            sendError(
              res,
              403,
              'CAPABILITY_DISABLED',
              'Remote import connector is disabled by policy',
              requestId,
            );
            return;
          }

          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          const reqHash = crypto
            .createHash('sha256')
            .update(canonicalizeJson(bodyRes.data), 'utf8')
            .digest('hex');

          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/assets/imports',
            key: idemKey,
            requestHash: reqHash,
          });

          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }

          const rawUrl = bodyRes.data['url'];
          const expectedSha = String(bodyRes.data['expected_sha256'] ?? '').toLowerCase().trim();
          const rightsData = bodyRes.data['rights'];

          // 1. Validate rights metadata
          const rightsCheck = validateImportRights(rightsData);
          if (!rightsCheck.valid) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/imports',
              key: idemKey,
            });
            sendError(
              res,
              422,
              'VALIDATION_FAILED',
              rightsCheck.message,
              requestId,
              false,
              [{ pointer: rightsCheck.pointer, code: rightsCheck.code, message: rightsCheck.message }],
            );
            return;
          }

          // 2. Validate expected SHA-256 format
          if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/imports',
              key: idemKey,
            });
            sendError(
              res,
              422,
              'VALIDATION_FAILED',
              'expected_sha256 must be a 64-character lowercase hexadecimal string',
              requestId,
              false,
              [{ pointer: '/expected_sha256', code: 'INVALID_CHECKSUM', message: 'Invalid hex SHA-256' }],
            );
            return;
          }

          // 3. Syntactic URL validation & SSRF defense
          let validatedUrl: ValidatedImportUrlResult;
          try {
            validatedUrl = validateAndNormalizeImportUrl(rawUrl, {
              allowCustomPortForTesting: importConnector.getAllowCustomPortForTesting(),
            });
          } catch (err) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/imports',
              key: idemKey,
            });
            const isSsr = err instanceof SsrSecurityError;
            sendError(
              res,
              isSsr ? err.httpStatus : 422,
              isSsr ? err.code : 'VALIDATION_FAILED',
              err instanceof Error ? err.message : String(err),
              requestId,
              false,
              [{ pointer: isSsr ? err.pointer : '/url', code: isSsr ? err.code : 'INVALID_URL', message: err instanceof Error ? err.message : String(err) }],
            );
            return;
          }

          // 4. Tenant allowlist check
          const tenantAllowlist = repository.getTenantImportAllowlist(auth.tenantId);
          const allowCheck = checkTenantImportAllowlist(validatedUrl.url, tenantAllowlist);
          if (!allowCheck.allowed) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/imports',
              key: idemKey,
            });
            sendError(
              res,
              422,
              'VALIDATION_FAILED',
              `Import URL "${sanitizeSourceUrl(validatedUrl.url)}" is not in tenant allowlist`,
              requestId,
              false,
              [{ pointer: '/url', code: 'URL_NOT_ALLOWLISTED', message: 'Target host or path is not allowlisted for tenant' }],
            );
            return;
          }

          // 5. DNS Resolution and IP range defense (fail fast against prohibited IPs)
          try {
            await resolveAndAuditHostDns(
              validatedUrl.url.hostname,
              importConnector.getDnsResolver(),
              { allowLoopbackForTesting: importConnector.getAllowLoopbackForTesting() },
            );
          } catch (err) {
            repository.releaseIdempotency(auth.tenantId, {
              method: 'POST',
              normalizedPath: '/v1/assets/imports',
              key: idemKey,
            });
            const isSsr = err instanceof SsrSecurityError;
            sendError(
              res,
              isSsr ? err.httpStatus : 422,
              isSsr ? err.code : 'VALIDATION_FAILED',
              err instanceof Error ? err.message : String(err),
              requestId,
              false,
              [{ pointer: isSsr ? err.pointer : '/url', code: isSsr ? err.code : 'SSRF_PROHIBITED_IP', message: err instanceof Error ? err.message : String(err) }],
            );
            return;
          }

          // 6. Create asset in processing status
          const assetId = `ast_${crypto.randomBytes(6).toString('hex')}`;
          const filename = path.basename(validatedUrl.url.pathname) || 'imported_asset.mp4';
          const inferredMime = inferAssetMimeType(validatedUrl.url.pathname);
          const kind = getAssetKindFromMimeType(inferredMime);

          const sanitizedSource = sanitizeSourceUrl(validatedUrl.url);
          const sanitizedRights = {
            ...rightsCheck.sanitized,
            source: sanitizedSource,
          };

          repository.createAssetImport(auth.tenantId, {
            id: assetId,
            filename,
            kind,
            status: 'processing',
            mimeType: inferredMime,
            expectedSha256: expectedSha,
            rights: sanitizedRights,
          });

          // 7. Complete idempotency record with 202 and initial AssetSummary
          const responsePayload = {
            id: assetId,
            status: 'processing' as const,
          };

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/assets/imports',
            key: idemKey,
            httpStatus: 202,
            responseBody: responsePayload,
            resourceId: assetId,
          });

          res.writeHead(202);
          res.end(JSON.stringify(responsePayload));

          // 8. Execute asynchronous background import via ImportConnector
          const currentTenantId = auth.tenantId;
          importConnector
            .executeImport({
              tenantId: currentTenantId,
              assetId,
              url: String(rawUrl),
              expectedSha256: expectedSha,
              rights: rightsCheck.sanitized,
              allowlist: tenantAllowlist,
            })
            .then((result) => {
              if (result.success) {
                repository.updateAssetStatus(currentTenantId, assetId, {
                  status: 'ready',
                  mimeType: result.mimeType,
                  probeMetadata: result.probeMetadata,
                  normalizedSha256: result.sha256,
                  bytes: result.bytes,
                });
              } else {
                repository.updateAssetStatus(currentTenantId, assetId, {
                  status: 'rejected',
                  mimeType: result.mimeType,
                  probeMetadata: {
                    error: result.error?.code ?? 'IMPORT_FAILED',
                    message: result.error?.message ?? 'Remote import failed validation or transfer',
                  },
                });
              }
            })
            .catch((err) => {
              try {
                repository.updateAssetStatus(currentTenantId, assetId, {
                  status: 'rejected',
                  mimeType: inferredMime,
                  probeMetadata: {
                    error: 'UNHANDLED_IMPORT_ERROR',
                    message: err instanceof Error ? err.message : String(err),
                  },
                });
              } catch {
                // Ignore secondary errors to prevent unhandled rejection
              }
            });

          return;
        }

        // 5.5 GET /v1/assets/{id}
        const assetGetMatch = /^\/v1\/assets\/([^/]+)$/.exec(pathname);
        if (assetGetMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['assets:read']);
          if (!auth) return;
          const asset = repository.getAsset(auth.tenantId, assetGetMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(asset));
          return;
        }

        // 5.5b GET /v1/assets/{id}/download
        const assetDownloadMatch = /^\/v1\/assets\/([^/]+)\/download$/.exec(pathname);
        if (assetDownloadMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['assets:read']);
          if (!auth) return;
          const rawBaseUrl = config.CVE_PUBLIC_BASE_URL;
          const hostHeader = req.headers.host || '127.0.0.1';
          const effectiveBaseUrl =
            !rawBaseUrl || rawBaseUrl.includes(':0')
              ? `http://${hostHeader}/v1`
              : rawBaseUrl;
          const cleanBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
          const grant = repository.getAssetDownloadGrant(auth.tenantId, assetDownloadMatch[1]!, {
            baseUrl: cleanBaseUrl,
          });
          res.writeHead(200);
          res.end(JSON.stringify(grant));
          return;
        }

        // 5.5c GET /v1/assets/{id}/tombstone
        const assetTombstoneMatch = /^\/v1\/assets\/([^/]+)\/tombstone$/.exec(pathname);
        if (assetTombstoneMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['assets:read']);
          if (!auth) return;
          const tombstone = repository.getAssetTombstone(auth.tenantId, assetTombstoneMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(tombstone));
          return;
        }

        // 5.6 DELETE /v1/assets/{id}
        const assetDelMatch = /^\/v1\/assets\/([^/]+)$/.exec(pathname);
        if (assetDelMatch && method === 'DELETE') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const deleted = repository.deleteAsset(auth.tenantId, assetDelMatch[1]!);
          quarantineStore.removeAsset(auth.tenantId, assetDelMatch[1]!);
          res.writeHead(202);
          res.end(JSON.stringify(deleted));
          return;
        }

        // 6. POST /v1/compositions
        if (pathname === '/v1/compositions' && method === 'POST') {
          const auth = authenticateAndAuthorize(['compositions:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/compositions',
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = {
            tenantId: auth.tenantId,
            normalizedPath: '/v1/compositions',
            key: idemKey,
          };

          const compId =
            typeof bodyRes.data['id'] === 'string' && bodyRes.data['id'].length > 0
              ? bodyRes.data['id']
              : `cmp_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createComposition(auth.tenantId, {
            id: compId,
            name: String(bodyRes.data['name'] ?? 'Composition'),
            spec: bodyRes.data['spec'] as CompositionSpec,
          });
          const responsePayload = {
            id: created.id,
            revision: created.revision,
            name: created.name,
            created_at: created.created_at,
          };

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath: '/v1/compositions',
            key: idemKey,
            httpStatus: 201,
            responseBody: responsePayload,
            resourceId: created.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(responsePayload));
          return;
        }

        // 7. GET /v1/compositions/{id}
        const compMatch = /^\/v1\/compositions\/([^/]+)$/.exec(pathname);
        if (compMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['compositions:read']);
          if (!auth) return;
          const comp = repository.getComposition(auth.tenantId, compMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(comp));
          return;
        }

        // 8. GET /v1/compositions/{id}/revisions/{revision}
        const compRevMatch = /^\/v1\/compositions\/([^/]+)\/revisions\/(\d+)$/.exec(pathname);
        if (compRevMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['compositions:read']);
          if (!auth) return;
          const rev = repository.getCompositionRevision(
            auth.tenantId,
            compRevMatch[1]!,
            Number(compRevMatch[2]),
          );
          res.setHeader('ETag', `"${rev.render_hash}"`);
          res.writeHead(200);
          res.end(JSON.stringify(rev));
          return;
        }

        // 9. POST /v1/compositions/{id}/revisions
        const compCreateRevMatch = /^\/v1\/compositions\/([^/]+)\/revisions$/.exec(pathname);
        if (compCreateRevMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['compositions:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }
          const normalizedPath = `/v1/compositions/${compCreateRevMatch[1]!}/revisions`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const created = repository.createCompositionRevision(
            auth.tenantId,
            compCreateRevMatch[1]!,
            {
              base_revision: Number(bodyRes.data['base_revision'] ?? 1),
              change_note: bodyRes.data['change_note'] ? String(bodyRes.data['change_note']) : undefined,
              spec: bodyRes.data['spec'] as CompositionSpec,
            },
          );

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 201,
            responseBody: created,
            resourceId: created.id,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        // 10. POST /v1/render-jobs (Task P4-01 atomic admission)
        if (pathname === '/v1/render-jobs' && method === 'POST') {
          const auth = authenticateAndAuthorize(['jobs:write'], { enforceRateLimit: true });
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          const normalizedPath = '/v1/render-jobs';
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            const parsedReplay = JSON.parse(idem.responseBody) as { id?: string };
            if (parsedReplay.id) {
              res.setHeader('Location', `/v1/jobs/${parsedReplay.id}`);
            }
            res.setHeader('Retry-After', '2');
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          if (onAfterIdempotencyClaim) {
            await onAfterIdempotencyClaim({
              tenantId: auth.tenantId,
              normalizedPath,
              key: idemKey,
            });
          }

          const validatedReq = validateRenderJobRequest(bodyRes.data);
          const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
          const admitted = repository.admitJob(auth.tenantId, {
            id: jobId,
            request: validatedReq,
            idempotency: {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              requestHash: reqHash,
            },
            serverCapabilities: {
              customCodeEnabled: config.CVE_CUSTOM_CODE_ENABLED,
            },
            beforeCommitHook: onBeforeJobCommit
              ? () =>
                  onBeforeJobCommit({
                    tenantId: auth.tenantId,
                    jobId,
                    kind: 'render',
                  })
              : undefined,
          });
          activeIdemClaim = null;

          if (onJobAdmissionCommitted) {
            onJobAdmissionCommitted({
              tenantId: auth.tenantId,
              jobId: admitted.job.id,
              kind: 'render',
              committedAtMs: Date.now(),
            });
          }

          res.setHeader('Location', `/v1/jobs/${admitted.job.id}`);
          res.setHeader('Retry-After', '2');
          if (admitted.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
          }
          res.writeHead(202);
          res.end(JSON.stringify(admitted.job));
          return;
        }

        // 10b. POST /v1/previews (Task P4-01 atomic preview admission)
        if (pathname === '/v1/previews' && method === 'POST') {
          const auth = authenticateAndAuthorize(['jobs:write'], { enforceRateLimit: true });
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          const normalizedPath = '/v1/previews';
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            const parsedReplay = JSON.parse(idem.responseBody) as { id?: string };
            if (parsedReplay.id) {
              res.setHeader('Location', `/v1/jobs/${parsedReplay.id}`);
            }
            res.setHeader('Retry-After', '2');
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          if (onAfterIdempotencyClaim) {
            await onAfterIdempotencyClaim({
              tenantId: auth.tenantId,
              normalizedPath,
              key: idemKey,
            });
          }

          const validatedReq = validatePreviewJobRequest(bodyRes.data);
          const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
          const admitted = repository.admitJob(auth.tenantId, {
            id: jobId,
            request: validatedReq,
            idempotency: {
              method: 'POST',
              normalizedPath,
              key: idemKey,
              requestHash: reqHash,
            },
            serverCapabilities: {
              customCodeEnabled: config.CVE_CUSTOM_CODE_ENABLED,
            },
            beforeCommitHook: onBeforeJobCommit
              ? () =>
                  onBeforeJobCommit({
                    tenantId: auth.tenantId,
                    jobId,
                    kind: 'preview',
                  })
              : undefined,
          });
          activeIdemClaim = null;

          if (onJobAdmissionCommitted) {
            onJobAdmissionCommitted({
              tenantId: auth.tenantId,
              jobId: admitted.job.id,
              kind: 'preview',
              committedAtMs: Date.now(),
            });
          }

          res.setHeader('Location', `/v1/jobs/${admitted.job.id}`);
          res.setHeader('Retry-After', '2');
          if (admitted.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
          }
          res.writeHead(202);
          res.end(JSON.stringify(admitted.job));
          return;
        }

        // 11. GET /v1/jobs
        if (pathname === '/v1/jobs' && method === 'GET') {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          const kind = parsedUrl.searchParams.get('kind') ?? undefined;
          const state = parsedUrl.searchParams.get('state') ?? undefined;
          const cursor = parsedUrl.searchParams.get('cursor') ?? undefined;
          const limitRaw = parsedUrl.searchParams.get('limit');
          const limit = limitRaw ? Number(limitRaw) : 20;
          const list = repository.listJobs(auth.tenantId, { kind, state, limit, cursor });
          res.writeHead(200);
          res.end(JSON.stringify(list));
          return;
        }

        // 12. GET /v1/jobs/{id}
        const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(pathname);
        if (jobMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          const job = repository.getJob(auth.tenantId, jobMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(job));
          return;
        }

        // 12b. POST /v1/jobs/{id}/cancel
        const jobCancelMatch = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(pathname);
        if (jobCancelMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['jobs:write']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }

          const jobId = jobCancelMatch[1]!;
          const normalizedPath = `/v1/jobs/${jobId}/cancel`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const canceled = repository.cancelJob(auth.tenantId, jobId);
          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: canceled.httpStatus,
            responseBody: canceled.body,
            resourceId: jobId,
          });
          activeIdemClaim = null;

          res.writeHead(canceled.httpStatus);
          res.end(JSON.stringify(canceled.body));
          return;
        }

        // 12c. GET /v1/jobs/{id}/events
        const jobEventsMatch = /^\/v1\/jobs\/([^/]+)\/events$/.exec(pathname);
        if (jobEventsMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          const afterSeqRaw = parsedUrl.searchParams.get('after_seq');
          const afterSeq = afterSeqRaw ? Number(afterSeqRaw) : undefined;
          const limitRaw = parsedUrl.searchParams.get('limit');
          const limit = limitRaw ? Number(limitRaw) : 50;
          const cursor = parsedUrl.searchParams.get('cursor') ?? undefined;
          const events = repository.listJobEvents(auth.tenantId, jobEventsMatch[1]!, {
            afterSeq,
            limit,
            cursor,
          });
          res.writeHead(200);
          res.end(JSON.stringify(events));
          return;
        }

        // 13. GET /v1/artifacts/{id}/download
        const artDownloadMatch = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(pathname);
        if (artDownloadMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          const rawBaseUrl = config.CVE_PUBLIC_BASE_URL;
          const hostHeader = req.headers.host || '127.0.0.1';
          const baseUrl =
            !rawBaseUrl || rawBaseUrl.includes(':0')
              ? `http://${hostHeader}/v1`
              : rawBaseUrl;
          const grant = repository.getArtifactDownloadGrant(
            auth.tenantId,
            artDownloadMatch[1]!,
            new Date(),
            baseUrl,
          );
          res.writeHead(200);
          res.end(JSON.stringify(grant));
          return;
        }

        // 14. POST /v1/webhook-endpoints & GET /v1/webhook-endpoints/{id}
        if (pathname === '/v1/webhook-endpoints' && method === 'POST') {
          const auth = authenticateAndAuthorize(['webhooks:manage']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          if ('tenant_id' in bodyRes.data) {
            sendError(res, 422, 'VALIDATION_FAILED', 'tenant_id is not permitted in request body', requestId, false, [
              { pointer: '/tenant_id', code: 'UNKNOWN_FIELD', message: 'tenant_id is forbidden in body' },
            ]);
            return;
          }

          const normalizedPath = '/v1/webhook-endpoints';
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const epId = `wh_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createWebhookEndpoint(auth.tenantId, {
            id: epId,
            url: String(bodyRes.data['url'] ?? 'https://client.example.invalid/hook'),
            events: (bodyRes.data['events'] as string[]) ?? ['job.succeeded'],
          });

          // Per docs/API.md line 13: signing_secret is returned ONLY once on initial creation;
          // idempotency store never stores plaintext secret and replays return secret_redacted: true.
          const redactedForReplay = {
            id: created.id,
            url: created.url,
            state: created.state,
            secret_redacted: true as const,
            events: created.events,
            created_at: created.created_at,
          };

          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 201,
            responseBody: redactedForReplay,
            resourceId: created.id,
            secretRedacted: true,
          });
          activeIdemClaim = null;

          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        const whVerifyMatch = /^\/v1\/webhook-endpoints\/([^/]+)\/verify$/.exec(pathname);
        if (whVerifyMatch && method === 'POST') {
          const auth = authenticateAndAuthorize(['webhooks:manage']);
          if (!auth) return;
          const idemKey = verifyIdempotencyHeader();
          if (!idemKey) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          const endpointId = whVerifyMatch[1]!;
          const normalizedPath = `/v1/webhook-endpoints/${endpointId}/verify`;
          const reqHash = computeCanonicalRequestHash(bodyRes.data);
          const idem = repository.claimIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            requestHash: reqHash,
          });
          if (idem.replayed) {
            res.setHeader('Idempotency-Replayed', 'true');
            res.writeHead(idem.httpStatus);
            res.end(idem.responseBody);
            return;
          }
          activeIdemClaim = { tenantId: auth.tenantId, normalizedPath, key: idemKey };

          const verified = repository.verifyWebhookEndpoint(auth.tenantId, endpointId);
          repository.completeIdempotency(auth.tenantId, {
            method: 'POST',
            normalizedPath,
            key: idemKey,
            httpStatus: 200,
            responseBody: verified,
            resourceId: endpointId,
          });
          activeIdemClaim = null;

          res.writeHead(200);
          res.end(JSON.stringify(verified));
          return;
        }

        const whMatch = /^\/v1\/webhook-endpoints\/([^/]+)$/.exec(pathname);
        if (whMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['webhooks:manage']);
          if (!auth) return;
          const ep = repository.getWebhookEndpoint(auth.tenantId, whMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(ep));
          return;
        }

        // 15. GET /v1/usage
        if (pathname === '/v1/usage' && method === 'GET') {
          const auth = authenticateAndAuthorize(['usage:read']);
          if (!auth) return;
          const from = parsedUrl.searchParams.get('from') ?? '2026-11-01T00:00:00Z';
          const to = parsedUrl.searchParams.get('to') ?? '2026-11-30T23:59:59Z';
          const usage = repository.getUsageSummary(auth.tenantId, from, to);
          res.writeHead(200);
          res.end(JSON.stringify(usage));
          return;
        }

        // 16. POST /v1/system/sweep (Maintenance sweeper execution)
        if (pathname === '/v1/system/sweep' && method === 'POST') {
          if (!sweeper) {
            sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Sweeper service not initialized', requestId);
            return;
          }
          const result = sweeper.sweep();
          res.writeHead(200);
          res.end(JSON.stringify(result));
          return;
        }
      } catch (err) {
        if (activeIdemClaim) {
          repository.releaseIdempotency(activeIdemClaim.tenantId, {
            method: 'POST',
            normalizedPath: activeIdemClaim.normalizedPath,
            key: activeIdemClaim.key,
          });
          activeIdemClaim = null;
        }

        if (err instanceof ResourceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', err.message, requestId);
          return;
        }
        if (err instanceof RevisionConflictError) {
          sendError(res, 409, 'REVISION_CONFLICT', err.message, requestId);
          return;
        }
        if (err instanceof IdempotencyConflictError) {
          sendError(res, 409, 'IDEMPOTENCY_CONFLICT', err.message, requestId, false);
          return;
        }
        if (err instanceof IdempotencyInProgressError) {
          res.setHeader('Retry-After', '1');
          sendError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', err.message, requestId, true);
          return;
        }
        if (err instanceof AssetNotReadyError) {
          sendError(res, 409, 'ASSET_NOT_READY', err.message, requestId, false);
          return;
        }
        if (err instanceof WebhookNotVerifiedError) {
          sendError(res, 409, 'WEBHOOK_NOT_VERIFIED', err.message, requestId, false);
          return;
        }
        if (err instanceof JobTerminalError) {
          sendError(res, 409, 'JOB_TERMINAL', err.message, requestId, false);
          return;
        }
        if (err instanceof RateLimitedError) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
          sendError(res, 429, 'RATE_LIMITED', err.message, requestId, true);
          return;
        }
        if (err instanceof QuotaExceededError) {
          res.setHeader('Retry-After', String(err.retryAfterSeconds));
          sendError(res, 429, 'QUOTA_EXCEEDED', err.message, requestId, true);
          return;
        }
        if (err instanceof UnsupportedCapabilityError) {
          sendError(res, 422, 'UNSUPPORTED_CAPABILITY', err.message, requestId, false, err.details);
          return;
        }
        if (err instanceof UploadGrantError) {
          sendError(res, err.httpStatus, err.code, err.message, requestId);
          return;
        }
        if (err instanceof DownloadGrantError) {
          sendError(res, err.httpStatus, err.code, err.message, requestId);
          return;
        }
        if (err instanceof QuarantineStorageError) {
          sendError(res, 400, err.code, err.message, requestId);
          return;
        }
        if (err instanceof InvalidCursorError) {
          sendError(res, 400, 'INVALID_CURSOR', err.message, requestId);
          return;
        }
        if (err instanceof BodyReferenceValidationError) {
          sendError(res, 422, 'VALIDATION_FAILED', err.message, requestId, false, err.details);
          return;
        }
        if (
          err instanceof AdmissionServiceUnavailableError ||
          (err instanceof PoolContextSecurityError && err.code === 'POOL_EXHAUSTED')
        ) {
          res.setHeader('Retry-After', '2');
          sendError(res, 503, 'SERVICE_UNAVAILABLE', err.message, requestId, true);
          return;
        }
        sendError(
          res,
          500,
          'INTERNAL_ERROR',
          err instanceof Error ? err.message : 'Internal server error',
          requestId,
          true,
        );
        return;
      }
    }

    // Unhandled routes
    sendError(res, 404, 'NOT_FOUND', `Endpoint ${method} ${pathname} not found`, requestId);
  });

  return server;
}
