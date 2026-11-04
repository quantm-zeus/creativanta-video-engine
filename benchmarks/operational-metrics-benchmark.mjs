/**
 * Creativanta Video Engine - Operational Metrics Collection Benchmark
 * Evaluates performance overhead of metric updates, histogram observations, and Prometheus serialization.
 */

import { MetricsRegistry } from '../ops/metrics/metrics-registry.mjs';

export function runMetricsBenchmark(iterations = 10000) {
  const registry = new MetricsRegistry();
  const counter = registry.getMetric('cve_api_requests_total');
  const histogram = registry.getMetric('cve_api_duration_seconds');
  const gauge = registry.getMetric('cve_jobs_queued');

  const startTime = Date.now();

  for (let i = 0; i < iterations; i++) {
    counter.inc({ method: 'POST', route: '/v1/render-jobs', status: '202' }, 1);
    histogram.observe({ method: 'POST', route: '/v1/render-jobs', status: '202' }, 0.045);
    gauge.set({ profile: 'mp4-720p-v1', adapter: 'chromium-frame-v1', pool: 'default' }, i % 10);
  }

  const durationMs = Date.now() - startTime;
  const opsPerSec = (iterations / (durationMs || 1)) * 1000;

  const serializeStart = Date.now();
  const prometheusText = registry.toPrometheus();
  const serializeDurationMs = Date.now() - serializeStart;

  return {
    iterations,
    durationMs,
    opsPerSec: Math.round(opsPerSec),
    serializeDurationMs,
    outputSizeBytes: Buffer.byteLength(prometheusText),
  };
}

if (process.argv[1] && process.argv[1].endsWith('operational-metrics-benchmark.mjs')) {
  const result = runMetricsBenchmark(20000);
  console.log('Metrics Benchmark Result:', JSON.stringify(result, null, 2));
}
