#!/usr/bin/env node
/**
 * CLI Runner for `@creativanta/custom-runtime` Self-Test & Evidence Generator (Task P7-01).
 */

import fs from 'node:fs';
import path from 'node:path';
import { runCustomRuntimeSelfTest } from './disposable-microvm-runtime.mjs';
import { CUSTOM_RUNTIME_ADR_0002 } from './adr-policy.mjs';

async function main() {
  const args = process.argv.slice(2);
  const writeEvidenceIdx = args.indexOf('--write-evidence');
  const writeEvidenceDir =
    writeEvidenceIdx !== -1 && args[writeEvidenceIdx + 1]
      ? path.resolve(args[writeEvidenceIdx + 1])
      : null;

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
