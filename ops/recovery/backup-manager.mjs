/**
 * Creativanta Video Engine - Disaster Recovery Backup & PITR Manager
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu", line 16: "Restore | RPO <= 15min, RTO <= 4h")
 *   - docs/OPERATIONS.md ("Runbook: DB/storage outage và restore", lines 77-82)
 *   - docs/DEPLOYMENT.md ("Storage, backup và release", line 116: "DB automated backups + WAL/PITR target RPO <= 15min; retention 30d")
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", line 63: "retention tối đa 30 ngày cho backup")
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Kế hoạch Phục hồi Thảm họa & Diễn tập Restore")
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CANONICAL_21_TABLES = Object.freeze([
  'tenants',
  'api_keys',
  'policies',
  'templates',
  'template_revisions',
  'compositions',
  'composition_revisions',
  'assets',
  'asset_versions',
  'scene_bundles',
  'scene_bundle_revisions',
  'jobs',
  'job_attempts',
  'job_events',
  'artifacts',
  'idempotency_records',
  'outbox',
  'webhook_endpoints',
  'webhook_deliveries',
  'usage_reservations',
  'usage_entries',
]);

export const SYSTEM_CATALOG_TENANT_ID = '00000000-0000-0000-0000-000000000000';
export const RPO_SLO_SECONDS = 15 * 60; // 15 minutes (900s)
export const RTO_SLO_SECONDS = 4 * 3600; // 4 hours (14,400s)
export const DEFAULT_BACKUP_RETENTION_DAYS = 30; // 30-day retention per docs/SECURITY.md:63

export class BackupIntegrityError extends Error {
  constructor(message, code = 'BACKUP_INTEGRITY_MISMATCH') {
    super(message);
    this.name = 'BackupIntegrityError';
    this.code = code;
  }
}

/**
 * Backup and Point-In-Time Recovery Manager
 */
export class BackupManager {
  /**
   * Creates an atomic point-in-time snapshot of the database across all 21 canonical tables
   * and schema_migrations with SHA-256 integrity hash.
   *
   * @param {import('node:sqlite').DatabaseSync} db - Active DatabaseSync instance
   * @param {object} [options]
   * @param {string} [options.cutoffTimestamp] - ISO timestamp for cutoff
   * @param {string} [options.snapshotId] - Optional custom snapshot ID
   * @param {boolean} [options.legalHold] - Whether retention hold applies
   * @returns {{ payloadJson: string, metadata: object }}
   */
  static createSnapshot(db, options = {}) {
    const createdAt = new Date().toISOString();
    const cutoffTimestamp = options.cutoffTimestamp ?? createdAt;

    const tablesToDump = ['schema_migrations', ...CANONICAL_21_TABLES];
    const dumpData = {};
    const tableRowCounts = {};

    for (const tbl of tablesToDump) {
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(tbl);
      if (!exists) {
        dumpData[tbl] = [];
        tableRowCounts[tbl] = 0;
        continue;
      }
      const rows = db.prepare(`SELECT * FROM ${tbl}`).all();
      dumpData[tbl] = rows;
      tableRowCounts[tbl] = rows.length;
    }

    const appliedMigrations = (dumpData['schema_migrations'] || []).map((r) => r.version);
    const payload = {
      version: '1.0',
      cutoffTimestamp,
      createdAt,
      appliedMigrations,
      tables: dumpData,
    };

    const payloadJson = JSON.stringify(payload, null, 2);
    const sha256 = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    const snapshotId = options.snapshotId ?? `snap_${sha256.slice(0, 12)}`;

    const metadata = {
      snapshotId,
      createdAt,
      cutoffTimestamp,
      appliedMigrations,
      sha256,
      bytes: Buffer.byteLength(payloadJson, 'utf8'),
      tableRowCounts,
      legalHold: Boolean(options.legalHold),
    };

    return { payloadJson, metadata };
  }

  /**
   * Saves a snapshot and its metadata to the specified backup directory.
   *
   * @param {string} backupDir - Target directory
   * @param {string} payloadJson - JSON snapshot payload
   * @param {object} metadata - Metadata object
   * @returns {{ snapshotPath: string, metaPath: string }}
   */
  static saveSnapshotToDisk(backupDir, payloadJson, metadata) {
    fs.mkdirSync(backupDir, { recursive: true });
    const snapshotPath = path.join(backupDir, `${metadata.snapshotId}.json`);
    const metaPath = path.join(backupDir, `${metadata.snapshotId}.meta.json`);

    fs.writeFileSync(snapshotPath, payloadJson, 'utf8');
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');

    return { snapshotPath, metaPath };
  }

  /**
   * Loads and validates a snapshot from disk, verifying SHA-256 integrity.
   *
   * @param {string} backupDir - Directory containing backups
   * @param {string} snapshotId - Snapshot ID to load
   * @returns {{ payload: object, payloadJson: string, metadata: object }}
   */
  static loadSnapshotFromDisk(backupDir, snapshotId) {
    const snapshotPath = path.join(backupDir, `${snapshotId}.json`);
    const metaPath = path.join(backupDir, `${snapshotId}.meta.json`);

    if (!fs.existsSync(snapshotPath) || !fs.existsSync(metaPath)) {
      throw new BackupIntegrityError(
        `Snapshot '${snapshotId}' files not found in ${backupDir}`,
        'SNAPSHOT_NOT_FOUND'
      );
    }

    const payloadJson = fs.readFileSync(snapshotPath, 'utf8');
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

    const actualSha256 = crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex');
    if (actualSha256 !== metadata.sha256) {
      throw new BackupIntegrityError(
        `Integrity check failed for snapshot ${snapshotId}: expected sha256=${metadata.sha256}, got ${actualSha256}`,
        'BACKUP_INTEGRITY_MISMATCH'
      );
    }

    const payload = JSON.parse(payloadJson);
    return { payload, payloadJson, metadata };
  }

