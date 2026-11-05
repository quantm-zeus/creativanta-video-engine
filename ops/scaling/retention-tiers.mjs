/**
 * Creativanta Video Engine - Storage & Data Retention Tiers Policy
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Retention, webhook và supply chain", lines 63-64:
 *     "Normal 7-day TTL bắt đầu từ asset ready/artifact publication... Metadata/usage 90 ngày, security audit 180 ngày")
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 17, 50, 55:
 *     "Backups expire <= 30d; storage retention 7d, storage_cost = byte-hours/GB-hours")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02: "Usage export/quota plans/retention tiers, pricing simulation và reconciliation")
 */

export const DEFAULT_STORAGE_RATE_PER_GB_MONTH = 0.02;
export const DAYS_PER_MONTH = 30.417;

export const STANDARD_RETENTION_TIERS = Object.freeze({
  ephemeral: Object.freeze({
    tierId: 'ephemeral',
    name: 'Ephemeral / Testing Tier',
    description: 'Ultra short-lived storage for local sandbox, automated CI, and temporary test runs',
    assetsDays: 1,       // 24 hours
    artifactsDays: 1,    // 24 hours
    jobHistoryDays: 7,   // 7 days
    auditLogsDays: 30,   // 30 days
    backupDays: 7,       // 7 days
  }),
  standard: Object.freeze({
    tierId: 'standard',
    name: 'Standard Baseline Tier',
    description: 'Production default compliant with PRD & SECURITY.md (7d media, 90d jobs, 180d audit)',
    assetsDays: 7,       // 7 days normal TTL
    artifactsDays: 7,    // 7 days normal TTL
    jobHistoryDays: 90,  // 90 days metadata retention
    auditLogsDays: 180,  // 180 days security audit retention
    backupDays: 30,      // 30 days max backup retention
  }),
  extended: Object.freeze({
    tierId: 'extended',
    name: 'Extended Pro Tier',
    description: 'Extended retention for active professional creators requiring 30-day asset availability',
    assetsDays: 30,      // 30 days
    artifactsDays: 14,   // 14 days
    jobHistoryDays: 180, // 180 days
    auditLogsDays: 365,  // 1 year
    backupDays: 30,      // 30 days max backup retention
  }),
  archive: Object.freeze({
    tierId: 'archive',
    name: 'Enterprise Archive Tier',
    description: 'Long-term enterprise compliance tier with 90-day assets and 2-year audit trail',
    assetsDays: 90,      // 90 days
    artifactsDays: 30,   // 30 days
    jobHistoryDays: 365, // 1 year
    auditLogsDays: 730,  // 2 years
    backupDays: 30,      // 30 days max backup retention
  }),
});

export class RetentionPolicyManager {
  constructor(options = {}) {
    this.tiers = { ...STANDARD_RETENTION_TIERS, ...(options.customTiers || {}) };
    this.defaultTierId = options.defaultTierId || 'standard';
    this.storageRatePerGbMonth = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
    // Map<tenantId, tierId>
    this.tenantTiers = new Map();
  }

  /**
   * Assigns a retention tier to a specific tenant.
   */
  assignTenantTier(tenantId, tierId) {
    if (!this.tiers[tierId]) {
      throw new Error(`Unknown retention tier '${tierId}'. Available: ${Object.keys(this.tiers).join(', ')}`);
    }
    this.tenantTiers.set(tenantId, tierId);
    return this.tiers[tierId];
  }

  /**
   * Gets the active retention tier for a tenant.
   */
  getTenantTier(tenantId) {
    const tierId = this.tenantTiers.get(tenantId) || this.defaultTierId;
    return this.tiers[tierId] || this.tiers.standard;
  }

  /**
   * Returns retention duration in days for a specific resource kind.
   */
  getRetentionDays(resourceKind, tierId = null) {
    const tier = tierId ? (this.tiers[tierId] || this.tiers.standard) : this.tiers[this.defaultTierId];
    switch (resourceKind) {
      case 'asset':
      case 'assets':
        return tier.assetsDays;
      case 'artifact':
      case 'artifacts':
      case 'video':
      case 'preview':
        return tier.artifactsDays;
      case 'job':
      case 'jobs':
      case 'job_metadata':
        return tier.jobHistoryDays;
      case 'audit':
      case 'audit_log':
      case 'audit_logs':
        return tier.auditLogsDays;
      case 'backup':
      case 'backups':
        return tier.backupDays;
      default:
        return tier.assetsDays;
    }
  }

