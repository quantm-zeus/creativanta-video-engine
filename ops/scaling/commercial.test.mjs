/**
 * Creativanta Video Engine - Commercial & Scaling Test Suite (Task P9-02)
 *
 * Verifies:
 *   1. Quota Plans & Admission Enforcement Suite
 *   2. Retention Tiers & Purge Lifecycle Suite
 *   3. Multi-Tenant Usage Exporter Suite
 *   4. Pricing Simulation & 10/50/80% Utilization Scenarios Suite
 *   5. Usage Reconciliation & Append-Only Compensation Suite
 *   6. Mock Billing Processor & Real Charging Safety Suite
 *   7. Full Commercial Suite End-to-End Orchestration
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { QuotaPolicyManager, STANDARD_QUOTA_PLANS } from './quota-plans.mjs';
import { RetentionPolicyManager, STANDARD_RETENTION_TIERS } from './retention-tiers.mjs';
import { UsageExporter } from './usage-exporter.mjs';
import { PricingSimulator } from './pricing-simulator.mjs';
import { ReconciliationEngine } from './reconciliation-engine.mjs';
import { MockBillingProcessor } from './billing-processor-mock.mjs';
import { CommercialSuite } from './commercial-suite.mjs';

test('Task P9-02: Quota Plans & Admission Enforcement Suite', async (t) => {
  await t.test('correctly configures standard plans and returns plan properties', () => {
    const qm = new QuotaPolicyManager();
    const plans = qm.plans;

    assert.ok(plans.free, 'free plan should exist');
    assert.ok(plans.starter, 'starter plan should exist');
    assert.ok(plans.pro, 'pro plan should exist');
    assert.ok(plans.enterprise, 'enterprise plan should exist');

    assert.equal(plans.free.maxConcurrentActiveSlots, 1);
    assert.equal(plans.free.monthlyBillableMinutesQuota, 10);
    assert.equal(plans.starter.maxConcurrentActiveSlots, 2);
    assert.equal(plans.starter.monthlyBillableMinutesQuota, 60);
    assert.equal(plans.pro.maxConcurrentActiveSlots, 5);
    assert.equal(plans.pro.monthlyBillableMinutesQuota, 300);
    assert.equal(plans.enterprise.maxConcurrentActiveSlots, 10);
    assert.equal(plans.enterprise.monthlyBillableMinutesQuota, 1200);
  });

  await t.test('rejects admission when requested profile is not in allowedProfiles', () => {
    const qm = new QuotaPolicyManager();
    qm.assignTenantPlan('tenant_custom', 'free', {
      allowedProfiles: ['preview-360p-v1'], // only preview allowed
    });

    const result = qm.evaluateAdmission('tenant_custom', {
      profile: 'mp4-720p-v1',
    });

    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 422);
    assert.equal(result.errorCode, 'UNSUPPORTED_CAPABILITY');
  });

  await t.test('rejects admission when tenant exceeds concurrent active slots limit (HTTP 429)', () => {
    const qm = new QuotaPolicyManager();
    qm.assignTenantPlan('t_slots', 'starter'); // 2 active slots limit

    qm.recordJobAdmission('t_slots', 'j1', { isActive: true });
    qm.recordJobAdmission('t_slots', 'j2', { isActive: true });

    const result = qm.evaluateAdmission('t_slots', { profile: 'mp4-720p-v1' });
    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 429);
    assert.equal(result.errorCode, 'QUOTA_EXCEEDED');
    assert.match(result.reason, /concurrent active slot limit/);
  });

  await t.test('rejects admission when tenant exceeds max queued jobs buffer (HTTP 429)', () => {
    const qm = new QuotaPolicyManager();
    qm.assignTenantPlan('t_queue', 'free'); // 5 queued jobs limit

    for (let i = 0; i < 5; i++) {
      qm.recordJobAdmission('t_queue', `q_${i}`, { isActive: false });
    }

    const result = qm.evaluateAdmission('t_queue', { profile: 'mp4-720p-v1' });
    assert.equal(result.allowed, false);
    assert.equal(result.statusCode, 429);
    assert.equal(result.errorCode, 'QUOTA_EXCEEDED');
    assert.match(result.reason, /pending queue limit/);
  });

  await t.test('triggers CVE_QUOTA_WARNING_80 when usage reaches or exceeds 80%', () => {
    const qm = new QuotaPolicyManager();
    qm.assignTenantPlan('t_warn', 'starter'); // 60 min limit

    // Consume 49 minutes (49 / 60 = 81.6%)
    qm.recordJobAdmission('t_warn', 'j_past', { isActive: true });
    qm.recordJobCompletion('t_warn', 'j_past', { billableMinutes: 49.0, status: 'succeeded' });

    const result = qm.evaluateAdmission('t_warn', {
      profile: 'mp4-720p-v1',
      estimatedMinutes: 0.25,
    });

    assert.equal(result.allowed, true);
    assert.ok(result.warnings.length > 0, 'should emit warning');
    assert.equal(result.warnings[0].code, 'CVE_QUOTA_WARNING_80');
    assert.match(result.warnings[0].message, /82\./);
  });

  await t.test('transitions job lifecycle correctly and calculates available headroom', () => {
    const qm = new QuotaPolicyManager();
    qm.assignTenantPlan('t_life', 'starter'); // 2 slots, 20 queued, 60 min

    qm.recordJobAdmission('t_life', 'job_q1', { isActive: false });
    let status = qm.getTenantQuotaStatus('t_life');
    assert.equal(status.usage.queuedJobsCount, 1);
    assert.equal(status.usage.activeSlotsInUse, 0);

    qm.transitionJobToActive('t_life', 'job_q1');
    status = qm.getTenantQuotaStatus('t_life');
    assert.equal(status.usage.queuedJobsCount, 0);
    assert.equal(status.usage.activeSlotsInUse, 1);

    qm.recordJobCompletion('t_life', 'job_q1', {
      billableMinutes: 0.5,
      operationalCostUsd: 0.003,
      status: 'succeeded',
    });
    status = qm.getTenantQuotaStatus('t_life');
    assert.equal(status.usage.activeSlotsInUse, 0);
    assert.equal(status.usage.periodBillableMinutes, 0.5);
    assert.equal(status.usage.totalSucceededJobs, 1);
    assert.equal(status.headroom.remainingBillableMinutes, 59.5);
  });
});

test('Task P9-02: Storage & Data Retention Tiers Suite', async (t) => {
  await t.test('defines standard retention tiers compliant with PRD & SECURITY.md', () => {
    const rm = new RetentionPolicyManager();
    const tiers = rm.tiers;

    assert.ok(tiers.ephemeral);
    assert.ok(tiers.standard);
    assert.ok(tiers.extended);
    assert.ok(tiers.archive);

    // Standard baseline
    assert.equal(tiers.standard.assetsDays, 7);
    assert.equal(tiers.standard.artifactsDays, 7);
    assert.equal(tiers.standard.jobHistoryDays, 90);
    assert.equal(tiers.standard.auditLogsDays, 180);
    assert.equal(tiers.standard.backupDays, 30);
  });

  await t.test('calculates exact expiration dates based on resource kind and tier', () => {
    const rm = new RetentionPolicyManager();
    const createdIso = '2026-11-01T00:00:00.000Z';

    const assetExp = rm.calculateExpirationDate('asset', createdIso, 'standard');
    assert.equal(assetExp, '2026-11-08T00:00:00.000Z'); // 7 days

    const jobExp = rm.calculateExpirationDate('job', createdIso, 'standard');
    assert.equal(jobExp, '2027-01-30T00:00:00.000Z'); // 90 days
    const expectedJobMs = Date.parse(createdIso) + 90 * 24 * 60 * 60 * 1000;
    assert.equal(Date.parse(jobExp), expectedJobMs);
  });

  await t.test('detects expired items while strictly preserving legalHold protected records', () => {
    const rm = new RetentionPolicyManager();
    const nowMs = Date.parse('2026-11-15T00:00:00.000Z');
    const createdOld = '2026-11-01T00:00:00.000Z'; // 14 days old (exceeds 7-day standard)

    // Standard expired
    const isExp = rm.isExpired('artifact', createdOld, {
      tierId: 'standard',
      referenceTime: new Date(nowMs).toISOString(),
    });
    assert.equal(isExp, true);

    // With legalHold = true
    const isHoldExp = rm.isExpired('artifact', createdOld, {
      tierId: 'standard',
      referenceTime: new Date(nowMs).toISOString(),
      legalHold: true,
    });
    assert.equal(isHoldExp, false, 'legal hold MUST prevent expiration');
  });

  await t.test('scans purge candidates, calculates freed bytes, and estimates monthly savings', () => {
    const rm = new RetentionPolicyManager();
    const nowMs = Date.parse('2026-11-20T00:00:00.000Z');

    const records = [
      { id: '1', kind: 'asset', createdAt: '2026-11-18T00:00:00Z', sizeBytes: 10 * 1024 * 1024, tierId: 'standard' }, // 2d old -> keep
      { id: '2', kind: 'asset', createdAt: '2026-11-01T00:00:00Z', sizeBytes: 50 * 1024 * 1024, tierId: 'standard' }, // 19d old -> purge
      { id: '3', kind: 'artifact', createdAt: '2026-11-01T00:00:00Z', sizeBytes: 100 * 1024 * 1024, tierId: 'standard', legalHold: true }, // hold -> keep
    ];

    const result = rm.scanPurgeCandidates(records, { referenceTime: new Date(nowMs).toISOString() });
    assert.equal(result.scannedCount, 3);
    assert.equal(result.purgeCandidatesCount, 1);
    assert.equal(result.preservedCount, 2);
    assert.equal(result.legalHoldPreservedCount, 1);
    assert.equal(result.totalFreedBytes, 50 * 1024 * 1024);
    assert.ok(result.estimatedMonthlySavingsUsd > 0);
  });
});

test('Task P9-02: Multi-Tenant Usage Exporter Suite', async (t) => {
  await t.test('enforces maximum 31-day query window limit', () => {
    const exp = new UsageExporter();

    // Valid 10-day range
    const valid = exp.validateDateRange('2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z');
    assert.ok(valid.fromIso);

    // Invalid backwards range
    assert.throws(
      () => exp.validateDateRange('2026-11-10T00:00:00Z', '2026-11-01T00:00:00Z'),
      /must not be earlier/
    );

    // Invalid >31 days window
    assert.throws(
      () => exp.validateDateRange('2026-10-01T00:00:00Z', '2026-11-15T00:00:00Z'),
      /cannot exceed 31 days/
    );
  });

  await t.test('segregates operational costs from billable minutes and exempts previews', () => {
    const exp = new UsageExporter();

    const jobs = [
      {
        jobId: 'j_render_succ',
        tenantId: 't1',
        jobKind: 'render',
        profile: 'mp4-720p-v1',
        status: 'succeeded',
        wallSeconds: 60.0,
        cpuSecondsActual: 50.0,
        outputDurationSeconds: 15.0,
        outputBytes: 5 * 1024 * 1024,
      },
      {
        jobId: 'j_preview',
        tenantId: 't1',
        jobKind: 'preview',
        profile: 'preview-360p-v1',
        status: 'succeeded',
        wallSeconds: 15.0,
        cpuSecondsActual: 12.0,
        outputDurationSeconds: 5.0,
        outputBytes: 1 * 1024 * 1024,
      },
      {
        jobId: 'j_render_failed',
        tenantId: 't1',
        jobKind: 'render',
        profile: 'mp4-720p-v1',
        status: 'failed',
        wallSeconds: 20.0,
        cpuSecondsActual: 18.0,
        outputDurationSeconds: 0,
        outputBytes: 0,
      },
    ];

    const result = exp.exportJson(jobs);

    assert.equal(result.summary.totalSubmitted, 3);
    assert.equal(result.summary.totalSucceeded, 2);
    assert.equal(result.summary.totalFailed, 1);
    assert.equal(result.summary.totalBillableJobs, 1, 'Only succeeded render job is billable');

    // Billable output minutes: only 15s from j_render_succ = 0.25 min (preview is exempt)
    assert.equal(result.summary.billable.totalBillableOutputMinutes, 0.25);

    // Operational wall seconds: 60 + 15 + 20 = 95s
    assert.equal(result.summary.operational.totalWallSeconds, 95.0);
    assert.ok(result.summary.operational.totalOperationalCostUsd > 0);
  });

  await t.test('exports valid RFC 4180 CSV and JSONL formats', () => {
    const exp = new UsageExporter();
    const jobs = [
      {
        jobId: 'j_csv_1',
        tenantId: 't_csv',
        jobKind: 'render',
        profile: 'mp4-720p-v1',
        status: 'succeeded',
        wallSeconds: 30.0,
        cpuSecondsActual: 25.0,
        outputDurationSeconds: 10.0,
        outputBytes: 1024,
      },
    ];

    const csv = exp.exportCsv(jobs);
    assert.ok(csv.startsWith('tenant_id,job_id,job_kind,profile,status'));
    const csvLines = csv.trim().split('\n');
    assert.equal(csvLines.length, 2);
    assert.match(csvLines[1], /t_csv,j_csv_1,render,mp4-720p-v1,succeeded/);

    const jsonl = exp.exportJsonl(jobs);
    const jsonlLines = jsonl.trim().split('\n');
    assert.equal(jsonlLines.length, 2); // header line + entry line
    const header = JSON.parse(jsonlLines[0]);
    assert.equal(header.type, 'header');
    const entry = JSON.parse(jsonlLines[1]);
    assert.equal(entry.type, 'usage_entry');
    assert.equal(entry.jobId, 'j_csv_1');
  });
});

test('Task P9-02: Pricing Simulator & 10/50/80% Scenarios Suite', async (t) => {
  await t.test('computes dedicated hardware provisioning costs for standard nodes', () => {
    const sim = new PricingSimulator();
    const cost = sim.calculateHostProvisioningCost(1);

    assert.equal(cost.nodeCount, 1);
    assert.equal(cost.hostVcpus, 4);
    assert.equal(cost.vcpuHourlyRateUsd, 0.04);
    assert.equal(cost.monthlyCostPerNode, 116.80);
    assert.equal(cost.totalMonthlyProvisionedCostUsd, 116.80);

    const cost3 = sim.calculateHostProvisioningCost(3);
    assert.equal(cost3.totalMonthlyProvisionedCostUsd, 350.40);
  });

  await t.test('evaluates PAYG volume tiered pricing across brackets', () => {
    const sim = new PricingSimulator();

    // 50 minutes (Tier 1: $0.18/min)
    const p50 = sim.calculatePaygRevenue(50);
    assert.equal(p50.totalRevenueUsd, 9.00);

    // 250 minutes (100 * $0.18 + 150 * $0.14 = $18 + $21 = $39.00)
    const p250 = sim.calculatePaygRevenue(250);
    assert.equal(p250.totalRevenueUsd, 39.00);
    assert.equal(p250.tierBreakdown.length, 2);
  });

  await t.test('simulates 3 canonical utilization scenarios (10%, 50%, 80%)', () => {
    const sim = new PricingSimulator();
    const report = sim.simulateUtilizationScenarios({ nodeCount: 1, rtf: 4.0 });

    assert.equal(report.scenarios.length, 3);
    const [s10, s50, s80] = report.scenarios;

    assert.equal(s10.utilizationPercent, 10);
    assert.equal(s50.utilizationPercent, 50);
    assert.equal(s80.utilizationPercent, 80);

    // Higher utilization yields more billable output minutes
    assert.ok(s50.billableOutputMinutes > s10.billableOutputMinutes);
    assert.ok(s80.billableOutputMinutes > s50.billableOutputMinutes);

    // Fully allocated unit cost decreases as utilization increases
    assert.ok(
      s10.unitEconomics.fullyAllocatedUnitCostPerMinuteUsd >
      s50.unitEconomics.fullyAllocatedUnitCostPerMinuteUsd
    );
    assert.ok(
      s50.unitEconomics.fullyAllocatedUnitCostPerMinuteUsd >
      s80.unitEconomics.fullyAllocatedUnitCostPerMinuteUsd
    );

    // PAYG gross margin increases at higher utilization
    assert.ok(
      s80.commercialProjections.paygTiered.grossMarginPercent >
      s10.commercialProjections.paygTiered.grossMarginPercent
    );
  });

  await t.test('simulates what-if workload distribution (80% promo, 20% footage)', () => {
    const sim = new PricingSimulator();
    const result = sim.simulateWorkloadDistribution({ totalJobs: 1000, nodeCount: 1 });

    assert.equal(result.workload.totalJobs, 1000);
    assert.equal(result.workload.promoJobsCount, 800);
    assert.equal(result.workload.footageJobsCount, 200);

    // Promo: 800 * 15s = 12000s, Footage: 200 * 45s = 9000s -> Total 21000s = 350 min
    assert.equal(result.workload.totalOutputSeconds, 21000);
    assert.equal(result.workload.totalBillableMinutes, 350.0);
    assert.ok(result.costs.marginalComputeCostUsd > 0);
  });
});

test('Task P9-02: Usage Reconciliation & Invariant Engine Suite', async (t) => {
  await t.test('confirms clean ledger passes reconciliation with BALANCED status', () => {
    const rec = new ReconciliationEngine();
    rec.recordJobState({ jobId: 'j_clean', tenantId: 't1', status: 'succeeded', outputDurationSeconds: 15 });
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_clean', entryType: 'RESERVATION', reservedUnitsUsd: 0.005 });
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_clean', entryType: 'SETTLEMENT', isBillable: true, billableOutputMinutes: 0.25, settledUnitsUsd: 0.001333 });
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_clean', entryType: 'RELEASE', releasedUnitsUsd: 0.003667 });

    const report = rec.reconcile();
    assert.equal(report.status, 'BALANCED');
    assert.equal(report.discrepancies.length, 0);
    assert.equal(report.invariants.zeroDuplicateBilledEntries, true);
    assert.equal(report.invariants.reservationReleaseConsistent, true);
  });

  await t.test('detects duplicate billable entry and generates compensating entry to balance ledger', () => {
    const rec = new ReconciliationEngine();
    rec.recordJobState({ jobId: 'j_dup', tenantId: 't1', status: 'succeeded', outputDurationSeconds: 15 });
    // Duplicate settlements
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_dup', entryType: 'SETTLEMENT', isBillable: true, billableOutputMinutes: 0.25, settledUnitsUsd: 0.002 });
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_dup', entryType: 'SETTLEMENT', isBillable: true, billableOutputMinutes: 0.25, settledUnitsUsd: 0.002 });

    const report1 = rec.reconcile();
    assert.equal(report1.status, 'DISCREPANCY_DETECTED');
    assert.equal(report1.discrepancies[0].code, 'DOUBLE_BILLABLE_ENTRY');

    // Auto-generate compensation
    const comp = rec.generateCompensatingEntries(report1);
    assert.equal(comp.generatedCount, 1);
    assert.equal(comp.compensatingEntries[0].entryType, 'COMPENSATING_RECONCILIATION');

    // Post-compensation reconciliation
    const report2 = rec.reconcile();
    assert.equal(report2.status, 'BALANCED');
    assert.equal(report2.invariants.zeroDuplicateBilledEntries, true);
  });

  await t.test('detects dangling reservation on failed job and releases it via compensation', () => {
    const rec = new ReconciliationEngine();
    rec.recordJobState({ jobId: 'j_fail_dang', tenantId: 't1', status: 'failed' });
    rec.appendLedgerEntry({ tenantId: 't1', jobId: 'j_fail_dang', entryType: 'RESERVATION', reservedUnitsUsd: 0.010 });

    const report1 = rec.reconcile();
    assert.equal(report1.status, 'DISCREPANCY_DETECTED');
    assert.equal(report1.discrepancies[0].code, 'DANGLING_RESERVATION');

    rec.generateCompensatingEntries(report1);
    const report2 = rec.reconcile();
    assert.equal(report2.status, 'BALANCED');
    assert.equal(report2.invariants.reservationReleaseConsistent, true);
  });
});

test('Task P9-02: Mock Billing Processor & Safety Suite', async (t) => {
  await t.test('strictly asserts that real charging and payment keys are forbidden', () => {
    // Attempting live charging must throw
    assert.throws(
      () => new MockBillingProcessor({ liveChargingEnabled: true }),
      /SECURITY VIOLATION.*Real charging is strictly forbidden/
    );

    assert.throws(
      () => new MockBillingProcessor({ stripeSecretKey: 'sk_live_12345' }),
      /SECURITY VIOLATION.*Real charging is strictly forbidden/
    );
  });

  await t.test('generates draft simulated invoice with SHA-256 integrity hash', () => {
    const bp = new MockBillingProcessor();
    const invoice = bp.generateDraftInvoice(
      't_corp',
      {
        totalBillableOutputMinutes: 80.0, // 60 included + 20 overage
        storedGigabytes: 15.0,
        egressGigabytes: 30.0,
      },
      {
        planId: 'starter',
      }
    );

    assert.equal(invoice.tenantId, 't_corp');
    assert.equal(invoice.status, 'SIMULATED_DRAFT');
    assert.equal(invoice.realChargingExecuted, false);
    assert.equal(invoice.paymentGatewayEngaged, false);

    assert.equal(invoice.financials.basePlanFeeUsd, 29.00);
    assert.equal(invoice.financials.overageFeeUsd, 3.00); // 20 * 0.15 = 3.00
    assert.ok(invoice.financials.totalUsd > 32.00);
    assert.ok(invoice.integrityHash);
    assert.equal(invoice.integrityHash.length, 64); // SHA-256 hex length
  });

  await t.test('formats human-readable billing statement with clear simulation banners', () => {
    const bp = new MockBillingProcessor();
    const invoice = bp.generateDraftInvoice('t_text', { totalBillableOutputMinutes: 10 });
    const text = bp.formatInvoiceText(invoice);

    assert.match(text, /SIMULATION \/ DRY-RUN ONLY/);
    assert.match(text, /TOTAL DUE:.*\(NO REAL CHARGE\)/);
  });
});

test('Task P9-02: Full Commercial Suite End-to-End Orchestration', async (t) => {
  await t.test('executes end-to-end evaluation with 100% checks passing', () => {
    const suite = new CommercialSuite();
    const report = suite.runFullEvaluation();

    assert.equal(report.summary.allChecksPassed, true);
    assert.equal(report.quotaResults.plansCount, 4);
    assert.equal(report.quotaResults.warningTriggered, true);
    assert.equal(report.retentionResults.purgeCandidatesCount, 3);
    assert.equal(report.retentionResults.legalHoldPreservedCount, 1);
    assert.equal(report.exportResults.totalRecordsExported, 4);
    assert.equal(report.pricingResults.scenariosCount, 3);
    assert.equal(report.reconciliationResults.postCompensationBalanced, true);
    assert.equal(report.billingResults.realChargingExecuted, false);

    const md = suite.generateMarkdownReport(report);
    assert.match(md, /Evidence Report — Task P9-02/);
    assert.match(md, /Task: P9-02/);
    assert.match(md, /EXT-P9-02/);
  });
});
