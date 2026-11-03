/**
 * Task P4-01 Integration & Concurrency Test Suite:
 * Admission Transaction, Idempotency, Rate/Quota Limits, Usage Reservations & Capabilities.
 *
 * Acceptance Criteria:
 *   "Admission transaction/idempotency/limits/reservations/capabilities;
 *    concurrent duplicate/key conflict/quota races pass, 202 only after durable commit"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  MigrationRunner,
  TenantConnectionPool,
  TenantRepository,
  TokenBucketRateLimiter,
  createServer,
} from '../dist/index.js';

const TEST_PEPPER = 'p401_test_secret_pepper_0123456789abcdef0123456789abcdef';
const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';

function buildValidSpec({
  fontAssetId = 'ast_font_noto_sans_regular',
  imageAssetId,
  audioAssetId,
  durationFrames = 450, // 15s at 30fps
  engine = 'html-v1',
  bundleId,
  bundleRevision,
  extraImageLayers = [],
} = {}) {
  const layers = [
    {
      id: 'layer_title',
      type: 'text',
      z_index: 1,
      start_frame: 0,
      duration_frames: durationFrames,
      box: { x: 48, y: 100, width: 624, height: 240 },
      content: {
        text: 'Xin chào Creativanta P4-01',
        font_id: 'font_main',
        font_size: 48,
        color: '#FFFFFF',
        align: 'center',
        max_lines: 2,
        overflow: 'ellipsis',
      },
    },
  ];

  if (imageAssetId) {
    layers.push({
      id: 'layer_hero_img',
      type: 'image',
      z_index: 2,
      start_frame: 0,
      duration_frames: durationFrames,
      box: { x: 50, y: 50, width: 400, height: 400 },
      content: {
        asset_id: imageAssetId,
        fit: 'cover',
      },
    });
  }

  for (let i = 0; i < extraImageLayers.length; i++) {
    layers.push({
      id: `layer_extra_img_${i}`,
      type: 'image',
      z_index: 3 + i,
      start_frame: 0,
      duration_frames: durationFrames,
      box: { x: 10, y: 10, width: 100, height: 100 },
      content: {
        asset_id: extraImageLayers[i],
        fit: 'cover',
      },
    });
  }

  const scene =
    engine === 'custom-html-v1'
      ? {
          id: 'scene_1',
          revision: 1,
          engine: 'custom-html-v1',
          start_frame: 0,
          duration_frames: durationFrames,
          background: '#101820',
          bundle: {
            id: bundleId ?? 'bnd_custom_1',
            revision: bundleRevision ?? 1,
            source_sha256: 'a'.repeat(64),
            build_sha256: 'b'.repeat(64),
            entrypoint: 'index.js',
            parameters: { headline: 'Custom Scene' },
          },
          transition_out: { type: 'cut', duration_frames: 0 },
        }
      : {
          id: 'scene_1',
          revision: 1,
          engine,
          start_frame: 0,
          duration_frames: durationFrames,
          background: '#101820',
          layers,
          transition_out: { type: 'cut', duration_frames: 0 },
        };

  return {
    schema_version: '1.0',
    canvas: { width: 1280, height: 720, background: '#101828' },
    fps: { num: 30, den: 1 },
    duration_frames: durationFrames,
    locale: 'vi-VN',
    direction: 'ltr',
    seed: 42,
    fonts: [
      {
        id: 'font_main',
        asset_id: fontAssetId,
        sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        family: 'Noto Sans',
        weight: 400,
        style: 'normal',
      },
    ],
    scenes: [scene],
    audio_tracks: audioAssetId
      ? [
          {
            id: 'audio_1',
            asset_id: audioAssetId,
            start_frame: 0,
            duration_frames: durationFrames,
            source_in_samples: 0,
            gain_db: -6,
          },
        ]
      : [],
    subtitles: [],
  };
}

async function createTestHarness(options = {}) {
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator' });

  const pool = new TenantConnectionPool(db, { poolSize: 8 });
  const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

  const keyAlpha = repo.issueApiKey({
    tenantId: TENANT_A_ID,
    keyId: 'key_alpha_full',
    scopes: [
      'templates:read',
      'templates:write',
      'compositions:read',
      'compositions:write',
      'assets:read',
      'assets:write',
      'jobs:read',
      'jobs:write',
      'webhooks:manage',
      'usage:read',
    ],
  }).plaintextKey;

  const keyBeta = repo.issueApiKey({
    tenantId: TENANT_B_ID,
    keyId: 'key_beta_full',
    scopes: [
      'templates:read',
      'templates:write',
      'compositions:read',
      'compositions:write',
      'assets:read',
      'assets:write',
      'jobs:read',
      'jobs:write',
      'webhooks:manage',
      'usage:read',
    ],
  }).plaintextKey;

  repo.createAsset(TENANT_A_ID, {
    id: 'ast_alpha_hero',
    filename: 'hero.png',
    kind: 'image',
    mimeType: 'image/png',
    bytes: 50000,
    sha256: 'a'.repeat(64),
    rights: { basis: 'owned', source: 'studio', attribution: 'Alpha' },
  });

  repo.createComposition(TENANT_A_ID, {
    id: 'cmp_alpha_main',
    name: 'Alpha Main Composition',
    spec: buildValidSpec({ imageAssetId: 'ast_alpha_hero', durationFrames: 450 }),
  });

  repo.createComposition(TENANT_B_ID, {
    id: 'cmp_beta_main',
    name: 'Beta Main Composition',
    spec: buildValidSpec({ durationFrames: 300 }),
  });

  const config = loadEnvConfig({
    CVE_ENV: 'development',
    CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    CVE_API_KEY_PEPPER: TEST_PEPPER,
    CVE_CUSTOM_CODE_ENABLED: options.customCodeEnabled ? 'true' : 'false',
    CVE_CUSTOM_RUNTIME: options.customCodeEnabled ? 'container_no_net' : 'disabled',
  });

  const rateLimiter = options.rateLimiter ?? new TokenBucketRateLimiter();
  const server = createServer({
    config,
    repository: repo,
    rateLimiter,
    enforceGlobalRateLimit: options.enforceGlobalRateLimit ?? false,
    onAfterIdempotencyClaim: options.onAfterIdempotencyClaim,
    onBeforeJobCommit: options.onBeforeJobCommit,
    onJobAdmissionCommitted: options.onJobAdmissionCommitted,
  });

  const baseUrl = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  };

  return { db, pool, repo, rateLimiter, server, baseUrl, keyAlpha, keyBeta, close };
}

describe('P4-01: Admission Transaction, Idempotency, Rate/Quota Limits, Reservations & Capabilities', () => {
  describe('1. Atomic Admission Transaction & 202 Only After Durable Commit', () => {
    it('1.1 admits POST /v1/render-jobs and POST /v1/previews (frame & clip), creating job, job_events, usage_reservations, and completed idempotency atomically', async () => {
      const commitEvents = [];
      const h = await createTestHarness({
        onJobAdmissionCommitted: (ev) => {
          commitEvents.push(ev);
        },
      });

      try {
        // 1. Submit POST /v1/render-jobs
        const renderRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-render-001',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            client_reference: 'campaign-2026-q4',
            metadata: { campaign: 'holiday', region: 'VN' },
          }),
        });

        const responseReceivedAtMs = Date.now();
        assert.strictEqual(renderRes.status, 202);
        assert.strictEqual(renderRes.headers.get('retry-after'), '2');
        assert.ok(renderRes.headers.get('x-request-id'));
        const renderJob = await renderRes.json();
        assert.strictEqual(renderJob.kind, 'render');
        assert.strictEqual(renderJob.state, 'queued');
        assert.strictEqual(renderJob.state_version, 1);
        assert.strictEqual(renderJob.composition_id, 'cmp_alpha_main');
        assert.strictEqual(renderJob.revision, 1);
        assert.strictEqual(renderJob.profile, 'mp4-720p-v1');
        assert.strictEqual(renderRes.headers.get('location'), `/v1/jobs/${renderJob.id}`);

        // Verify durable commit occurred before 202 response arrived
        assert.strictEqual(commitEvents.length, 1);
        assert.strictEqual(commitEvents[0].jobId, renderJob.id);
        assert.ok(commitEvents[0].committedAtMs <= responseReceivedAtMs);

        // Verify usage_reservation created atomically (450 frames @ 30fps = 15s output, 120 vCPU-s)
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, renderJob.id);
        assert.ok(reservation);
        assert.strictEqual(reservation.state, 'reserved');
        assert.strictEqual(reservation.reserved_output_seconds, 15);
        assert.strictEqual(reservation.reserved_vcpu_seconds, 120);

        // Verify initial job_events entry via GET /v1/jobs/{id}/events
        const eventsRes = await fetch(`${h.baseUrl}/v1/jobs/${renderJob.id}/events`, {
          headers: { Authorization: `Bearer ${h.keyAlpha}` },
        });
        assert.strictEqual(eventsRes.status, 200);
        const eventsBody = await eventsRes.json();
        assert.strictEqual(eventsBody.data.length, 1);
        assert.strictEqual(eventsBody.data[0].event_seq, 1);
        assert.strictEqual(eventsBody.data[0].state, 'queued');

        // 2. Submit POST /v1/previews (mode = frame)
        const framePreviewRes = await fetch(`${h.baseUrl}/v1/previews`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-preview-frame-001',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            mode: 'frame',
            frame_index: 120,
            profile: 'preview-360p-v1',
          }),
        });
        assert.strictEqual(framePreviewRes.status, 202);
        const framePreviewJob = await framePreviewRes.json();
        assert.strictEqual(framePreviewJob.kind, 'preview');
        assert.strictEqual(framePreviewJob.profile, 'preview-360p-v1');
        assert.strictEqual(
          framePreviewRes.headers.get('location'),
          `/v1/jobs/${framePreviewJob.id}`,
        );

        const frameResv = h.repo.getUsageReservation(TENANT_A_ID, framePreviewJob.id);
        assert.ok(frameResv);
        assert.strictEqual(frameResv.state, 'reserved');
        assert.ok(frameResv.reserved_output_seconds > 0);

        // 3. Submit POST /v1/previews (mode = clip)
        const clipPreviewRes = await fetch(`${h.baseUrl}/v1/previews`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-preview-clip-001',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            mode: 'clip',
            start_frame: 60,
            duration_frames: 150,
            profile: 'preview-360p-v1',
          }),
        });
        assert.strictEqual(clipPreviewRes.status, 202);
        const clipPreviewJob = await clipPreviewRes.json();
        const clipResv = h.repo.getUsageReservation(TENANT_A_ID, clipPreviewJob.id);
        assert.ok(clipResv);
        assert.strictEqual(clipResv.reserved_output_seconds, 5); // 150 frames @ 30fps = 5s
      } finally {
        await h.close();
      }
    });

    it('1.2 never returns 202 if durable commit fails; rolls back job, reservation, events, and idempotency claim so retry with same key succeeds', async () => {
      let failCommit = true;
      const h = await createTestHarness({
        onBeforeJobCommit: () => {
          if (failCommit) {
            throw new Error('SIMULATED_WAL_FSYNC_COMMIT_FAILURE');
          }
        },
      });

      try {
        // Attempt 1: Commit fails inside transaction
        const failedRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-commit-fault-001',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });

        assert.strictEqual(failedRes.status, 503);
        assert.strictEqual(failedRes.headers.get('retry-after'), '2');
        const errBody = await failedRes.json();
        assert.strictEqual(errBody.error.code, 'SERVICE_UNAVAILABLE');
        assert.strictEqual(errBody.error.retryable, true);

        // Verify zero orphan rows exist in jobs, usage_reservations, or idempotency_records
        const jobsAfterFault = h.repo.listJobs(TENANT_A_ID);
        assert.strictEqual(jobsAfterFault.data.length, 0);
        const resvAfterFault = h.repo.listUsageReservations(TENANT_A_ID);
        assert.strictEqual(resvAfterFault.length, 0);
        const idemAfterFault = h.repo.getIdempotencyRecord(TENANT_A_ID, {
          method: 'POST',
          normalizedPath: '/v1/render-jobs',
          key: 'idem-commit-fault-001',
        });
        assert.strictEqual(idemAfterFault, null);

        // Attempt 2: DB commit recovers; client retries with the EXACT same Idempotency-Key
        failCommit = false;
        const retryRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-commit-fault-001',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });

        assert.strictEqual(retryRes.status, 202);
        assert.strictEqual(retryRes.headers.get('idempotency-replayed'), null);
        const admittedJob = await retryRes.json();
        assert.strictEqual(admittedJob.state, 'queued');

        const jobsAfterRecovery = h.repo.listJobs(TENANT_A_ID);
        assert.strictEqual(jobsAfterRecovery.data.length, 1);
        assert.strictEqual(jobsAfterRecovery.data[0].id, admittedJob.id);
      } finally {
        await h.close();
      }
    });

    it('1.3 validates preview timeline bounds (TIMELINE_BOUNDS), unknown fields, client_reference, and metadata limits', async () => {
      const h = await createTestHarness();
      try {
        // Out-of-bounds frame_index (>= 450)
        const oobFrameRes = await fetch(`${h.baseUrl}/v1/previews`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-bounds-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            mode: 'frame',
            frame_index: 450,
            profile: 'preview-360p-v1',
          }),
        });
        assert.strictEqual(oobFrameRes.status, 422);
        const oobFrameJson = await oobFrameRes.json();
        assert.strictEqual(oobFrameJson.error.code, 'VALIDATION_FAILED');
        assert.strictEqual(oobFrameJson.error.details[0].code, 'TIMELINE_BOUNDS');

        // Clip duration > 300 frames (10s limit)
        const clipTooLongRes = await fetch(`${h.baseUrl}/v1/previews`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-bounds-2',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            mode: 'clip',
            start_frame: 0,
            duration_frames: 301,
            profile: 'preview-360p-v1',
          }),
        });
        assert.strictEqual(clipTooLongRes.status, 422);
        const clipTooLongJson = await clipTooLongRes.json();
        assert.strictEqual(clipTooLongJson.error.details[0].code, 'TIMELINE_BOUNDS');

        // Clip start_frame + duration_frames > composition.duration_frames (350 + 150 = 500 > 450)
        const clipOverflowRes = await fetch(`${h.baseUrl}/v1/previews`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-bounds-3',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            mode: 'clip',
            start_frame: 350,
            duration_frames: 150,
            profile: 'preview-360p-v1',
          }),
        });
        assert.strictEqual(clipOverflowRes.status, 422);
        const clipOverflowJson = await clipOverflowRes.json();
        assert.strictEqual(clipOverflowJson.error.details[0].code, 'TIMELINE_BOUNDS');

        // Unknown field + metadata value > 256 chars
        const badMetaRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-bounds-4',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            unexpected_flag: true,
            metadata: {
              oversized: 'x'.repeat(300),
            },
          }),
        });
        assert.strictEqual(badMetaRes.status, 422);
        const badMetaJson = await badMetaRes.json();
        const detailCodes = badMetaJson.error.details.map((d) => d.code);
        assert.ok(detailCodes.includes('UNKNOWN_FIELD'));
        assert.ok(detailCodes.includes('METADATA_LIMIT_EXCEEDED'));
      } finally {
        await h.close();
      }
    });
  });

  describe('2. Idempotency Replay, Key Conflict, Concurrent In-Progress Races & Secret Redaction', () => {
    it('2.1 replays exact and RFC 8785 JCS-equivalent requests with Idempotency-Replayed: true without duplicate job or reservation', async () => {
      const h = await createTestHarness();
      try {
        const res1 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-jcs-replay-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            metadata: { b: 'two', a: 'one' },
          }),
        });
        assert.strictEqual(res1.status, 202);
        assert.strictEqual(res1.headers.get('idempotency-replayed'), null);
        const job1 = await res1.json();

        // Replay with keys in different order (RFC 8785 JCS produces identical SHA-256 hash)
        const res2 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-jcs-replay-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            profile: 'mp4-720p-v1',
            revision: 1,
            metadata: { a: 'one', b: 'two' },
            composition_id: 'cmp_alpha_main',
          }),
        });
        assert.strictEqual(res2.status, 202);
        assert.strictEqual(res2.headers.get('idempotency-replayed'), 'true');
        assert.strictEqual(res2.headers.get('location'), `/v1/jobs/${job1.id}`);
        assert.strictEqual(res2.headers.get('retry-after'), '2');
        const job2 = await res2.json();
        assert.strictEqual(job2.id, job1.id);

        // Verify only 1 job and 1 reservation exist
        assert.strictEqual(h.repo.listJobs(TENANT_A_ID).data.length, 1);
        assert.strictEqual(h.repo.listUsageReservations(TENANT_A_ID).length, 1);

        // Reusing the same Idempotency-Key with a different payload returns 409 IDEMPOTENCY_CONFLICT
        const conflictRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-jcs-replay-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            metadata: { a: 'one', b: 'DIFFERENT' },
          }),
        });
        assert.strictEqual(conflictRes.status, 409);
        const conflictBody = await conflictRes.json();
        assert.strictEqual(conflictBody.error.code, 'IDEMPOTENCY_CONFLICT');
        assert.strictEqual(conflictBody.error.retryable, false);
      } finally {
        await h.close();
      }
    });

    it('2.2 handles concurrent in-flight duplicate and key-conflict requests (409 IDEMPOTENCY_IN_PROGRESS with Retry-After: 1 vs 409 IDEMPOTENCY_CONFLICT)', async () => {
      let releaseBarrier;
      const barrierPromise = new Promise((resolve) => {
        releaseBarrier = resolve;
      });
      let notifyInProgressEntered;
      const enteredPromise = new Promise((resolve) => {
        notifyInProgressEntered = resolve;
      });

      let firstCall = true;
      const h = await createTestHarness({
        onAfterIdempotencyClaim: async ({ key }) => {
          if (key === 'idem-concurrent-flight-1' && firstCall) {
            firstCall = false;
            notifyInProgressEntered();
            await barrierPromise;
          }
        },
      });

      try {
        const payload = {
          composition_id: 'cmp_alpha_main',
          revision: 1,
          profile: 'mp4-720p-v1',
        };

        // Start Request A (holds in_progress at barrier)
        const reqAPromise = fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-concurrent-flight-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        await enteredPromise;

        // While Request A is in_progress, Request B arrives with identical key & payload -> 409 IDEMPOTENCY_IN_PROGRESS
        const reqBRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-concurrent-flight-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        assert.strictEqual(reqBRes.status, 409);
        assert.strictEqual(reqBRes.headers.get('retry-after'), '1');
        const reqBBody = await reqBRes.json();
        assert.strictEqual(reqBBody.error.code, 'IDEMPOTENCY_IN_PROGRESS');
        assert.strictEqual(reqBBody.error.retryable, true);

        // While Request A is in_progress, Request C arrives with same key & different payload -> 409 IDEMPOTENCY_CONFLICT
        const reqCRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-concurrent-flight-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...payload,
            client_reference: 'conflicting-in-flight-payload',
          }),
        });
        assert.strictEqual(reqCRes.status, 409);
        const reqCBody = await reqCRes.json();
        assert.strictEqual(reqCBody.error.code, 'IDEMPOTENCY_CONFLICT');
        assert.strictEqual(reqCBody.error.retryable, false);

        // Release Request A and verify it completes with 202 Accepted
        releaseBarrier();
        const reqARes = await reqAPromise;
        assert.strictEqual(reqARes.status, 202);
        const jobA = await reqARes.json();

        // Now Request B retries with the same Idempotency-Key and gets 202 Replayed with jobA.id
        const reqBRetryRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-concurrent-flight-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });
        assert.strictEqual(reqBRetryRes.status, 202);
        assert.strictEqual(reqBRetryRes.headers.get('idempotency-replayed'), 'true');
        const jobBRetry = await reqBRetryRes.json();
        assert.strictEqual(jobBRetry.id, jobA.id);
      } finally {
        await h.close();
      }
    });

    it('2.3 redacts webhook signing_secret in idempotency store and returns secret_redacted: true on replay', async () => {
      const h = await createTestHarness();
      try {
        const createRes = await fetch(`${h.baseUrl}/v1/webhook-endpoints`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-wh-secret-once-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://alpha.example.invalid/webhooks/render',
            events: ['job.succeeded', 'job.failed'],
          }),
        });
        assert.strictEqual(createRes.status, 201);
        const initialBody = await createRes.json();
        assert.ok(initialBody.signing_secret.startsWith('whsec_'));
        assert.strictEqual(initialBody.secret_redacted, undefined);

        // Inspect stored idempotency record in DB: must NOT contain plaintext signing_secret
        const storedRecord = h.repo.getIdempotencyRecord(TENANT_A_ID, {
          method: 'POST',
          normalizedPath: '/v1/webhook-endpoints',
          key: 'idem-wh-secret-once-1',
        });
        assert.ok(storedRecord);
        assert.strictEqual(storedRecord.secret_redacted, 1);
        assert.ok(!storedRecord.response_body_encrypted.includes(initialBody.signing_secret));

        // Replay request with same Idempotency-Key -> returns 201 with secret_redacted: true and no signing_secret
        const replayRes = await fetch(`${h.baseUrl}/v1/webhook-endpoints`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-wh-secret-once-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://alpha.example.invalid/webhooks/render',
            events: ['job.succeeded', 'job.failed'],
          }),
        });
        assert.strictEqual(replayRes.status, 201);
        assert.strictEqual(replayRes.headers.get('idempotency-replayed'), 'true');
        const replayBody = await replayRes.json();
        assert.strictEqual(replayBody.id, initialBody.id);
        assert.strictEqual(replayBody.secret_redacted, true);
        assert.strictEqual(replayBody.signing_secret, undefined);
      } finally {
        await h.close();
      }
    });
  });

  describe('3. Token-Bucket Rate Limiting (429 RATE_LIMITED)', () => {
    it('3.1 enforces per-tenant and per-API-key token bucket (1 token/s refill, burst 20) with Retry-After and refills deterministically', async () => {
      let currentClockMs = 1_700_000_000_000;
      const rateLimiter = new TokenBucketRateLimiter({
        nowFn: () => currentClockMs,
      });
      // Set pending_admission_slots_max high enough so the 21st request hits RATE_LIMITED, not QUOTA_EXCEEDED
      const h = await createTestHarness({ rateLimiter });
      h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
        pending_admission_slots_max: 50,
        non_terminal_jobs_total_max: 52,
        token_bucket_refill_per_second: 1,
        token_bucket_burst_capacity: 20,
      });

      try {
        // Send 20 requests at fixed clock -> all 20 succeed with 202 Accepted
        for (let i = 1; i <= 20; i++) {
          const res = await fetch(`${h.baseUrl}/v1/render-jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${h.keyAlpha}`,
              'Idempotency-Key': `idem-burst-${i}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              composition_id: 'cmp_alpha_main',
              revision: 1,
              profile: 'mp4-720p-v1',
            }),
          });
          assert.strictEqual(res.status, 202, `Expected request #${i} to pass burst 20`);
        }

        // 21st request at same timestamp -> 429 RATE_LIMITED with Retry-After: 1
        const res21 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-burst-21-retryable',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(res21.status, 429);
        assert.strictEqual(res21.headers.get('retry-after'), '1');
        const body21 = await res21.json();
        assert.strictEqual(body21.error.code, 'RATE_LIMITED');
        assert.strictEqual(body21.error.retryable, true);

        // Tenant B is completely unaffected by Tenant A's exhausted token bucket
        const betaRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyBeta}`,
            'Idempotency-Key': 'idem-beta-unaffected-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_beta_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(betaRes.status, 202);

        // Advance clock by 1000ms (1 token refilled) -> Tenant A retries request #21 with the SAME Idempotency-Key and succeeds!
        currentClockMs += 1000;
        const retry21 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-burst-21-retryable',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(retry21.status, 202);
      } finally {
        await h.close();
      }
    });
  });

  describe('4. Slot Quotas, Concurrent Quota Races, Retry-Wait Reservation Retention & Cancellation', () => {
    it('4.1 enforces pending admission slots (20) and total non-terminal cap (22), passes concurrent quota races, retains slot on active->retry_wait (AMB-004), and frees slot on cancel', async () => {
      const h = await createTestHarness();
      // Allow high rate-limit burst so concurrent requests race purely on DB admission slots
      h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
        active_job_slots_max: 2,
        pending_admission_slots_max: 20,
        non_terminal_jobs_total_max: 22,
        token_bucket_refill_per_second: 100,
        token_bucket_burst_capacity: 200,
      });

      try {
        // 1. Admit 2 jobs and transition them to active 'rendering' state (consuming the 2 active slots)
        const activeJobIds = [];
        for (let i = 1; i <= 2; i++) {
          const res = await fetch(`${h.baseUrl}/v1/render-jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${h.keyAlpha}`,
              'Idempotency-Key': `idem-active-seed-${i}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              composition_id: 'cmp_alpha_main',
              revision: 1,
              profile: 'mp4-720p-v1',
            }),
          });
          assert.strictEqual(res.status, 202);
          const job = await res.json();
          activeJobIds.push(job.id);
          h.repo.transitionJobToActive(TENANT_A_ID, job.id, { state: 'rendering' });
        }

        // 2. Admit 18 pending jobs (mix of render and preview jobs sharing the pool) -> 18 pending, 20 non-terminal total
        const pendingJobIds = [];
        for (let i = 1; i <= 18; i++) {
          const isPreview = i % 3 === 0;
          const res = await fetch(
            `${h.baseUrl}${isPreview ? '/v1/previews' : '/v1/render-jobs'}`,
            {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${h.keyAlpha}`,
                'Idempotency-Key': `idem-pending-seed-${i}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(
                isPreview
                  ? {
                      composition_id: 'cmp_alpha_main',
                      revision: 1,
                      mode: 'frame',
                      frame_index: 10,
                      profile: 'preview-360p-v1',
                    }
                  : {
                      composition_id: 'cmp_alpha_main',
                      revision: 1,
                      profile: 'mp4-720p-v1',
                    },
              ),
            },
          );
          assert.strictEqual(res.status, 202);
          const job = await res.json();
          pendingJobIds.push(job.id);
        }

        // 3. Fire 10 concurrent job admission requests racing for the last 2 remaining slots (20 pending max / 22 non-terminal max)
        const racePromises = Array.from({ length: 10 }, (_, idx) =>
          fetch(`${h.baseUrl}/v1/render-jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${h.keyAlpha}`,
              'Idempotency-Key': `idem-quota-race-${idx + 1}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              composition_id: 'cmp_alpha_main',
              revision: 1,
              profile: 'mp4-720p-v1',
            }),
          }),
        );

        const raceResponses = await Promise.all(racePromises);
        const statuses = raceResponses.map((r) => r.status);
        const admittedCount = statuses.filter((s) => s === 202).length;
        const rejectedCount = statuses.filter((s) => s === 429).length;

        assert.strictEqual(admittedCount, 2, `Expected exactly 2 requests to win last 2 slots, got ${admittedCount}`);
        assert.strictEqual(rejectedCount, 8, `Expected exactly 8 requests to get 429 QUOTA_EXCEEDED, got ${rejectedCount}`);

        for (const r of raceResponses) {
          if (r.status === 429) {
            assert.strictEqual(r.headers.get('retry-after'), '5');
            const errJson = await r.json();
            assert.strictEqual(errJson.error.code, 'QUOTA_EXCEEDED');
            assert.strictEqual(errJson.error.retryable, true);
          }
        }

        // Verify exact database invariant: 22 non-terminal jobs (2 active + 20 queued) and 22 active reservations
        const allReservations = h.repo.listUsageReservations(TENANT_A_ID, 'reserved');
        assert.strictEqual(allReservations.length, 22);

        // 4. AMB-004: Already-admitted active job transitioning from 'rendering' to 'retry_wait'
        // retains its existing non-terminal slot and reservation without failing admission
        const retryWaitTransition = h.repo.transitionJobToRetryWait(
          TENANT_A_ID,
          activeJobIds[0],
          { reason: 'Worker transient crash' },
        );
        assert.strictEqual(retryWaitTransition.state, 'retry_wait');
        const retainedResv = h.repo.getUsageReservation(TENANT_A_ID, activeJobIds[0]);
        assert.strictEqual(retainedResv.state, 'reserved');

        // 5. Cancel 2 queued jobs via POST /v1/jobs/{id}/cancel -> releases their reservations and frees slots
        for (const jobIdToCancel of [pendingJobIds[0], pendingJobIds[1]]) {
          const cancelRes = await fetch(`${h.baseUrl}/v1/jobs/${jobIdToCancel}/cancel`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${h.keyAlpha}`,
              'Idempotency-Key': `idem-cancel-${jobIdToCancel}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          });
          assert.strictEqual(cancelRes.status, 202);
          const cancelBody = await cancelRes.json();
          assert.strictEqual(cancelBody.state, 'canceled');

          const releasedResv = h.repo.getUsageReservation(TENANT_A_ID, jobIdToCancel);
          assert.strictEqual(releasedResv.state, 'released');
          assert.ok(releasedResv.settled_at);
        }

        // Calling cancel again on an already-canceled job with a new key returns 200 OK
        const cancelAgainRes = await fetch(`${h.baseUrl}/v1/jobs/${pendingJobIds[0]}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-cancel-already-canceled',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        assert.strictEqual(cancelAgainRes.status, 200);

        // Now a previously rejected request from the race (using its original Idempotency-Key!) can retry and succeed with 202 Accepted
        const rejectedIdx = statuses.findIndex((s) => s === 429);
        const retryRejectedRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': `idem-quota-race-${rejectedIdx + 1}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(retryRejectedRes.status, 202);
      } finally {
        await h.close();
      }
    });

    it('4.2 enforces tenant compute/output reservation budget caps (max_reserved_vcpu_seconds / max_reserved_output_seconds)', async () => {
      const h = await createTestHarness();
      // Each render job of cmp_alpha_main (15s) reserves 15 output seconds and 120 vCPU seconds.
      // Cap tenant at 200 vCPU seconds -> 1st job (120) succeeds, 2nd job (120 + 120 = 240 > 200) fails with 429 QUOTA_EXCEEDED
      h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
        max_reserved_vcpu_seconds: 200,
        max_reserved_output_seconds: 30,
      });

      try {
        const res1 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-budget-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(res1.status, 202);

        const res2 = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-budget-2',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(res2.status, 429);
        const body2 = await res2.json();
        assert.strictEqual(body2.error.code, 'QUOTA_EXCEEDED');
      } finally {
        await h.close();
      }
    });
  });

  describe('5. Capabilities, Asset Readiness, Asset Count/Byte Budgets & Webhook Verification Gates', () => {
    it('5.1 rejects unsupported profiles, disabled engines, unapproved custom bundles, and admits approved custom bundles when enabled', async () => {
      const h = await createTestHarness({ customCodeEnabled: true });
      try {
        // 1. Unsupported profile on /v1/render-jobs -> 422 UNSUPPORTED_CAPABILITY (PROFILE_CONSTRAINT_VIOLATED)
        const badProfileRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-cap-profile-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-4k-hdr-v1',
          }),
        });
        assert.strictEqual(badProfileRes.status, 422);
        const badProfileBody = await badProfileRes.json();
        assert.strictEqual(badProfileBody.error.code, 'UNSUPPORTED_CAPABILITY');
        assert.strictEqual(badProfileBody.error.details[0].code, 'PROFILE_CONSTRAINT_VIOLATED');

        // 2. Disable canvas-v1 in tenant policy and attempt to admit a composition using canvas-v1
        h.repo.createComposition(TENANT_A_ID, {
          id: 'cmp_alpha_canvas',
          name: 'Canvas Composition',
          spec: buildValidSpec({ engine: 'canvas-v1', durationFrames: 90 }),
        });
        h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
          canvas_engine_enabled: false,
        });

        const disabledCanvasRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-cap-canvas-disabled',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_canvas',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(disabledCanvasRes.status, 422);
        const disabledCanvasBody = await disabledCanvasRes.json();
        assert.strictEqual(disabledCanvasBody.error.code, 'UNSUPPORTED_CAPABILITY');
        assert.strictEqual(disabledCanvasBody.error.details[0].code, 'CAPABILITY_DISABLED');

        // 3. Custom code engine (custom-html-v1): insert a composition revision directly via migrator/repo
        // and verify unapproved bundle is rejected while approved bundle with security_gate_digest passes
        h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
          canvas_engine_enabled: true,
          custom_code_enabled: true,
        });

        h.repo.registerSceneBundle(TENANT_A_ID, {
          bundleId: 'bnd_draft_only',
          revision: 1,
          status: 'draft',
          securityGateDigest: null,
        });

        h.repo.registerSceneBundle(TENANT_A_ID, {
          bundleId: 'bnd_verified_prod',
          revision: 1,
          status: 'approved',
          securityGateDigest: 'f'.repeat(64),
        });

        const draftSpec = buildValidSpec({
          engine: 'custom-html-v1',
          bundleId: 'bnd_draft_only',
          bundleRevision: 1,
          durationFrames: 90,
        });
        const verifiedSpec = buildValidSpec({
          engine: 'custom-html-v1',
          bundleId: 'bnd_verified_prod',
          bundleRevision: 1,
          durationFrames: 90,
        });

        h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
          const nowIso = new Date().toISOString();
          tx.insertScoped('compositions', {
            tenant_id: TENANT_A_ID,
            id: 'cmp_custom_draft',
            name: 'Draft Bundle Comp',
            current_revision: 1,
            template_tenant_id: null,
            template_id: null,
            template_revision: null,
            editable: 1,
            created_at: nowIso,
            updated_at: nowIso,
          });
          tx.insertScoped('composition_revisions', {
            tenant_id: TENANT_A_ID,
            composition_id: 'cmp_custom_draft',
            revision: 1,
            schema_version: '1.0',
            spec_json: JSON.stringify(draftSpec),
            render_hash: 'd'.repeat(64),
            change_note: 'Draft custom bundle',
            created_at: nowIso,
          });

          tx.insertScoped('compositions', {
            tenant_id: TENANT_A_ID,
            id: 'cmp_custom_verified',
            name: 'Verified Bundle Comp',
            current_revision: 1,
            template_tenant_id: null,
            template_id: null,
            template_revision: null,
            editable: 1,
            created_at: nowIso,
            updated_at: nowIso,
          });
          tx.insertScoped('composition_revisions', {
            tenant_id: TENANT_A_ID,
            composition_id: 'cmp_custom_verified',
            revision: 1,
            schema_version: '1.0',
            spec_json: JSON.stringify(verifiedSpec),
            render_hash: 'e'.repeat(64),
            change_note: 'Verified custom bundle',
            created_at: nowIso,
          });
        });

        const draftBundleJobRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-custom-draft-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_custom_draft',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(draftBundleJobRes.status, 422);
        const draftBundleBody = await draftBundleJobRes.json();
        assert.strictEqual(draftBundleBody.error.code, 'UNSUPPORTED_CAPABILITY');
        assert.strictEqual(draftBundleBody.error.details[0].code, 'CAPABILITY_DISABLED');

        const verifiedBundleJobRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-custom-verified-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_custom_verified',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(verifiedBundleJobRes.status, 202);
      } finally {
        await h.close();
      }
    });

    it('5.2 enforces asset readiness (409 ASSET_NOT_READY), revoked asset rejection (422 ASSET_NOT_FOUND), per-job asset/byte budgets, and webhook verification (409 WEBHOOK_NOT_VERIFIED)', async () => {
      const h = await createTestHarness();
      try {
        // 1. Create a webhook endpoint (starts in pending_verification)
        const whCreateRes = await fetch(`${h.baseUrl}/v1/webhook-endpoints`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-wh-gate-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: 'https://alpha.example.invalid/hook',
            events: ['job.succeeded'],
          }),
        });
        assert.strictEqual(whCreateRes.status, 201);
        const wh = await whCreateRes.json();
        assert.strictEqual(wh.state, 'pending_verification');

        // Submitting render job with unverified webhook endpoint -> 409 WEBHOOK_NOT_VERIFIED
        const unverifiedWhJobRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-job-with-wh-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            webhook_endpoint_id: wh.id,
          }),
        });
        assert.strictEqual(unverifiedWhJobRes.status, 409);
        const unverifiedWhBody = await unverifiedWhJobRes.json();
        assert.strictEqual(unverifiedWhBody.error.code, 'WEBHOOK_NOT_VERIFIED');

        // Verify the webhook endpoint via POST /v1/webhook-endpoints/{id}/verify
        const whVerifyRes = await fetch(`${h.baseUrl}/v1/webhook-endpoints/${wh.id}/verify`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-wh-verify-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        });
        assert.strictEqual(whVerifyRes.status, 200);

        // Retry job submission with the SAME Idempotency-Key -> now succeeds with 202 Accepted!
        const verifiedWhJobRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-job-with-wh-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_alpha_main',
            revision: 1,
            profile: 'mp4-720p-v1',
            webhook_endpoint_id: wh.id,
          }),
        });
        assert.strictEqual(verifiedWhJobRes.status, 202);

        // 2. Asset transitions to 'processing' -> admission rejects with 409 ASSET_NOT_READY
        h.repo.createAsset(TENANT_A_ID, {
          id: 'ast_temp_ready',
          filename: 'temp.png',
          kind: 'image',
          mimeType: 'image/png',
          bytes: 80 * 1024 * 1024, // 80 MiB
          sha256: 'b'.repeat(64),
          rights: { basis: 'owned', source: 'studio', attribution: 'Alpha' },
        });
        h.repo.createComposition(TENANT_A_ID, {
          id: 'cmp_with_temp_asset',
          name: 'Temp Asset Composition',
          spec: buildValidSpec({ imageAssetId: 'ast_temp_ready', durationFrames: 90 }),
        });

        // Set asset status to 'processing' and attempt admission -> 409 ASSET_NOT_READY
        h.repo.updateAssetStatus(TENANT_A_ID, 'ast_temp_ready', { status: 'processing' });
        const notReadyRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-asset-not-ready-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_with_temp_asset',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(notReadyRes.status, 409);
        const notReadyBody = await notReadyRes.json();
        assert.strictEqual(notReadyBody.error.code, 'ASSET_NOT_READY');

        // Delete the asset and attempt admission -> 422 VALIDATION_FAILED (ASSET_NOT_FOUND)
        h.repo.deleteAsset(TENANT_A_ID, 'ast_temp_ready');
        const deletedAssetRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-asset-deleted-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_with_temp_asset',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(deletedAssetRes.status, 422);
        const deletedAssetBody = await deletedAssetRes.json();
        assert.strictEqual(deletedAssetBody.error.code, 'VALIDATION_FAILED');
        assert.strictEqual(deletedAssetBody.error.details[0].code, 'ASSET_NOT_FOUND');

        // 3. Total input bytes > 500 MiB (create 6 assets of 90 MiB each = 540 MiB > 500 MiB)
        const heavyAssetIds = [];
        for (let i = 1; i <= 6; i++) {
          const aid = `ast_heavy_${i}`;
          heavyAssetIds.push(aid);
          h.repo.createAsset(TENANT_A_ID, {
            id: aid,
            filename: `heavy_${i}.png`,
            kind: 'image',
            mimeType: 'image/png',
            bytes: 90 * 1024 * 1024, // 90 MiB
            sha256: String(i).repeat(64),
            rights: { basis: 'owned', source: 'studio', attribution: 'Alpha' },
          });
        }

        h.repo.createComposition(TENANT_A_ID, {
          id: 'cmp_heavy_540mib',
          name: 'Heavy 540 MiB Composition',
          spec: buildValidSpec({
            extraImageLayers: heavyAssetIds,
            durationFrames: 90,
          }),
        });

        const heavyJobRes = await fetch(`${h.baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyAlpha}`,
            'Idempotency-Key': 'idem-heavy-540mib-1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            composition_id: 'cmp_heavy_540mib',
            revision: 1,
            profile: 'mp4-720p-v1',
          }),
        });
        assert.strictEqual(heavyJobRes.status, 422);
        const heavyJobBody = await heavyJobRes.json();
        assert.strictEqual(heavyJobBody.error.code, 'UNSUPPORTED_CAPABILITY');
        assert.strictEqual(heavyJobBody.error.details[0].code, 'PROFILE_CONSTRAINT_VIOLATED');
      } finally {
        await h.close();
      }
    });
  });
});
