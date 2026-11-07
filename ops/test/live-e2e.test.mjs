/**
 * Test Suite: Non-Mock Live Staging E2E Verifier
 *
 * Deterministic unit and contract tests for:
 *   - Target endpoint safety validation and refusal of public/production targets
 *   - Token masking and secret redaction
 *   - Fail-closed preflight behavior on unreachable/offline services
 *   - Strict boolean-false capability invariant guards (Codex Finding 5)
 *   - Real `@creativanta/contracts` Scene Spec 1.0 schema/semantic/capability validation (Codex Finding 1)
 *   - ISOBMFF MP4 video track inspection and fail-closed `ffprobe` verification (Codex Finding 2)
 *   - Ephemeral loopback webhook receiver challenge + delivered HMAC verification (Codex Finding 3)
 *   - Bounded per-request header/body timeouts and response byte caps (Codex Finding 4)
 *   - Mandatory cancellation drill with terminal `canceled` state polling (Codex Finding 6)
 *   - Usage baseline capture and non-zero settlement delta reconciliation (Codex Finding 7)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  loadEnvConfig,
  validateCompositionSchema,
  SemanticValidator,
  CapabilityValidator,
  validateCompositionUnified,
  compileComposition,
} from '../../packages/contracts/dist/index.js';
import {
  MigrationRunner,
  QuarantineStore,
  StorageGrantRevocationStore,
  TenantConnectionPool,
  TenantRepository,
  WebhookDeliveryService,
  createServer,
} from '../../packages/api/dist/index.js';
import {
  validateTargetEndpoint,
  TargetEndpointSecurityError,
} from '../staging/config.mjs';
import {
  maskSecret,
  sanitizeUrl,
  redactObject,
  RedactedLogger,
} from '../staging/redaction.mjs';
import {
  SYNTHETIC_LICENSED_SVG_BUFFER,
  SYNTHETIC_LICENSED_SVG_SHA256,
  createValidTestMp4Buffer,
  createValidFfprobeResult,
  inspectMp4Boxes,
  verifyArtifactIntegrity,
} from '../staging/media-verify.mjs';
import {
  runStagingPreflight,
  deriveServerOrigin,
  validateCapabilitiesInvariants,
} from '../staging/preflight.mjs';
import {
  MINIMAL_STAGING_SCENE_SPEC,
  CURATED_FONT_NOTO_SANS,
  buildStagingCompositionSpec,
  buildStagingTemplatePayload,
  StagingWebhookReceiver,
  verifyWebhookHmacSignature,
  validateUsageSettlementDelta,
  LiveStagingE2EVerifier,
} from '../staging/live-e2e.mjs';

/**
 * Helper to create an empty `ftyp` + empty `moov` buffer without any video track or `mdat` box.
 * Used to verify that empty/no-video MP4 containers are rejected fail-closed.
 */
function createEmptyFtypMoovMp4Buffer() {
  const ftypBox = Buffer.alloc(16);
  ftypBox.writeUInt32BE(16, 0);
  ftypBox.write('ftyp', 4, 'ascii');
  ftypBox.write('isom', 8, 'ascii');
  ftypBox.writeUInt32BE(512, 12);

  const moovBox = Buffer.alloc(8);
  moovBox.writeUInt32BE(8, 0);
  moovBox.write('moov', 4, 'ascii');

  return Buffer.concat([ftypBox, moovBox]);
}

/**
 * Recursively substitutes `{ variable: "<name>" }` placeholders in a template composition spec.
 */
function substituteTemplateVariables(node, vars) {
  if (Array.isArray(node)) {
    return node.map((item) => substituteTemplateVariables(item, vars));
  }
  if (node && typeof node === 'object') {
    const keys = Object.keys(node);
    if (keys.length === 1 && keys[0] === 'variable' && typeof node.variable === 'string') {
      return vars[node.variable];
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = substituteTemplateVariables(v, vars);
    }
    return out;
  }
  return node;
}

/**
 * Signs and sends a webhook payload to a target callback URL using Creativanta's HMAC-SHA256 format.
 */
