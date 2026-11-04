/**
 * Test Suite: Load & Capacity Envelope
 *
 * Canonical specifications:
 *   - docs/TESTING.md ("Reliability/load và CI", line 70)
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 8-13)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateLatencyPercentiles,
  runApiLoadBenchmark,
} from '../load/load-harness.mjs';
import {
  calculateCapacityEnvelope,
  evaluateArrivalRate,
  REFERENCE_HARDWARE,
  REFERENCE_WORKER_PROFILE,
  POLICY_WORKLOAD_MIX,
} from '../capacity/capacity-envelope.mjs';

describe('Load & Capacity Envelope Suite', () => {
  it('correctly calculates accurate latency percentiles', () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const stats = calculateLatencyPercentiles(latencies);

    assert.strictEqual(stats.count, 10);
    assert.strictEqual(stats.p50, 50);
    assert.strictEqual(stats.p90, 90);
    assert.strictEqual(stats.p95, 100);
    assert.strictEqual(stats.p99, 100);
    assert.strictEqual(stats.min, 10);
    assert.strictEqual(stats.max, 100);
    assert.strictEqual(stats.mean, 55);
  });

  it('verifies API load benchmark under 20 authenticated clients at 10 req/s satisfies SLOs', async () => {
    const result = await runApiLoadBenchmark({
      clientCount: 20,
      targetRps: 10,
      totalRequests: 200,
    });

    assert.strictEqual(result.counts.total, 200);
    assert.strictEqual(result.sloVerification.error5xxPercent, 0.0);
    assert.ok(result.sloVerification.p95LatencyMs < 500.0, `p95 latency ${result.sloVerification.p95LatencyMs}ms should be < 500ms`);
    assert.strictEqual(result.sloVerification.p95Pass, true);
    assert.strictEqual(result.sloVerification.error5xxPass, true);
    assert.strictEqual(result.sloVerification.status, 'PASS');

    // Confirms GET status vs Submit breakdown (~80% GET, ~20% Submit)
    assert.ok(result.counts.statusRequests >= 140 && result.counts.statusRequests <= 180);
    assert.ok(result.counts.successfulSubmits >= 20 && result.counts.successfulSubmits <= 60);
  });

  it('segregates HTTP 429 quota rejection latencies from successful submit latencies', async () => {
    // Force quota threshold to 2 submits per client
    const result = await runApiLoadBenchmark({
      clientCount: 2,
      targetRps: 10,
      totalRequests: 100,
      tenantSubmitQuotaPerMinute: 2,
    });

    assert.ok(result.counts.rejected429Quota > 0, 'Expected some requests to be rejected by quota');
    assert.ok(result.percentiles.rejected429QuotaOnly.count > 0);
    // 429 fast-reject latency should be fast (< 20ms)
    assert.ok(result.percentiles.rejected429QuotaOnly.p95 < 20.0);
  });

  it('computes reference capacity envelope for standard 4 vCPU / 8 GiB node', () => {
    const envelope = calculateCapacityEnvelope({ nodeCount: 1, slotsPerNode: 2 });

    assert.strictEqual(envelope.totalSlots, 2);
    assert.strictEqual(envelope.nodeCount, 1);
    assert.strictEqual(envelope.slotsPerNode, 2);
    assert.strictEqual(envelope.referenceHardware.hostVcpus, 4);
    assert.strictEqual(envelope.referenceHardware.hostRamGiB, 8);

    // Saturated capacity
    assert.ok(envelope.throughput.saturated100Percent.jobsPerHour >= 100.0);
    assert.ok(envelope.throughput.saturated100Percent.jobsPerMinute >= 1.7);

    // Sustainable capacity (70% arrival rate per docs/TESTING.md line 70)
    assert.ok(envelope.throughput.sustainable70Percent.jobsPerHour >= 70.0);
    assert.strictEqual(envelope.throughput.sustainable70Percent.arrivalRatio, 0.7);
    assert.strictEqual(envelope.throughput.sustainable70Percent.meetsQueueWaitSlo, true);

    // Overload 2x capacity
    assert.strictEqual(envelope.throughput.overload2x.multiplier, 2.0);
    assert.ok(envelope.throughput.overload2x.jobsPerHour >= 140.0);

    // Memory footprint
    assert.ok(envelope.resourceFootprint.peakRamPerNodeMib < 2048);
    assert.ok(envelope.resourceFootprint.peakRamUtilizationPercent < 25.0);
  });

  it('evaluates arrival rate regimes accurately (SUSTAINABLE, ELEVATED, OVERLOADED)', () => {
    const sustainableEval = evaluateArrivalRate(1.0, { nodeCount: 1 });
    assert.strictEqual(sustainableEval.regime, 'SUSTAINABLE');
    assert.strictEqual(sustainableEval.backpressureRequired, false);

    const elevatedEval = evaluateArrivalRate(1.5, { nodeCount: 1 });
    assert.strictEqual(elevatedEval.regime, 'ELEVATED');
    assert.strictEqual(elevatedEval.backpressureRequired, false);

    const overloadedEval = evaluateArrivalRate(3.0, { nodeCount: 1 });
    assert.strictEqual(overloadedEval.regime, 'OVERLOADED');
    assert.strictEqual(overloadedEval.backpressureRequired, true);
  });
});
