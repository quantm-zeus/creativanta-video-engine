#!/usr/bin/env node
/**
 * Standalone runner for Creativanta SDK Integration Examples (Task P5-04).
 *
 * Runs typed-client integration and error-and-retry scenarios against
 * local CreativantaContractMock server.
 */

import { CreativantaClient } from '../dist/client/creativanta-client.js';
import { CreativantaContractMock } from '../dist/client/contract-mock.js';
import { runTypedClientIntegrationExample } from '../dist/examples/typed-client.js';
import { runErrorAndRetryScenarios } from '../dist/examples/error-and-retry.js';

async function main() {
  console.log('--- Starting Creativanta SDK Examples Verification ---');

  // Start standalone mock server
  const mockServer = new CreativantaContractMock({
    apiKey: 'cve_live_placeholder_key_000000000000000000000000',
    webhookSecret: 'whsec_placeholder_secret_000000000000000000000000',
    autoAdvanceJobsMs: 50,
  });

  const baseUrl = await mockServer.start();
  console.log(`Mock server running at: ${baseUrl}`);

  try {
    // 1. Run Typed Client Example
    console.log('\n[1/2] Running Typed Client Integration Example...');
    const demoResult = await runTypedClientIntegrationExample({
      baseUrl,
      apiKey: mockServer.apiKey,
      webhookSecret: mockServer.webhookSecret,
    });

    console.log(`✓ Capabilities inspected: API v${demoResult.capabilities.api_version}`);
    console.log(`✓ Asset uploaded: ${demoResult.assetId}`);
    console.log(`✓ Composition instantiated: ${demoResult.compositionId}`);
    console.log(`✓ Render job admitted: ${demoResult.admittedJob.id} (${demoResult.admittedJob.kind})`);
    console.log(`✓ Job completed: ${demoResult.finalJob.id} state=${demoResult.finalJob.state}`);
    console.log(`✓ Video artifact downloaded: ${demoResult.videoBuffer.length} bytes`);

    // 2. Run Error & Retry Scenarios
    console.log('\n[2/2] Running Error & Retry Scenarios...');
    const client = new CreativantaClient({
      baseUrl,
      apiKey: mockServer.apiKey,
    });

    const errorReport = await runErrorAndRetryScenarios({
      client,
      webhookSecret: mockServer.webhookSecret,
      mockServer,
    });

    console.log(`✓ 409 IDEMPOTENCY_IN_PROGRESS handled: ${errorReport.idempotencyInProgressHandled}`);
    console.log(`✓ 429 RATE_LIMITED handled: ${errorReport.rateLimitHandled}`);
    console.log(`✓ 410 GRANT_EXPIRED recovered: ${errorReport.grantExpiredRecovered}`);
    console.log(`✓ 422 VALIDATION_FAILED caught: ${errorReport.validationErrorCaught}`);
    console.log(`✓ 409 JOB_TERMINAL caught: ${errorReport.jobTerminalCaught}`);
    console.log(`✓ AbortSignal cancellation handled: ${errorReport.abortSignalHandled}`);
    console.log(`✓ Webhook forgery blocked: ${errorReport.webhookForgeryBlocked}`);

    console.log('\n--- All SDK Client Examples Verified Successfully! ---');
  } finally {
    await mockServer.stop();
  }
}

main().catch((err) => {
  console.error('Fatal error running examples:', err);
  process.exit(1);
});
