/**
 * Operational Cost Modeling for Video Render Jobs.
 * Implements the multi-scenario utilization model (10%, 50%, 80%) defined in docs/OPERATIONS.md & docs/TESTING.md.
 */

import { CostScenario } from './benchmark-types.js';

export interface CostModelInput {
  rtf: number;
  outputDurationSeconds: number;
  outputBytes: number;
  reservedVcpus?: number;
  vcpuHourlyRateUsd?: number;
  hostVcpus?: number;
  storageRatePerGbMonth?: number;
  egressRatePerGb?: number;
}

export const DEFAULT_VCPU_HOURLY_RATE_USD = 0.04;
export const DEFAULT_HOST_VCPUS = 4;
export const DEFAULT_RESERVED_VCPUS = 2;
export const DEFAULT_STORAGE_RATE_PER_GB_MONTH = 0.02;
export const DEFAULT_EGRESS_RATE_PER_GB = 0.05;
export const COMPUTE_BUDGET_CEILING_USD_PER_MIN = 0.05;

/**
 * Calculates cost projections for 10%, 50%, and 80% server capacity utilization.
 */
export function calculateCostScenarios(input: CostModelInput): Record<10 | 50 | 80, CostScenario> {
  const reservedVcpus = input.reservedVcpus ?? DEFAULT_RESERVED_VCPUS;
  const vcpuRate = input.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD;
  const hostVcpus = input.hostVcpus ?? DEFAULT_HOST_VCPUS;
  const storageRate = input.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
  const egressRate = input.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB;

  const hostHourlyCostUsd = hostVcpus * vcpuRate; // 4 * $0.04 = $0.16/h
  const workerHourlyCostUsd = reservedVcpus * vcpuRate; // 2 * $0.04 = $0.08/h
  const concurrentWorkers = Math.max(1, Math.floor(hostVcpus / reservedVcpus)); // 2 concurrent slots

  const outputBytes = input.outputBytes || 1024 * 1024; // fallback 1MB
  const outputSizeGb = outputBytes / (1024 * 1024 * 1024);
  const outputDurationMinutes = Math.max(0.1, input.outputDurationSeconds / 60);

  // Storage cost for 7 days retention (7 days / 30.417 days per month)
  const storageCostJob = outputSizeGb * storageRate * (7 / 30.417);
  const storageCost7dUsd = storageCostJob / outputDurationMinutes;

  // Egress cost for 1 single download
  const egressCostJob = outputSizeGb * egressRate;
  const egressCost1DownloadUsd = egressCostJob / outputDurationMinutes;

  const rtf = Math.max(0.01, input.rtf);

  const buildScenario = (utilizationPercent: 10 | 50 | 80): CostScenario => {
    const utilFraction = utilizationPercent / 100;

    // Output minutes produced per hour at given utilization
    // Total render seconds per host = 3600 * utilFraction * concurrentWorkers
    // Output seconds produced = (3600 * utilFraction * concurrentWorkers) / RTF
    // Output minutes produced = Output seconds / 60 = (60 * utilFraction * concurrentWorkers) / RTF
    const outputMinutesProducedPerHour = (60 * utilFraction * concurrentWorkers) / rtf;

    // Full host cost allocated across the output minutes produced in that hour
    const computeCostPerOutputMinuteUsd =
      outputMinutesProducedPerHour > 0
        ? hostHourlyCostUsd / outputMinutesProducedPerHour
        : (workerHourlyCostUsd * rtf) / 60;

    const totalCostPerOutputMinuteUsd =
      computeCostPerOutputMinuteUsd + storageCost7dUsd + egressCost1DownloadUsd;

    return {
      utilizationPercent,
      hostHourlyCostUsd,
      reservedVcpus,
      workerHourlyCostUsd,
      outputMinutesProducedPerHour: Number(outputMinutesProducedPerHour.toFixed(2)),
      computeCostPerOutputMinuteUsd: Number(computeCostPerOutputMinuteUsd.toFixed(6)),
      storageCost7dUsd: Number(storageCost7dUsd.toFixed(6)),
      egressCost1DownloadUsd: Number(egressCost1DownloadUsd.toFixed(6)),
      totalCostPerOutputMinuteUsd: Number(totalCostPerOutputMinuteUsd.toFixed(6)),
      meetsBudgetCeiling: computeCostPerOutputMinuteUsd <= COMPUTE_BUDGET_CEILING_USD_PER_MIN,
    };
  };

  return {
    10: buildScenario(10),
    50: buildScenario(50),
    80: buildScenario(80),
  };
}
