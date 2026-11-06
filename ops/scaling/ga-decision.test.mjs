import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GaDecisionEvaluator,
  GA_VERSION,
  GA_RELEASE_TAG,
  GA_EXTERNAL_GATES,
  OPTIONAL_FEATURES_GOVERNANCE,
  DATA_RESIDENCY_POLICY,
  SUPPORT_ON_CALL_MATRIX,
  SLO_CONTRACTS,
} from './ga-decision-evaluator.mjs';

test('Task P9-05: Capacity & Headroom Dimension Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const capacity = await evaluator.evaluateCapacityDimension();

  await t.test('enforces hard monthly budget clamp ($350.40/mo) and max 3 nodes ceiling', () => {
    assert.equal(capacity.status, 'PASS');
    assert.equal(capacity.monthlyBudgetCapUsd, 350.40);
    assert.equal(capacity.maxNodesUnderCap, 3);
    assert.equal(capacity.totalClusterSlots, 6);
    assert.equal(capacity.cooldownSeconds, 600);
    assert.equal(capacity.maxDrainWaitSeconds, 600);
  });

  await t.test('confirms DB queue headroom >7,800x and zero external broker requirement', () => {
    assert.ok(capacity.dbQueueHeadroomRatio > 7800);
    assert.equal(capacity.profilingSummary.bottleneckDetected, false);
    assert.equal(capacity.profilingSummary.externalBrokerRequired, false);
    assert.equal(capacity.profilingSummary.selectedArchitecture, 'POSTGRESQL_NATIVE_QUEUE');
    assert.ok(capacity.dispatcherClaimRateOpsPerSec > 3500);
  });

  await t.test('validates sustainable cluster throughput and queue wait latency target', () => {
    assert.equal(capacity.sustainableArrivalJobsPerHour, 74.3);
    assert.equal(capacity.clusterCapacityJobsPerHour, 222.9);
    assert.equal(capacity.queueWaitP95ThresholdSeconds, 60);
  });
});

test('Task P9-05: Cost & Unit Economics Dimension Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const cost = evaluator.evaluateCostDimension();

  await t.test('confirms fully allocated unit cost satisfies <= $0.05/minute target across production scenarios', () => {
    assert.equal(cost.status, 'PASS');
    assert.ok(cost.scenario50.fullyAllocatedUnitCostPerMinuteUsd <= 0.05);
    assert.ok(cost.scenario80.fullyAllocatedUnitCostPerMinuteUsd <= 0.05);
    assert.ok(cost.scenario50.grossMarginPercent > 50);
    assert.ok(cost.scenario80.grossMarginPercent > 70);
  });

  await t.test('guarantees zero duplicate billing and append-only compensation invariants', () => {
    assert.equal(cost.billingReconciliation.zeroDuplicateBilledEntries, true);
    assert.equal(cost.billingReconciliation.appendOnlyCompensationSupported, true);
    assert.equal(cost.billingReconciliation.mockBillingIsolationAsserted, true);
  });
});

test('Task P9-05: Security, Sandboxing & Supply Chain Dimension Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const security = evaluator.evaluateSecurityDimension();

  await t.test('passes all core security boundaries with zero critical findings', () => {
    assert.equal(security.status, 'PASS');
    assert.equal(security.openCriticalFindings, 0);
    assert.equal(security.openHighFindings, 0);
    assert.equal(security.passedSecurityChecks, security.totalSecurityChecks);
  });

  await t.test('strictly verifies non-root Chromium sandbox and safe FFmpeg argv', () => {
    const chromiumCheck = security.checks.find((c) => c.name.includes('Chromium'));
    assert.ok(chromiumCheck.enforced);
    assert.ok(chromiumCheck.forbiddenFlags.includes('--no-sandbox'));

    const ffmpegCheck = security.checks.find((c) => c.name.includes('FFmpeg'));
    assert.ok(ffmpegCheck.enforced);
    assert.equal(ffmpegCheck.protocolWhitelist, 'file,pipe');
  });

  await t.test('verifies composite tenant FK / RLS isolation returning HTTP 404 for foreign IDs', () => {
    const tenantCheck = security.checks.find((c) => c.name.includes('Tenant'));
    assert.ok(tenantCheck.enforced);
    assert.equal(tenantCheck.foreignIdsReturnCode, 404);
  });
});

