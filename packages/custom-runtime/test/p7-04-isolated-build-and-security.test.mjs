// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPROVED_IMPORT_PACKAGES_REGISTRY,
  APPROVED_PREINSTALLED_SCENE_IMPORTS,
  AuthoringJobManager,
  CustomRuntimeError,
  DEFAULT_P704_CANARY_SECRET,
  IsolatedSceneBuildPipeline,
  IsolatedScenePreviewEngine,
  MALICIOUS_PAYLOAD_CORPUS,
  SceneBundleRegistry,
  assertNoTrustedApiExecution,
  getApprovedImportPackage,
  getTrustedApiExecutionAudit,
  listApprovedImportPackages,
  parseStaticModuleImports,
  resetTrustedApiExecutionAudit,
  runDeepStaticSecurityScan,
  runMaliciousPayloadSuite,
  runP704IsolatedBuildAndSecuritySelfTest,
  validateSceneModuleImports,
  verifyApprovedImportsRegistryIntegrity,
  verifySourceInjectionCannotReadCanarySecrets,
} from '../index.mjs';

describe('P7-04: Approved Pre-installed Imports Registry & Static Dependency Graph', () => {
  it('verifies all 3 pre-installed approved packages, their versions, exports, and SHA-256 digests', () => {
    const check = verifyApprovedImportsRegistryIntegrity();
    assert.equal(check.verified, true);
    assert.equal(check.packageCount, 3);

    const packages = listApprovedImportPackages();
    const names = packages.map((p) => p.packageName);
    assert.deepEqual(names, [...APPROVED_PREINSTALLED_SCENE_IMPORTS]);

    const mathPkg = getApprovedImportPackage('@creativanta/scene-math');
    assert.ok(mathPkg);
    assert.equal(mathPkg.version, '1.0.0');
    assert.ok(mathPkg.exports.includes('clamp'));
    assert.ok(mathPkg.exports.includes('lerp'));
    assert.equal(mathPkg.sha256.length, 64);

    const easingPkg = getApprovedImportPackage('@creativanta/scene-easing');
    assert.ok(easingPkg);
    assert.ok(easingPkg.exports.includes('easeOutCubic'));
    assert.ok(easingPkg.exports.includes('spring'));

    const runtimePkg = getApprovedImportPackage('@creativanta/scene-runtime');
    assert.ok(runtimePkg);
    assert.ok(runtimePkg.exports.includes('createSceneContext'));
    assert.ok(runtimePkg.exports.includes('createSeededRandom'));

    assert.equal(getApprovedImportPackage('axios'), null);
  });

  it('parses static ESM imports and validates approved packages, exported symbols, and relative modules', () => {
    const parsed = parseStaticModuleImports(
      'import { clamp, lerp as mix } from "@creativanta/scene-math";\nimport * as easing from "@creativanta/scene-easing";\nimport renderHelper from "./utils/helper.js";',
    );
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0].namedImports, ['clamp', 'lerp']);
    assert.equal(parsed[1].namespaceImport, 'easing');
    assert.equal(parsed[2].defaultImport, 'renderHelper');

    const validGraph = validateSceneModuleImports([
      {
        relativePath: 'index.js',
        content:
          'import { clamp } from "@creativanta/scene-math";\nimport { fmt } from "./utils/helper.js";\nexport default function(v) { return fmt(clamp(v, 0, 1)); }',
      },
      {
        relativePath: 'utils/helper.js',
        content: 'export function fmt(x) { return Number(x).toFixed(2); }',
      },
    ]);
    assert.equal(validGraph.valid, true);
    assert.equal(validGraph.resolvedImports.length, 2);
  });

  it('rejects unapproved packages, unexported symbols, missing relative targets, and circular imports', () => {
    // 1. Unexported symbol from approved package
    const badSymbol = validateSceneModuleImports([
      {
        relativePath: 'index.js',
        content: 'import { clamp, nonExistentExec } from "@creativanta/scene-math";',
      },
    ]);
    assert.equal(badSymbol.valid, false);
    assert.equal(badSymbol.violations[0].ruleId, 'UNEXPORTED_PACKAGE_SYMBOL');

    // 2. Missing relative target
    const missingRel = validateSceneModuleImports([
      {
        relativePath: 'index.js',
        content: 'import { x } from "./missing-module.js";',
      },
    ]);
    assert.equal(missingRel.valid, false);
    assert.equal(missingRel.violations[0].ruleId, 'MISSING_RELATIVE_IMPORT_TARGET');

    // 3. Circular relative imports
    const circular = validateSceneModuleImports([
      { relativePath: 'a.js', content: 'import { b } from "./b.js"; export const a = b;' },
      { relativePath: 'b.js', content: 'import { a } from "./a.js"; export const b = a;' },
    ]);
    assert.equal(circular.valid, false);
    assert.ok(circular.violations.some((v) => v.ruleId === 'CIRCULAR_IMPORT_DETECTED'));
  });
});

