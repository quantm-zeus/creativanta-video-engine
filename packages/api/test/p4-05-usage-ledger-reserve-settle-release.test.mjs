/**
 * Task P4-05 Integration & Invariant Test Suite:
 * Usage Ledger, Reserve, Settle, Release, Operational vs Billable Reports,
 * Repeated Completion Double Debit Guards, and Canceled vs Failed Separation.
 *
 * Acceptance Criteria:
 *   "Usage ledger/reserve/settle/release/operational vs billable reports;
 *    repeated completion không double debit, canceled/failed units tách rõ"
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("usage_reservations", "usage_entries", unique ledger constraint)
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", operational vs billable meters)
 *   - docs/API.md ("GET /v1/usage", query window, preview exemption, billable output minutes)
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
  MigrationRunner,
  TenantConnectionPool,
  TenantRepository,
  JobDispatcher,
  QuarantineStore,
  createServer,
} from '../dist/index.js';

const TEST_PEPPER = 'p405_test_secret_pepper_0123456789abcdef0123456789abcdef';
const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';

function buildValidSpec({
  durationFrames = 450, // 15s at 30fps
  fontAssetId = 'ast_font_noto_sans_regular',
  imageAssetId = 'ast_img_hero',
} = {}) {
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
    scenes: [
      {
        id: 'scene_1',
        revision: 1,
        engine: 'html-v1',
        start_frame: 0,
        duration_frames: durationFrames,
        background: '#101820',
        layers: [
          {
            id: 'layer_title',
            type: 'text',
            z_index: 1,
            start_frame: 0,
            duration_frames: durationFrames,
            box: { x: 48, y: 100, width: 624, height: 240 },
            content: {
              text: 'Xin chào Creativanta P4-05',
              font_id: 'font_main',
              font_size: 48,
              color: '#FFFFFF',
              align: 'center',
              max_lines: 2,
              overflow: 'ellipsis',
            },
          },
          {
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
          },
        ],
        transition_out: { type: 'cut', duration_frames: 0 },
      },
    ],
    audio_tracks: [],
    subtitles: [],
  };
}

function seedTenantData(repo, tenantId, compId = 'cmp_p405_main') {
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

  const spec = buildValidSpec({ durationFrames: 450 });
  repo.createComposition(tenantId, {
    id: compId,
    name: `Composition ${compId}`,
    spec,
  });

  return { compId, spec };
}

function advanceToVerifying(dispatcher, tenantId, jobId, attemptId, leaseEpoch) {
  dispatcher.advanceJobStage({
    tenantId,
    jobId,
    attemptId,
    leaseEpoch,
    targetState: 'rendering',
  });
  dispatcher.advanceJobStage({
    tenantId,
    jobId,
    attemptId,
    leaseEpoch,
    targetState: 'encoding',
  });
  dispatcher.advanceJobStage({
    tenantId,
    jobId,
    attemptId,
    leaseEpoch,
    targetState: 'verifying',
  });
}

function createTestHarness(options = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p405-test-'));
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

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha', now: dbClock() });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta', now: dbClock() });

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

  seedTenantData(repo, TENANT_A_ID, 'cmp_p405_main');
  seedTenantData(repo, TENANT_B_ID, 'cmp_p405_main');

  const dispatcher = new JobDispatcher({
    repository: repo,
    quarantineStore,
    maxGlobalSlots: options.maxGlobalSlots ?? 4,
    includeRetryJitter: false,
    dbClock,
  });

  const cleanup = () => {
    quarantineStore.clearAll();
  };

  return {
    db,
    pool,
    repo,
    dispatcher,
    quarantineStore,
    keyA,
    keyB,
    dbClock,
    advanceClockMs,
    cleanup,
  };
}

describe('P4-05: Usage Ledger, Reserve, Settle, Release, Operational vs Billable Reports & Double Debit Guards', () => {
  describe('1. Full Lifecycle: Reserve, Settle, and Release', () => {
    it('1.1 Reserves maximum budget on admission, tracks pending units, and enforces reservation caps', async () => {
      const h = createTestHarness();
      try {
        // Set policy limits for Tenant A
        h.repo.updateTenantPolicyLimits(TENANT_A_ID, {
          max_reserved_vcpu_seconds: 200,
          max_reserved_output_seconds: 50,
        });

        // Admitting a 15s render job requires 15s output and 120 vCPU-s (15s * 8)
        const admitted1 = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_reserve_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        assert.equal(admitted1.job.state, 'queued');

        // Verify reservation state is 'reserved' with exact values
        const res1 = h.repo.getUsageReservation(TENANT_A_ID, 'job_reserve_1');
        assert.ok(res1);
        assert.equal(res1.state, 'reserved');
        assert.equal(res1.reserved_output_seconds, 15);
        assert.equal(res1.reserved_vcpu_seconds, 120);
        assert.equal(res1.settled_at, null);

        // Usage report shows 1 pending reservation
        const usageReport = h.repo.getUsageSummary(
          TENANT_A_ID,
          '2026-11-01T00:00:00Z',
          '2026-11-30T23:59:59Z',
        );
        assert.equal(usageReport.reservations.pending_count, 1);
        assert.equal(usageReport.reservations.pending_vcpu_seconds, 120);
        assert.equal(usageReport.reservations.pending_output_seconds, 15);
        assert.equal(usageReport.billable_output_minutes, 0);

        // Attempting to admit another job that would exceed max_reserved_vcpu_seconds (120 + 120 = 240 > 200)
        assert.throws(
          () => {
            h.repo.admitJob(TENANT_A_ID, {
              id: 'job_reserve_2_overflow',
              request: {
                kind: 'render',
                compositionId: 'cmp_p405_main',
                compositionRevision: 1,
                profile: 'mp4-720p-v1',
              },
            });
          },
          (err) => err.code === 'QUOTA_EXCEEDED' && err.message.includes('vCPU budget exceeded'),
        );

        // Cancel job1 -> reservation transitions to 'released'
        const cancelResult = h.repo.cancelJob(TENANT_A_ID, 'job_reserve_1');
        assert.equal(cancelResult.httpStatus, 202);
        assert.equal(cancelResult.body.state, 'canceled');

        const res1AfterCancel = h.repo.getUsageReservation(TENANT_A_ID, 'job_reserve_1');
        assert.equal(res1AfterCancel.state, 'released');
        assert.ok(res1AfterCancel.settled_at);

        // Now job2 can be admitted safely because the previous budget was released
        const admitted2 = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_reserve_2_after_release',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        assert.equal(admitted2.job.state, 'queued');
      } finally {
        h.cleanup();
      }
    });

    it('1.2 Settles reservation on render job success, creating exactly 1 billable and 1 operational entry', async () => {
      const h = createTestHarness();
      try {
        const admitted = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_settle_render_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });

        // Claim and advance to verifying
        const claim = h.dispatcher.claimNextJob({ workerId: 'worker_settle_1' });
        assert.ok(claim);
        assert.equal(claim.jobId, admitted.job.id);

        advanceToVerifying(h.dispatcher, TENANT_A_ID, admitted.job.id, claim.attemptId, claim.leaseEpoch);

        // Publish job attempt (15s output = 0.25 min billable, 2.45s CPU operational)
        const pubResult = h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: admitted.job.id,
          attemptId: claim.attemptId,
          leaseEpoch: claim.leaseEpoch,
          artifacts: [],
          cpuSeconds: 2.45,
          peakRssBytes: 128 * 1024 * 1024,
          outputSeconds: 15.0,
        });
        assert.equal(pubResult.published, true);
        assert.equal(pubResult.state, 'succeeded');

        // Verify reservation state is 'settled'
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, admitted.job.id);
        assert.equal(reservation.state, 'settled');
        assert.ok(reservation.settled_at);

        // Verify usage ledger entries: exactly 1 operational (cpu_seconds) and 1 billable (billable_output_minutes)
        const entries = h.repo.listUsageEntries(TENANT_A_ID, admitted.job.id);
        assert.equal(entries.length, 2);

        const operationalEntry = entries.find((e) => e.usage_class === 'operational');
        assert.ok(operationalEntry);
        assert.equal(operationalEntry.meter, 'cpu_seconds');
        assert.equal(operationalEntry.quantity, 2.45);
        assert.equal(operationalEntry.attempt_id, claim.attemptId);

        const billableEntry = entries.find((e) => e.usage_class === 'billable');
        assert.ok(billableEntry);
        assert.equal(billableEntry.meter, 'billable_output_minutes');
        assert.equal(billableEntry.quantity, 0.25);
        assert.equal(billableEntry.ledger_version, 1);
        assert.equal(billableEntry.reason, 'terminal_succeeded_settlement');

        // Verify job status reflects aggregated usage
        const jobStatus = h.repo.getJob(TENANT_A_ID, admitted.job.id);
        assert.equal(jobStatus.state, 'succeeded');
        assert.equal(jobStatus.usage.output_seconds, 15);
        assert.equal(jobStatus.usage.cpu_seconds, 2.45);
        assert.equal(jobStatus.usage.billable_output_minutes, 0.25);
      } finally {
        h.cleanup();
      }
    });

    it('1.3 Enforces preview exemption: preview jobs settle reservation, track operational CPU, but debit 0 billable minutes', async () => {
      const h = createTestHarness();
      try {
        const admittedPreview = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_settle_preview_1',
          request: {
            kind: 'preview',
            mode: 'clip',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'preview-360p-v1',
            startFrame: 0,
            durationFrames: 150, // 5s preview
          },
        });
        assert.equal(admittedPreview.job.kind, 'preview');

        // Claim and advance to verifying
        const claim = h.dispatcher.claimNextJob({ workerId: 'worker_preview_1' });
        assert.ok(claim);
        assert.equal(claim.jobId, admittedPreview.job.id);

        advanceToVerifying(h.dispatcher, TENANT_A_ID, admittedPreview.job.id, claim.attemptId, claim.leaseEpoch);

        // Publish preview
        const pubResult = h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: admittedPreview.job.id,
          attemptId: claim.attemptId,
          leaseEpoch: claim.leaseEpoch,
          artifacts: [],
          cpuSeconds: 0.85,
          peakRssBytes: 64 * 1024 * 1024,
          outputSeconds: 5.0,
        });
        assert.equal(pubResult.published, true);

        // Reservation is settled
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, admittedPreview.job.id);
        assert.equal(reservation.state, 'settled');

        // Usage entries: operational CPU is metered, but billable output minutes is 0 (preview exempt)
        const entries = h.repo.listUsageEntries(TENANT_A_ID, admittedPreview.job.id);
        const billableEntry = entries.find((e) => e.usage_class === 'billable');
        assert.ok(billableEntry);
        assert.equal(billableEntry.quantity, 0); // Exemption: 0 billable output minutes
        assert.equal(billableEntry.reason, 'terminal_preview_exempt');

        const operationalEntry = entries.find((e) => e.usage_class === 'operational');
        assert.ok(operationalEntry);
        assert.equal(operationalEntry.quantity, 0.85);

        // Job status reports 0 billable output minutes
        const jobStatus = h.repo.getJob(TENANT_A_ID, admittedPreview.job.id);
        assert.equal(jobStatus.usage.billable_output_minutes, 0);
        assert.equal(jobStatus.usage.cpu_seconds, 0.85);
      } finally {
        h.cleanup();
      }
    });

    it('1.4 Releases reservation on job cancellation at all stages, preserving operational units with 0 billable debit', async () => {
      const h = createTestHarness();
      try {
        // Stage A: Cancel a queued job
        const queuedJob = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_cancel_queued_stage',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const cancelQueued = h.repo.cancelJob(TENANT_A_ID, queuedJob.job.id);
        assert.equal(cancelQueued.httpStatus, 202);
        assert.equal(cancelQueued.body.state, 'canceled');
        assert.equal(h.repo.getUsageReservation(TENANT_A_ID, queuedJob.job.id).state, 'released');
        assert.equal(h.repo.listUsageEntries(TENANT_A_ID, queuedJob.job.id).length, 0);

        // Stage B: Cancel a running active job (cancel_requested -> worker aborts)
        const runningJob = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_cancel_running_stage',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claimRunning = h.dispatcher.claimNextJob({ workerId: 'worker_cancel_1' });
        assert.equal(claimRunning.jobId, runningJob.job.id);

        // Request cancel while running
        const cancelReq = h.repo.cancelJob(TENANT_A_ID, runningJob.job.id);
        assert.equal(cancelReq.httpStatus, 202);
        assert.equal(cancelReq.body.state, 'cancel_requested');

        // Worker attempts to renew lease -> finalized to canceled, operational CPU recorded
        const hbResult = h.dispatcher.renewLease({
          tenantId: TENANT_A_ID,
          jobId: runningJob.job.id,
          attemptId: claimRunning.attemptId,
          leaseEpoch: claimRunning.leaseEpoch,
        });
        assert.equal(hbResult.shouldAbortWorker, true);
        assert.equal(hbResult.reason, 'CANCEL_REQUESTED');

        // Verify reservation released and operational CPU recorded, ZERO billable entries
        assert.equal(h.repo.getUsageReservation(TENANT_A_ID, runningJob.job.id).state, 'released');
        const runningEntries = h.repo.listUsageEntries(TENANT_A_ID, runningJob.job.id);
        assert.equal(runningEntries.filter((u) => u.usage_class === 'billable').length, 0);
        assert.equal(runningEntries.filter((u) => u.usage_class === 'operational').length, 1);

        // Stage C: Cancel a retry_wait job
        const retryJob = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_cancel_retry_wait_stage',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claimRetry = h.dispatcher.claimNextJob({ workerId: 'worker_retry_1' });
        // Attempt 1 fails with retryable error
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: retryJob.job.id,
          attemptId: claimRetry.attemptId,
          leaseEpoch: claimRetry.leaseEpoch,
          errorCode: 'RENDER_TIMEOUT',
          message: 'Frame render timeout',
          retryable: true,
          cpuSeconds: 1.15,
        });

        // Job is in retry_wait, reservation is still 'reserved'
        assert.equal(h.repo.getJob(TENANT_A_ID, retryJob.job.id).state, 'retry_wait');
        assert.equal(h.repo.getUsageReservation(TENANT_A_ID, retryJob.job.id).state, 'reserved');

        // Now cancel while in retry_wait
        const cancelRetryWait = h.repo.cancelJob(TENANT_A_ID, retryJob.job.id);
        assert.equal(cancelRetryWait.httpStatus, 202);
        assert.equal(cancelRetryWait.body.state, 'canceled');

        // Reservation released, attempt 1 operational CPU preserved, zero billable entries
        assert.equal(h.repo.getUsageReservation(TENANT_A_ID, retryJob.job.id).state, 'released');
        const retryEntries = h.repo.listUsageEntries(TENANT_A_ID, retryJob.job.id);
        assert.equal(retryEntries.filter((u) => u.usage_class === 'billable').length, 0);
        const opRetry = retryEntries.filter((u) => u.usage_class === 'operational');
        assert.equal(opRetry.length, 1);
        assert.equal(opRetry[0].quantity, 1.15);
      } finally {
        h.cleanup();
      }
    });

    it('1.5 Releases reservation on terminal failures (exhausted retries & fatal errors) with operational metering and 0 billable debit', async () => {
      const h = createTestHarness();
      try {
        const failJob = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_terminal_fail_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });

        // Attempt 1 fails (retryable)
        const claim1 = h.dispatcher.claimNextJob({ workerId: 'worker_fail_1' });
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: failJob.job.id,
          attemptId: claim1.attemptId,
          leaseEpoch: claim1.leaseEpoch,
          errorCode: 'STORAGE_TRANSIENT_ERROR',
          message: 'S3 503 transient error',
          retryable: true,
          cpuSeconds: 0.95,
        });

        // Advance clock past backoff and claim attempt 2
        h.advanceClockMs(10_000);
        h.dispatcher.promoteEligibleRetryWaitJobs({ forceIgnoreBackoff: true });
        const claim2 = h.dispatcher.claimNextJob({ workerId: 'worker_fail_2' });
        assert.ok(claim2);
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: failJob.job.id,
          attemptId: claim2.attemptId,
          leaseEpoch: claim2.leaseEpoch,
          errorCode: 'STORAGE_TRANSIENT_ERROR',
          message: 'S3 503 transient error',
          retryable: true,
          cpuSeconds: 1.1,
        });

        // Advance clock past backoff and claim attempt 3 (max_attempts = 3)
        h.advanceClockMs(40_000);
        h.dispatcher.promoteEligibleRetryWaitJobs({ forceIgnoreBackoff: true });
        const claim3 = h.dispatcher.claimNextJob({ workerId: 'worker_fail_3' });
        assert.ok(claim3);
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: failJob.job.id,
          attemptId: claim3.attemptId,
          leaseEpoch: claim3.leaseEpoch,
          errorCode: 'STORAGE_TRANSIENT_ERROR',
          message: 'S3 503 transient error',
          retryable: true,
          cpuSeconds: 1.25,
        });

        // Final state is terminal 'failed'
        const finalJob = h.repo.getJob(TENANT_A_ID, failJob.job.id);
        assert.equal(finalJob.state, 'failed');

        // Reservation released
        const reservation = h.repo.getUsageReservation(TENANT_A_ID, failJob.job.id);
        assert.equal(reservation.state, 'released');
        assert.ok(reservation.settled_at);

        // Exactly 3 operational CPU entries recorded (1 per attempt), ZERO billable entries
        const entries = h.repo.listUsageEntries(TENANT_A_ID, failJob.job.id);
        assert.equal(entries.filter((u) => u.usage_class === 'billable').length, 0);
        const opEntries = entries.filter((u) => u.usage_class === 'operational');
        assert.equal(opEntries.length, 3);
        assert.deepEqual(
          opEntries.map((e) => e.quantity),
          [0.95, 1.1, 1.25],
        );
      } finally {
        h.cleanup();
      }
    });
  });

  describe('2. Repeated Completion & Double Debit Protection', () => {
    it('2.1 Rejects repeated publication from the same worker with STALE_LEASE_OR_EPOCH and zero double debit', async () => {
      const h = createTestHarness();
      try {
        const admitted = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_repeated_publish_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });

        const claim = h.dispatcher.claimNextJob({ workerId: 'worker_repeat_1' });
        advanceToVerifying(h.dispatcher, TENANT_A_ID, admitted.job.id, claim.attemptId, claim.leaseEpoch);

        // First publication succeeds
        const pub1 = h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: admitted.job.id,
          attemptId: claim.attemptId,
          leaseEpoch: claim.leaseEpoch,
          artifacts: [],
          cpuSeconds: 2.1,
          peakRssBytes: 100 * 1024 * 1024,
          outputSeconds: 15.0,
        });
        assert.equal(pub1.published, true);

        // Immediate repeated call from the exact same worker attempt
        const pub2 = h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: admitted.job.id,
          attemptId: claim.attemptId,
          leaseEpoch: claim.leaseEpoch,
          artifacts: [],
          cpuSeconds: 2.1,
          peakRssBytes: 100 * 1024 * 1024,
          outputSeconds: 15.0,
        });
        assert.equal(pub2.published, false);
        assert.equal(pub2.reason, 'STALE_LEASE_OR_EPOCH');
        assert.equal(pub2.shouldAbortWorker, true);

        // Invariant: exactly 1 billable output minutes entry exists
        const usageEntries = h.repo.listUsageEntries(TENANT_A_ID, admitted.job.id);
        const billableEntries = usageEntries.filter((u) => u.usage_class === 'billable');
        assert.equal(billableEntries.length, 1);
        assert.equal(billableEntries[0].quantity, 0.25);

        // Invariant: database unique constraint blocks duplicate manual insertion
        assert.throws(() => {
          h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
            tx.insertScoped('usage_entries', {
              tenant_id: TENANT_A_ID,
              id: 'use_duplicate_billable_attempt',
              job_id: admitted.job.id,
              attempt_id: claim.attemptId,
              usage_class: 'billable',
              meter: 'billable_output_minutes',
              ledger_version: 1, // Same unique key (tenant_id, job_id, meter, ledger_version)
              quantity: 0.25,
              rate_version: 'starter-v1',
              reason: 'illegal_duplicate_attempt',
              created_at: new Date().toISOString(),
            });
          });
        });
      } finally {
        h.cleanup();
      }
    });

    it('2.2 Prevents duplicate reservations or duplicate debits on idempotent API request replay', async () => {
      const h = createTestHarness();
      const config = loadEnvConfig({
        CVE_ENV: 'development',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_API_KEY_PEPPER: TEST_PEPPER,
      });

      const server = createServer({
        config,
        repository: h.repo,
        quarantineStore: h.quarantineStore,
        pool: h.pool,
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const payload = JSON.stringify({
          composition_id: 'cmp_p405_main',
          revision: 1,
          profile: 'mp4-720p-v1',
        });

        // First POST /v1/render-jobs
        const res1 = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyA.plaintextKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem_p405_unique_key_01',
          },
          body: payload,
        });
        assert.equal(res1.status, 202);
        assert.equal(res1.headers.get('idempotency-replayed'), null);
        const body1 = await res1.json();
        const jobId = body1.id;

        // Replaying with identical Idempotency-Key returns 202 with Idempotency-Replayed header
        const res2 = await fetch(`${baseUrl}/v1/render-jobs`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyA.plaintextKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'idem_p405_unique_key_01',
          },
          body: payload,
        });
        assert.equal(res2.status, 202);
        assert.equal(res2.headers.get('idempotency-replayed'), 'true');
        const body2 = await res2.json();
        assert.equal(body2.id, jobId);

        // Verify only 1 reservation row exists
        const reservations = h.repo.listUsageReservations(TENANT_A_ID);
        const jobReservations = reservations.filter((r) => r.job_id === jobId);
        assert.equal(jobReservations.length, 1);

        // Cancel with Idempotency-Key
        const cancel1 = await fetch(`${baseUrl}/v1/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyA.plaintextKey}`,
            'Idempotency-Key': 'idem_p405_cancel_key_01',
          },
        });
        assert.equal(cancel1.status, 202);

        // Replay cancel with same Idempotency-Key
        const cancel2 = await fetch(`${baseUrl}/v1/jobs/${jobId}/cancel`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${h.keyA.plaintextKey}`,
            'Idempotency-Key': 'idem_p405_cancel_key_01',
          },
        });
        assert.equal(cancel2.status, 202);
        assert.equal(cancel2.headers.get('idempotency-replayed'), 'true');

        // Verify reservation state is released, exactly once
        const finalRes = h.repo.getUsageReservation(TENANT_A_ID, jobId);
        assert.equal(finalRes.state, 'released');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        h.cleanup();
      }
    });

    it('2.3 Resolves concurrent publication race: exactly 1 worker commits publication, second is fenced, exactly 1 billable debit', async () => {
      const h = createTestHarness();
      try {
        const admitted = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_publish_race_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });

        const claim = h.dispatcher.claimNextJob({ workerId: 'worker_race_1' });
        advanceToVerifying(h.dispatcher, TENANT_A_ID, admitted.job.id, claim.attemptId, claim.leaseEpoch);

        // Run 5 publication attempts concurrently with same credentials
        const publishPromises = Array.from({ length: 5 }, () =>
          Promise.resolve().then(() =>
            h.dispatcher.publishJobAttempt({
              tenantId: TENANT_A_ID,
              jobId: admitted.job.id,
              attemptId: claim.attemptId,
              leaseEpoch: claim.leaseEpoch,
              artifacts: [],
              cpuSeconds: 1.5,
              peakRssBytes: 1024,
              outputSeconds: 15.0,
            }),
          ),
        );

        const results = await Promise.all(publishPromises);
        const publishedCount = results.filter((r) => r.published).length;
        const rejectedCount = results.filter((r) => !r.published).length;

        assert.equal(publishedCount, 1);
        assert.equal(rejectedCount, 4);

        // Verify only 1 billable usage entry was committed
        const entries = h.repo.listUsageEntries(TENANT_A_ID, admitted.job.id);
        const billableEntries = entries.filter((u) => u.usage_class === 'billable');
        assert.equal(billableEntries.length, 1);
      } finally {
        h.cleanup();
      }
    });
  });

  describe('3. Operational vs Billable Reports & Separation of Canceled/Failed Units', () => {
    it('3.1 Validates GET /v1/usage query parameters (ISO format, ordering, and 31-day window limit)', async () => {
      const h = createTestHarness();
      const config = loadEnvConfig({
        CVE_ENV: 'development',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_API_KEY_PEPPER: TEST_PEPPER,
      });

      const server = createServer({
        config,
        repository: h.repo,
        quarantineStore: h.quarantineStore,
        pool: h.pool,
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        const authHeader = { Authorization: `Bearer ${h.keyA.plaintextKey}` };

        // Test A: Malformed 'from' parameter -> 400 INVALID_QUERY_PARAM
        const badFromRes = await fetch(`${baseUrl}/v1/usage?from=not-a-date&to=2026-11-10T00:00:00Z`, {
          headers: authHeader,
        });
        assert.equal(badFromRes.status, 400);
        const badFrom = await badFromRes.json();
        assert.equal(badFrom.error.code, 'INVALID_QUERY_PARAM');
        assert.ok(badFrom.error.message.includes("'from' must be a valid ISO 8601"));

        // Test B: Malformed 'to' parameter -> 400 INVALID_QUERY_PARAM
        const badToRes = await fetch(`${baseUrl}/v1/usage?from=2026-11-01T00:00:00Z&to=invalid-to`, {
          headers: authHeader,
        });
        assert.equal(badToRes.status, 400);
        const badTo = await badToRes.json();
        assert.equal(badTo.error.code, 'INVALID_QUERY_PARAM');

        // Test C: 'to' is earlier than 'from' -> 400 INVALID_QUERY_PARAM
        const reversedRes = await fetch(
          `${baseUrl}/v1/usage?from=2026-11-15T00:00:00Z&to=2026-11-10T00:00:00Z`,
          { headers: authHeader },
        );
        assert.equal(reversedRes.status, 400);
        const reversed = await reversedRes.json();
        assert.equal(reversed.error.code, 'INVALID_QUERY_PARAM');
        assert.ok(reversed.error.message.includes("'to' must not be earlier than 'from'"));

        // Test D: Window exceeds 31 days (e.g. 45 days) -> 400 INVALID_QUERY_PARAM
        const wideRes = await fetch(
          `${baseUrl}/v1/usage?from=2026-10-01T00:00:00Z&to=2026-11-20T00:00:00Z`,
          { headers: authHeader },
        );
        assert.equal(wideRes.status, 400);
        const wide = await wideRes.json();
        assert.equal(wide.error.code, 'INVALID_QUERY_PARAM');
        assert.ok(wide.error.message.includes('cannot exceed 31 days'));

        // Test E: Valid query within 31-day window -> 200 OK
        const validRes = await fetch(
          `${baseUrl}/v1/usage?from=2026-11-01T00:00:00Z&to=2026-11-25T00:00:00Z`,
          { headers: authHeader },
        );
        assert.equal(validRes.status, 200);
        const validBody = await validRes.json();
        assert.equal(validBody.currency, 'USD');
        assert.equal(typeof validBody.billable_output_minutes, 'number');
        assert.equal(typeof validBody.operational_attempts, 'number');
      } finally {
        await new Promise((resolve) => server.close(resolve));
        h.cleanup();
      }
    });

    it('3.2 Generates detailed operational vs billable reports, strictly separating canceled and failed units', async () => {
      const h = createTestHarness();
      const config = loadEnvConfig({
        CVE_ENV: 'development',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_API_KEY_PEPPER: TEST_PEPPER,
      });

      const server = createServer({
        config,
        repository: h.repo,
        quarantineStore: h.quarantineStore,
        pool: h.pool,
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      try {
        // Setup Workload on Tenant A:
        // 1. Succeeded render job (15s output = 0.25 min billable, 2.5s operational CPU)
        const jobRender = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_rep_render',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claimRender = h.dispatcher.claimNextJob({ workerId: 'worker_rep_1' });
        advanceToVerifying(h.dispatcher, TENANT_A_ID, jobRender.job.id, claimRender.attemptId, claimRender.leaseEpoch);
        h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: jobRender.job.id,
          attemptId: claimRender.attemptId,
          leaseEpoch: claimRender.leaseEpoch,
          artifacts: [],
          cpuSeconds: 2.5,
          peakRssBytes: 1024,
          outputSeconds: 15.0,
        });

        // 2. Succeeded preview job (5s preview = 0.0 min billable, 0.8s operational CPU)
        const jobPreview = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_rep_preview',
          request: {
            kind: 'preview',
            mode: 'clip',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'preview-360p-v1',
            startFrame: 0,
            durationFrames: 150,
          },
        });
        const claimPreview = h.dispatcher.claimNextJob({ workerId: 'worker_rep_2' });
        advanceToVerifying(h.dispatcher, TENANT_A_ID, jobPreview.job.id, claimPreview.attemptId, claimPreview.leaseEpoch);
        h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: jobPreview.job.id,
          attemptId: claimPreview.attemptId,
          leaseEpoch: claimPreview.leaseEpoch,
          artifacts: [],
          cpuSeconds: 0.8,
          peakRssBytes: 1024,
          outputSeconds: 5.0,
        });

        // 3. Canceled active job (1 attempt ran 1.2s CPU, then canceled)
        const jobCanceled = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_rep_canceled',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claimCancel = h.dispatcher.claimNextJob({ workerId: 'worker_rep_3' });
        h.repo.cancelJob(TENANT_A_ID, jobCanceled.job.id);
        h.dispatcher.renewLease({
          tenantId: TENANT_A_ID,
          jobId: jobCanceled.job.id,
          attemptId: claimCancel.attemptId,
          leaseEpoch: claimCancel.leaseEpoch,
        });

        // 4. Failed job (attempt 1 failed with 1.4s CPU, attempt 2 failed fatal with 1.6s CPU)
        const jobFailed = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_rep_failed',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claimFail1 = h.dispatcher.claimNextJob({ workerId: 'worker_rep_4' });
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: jobFailed.job.id,
          attemptId: claimFail1.attemptId,
          leaseEpoch: claimFail1.leaseEpoch,
          errorCode: 'RENDER_TIMEOUT',
          message: 'Timeout',
          retryable: true,
          cpuSeconds: 1.4,
        });
        h.advanceClockMs(10_000);
        h.dispatcher.promoteEligibleRetryWaitJobs({ forceIgnoreBackoff: true });
        const claimFail2 = h.dispatcher.claimNextJob({ workerId: 'worker_rep_5' });
        assert.ok(claimFail2);
        h.dispatcher.failOrRetryAttempt({
          tenantId: TENANT_A_ID,
          jobId: jobFailed.job.id,
          attemptId: claimFail2.attemptId,
          leaseEpoch: claimFail2.leaseEpoch,
          errorCode: 'SANDBOX_SECURITY_VIOLATION',
          message: 'Fatal sandbox violation',
          retryable: false,
          cpuSeconds: 1.6,
        });

        // 5. Queued job in pending reserved state (15s output, 120s vCPU)
        h.repo.admitJob(TENANT_A_ID, {
          id: 'job_rep_pending_queued',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });

        // Query GET /v1/usage via HTTP
        const res = await fetch(
          `${baseUrl}/v1/usage?from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z`,
          { headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` } },
        );
        assert.equal(res.status, 200);
        const rep = await res.json();

        // 1. Top-level OpenAPI required fields
        assert.equal(rep.from, '2026-11-01T00:00:00Z');
        assert.equal(rep.to, '2026-11-30T23:59:59Z');
        assert.equal(rep.currency, 'USD');
        assert.equal(rep.billable_output_minutes, 0.25); // Only 1 render succeeded: 15/60 = 0.25 min
        assert.equal(rep.operational_attempts, 5); // 1 render + 1 preview + 1 cancel + 2 fail attempts = 5
        assert.ok(rep.operational_cpu_seconds > 6.0);
        assert.equal(
          rep.operational_cpu_seconds,
          Number(
            (
              rep.succeeded_units.operational_cpu_seconds +
              rep.canceled_units.operational_cpu_seconds +
              rep.failed_units.operational_cpu_seconds
            ).toFixed(6),
          ),
        );
        assert.equal(rep.billable_jobs, 1);
        assert.equal(rep.preview_jobs, 1);

        // 2. Canceled units clearly separated
        assert.ok(rep.canceled_units);
        assert.equal(rep.canceled_units.jobs_count, 1);
        assert.equal(rep.canceled_units.attempts_count, 1);
        assert.ok(rep.canceled_units.operational_cpu_seconds > 0);
        assert.equal(rep.canceled_units.billable_output_minutes, 0); // 0 billable debit
        assert.equal(rep.canceled_units.released_output_seconds, 15);

        // 3. Failed units clearly separated
        assert.ok(rep.failed_units);
        assert.equal(rep.failed_units.jobs_count, 1);
        assert.equal(rep.failed_units.attempts_count, 2);
        assert.equal(rep.failed_units.operational_cpu_seconds, 3.0); // 1.4 + 1.6 = 3.0s
        assert.equal(rep.failed_units.billable_output_minutes, 0); // 0 billable debit
        assert.equal(rep.failed_units.released_output_seconds, 15);

        // 4. Succeeded units
        assert.ok(rep.succeeded_units);
        assert.equal(rep.succeeded_units.jobs_count, 2); // 1 render + 1 preview
        assert.equal(rep.succeeded_units.attempts_count, 2);
        assert.equal(rep.succeeded_units.operational_cpu_seconds, 3.3); // 2.5 + 0.8 = 3.3s
        assert.equal(rep.succeeded_units.billable_output_minutes, 0.25);

        // 5. Reservations breakdown (pending, settled, released)
        assert.ok(rep.reservations);
        assert.equal(rep.reservations.pending_count, 1);
        assert.equal(rep.reservations.pending_output_seconds, 15);
        assert.equal(rep.reservations.pending_vcpu_seconds, 120);
        assert.equal(rep.reservations.settled_count, 2);
        assert.equal(rep.reservations.released_count, 2);

        // 6. Reconciliation verification
        assert.ok(rep.reconciliation);
        assert.equal(rep.reconciliation.clean, true);
        assert.equal(rep.reconciliation.double_debit_detected, false);
        assert.equal(rep.reconciliation.discrepancies.length, 0);

        // 7. Multi-tenant isolation: Tenant B sees strictly 0
        const resB = await fetch(
          `${baseUrl}/v1/usage?from=2026-11-01T00:00:00Z&to=2026-11-30T23:59:59Z`,
          { headers: { Authorization: `Bearer ${h.keyB.plaintextKey}` } },
        );
        assert.equal(resB.status, 200);
        const repB = await resB.json();
        assert.equal(repB.billable_output_minutes, 0);
        assert.equal(repB.operational_attempts, 0);
        assert.equal(repB.operational_cpu_seconds, 0);
        assert.equal(repB.reservations.pending_count, 0);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        h.cleanup();
      }
    });

    it('3.3 Audits ledger via reconcileUsage, handles compensating entries, and detects discrepancies', async () => {
      const h = createTestHarness();
      try {
        // Admit and succeed a job
        const job = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_audit_1',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        const claim = h.dispatcher.claimNextJob({ workerId: 'worker_audit_1' });
        advanceToVerifying(h.dispatcher, TENANT_A_ID, job.job.id, claim.attemptId, claim.leaseEpoch);
        h.dispatcher.publishJobAttempt({
          tenantId: TENANT_A_ID,
          jobId: job.job.id,
          attemptId: claim.attemptId,
          leaseEpoch: claim.leaseEpoch,
          artifacts: [],
          cpuSeconds: 1.8,
          peakRssBytes: 1024,
          outputSeconds: 15.0,
        });

        // Run full reconciliation
        const reconClean = h.repo.reconcileUsage(TENANT_A_ID);
        assert.equal(reconClean.clean, true);
        assert.equal(reconClean.summary.succeeded_jobs_count, 1);
        assert.equal(reconClean.summary.settled_reservations_count, 1);
        assert.equal(reconClean.summary.total_billable_output_minutes, 0.25);
        assert.equal(reconClean.discrepancies.length, 0);

        // Add a compensating credit entry (-0.05 min credit due to support resolution)
        const compEntry = h.repo.insertCompensatingUsageEntry(TENANT_A_ID, {
          jobId: job.job.id,
          meter: 'billable_output_minutes',
          quantity: -0.05,
          reason: 'support_ticket_123_partial_credit',
        });
        assert.equal(compEntry.usage_class, 'compensating');
        assert.equal(compEntry.ledger_version, 2);
        assert.equal(compEntry.quantity, -0.05);

        // Verify summary reflects the compensating adjustment: 0.25 - 0.05 = 0.20
        const adjustedSummary = h.repo.getUsageSummary(
          TENANT_A_ID,
          '2026-11-01T00:00:00Z',
          '2026-11-30T23:59:59Z',
        );
        assert.equal(adjustedSummary.billable_output_minutes, 0.2);

        // Verify filtered listUsageEntries
        const compOnly = h.repo.listUsageEntries(TENANT_A_ID, { usageClass: 'compensating' });
        assert.equal(compOnly.length, 1);
        assert.equal(compOnly[0].id, compEntry.id);

        // Simulate an illegal discrepancy by injecting a billable entry for a canceled job
        const canceledJob = h.repo.admitJob(TENANT_A_ID, {
          id: 'job_audit_canceled_leak',
          request: {
            kind: 'render',
            compositionId: 'cmp_p405_main',
            compositionRevision: 1,
            profile: 'mp4-720p-v1',
          },
        });
        h.repo.cancelJob(TENANT_A_ID, canceledJob.job.id);

        h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
          tx.insertScoped('usage_entries', {
            tenant_id: TENANT_A_ID,
            id: 'use_illegal_leak_billable',
            job_id: canceledJob.job.id,
            attempt_id: null,
            usage_class: 'billable',
            meter: 'billable_output_minutes',
            ledger_version: 1,
            quantity: 0.5,
            rate_version: 'starter-v1',
            reason: 'simulated_corrupt_entry',
            created_at: new Date().toISOString(),
          });
        });

        // Run reconciliation and verify the discrepancy is detected and typed
        const reconDiscrepancy = h.repo.reconcileUsage(TENANT_A_ID);
        assert.equal(reconDiscrepancy.clean, false);
        const unexp = reconDiscrepancy.discrepancies.find((d) => d.type === 'UNEXPECTED_BILLABLE_ENTRY');
        assert.ok(unexp);
        assert.equal(unexp.job_id, canceledJob.job.id);
      } finally {
        h.cleanup();
      }
    });
  });
});
