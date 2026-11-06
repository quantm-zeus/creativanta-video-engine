import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import { createServer } from '../dist/server.js';
import { TenantConnectionPool } from '../dist/db/tenant-pool.js';
import { TenantRepository } from '../dist/db/repository.js';

describe('Live dependency readiness gates', () => {
  let db;
  let server;
  let baseUrl;
  let checkState = { database: true, storage: true, renderer: true };
  let shouldThrow = false;
  let probes = 0;

  before(async () => {
    db = new DatabaseSync(':memory:');
    const repository = new TenantRepository(new TenantConnectionPool(db), {
      pepper: 'isolated-readiness-test-pepper-not-a-production-secret',
    });
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });
    server = createServer({
      config,
      repository,
      readinessProbe: () => {
        probes++;
        if (shouldThrow) throw new Error('confidential-probe-error-should-not-leak');
        return {
          database: db.prepare('SELECT 1 AS ok').get().ok === 1 && checkState.database,
          storage: checkState.storage,
          renderer: checkState.renderer,
        };
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  it('reports 200 only after all three dependency checks succeed', async () => {
    const res = await fetch(baseUrl + '/readyz');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.deepEqual(body.checks, { database: 'ok', storage: 'ok', renderer: 'ok' });
    assert.ok(probes >= 1);
  });

  it('reports 503 if ANY dependency is unavailable', async () => {
    for (const key of ['database', 'storage', 'renderer']) {
      checkState = { database: true, storage: true, renderer: true };
      checkState[key] = false;
      const res = await fetch(baseUrl + '/readyz');
      assert.equal(res.status, 503, 'unavailable dependency: ' + key);
      const body = await res.json();
      assert.equal(body.status, 'not_ready');
      assert.equal(body.reason, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(body.checks[key], 'unavailable');
    }
    checkState = { database: true, storage: true, renderer: true };
  });

  it('does not leak sensitive details from thrown dependency probes', async () => {
    shouldThrow = true;
    try {
      const res = await fetch(baseUrl + '/readyz');
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.reason, 'READINESS_PROBE_FAILED');
      assert.equal(body.status, 'not_ready');
      assert.equal(JSON.stringify(body).includes('confidential-probe-error'), false);
    } finally {
      shouldThrow = false;
    }
  });
});

it('cannot report ready without a configured repository, even with a bogus all-green probe', async () => {
  const config = loadEnvConfig({
    CVE_ENV: 'development',
    CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
  });
  const server = createServer({
    config,
    readinessProbe: () => ({ database: true, storage: true, renderer: true }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + server.address().port + '/readyz');
    assert.equal(res.status, 503);
    assert.equal((await res.json()).reason, 'TENANT_REPOSITORY_NOT_CONFIGURED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
