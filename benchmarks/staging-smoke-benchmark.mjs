/**
 * Creativanta Video Engine — Staging Smoke & G4 Readiness Benchmark
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-05)
 *   - docs/TESTING.md ("G4 private beta", line 13)
 */

import { ReleaseManifestGenerator } from '../ops/release/release-manifest.mjs';
import { MigrationManager } from '../ops/release/migration-manager.mjs';
import { RollbackManager } from '../ops/release/rollback-manager.mjs';
import { SloErrorBudgetManager } from '../ops/release/slo-error-budget.mjs';
import { StagingSmokeRunner } from '../ops/release/staging-smoke-runner.mjs';
import { G4ReadinessEvaluator } from '../ops/release/g4-readiness-evaluator.mjs';

export async function runStagingSmokeBenchmark(smokeIterations = 3) {
  const startedAt = Date.now();

  // 1. Release Manifest Micro-benchmark
  const manifestStart = performance.now();
  const manifestGen = new ReleaseManifestGenerator();
  let manifest;
  for (let i = 0; i < 50; i++) {
    manifest = manifestGen.generateManifest();
  }
  const manifestDurationMs = performance.now() - manifestStart;

  // 2. Migration Verifier Micro-benchmark
  const migStart = performance.now();
  const migMgr = new MigrationManager();
  let migRes;
  for (let i = 0; i < 50; i++) {
    migRes = migMgr.runAll();
  }
  const migDurationMs = performance.now() - migStart;

  // 3. Rollback Evaluator Micro-benchmark
  const rollStart = performance.now();
  const rollMgr = new RollbackManager();
  let rollRes;
  for (let i = 0; i < 50; i++) {
    rollRes = rollMgr.runAll();
  }
  const rollDurationMs = performance.now() - rollStart;

  // 4. SLO Evaluator Micro-benchmark
  const sloStart = performance.now();
  const sloMgr = new SloErrorBudgetManager();
  let sloRes;
  for (let i = 0; i < 100; i++) {
    sloRes = sloMgr.runAll();
  }
  const sloDurationMs = performance.now() - sloStart;

  // 5. Staging Smoke Execution Benchmark
  const smokeLatencies = [];
  const smokeRunner = new StagingSmokeRunner();
  for (let i = 0; i < smokeIterations; i++) {
    const sStart = performance.now();
    const sRes = await smokeRunner.runSmoke();
    if (sRes.status !== 'PASS') {
      throw new Error(`Smoke iteration ${i} failed`);
    }
    smokeLatencies.push(performance.now() - sStart);
  }

  // 6. Full G4 Evaluation Benchmark
  const g4Start = performance.now();
  const g4Evaluator = new G4ReadinessEvaluator();
  const g4Result = await g4Evaluator.runFullG4Evaluation();
  const g4DurationMs = performance.now() - g4Start;

  smokeLatencies.sort((a, b) => a - b);
  const p50SmokeMs = smokeLatencies[Math.floor(smokeLatencies.length * 0.5)];
  const p95SmokeMs = smokeLatencies[Math.floor(smokeLatencies.length * 0.95)] || smokeLatencies[smokeLatencies.length - 1];

  return {
    benchmarkSuite: 'P6-05 Staging Smoke & G4 Readiness Benchmark',
    timestamp: new Date().toISOString(),
    totalDurationMs: Date.now() - startedAt,
    microBenchmarks: [
      {
        benchmark: 'release_manifest_generation_50_iters',
        totalMs: Number(manifestDurationMs.toFixed(2)),
        meanMsPerIter: Number((manifestDurationMs / 50).toFixed(3)),
      },
      {
        benchmark: 'migration_integrity_verification_50_iters',
        totalMs: Number(migDurationMs.toFixed(2)),
        meanMsPerIter: Number((migDurationMs / 50).toFixed(3)),
      },
      {
        benchmark: 'rollback_procedures_evaluation_50_iters',
        totalMs: Number(rollDurationMs.toFixed(2)),
        meanMsPerIter: Number((rollDurationMs / 50).toFixed(3)),
      },
      {
        benchmark: 'slo_compliance_evaluation_100_iters',
        totalMs: Number(sloDurationMs.toFixed(2)),
        meanMsPerIter: Number((sloDurationMs / 100).toFixed(3)),
      },
      {
        benchmark: 'staging_smoke_end_to_end',
        iterations: smokeIterations,
        p50Ms: Number(p50SmokeMs.toFixed(2)),
        p95Ms: Number(p95SmokeMs.toFixed(2)),
      },
    ],
    fullG4Evaluation: {
      status: g4Result.overallStatus,
      decision: g4Result.g4Decision,
      passedPillars: `${g4Result.summary.passedPillars}/${g4Result.summary.totalPillars}`,
      durationMs: Number(g4DurationMs.toFixed(2)),
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('staging-smoke-benchmark.mjs')) {
  runStagingSmokeBenchmark(3)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
