/**
 * Creativanta Video Engine - Disaster Recovery & Restore Drill Performance Benchmark
 * Evaluates snapshot generation throughput, WAL replay velocity, object reconciliation speed,
 * and confirms that RPO <= 15min and RTO <= 4h constraints are strictly satisfied under load.
 */

import { DatabaseSync } from 'node:sqlite';
import { BackupManager } from '../ops/recovery/backup-manager.mjs';
import { MemoryStorageBackend } from '../ops/recovery/object-reconciler.mjs';
import { RestoreDrillRunner } from '../ops/recovery/restore-drill-runner.mjs';
import { MigrationRunner } from '../packages/api/dist/index.js';

export async function runRestoreDrillBenchmark(jobCount = 2000) {
  const initialMem = process.memoryUsage();
  const sourceDb = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(sourceDb);
  runner.migrateUp({ role: 'cve_migrator', targetVersion: '0002' });

  const tenantA = '11111111-1111-4111-8111-111111111111';
  const tenantB = '22222222-2222-4222-8222-222222222222';
  const now = new Date();
  const tMinus10m = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const tMinus5m = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const tPlus30m = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  sourceDb.exec('PRAGMA foreign_keys = OFF;');
  sourceDb.exec('BEGIN IMMEDIATE;');
  try {
    sourceDb.prepare('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      tenantA,
      'Tenant Alpha',
      'active',
      tMinus10m,
      tMinus10m
    );
    sourceDb.prepare('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      tenantB,
      'Tenant Beta',
      'active',
      tMinus10m,
      tMinus10m
    );

    sourceDb.prepare(
      `INSERT INTO compositions (tenant_id, id, name, current_revision, editable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantA, 'cmp_bench_01', 'Bench Composition A', 1, 1, tMinus10m, tMinus10m);

    sourceDb.prepare(
      `INSERT INTO composition_revisions (tenant_id, composition_id, revision, schema_version, spec_json, render_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantA, 'cmp_bench_01', 1, '1.0', '{}', '0'.repeat(64), tMinus10m);

    sourceDb.prepare(
      `INSERT INTO compositions (tenant_id, id, name, current_revision, editable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantB, 'cmp_bench_01', 'Bench Composition B', 1, 1, tMinus10m, tMinus10m);

    sourceDb.prepare(
      `INSERT INTO composition_revisions (tenant_id, composition_id, revision, schema_version, spec_json, render_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantB, 'cmp_bench_01', 1, '1.0', '{}', '0'.repeat(64), tMinus10m);

    const insertJob = sourceDb.prepare(
      `INSERT INTO jobs (tenant_id, id, kind, state, stage, state_version, progress, composition_id, composition_revision, profile, snapshot_json, attempt_count, max_attempts, lease_epoch, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertAttempt = sourceDb.prepare(
      `INSERT INTO job_attempts (tenant_id, job_id, attempt_id, lease_epoch, worker_id, state, started_at, heartbeat_at, lease_expires_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertArtifact = sourceDb.prepare(
      `INSERT INTO artifacts (tenant_id, id, job_id, attempt_id, kind, mime_type, sha256, bytes, storage_key, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < jobCount; i++) {
      const jobId = `job_bench_${String(i).padStart(6, '0')}`;
      const attemptId = `att_bench_${String(i).padStart(6, '0')}`;
      const artId = `art_bench_${String(i).padStart(6, '0')}`;
      const tenant = i % 2 === 0 ? tenantA : tenantB;
      const state = i % 10 === 0 ? 'rendering' : i % 20 === 0 ? 'cancel_requested' : 'succeeded';
      const storageKey = `tenant/${tenant}/jobs/${jobId}/video.mp4`;

      insertJob.run(
        tenant,
        jobId,
        'render',
        state,
        state === 'succeeded' ? 'completed' : state,
        1,
        state === 'succeeded' ? 1.0 : 0.5,
        'cmp_bench_01',
        1,
        'mp4-720p-v1',
        '{}',
        1,
        3,
        1,
        tPlus30m,
        tMinus10m,
        tMinus5m
      );

      insertAttempt.run(
        tenant,
        jobId,
        attemptId,
        1,
        `worker_${i % 4}`,
        state,
        tMinus10m,
        tMinus5m,
        tMinus5m,
        state === 'succeeded' ? tMinus5m : null
      );

      if (state === 'succeeded') {
        insertArtifact.run(
          tenant,
          artId,
          jobId,
          attemptId,
          'video',
          'video/mp4',
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          1024,
          storageKey,
          tPlus30m,
          tMinus5m
        );
      }
    }
    sourceDb.exec('COMMIT;');
  } catch (err) {
    sourceDb.exec('ROLLBACK;');
    throw err;
  } finally {
    sourceDb.exec('PRAGMA foreign_keys = ON;');
  }

  // 1. Benchmark Snapshot Generation
  const snapStart = Date.now();
  const snapshot = BackupManager.createSnapshot(sourceDb, { cutoffTimestamp: now.toISOString() });
  const snapDurationMs = Math.max(1, Date.now() - snapStart);
  const totalRows = Object.values(snapshot.metadata.tableRowCounts).reduce((a, b) => a + b, 0);
  const snapRowsPerSec = Math.round((totalRows / snapDurationMs) * 1000);
  const snapMbPerSec = Number(((snapshot.metadata.bytes / (1024 * 1024)) / (snapDurationMs / 1000)).toFixed(2));

  // Populate mock storage with matching artifact keys
  const storage = new MemoryStorageBackend();
  const dummyBuf = Buffer.alloc(1024);
  const artKeys = sourceDb.prepare('SELECT storage_key FROM artifacts').all();
  for (const r of artKeys) {
    storage.put(r.storage_key, dummyBuf);
  }

  // 2. Benchmark Restore Drill & Replay
  const drillRunner = new RestoreDrillRunner();
  const drillStart = Date.now();
  const drillReport = await drillRunner.runDrill({
    targetCutoffTimestamp: now.toISOString(),
    snapshotPayloadJson: snapshot.payloadJson,
    expectedSnapshotSha256: snapshot.metadata.sha256,
    storage,
  });
  const drillDurationMs = Math.max(1, Date.now() - drillStart);

  const finalMem = process.memoryUsage();
  const heapDeltaMb = Number(((finalMem.heapUsed - initialMem.heapUsed) / (1024 * 1024)).toFixed(2));
  const rssDeltaMb = Number(((finalMem.rss - initialMem.rss) / (1024 * 1024)).toFixed(2));

  return {
    jobCount,
    totalRows,
    snapshot: {
      bytes: snapshot.metadata.bytes,
      durationMs: snapDurationMs,
      rowsPerSec: snapRowsPerSec,
      mbPerSec: snapMbPerSec,
    },
    restoreDrill: {
      durationMs: drillDurationMs,
      rpoSeconds: drillReport.rpo.rpoSeconds,
      rpoMinutes: drillReport.rpo.rpoMinutes,
      rpoTargetMet: drillReport.rpo.rpoTargetMet, // <= 15 min
      rtoSeconds: drillReport.rto.rtoSeconds,
      rtoTargetMet: drillReport.rto.rtoTargetMet, // <= 4 hours
      status: drillReport.status,
      safetyState: drillReport.safetyFlags.safetyState,
      customCodeLocked: !drillReport.safetyFlags.customCodeEnabled,
      remoteImportLocked: !drillReport.safetyFlags.remoteImportEnabled,
    },
    memory: {
      heapDeltaMb,
      rssDeltaMb,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('restore-drill-benchmark.mjs')) {
  runRestoreDrillBenchmark(2000).then((res) => {
    console.log('Restore Drill Benchmark Result:', JSON.stringify(res, null, 2));
  });
}