  /**
   * Calculates the exact expiration date for a resource given its creation time.
   */
  calculateExpirationDate(resourceKind, createdAt, tierId = null) {
    const createdMs = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
    if (isNaN(createdMs)) {
      throw new Error(`Invalid createdAt timestamp: ${createdAt}`);
    }
    const days = this.getRetentionDays(resourceKind, tierId);
    const expiresMs = createdMs + days * 24 * 60 * 60 * 1000;
    return new Date(expiresMs).toISOString();
  }

  /**
   * Checks whether a resource has passed its retention deadline.
   * If the resource has active legal hold, it is never expired.
   */
  isExpired(resourceKind, createdAt, options = {}) {
    if (options.legalHold) {
      return false; // Protected by legal hold
    }
    const tierId = options.tierId || null;
    const referenceTimeMs = options.referenceTime ? Date.parse(options.referenceTime) : Date.now();
    const expiresIso = this.calculateExpirationDate(resourceKind, createdAt, tierId);
    const expiresMs = Date.parse(expiresIso);
    return referenceTimeMs >= expiresMs;
  }

  /**
   * Calculates monthly and duration storage cost for a given byte size and retention duration.
   */
  calculateStorageCost(storedBytes, durationDays = null, tierId = null) {
    const bytes = Number(storedBytes || 0);
    const gigabytes = bytes / (1024 * 1024 * 1024);
    const effectiveDays = durationDays ?? this.getRetentionDays('artifact', tierId);
    const costUsd = gigabytes * this.storageRatePerGbMonth * (effectiveDays / DAYS_PER_MONTH);
    const monthlyRateUsd = gigabytes * this.storageRatePerGbMonth;

    return {
      storedBytes: bytes,
      storedGigabytes: Number(gigabytes.toFixed(6)),
      durationDays: effectiveDays,
      costUsd: Number(costUsd.toFixed(6)),
      monthlyRateUsd: Number(monthlyRateUsd.toFixed(6)),
    };
  }

  /**
   * Evaluates a batch of storage records and identifies purge candidates.
   */
  scanPurgeCandidates(records = [], options = {}) {
    const referenceTimeMs = options.referenceTime ? Date.parse(options.referenceTime) : Date.now();
    const purgeCandidates = [];
    let preservedCount = 0;
    let legalHoldPreservedCount = 0;
    let totalFreedBytes = 0;

    for (const record of records) {
      const resourceKind = record.resourceKind || record.kind || 'artifact';
      const createdAt = record.createdAt || record.created_at;
      const tierId = record.tierId || (record.tenantId ? this.getTenantTier(record.tenantId).tierId : this.defaultTierId);
      const isLegalHold = Boolean(record.legalHold || record.legal_hold);

      if (isLegalHold) {
        preservedCount += 1;
        legalHoldPreservedCount += 1;
        continue;
      }

      const expired = this.isExpired(resourceKind, createdAt, {
        tierId,
        referenceTime: new Date(referenceTimeMs).toISOString(),
        legalHold: isLegalHold,
      });

      if (expired) {
        const bytes = Number(record.bytes || record.sizeBytes || 0);
        totalFreedBytes += bytes;
        purgeCandidates.push({
          id: record.id || record.resourceId,
          resourceKind,
          tenantId: record.tenantId || 'global',
          createdAt,
          expiresAt: this.calculateExpirationDate(resourceKind, createdAt, tierId),
          bytes,
          tierId,
          reason: `RETENTION_EXPIRED_${tierId.toUpperCase()}`,
        });
      } else {
        preservedCount += 1;
      }
    }

    const freedGigabytes = totalFreedBytes / (1024 * 1024 * 1024);
    const estimatedMonthlySavingsUsd = freedGigabytes * this.storageRatePerGbMonth;

    return {
      scannedCount: records.length,
      purgeCandidatesCount: purgeCandidates.length,
      preservedCount,
      legalHoldPreservedCount,
      totalFreedBytes,
      freedGigabytes: Number(freedGigabytes.toFixed(4)),
      estimatedMonthlySavingsUsd: Number(estimatedMonthlySavingsUsd.toFixed(6)),
      purgeCandidates,
    };
  }
}
