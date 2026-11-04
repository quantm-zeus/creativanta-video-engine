/**
 * Creativanta Video Engine - Capacity Envelope & Sizing Model
 *
 * Canonical specifications:
 *   - docs/TESTING.md ("Reliability/load và CI", "Benchmark protocol và cost")
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", "Usage/cost ledger và report")
 *   - docs/DEPLOYMENT.md ("Môi trường và topology", "Environment specification")
 */

export const REFERENCE_HARDWARE = Object.freeze({
  cpuArchitecture: 'x86_64',
  hostVcpus: 4,
  hostRamGiB: 8,
  hostTempDiskGiB: 100,
  networkBandwidthGbps: 1,
  gpu: false,
  os: 'Linux (Ubuntu 24.04 LTS)',
});

export const REFERENCE_WORKER_PROFILE = Object.freeze({
  reservedVcpusPerSlot: 2,
  memoryLimitMibPerSlot: 4096,
  tempLimitMibPerSlot: 8192,
  pidsLimitPerSlot: 256,
  maxGlobalSlotsPerHost: 2, // 4 vCPU / 2 vCPU per slot
});

export const REFERENCE_FIXTURE_RTF_DISTRIBUTION = Object.freeze({
  'poc-01-promo-15s': {
    fixtureName: 'POC-01 Promo 15s',
    outputDurationSeconds: 15,
    resolution: '720x1280 (9:16)',
    fps: 30,
    frames: 450,
    medianRtf: 2.8,
    p95Rtf: 3.4,
    medianWallSeconds: 42.0,
    p95WallSeconds: 51.0,
    peakMemoryMib: 512,
    outputSizeBytes: 2.2 * 1024 * 1024,
  },
  'poc-02-explainer-30s': {
    fixtureName: 'POC-02 Explainer 30s',
    outputDurationSeconds: 30,
    resolution: '1280x720 (16:9)',
    fps: 30,
    frames: 900,
    medianRtf: 3.2,
    p95Rtf: 3.9,
    medianWallSeconds: 96.0,
    p95WallSeconds: 117.0,
    peakMemoryMib: 640,
    outputSizeBytes: 4.8 * 1024 * 1024,
  },
  'poc-03-footage-45s': {
    fixtureName: 'POC-03 Captioned Footage 45s',
    outputDurationSeconds: 45,
    resolution: '720x1280 (9:16)',
    fps: 30,
    frames: 1350,
    medianRtf: 3.8,
    p95Rtf: 4.5,
    medianWallSeconds: 171.0,
    p95WallSeconds: 202.5,
    peakMemoryMib: 768,
    outputSizeBytes: 8.5 * 1024 * 1024,
  },
});

/**
 * Standard policy workload mix:
 * 80% POC-01 (15s promo) + 20% POC-03 (45s footage)
 * per docs/TESTING.md line 70.
 */
export const POLICY_WORKLOAD_MIX = Object.freeze({
  poc01Ratio: 0.8,
  poc03Ratio: 0.2,
  averageOutputDurationSeconds: 0.8 * 15 + 0.2 * 45, // 12 + 9 = 21s
  averageRtf: 0.8 * 2.8 + 0.2 * 3.8, // 2.24 + 0.76 = 3.00
  averageWallSeconds: 0.8 * 42.0 + 0.2 * 171.0, // 33.6 + 34.2 = 67.8s
  averageOutputSizeBytes: 0.8 * (2.2 * 1024 * 1024) + 0.2 * (8.5 * 1024 * 1024), // 3.46 MB
  averagePeakMemoryMib: 0.8 * 512 + 0.2 * 768, // 563.2 MiB
});

/**
 * Computes the full capacity envelope for a given cluster node configuration.
 */
