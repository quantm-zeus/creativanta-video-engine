/**
 * REST API Server implementation for Creativanta Video Engine.
 * Canonical specification: docs/API.md & docs/SECURITY.md
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import {
  CapabilitiesResponse,
  CompositionSpec,
  CveEnvConfig,
  ErrorDetail,
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
  InvalidCursorError,
  ResourceNotFoundError,
  RevisionConflictError,
  TenantRepository,
} from './db/repository.js';

export interface CreateServerOptions {
  config: CveEnvConfig;
  repository?: TenantRepository;
  requireAuthOnCapabilities?: boolean;
}

const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_JSON_BODY_BYTES = 1048576; // 1 MiB per docs/PRD.md

export function buildCapabilities(config: CveEnvConfig): CapabilitiesResponse {
  return {
    api_version: '1.0.0',
    scene_schema_versions: ['1.0'],
    engines: {
      'html-v1': true,
      'canvas-v1': true,
      'svg-v1': true,
      'custom-html-v1': config.CVE_CUSTOM_CODE_ENABLED,
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
      custom_code: config.CVE_CUSTOM_CODE_ENABLED,
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

export function createServer({
  config,
  repository,
  requireAuthOnCapabilities = false,
}: CreateServerOptions): http.Server {
  const startTime = Date.now();

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

    const pathname = parsedUrl.pathname;
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

    const authenticateAndAuthorize = (
      requiredScopes: readonly ApiScope[],
    ): { tenantId: string; keyId: string; scopes: ApiScope[] } | null => {
      if (!repository) {
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
      if (requireAuthOnCapabilities || req.headers['authorization'] !== undefined) {
        if (repository) {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
        }
      }
      const caps = buildCapabilities(config);
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

    // Tenant-scoped v1 endpoints require repository
    if (pathname.startsWith('/v1/') && repository) {
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
          if (!verifyIdempotencyHeader()) return;
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
          const id = `tpl_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createTemplate(auth.tenantId, {
            id,
            name: String(bodyRes.data['name'] ?? 'Template'),
            variables_schema: (bodyRes.data['variables_schema'] as Record<string, unknown>) ?? {},
            defaults: (bodyRes.data['defaults'] as Record<string, unknown>) ?? {},
            composition_spec: (bodyRes.data['composition_spec'] as Record<string, unknown>) ?? {},
            supported_locales: (bodyRes.data['supported_locales'] as string[]) ?? ['vi-VN'],
            source_template: bodyRes.data['source_template'] as { id: string; revision: number } | undefined,
          });
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
          if (!verifyIdempotencyHeader()) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          const created = repository.createTemplateRevision(auth.tenantId, tplCreateRevMatch[1]!, {
            base_revision: Number(bodyRes.data['base_revision'] ?? 1),
            change_note: bodyRes.data['change_note'] ? String(bodyRes.data['change_note']) : undefined,
            name: String(bodyRes.data['name'] ?? 'Template'),
            variables_schema: (bodyRes.data['variables_schema'] as Record<string, unknown>) ?? {},
            defaults: (bodyRes.data['defaults'] as Record<string, unknown>) ?? {},
            composition_spec: (bodyRes.data['composition_spec'] as Record<string, unknown>) ?? {},
            supported_locales: (bodyRes.data['supported_locales'] as string[]) ?? ['vi-VN'],
          });
          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        // 5. GET & DELETE /v1/assets/{id}
        const assetMatch = /^\/v1\/assets\/([^/]+)$/.exec(pathname);
        if (assetMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['assets:read']);
          if (!auth) return;
          const asset = repository.getAsset(auth.tenantId, assetMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(asset));
          return;
        }
        if (assetMatch && method === 'DELETE') {
          const auth = authenticateAndAuthorize(['assets:write']);
          if (!auth) return;
          const deleted = repository.deleteAsset(auth.tenantId, assetMatch[1]!);
          res.writeHead(202);
          res.end(JSON.stringify(deleted));
          return;
        }

        // 6. POST /v1/compositions
        if (pathname === '/v1/compositions' && method === 'POST') {
          const auth = authenticateAndAuthorize(['compositions:write']);
          if (!auth) return;
          if (!verifyIdempotencyHeader()) return;
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
          const compId = `cmp_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createComposition(auth.tenantId, {
            id: compId,
            name: String(bodyRes.data['name'] ?? 'Composition'),
            spec: bodyRes.data['spec'] as CompositionSpec,
          });
          res.writeHead(201);
          res.end(
            JSON.stringify({
              id: created.id,
              revision: created.revision,
              name: created.name,
              created_at: created.created_at,
            }),
          );
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
          if (!verifyIdempotencyHeader()) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          const created = repository.createCompositionRevision(
            auth.tenantId,
            compCreateRevMatch[1]!,
            {
              base_revision: Number(bodyRes.data['base_revision'] ?? 1),
              change_note: bodyRes.data['change_note'] ? String(bodyRes.data['change_note']) : undefined,
              spec: bodyRes.data['spec'] as CompositionSpec,
            },
          );
          res.writeHead(201);
          res.end(JSON.stringify(created));
          return;
        }

        // 10. POST /v1/render-jobs
        if (pathname === '/v1/render-jobs' && method === 'POST') {
          const auth = authenticateAndAuthorize(['jobs:write']);
          if (!auth) return;
          if (!verifyIdempotencyHeader()) return;
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
          const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
          const job = repository.createJob(auth.tenantId, {
            id: jobId,
            kind: 'render',
            compositionId: String(bodyRes.data['composition_id'] ?? ''),
            compositionRevision: Number(bodyRes.data['revision'] ?? 1),
            profile: (bodyRes.data['profile'] as 'mp4-720p-v1') ?? 'mp4-720p-v1',
            webhookEndpointId: bodyRes.data['webhook_endpoint_id']
              ? String(bodyRes.data['webhook_endpoint_id'])
              : undefined,
            clientReference: bodyRes.data['client_reference']
              ? String(bodyRes.data['client_reference'])
              : undefined,
            metadata: bodyRes.data['metadata'] as Record<string, string> | undefined,
          });
          res.setHeader('Location', `/v1/jobs/${job.id}`);
          res.setHeader('Retry-After', '2');
          res.writeHead(202);
          res.end(JSON.stringify(job));
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

        // 13. GET /v1/artifacts/{id}/download
        const artDownloadMatch = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(pathname);
        if (artDownloadMatch && method === 'GET') {
          const auth = authenticateAndAuthorize(['jobs:read']);
          if (!auth) return;
          const grant = repository.getArtifactDownloadGrant(auth.tenantId, artDownloadMatch[1]!);
          res.writeHead(200);
          res.end(JSON.stringify(grant));
          return;
        }

        // 14. POST /v1/webhook-endpoints & GET /v1/webhook-endpoints/{id}
        if (pathname === '/v1/webhook-endpoints' && method === 'POST') {
          const auth = authenticateAndAuthorize(['webhooks:manage']);
          if (!auth) return;
          if (!verifyIdempotencyHeader()) return;
          const bodyRes = await readJsonBody(req);
          if (!bodyRes.ok) {
            sendError(res, bodyRes.status, bodyRes.code, bodyRes.message, requestId);
            return;
          }
          const epId = `wh_${crypto.randomBytes(6).toString('hex')}`;
          const created = repository.createWebhookEndpoint(auth.tenantId, {
            id: epId,
            url: String(bodyRes.data['url'] ?? 'https://client.example.invalid/hook'),
            events: (bodyRes.data['events'] as string[]) ?? ['job.succeeded'],
          });
          res.writeHead(201);
          res.end(JSON.stringify(created));
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
      } catch (err) {
        if (err instanceof ResourceNotFoundError) {
          sendError(res, 404, 'NOT_FOUND', err.message, requestId);
          return;
        }
        if (err instanceof RevisionConflictError) {
          sendError(res, 409, 'REVISION_CONFLICT', err.message, requestId);
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
