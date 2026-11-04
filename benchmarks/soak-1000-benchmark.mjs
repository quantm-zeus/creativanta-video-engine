/**
 * Creativanta Video Engine - 24-Hour Soak Beta Benchmark (>=1000 Valid Jobs)
 *
 * Executes >=1000 valid jobs with stage-boundary fault injection,
 * verifying all core system invariants, memory boundedness, and zero data loss.
 */

import { runSoakTest } from '../ops/load/soak-runner.mjs';

export async function runSoakBenchmark(jobCount = 1000) {
  const result = await runSoakTest({ totalJobCount: jobCount });
  return result;
}

if (process.argv[1] && process.argv[1].endsWith('soak-1000-benchmark.mjs')) {
  const count = process.argv[2] ? parseInt(process.argv[2], 10) : 1000;
  console.log(`Starting Soak Benchmark with ${count} valid jobs...`);
  runSoakBenchmark(count).then((res) => {
    console.log(JSON.stringify(res, null, 2));
    if (res.verdict !== 'PASS') {
      console.error('Soak benchmark failed invariants check!');
      process.exit(1);
    }
  }).catch((err) => {
    console.error('Soak benchmark encountered error:', err);
    process.exit(1);
  });
}