  /**
   * Replays WAL records up to target cutoff timestamp into the database.
   *
   * @param {import('node:sqlite').DatabaseSync} db - DatabaseSync instance
   * @param {Array<object>} walEntries - List of WAL transaction records
   * @param {string} targetCutoffTimestamp - ISO timestamp for cutoff
   * @returns {{ replayedCount: number, skippedCount: number, lastReplayedTxTimestamp: string | null }}
   */
  static replayWalToCutoff(db, walEntries = [], targetCutoffTimestamp) {
    const cutoffMs = Date.parse(targetCutoffTimestamp);
    let replayedCount = 0;
    let skippedCount = 0;
    let lastReplayedTxTimestamp = null;

    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const entry of walEntries) {
        const entryMs = Date.parse(entry.timestamp);
        if (entryMs > cutoffMs) {
          skippedCount++;
          continue;
        }

        const { table, op, data } = entry;
        if (!CANONICAL_21_TABLES.includes(table) && table !== 'schema_migrations') {
          continue;
        }

        if (op === 'INSERT') {
          const cols = Object.keys(data);
          const placeholders = cols.map(() => '?').join(', ');
          const stmt = db.prepare(
            `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`
          );
          stmt.run(...cols.map((c) => data[c]));
        } else if (op === 'UPDATE') {
          const { id, tenant_id, ...updates } = data;
          const setCols = Object.keys(updates);
          if (setCols.length > 0) {
            const setClause = setCols.map((c) => `${c} = ?`).join(', ');
            let sql = `UPDATE ${table} SET ${setClause} WHERE id = ?`;
            const params = [...setCols.map((c) => updates[c]), id];
            if (tenant_id) {
              sql += ' AND tenant_id = ?';
              params.push(tenant_id);
            }
            db.prepare(sql).run(...params);
          }
        } else if (op === 'DELETE') {
          const { id, tenant_id } = data;
          let sql = `DELETE FROM ${table} WHERE id = ?`;
          const params = [id];
          if (tenant_id) {
            sql += ' AND tenant_id = ?';
            params.push(tenant_id);
          }
          db.prepare(sql).run(...params);
        }

        replayedCount++;
        lastReplayedTxTimestamp = entry.timestamp;
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }

    return { replayedCount, skippedCount, lastReplayedTxTimestamp };
  }

  /**
   * Calculates actual measured RPO in seconds and checks whether RPO SLO (<= 15m) is met.
   *
   * @param {string} cutoffTimestamp - Targeted cutoff timestamp (ISO string)
   * @param {string} lastCommittedTxTimestamp - Timestamp of the last committed transaction (ISO string)
   * @returns {{ rpoSeconds: number, rpoMinutes: number, rpoTargetMet: boolean }}
   */
  static calculateRpo(cutoffTimestamp, lastCommittedTxTimestamp) {
    const cutoffMs = Date.parse(cutoffTimestamp);
    const lastTxMs = Date.parse(lastCommittedTxTimestamp);
    const diffMs = Math.max(0, cutoffMs - lastTxMs);
    const rpoSeconds = Math.round(diffMs / 1000);
    const rpoMinutes = Number((rpoSeconds / 60).toFixed(2));
    const rpoTargetMet = rpoSeconds <= RPO_SLO_SECONDS;

    return {
      rpoSeconds,
      rpoMinutes,
      rpoTargetMet,
    };
  }

  /**
   * Prunes backup files older than retentionDays (default 30 days) per docs/SECURITY.md:63,
   * respecting legal/retention holds.
   *
   * @param {string} backupDir - Directory containing backups
   * @param {number} [retentionDays=30] - Max retention in days
   * @param {Date} [now] - Current reference date
   * @returns {{ prunedSnapshots: string[], retainedSnapshots: string[] }}
   */
  static pruneExpiredBackups(backupDir, retentionDays = DEFAULT_BACKUP_RETENTION_DAYS, now = new Date()) {
    if (!fs.existsSync(backupDir)) {
      return { prunedSnapshots: [], retainedSnapshots: [] };
    }

    const maxAgeMs = retentionDays * 24 * 3600 * 1000;
    const nowMs = now.getTime();
    const files = fs.readdirSync(backupDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

    const prunedSnapshots = [];
    const retainedSnapshots = [];

    for (const metaFile of metaFiles) {
      const metaPath = path.join(backupDir, metaFile);
      try {
        const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const ageMs = nowMs - Date.parse(metadata.createdAt);

        if (ageMs > maxAgeMs && !metadata.legalHold) {
          const snapshotId = metadata.snapshotId;
          const snapFile = path.join(backupDir, `${snapshotId}.json`);
          if (fs.existsSync(snapFile)) fs.unlinkSync(snapFile);
          if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
          prunedSnapshots.push(snapshotId);
        } else {
          retainedSnapshots.push(metadata.snapshotId);
        }
      } catch (err) {
        // Leave corrupted file intact for investigation
      }
    }

    return { prunedSnapshots, retainedSnapshots };
  }
}
