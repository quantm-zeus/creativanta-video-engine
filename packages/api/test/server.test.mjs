import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvConfig } from '@creativanta/contracts';
import { createServer } from '../dist/server.js';

describe('API Server Health & Capabilities', () => {
  let server;
  let baseUrl;

  before(async () => {
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });
    server = createServer({ config });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  });

  it('responds with 200 OK on /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'creativanta-video-engine-api');
    assert.strictEqual(body.environment, 'development');
    assert.ok(typeof body.uptime_seconds === 'number');
  });

  it('responds with 200 OK on /readyz', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.checks.database, 'ok');
    assert.strictEqual(body.checks.storage, 'ok');
  });

  it('responds with 200 OK on /v1/capabilities matching API spec', async () => {
    const res = await fetch(`${baseUrl}/v1/capabilities`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.api_version, '1.0.0');
    assert.deepStrictEqual(body.scene_schema_versions, ['1.0']);
    assert.strictEqual(body.engines['html-v1'], true);
    assert.strictEqual(body.engines['canvas-v1'], true);
    assert.strictEqual(body.engines['svg-v1'], true);
    assert.strictEqual(body.engines['custom-html-v1'], false);
    assert.strictEqual(body.profiles['mp4-720p-v1'].supported, true);
    assert.strictEqual(body.features.custom_code, false);
    assert.strictEqual(body.features.remote_import, false);
    assert.strictEqual(body.limits.max_upload_bytes, 104857600);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });
});
