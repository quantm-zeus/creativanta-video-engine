#!/usr/bin/env node
/**
 * Real child-process API startup verification on 127.0.0.1. NOT an E2E
 * deployment, and intentionally expects 503 while no database-backed
 * repository, object storage probe or renderer probe is wired to main().
 * No production credentials, remote egress or public listen addresses.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await reserveLoopbackPort();
const url = 'http://127.0.0.1:' + port;
const child = spawn(process.execPath, ['packages/api/dist/index.js'], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    CVE_ENV: 'development',
    CVE_PUBLIC_BASE_URL: url + '/v1',
    HOST: '127.0.0.1',
    CVE_CUSTOM_CODE_ENABLED: 'false',
    CVE_CUSTOM_RUNTIME: 'disabled',
    CVE_REMOTE_IMPORT_ENABLED: 'false',
    CVE_TTS_PROVIDER: 'disabled',
    CVE_AUTHORING_PROVIDER: 'disabled',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childExit = false;
let output = '';
child.on('exit', () => { childExit = true; });
child.stdout.on('data', (data) => { output = (output + String(data)).slice(-2000); });
child.stderr.on('data', (data) => { output = (output + String(data)).slice(-2000); });
child.on('error', (err) => { output = String(err.message).slice(-500); });

try {
  let alive = false;
  for (let i = 0; i < 80; i++) {
    if (childExit) throw new Error('API child process terminated before healthz');
    try {
      const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(300) });
      if (response.status === 200) {
        alive = true;
        break;
      }
    } catch {
      // Expected briefly while node starts.
    }
    await delay(100);
  }
  assert.equal(alive, true, 'real child process never exposed /healthz');
  const healthResponse = await fetch(url + '/healthz');
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');
  const readyResponse = await fetch(url + '/readyz');
  const ready = await readyResponse.json();
  assert.equal(readyResponse.status, 503);
  assert.equal(ready.reason, 'TENANT_REPOSITORY_NOT_CONFIGURED');
  assert.equal(ready.checks.database, 'unavailable');
  assert.equal(ready.checks.storage, 'unverified');
  assert.equal(ready.checks.renderer, 'unverified');
  const capabilitiesResponse = await fetch(url + '/v1/capabilities');
  const caps = await capabilitiesResponse.json();
  assert.equal(capabilitiesResponse.status, 200);
  assert.equal(caps.engines['custom-html-v1'], false);
  assert.equal(caps.features.remote_import, false);
  console.log(JSON.stringify({
    probe: 'API_REAL_PROCESS_LOOPBACK',
    result: 'PASS_FAIL_CLOSED',
    live_e2e: false,
    production_release_authorized: false,
    api_process_started: true,
    bind: '127.0.0.1',
    healthz: healthResponse.status,
    readyz: readyResponse.status,
    reason: ready.reason,
    custom_code_enabled: caps.engines['custom-html-v1'],
    remote_import_enabled: caps.features.remote_import,
    note: 'The real API process is NOT ready for authenticated jobs. Fix backend and external dependencies before release.',
  }, null, 2));
} catch (err) {
  console.error('API_REAL_PROCESS_LOOPBACK_FAIL:', err.message, output);
  process.exitCode = 1;
} finally {
  if (!childExit) child.kill('SIGTERM');
  for (let i = 0; i < 30 && !childExit; i++) {
    await delay(100);
  }
  if (!childExit) child.kill('SIGKILL');
}
