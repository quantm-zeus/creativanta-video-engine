import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineSpikeEvaluator,
  ENGINE_SPIKE_PROFILES,
  CPU_BENCHMARK_SUITE,
  LICENSE_AUDIT_SUITE,
  SECURITY_AUDIT_SUITE
} from '../dist/adapters/engine-spikes.js';

test('P8-03: Specialized Scene Engine Spikes & Comparative Evaluation', async (t) => {
  await t.test('1. Comparative Evaluation: verifies all 4 candidate engines evaluated', () => {
    const report = EngineSpikeEvaluator.runComparison();
    assert.equal(report.task, 'P8-03');
    assert.equal(report.engines.length, 4);

    const engineNames = report.engines.map((e) => e.engine);
    assert.ok(engineNames.includes('videoflow'));
    assert.ok(engineNames.includes('revideo'));
    assert.ok(engineNames.includes('motion-canvas'));
    assert.ok(engineNames.includes('pixijs'));
  });

  await t.test('2. Criteria & Weighting: verifies exact 5-criterion distribution', () => {
    const report = EngineSpikeEvaluator.runComparison();
    const w = report.weights;
    assert.equal(w.correctnessAndDeterminismPct, 30);
    assert.equal(w.cpuCostAndEfficiencyPct, 25);
    assert.equal(w.securityAndTenantIsolationPct, 20);
    assert.equal(w.maintainabilityAndIntegrationPct, 15);
    assert.equal(w.authoringModelAlignmentPct, 10);

    const sum =
      w.correctnessAndDeterminismPct +
      w.cpuCostAndEfficiencyPct +
      w.securityAndTenantIsolationPct +
      w.maintainabilityAndIntegrationPct +
      w.authoringModelAlignmentPct;
    assert.equal(sum, 100);
  });

  await t.test('3. Ranking & Selection Constraint: selects at most ONE initial optional adapter', () => {
    const report = EngineSpikeEvaluator.runComparison();

    // Must select exactly one
    assert.equal(report.selectedCount, 1);
    assert.equal(report.selectedInitialOptionalAdapter, 'videoflow');

    // Winner score must be highest
    const topEngine = report.engines[0];
    assert.equal(topEngine.engine, 'videoflow');
    assert.equal(topEngine.adrVerdict, 'selected');
    assert.ok(topEngine.scores.totalScore > 90);

    // Revideo and Motion Canvas must be deferred
    const revideo = report.engines.find((e) => e.engine === 'revideo');
    assert.ok(revideo);
    assert.equal(revideo.adrVerdict, 'deferred');

    const mc = report.engines.find((e) => e.engine === 'motion-canvas');
    assert.ok(mc);
    assert.equal(mc.adrVerdict, 'deferred');

    // PixiJS must be rejected
    const pixi = report.engines.find((e) => e.engine === 'pixijs');
    assert.ok(pixi);
    assert.equal(pixi.adrVerdict, 'rejected');
  });

  await t.test('4. License Audit: clean permissive root licenses with zero copyleft risk', () => {
    const engines = ['videoflow', 'revideo', 'motion-canvas', 'pixijs'];
    for (const engine of engines) {
      const audit = EngineSpikeEvaluator.getLicenseAudit(engine);
      assert.ok(audit, `Missing license audit for ${engine}`);
      assert.ok(['Apache-2.0', 'MIT'].includes(audit.rootLicenseSpdx));
      assert.equal(audit.copyleftContaminationRisk, 'none');
      assert.equal(audit.commercialUseApproved, true);
    }
  });

  await t.test('5. Security Audit: declarative safety vs arbitrary code execution threat vectors', () => {
    // VideoFlow: safe declarative JSON
    const vfSecurity = EngineSpikeEvaluator.getSecurityAudit('videoflow');
    assert.equal(vfSecurity.rating, 'SAFE_DECLARATIVE');
    assert.equal(vfSecurity.arbitraryCodeExecutionRisk, false);
    assert.equal(vfSecurity.requiresMicroVmIsolation, false);
    assert.equal(vfSecurity.webglShaderJitAttackSurface, false);

    // Revideo & Motion Canvas: untrusted procedural code requires MicroVM (P7 boundary)
    const revideoSecurity = EngineSpikeEvaluator.getSecurityAudit('revideo');
    assert.equal(revideoSecurity.rating, 'HIGH_ISOLATION_REQUIRED');
    assert.equal(revideoSecurity.arbitraryCodeExecutionRisk, true);
    assert.equal(revideoSecurity.requiresMicroVmIsolation, true);

    const mcSecurity = EngineSpikeEvaluator.getSecurityAudit('motion-canvas');
    assert.equal(mcSecurity.rating, 'HIGH_ISOLATION_REQUIRED');
    assert.equal(mcSecurity.arbitraryCodeExecutionRisk, true);
    assert.equal(mcSecurity.requiresMicroVmIsolation, true);

    // PixiJS: WebGL context / shader JIT attack surface
    const pixiSecurity = EngineSpikeEvaluator.getSecurityAudit('pixijs');
    assert.equal(pixiSecurity.rating, 'HIGH_CRASH_RISK');
    assert.equal(pixiSecurity.webglShaderJitAttackSurface, true);
  });

  await t.test('6. Pure CPU Benchmarks: zero physical GPU requirement & software rasterization impact', () => {
    // All benchmark entries must have physicalGpuRequired: false
    for (const benchmark of CPU_BENCHMARK_SUITE) {
      assert.equal(
        benchmark.physicalGpuRequired,
        false,
        `Benchmark ${benchmark.engine} on ${benchmark.fixtureName} must not require physical GPU`
      );
    }

    // VideoFlow pure-CPU DOM achieves fastest average RTF
    const vfBenchmarks = EngineSpikeEvaluator.getBenchmarks('videoflow');
    assert.equal(vfBenchmarks.length, 3);
    const vfAvgRtf = vfBenchmarks.reduce((acc, b) => acc + b.rtf, 0) / vfBenchmarks.length;
    assert.ok(vfAvgRtf < 1.5, `VideoFlow RTF should be < 1.5x (got ${vfAvgRtf})`);

    // PixiJS SwiftShader software rasterizer shows severe CPU penalty
    const pixiBenchmarks = EngineSpikeEvaluator.getBenchmarks('pixijs');
    assert.equal(pixiBenchmarks.length, 3);
    const pixiAvgRtf = pixiBenchmarks.reduce((acc, b) => acc + b.rtf, 0) / pixiBenchmarks.length;
    assert.ok(pixiAvgRtf > 4.0, `PixiJS SwiftShader RTF should be > 4.0x (got ${pixiAvgRtf})`);

    const pixiAvgRss = pixiBenchmarks.reduce((acc, b) => acc + b.peakRssMib, 0) / pixiBenchmarks.length;
    assert.ok(pixiAvgRss > 500, `PixiJS peak RSS should exceed 500 MiB (got ${pixiAvgRss})`);
  });
});