describe('P7-04: Isolated Scene Build Pipeline in Disposable build-vm', () => {
  it('compiles multi-file scene with approved imports inside disposable build-vm and wipes prison', async () => {
    const pipeline = new IsolatedSceneBuildPipeline();
    try {
      const buildRes = await pipeline.buildSceneBundle({
        bundleId: 'bnd_test_build_01',
        revision: 1,
        entrypoint: 'index.js',
        sourceFiles: [
          {
            relativePath: 'index.js',
            content: [
              'import { createSceneContext } from "@creativanta/scene-runtime";',
              'import { clamp } from "@creativanta/scene-math";',
              'import { easeOutCubic } from "@creativanta/scene-easing";',
              'import { labelText } from "./sub/text.js";',
              'export default function renderFrame(f) {',
              '  const ctx = createSceneContext({ frameIndex: f });',
              '  return { text: labelText, alpha: easeOutCubic(clamp(ctx.progress, 0, 1)) };',
              '}',
            ].join('\n'),
          },
          {
            relativePath: 'sub/text.js',
            content: 'export const labelText = "Khuyến mãi Mùa Thu 2026";\n',
          },
        ],
        securitySelfTestMode: true,
      });

      assert.equal(buildRes.sourceSha256.length, 64);
      assert.equal(buildRes.buildSha256.length, 64);
      assert.match(buildRes.cspScriptHash, /^'sha256-[A-Za-z0-9+/=]+'$/);
      assert.match(buildRes.cspHeader, /connect-src 'none'/);
      assert.equal(buildRes.resolvedImports.length, 4);
      assert.equal(buildRes.canaryPresentInBuildVm, false);
      assert.equal(buildRes.trustedApiExecuted, false);

      const att = buildRes.buildMicroVmInstance.getAttestation();
      assert.equal(att.destroyed, true);
      assert.equal(att.prisonWiped, true);
      assert.equal(att.networkInterfacesCount, 0);
    } finally {
      pipeline.runtime.cleanupBaseDir();
    }
  });

  it('produces byte-identical sourceSha256, buildSha256, and cspScriptHash regardless of input file order', async () => {
    const pipeline = new IsolatedSceneBuildPipeline();
    try {
      const fileA = {
        relativePath: 'index.js',
        content: 'import { k } from "./constants.js";\nexport default function() { return k; }\n',
      };
      const fileB = {
        relativePath: 'constants.js',
        content: 'import { clamp } from "@creativanta/scene-math";\nexport const k = clamp(10, 0, 5);\n',
      };

      const res1 = await pipeline.buildSceneBundle({
        bundleId: 'bnd_det',
        revision: 1,
        entrypoint: 'index.js',
        sourceFiles: [fileA, fileB],
        securitySelfTestMode: true,
      });
      const res2 = await pipeline.buildSceneBundle({
        bundleId: 'bnd_det',
        revision: 1,
        entrypoint: 'index.js',
        sourceFiles: [fileB, fileA],
        securitySelfTestMode: true,
      });

      assert.equal(res1.sourceSha256, res2.sourceSha256);
      assert.equal(res1.buildSha256, res2.buildSha256);
      assert.equal(res1.cspScriptHash, res2.cspScriptHash);
      assert.equal(Buffer.compare(res1.compiledBytes, res2.compiledBytes), 0);
    } finally {
      pipeline.runtime.cleanupBaseDir();
    }
  });
});

