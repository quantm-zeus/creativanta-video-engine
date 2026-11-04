/**
 * Creativanta Video Engine Client (Task P5-03).
 *
 * Primary TypeScript client for Creativanta integration:
 *   - Zero shared DB assumptions: 100% pure HTTP client via REST API v1
 *   - Idempotency & external_reference handling
 *   - Cancellation semantics (202 / 200 / 409 JOB_TERMINAL)
 *   - Polling reconciliation with exponential backoff (2s -> 10s) and state_version guard
 *   - Download-expiry refresh and download integrity verification
 */

import crypto from 'node:crypto';
import {
  DownloadIntegrityError,
  GrantExpiredError,
  ReconciliationTimeoutError,
} from './errors.js';
import { HttpTransport } from './http-transport.js';
import type {
  AdmittedJobResponse,
  ArtifactDownloadGrant,
  CancelJobOptions,
  CancelJobResult,
  CreatePreviewJobOptions,
  CreateRenderJobOptions,
  CreativantaClientConfig,
  DownloadArtifactOptions,
  JobResponse,
  PollReconcileOptions,
} from './types.js';

export class CreativantaClient {
  private readonly transport: HttpTransport;
  private readonly defaultWebhookEndpointId?: string;
  private readonly clock: () => Date;
  private readonly customFetch: typeof fetch;

  constructor(config: CreativantaClientConfig) {
    this.transport = new HttpTransport(config);
    this.defaultWebhookEndpointId = config.defaultWebhookEndpointId;
    this.clock = config.clock ?? (() => new Date());
    this.customFetch = config.customFetch ?? globalThis.fetch;
  }

  // =========================================================================
  // Job Creation & Submission (Idempotency & External Reference)
  // =========================================================================

  /**
   * Submits a full video render job (`POST /v1/render-jobs`).
   * Normalizes `externalReference` (Creativanta tracking ID) to `client_reference` on the wire.
   */
  public async createRenderJob(options: CreateRenderJobOptions): Promise<AdmittedJobResponse> {
    const clientRef = options.clientReference || options.externalReference;
    const webhookId = options.webhookEndpointId || this.defaultWebhookEndpointId;

    const body: Record<string, unknown> = {
      composition_id: options.compositionId,
      revision: options.revision,
      profile: options.profile ?? 'mp4-720p-v1',
    };

    if (webhookId) {
      body['webhook_endpoint_id'] = webhookId;
    }
    if (clientRef) {
      body['client_reference'] = clientRef;
    }
    if (options.metadata) {
      body['metadata'] = options.metadata;
    }

    const res = await this.transport.request<AdmittedJobResponse>({
      method: 'POST',
      path: '/v1/render-jobs',
      body,
      idempotencyKey: options.idempotencyKey,
    });

    return {
      ...res.data,
      isReplayed: res.isReplayed,
    };
  }

  /**
   * Submits a preview job (`POST /v1/previews`).
   */
  public async createPreviewJob(options: CreatePreviewJobOptions): Promise<AdmittedJobResponse> {
    const clientRef = options.clientReference || options.externalReference;
    const webhookId = options.webhookEndpointId || this.defaultWebhookEndpointId;

    const body: Record<string, unknown> = {
      composition_id: options.compositionId,
      revision: options.revision,
      mode: options.mode,
      profile: options.profile ?? 'preview-360p-v1',
    };

    if (options.mode === 'frame' && options.frameIndex !== undefined) {
      body['frame_index'] = options.frameIndex;
    }
    if (options.mode === 'clip') {
      if (options.startFrame !== undefined) body['start_frame'] = options.startFrame;
      if (options.durationFrames !== undefined) body['duration_frames'] = options.durationFrames;
    }
    if (webhookId) {
      body['webhook_endpoint_id'] = webhookId;
    }
    if (clientRef) {
      body['client_reference'] = clientRef;
    }
    if (options.metadata) {
      body['metadata'] = options.metadata;
    }

    const res = await this.transport.request<AdmittedJobResponse>({
      method: 'POST',
      path: '/v1/previews',
      body,
      idempotencyKey: options.idempotencyKey,
    });

    return {
      ...res.data,
      isReplayed: res.isReplayed,
    };
  }

  // =========================================================================
  // Status, Cancellation & Polling Reconciliation
  // =========================================================================

  /**
   * Retrieves authoritative job status (`GET /v1/jobs/{id}`).
   */
  public async getJob(jobId: string): Promise<JobResponse> {
    const res = await this.transport.request<JobResponse>({
      method: 'GET',
      path: `/v1/jobs/${jobId}`,
    });
    return res.data;
  }