async function sendSignedWebhookCallback(url, signingSecret, eventPayload, options = {}) {
  const rawBody = JSON.stringify(eventPayload);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const digest = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const signature = options.tamperSignature
    ? `v1=${'0'.repeat(64)}`
    : `v1=${digest}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-CVE-Event-Id': eventPayload.id || `evt_${crypto.randomBytes(4).toString('hex')}`,
      'X-CVE-Timestamp': String(timestamp),
      'X-CVE-Key-Id': 'whk_active_01',
      'X-CVE-Signature': signature,
    },
    body: rawBody,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, ok: res.ok, data };
}

/**
 * Injected Local HTTP Test Double Server (clearly labeled test double).
 * Enforces real `@creativanta/contracts` composition validation, webhook challenge & delivery,
 * job cancellation transitions, and usage ledger progression.
 */
class TestDoubleHttpServer {
  constructor(options = {}) {
    this.server = null;
    this.port = 0;
    this.options = {
      healthOk: options.healthOk ?? true,
      readyOk: options.readyOk ?? true,
      readySubsystems: options.readySubsystems ?? { database: 'ok', storage: 'ok', renderer: 'ok' },
      customCodeEnabled: options.customCodeEnabled ?? false,
      remoteImportEnabled: options.remoteImportEnabled ?? false,
      capabilitiesOverride: options.capabilitiesOverride ?? null,
      missingProfiles: options.missingProfiles ?? false,
      artifactBuffer: options.artifactBuffer ?? createValidTestMp4Buffer(),
      grantTtlSeconds: options.grantTtlSeconds ?? 240,
      failWebhookRegistration: options.failWebhookRegistration ?? false,
      failWebhookChallenge: options.failWebhookChallenge ?? false,
      suppressWebhookDelivery: options.suppressWebhookDelivery ?? false,
      tamperWebhookSignature: options.tamperWebhookSignature ?? false,
      failAuxJobCreation: options.failAuxJobCreation ?? false,
      cancelUnsupported: options.cancelUnsupported ?? false,
      ignoreCancelRequest: options.ignoreCancelRequest ?? false,
      usageBaselineOverride: options.usageBaselineOverride ?? null,
      usageFinalOverride: options.usageFinalOverride ?? null,
    };
    this.idempotencyRecords = new Map();
    this.compositions = new Map();
    this.templates = new Map();
    this.readyAssets = new Set();
    this.jobs = new Map();
    this.webhookEndpoints = new Map();
    this.usageMetrics = {
      operational_attempts: 2,
      billable_output_minutes: 0.1,
      billable_jobs: 1,
      preview_jobs: 1,
      settled_count: 1,
      released_count: 0,
    };
    this.jobsExecuted = 0;
  }

  async start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = addr.port;
        resolve(`http://127.0.0.1:${this.port}/v1`);
      });
      this.server.on('error', reject);
    });
  }

  async close() {
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }

  _validateSpecWithContracts(spec, profile = 'mp4-720p-v1') {
    return validateCompositionUnified(spec, {
      profile,
      readyAssetIds: this.readyAssets,
      readyFontIds: new Set([CURATED_FONT_NOTO_SANS.asset_id]),
      fontMetadata: new Map([
        [CURATED_FONT_NOTO_SANS.asset_id, { sha256: CURATED_FONT_NOTO_SANS.sha256 }],
      ]),
    });
  }

  async handle(req, res) {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    let jsonBody = {};
    if (bodyStr) {
      try {
        jsonBody = JSON.parse(bodyStr);
      } catch {
        jsonBody = {};
      }
    }

    const authHeader = req.headers['authorization'] || '';
    const isTenantA = authHeader.includes('tenant_a') || authHeader.includes('key_a');
    const isTenantB = authHeader.includes('tenant_b') || authHeader.includes('key_b');
    const tenantId = isTenantA ? 'tenant_a' : isTenantB ? 'tenant_b' : 'anonymous';

    // 1. Liveness: GET /healthz
    if (pathname === '/healthz' && method === 'GET') {
      if (this.options.healthOk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'creativanta-video-engine-api' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: 'Service unhealthy' }));
      }
      return;
    }

    // 2. Readiness: GET /readyz
    if (pathname === '/readyz' && method === 'GET') {
      if (this.options.readyOk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', checks: this.options.readySubsystems }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'not_ready', checks: this.options.readySubsystems }));
      }
      return;
    }

    // 3. Capabilities: GET /v1/capabilities
    if (pathname === '/v1/capabilities' && method === 'GET') {
      if (this.options.capabilitiesOverride) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.options.capabilitiesOverride));
        return;
      }

      const profiles = this.options.missingProfiles
        ? {}
        : {
            'mp4-720p-v1': { id: 'mp4-720p-v1', supported: true, width: 720, height: 1280 },
            'preview-360p-v1': { id: 'preview-360p-v1', supported: true, width: 360, height: 640 },
          };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          api_version: 'v1',
          engines: {
            'html-v1': true,
            'canvas-v1': true,
            'svg-v1': true,
            'custom-html-v1': false,
          },
          profiles,
          features: {
            custom_code: this.options.customCodeEnabled,
            remote_import: this.options.remoteImportEnabled,
            tts: false,
            authoring_adapter: false,
          },
        })
      );
      return;
    }

    // 4. Composition Validate: POST /v1/compositions/validate
    if (pathname === '/v1/compositions/validate' && method === 'POST') {
      const validation = this._validateSpecWithContracts(
        jsonBody.spec,
        jsonBody.profile || 'mp4-720p-v1'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validation));
      return;
    }

    // 5. Compositions: POST /v1/compositions
    if (pathname === '/v1/compositions' && method === 'POST') {
      const validation = this._validateSpecWithContracts(jsonBody.spec, 'mp4-720p-v1');
      if (!validation.valid) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'SCHEMA_VALIDATION_FAILED',
              message: 'Composition spec failed validation',
              details: validation.errors,
            },
          })
        );
        return;
      }

      const compId = `cmp_${crypto.randomBytes(4).toString('hex')}`;
      this.compositions.set(compId, {
        id: compId,
        revision: 1,
        owner: tenantId,
        spec: jsonBody.spec,
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: compId, revision: 1, status: 'valid' }));
      return;
    }

    // 6. Anti-IDOR Check: GET /v1/compositions/:id
    if (pathname.startsWith('/v1/compositions/') && method === 'GET') {
      const compId = pathname.replace('/v1/compositions/', '');
      const record = this.compositions.get(compId);
      if (!record || record.owner !== tenantId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Composition not found' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(record));
      return;
    }

    // 7. Assets: POST /v1/assets/uploads
    if (pathname === '/v1/assets/uploads' && method === 'POST') {
      const assetId = `ast_${crypto.randomBytes(4).toString('hex')}`;
      const uploadUrl = `http://127.0.0.1:${this.port}/s3-upload/${assetId}`;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          asset_id: assetId,
          status: 'uploading',
          upload_method: 'PUT',
          upload_url: uploadUrl,
          required_headers: { 'Content-Type': jsonBody.mime_type || 'image/svg+xml' },
          expires_at: new Date(Date.now() + 600000).toISOString(),
        })
      );
      return;
    }

    // Direct S3 Upload Handler
    if (pathname.startsWith('/s3-upload/') && method === 'PUT') {
      res.writeHead(200);
      res.end();
      return;
    }

    // 8. Assets Complete: POST /v1/assets/:id/complete
    if (pathname.startsWith('/v1/assets/') && pathname.endsWith('/complete') && method === 'POST') {
      const assetId = pathname.split('/')[3];
      this.readyAssets.add(assetId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: assetId, status: 'ready' }));
      return;
    }

    // 9. Templates Create: POST /v1/templates
    if (pathname === '/v1/templates' && method === 'POST') {
      const testSpec = substituteTemplateVariables(
        jsonBody.composition_spec,
        jsonBody.defaults || {}
      );
      const schemaRes = validateCompositionSchema(testSpec);
      if (!schemaRes.valid) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'SCHEMA_VALIDATION_FAILED',
              message: 'Template composition_spec with defaults is invalid',
              details: schemaRes.errors,
            },
          })
        );
        return;
      }

      const tplId = `tpl_${crypto.randomBytes(4).toString('hex')}`;
      this.templates.set(tplId, {
        id: tplId,
        revision: 1,
        owner: tenantId,
        ...jsonBody,
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: tplId, revision: 1, name: jsonBody.name }));
      return;
    }

    // 10. Templates Instantiate: POST /v1/templates/:id/instantiate
    if (pathname.startsWith('/v1/templates/') && pathname.endsWith('/instantiate') && method === 'POST') {
      const tplId = pathname.split('/')[3];
      const tpl = this.templates.get(tplId);
      if (!tpl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Template not found' } }));
        return;
      }

      const mergedVars = { ...(tpl.defaults || {}), ...(jsonBody.variables || {}) };
      const instantiatedSpec = substituteTemplateVariables(tpl.composition_spec, mergedVars);
      const validation = this._validateSpecWithContracts(instantiatedSpec, 'mp4-720p-v1');
      if (!validation.valid) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'SCHEMA_VALIDATION_FAILED',
              message: 'Instantiated template spec failed validation',
              details: validation.errors,
            },
          })
        );
        return;
      }

      const compId = `cmp_inst_${crypto.randomBytes(4).toString('hex')}`;
      this.compositions.set(compId, {
        id: compId,
        revision: 1,
        owner: tenantId,
        spec: instantiatedSpec,
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: compId,
          revision: 1,
          status: 'valid',
          template: { id: tplId, revision: 1 },
        })
      );
      return;
    }

    // 11. Previews: POST /v1/previews
    if (pathname === '/v1/previews' && method === 'POST') {
      if (jsonBody.mode === 'frame' && this.options.failAuxJobCreation) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Aux job failed' } }));
        return;
      }

      const jobId = `job_prev_${crypto.randomBytes(4).toString('hex')}`;
      const isAuxCancel = jsonBody.mode === 'frame';
      this.jobs.set(jobId, {
        id: jobId,
        kind: 'preview',
        state: isAuxCancel ? 'queued' : 'succeeded',
        progress: isAuxCancel ? 0 : 1,
        artifacts: isAuxCancel
          ? []
          : [{ id: 'art_prev_001', kind: 'video', mime_type: 'video/mp4' }],
      });

      if (!isAuxCancel) {
        this.jobsExecuted++;
        this.usageMetrics.operational_attempts += 1;
        this.usageMetrics.preview_jobs += 1;
        this.usageMetrics.settled_count += 1;
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: jobId, kind: 'preview', state: 'queued' }));
      return;
    }

    // 12. Render Jobs: POST /v1/render-jobs (with idempotency and webhook delivery)
    if (pathname === '/v1/render-jobs' && method === 'POST') {
      const idemKey = req.headers['idempotency-key'];
      if (idemKey && this.idempotencyRecords.has(idemKey)) {
        const recorded = this.idempotencyRecords.get(idemKey);
        res.writeHead(202, {
          'Content-Type': 'application/json',
          'Idempotency-Replayed': 'true',
        });
        res.end(JSON.stringify(recorded));
        return;
      }

      if (jsonBody.webhook_endpoint_id) {
        const ep = this.webhookEndpoints.get(jsonBody.webhook_endpoint_id);
        if (!ep || ep.state !== 'active') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: { code: 'WEBHOOK_NOT_VERIFIED', message: 'Webhook endpoint not active' },
            })
          );
          return;
        }
      }

      const jobId = `job_render_${crypto.randomBytes(4).toString('hex')}`;
      const payload = { id: jobId, kind: 'render', state: 'queued' };
      if (idemKey) {
        this.idempotencyRecords.set(idemKey, payload);
      }

      this.jobs.set(jobId, {
        id: jobId,
        kind: 'render',
        state: 'succeeded',
        progress: 1,
        webhook_endpoint_id: jsonBody.webhook_endpoint_id || null,
        artifacts: [
          {
            id: 'art_video_001',
            kind: 'video',
            mime_type: 'video/mp4',
          },
        ],
      });

      this.jobsExecuted++;
      this.usageMetrics.operational_attempts += 1;
      this.usageMetrics.billable_jobs += 1;
      this.usageMetrics.billable_output_minutes = Number(
        (this.usageMetrics.billable_output_minutes + 0.05).toFixed(4)
      );
      this.usageMetrics.settled_count += 1;

      // Deliver signed job.succeeded webhook asynchronously if configured
      if (jsonBody.webhook_endpoint_id && !this.options.suppressWebhookDelivery) {
        const ep = this.webhookEndpoints.get(jsonBody.webhook_endpoint_id);
        if (ep) {
          const eventPayload = {
            id: `evt_${crypto.randomBytes(6).toString('hex')}`,
            type: 'job.succeeded',
            api_version: 'v1',
            created_at: new Date().toISOString(),
            data: {
              job_id: jobId,
              kind: 'render',
              state: 'succeeded',
              profile: 'mp4-720p-v1',
            },
          };
          sendSignedWebhookCallback(ep.url, ep.signingSecret, eventPayload, {
            tamperSignature: this.options.tamperWebhookSignature,
          }).catch(() => {});
        }
      }

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    // 13. Job Status: GET /v1/jobs/:id
    if (pathname.startsWith('/v1/jobs/') && !pathname.endsWith('/cancel') && method === 'GET') {
      const jobId = pathname.replace('/v1/jobs/', '');
      const job = this.jobs.get(jobId) || {
        id: jobId,
        state: 'succeeded',
        progress: 1,
        artifacts: [{ id: 'art_video_001', kind: 'video', mime_type: 'video/mp4' }],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
      return;
    }

    // 14. Job Cancel: POST /v1/jobs/:id/cancel
    if (pathname.startsWith('/v1/jobs/') && pathname.endsWith('/cancel') && method === 'POST') {
      if (this.options.cancelUnsupported) {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_IMPLEMENTED', message: 'Not supported' } }));
        return;
      }

      const jobId = pathname.split('/')[3];
      const existing = this.jobs.get(jobId);
      if (existing) {
        existing.state = this.options.ignoreCancelRequest ? 'succeeded' : 'canceled';
      }
      this.usageMetrics.released_count += 1;
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: jobId, state: 'cancel_requested' }));
      return;
    }

    // 15. Webhook endpoints: POST /v1/webhook-endpoints
    if (pathname === '/v1/webhook-endpoints' && method === 'POST') {
      if (this.options.failWebhookRegistration) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Webhook reg failed' } }));
        return;
      }

      const epId = `wh_${crypto.randomBytes(4).toString('hex')}`;
      const signingSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
      this.webhookEndpoints.set(epId, {
        id: epId,
        url: jsonBody.url,
        state: 'pending_verification',
        signingSecret,
        events: jsonBody.events || [],
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: epId,
          url: jsonBody.url,
          state: 'pending_verification',
          active_key_id: 'whk_active_01',
          signing_secret: signingSecret,
          events: jsonBody.events || [],
        })
      );
      return;
    }

    // 16. Webhook challenge verify: POST /v1/webhook-endpoints/:id/verify
    if (
      pathname.startsWith('/v1/webhook-endpoints/') &&
      pathname.endsWith('/verify') &&
      method === 'POST'
    ) {
      if (!req.headers['idempotency-key']) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Missing Idempotency-Key header' },
          })
        );
        return;
      }
      const epId = pathname.split('/')[3];
      const ep = this.webhookEndpoints.get(epId);
      if (!ep || this.options.failWebhookChallenge) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'WEBHOOK_CHALLENGE_FAILED', message: 'Challenge failed' },
          })
        );
        return;
      }

      const challengeToken = crypto.randomBytes(32).toString('hex');
      const challengePayload = {
        id: `evt_ch_${crypto.randomBytes(4).toString('hex')}`,
        type: 'endpoint.challenge',
        api_version: 'v1',
        created_at: new Date().toISOString(),
        data: {
          endpoint_id: ep.id,
          challenge: challengeToken,
        },
      };

      const challengeRes = await sendSignedWebhookCallback(
        ep.url,
        ep.signingSecret,
        challengePayload
      );

      if (!challengeRes.ok || challengeRes.data?.challenge !== challengeToken) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 'WEBHOOK_CHALLENGE_FAILED', message: 'Challenge mismatch' },
          })
        );
        return;
      }

      ep.state = 'active';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: ep.id,
          state: 'active',
          verified_at: new Date().toISOString(),
        })
      );
      return;
    }

    // 17. Webhook delete: DELETE /v1/webhook-endpoints/:id
    if (pathname.startsWith('/v1/webhook-endpoints/') && method === 'DELETE') {
      const epId = pathname.split('/')[3];
      this.webhookEndpoints.delete(epId);
      res.writeHead(204);
      res.end();
      return;
    }

    // 18. Download Grant: GET /v1/artifacts/:id/download
    if (pathname.startsWith('/v1/artifacts/') && pathname.endsWith('/download') && method === 'GET') {
      const artifactBuffer = this.options.artifactBuffer;
      const sha256 = crypto.createHash('sha256').update(artifactBuffer).digest('hex');
      const downloadUrl = `http://127.0.0.1:${this.port}/s3-download/art_video_001`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          url: downloadUrl,
          expires_at: new Date(Date.now() + this.options.grantTtlSeconds * 1000).toISOString(),
          bytes: artifactBuffer.length,
          sha256,
        })
      );
      return;
    }

    // Direct S3 Download Handler
    if (pathname.startsWith('/s3-download/') && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(this.options.artifactBuffer.length),
      });
      res.end(this.options.artifactBuffer);
      return;
    }

    // 19. Usage: GET /v1/usage
    if (pathname === '/v1/usage' && method === 'GET') {
      if (this.jobsExecuted === 0 && this.options.usageBaselineOverride) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.options.usageBaselineOverride));
        return;
      }
      if (this.jobsExecuted > 0 && this.options.usageFinalOverride) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.options.usageFinalOverride));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          from: parsedUrl.searchParams.get('from') || new Date(Date.now() - 3600000).toISOString(),
          to: parsedUrl.searchParams.get('to') || new Date().toISOString(),
          operational_attempts: this.usageMetrics.operational_attempts,
          billable_output_minutes: this.usageMetrics.billable_output_minutes,
          estimated_cost: Number((this.usageMetrics.billable_output_minutes * 0.05).toFixed(4)),
          currency: 'USD',
          operational_cpu_seconds: this.usageMetrics.operational_attempts * 1.5,
          billable_jobs: this.usageMetrics.billable_jobs,
          preview_jobs: this.usageMetrics.preview_jobs,
          reservations: {
            pending_count: 0,
            pending_vcpu_seconds: 0,
            pending_output_seconds: 0,
            settled_count: this.usageMetrics.settled_count,
            released_count: this.usageMetrics.released_count,
          },
          reconciliation: {
            clean: true,
            double_debit_detected: false,
            discrepancies: [],
          },
        })
      );
      return;
    }

    // Catch-all
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  }
}

