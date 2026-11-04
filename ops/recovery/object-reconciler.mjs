/**
 * Creativanta Video Engine - Object Storage Consistency & Database Reconciler
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("Runbook: DB/storage outage và restore", lines 77-82)
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", lines 123-125)
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 63-65)
 *   - migrations/ROLLBACK_AND_RECOVERY.md ("Bước 3 & Bước 4: Đối soát nhất quán giữa DB và Object Storage")
 */

import crypto from 'node:crypto';

/**
 * Storage Backend Adapter Interface for in-memory or filesystem/S3 stores.
 */
export class MemoryStorageBackend {
  constructor(initialObjects = new Map()) {
    /** @type {Map<string, { buffer: Buffer, sha256: string, bytes: number, lastModified: string }>} */
    this.objects = new Map();
    for (const [key, val] of initialObjects.entries()) {
      if (Buffer.isBuffer(val)) {
        this.put(key, val);
      } else if (typeof val === 'string') {
        this.put(key, Buffer.from(val, 'utf8'));
      } else {
        this.objects.set(key, val);
      }
    }
  }

  has(key) {
    return this.objects.has(key);
  }

  get(key) {
    const entry = this.objects.get(key);
    return entry ? entry.buffer : null;
  }

  stat(key) {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      bytes: entry.bytes,
      sha256: entry.sha256,
      lastModified: entry.lastModified,
    };
  }

  put(key, buffer) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    this.objects.set(key, {
      buffer: buf,
      bytes: buf.byteLength,
      sha256,
      lastModified: new Date().toISOString(),
    });
  }

  delete(key) {
    return this.objects.delete(key);
  }

  listKeys() {
    return Array.from(this.objects.keys());
  }
}

/**
 * Reconciles Object Storage and Database state during disaster recovery or restore drills.
 */
export class ObjectConsistencyReconciler {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {MemoryStorageBackend | { has(key): boolean, stat(key): { bytes: number, sha256: string } | null, listKeys(): string[] }} storage
   */
  constructor(db, storage) {
    this.db = db;
    this.storage = storage;
  }

