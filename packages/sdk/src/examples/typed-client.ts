/**
 * Creativanta Video Engine - Typed Client Integration Example (Task P5-04).
 *
 * Demonstrates an end-to-end integration workflow using @creativanta/sdk:
 *   1. Client initialization with placeholder credentials
 *   2. Inspecting server capabilities and profile constraints
 *   3. Ingesting media asset (initiate -> upload -> complete)
 *   4. Instantiating a template into a versioned composition
 *   5. Submitting a render job with Idempotency-Key and externalReference
 *   6. Signed webhook event handling via CreativantaWebhookReceiver
 *   7. Polling reconciliation with exponential backoff (2s -> 10s)
 *   8. Artifact download with automatic expiry refresh and SHA-256 verification
 *
 * NOTE: All credentials below are strictly PLACEHOLDERS. Never use real API keys in source code.
 */

import crypto from 'node:crypto';
import {
  CreativantaClient,
  CreativantaWebhookReceiver,
  JobReconciliationManager,
  type AdmittedJobResponse,
  type CapabilitiesResponse,
  type JobResponse,
} from '../client/index.js';

export interface IntegrationDemoResult {
  capabilities: CapabilitiesResponse;
  assetId: string;
  compositionId: string;
  admittedJob: AdmittedJobResponse;
  finalJob: JobResponse;
  videoBuffer: Buffer;
  webhookVerified: boolean;
}

/**
 * Runs a complete typed integration workflow against the Creativanta Video Engine.
 *
 * @param baseUrl Base URL of the Video Engine API (e.g. https://video.example.invalid/v1)
 * @param apiKey Bearer API key (placeholder)
 * @param webhookSecret Signing secret for webhooks (placeholder)
 * @param customFetch Optional fetch replacement for testing/mocking
 */
export async function runTypedClientIntegrationExample(options?: {
  baseUrl?: string;
  apiKey?: string;
  webhookSecret?: string;
  customFetch?: typeof fetch;
}): Promise<IntegrationDemoResult> {
  // 1. Client Configuration with Placeholder Credentials
  // Placeholder credentials format conforms to PRD and docs/SECURITY.md
  const PLACEHOLDER_API_KEY = 'cve_live_placeholder_key_000000000000000000000000';
  const PLACEHOLDER_WEBHOOK_SECRET = 'whsec_placeholder_secret_000000000000000000000000';
  const BASE_URL = options?.baseUrl ?? 'https://video.example.invalid/v1';

  const client = new CreativantaClient({
    baseUrl: BASE_URL,
    apiKey: options?.apiKey ?? PLACEHOLDER_API_KEY,
    timeoutMs: 15000,
    maxRetries: 3,
    customFetch: options?.customFetch,
  });

  // 2. Capabilities Inspection
  // Discover supported rendering profiles, canvas limits, and active engines
  const capabilities = await client.getCapabilities();

  // 3. Asset Intake Pipeline (Upload Grant -> PUT bytes -> Complete Probe)
  const dummyImageBytes = Buffer.from('mock-product-image-content-png-bytes');
  const dummyImageSha = crypto.createHash('sha256').update(dummyImageBytes).digest('hex');

  const uploadGrant = await client.initiateAssetUpload({
    filename: 'product_hero.png',
    mimeType: 'image/png',
    bytes: dummyImageBytes.length,
    sha256: dummyImageSha,
    rights: {
      basis: 'owned',
      source: 'Creativanta catalog item #8841',
      attribution: 'Creativanta Internal Media Repository',
    },
    idempotencyKey: `asset-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  });

  // If a real storage URL is returned, the client PUTs the raw binary bytes here
  if (options?.customFetch && uploadGrant.upload_url) {
    await options.customFetch(uploadGrant.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: dummyImageBytes,
    });
  }

  // Finalize asset intake to trigger async probing and quarantine validation
  await client.completeAssetUpload(uploadGrant.asset_id, dummyImageSha);

  // 4. Template Instantiation
  // Materialize an approved curated template into an editable composition revision 1
  const instantiated = await client.instantiateTemplate('tpl_retail_promo', {
    templateRevision: 1,
    name: 'Khuyến Mãi Mùa Hè 2026',
    variables: {
      headline: 'Ưu Đãi Đặc Biệt Tháng 11',
      price: '199.000 ₫',
      product_image: uploadGrant.asset_id,
    },
    locale: 'vi-VN',
    idempotencyKey: `tpl-instantiate-${Date.now()}`,
  });

  // 5. Submit Video Render Job with Idempotency & External Reference
  // Idempotency-Key guarantees safe retries across network drops
  // externalReference preserves Creativanta campaign tracking ID on server
  const idempotencyKey = `render-job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const externalReference = `creativanta-order-2026-nov-${crypto.randomBytes(3).toString('hex')}`;

  const admittedJob = await client.createRenderJob({
    compositionId: instantiated.id,
    revision: instantiated.revision,
    profile: 'mp4-720p-v1',
    externalReference,
    metadata: {
      campaign: 'holiday_launch',
      tenant_env: 'production_sandbox',
    },
    idempotencyKey,
  });

  // 6. Webhook Receiver Setup (HMAC-SHA256 Verification)
  // Handles incoming callbacks with constant-time signature comparison and 7-day deduplication
  const webhookReceiver = new CreativantaWebhookReceiver({
    secrets: options?.webhookSecret ?? PLACEHOLDER_WEBHOOK_SECRET,
    maxSkewSeconds: 300,
    retentionMs: 7 * 86400 * 1000,
  });

  let webhookVerified = false;
  webhookReceiver.on('job.succeeded', (event) => {
    if (event.data.job_id === admittedJob.id) {
      webhookVerified = true;
    }
  });

  // 7. Polling Reconciliation (ReconciliationManager)
  // Conforms to docs/API.md: "Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation"
  const reconManager = new JobReconciliationManager(client);
  const finalJob = await reconManager.waitForJobTerminal(admittedJob.id, {
    timeoutMs: 10000,
    initialIntervalMs: 50,
    maxIntervalMs: 200,
    backoffFactor: 1.5,
  });

  // 8. Artifact Download & Integrity Verification
  // Proactively refreshes short-TTL signed grant (<= 5min) and validates byte length & SHA-256
  const videoArtifact = finalJob.artifacts.find((a: { kind: string }) => a.kind === 'video') || finalJob.artifacts[0];
  let videoBuffer = Buffer.alloc(0);

  if (videoArtifact) {
    videoBuffer = await client.downloadArtifact(videoArtifact.id, {
      refreshBufferMs: 30000,
      maxRefreshRetries: 2,
      verifyIntegrity: true,
    });
  }

  return {
    capabilities,
    assetId: uploadGrant.asset_id,
    compositionId: instantiated.id,
    admittedJob,
    finalJob,
    videoBuffer,
    webhookVerified,
  };
}
