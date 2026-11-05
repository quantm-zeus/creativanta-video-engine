/**
 * Creativanta Contract Mock Server (Tasks P5-03 & P5-04).
 *
 * Lightweight, zero-database contract simulator for Creativanta integration testing:
 *   - Implements full REST API v1 contracts: capabilities, compositions, templates,
 *     assets, render-jobs, previews, jobs status, cancellation, events,
 *     artifact download grants, download-expiry simulation, webhooks, and usage.
 *   - Strictly enforces idempotency rules, conflict detection, replay headers, and terminal cancel states.
 *   - Simulates transient faults (409 IN_PROGRESS, 429 RATE_LIMITED, 503 SERVICE_UNAVAILABLE)
 *     and download expiry (410 GRANT_EXPIRED) to verify client error & retry resilience.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  computeCanonicalRequestHash,
  isValidIdempotencyKey,
} from './idempotency.js';

export interface MockServerOptions {
  apiKey?: string;
  webhookSecret?: string;
  defaultGrantTtlSeconds?: number;
  autoAdvanceJobsMs?: number;
}

export interface MockJobRecord {
  id: string;
  kind: 'render' | 'preview';
  state: 'queued' | 'preparing' | 'rendering' | 'succeeded' | 'failed' | 'canceled' | 'cancel_requested';
  state_version: number;
  stage?: string;
  progress?: number;
  attempt?: number;
  max_attempts?: number;
  composition_id: string;
  revision: number;
  profile: string;
  client_reference?: string;
  metadata?: Record<string, string>;
  artifacts: Array<{ id: string; kind: string; mime_type: string; sha256: string; bytes: number; content: Buffer }>;
  usage: { output_seconds: number; cpu_seconds: number; billable_output_minutes: number };
  error?: { code: string; message: string; retryable: boolean; details?: unknown[] } | null;
  created_at: string;
  completed_at?: string | null;
}

export class CreativantaContractMock {
  public readonly apiKey: string;
  public readonly webhookSecret: string;
  public grantTtlSeconds: number;
  public autoAdvanceJobsMs?: number;

  private server: http.Server | null = null;
  private baseUrl = '';
  private readonly jobs = new Map<string, MockJobRecord>();
  private readonly idempotencyRecords = new Map<
    string,
    { key: string; method: string; path: string; requestHash: string; status: number; body: string }
  >();
  private readonly artifacts = new Map<
    string,
    { id: string; jobId: string; mimeType: string; bytes: number; sha256: string; content: Buffer }
  >();
  private readonly downloadTokens = new Map<
    string,
    { artifactId: string; expiresAtMs: number; token: string }
  >();

  // In-memory collections for compositions, templates, assets, and webhooks
  private readonly compositions = new Map<string, { id: string; revision: number; name: string; spec: Record<string, unknown> }>();
  private readonly templates = new Map<string, { id: string; revision: number; name: string; schema: Record<string, unknown>; defaults: Record<string, unknown>; spec: Record<string, unknown> }>();
  private readonly assets = new Map<string, { id: string; filename: string; mime_type: string; bytes: number; sha256: string; status: string; rights: unknown }>();
  private readonly webhookEndpoints = new Map<string, { id: string; url: string; events: string[]; status: 'pending' | 'active' | 'disabled'; secret: string; created_at: string }>();

  // Injected behaviors for testing
  public simulateIdempotencyInProgressCount = 0;
  public simulateRateLimitedCount = 0;
  public simulateServiceUnavailableCount = 0;
  public simulateValidationErrorCount = 0;
  public simulateAuthErrorCount = 0;
  public simulateNotFoundErrorCount = 0;

  constructor(options?: MockServerOptions) {
    this.apiKey = options?.apiKey ?? 'test-creativanta-api-key-p503';
    this.webhookSecret = options?.webhookSecret ?? 'test-signing-secret-32-bytes-p503!';
    this.grantTtlSeconds = options?.defaultGrantTtlSeconds ?? 300; // 5 min default
    this.autoAdvanceJobsMs = options?.autoAdvanceJobsMs;
    this.seedDefaultTemplates();
  }

  private seedDefaultTemplates(): void {
    this.templates.set('tpl_retail_promo', {
      id: 'tpl_retail_promo',
      revision: 1,
      name: 'Retail Promo Template',
      schema: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          price: { type: 'string' },
        },
      },
      defaults: {
        headline: 'Khuyến mãi đặc biệt',
        price: '199.000 ₫',
      },
      spec: {
        schema_version: '1.0',
        duration_frames: 450,
      },
    });
  }

  public async start(): Promise<string> {
    if (this.server) return this.baseUrl;

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INTERNAL_MOCK_ERROR', message: String(err) } }));
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        this.baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    return this.baseUrl;
  }

  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      this.baseUrl = '';
    }
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public seedJob(job: MockJobRecord): void {
    this.jobs.set(job.id, job);
    for (const art of job.artifacts) {
      this.artifacts.set(art.id, {
        id: art.id,
        jobId: job.id,
        mimeType: art.mime_type,
        bytes: art.bytes,
        sha256: art.sha256,
        content: art.content,
      });
    }
  }

  public getJobRecord(jobId: string): MockJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  public updateJobState(jobId: string, state: MockJobRecord['state'], error?: MockJobRecord['error']): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.state = state;
    job.state_version += 1;
    if (error !== undefined) job.error = error;
    if (['succeeded', 'failed', 'canceled'].includes(state)) {
      job.completed_at = new Date().toISOString();
      if (state === 'succeeded') {
        job.stage = 'complete';
        job.progress = 1.0;
      }
    }
  }

  /**
   * Helper to dispatch a signed webhook to a receiver URL using this mock's secret.
   */
  public async dispatchSignedWebhook(
    receiverUrl: string,
    event: { id?: string; type: string; data: Record<string, unknown>; stateVersion?: number },
    options?: { keyId?: string; timestamp?: number; secretOverride?: string },
  ): Promise<{ status: number; body: string }> {
    const eventId = event.id ?? `evt_${crypto.randomUUID()}`;
    const timestamp = options?.timestamp ?? Math.floor(Date.now() / 1000);
    const keyId = options?.keyId ?? 'whk_mock_1';
    const secret = options?.secretOverride ?? this.webhookSecret;

    const payload = JSON.stringify({
      id: eventId,
      type: event.type,
      api_version: 'v1',
      created_at: new Date(timestamp * 1000).toISOString(),
      data: event.data,
    });

    const signaturePayload = `${timestamp}.${payload}`;
    const signatureHex = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CVE-Event-Id': eventId,
        'X-CVE-Timestamp': String(timestamp),
        'X-CVE-Key-Id': keyId,
        'X-CVE-Signature': `v1=${signatureHex}`,
      },
      body: payload,
    });

    const bodyText = await res.text();
    return { status: res.status, body: bodyText };
  }

  // =========================================================================
  // Internal HTTP Router
  // =========================================================================

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', this.baseUrl);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    // 1. Raw download endpoint (does not require Bearer token, token is in query/path)
    const rawDlMatch = /^\/v1\/artifacts\/raw\/([^/]+)$/.exec(pathname);
    if (rawDlMatch && method === 'GET') {
      const token = rawDlMatch[1]!;
      const grant = this.downloadTokens.get(token);
      if (!grant) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Download token not found' } }));
        return;
      }

      if (Date.now() >= grant.expiresAtMs) {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'GRANT_EXPIRED', message: 'Artifact download grant expired' } }));
        return;
      }

      const art = this.artifacts.get(grant.artifactId);
      if (!art) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': art.mimeType,
        'Content-Length': String(art.bytes),
        'X-Artifact-Sha256': art.sha256,
      });
      res.end(art.content);
      return;
    }

    // 2. Auth check for API endpoints
    if (this.simulateAuthErrorCount > 0) {
      this.simulateAuthErrorCount -= 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Simulated authentication failure' } }));
      return;
    }

    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${this.apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or missing API key' } }));
      return;
    }

    // 3. Simulated transient faults (idempotency-in-progress, 429, 503, 422, 404)
    if (this.simulateIdempotencyInProgressCount > 0) {
      this.simulateIdempotencyInProgressCount -= 1;
      res.writeHead(409, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_IN_PROGRESS', message: 'Idempotency operation in progress' } }));
      return;
    }

    if (this.simulateRateLimitedCount > 0) {
      this.simulateRateLimitedCount -= 1;
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded, retry later' } }));
      return;
    }

    if (this.simulateServiceUnavailableCount > 0) {
      this.simulateServiceUnavailableCount -= 1;
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Retry-After': '1',
      });
      res.end(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Transient backend unavailable' } }));
      return;
    }

    if (this.simulateValidationErrorCount > 0) {
      this.simulateValidationErrorCount -= 1;
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Simulated validation error',
          details: [{ pointer: '/spec/duration_frames', code: 'OUT_OF_RANGE', message: 'Must be positive' }],
        },
      }));
      return;
    }

    if (this.simulateNotFoundErrorCount > 0) {
      this.simulateNotFoundErrorCount -= 1;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Simulated resource not found' } }));
      return;
    }

    // 4. GET /v1/capabilities
    if (pathname === '/v1/capabilities' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          api_version: 'v1',
          scene_schema_versions: ['1.0'],
          engines: {
            'html-v1': true,
            'canvas-v1': true,
            'svg-v1': true,
            'custom-html-v1': false,
          },
          profiles: [
            {
              id: 'mp4-720p-v1',
              dimensions: { width: 1280, height: 720 },
              fps: { num: 30, den: 1 },
              container: 'mp4',
              codecs: { video: 'h264', audio: 'aac' },
              max_duration_seconds: 600,
              supported: true,
            },
            {
              id: 'preview-360p-v1',
              dimensions: { width: 640, height: 360 },
              fps: { num: 30, den: 1 },
              container: 'mp4',
              codecs: { video: 'h264', audio: 'aac' },
              max_duration_seconds: 120,
              supported: true,
            },
          ],
          limits: {
            max_scenes: 50,
            max_layers_per_scene: 100,
            max_duration_frames: 10800,
            max_body_bytes: 1048576,
            max_upload_bytes: 104857600,
            max_concurrent_jobs: 22,
          },
          features: {
            remote_import_enabled: false,
            custom_code_enabled: false,
            authoring_provider: 'disabled',
            tts_provider: 'disabled',
          },
          policy_version: 'v1',
        }),
      );
      return;
    }

    // 5. POST /v1/compositions/validate
    if (pathname === '/v1/compositions/validate' && method === 'POST') {
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const spec = body.spec as Record<string, unknown> | undefined;

      if (!spec || (spec.duration_frames !== undefined && Number(spec.duration_frames) <= 0)) {
        res.writeHead(422, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message: 'Invalid composition specification',
              details: [{ pointer: '/duration_frames', code: 'OUT_OF_RANGE', message: 'Must be > 0' }],
            },
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          valid: true,
          normalized_spec: spec,
          render_hash: `hash_${crypto.randomBytes(8).toString('hex')}`,
          required_capabilities: ['engine:html-v1'],
          estimate: {
            output_seconds: Number(spec.duration_frames || 450) / 30,
            estimated_cost: 0.05,
            currency: 'USD',
            rate_version: 'v1',
          },
          warnings: [],
        }),
      );
      return;
    }

    // 6. POST /v1/compositions
    if (pathname === '/v1/compositions' && method === 'POST') {
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const compId = `cmp_${crypto.randomBytes(6).toString('hex')}`;
      const record = {
        id: compId,
        revision: 1,
        name: String(body.name || 'Untitled Composition'),
        spec: (body.spec as Record<string, unknown>) || {},
      };
      this.compositions.set(compId, record);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: compId,
          revision: 1,
          name: record.name,
          schema_version: '1.0',
          editable: true,
          spec: record.spec,
          created_at: new Date().toISOString(),
        }),
      );
      return;
    }

    // 7. GET /v1/compositions/{id}
    const compGetMatch = /^\/v1\/compositions\/([^/]+)$/.exec(pathname);
    if (compGetMatch && method === 'GET') {
      const compId = compGetMatch[1]!;
      const comp = this.compositions.get(compId);
      if (!comp) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Composition ${compId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: comp.id,
          revision: comp.revision,
          name: comp.name,
          schema_version: '1.0',
          editable: true,
          spec: comp.spec,
        }),
      );
      return;
    }

    // 8. POST /v1/compositions/{id}/revisions
    const compRevMatch = /^\/v1\/compositions\/([^/]+)\/revisions$/.exec(pathname);
    if (compRevMatch && method === 'POST') {
      const compId = compRevMatch[1]!;
      const comp = this.compositions.get(compId);
      if (!comp) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Composition ${compId} not found` } }));
        return;
      }
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      if (body.base_revision !== comp.revision) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'Stale base_revision' } }));
        return;
      }
      comp.revision += 1;
      if (body.spec) comp.spec = body.spec;

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: comp.id,
          revision: comp.revision,
          name: comp.name,
          schema_version: '1.0',
          editable: true,
          spec: comp.spec,
        }),
      );
      return;
    }

    // 9. GET /v1/templates
    if (pathname === '/v1/templates' && method === 'GET') {
      const list = Array.from(this.templates.values()).map((t) => ({
        id: t.id,
        name: t.name,
        current_revision: t.revision,
        visibility: 'curated' as const,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: list, next_cursor: null }));
      return;
    }

    // 10. GET /v1/templates/{id}/revisions/{revision}
    const tplRevMatch = /^\/v1\/templates\/([^/]+)\/revisions\/([^/]+)$/.exec(pathname);
    if (tplRevMatch && method === 'GET') {
      const tplId = tplRevMatch[1]!;
      const tpl = this.templates.get(tplId);
      if (!tpl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Template ${tplId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: tpl.id,
          revision: tpl.revision,
          name: tpl.name,
          variables_schema: tpl.schema,
          defaults: tpl.defaults,
          composition_spec: tpl.spec,
          supported_locales: ['vi-VN', 'en-US'],
        }),
      );
      return;
    }

    // 11. POST /v1/templates/{id}/instantiate
    const tplInstMatch = /^\/v1\/templates\/([^/]+)\/instantiate$/.exec(pathname);
    if (tplInstMatch && method === 'POST') {
      const tplId = tplInstMatch[1]!;
      const tpl = this.templates.get(tplId);
      if (!tpl) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Template ${tplId} not found` } }));
        return;
      }
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const compId = `cmp_inst_${crypto.randomBytes(5).toString('hex')}`;
      this.compositions.set(compId, {
        id: compId,
        revision: 1,
        name: String(body.name || tpl.name),
        spec: { ...tpl.spec, variables: body.variables },
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: compId,
          revision: 1,
          template: { id: tplId, revision: tpl.revision },
          schema_version: '1.0',
          editable: true,
        }),
      );
      return;
    }

    // 12. POST /v1/assets/uploads
    if (pathname === '/v1/assets/uploads' && method === 'POST') {
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const astId = `ast_${crypto.randomBytes(6).toString('hex')}`;
      this.assets.set(astId, {
        id: astId,
        filename: String(body.filename || 'asset.bin'),
        mime_type: String(body.mime_type || 'application/octet-stream'),
        bytes: Number(body.bytes || 0),
        sha256: String(body.sha256 || ''),
        status: 'uploading',
        rights: body.rights,
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          asset_id: astId,
          upload_method: 'PUT',
          upload_url: `${this.baseUrl}/v1/assets/quarantine-upload/${astId}`,
          expires_at: new Date(Date.now() + 600000).toISOString(),
        }),
      );
      return;
    }

    // 13. POST /v1/assets/{id}/complete
    const astCompMatch = /^\/v1\/assets\/([^/]+)\/complete$/.exec(pathname);
    if (astCompMatch && method === 'POST') {
      const astId = astCompMatch[1]!;
      const ast = this.assets.get(astId);
      if (!ast) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Asset ${astId} not found` } }));
        return;
      }
      ast.status = 'ready';
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ready', asset_id: astId }));
      return;
    }

    // 14. GET /v1/assets/{id}
    const astGetMatch = /^\/v1\/assets\/([^/]+)$/.exec(pathname);
    if (astGetMatch && method === 'GET') {
      const astId = astGetMatch[1]!;
      const ast = this.assets.get(astId);
      if (!ast) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Asset ${astId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ast));
      return;
    }

    // 15. DELETE /v1/assets/{id}
    if (astGetMatch && method === 'DELETE') {
      const astId = astGetMatch[1]!;
      const ast = this.assets.get(astId);
      if (!ast) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Asset ${astId} not found` } }));
        return;
      }
      ast.status = 'deleted';
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: astId, status: 'deleted' }));
      return;
    }

    // 16. POST /v1/render-jobs
    if (pathname === '/v1/render-jobs' && method === 'POST') {
      await this.handleCreateJob(req, res, 'render');
      return;
    }

    // 17. POST /v1/previews
    if (pathname === '/v1/previews' && method === 'POST') {
      await this.handleCreateJob(req, res, 'preview');
      return;
    }

    // 18. POST /v1/jobs/{id}/cancel
    const cancelMatch = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(pathname);
    if (cancelMatch && method === 'POST') {
      const jobId = cancelMatch[1]!;
      await this.handleCancelJob(req, res, jobId);
      return;
    }

    // 19. GET /v1/jobs (list)
    if (pathname === '/v1/jobs' && method === 'GET') {
      const allJobs = Array.from(this.jobs.values());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: allJobs, next_cursor: null }));
      return;
    }

    // 20. GET /v1/jobs/{id}
    const jobGetMatch = /^\/v1\/jobs\/([^/]+)$/.exec(pathname);
    if (jobGetMatch && method === 'GET') {
      const jobId = jobGetMatch[1]!;
      const job = this.jobs.get(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Job ${jobId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(job));
      return;
    }

    // 21. GET /v1/jobs/{id}/events
    const jobEvtMatch = /^\/v1\/jobs\/([^/]+)\/events$/.exec(pathname);
    if (jobEvtMatch && method === 'GET') {
      const jobId = jobEvtMatch[1]!;
      const job = this.jobs.get(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Job ${jobId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            { id: `evt_${jobId}_created`, type: 'job.created', timestamp: job.created_at, state: 'queued' },
            { id: `evt_${jobId}_status`, type: 'job.state_changed', timestamp: job.completed_at || job.created_at, state: job.state },
          ],
          next_cursor: null,
        }),
      );
      return;
    }

    // 22. GET /v1/artifacts/{id}/download
    const artDlMatch = /^\/v1\/artifacts\/([^/]+)\/download$/.exec(pathname);
    if (artDlMatch && method === 'GET') {
      const artId = artDlMatch[1]!;
      const art = this.artifacts.get(artId);
      if (!art) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Artifact ${artId} not found` } }));
        return;
      }

      const token = `tok_${crypto.randomBytes(12).toString('hex')}`;
      const expiresAtMs = Date.now() + this.grantTtlSeconds * 1000;
      this.downloadTokens.set(token, {
        artifactId: artId,
        expiresAtMs,
        token,
      });

      const grantBody = {
        url: `${this.baseUrl}/v1/artifacts/raw/${token}`,
        expires_at: new Date(expiresAtMs).toISOString(),
        sha256: art.sha256,
        bytes: art.bytes,
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(grantBody));
      return;
    }

    // 23. POST /v1/webhook-endpoints
    if (pathname === '/v1/webhook-endpoints' && method === 'POST') {
      const rawBody = await this.readBody(req);
      const body = rawBody ? JSON.parse(rawBody) : {};
      const whId = `wh_${crypto.randomBytes(6).toString('hex')}`;
      const signingSecret = `whsec_${crypto.randomBytes(24).toString('hex')}`;

      this.webhookEndpoints.set(whId, {
        id: whId,
        url: String(body.url || 'https://client.example.invalid/hooks'),
        events: (body.events as string[]) || ['job.succeeded', 'job.failed'],
        status: 'pending',
        secret: signingSecret,
        created_at: new Date().toISOString(),
      });

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: whId,
          url: body.url,
          events: body.events,
          status: 'pending',
          created_at: new Date().toISOString(),
          signing_secret: signingSecret,
        }),
      );
      return;
    }

    // 24. POST /v1/webhook-endpoints/{id}/verify
    const whVerifyMatch = /^\/v1\/webhook-endpoints\/([^/]+)\/verify$/.exec(pathname);
    if (whVerifyMatch && method === 'POST') {
      const whId = whVerifyMatch[1]!;
      const endpoint = this.webhookEndpoints.get(whId);
      if (!endpoint) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Webhook endpoint ${whId} not found` } }));
        return;
      }
      endpoint.status = 'active';
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ verified: true, status: 'active' }));
      return;
    }

    // 25. GET /v1/webhook-endpoints/{id}
    const whGetMatch = /^\/v1\/webhook-endpoints\/([^/]+)$/.exec(pathname);
    if (whGetMatch && method === 'GET') {
      const whId = whGetMatch[1]!;
      const endpoint = this.webhookEndpoints.get(whId);
      if (!endpoint) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Webhook endpoint ${whId} not found` } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Never return signing_secret in GET!
      res.end(
        JSON.stringify({
          id: endpoint.id,
          url: endpoint.url,
          events: endpoint.events,
          status: endpoint.status,
          created_at: endpoint.created_at,
        }),
      );
      return;
    }

    // 26. POST /v1/webhook-endpoints/{id}/rotate-secret
    const whRotateMatch = /^\/v1\/webhook-endpoints\/([^/]+)\/rotate-secret$/.exec(pathname);
    if (whRotateMatch && method === 'POST') {
      const whId = whRotateMatch[1]!;
      const endpoint = this.webhookEndpoints.get(whId);
      if (!endpoint) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Webhook endpoint ${whId} not found` } }));
        return;
      }
      const newSecret = `whsec_rotated_${crypto.randomBytes(24).toString('hex')}`;
      endpoint.secret = newSecret;

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          endpoint_id: whId,
          key_id: `whk_${crypto.randomBytes(4).toString('hex')}`,
          signing_secret: newSecret,
          previous_key_expires_at: new Date(Date.now() + 86400000).toISOString(),
        }),
      );
      return;
    }

    // 27. DELETE /v1/webhook-endpoints/{id}
    if (whGetMatch && method === 'DELETE') {
      const whId = whGetMatch[1]!;
      this.webhookEndpoints.delete(whId);
      res.writeHead(204);
      res.end();
      return;
    }

    // 28. GET /v1/usage
    if (pathname === '/v1/usage' && method === 'GET') {
      const from = url.searchParams.get('from') || new Date(Date.now() - 86400000).toISOString();
      const to = url.searchParams.get('to') || new Date().toISOString();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          from,
          to,
          operational: {
            total_attempts: 3,
            cpu_seconds: 14.5,
          },
          billable: {
            succeeded_jobs: 2,
            output_seconds: 30,
            billable_output_minutes: 0.5,
          },
        }),
      );
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Endpoint ${method} ${pathname} not found on contract mock` } }));
  }

  private async handleCreateJob(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    kind: 'render' | 'preview',
  ): Promise<void> {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' } }));
      return;
    }

    if (!isValidIdempotencyKey(rawKey)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'Invalid Idempotency-Key format' } }));
      return;
    }

    const rawBody = await this.readBody(req);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'MALFORMED_JSON', message: 'Request body must be valid JSON' } }));
      return;
    }

    const path = kind === 'render' ? '/v1/render-jobs' : '/v1/previews';
    const reqHash = computeCanonicalRequestHash(body);
    const idemKey = `${path}:${rawKey}`;

    // Check Idempotency Record
    const existing = this.idempotencyRecords.get(idemKey);
    if (existing) {
      if (existing.requestHash !== reqHash) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Payload differs from previous request with same Idempotency-Key' } }));
        return;
      }
      res.writeHead(existing.status, {
        'Content-Type': 'application/json',
        'Idempotency-Replayed': 'true',
        Location: `/v1/jobs/${JSON.parse(existing.body).id}`,
        'Retry-After': '2',
      });
      res.end(existing.body);
      return;
    }

    // Create New Job
    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
    const compId = String(body['composition_id'] || 'cmp_default');
    const rev = Number(body['revision'] || 1);
    const profile = String(body['profile'] || (kind === 'render' ? 'mp4-720p-v1' : 'preview-360p-v1'));
    const clientRef = (body['client_reference'] as string) || undefined;
    const metadata = (body['metadata'] as Record<string, string>) || undefined;

    // Seed default mock artifacts
    const dummyVideo = Buffer.from('mock-isobmff-video-content-1280x720-30fps');
    const dummyVideoSha = crypto.createHash('sha256').update(dummyVideo).digest('hex');
    const artVideoId = `art_vid_${crypto.randomBytes(4).toString('hex')}`;

    const newJob: MockJobRecord = {
      id: jobId,
      kind,
      state: 'queued',
      state_version: 1,
      composition_id: compId,
      revision: rev,
      profile,
      client_reference: clientRef,
      metadata,
      artifacts: [
        {
          id: artVideoId,
          kind: 'video',
          mime_type: 'video/mp4',
          sha256: dummyVideoSha,
          bytes: dummyVideo.length,
          content: dummyVideo,
        },
      ],
      usage: { output_seconds: 15, cpu_seconds: 4, billable_output_minutes: 0.25 },
      created_at: newJobTimestamp(),
    };

    function newJobTimestamp(): string {
      return new Date().toISOString();
    }

    this.seedJob(newJob);

    if (this.autoAdvanceJobsMs && this.autoAdvanceJobsMs > 0) {
      setTimeout(() => {
        this.updateJobState(jobId, 'rendering');
        setTimeout(() => {
          this.updateJobState(jobId, 'succeeded');
        }, this.autoAdvanceJobsMs);
      }, this.autoAdvanceJobsMs);
    }

    const responsePayload = {
      id: jobId,
      kind,
      state: 'queued',
      state_version: 1,
      composition_id: compId,
      revision: rev,
      profile,
      created_at: newJob.created_at,
      status_url: `/v1/jobs/${jobId}`,
    };

    const responseBodyStr = JSON.stringify(responsePayload);
    this.idempotencyRecords.set(idemKey, {
      key: rawKey,
      method: 'POST',
      path,
      requestHash: reqHash,
      status: 202,
      body: responseBodyStr,
    });

    res.writeHead(202, {
      'Content-Type': 'application/json',
      Location: `/v1/jobs/${jobId}`,
      'Retry-After': '2',
    });
    res.end(responseBodyStr);
  }

  private async handleCancelJob(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    jobId: string,
  ): Promise<void> {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'Idempotency-Key header is required' } }));
      return;
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Job ${jobId} not found` } }));
      return;
    }

    const rawBody = await this.readBody(req);
    const body = rawBody ? JSON.parse(rawBody) : {};
    const path = `/v1/jobs/${jobId}/cancel`;
    const reqHash = computeCanonicalRequestHash(body);
    const idemKey = `${path}:${rawKey}`;

    // 1. Replay check
    const existing = this.idempotencyRecords.get(idemKey);
    if (existing) {
      if (existing.requestHash !== reqHash) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Differing payload for same key' } }));
        return;
      }
      res.writeHead(existing.status, {
        'Content-Type': 'application/json',
        'Idempotency-Replayed': 'true',
      });
      res.end(existing.body);
      return;
    }

    // 2. Terminal state checks per docs/API.md line 11
    if (job.state === 'succeeded' || job.state === 'failed') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'JOB_TERMINAL', message: 'Job has already reached terminal status' } }));
      return;
    }

    if (job.state === 'canceled') {
      const respObj = { id: jobId, state: 'canceled', state_version: job.state_version };
      const respStr = JSON.stringify(respObj);
      this.idempotencyRecords.set(idemKey, {
        key: rawKey,
        method: 'POST',
        path,
        requestHash: reqHash,
        status: 200,
        body: respStr,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(respStr);
      return;
    }

    // Job was queued, preparing, rendering -> transition to canceled
    job.state = 'canceled';
    job.state_version += 1;
    job.completed_at = new Date().toISOString();

    const respObj = { id: jobId, state: 'canceled', state_version: job.state_version };
    const respStr = JSON.stringify(respObj);
    this.idempotencyRecords.set(idemKey, {
      key: rawKey,
      method: 'POST',
      path,
      requestHash: reqHash,
      status: 202,
      body: respStr,
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(respStr);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (e) => reject(e));
    });
  }
}
