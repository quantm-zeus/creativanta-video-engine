// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateCompositionUnified } from '../../contracts/dist/index.js';

import {
  PILOT_CREATIVE_BRIEF,
  DEFAULT_PILOT_TENANT_ID,
  COST_MODEL_RATES,
  createKineticPromoVariant,
  createMetricCounterVariant,
  createAmbientVisualizerVariant,
  generateThreeCustomSceneVariants,
  measureAuthoringCost,
  measureRenderCost,
  buildSceneBundleManifest,
  materializeCustomSceneComposition,
  CustomSceneApprovalWorkflow,
  runP706CustomSceneVariantsSelfTest,
  CustomRuntimeError,
  CustomRuntimeRolloutController,
  computeRuntimeDigestManifest,
  signC1ToC6ReviewPacket,
  DEFAULT_P705_REVIEW_SIGNING_SECRET,
  REQUIRED_C1_TO_C6_GATES,
  probeHostVirtualization,
} from '../index.mjs';

describe('P7-06: 3 Custom Scene Variants from Same Brief & Approved Imports', () => {
  it('generates 3 distinct custom scene variants from the same Vietnamese creative brief', () => {
    const variants = generateThreeCustomSceneVariants();

    assert.equal(variants.length, 3);

    const [v1, v2, v3] = variants;

    // Verify Variant 1: Kinetic Typography Promo
    assert.equal(v1.variantId, 'variant-promo-kinetic');
    assert.equal(v1.variantType, 'promo-kinetic');
    assert.equal(v1.bundleId, 'bnd_p706_promo_kinetic');
    assert.equal(v1.brief, PILOT_CREATIVE_BRIEF);
    assert.equal(v1.canvas.width, 1280);
    assert.equal(v1.canvas.height, 720);
    assert.equal(v1.fps, 30);
    assert.equal(v1.totalFrames, 150);
    assert.equal(v1.parameterDefaults.headline, 'Ưu Đãi Ra Mắt — Giảm 50%');

    // Verify Variant 2: Metric Counter Cards
    assert.equal(v2.variantId, 'variant-metric-counter');
    assert.equal(v2.variantType, 'metric-counter');
    assert.equal(v2.bundleId, 'bnd_p706_metric_counter');
    assert.equal(v2.brief, PILOT_CREATIVE_BRIEF);
    assert.equal(v2.canvas.width, 1280);
    assert.equal(v2.canvas.height, 720);
    assert.equal(v2.parameterDefaults.metricPrimary, '99.9% Uptime');

    // Verify Variant 3: Ambient Particle Visualizer
    assert.equal(v3.variantId, 'variant-ambient-visualizer');
    assert.equal(v3.variantType, 'ambient-visualizer');
    assert.equal(v3.bundleId, 'bnd_p706_ambient_visualizer');
    assert.equal(v3.brief, PILOT_CREATIVE_BRIEF);
    assert.equal(v3.canvas.width, 1280);
    assert.equal(v3.canvas.height, 720);
    assert.equal(v3.parameterDefaults.particleCount, 60);

    // Verify all 3 have the identical brief_hash
    assert.equal(v1.briefHash, v2.briefHash);
    assert.equal(v2.briefHash, v3.briefHash);
    assert.match(v1.briefHash, /^[0-9a-f]{64}$/);
  });

  it('verifies all 3 variants import only approved offline packages and relative modules', () => {
    const variants = generateThreeCustomSceneVariants();
    const approvedPackagePrefixes = [
      '@creativanta/scene-runtime',
      '@creativanta/scene-math',
      '@creativanta/scene-easing',
      './',
    ];

    for (const v of variants) {
      for (const file of v.sourceFiles) {
        const lines = file.content.split('\n').filter((l) => l.startsWith('import '));
        for (const line of lines) {
          const isApproved = approvedPackagePrefixes.some(
            (pkg) => line.includes(`"${pkg}`) || line.includes(`'${pkg}`),
          );
          assert.ok(
            isApproved,
            `Variant ${v.variantId} file ${file.relativePath} contains unapproved import: ${line}`,
          );
        }
      }
    }
  });
});