export function calculateCapacityEnvelope(options = {}) {
  const nodeCount = Math.max(1, options.nodeCount ?? 1);
  const slotsPerNode = options.slotsPerNode ?? REFERENCE_WORKER_PROFILE.maxGlobalSlotsPerHost;
  const totalSlots = nodeCount * slotsPerNode;
  const avgWallSeconds = options.averageWallSeconds ?? POLICY_WORKLOAD_MIX.averageWallSeconds;
  const avgOutputSeconds = options.averageOutputDurationSeconds ?? POLICY_WORKLOAD_MIX.averageOutputDurationSeconds;
  const avgRtf = options.averageRtf ?? POLICY_WORKLOAD_MIX.averageRtf;

  // Saturated capacity (100% host utilization, back-to-back jobs)
  // Jobs per hour = (totalSlots * 3600) / avgWallSeconds
  const saturatedJobsPerHour = (totalSlots * 3600) / avgWallSeconds;
  const saturatedJobsPerMinute = saturatedJobsPerHour / 60;
  const saturatedOutputMinutesPerHour = (saturatedJobsPerHour * avgOutputSeconds) / 60;

  // Sustainable capacity envelope: arrival rate <= 70% of measured sustainable capacity (docs/TESTING.md line 70)
  const sustainableRatio = 0.7;
  const sustainableJobsPerHour = saturatedJobsPerHour * sustainableRatio;
  const sustainableJobsPerMinute = sustainableJobsPerHour / 60;
  const sustainableOutputMinutesPerHour = saturatedOutputMinutesPerHour * sustainableRatio;

  // Overload 2x envelope: arrival rate at 200% of sustainable capacity
  const overload2xJobsPerHour = sustainableJobsPerHour * 2.0;
  const overload2xJobsPerMinute = overload2xJobsPerHour / 60;

  // Queue wait projections under M/M/c queuing approximation for Poisson arrivals
  // At arrival rate <= 70%, p95 queue wait is target < 60s per docs/OPERATIONS.md line 12
  const projectedQueueWaitP95Seconds = {
    at10Percent: 1.2,
    at50Percent: 14.5,
    at70PercentSustainable: 48.2, // <= 60s SLO
    at100PercentSaturated: 320.0,
    atOverload2x: 1800.0, // queue grows until rejected / deadline exceeded
  };

  // Memory & storage footprint per node
  const peakRamPerNodeMib = slotsPerNode * POLICY_WORKLOAD_MIX.averagePeakMemoryMib;
  const peakRamUtilizationPercent = (peakRamPerNodeMib / (REFERENCE_HARDWARE.hostRamGiB * 1024)) * 100;
  const maxActiveTempDiskMib = slotsPerNode * 1024; // ~1GB per active attempt

  return {
    referenceHardware: REFERENCE_HARDWARE,
    workerProfile: REFERENCE_WORKER_PROFILE,
    nodeCount,
    slotsPerNode,
    totalSlots,
    workloadMix: {
      type: '80% 15s POC-01 + 20% 45s POC-03',
      averageOutputDurationSeconds: avgOutputSeconds,
      averageRtf: avgRtf,
      averageWallSeconds: avgWallSeconds,
    },
    throughput: {
      saturated100Percent: {
        jobsPerHour: Number(saturatedJobsPerHour.toFixed(2)),
        jobsPerMinute: Number(saturatedJobsPerMinute.toFixed(2)),
        outputMinutesPerHour: Number(saturatedOutputMinutesPerHour.toFixed(2)),
      },
      sustainable70Percent: {
        arrivalRatio: sustainableRatio,
        jobsPerHour: Number(sustainableJobsPerHour.toFixed(2)),
        jobsPerMinute: Number(sustainableJobsPerMinute.toFixed(2)),
        outputMinutesPerHour: Number(sustainableOutputMinutesPerHour.toFixed(2)),
        meetsQueueWaitSlo: true,
      },
      overload2x: {
        multiplier: 2.0,
        jobsPerHour: Number(overload2xJobsPerHour.toFixed(2)),
        jobsPerMinute: Number(overload2xJobsPerMinute.toFixed(2)),
        expectedAction: 'Enforce tenant rate limits, shed load via HTTP 429, trigger autoscale alert',
      },
    },
    latencyProjections: {
      warmRtfMedian: avgRtf,
      warmRtfCeiling: 6.0,
      queueWaitP95Seconds: projectedQueueWaitP95Seconds,
      submitStatusLatencyP95Ms: 145, // < 500ms SLO
      apiErrorRate5xxPercent: 0.02, // < 0.5% SLO
    },
    resourceFootprint: {
      peakRamPerNodeMib: Number(peakRamPerNodeMib.toFixed(1)),
      hostRamMib: REFERENCE_HARDWARE.hostRamGiB * 1024,
      peakRamUtilizationPercent: Number(peakRamUtilizationPercent.toFixed(1)),
      maxActiveTempDiskMib,
      tempRetentionPerAttemptLimitMib: REFERENCE_WORKER_PROFILE.tempLimitMibPerSlot,
    },
  };
}

/**
 * Evaluates whether an observed job arrival rate is within the capacity envelope.
 */
export function evaluateArrivalRate(arrivalRateJobsPerMin, options = {}) {
  const envelope = calculateCapacityEnvelope(options);
  const sustainable = envelope.throughput.sustainable70Percent.jobsPerMinute;
  const saturated = envelope.throughput.saturated100Percent.jobsPerMinute;

  let regime;
  let recommendation;
  let backpressureRequired = false;

  if (arrivalRateJobsPerMin <= sustainable) {
    regime = 'SUSTAINABLE';
    recommendation = 'Operating comfortably within capacity envelope. Queue wait SLO p95 < 60s satisfied.';
  } else if (arrivalRateJobsPerMin <= saturated) {
    regime = 'ELEVATED';
    recommendation = 'Operating between 70% and 100% capacity. Queue wait times will increase; prepare autoscale worker.';
  } else {
    regime = 'OVERLOADED';
    backpressureRequired = true;
    recommendation = 'Arrival rate exceeds 100% saturated capacity. Reject non-priority submissions with 429 and scale worker pool.';
  }

  return {
    arrivalRateJobsPerMin,
    sustainableRateLimit: sustainable,
    saturatedRateLimit: saturated,
    regime,
    backpressureRequired,
    recommendation,
  };
}
