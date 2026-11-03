/**
 * CLI Runner for P2-04 Cross-Candidate Benchmark Suite.
 * Generates runs.jsonl and summary.json into evidence/P2-04/.
 * Canonical specification: docs/TESTING.md, docs/ADR/0001-engine-selection.md, docs/IMPLEMENTATION_PLAN.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { runFullBenchmarkSuite } from './benchmark-runner.js';
import { BenchmarkFixtureId } from './benchmark-types.js';
import { CanonicalCompilerManifest } from '@creativanta/contracts';

const repoRoot = resolve(process.cwd());
const evidenceDir = resolve(repoRoot, 'evidence/P2-04');

// Ensure evidence directory exists
mkdirSync(evidenceDir, { recursive: true });

// Read fixtures
const manifestPoc01 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc01.json'), 'utf-8')
) as CanonicalCompilerManifest;

const manifestPoc02 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc02.json'), 'utf-8')
) as CanonicalCompilerManifest;

const manifestPoc03 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/manifest-poc03.json'), 'utf-8')
) as CanonicalCompilerManifest;

const fixtures: Record<BenchmarkFixtureId, CanonicalCompilerManifest> = {
  'POC-01': manifestPoc01,
  'POC-02': manifestPoc02,
  'POC-03': manifestPoc03,
};

let gitCommit = 'de614f4e242cf126305a2e584f18b5f3eb65c589';
try {
  gitCommit = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
} catch {
  // fallback
}

console.log(`Starting P2-04 Cross-Candidate Benchmark on commit: ${gitCommit}`);
console.log('Testing candidates: chromium-frame-v1 vs hyperframes-v1');
console.log('Fixtures: POC-01 (15s, 450 frames), POC-02 (30s, 900 frames), POC-03 (45s, 1350 frames)');
console.log('Runs protocol: 1 warmup + 5 measured warm + 3 cold start runs (9 runs per fixture/candidate = 54 total runs)');

const t0 = performance.now();
const { report, allRuns } = await runFullBenchmarkSuite(fixtures, {
  measuredWarmRuns: 5,
  measuredColdRuns: 3,
  includeWarmup: true,
  gitCommit,
});
const totalDurationSec = ((performance.now() - t0) / 1000).toFixed(2);

console.log(`\nBenchmark completed in ${totalDurationSec}s. Total runs executed: ${allRuns.length}`);

// Write runs.jsonl
const jsonlLines = allRuns.map((r) => JSON.stringify(r)).join('\n') + '\n';
writeFileSync(resolve(evidenceDir, 'runs.jsonl'), jsonlLines, 'utf-8');
console.log(`Saved raw runs to: evidence/P2-04/runs.jsonl (${allRuns.length} lines)`);

// Write summary.json
writeFileSync(
  resolve(evidenceDir, 'summary.json'),
  JSON.stringify(report, null, 2) + '\n',
  'utf-8'
);
console.log(`Saved structured summary to: evidence/P2-04/summary.json`);

console.log('\n--- BENCHMARK RESULTS SUMMARY ---');
for (const [key, sum] of Object.entries(report.fixtureSummaries)) {
  console.log(
    `[${key}] Status: ${sum.overallStatus} | Warm RTF: ${sum.warmRtf.median} (p95: ${sum.warmRtf.p95}) | Cold RTF: ${sum.coldRtf.median} | Warm Wall: ${sum.warmWallSeconds.median}s | Peak RSS: ${(sum.peakRssBytes / (1024 * 1024)).toFixed(1)}MB`
  );
}

console.log('\n--- COST SCENARIOS (POC-02 30s) ---');
for (const [cand, scenarios] of Object.entries(report.costScenarios)) {
  console.log(`Candidate: ${cand}`);
  for (const [util, sc] of Object.entries(scenarios)) {
    console.log(
      `  Utilization ${util}%: Compute/min = $${sc.computeCostPerOutputMinuteUsd} | Total/min = $${sc.totalCostPerOutputMinuteUsd} | Target <= $0.05: ${sc.meetsBudgetCeiling}`
    );
  }
}

console.log('\n--- ADR 0001 DECISION ---');
console.log(`Primary Engine: ${report.decision.primaryEngine}`);
console.log(`Fallback Engine: ${report.decision.fallbackEngine}`);
console.log(`HyperFrames Status: ${report.decision.hyperframesStatus}`);
console.log(`Formal Blockers: ${report.decision.formalBlockers.length}`);
console.log(`Scoring: Chromium = ${report.scoringMatrix.totalChromium} | HyperFrames = ${report.scoringMatrix.totalHyperframes}`);
