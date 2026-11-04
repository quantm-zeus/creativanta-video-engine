/**
 * Creativanta Video Engine - Operational Cost Calculator
 * Canonical specification: docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 */

export const DEFAULT_VCPU_HOURLY_RATE_USD = 0.04;
export const DEFAULT_HOST_VCPUS = 4;
export const DEFAULT_RESERVED_VCPUS = 2;
export const DEFAULT_STORAGE_RATE_PER_GB_MONTH = 0.02;
export const DEFAULT_EGRESS_RATE_PER_GB = 0.05;
export const DEFAULT_RETENTION_DAYS = 7;
export const DAYS_PER_MONTH = 30.417;
export const COMPUTE_BUDGET_CEILING_USD_PER_MIN = 0.05;

/**
 * Calculates itemized costs for a single render or preview job execution.
 */
export function calculateJobCost(job = {}, options = {}) {
  const vcpuRate = options.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD;
  const reservedVcpus = job.reservedVcpus ?? options.reservedVcpus ?? DEFAULT_RESERVED_VCPUS;
  const storageRate = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
  const egressRate = options.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  const wallSeconds = Number(job.wallSeconds || 0);
  const cpuSecondsActual = Number(job.cpuSecondsActual || 0);
  const outputDurationSeconds = Number(job.outputDurationSeconds || 0);
  const outputBytes = Number(job.outputBytes || 0);
  const egressBytes = Number(job.egressBytes || outputBytes); // fallback to 1 download
  const isSucceeded = job.status === 'succeeded';
  const isPreview = job.jobKind === 'preview';

  // 1. Compute quantities
  const reservedVcpuSeconds = reservedVcpus * wallSeconds;
  const allocatedComputeCostUsd = (reservedVcpuSeconds / 3600) * vcpuRate;

  // 2. Storage quantities (7-day standard retention)
  const outputGigabytes = outputBytes / (1024 * 1024 * 1024);
  const storageCostUsd = outputGigabytes * storageRate * (retentionDays / DAYS_PER_MONTH);

  // 3. Egress quantities
  const egressGigabytes = egressBytes / (1024 * 1024 * 1024);
  const egressCostUsd = egressGigabytes * egressRate;

  // 4. Marginal operational cost (Compute + Storage + Egress)
  const marginalTotalCostUsd = allocatedComputeCostUsd + storageCostUsd + egressCostUsd;

  // 5. Output minute calculations
  const outputMinutes = outputDurationSeconds / 60;
  const billableOutputMinutes = isSucceeded && !isPreview ? outputMinutes : 0;

  const rtf = outputDurationSeconds > 0 ? wallSeconds / outputDurationSeconds : 0;

  return {
    jobId: job.jobId || 'unknown',
    status: job.status || 'unknown',
    jobKind: job.jobKind || 'render',
    profile: job.profile || 'mp4-720p-v1',
    wallSeconds,
    cpuSecondsActual,
    reservedVcpuSeconds,
    outputDurationSeconds,
    outputMinutes,
    billableOutputMinutes,
    rtf,
    outputBytes,
    egressBytes,
    allocatedComputeCostUsd: Number(allocatedComputeCostUsd.toFixed(6)),
    storageCostUsd: Number(storageCostUsd.toFixed(6)),
    egressCostUsd: Number(egressCostUsd.toFixed(6)),
    marginalTotalCostUsd: Number(marginalTotalCostUsd.toFixed(6)),
    unitCostPerOutputMinuteUsd:
      billableOutputMinutes > 0
        ? Number((marginalTotalCostUsd / billableOutputMinutes).toFixed(6))
        : null,
  };
}

/**
 * Aggregates a list of job execution records for a tenant and projects costs
 * across 10%, 50%, and 80% host capacity utilization scenarios.
 */
