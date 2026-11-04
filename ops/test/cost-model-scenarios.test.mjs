/**
 * Test Suite: Cost Model at 10%, 50%, and 80% Utilization Scenarios
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 *   - docs/TESTING.md ("Benchmark protocol và cost", lines 58-68)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-03)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMultiScenarioCostModel,
  formatCostModelMarkdown,
} from '../cost/cost-model.mjs';
import {
  COMPUTE_BUDGET_CEILING_USD_PER_MIN,
} from '../cost/cost-calculator.mjs';

describe('Cost Model Scenarios Suite (10%, 50%, 80%)', () => {
  it('builds comprehensive multi-scenario cost model and verifies all 3 utilization levels', () => {
    const model = buildMultiScenarioCostModel({
      averageRtf: 3.0,
      averageOutputDurationSeconds: 21.0,
    });

    const s10 = model.utilizationScenarios[10];
    const s50 = model.utilizationScenarios[50];
    const s80 = model.utilizationScenarios[80];

    assert.ok(s10, 'Scenario 10% should exist');
    assert.ok(s50, 'Scenario 50% should exist');
    assert.ok(s80, 'Scenario 80% should exist');

    assert.strictEqual(s10.utilizationPercent, 10);
    assert.strictEqual(s50.utilizationPercent, 50);
    assert.strictEqual(s80.utilizationPercent, 80);

    // Output minutes produced per hour scales linearly with utilization:
    // Saturated 40.0 min/h -> 10% is 4.0 min/h, 50% is 20.0 min/h, 80% is 32.0 min/h
    assert.strictEqual(s10.outputMinutesProducedPerHour, 4.0);
    assert.strictEqual(s50.outputMinutesProducedPerHour, 20.0);
    assert.strictEqual(s80.outputMinutesProducedPerHour, 32.0);

    // Compute cost per output minute:
    // Host cost is $0.16/hour.
    // At 10%: $0.16 / 4.0 = $0.040000 / min
    // At 50%: $0.16 / 20.0 = $0.008000 / min
    // At 80%: $0.16 / 32.0 = $0.005000 / min
    assert.strictEqual(s10.allocatedComputeCostPerMinuteUsd, 0.04);
    assert.strictEqual(s50.allocatedComputeCostPerMinuteUsd, 0.008);
    assert.strictEqual(s80.allocatedComputeCostPerMinuteUsd, 0.005);

    // Marginal compute cost is constant ($0.004000 / min for RTF 3.0 on 2 vCPUs)
    assert.strictEqual(model.marginalCosts.computeCostPerMinuteUsd, 0.004);

    // Idle overhead is highest at 10% ($0.0360/min), lower at 50% ($0.0040/min), lowest at 80% ($0.0010/min)
    assert.strictEqual(s10.idleOverheadCostPerMinuteUsd, 0.036);
    assert.strictEqual(s50.idleOverheadCostPerMinuteUsd, 0.004);
    assert.strictEqual(s80.idleOverheadCostPerMinuteUsd, 0.001);

    // All scenarios satisfy the $0.05/output-minute budget ceiling
    assert.strictEqual(s10.meetsBudgetCeiling, true);
    assert.strictEqual(s50.meetsBudgetCeiling, true);
    assert.strictEqual(s80.meetsBudgetCeiling, true);
  });

  it('formats executive markdown table report with expected headers and columns', () => {
    const model = buildMultiScenarioCostModel();
    const md = formatCostModelMarkdown(model);

    assert.ok(md.includes('### Mô hình chi phí vận hành đa kịch bản'));
    assert.ok(md.includes('| Kịch bản sử dụng | Sản lượng phút/giờ | Chi phí Compute / phút'));
    assert.ok(md.includes('| **10%** |'));
    assert.ok(md.includes('| **50%** |'));
    assert.ok(md.includes('| **80%** |'));
    assert.ok(md.includes('✅ ĐẠT'));
  });
});
