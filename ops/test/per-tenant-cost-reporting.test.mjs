/**
 * Test Suite: Per-Tenant Usage & Cost Reporting Engine
 * Canonical specifications: docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateJobCost,
  calculateTenantCostSummary,
  COMPUTE_BUDGET_CEILING_USD_PER_MIN,
} from '../cost/cost-calculator.mjs';
import {
  generateDailyReport,
  generateWeeklyReport,
} from '../cost/cost-reporter.mjs';

describe('Per-Tenant Cost Reporting Suite', () => {
  it('correctly calculates itemized cost for a single 15s video job (POC-01)', () => {
    // 15s output video that takes 60s wall clock time on 2 vCPUs at $0.04/vCPU-h
    // Expected compute cost = 2 * 60 / 3600 * 0.04 = $0.001333 USD
    // Rate per output minute = 0.001333 / (15/60) = 0.005333 USD/min (exactly matches docs/OPERATIONS.md line 53)
    const cost = calculateJobCost({
      jobId: 'job_poc01',
      status: 'succeeded',
      jobKind: 'render',
      profile: 'mp4-720p-v1',
      wallSeconds: 60,
      cpuSecondsActual: 52,
      outputDurationSeconds: 15,
      outputBytes: 2 * 1024 * 1024, // 2MB
      egressBytes: 2 * 1024 * 1024,
      reservedVcpus: 2,
    });

    assert.strictEqual(cost.allocatedComputeCostUsd, 0.001333);
    assert.strictEqual(cost.outputMinutes, 0.25);
    assert.strictEqual(cost.billableOutputMinutes, 0.25);
    assert.strictEqual(cost.rtf, 4.0); // 60s / 15s = 4.0 RTF (<= 6.0 ceiling)
    assert.ok(cost.marginalTotalCostUsd >= 0.001333);
  });

  it('separates billable output minutes from operational costs for failed and canceled jobs', () => {
    const failedJob = calculateJobCost({
      jobId: 'job_failed_01',
      status: 'failed',
      jobKind: 'render',
      wallSeconds: 40,
      cpuSecondsActual: 35,
      outputDurationSeconds: 30,
      outputBytes: 0,
      reservedVcpus: 2,
    });

    // Failed jobs have 0 billable output minutes, but still have operational compute cost
    assert.strictEqual(failedJob.billableOutputMinutes, 0);
    assert.strictEqual(failedJob.allocatedComputeCostUsd, 0.000889);
    assert.strictEqual(failedJob.unitCostPerOutputMinuteUsd, null);
  });

  it('models multi-scenario utilization (10%, 50%, 80%) under provisioned host capacity', () => {
    const jobs = [
      {
        jobId: 'job_1',
        status: 'succeeded',
        jobKind: 'render',
        wallSeconds: 45,
        cpuSecondsActual: 40,
        outputDurationSeconds: 15,
        outputBytes: 3 * 1024 * 1024,
      },
      {
        jobId: 'job_2',
        status: 'succeeded',
        jobKind: 'render',
        wallSeconds: 90,
        cpuSecondsActual: 80,
        outputDurationSeconds: 30,
        outputBytes: 6 * 1024 * 1024,
      },
      {
        jobId: 'job_3',
        status: 'failed',
        jobKind: 'render',
        wallSeconds: 30,
        cpuSecondsActual: 25,
        outputDurationSeconds: 15,
        outputBytes: 0,
      },
    ];

    const summary = calculateTenantCostSummary('tenant_alpha', jobs);

    assert.strictEqual(summary.tenantId, 'tenant_alpha');
    assert.strictEqual(summary.metrics.submittedCount, 3);
    assert.strictEqual(summary.metrics.succeededCount, 2);
    assert.strictEqual(summary.metrics.failedCount, 1);
    assert.strictEqual(summary.metrics.totalBillableOutputMinutes, 0.75); // 15s + 30s = 45s = 0.75 min

    const sc = summary.utilizationScenarios;
    assert.ok(sc[10]);
    assert.ok(sc[50]);
    assert.ok(sc[80]);

    // At higher utilization (80%), cost per output minute is significantly lower than at 10%
    assert.ok(sc[80].computeCostPerOutputMinuteUsd < sc[50].computeCostPerOutputMinuteUsd);
    assert.ok(sc[50].computeCostPerOutputMinuteUsd < sc[10].computeCostPerOutputMinuteUsd);

    // At 50% and 80%, compute cost meets budget ceiling of $0.05/min
    assert.strictEqual(sc[50].meetsBudgetCeiling, true);
    assert.strictEqual(sc[80].meetsBudgetCeiling, true);
    assert.ok(sc[80].computeCostPerOutputMinuteUsd <= COMPUTE_BUDGET_CEILING_USD_PER_MIN);
  });

  it('generates daily and weekly markdown reports with full table structures', () => {
    const sampleJobs = [
      {
        jobId: 'job_daily_1',
        status: 'succeeded',
        jobKind: 'render',
        wallSeconds: 60,
        cpuSecondsActual: 50,
        outputDurationSeconds: 20,
        outputBytes: 4 * 1024 * 1024,
      },
    ];

    const daily = generateDailyReport('tenant_test_daily', sampleJobs, '2026-11-04');
    assert.ok(daily.markdown.includes('# Per-Tenant Cost Report: tenant_test_daily'));
    assert.ok(daily.markdown.includes('daily-2026-11-04'));
    assert.ok(daily.markdown.includes('Dedicated Host Allocation Scenarios'));
    assert.ok(daily.markdown.includes('10% (Low / Idle Spike)'));

    const weekly = generateWeeklyReport('tenant_test_weekly', sampleJobs, '2026-W45');
    assert.ok(weekly.markdown.includes('# Per-Tenant Cost Report: tenant_test_weekly'));
    assert.ok(weekly.markdown.includes('weekly-2026-W45'));
  });
});
