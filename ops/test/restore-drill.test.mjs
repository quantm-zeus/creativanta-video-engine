/**
 * Test Suite: Disaster Recovery Backup, PITR, Object Consistency & Isolated Restore Drill
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (P6-02: "Backup/PITR + object consistency + restore drill vào isolated env, measured RPO<=15min/RTO<=4h; custom/import stay off sau restore đến revalidation")
 *   - docs/OPERATIONS.md ("SLO mục tiêu", line 16: "Restore | RPO <= 15min, RTO <= 4h")
 *   - docs/OPERATIONS.md ("Runbook: DB/storage outage và restore", lines 77-82)
 *   - docs/DEPLOYMENT.md ("Storage, backup và release", lines 116-118)
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 63-65)
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Kế hoạch Phục hồi Thảm họa & Diễn tập Restore")
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BackupManager,
  BackupIntegrityError,
  CANONICAL_21_TABLES,
  RPO_SLO_SECONDS,
  RTO_SLO_SECONDS,
  SYSTEM_CATALOG_TENANT_ID,
} from '../recovery/backup-manager.mjs';

import {
  ObjectConsistencyReconciler,
  MemoryStorageBackend,
} from '../recovery/object-reconciler.mjs';

import {
  PostRestoreSafetyGate,
  PostRestoreSafetyError,
  SAFETY_STATES,
} from '../recovery/safety-gate-manager.mjs';

import { RestoreDrillRunner } from '../recovery/restore-drill-runner.mjs';
import { MigrationRunner } from '../../packages/api/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupTestDatabase() {
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator', targetVersion: '0002' });
  return db;
}

function seedMultiTenantData(db) {
  const tenantA = '11111111-1111-4111-8111-111111111111';
  const tenantB = '22222222-2222-4222-8222-222222222222';
  const now = new Date();
  const tMinus10m = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const tMinus5m = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const tPlus30m = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      tenantA,
      'Tenant Alpha',
      'active',
      tMinus10m,
      tMinus10m
    );
    db.prepare('INSERT INTO tenants (id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      tenantB,
      'Tenant Beta',
      'active',
      tMinus10m,
      tMinus10m
    );

    // Compositions
    db.prepare(
      `INSERT INTO compositions (tenant_id, id, name, current_revision, editable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantA, 'cmp_test_01', 'Comp Alpha', 1, 1, tMinus10m, tMinus10m);
    db.prepare(
      `INSERT INTO composition_revisions (tenant_id, composition_id, revision, schema_version, spec_json, render_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantA, 'cmp_test_01', 1, '1.0', '{}', '0'.repeat(64), tMinus10m);

    db.prepare(
      `INSERT INTO compositions (tenant_id, id, name, current_revision, editable, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantB, 'cmp_test_02', 'Comp Beta', 1, 1, tMinus10m, tMinus10m);
    db.prepare(
      `INSERT INTO composition_revisions (tenant_id, composition_id, revision, schema_version, spec_json, render_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(tenantB, 'cmp_test_02', 1, '1.0', '{}', '0'.repeat(64), tMinus10m);

    // Jobs for Tenant A
    db.prepare(
      `INSERT INTO jobs (tenant_id, id, kind, state, stage, state_version, progress, composition_id, composition_revision, profile, snapshot_json, attempt_count, max_attempts, lease_epoch, lease_expires_at, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'job_alpha_active',
      'render',
      'rendering',
      'rendering',
      2,
      0.4,
      'cmp_test_01',
      1,
      'mp4-720p-v1',
      '{}',
      1,
      3,
      1,
      tMinus5m, // Expired lease
      tPlus30m,
      tMinus10m,
      tMinus5m
    );

    db.prepare(
      `INSERT INTO jobs (tenant_id, id, kind, state, stage, state_version, progress, composition_id, composition_revision, profile, snapshot_json, attempt_count, max_attempts, lease_epoch, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'job_alpha_cancel',
      'render',
      'cancel_requested',
      'rendering',
      2,
      0.3,
      'cmp_test_01',
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

    db.prepare(
      `INSERT INTO jobs (tenant_id, id, kind, state, stage, state_version, progress, composition_id, composition_revision, profile, snapshot_json, attempt_count, max_attempts, lease_epoch, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'job_alpha_done',
      'render',
      'succeeded',
      'completed',
      3,
      1.0,
      'cmp_test_01',
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

    // Job Attempt
    db.prepare(
      `INSERT INTO job_attempts (tenant_id, job_id, attempt_id, lease_epoch, worker_id, state, started_at, heartbeat_at, lease_expires_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'job_alpha_done',
      'att_done_1',
      1,
      'worker_01',
      'succeeded',
      tMinus10m,
      tMinus5m,
      tMinus5m,
      tMinus5m
    );

    // Artifacts for Tenant A
    db.prepare(
      `INSERT INTO artifacts (tenant_id, id, job_id, attempt_id, kind, mime_type, sha256, bytes, storage_key, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'art_alpha_valid',
      'job_alpha_done',
      'att_done_1',
      'video',
      'video/mp4',
      '5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef',
      1024,
      'tenant/11111111-1111-4111-8111-111111111111/jobs/job_alpha_done/video.mp4',
      tPlus30m,
      tMinus5m
    );

    db.prepare(
      `INSERT INTO artifacts (tenant_id, id, job_id, attempt_id, kind, mime_type, sha256, bytes, storage_key, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'art_alpha_missing',
      'job_alpha_done',
      'att_done_1',
      'thumbnail',
      'image/jpeg',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      2048,
      'tenant/11111111-1111-4111-8111-111111111111/jobs/job_alpha_done/thumb.jpg',
      tPlus30m,
      tMinus5m
    );

    // Assets
    db.prepare(
      `INSERT INTO assets (tenant_id, id, filename, kind, status, current_version, visibility, rights_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'ast_incomplete',
      'uploading_video.mp4',
      'video',
      'uploading',
      1,
      'tenant_private',
      '{"basis":"owned"}',
      tMinus10m,
      tMinus5m
    );

    db.prepare(
      `INSERT INTO asset_versions (tenant_id, asset_id, version, original_sha256, mime_type, bytes, storage_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'ast_incomplete',
      1,
      '0'.repeat(64),
      'video/mp4',
      5000,
      'tenant/11111111-1111-4111-8111-111111111111/assets/ast_incomplete/v1/source.mp4',
      tMinus5m
    );

    // Usage Reservations
    db.prepare(
      `INSERT INTO usage_reservations (tenant_id, job_id, reserved_vcpu_seconds, reserved_output_seconds, created_at, state)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(tenantA, 'job_alpha_cancel', 60.0, 15.0, tMinus10m, 'reserved');

    // Webhooks
    db.prepare(
      `INSERT INTO webhook_endpoints (tenant_id, id, url, state, events_filter_json, active_key_id, secret_ciphertext, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      tenantA,
      'ep_alpha_1',
      'https://example.com/webhook',
      'active',
      JSON.stringify(['render_job.succeeded']),
      'whk_1',
      'enc_secret_1',
      tMinus10m,
      tMinus10m
    );

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }

  return { tenantA, tenantB };
}

describe('P6-02: Disaster Recovery Backup, PITR, Object Consistency & Restore Drill', () => {
  describe('1. Atomic Base Snapshot & Tamper Detection', () => {
    it('creates full snapshot of all 21 tables with SHA-256 integrity hash', () => {
      const db = setupTestDatabase();
      seedMultiTenantData(db);

      const snapshot = BackupManager.createSnapshot(db);
      assert.ok(snapshot.metadata.snapshotId.startsWith('snap_'));
      assert.strictEqual(snapshot.metadata.appliedMigrations.length, 2);
      assert.strictEqual(snapshot.metadata.sha256.length, 64);
      assert.ok(snapshot.metadata.bytes > 1000);

      for (const table of CANONICAL_21_TABLES) {
        assert.ok(typeof snapshot.metadata.tableRowCounts[table] === 'number');
      }

      assert.strictEqual(snapshot.metadata.tableRowCounts['tenants'], 3); // 2 seeded + 1 system catalog
      assert.strictEqual(snapshot.metadata.tableRowCounts['jobs'], 3);
    });

    it('persists and loads snapshot to/from disk and detects tamper modifications', () => {
      const db = setupTestDatabase();
      seedMultiTenantData(db);

      const backupDir = path.join(__dirname, '.test_backups');
      const snapshot = BackupManager.createSnapshot(db);
      const { snapshotPath, metaPath } = BackupManager.saveSnapshotToDisk(
        backupDir,
        snapshot.payloadJson,
        snapshot.metadata
      );

      assert.ok(fs.existsSync(snapshotPath));
      assert.ok(fs.existsSync(metaPath));

      // Clean load verifies integrity
      const loaded = BackupManager.loadSnapshotFromDisk(backupDir, snapshot.metadata.snapshotId);
      assert.strictEqual(loaded.metadata.sha256, snapshot.metadata.sha256);

      // Tamper with payload
      fs.writeFileSync(snapshotPath, snapshot.payloadJson + '/* tampered */', 'utf8');
      assert.throws(
        () => BackupManager.loadSnapshotFromDisk(backupDir, snapshot.metadata.snapshotId),
        (err) => err instanceof BackupIntegrityError && err.code === 'BACKUP_INTEGRITY_MISMATCH'
      );

      // Cleanup
      fs.rmSync(backupDir, { recursive: true, force: true });
    });
  });

  describe('2. WAL Transaction Logging & Point-In-Time Recovery (PITR)', () => {
    it('replays WAL mutations up to cutoff timestamp and ignores post-cutoff entries', () => {
      const db = setupTestDatabase();
      const baseNow = new Date('2026-11-04T02:00:00.000Z');

      const walEntries = [
        {
          lsn: 1,
          timestamp: '2026-11-04T02:05:00.000Z',
          table: 'tenants',
          op: 'INSERT',
          data: {
            id: '99999999-9999-4999-8999-999999999999',
            name: 'WAL Tenant Pre-Cutoff',
            status: 'active',
            created_at: '2026-11-04T02:05:00.000Z',
            updated_at: '2026-11-04T02:05:00.000Z',
          },
        },
        {
          lsn: 2,
          timestamp: '2026-11-04T02:10:00.000Z',
          table: 'tenants',
          op: 'INSERT',
          data: {
            id: '88888888-8888-4888-8888-888888888888',
            name: 'WAL Tenant Post-Cutoff',
            status: 'active',
            created_at: '2026-11-04T02:10:00.000Z',
            updated_at: '2026-11-04T02:10:00.000Z',
          },
        },
      ];

      const cutoffTimestamp = '2026-11-04T02:07:00.000Z';
      const result = BackupManager.replayWalToCutoff(db, walEntries, cutoffTimestamp);

      assert.strictEqual(result.replayedCount, 1);
      assert.strictEqual(result.skippedCount, 1);
      assert.strictEqual(result.lastReplayedTxTimestamp, '2026-11-04T02:05:00.000Z');

      const preRow = db.prepare('SELECT id FROM tenants WHERE id = ?').get('99999999-9999-4999-8999-999999999999');
      assert.ok(preRow);

      const postRow = db.prepare('SELECT id FROM tenants WHERE id = ?').get('88888888-8888-4888-8888-888888888888');
      assert.strictEqual(postRow, undefined);
    });

    it('calculates measured RPO accurately and checks against RPO <= 15m SLO', () => {
      const cutoff = '2026-11-04T03:00:00.000Z';
      const lastTx1 = '2026-11-04T02:50:00.000Z'; // 10 minutes lag
      const rpo1 = BackupManager.calculateRpo(cutoff, lastTx1);
      assert.strictEqual(rpo1.rpoSeconds, 600);
      assert.strictEqual(rpo1.rpoMinutes, 10);
      assert.strictEqual(rpo1.rpoTargetMet, true); // <= 15 min

      const lastTx2 = '2026-11-04T02:40:00.000Z'; // 20 minutes lag
      const rpo2 = BackupManager.calculateRpo(cutoff, lastTx2);
      assert.strictEqual(rpo2.rpoSeconds, 1200);
      assert.strictEqual(rpo2.rpoMinutes, 20);
      assert.strictEqual(rpo2.rpoTargetMet, false); // > 15 min
    });

    it('enforces 30-day backup retention pruning policy and honors legal hold', () => {
      const backupDir = path.join(__dirname, '.test_retention');
      fs.mkdirSync(backupDir, { recursive: true });

      const now = new Date('2026-11-04T03:00:00.000Z');
      const day20Ago = new Date(now.getTime() - 20 * 24 * 3600 * 1000).toISOString();
      const day35Ago = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString();

      // Snapshot 1: 20 days old (retained)
      const snap1Meta = { snapshotId: 'snap_recent', createdAt: day20Ago, legalHold: false };
      fs.writeFileSync(path.join(backupDir, 'snap_recent.meta.json'), JSON.stringify(snap1Meta));
      fs.writeFileSync(path.join(backupDir, 'snap_recent.json'), '{}');

      // Snapshot 2: 35 days old, no hold (pruned)
      const snap2Meta = { snapshotId: 'snap_old_expired', createdAt: day35Ago, legalHold: false };
      fs.writeFileSync(path.join(backupDir, 'snap_old_expired.meta.json'), JSON.stringify(snap2Meta));
      fs.writeFileSync(path.join(backupDir, 'snap_old_expired.json'), '{}');

      // Snapshot 3: 35 days old WITH legal hold (retained)
      const snap3Meta = { snapshotId: 'snap_old_held', createdAt: day35Ago, legalHold: true };
      fs.writeFileSync(path.join(backupDir, 'snap_old_held.meta.json'), JSON.stringify(snap3Meta));
      fs.writeFileSync(path.join(backupDir, 'snap_old_held.json'), '{}');

      const { prunedSnapshots, retainedSnapshots } = BackupManager.pruneExpiredBackups(backupDir, 30, now);

      assert.deepStrictEqual(prunedSnapshots, ['snap_old_expired']);
      assert.ok(retainedSnapshots.includes('snap_recent'));
      assert.ok(retainedSnapshots.includes('snap_old_held'));

      fs.rmSync(backupDir, { recursive: true, force: true });
    });
  });

  describe('3. Object Storage Consistency & Database Reconciler', () => {
    it('detects missing artifacts, rejects incomplete uploads, fences expired leases, and converges cancel requests', () => {
      const db = setupTestDatabase();
      const { tenantA } = seedMultiTenantData(db);

      const storage = new MemoryStorageBackend();
      // Only art_alpha_valid is present in storage
      storage.put(
        'tenant/11111111-1111-4111-8111-111111111111/jobs/job_alpha_done/video.mp4',
        Buffer.alloc(1024)
      );
      // Orphan object in storage
      storage.put('tenant/11111111-1111-4111-8111-111111111111/jobs/orphan_job/video.mp4', Buffer.alloc(512));

      const reconciler = new ObjectConsistencyReconciler(db, storage);
      const report = reconciler.reconcile();

      // 1. Missing artifact flagged
      assert.strictEqual(report.missingStorageArtifacts.length, 1);
      assert.strictEqual(report.missingStorageArtifacts[0], `${tenantA}:art_alpha_missing`);

      // 2. Verified artifact passed
      assert.strictEqual(report.verifiedArtifacts.length, 1);
      assert.strictEqual(report.verifiedArtifacts[0], `${tenantA}:art_alpha_valid`);

      // 3. Incomplete upload rejected
      assert.strictEqual(report.rejectedIncompleteUploads.length, 1);
      assert.strictEqual(report.rejectedIncompleteUploads[0], `${tenantA}:ast_incomplete`);
      const asset = db.prepare('SELECT status FROM assets WHERE id = ?').get('ast_incomplete');
      assert.strictEqual(asset.status, 'rejected');

      // 4. Orphaned storage key detected
      assert.strictEqual(report.orphanedStorageKeys.length, 1);
      assert.strictEqual(
        report.orphanedStorageKeys[0],
        'tenant/11111111-1111-4111-8111-111111111111/jobs/orphan_job/video.mp4'
      );

      // 5. Expired active worker lease requeued with lease_epoch bump (fencing token)
      assert.strictEqual(report.requeuedExpiredJobs.length, 1);
      assert.strictEqual(report.requeuedExpiredJobs[0], `${tenantA}:job_alpha_active`);
      const activeJob = db.prepare('SELECT state, lease_epoch FROM jobs WHERE id = ?').get('job_alpha_active');
      assert.strictEqual(activeJob.state, 'retry_wait');
      assert.strictEqual(activeJob.lease_epoch, 2); // Bumped from 1 to 2

      // 6. In-flight cancel_requested converged to canceled
      assert.strictEqual(report.convergedCanceledJobs.length, 1);
      assert.strictEqual(report.convergedCanceledJobs[0], `${tenantA}:job_alpha_cancel`);
      const cancelJob = db.prepare('SELECT state FROM jobs WHERE id = ?').get('job_alpha_cancel');
      assert.strictEqual(cancelJob.state, 'canceled');

      // 7. Usage reservation released
      assert.strictEqual(report.releasedUsageReservations.length, 1);
      const res = db.prepare('SELECT state FROM usage_reservations WHERE job_id = ?').get('job_alpha_cancel');
      assert.strictEqual(res.state, 'released');

      // 8. Webhook endpoint frozen
      assert.strictEqual(report.disabledWebhookEndpoints.length, 1);
      const ep = db.prepare('SELECT state FROM webhook_endpoints WHERE id = ?').get('ep_alpha_1');
      assert.strictEqual(ep.state, 'disabled');
    });
  });

  describe('4. Post-Restore Safety Gate (custom/import stay off)', () => {
    it('locks custom code, remote import, and outbound webhooks off until operator revalidation', () => {
      const gate = new PostRestoreSafetyGate();
      gate.lockPostRestore();

      assert.strictEqual(gate.state, SAFETY_STATES.RESTORED_PENDING_REVALIDATION);

      // Custom code call is blocked
      assert.throws(
        () => gate.assertCustomCodeAllowed(),
        (err) => err instanceof PostRestoreSafetyError && err.code === 'FEATURE_LOCKED_PENDING_REVALIDATION'
      );

      // Remote import call is blocked
      assert.throws(
        () => gate.assertRemoteImportAllowed(),
        (err) => err instanceof PostRestoreSafetyError && err.code === 'FEATURE_LOCKED_PENDING_REVALIDATION'
      );

      // Outbound webhooks call is blocked
      assert.throws(
        () => gate.assertOutboundWebhooksAllowed(),
        (err) => err instanceof PostRestoreSafetyError && err.code === 'FEATURE_LOCKED_PENDING_REVALIDATION'
      );

      // Revalidation with failing checks is rejected
      assert.throws(
        () =>
          gate.revalidate({
            operator: 'sec_operator_01',
            ticket: 'INC-RESTORE-TEST',
            checks: {
              foreignKeysPassed: false, // FAILED
              objectConsistencyPassed: true,
              tenantIsolationPassed: true,
            },
          }),
        (err) => err instanceof PostRestoreSafetyError && err.code === 'REVALIDATION_CHECKS_FAILED'
      );

      // Revalidation with all checks PASS succeeds and transitions state
      const signoff = gate.revalidate({
        operator: 'sec_operator_01',
        ticket: 'INC-RESTORE-TEST',
        checks: {
          foreignKeysPassed: true,
          objectConsistencyPassed: true,
          tenantIsolationPassed: true,
          catalogIntegrityPassed: true,
        },
        allowEnableFeatures: {
          customCode: false, // Keep custom code off per policy
          remoteImport: true,
          outboundWebhooks: true,
        },
      });

      assert.strictEqual(signoff.state, SAFETY_STATES.REVALIDATED_ACTIVE);
      assert.strictEqual(gate.remoteImportEnabled, true);
      assert.strictEqual(gate.assertRemoteImportAllowed(), true);
      assert.strictEqual(gate.assertOutboundWebhooksAllowed(), true);

      // Custom code still off per explicit policy
      assert.throws(
        () => gate.assertCustomCodeAllowed(),
        (err) => err instanceof PostRestoreSafetyError && err.code === 'FEATURE_DISABLED'
      );
    });
  });

  describe('5. End-to-End Isolated Restore Drill Runner', () => {
    it('executes full drill, verifies RPO<=15m, RTO<=4h, FKs, tenant isolation, and safety locks', async () => {
      const sourceDb = setupTestDatabase();
      const { tenantA } = seedMultiTenantData(sourceDb);

      const now = new Date();
      const cutoff = now.toISOString();

      const snapshot = BackupManager.createSnapshot(sourceDb, { cutoffTimestamp: cutoff });
      const storage = new MemoryStorageBackend();
      storage.put(
        'tenant/11111111-1111-4111-8111-111111111111/jobs/job_alpha_done/video.mp4',
        Buffer.alloc(1024)
      );

      const runner = new RestoreDrillRunner();
      const drillReport = await runner.runDrill({
        targetCutoffTimestamp: cutoff,
        snapshotPayloadJson: snapshot.payloadJson,
        expectedSnapshotSha256: snapshot.metadata.sha256,
        storage,
        now,
      });

      assert.strictEqual(drillReport.status, 'SUCCESS');
      assert.ok(drillReport.drillId.startsWith('drill-'));

      // Measured RPO & RTO SLO checks
      assert.strictEqual(drillReport.rpo.rpoTargetMet, true);
      assert.ok(drillReport.rpo.rpoSeconds <= RPO_SLO_SECONDS);
      assert.strictEqual(drillReport.rto.rtoTargetMet, true);
      assert.ok(drillReport.rto.rtoSeconds <= RTO_SLO_SECONDS);

      // Safety locks stay off
      assert.strictEqual(drillReport.safetyFlags.customCodeEnabled, false);
      assert.strictEqual(drillReport.safetyFlags.remoteImportEnabled, false);
      assert.strictEqual(drillReport.safetyFlags.outboundWebhooksEnabled, false);
      assert.strictEqual(drillReport.safetyFlags.safetyState, SAFETY_STATES.RESTORED_PENDING_REVALIDATION);

      // Verifications
      assert.strictEqual(drillReport.verification.foreignKeysCheck, 'PASS');
      assert.strictEqual(drillReport.verification.tenantIsolationCheck, 'PASS');
      assert.strictEqual(drillReport.verification.catalogIntegrityCheck, 'PASS');
      assert.strictEqual(drillReport.verification.safetyLockEnforced, 'PASS');

      // Operator Revalidation on Restored Instance
      const signoff = drillReport.safetyGate.revalidate({
        operator: 'dr_lead_reviewer',
        ticket: 'DRILL-2026-P602',
        checks: {
          foreignKeysPassed: drillReport.verification.foreignKeysCheck === 'PASS',
          objectConsistencyPassed: drillReport.reconciliation.ledgerInvariantPassed,
          tenantIsolationPassed: drillReport.verification.tenantIsolationCheck === 'PASS',
          catalogIntegrityPassed: drillReport.verification.catalogIntegrityCheck === 'PASS',
        },
      });

      assert.strictEqual(signoff.state, SAFETY_STATES.REVALIDATED_ACTIVE);
    });
  });
});
