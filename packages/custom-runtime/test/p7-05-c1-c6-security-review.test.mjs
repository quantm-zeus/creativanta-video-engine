// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CANARY_SCENE_FIXTURES,
  CustomRuntimeError,
  CustomRuntimeRolloutController,
  DEFAULT_P705_CANARY_SECRET,
  DEFAULT_P705_REVIEW_SIGNING_SECRET,
  DEFAULT_PINNED_KERNEL_DIGEST,
  DEFAULT_PINNED_ROOTFS_DIGEST,
  REQUIRED_C1_TO_C6_GATES,
  computeRuntimeDigestManifest,
  evaluateAllC1ToC6Gates,
  probeHostVirtualization,
  runOffByDefaultAndRollbackSuite,
  runP705SecurityReviewSelfTest,
  signC1ToC6ReviewPacket,
  verifyC1ToC6ReviewPacket,
} from '../index.mjs';

describe('P7-05: Exact Runtime Digest Pinning & C1–C6 Signed Security Review Packet', () => {
  it('computes deterministic RuntimeDigestManifest across rootfs, guest kernel, and 3 approved packages', () => {
    const manifest1 = computeRuntimeDigestManifest();
    const manifest2 = computeRuntimeDigestManifest();

    assert.equal(manifest1.adrId, 'ADR-0002');
    assert.equal(manifest1.runtime, 'microvm-firecracker-v1');
    assert.equal(manifest1.rootfsImageDigest, DEFAULT_PINNED_ROOTFS_DIGEST);
    assert.equal(manifest1.guestKernelDigest, DEFAULT_PINNED_KERNEL_DIGEST);
    assert.match(manifest1.approvedImportsBundleDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(manifest1.compositeRuntimeFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(manifest1.preinstalledPackages.length, 3);
    assert.equal(
      manifest1.compositeRuntimeFingerprint,
      manifest2.compositeRuntimeFingerprint,
    );

    // Changing rootfs, kernel, or approved imports digest alters compositeRuntimeFingerprint
    const alteredRootfs = computeRuntimeDigestManifest({
      rootfsImageDigest: 'sha256:' + 'a'.repeat(64),
    });
    assert.notEqual(
      alteredRootfs.compositeRuntimeFingerprint,
      manifest1.compositeRuntimeFingerprint,
    );

    const alteredImports = computeRuntimeDigestManifest({
      overrideApprovedImportsDigest: 'sha256:' + 'b'.repeat(64),
    });
    assert.notEqual(
      alteredImports.compositeRuntimeFingerprint,
      manifest1.compositeRuntimeFingerprint,
    );
  });

  it('signs and verifies C1ToC6SignedReviewPacket and rejects any drift, missing gate, or tampering', () => {
    const manifest = computeRuntimeDigestManifest();
    const gates = Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true]));

    const signedPacket = signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifest,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: '2026-11-04T16:45:00.000Z',
        expiresAt: '2027-11-04T16:45:00.000Z',
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates,
      },
      DEFAULT_P705_REVIEW_SIGNING_SECRET,
    );

    assert.equal(
      verifyC1ToC6ReviewPacket(
        signedPacket,
        manifest,
        DEFAULT_P705_REVIEW_SIGNING_SECRET,
        new Date('2026-11-05T00:00:00Z'),
      ),
      true,
    );

    // 1. Rootfs digest drift -> ROOTFS_DIGEST_DRIFT
    const driftedRootfs = computeRuntimeDigestManifest({
      rootfsImageDigest: 'sha256:' + '1'.repeat(64),
    });
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          signedPacket,
          driftedRootfs,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'ROOTFS_DIGEST_DRIFT',
    );

    // 2. Guest kernel digest drift -> KERNEL_DIGEST_DRIFT
    const driftedKernel = computeRuntimeDigestManifest({
      guestKernelDigest: 'sha256:' + '2'.repeat(64),
    });
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          signedPacket,
          driftedKernel,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'KERNEL_DIGEST_DRIFT',
    );

    // 3. Pre-installed approved imports digest drift -> IMPORTS_DIGEST_DRIFT
    const driftedImports = computeRuntimeDigestManifest({
      overrideApprovedImportsDigest: 'sha256:' + '3'.repeat(64),
    });
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          signedPacket,
          driftedImports,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'IMPORTS_DIGEST_DRIFT',
    );

    // 4. Missing gate -> C1_C6_GATE_UNSATISFIED
    const missingC4Packet = signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifest,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: '2026-11-04T16:45:00.000Z',
        expiresAt: '2027-11-04T16:45:00.000Z',
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates: {
          ...gates,
          C4_resource_bombs_cancel_and_lease_fencing: false,
        },
      },
      DEFAULT_P705_REVIEW_SIGNING_SECRET,
    );
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          missingC4Packet,
          manifest,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'C1_C6_GATE_UNSATISFIED',
    );

    // 5. Unverified rollback or canary flag -> ROLLBACK_UNVERIFIED / CANARY_UNVERIFIED
    const unverifiedRollbackPacket = signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifest,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: '2026-11-04T16:45:00.000Z',
        expiresAt: '2027-11-04T16:45:00.000Z',
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: false,
        gates,
      },
      DEFAULT_P705_REVIEW_SIGNING_SECRET,
    );
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          unverifiedRollbackPacket,
          manifest,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'ROLLBACK_UNVERIFIED',
    );

    // 6. Tampered reviewer identity -> C1_C6_SIGNATURE_INVALID
    assert.throws(
      () =>
        verifyC1ToC6ReviewPacket(
          {
            ...signedPacket,
            reviewer: 'forged@attacker.invalid',
          },
          manifest,
          DEFAULT_P705_REVIEW_SIGNING_SECRET,
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'C1_C6_SIGNATURE_INVALID',
    );
  });
});

