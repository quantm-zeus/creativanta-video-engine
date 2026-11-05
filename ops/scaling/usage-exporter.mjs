/**
 * Creativanta Video Engine - Multi-Tenant Usage Exporter
 *
 * Canonical specifications:
 *   - docs/API.md ("Endpoint catalog", line 52: "GET /usage?from=...&to=...", line 172:
 *     "Usage tách operational (mọi attempt, kể cả failed) và billable (logical succeeded render)...")
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02: "Usage export/quota plans/retention tiers, pricing simulation và reconciliation")
 */

import { calculateJobCost, DEFAULT_VCPU_HOURLY_RATE_USD } from '../cost/cost-calculator.mjs';

export const MAX_USAGE_QUERY_WINDOW_DAYS = 31;
export const MAX_USAGE_QUERY_WINDOW_MS = MAX_USAGE_QUERY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export class UsageExporter {
  constructor(options = {}) {
    this.vcpuHourlyRateUsd = options.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD;
  }

  /**
   * Validates and normalizes date range parameters. Enforces max 31-day window limit.
   */
  validateDateRange(fromIso, toIso) {
    if (!fromIso && !toIso) {
      const now = new Date();
      const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { fromIso: past.toISOString(), toIso: now.toISOString() };
    }

    if (fromIso && isNaN(Date.parse(fromIso))) {
      throw new Error("Invalid 'from' timestamp: must be a valid ISO 8601 date-time string");
    }
    if (toIso && isNaN(Date.parse(toIso))) {
      throw new Error("Invalid 'to' timestamp: must be a valid ISO 8601 date-time string");
    }

    let startMs = fromIso ? Date.parse(fromIso) : Date.parse(toIso) - 30 * 24 * 60 * 60 * 1000;
    let endMs = toIso ? Date.parse(toIso) : Date.parse(fromIso) + 30 * 24 * 60 * 60 * 1000;

    if (endMs < startMs) {
      throw new Error("Invalid query window: 'to' must not be earlier than 'from'");
    }

    if (endMs - startMs > MAX_USAGE_QUERY_WINDOW_MS) {
      throw new Error(`Usage query window cannot exceed ${MAX_USAGE_QUERY_WINDOW_DAYS} days`);
    }

    return {
      fromIso: new Date(startMs).toISOString(),
      toIso: new Date(endMs).toISOString(),
    };
  }

  /**
   * Filters and standardizes job records according to filter parameters.
   */
  filterRecords(records = [], filter = {}) {
    const { fromIso, toIso } = this.validateDateRange(filter.from, filter.to);
    const startMs = Date.parse(fromIso);
    const endMs = Date.parse(toIso);

    return records.filter((rec) => {
      // Tenant filter
      if (filter.tenantId && rec.tenantId !== filter.tenantId) {
        return false;
      }
      // Job kind filter
      if (filter.jobKind && rec.jobKind !== filter.jobKind) {
        return false;
      }
      // Profile filter
      if (filter.profile && rec.profile !== filter.profile) {
        return false;
      }
      // Status filter
      if (filter.status && rec.status !== filter.status) {
        return false;
      }

      // Timestamp filter
      const recordTime = rec.completedAt || rec.completed_at || rec.createdAt || rec.created_at;
      if (recordTime) {
        const timeMs = Date.parse(recordTime);
        if (!isNaN(timeMs) && (timeMs < startMs || timeMs > endMs)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Aggregates usage metrics separating operational vs billable quantities.
   */
  aggregateUsage(filteredRecords = [], metadata = {}) {
    let totalSubmitted = filteredRecords.length;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalCanceled = 0;

    let totalWallSeconds = 0;
    let totalCpuSecondsActual = 0;
    let totalReservedVcpuSeconds = 0;
    let totalOutputDurationSeconds = 0;
    let totalBillableOutputMinutes = 0;
    let totalOutputBytes = 0;
    let totalEgressBytes = 0;

    let totalComputeCostUsd = 0;
    let totalStorageCostUsd = 0;
    let totalEgressCostUsd = 0;
    let totalOperationalCostUsd = 0;

    const byTenant = {};
    const byProfile = {};
    const byJobKind = { render: 0, preview: 0 };

    const itemizedRecords = [];

    for (const raw of filteredRecords) {
      const itemCost = calculateJobCost(raw, { vcpuHourlyRateUsd: this.vcpuHourlyRateUsd });
      const tenantId = raw.tenantId || 'global';
      const status = raw.status || 'succeeded';
      const jobKind = raw.jobKind || 'render';
      const profile = raw.profile || 'mp4-720p-v1';

      if (status === 'succeeded') totalSucceeded += 1;
      else if (status === 'canceled') totalCanceled += 1;
      else totalFailed += 1;

      byJobKind[jobKind] = (byJobKind[jobKind] || 0) + 1;
      byProfile[profile] = (byProfile[profile] || 0) + 1;

      totalWallSeconds += itemCost.wallSeconds;
      totalCpuSecondsActual += itemCost.cpuSecondsActual;
      totalReservedVcpuSeconds += itemCost.reservedVcpuSeconds;
      totalOutputDurationSeconds += itemCost.outputDurationSeconds;
      totalBillableOutputMinutes += itemCost.billableOutputMinutes;
      totalOutputBytes += itemCost.outputBytes;
      totalEgressBytes += itemCost.egressBytes;

      totalComputeCostUsd += itemCost.allocatedComputeCostUsd;
      totalStorageCostUsd += itemCost.storageCostUsd;
      totalEgressCostUsd += itemCost.egressCostUsd;
      totalOperationalCostUsd += itemCost.marginalTotalCostUsd;

      // Tenant aggregation bucket
      if (!byTenant[tenantId]) {
        byTenant[tenantId] = {
          tenantId,
          submittedCount: 0,
          succeededCount: 0,
          failedCount: 0,
          canceledCount: 0,
          wallSeconds: 0,
          cpuSecondsActual: 0,
          reservedVcpuSeconds: 0,
          outputDurationSeconds: 0,
          billableOutputMinutes: 0,
          operationalCostUsd: 0,
          billableJobsCount: 0,
        };
      }
      const t = byTenant[tenantId];
      t.submittedCount += 1;
      if (status === 'succeeded') {
        t.succeededCount += 1;
        if (jobKind === 'render') {
          t.billableJobsCount += 1;
        }
      } else if (status === 'canceled') {
        t.canceledCount += 1;
      } else {
        t.failedCount += 1;
      }
      t.wallSeconds += itemCost.wallSeconds;
      t.cpuSecondsActual += itemCost.cpuSecondsActual;
      t.reservedVcpuSeconds += itemCost.reservedVcpuSeconds;
      t.outputDurationSeconds += itemCost.outputDurationSeconds;
      t.billableOutputMinutes += itemCost.billableOutputMinutes;
      t.operationalCostUsd += itemCost.marginalTotalCostUsd;

      // Sanitized itemized record
      itemizedRecords.push({
        tenantId,
        jobId: raw.jobId || raw.id,
        jobKind,
        profile,
        status,
        createdAt: raw.createdAt || raw.created_at || null,
        completedAt: raw.completedAt || raw.completed_at || null,
        wallSeconds: itemCost.wallSeconds,
        cpuSecondsActual: itemCost.cpuSecondsActual,
        reservedVcpuSeconds: itemCost.reservedVcpuSeconds,
        outputDurationSeconds: itemCost.outputDurationSeconds,
        billableOutputMinutes: Number(itemCost.billableOutputMinutes.toFixed(6)),
        outputBytes: itemCost.outputBytes,
        egressBytes: itemCost.egressBytes,
        allocatedComputeCostUsd: itemCost.allocatedComputeCostUsd,
        storageCostUsd: itemCost.storageCostUsd,
        egressCostUsd: itemCost.egressCostUsd,
        totalCostUsd: itemCost.marginalTotalCostUsd,
      });
    }

    // Format tenant summaries with rounded numbers
    for (const tid of Object.keys(byTenant)) {
      byTenant[tid].billableOutputMinutes = Number(byTenant[tid].billableOutputMinutes.toFixed(6));
      byTenant[tid].operationalCostUsd = Number(byTenant[tid].operationalCostUsd.toFixed(6));
    }

    const avgRtf = totalOutputDurationSeconds > 0 ? totalWallSeconds / totalOutputDurationSeconds : 0;
    const costPerBillableMinute = totalBillableOutputMinutes > 0
      ? totalOperationalCostUsd / totalBillableOutputMinutes
      : null;

    return {
      metadata: {
        exportedAt: new Date().toISOString(),
        queryWindow: metadata.queryWindow,
        rateVersion: '2026-11-v1',
        vcpuHourlyRateUsd: this.vcpuHourlyRateUsd,
      },
      summary: {
        totalSubmitted,
        totalSucceeded,
        totalFailed,
        totalCanceled,
        totalBillableJobs: filteredRecords.filter(r => r.status === 'succeeded' && r.jobKind !== 'preview').length,
        operational: {
          totalWallSeconds: Number(totalWallSeconds.toFixed(2)),
          totalCpuSecondsActual: Number(totalCpuSecondsActual.toFixed(2)),
          totalReservedVcpuSeconds: Number(totalReservedVcpuSeconds.toFixed(2)),
          computeCostUsd: Number(totalComputeCostUsd.toFixed(6)),
          storageCostUsd: Number(totalStorageCostUsd.toFixed(6)),
          egressCostUsd: Number(totalEgressCostUsd.toFixed(6)),
          totalOperationalCostUsd: Number(totalOperationalCostUsd.toFixed(6)),
          averageRtf: Number(avgRtf.toFixed(4)),
        },
        billable: {
          totalOutputDurationSeconds: Number(totalOutputDurationSeconds.toFixed(2)),
          totalBillableOutputMinutes: Number(totalBillableOutputMinutes.toFixed(6)),
          costPerBillableMinuteUsd: costPerBillableMinute !== null ? Number(costPerBillableMinute.toFixed(6)) : null,
          note: 'Preview jobs are exempt from billable output minutes but incur operational cost',
        },
        breakdowns: {
          byTenant,
          byProfile,
          byJobKind,
        },
      },
      records: itemizedRecords,
    };
  }

  /**
   * Exports usage as structured JSON.
   */
  exportJson(records = [], filter = {}) {
    const { fromIso, toIso } = this.validateDateRange(filter.from, filter.to);
    const filtered = this.filterRecords(records, filter);
    return this.aggregateUsage(filtered, { queryWindow: { from: fromIso, to: toIso } });
  }

  /**
   * Exports usage as RFC 4180 CSV string.
   */
  exportCsv(records = [], filter = {}) {
    const exportData = this.exportJson(records, filter);
    const headers = [
      'tenant_id',
      'job_id',
      'job_kind',
      'profile',
      'status',
      'created_at',
      'completed_at',
      'wall_seconds',
      'cpu_seconds_actual',
      'reserved_vcpu_seconds',
      'output_duration_seconds',
      'billable_output_minutes',
      'output_bytes',
      'egress_bytes',
      'allocated_compute_cost_usd',
      'storage_cost_usd',
      'egress_cost_usd',
      'total_cost_usd',
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows = [headers.join(',')];
    for (const r of exportData.records) {
      const row = [
        escapeCsv(r.tenantId),
        escapeCsv(r.jobId),
        escapeCsv(r.jobKind),
        escapeCsv(r.profile),
        escapeCsv(r.status),
        escapeCsv(r.createdAt),
        escapeCsv(r.completedAt),
        escapeCsv(r.wallSeconds),
        escapeCsv(r.cpuSecondsActual),
        escapeCsv(r.reservedVcpuSeconds),
        escapeCsv(r.outputDurationSeconds),
        escapeCsv(r.billableOutputMinutes),
        escapeCsv(r.outputBytes),
        escapeCsv(r.egressBytes),
        escapeCsv(r.allocatedComputeCostUsd),
        escapeCsv(r.storageCostUsd),
        escapeCsv(r.egressCostUsd),
        escapeCsv(r.totalCostUsd),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }

  /**
   * Exports usage as line-delimited JSON (JSONL).
   */
  exportJsonl(records = [], filter = {}) {
    const exportData = this.exportJson(records, filter);
    const lines = [];

    // Header metadata record
    lines.push(JSON.stringify({ type: 'header', metadata: exportData.metadata, summary: exportData.summary }));

    // Itemized record lines
    for (const r of exportData.records) {
      lines.push(JSON.stringify({ type: 'usage_entry', ...r }));
    }

    return lines.join('\n');
  }
}
