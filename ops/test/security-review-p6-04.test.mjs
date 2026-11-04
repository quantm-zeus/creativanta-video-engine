/**
 * Test Suite: P6-04 Security Reviewer — Structured Renderer Security, SBOM/License/Codec/Asset Audit,
 * and Secrets/IDOR/SSRF/Abuse/Deletion Verification.
 *
 * Canonical specifications:
 *   - docs/SECURITY.md
 *   - docs/TESTING.md ("Security tests", lines 30-35)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-04)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RendererSecuritySuite } from '../security/renderer-security-suite.mjs';
import { SbomLicenseCodecAuditor, BANNED_DEPENDENCIES } from '../security/sbom-license-codec-auditor.mjs';
import { ApiTenantSecuritySuite } from '../security/api-tenant-security-suite.mjs';
import { SecurityReviewRunner, SECURITY_REVIEW_FINDINGS } from '../security/security-review-runner.mjs';

describe('P6-04 Security Reviewer Verification Suite', () => {
  it('passes all 9 structured renderer security suite checks (nonroot, Chromium flags, CSP/XXE, FFmpeg safe argv, RO inputs, symlink/hardlink, resource bombs, secret canary, loopback server)', async () => {
    const suite = new RendererSecuritySuite();
    const res = await suite.runAll();

    for (const check of res.checks) {
      assert.strictEqual(
        check.passed,
        true,
        `Renderer security check ${check.id} (${check.title}) failed: ${check.error || ''}`
      );
    }
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.totalChecks, 9);
    assert.strictEqual(res.passedChecks, 9);
    assert.strictEqual(res.failedChecks, 0);
  });

  it('passes all 5 SBOM, license, codec, fixture/template asset provenance, and TTS voice rights checks', async () => {
    const auditor = new SbomLicenseCodecAuditor();
    const res = await auditor.runAll();

    for (const check of res.checks) {
      assert.strictEqual(
        check.passed,
        true,
        `SBOM/License/Codec check ${check.id} (${check.title}) failed: ${check.error || ''}`
      );
    }
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.totalChecks, 5);
    assert.strictEqual(res.passedChecks, 5);
    assert.strictEqual(res.artifacts.sbomInventory.externalRuntimeDependenciesCount, 0);
    assert.strictEqual(res.artifacts.sbomInventory.bannedPackagesFound.length, 0);
    assert.ok(BANNED_DEPENDENCIES.includes('hyperframes'));
    assert.ok(BANNED_DEPENDENCIES.includes('@hyperframes/engine'));
    assert.ok(BANNED_DEPENDENCIES.includes('puppeteer'));
    assert.ok(BANNED_DEPENDENCIES.includes('gsap'));
    assert.strictEqual(res.artifacts.assetProvenance.fixturesVerifiedCount, 3);
    assert.ok(res.artifacts.assetProvenance.manifestAssetsVerifiedCount >= 10);
    assert.ok(res.artifacts.assetProvenance.onDiskFixtureFilesVerifiedCount >= 3);
    assert.strictEqual(res.artifacts.assetProvenance.curatedTemplatesLicenseVerified.length, 6);
  });

  it('passes all 10 secrets, cross-tenant IDOR (Path 404 / Body 422), cursor binding, SSRF, malicious media, rate-limit/quota, webhook replay redaction, DELETE cascade, lease fencing, and restore safety checks', async () => {
    const suite = new ApiTenantSecuritySuite();
    const res = await suite.runAll();

    for (const check of res.checks) {
      assert.strictEqual(
        check.passed,
        true,
        `API/Tenant security check ${check.id} (${check.title}) failed: ${check.error || ''}`
      );
    }
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.totalChecks, 10);
    assert.strictEqual(res.passedChecks, 10);
    assert.strictEqual(res.failedChecks, 0);
  });

  it('aggregates full P6-04 security review with 24/24 checks passing and zero open critical/high findings', async () => {
    const runner = new SecurityReviewRunner();
    const report = await runner.runFullReview();

    assert.strictEqual(report.taskId, 'P6-04');
    assert.strictEqual(report.overallStatus, 'PASS');
    assert.strictEqual(report.betaReleaseGateDecision, 'APPROVED_FOR_PRIVATE_BETA_PENDING_EXTERNAL_GATES');
    assert.strictEqual(report.summary.totalSuites, 3);
    assert.strictEqual(report.summary.passedSuites, 3);
    assert.strictEqual(report.summary.totalChecks, 24);
    assert.strictEqual(report.summary.passedChecks, 24);
    assert.strictEqual(report.summary.failedChecks, 0);
    assert.strictEqual(report.summary.openCriticalFindings, 0);
    assert.strictEqual(report.summary.openHighFindings, 0);
    assert.strictEqual(SECURITY_REVIEW_FINDINGS.every((f) => f.status === 'RESOLVED'), true);
  });
});
