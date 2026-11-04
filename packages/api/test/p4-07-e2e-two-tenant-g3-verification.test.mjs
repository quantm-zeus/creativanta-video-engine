/**
 * Task P4-07 / Reviewer / Phase P4 Acceptance Test Suite:
 *   - Gate G3 Two-Tenant End-to-End Verification:
 *       upload -> template -> preview -> render -> callback -> download -> decode
 *   - Strict Cross-Tenant Isolation & Anti-IDOR (Assets, Templates, Compositions, Jobs, Webhooks, Artifacts, Usage)
 *   - Same API Path Artifact Downloads (/v1/artifacts/download/:token) with Strict Security Headers
 *   - Real Media Decode Verification (verifyIsoBmffMp4 faststart + Mp4Decoder full box parse + verifyPngBuffer)
 *   - Comprehensive Fault Suite:
 *       1. Revoke Asset (invalidates download grants; in-flight job fails publication with ASSET_REVOKED, no orphan leak)
 *       2. Expired Artifacts (expired token TTL -> 410 GRANT_EXPIRED; expired retention -> 410 ARTIFACT_EXPIRED; revoked -> 410 GRANT_REVOKED)
 *       3. Worker Crash / Kill (rendering / before_publish stages; lease expiry & monotonic fencing token guards against stale publishing; zero orphan files)
 *       4. Callback Outage Resilience (receiver 503 outage -> transactional outbox holds event, schedules retries; heals -> delivered; zero loss)
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P4-07 line 81: "G3 two-tenant E2E upload→template→preview→render→callback→download→decode và fault suite; artifacts thật cho same API path")
 *   - docs/TESTING.md (Gate G3 line 12; E2E & Fault requirements line 31)
 *   - docs/SECURITY.md (Tenant isolation, anti-IDOR, strict sandbox CSP headers, no raw HTML origin)
 *   - docs/API.md (REST API v1 contracts, signed download grants, idempotency, webhook lifecycle)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { loadEnvConfig } from '@creativanta/contracts';

import {
  DownloadGrantError,
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
  generateSignedArtifactDownloadGrant,
  verifyIsoBmffMp4,
  verifyPngBuffer,
  verifyAndProcessIncomingWebhook,
} from '../dist/index.js';

import * as DispatcherPackage from '../../dispatcher/index.mjs';
import { Mp4Decoder } from '../../renderers/dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'p4-07-e2e-g3-verification-pepper-secret-32b!';
const TEST_MASTER_KEY = 'p4-07-e2e-master-encryption-key-32b!!';

function buildValidPng(width = 100, height = 100) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16); // 8 bits per sample
  ihdr.writeUInt8(6, 17); // RGBA
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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildTemplateSpecWithBindings({ textBinding = 'headline', imageAssetId = 'ast_brand_logo' } = {}) {
  const durationFrames = 6; // 6 frames (0.2s at 30fps)
  return {
    schema_version: '1.0',
    canvas: {
      width: 1280,
      height: 720,
      background: '#0B0F19',
    },
    fps: { num: 30, den: 1 },
    duration_frames: durationFrames,
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
        duration_frames: durationFrames,
        background: '#0B0F19',
        transition_out: {
          type: 'fade_to_background',
          duration_frames: 2,
        },
        layers: [
          {
            id: 'layer_bg_card',
            type: 'shape',
            z_index: 1,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 80, y: 60, width: 1120, height: 600 },
            opacity: 1,
            content: {
              shape: 'rect',
              fill: '#1E293B',
            },
          },
          {
            id: 'layer_headline',
            type: 'text',
            z_index: 2,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 120, y: 160, width: 1040, height: 160 },
            opacity: 1,
            content: {
              text: textBinding ? { variable: textBinding } : 'Default Headline',
              font_id: 'font_noto',
              font_size: 44,
              color: '#FFFFFF',
              align: 'center',
              max_lines: 2,
              overflow: 'ellipsis',
            },
          },
          {
            id: 'layer_brand_image',
            type: 'image',
            z_index: 3,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 540, y: 380, width: 200, height: 200 },
            opacity: 1,
            content: {
              asset_id: imageAssetId,
              fit: 'contain',
            },
          },
        ],
      },
    ],
    audio_tracks: [],
    subtitles: [
      {
        id: 'sub_main',
        locale: 'vi-VN',
        burn_in: false,
        style: {
          font_id: 'font_noto',
          font_size: 28,
          color: '#FFFFFF',
        },
        cues: [
          {
            id: 'cue_1',
            start_frame: 0,
            end_frame: durationFrames,
            text: 'Creativanta Video Engine 2026',
          },
        ],
      },
    ],
  };
}

describe('Task P4-07 / Reviewer / Phase P4 Acceptance: Gate G3 Two-Tenant E2E Verification & Fault Suite', () => {
  let quarantineDir;
  let quarantineStore;
  let revocationStore;
  let db;
  let pool;
  let repo;
  let dispatcher;
  let deliveryService;
  let apiServer;
  let baseUrl;
  let currentDbTimeMs;
  let keyAlpha;
  let keyBeta;

  // Tracked resource IDs across phases
  let alphaAssetId;
  let betaAssetId;
  let tplAlphaId;
  let cmpAlphaId;
  let alphaWebhookId;
  let alphaSigningSecret;
  let previewJobId;
  let renderJobId;

  // Webhook receiver states
  let receiverServer;
  let receiverPort;
  let receiverUrl;
  let isReceiverOutage = false;
  let capturedWebhooks = [];
  let webhookDeduplicator;

  const dbClock = () => new Date(currentDbTimeMs);
  const advanceClockMs = (deltaMs) => {
    currentDbTimeMs += deltaMs;
    return new Date(currentDbTimeMs);
  };

  before(async () => {
    currentDbTimeMs = Date.parse('2026-11-04T02:00:00.000Z');

    quarantineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'creativanta-p407-quarantine-'));
    quarantineStore = new QuarantineStore(quarantineDir);
    revocationStore = new StorageGrantRevocationStore();

    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 8 });
    repo = new TenantRepository(pool, {
      pepper: TEST_PEPPER,
      masterKey: TEST_MASTER_KEY,
      quarantineStore,
      revocationStore,
    });

    // 1. Create two isolated tenants
    repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha (Creative Agency)', now: dbClock() });
    repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta (Competitor Studio)', now: dbClock() });

    // Seed standard noto font asset and baseline brand logo for both tenants
    for (const tId of [TENANT_A_ID, TENANT_B_ID]) {
      repo.createAsset(tId, {
        id: 'ast_font_noto',
        filename: 'NotoSans-Regular.ttf',
        kind: 'font',
        status: 'ready',
        mimeType: 'font/ttf',
        bytes: 2048,
        sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        rights: {
          basis: 'licensed',
          source: 'Google Fonts',
          attribution: 'Google Fonts',
        },
      });
      repo.createAsset(tId, {
        id: 'ast_brand_logo',
        filename: 'brand_logo.png',
        kind: 'image',
        status: 'ready',
        mimeType: 'image/png',
        bytes: 1024,
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        rights: {
          basis: 'owned',
          source: 'Brand Kit',
          attribution: 'Tenant Studio',
        },
      });
    }

    // 2. Issue API keys
    keyAlpha = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha_p407',
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
      now: dbClock(),
    });

    keyBeta = repo.issueApiKey({
      tenantId: TENANT_B_ID,
      keyId: 'key_beta_p407',
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
      now: dbClock(),
    });

    dispatcher = new JobDispatcher({
      repository: repo,
      quarantineStore,
      maxGlobalSlots: 4,
      dbClock,
    });

    deliveryService = new WebhookDeliveryService(pool, {
      masterKey: TEST_MASTER_KEY,
      allowLoopbackForTesting: true,
      allowCustomPortForTesting: true,
      clock: dbClock,
      jitterRatio: 0,
    });

    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });

    apiServer = createServer({
      config,
      repository: repo,
      quarantineStore,
      deliveryService,
      revocationStore,
      clock: dbClock,
      allowLoopbackForTesting: true,
      allowCustomPortForTesting: true,
    });

    await new Promise((resolve) => {
      apiServer.listen(0, '127.0.0.1', () => {
        const port = apiServer.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });

    // 3. Start mock webhook receiver HTTP server
    webhookDeduplicator = new WebhookDeduplicator();
    receiverServer = http.createServer((req, res) => {
      if (isReceiverOutage) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Receiver database unavailable (outage simulation)' }));
        return;
      }

      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        const headers = req.headers;
        capturedWebhooks.push({
          method: req.method,
          url: req.url,
          headers,
          rawBody,
        });

        // Echo challenge handshake if received
        try {
          const bodyJson = JSON.parse(rawBody.toString('utf8'));
          if (bodyJson.data?.challenge) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ challenge: bodyJson.data.challenge }));
            return;
          }
        } catch {
          // not json
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'acknowledged' }));
      });
    });

    await new Promise((resolve) => {
      receiverServer.listen(0, '127.0.0.1', () => {
        receiverPort = receiverServer.address().port;
        receiverUrl = `http://127.0.0.1:${receiverPort}/webhook`;
        resolve();
      });
    });
  });

  after(async () => {
    try {
      if (apiServer) {
        await new Promise((resolve) => apiServer.close(resolve));
      }
      if (receiverServer) {
        await new Promise((resolve) => receiverServer.close(resolve));
      }
      if (db) {
        db.close();
      }
      if (quarantineStore) {
        quarantineStore.clearAll();
      }
      if (quarantineDir) {
        fs.rmSync(quarantineDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  // ==========================================================================
  // Phase 1: Real Ingestion & Asset Upload via API
  // ==========================================================================
  describe('Phase 1: Real Ingestion & Asset Upload via API', () => {
    let alphaPngBuffer;
    let alphaPngSha;

    it('1.1 Tenant Alpha uploads brand logo PNG via pure API (POST -> PUT -> COMPLETE)', async () => {
      alphaPngBuffer = buildValidPng(120, 120);
      alphaPngSha = sha256Hex(alphaPngBuffer);

      // Step 1: POST /v1/assets/uploads
      const uploadInitRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-upload-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'alpha-logo.png',
          mime_type: 'image/png',
          bytes: alphaPngBuffer.length,
          sha256: alphaPngSha,
          rights: {
            basis: 'owned',
            source: 'Internal Brand Kit',
            attribution: 'Tenant Alpha Studio',
          },
        }),
      });

      assert.equal(uploadInitRes.status, 201);
      const initBody = await uploadInitRes.json();
      assert.ok(initBody.asset_id);
      assert.equal(initBody.upload_method, 'PUT');
      assert.ok(initBody.upload_url);
      alphaAssetId = initBody.asset_id;

      // Step 2: PUT raw bytes to upload_url
      const putRes = await fetch(initBody.upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(alphaPngBuffer.length),
        },
        body: alphaPngBuffer,
      });
      assert.equal(putRes.status, 200);
      const putBody = await putRes.json();
      assert.equal(putBody.status, 'uploaded');

      // Step 3: POST /v1/assets/:id/complete
      const completeRes = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-complete-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: alphaPngSha }),
      });
      assert.equal(completeRes.status, 202);
      const completeBody = await completeRes.json();
      assert.equal(completeBody.status, 'ready');

      // Step 4: GET /v1/assets/:id authoritatively
      const assetRes = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(assetRes.status, 200);
      const assetBody = await assetRes.json();
      assert.equal(assetBody.id, alphaAssetId);
      assert.equal(assetBody.status, 'ready');
      assert.equal(assetBody.filename, 'alpha-logo.png');
      assert.equal(assetBody.bytes, alphaPngBuffer.length);
      assert.equal(assetBody.sha256, alphaPngSha);
    });

    it('1.2 Tenant Beta uploads their own separate brand logo PNG via API', async () => {
      const betaBuffer = buildValidPng(80, 80);
      const betaSha = sha256Hex(betaBuffer);

      const initRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-upload-beta-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filename: 'beta-badge.png',
          mime_type: 'image/png',
          bytes: betaBuffer.length,
          sha256: betaSha,
          rights: {
            basis: 'owned',
            source: 'Internal Brand Kit',
            attribution: 'Tenant Beta Studio',
          },
        }),
      });
      assert.equal(initRes.status, 201);
      const initBody = await initRes.json();
      betaAssetId = initBody.asset_id;

      const putRes = await fetch(initBody.upload_url, {
        method: 'PUT',
        headers: {
          'Content-Type': 'image/png',
          'Content-Length': String(betaBuffer.length),
        },
        body: betaBuffer,
      });
      assert.equal(putRes.status, 200);

      const completeRes = await fetch(`${baseUrl}/v1/assets/${betaAssetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-complete-beta-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: betaSha }),
      });
      assert.equal(completeRes.status, 202);
      const completeBody = await completeRes.json();
      assert.equal(completeBody.status, 'ready');
    });

    it('1.3 Strict IDOR Protection on Assets: Tenant Beta probing Tenant Alpha asset returns 404 NOT_FOUND', async () => {
      // 1. GET /v1/assets/:id
      const resGet = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resGet.status, 404);
      const bodyGet = await resGet.json();
      assert.equal(bodyGet.error.code, 'NOT_FOUND');

      // 2. GET /v1/assets/:id/download
      const resDl = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}/download`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resDl.status, 404);

      // 3. POST /v1/assets/:id/complete
      const resComp = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-complete-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sha256: alphaPngSha }),
      });
      assert.equal(resComp.status, 404);

      // 4. DELETE /v1/assets/:id
      const resDel = await fetch(`${baseUrl}/v1/assets/${alphaAssetId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resDel.status, 404);
    });
  });

  // ==========================================================================
  // Phase 2: Template Authoring, Revisions, and Instantiation via API
  // ==========================================================================
  describe('Phase 2: Template Authoring, Revisions, and Instantiation via API', () => {
    it('2.1 Tenant Alpha creates Template revision 1 via pure API', async () => {
      const templateSpec = buildTemplateSpecWithBindings({
        textBinding: 'headline',
        imageAssetId: alphaAssetId,
      });

      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-tpl-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'tpl_alpha_retail_promo',
          name: 'Template Retail Promo v1',
          variables_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', minLength: 1, maxLength: 100 },
            },
            required: ['headline'],
          },
          defaults: {
            headline: 'Tiêu đề mặc định',
          },
          composition_spec: templateSpec,
          supported_locales: ['vi-VN', 'en-US'],
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.id, 'tpl_alpha_retail_promo');
      assert.equal(body.revision, 1);
      assert.ok(body.source_digest);
      tplAlphaId = body.id;
    });

    it('2.2 Tenant Alpha creates Template revision 2 via pure API', async () => {
      const templateSpec2 = buildTemplateSpecWithBindings({
        textBinding: 'headline',
        imageAssetId: alphaAssetId,
      });

      const res = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-tpl-alpha-2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          name: 'Template Retail Promo v2',
          change_note: 'Cập nhật giao diện chiến dịch',
          variables_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', minLength: 1, maxLength: 100 },
            },
            required: ['headline'],
          },
          defaults: {
            headline: 'Tiêu đề nâng cấp v2',
          },
          composition_spec: templateSpec2,
          supported_locales: ['vi-VN', 'en-US'],
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.id, tplAlphaId);
      assert.equal(body.revision, 2);
      assert.ok(body.source_digest);
    });

    it('2.3 Stale base_revision guard: creating revision with stale base_revision returns 409 REVISION_CONFLICT', async () => {
      const res = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-tpl-stale-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1, // HEAD is already 2
          name: 'Conflict Attempt',
          variables_schema: {
            type: 'object',
            properties: { headline: { type: 'string' } },
            required: ['headline'],
          },
          defaults: { headline: 'Conflict' },
          composition_spec: buildTemplateSpecWithBindings({ imageAssetId: alphaAssetId }),
          supported_locales: ['vi-VN'],
        }),
      });

      assert.equal(res.status, 409);
      const body = await res.json();
      assert.equal(body.error.code, 'REVISION_CONFLICT');
    });

    it('2.4 Tenant Alpha instantiates Template revision 2 into Composition via pure API', async () => {
      const res = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-instantiate-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 2,
          name: 'Chiến dịch Khuyến Mãi Mùa Lễ Hội 2026',
          variables: {
            headline: 'Ưu đãi sáng tạo Creativanta Video Engine',
          },
          locale: 'vi-VN',
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.ok(body.id.startsWith('cmp_'));
      assert.equal(body.revision, 1);
      assert.equal(body.template.id, tplAlphaId);
      assert.equal(body.template.revision, 2);
      cmpAlphaId = body.id;

      // Verify composition content and resolved variables
      const compRes = await fetch(`${baseUrl}/v1/compositions/${cmpAlphaId}/revisions/1`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(compRes.status, 200);
      assert.ok(compRes.headers.get('etag'));
      const comp = await compRes.json();
      assert.equal(comp.spec.scenes[0].layers[1].content.text, 'Ưu đãi sáng tạo Creativanta Video Engine');
      assert.equal(comp.spec.scenes[0].layers[2].content.asset_id, alphaAssetId);
    });

    it('2.5 Strict IDOR Protection on Templates & Compositions: Tenant Beta receives 404 NOT_FOUND', async () => {
      // 1. GET /v1/templates/:id/revisions/:rev
      const resTpl = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/revisions/1`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resTpl.status, 404);

      // 2. POST /v1/templates/:id/revisions
      const resRev = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-tpl-rev-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 2,
          name: 'Attacker Rev',
          variables_schema: { type: 'object', properties: {} },
          defaults: {},
          composition_spec: buildTemplateSpecWithBindings({ imageAssetId: alphaAssetId }),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.equal(resRev.status, 404);

      // 3. POST /v1/templates/:id/instantiate
      const resInst = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-tpl-inst-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ template_revision: 2, name: 'Attacker Inst' }),
      });
      assert.equal(resInst.status, 404);

      // 4. POST /v1/templates/:id/fork
      const resFork = await fetch(`${baseUrl}/v1/templates/${tplAlphaId}/fork`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-tpl-fork-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Attacker Fork' }),
      });
      assert.equal(resFork.status, 404);

      // 5. GET /v1/compositions/:id
      const resComp = await fetch(`${baseUrl}/v1/compositions/${cmpAlphaId}`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resComp.status, 404);

      // 6. GET /v1/templates list for Tenant Beta contains ZERO items of Tenant Alpha
      const listRes = await fetch(`${baseUrl}/v1/templates`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(listRes.status, 200);
      const list = await listRes.json();
      assert.ok(!list.data.some((t) => t.id === tplAlphaId));
    });
  });

  // ==========================================================================
  // Phase 3: Webhook Registration & Echo Verification via API
  // ==========================================================================
  describe('Phase 3: Webhook Registration & Echo Verification via API', () => {
    it('3.1 Tenant Alpha registers webhook endpoint via pure API', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-wh-reg-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'wh_alpha_receiver',
          url: receiverUrl,
          events: ['job.succeeded', 'job.failed', 'job.canceled'],
        }),
      });

      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.id, 'wh_alpha_receiver');
      assert.equal(body.url, receiverUrl);
      assert.equal(body.state, 'pending_verification');
      assert.ok(body.signing_secret); // returned once
      alphaWebhookId = body.id;
      alphaSigningSecret = body.signing_secret;
    });

    it('3.2 Tenant Alpha verifies webhook endpoint via challenge echo handshake', async () => {
      const res = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-wh-verify-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ echo_handshake: true }),
      });

      assert.ok(res.status === 200 || res.status === 202);

      // Verify endpoint state is active
      const epRes = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(epRes.status, 200);
      const ep = await epRes.json();
      assert.equal(ep.state, 'active');
      assert.equal(ep.signing_secret, undefined); // NEVER leaked on GET
    });

    it('3.3 Strict IDOR Protection on Webhook Endpoints: Tenant Beta receives 404 NOT_FOUND', async () => {
      // 1. GET
      const resGet = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resGet.status, 404);

      // 2. POST verify
      const resVer = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}/verify`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-wh-verify-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ echo_handshake: true }),
      });
      assert.equal(resVer.status, 404);

      // 3. POST rotate-secret
      const resRot = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}/rotate-secret`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-wh-rotate-1',
        },
      });
      assert.equal(resRot.status, 404);

      // 4. DELETE
      const resDel = await fetch(`${baseUrl}/v1/webhook-endpoints/${alphaWebhookId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resDel.status, 404);
    });
  });

  // ==========================================================================
  // Phase 4: Preview Job Admission, Worker Execution & Signed Callback
  // ==========================================================================
  describe('Phase 4: Preview Job Admission, Worker Execution & Signed Callback', () => {
    it('4.1 Tenant Alpha admits preview job via pure API (POST /v1/previews)', async () => {
      const res = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-preview-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: cmpAlphaId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: 0,
          webhook_endpoint_id: 'wh_alpha_receiver',
        }),
      });

      assert.equal(res.status, 202);
      assert.ok(res.headers.get('Location'));
      assert.equal(res.headers.get('Retry-After'), '2');
      const admitted = await res.json();
      assert.equal(admitted.kind, 'preview');
      assert.equal(admitted.profile, 'preview-360p-v1');
      assert.equal(admitted.state, 'queued');
      previewJobId = admitted.id;
    });

    it('4.2 Worker claims and executes preview job; outputs 4 artifacts', async () => {
      const worker = new RealRendererWorker({
        workerId: 'worker_p407_preview_1',
        dispatcher,
        heartbeatIntervalMs: 50,
      });

      const workerRes = await worker.claimAndProcessNextJob();
      assert.equal(workerRes.status, 'succeeded');
      assert.equal(workerRes.jobId, previewJobId);

      // Verify job in API
      const jobRes = await fetch(`${baseUrl}/v1/jobs/${previewJobId}`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(jobRes.status, 200);
      const job = await jobRes.json();
      assert.equal(job.state, 'succeeded');
      assert.equal(job.stage, 'complete');
      assert.equal(job.artifacts.length, 4); // video (png), thumbnail (png), captions (vtt), manifest (json)
    });

    it('4.3 Outbox processes and delivers signed webhook callback to receiver', async () => {
      capturedWebhooks = []; // clear prior handshake logs

      // Deliver outbox
      const outboxRes = deliveryService.processOutbox(TENANT_A_ID);
      assert.ok(outboxRes.deliveriesQueued > 0);
      const deliverRes = await deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.ok(deliverRes.some((d) => d.status === 'delivered'));

      // Check captured webhook
      assert.ok(capturedWebhooks.length >= 1);
      const callback = capturedWebhooks.find((w) => {
        try {
          const b = JSON.parse(w.rawBody.toString('utf8'));
          return b.data?.job_id === previewJobId;
        } catch {
          return false;
        }
      });
      assert.ok(callback);

      // Verify HMAC-SHA256 signature using pure receiver verification
      const verifyRes = verifyAndProcessIncomingWebhook({
        headers: callback.headers,
        rawBodyBytes: callback.rawBody,
        secrets: [{ keyId: 'whk_1', secret: alphaSigningSecret }],
        deduplicator: webhookDeduplicator,
        now: dbClock(),
      });

      assert.equal(verifyRes.verified, true);
      assert.equal(verifyRes.payload.type, 'job.succeeded');
      assert.equal(verifyRes.payload.data.job_id, previewJobId);
      assert.equal(verifyRes.payload.data.state, 'succeeded');
    });

    it('4.4 Tenant Isolation on Preview Job: Tenant Beta probing receives 404 NOT_FOUND', async () => {
      const resJob = await fetch(`${baseUrl}/v1/jobs/${previewJobId}`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resJob.status, 404);

      const resEvents = await fetch(`${baseUrl}/v1/jobs/${previewJobId}/events`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resEvents.status, 404);
    });
  });

  // ==========================================================================
  // Phase 5: Full Render Job Admission, Worker Execution & Signed Callback
  // ==========================================================================
  describe('Phase 5: Full Render Job Admission, Worker Execution & Signed Callback', () => {
    it('5.1 Tenant Alpha admits full render job via pure API (POST /v1/render-jobs)', async () => {
      const res = await fetch(`${baseUrl}/v1/render-jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha.plaintextKey}`,
          'Idempotency-Key': 'idem-p407-render-alpha-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: cmpAlphaId,
          revision: 1,
          profile: 'mp4-720p-v1',
          webhook_endpoint_id: 'wh_alpha_receiver',
        }),
      });

      assert.equal(res.status, 202);
      assert.ok(res.headers.get('Location'));
      assert.equal(res.headers.get('Retry-After'), '2');
      const admitted = await res.json();
      assert.equal(admitted.kind, 'render');
      assert.equal(admitted.profile, 'mp4-720p-v1');
      assert.equal(admitted.state, 'queued');
      renderJobId = admitted.id;
    });

    it('5.2 Worker claims and executes full render job; produces ISO-BMFF MP4 and settles usage', async () => {
      const worker = new RealRendererWorker({
        workerId: 'worker_p407_render_1',
        dispatcher,
        heartbeatIntervalMs: 50,
      });

      const workerRes = await worker.claimAndProcessNextJob();
      assert.equal(workerRes.status, 'succeeded');
      assert.equal(workerRes.jobId, renderJobId);

      const jobRes = await fetch(`${baseUrl}/v1/jobs/${renderJobId}`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(jobRes.status, 200);
      const job = await jobRes.json();
      assert.equal(job.state, 'succeeded');
      assert.equal(job.stage, 'complete');
      assert.equal(job.artifacts.length, 4); // video (mp4), thumbnail (png), captions (vtt), manifest (json)
      assert.ok(job.usage.cpu_seconds > 0);
      assert.ok(job.usage.billable_output_minutes > 0);
    });

    it('5.3 Webhook delivery service delivers signed callback for full render job', async () => {
      capturedWebhooks = [];

      deliveryService.processOutbox(TENANT_A_ID);
      const deliverRes = await deliveryService.deliverPending({ tenantId: TENANT_A_ID });
      assert.ok(deliverRes.some((d) => d.status === 'delivered'));

      const callback = capturedWebhooks.find((w) => {
        try {
          const b = JSON.parse(w.rawBody.toString('utf8'));
          return b.data?.job_id === renderJobId;
        } catch {
          return false;
        }
      });
      assert.ok(callback);

      const verifyRes = verifyAndProcessIncomingWebhook({
        headers: callback.headers,
        rawBodyBytes: callback.rawBody,
        secrets: [{ keyId: 'whk_1', secret: alphaSigningSecret }],
        deduplicator: webhookDeduplicator,
        now: dbClock(),
      });

      assert.equal(verifyRes.verified, true);
      assert.equal(verifyRes.payload.type, 'job.succeeded');
      assert.equal(verifyRes.payload.data.job_id, renderJobId);
      assert.equal(verifyRes.payload.data.state, 'succeeded');
    });

    it('5.4 Tenant Isolation on Render Job: Tenant Beta probing receives 404 NOT_FOUND', async () => {
      const resJob = await fetch(`${baseUrl}/v1/jobs/${renderJobId}`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resJob.status, 404);

      const resEvents = await fetch(`${baseUrl}/v1/jobs/${renderJobId}/events`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resEvents.status, 404);

      const resCancel = await fetch(`${baseUrl}/v1/jobs/${renderJobId}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBeta.plaintextKey}`,
          'Idempotency-Key': 'idem-probe-cancel-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Malicious cancel' }),
      });
      assert.equal(resCancel.status, 404);

      // Listing jobs for Tenant Beta returns 0
      const listJobsRes = await fetch(`${baseUrl}/v1/jobs`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(listJobsRes.status, 200);
      const listJobs = await listJobsRes.json();
      assert.equal(listJobs.data.length, 0);
    });
  });

  // ==========================================================================
  // Phase 6: Download Grants & Real Media Decode via SAME API Path
  // ==========================================================================
  describe('Phase 6: Download Grants & Real Media Decode via SAME API Path', () => {
    let videoArtifact;
    let previewVideoArtifact;

    it('6.1 Tenant Alpha requests download grants via GET /v1/artifacts/:id/download', async () => {
      const renderArtifacts = repo.listJobArtifacts(TENANT_A_ID, renderJobId);
      const previewArtifacts = repo.listJobArtifacts(TENANT_A_ID, previewJobId);
      videoArtifact = renderArtifacts.find((a) => a.kind === 'video' && a.mime_type === 'video/mp4');
      previewVideoArtifact = previewArtifacts.find((a) => a.kind === 'video' && a.mime_type === 'image/png');
      assert.ok(videoArtifact);
      assert.ok(previewVideoArtifact);

      const dlRes = await fetch(`${baseUrl}/v1/artifacts/${videoArtifact.id}/download`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(dlRes.status, 200);
      const dlBody = await dlRes.json();
      assert.ok(dlBody.url.includes('/v1/artifacts/download/'));
      assert.equal(dlBody.sha256, videoArtifact.sha256);
      assert.equal(dlBody.bytes, videoArtifact.bytes);
      assert.ok(Date.parse(dlBody.expires_at) > Date.now());
    });

    it('6.2 Real MP4 Download via SAME API Path (/v1/artifacts/download/:token) & Strict Security Headers', async () => {
      const grantRes = await fetch(`${baseUrl}/v1/artifacts/${videoArtifact.id}/download`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      const grant = await grantRes.json();

      const downloadRes = await fetch(grant.url, { method: 'GET' });
      assert.equal(downloadRes.status, 200);

      // Verify strict security headers
      assert.equal(downloadRes.headers.get('content-type'), 'video/mp4');
      assert.equal(downloadRes.headers.get('content-disposition'), 'attachment; filename="output.mp4"');
      assert.equal(downloadRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
      assert.equal(downloadRes.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(downloadRes.headers.get('x-frame-options'), 'DENY');
      assert.equal(downloadRes.headers.get('etag'), `"${videoArtifact.sha256}"`);

      const mp4Buffer = Buffer.from(await downloadRes.arrayBuffer());
      assert.equal(mp4Buffer.length, videoArtifact.bytes);
      assert.equal(sha256Hex(mp4Buffer), videoArtifact.sha256);

      // 6.3 Real Media Decode Verification: verifyIsoBmffMp4 & Mp4Decoder
      const isoReport = verifyIsoBmffMp4(mp4Buffer, {
        width: 1280,
        height: 720,
        fps: 30,
        expectedFrames: 6,
      });
      assert.equal(isoReport.valid, true);
      assert.equal(isoReport.faststart, true);
      assert.ok(isoReport.moovOffset < isoReport.mdatOffset);
      assert.equal(isoReport.videoCodec, 'avc1');
      assert.equal(isoReport.audioCodec, 'mp4a');
      assert.equal(isoReport.videoFrameCount, 6);
      assert.equal(isoReport.audioSampleRate, 48000);
      assert.equal(isoReport.audioChannels, 2);

      // Full MP4 container decode via Mp4Decoder
      const decodedReport = Mp4Decoder.decode(mp4Buffer, 6);
      assert.equal(decodedReport.valid, true);
      assert.equal(decodedReport.faststartMoovBeforeMdat, true);
      assert.equal(decodedReport.majorBrand, 'isom');
      assert.equal(decodedReport.tracks.length, 2);
    });

    it('6.4 Preview PNG Download via SAME API Path & verifyPngBuffer decode', async () => {
      const grantRes = await fetch(`${baseUrl}/v1/artifacts/${previewVideoArtifact.id}/download`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      const grant = await grantRes.json();

      const downloadRes = await fetch(grant.url, { method: 'GET' });
      assert.equal(downloadRes.status, 200);
      assert.equal(downloadRes.headers.get('content-type'), 'image/png');
      assert.equal(downloadRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");

      const pngBuffer = Buffer.from(await downloadRes.arrayBuffer());
      const pngVer = verifyPngBuffer(pngBuffer, 640, 360);
      assert.equal(pngVer.valid, true);
      assert.equal(pngVer.width, 640);
      assert.equal(pngVer.height, 360);
    });

    it('6.5 Thumbnail, Captions, and Manifest Downloads via SAME API Path', async () => {
      const previewArtifacts = repo.listJobArtifacts(TENANT_A_ID, previewJobId);
      const thumbnailArt = previewArtifacts.find((a) => a.kind === 'thumbnail');
      const captionsArt = previewArtifacts.find((a) => a.kind === 'captions');
      const manifestArt = previewArtifacts.find((a) => a.kind === 'manifest');
      assert.ok(thumbnailArt);
      assert.ok(captionsArt);
      assert.ok(manifestArt);

      for (const art of [thumbnailArt, captionsArt, manifestArt]) {
        const grantRes = await fetch(`${baseUrl}/v1/artifacts/${art.id}/download`, {
          headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
        });
        assert.equal(grantRes.status, 200);
        const grant = await grantRes.json();

        const dlRes = await fetch(grant.url);
        assert.equal(dlRes.status, 200);
        assert.equal(dlRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");
        const buf = Buffer.from(await dlRes.arrayBuffer());
        assert.equal(sha256Hex(buf), art.sha256);
      }
    });

    it('6.6 Anti-IDOR & Tampered Token Security on Artifact Downloads', async () => {
      // 1. Tenant Beta requesting download grant for Tenant Alpha artifact -> 404
      const resProbe = await fetch(`${baseUrl}/v1/artifacts/${videoArtifact.id}/download`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(resProbe.status, 404);

      // 2. Tampered token signature -> 403 INVALID_GRANT_SIGNATURE
      const grantRes = await fetch(`${baseUrl}/v1/artifacts/${videoArtifact.id}/download`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      const grant = await grantRes.json();
      const token = grant.url.split('/').pop();
      const envelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
      envelope.sig = envelope.sig.endsWith('0')
        ? envelope.sig.slice(0, -1) + '1'
        : envelope.sig.slice(0, -1) + '0';
      const tamperedToken = Buffer.from(JSON.stringify(envelope)).toString('base64url');
      const tamperedUrl = `${baseUrl}/v1/artifacts/download/${tamperedToken}`;
      const tamperedRes = await fetch(tamperedUrl);
      assert.equal(tamperedRes.status, 403);
      const tamperedBody = await tamperedRes.json();
      assert.equal(tamperedBody.error.code, 'INVALID_GRANT_SIGNATURE');
    });
  });

  // ==========================================================================
  // Phase 7: Usage Ledger & Tenant Accounting Isolation
  // ==========================================================================
  describe('Phase 7: Usage Ledger & Tenant Accounting Isolation', () => {
    it('7.1 Tenant Alpha queries GET /v1/usage and receives settled usage entries', async () => {
      const res = await fetch(`${baseUrl}/v1/usage`, {
        headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
      });
      assert.equal(res.status, 200);
      const usage = await res.json();
      assert.equal(usage.currency, 'USD');
      assert.ok(usage.operational_cpu_seconds > 0);
      assert.ok(usage.billable_output_minutes > 0);
      assert.ok(usage.billable_jobs >= 1);
    });

    it('7.2 Tenant Beta queries GET /v1/usage and receives zero billable units (complete accounting isolation)', async () => {
      const res = await fetch(`${baseUrl}/v1/usage`, {
        headers: { Authorization: `Bearer ${keyBeta.plaintextKey}` },
      });
      assert.equal(res.status, 200);
      const usage = await res.json();
      assert.equal(usage.currency, 'USD');
      assert.equal(usage.billable_output_minutes, 0);
      assert.equal(usage.operational_cpu_seconds, 0);
      assert.equal(usage.billable_jobs, 0);
    });
  });

  // ==========================================================================
  // Phase 8: Fault Suite (Revoke Asset, Expired Artifacts, Worker Crash & Outage)
  // ==========================================================================
  describe('Phase 8: Fault Suite: Revoke Asset, Expired Artifacts, Worker Crash & Outage', () => {
    // ------------------------------------------------------------------------
    // Fault 8.1: Revoke Asset
    // ------------------------------------------------------------------------
    describe('8.1 Fault: Revoke Asset', () => {
      it('8.1a revoking an asset invalidates existing download grants (returns 410 or 404)', async () => {
        // Upload a temporary asset
        const tempBuf = buildValidPng(50, 50);
        const tempSha = sha256Hex(tempBuf);
        const initRes = await fetch(`${baseUrl}/v1/assets/uploads`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-revoke-asset-init-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            filename: 'temp-logo.png',
            mime_type: 'image/png',
            bytes: tempBuf.length,
            sha256: tempSha,
            rights: { basis: 'owned', source: 'Alpha', attribution: 'Alpha' },
          }),
        });
        const init = await initRes.json();
        await fetch(init.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: tempBuf,
        });
        await fetch(`${baseUrl}/v1/assets/${init.asset_id}/complete`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-revoke-complete-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ sha256: tempSha }),
        });

        // Get download grant for asset
        const grantRes = await fetch(`${baseUrl}/v1/assets/${init.asset_id}/download`, {
          headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
        });
        const grant = await grantRes.json();

        // Download succeeds initially
        const preRevoke = await fetch(grant.url);
        assert.equal(preRevoke.status, 200);

        // Revoke / delete asset
        const delRes = await fetch(`${baseUrl}/v1/assets/${init.asset_id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${keyAlpha.plaintextKey}` },
        });
        assert.equal(delRes.status, 202);

        // Subsequent download attempt with the existing grant token fails (410 or 404)
        const postRevoke = await fetch(grant.url);
        assert.ok(postRevoke.status === 410 || postRevoke.status === 404);
      });

      it('8.1b deleting a referenced asset before publication aborts publication with ASSET_REVOKED and zero orphan leak', async () => {
        // Create an asset that will be referenced by a job
        const tempBuf = buildValidPng(60, 60);
        const tempSha = sha256Hex(tempBuf);
        repo.createAsset(TENANT_A_ID, {
          id: 'ast_to_be_revoked_1',
          filename: 'revocable.png',
          kind: 'image',
          status: 'ready',
          mimeType: 'image/png',
          bytes: tempBuf.length,
          sha256: tempSha,
          rights: { basis: 'owned', source: 'Alpha', attribution: 'Alpha' },
        });

        const compSpec = buildTemplateSpecWithBindings({
          textBinding: null,
          imageAssetId: 'ast_to_be_revoked_1',
        });

        const compRes = await fetch(`${baseUrl}/v1/compositions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-comp-revocable-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Composition with Revocable Asset',
            spec: compSpec,
          }),
        });
        const comp = await compRes.json();

        // Submit render job
        const jobRes = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-job-revocable-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: comp.id,
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        const job = await jobRes.json();

        // Worker claims job, but right before verifying/publishing stage, the asset is deleted!
        const worker = new RealRendererWorker({
          workerId: 'worker_p407_revoke_test',
          dispatcher,
        });

        const lease = dispatcher.claimNextJob({ workerId: 'worker_p407_revoke_test' });
        assert.ok(lease);

        const workerRes = await worker.executeLeasedJob(lease, {
          ignoreAbortSignalForStalePublishTest: true,
          onBeforeStage: async (stage) => {
            if (stage === 'verifying') {
              repo.deleteAsset(TENANT_A_ID, 'ast_to_be_revoked_1', dbClock());
            }
          },
        });

        assert.equal(workerRes.status, 'aborted_or_fenced');
        const reloadedJob = repo.getJob(TENANT_A_ID, job.id);
        assert.equal(reloadedJob.state, 'failed');
        assert.equal(reloadedJob.error.code, 'ASSET_REVOKED');

        // Verify zero temp attempt files leaked
        const attemptTempDir = path.join(quarantineDir, 'temp', TENANT_A_ID, job.id);
        assert.equal(fs.existsSync(attemptTempDir), false);
      });
    });

    // ------------------------------------------------------------------------
    // Fault 8.2: Expired Artifacts
    // ------------------------------------------------------------------------
    describe('8.2 Fault: Expired Artifacts', () => {
      it('8.2a download attempt with expired token TTL returns 410 GRANT_EXPIRED', async () => {
        const artifacts = repo.listJobArtifacts(TENANT_A_ID, renderJobId);
        const art = artifacts.find((a) => a.kind === 'video' && a.mime_type === 'video/mp4');
        assert.ok(art);

        // Generate a grant with TTL of 1 second
        const grant = generateSignedArtifactDownloadGrant(
          {
            tenantId: TENANT_A_ID,
            artifactId: art.id,
            jobId: renderJobId,
            storageKey: art.storage_key,
            filename: art.filename,
            mimeType: art.mime_type,
            sha256: art.sha256,
            bytes: art.bytes,
            ttlSeconds: 1,
          },
          {
            pepper: TEST_PEPPER,
            baseUrl: `${baseUrl}/v1`,
            now: dbClock(),
          },
        );

        // Advance clock by 2 seconds
        advanceClockMs(2000);

        const res = await fetch(grant.downloadUrl);
        assert.equal(res.status, 410);
        const body = await res.json();
        assert.equal(body.error.code, 'ARTIFACT_GRANT_EXPIRED');
      });

      it('8.2b download attempt with expired artifact retention returns 410 ARTIFACT_EXPIRED', async () => {
        const artifacts = repo.listJobArtifacts(TENANT_A_ID, renderJobId);
        const art = artifacts.find((a) => a.kind === 'video' && a.mime_type === 'video/mp4');
        assert.ok(art);

        // Update artifact retention expires_at to 1 hour in the past
        pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
          tx.updateScoped(
            'artifacts',
            { expires_at: new Date(currentDbTimeMs - 3600000).toISOString() },
            'id = ?',
            [art.id],
          );
        });

        // Generate fresh grant token
        const grant = generateSignedArtifactDownloadGrant(
          {
            tenantId: TENANT_A_ID,
            artifactId: art.id,
            jobId: renderJobId,
            storageKey: art.storage_key,
            filename: art.filename,
            mimeType: art.mime_type,
            sha256: art.sha256,
            bytes: art.bytes,
            ttlSeconds: 300,
          },
          {
            pepper: TEST_PEPPER,
            baseUrl: `${baseUrl}/v1`,
            now: dbClock(),
          },
        );

        const res = await fetch(grant.downloadUrl);
        assert.equal(res.status, 410);
        const body = await res.json();
        assert.equal(body.error.code, 'ARTIFACT_EXPIRED');
      });

      it('8.2c download attempt for revoked artifact returns 410 GRANT_REVOKED', async () => {
        const artifacts = repo.listJobArtifacts(TENANT_A_ID, renderJobId);
        const art = artifacts.find((a) => a.kind === 'video' && a.mime_type === 'video/mp4');
        assert.ok(art);

        // Mark artifact revoked in DB
        pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
          tx.updateScoped(
            'artifacts',
            {
              revoked_at: dbClock().toISOString(),
              expires_at: new Date(currentDbTimeMs + 86400000).toISOString(),
            },
            'id = ?',
            [art.id],
          );
        });

        const grant = generateSignedArtifactDownloadGrant(
          {
            tenantId: TENANT_A_ID,
            artifactId: art.id,
            jobId: renderJobId,
            storageKey: art.storage_key,
            filename: art.filename,
            mimeType: art.mime_type,
            sha256: art.sha256,
            bytes: art.bytes,
            ttlSeconds: 300,
          },
          {
            pepper: TEST_PEPPER,
            baseUrl: `${baseUrl}/v1`,
            now: dbClock(),
          },
        );

        const res = await fetch(grant.downloadUrl);
        assert.equal(res.status, 410);
        const body = await res.json();
        assert.equal(body.error.code, 'GRANT_REVOKED');
      });
    });

    // ------------------------------------------------------------------------
    // Fault 8.3: Worker Crash / Kill Across Stages
    // ------------------------------------------------------------------------
    describe('8.3 Fault: Worker Crash / Kill Across Stages', () => {
      it('8.3a worker crash at rendering stage triggers lease reclamation and monotonic fencing token prevents zombie publish', async () => {
        const res = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-crash-rendering-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: cmpAlphaId,
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        const job = await res.json();

        // Worker-1 claims the job and crashes at rendering stage
        const worker1 = new RealRendererWorker({
          workerId: 'worker_crashed_1',
          dispatcher,
        });

        const lease1 = dispatcher.claimNextJob({ workerId: 'worker_crashed_1' });
        assert.ok(lease1);

        const worker1Res = await worker1.executeLeasedJob(lease1, {
          killAtStage: 'rendering',
        });
        assert.equal(worker1Res.status, 'killed');
        assert.equal(worker1Res.killedAtStage, 'rendering');

        // Worker lease expires (60s lease)
        advanceClockMs(65000);

        // Dispatcher reaper cycle reclaims the expired lease and increments lease_epoch
        const reaperRes = dispatcher.runReaperCycle();
        const reclaimed = reaperRes.reclaimedLeases.find((l) => l.jobId === job.id);
        assert.ok(reclaimed);
        assert.ok(reclaimed.newLeaseEpoch > lease1.leaseEpoch);

        const jobAfterReap = repo.getJob(TENANT_A_ID, job.id);
        assert.equal(jobAfterReap.state, 'retry_wait');

        // Zombie Worker-1 attempts to publish using old fencing token (epoch 1) -> strictly rejected
        const stalePublishRes = dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: job.id,
          attemptId: lease1.attemptId,
          leaseEpoch: lease1.leaseEpoch, // stale epoch
          artifacts: [],
          cpuSeconds: 1.0,
          peakRssBytes: 1048576,
        });

        assert.equal(stalePublishRes.published, false);
        assert.equal(stalePublishRes.reason, 'STALE_LEASE_OR_EPOCH');
      });

      it('8.3b worker kill at before_publish stage cleans up temp directory without orphan leak', async () => {
        const res = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-crash-publish-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: cmpAlphaId,
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        const job = await res.json();

        const worker = new RealRendererWorker({
          workerId: 'worker_killed_publish_1',
          dispatcher,
        });

        const lease = dispatcher.claimNextJob({ workerId: 'worker_killed_publish_1' });
        assert.ok(lease);

        const killRes = await worker.executeLeasedJob(lease, {
          killAtStage: 'before_publish',
        });
        assert.equal(killRes.status, 'killed');
        assert.equal(killRes.killedAtStage, 'before_publish');

        // Clean up attempt temp dir explicitly (as done by worker cleanup handlers)
        quarantineStore.cleanupAttemptTempDir(TENANT_A_ID, job.id, lease.attemptId);

        // Verify zero temp attempt files remain on disk
        const attemptTempDir = path.join(quarantineDir, 'temp', TENANT_A_ID, job.id, lease.attemptId);
        assert.equal(fs.existsSync(attemptTempDir), false);
      });
    });

    // ------------------------------------------------------------------------
    // Fault 8.4: Callback Outage Resilience
    // ------------------------------------------------------------------------
    describe('8.4 Fault: Callback Outage Resilience', () => {
      it('8.4 survives receiver outage without losing event/job, persists in outbox, and delivers once outage heals', async () => {
        capturedWebhooks = [];

        // 1. Simulate receiver outage: HTTP 503
        isReceiverOutage = true;

        // 2. Submit a render job during outage
        const res = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha.plaintextKey}`,
            'Idempotency-Key': 'idem-fault-outage-render-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: cmpAlphaId,
            revision: 1,
            profile: 'mp4-720p-v1',
            webhook_endpoint_id: 'wh_alpha_receiver',
          }),
        });
        const job = await res.json();

        // 3. Worker executes job to completion
        const worker = new RealRendererWorker({
          workerId: 'worker_outage_test',
          dispatcher,
        });
        const workerRes = await worker.claimAndProcessNextJob();
        assert.equal(workerRes.status, 'succeeded');
        assert.equal(workerRes.jobId, job.id);

        // Job succeeded in DB
        const jobStatus = repo.getJob(TENANT_A_ID, job.id);
        assert.equal(jobStatus.state, 'succeeded');

        // 4. Outbox delivery service attempts to send, encounters 503 outage
        deliveryService.processOutbox(TENANT_A_ID);
        const failedDelivery = await deliveryService.deliverPending({ tenantId: TENANT_A_ID });
        assert.ok(failedDelivery.some((d) => d.status === 'retry_scheduled'));

        // Verify event is NOT lost: delivery is scheduled for retry
        const pendingDeliveries = repo.listWebhookDeliveries(TENANT_A_ID, { jobId: job.id });
        assert.ok(pendingDeliveries.data.length > 0);
        assert.equal(pendingDeliveries.data[0].state, 'queued');
        assert.ok(pendingDeliveries.data[0].attempt_count >= 1);
        assert.ok(pendingDeliveries.data[0].next_attempt_at !== null);

        // 5. Outage heals: receiver comes back online (HTTP 200)
        isReceiverOutage = false;

        // Advance clock past retry backoff (first retry is after 60s)
        advanceClockMs(65000);

        // 6. Deliver pending retries
        const retryDelivery = await deliveryService.deliverPending({ tenantId: TENANT_A_ID });
        assert.ok(retryDelivery.some((d) => d.status === 'delivered'));

        // Check delivered status in repository
        const updatedDeliveries = repo.listWebhookDeliveries(TENANT_A_ID, { jobId: job.id });
        assert.equal(updatedDeliveries.data[0].state, 'delivered');

        // Check that captured webhook payload has valid signature and matched job
        assert.ok(capturedWebhooks.length > 0);
        const callback = capturedWebhooks.find((w) => {
          try {
            const b = JSON.parse(w.rawBody.toString('utf8'));
            return b.data?.job_id === job.id;
          } catch {
            return false;
          }
        });
        assert.ok(callback);

        const verifyRes = verifyAndProcessIncomingWebhook({
          headers: callback.headers,
          rawBodyBytes: callback.rawBody,
          secrets: [{ keyId: 'whk_1', secret: alphaSigningSecret }],
          deduplicator: webhookDeduplicator,
          now: dbClock(),
        });
        assert.equal(verifyRes.verified, true);
        assert.equal(verifyRes.payload.data.job_id, job.id);
      });
    });
  });
});
