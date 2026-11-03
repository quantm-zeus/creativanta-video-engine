/**
 * Storage & Temp File Sweeper (Task P3-05).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 61-64)
 *   - docs/DEPLOYMENT.md ("Object storage và CDN", line 114)
 *   - docs/API.md ("Quy tắc chung", lines 9-11 & status taxonomy)
 */

import { TenantRepository } from '../db/repository.js';
import { QuarantineStore } from '../assets/quarantine-store.js';
import {
  StorageGrantRevocationStore,
  defaultGrantRevocationStore,
} from '../assets/upload-grant.js';

export interface SweeperOptions {
  repository: TenantRepository;
  quarantineStore: QuarantineStore;
  revocationStore?: StorageGrantRevocationStore;
  defaultAssetRetentionDays?: number;
  defaultArtifactRetentionDays?: number;
  defaultIdempotencyRetentionDays?: number;
  defaultQuarantineOrphanTtlMs?: number;
  defaultAttemptTempOrphanTtlMs?: number;
}

export interface SweepResult {
  startedAt: string;
  completedAt: string;
  quarantineFilesRemoved: number;
  quarantineBytesReclaimed: number;
  attemptTempDirsRemoved: number;
  attemptTempFilesRemoved: number;
  attemptTempBytesReclaimed: number;
  grantsRevokedOrExpired: number;
  assetsExpired: number;
  artifactsExpired: number;
  idempotencyRecordsPruned: number;
}

export class StorageTempSweeper {
  private readonly repository: TenantRepository;
  private readonly quarantineStore: QuarantineStore;
  private readonly revocationStore: StorageGrantRevocationStore;
  private readonly defaultAssetRetentionDays: number;
  private readonly defaultArtifactRetentionDays: number;
  private readonly defaultIdempotencyRetentionDays: number;
  private readonly defaultQuarantineOrphanTtlMs: number;
  private readonly defaultAttemptTempOrphanTtlMs: number;

  constructor(options: SweeperOptions) {
    this.repository = options.repository;
    this.quarantineStore = options.quarantineStore;
    this.revocationStore = options.revocationStore ?? defaultGrantRevocationStore;
    this.defaultAssetRetentionDays = options.defaultAssetRetentionDays ?? 7;
    this.defaultArtifactRetentionDays = options.defaultArtifactRetentionDays ?? 7;
    this.defaultIdempotencyRetentionDays = options.defaultIdempotencyRetentionDays ?? 7;
    // 24 hours default orphan cleanup per docs/DEPLOYMENT.md:114 & docs/ARCHITECTURE.md:92
    this.defaultQuarantineOrphanTtlMs = options.defaultQuarantineOrphanTtlMs ?? 24 * 60 * 60 * 1000;
    this.defaultAttemptTempOrphanTtlMs =
      options.defaultAttemptTempOrphanTtlMs ??
      options.defaultQuarantineOrphanTtlMs ??
      24 * 60 * 60 * 1000;
  }

  /**
   * Executes a complete sweep of orphan quarantine files, orphan attempt temp directories
   * (excluding active live leases), expired grants, expired assets/artifacts retention,
   * and expired idempotency records.
   */
  public sweep(options?: {
    now?: Date;
    assetRetentionDays?: number;
    artifactRetentionDays?: number;
    idempotencyRetentionDays?: number;
    quarantineMaxAgeMs?: number;
    attemptTempMaxAgeMs?: number;
  }): SweepResult {
    const now = options?.now ?? new Date();
    const startedAt = now.toISOString();

    // 1. Sweep orphan quarantine files
    const quarantineResult = this.quarantineStore.sweepQuarantine(
      options?.quarantineMaxAgeMs ?? this.defaultQuarantineOrphanTtlMs,
      now,
    );

    // 2. Sweep orphan attempt temp directories while preserving live leases ("don't delete live lease output")
    const liveAttemptKeys = this.repository.getLiveLeasedAttemptKeys(now);
    const attemptTempResult = this.quarantineStore.sweepOrphanAttemptTempDirs({
      maxAgeMs:
        options?.attemptTempMaxAgeMs ??
        options?.quarantineMaxAgeMs ??
        this.defaultAttemptTempOrphanTtlMs,
      now,
      liveAttemptKeys,
    });

    // 3. Sweep expired grant revocations
    const grantsCleaned = this.revocationStore.sweepExpired(now.getTime());

    // 4. Sweep database records and cascade deletions
    const dbResult = this.repository.sweepExpiredRecords({
      now,
      assetRetentionDays: options?.assetRetentionDays ?? this.defaultAssetRetentionDays,
      artifactRetentionDays: options?.artifactRetentionDays ?? this.defaultArtifactRetentionDays,
      idempotencyRetentionDays: options?.idempotencyRetentionDays ?? this.defaultIdempotencyRetentionDays,
    });

    const completedAt = new Date().toISOString();

    return {
      startedAt,
      completedAt,
      quarantineFilesRemoved: quarantineResult.removedFiles,
      quarantineBytesReclaimed: quarantineResult.bytesReclaimed,
      attemptTempDirsRemoved: attemptTempResult.dirsRemoved,
      attemptTempFilesRemoved: attemptTempResult.filesRemoved,
      attemptTempBytesReclaimed: attemptTempResult.bytesReclaimed,
      grantsRevokedOrExpired: grantsCleaned,
      assetsExpired: dbResult.assetsExpired,
      artifactsExpired: dbResult.artifactsExpired,
      idempotencyRecordsPruned: dbResult.idempotencyRecordsPruned,
    };
  }
}
