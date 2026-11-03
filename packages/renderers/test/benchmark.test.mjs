import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeDistribution,
  calculateCostScenarios,
  evaluateAdrGates,
  evaluateScoringMatrix,
  determineEngineSelection,
  runCandidateFixtureBenchmark,
  runFullBenchmarkSuite,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const manifestMinimal = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-minimal.json'), 'utf-8')
);
const manifestPoc01 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc01.json'), 'utf-8')
);
const manifestPoc02 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc02.json'), 'utf-8')
);
const manifestPoc03 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc03.json'), 'utf-8')
);

test('P2-04 Benchmark: Descriptive Statistics Distribution Calculation', () => {
  const sample = [1.2, 1.5, 1.1, 1.9, 1.3];
  const dist = computeDistribution(sample);

  assert.equal(dist.min, 1.1);
  assert.equal(dist.max, 1.9);
  assert.equal(dist.median, 1.3);
  assert.equal(dist.mean, 1.4);
  assert.ok(dist.p95 >= 1.5);

  // Empty edge case
  const emptyDist = computeDistribution([]);
  assert.equal(emptyDist.median, 0);
});

test('P2-04 Benchmark: Operational Cost Model (10%, 50%, 80% Utilization)', () => {
  const costScenarios = calculateCostScenarios({
    rtf: 1.25,
    outputDurationSeconds: 30,
    outputBytes: 5 * 1024 * 1024, // 5MB MP4
    reservedVcpus: 2,
    vcpuHourlyRateUsd: 0.04,
    hostVcpus: 4,
  });

  // Verify all 3 utilization scenarios are present
  assert.ok(costScenarios[10]);
  assert.ok(costScenarios[50]);
  assert.ok(costScenarios[80]);

  // At 10% utilization: higher cost per unit due to idle host overhead
  assert.ok(costScenarios[10].computeCostPerOutputMinuteUsd > costScenarios[50].computeCostPerOutputMinuteUsd);
  assert.ok(costScenarios[50].computeCostPerOutputMinuteUsd > costScenarios[80].computeCostPerOutputMinuteUsd);

  // Verify compute budget ceiling (<= 0.05 USD / output-minute) is met at 50% and 80%
  assert.equal(costScenarios[50].meetsBudgetCeiling, true);
  assert.equal(costScenarios[80].meetsBudgetCeiling, true);
  assert.ok(costScenarios[50].computeCostPerOutputMinuteUsd < 0.02);

  // Storage and egress are accounted for
  assert.ok(costScenarios[50].storageCost7dUsd > 0);
  assert.ok(costScenarios[50].egressCost1DownloadUsd > 0);
  assert.ok(costScenarios[50].totalCostPerOutputMinuteUsd >= costScenarios[50].computeCostPerOutputMinuteUsd);
});