export function calculateTenantCostSummary(tenantId, jobs = [], options = {}) {
  const vcpuRate = options.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD;
  const hostVcpus = options.hostVcpus ?? DEFAULT_HOST_VCPUS;
  const reservedVcpus = options.reservedVcpus ?? DEFAULT_RESERVED_VCPUS;
  const storageRate = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
  const egressRate = options.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB;
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;

  let submittedCount = jobs.length;
  let succeededCount = 0;
  let failedCount = 0;
  let canceledCount = 0;
  let totalWallSeconds = 0;
  let totalCpuSecondsActual = 0;
  let totalReservedVcpuSeconds = 0;
  let totalOutputDurationSeconds = 0;
  let totalBillableOutputMinutes = 0;
  let totalOutputBytes = 0;
  let totalEgressBytes = 0;
  let totalMarginalComputeCostUsd = 0;
  let totalStorageCostUsd = 0;
  let totalEgressCostUsd = 0;
  let peakMemoryBytesObserved = 0;

  const itemizedJobs = [];

  for (const job of jobs) {
    if (job.status === 'succeeded') succeededCount++;
    else if (job.status === 'failed') failedCount++;
    else if (job.status === 'canceled') canceledCount++;

    if (job.peakMemoryBytes && job.peakMemoryBytes > peakMemoryBytesObserved) {
      peakMemoryBytesObserved = job.peakMemoryBytes;
    }

    const item = calculateJobCost(job, options);
    itemizedJobs.push(item);

    totalWallSeconds += item.wallSeconds;
    totalCpuSecondsActual += item.cpuSecondsActual;
    totalReservedVcpuSeconds += item.reservedVcpuSeconds;
    totalOutputDurationSeconds += item.outputDurationSeconds;
    totalBillableOutputMinutes += item.billableOutputMinutes;
    totalOutputBytes += item.outputBytes;
    totalEgressBytes += item.egressBytes;
    totalMarginalComputeCostUsd += item.allocatedComputeCostUsd;
    totalStorageCostUsd += item.storageCostUsd;
    totalEgressCostUsd += item.egressCostUsd;
  }

  const totalMarginalCostUsd =
    totalMarginalComputeCostUsd + totalStorageCostUsd + totalEgressCostUsd;

  const averageRtf =
    totalOutputDurationSeconds > 0
      ? totalWallSeconds / totalOutputDurationSeconds
      : 1.0;

  // Fully allocated multi-scenario utilization modeling (docs/OPERATIONS.md line 49)
  const hostHourlyCostUsd = hostVcpus * vcpuRate; // 4 * $0.04 = $0.16/h
  const concurrentWorkers = Math.max(1, Math.floor(hostVcpus / reservedVcpus)); // 2 concurrent slots

  const buildScenario = (utilizationPercent) => {
    const utilFraction = utilizationPercent / 100;
    // Output minutes produced per hour on host = (60 * utilFraction * concurrentWorkers) / RTF
    const safeRtf = Math.max(0.1, averageRtf);
    const outputMinutesProducedPerHour = (60 * utilFraction * concurrentWorkers) / safeRtf;

    const computeCostPerOutputMinuteUsd =
      outputMinutesProducedPerHour > 0
        ? hostHourlyCostUsd / outputMinutesProducedPerHour
        : (reservedVcpus * vcpuRate * safeRtf) / 60;

    const storageCostPerOutputMinute =
      totalBillableOutputMinutes > 0
        ? totalStorageCostUsd / totalBillableOutputMinutes
        : (totalOutputBytes / (1024 * 1024 * 1024) * storageRate * (retentionDays / DAYS_PER_MONTH)) /
          Math.max(0.1, totalOutputDurationSeconds / 60);

    const egressCostPerOutputMinute =
      totalBillableOutputMinutes > 0
        ? totalEgressCostUsd / totalBillableOutputMinutes
        : (totalEgressBytes / (1024 * 1024 * 1024) * egressRate) /
          Math.max(0.1, totalOutputDurationSeconds / 60);

    const fullyAllocatedCostPerMinuteUsd =
      computeCostPerOutputMinuteUsd + storageCostPerOutputMinute + egressCostPerOutputMinute;

    const projectedTenantCostUsd =
      totalBillableOutputMinutes * fullyAllocatedCostPerMinuteUsd;

    return {
      utilizationPercent,
      hostHourlyCostUsd,
      outputMinutesProducedPerHour: Number(outputMinutesProducedPerHour.toFixed(2)),
      computeCostPerOutputMinuteUsd: Number(computeCostPerOutputMinuteUsd.toFixed(6)),
      storageCostPerOutputMinuteUsd: Number(storageCostPerOutputMinute.toFixed(6)),
      egressCostPerOutputMinuteUsd: Number(egressCostPerOutputMinute.toFixed(6)),
      fullyAllocatedCostPerMinuteUsd: Number(fullyAllocatedCostPerMinuteUsd.toFixed(6)),
      projectedTenantCostUsd: Number(projectedTenantCostUsd.toFixed(4)),
      meetsBudgetCeiling: computeCostPerOutputMinuteUsd <= COMPUTE_BUDGET_CEILING_USD_PER_MIN,
    };
  };

  const utilizationScenarios = {
    10: buildScenario(10),
    50: buildScenario(50),
    80: buildScenario(80),
  };

  const marginalUnitCostPerOutputMinuteUsd =
    totalBillableOutputMinutes > 0
      ? totalMarginalCostUsd / totalBillableOutputMinutes
      : 0;

  return {
    tenantId,
    period: options.period || 'custom',
    generatedAt: new Date().toISOString(),
    metrics: {
      submittedCount,
      succeededCount,
      failedCount,
      canceledCount,
      totalWallSeconds: Number(totalWallSeconds.toFixed(2)),
      totalCpuSecondsActual: Number(totalCpuSecondsActual.toFixed(2)),
      totalReservedVcpuSeconds: Number(totalReservedVcpuSeconds.toFixed(2)),
      totalOutputDurationSeconds: Number(totalOutputDurationSeconds.toFixed(2)),
      totalBillableOutputMinutes: Number(totalBillableOutputMinutes.toFixed(4)),
      averageRtf: Number(averageRtf.toFixed(3)),
      peakMemoryBytesObserved,
      totalOutputBytes,
      totalEgressBytes,
    },
    costs: {
      marginalComputeCostUsd: Number(totalMarginalComputeCostUsd.toFixed(6)),
      storageCostUsd: Number(totalStorageCostUsd.toFixed(6)),
      egressCostUsd: Number(totalEgressCostUsd.toFixed(6)),
      marginalTotalCostUsd: Number(totalMarginalCostUsd.toFixed(6)),
      marginalUnitCostPerOutputMinuteUsd: Number(marginalUnitCostPerOutputMinuteUsd.toFixed(6)),
    },
    utilizationScenarios,
    pricingAssumptions: {
      vcpuHourlyRateUsd: vcpuRate,
      hostVcpus,
      reservedVcpus,
      storageRatePerGbMonth: storageRate,
      egressRatePerGb: egressRate,
      retentionDays,
      computeBudgetCeilingUsdPerMin: COMPUTE_BUDGET_CEILING_USD_PER_MIN,
    },
    itemizedJobs,
  };
}
