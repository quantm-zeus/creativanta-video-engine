#!/usr/bin/env node
/**
 * Creativanta Video Engine — P6-04 Security Review CLI
 * Usage:
 *   node ops/security/security-cli.mjs [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { SecurityReviewRunner } from './security-review-runner.mjs';

async function main() {
  const runner = new SecurityReviewRunner();
  const report = await runner.runFullReview();

  const writeIdx = process.argv.indexOf('--write-evidence');
  if (writeIdx !== -1 && process.argv[writeIdx + 1]) {
    const outDir = path.resolve(process.argv[writeIdx + 1]);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify(
        {
          taskId: report.taskId,
          role: report.role,
          phase: report.phase,
          executedAt: report.executedAt,
          overallStatus: report.overallStatus,
          betaReleaseGateDecision: report.betaReleaseGateDecision,
          summary: report.summary,
          findings: report.findings,
          externalGates: report.externalGates,
        },
        null,
        2
      ) + '\n'
    );
    fs.writeFileSync(
      path.join(outDir, 'sbom-and-security-audit.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      `[P6-04 Security Review] Status=${report.overallStatus} Decision=${report.betaReleaseGateDecision} ` +
        `Suites=${report.summary.passedSuites}/${report.summary.totalSuites} ` +
        `Checks=${report.summary.passedChecks}/${report.summary.totalChecks} ` +
        `ResolvedFindings=${report.summary.findingsResolved}/${report.summary.findingsTotal} ` +
        `OpenCritical=${report.summary.openCriticalFindings}\n`
    );
  }

  process.exit(report.overallStatus === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal error in security-cli: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