describe('P7-05: Kill Switch, 3-Fixture Canary Suite & Pilot Tenant Allowlist Evidence', () => {
  it('runs 3 custom scene canary fixtures with zero canary secret leak and enforces pilot allowlist + kill switch', async () => {
    assert.equal(CANARY_SCENE_FIXTURES.length, 3);
    const controller = new CustomRuntimeRolloutController({
      signingSecret: DEFAULT_P705_REVIEW_SIGNING_SECRET,
      canarySecret: DEFAULT_P705_CANARY_SECRET,
    });

    try {
      // 1. Default state is strictly off
      const initial = controller.getConfigSnapshot();
      assert.equal(initial.CVE_CUSTOM_CODE_ENABLED, false);
      assert.equal(initial.CVE_CUSTOM_RUNTIME, 'disabled');
      assert.deepEqual(initial.CVE_CUSTOM_TENANT_ALLOWLIST, []);

      // 2. Run 3-fixture canary suite
      const canaryReport = await controller.runCanaryVerificationSuite();
      assert.equal(canaryReport.passed, true);
      assert.equal(canaryReport.fixturesCount, 3);
      assert.equal(canaryReport.passedFixturesCount, 3);
      assert.equal(canaryReport.canarySecretLeaked, false);
      assert.equal(canaryReport.trustedApiExecutionsCount, 0);

      // 3. Sign C1-C6 review packet and enable pilot rollout for tnt_pilot_01 & tnt_pilot_02
      const signedPacket = signC1ToC6ReviewPacket(
        {
          runtimeManifest: controller.runtimeManifest,
          reviewer: 'security-reviewer@creativanta.internal',
          reviewedAt: '2026-11-04T16:45:00.000Z',
          expiresAt: '2027-11-04T16:45:00.000Z',
          killSwitchVerified: true,
          canaryVerified: true,
          allowlistVerified: true,
          offByDefaultVerified: true,
          rollbackVerified: true,
          gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
        },
        DEFAULT_P705_REVIEW_SIGNING_SECRET,
      );

      const kvmReadyProbe = probeHostVirtualization({
        overrideKvmAvailable: true,
        overrideBinaries: { firecracker: true, jailer: true },
      });

      const enabledSnap = await controller.enablePilotRollout({
        signedReviewPacket: signedPacket,
        pilotTenants: ['tnt_pilot_01', 'tnt_pilot_02'],
        hostProbe: kvmReadyProbe,
        skipCanaryRerunIfPassed: true,
      });

      assert.equal(enabledSnap.CVE_CUSTOM_CODE_ENABLED, true);
      assert.equal(enabledSnap.CVE_CUSTOM_RUNTIME, 'microvm-firecracker-v1');
      assert.deepEqual(enabledSnap.CVE_CUSTOM_TENANT_ALLOWLIST, [
        'tnt_pilot_01',
        'tnt_pilot_02',
      ]);

      // 4. Allowlisted tenant allowed; non-allowlisted tenant rejected with TENANT_NOT_ALLOWLISTED
      const auth01 = controller.assertTenantAllowedForCustomCode('tnt_pilot_01', {
        hostProbe: kvmReadyProbe,
      });
      assert.equal(auth01.allowed, true);

      assert.throws(
        () =>
          controller.assertTenantAllowedForCustomCode('tnt_non_pilot_99', {
            hostProbe: kvmReadyProbe,
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.code === 'CAPABILITY_DISABLED' &&
          err.details?.reason === 'TENANT_NOT_ALLOWLISTED',
      );

      // 5. Dynamic tenant revocation terminates running custom jobs & grants for that tenant
      let tenantRevokeTerminated = false;
      controller.registerActiveCustomJob({
        jobId: 'job_pilot02_custom_01',
        tenantId: 'tnt_pilot_02',
        kind: 'render',
        hostProbe: kvmReadyProbe,
        onTerminate: () => {
          tenantRevokeTerminated = true;
        },
      });
      controller.registerIssuedDownloadGrant({
        grantId: 'grt_pilot02_01',
        previewId: 'prv_pilot02_01',
        tenantId: 'tnt_pilot_02',
      });

      const revokeRes = controller.revokePilotTenant('tnt_pilot_02', 'COHORT_EXPIRY');
      assert.equal(revokeRes.terminatedJobsCount, 1);
      assert.equal(revokeRes.revokedGrantsCount, 1);
      assert.equal(tenantRevokeTerminated, true);

      // 6. Emergency Kill Switch terminates all running custom jobs, blocks admission, revokes grants, preserves structured path
      let killSwitchTerminatedCount = 0;
      controller.registerActiveCustomJob({
        jobId: 'job_pilot01_build_01',
        tenantId: 'tnt_pilot_01',
        kind: 'build',
        hostProbe: kvmReadyProbe,
        onTerminate: () => {
          killSwitchTerminatedCount += 1;
        },
      });
      controller.registerActiveCustomJob({
        jobId: 'job_pilot01_render_01',
        tenantId: 'tnt_pilot_01',
        kind: 'render',
        hostProbe: kvmReadyProbe,
        onTerminate: () => {
          killSwitchTerminatedCount += 1;
        },
      });
      controller.registerIssuedDownloadGrant({
        grantId: 'grt_pilot01_01',
        previewId: 'prv_pilot01_01',
        tenantId: 'tnt_pilot_01',
      });

      const killSummary = controller.triggerEmergencyKillSwitch(
        'EMERGENCY_INCIDENT_DRILL',
        'security-reviewer@creativanta.internal',
      );
      assert.equal(killSummary.killSwitchActive, true);
      assert.equal(killSummary.CVE_CUSTOM_CODE_ENABLED, false);
      assert.equal(killSummary.CVE_CUSTOM_RUNTIME, 'disabled');
      assert.equal(killSummary.terminatedCustomJobsCount, 2);
      assert.equal(killSwitchTerminatedCount, 2);
      assert.equal(killSummary.revokedGrantsCount, 1);
      assert.equal(killSummary.structuredRenderingUnaffected, true);

      assert.throws(
        () =>
          controller.assertTenantAllowedForCustomCode('tnt_pilot_01', {
            hostProbe: kvmReadyProbe,
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === 'KILL_SWITCH_ACTIVE',
      );

      assert.throws(
        () => controller.assertDownloadGrantActive('grt_pilot01_01'),
        (err) =>
          err instanceof CustomRuntimeError && err.details?.statusCode === 410,
      );

      // Structured engines remain 100% operational during kill switch
      for (const structuredEngine of ['html-v1', 'canvas-v1', 'svg-v1']) {
        const res = controller.verifyStructuredRenderingPathUnaffected(structuredEngine);
        assert.equal(res.allowed, true);
        assert.equal(res.structuredPathUnaffected, true);
      }
    } finally {
      controller.runtime.cleanupBaseDir();
    }
  });
});

describe('P7-05: Off-by-Default Regression, Runtime Rollback Drill & Full 12-Check Self-Test', () => {
  it('passes off-by-default regression, post-restore safety lock, vulnerable image revocation, and zero-data-loss rollback drill', async () => {
    const suiteRes = await runOffByDefaultAndRollbackSuite();
    assert.equal(suiteRes.passed, true);
    assert.equal(suiteRes.offByDefaultRegression.contractsDefaultOff, true);
    assert.equal(suiteRes.offByDefaultRegression.adrDefaultOff, true);
    assert.equal(suiteRes.offByDefaultRegression.controllerDefaultOff, true);
    assert.equal(suiteRes.offByDefaultRegression.defaultExecutionBlocked, true);
    assert.equal(suiteRes.offByDefaultRegression.registryPrepareBlockedByDefault, true);
    assert.equal(suiteRes.offByDefaultRegression.allocateVmBlockedByDefault, true);
    assert.equal(suiteRes.offByDefaultRegression.postRestoreLockedOff, true);
    assert.equal(suiteRes.offByDefaultRegression.postRestoreRevalidatedDefaultOff, true);

    assert.equal(suiteRes.rollbackDrill.unreviewedV2DigestDriftRejected, true);
    assert.equal(suiteRes.rollbackDrill.inFlightVulnerableJobsFailedCount, 1);
    assert.equal(suiteRes.rollbackDrill.rolledBackToDefaultOffVerified, true);
    assert.equal(suiteRes.rollbackDrill.zeroBlindDataRollback, true);
    assert.equal(suiteRes.rollbackDrill.preservedRevisionsCount, 2);
    assert.equal(suiteRes.rollbackDrill.rolledBackToKnownGoodV1Verified, true);
    assert.equal(suiteRes.rollbackDrill.structuredRenderingUnaffectedThroughout, true);
    assert.equal(suiteRes.rollbackDrill.finalStateDefaultOffRestored, true);
  });

  it('executes all 6 C1–C6 gates and passes the 12-check runP705SecurityReviewSelfTest audit', async () => {
    const report = await runP705SecurityReviewSelfTest();
    assert.equal(report.taskId, 'P7-05');
    assert.equal(report.status, 'PASS');
    assert.equal(report.totalChecks, 12);
    assert.equal(report.passedChecks, 12);
    assert.equal(report.failedChecks, 0);
    assert.equal(report.trustedApiExecutionAudit.trustedApiExecutionsCount, 0);
    assert.equal(report.defaultFeatureState.CVE_CUSTOM_CODE_ENABLED, false);
    assert.equal(report.defaultFeatureState.CVE_CUSTOM_RUNTIME, 'disabled');
    assert.ok(report.signedReviewPacket);
    assert.equal(
      report.signedReviewPacket.reviewApprovalScope,
      'TECHNICAL_GATE_VERIFIED_AWAITING_HUMAN_SIGNOFF',
    );
  });
});
