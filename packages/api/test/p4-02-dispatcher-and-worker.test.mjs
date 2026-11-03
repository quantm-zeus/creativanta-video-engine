/**
 * Task P4-02 Integration & Concurrency Test Suite:
 *   - Postgres/SQLite Job Dispatcher, 60s Lease / 15s Heartbeat (DB Server Clock `now()`),
 *   - Monotonic Fencing Token `(job_id, attempt_id, lease_epoch)`,
 *   - Fair Multi-Tenant Scheduler (Round-Robin across tenants, FIFO within tenant, max 2 active/tenant,
 *     2:1 preview-to-render priority with <= 50% global preview slot cap when render is waiting),
 *   - Real Deterministic Renderer + Faststart ISO-BMFF H.264/AAC Muxer & Full MP4 Decoder Verifier,
 *   - Job/Attempt/Event State Machine, Retry Backoff (5s, 30s+jitter, max_attempts=3),
 *   - Stale Worker Fencing (`stale worker không publish`).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  CVE_HEARTBEAT_INTERVAL_SECONDS,
  CVE_LEASE_DURATION_SECONDS,
  InvalidStateTransitionError,
  JobDispatcher,
  MigrationRunner,
  NON_RETRYABLE_JOB_ERROR_CODES,
  QuarantineStore,
  RETRYABLE_JOB_ERROR_CODES,
  RealRendererWorker,
  TenantConnectionPool,
  TenantRepository,
  calculateRetryBackoffMs,
  createServer,
  verifyIsoBmffMp4,
  verifyPngBuffer,
} from '../dist/index.js';
import * as DispatcherPackage from '../../dispatcher/index.mjs';
import { Mp4Decoder } from '../../renderers/dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_C_ID = '33333333-3333-4333-8333-333333333333';
const TEST_PEPPER = 'p4-02-dispatcher-worker-secret-pepper-32bytes!';

function createValidSpec(overrides = {}) {
  const durationFrames = overrides.duration_frames ?? 6; // 6 frames (0.2s at 30fps)
  return {
    schema_version: '1.0',
    canvas: {
      width: 1280,
      height: 720,
      background: '#101828',
    },
    fps: { num: 30, den: 1 },
    duration_frames: durationFrames,
    locale: 'vi-VN',
    direction: 'ltr',
    seed: 42,
    fonts: [
      {
        id: 'font_main',
        asset_id: 'ast_font_noto_sans_regular',
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
        background: '#101828',
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
              fill: '#1D4ED8',
            },
          },
          {
            id: 'layer_headline',
            type: 'text',
            z_index: 2,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 140, y: 180, width: 960, height: 160 },
            opacity: 1,
            content: {
              text: 'Xin chào Creativanta P4-02',
              font_id: 'font_main',
              font_size: 48,
              color: '#FFFFFF',
              align: 'center',
              max_lines: 2,
              overflow: 'ellipsis',
            },
          },
          {
            id: 'layer_logo',
            type: 'image',
            z_index: 3,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 140, y: 380, width: 240, height: 160 },
            opacity: 0.95,
            content: {
              asset_id: 'ast_img_hero',
              fit: 'cover',
            },
          },
        ],
        transition_out: { type: 'cut', duration_frames: 0 },
      },
    ],
    audio_tracks: [
      {
        id: 'track_bgm',
        asset_id: 'ast_audio_bgm',
        start_frame: 0,
        duration_frames: durationFrames,
        source_in_samples: 0,
        gain_db: -6,
      },
    ],
    subtitles: [
      {
        id: 'sub_vi',
        locale: 'vi-VN',
        burn_in: true,
        style: {
          font_id: 'font_main',
          font_size: 28,
          color: '#FFFFFF',
        },
        cues: [
          {
            id: 'cue_1',
            start_frame: 0,
            end_frame: durationFrames,
            text: 'Xin chào Creativanta',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function seedTenantAssetsAndComposition(repo, tenantId, compId = 'cmp_p402_main') {
  repo.createAsset(tenantId, {
    id: 'ast_img_hero',
    filename: 'hero.png',
    kind: 'image',
    status: 'ready',
    mimeType: 'image/png',
    bytes: 4096,
    sha256: crypto.createHash('sha256').update(`img:${tenantId}`).digest('hex'),
    rights: { basis: 'owned', source: 'studio', attribution: 'Creativanta' },
  });

  repo.createAsset(tenantId, {
    id: 'ast_audio_bgm',
    filename: 'bgm.wav',
    kind: 'audio',
    status: 'ready',
    mimeType: 'audio/wav',
    bytes: 8192,
    sha256: crypto.createHash('sha256').update(`aud:${tenantId}`).digest('hex'),
    rights: { basis: 'owned', source: 'studio', attribution: 'Creativanta' },
  });

  const spec = createValidSpec();
  repo.createComposition(tenantId, {
    id: compId,
    name: `Composition ${compId}`,
    spec,
  });

  return { compId, spec };
}

function createTestHarness(options = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p402-test-'));
  const quarantineStore = new QuarantineStore(storageDir);
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator' });

  const pool = new TenantConnectionPool(db, { poolSize: 8 });
  const repo = new TenantRepository(pool, {
    pepper: TEST_PEPPER,
    quarantineStore,
  });

  let currentDbTimeMs = Date.parse(options.initialTimeIso ?? '2026-11-03T12:00:00.000Z');
  const dbClock = () => new Date(currentDbTimeMs);
  const advanceClockMs = (deltaMs) => {
    currentDbTimeMs += deltaMs;
    return new Date(currentDbTimeMs);
  };

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant A (Noisy)', now: dbClock() });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant B (Quiet)', now: dbClock() });
  repo.createTenant({ id: TENANT_C_ID, name: 'Tenant C', now: dbClock() });

  const keyA = repo.issueApiKey({
    tenantId: TENANT_A_ID,
    keyId: 'key_tenant_a',
    scopes: ['jobs:read', 'jobs:write', 'compositions:write', 'assets:write', 'usage:read'],
    now: dbClock(),
  });
  const keyB = repo.issueApiKey({
    tenantId: TENANT_B_ID,
    keyId: 'key_tenant_b',
    scopes: ['jobs:read', 'jobs:write', 'compositions:write', 'assets:write', 'usage:read'],
    now: dbClock(),
  });

  seedTenantAssetsAndComposition(repo, TENANT_A_ID, 'cmp_p402_main');
  seedTenantAssetsAndComposition(repo, TENANT_B_ID, 'cmp_p402_main');
  seedTenantAssetsAndComposition(repo, TENANT_C_ID, 'cmp_p402_main');

  const dispatcher = new JobDispatcher({
    repository: repo,
    quarantineStore,
    maxGlobalSlots: options.maxGlobalSlots ?? 4,
    includeRetryJitter: options.includeRetryJitter ?? false,
    dbClock,
  });

  const cleanup = () => {
    quarantineStore.clearAll();
  };

  return {
    db,
    pool,
    repo,
    quarantineStore,
    dispatcher,
    keyA,
    keyB,
    dbClock,
    advanceClockMs,
    cleanup,
  };
}

describe('P4-02: Postgres Dispatcher, Lease/Heartbeat/Fencing, Fair Scheduling & Real Renderer', () => {
  it('1. Exports canonical dispatcher and worker symbols from both @creativanta/api and packages/dispatcher', () => {
    assert.equal(CVE_LEASE_DURATION_SECONDS, 60);
    assert.equal(CVE_HEARTBEAT_INTERVAL_SECONDS, 15);
    assert.equal(RETRYABLE_JOB_ERROR_CODES.length, 5);
    assert.equal(NON_RETRYABLE_JOB_ERROR_CODES.length, 8);
    assert.equal(typeof DispatcherPackage.JobDispatcher, 'function');
    assert.equal(typeof DispatcherPackage.RealRendererWorker, 'function');
    assert.equal(DispatcherPackage.JobDispatcher, JobDispatcher);
    assert.equal(DispatcherPackage.RealRendererWorker, RealRendererWorker);
  });

  it('2. Executes end-to-end real render (mp4-720p-v1) & preview (preview-360p-v1) jobs with ISO-BMFF faststart MP4 decoding, monotonic events, usage settlement, and outbox emission', async () => {
    const h = createTestHarness();
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_API_KEY_PEPPER: TEST_PEPPER,
      CVE_CUSTOM_CODE_ENABLED: 'false',
      CVE_CUSTOM_RUNTIME: 'disabled',
    });
    const server = createServer({
      config,
      repository: h.repo,
      quarantineStore: h.quarantineStore,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Admit a render job via HTTP POST /v1/render-jobs
      const renderRes = await fetch(`${baseUrl}/v1/render-jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p402_e2e_render_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: 'cmp_p402_main',
          revision: 1,
          profile: 'mp4-720p-v1',
          client_reference: 'e2e_render_ref',
        }),
      });
      assert.equal(renderRes.status, 202);
      const renderAdmitted = await renderRes.json();
      const renderJobId = renderAdmitted.id;

      // 2. Admit a keyframe preview job via HTTP POST /v1/previews
      const previewKeyRes = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p402_e2e_preview_key_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: 'cmp_p402_main',
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: 2,
        }),
      });
      assert.equal(previewKeyRes.status, 202);
      const previewKeyAdmitted = await previewKeyRes.json();
      const previewKeyJobId = previewKeyKeyId(previewKeyAdmitted);

      // 3. Admit a clip preview job via HTTP POST /v1/previews
      const previewClipRes = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p402_e2e_preview_clip_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: 'cmp_p402_main',
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 1,
          duration_frames: 4,
        }),
      });
      assert.equal(previewClipRes.status, 202);
      const previewClipAdmitted = await previewClipRes.json();
      const previewClipJobId = previewClipAdmitted.id;

      // 4. Process all 3 jobs using RealRendererWorker
      const worker = new RealRendererWorker({
        workerId: 'worker_e2e_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 50,
      });

      const results = [];
      for (let i = 0; i < 3; i++) {
        const res = await worker.claimAndProcessNextJob();
        assert.equal(res.status, 'succeeded');
        results.push(res);
      }

      // Queue is now empty
      const idleRes = await worker.claimAndProcessNextJob();
      assert.equal(idleRes.status, 'idle');

      // 5. Inspect completed Render Job via GET /v1/jobs/{id} and GET /v1/jobs/{id}/events
      const jobStatusRes = await fetch(`${baseUrl}/v1/jobs/${renderJobId}`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(jobStatusRes.status, 200);
      const jobStatus = await jobStatusRes.json();
      assert.equal(jobStatus.state, 'succeeded');
      assert.equal(jobStatus.stage, 'complete');
      assert.equal(jobStatus.progress, 1);
      assert.equal(jobStatus.attempt, 1);
      assert.equal(jobStatus.error, null);
      assert.ok(jobStatus.completed_at);
      assert.equal(jobStatus.artifacts.length, 3); // video, thumbnail, manifest
      assert.ok(jobStatus.usage.cpu_seconds > 0);
      assert.ok(jobStatus.usage.output_seconds > 0);
      assert.ok(jobStatus.usage.billable_output_minutes > 0);

      // Verify monotonic event sequence: queued(1) -> preparing(2) -> rendering(3) -> encoding(4) -> verifying(5) -> succeeded(6)
      const eventsRes = await fetch(`${baseUrl}/v1/jobs/${renderJobId}/events`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(eventsRes.status, 200);
      const eventsBody = await eventsRes.json();
      assert.deepEqual(
        eventsBody.data.map((e) => e.event_seq),
        [1, 2, 3, 4, 5, 6],
      );
      assert.deepEqual(
        eventsBody.data.map((e) => e.state),
        ['queued', 'preparing', 'rendering', 'encoding', 'verifying', 'succeeded'],
      );

      // Verify job_attempts telemetry
      const attempts = h.repo.listJobAttempts(TENANT_A_ID, renderJobId);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].state, 'succeeded');
      assert.equal(attempts[0].lease_epoch, 1);
      assert.equal(attempts[0].worker_id, 'worker_e2e_1');
      assert.ok(attempts[0].cpu_seconds > 0);
      assert.ok(attempts[0].peak_rss_bytes > 0);
      assert.ok(attempts[0].ended_at);

      // Verify usage reservation settled & usage ledger entries created
      const reservation = h.repo.getUsageReservation(TENANT_A_ID, renderJobId);
      assert.equal(reservation.state, 'settled');
      assert.ok(reservation.settled_at);

      const usageEntries = h.repo.listUsageEntries(TENANT_A_ID, renderJobId);
      assert.equal(usageEntries.length, 2);
      assert.ok(
        usageEntries.some(
          (u) => u.usage_class === 'operational' && u.meter === 'cpu_seconds',
        ),
      );
      assert.ok(
        usageEntries.some(
          (u) => u.usage_class === 'billable' && u.meter === 'billable_output_minutes',
        ),
      );

      // Verify transactional outbox event emitted
      const outboxEvents = h.repo.listOutboxEvents(TENANT_A_ID, renderJobId);
      assert.equal(outboxEvents.length, 1);
      assert.equal(outboxEvents[0].event_type, 'job.succeeded');
      assert.equal(outboxEvents[0].state_version, jobStatus.state_version);

      // Verify real MP4 file on disk via both verifyIsoBmffMp4 and @creativanta/renderers Mp4Decoder
      const dbArtifacts = h.repo.listJobArtifacts(TENANT_A_ID, renderJobId);
      const videoArtifact = dbArtifacts.find((a) => a.kind === 'video');
      assert.ok(videoArtifact);
      assert.equal(videoArtifact.mime_type, 'video/mp4');

      // Verify GET /v1/artifacts/{id}/download returns a valid 300s grant
      const dlRes = await fetch(
        `${baseUrl}/v1/artifacts/${videoArtifact.id}/download`,
        {
          headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
        },
      );
      assert.equal(dlRes.status, 200);
      const dlGrant = await dlRes.json();
      assert.equal(dlGrant.sha256, videoArtifact.sha256);
      assert.equal(dlGrant.bytes, videoArtifact.bytes);

      const storedMp4 = h.quarantineStore.getArtifactFileByStorageKey(
        videoArtifact.storage_key,
      );
      assert.ok(storedMp4);
      const isoReport = verifyIsoBmffMp4(storedMp4.buffer, {
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

      // Cross-verify with @creativanta/renderers Mp4Decoder
      const decodedContainer = Mp4Decoder.decode(storedMp4.buffer, 6);
      assert.equal(decodedContainer.faststartMoovBeforeMdat, true);
      assert.equal(decodedContainer.majorBrand, 'isom');
      assert.equal(decodedContainer.tracks.length, 2);

      // Verify keyframe preview produced lossless 640x360 PNG
      const keyframeArtifacts = h.repo.listJobArtifacts(TENANT_A_ID, previewKeyJobId);
      const keyframeVideoArt = keyframeArtifacts.find((a) => a.kind === 'video');
      assert.ok(keyframeVideoArt);
      assert.equal(keyframeVideoArt.mime_type, 'image/png');
      const storedPng = h.quarantineStore.getArtifactFileByStorageKey(
        keyframeVideoArt.storage_key,
      );
      assert.ok(storedPng);
      const pngCheck = verifyPngBuffer(storedPng.buffer, 640, 360);
      assert.equal(pngCheck.valid, true);

      // Verify clip preview produced faststart 640x360 MP4 with 4 frames
      const clipArtifacts = h.repo.listJobArtifacts(TENANT_A_ID, previewClipJobId);
      const clipVideoArt = clipArtifacts.find((a) => a.kind === 'video');
      assert.ok(clipVideoArt);
      assert.equal(clipVideoArt.mime_type, 'video/mp4');
      const storedClipMp4 = h.quarantineStore.getArtifactFileByStorageKey(
        clipVideoArt.storage_key,
      );
      assert.ok(storedClipMp4);
      const clipIso = verifyIsoBmffMp4(storedClipMp4.buffer, {
        width: 640,
        height: 360,
        fps: 30,
        expectedFrames: 4,
      });
      assert.equal(clipIso.valid, true);
      assert.equal(clipIso.faststart, true);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('3. Enforces 60s lease & 15s heartbeat on DB server clock `now()` ignoring worker clock skew (AMB-009) and self-aborts worker on missed renewal', async () => {
    const h = createTestHarness();
    try {
      const admitted = h.repo.admitJob(TENANT_A_ID, {
        id: 'job_lease_clock_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });

      const t0 = h.dbClock();
      // Pass a workerLocalTime skewed +3 hours in the future
      const skewedWorkerClock = new Date(t0.getTime() + 3 * 3600 * 1000);

      const lease = h.dispatcher.claimNextJob({
        workerId: 'worker_clock_1',
        workerLocalTime: skewedWorkerClock,
      });
      assert.ok(lease);
      assert.equal(lease.jobId, admitted.job.id);
      assert.equal(lease.leaseEpoch, 1);

      // Lease expiration MUST be t0 + 60s (DB clock), NOT skewedWorkerClock + 60s
      assert.equal(
        Date.parse(lease.leaseExpiresAt),
        t0.getTime() + CVE_LEASE_DURATION_SECONDS * 1000,
      );
      assert.equal(Date.parse(lease.heartbeatAt), t0.getTime());

      // Advance DB clock by 15s (canonical heartbeat interval)
      const t15 = h.advanceClockMs(CVE_HEARTBEAT_INTERVAL_SECONDS * 1000);
      const skewedPastWorkerClock = new Date(t0.getTime() - 2 * 3600 * 1000);

      const renewal1 = h.dispatcher.renewLease({
        tenantId: TENANT_A_ID,
        jobId: lease.jobId,
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        workerId: 'worker_clock_1',
        progress: 0.35,
        workerLocalTime: skewedPastWorkerClock,
      });
      assert.equal(renewal1.renewed, true);
      assert.equal(renewal1.shouldAbortWorker, false);
      assert.equal(
        Date.parse(renewal1.leaseExpiresAt),
        t15.getTime() + CVE_LEASE_DURATION_SECONDS * 1000,
      );
      assert.equal(Date.parse(renewal1.heartbeatAt), t15.getTime());
      assert.ok(renewal1.workerClockSkewMs < -7_000_000);

      // Advance DB clock by 61s without heartbeat so lease expires on DB clock
      h.advanceClockMs(61_000);

      // Even if worker claims its local clock is still at t15 + 5s, DB clock says lease expired!
      const renewalExpired = h.dispatcher.renewLease({
        tenantId: TENANT_A_ID,
        jobId: lease.jobId,
        attemptId: lease.attemptId,
        leaseEpoch: lease.leaseEpoch,
        workerId: 'worker_clock_1',
        workerLocalTime: new Date(t15.getTime() + 5_000),
      });
      assert.equal(renewalExpired.renewed, false);
      assert.equal(renewalExpired.shouldAbortWorker, true);
      assert.equal(renewalExpired.reason, 'LEASE_EXPIRED');

      // Reaper reclaims the expired lease and increments lease_epoch to 2
      const reclaimed = h.dispatcher.reclaimExpiredLeases();
      assert.equal(reclaimed.length, 1);
      assert.equal(reclaimed[0].jobId, lease.jobId);
      assert.equal(reclaimed[0].previousLeaseEpoch, 1);
      assert.equal(reclaimed[0].newLeaseEpoch, 2);
      assert.equal(reclaimed[0].newState, 'retry_wait');
    } finally {
      h.cleanup();
    }
  });

  it('4. Guarantees stale worker fencing (`stale worker không publish`): stalled Worker 1 cannot heartbeat, advance stage, or publish artifacts after lease reclamation and Worker 2 takeover', async () => {
    const h = createTestHarness();
    try {
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_fenced_stale_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });

      const worker1 = new RealRendererWorker({
        workerId: 'worker_stale_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 60_000,
      });
      const worker2 = new RealRendererWorker({
        workerId: 'worker_fresh_2',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 60_000,
      });

      // Step 1: Worker 1 claims job (attempt 1, lease_epoch = 1)
      const lease1 = h.dispatcher.claimNextJob({ workerId: 'worker_stale_1' });
      assert.ok(lease1);
      assert.equal(lease1.leaseEpoch, 1);
      assert.equal(lease1.attemptCount, 1);

      let worker2Result = null;
      let directStaleHeartbeatResult = null;
      let directStaleStageResult = null;

      // Step 2: Worker 1 runs up to `verifying` (staging its temp files), then stalls before `publishJobAttempt`
      const worker1Result = await worker1.executeLeasedJob(lease1, {
        ignoreAbortSignalForStalePublishTest: true,
        onBeforeStage: async (stage) => {
          if (stage === 'verifying') {
            // Worker 1 has already staged its temp files in `encoding` and is about to enter `verifying`.
            // Let's advance Worker 1 into `verifying` first, or stall right after `verifying`!
          }
        },
        onFrameRendered: async (frameIdx) => {
          if (frameIdx === 5) {
            // All frames rendered by Worker 1; now simulate Worker 1 stalling for 65s!
            h.advanceClockMs(65_000);

            // Lease reaper runs and reclaims Worker 1's expired lease -> retry_wait (lease_epoch = 2)
            const reclaimed = h.dispatcher.reclaimExpiredLeases();
            assert.equal(reclaimed.length, 1);
            assert.equal(reclaimed[0].previousAttemptId, lease1.attemptId);
            assert.equal(reclaimed[0].previousLeaseEpoch, 1);
            assert.equal(reclaimed[0].newLeaseEpoch, 2);
            assert.equal(reclaimed[0].newState, 'retry_wait');

            // Advance 5s retry backoff and promote retry_wait -> queued
            h.advanceClockMs(5_000);
            const promoted = h.dispatcher.promoteEligibleRetryWaitJobs();
            assert.equal(promoted.length, 1);
            assert.equal(promoted[0].outcome, 'queued');

            // Worker 2 claims the re-queued job (attempt 2, lease_epoch = 2) and renders + publishes to completion!
            worker2Result = await worker2.claimAndProcessNextJob();
            assert.equal(worker2Result.status, 'succeeded');
            assert.equal(worker2Result.leaseEpoch, 3); // epoch 1 (w1) -> 2 (reaper) -> 3 (w2)

            // Verify that direct heartbeat & stage advance from Stale Worker 1 (epoch 1) are rejected
            directStaleHeartbeatResult = h.dispatcher.renewLease({
              tenantId: TENANT_A_ID,
              jobId: lease1.jobId,
              attemptId: lease1.attemptId,
              leaseEpoch: lease1.leaseEpoch,
              workerId: 'worker_stale_1',
            });
            directStaleStageResult = h.dispatcher.advanceJobStage({
              tenantId: TENANT_A_ID,
              jobId: lease1.jobId,
              attemptId: lease1.attemptId,
              leaseEpoch: lease1.leaseEpoch,
              targetState: 'encoding',
            });
          }
        },
      });

      // Step 3: Verify Stale Worker 1 was strictly fenced off and could NOT publish!
      assert.equal(directStaleHeartbeatResult.renewed, false);
      assert.equal(directStaleHeartbeatResult.reason, 'STALE_LEASE_OR_EPOCH');
      assert.equal(directStaleStageResult.transitioned, false);
      assert.equal(directStaleStageResult.reason, 'STALE_LEASE_OR_EPOCH');

      assert.equal(worker1Result.status, 'aborted_or_fenced');
      assert.equal(worker1Result.reason, 'STALE_LEASE_OR_EPOCH');
      assert.equal(worker1Result.artifacts, undefined);

      // Step 4: Also test direct `publishJobAttempt` call from Stale Worker 1 -> strictly rejected!
      const directStalePublish = h.dispatcher.publishJobAttempt({
        tenantId: TENANT_A_ID,
        jobId: lease1.jobId,
        attemptId: lease1.attemptId,
        leaseEpoch: lease1.leaseEpoch,
        artifacts: [
          {
            id: 'art_corrupt_stale',
            kind: 'video',
            filename: 'output.mp4',
            mimeType: 'video/mp4',
            bytes: 123,
            sha256: 'f'.repeat(64),
            buffer: Buffer.from('stale-corrupt-bytes'),
          },
        ],
        cpuSeconds: 9.9,
        peakRssBytes: 1024,
        outputSeconds: 0.2,
      });
      assert.equal(directStalePublish.published, false);
      assert.equal(directStalePublish.reason, 'STALE_LEASE_OR_EPOCH');
      assert.equal(directStalePublish.artifacts.length, 0);

      // Step 5: Verify DB state reflects ONLY Worker 2's publication (single logical publication)
      const finalJob = h.repo.getJob(TENANT_A_ID, 'job_fenced_stale_1');
      assert.equal(finalJob.state, 'succeeded');
      assert.equal(finalJob.attempt, 2);

      const finalArtifacts = h.repo.listJobArtifacts(TENANT_A_ID, 'job_fenced_stale_1');
      assert.equal(finalArtifacts.length, 3);
      for (const art of finalArtifacts) {
        assert.equal(art.attempt_id, worker2Result.attemptId);
        assert.notEqual(art.attempt_id, lease1.attemptId);
        assert.notEqual(art.sha256, 'f'.repeat(64));
      }

      const attempts = h.repo.listJobAttempts(TENANT_A_ID, 'job_fenced_stale_1');
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].attempt_id, lease1.attemptId);
      assert.equal(attempts[0].state, 'retry_wait');
      assert.equal(attempts[0].error.code, 'WORKER_LOST');
      assert.equal(attempts[1].attempt_id, worker2Result.attemptId);
      assert.equal(attempts[1].state, 'succeeded');

      // Only 1 outbox event (`job.succeeded`) and 1 billable usage entry exist
      const outbox = h.repo.listOutboxEvents(TENANT_A_ID, 'job_fenced_stale_1');
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].event_type, 'job.succeeded');
      assert.equal(outbox[0].payload.attempt_id, worker2Result.attemptId);

      const usageEntries = h.repo.listUsageEntries(TENANT_A_ID, 'job_fenced_stale_1');
      const billableEntries = usageEntries.filter((u) => u.usage_class === 'billable');
      assert.equal(billableEntries.length, 1);
      assert.equal(billableEntries[0].attempt_id, worker2Result.attemptId);
    } finally {
      h.cleanup();
    }
  });

  it('5. Enforces Fair Multi-Tenant Scheduling: round-robin across noisy vs quiet tenants, FIFO within tenant, per-tenant active cap (2), and 2:1 preview-to-render weighted priority with <= 50% global preview cap', async () => {
    const h = createTestHarness({ maxGlobalSlots: 6 });
    try {
      // Part A: Noisy Tenant A (5 render jobs) vs Quiet Tenant B (2 render jobs) vs Tenant C (1 render job)
      for (let i = 1; i <= 5; i++) {
        h.repo.admitJob(TENANT_A_ID, {
          id: `job_noisy_a_${i}`,
          request: {
            kind: 'render',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h.advanceClockMs(10),
        });
      }
      for (let i = 1; i <= 2; i++) {
        h.repo.admitJob(TENANT_B_ID, {
          id: `job_quiet_b_${i}`,
          request: {
            kind: 'render',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h.advanceClockMs(10),
        });
      }
      h.repo.admitJob(TENANT_C_ID, {
        id: 'job_quiet_c_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.advanceClockMs(10),
      });

      // Claim 5 jobs concurrently while keeping them active:
      // Expected round-robin order:
      //   1. Tenant A -> job_noisy_a_1 (FIFO #1 of A, active A = 1/2)
      //   2. Tenant B -> job_quiet_b_1 (FIFO #1 of B, active B = 1/2)
      //   3. Tenant C -> job_quiet_c_1 (FIFO #1 of C, active C = 1/2)
      //   4. Tenant A -> job_noisy_a_2 (FIFO #2 of A, active A = 2/2 -> Tenant A hits active_job_slots_max = 2!)
      //   5. Tenant B -> job_quiet_b_2 (FIFO #2 of B, active B = 2/2)
      //   6. Next claim MUST return null because Tenant A already has 2 active slots (even though global slots has 1 free slot and Tenant A has 3 queued jobs!)
      const claimed = [];
      for (let i = 0; i < 5; i++) {
        const lease = h.dispatcher.claimNextJob({ workerId: `worker_fair_${i + 1}` });
        assert.ok(lease);
        claimed.push(lease);
      }

      assert.deepEqual(
        claimed.map((c) => `${c.tenantId.slice(0, 4)}:${c.jobId}`),
        [
          '1111:job_noisy_a_1',
          '2222:job_quiet_b_1',
          '3333:job_quiet_c_1',
          '1111:job_noisy_a_2',
          '2222:job_quiet_b_2',
        ],
      );

      // 6th concurrent claim returns null because Tenant A is capped at 2 active slots!
      const blockedByTenantCap = h.dispatcher.claimNextJob({ workerId: 'worker_fair_6' });
      assert.equal(blockedByTenantCap, null);
    } finally {
      h.cleanup();
    }

    // Part B: Preview vs Render 2:1 weighted priority + <= 50% global preview slot cap when render is waiting
    const h2 = createTestHarness({ maxGlobalSlots: 2 });
    try {
      // Queue 3 previews and 2 renders across Tenant A and Tenant B
      for (let i = 1; i <= 3; i++) {
        h2.repo.admitJob(TENANT_A_ID, {
          id: `job_prev_${i}`,
          request: {
            kind: 'preview',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'preview-360p-v1',
            mode: 'keyframes',
            frame_index: 0,
          },
          now: h2.advanceClockMs(10),
        });
      }
      for (let i = 1; i <= 2; i++) {
        h2.repo.admitJob(TENANT_B_ID, {
          id: `job_rend_${i}`,
          request: {
            kind: 'render',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h2.advanceClockMs(10),
        });
      }

      // With maxGlobalSlots = 2:
      // Slot 1 claims `job_prev_1` (preview).
      // Now 1 of 2 global slots (50%) is occupied by an active preview while a render job is waiting!
      // Therefore, Slot 2 MUST claim `job_rend_1` (render) so previews never exceed 50% of global slots while render is waiting!
      const slot1 = h2.dispatcher.claimNextJob({ workerId: 'w_slot_1' });
      const slot2 = h2.dispatcher.claimNextJob({ workerId: 'w_slot_2' });
      assert.ok(slot1);
      assert.ok(slot2);
      assert.equal(slot1.kind, 'preview');
      assert.equal(slot1.jobId, 'job_prev_1');
      assert.equal(slot2.kind, 'render');
      assert.equal(slot2.jobId, 'job_rend_1');

      // Slot 3 is blocked by maxGlobalSlots = 2
      assert.equal(h2.dispatcher.claimNextJob({ workerId: 'w_slot_3' }), null);
    } finally {
      h2.cleanup();
    }

    // Part C: Sequential 2:1 [preview, preview, render] cadence when slots free up
    const h3 = createTestHarness({ maxGlobalSlots: 4 });
    try {
      for (let i = 1; i <= 4; i++) {
        h3.repo.admitJob(TENANT_A_ID, {
          id: `seq_prev_${i}`,
          request: {
            kind: 'preview',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'preview-360p-v1',
            mode: 'keyframes',
            frame_index: 0,
          },
          now: h3.advanceClockMs(10),
        });
      }
      for (let i = 1; i <= 2; i++) {
        h3.repo.admitJob(TENANT_A_ID, {
          id: `seq_rend_${i}`,
          request: {
            kind: 'render',
            compositionId: 'cmp_p402_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h3.advanceClockMs(10),
        });
      }

      const seqWorker = new RealRendererWorker({
        workerId: 'w_seq',
        dispatcher: h3.dispatcher,
      });

      const dispatchOrder = [];
      for (let i = 0; i < 6; i++) {
        const res = await seqWorker.claimAndProcessNextJob();
        assert.equal(res.status, 'succeeded');
        const job = h3.repo.getJob(TENANT_A_ID, res.jobId);
        dispatchOrder.push(`${job.kind}:${job.id}`);
      }

      // Exact 2:1 weighted priority cadence: [preview, preview, render, preview, preview, render]
      assert.deepEqual(dispatchOrder, [
        'preview:seq_prev_1',
        'preview:seq_prev_2',
        'render:seq_rend_1',
        'preview:seq_prev_3',
        'preview:seq_prev_4',
        'render:seq_rend_2',
      ]);
    } finally {
      h3.cleanup();
    }
  });

  it('6. Enforces state machine invariants, retryable (5s/30s backoff, max_attempts=3) vs non-retryable error codes, cancel reaper (AMB-003), and ASSET_REVOKED publication block', async () => {
    const h = createTestHarness({ includeRetryJitter: false });
    try {
      // Case A: Retryable failures across 3 attempts (5s backoff after attempt 1, 30s after attempt 2, terminal failed on attempt 3)
      assert.equal(calculateRetryBackoffMs(1, 'job_retry_test', { includeJitter: false }), 5_000);
      assert.equal(calculateRetryBackoffMs(2, 'job_retry_test', { includeJitter: false }), 30_000);

      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_retry_exhaust_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });

      const worker = new RealRendererWorker({
        workerId: 'worker_fault_1',
        dispatcher: h.dispatcher,
      });

      // Attempt 1 fails with retryable RENDER_TIMEOUT -> retry_wait (5s backoff)
      const att1 = await worker.claimAndProcessNextJob({
        simulateError: {
          stage: 'rendering',
          code: 'RENDER_TIMEOUT',
          message: 'Frame evaluation timed out at 120s',
        },
      });
      assert.equal(att1.status, 'retry_wait');
      assert.equal(h.repo.getJob(TENANT_A_ID, 'job_retry_exhaust_1').state, 'retry_wait');
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, 'job_retry_exhaust_1').state,
        'reserved',
      );

      // Before 5s backoff elapses, job is NOT promoted
      h.advanceClockMs(3_000);
      assert.equal(h.dispatcher.promoteEligibleRetryWaitJobs().length, 0);

      // At 5s, job is promoted to queued
      h.advanceClockMs(2_000);
      assert.equal(h.dispatcher.promoteEligibleRetryWaitJobs().length, 1);

      // Attempt 2 fails with retryable STORAGE_TRANSIENT_ERROR -> retry_wait (30s backoff)
      const att2 = await worker.claimAndProcessNextJob({
        simulateError: {
          stage: 'encoding',
          code: 'STORAGE_TRANSIENT_ERROR',
          message: 'Object storage write timed out',
        },
      });
      assert.equal(att2.status, 'retry_wait');

      // Advance 30s backoff -> promoted to queued
      h.advanceClockMs(30_000);
      assert.equal(h.dispatcher.promoteEligibleRetryWaitJobs().length, 1);

      // Attempt 3 fails with retryable INTERNAL_WORKER_ERROR -> max_attempts (3) exhausted -> terminal failed!
      const att3 = await worker.claimAndProcessNextJob({
        simulateError: {
          stage: 'rendering',
          code: 'INTERNAL_WORKER_ERROR',
          message: 'Worker process crashed on attempt 3',
        },
      });
      assert.equal(att3.status, 'failed');

      const exhaustedJob = h.repo.getJob(TENANT_A_ID, 'job_retry_exhaust_1');
      assert.equal(exhaustedJob.state, 'failed');
      assert.equal(exhaustedJob.attempt, 3);
      assert.equal(exhaustedJob.error.code, 'INTERNAL_WORKER_ERROR');
      assert.equal(exhaustedJob.error.retryable, false);
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, 'job_retry_exhaust_1').state,
        'released',
      );
      assert.equal(h.repo.listJobAttempts(TENANT_A_ID, 'job_retry_exhaust_1').length, 3);
      assert.equal(
        h.repo.listUsageEntries(TENANT_A_ID, 'job_retry_exhaust_1').length,
        3, // 3 operational cpu_seconds entries, 0 billable entries
      );
      const exhaustedOutbox = h.repo.listOutboxEvents(TENANT_A_ID, 'job_retry_exhaust_1');
      assert.equal(exhaustedOutbox.length, 1);
      assert.equal(exhaustedOutbox[0].event_type, 'job.failed');

      // Case B: Non-retryable error (SANDBOX_SECURITY_VIOLATION) fails immediately on Attempt 1
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_nonretry_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const nonRetryRes = await worker.claimAndProcessNextJob({
        simulateError: {
          stage: 'rendering',
          code: 'SANDBOX_SECURITY_VIOLATION',
          message: 'Blocked network egress attempt inside sandbox',
        },
      });
      assert.equal(nonRetryRes.status, 'failed');
      const nonRetryJob = h.repo.getJob(TENANT_A_ID, 'job_nonretry_1');
      assert.equal(nonRetryJob.state, 'failed');
      assert.equal(nonRetryJob.attempt, 1);
      assert.equal(nonRetryJob.error.code, 'SANDBOX_SECURITY_VIOLATION');
      assert.equal(nonRetryJob.error.retryable, false);

      // Case C: Invalid state transition (`preparing -> verifying` skipping `rendering` & `encoding`) throws InvalidStateTransitionError
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_invalid_trans_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const transLease = h.dispatcher.claimNextJob({ workerId: 'w_trans' });
      assert.ok(transLease);
      assert.throws(
        () =>
          h.dispatcher.advanceJobStage({
            tenantId: TENANT_A_ID,
            jobId: transLease.jobId,
            attemptId: transLease.attemptId,
            leaseEpoch: transLease.leaseEpoch,
            targetState: 'verifying',
          }),
        (err) => err instanceof InvalidStateTransitionError,
      );

      // Now cancel `job_invalid_trans_1` while active (`preparing -> cancel_requested`) and let reaper finalize `canceled` (AMB-003)
      const cancelRes = h.repo.cancelJob(TENANT_A_ID, 'job_invalid_trans_1', {
        now: h.dbClock(),
      });
      assert.equal(cancelRes.body.state, 'cancel_requested');
      h.advanceClockMs(61_000);
      const cancelReclaimed = h.dispatcher.reclaimExpiredLeases();
      assert.equal(cancelReclaimed.length, 1);
      assert.equal(cancelReclaimed[0].newState, 'canceled');
      assert.equal(h.repo.getJob(TENANT_A_ID, 'job_invalid_trans_1').state, 'canceled');
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, 'job_invalid_trans_1').state,
        'released',
      );

      // Case D: Asset revocation mid-render blocks publication (`ASSET_REVOKED`)
      h.repo.admitJob(TENANT_B_ID, {
        id: 'job_asset_revoked_1',
        request: {
          kind: 'render',
          compositionId: 'cmp_p402_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const revokeLease = h.dispatcher.claimNextJob({ workerId: 'w_revoke' });
      assert.ok(revokeLease);
      assert.equal(revokeLease.tenantId, TENANT_B_ID);

      const revokeWorkerRes = await worker.executeLeasedJob(revokeLease, {
        ignoreAbortSignalForStalePublishTest: true,
        onBeforeStage: async (stage) => {
          if (stage === 'verifying') {
            // Tenant B deletes referenced image asset `ast_img_hero` right before verification/publication
            h.repo.deleteAsset(TENANT_B_ID, 'ast_img_hero', h.dbClock());
          }
        },
      });
      assert.equal(revokeWorkerRes.status, 'aborted_or_fenced');
      const revokedJob = h.repo.getJob(TENANT_B_ID, 'job_asset_revoked_1');
      assert.equal(revokedJob.state, 'failed');
      assert.equal(revokedJob.error.code, 'ASSET_REVOKED');
      assert.equal(h.repo.listJobArtifacts(TENANT_B_ID, 'job_asset_revoked_1').length, 0);
    } finally {
      h.cleanup();
    }
  });
});

function previewKeyKeyId(admitted) {
  return admitted.id;
}
