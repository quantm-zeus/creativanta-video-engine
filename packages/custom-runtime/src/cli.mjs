#!/usr/bin/env node
/**
 * CLI Runner for `@creativanta/custom-runtime` Self-Test & Evidence Generator (Tasks P7-01, P7-02, P7-03, P7-04 & P7-05).
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCustomRuntimeSelfTest } from './disposable-microvm-runtime.mjs';
import { runSceneBundleRegistrySelfTest } from './scene-bundle-registry.mjs';
import { runAuthoringAdapterSelfTest } from './authoring-job-manager.mjs';
import { runP704IsolatedBuildAndSecuritySelfTest } from './malicious-payload-suite.mjs';
import { runP705SecurityReviewSelfTest } from './c1-c6-security-review.mjs';
import { runP706CustomSceneVariantsSelfTest } from './variant-authoring-and-approval.mjs';
import { CUSTOM_RUNTIME_ADR_0002 } from './adr-policy.mjs';
import { getSceneBundleOpenApiSpec } from './scene-bundle-openapi.mjs';
import { getAuthoringOpenApiSpec } from './authoring-openapi.mjs';

async function main() {
  const args = process.argv.slice(2);
  const writeEvidenceIdx = args.indexOf('--write-evidence');
  const writeEvidenceDir =
    writeEvidenceIdx !== -1 && args[writeEvidenceIdx + 1]
      ? path.resolve(args[writeEvidenceIdx + 1])
      : null;

  const taskIdx = args.indexOf('--task');
  const targetTask = taskIdx !== -1 && args[taskIdx + 1] ? args[taskIdx + 1].toUpperCase() : null;

  // Infer task from writeEvidenceDir if not explicitly specified
  const isP706 = targetTask === 'P7-06' || (writeEvidenceDir && writeEvidenceDir.includes('P7-06'));
  const isP705 = targetTask === 'P7-05' || (writeEvidenceDir && writeEvidenceDir.includes('P7-05'));
  const isP704 = targetTask === 'P7-04' || (writeEvidenceDir && writeEvidenceDir.includes('P7-04'));
  const isP703 = targetTask === 'P7-03' || (writeEvidenceDir && writeEvidenceDir.includes('P7-03'));
  const isP702 = targetTask === 'P7-02' || (writeEvidenceDir && writeEvidenceDir.includes('P7-02'));

  if (isP706) {
    const report = await runP706CustomSceneVariantsSelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'custom-scene-variants-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(report, null, 2) + '\n',
        'utf-8',
      );

      if (report.variantsManifest) {
        const manifestPath = path.join(writeEvidenceDir, 'variants-manifest.json');
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(report.variantsManifest, null, 2) + '\n',
          'utf-8',
        );
      }

      if (report.costSummary) {
        const costPath = path.join(writeEvidenceDir, 'cost-model-summary.json');
        fs.writeFileSync(
          costPath,
          JSON.stringify(report.costSummary, null, 2) + '\n',
          'utf-8',
        );
      }

      if (report.approvedComposition) {
        const compPath = path.join(writeEvidenceDir, 'approved-scene-composition.json');
        fs.writeFileSync(
          compPath,
          JSON.stringify(report.approvedComposition, null, 2) + '\n',
          'utf-8',
        );
      }
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  } else if (isP705) {
    const report = await runP705SecurityReviewSelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'c1-c6-security-review-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(report, null, 2) + '\n',
        'utf-8',
      );

      if (report.signedReviewPacket) {
        const attestationPath = path.join(writeEvidenceDir, 'c1-c6-signed-attestation.json');
        fs.writeFileSync(
          attestationPath,
          JSON.stringify(report.signedReviewPacket, null, 2) + '\n',
          'utf-8',
        );
      }
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  } else if (isP704) {
    const report = await runP704IsolatedBuildAndSecuritySelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'isolated-build-and-security-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(report, null, 2) + '\n',
        'utf-8',
      );
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  } else if (isP703) {
    const report = await runAuthoringAdapterSelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'authoring-adapter-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(
          {
            ...report,
            openApiSummary: {
              version: '3.1.0',
              routesCount: 5,
              specification: getAuthoringOpenApiSpec(),
            },
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );

      const openApiPath = path.join(writeEvidenceDir, 'authoring-openapi.json');
      fs.writeFileSync(
        openApiPath,
        JSON.stringify(getAuthoringOpenApiSpec(), null, 2) + '\n',
        'utf-8',
      );
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  } else if (isP702) {
    const report = await runSceneBundleRegistrySelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'scene-bundle-registry-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(
          {
            ...report,
            openApiSummary: {
              version: '3.1.0',
              routesCount: 10,
              specification: getSceneBundleOpenApiSpec(),
            },
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  } else {
    const report = await runCustomRuntimeSelfTest();

    if (writeEvidenceDir) {
      fs.mkdirSync(writeEvidenceDir, { recursive: true });
      const auditPath = path.join(writeEvidenceDir, 'microvm-runtime-audit.json');
      fs.writeFileSync(
        auditPath,
        JSON.stringify(
          {
            ...report,
            adrSpecification: CUSTOM_RUNTIME_ADR_0002,
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
    }

    console.log(JSON.stringify(report, null, 2));
    process.exit(report.status === 'PASS' ? 0 : 1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