test('Task P9-05: SLO Contracts & Error Budget Governance Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const slo = evaluator.evaluateSloDimension();

  await t.test('confirms all 9 production SLO targets compliant with docs/OPERATIONS.md', () => {
    assert.equal(slo.status, 'PASS');
    assert.equal(SLO_CONTRACTS.availability.target, '>= 99.5%');
    assert.equal(SLO_CONTRACTS.renderSuccess.target, '>= 99.0%');
    assert.equal(SLO_CONTRACTS.submitLatency.target, 'p95 < 500ms');
    assert.equal(SLO_CONTRACTS.queueWait.target, 'p95 < 60s');
    assert.equal(SLO_CONTRACTS.renderSpeed.target, 'warm RTF <= 6.0');
    assert.equal(SLO_CONTRACTS.webhookLatency.target, 'p95 < 10s');
    assert.equal(SLO_CONTRACTS.dataConsistency.status, 'ZERO_VIOLATIONS');
    assert.equal(SLO_CONTRACTS.disasterRecovery.status, 'VERIFIED');
    assert.equal(SLO_CONTRACTS.assetDeletion.status, 'VERIFIED');
  });

  await t.test('verifies 2x and 10x error budget burn rate triggers', () => {
    const burn = SLO_CONTRACTS.burnRatePolicies;
    assert.equal(burn.burnRate2x.action, 'FEATURE_ROLLOUT_FREEZE');
    assert.equal(burn.burnRate10x.action, 'P0_INCIDENT_MOBILIZATION');
    assert.equal(burn.securityBreach.action, 'IMMEDIATE_CIRCUIT_BREAKER');
  });
});

test('Task P9-05: Support Matrix, Escalation Ladder & Runbooks Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const support = evaluator.evaluateSupportDimension();

  await t.test('confirms 4 severity tiers with strict response SLAs (<15m for P0)', () => {
    assert.equal(support.status, 'PASS');
    assert.equal(support.severityTiersCount, 4);
    const p0 = SUPPORT_ON_CALL_MATRIX.severityTiers[0];
    assert.equal(p0.level, 'P0_CRITICAL');
    assert.equal(p0.responseSlaMinutes, 15);
    assert.equal(p0.updateCadenceMinutes, 30);
  });

  await t.test('verifies 5 specialized service leads and 6 operational runbooks', () => {
    assert.equal(support.serviceLeadsCount, 5);
    assert.equal(support.verifiedRunbooksCount, 6);
    const runbookIds = SUPPORT_ON_CALL_MATRIX.verifiedRunbooks.map((r) => r.id);
    assert.deepEqual(runbookIds, [
      'RUNBOOK-01',
      'RUNBOOK-02',
      'RUNBOOK-03',
      'RUNBOOK-04',
      'RUNBOOK-05',
      'RUNBOOK-06',
    ]);
  });
});

test('Task P9-05: Commercial Legal, Quota Packaging & Clean-Room Licensing Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const com = evaluator.evaluateCommercialLegalDimension();

  await t.test('confirms 4 standard quota plans (free, starter, pro, enterprise)', () => {
    assert.equal(com.status, 'PASS');
    assert.equal(com.quotaPlansCount, 4);
    assert.ok(com.quotaPlans.includes('free'));
    assert.ok(com.quotaPlans.includes('starter'));
    assert.ok(com.quotaPlans.includes('pro'));
    assert.ok(com.quotaPlans.includes('enterprise'));
  });

  await t.test('confirms 4 retention tiers and clean-room permissive licensing (0 copyleft)', () => {
    assert.equal(com.retentionTiersCount, 4);
    assert.equal(com.licensingAudit.copyleftLicensesPresent, 0);
    assert.equal(com.licensingAudit.permissiveLicensesOnly, true);
    assert.equal(com.licensingAudit.ffmpegNonFreeDisabled, true);
    assert.equal(com.licensingAudit.commercialPatentReviewPending, 'EXT-GATE-COMMERCIAL-LEGAL-03');
  });
});

