/**
 * Test Suite: G4 Private Beta Gate Readiness, Release Manifest, Migrations, Rollback & SLO
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-05)
 *   - docs/TESTING.md ("G4 private beta", line 13)
 *   - docs/SECURITY.md
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership")
 *   - docs/DEPLOYMENT.md
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseManifestGenerator, RELEASE_VERSION } from '../release/release-manifest.mjs';
import { MigrationManager, EXPAND_CONTRACT_PHASES } from '../release/migration-manager.mjs';
import { RollbackManager, ROLLBACK_TIERS } from '../release/rollback-manager.mjs';
import { SloErrorBudgetManager, CANONICAL_SLOS, SUPPORT_OWNERSHIP_MATRIX } from '../release/slo-error-budget.mjs';
import { G4ReadinessEvaluator, G4_EXTERNAL_GATES } from '../release/g4-readiness-evaluator.mjs';

describe('G4 Private Beta Gate Readiness & Release Artifacts Suite', () => {
  it('generates immutable release manifest with 7 packages, container image digests, and verified integrity', () => {
    const generator = new ReleaseManifestGenerator();
    const manifest = generator.generateManifest();

    assert.strictEqual(manifest.releaseVersion, RELEASE_VERSION);
    assert.strictEqual(manifest.phase, 'P6');
    assert.strictEqual(manifest.gate, 'G4');
    assert.ok(manifest.manifestDigest.startsWith('sha256:'));
    assert.strictEqual(manifest.packageInventory.length, 7);

    // Verify all 7 container images have sha256 pinned digests
    const images = Object.values(manifest.containerImages);
    assert.strictEqual(images.length, 7);
    for (const img of images) {
      assert.ok(img.digest && img.digest.startsWith('sha256:'));
    }

    // Verify manifest verification runner
    const verification = generator.verifyManifest(manifest);
    assert.strictEqual(verification.passed, true);
    assert.strictEqual(verification.failedChecks, 0);
  });

  it('verifies database migration checksums, 21 canonical tables, role segregation, and expand-contract N/N-1 compatibility', () => {
    const migrator = new MigrationManager();
    const result = migrator.runAll();

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.checksums.passed, true);
    assert.strictEqual(result.checksums.failedMigrations, 0);

    // Check roles
    assert.strictEqual(result.roles.passed, true);

    // Check 21 tables
    assert.strictEqual(result.tables.passed, true);

    // Check expand/contract rules
    assert.strictEqual(result.expandContract.backwardCompatibleWithNMinus1, true);
    assert.strictEqual(result.expandContract.violations.length, 0);
    assert.ok(EXPAND_CONTRACT_PHASES.EXPAND);
    assert.ok(EXPAND_CONTRACT_PHASES.DEPLOY_AND_DRAIN);
    assert.ok(EXPAND_CONTRACT_PHASES.CONTRACT);
  });

  it('verifies 3-tier safe rollback plan, lease fencing, and post-restore safety locks', () => {
    const rollback = new RollbackManager();
    const result = rollback.runAll();

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.failedChecks, 0);

    assert.ok(ROLLBACK_TIERS.TIER_1_WORKER);
    assert.ok(ROLLBACK_TIERS.TIER_2_API);
    assert.ok(ROLLBACK_TIERS.TIER_3_DATABASE);

    // Verify lease fencing blocks stale publish
    assert.strictEqual(result.leaseFencing.invariantPreserved, true);
    assert.strictEqual(result.leaseFencing.rejectionCode, 'STALE_LEASE_EPOCH');

    // Verify post-restore safety locks
    assert.strictEqual(result.safetyLock.allSafetyLocksEnforced, true);
  });

  it('validates 9 canonical SLO contracts, error budget accounting, burn rate policies, and support ownership matrix', () => {
    const sloMgr = new SloErrorBudgetManager();
    const result = sloMgr.runAll();

    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.compliance.totalSlos, 9);
    assert.strictEqual(result.compliance.passedSlos, 9);

    // Check burn rate triggers
    assert.strictEqual(result.burnRateScenarios.normalBurn.policy, 'NORMAL_OPERATIONS');
    assert.strictEqual(result.burnRateScenarios.elevatedBurn.policy, 'FREEZE_FEATURE_ROLLOUTS');
    assert.strictEqual(result.burnRateScenarios.criticalBurn.policy, 'CRITICAL_P0_HALT');
    assert.strictEqual(result.burnRateScenarios.criticalBurn.severity, 'P0');

    // Check support ownership
    assert.strictEqual(SUPPORT_OWNERSHIP_MATRIX.roles.length, 5);
    const roleTitles = SUPPORT_OWNERSHIP_MATRIX.roles.map((r) => r.role);
    assert.ok(roleTitles.includes('Control Plane Lead'));
    assert.ok(roleTitles.includes('Render Pipeline Lead'));
    assert.ok(roleTitles.includes('Operations / SRE Lead'));
    assert.ok(roleTitles.includes('Database & Storage Lead'));
    assert.ok(roleTitles.includes('Security & Compliance Officer'));
  });

  it('executes full G4 Readiness Evaluator and confirms GO_FOR_PRIVATE_BETA_STAGING with external gates maintained', async () => {
    const evaluator = new G4ReadinessEvaluator();
    const report = await evaluator.runFullG4Evaluation();

    assert.strictEqual(report.overallStatus, 'PASS');
    assert.strictEqual(report.g4Decision, 'GO_FOR_PRIVATE_BETA_STAGING');
    assert.strictEqual(report.summary.totalPillars, 8);
    assert.strictEqual(report.summary.passedPillars, 8);
    assert.strictEqual(report.summary.failedPillars, 0);

    // Production deploy statement must explicitly state it is NOT self-granted
    assert.ok(report.productionDeployStatement.includes('KHÔNG tự được cấp'));

    // External gates must be preserved
    assert.strictEqual(report.externalGates.length, G4_EXTERNAL_GATES.length);
    const gateIds = report.externalGates.map((g) => g.gateId);
    assert.ok(gateIds.includes('EXT-GATE-PROD-01'));
    assert.ok(gateIds.includes('EXT-GATE-CREATIVANTA-02'));
    assert.ok(gateIds.includes('EXT-GATE-LEGAL-03'));
    assert.ok(gateIds.includes('EXT-GATE-INFRA-04'));
  });
});
