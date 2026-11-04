/**
 * Creativanta Video Engine - Load & Capacity Envelope Benchmark
 *
 * Evaluates:
 *   1. API Latency & Throughput under load (20 clients, 10 req/s, 80% GET / 20% POST).
 *   2. Capacity Envelope sizing (100% saturated, 70% sustainable, 2x overload).
 */

import { runApiLoadBenchmark } from '../ops/load/load-harness.mjs';
import { calculateCapacityEnvelope, evaluateArrivalRate } from '../ops/capacity/capacity-envelope.mjs';

export async function runLoadCapacityBenchmark(options = {}) {
  // 1. Run API Load & Latency Test
  const apiLoadResult = await runApiLoadBenchmark({
    clientCount: options.clientCount ?? 20,
    targetRps: options.targetRps ?? 10,
    totalRequests: options.totalRequests ?? 1000,
  });

  // 2. Compute Capacity Envelope
  const capacityEnvelope = calculateCapacityEnvelope({
    nodeCount: options.nodeCount ?? 1,
    slotsPerNode: options.slotsPerNode ?? 2,
  });

  // 3. Evaluate Sustainable Rate and Overload Rate
  const sustainableEvaluation = evaluateArrivalRate(
    capacityEnvelope.throughput.sustainable70Percent.jobsPerMinute,
    { nodeCount: 1 }
  );

  const overloadEvaluation = evaluateArrivalRate(
    capacityEnvelope.throughput.overload2x.jobsPerMinute,
    { nodeCount: 1 }
  );

  return {
    apiLoad: apiLoadResult,
    capacityEnvelope,
    evaluations: {
      sustainableLoad: sustainableEvaluation,
      overload2x: overloadEvaluation,
    },
    summary: {
      apiP95LatencyMs: apiLoadResult.percentiles.overallEligibleRequests.p95,
      apiP95Pass: apiLoadResult.sloVerification.p95Pass,
      apiError5xxPercent: apiLoadResult.sloVerification.error5xxPercent,
      sustainableJobsPerHour: capacityEnvelope.throughput.sustainable70Percent.jobsPerHour,
      status: apiLoadResult.sloVerification.status,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('load-capacity-benchmark.mjs')) {
  console.log('Running Load & Capacity Benchmark...');
  runLoadCapacityBenchmark().then((res) => {
    console.log(JSON.stringify(res, null, 2));
    if (res.summary.status !== 'PASS') {
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Load capacity benchmark failed:', err);
    process.exit(1);
  });
}