test('P2-04 Benchmark: ADR 0001 Verification Gates (E1–E6) Evaluation', () => {
  const gates = evaluateAdrGates();
  assert.equal(gates.length, 6);

  const gateMap = new Map(gates.map((g) => [g.gate, g]));

  // E1 Legal/dependency
  assert.equal(gateMap.get('E1').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E1').hyperframesStatus, 'BLOCKED');
  assert.ok(gateMap.get('E1').blockersIdentified.includes('BLOCKER-HF-01'));

  // E2 Offline/CPU
  assert.equal(gateMap.get('E2').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E2').hyperframesStatus, 'BLOCKED');
  assert.ok(gateMap.get('E2').blockersIdentified.includes('BLOCKER-HF-02'));

  // E3 Correctness
  assert.equal(gateMap.get('E3').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E3').hyperframesStatus, 'BLOCKED');
  assert.ok(gateMap.get('E3').blockersIdentified.includes('BLOCKER-HF-04'));

  // E4 Cost/reliability
  assert.equal(gateMap.get('E4').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E4').hyperframesStatus, 'BLOCKED');

  // E5 Security sandbox
  assert.equal(gateMap.get('E5').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E5').hyperframesStatus, 'BLOCKED');

  // E6 Integration
  assert.equal(gateMap.get('E6').chromiumStatus, 'PASS');
  assert.equal(gateMap.get('E6').hyperframesStatus, 'CONDITIONAL');
});

test('P2-04 Benchmark: Weighted Scoring Matrix and Hard Security Gates', () => {
  const scoring = evaluateScoringMatrix();

  // Weights must sum to 1.0 (30% + 25% + 20% + 15% + 10%)
  const totalWeight = scoring.criteria.reduce((acc, c) => acc + c.weight, 0);
  assert.ok(Math.abs(totalWeight - 1.0) < 0.001);

  // Chromium baseline must achieve >90
  assert.ok(scoring.totalChromium >= 90.0, `Chromium score ${scoring.totalChromium} should be >= 90`);

  // HyperFrames must score <50 due to security and legal blockers
  assert.ok(scoring.totalHyperframes < 50.0, `HyperFrames score ${scoring.totalHyperframes} should be < 50`);
});

test('P2-04 Benchmark: Engine Selection Decision & Formal Blocker Review', () => {
  const decision = determineEngineSelection();

  assert.equal(decision.primaryEngine, 'chromium-frame-v1');
  assert.equal(decision.fallbackEngine, 'none');
  assert.equal(decision.hyperframesStatus, 'BLOCKED');
  assert.equal(decision.formalBlockers.length, 4);

  const blockerIds = decision.formalBlockers.map((b) => b.id);
  assert.ok(blockerIds.includes('BLOCKER-HF-01'));
  assert.ok(blockerIds.includes('BLOCKER-HF-02'));
  assert.ok(blockerIds.includes('BLOCKER-HF-03'));
  assert.ok(blockerIds.includes('BLOCKER-HF-04'));
});

test('P2-04 Benchmark: Candidate Execution on Fixture (1 Warmup + 5 Warm + 3 Cold)', async () => {
  // Execute ChromiumBaseline on manifest-minimal (150 frames, 5s)
  const chromBench = await runCandidateFixtureBenchmark(
    'chromium-frame-v1',
    'POC-01',
    manifestMinimal,
    { measuredWarmRuns: 5, measuredColdRuns: 3, includeWarmup: true }
  );

  assert.equal(chromBench.runs.length, 9); // 1 warmup + 5 warm + 3 cold
  assert.equal(chromBench.summary.warmupRunsCount, 1);
  assert.equal(chromBench.summary.measuredWarmRunsCount, 5);
  assert.equal(chromBench.summary.measuredColdRunsCount, 3);
  assert.equal(chromBench.summary.overallStatus, 'PASS');

  // Verify all runs passed
  for (const r of chromBench.runs) {
    assert.equal(r.exitStatus, 'PASS');
    assert.equal(r.frameCountDecoded, 150);
    assert.equal(r.ptsDriftFrames, 0);
    assert.ok(r.wallSeconds > 0);
  }

  // Targets verification
  assert.equal(chromBench.summary.targets.targetWarmRtfSatisfied, true);
  assert.equal(chromBench.summary.targets.targetPeakMemorySatisfied, true);
  assert.equal(chromBench.summary.targets.targetNoOom, true);
  assert.equal(chromBench.summary.targets.targetComputeCostSatisfied, true);

  // Execute HyperFrames on manifest-minimal (verify blocked behavior)
  const hfBench = await runCandidateFixtureBenchmark(
    'hyperframes-v1',
    'POC-01',
    manifestMinimal,
    { measuredWarmRuns: 5, measuredColdRuns: 3, includeWarmup: true }
  );

  assert.equal(hfBench.runs.length, 9);
  assert.equal(hfBench.summary.overallStatus, 'BLOCKED');
  assert.ok(hfBench.summary.blockers.length >= 2);
  for (const r of hfBench.runs) {
    assert.equal(r.exitStatus, 'BLOCKED');
  }
});