  /**
   * Performs full post-restore reconciliation across artifacts, assets, worker leases,
   * cancellations, outbound webhooks, and billing reservations.
   *
   * @param {object} [options]
   * @param {Date} [options.now] - Current reference date
   * @returns {object} Reconciliation report
   */
  reconcile(options = {}) {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();

    const report = {
      reconciledAt: nowIso,
      missingStorageArtifacts: [],
      corruptedStorageArtifacts: [],
      verifiedArtifacts: [],
      rejectedIncompleteUploads: [],
      orphanedStorageKeys: [],
      requeuedExpiredJobs: [],
      failedExpiredJobs: [],
      convergedCanceledJobs: [],
      disabledWebhookEndpoints: [],
      releasedUsageReservations: [],
      ledgerInvariantPassed: true,
    };

    this.db.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Reconcile Published Artifacts
      const artifacts = this.db
        .prepare('SELECT tenant_id, id, storage_key, sha256, bytes FROM artifacts WHERE revoked_at IS NULL')
        .all();

      for (const art of artifacts) {
        const itemRef = `${art.tenant_id}:${art.id}`;
        if (!this.storage.has(art.storage_key)) {
          report.missingStorageArtifacts.push(itemRef);
        } else {
          const stat = this.storage.stat(art.storage_key);
          if (stat && (stat.sha256 !== art.sha256 || stat.bytes !== art.bytes)) {
            report.corruptedStorageArtifacts.push(itemRef);
          } else {
            report.verifiedArtifacts.push(itemRef);
          }
        }
      }

      // 2. Reconcile Incomplete Asset Uploads
      const pendingAssets = this.db
        .prepare("SELECT tenant_id, id, current_version FROM assets WHERE status IN ('uploading', 'processing')")
        .all();

      for (const asset of pendingAssets) {
        const itemRef = `${asset.tenant_id}:${asset.id}`;
        const ver = this.db
          .prepare('SELECT storage_key FROM asset_versions WHERE tenant_id = ? AND asset_id = ? AND version = ?')
          .get(asset.tenant_id, asset.id, asset.current_version);

        if (!ver || !this.storage.has(ver.storage_key)) {
          this.db
            .prepare("UPDATE assets SET status = 'rejected', updated_at = ? WHERE tenant_id = ? AND id = ?")
            .run(nowIso, asset.tenant_id, asset.id);
          report.rejectedIncompleteUploads.push(itemRef);
        }
      }

      // 3. Detect Orphaned Storage Objects
      const allStorageKeys = this.storage.listKeys ? this.storage.listKeys() : [];
      if (allStorageKeys.length > 0) {
        const referencedKeys = new Set();
        const artKeys = this.db.prepare('SELECT storage_key FROM artifacts').all();
        for (const r of artKeys) referencedKeys.add(r.storage_key);

        const assetKeys = this.db.prepare('SELECT storage_key FROM asset_versions').all();
        for (const r of assetKeys) referencedKeys.add(r.storage_key);

        for (const key of allStorageKeys) {
          if (!referencedKeys.has(key)) {
            report.orphanedStorageKeys.push(key);
          }
        }
      }

      // 4. Converge in-flight cancel_requested jobs to terminal canceled
      const cancelRequestedJobs = this.db
        .prepare("SELECT tenant_id, id, state_version FROM jobs WHERE state = 'cancel_requested'")
        .all();

      for (const job of cancelRequestedJobs) {
        const nextVersion = job.state_version + 1;
        this.db
          .prepare(
            `UPDATE jobs
             SET state = 'canceled', stage = 'canceled', state_version = ?, active_attempt_id = NULL,
                 lease_expires_at = NULL, completed_at = ?, updated_at = ?
             WHERE tenant_id = ? AND id = ?`
          )
          .run(nextVersion, nowIso, nowIso, job.tenant_id, job.id);
        report.convergedCanceledJobs.push(`${job.tenant_id}:${job.id}`);

        const rel = this.db
          .prepare(
            `UPDATE usage_reservations
             SET state = 'released', settled_at = ?
             WHERE tenant_id = ? AND job_id = ? AND state = 'reserved'`
          )
          .run(nowIso, job.tenant_id, job.id);
        if (rel.changes > 0) {
          report.releasedUsageReservations.push(`${job.tenant_id}:${job.id}`);
        }
      }

      // 5. Reconcile Active Worker Leases and Update Fencing Tokens
      const activeJobs = this.db
        .prepare(
          `SELECT tenant_id, id, state, state_version, attempt_count, max_attempts, lease_epoch, lease_expires_at, deadline_at
           FROM jobs
           WHERE state IN ('preparing', 'rendering', 'encoding', 'verifying')`
        )
        .all();

      for (const job of activeJobs) {
        const leaseExpired = !job.lease_expires_at || Date.parse(job.lease_expires_at) <= now.getTime();
        if (!leaseExpired) continue;

        const deadlineExceeded = Date.parse(job.deadline_at) <= now.getTime();
        const nextVersion = job.state_version + 1;
        const nextFence = job.lease_epoch + 1; // Advance fencing token

        if (!deadlineExceeded && job.attempt_count < job.max_attempts) {
          this.db
            .prepare(
              `UPDATE jobs
               SET state = 'retry_wait', stage = 'retry_wait', state_version = ?,
                   lease_epoch = ?, active_attempt_id = NULL, lease_expires_at = NULL, updated_at = ?
               WHERE tenant_id = ? AND id = ?`
            )
            .run(nextVersion, nextFence, nowIso, job.tenant_id, job.id);
          report.requeuedExpiredJobs.push(`${job.tenant_id}:${job.id}`);
        } else {
          const errorCode = deadlineExceeded ? 'JOB_DEADLINE_EXCEEDED' : 'WORKER_LOST';
          this.db
            .prepare(
              `UPDATE jobs
               SET state = 'failed', stage = 'failed', state_version = ?,
                   lease_epoch = ?, active_attempt_id = NULL, lease_expires_at = NULL,
                   error_json = ?, completed_at = ?, updated_at = ?
               WHERE tenant_id = ? AND id = ?`
            )
            .run(
              nextVersion,
              nextFence,
              JSON.stringify({
                code: errorCode,
                message: 'Job terminated during post-restore lease reconciliation',
                retryable: false,
              }),
              nowIso,
              nowIso,
              job.tenant_id,
              job.id
            );
          report.failedExpiredJobs.push(`${job.tenant_id}:${job.id}`);

          const rel = this.db
            .prepare(
              `UPDATE usage_reservations
               SET state = 'released', settled_at = ?
               WHERE tenant_id = ? AND job_id = ? AND state = 'reserved'`
            )
            .run(nowIso, job.tenant_id, job.id);
          if (rel.changes > 0) {
            report.releasedUsageReservations.push(`${job.tenant_id}:${job.id}`);
          }
        }
      }

      // 6. Freeze Outbound Webhook Delivery Egress
      const endpoints = this.db
        .prepare("SELECT tenant_id, id FROM webhook_endpoints WHERE state != 'disabled'")
        .all();

      for (const ep of endpoints) {
        this.db
          .prepare(
            "UPDATE webhook_endpoints SET state = 'disabled', updated_at = ? WHERE tenant_id = ? AND id = ?"
          )
          .run(nowIso, ep.tenant_id, ep.id);
        report.disabledWebhookEndpoints.push(`${ep.tenant_id}:${ep.id}`);
      }

      // 7. Verify Usage Ledger Invariant: At most 1 billable entry per (tenant_id, job_id, meter, ledger_version)
      const duplicateEntries = this.db
        .prepare(
          `SELECT tenant_id, job_id, meter, ledger_version, COUNT(*) as cnt
           FROM usage_entries
           WHERE job_id IS NOT NULL
           GROUP BY tenant_id, job_id, meter, ledger_version
           HAVING cnt > 1`
        )
        .all();

      if (duplicateEntries.length > 0) {
        report.ledgerInvariantPassed = false;
      }

      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }

    return report;
  }
}
