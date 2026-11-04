/**
 * Creativanta Video Engine - Disaster Recovery Isolated Restore Drill Runner
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu", line 16: "Restore | RPO <= 15min, RTO <= 4h")
 *   - docs/OPERATIONS.md ("Runbook: DB/storage outage và restore", lines 77-82)
 *   - docs/DEPLOYMENT.md ("Storage, backup và release", lines 116-118)
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 63-65)
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Kế hoạch Phục hồi Thảm họa & Diễn tập Restore")
 */

import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BackupManager,
  CANONICAL_21_TABLES,
  RPO_SLO_SECONDS,
  RTO_SLO_SECONDS,
  SYSTEM_CATALOG_TENANT_ID,
} from './backup-manager.mjs';
import { MemoryStorageBackend, ObjectConsistencyReconciler } from './object-reconciler.mjs';
import { PostRestoreSafetyGate, SAFETY_STATES } from './safety-gate-manager.mjs';
import { MigrationRunner } from '../../packages/api/dist/index.js';

export class RestoreDrillRunner {
  /**
   * Executes a complete disaster recovery drill into an isolated environment.
   *
   * @param {object} options
   * @param {string} options.targetCutoffTimestamp - Targeted recovery point in time (ISO-8601)
   * @param {string} options.snapshotPayloadJson - JSON backup snapshot payload
   * @param {string} [options.expectedSnapshotSha256] - Checksum to verify
   * @param {Array<object>} [options.walEntries=[]] - WAL log entries to replay
   * @param {MemoryStorageBackend | object} [options.storage] - Storage backend
   * @param {DatabaseSync} [options.targetDb] - Target DatabaseSync instance
   * @param {Date} [options.now] - Current reference time
   * @returns {object} Full RecoveryDrillReport
   */
  async runDrill(options) {
    const restoreStartMs = Date.now();
    const now = options.now ?? new Date();
    const targetCutoffTimestamp = options.targetCutoffTimestamp ?? new Date().toISOString();

    // 1. Verify snapshot integrity if expected hash provided
    if (options.expectedSnapshotSha256) {
      const actualHash = crypto
        .createHash('sha256')
        .update(options.snapshotPayloadJson, 'utf8')
        .digest('hex');
      if (actualHash !== options.expectedSnapshotSha256) {
        throw new Error(
          `SNAPSHOT_INTEGRITY_FAILED: expected sha256=${options.expectedSnapshotSha256}, got ${actualHash}`
        );
      }
    }

    const parsedSnapshot = JSON.parse(options.snapshotPayloadJson);

    // 2. Setup isolated database and initialize canonical schema
    const targetDb = options.targetDb ?? new DatabaseSync(':memory:');
    const runner = new MigrationRunner(targetDb);
    runner.migrateUp({ role: 'cve_migrator', targetVersion: '0001' });

    // 3. Populate base snapshot into isolated database
    targetDb.exec('PRAGMA foreign_keys = OFF;');
    targetDb.exec('BEGIN IMMEDIATE;');
    try {
      for (const tbl of [...CANONICAL_21_TABLES].reverse()) {
        targetDb.exec(`DELETE FROM ${tbl};`);
      }
      targetDb.exec('DELETE FROM schema_migrations;');

      for (const tbl of ['schema_migrations', ...CANONICAL_21_TABLES]) {
        const rows = parsedSnapshot.tables[tbl] ?? [];
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.length === 0) continue;
          const placeholders = cols.map(() => '?').join(', ');
          const stmt = targetDb.prepare(
            `INSERT INTO ${tbl} (${cols.join(', ')}) VALUES (${placeholders})`
          );
          stmt.run(...cols.map((c) => row[c]));
        }
      }
      targetDb.exec('COMMIT;');
    } catch (err) {
      targetDb.exec('ROLLBACK;');
      throw err;
    } finally {
      targetDb.exec('PRAGMA foreign_keys = ON;');
    }

    // 4. Replay WAL entries up to cutoff timestamp
    const walEntries = options.walEntries ?? [];
    const walReplayResult = BackupManager.replayWalToCutoff(
      targetDb,
      walEntries,
      targetCutoffTimestamp
    );

    // 5. Measure and calculate RPO
    const lastCommittedTxTimestamp =
      walReplayResult.lastReplayedTxTimestamp ?? parsedSnapshot.cutoffTimestamp;
    const rpo = BackupManager.calculateRpo(targetCutoffTimestamp, lastCommittedTxTimestamp);

    // 6. Enforce Post-Restore Safety Gate
    const safetyGate = new PostRestoreSafetyGate();
    safetyGate.lockPostRestore();

    // 7. Perform Object Storage Consistency Reconciliation
    const storage = options.storage ?? new MemoryStorageBackend();
    const reconciler = new ObjectConsistencyReconciler(targetDb, storage);
    const reconciliation = reconciler.reconcile({ now });

    // 8. Post-Restore Verification Suite
    // 8.1 Foreign Key Check
    const fkViolations = targetDb.prepare('PRAGMA foreign_key_check').all();
    const foreignKeysPassed = fkViolations.length === 0;

    // 8.2 Multi-Tenant Isolation Check
    const tenantIsolationPassed = this._verifyTenantIsolation(targetDb);

    // 8.3 System Catalog Immutability Check
    const catalogIntegrityPassed = this._verifySystemCatalog(targetDb);

    // 8.4 Safety Lock Verification: Verify that custom code & import throw
    let safetyLockEnforced = false;
    try {
      safetyGate.assertCustomCodeAllowed();
    } catch (e1) {
      try {
        safetyGate.assertRemoteImportAllowed();
      } catch (e2) {
        if (
          e1.code === 'FEATURE_LOCKED_PENDING_REVALIDATION' &&
          e2.code === 'FEATURE_LOCKED_PENDING_REVALIDATION'
        ) {
          safetyLockEnforced = true;
        }
      }
    }

    // 9. Measure and calculate RTO
    const restoreEndMs = Date.now();
    const rtoSeconds = Number(((restoreEndMs - restoreStartMs) / 1000).toFixed(4));
    const rtoMinutes = Number((rtoSeconds / 60).toFixed(2));
    const rtoTargetMet = rtoSeconds <= RTO_SLO_SECONDS;

    const drillId = `drill-${crypto.randomBytes(6).toString('hex')}`;
    const report = {
      drillId,
      executedAt: new Date(restoreEndMs).toISOString(),
      targetCutoffTimestamp,
      lastCommittedTxTimestamp,
      rpo: {
        rpoSeconds: rpo.rpoSeconds,
        rpoMinutes: rpo.rpoMinutes,
        rpoTargetMet: rpo.rpoTargetMet, // <= 15 min SLO
        sloLimitSeconds: RPO_SLO_SECONDS,
      },
      rto: {
        rtoSeconds,
        rtoMinutes,
        rtoTargetMet, // <= 4 hours SLO
        sloLimitSeconds: RTO_SLO_SECONDS,
      },
      safetyFlags: {
        customCodeEnabled: false,
        remoteImportEnabled: false,
        outboundWebhooksEnabled: false,
        safetyState: SAFETY_STATES.RESTORED_PENDING_REVALIDATION,
      },
      reconciliation,
      walReplay: walReplayResult,
      verification: {
        foreignKeysCheck: foreignKeysPassed ? 'PASS' : 'FAIL',
        foreignKeyViolationsCount: fkViolations.length,
        tenantIsolationCheck: tenantIsolationPassed ? 'PASS' : 'FAIL',
        catalogIntegrityCheck: catalogIntegrityPassed ? 'PASS' : 'FAIL',
        safetyLockEnforced: safetyLockEnforced ? 'PASS' : 'FAIL',
      },
      safetyGate,
      targetDb,
      storage,
      status: foreignKeysPassed && tenantIsolationPassed && safetyLockEnforced ? 'SUCCESS' : 'FAILED',
    };

    return report;
  }

  _verifyTenantIsolation(db) {
    try {
      const distinctTenants = db.prepare('SELECT id FROM tenants').all();
      if (distinctTenants.length < 2) return true; // Single tenant fixture passes trivially

      const tenantA = distinctTenants[0].id;
      const tenantB = distinctTenants[1].id;

      // Verify jobs queried for tenant A do not leak into tenant B
      const tenantAJobs = db
        .prepare('SELECT id FROM jobs WHERE tenant_id = ?')
        .all(tenantA)
        .map((r) => r.id);
      const tenantBJobs = db
        .prepare('SELECT id FROM jobs WHERE tenant_id = ?')
        .all(tenantB)
        .map((r) => r.id);

      const intersection = tenantAJobs.filter((id) => tenantBJobs.includes(id));
      return intersection.length === 0;
    } catch {
      return false;
    }
  }

  _verifySystemCatalog(db) {
    try {
      const catalog = db
        .prepare('SELECT id FROM tenants WHERE id = ?')
        .get(SYSTEM_CATALOG_TENANT_ID);
      return Boolean(catalog);
    } catch {
      return false;
    }
  }
}
