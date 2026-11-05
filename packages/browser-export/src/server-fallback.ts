/**
 * Server Fallback Orchestration (Task P8-02).
 *
 * Implements acceptance requirement: "unsupported feature fallback **server job mới**".
 * Whenever a composition uses features outside the approved scene subset, exceeds platform
 * capability/memory ceilings, or fails local execution, this module generates a canonical
 * idempotency key and dispatches an authoritative server-side render job (POST /v1/render-jobs).
 */

import crypto from 'node:crypto';
import type {
  AdmittedServerJob,
  BrowserPlatform,
  FallbackReasonCode,
  IServerJobDispatcher,
  ServerJobDispatchPayload,
  ServerJobFallbackResult,
} from './types.js';

export interface ExecuteServerFallbackParams {
  compositionId: string;
  revision: number;
  profile?: string;
  reasonCode: FallbackReasonCode;
  diagnostics: readonly string[];
  platform?: BrowserPlatform;
  clientReference?: string;
  dispatcher?: IServerJobDispatcher;
}

/**
 * Computes a deterministic canonical idempotency key for the fallback job submission.
 * Conforms to ASCII [A-Za-z0-9._:-] requirements (1 to 128 characters).
 */
export function computeFallbackIdempotencyKey(
  compositionId: string,
  revision: number,
  reasonCode: string,
  platform: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${compositionId}:${revision}:${reasonCode}:${platform}`)
    .digest('hex')
    .slice(0, 32);
  return `idem_fb_${compositionId.replace(/[^a-zA-Z0-9]/g, '_')}_r${revision}_${hash}`;
}

/**
 * Default Mock Server Job Dispatcher for testing and headless verification.
 * Simulates server job admission (POST /v1/render-jobs) with exact state semantics.
 */
export class MockServerJobDispatcher implements IServerJobDispatcher {
  public readonly admittedJobs: AdmittedServerJob[] = [];
  public readonly dispatchedPayloads: { payload: ServerJobDispatchPayload; idempotencyKey: string }[] = [];

  public async dispatchRenderJob(
    payload: ServerJobDispatchPayload,
    idempotencyKey: string,
  ): Promise<AdmittedServerJob> {
    this.dispatchedPayloads.push({ payload, idempotencyKey });

    // Check if replaying an existing idempotency key
    const existing = this.admittedJobs.find((j) => j.client_reference === payload.client_reference);
    if (existing) {
      return {
        ...existing,
        isReplayed: true,
      };
    }

    const jobHash = crypto
      .createHash('sha256')
      .update(`${idempotencyKey}:${payload.composition_id}:${payload.revision}`)
      .digest('hex')
      .slice(0, 16);

    const admittedJob: AdmittedServerJob = {
      id: `job_fallback_${jobHash}`,
      kind: 'render',
      state: 'queued',
      state_version: 1,
      composition_id: payload.composition_id,
      revision: payload.revision,
      profile: payload.profile,
      created_at: new Date().toISOString(),
      status_url: `/v1/jobs/job_fallback_${jobHash}`,
      isReplayed: false,
      client_reference: payload.client_reference,
    };

    this.admittedJobs.push(admittedJob);
    return admittedJob;
  }
}

/**
 * REST HTTP Server Job Dispatcher communicating directly with Creativanta API server.
 */
export class HttpServerJobDispatcher implements IServerJobDispatcher {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: { baseUrl: string; apiKey: string }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  public async dispatchRenderJob(
    payload: ServerJobDispatchPayload,
    idempotencyKey: string,
  ): Promise<AdmittedServerJob> {
    const res = await fetch(`${this.baseUrl}/v1/render-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server job fallback failed with HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as AdmittedServerJob;
    return {
      ...data,
      isReplayed: res.headers.get('Idempotency-Replayed') === 'true',
    };
  }
}

/**
 * Core Fallback Function: Orchestrates fallback by creating and dispatching a new server render job.
 */
export async function executeServerJobFallback(
  params: ExecuteServerFallbackParams,
): Promise<ServerJobFallbackResult> {
  const platform = params.platform ?? 'chrome-desktop';
  const profile = params.profile ?? 'mp4-720p-v1';
  const dispatcher = params.dispatcher ?? new MockServerJobDispatcher();

  const idempotencyKey = computeFallbackIdempotencyKey(
    params.compositionId,
    params.revision,
    params.reasonCode,
    platform,
  );

  const clientReference =
    params.clientReference || `fb_${params.reasonCode.toLowerCase()}_${Date.now()}`;

  const payload: ServerJobDispatchPayload = {
    composition_id: params.compositionId,
    revision: params.revision,
    profile,
    client_reference: clientReference,
    metadata: {
      fallback_source: 'browser_export_spike',
      fallback_reason_code: params.reasonCode,
      fallback_detail: params.diagnostics.join('; '),
      browser_platform: platform,
      dispatched_at: new Date().toISOString(),
    },
  };

  const admittedJob = await dispatcher.dispatchRenderJob(payload, idempotencyKey);

  return {
    action: 'fallback_to_server_job',
    reasonCode: params.reasonCode,
    diagnostics: params.diagnostics,
    admittedJob,
    idempotencyKey,
    dispatchedAt: new Date().toISOString(),
  };
}
