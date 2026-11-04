/**
 * Creativanta Video Engine - Per-Tenant Cost Reporter
 * Canonical specification: docs/OPERATIONS.md ("Daily report... Weekly... Mức giá bán/margin chưa quyết", lines 54-56)
 */

import { calculateTenantCostSummary } from './cost-calculator.mjs';

/**
 * Formats a tenant cost summary into an operational Markdown report.
 */
export function formatMarkdownReport(summary) {
  const m = summary.metrics;
  const c = summary.costs;
  const sc = summary.utilizationScenarios;
  const p = summary.pricingAssumptions;

  return `# Per-Tenant Cost Report: ${summary.tenantId}

- **Reporting Period:** ${summary.period}
- **Generated At (UTC):** ${summary.generatedAt}
- **Pricing Basis:** vCPU=$${p.vcpuHourlyRateUsd}/hr (Host $${(p.hostVcpus * p.vcpuHourlyRateUsd).toFixed(2)}/hr), Storage=$${p.storageRatePerGbMonth}/GB-mo (7d TTL), Egress=$${p.egressRatePerGb}/GB
- **Budget Ceiling:** $${p.computeBudgetCeilingUsdPerMin}/output-min

## 1. Workload & Operational Metrics

| Metric | Measured Value |
| --- | --- |
| Jobs Submitted | ${m.submittedCount} |
| Jobs Succeeded | ${m.succeededCount} |
| Jobs Failed | ${m.failedCount} |
| Jobs Canceled | ${m.canceledCount} |
| Billable Output Minutes | ${m.totalBillableOutputMinutes.toFixed(2)} min |
| Actual CPU Seconds (User+Sys) | ${m.totalCpuSecondsActual.toFixed(2)} s |
| Occupied Wall Seconds | ${m.totalWallSeconds.toFixed(2)} s |
| Reserved vCPU Seconds | ${m.totalReservedVcpuSeconds.toFixed(2)} s |
| Average Real-Time Factor (RTF) | ${m.averageRtf.toFixed(2)} |
| Peak Memory Observed | ${(m.peakMemoryBytesObserved / (1024 * 1024)).toFixed(1)} MiB |
| Output Storage Generated | ${(m.totalOutputBytes / (1024 * 1024)).toFixed(2)} MiB |
| Egress Transferred | ${(m.totalEgressBytes / (1024 * 1024)).toFixed(2)} MiB |

## 2. Marginal Cost Summary (Pure Incremental Consumption)

| Component | Cost (USD) | Effective Rate per Output Minute |
| --- | --- | --- |
| Reserved Compute | $${c.marginalComputeCostUsd.toFixed(4)} | $${m.totalBillableOutputMinutes > 0 ? (c.marginalComputeCostUsd / m.totalBillableOutputMinutes).toFixed(6) : '0.000000'} |
| 7-Day Artifact Storage | $${c.storageCostUsd.toFixed(4)} | $${m.totalBillableOutputMinutes > 0 ? (c.storageCostUsd / m.totalBillableOutputMinutes).toFixed(6) : '0.000000'} |
| Single-Download Egress | $${c.egressCostUsd.toFixed(4)} | $${m.totalBillableOutputMinutes > 0 ? (c.egressCostUsd / m.totalBillableOutputMinutes).toFixed(6) : '0.000000'} |
| **Total Marginal Operational Cost** | **$${c.marginalTotalCostUsd.toFixed(4)}** | **$${c.marginalUnitCostPerOutputMinuteUsd.toFixed(6)}** |

## 3. Dedicated Host Allocation Scenarios (10%, 50%, 80% Utilization)

Reflects provisioned capacity allocation under real server idle & utilization envelopes:

| Utilization | Output Min / Host Hour | Compute Cost / Output Min | Fully Allocated Cost / Min | Meets Budget (<$0.05/min)? | Projected Period Cost |
| --- | --- | --- | --- | --- | --- |
| **10% (Low / Idle Spike)** | ${sc[10].outputMinutesProducedPerHour.toFixed(2)} min | $${sc[10].computeCostPerOutputMinuteUsd.toFixed(4)} | $${sc[10].fullyAllocatedCostPerMinuteUsd.toFixed(4)} | ${sc[10].meetsBudgetCeiling ? 'YES' : 'NO (Idle Overhead)'} | $${sc[10].projectedTenantCostUsd.toFixed(2)} |
| **50% (Standard Working)** | ${sc[50].outputMinutesProducedPerHour.toFixed(2)} min | $${sc[50].computeCostPerOutputMinuteUsd.toFixed(4)} | $${sc[50].fullyAllocatedCostPerMinuteUsd.toFixed(4)} | ${sc[50].meetsBudgetCeiling ? 'YES' : 'NO'} | $${sc[50].projectedTenantCostUsd.toFixed(2)} |
| **80% (High / Target)** | ${sc[80].outputMinutesProducedPerHour.toFixed(2)} min | $${sc[80].computeCostPerOutputMinuteUsd.toFixed(4)} | $${sc[80].fullyAllocatedCostPerMinuteUsd.toFixed(4)} | ${sc[80].meetsBudgetCeiling ? 'YES' : 'NO'} | $${sc[80].projectedTenantCostUsd.toFixed(2)} |

---
*Note: In accordance with docs/OPERATIONS.md, this report separates operational compute from commercial billing pricing. Commercial billing and margin policies are deferred until after private beta.*
`;
}

/**
 * Generates Daily Report for a tenant.
 */
export function generateDailyReport(tenantId, jobs = [], dateStr = new Date().toISOString().slice(0, 10)) {
  const summary = calculateTenantCostSummary(tenantId, jobs, { period: `daily-${dateStr}` });
  return {
    summary,
    markdown: formatMarkdownReport(summary),
  };
}

/**
 * Generates Weekly Report for a tenant.
 */
export function generateWeeklyReport(tenantId, jobs = [], weekStr = 'week-latest') {
  const summary = calculateTenantCostSummary(tenantId, jobs, { period: `weekly-${weekStr}` });
  return {
    summary,
    markdown: formatMarkdownReport(summary),
  };
}