  /**
   * Retrieves ordered job event sequence (`GET /v1/jobs/{id}/events`).
   */
  public async getJobEvents(
    jobId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<{ data: unknown[]; next_cursor: string | null }> {
    const res = await this.transport.request<{ data: unknown[]; next_cursor: string | null }>({
      method: 'GET',
      path: `/v1/jobs/${jobId}/events`,
      query,
    });
    return res.data;
  }

  /**
   * Cancels an in-flight job (`POST /v1/jobs/{id}/cancel`).
   * Handles idempotency and terminal states:
   *   - 202: cancel accepted or already canceling
   *   - 200: already canceled (idempotent confirmation)
   *   - 409: JOB_TERMINAL (throws JobTerminalError if job succeeded or failed)
   */
  public async cancelJob(jobId: string, options?: CancelJobOptions): Promise<CancelJobResult> {
    const body: Record<string, unknown> = {};
    if (options?.reason) {
      body['reason'] = options.reason;
    }

    const res = await this.transport.request<{ id: string; state: 'canceled' | 'cancel_requested' }>({
      method: 'POST',
      path: `/v1/jobs/${jobId}/cancel`,
      body,
      idempotencyKey: options?.idempotencyKey,
    });

    return {
      id: res.data.id || jobId,
      state: res.data.state,
      httpStatus: res.status as 200 | 202,
      isReplayed: res.isReplayed,
    };
  }

  /**
   * Performs polling reconciliation on a job until it reaches a terminal state.
   * Conforms to docs/API.md line 139:
   *   "Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation"
   * Includes state_version tracking to avoid applying stale status out-of-order.
   */
  public async reconcileJob(jobId: string, options?: PollReconcileOptions): Promise<JobResponse> {
    const initialIntervalMs = options?.initialIntervalMs ?? 2000;
    const maxIntervalMs = options?.maxIntervalMs ?? 10000;
    const backoffFactor = options?.backoffFactor ?? 1.5;
    const timeoutMs = options?.timeoutMs ?? 60000;
    const stopOnStates = new Set(options?.stopOnStates ?? ['succeeded', 'failed', 'canceled']);

    let currentIntervalMs = initialIntervalMs;
    let highestKnownVersion = options?.knownStateVersion ?? -1;
    const startTimeMs = Date.now();
    let latestJob: JobResponse | undefined;

    while (true) {
      if (options?.signal?.aborted) {
        throw new Error('Polling reconciliation aborted by caller signal');
      }

      const elapsed = Date.now() - startTimeMs;
      if (elapsed > timeoutMs) {
        throw new ReconciliationTimeoutError(jobId, elapsed, latestJob?.state);
      }

      const job = await this.getJob(jobId);

      // Guard monotonic state_version: only accept updates equal or newer
      if (job.state_version >= highestKnownVersion) {
        highestKnownVersion = job.state_version;
        latestJob = job;
        if (options?.onPoll) {
          options.onPoll(job);
        }
      }

      if (latestJob && stopOnStates.has(latestJob.state)) {
        return latestJob;
      }

      // Wait interval with exponential backoff
      await new Promise((resolve) => setTimeout(resolve, currentIntervalMs));
      currentIntervalMs = Math.min(Math.floor(currentIntervalMs * backoffFactor), maxIntervalMs);
    }
  }

  // =========================================================================
  // Artifact Download & Download-Expiry Refresh
  // =========================================================================

  /**
   * Requests a fresh signed download grant (`GET /v1/artifacts/{id}/download`).
   * URLs expire within <= 5 minutes per docs/API.md line 44.
   */
  public async getArtifactDownloadGrant(artifactId: string): Promise<ArtifactDownloadGrant> {
    const res = await this.transport.request<ArtifactDownloadGrant>({
      method: 'GET',
      path: `/v1/artifacts/${artifactId}/download`,
    });
    return res.data;
  }

  /**
   * Explicitly refreshes an artifact download grant without rerendering the video.
   */
  public async refreshDownloadGrant(artifactId: string): Promise<ArtifactDownloadGrant> {
    return this.getArtifactDownloadGrant(artifactId);
  }

  /**
   * Downloads artifact bytes with automatic download-expiry refresh and integrity verification.
   *   - If current grant is within `refreshBufferMs` (default 30s) of expiring, refreshes grant proactively.
   *   - If download returns HTTP 410 GRANT_EXPIRED, automatically requests a fresh grant and retries.
   *   - Verifies SHA-256 hex and byte length against server grant.
   */
  public async downloadArtifact(
    artifactId: string,
    options?: DownloadArtifactOptions,
  ): Promise<Buffer> {
    const refreshBufferMs = options?.refreshBufferMs ?? 30000;
    const maxRetries = options?.maxRefreshRetries ?? 1;
    const verifyIntegrity = options?.verifyIntegrity ?? true;

    let grant = await this.getArtifactDownloadGrant(artifactId);
    let attempts = 0;

    while (true) {
      attempts += 1;
      const nowMs = this.clock().getTime();
      const expiresAtMs = Date.parse(grant.expires_at);

      // Proactive refresh if grant is expired or near expiry
      if (expiresAtMs - nowMs < refreshBufferMs) {
        grant = await this.refreshDownloadGrant(artifactId);
      }

      const res = await this.customFetch(grant.url, {
        method: 'GET',
        signal: options?.signal,
      });

      // If grant expired in transit (410), refresh and retry
      if (res.status === 410 && attempts <= maxRetries + 1) {
        grant = await this.refreshDownloadGrant(artifactId);
        continue;
      }

      if (!res.ok) {
        if (res.status === 410) {
          throw new GrantExpiredError(`Download grant expired for artifact ${artifactId}`);
        }
        throw new Error(`Failed to download artifact ${artifactId}: HTTP ${res.status} ${res.statusText}`);
      }

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      if (verifyIntegrity) {
        if (grant.bytes !== undefined && buffer.length !== grant.bytes) {
          throw new DownloadIntegrityError(
            `Artifact byte count mismatch: expected ${grant.bytes} bytes, got ${buffer.length} bytes`,
            {
              expectedBytes: grant.bytes,
              actualBytes: buffer.length,
            },
          );
        }

        if (grant.sha256) {
          const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
          const expectedSha256 = grant.sha256.toLowerCase();
          if (actualSha256 !== expectedSha256) {
            throw new DownloadIntegrityError(
              `Artifact SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
              {
                expectedSha256,
                actualSha256,
              },
            );
          }
        }
      }

      return buffer;
    }
  }

  // =========================================================================
  // Asset & Template Helpers (Optional Client Conveniences)
  // =========================================================================

  public async initiateAssetUpload(options: {
    filename: string;
    mimeType: string;
    bytes: number;
    sha256: string;
    rights: {
      basis: 'owned' | 'licensed' | 'public_domain';
      source: string;
      attribution: string;
      expires_at?: string;
    };
    idempotencyKey?: string;
  }): Promise<{ asset_id: string; upload_method: string; upload_url: string; expires_at: string }> {
    const res = await this.transport.request<{
      asset_id: string;
      upload_method: string;
      upload_url: string;
      expires_at: string;
    }>({
      method: 'POST',
      path: '/v1/assets/uploads',
      body: {
        filename: options.filename,
        mime_type: options.mimeType,
        bytes: options.bytes,
        sha256: options.sha256,
        rights: options.rights,
      },
      idempotencyKey: options.idempotencyKey,
    });
    return res.data;
  }

  public async completeAssetUpload(
    assetId: string,
    sha256: string,
    idempotencyKey?: string,
  ): Promise<{ status: string }> {
    const res = await this.transport.request<{ status: string }>({
      method: 'POST',
      path: `/v1/assets/${assetId}/complete`,
      body: { sha256 },
      idempotencyKey,
    });
    return res.data;
  }

  public async getAsset(assetId: string): Promise<Record<string, unknown>> {
    const res = await this.transport.request<Record<string, unknown>>({
      method: 'GET',
      path: `/v1/assets/${assetId}`,
    });
    return res.data;
  }

  public async instantiateTemplate(
    templateId: string,
    options: {
      templateRevision: number;
      name: string;
      variables: Record<string, unknown>;
      locale?: string;
      idempotencyKey?: string;
    },
  ): Promise<{ id: string; revision: number; template: { id: string; revision: number } }> {
    const res = await this.transport.request<{
      id: string;
      revision: number;
      template: { id: string; revision: number };
    }>({
      method: 'POST',
      path: `/v1/templates/${templateId}/instantiate`,
      body: {
        template_revision: options.templateRevision,
        name: options.name,
        variables: options.variables,
        locale: options.locale ?? 'vi-VN',
      },
      idempotencyKey: options.idempotencyKey,
    });
    return res.data;
  }
}
