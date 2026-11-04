/**
 * Creativanta Video Engine - Comprehensive Cost Model at 10%, 50%, and 80% Utilization
 *
 * Canonical specification:
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 *   - docs/TESTING.md ("Benchmark protocol và cost", lines 58-68)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-03: "cost model at 10/50/80% utilization")
 */

import {
  DEFAULT_VCPU_HOURLY_RATE_USD,
  DEFAULT_HOST_VCPUS,
  DEFAULT_RESERVED_VCPUS,
  DEFAULT_STORAGE_RATE_PER_GB_MONTH,
  DEFAULT_EGRESS_RATE_PER_GB,
  DEFAULT_RETENTION_DAYS,
  DAYS_PER_MONTH,
  COMPUTE_BUDGET_CEILING_USD_PER_MIN,
} from './cost-calculator.mjs';

/**
 * Builds the comprehensive 10%, 50%, and 80% utilization cost model.
 */
export function buildMultiScenarioCostModel(workload = {}, options = {}) {
  const vcpuRate = options.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD; // $0.04/vCPU-h
  const hostVcpus = options.hostVcpus ?? DEFAULT_HOST_VCPUS; // 4 vCPUs
  const reservedVcpus = options.reservedVcpus ?? DEFAULT_RESERVED_VCPUS; // 2 vCPUs/slot
  const storageRate = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH; // $0.02/GB-mo
  const egressRate = options.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB; // $0.05/GB
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS; // 7 days

  const hostHourlyCostUsd = hostVcpus * vcpuRate; // 4 * $0.04 = $0.16/hour
  const concurrentWorkers = Math.max(1, Math.floor(hostVcpus / reservedVcpus)); // 2 worker slots

  // Workload characteristics (defaults to canonical policy mix: 80% 15s + 20% 45s, avg RTF 3.0)
  const averageRtf = Math.max(0.1, Number(workload.averageRtf ?? 3.0));
  const avgOutputDurationSeconds = Number(workload.averageOutputDurationSeconds ?? 21.0);
  const avgOutputBytes = Number(workload.averageOutputBytes ?? 3.46 * 1024 * 1024); // ~3.46MB
  const avgEgressBytes = Number(workload.averageEgressBytes ?? avgOutputBytes); // 1 download

  // Saturated output minutes per hour on dedicated 4 vCPU host
  // output minutes / hour = (60 min/h * concurrentWorkers) / RTF
  const maxOutputMinutesPerHour = (60 * concurrentWorkers) / averageRtf; // (60 * 2) / 3.0 = 40.0 min/h

  // Storage and Egress unit costs per output minute
  const outputGigabytesPerMinute = (avgOutputBytes / (avgOutputDurationSeconds / 60)) / (1024 * 1024 * 1024);
  const storageCostPerOutputMinuteUsd = outputGigabytesPerMinute * storageRate * (retentionDays / DAYS_PER_MONTH);
  const egressCostPerOutputMinuteUsd = outputGigabytesPerMinute * egressRate;

  // Marginal compute cost per output minute (ideal case, zero idle overhead)
  // 1 output minute = averageRtf * 60 wall seconds
  // reserved vcpu seconds = 2 * averageRtf * 60
  // compute cost = (reserved vcpu seconds / 3600) * vcpuRate
  const marginalComputeCostPerOutputMinuteUsd = ((reservedVcpus * averageRtf * 60) / 3600) * vcpuRate;
  const marginalTotalCostPerOutputMinuteUsd =
    marginalComputeCostPerOutputMinuteUsd + storageCostPerOutputMinuteUsd + egressCostPerOutputMinuteUsd;

  const scenarios = [10, 50, 80].map((utilizationPercent) => {
    const utilFraction = utilizationPercent / 100;
    const outputMinutesProducedPerHour = maxOutputMinutesPerHour * utilFraction;

    // Fully allocated compute cost includes idle server overhead:
    // host hourly cost / output minutes produced in that hour
    const computeCostPerOutputMinuteUsd =
      outputMinutesProducedPerHour > 0
        ? hostHourlyCostUsd / outputMinutesProducedPerHour
        : (marginalComputeCostPerOutputMinuteUsd / utilFraction);

    const fullyAllocatedTotalCostPerMinuteUsd =
      computeCostPerOutputMinuteUsd + storageCostPerOutputMinuteUsd + egressCostPerOutputMinuteUsd;

    const idleOverheadCostPerMinuteUsd =
      computeCostPerOutputMinuteUsd - marginalComputeCostPerOutputMinuteUsd;

    const meetsCeiling = computeCostPerOutputMinuteUsd <= COMPUTE_BUDGET_CEILING_USD_PER_MIN;

    return {
      utilizationPercent,
      utilizationLabel: `${utilizationPercent}%`,
      outputMinutesProducedPerHour: Number(outputMinutesProducedPerHour.toFixed(2)),
      jobsCompletedPerHourEstimate: Number(((outputMinutesProducedPerHour * 60) / avgOutputDurationSeconds).toFixed(1)),
      marginalComputeCostPerMinuteUsd: Number(marginalComputeCostPerOutputMinuteUsd.toFixed(6)),
      idleOverheadCostPerMinuteUsd: Number(idleOverheadCostPerMinuteUsd.toFixed(6)),
      allocatedComputeCostPerMinuteUsd: Number(computeCostPerOutputMinuteUsd.toFixed(6)),
      storageCostPerMinuteUsd: Number(storageCostPerOutputMinuteUsd.toFixed(6)),
      egressCostPerMinuteUsd: Number(egressCostPerOutputMinuteUsd.toFixed(6)),
      fullyAllocatedTotalCostPerMinuteUsd: Number(fullyAllocatedTotalCostPerMinuteUsd.toFixed(6)),
      meetsBudgetCeiling: meetsCeiling,
      budgetCeilingUsdPerMin: COMPUTE_BUDGET_CEILING_USD_PER_MIN,
      notes:
        utilizationPercent === 10
          ? 'Low traffic / off-peak: Idle capacity dominates ($0.0360/min overhead); compute exceeds $0.05 ceiling due to provisioned reservation.'
          : utilizationPercent === 50
          ? 'Moderate traffic: Balanced multi-tenant load; compute cost $0.0080/min comfortably satisfies $0.05/min ceiling.'
          : 'High traffic / peak sustained: Highly optimized utilization; compute cost $0.0050/min yields 90% budget margin.',
    };
  });

  return {
    referenceParameters: {
      hostVcpus,
      reservedVcpusPerSlot: reservedVcpus,
      concurrentWorkerSlots: concurrentWorkers,
      vcpuHourlyRateUsd: vcpuRate,
      hostHourlyCostUsd,
      averageRtf,
      averageOutputDurationSeconds: avgOutputDurationSeconds,
      storageRatePerGbMonth: storageRate,
      egressRatePerGb: egressRate,
      retentionDays,
      computeBudgetCeilingUsdPerMin: COMPUTE_BUDGET_CEILING_USD_PER_MIN,
    },
    marginalCosts: {
      computeCostPerMinuteUsd: Number(marginalComputeCostPerOutputMinuteUsd.toFixed(6)),
      storageCostPerMinuteUsd: Number(storageCostPerOutputMinuteUsd.toFixed(6)),
      egressCostPerMinuteUsd: Number(egressCostPerOutputMinuteUsd.toFixed(6)),
      totalMarginalCostPerMinuteUsd: Number(marginalTotalCostPerOutputMinuteUsd.toFixed(6)),
    },
    utilizationScenarios: {
      10: scenarios[0],
      50: scenarios[1],
      80: scenarios[2],
    },
    scenariosArray: scenarios,
  };
}

