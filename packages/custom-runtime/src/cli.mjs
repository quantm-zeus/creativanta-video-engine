#!/usr/bin/env node
/**
 * CLI Runner for `@creativanta/custom-runtime` Self-Test & Evidence Generator (Tasks P7-01 & P7-02).
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCustomRuntimeSelfTest } from './disposable-microvm-runtime.mjs';
import { runSceneBundleRegistrySelfTest } from './scene-bundle-registry.mjs';
import { CUSTOM_RUNTIME_ADR_0002 } from './adr-policy.mjs';
import { getSceneBundleOpenApiSpec } from './scene-bundle-openapi.mjs';

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
  const isP702 = targetTask === 'P7-02' || (writeEvidenceDir && writeEvidenceDir.includes('P7-02'));

  if (isP702) {
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
