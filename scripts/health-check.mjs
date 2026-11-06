#!/usr/bin/env node
/**
 * Health check verification script for Creativanta Video Engine.
 * Verifies workspace packages, configuration validity, and API endpoints.
 */

import http from 'node:http';
import { loadEnvConfig, redactEnvConfig } from '../packages/contracts/dist/index.js';
import { createServer } from '../packages/api/dist/server.js';

async function main() {
  process.stdout.write('Checking Creativanta Video Engine workspace health...\n');
  const results = {
    timestamp: new Date().toISOString(),
    checks: [],
    status: 'PASS',
  };

  // 1. Check Environment Parser & Config Validation
  try {
    const config = loadEnvConfig();
    const redacted = redactEnvConfig(config);
    results.checks.push({
      name: 'env_configuration',
      status: 'PASS',
      environment: config.CVE_ENV,
      adapter: config.CVE_RENDERER_ADAPTER,
      redacted_config: redacted,
    });
  } catch (err) {
    results.status = 'FAIL';
    results.checks.push({
      name: 'env_configuration',
      status: 'FAIL',
      error: err.message,
    });
  }

  // 2. Test In-Memory API Health & Capabilities Endpoints
  try {
    const testConfig = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });
    const server = createServer({ config: testConfig });

    const port = await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject(new Error('Failed to bind server port'));
        }
      });
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // Probe /healthz
    const healthzRes = await fetch(`${baseUrl}/healthz`);
    if (!healthzRes.ok) throw new Error(`/healthz returned status ${healthzRes.status}`);
    const healthzData = await healthzRes.json();

    // An unbacked development server MUST reject readiness even when
    // liveness and capabilities endpoints work.
    const readyzRes = await fetch(baseUrl + '/readyz');
    const readyzData = await readyzRes.json();
    if (readyzRes.status !== 503 || readyzData.reason !== 'TENANT_REPOSITORY_NOT_CONFIGURED') {
      throw new Error('Unbacked /readyz must return 503; got ' + readyzRes.status);
    }

    // Probe /v1/capabilities
    const capsRes = await fetch(`${baseUrl}/v1/capabilities`);
    if (!capsRes.ok) throw new Error(`/v1/capabilities returned status ${capsRes.status}`);
    const capsData = await capsRes.json();

    await new Promise((resolve) => server.close(resolve));

    results.checks.push({
      name: 'unbacked_api_contract_not_live_readiness',
      status: 'PASS',
      healthz: healthzData,
      readyz: readyzData,
      note: 'Synthetic in-process API; live backend/worker readiness NOT verified',
      capabilities_engines: capsData.engines,
      capabilities_profiles: Object.keys(capsData.profiles),
    });
  } catch (err) {
    results.status = 'FAIL';
    results.checks.push({
      name: 'api_endpoints',
      status: 'FAIL',
      error: err.message,
    });
  }

  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  process.exit(results.status === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal health check error:', err);
  process.exit(1);
});
