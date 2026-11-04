/**
 * Test Suite: Multi-Tenant Fairness & Scheduling
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", "Fair scheduling")
 *   - docs/TESTING.md ("Reliability/load và CI", line 70)
 *   - packages/api/src/dispatcher/job-dispatcher.ts (lines 1045-1150)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateJainsFairnessIndex,
  evaluateMultiTenantContention,
  evaluatePreviewRenderPriority,
  evaluateOverloadFairness,
} from '../load/fairness-evaluator.mjs';

describe('Multi-Tenant Fairness & Scheduling Suite', () => {
  it('computes Jain fairness index correctly for balanced and skewed allocations', () => {
    // Perfectly equal allocation -> J = 1.0
    const equalAllocation = [10, 10, 10, 10];
    assert.strictEqual(calculateJainsFairnessIndex(equalAllocation), 1.0);

    // Highly skewed allocation -> lower J
    const skewedAllocation = [100, 10, 5];
    const jSkewed = calculateJainsFairnessIndex(skewedAllocation);
    assert.ok(jSkewed >= 0.3 && jSkewed <= 0.6);
  });

  it('prevents starvation of minority tenants under severe queue contention', () => {
    // Tenant A (100 jobs), Tenant B (10 jobs), Tenant C (5 jobs)
    const result = evaluateMultiTenantContention({ maxGlobalSlots: 4, perTenantSlotMax: 2 });

    assert.strictEqual(result.invariants.antiStarvationPass, true);
    assert.strictEqual(result.invariants.perTenantSlotCapEnforced, true);
    assert.ok(result.jainsFairnessIndex >= 0.80);

    // Verify all 3 tenants get their first dispatch in the very first round-robin cycle (steps 1, 2, 3)
    assert.strictEqual(result.firstDispatchSteps['tenant-bulk-A'], 1);
    assert.strictEqual(result.firstDispatchSteps['tenant-inter-B'], 2);
    assert.strictEqual(result.firstDispatchSteps['tenant-burst-C'], 3);
  });

  it('enforces 2:1 preview-to-render priority without starving render jobs', () => {
    const result = evaluatePreviewRenderPriority({ maxGlobalSlots: 4 });

    assert.strictEqual(result.invariants.renderNeverStarved, true);
    assert.strictEqual(result.invariants.previewCapRespected, true);
    assert.strictEqual(result.invariants.cadenceMatchesExpected, true);
    assert.ok(result.dispatchedPreviews >= 15);
    assert.ok(result.dispatchedRenders >= 10);
  });

  it('sheds excess load under 2x overload and protects non-offending tenants', () => {
    const result = evaluateOverloadFairness();

    assert.strictEqual(result.invariants.status, 'PASS');
    assert.strictEqual(result.invariants.spammerClamped, true);
    assert.strictEqual(result.invariants.normalTenantsProtected, true);
    assert.strictEqual(result.results.normalTenant1.rejected429, 0);
    assert.strictEqual(result.results.normalTenant2.rejected429, 0);
    assert.strictEqual(result.results.spammerTenant3.rejected429, 90);
  });
});