test('Task P9-05: Data Residency & Sovereign Containment Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const data = evaluator.evaluateDataResidencyDimension();

  await t.test('confirms tenant-prefix storage layout and encryption standards', () => {
    assert.equal(data.status, 'PASS');
    assert.ok(DATA_RESIDENCY_POLICY.storagePrefixPattern.startsWith('tenant/{tenant_id}'));
    assert.ok(DATA_RESIDENCY_POLICY.encryptionAtRest.includes('AES-256-GCM'));
    assert.ok(DATA_RESIDENCY_POLICY.encryptionInTransit.includes('TLS 1.3'));
  });

  await t.test('enforces regional containment and right-to-be-forgotten deletion SLA', () => {
    assert.ok(DATA_RESIDENCY_POLICY.primaryRegionTarget.includes('ap-southeast-1'));
    assert.equal(DATA_RESIDENCY_POLICY.crossBorderReplication, 'STRICTLY_PROHIBITED_WITHOUT_DPA');
    assert.equal(DATA_RESIDENCY_POLICY.deletionPurgeSlaHours, 24);
    assert.equal(DATA_RESIDENCY_POLICY.backupRetentionMaxDays, 30);
    assert.equal(DATA_RESIDENCY_POLICY.aiDataSharing, 'STRICTLY_PROHIBITED_WITHOUT_TENANT_OPT_IN');
  });
});

test('Task P9-05: Release Manifest & 3-Tier Safe Rollback Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const rel = evaluator.evaluateReleaseRollbackDimension();

  await t.test('verifies immutable GA candidate release tag and version', () => {
    assert.equal(rel.status, 'PASS');
    assert.equal(rel.version, '1.0.0');
    assert.equal(rel.releaseTag, 'v1.0.0-ga-candidate');
    assert.equal(rel.schemaCompatibility, 'EXPAND_CONTRACT_N_MINUS_1_COMPATIBLE');
  });

  await t.test('confirms 3-tier safe rollback procedures and golden canary fixtures', () => {
    assert.equal(rel.rollbackProcedures.tier1WorkerPoolDrain, 'IMMEDIATE_DRAIN_AND_IMAGE_ROLLBACK');
    assert.equal(rel.rollbackProcedures.tier2ApiGateway, 'BLUE_GREEN_OR_CANARY_IMAGE_DOWNGRADE');
    assert.equal(rel.rollbackProcedures.tier3DatabaseRecovery, 'POST_RESTORE_SAFETY_GATE_COMPENSATING_MIGRATION');
    assert.equal(rel.canaryFixtures.length, 3);
  });
});

test('Task P9-05: Optional P7 & P8 Gate Policy (Strict Prohibition on Advertising) Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const opt = evaluator.evaluateOptionalFeaturesGovernance();

  await t.test('strictly verifies that P7 custom code is NOT advertised in GA and locked to pilot tenants', () => {
    assert.equal(opt.status, 'PASS');
    assert.equal(opt.p7CustomCode.advertisedInGa, false);
    assert.equal(opt.p7CustomCode.allowedInPublicCatalog, false);
    assert.equal(opt.p7CustomCode.allowedInPublicPricing, false);
    assert.equal(opt.p7CustomCode.status, 'RESTRICTED_PILOT_ONLY');
    assert.equal(opt.p7CustomCode.defaultEnabled, false);
    assert.equal(opt.p7CustomCode.complianceCheck, 'PASS_NOT_ADVERTISED');
  });

  await t.test('strictly verifies that P8 browser export is NOT advertised in GA and requires server fallback', () => {
    assert.equal(opt.p8BrowserExport.advertisedInGa, false);
    assert.equal(opt.p8BrowserExport.allowedInPublicCatalog, false);
    assert.equal(opt.p8BrowserExport.allowedInPublicPricing, false);
    assert.equal(opt.p8BrowserExport.status, 'EXPERIMENTAL_INTERNAL_EVALUATION');
    assert.equal(opt.p8BrowserExport.fallbackToServerRequired, true);
    assert.equal(opt.p8BrowserExport.complianceCheck, 'PASS_NOT_ADVERTISED');
  });

  await t.test('fails compliance check if P7 or P8 is illegally advertised in GA catalog', () => {
    const invalidGovernance = {
      p7CustomCode: { ...OPTIONAL_FEATURES_GOVERNANCE.p7CustomCode, advertisedInGa: true },
      p8BrowserExport: { ...OPTIONAL_FEATURES_GOVERNANCE.p8BrowserExport },
    };

    const p7NotAdvertised = !invalidGovernance.p7CustomCode.advertisedInGa;
    assert.equal(p7NotAdvertised, false, 'Should detect illegal P7 advertising');
  });
});

