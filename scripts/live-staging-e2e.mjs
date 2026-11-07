#!/usr/bin/env node
/**
 * Creativanta Video Engine — Operator CLI for Non-Mock Live Staging E2E Verification
 * Canonical specifications:
 *   - docs/TESTING.md (Non-mock E2E verification)
 *   - docs/SECURITY.md (Token protection, anti-IDOR, fail-closed guards)
 *   - docs/DEPLOYMENT.md (Staging verification harness)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import fs from 'node:fs';
import path from 'node:path';
import { LiveStagingE2EVerifier } from '../ops/staging/live-e2e.mjs';
import { RedactedLogger, redactObject, sanitizeUrl } from '../ops/staging/redaction.mjs';

function printHelp() {
  process.stdout.write(`
Creativanta Video Engine — Non-Mock Live Staging E2E Verifier

Usage:
  node scripts/live-staging-e2e.mjs [options]

Options:
  --endpoint <url>         Override target API base URL (must be loopback or private staging)
  --preflight-only         Run only the fail-closed preflight readiness check
  --write-evidence <dir>   Write structured results JSON to specified directory
  --json                   Output raw JSON to stdout instead of formatted log
  --help, -h               Show this help message

Environment Variables:
  CVE_STAGING_API_BASE_URL    Target API base URL (default: http://127.0.0.1:8080/v1)
  CVE_STAGING_API_KEY_A       Test API key for Tenant A
  CVE_STAGING_API_KEY_B       Test API key for Tenant B (for anti-IDOR tests)
  CVE_STAGING_WEBHOOK_SECRET  Signing secret for webhook verification
  CVE_STAGING_TIMEOUT_MS      Request timeout in milliseconds (default: 15000)

Exit Codes:
  0: All stages / checks PASSED
  2: System NOT READY (Preflight failed closed due to absent/offline dependencies)
  1: Fatal error or configuration security violation
`.trim() + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  let endpointOverride = null;
  let preflightOnly = false;
  let writeEvidenceDir = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--endpoint') {
      endpointOverride = args[++i];
    } else if (arg === '--preflight-only') {
      preflightOnly = true;
    } else if (arg === '--write-evidence') {
      writeEvidenceDir = args[++i];
    } else if (arg === '--json') {
      jsonOutput = true;
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      printHelp();
      process.exit(1);
    }
  }

  const logger = new RedactedLogger(process.stdout);

  const verifierOptions = {};
  if (endpointOverride) {
    verifierOptions.baseUrl = endpointOverride;
  }
  if (jsonOutput) {
    // Suppress verbose logger in JSON mode
    verifierOptions.logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      registerSecret: () => {},
    };
  }

  let result;
  try {
    const verifier = new LiveStagingE2EVerifier(verifierOptions);

    if (preflightOnly) {
      result = await verifier.runPreflight();
    } else {
      result = await verifier.run();
    }
  } catch (err) {
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ status: 'ERROR', error: err.message }, null, 2) + '\n');
    } else {
      logger.error(`Fatal execution error: ${err.message}`);
    }
    process.exit(1);
  }

  // Write evidence if requested
  if (writeEvidenceDir) {
    try {
      const resolvedDir = path.resolve(process.cwd(), writeEvidenceDir);
      if (!fs.existsSync(resolvedDir)) {
        fs.mkdirSync(resolvedDir, { recursive: true });
      }

      const filename = preflightOnly
        ? 'live-staging-preflight-result.json'
        : result.status === 'NOT_READY'
        ? 'live-staging-preflight-result.json'
        : 'live-staging-results.json';

      const filePath = path.join(resolvedDir, filename);
      const sanitizedResult = redactObject(result);
      fs.writeFileSync(filePath, JSON.stringify(sanitizedResult, null, 2) + '\n', 'utf8');

      if (!jsonOutput) {
        logger.info(`Evidence written to: ${filePath}`);
      }
    } catch (writeErr) {
      logger.error(`Failed to write evidence: ${writeErr.message}`);
    }
  }

  if (jsonOutput) {
    process.stdout.write(JSON.stringify(redactObject(result), null, 2) + '\n');
  } else {
    // Format human-readable output
    process.stdout.write('\n' + '='.repeat(70) + '\n');
    process.stdout.write('CREATIVANTA VIDEO ENGINE — LIVE STAGING VERIFICATION REPORT\n');
    process.stdout.write('='.repeat(70) + '\n');
    process.stdout.write(`Target Endpoint: ${result.targetUrl}\n`);
    process.stdout.write(`Result Status:   ${result.status}\n`);
    if (result.decision) {
      process.stdout.write(`Decision:        ${result.decision}\n`);
    }

    if (result.dependencies) {
      process.stdout.write('\nStructured Dependency Health:\n');
      process.stdout.write(`  API Service:   ${result.dependencies.api}\n`);
      process.stdout.write(`  Database:      ${result.dependencies.database}\n`);
      process.stdout.write(`  Object Store:  ${result.dependencies.storage}\n`);
      process.stdout.write(`  Renderer Node: ${result.dependencies.renderer}\n`);
    }

    if (result.blockers && result.blockers.length > 0) {
      process.stdout.write('\nIdentified Blockers / Missing Dependencies:\n');
      for (const blocker of result.blockers) {
        process.stdout.write(`  [!] ${blocker}\n`);
      }
    }

    if (result.stages && result.stages.length > 0) {
      process.stdout.write('\nExecuted Verification Stages:\n');
      for (const stage of result.stages) {
        const mark = stage.passed
          ? '[PASS]'
          : stage.status === 'BLOCKED'
          ? '[BLOCKED]'
          : '[FAIL]';
        process.stdout.write(`  ${mark} ${stage.id}: ${stage.title} (${stage.durationMs}ms)\n`);
        if (stage.error) {
          process.stdout.write(`         Error: ${stage.error}\n`);
        }
      }
    }

    process.stdout.write('\n' + '='.repeat(70) + '\n\n');
  }

  const passed = preflightOnly ? result.ready === true : result.status === 'PASS';
  if (passed) {
    process.exit(0);
  } else if (result.status === 'NOT_READY' || result.ready === false) {
    process.exit(2);
  } else {
    process.exit(1);
  }
}

main();
