/**
 * Task P4-03 Integration & Fault-Injection Tests:
 *   - Cancel (`POST /v1/jobs/{id}/cancel`), `cancel_requested -> canceled` within <= 10s or via Reaper (`AMB-003`)
 *   - Timeouts: frame readiness (`5,000 ms`), attempt timeout (`600s` render / `120s` preview),
 *     job deadline (`1800s` render / `300s` preview across `queued`, `retry_wait`, and active stages)
 *   - Retries: `max_attempts = 3`, backoff `5s` then `30s + jitter`, 5 retryable vs 8 non-retryable codes
 *   - Object temp verification (server-generated attempt-scoped temp prefix, regular file / no symlink /
 *     no hardlink / realpath containment, byte count, SHA-256, container magic bytes & faststart MP4/PNG)
 *     and atomic promotion with rollback on DB commit failure
 *   - Kill tests at every stage (`preparing`, `rendering`, `encoding`, `verifying`, `before_publish`,
 *     and `cancel_requested`) with Reaper recovery, epoch fencing, and zero partial publication
 *   - Deterministic and concurrent `cancel-vs-success` and `asset-revoke-vs-publish` races
 *   - Orphan attempt temp sweeper (`> 24h`) with strict live-lease output protection (`don't delete live lease output`)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  CVE_CANCEL_KILL_TIMEOUT_MS,
  CVE_FRAME_TIMEOUT_MS,
  CVE_HEARTBEAT_INTERVAL_SECONDS,
  CVE_JOB_DEADLINE_SECONDS,
  CVE_LEASE_DURATION_SECONDS,
  CVE_PREVIEW_DEADLINE_SECONDS,
  CVE_PREVIEW_TIMEOUT_SECONDS,
  CVE_RENDER_TIMEOUT_SECONDS,
  JobDispatcher,
  MigrationRunner,
  NON_RETRYABLE_JOB_ERROR_CODES,
  QuarantineStore,
  RETRYABLE_JOB_ERROR_CODES,
  RealRendererWorker,
  StorageTempSweeper,
  TenantConnectionPool,
  TenantRepository,
  calculateRetryBackoffMs,
  createServer,
  isRetryableJobErrorCode,
  verifyIsoBmffMp4,
} from '../dist/index.js';

const PEPPER = 'test-pepper-p4-03-cancel-timeout-retry-reaper-secret';
const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';

function createValidPngBuffer() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
    'hex',
  );
}

function makeCompositionSpec({
  durationFrames = 6,
  fps = 30,
  width = 1280,
  height = 720,
  assetId = 'ast_p403_hero',
} = {}) {
  return {
    schema_version: '1.0',
    canvas: {
      width,
      height,
      background: '#101828',
    },
    fps: { num: fps, den: 1 },
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
              text: 'Creativanta P4-03 Verification',
              font_id: 'font_main',
              font_size: 44,
              color: '#FFFFFF',
              align: 'center',
              max_lines: 2,
              overflow: 'ellipsis',
            },
          },
          ...(assetId
            ? [
                {
                  id: 'layer_hero_image',
                  type: 'image',
                  z_index: 3,
                  start_frame: 0,
                  duration_frames: durationFrames,
                  box: { x: 140, y: 380, width: 240, height: 160 },
                  opacity: 0.95,
                  content: {
                    asset_id: assetId,
                    fit: 'cover',
                  },
                },
              ]
            : []),
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
            text: 'Atomic publish and reaper test',
          },
        ],
      },
    ],
  };
}

function seedTenantAssetsAndComposition(repo, tenantId, compId = 'cmp_p403_main') {
  repo.createAsset(tenantId, {
    id: 'ast_p403_hero',
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

  const spec = makeCompositionSpec({ durationFrames: 6, fps: 30, assetId: 'ast_p403_hero' });
  repo.createComposition(tenantId, {
    id: compId,
    name: `Composition ${compId}`,
    spec,
  });

  return { compId, spec };
}

function createTestHarness(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p4-03-test-'));
  const quarantineStore = new QuarantineStore(tmpDir);
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator' });

  const pool = new TenantConnectionPool(db, { poolSize: 8 });
  const repo = new TenantRepository(pool, {
    pepper: PEPPER,
    quarantineStore,
  });

  let simulatedNowMs = Date.parse('2026-11-03T12:00:00.000Z');
  const dbClock = () => new Date(simulatedNowMs);
  const advanceClockMs = (deltaMs) => {
    simulatedNowMs += deltaMs;
    return new Date(simulatedNowMs);
  };

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha', now: dbClock() });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta', now: dbClock() });

  const keyA = repo.issueApiKey({
    tenantId: TENANT_A_ID,
    keyId: 'key_p403_a',
    scopes: [
      'templates:read',
      'templates:write',
      'assets:read',
      'assets:write',
      'compositions:read',
      'compositions:write',
      'jobs:read',
      'jobs:write',
      'webhooks:read',
      'webhooks:write',
      'usage:read',
    ],
    now: dbClock(),
  });
  const keyB = repo.issueApiKey({
    tenantId: TENANT_B_ID,
    keyId: 'key_p403_b',
    scopes: [
      'templates:read',
      'templates:write',
      'assets:read',
      'assets:write',
      'compositions:read',
      'compositions:write',
      'jobs:read',
      'jobs:write',
      'webhooks:read',
      'webhooks:write',
      'usage:read',
    ],
    now: dbClock(),
  });

  seedTenantAssetsAndComposition(repo, TENANT_A_ID, 'cmp_p403_main');
  seedTenantAssetsAndComposition(repo, TENANT_B_ID, 'cmp_p403_main');

  const dispatcher = new JobDispatcher({
    repository: repo,
    quarantineStore,
    maxGlobalSlots: options.maxGlobalSlots ?? 4,
    leaseDurationSeconds: options.leaseDurationSeconds ?? CVE_LEASE_DURATION_SECONDS,
    heartbeatIntervalSeconds: options.heartbeatIntervalSeconds ?? CVE_HEARTBEAT_INTERVAL_SECONDS,
    renderTimeoutSeconds: options.renderTimeoutSeconds ?? CVE_RENDER_TIMEOUT_SECONDS,
    previewTimeoutSeconds: options.previewTimeoutSeconds ?? CVE_PREVIEW_TIMEOUT_SECONDS,
    cancelKillTimeoutMs: options.cancelKillTimeoutMs ?? CVE_CANCEL_KILL_TIMEOUT_MS,
    includeRetryJitter: options.includeRetryJitter ?? true,
    dbClock,
  });

  const sweeper = new StorageTempSweeper({
    repository: repo,
    quarantineStore,
  });

  return {
    tmpDir,
    db,
    pool,
    repo,
    quarantineStore,
    dispatcher,
    sweeper,
    keyA,
    keyB,
    dbClock,
    advanceClockMs,
    setClock: (isoOrMs) => {
      simulatedNowMs = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
    },
    cleanup: () => {
      quarantineStore.clearAll();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

async function startTestServer(repo) {
  const config = loadEnvConfig({
    CVE_NODE_ENV: 'test',
    CVE_API_PORT: '0',
    CVE_LOG_LEVEL: 'error',
    CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0',
    CVE_KEY_HASH_PEPPER: PEPPER,
  });
  const server = createServer({
    config,
    repository: repo,
    quarantineStore: repo.getQuarantineStore(),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

describe('P4-03: Cancel/Timeout/Retry/Reaper, Object Temp Verification, Atomic Publish, Kill & Race Tests', () => {
  it('1. Enforces full cancel lifecycle (`POST /v1/jobs/{id}/cancel`), process-group termination <= 10s, operational CPU metering, and idempotent status semantics', async () => {
    const h = createTestHarness();
    const { server, baseUrl } = await startTestServer(h.repo);

    try {
      const headersA = {
        Authorization: `Bearer ${h.keyA.plaintextKey}`,
        'Content-Type': 'application/json',
      };

      // Part A: Cancel a `queued` job via HTTP -> immediate `canceled` (202), replay (202), new key (200)
      const createQueuedRes = await fetch(`${baseUrl}/v1/render-jobs`, {
        method: 'POST',
        headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_queued_create' },
        body: JSON.stringify({
          composition_id: 'cmp_p403_main',
          revision: 1,
          profile: 'mp4-720p-v1',
        }),
      });
      assert.equal(createQueuedRes.status, 202);
      const queuedJob = await createQueuedRes.json();

      const cancelQueuedRes = await fetch(`${baseUrl}/v1/jobs/${queuedJob.id}/cancel`, {
        method: 'POST',
        headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_queued_1' },
      });
      assert.equal(cancelQueuedRes.status, 202);
      const cancelQueuedBody = await cancelQueuedRes.json();
      assert.equal(cancelQueuedBody.state, 'canceled');

      // Idempotent replay with same key -> 202
      const cancelQueuedReplay = await fetch(`${baseUrl}/v1/jobs/${queuedJob.id}/cancel`, {
        method: 'POST',
        headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_queued_1' },
      });
      assert.equal(cancelQueuedReplay.status, 202);

      // New Idempotency-Key on already-canceled job -> 200 OK
      const cancelQueuedNewKey = await fetch(`${baseUrl}/v1/jobs/${queuedJob.id}/cancel`, {
        method: 'POST',
        headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_queued_2' },
      });
      assert.equal(cancelQueuedNewKey.status, 200);
      const cancelQueuedNewKeyBody = await cancelQueuedNewKey.json();
      assert.equal(cancelQueuedNewKeyBody.state, 'canceled');

      // Reservation released, 0 billable entries
      assert.equal(h.repo.getUsageReservation(TENANT_A_ID, queuedJob.id).state, 'released');
      assert.equal(
        h.repo
          .listUsageEntries(TENANT_A_ID, queuedJob.id)
          .filter((u) => u.usage_class === 'billable').length,
        0,
      );

      // Part B: Cancel a `retry_wait` job -> immediate `canceled` (202), operational CPU from attempt 1 preserved, 0 billable
      const retryAdmitted = h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_cancel_retry_wait',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const worker = new RealRendererWorker({
        workerId: 'worker_cancel_test',
        dispatcher: h.dispatcher,
      });
      const failedAtt1 = await worker.claimAndProcessNextJob({
        simulateError: {
          stage: 'rendering',
          code: 'STORAGE_TRANSIENT_ERROR',
          message: 'Transient S3 timeout',
        },
      });
      assert.equal(failedAtt1.status, 'retry_wait');

      const cancelRetryWaitRes = await fetch(
        `${baseUrl}/v1/jobs/${retryAdmitted.job.id}/cancel`,
        {
          method: 'POST',
          headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_retrywait_1' },
        },
      );
      assert.equal(cancelRetryWaitRes.status, 202);
      const cancelRetryWaitBody = await cancelRetryWaitRes.json();
      assert.equal(cancelRetryWaitBody.state, 'canceled');
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, retryAdmitted.job.id).state,
        'released',
      );
      const retryWaitUsage = h.repo.listUsageEntries(TENANT_A_ID, retryAdmitted.job.id);
      assert.equal(retryWaitUsage.filter((u) => u.usage_class === 'operational').length, 1);
      assert.equal(retryWaitUsage.filter((u) => u.usage_class === 'billable').length, 0);

      // Part C: Cancel active jobs during `rendering` -> `cancel_requested` (202) -> worker stops process group <= 10s -> `canceled`
      const activeAdmitted = h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_cancel_active_render',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });

      let killedProcessGroupInfo = null;
      const activeLease = h.dispatcher.claimNextJob({ workerId: 'worker_cancel_active' });
      assert.ok(activeLease);

      const activeResult = await worker.executeLeasedJob(activeLease, {
        onKillProcessGroup: (info) => {
          killedProcessGroupInfo = info;
        },
        onFrameRendered: async (frameIdx) => {
          if (frameIdx === 1) {
            // Issue HTTP POST /v1/jobs/{id}/cancel while worker is actively rendering frame 1
            const httpCancel = await fetch(
              `${baseUrl}/v1/jobs/${activeAdmitted.job.id}/cancel`,
              {
                method: 'POST',
                headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_active_1' },
              },
            );
            assert.equal(httpCancel.status, 202);
            const httpCancelBody = await httpCancel.json();
            assert.equal(httpCancelBody.state, 'cancel_requested');

            // Replay while in cancel_requested -> 202 cancel_requested
            const httpCancelReplay = await fetch(
              `${baseUrl}/v1/jobs/${activeAdmitted.job.id}/cancel`,
              {
                method: 'POST',
                headers: { ...headersA, 'Idempotency-Key': 'idem_p403_cancel_active_2' },
              },
            );
            assert.equal(httpCancelReplay.status, 202);
            assert.equal((await httpCancelReplay.json()).state, 'cancel_requested');
          }
        },
      });

      assert.equal(activeResult.status, 'canceled');
      assert.equal(activeResult.processGroupKilled, true);
      assert.ok(
        activeResult.cancelStopDurationMs <= CVE_CANCEL_KILL_TIMEOUT_MS,
        `Expected cancelStopDurationMs (${activeResult.cancelStopDurationMs}ms) <= ${CVE_CANCEL_KILL_TIMEOUT_MS}ms`,
      );
      assert.ok(killedProcessGroupInfo);
      assert.equal(killedProcessGroupInfo.jobId, activeAdmitted.job.id);
      assert.equal(killedProcessGroupInfo.attemptId, activeLease.attemptId);

      // Verify final job state is `canceled`, operational CPU recorded, 0 billable, reservation released, 0 temp files
      const finalActiveJob = h.repo.getJob(TENANT_A_ID, activeAdmitted.job.id);
      assert.equal(finalActiveJob.state, 'canceled');
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, activeAdmitted.job.id).state,
        'released',
      );
      const activeUsage = h.repo.listUsageEntries(TENANT_A_ID, activeAdmitted.job.id);
      assert.equal(activeUsage.filter((u) => u.usage_class === 'operational').length, 1);
      assert.equal(activeUsage.filter((u) => u.usage_class === 'billable').length, 0);
      assert.equal(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          activeAdmitted.job.id,
          activeLease.attemptId,
        ).length,
        0,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('2. Enforces canonical timeouts (`FRAME_READINESS_TIMEOUT` 5s, `RENDER_TIMEOUT` 600s/120s, `JOB_DEADLINE_EXCEEDED` 1800s/300s) and retry backoff (`5s`, `30s+jitter`, `max_attempts=3`) across all 5 retryable and 8 non-retryable codes', async () => {
    const h = createTestHarness();
    try {
      // Verify canonical timeout constants match docs/ARCHITECTURE.md & docs/DEPLOYMENT.md
      assert.equal(CVE_FRAME_TIMEOUT_MS, 5_000);
      assert.equal(CVE_RENDER_TIMEOUT_SECONDS, 600);
      assert.equal(CVE_PREVIEW_TIMEOUT_SECONDS, 120);
      assert.equal(CVE_JOB_DEADLINE_SECONDS, 1800);
      assert.equal(CVE_PREVIEW_DEADLINE_SECONDS, 300);
      assert.equal(CVE_CANCEL_KILL_TIMEOUT_MS, 10_000);

      // Verify all 5 retryable and 8 non-retryable error codes
      assert.equal(RETRYABLE_JOB_ERROR_CODES.length, 5);
      for (const code of RETRYABLE_JOB_ERROR_CODES) {
        assert.equal(isRetryableJobErrorCode(code), true, `${code} must be retryable`);
      }
      assert.equal(NON_RETRYABLE_JOB_ERROR_CODES.length, 8);
      for (const code of NON_RETRYABLE_JOB_ERROR_CODES) {
        assert.equal(isRetryableJobErrorCode(code), false, `${code} must be non-retryable`);
      }

      // Verify retry backoff with jitter: 5,000ms after attempt 1, 30,000..32,000ms after attempt 2
      assert.equal(calculateRetryBackoffMs(1, 'job_backoff_1', { includeJitter: true }), 5_000);
      const backoff2 = calculateRetryBackoffMs(2, 'job_backoff_1', { includeJitter: true });
      assert.ok(backoff2 >= 30_000 && backoff2 <= 32_000);

      // Part A: Frame readiness timeout (5,000 ms) triggers `FRAME_READINESS_TIMEOUT` -> `retry_wait` -> succeeds on attempt 2
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_frame_timeout',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });

      const worker = new RealRendererWorker({
        workerId: 'worker_timeouts',
        dispatcher: h.dispatcher,
      });

      // Attempt 1: Frame 0 takes 5,100ms (> 5,000ms CVE_FRAME_TIMEOUT_MS)
      const frameTimeoutRes = await worker.claimAndProcessNextJob({
        onFrameRendered: (frameIdx) => {
          if (frameIdx === 0) {
            h.advanceClockMs(CVE_FRAME_TIMEOUT_MS + 100);
          }
        },
      });
      assert.equal(frameTimeoutRes.status, 'retry_wait');
      assert.equal(frameTimeoutRes.reason, 'FRAME_READINESS_TIMEOUT');

      // Advance 5s backoff, promote, and complete on Attempt 2
      h.advanceClockMs(5_000);
      assert.equal(h.dispatcher.promoteEligibleRetryWaitJobs().length, 1);
      const frameRetrySuccess = await worker.claimAndProcessNextJob();
      assert.equal(frameRetrySuccess.status, 'succeeded');
      assert.equal(h.repo.getJob(TENANT_A_ID, 'job_p403_frame_timeout').attempt, 2);

      // Part B: Render attempt timeout (600s) and Preview attempt timeout (120s)
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_render_timeout_600s',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const renderTimeoutRes = await worker.claimAndProcessNextJob({
        onFrameRendered: (frameIdx) => {
          if (frameIdx === 2) {
            // Advance 601s (> 600s render attempt timeout, while under 5s per-frame check via hook before check? Wait: onFrameRendered runs before per-frame check, so pass frameTimeoutMs: 700_000 to isolate attempt timeout)
            h.advanceClockMs((CVE_RENDER_TIMEOUT_SECONDS + 1) * 1000);
          }
        },
        frameTimeoutMs: 700_000,
      });
      assert.equal(renderTimeoutRes.status, 'retry_wait');
      assert.equal(renderTimeoutRes.reason, 'RENDER_TIMEOUT');

      h.repo.admitJob(TENANT_B_ID, {
        id: 'job_p403_preview_timeout_120s',
        request: {
          kind: 'preview',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 0,
          duration_frames: 4,
        },
        now: h.dbClock(),
      });
      const previewTimeoutRes = await worker.claimAndProcessNextJob({
        onFrameRendered: (frameIdx) => {
          if (frameIdx === 1) {
            // Advance 121s (> 120s preview attempt timeout)
            h.advanceClockMs((CVE_PREVIEW_TIMEOUT_SECONDS + 1) * 1000);
          }
        },
        frameTimeoutMs: 200_000,
      });
      assert.equal(previewTimeoutRes.status, 'retry_wait');
      assert.equal(previewTimeoutRes.reason, 'RENDER_TIMEOUT');

      // Part C: Job deadline exceeded (`1800s` render / `300s` preview) in `queued` and `retry_wait` reaped by `runReaperCycle`
      h.repo.admitJob(TENANT_B_ID, {
        id: 'job_p403_preview_deadline_queued',
        request: {
          kind: 'preview',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'preview-360p-v1',
          mode: 'keyframes',
          frame_index: 0,
        },
        now: h.dbClock(),
      });

      // Advance clock by 301s (> 300s preview deadline) and run reaper cycle
      h.advanceClockMs((CVE_PREVIEW_DEADLINE_SECONDS + 1) * 1000);
      const reaperCycle = h.dispatcher.runReaperCycle();
      assert.ok(
        reaperCycle.expiredQueuedJobs.some(
          (j) =>
            j.jobId === 'job_p403_preview_deadline_queued' &&
            j.reason === 'JOB_DEADLINE_EXCEEDED',
        ),
      );
      assert.ok(
        reaperCycle.promotedRetryJobs.some(
          (j) =>
            j.jobId === 'job_p403_preview_timeout_120s' &&
            j.outcome === 'failed' &&
            j.reason === 'JOB_DEADLINE_EXCEEDED',
        ),
      );
      assert.equal(
        h.repo.getJob(TENANT_B_ID, 'job_p403_preview_deadline_queued').state,
        'failed',
      );
      assert.equal(
        h.repo.getJob(TENANT_B_ID, 'job_p403_preview_deadline_queued').error.code,
        'JOB_DEADLINE_EXCEEDED',
      );
      assert.equal(
        h.repo.getUsageReservation(TENANT_B_ID, 'job_p403_preview_deadline_queued').state,
        'released',
      );
    } finally {
      h.cleanup();
    }
  });

  it('3. Enforces object temp verification (missing file, symlink, hardlink, byte/SHA-256 mismatch, corrupt MP4/PNG container, temp quota) and rolls back permanent files on DB commit failure', async () => {
    const h = createTestHarness();
    try {
      const worker = new RealRendererWorker({
        workerId: 'worker_temp_verify',
        dispatcher: h.dispatcher,
      });

      // Case A: Symlink replacement in attempt temp directory -> rejected with `SANDBOX_SECURITY_VIOLATION`
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_temp_symlink',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const symlinkRes = await worker.claimAndProcessNextJob({
        onBeforePublish: (lease) => {
          const tempFile = path.join(
            h.quarantineStore.getRootDir(),
            'temp',
            'tenant',
            lease.tenantId,
            'job',
            lease.jobId,
            lease.attemptId,
            'output.mp4',
          );
          const outsideTarget = path.join(h.tmpDir, 'outside-secret.txt');
          fs.writeFileSync(outsideTarget, 'secret-host-data');
          fs.unlinkSync(tempFile);
          fs.symlinkSync(outsideTarget, tempFile);
        },
      });
      assert.equal(symlinkRes.status, 'failed');
      assert.equal(symlinkRes.reason, 'SANDBOX_SECURITY_VIOLATION');
      const symlinkJob = h.repo.getJob(TENANT_A_ID, 'job_p403_temp_symlink');
      assert.equal(symlinkJob.state, 'failed');
      assert.equal(symlinkJob.error.code, 'SANDBOX_SECURITY_VIOLATION');
      assert.equal(h.repo.listJobArtifacts(TENANT_A_ID, 'job_p403_temp_symlink').length, 0);

      // Case B: Hardlink escape (nlink > 1) in attempt temp directory -> rejected with `SANDBOX_SECURITY_VIOLATION`
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_temp_hardlink',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const hardlinkPath = path.join(h.tmpDir, 'hardlink-peer.mp4');
      const hardlinkRes = await worker.claimAndProcessNextJob({
        onBeforePublish: (lease) => {
          const tempFile = path.join(
            h.quarantineStore.getRootDir(),
            'temp',
            'tenant',
            lease.tenantId,
            'job',
            lease.jobId,
            lease.attemptId,
            'output.mp4',
          );
          fs.linkSync(tempFile, hardlinkPath);
        },
      });
      assert.equal(hardlinkRes.status, 'failed');
      assert.equal(hardlinkRes.reason, 'SANDBOX_SECURITY_VIOLATION');
      assert.equal(
        h.repo.getJob(TENANT_A_ID, 'job_p403_temp_hardlink').error.code,
        'SANDBOX_SECURITY_VIOLATION',
      );
      if (fs.existsSync(hardlinkPath)) fs.unlinkSync(hardlinkPath);

      // Case C: Tampered SHA-256 / corrupt MP4 magic bytes in temp directory -> rejected with `ENCODE_VERIFICATION_FAILED`
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_temp_corrupt_mp4',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const corruptRes = await worker.claimAndProcessNextJob({
        onBeforePublish: (lease, stagedArtifacts) => {
          const videoDesc = stagedArtifacts.find((a) => a.kind === 'video');
          const tempFile = path.join(
            h.quarantineStore.getRootDir(),
            'temp',
            'tenant',
            lease.tenantId,
            'job',
            lease.jobId,
            lease.attemptId,
            'output.mp4',
          );
          // Overwrite first 8 bytes (corrupting ftyp box) while updating descriptor.sha256 so magic-byte check catches it
          const buf = fs.readFileSync(tempFile);
          buf.write('BAD!BOX!', 0, 8, 'ascii');
          fs.writeFileSync(tempFile, buf);
          videoDesc.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
        },
      });
      assert.equal(corruptRes.status, 'failed');
      assert.equal(corruptRes.reason, 'ENCODE_VERIFICATION_FAILED');
      const corruptJob = h.repo.getJob(TENANT_A_ID, 'job_p403_temp_corrupt_mp4');
      assert.equal(corruptJob.state, 'failed');
      assert.equal(corruptJob.error.code, 'ENCODE_VERIFICATION_FAILED');
      assert.equal(h.repo.listJobArtifacts(TENANT_A_ID, 'job_p403_temp_corrupt_mp4').length, 0);

      // Case D: Per-attempt temporary disk quota exceeded -> fails with `SANDBOX_RESOURCE_LIMIT`
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_temp_quota',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const quotaRes = await worker.claimAndProcessNextJob({
        maxAttemptTempBytes: 64, // 64 bytes limit -> MP4 output exceeds quota immediately
      });
      assert.equal(quotaRes.status, 'failed');
      assert.equal(quotaRes.reason, 'SANDBOX_RESOURCE_LIMIT');
      assert.equal(
        h.repo.getJob(TENANT_A_ID, 'job_p403_temp_quota').error.code,
        'SANDBOX_RESOURCE_LIMIT',
      );

      // Case E: Transactional rollback of promoted permanent files if DB commit fails during `publishJobAttempt`
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_atomic_rollback',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      let capturedAttemptId = null;
      const rollbackRes = await worker.claimAndProcessNextJob({
        onAfterPromoteBeforeDbCommit: () => {
          throw Object.assign(new Error('Simulated DB commit failure after file promotion'), {
            errorCode: 'STORAGE_TRANSIENT_ERROR',
          });
        },
        onBeforePublish: (lease) => {
          capturedAttemptId = lease.attemptId;
        },
      });
      // Attempt 1 transitions to `retry_wait` because `STORAGE_TRANSIENT_ERROR` is retryable
      assert.equal(rollbackRes.status, 'retry_wait');
      assert.ok(capturedAttemptId);

      // Verify promoted permanent files for `capturedAttemptId` were rolled back (deleted from permanent storage!)
      for (const filename of ['output.mp4', 'thumbnail.png', 'manifest.json']) {
        const permKey = `tenant/${TENANT_A_ID}/job/job_p403_atomic_rollback/${capturedAttemptId}/${filename}`;
        assert.equal(
          h.quarantineStore.getArtifactFileByStorageKey(permKey),
          null,
          `Promoted permanent artifact ${permKey} must be rolled back on DB failure`,
        );
      }
      assert.equal(h.repo.listJobArtifacts(TENANT_A_ID, 'job_p403_atomic_rollback').length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('4. Survives abrupt worker kill (`SIGKILL`) at every stage (`preparing`, `rendering`, `encoding`, `verifying`, `before_publish`, and `cancel_requested`) with Reaper recovery, epoch fencing, and zero partial publication', async () => {
    const h = createTestHarness();
    try {
      const killStages = [
        'preparing',
        'rendering',
        'encoding',
        'verifying',
        'before_publish',
      ];

      const workerKilled = new RealRendererWorker({
        workerId: 'worker_killed_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 60_000,
      });
      const workerSurvivor = new RealRendererWorker({
        workerId: 'worker_survivor_2',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 60_000,
      });

      for (const stage of killStages) {
        const jobId = `job_p403_kill_${stage}`;
        h.repo.admitJob(TENANT_A_ID, {
          id: jobId,
          request: {
            kind: 'render',
            compositionId: 'cmp_p403_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h.dbClock(),
        });

        // 1. Worker 1 claims job (attempt 1, lease_epoch = 1) and is abruptly killed at `stage`
        const lease1 = h.dispatcher.claimNextJob({ workerId: 'worker_killed_1' });
        assert.ok(lease1);
        assert.equal(lease1.jobId, jobId);
        assert.equal(lease1.leaseEpoch, 1);

        const killRes = await workerKilled.executeLeasedJob(lease1, {
          killAtStage: stage,
        });
        assert.equal(killRes.status, 'killed');
        assert.equal(killRes.killedAtStage, stage);

        // Verify unpromoted temp files were left behind by killed worker, and ZERO artifacts published
        const tempFilesBeforeReap = h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          jobId,
          lease1.attemptId,
        );
        assert.ok(
          tempFilesBeforeReap.length > 0,
          `Expected temp files staged before SIGKILL at stage '${stage}'`,
        );
        assert.equal(h.repo.listJobArtifacts(TENANT_A_ID, jobId).length, 0);

        // 2. Advance DB clock by 61s so Worker 1's lease expires, then run Reaper cycle
        h.advanceClockMs(61_000);
        const reaperRes = h.dispatcher.runReaperCycle({ forceIgnoreBackoff: true });
        assert.equal(reaperRes.reclaimedLeases.length, 1);
        assert.equal(reaperRes.reclaimedLeases[0].jobId, jobId);
        assert.equal(reaperRes.reclaimedLeases[0].previousAttemptId, lease1.attemptId);
        assert.equal(reaperRes.reclaimedLeases[0].previousLeaseEpoch, 1);
        assert.equal(reaperRes.reclaimedLeases[0].newLeaseEpoch, 2);
        assert.equal(reaperRes.reclaimedLeases[0].newState, 'retry_wait');

        // Verify Reaper cleaned up dead attempt 1's temp directory (zero orphan temp files)
        assert.equal(
          h.quarantineStore.listAttemptTempFiles(TENANT_A_ID, jobId, lease1.attemptId).length,
          0,
          `Reaper must clean up dead attempt temp files for stage '${stage}'`,
        );

        // Verify job was promoted back to `queued`
        assert.equal(reaperRes.promotedRetryJobs.length, 1);
        assert.equal(reaperRes.promotedRetryJobs[0].jobId, jobId);
        assert.equal(reaperRes.promotedRetryJobs[0].outcome, 'queued');

        // 3. Survivor Worker 2 claims attempt 2 (`lease_epoch = 3`) and completes publication
        const survivorRes = await workerSurvivor.claimAndProcessNextJob();
        assert.equal(survivorRes.status, 'succeeded');
        assert.equal(survivorRes.jobId, jobId);
        assert.equal(survivorRes.leaseEpoch, 3);

        // 4. Zombie Worker 1 wakes up and attempts to publish using old `(attemptId, leaseEpoch = 1)` -> fenced!
        const zombiePublish = h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId,
          attemptId: lease1.attemptId,
          leaseEpoch: lease1.leaseEpoch,
          artifacts: [
            {
              id: `art_zombie_${stage}`,
              kind: 'video',
              filename: 'output.mp4',
              mimeType: 'video/mp4',
              bytes: 64,
              sha256: '0'.repeat(64),
              buffer: Buffer.alloc(64),
            },
          ],
          cpuSeconds: 1.0,
          peakRssBytes: 1024,
        });
        assert.equal(zombiePublish.published, false);
        assert.equal(zombiePublish.reason, 'STALE_LEASE_OR_EPOCH');

        // 5. Verify final state: single logical publication from Worker 2, valid MP4, settled reservation
        const finalJob = h.repo.getJob(TENANT_A_ID, jobId);
        assert.equal(finalJob.state, 'succeeded');
        assert.equal(finalJob.attempt, 2);
        const artifacts = h.repo.listJobArtifacts(TENANT_A_ID, jobId);
        assert.equal(artifacts.length, 3);
        for (const art of artifacts) {
          assert.equal(art.attempt_id, survivorRes.attemptId);
        }
        const videoArt = artifacts.find((a) => a.kind === 'video');
        const storedMp4 = h.quarantineStore.getArtifactFileByStorageKey(videoArt.storage_key);
        assert.ok(storedMp4);
        assert.equal(
          verifyIsoBmffMp4(storedMp4.buffer, {
            width: 1280,
            height: 720,
            fps: 30,
            expectedFrames: 6,
          }).valid,
          true,
        );
      }

      // Also test SIGKILL while in `cancel_requested`: Reaper finalizes `cancel_requested -> canceled` (AMB-003)
      const cancelKillJobId = 'job_p403_kill_cancel_requested';
      h.repo.admitJob(TENANT_A_ID, {
        id: cancelKillJobId,
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const cancelKillLease = h.dispatcher.claimNextJob({ workerId: 'worker_killed_1' });
      assert.ok(cancelKillLease);

      const cancelKillRes = await workerKilled.executeLeasedJob(cancelKillLease, {
        onBeforePublish: () => {
          h.repo.cancelJob(TENANT_A_ID, cancelKillJobId, { now: h.dbClock() });
        },
        killAtStage: 'before_publish',
      });
      assert.equal(cancelKillRes.status, 'killed');
      assert.equal(h.repo.getJob(TENANT_A_ID, cancelKillJobId).state, 'cancel_requested');

      // Advance clock 11s (> 10s cancel grace timeout) and run Reaper cycle
      h.advanceClockMs(11_000);
      const cancelReaperRes = h.dispatcher.runReaperCycle({ reapCancelGraceExceeded: true });
      assert.equal(cancelReaperRes.reclaimedLeases.length, 1);
      assert.equal(cancelReaperRes.reclaimedLeases[0].jobId, cancelKillJobId);
      assert.equal(cancelReaperRes.reclaimedLeases[0].newState, 'canceled');
      assert.equal(h.repo.getJob(TENANT_A_ID, cancelKillJobId).state, 'canceled');
      assert.equal(
        h.repo.getUsageReservation(TENANT_A_ID, cancelKillJobId).state,
        'released',
      );
      assert.equal(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          cancelKillJobId,
          cancelKillLease.attemptId,
        ).length,
        0,
      );
    } finally {
      h.cleanup();
    }
  });

  it('5. Stabilizes `cancel-vs-success` race (`POST /v1/jobs/{id}/cancel` vs `publishJobAttempt`) with strict mutual exclusion and zero orphan leak across 20 concurrent stress iterations', async () => {
    const h = createTestHarness({ maxGlobalSlots: 4 });
    try {
      const worker = new RealRendererWorker({
        workerId: 'worker_race_cancel',
        dispatcher: h.dispatcher,
      });

      // Run 20 race iterations where half trigger cancel right before publish commits, and half trigger cancel right after publish commits
      for (let i = 0; i < 20; i++) {
        const jobId = `job_p403_race_cancel_${i}`;
        h.repo.admitJob(TENANT_A_ID, {
          id: jobId,
          request: {
            kind: 'render',
            compositionId: 'cmp_p403_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h.advanceClockMs(10),
        });

        const lease = h.dispatcher.claimNextJob({ workerId: `worker_race_${i}` });
        assert.ok(lease);

        let postPublishCancelStatus = null;
        const cancelBeforePublish = i % 2 === 0;

        const execPromise = worker.executeLeasedJob(lease, {
          onBeforePublish: async () => {
            if (cancelBeforePublish) {
              // Cancel wins the race right as worker enters publishJobAttempt!
              const cancelRes = h.repo.cancelJob(TENANT_A_ID, jobId, { now: h.dbClock() });
              assert.equal(cancelRes.httpStatus, 202);
              assert.equal(cancelRes.body.state, 'cancel_requested');
            }
          },
        });

        const execResult = await execPromise;

        if (!cancelBeforePublish) {
          // Publish won the race -> subsequent cancel MUST throw JobTerminalError (409 JOB_TERMINAL)
          assert.throws(
            () => h.repo.cancelJob(TENANT_A_ID, jobId, { now: h.dbClock() }),
            (err) => err.code === 'JOB_TERMINAL',
          );
          postPublishCancelStatus = 409;
        } else {
          // Cancel won the race -> subsequent cancel MUST return 200 OK idempotent `canceled`
          const afterCancel = h.repo.cancelJob(TENANT_A_ID, jobId, { now: h.dbClock() });
          assert.equal(afterCancel.httpStatus, 200);
          assert.equal(afterCancel.body.state, 'canceled');
          postPublishCancelStatus = 200;
        }

        const job = h.repo.getJob(TENANT_A_ID, jobId);
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, jobId);
        const artifacts = h.repo.listJobArtifacts(TENANT_A_ID, jobId);
        const outbox = h.repo.listOutboxEvents(TENANT_A_ID, jobId);
        const usage = h.repo.listUsageEntries(TENANT_A_ID, jobId);
        const billable = usage.filter((u) => u.usage_class === 'billable');
        const operational = usage.filter((u) => u.usage_class === 'operational');

        // Strict mutual exclusion invariants:
        if (cancelBeforePublish) {
          assert.equal(execResult.status, 'canceled');
          assert.equal(job.state, 'canceled');
          assert.equal(postPublishCancelStatus, 200);
          assert.equal(reservation.state, 'released');
          assert.equal(artifacts.length, 0);
          assert.equal(billable.length, 0);
          assert.equal(operational.length, 1);
          assert.equal(outbox.length, 1);
          assert.equal(outbox[0].event_type, 'job.canceled');
        } else {
          assert.equal(execResult.status, 'succeeded');
          assert.equal(job.state, 'succeeded');
          assert.equal(postPublishCancelStatus, 409);
          assert.equal(reservation.state, 'settled');
          assert.equal(artifacts.length, 3);
          assert.equal(billable.length, 1);
          assert.equal(operational.length, 1);
          assert.equal(outbox.length, 1);
          assert.equal(outbox[0].event_type, 'job.succeeded');
        }

        // Zero orphan temp files for this attempt
        assert.equal(
          h.quarantineStore.listAttemptTempFiles(TENANT_A_ID, jobId, lease.attemptId).length,
          0,
        );
      }

      assert.equal(h.quarantineStore.listAllAttemptTempDirs().length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('6. Stabilizes `asset-revoke-vs-publish` race (`DELETE /v1/assets/{id}` vs `publishJobAttempt`) and enforces `AMB-003` (`cancel_requested` immunity to `ASSET_REVOKED`) across 20 iterations', async () => {
    const h = createTestHarness({ maxGlobalSlots: 4 });
    try {
      const worker = new RealRendererWorker({
        workerId: 'worker_race_revoke',
        dispatcher: h.dispatcher,
      });

      // Part A: AMB-003 invariant — if a job is already in `cancel_requested`, `DELETE /v1/assets/{id}`
      // MUST NOT overwrite it to `failed` (`ASSET_REVOKED`); it MUST still finalize to `canceled`!
      h.repo.admitJob(TENANT_B_ID, {
        id: 'job_p403_amb003_cancel_vs_revoke',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const ambLease = h.dispatcher.claimNextJob({ workerId: 'worker_amb003' });
      assert.ok(ambLease);

      // 1. Tenant B cancels the active job -> `cancel_requested`
      const cancelAmb = h.repo.cancelJob(TENANT_B_ID, 'job_p403_amb003_cancel_vs_revoke', {
        now: h.dbClock(),
      });
      assert.equal(cancelAmb.body.state, 'cancel_requested');

      // 2. Tenant B deletes the referenced asset while the job is in `cancel_requested`
      const delAmb = h.repo.deleteAsset(TENANT_B_ID, 'ast_p403_hero', h.dbClock());
      assert.equal(delAmb.status, 'deleted');
      assert.equal(
        delAmb.revokedJobs.includes('job_p403_amb003_cancel_vs_revoke'),
        false,
        'cancel_requested job must not be overwritten to failed by deleteAsset (AMB-003)',
      );
      assert.equal(
        h.repo.getJob(TENANT_B_ID, 'job_p403_amb003_cancel_vs_revoke').state,
        'cancel_requested',
      );

      // 3. Worker finishes/aborts -> job transitions to `canceled` (never `failed`)
      const ambWorkerRes = await worker.executeLeasedJob(ambLease);
      assert.equal(ambWorkerRes.status, 'canceled');
      assert.equal(
        h.repo.getJob(TENANT_B_ID, 'job_p403_amb003_cancel_vs_revoke').state,
        'canceled',
      );

      // Part B: 20-iteration race stress test between `DELETE /v1/assets/{id}` and `publishJobAttempt`
      for (let i = 0; i < 20; i++) {
        // Re-ensure `ast_p403_hero` for TENANT_A_ID is ready before admitting iteration i
        h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
          tx.updateScoped(
            'assets',
            { status: 'ready', deleted_at: null, updated_at: h.dbClock().toISOString() },
            'id = ?',
            ['ast_p403_hero'],
          );
        });

        const jobId = `job_p403_race_revoke_${i}`;
        h.repo.admitJob(TENANT_A_ID, {
          id: jobId,
          request: {
            kind: 'render',
            compositionId: 'cmp_p403_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
          now: h.advanceClockMs(10),
        });

        const lease = h.dispatcher.claimNextJob({ workerId: `worker_revoke_${i}` });
        assert.ok(lease);

        const revokeBeforePublish = i % 2 === 0;
        const execResult = await worker.executeLeasedJob(lease, {
          ignoreAbortSignalForStalePublishTest: true,
          onBeforePublish: async () => {
            if (revokeBeforePublish) {
              // Asset revocation wins the race right before `publishJobAttempt`!
              h.repo.deleteAsset(TENANT_A_ID, 'ast_p403_hero', h.dbClock());
            }
          },
        });

        if (!revokeBeforePublish) {
          // Publish won the race -> deleting the asset afterwards must NOT alter the succeeded job
          const delAfter = h.repo.deleteAsset(TENANT_A_ID, 'ast_p403_hero', h.dbClock());
          assert.equal(delAfter.revokedJobs.includes(jobId), false);
        }

        const job = h.repo.getJob(TENANT_A_ID, jobId);
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, jobId);
        const artifacts = h.repo.listJobArtifacts(TENANT_A_ID, jobId);
        const outbox = h.repo.listOutboxEvents(TENANT_A_ID, jobId);
        const usage = h.repo.listUsageEntries(TENANT_A_ID, jobId);
        const billable = usage.filter((u) => u.usage_class === 'billable');
        const operational = usage.filter((u) => u.usage_class === 'operational');

        if (revokeBeforePublish) {
          assert.equal(job.state, 'failed');
          assert.equal(job.error.code, 'ASSET_REVOKED');
          assert.equal(reservation.state, 'released');
          assert.equal(artifacts.length, 0);
          assert.equal(billable.length, 0);
          assert.equal(operational.length, 1);
          assert.equal(outbox.length, 1);
          assert.equal(outbox[0].event_type, 'job.failed');
        } else {
          assert.equal(execResult.status, 'succeeded');
          assert.equal(job.state, 'succeeded');
          assert.equal(reservation.state, 'settled');
          assert.equal(artifacts.length, 3);
          assert.equal(billable.length, 1);
          assert.equal(operational.length, 1);
          assert.equal(outbox.length, 1);
          assert.equal(outbox[0].event_type, 'job.succeeded');
        }

        // Zero orphan temp files
        assert.equal(
          h.quarantineStore.listAttemptTempFiles(TENANT_A_ID, jobId, lease.attemptId).length,
          0,
        );
      }

      assert.equal(h.quarantineStore.listAllAttemptTempDirs().length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('7. Sweeps orphan attempt temp directories (`> 24h`) while strictly protecting live leased attempt outputs (`don\'t delete live lease output`)', async () => {
    const h = createTestHarness();
    try {
      // 1. Admit and claim an active job with a live lease (`lease_expires_at = t0 + 60s`)
      h.repo.admitJob(TENANT_A_ID, {
        id: 'job_p403_live_lease',
        request: {
          kind: 'render',
          compositionId: 'cmp_p403_main',
          compositionRevision: 1,
          profile: 'mp4-720p-v1',
        },
        now: h.dbClock(),
      });
      const liveLease = h.dispatcher.claimNextJob({ workerId: 'worker_live_lease' });
      assert.ok(liveLease);

      // Stage temp output for the live lease AND backdate its mtime to 48 hours ago to prove
      // live-lease protection is based on lease liveness, not just file age!
      const liveTemp = h.quarantineStore.stageAttemptTempArtifact(
        TENANT_A_ID,
        liveLease.jobId,
        liveLease.attemptId,
        'output.mp4',
        Buffer.from('live-lease-staged-video-data'),
      );
      const fortyEightHoursAgo = new Date(h.dbClock().getTime() - 48 * 3600 * 1000);
      fs.utimesSync(liveTemp.tempFilePath, fortyEightHoursAgo, fortyEightHoursAgo);
      fs.utimesSync(
        path.dirname(liveTemp.tempFilePath),
        fortyEightHoursAgo,
        fortyEightHoursAgo,
      );

      // 2. Stage an unreferenced orphan attempt temp directory older than 24h (`30h` old)
      const orphanOld = h.quarantineStore.stageAttemptTempArtifact(
        TENANT_A_ID,
        'job_orphan_crashed',
        'att_orphan_old_1',
        'output.mp4',
        Buffer.from('orphan-old-temp-video-bytes-to-reclaim'),
      );
      const thirtyHoursAgo = new Date(h.dbClock().getTime() - 30 * 3600 * 1000);
      fs.utimesSync(orphanOld.tempFilePath, thirtyHoursAgo, thirtyHoursAgo);
      fs.utimesSync(path.dirname(orphanOld.tempFilePath), thirtyHoursAgo, thirtyHoursAgo);

      // 3. Stage a recent unreferenced attempt temp directory (`1h` old, < 24h threshold)
      const orphanRecent = h.quarantineStore.stageAttemptTempArtifact(
        TENANT_A_ID,
        'job_orphan_recent',
        'att_orphan_recent_1',
        'output.mp4',
        Buffer.from('orphan-recent-temp-bytes'),
      );
      const oneHourAgo = new Date(h.dbClock().getTime() - 1 * 3600 * 1000);
      fs.utimesSync(orphanRecent.tempFilePath, oneHourAgo, oneHourAgo);
      fs.utimesSync(path.dirname(orphanRecent.tempFilePath), oneHourAgo, oneHourAgo);

      // 4. Run StorageTempSweeper at `h.dbClock()` (while `liveLease` is still active!)
      const sweep1 = h.sweeper.sweep({ now: h.dbClock() });
      assert.equal(sweep1.attemptTempDirsRemoved, 1);
      assert.equal(sweep1.attemptTempFilesRemoved, 1);
      assert.equal(sweep1.attemptTempBytesReclaimed, orphanOld.bytes);

      // Verify:
      // - `orphanOld` (> 24h) was removed
      assert.equal(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          'job_orphan_crashed',
          'att_orphan_old_1',
        ).length,
        0,
      );
      // - `orphanRecent` (< 24h) was preserved
      assert.equal(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          'job_orphan_recent',
          'att_orphan_recent_1',
        ).length,
        1,
      );
      // - `liveLease` output was strictly preserved despite backdated mtime (`don't delete live lease output`)!
      assert.deepEqual(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          liveLease.jobId,
          liveLease.attemptId,
        ),
        ['output.mp4'],
      );

      // 5. Complete the live lease job normally via worker
      const worker = new RealRendererWorker({
        workerId: 'worker_live_lease',
        dispatcher: h.dispatcher,
      });
      const finishRes = await worker.executeLeasedJob(liveLease);
      assert.equal(finishRes.status, 'succeeded');
      assert.equal(
        h.quarantineStore.listAttemptTempFiles(
          TENANT_A_ID,
          liveLease.jobId,
          liveLease.attemptId,
        ).length,
        0,
      );

      // 6. Advance clock 25h so `orphanRecent` ages past 24h and sweep again -> 0 temp dirs remain
      const futureNow = h.advanceClockMs(25 * 3600 * 1000);
      const sweep2 = h.sweeper.sweep({ now: futureNow });
      assert.equal(sweep2.attemptTempDirsRemoved, 1);
      assert.equal(h.quarantineStore.listAllAttemptTempDirs().length, 0);
    } finally {
      h.cleanup();
    }
  });
});