describe('P7-04: Deep Static Security Scanner (Obfuscation, Constructor Escape & DOM Guards)', () => {
  it('blocks constructor chain escapes, bracket obfuscation, prototype mutation, /proc/self/environ, and package.json hooks', () => {
    const forbiddenCases = [
      {
        name: 'constructor_chain',
        files: [{ relativePath: 'index.js', content: '({}).constructor.constructor("return process")();' }],
      },
      {
        name: 'bracket_concat_global',
        files: [{ relativePath: 'index.js', content: 'globalThis["ev" + "al"]("1");' }],
      },
      {
        name: 'unicode_escaped_eval',
        files: [{ relativePath: 'index.js', content: 'const f = "\\u0065\\u0076\\u0061\\u006c";' }],
      },
      {
        name: 'proto_mutation',
        files: [{ relativePath: 'index.js', content: 'const o = {}; o.__proto__.x = 1;' }],
      },
      {
        name: 'proc_self_environ',
        files: [{ relativePath: 'index.js', content: 'export const p = "/proc/self/environ";' }],
      },
      {
        name: 'package_json_unapproved_dependency',
        files: [
          { relativePath: 'index.js', content: 'export const a = 1;' },
          {
            relativePath: 'package.json',
            content: JSON.stringify({ name: 'scene', dependencies: { lodash: '^4.17.21' } }),
          },
        ],
      },
      {
        name: 'unsafe_html_iframe_and_onload',
        files: [
          {
            relativePath: 'index.html',
            content: '<body onload="alert(1)"><iframe src="about:blank"></iframe></body>',
          },
        ],
      },
    ];

    for (const item of forbiddenCases) {
      assert.throws(
        () => runDeepStaticSecurityScan(item.files),
        (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
        `Expected ${item.name} to be rejected by runDeepStaticSecurityScan`,
      );
    }
  });
});

describe('P7-04: Isolated Frame/Clip Previews (preview-360p-v1) & No Raw HTML Origin', () => {
  it('renders frame (PNG 640x360) and clip (MP4 360x640) previews in disposable render-vm and blocks raw HTML origin', async () => {
    const buildPipeline = new IsolatedSceneBuildPipeline();
    const previewEngine = new IsolatedScenePreviewEngine({ runtime: buildPipeline.runtime });

    try {
      const compiled = await buildPipeline.buildSceneBundle({
        bundleId: 'bnd_preview_test',
        revision: 1,
        entrypoint: 'index.js',
        sourceFiles: [
          {
            relativePath: 'index.js',
            content:
              'import { clamp } from "@creativanta/scene-math";\nexport default function renderFrame(f) { return clamp(f, 0, 300); }\n',
          },
        ],
        securitySelfTestMode: true,
      });

      // 1. Frame preview on 1280x720 -> 640x360 PNG
      const framePreview = await previewEngine.renderIsolatedPreview({
        tenantId: 'tnt_preview_owner',
        compiledBundle: compiled,
        mode: 'frame',
        profile: 'preview-360p-v1',
        canvas: { width: 1280, height: 720 },
        fps: 30,
        totalFrames: 300,
        frameIndex: 90,
        securitySelfTestMode: true,
      });

      assert.equal(framePreview.format, 'png');
      assert.equal(framePreview.mimeType, 'image/png');
      assert.deepEqual(framePreview.outputDimensions, { width: 640, height: 360 });
      assert.equal(framePreview.artifactBytes.readUInt32BE(16), 640);
      assert.equal(framePreview.artifactBytes.readUInt32BE(20), 360);
      assert.equal(framePreview.rawCustomHtmlOriginServed, false);
      assert.equal(framePreview.renderVmAttestation.destroyed, true);

      // 2. Clip preview on 720x1280 -> 360x640 MP4
      const clipPreview = await previewEngine.renderIsolatedPreview({
        tenantId: 'tnt_preview_owner',
        compiledBundle: compiled,
        mode: 'clip',
        profile: 'preview-360p-v1',
        canvas: { width: 720, height: 1280 },
        fps: 30,
        totalFrames: 300,
        startFrame: 30,
        durationFrames: 90,
        securitySelfTestMode: true,
      });

      assert.equal(clipPreview.format, 'mp4');
      assert.equal(clipPreview.mimeType, 'video/mp4');
      assert.deepEqual(clipPreview.outputDimensions, { width: 360, height: 640 });
      assert.deepEqual(clipPreview.sourceFrameRange, [30, 120]);
      assert.equal(clipPreview.exportStartTimestampSeconds, 0);

      // 3. Reject out-of-bounds frame_index or clip range with VALIDATION_FAILED (no silent clamping)
      await assert.rejects(
        () =>
          previewEngine.renderIsolatedPreview({
            tenantId: 'tnt_preview_owner',
            compiledBundle: compiled,
            mode: 'frame',
            totalFrames: 300,
            frameIndex: 300,
            securitySelfTestMode: true,
          }),
        (err) => err instanceof CustomRuntimeError && err.code === 'VALIDATION_FAILED',
      );

      // 4. Block raw custom HTML preview origin
      await assert.rejects(
        () =>
          previewEngine.renderIsolatedPreview({
            tenantId: 'tnt_preview_owner',
            compiledBundle: compiled,
            mode: 'frame',
            frameIndex: 0,
            outputOrigin: 'raw-html',
            securitySelfTestMode: true,
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === 'RAW_HTML_PREVIEW_ORIGIN_FORBIDDEN',
      );

      // 5. Tenant-scoped download grant & 404 IDOR protection
      const grant = previewEngine.createPreviewDownloadGrant(
        'tnt_preview_owner',
        framePreview.previewId,
        { ttlSeconds: 300 },
      );
      assert.equal(grant.ttlSeconds, 300);
      assert.equal(grant.rawCustomHtmlOrigin, false);
      assert.equal(grant.securityHeaders['X-Content-Type-Options'], 'nosniff');

      assert.throws(
        () => previewEngine.createPreviewDownloadGrant('tnt_foreign_tenant', framePreview.previewId),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.code === 'PREVIEW_NOT_FOUND' &&
          err.details?.statusCode === 404,
      );
    } finally {
      buildPipeline.runtime.cleanupBaseDir();
    }
  });
});

describe('P7-04: Malicious Payload Suite, Canary Non-Exfiltration & No Trusted API Execution', () => {
  it('blocks all 24 payloads in MALICIOUS_PAYLOAD_CORPUS + runtime prison suite', async () => {
    assert.equal(MALICIOUS_PAYLOAD_CORPUS.length, 22);
    const report = await runMaliciousPayloadSuite({
      canarySecret: DEFAULT_P704_CANARY_SECRET,
    });
    assert.equal(report.passed, true);
    assert.equal(report.totalPayloads, 24);
    assert.equal(report.blockedPayloads, 24);
    assert.equal(report.trustedApiExecutionsCount, 0);
  });

  it('proves source injection and prompt injection cannot read canary secrets', async () => {
    const proof = await verifySourceInjectionCannotReadCanarySecrets({
      canarySecret: 'CANARY_P704_UNIT_TEST_SECRET_TOKEN_112233445566',
    });
    assert.equal(proof.verified, true);
    assert.equal(proof.vectorsTestedCount, 4);
    assert.equal(proof.canaryPresentInBuildVm, false);
    assert.equal(proof.canaryPresentInRenderVm, false);
    assert.equal(proof.canaryLeakedInArtifactsOrLogs, false);
    assert.equal(proof.trustedApiExecutionsCount, 0);
  });

  it('enforces No Trusted API Execution guard and passes full 12-check P7-04 self-test suite', async () => {
    resetTrustedApiExecutionAudit();
    assert.throws(
      () => assertNoTrustedApiExecution('api-route', 'eval("1")'),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === 'TRUSTED_API_EXECUTION_FORBIDDEN',
    );
    assert.equal(getTrustedApiExecutionAudit().trustedApiExecutionsCount, 0);
    assert.equal(getTrustedApiExecutionAudit().blockedTrustedApiAttemptsCount, 1);

    const selfTestReport = await runP704IsolatedBuildAndSecuritySelfTest();
    assert.equal(selfTestReport.taskId, 'P7-04');
    assert.equal(selfTestReport.status, 'PASS');
    assert.equal(selfTestReport.totalChecks, 12);
    assert.equal(selfTestReport.passedChecks, 12);
    assert.equal(selfTestReport.failedChecks, 0);
    assert.equal(selfTestReport.trustedApiExecutionAudit.trustedApiExecutionsCount, 0);
  });
});
