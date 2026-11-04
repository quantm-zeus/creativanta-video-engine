/**
 * Creativanta Video Engine - Cost Model & Capacity Envelope Benchmark
 * Simulates workload execution and validates cost ceilings at 10%, 50%, and 80% utilization.
 */

import { calculateTenantCostSummary } from '../ops/cost/cost-calculator.mjs';

export function runCostCapacityBenchmark(jobCount = 100) {
  const syntheticJobs = [];

  // Generate a realistic distribution of POC-01 (15s), POC-02 (30s), POC-03 (45s) jobs
  for (let i = 0; i < jobCount; i++) {
    const isSuccess = i % 20 !== 0; // 95% success rate
    const durationSeconds = i % 3 === 0 ? 15 : i % 3 === 1 ? 30 : 45;
    const rtf = 2.5 + (i % 10) * 0.2; // RTF between 2.5 and 4.3 (well under 6.0 ceiling)
    const wallSeconds = durationSeconds * rtf;
    const outputBytes = durationSeconds * 200 * 1024; // ~200KB/s bitrate

    syntheticJobs.push({
      jobId: `bench_job_${i}`,
      status: isSuccess ? 'succeeded' : 'failed',
      jobKind: 'render',
      profile: 'mp4-720p-v1',
      wallSeconds,
      cpuSecondsActual: wallSeconds * 0.85,
      outputDurationSeconds: durationSeconds,
      outputBytes,
      peakMemoryBytes: 450 * 1024 * 1024 + (i % 50) * 1024 * 1024,
    });
  }

  const summary = calculateTenantCostSummary('tenant-benchmark', syntheticJobs);
  const sc = summary.utilizationScenarios;

  return {
    jobCount,
    succeededJobs: summary.metrics.succeededCount,
    billableOutputMinutes: summary.metrics.totalBillableOutputMinutes,
    averageRtf: summary.metrics.averageRtf,
    marginalCostTotalUsd: summary.costs.marginalTotalCostUsd,
    marginalCostPerOutputMinuteUsd: summary.costs.marginalUnitCostPerOutputMinuteUsd,
    scenarios: {
      10: {
        utilization: '10%',
        outputMinutesProducedPerHour: sc[10].outputMinutesProducedPerHour,
        computeCostPerOutputMinuteUsd: sc[10].computeCostPerOutputMinuteUsd,
        fullyAllocatedCostPerMinuteUsd: sc[10].fullyAllocatedCostPerMinuteUsd,
        meetsBudgetCeiling: sc[10].meetsBudgetCeiling,
      },
      50: {
        utilization: '50%',
        outputMinutesProducedPerHour: sc[50].outputMinutesProducedPerHour,
        computeCostPerOutputMinuteUsd: sc[50].computeCostPerOutputMinuteUsd,
        fullyAllocatedCostPerMinuteUsd: sc[50].fullyAllocatedCostPerMinuteUsd,
        meetsBudgetCeiling: sc[50].meetsBudgetCeiling,
      },
      80: {
        utilization: '80%',
        outputMinutesProducedPerHour: sc[80].outputMinutesProducedPerHour,
        computeCostPerOutputMinuteUsd: sc[80].computeCostPerOutputMinuteUsd,
        fullyAllocatedCostPerMinuteUsd: sc[80].fullyAllocatedCostPerMinuteUsd,
        meetsBudgetCeiling: sc[80].meetsBudgetCeiling,
      },
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('cost-capacity-benchmark.mjs')) {
  const result = runCostCapacityBenchmark(100);
  console.log('Cost Capacity Benchmark Result:', JSON.stringify(result, null, 2));
}