describe('P7-06: Measured Authoring and Render Cost Model', () => {
  it('measures authoring cost accurately across prompt tokens, completion tokens, latency, and rates', () => {
    const promo = createKineticPromoVariant();
    const authCost = measureAuthoringCost({
      brief: promo.brief,
      sourceFiles: promo.sourceFiles,
      durationMs: 75,
      modelId: 'deterministic-mock-v1',
    });

    assert.equal(authCost.modelId, 'deterministic-mock-v1');
    assert.ok(authCost.promptTokens > 250);
    assert.ok(authCost.completionTokens > 200);
    assert.equal(authCost.totalTokens, authCost.promptTokens + authCost.completionTokens);
    assert.equal(authCost.durationMs, 75);
    assert.equal(authCost.mockCostUsd, 0.0); // Non-premium subscription-free route
    assert.ok(authCost.standardTierCostUsd > 0.0);
    assert.equal(authCost.isNonPremiumRoute, true);
    assert.equal(authCost.currency, 'USD');
  });

  it('measures render and build compute cost for disposable microVM execution', () => {
    const renderCost = measureRenderCost({
      buildResult: {
        buildDurationMs: 140,
        compiledBytes: Buffer.from('console.log("compiled");'),
      },
      previewResult: {
        renderDurationMs: 400,
        mode: 'frame',
        format: 'png',
        outputDimensions: { width: 640, height: 360 },
        artifactBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
      totalFrames: 150,
      fps: 30,
    });

    assert.equal(renderCost.build.buildDurationMs, 140);
    assert.equal(renderCost.build.buildCpuSeconds, 0.14);
    assert.ok(renderCost.build.buildCostUsd > 0);

    assert.equal(renderCost.preview.mode, 'frame');
    assert.equal(renderCost.preview.format, 'png');
    assert.equal(renderCost.preview.previewDurationMs, 400);
    assert.equal(renderCost.preview.previewCpuSeconds, 0.4);

    assert.equal(renderCost.totalComputeSeconds, 0.54);
    assert.ok(renderCost.totalRenderCostUsd > 0);
    assert.ok(renderCost.fullRenderEstimate.estimatedRenderCostUsd > 0);
    assert.equal(renderCost.currency, 'USD');
  });
});

describe('P7-06: User Preview & Approval Workflow, Editable Versions & Manifest', () => {
  function setupPilotWorkflow() {
    const manifest = computeRuntimeDigestManifest();
    const c1ToC6Gates = Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true]));
    const signedReviewPacket = signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifest,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates: c1ToC6Gates,
      },
      DEFAULT_P705_REVIEW_SIGNING_SECRET,
    );

    const rolloutController = new CustomRuntimeRolloutController({
      signingSecret: DEFAULT_P705_REVIEW_SIGNING_SECRET,
    });

    const kvmReadyProbe = probeHostVirtualization({
      overrideKvmAvailable: true,
      overrideBinaries: { firecracker: true, jailer: true },
    });

    return {
      rolloutController,
      signedReviewPacket,
      kvmReadyProbe,
      pilotTenant: DEFAULT_PILOT_TENANT_ID,
    };
  }

  it('executes full preview and approval flow, creates editable revision 2, and seals approved bundle', async () => {
    const { rolloutController, signedReviewPacket, kvmReadyProbe, pilotTenant } =
      setupPilotWorkflow();

    await rolloutController.enablePilotRollout({
      signedReviewPacket,
      pilotTenants: [pilotTenant],
      skipCanaryRerunIfPassed: true,
      hostProbe: kvmReadyProbe,
    });

    const workflow = new CustomSceneApprovalWorkflow({
      rolloutController,
      pilotTenants: [pilotTenant],
    });

    // 1. Generate 3 variants from brief
    const variants = await workflow.generateVariantsFromBrief({
      tenantId: pilotTenant,
      brief: PILOT_CREATIVE_BRIEF,
    });
    assert.equal(variants.length, 3);

    // 2. Build variant 1 in disposable build-vm
    const buildRes = await workflow.buildVariantRevision({
      tenantId: pilotTenant,
      variantId: 'variant-promo-kinetic',
      revision: 1,
    });
    assert.match(buildRes.sourceSha256, /^[0-9a-f]{64}$/);
    assert.match(buildRes.buildSha256, /^[0-9a-f]{64}$/);
    assert.match(buildRes.cspScriptHash, /^'sha256-[A-Za-z0-9+/=]+'$/);
    assert.equal(buildRes.buildMicroVmDestroyed, true);

    // 3. Render isolated frame preview in disposable render-vm (preview-360p-v1)
    const framePreview = await workflow.renderVariantPreview({
      tenantId: pilotTenant,
      variantId: 'variant-promo-kinetic',
      revision: 1,
      mode: 'frame',
      frameIndex: 45,
    });
    assert.equal(framePreview.format, 'png');
    assert.equal(framePreview.dimensions.width, 640);
    assert.equal(framePreview.dimensions.height, 360);
    assert.equal(framePreview.renderMicroVmDestroyed, true);

    // 4. Render clip preview for variant 3 (preview-360p-v1)
    const clipPreview = await workflow.renderVariantPreview({
      tenantId: pilotTenant,
      variantId: 'variant-ambient-visualizer',
      revision: 1,
      mode: 'clip',
      startFrame: 0,
      durationFrames: 60,
    });
    assert.equal(clipPreview.format, 'mp4');
    assert.equal(clipPreview.dimensions.width, 640);
    assert.equal(clipPreview.dimensions.height, 360);
    assert.equal(clipPreview.renderMicroVmDestroyed, true);

    // 5. Apply user edit, creating editable revision 2
    const editRes = await workflow.applyUserRevision({
      tenantId: pilotTenant,
      variantId: 'variant-promo-kinetic',
      baseRevision: 1,
      customParameters: {
        headline: 'Khuyến Mãi Đặc Quyền Tháng 11 — Giảm 50%',
        accentColor: '#f43f5e',
      },
      changeNote: 'Đổi tiêu đề sang Khuyến Mãi Đặc Quyền và cập nhật màu nhấn đỏ sang trọng',
    });
    assert.equal(editRes.revision, 2);
    assert.equal(editRes.parameters.headline, 'Khuyến Mãi Đặc Quyền Tháng 11 — Giảm 50%');
    assert.equal(editRes.parameters.accentColor, '#f43f5e');

    // Stale base_revision conflict rejection (optimistic concurrency)
    await assert.rejects(
      async () => {
        await workflow.applyUserRevision({
          tenantId: pilotTenant,
          variantId: 'variant-promo-kinetic',
          baseRevision: 99, // Mismatched base revision
          customParameters: { headline: 'Conflict attempt' },
        });
      },
      (err) => err instanceof CustomRuntimeError && String(err.code) === 'REVISION_CONFLICT',
    );

    // 6. User approval decision on revision 2
    const approvalReceipt = await workflow.approveVariantRevision({
      tenantId: pilotTenant,
      selectedVariantId: 'variant-promo-kinetic',
      selectedRevision: 2,
      approvedBy: 'design-lead@creativanta.internal',
      approvalNotes: 'Phê duyệt chính thức phương án 1 (Revision 2) cho chiến dịch ra mắt',
    });

    assert.equal(approvalReceipt.approved, true);
    assert.equal(approvalReceipt.revision, 2);
    assert.equal(approvalReceipt.manifest.approval.isSealed, true);
    assert.equal(approvalReceipt.manifest.approval.status, 'approved');
    assert.equal(approvalReceipt.approvalRecord.approvedBy, 'design-lead@creativanta.internal');

    // 7. Verify alternative variants are archived
    const summary = workflow.getWorkflowSummary();
    const metricSession = summary.find((s) => s.variantId === 'variant-metric-counter');
    assert.equal(metricSession?.revisions[0]?.approvalStatus, 'archived');

    // 8. Validate materialized Scene Spec 1.0 composition against @creativanta/contracts
    const compSpec = approvalReceipt.compositionSpec;
    assert.equal(compSpec.schema_version, '1.0');
    assert.equal(compSpec.scenes[0].engine, 'custom-html-v1');
    assert.equal(compSpec.scenes[0].bundle.id, 'bnd_p706_promo_kinetic');
    assert.equal(compSpec.scenes[0].bundle.revision, 2);

    // Contract validation: fails by default (default-off)
    const valDefault = validateCompositionUnified(compSpec, { profile: 'mp4-720p-v1' });
    assert.equal(valDefault.valid, false);
    assert.equal(valDefault.capabilities.errors[0]?.code, 'CAPABILITY_DISABLED');

    // Contract validation: succeeds when customCodeEnabled is granted to pilot tenant
    const valPilot = validateCompositionUnified(compSpec, {
      profile: 'mp4-720p-v1',
      capabilityOptions: { customCodeEnabled: true },
    });
    assert.equal(valPilot.valid, true);
    assert.equal(valPilot.all_errors.length, 0);
  });

  it('enforces pilot tenant allowlist gate and emergency kill switch defense', async () => {
    const { rolloutController, signedReviewPacket, kvmReadyProbe, pilotTenant } =
      setupPilotWorkflow();

    await rolloutController.enablePilotRollout({
      signedReviewPacket,
      pilotTenants: [pilotTenant],
      skipCanaryRerunIfPassed: true,
      hostProbe: kvmReadyProbe,
    });

    const workflow = new CustomSceneApprovalWorkflow({
      rolloutController,
      pilotTenants: [pilotTenant],
    });

    // 1. Non-pilot tenant is blocked immediately
    await assert.rejects(
      async () => {
        await workflow.generateVariantsFromBrief({
          tenantId: 'tnt_unauthorized_external',
          brief: PILOT_CREATIVE_BRIEF,
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED',
    );

    // 2. Generate variants for pilot tenant
    await workflow.generateVariantsFromBrief({
      tenantId: pilotTenant,
      brief: PILOT_CREATIVE_BRIEF,
    });

    // 3. Trigger emergency kill switch
    rolloutController.triggerEmergencyKillSwitch('Security Incident Drill P7-06');

    // Subsequent operation is blocked by kill switch
    await assert.rejects(
      async () => {
        await workflow.buildVariantRevision({
          tenantId: pilotTenant,
          variantId: 'variant-promo-kinetic',
          revision: 1,
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED',
    );

    // Structured rendering remains unaffected
    const structuredResult = rolloutController.verifyStructuredRenderingPathUnaffected('html-v1');
    assert.equal(structuredResult.allowed, true);
    assert.equal(structuredResult.structuredPathUnaffected, true);
  });
});

describe('P7-06: Automated 12-Check Self-Test Suite', () => {
  it('executes runP706CustomSceneVariantsSelfTest with 12/12 passing checks', async () => {
    const report = await runP706CustomSceneVariantsSelfTest();

    assert.equal(report.status, 'PASS');
    assert.equal(report.task_id, 'P7-06');
    assert.equal(report.passedCount, 12);
    assert.equal(report.totalCount, 12);
    assert.ok(report.checks.length === 12);
    assert.ok(report.checks.every((/** @type {{ status: string }} */ c) => c.status === 'PASS'));

    assert.ok(report.variantsManifest);
    assert.equal(report.variantsManifest.bundle_id, 'bnd_p706_promo_kinetic');
    assert.equal(report.variantsManifest.approval.status, 'approved');

    assert.ok(report.approvedComposition);
    assert.equal(report.approvedComposition.schema_version, '1.0');
    assert.equal(report.approvedComposition.scenes[0].engine, 'custom-html-v1');
  });
});