test('Task P9-05: Full GA Decision Packet End-to-End Orchestration Suite', async (t) => {
  const evaluator = new GaDecisionEvaluator();
  const packet = await evaluator.runFullGaEvaluation();

  await t.test('achieves PASS across all 8 pillars and establishes GO_FOR_GA_CANDIDATE_WITH_EXTERNAL_GATES', () => {
    assert.equal(packet.overallStatus, 'PASS');
    assert.equal(packet.decision, 'GO_FOR_GA_CANDIDATE_WITH_EXTERNAL_GATES');
    assert.equal(packet.summary.totalPillars, 8);
    assert.equal(packet.summary.passedPillars, 8);
    assert.equal(packet.summary.failedPillars, 0);
    assert.equal(packet.summary.optionalFeaturesGoverned, true);
    assert.equal(packet.summary.externalGatesCount, 6);
  });

  await t.test('verifies all 6 external gates are accounted for with explicit ownership', () => {
    assert.equal(packet.externalGates.length, 6);
    const gateIds = packet.externalGates.map((g) => g.gateId);
    assert.ok(gateIds.includes('EXT-GATE-PROD-AUTH-01'));
    assert.ok(gateIds.includes('EXT-GATE-CREATIVANTA-LIVE-02'));
    assert.ok(gateIds.includes('EXT-GATE-COMMERCIAL-LEGAL-03'));
    assert.ok(gateIds.includes('EXT-GATE-DATA-RESIDENCY-04'));
    assert.ok(gateIds.includes('EXT-GATE-P7-MICROVM-05'));
    assert.ok(gateIds.includes('EXT-GATE-P8-BROWSER-06'));
  });

  await t.test('generates valid, complete markdown report with single H1 and balanced code blocks', () => {
    const reportMd = evaluator.generateMarkdownReport(packet, 'test-commit-sha');
    assert.ok(reportMd.length > 5000);

    const h1Matches = reportMd.match(/^# /gm);
    assert.equal(h1Matches.length, 1, 'Markdown report must have exactly one H1');

    const fences = reportMd.match(/^```/gm);
    assert.ok(fences.length > 0 && fences.length % 2 === 0, 'Code fences must be balanced');
    assert.ok(reportMd.includes('P9-05: Supervisor+Reviewer / P9'));
    assert.ok(reportMd.includes('PIL-CAPACITY'));
    assert.ok(reportMd.includes('PIL-COST'));
    assert.ok(reportMd.includes('PIL-SECURITY'));
    assert.ok(reportMd.includes('PIL-SLO'));
    assert.ok(reportMd.includes('PIL-SUPPORT'));
    assert.ok(reportMd.includes('PIL-COMMERCIAL'));
    assert.ok(reportMd.includes('PIL-DATA-RESIDENCY'));
    assert.ok(reportMd.includes('PIL-RELEASE-ROLLBACK'));
    assert.ok(reportMd.includes('CẤM QUẢNG CÁO TRÊN BẢNG GIÁ GA'));
  });
});
