/**
 * Task P5-03: Creativanta Client - Real API Server E2E Contract Harness.
 *
 * Verifies the full client integration against the real Video Engine REST API server:
 *   - Zero shared DB assumptions: Creativanta client operates strictly over HTTP fetch
 *   - Signed webhook endpoint verification handshake (endpoint.challenge)
 *   - Asset ingestion & template instantiation via client HTTP endpoints
 *   - Full render job submission with external_reference and Idempotency-Key
 *   - Signed webhook delivery & reception by CreativantaWebhookReceiver
 *   - Polling reconciliation of authoritative state
 *   - Artifact download and download-expiry refresh verification
 *   - Job cancellation workflow
 *   - Static audit check verifying no database imports exist in packages/sdk/src/client
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  JobDispatcher,
  MigrationRunner,
  QuarantineStore,
  RealRendererWorker,
  StorageGrantRevocationStore,
  TenantConnectionPool,
  TenantRepository,
  WebhookDeliveryService,
  WebhookDeduplicator,
  createServer,
} from '../../api/dist/index.js';

import {
  CreativantaClient,
  CreativantaWebhookReceiver,
  JobReconciliationManager,
  generateIdempotencyKey,
} from '../dist/index.js';

const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const TEST_PEPPER = 'p5-03-contract-test-pepper-secret-32b!!';
const TEST_MASTER_KEY = 'p5-03-contract-test-master-key-32b!!';

function buildValidPng(width = 80, height = 80) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  ihdr.writeUInt8(0, 18);
  ihdr.writeUInt8(0, 19);
  ihdr.writeUInt8(0, 20);
  ihdr.writeUInt32BE(0x12345678, 21);

  const idat = Buffer.from([
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
  ]);
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([header, ihdr, idat, iend]);
}

describe('Task P5-03: Real API Server E2E Contract Harness (No Shared DB Assumptions)', () => {
  let quarantineDir;
  let quarantineStore;
  let revocationStore;
  let db;
  let pool;
  let repo;
  let dispatcher;
  let deliveryService;
  let apiServer;
  let apiBaseUrl;

  let receiverServer;
  let receiverUrl;
  let webhookReceiver;
  let webhookSigningSecret;
  let webhookEndpointId;

  let creativantaClient;
  let apiKeyRecord;
  let seededAssetId;
  let seededTemplateId;
  let compositionId;

  before(async () => {
    // 1. Setup isolated in-memory DB and server infrastructure
    quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creativanta-p503-quarantine-'));
    quarantineStore = new QuarantineStore(quarantineDir);
    revocationStore = new StorageGrantRevocationStore();

    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 4 });
    repo = new TenantRepository(pool, {
      pepper: TEST_PEPPER,
      masterKey: TEST_MASTER_KEY,
      quarantineStore,
      revocationStore,
    });

    repo.createTenant({ id: TENANT_ID, name: 'Creativanta SaaS Tenant', now: new Date() });

    // Seed baseline font
    repo.createAsset(TENANT_ID, {
      id: 'ast_font_noto',
      filename: 'NotoSans-Regular.ttf',
      kind: 'font',
      status: 'ready',
      mimeType: 'font/ttf',
      bytes: 2048,
      sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
      rights: { basis: 'licensed', source: 'Google Fonts', attribution: 'Google Fonts' },
    });

    apiKeyRecord = repo.issueApiKey({
      tenantId: TENANT_ID,
      keyId: 'key_creativanta_p503',
      scopes: [
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
      ],
      now: new Date(),
    });

    dispatcher = new JobDispatcher({
      repository: repo,
      quarantineStore,
      maxGlobalSlots: 2,
    });

    deliveryService = new WebhookDeliveryService(pool, {
      masterKey: TEST_MASTER_KEY,
      allowLoopbackForTesting: true,
      allowCustomPortForTesting: true,
      jitterRatio: 0,
    });

    const envConfig = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });

    apiServer = createServer({
      config: envConfig,
      repository: repo,
      quarantineStore,
      deliveryService,
      revocationStore,
      allowLoopbackForTesting: true,
      allowCustomPortForTesting: true,
    });

    await new Promise((resolve) => {
      apiServer.listen(0, '127.0.0.1', () => {
        const port = apiServer.address().port;
        apiBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 2. Setup Creativanta Webhook Receiver HTTP listener
    // Note: secret will be provided upon webhook-endpoint creation
    webhookReceiver = new CreativantaWebhookReceiver({
      secrets: 'temporary-placeholder-secret-to-be-updated',
    });

    receiverServer = http.createServer((req, res) => {
      webhookReceiver.handleHttpRequest(req, res);
    });

    await new Promise((resolve) => {
      receiverServer.listen(0, '127.0.0.1', () => {
        const port = receiverServer.address().port;
        receiverUrl = `http://127.0.0.1:${port}/creativanta-webhook`;
        resolve();
      });
    });

    // 3. Initialize pure HTTP CreativantaClient (Zero DB connections)
    creativantaClient = new CreativantaClient({
      baseUrl: apiBaseUrl,
      apiKey: apiKeyRecord.plaintextKey,
    });
  });

  after(async () => {
    try {
      if (apiServer) await new Promise((r) => apiServer.close(r));
      if (receiverServer) await new Promise((r) => receiverServer.close(r));
      if (db) db.close();
      if (quarantineDir) fs.rmSync(quarantineDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('5.1 Static Code Audit: Verifies zero database / internal engine imports in SDK client', () => {
    const clientDir = path.resolve('packages/sdk/src/client');
    const files = fs.readdirSync(clientDir).filter((f) => f.endsWith('.ts'));

    const forbiddenPatterns = [
      'node:sqlite',
      'DatabaseSync',
      'TenantRepository',
      'TenantConnectionPool',
      'MigrationRunner',
      'QuarantineStore',
      'RealRendererWorker',
      '@creativanta/api',
      'pg',
      'knex',
    ];

    for (const f of files) {
      const content = fs.readFileSync(path.join(clientDir, f), 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.equal(
          content.includes(pattern),
          false,
          `File packages/sdk/src/client/${f} must NOT import '${pattern}' (Strict no-shared-DB rule)`,
        );
      }
    }
  });

  it('5.2 Registers webhook endpoint & completes signed challenge handshake via CreativantaWebhookReceiver', async () => {
    // 1. Creativanta registers webhook endpoint via API
    const regRes = await fetch(`${apiBaseUrl}/v1/webhook-endpoints`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyRecord.plaintextKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': generateIdempotencyKey('wh_reg'),
      },
      body: JSON.stringify({
        url: receiverUrl,
        events: ['job.succeeded', 'job.failed', 'job.canceled'],
      }),
    });

    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();
    assert.ok(regBody.id);
    assert.ok(regBody.signing_secret);
    assert.equal(regBody.state, 'pending_verification');

    webhookEndpointId = regBody.id;
    webhookSigningSecret = regBody.signing_secret;

    // 2. Configure CreativantaWebhookReceiver with the returned signing secret
    webhookReceiver.updateSecrets([
      { keyId: 'whk_1', secret: webhookSigningSecret },
    ]);

    // 3. Trigger verification challenge
    const verifyInitRes = await fetch(`${apiBaseUrl}/v1/webhook-endpoints/${webhookEndpointId}/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyRecord.plaintextKey}`,
        'Idempotency-Key': generateIdempotencyKey('wh_ver'),
      },
    });
    assert.equal(verifyInitRes.status, 202);

    // 4. Server delivers challenge to receiverUrl; receiver echoes challenge automatically
    deliveryService.processOutbox(TENANT_ID);
    await deliveryService.deliverPending({ tenantId: TENANT_ID });

    // 5. Verify endpoint is now active on server
    const getEpRes = await fetch(`${apiBaseUrl}/v1/webhook-endpoints/${webhookEndpointId}`, {
      headers: { Authorization: `Bearer ${apiKeyRecord.plaintextKey}` },
    });
    assert.equal(getEpRes.status, 200);
    const epData = await getEpRes.json();
    assert.equal(epData.state, 'active');
  });

  it('5.3 Client uploads media asset via pure HTTP (initiate -> PUT -> complete)', async () => {
    const pngBuffer = buildValidPng(100, 100);
    const pngSha = crypto.createHash('sha256').update(pngBuffer).digest('hex');

    const uploadGrant = await creativantaClient.initiateAssetUpload({
      filename: 'hero-banner.png',
      mimeType: 'image/png',
      bytes: pngBuffer.length,
      sha256: pngSha,
      rights: {
        basis: 'owned',
        source: 'Creativanta Studio Kit',
        attribution: 'Creativanta Team',
      },
      idempotencyKey: generateIdempotencyKey('asset_upload'),
    });

    assert.ok(uploadGrant.asset_id);
    assert.ok(uploadGrant.upload_url);
    seededAssetId = uploadGrant.asset_id;

    // PUT raw bytes to upload_url
    const putRes = await fetch(uploadGrant.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/png',
        'Content-Length': String(pngBuffer.length),
      },
      body: pngBuffer,
    });
    assert.equal(putRes.status, 200);

    // Complete upload
    const completeRes = await creativantaClient.completeAssetUpload(
      seededAssetId,
      pngSha,
      generateIdempotencyKey('asset_complete'),
    );
    assert.equal(completeRes.status, 'ready');
  });

  it('5.4 Client creates template and instantiates composition revision 1', async () => {
    const templateSpec = {
      schema_version: '1.0',
      canvas: { width: 1280, height: 720, background: '#111827' },
      fps: { num: 30, den: 1 },
      duration_frames: 6,
      locale: 'vi-VN',
      direction: 'ltr',
      seed: 101,
      fonts: [
        {
          id: 'font_noto',
          asset_id: 'ast_font_noto',
          sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
          family: 'Noto Sans',
          weight: 400,
          style: 'normal',
        },
      ],
      scenes: [
        {
          id: 'scene_main',
          revision: 1,
          engine: 'html-v1',
          start_frame: 0,
          duration_frames: 6,
          background: '#0B0F19',
          layers: [
            {
              id: 'layer_bg_card',
              type: 'shape',
              z_index: 1,
              start_frame: 0,
              duration_frames: 6,
              box: { x: 80, y: 60, width: 1120, height: 600 },
              opacity: 1,
              content: { shape: 'rect', fill: '#1E293B' },
            },
            {
              id: 'layer_headline',
              type: 'text',
              z_index: 2,
              start_frame: 0,
              duration_frames: 6,
              box: { x: 120, y: 160, width: 1040, height: 160 },
              opacity: 1,
              content: {
                text: { variable: 'headline' },
                font_id: 'font_noto',
                font_size: 44,
                color: '#FFFFFF',
                align: 'center',
                max_lines: 2,
                overflow: 'ellipsis',
              },
            },
          ],
        },
      ],
      audio_tracks: [],
      subtitles: [],
    };

    // POST /v1/templates
    const tplRes = await fetch(`${apiBaseUrl}/v1/templates`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKeyRecord.plaintextKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': generateIdempotencyKey('tpl_create'),
      },
      body: JSON.stringify({
        name: 'E2E Promo Template',
        composition_spec: templateSpec,
        variables_schema: {
          type: 'object',
          properties: { headline: { type: 'string', minLength: 1 } },
          required: ['headline'],
        },
        defaults: { headline: 'Default Headline' },
        supported_locales: ['vi-VN'],
      }),
    });
    assert.equal(tplRes.status, 201);
    const tplJson = await tplRes.json();
    seededTemplateId = tplJson.id;

    // Instantiate composition
    const comp = await creativantaClient.instantiateTemplate(seededTemplateId, {
      templateRevision: 1,
      name: 'Black Friday Campaign Video',
      variables: { headline: 'Ưu đãi tháng 11 - Giảm 50%' },
      idempotencyKey: generateIdempotencyKey('cmp_instantiate'),
    });

    assert.ok(comp.id);
    assert.equal(comp.revision, 1);
    compositionId = comp.id;
  });

  it('5.5 Full E2E Flow: Job Admission -> Worker Execution -> Signed Webhook -> Reconcile -> Download', async () => {
    const externalRef = 'order_creativanta_campaign_998811';
    let receivedWebhookPayload = null;

    webhookReceiver.once('job.succeeded', (evt) => {
      receivedWebhookPayload = evt;
    });

    // 1. Submit Render Job with externalReference & Idempotency-Key
    const admitted = await creativantaClient.createRenderJob({
      compositionId,
      revision: 1,
      profile: 'mp4-720p-v1',
      webhookEndpointId,
      externalReference: externalRef,
      idempotencyKey: generateIdempotencyKey('render_e2e_submit'),
    });

    assert.ok(admitted.id);
    assert.equal(admitted.kind, 'render');
    assert.equal(admitted.state, 'queued');

    // 2. Worker claims and executes job to completion
    const worker = new RealRendererWorker({
      workerId: 'worker_p503_contract_e2e',
      dispatcher,
    });
    const workRes = await worker.claimAndProcessNextJob();
    assert.equal(workRes.status, 'succeeded');
    assert.equal(workRes.jobId, admitted.id);

    // 3. Webhook delivery service delivers signed callback
    deliveryService.processOutbox(TENANT_ID);
    const deliverRes = await deliveryService.deliverPending({ tenantId: TENANT_ID });
    assert.ok(deliverRes.some((d) => d.status === 'delivered'));

    // 4. Verify signed callback arrived at CreativantaWebhookReceiver
    assert.ok(receivedWebhookPayload);
    assert.equal(receivedWebhookPayload.type, 'job.succeeded');
    assert.equal(receivedWebhookPayload.data.job_id, admitted.id);
    assert.equal(receivedWebhookPayload.data.client_reference, externalRef);

    // 5. Polling reconciliation verifies matching authoritative status
    const reconciledJob = await creativantaClient.reconcileJob(admitted.id, {
      initialIntervalMs: 50,
      maxIntervalMs: 100,
    });
    assert.equal(reconciledJob.state, 'succeeded');
    assert.ok(reconciledJob.artifacts.length >= 1);

    // 6. Download artifact and verify integrity
    const videoArtifact = reconciledJob.artifacts.find((a) => a.kind === 'video');
    assert.ok(videoArtifact);

    const videoBytes = await creativantaClient.downloadArtifact(videoArtifact.id);
    assert.ok(videoBytes.length > 0);

    const grant = await creativantaClient.getArtifactDownloadGrant(videoArtifact.id);
    assert.equal(videoBytes.length, grant.bytes);

    const downloadedSha = crypto.createHash('sha256').update(videoBytes).digest('hex');
    assert.equal(downloadedSha, grant.sha256);
  });

  it('5.6 Job Cancellation via Client HTTP API', async () => {
    // Admit another render job
    const admitted = await creativantaClient.createRenderJob({
      compositionId,
      revision: 1,
      profile: 'mp4-720p-v1',
      idempotencyKey: generateIdempotencyKey('cancel_e2e_admit'),
    });

    assert.equal(admitted.state, 'queued');

    // Cancel while queued -> returns 202 and state is canceled
    const cancelResult = await creativantaClient.cancelJob(admitted.id, {
      idempotencyKey: generateIdempotencyKey('cancel_e2e_exec'),
      reason: 'Creativanta user canceled generation',
    });

    assert.equal(cancelResult.id, admitted.id);
    assert.equal(cancelResult.httpStatus, 202);
    assert.equal(cancelResult.state, 'canceled');

    // Reconcile status confirms canceled state
    const jobStatus = await creativantaClient.getJob(admitted.id);
    assert.equal(jobStatus.state, 'canceled');
  });
});