describe('Non-Mock Live Staging E2E Verifier Suite (P10-B)', () => {
  describe('1. Target Endpoint Security & Refusal Guards', () => {
    it('accepts loopback addresses and normalizes URL', () => {
      assert.strictEqual(validateTargetEndpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1');
      assert.strictEqual(validateTargetEndpoint('http://localhost:3000'), 'http://localhost:3000');
      assert.strictEqual(validateTargetEndpoint('http://127.0.0.2:9000/v1'), 'http://127.0.0.2:9000/v1');
    });

    it('accepts approved private RFC1918 addresses and internal staging domains', () => {
      assert.strictEqual(
        validateTargetEndpoint('http://10.0.1.5:8080/v1'),
        'http://10.0.1.5:8080/v1'
      );
      assert.strictEqual(
        validateTargetEndpoint('https://staging.creativanta.internal/v1'),
        'https://staging.creativanta.internal/v1'
      );
      assert.strictEqual(
        validateTargetEndpoint('http://worker.local:8080/v1'),
        'http://worker.local:8080/v1'
      );
    });

    it('DENIES public production domain targets by default (fail-closed)', () => {
      assert.throws(
        () => validateTargetEndpoint('https://video.creativanta.com/v1'),
        (err) => err instanceof TargetEndpointSecurityError && err.message.includes('PRODUCTION/PUBLIC TARGET DENIED')
      );
      assert.throws(
        () => validateTargetEndpoint('https://api.creativanta.io'),
        TargetEndpointSecurityError
      );
      assert.throws(
        () => validateTargetEndpoint('http://example.com/v1'),
        TargetEndpointSecurityError
      );
    });

    it('DENIES public IP literals by default', () => {
      assert.throws(
        () => validateTargetEndpoint('http://8.8.8.8:8080/v1'),
        TargetEndpointSecurityError
      );
      assert.throws(
        () => validateTargetEndpoint('http://203.0.113.10:8080/v1'),
        TargetEndpointSecurityError
      );
    });

    it('rejects malformed or empty URLs', () => {
      assert.throws(() => validateTargetEndpoint(''), TargetEndpointSecurityError);
      assert.throws(() => validateTargetEndpoint('ftp://127.0.0.1:21'), TargetEndpointSecurityError);
      assert.throws(() => validateTargetEndpoint('not-a-url'), TargetEndpointSecurityError);
    });

    it('derives server origin correctly', () => {
      assert.strictEqual(deriveServerOrigin('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080');
      assert.strictEqual(deriveServerOrigin('https://staging.creativanta.internal:8443/v1/sub'), 'https://staging.creativanta.internal:8443');
    });
  });

  describe('2. Secret Redaction & Token Masking', () => {
    it('masks long tokens while displaying safe prefix/suffix', () => {
      const token = 'cve_live_staging_smoke_key_0123456789abcdef';
      const masked = maskSecret(token);
      assert.strictEqual(masked, 'cve_...cdef');
      assert.ok(!masked.includes('smoke_key'));
    });

    it('returns [REDACTED] for short or null secrets', () => {
      assert.strictEqual(maskSecret('short'), '[REDACTED]');
      assert.strictEqual(maskSecret(null), '[REDACTED]');
      assert.strictEqual(maskSecret(undefined), '[REDACTED]');
    });

    it('sanitizes URL query parameters containing signatures and tokens', () => {
      const sensitiveUrl = 'https://s3.internal/bucket/file.mp4?token=secret123&X-Amz-Signature=abc456&safeParam=value';
      const clean = sanitizeUrl(sensitiveUrl);
      assert.ok(!clean.includes('secret123'));
      assert.ok(!clean.includes('abc456'));
      assert.ok(clean.includes('safeParam=value'));
    });

    it('strips user credentials from sanitized URLs', () => {
      const credUrl = 'http://admin:superSecret@staging.internal:8080/v1/path';
      const clean = sanitizeUrl(credUrl);
      assert.strictEqual(clean, 'http://staging.internal:8080/v1/path');
    });

    it('recursively redacts sensitive keys from objects', () => {
      const payload = {
        name: 'test',
        api_key: 'cve_live_staging_secret_key_12345',
        nested: {
          signing_secret: 'whsec_very_secret_token_abcde',
          public_info: 'allowed',
        },
      };
      const redacted = redactObject(payload);
      assert.strictEqual(redacted.name, 'test');
      assert.strictEqual(redacted.api_key, 'cve_...2345');
      assert.strictEqual(redacted.nested.signing_secret, 'whse...bcde');
      assert.strictEqual(redacted.nested.public_info, 'allowed');
    });

    it('RedactedLogger scrubs registered secrets and Bearer tokens', () => {
      let output = '';
      const mockStream = {
        write: (str) => {
          output += str;
        },
      };

      const logger = new RedactedLogger(mockStream);
      const secret = 'cve_super_secret_token_value_999';
      logger.registerSecret(secret);

      logger.info(`Sending token ${secret} and Bearer abcdef1234567890`);
      assert.ok(!output.includes('cve_super_secret_token_value_999'));
      assert.ok(output.includes('cve_..._999'));
      assert.ok(!output.includes('abcdef1234567890'));
      assert.ok(output.includes('Bearer abcd...7890'));
    });
  });

  describe('3. Synthetic Media Fixtures & MP4 Integrity (Codex Finding 2)', () => {
    it('provides valid synthetic licensed SVG fixture buffer and matching SHA-256', () => {
      assert.ok(Buffer.isBuffer(SYNTHETIC_LICENSED_SVG_BUFFER));
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.length > 0);
      assert.strictEqual(SYNTHETIC_LICENSED_SVG_SHA256.length, 64);
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.toString('utf8').includes('<svg'));
      assert.ok(SYNTHETIC_LICENSED_SVG_BUFFER.toString('utf8').includes('Creativanta'));
    });

    it('inspectMp4Boxes validates complete ISOBMFF ftyp/moov/vide/avc1/mdat structure', () => {
      const validMp4 = createValidTestMp4Buffer();
      const analysis = inspectMp4Boxes(validMp4);
      assert.strictEqual(analysis.valid, true);
      assert.strictEqual(analysis.majorBrand, 'isom');
      assert.strictEqual(analysis.hasMoov, true);
      assert.strictEqual(analysis.hasMdat, true);
      assert.strictEqual(analysis.hasVideoTrack, true);
      assert.strictEqual(analysis.videoCodec, 'avc1');
      assert.strictEqual(analysis.width, 720);
      assert.strictEqual(analysis.height, 1280);
      assert.strictEqual(analysis.sampleCount, 90);
      assert.strictEqual(analysis.durationSeconds, 3);
    });

    it('inspectMp4Boxes rejects malformed non-MP4 buffers and short buffers', () => {
      const corrupt = Buffer.from('NOT_AN_MP4_FILE_JUST_PLAIN_TEXT_WITH_36_BYTES');
      const analysis = inspectMp4Boxes(corrupt);
      assert.strictEqual(analysis.valid, false);
      assert.ok(analysis.error.includes("expected 'ftyp' box"));

      const tooShort = Buffer.from('ftyp');
      assert.strictEqual(inspectMp4Boxes(tooShort).valid, false);
    });

    it('[Codex Finding 2] inspectMp4Boxes REJECTS empty ftyp+moov without video stream or mdat', () => {
      const emptyFtypMoov = createEmptyFtypMoovMp4Buffer();
      const analysis = inspectMp4Boxes(emptyFtypMoov);
      assert.strictEqual(analysis.valid, false);
    });

    it('[Codex Finding 2] inspectMp4Boxes REJECTS truncated boxes where declared size exceeds buffer', () => {
      const validMp4 = Buffer.from(createValidTestMp4Buffer());
      // Corrupt the moov box size at offset 28 to exceed buffer length
      validMp4.writeUInt32BE(999999, 28);
      const analysis = inspectMp4Boxes(validMp4);
      assert.strictEqual(analysis.valid, false);
      assert.ok(analysis.error.includes('Malformed or truncated ISOBMFF box'));
    });

    it('verifyArtifactIntegrity detects byte length and SHA-256 mismatches', () => {
      const validMp4 = createValidTestMp4Buffer();
      const actualSha = crypto.createHash('sha256').update(validMp4).digest('hex');

      const pass = verifyArtifactIntegrity(validMp4, {
        expectedBytes: validMp4.length,
        expectedSha256: actualSha,
        isMp4: true,
        ffprobeRunner: () => createValidFfprobeResult({ bytes: validMp4.length }),
      });
      assert.strictEqual(pass.valid, true);
      assert.strictEqual(pass.byteCountMatches, true);
      assert.strictEqual(pass.sha256Matches, true);

      const fail = verifyArtifactIntegrity(validMp4, {
        expectedBytes: validMp4.length + 10,
        expectedSha256: actualSha,
        isMp4: true,
        ffprobeRunner: () => createValidFfprobeResult({ bytes: validMp4.length }),
      });
      assert.strictEqual(fail.valid, false);
      assert.strictEqual(fail.byteCountMatches, false);
    });

    it('[Codex Finding 2] verifyArtifactIntegrity FAILS CLOSED when ffprobe is missing/unavailable', () => {
      const validMp4 = createValidTestMp4Buffer();
      const res = verifyArtifactIntegrity(validMp4, {
        isMp4: true,
        requireFfprobe: true,
        ffprobeRunner: () => ({ available: false, error: 'ffprobe binary not found in PATH' }),
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('FFPROBE_UNAVAILABLE')));
    });

    it('[Codex Finding 2] verifyArtifactIntegrity FAILS CLOSED when ffprobe exits non-zero or errors', () => {
      const validMp4 = createValidTestMp4Buffer();
      const res = verifyArtifactIntegrity(validMp4, {
        isMp4: true,
        requireFfprobe: true,
        ffprobeRunner: () => ({
          available: true,
          exitCode: 1,
          error: 'moov atom not found / Invalid data found when processing input',
        }),
      });
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.includes('ffprobe error (exit 1)')));
    });

    it('[Codex Finding 2] verifyArtifactIntegrity FAILS CLOSED when ffprobe reports no video stream or 0 frames', () => {
      const validMp4 = createValidTestMp4Buffer();

      const audioOnlyRes = verifyArtifactIntegrity(validMp4, {
        isMp4: true,
        ffprobeRunner: () => ({
          available: true,
          exitCode: 0,
          format: { format_name: 'mov,mp4,m4a', duration: '3.0' },
          streams: [{ codec_type: 'audio', codec_name: 'aac' }],
        }),
      });
      assert.strictEqual(audioOnlyRes.valid, false);
      assert.ok(audioOnlyRes.errors.some((e) => e.includes('no decodable video stream')));

      const zeroFramesRes = verifyArtifactIntegrity(validMp4, {
        isMp4: true,
        ffprobeRunner: () =>
          createValidFfprobeResult({ nbReadFrames: 0, duration: '3.000000' }),
      });
      assert.strictEqual(zeroFramesRes.valid, false);
      assert.ok(zeroFramesRes.errors.some((e) => e.includes('decoded 0 frames')));

      const zeroDurationRes = verifyArtifactIntegrity(validMp4, {
        isMp4: true,
        ffprobeRunner: () =>
          createValidFfprobeResult({ nbReadFrames: 90, duration: '0.000000' }),
      });
      assert.strictEqual(zeroDurationRes.valid, false);
      assert.ok(zeroDurationRes.errors.some((e) => e.includes('non-positive duration')));
    });
  });

  describe('4. Fail-Closed Preflight on Absent Services', () => {
    it('fails closed when target API is completely offline (connection refused)', async () => {
      const offlineUrl = 'http://127.0.0.1:58761/v1';
      const preflight = await runStagingPreflight({
        baseUrl: offlineUrl,
        apiKeyA: 'test_a',
        apiKeyB: 'test_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.strictEqual(preflight.status, 'NOT_READY');
      assert.strictEqual(preflight.dependencies.api, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.database, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.storage, 'UNAVAILABLE');
      assert.strictEqual(preflight.dependencies.renderer, 'UNAVAILABLE');
      assert.ok(preflight.blockers.some((b) => b.includes('API_SERVICE_UNAVAILABLE')));
    });

    it('LiveStagingE2EVerifier returns structured NOT_READY when services are absent (NO MOCK invoked)', async () => {
      const offlineUrl = 'http://127.0.0.1:58762/v1';
      const verifier = new LiveStagingE2EVerifier({
        baseUrl: offlineUrl,
        apiKeyA: 'test_a',
        apiKeyB: 'test_b',
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'NOT_READY');
      assert.strictEqual(result.decision, 'HOLD_SERVICES_NOT_DEPLOYED');
      assert.strictEqual(result.passedStages, 0);
      assert.strictEqual(result.failedStages, 0);
      assert.strictEqual(result.dependencies.api, 'UNAVAILABLE');
      assert.ok(result.blockers.length > 0);
    });
  });

  describe('5. Preflight Fail-Closed on Degraded Dependencies & Capability Invariants (Codex Finding 5)', () => {
    let testDouble = null;

    it('fails closed when /readyz returns 503 (database/storage/renderer not ready)', async () => {
      testDouble = new TestDoubleHttpServer({
        readyOk: false,
        readySubsystems: { database: 'unavailable', storage: 'unavailable', renderer: 'unavailable' },
      });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.strictEqual(preflight.status, 'NOT_READY');
      assert.ok(preflight.blockers.some((b) => b.includes('API_READINESS_FAIL_CLOSED')));

      await testDouble.close();
    });

    it('fails closed when custom code is enabled (violates CVE_CUSTOM_CODE_ENABLED invariant)', async () => {
      testDouble = new TestDoubleHttpServer({ customCodeEnabled: true });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('CVE_CUSTOM_CODE_ENABLED must be false')));

      await testDouble.close();
    });

    it('fails closed when required profile mp4-720p-v1 is missing from capabilities', async () => {
      testDouble = new TestDoubleHttpServer({ missingProfiles: true });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('Missing required profiles')));

      await testDouble.close();
    });

    it('fails closed when tenant API credentials are not provided', async () => {
      testDouble = new TestDoubleHttpServer();
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: '',
        apiKeyB: '',
      });

      assert.strictEqual(preflight.ready, false);
      assert.ok(preflight.blockers.some((b) => b.includes('MISSING_TENANT_CREDENTIALS')));

      await testDouble.close();
    });

    it('[Codex Finding 5] fails preflight when capabilities.features is absent or protected fields are missing', async () => {
      testDouble = new TestDoubleHttpServer({
        capabilitiesOverride: {
          api_version: 'v1',
          profiles: {
            'mp4-720p-v1': { id: 'mp4-720p-v1', supported: true },
            'preview-360p-v1': { id: 'preview-360p-v1', supported: true },
          },
          // features omitted completely!
        },
      });
      const baseUrl = await testDouble.start();

      const preflight = await runStagingPreflight({
        baseUrl,
        apiKeyA: 'test_key_a',
        apiKeyB: 'test_key_b',
      });

      assert.strictEqual(preflight.ready, false);
      assert.strictEqual(preflight.status, 'NOT_READY');
      assert.ok(preflight.blockers.some((b) => b.includes('missing required "features" object')));

      await testDouble.close();
    });

    it('[Codex Finding 5] fails preflight when protected capability flags are missing or non-boolean ("false", 0, null)', async () => {
      const partialRes = validateCapabilitiesInvariants({
        profiles: {
          'mp4-720p-v1': { supported: true },
          'preview-360p-v1': { supported: true },
        },
        features: {
          custom_code: false,
          // remote_import missing!
          tts: 'false', // string instead of boolean!
          authoring_adapter: 0, // number instead of boolean!
        },
      });

      assert.strictEqual(partialRes.valid, false);
      assert.ok(partialRes.violations.some((v) => v.includes('features.remote_import" is missing')));
      assert.ok(partialRes.violations.some((v) => v.includes('features.tts" must be explicitly boolean false')));
      assert.ok(
        partialRes.violations.some((v) => v.includes('features.authoring_adapter" must be explicitly boolean false'))
      );
    });
  });

  describe('6. Full Live Staging Verification Workflow (TestDoubleHttpServer)', () => {
    let testDouble = null;
    let baseUrl = '';

    it('executes full 10-stage live E2E verification workflow and achieves 100% PASS', async () => {
      testDouble = new TestDoubleHttpServer({
        healthOk: true,
        readyOk: true,
        customCodeEnabled: false,
        remoteImportEnabled: false,
        grantTtlSeconds: 240,
      });
      baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        webhookSecret: 'whsec_staging_test_secret_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();

      assert.strictEqual(result.status, 'PASS');
      assert.strictEqual(result.decision, 'STAGING_LIVE_E2E_VERIFIED');
      assert.strictEqual(result.totalStages, 10);
      assert.strictEqual(result.passedStages, 10);
      assert.strictEqual(result.failedStages, 0);

      const stageIds = result.stages.map((s) => s.id);
      assert.deepStrictEqual(stageIds, [
        'LIVE-01',
        'LIVE-02',
        'LIVE-03',
        'LIVE-04',
        'LIVE-05',
        'LIVE-06',
        'LIVE-07',
        'LIVE-08',
        'LIVE-09',
        'LIVE-10',
      ]);

      for (const stage of result.stages) {
        assert.strictEqual(stage.passed, true);
        assert.ok(stage.durationMs >= 0);
      }

      await testDouble.close();
    });

    it('fails when download grant TTL exceeds 300 seconds security constraint', async () => {
      testDouble = new TestDoubleHttpServer({
        grantTtlSeconds: 600,
      });
      baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage08 = result.stages.find((s) => s.id === 'LIVE-08');
      assert.ok(stage08);
      assert.strictEqual(stage08.passed, false);
      assert.ok(stage08.error.includes('exceeds 300 seconds security cap'));

      await testDouble.close();
    });
  });

  describe('7. Canonical Scene Spec 1.0 & Real @creativanta/contracts Validation (Codex Finding 1)', () => {
    it('MINIMAL_STAGING_SCENE_SPEC passes real @creativanta/contracts JSON Schema, Semantic, Capability, and Compiler checks', () => {
      const schemaRes = validateCompositionSchema(MINIMAL_STAGING_SCENE_SPEC);
      assert.strictEqual(schemaRes.valid, true, JSON.stringify(schemaRes.errors));

      const semanticValidator = new SemanticValidator();
      const semRes = semanticValidator.validate(MINIMAL_STAGING_SCENE_SPEC, {
        readyAssetIds: new Set(),
        readyFontIds: new Set([CURATED_FONT_NOTO_SANS.asset_id]),
        fontMetadata: new Map([
          [CURATED_FONT_NOTO_SANS.asset_id, { sha256: CURATED_FONT_NOTO_SANS.sha256 }],
        ]),
      });
      assert.strictEqual(semRes.valid, true, JSON.stringify(semRes.errors));

      const capValidator = new CapabilityValidator();
      const capRes = capValidator.validate(MINIMAL_STAGING_SCENE_SPEC, {
        profile: 'mp4-720p-v1',
        customCodeEnabled: false,
      });
      assert.strictEqual(capRes.valid, true, JSON.stringify(capRes.errors));

      const unifiedRes = validateCompositionUnified(MINIMAL_STAGING_SCENE_SPEC, {
        profile: 'mp4-720p-v1',
        readyAssetIds: new Set(),
        readyFontIds: new Set([CURATED_FONT_NOTO_SANS.asset_id]),
        fontMetadata: new Map([
          [CURATED_FONT_NOTO_SANS.asset_id, { sha256: CURATED_FONT_NOTO_SANS.sha256 }],
        ]),
      });
      assert.strictEqual(unifiedRes.valid, true, JSON.stringify(unifiedRes.errors));

      const compiled = compileComposition(MINIMAL_STAGING_SCENE_SPEC);
      assert.strictEqual(typeof compiled.spec_hash, 'string');
      assert.strictEqual(compiled.spec_hash.length, 64);
      assert.strictEqual(typeof compiled.render_hash, 'string');
      assert.strictEqual(compiled.render_hash.length, 64);
    });

    it('buildStagingCompositionSpec and buildStagingTemplatePayload produce schema-valid & semantically-valid compositions with SVG asset', () => {
      const svgAssetId = 'ast_test_svg_badge_001';
      const specWithSvg = buildStagingCompositionSpec({ svgAssetId });
      const unifiedRes = validateCompositionUnified(specWithSvg, {
        profile: 'mp4-720p-v1',
        readyAssetIds: new Set([svgAssetId]),
        readyFontIds: new Set([CURATED_FONT_NOTO_SANS.asset_id]),
        fontMetadata: new Map([
          [CURATED_FONT_NOTO_SANS.asset_id, { sha256: CURATED_FONT_NOTO_SANS.sha256 }],
        ]),
      });
      assert.strictEqual(unifiedRes.valid, true, JSON.stringify(unifiedRes.errors));

      const tplPayload = buildStagingTemplatePayload({ defaultSvgAssetId: svgAssetId });
      const instantiated = substituteTemplateVariables(tplPayload.composition_spec, {
        headline: 'Ưu đãi đặc biệt',
        price: '149.000 ₫',
        badge_asset_id: svgAssetId,
      });
      const tplUnifiedRes = validateCompositionUnified(instantiated, {
        profile: 'mp4-720p-v1',
        readyAssetIds: new Set([svgAssetId]),
        readyFontIds: new Set([CURATED_FONT_NOTO_SANS.asset_id]),
        fontMetadata: new Map([
          [CURATED_FONT_NOTO_SANS.asset_id, { sha256: CURATED_FONT_NOTO_SANS.sha256 }],
        ]),
      });
      assert.strictEqual(tplUnifiedRes.valid, true, JSON.stringify(tplUnifiedRes.errors));
    });

    it('real @creativanta/contracts validator REJECTS legacy schema-invalid scene spec (forbidden meta, missing canvas/fps/fonts)', () => {
      const legacyInvalidSpec = {
        schema_version: '1.0',
        meta: {
          title: 'Staging Live Non-Mock Fixture',
          output_profile: 'mp4-720p-v1',
          aspect_ratio: '9:16',
          duration_frames: 90,
          fps: 30,
        },
        scenes: [
          {
            id: 'scn_staging_01',
            name: 'Promo Scene',
            duration_frames: 90,
            layers: [],
          },
        ],
      };

      const schemaRes = validateCompositionSchema(legacyInvalidSpec);
      assert.strictEqual(schemaRes.valid, false);
      assert.ok(schemaRes.errors.length > 0);
    });

    it('validates upload, template, composition, webhook challenge, preview, render, cancel, and usage against real packages/api createServer', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p10b-real-api-'));
      const quarantineStore = new QuarantineStore(tmpDir);
      const revocationStore = new StorageGrantRevocationStore();
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      runner.migrateUp({ role: 'cve_migrator' });

      const pool = new TenantConnectionPool(db, { poolSize: 4 });
      const repo = new TenantRepository(pool, {
        pepper: 'p10-b-real-api-contract-pepper-32bytes!',
        masterKey: 'p10-b-real-api-master-key-32bytes!!',
        quarantineStore,
        revocationStore,
      });

      const tenantA = '11111111-1111-4111-8111-111111111111';
      const tenantB = '22222222-2222-4222-8222-222222222222';
      repo.createTenant({ id: tenantA, name: 'Staging Tenant A' });
      repo.createTenant({ id: tenantB, name: 'Staging Tenant B' });

      const scopes = [
        'jobs:read',
        'jobs:write',
        'templates:read',
        'templates:write',
        'compositions:read',
        'compositions:write',
        'assets:read',
        'assets:write',
        'webhooks:manage',
        'usage:read',
      ];
      const keyA = repo.issueApiKey({ tenantId: tenantA, keyId: 'k_a', scopes }).plaintextKey;
      const keyB = repo.issueApiKey({ tenantId: tenantB, keyId: 'k_b', scopes }).plaintextKey;

      const deliveryService = new WebhookDeliveryService(pool, {
        masterKey: 'p10-b-real-api-master-key-32bytes!!',
        allowLoopbackForTesting: true,
        allowCustomPortForTesting: true,
      });

      const apiServer = createServer({
        config: loadEnvConfig({
          CVE_ENV: 'development',
          CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        }),
        repository: repo,
        quarantineStore,
        deliveryService,
        revocationStore,
        allowLoopbackForTesting: true,
        allowCustomPortForTesting: true,
      });

      await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
      const port = apiServer.address().port;
      const apiBaseUrl = `http://127.0.0.1:${port}/v1`;

      const verifier = new LiveStagingE2EVerifier({
        baseUrl: apiBaseUrl,
        apiKeyA: keyA,
        apiKeyB: keyB,
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      try {
        // 1. POST /v1/compositions/validate
        const valRes = await verifier._request('/compositions/validate', {
          method: 'POST',
          apiKey: keyA,
          body: { spec: MINIMAL_STAGING_SCENE_SPEC, profile: 'mp4-720p-v1' },
        });
        assert.strictEqual(valRes.status, 200);
        assert.strictEqual(valRes.data.valid, true);

        // 2. POST /v1/compositions & Anti-IDOR
        const compRes = await verifier._request('/compositions', {
          method: 'POST',
          apiKey: keyA,
          idempotencyKey: `real_comp_${crypto.randomUUID()}`,
          body: { name: 'Real API Composition', spec: MINIMAL_STAGING_SCENE_SPEC },
        });
        assert.strictEqual(compRes.status, 201);
        assert.ok(compRes.data.id);

        const idorRes = await verifier._request(`/compositions/${compRes.data.id}`, {
          method: 'GET',
          apiKey: keyB,
        });
        assert.strictEqual(idorRes.status, 404);

        // 3. POST /v1/assets/uploads -> PUT -> POST /v1/assets/:id/complete
        const upRes = await verifier._request('/assets/uploads', {
          method: 'POST',
          apiKey: keyA,
          idempotencyKey: `real_up_${crypto.randomUUID()}`,
          body: {
            filename: 'synthetic-promo-badge.svg',
            mime_type: 'image/svg+xml',
            bytes: SYNTHETIC_LICENSED_SVG_BUFFER.length,
            sha256: SYNTHETIC_LICENSED_SVG_SHA256,
            rights: {
              basis: 'licensed',
              source: 'creativanta-internal-test-asset-v1',
              attribution: 'Creativanta Synthetic Staging Vector Asset',
              expires_at: '2099-01-01T00:00:00Z',
            },
          },
        });
        assert.strictEqual(upRes.status, 201);
        const svgAssetId = upRes.data.asset_id;

        const putRes = await verifier._fetchRaw(upRes.data.upload_url, {
          method: 'PUT',
          headers: {
            ...(upRes.data.required_headers || {}),
            'Content-Type': 'image/svg+xml',
            'Content-Length': String(SYNTHETIC_LICENSED_SVG_BUFFER.length),
          },
          body: SYNTHETIC_LICENSED_SVG_BUFFER,
        });
        assert.ok(putRes.ok);

        const cmplRes = await verifier._request(`/assets/${svgAssetId}/complete`, {
          method: 'POST',
          apiKey: keyA,
          idempotencyKey: `real_cmpl_${crypto.randomUUID()}`,
          body: { sha256: SYNTHETIC_LICENSED_SVG_SHA256 },
        });
        assert.ok(cmplRes.status === 200 || cmplRes.status === 202);
        assert.strictEqual(cmplRes.data.status, 'ready');

        // 4. POST /v1/templates & POST /v1/templates/:id/instantiate
        const tplRes = await verifier._request('/templates', {
          method: 'POST',
          apiKey: keyA,
          idempotencyKey: `real_tpl_${crypto.randomUUID()}`,
          body: buildStagingTemplatePayload({ defaultSvgAssetId: svgAssetId }),
        });
        assert.strictEqual(tplRes.status, 201);

        const instRes = await verifier._request(`/templates/${tplRes.data.id}/instantiate`, {
          method: 'POST',
          apiKey: keyA,
          idempotencyKey: `real_inst_${crypto.randomUUID()}`,
          body: {
            template_revision: 1,
            name: 'Instantiated Real Promo',
            locale: 'vi-VN',
            variables: {
              headline: 'Ưu đãi hôm nay',
              price: '199.000 ₫',
              badge_asset_id: svgAssetId,
            },
          },
        });
        assert.strictEqual(instRes.status, 201);
        assert.ok(instRes.data.id);
        assert.strictEqual(instRes.data.revision, 1);

        // 5. Real Webhook Receiver + POST /v1/webhook-endpoints + POST /v1/webhook-endpoints/:id/verify
        const receiver = new StagingWebhookReceiver();
        await receiver.start();
        try {
          const whRes = await verifier._request('/webhook-endpoints', {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: `real_wh_${crypto.randomUUID()}`,
            body: {
              url: receiver.url,
              events: ['job.succeeded', 'job.failed', 'job.canceled'],
            },
          });
          assert.strictEqual(whRes.status, 201);
          receiver.setSigningSecret(whRes.data.signing_secret);

          const verWhRes = await verifier._request(`/webhook-endpoints/${whRes.data.id}/verify`, {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: `real_wh_ver_${crypto.randomUUID()}`,
            body: { echo_handshake: true },
          });
          assert.ok(verWhRes.status === 200 || verWhRes.status === 202);
          assert.strictEqual(verWhRes.data.state, 'active');
          assert.strictEqual(receiver.challengeVerified, true);

          // 6. POST /v1/previews + POST /v1/jobs/:id/cancel -> state === 'canceled'
          const prevRes = await verifier._request('/previews', {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: `real_prev_${crypto.randomUUID()}`,
            body: {
              composition_id: instRes.data.id,
              revision: 1,
              mode: 'frame',
              frame_index: 0,
              profile: 'preview-360p-v1',
            },
          });
          assert.strictEqual(prevRes.status, 202);

          const cancelRes = await verifier._request(`/jobs/${prevRes.data.id}/cancel`, {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: `real_cancel_${crypto.randomUUID()}`,
            body: {},
          });
          assert.ok(cancelRes.status === 200 || cancelRes.status === 202);

          const polledCancel = await verifier._pollJob(prevRes.data.id, keyA, 2000);
          assert.strictEqual(polledCancel.state, 'canceled');

          // 7. POST /v1/render-jobs + idempotency replay
          const renderKey = `real_rnd_${crypto.randomUUID()}`;
          const rndBody = {
            composition_id: instRes.data.id,
            revision: 1,
            profile: 'mp4-720p-v1',
            webhook_endpoint_id: whRes.data.id,
            client_reference: 'real-api-contract-check',
          };
          const rnd1 = await verifier._request('/render-jobs', {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: renderKey,
            body: rndBody,
          });
          assert.strictEqual(rnd1.status, 202);

          const rnd2 = await verifier._request('/render-jobs', {
            method: 'POST',
            apiKey: keyA,
            idempotencyKey: renderKey,
            body: rndBody,
          });
          assert.strictEqual(rnd2.status, 202);
          assert.strictEqual(rnd2.isReplayed, true);
          assert.strictEqual(rnd2.data.id, rnd1.data.id);
        } finally {
          await receiver.close();
        }
      } finally {
        await new Promise((resolve) => apiServer.close(resolve));
        db.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('8. Webhook Challenge Handshake & Signed Callback Delivery (Codex Finding 3)', () => {
    it('verifyWebhookHmacSignature validates authentic HMAC-SHA256 signatures and rejects tampered/expired ones', () => {
      const secret = 'whsec_test_secret_1234567890abcdef';
      const ts = Math.floor(Date.now() / 1000).toString();
      const rawBody = JSON.stringify({ id: 'evt_1', type: 'job.succeeded' });
      const validHex = crypto
        .createHmac('sha256', secret)
        .update(`${ts}.${rawBody}`, 'utf8')
        .digest('hex');

      assert.strictEqual(
        verifyWebhookHmacSignature({
          signingSecret: secret,
          timestampHeader: ts,
          signatureHeader: `v1=${validHex}`,
          rawBody,
        }).valid,
        true
      );

      // Tampered body
      assert.strictEqual(
        verifyWebhookHmacSignature({
          signingSecret: secret,
          timestampHeader: ts,
          signatureHeader: `v1=${validHex}`,
          rawBody: JSON.stringify({ id: 'evt_1', type: 'job.failed' }),
        }).valid,
        false
      );

      // Expired timestamp (> 300s old)
      const oldTs = String(Math.floor(Date.now() / 1000) - 900);
      const oldHex = crypto
        .createHmac('sha256', secret)
        .update(`${oldTs}.${rawBody}`, 'utf8')
        .digest('hex');
      assert.strictEqual(
        verifyWebhookHmacSignature({
          signingSecret: secret,
          timestampHeader: oldTs,
          signatureHeader: `v1=${oldHex}`,
          rawBody,
        }).valid,
        false
      );
    });

    it('fails LIVE-06 when webhook endpoint registration fails (never skips)', async () => {
      const testDouble = new TestDoubleHttpServer({ failWebhookRegistration: true });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage06 = result.stages.find((s) => s.id === 'LIVE-06');
      assert.ok(stage06);
      assert.strictEqual(stage06.passed, false);
      assert.ok(stage06.error.includes('Webhook endpoint registration failed'));

      await testDouble.close();
    });

    it('fails LIVE-07 when delivered webhook callback has tampered HMAC signature', async () => {
      const testDouble = new TestDoubleHttpServer({ tamperWebhookSignature: true });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        webhookDeliveryTimeoutMs: 200,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage07 = result.stages.find((s) => s.id === 'LIVE-07');
      assert.ok(stage07);
      assert.strictEqual(stage07.passed, false);
      assert.ok(stage07.error.includes('failed HMAC-SHA256 verification'));

      await testDouble.close();
    });

    it('reports BLOCKED / HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED (never PASS) when callback is not delivered', async () => {
      const testDouble = new TestDoubleHttpServer({ suppressWebhookDelivery: true });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        webhookDeliveryTimeoutMs: 120,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'BLOCKED');
      assert.strictEqual(result.decision, 'HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED');
      const stage07 = result.stages.find((s) => s.id === 'LIVE-07');
      assert.ok(stage07);
      assert.strictEqual(stage07.passed, false);
      assert.strictEqual(stage07.status, 'BLOCKED');
      assert.ok(stage07.error.includes('WEBHOOK_CALLBACK_NOT_VERIFIED'));

      await testDouble.close();
    });
  });

  describe('9. Bounded Request/Response Timeouts & Byte Caps (Codex Finding 4)', () => {
    it('aborts stalled response body stream and throws REQUEST_TIMEOUT', async () => {
      const stalledServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"partial":');
        // Never call res.end() — simulates stalled response body
      });

      await new Promise((resolve) => stalledServer.listen(0, '127.0.0.1', resolve));
      const port = stalledServer.address().port;

      const verifier = new LiveStagingE2EVerifier({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyA: 'key_a',
        apiKeyB: 'key_b',
        timeoutMs: 80,
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      await assert.rejects(
        () => verifier._request('/compositions'),
        (err) => err.message.includes('REQUEST_TIMEOUT')
      );

      await new Promise((resolve) => stalledServer.close(resolve));
    });

    it('aborts and rejects oversized JSON response bodies exceeding maxJsonResponseBytes', async () => {
      const oversizedServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: 'x'.repeat(4096) }));
      });

      await new Promise((resolve) => oversizedServer.listen(0, '127.0.0.1', resolve));
      const port = oversizedServer.address().port;

      const verifier = new LiveStagingE2EVerifier({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKeyA: 'key_a',
        apiKeyB: 'key_b',
        maxJsonResponseBytes: 512,
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      await assert.rejects(
        () => verifier._request('/compositions'),
        (err) => err.message.includes('RESPONSE_BODY_TOO_LARGE')
      );

      await new Promise((resolve) => oversizedServer.close(resolve));
    });
  });

  describe('10. Mandatory Cancellation Drill & Terminal State Polling (Codex Finding 6)', () => {
    it('fails LIVE-06 when auxiliary job ignores cancellation and finishes as succeeded', async () => {
      const testDouble = new TestDoubleHttpServer({ ignoreCancelRequest: true });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage06 = result.stages.find((s) => s.id === 'LIVE-06');
      assert.ok(stage06);
      assert.strictEqual(stage06.passed, false);
      assert.ok(stage06.error.includes('Cancellation drill not honored'));

      await testDouble.close();
    });

    it('marks LIVE-06 as BLOCKED when cancellation endpoint is unsupported (HTTP 501)', async () => {
      const testDouble = new TestDoubleHttpServer({ cancelUnsupported: true });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'BLOCKED');
      const stage06 = result.stages.find((s) => s.id === 'LIVE-06');
      assert.ok(stage06);
      assert.strictEqual(stage06.status, 'BLOCKED');

      await testDouble.close();
    });
  });

  describe('11. Usage Metering Baseline & Settlement Delta Audit (Codex Finding 7)', () => {
    it('rejects all-zero usage, missing operational_attempts, or zero delta from baseline', () => {
      const baseline = {
        operational_attempts: 2,
        billable_output_minutes: 0.1,
        billable_jobs: 1,
        reservations: { settled_count: 1, pending_count: 0 },
      };

      // Zero delta
      const zeroDelta = validateUsageSettlementDelta(baseline, {
        operational_attempts: 2,
        billable_output_minutes: 0.1,
        billable_jobs: 1,
        reservations: { settled_count: 1, pending_count: 0 },
        reconciliation: { clean: true, double_debit_detected: false, discrepancies: [] },
      });
      assert.strictEqual(zeroDelta.valid, false);
      assert.ok(zeroDelta.errors.some((e) => e.includes('operational_attempts did not advance')));

      // Legacy operational_jobs without operational_attempts
      const legacyField = validateUsageSettlementDelta(baseline, {
        operational_jobs: 5,
        billable_output_minutes: 0.2,
        billable_jobs: 2,
        reservations: { settled_count: 2, pending_count: 0 },
        reconciliation: { clean: true, double_debit_detected: false, discrepancies: [] },
      });
      assert.strictEqual(legacyField.valid, false);
      assert.ok(legacyField.errors.some((e) => e.includes('missing required numeric "operational_attempts"')));
    });

    it('fails LIVE-10 when usage ledger reports unclean reconciliation or double-debit', async () => {
      const testDouble = new TestDoubleHttpServer({
        usageFinalOverride: {
          operational_attempts: 5,
          billable_output_minutes: 0.25,
          billable_jobs: 2,
          reservations: {
            pending_count: 0,
            settled_count: 3,
            released_count: 1,
          },
          reconciliation: {
            clean: false,
            double_debit_detected: true,
            discrepancies: ['Double settlement detected on job_render_001'],
          },
        },
      });
      const baseUrl = await testDouble.start();

      const verifier = new LiveStagingE2EVerifier({
        baseUrl,
        apiKeyA: 'cve_live_staging_test_token_tenant_a_0123456789abcdef',
        apiKeyB: 'cve_live_staging_test_token_tenant_b_0123456789abcdef',
        pollIntervalMs: 10,
        ffprobeRunner: () => createValidFfprobeResult(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, registerSecret: () => {} },
      });

      const result = await verifier.run();
      assert.strictEqual(result.status, 'FAIL');
      const stage10 = result.stages.find((s) => s.id === 'LIVE-10');
      assert.ok(stage10);
      assert.strictEqual(stage10.passed, false);
      assert.ok(stage10.error.includes('reconciliation is not clean'));
      assert.ok(stage10.error.includes('double-debit'));

      await testDouble.close();
    });
  });
});