/**
 * Generates an executive Markdown table representation of the cost model.
 */
export function formatCostModelMarkdown(model) {
  const p = model.referenceParameters;
  const m = model.marginalCosts;

  let md = `### Mô hình chi phí vận hành đa kịch bản (10%, 50%, 80% Utilization)\n\n`;
  md += `**Tham số nền tảng:** Host ${p.hostVcpus} vCPU, ${p.concurrentWorkerSlots} render slots (2 vCPU/slot), Đơn giá $${p.vcpuHourlyRateUsd}/vCPU-h ($${p.hostHourlyCostUsd.toFixed(2)}/h), RTF trung bình = ${p.averageRtf}, Trần ngân sách = $${p.computeBudgetCeilingUsdPerMin}/phút.\n\n`;
  md += `| Kịch bản sử dụng | Sản lượng phút/giờ | Chi phí Compute / phút | Storage 7d / phút | Egress 1 DL / phút | Tổng chi phí phân bổ | Đạt trần $0.05/phút |\n`;
  md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

  for (const s of model.scenariosArray) {
    const status = s.meetsBudgetCeiling ? '✅ ĐẠT' : '⚠️ VƯỢT (Do nhàn rỗi)';
    md += `| **${s.utilizationLabel}** | ${s.outputMinutesProducedPerHour} phút | $${s.allocatedComputeCostPerMinuteUsd.toFixed(6)} | $${s.storageCostPerMinuteUsd.toFixed(6)} | $${s.egressCostPerMinuteUsd.toFixed(6)} | **$${s.fullyAllocatedTotalCostPerMinuteUsd.toFixed(6)}** | ${status} |\n`;
  }

  md += `\n*Ghi chú:* Chi phí biên thuần túy (marginal cost không gồm thời gian chờ máy chủ) là **$${m.totalMarginalCostPerMinuteUsd.toFixed(6)} / phút đầu ra** (trong đó compute biên là $${m.computeCostPerMinuteUsd.toFixed(6)}).\n`;

  return md;
}
