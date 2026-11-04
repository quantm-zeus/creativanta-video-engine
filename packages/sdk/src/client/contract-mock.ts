/**
 * Creativanta Contract Mock Server (Task P5-03).
 *
 * Lightweight, zero-database contract simulator for Creativanta integration testing:
 *   - Implements REST API v1 contracts for render-jobs, previews, jobs status, cancellation,
 *     artifact download grants, download-expiry simulation, and signed webhooks.
 *   - Strictly enforces idempotency rules, conflict detection, replay headers, and terminal cancel states.
 *   - Simulates download expiry (410 GRANT_EXPIRED) to verify client download-expiry refresh.
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
}

export interface MockJobRecord {
  id: string;
  kind: 'render' | 'preview';
  state: 'queued' | 'preparing' | 'rendering' | 'succeeded' | 'failed' | 'canceled' | 'cancel_requested';
  state_version: number;
  composition_id: string;
  revision: number;
  profile: string;
  client_reference?: string;
  metadata?: Record<string, string>;
  artifacts: Array<{ id: string; kind: string; mime_type: string; sha256: string; bytes: number; content: Buffer }>;
  usage: { output_seconds: number; cpu_seconds: number; billable_output_minutes: number };
  error?: { code: string; message: string; retryable: boolean } | null;
  created_at: string;
  completed_at?: string | null;
}

export class CreativantaContractMock {
  public readonly apiKey: string;
  public readonly webhookSecret: string;
  public grantTtlSeconds: number;

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

  // Injected behaviors for testing
  public simulateIdempotencyInProgressCount = 0;
  public simulateRateLimitedCount = 0;
  public simulateServiceUnavailableCount = 0;

  constructor(options?: MockServerOptions) {
    this.apiKey = options?.apiKey ?? 'test-creativanta-api-key-p503';
    this.webhookSecret = options?.webhookSecret ?? 'test-signing-secret-32-bytes-p503!';
    this.grantTtlSeconds = options?.defaultGrantTtlSeconds ?? 300; // 5 min default
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

      if (Date.now() > grant.expiresAtMs) {
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
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${this.apiKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Invalid or missing API key' } }));
      return;
    }

    // 3. Simulated transient faults (idempotency-in-progress, 429, 503)
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

    // 4. POST /v1/render-jobs
    if (pathname === '/v1/render-jobs' && method === 'POST') {
      await this.handleCreateJob(req, res, 'render');
      return;
    }

    // 5. POST /v1/previews
    if (pathname === '/v1/previews' && method === 'POST') {
      await this.handleCreateJob(req, res, 'preview');
      return;
    }

    // 6. POST /v1/jobs/{id}/cancel
    const cancelMatch = /^\/v1\/jobs\/([^/]+)\/cancel$/.exec(pathname);
    if (cancelMatch && method === 'POST') {
      const jobId = cancelMatch[1]!;
      await this.handleCancelJob(req, res, jobId);
      return;
    }

    // 7. GET /v1/jobs/{id}
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

    // 8. GET /v1/artifacts/{id}/download
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
      created_at: new Date().toISOString(),
    };

    this.seedJob(newJob);

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

    // 2. Terminal state checks per docs/API.md line 11:
    // "khi job đang cancel_requested trả 202 Accepted, khi job đã canceled trả 200 OK (state confirmation),
    //  còn khi job đã succeeded hoặc failed trả 409 JOB_TERMINAL."
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

    // Job was queued, preparing, rendering -> transition to canceled (or cancel_requested)
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
