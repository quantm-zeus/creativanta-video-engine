/**
 * Creativanta Video Engine - Multi-Tenant Fairness & Scheduling Benchmark
 *
 * Evaluates:
 *   1. Multi-Tenant Contention & Anti-Starvation (Round-Robin interleaving, active slot cap).
 *   2. Preview vs Render 2:1 Priority & Anti-Starvation Cap (<= 50% preview slots).
 *   3. 2x Overload Shedding & Tenant Isolation (HTTP 429 backpressure).
 */

import {
  evaluateMultiTenantContention,
  evaluatePreviewRenderPriority,
  evaluateOverloadFairness,
  calculateJainsFairnessIndex,
} from '../ops/load/fairness-evaluator.mjs';

export function runFairnessBenchmark() {
  const contentionResult = evaluateMultiTenantContention();
  const priorityResult = evaluatePreviewRenderPriority();
  const overloadResult = evaluateOverloadFairness();

  const allPassed =
    contentionResult.invariants.antiStarvationPass &&
    contentionResult.invariants.jainsFairnessPass &&
    priorityResult.invariants.renderNeverStarved &&
    priorityResult.invariants.cadenceMatchesExpected &&
    overloadResult.invariants.status === 'PASS';

  return {
    contentionTest: contentionResult,
    priorityTest: priorityResult,
    overloadTest: overloadResult,
    summary: {
      jainsFairnessIndex: contentionResult.jainsFairnessIndex,
      antiStarvationPass: contentionResult.invariants.antiStarvationPass,
      previewToRenderRatio: priorityResult.previewToRenderRatio,
      renderNeverStarved: priorityResult.invariants.renderNeverStarved,
      spammerClampedBy429: overloadResult.invariants.spammerClamped,
      status: allPassed ? 'PASS' : 'FAIL',
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('fairness-benchmark.mjs')) {
  console.log('Running Multi-Tenant Fairness Benchmark...');
  const res = runFairnessBenchmark();
  console.log(JSON.stringify(res, null, 2));
  if (res.summary.status !== 'PASS') {
    process.exit(1);
  }
}
