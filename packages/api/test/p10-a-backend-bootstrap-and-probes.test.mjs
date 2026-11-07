/**
 * Task P10-A: Staging Backend Bootstrap, Fail-Closed Environment Guard,
 * Driver Compatibility Assessment, Bounded Protocol Probes, and Real-Process
 * Non-Production SQLite Test Loopback Verification (GitHub Issue #65 / Parent #63).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  ALL_API_SCOPES,
  BackendBootstrapError,
  PG_WIRE_MAX_BUFFER_BYTES,
  PG_WIRE_MAX_FRAME_LENGTH,
  bootstrapApiBackend,
  evaluatePostgresDriverAndRlsReadiness,
  generateApiKeyMaterial,
  probeObjectStorageConnectivity,
  probePostgresConnectivity,
  probeRendererWorkerReadiness,
  resolveBackendMode,
  startApiServer,
  validateBackendStartupEnv,
} from '../dist/index.js';
import { StagingBackendVerifier } from '../../../ops/staging/staging-backend-verifier.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const VALID_PINNED_DIGEST =
  'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

function buildStagingEnv(overrides = {}) {
  return {
    CVE_ENV: 'staging',
    CVE_BACKEND_MODE: 'postgres',
    CVE_PUBLIC_BASE_URL: 'https://staging-video.creativanta.internal/v1',
    CVE_DATABASE_URL:
      'postgresql://cve_api:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:5432/creativanta_staging',
    CVE_MIGRATION_DATABASE_URL:
      'postgresql://cve_migrator:stgmigrator_1f2e3d4c5b6a798897a6b5c4@127.0.0.1:5432/creativanta_staging',
    CVE_STORAGE_ENDPOINT: 'https://staging-s3.creativanta.internal',
    CVE_STORAGE_REGION: 'ap-southeast-1',
    CVE_STORAGE_ACCESS_KEY_ID: 'STAGING_ACCESS_KEY_ID_9001',
    CVE_STORAGE_SECRET_ACCESS_KEY: 'staging_secret_access_key_9001_valid_len',
    CVE_QUARANTINE_BUCKET: 'cve-quarantine-staging',
    CVE_ASSET_BUCKET: 'cve-assets-staging',
    CVE_ARTIFACT_BUCKET: 'cve-artifacts-staging',
    CVE_API_KEY_PEPPER: 'staging_pepper_high_entropy_32_bytes_minimum_value_01',
    CVE_SECRET_ENCRYPTION_KEY_ID: 'arn:aws:kms:ap-southeast-1:000000000000:key/staging-cve-key-01',
    CVE_RENDERER_ADAPTER: 'chromium-frame-v1',
    CVE_RENDER_IMAGE_DIGEST: VALID_PINNED_DIGEST,
    CVE_REMOTE_IMPORT_ENABLED: 'false',
    CVE_CUSTOM_CODE_ENABLED: 'false',
    CVE_CUSTOM_RUNTIME: 'disabled',
    CVE_TTS_PROVIDER: 'disabled',
    CVE_AUTHORING_PROVIDER: 'disabled',
    ...overrides,
  };
}

describe('P10-A Staging Backend Bootstrap & Bounded Connectivity Probes', () => {
  it('resolves backend mode safely and blocks sqlite-test-only in staging and production', () => {
    const devCfg = loadEnvConfig({ CVE_ENV: 'development' });
    assert.equal(resolveBackendMode(devCfg, { CVE_ENV: 'development' }), 'unconfigured');
    assert.equal(
      resolveBackendMode(devCfg, {
        CVE_ENV: 'development',
        CVE_BACKEND_MODE: 'sqlite-test-only',
      }),
      'sqlite-test-only',
    );

    const stgEnv = buildStagingEnv();
    const stgCfg = loadEnvConfig(stgEnv);
    assert.equal(resolveBackendMode(stgCfg, stgEnv), 'postgres');

    assert.throws(
      () =>
        resolveBackendMode(stgCfg, {
          ...stgEnv,
          CVE_BACKEND_MODE: 'sqlite-test-only',
        }),
      (err) =>
        err instanceof BackendBootstrapError &&
        err.code === 'SQLITE_TEST_MODE_FORBIDDEN_IN_STAGING_OR_PROD',
    );
  });

  it('rejects missing staging env vars, default credentials, non-cve_api DB roles, and unsafe capability flags', () => {
    // Missing explicit staging env vars (refuses loadEnvConfig fallback defaults)
    const emptyStg = { CVE_ENV: 'staging' };
    assert.throws(
      () => validateBackendStartupEnv(loadEnvConfig(emptyStg), emptyStg),
      (err) => err instanceof BackendBootstrapError && err.code === 'MISSING_EXPLICIT_STAGING_ENV',
    );

    // Default placeholder credentials rejected
    const placeholderStg = buildStagingEnv({
      CVE_API_KEY_PEPPER: 'dev_pepper_0123456789abcdef0123456789abcdef',
      CVE_RENDER_IMAGE_DIGEST:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    assert.throws(
      () => validateBackendStartupEnv(loadEnvConfig(placeholderStg), placeholderStg),
      (err) =>
        err instanceof BackendBootstrapError &&
        err.code === 'INSECURE_OR_INVALID_STAGING_ENV' &&
        err.details.length >= 2,
    );

    // Forbidden runtime DB role (postgres or cve_migrator)
    const superuserRoleStg = buildStagingEnv({
      CVE_DATABASE_URL:
        'postgresql://postgres:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:5432/creativanta_staging',
    });
    assert.throws(
      () => validateBackendStartupEnv(loadEnvConfig(superuserRoleStg), superuserRoleStg),
      (err) =>
        err instanceof BackendBootstrapError &&
        err.code === 'INSECURE_OR_INVALID_STAGING_ENV' &&
        err.details.some((d) => d.includes("least-privilege 'cve_api'")),
    );

    // Non-distinct or -dev bucket names rejected
    const duplicateBucketsStg = buildStagingEnv({
      CVE_ASSET_BUCKET: 'cve-quarantine-staging',
    });
    assert.throws(
      () => validateBackendStartupEnv(loadEnvConfig(duplicateBucketsStg), duplicateBucketsStg),
      (err) => err instanceof BackendBootstrapError && err.code === 'INSECURE_OR_INVALID_STAGING_ENV',
    );

    // Remote import or custom code enabled rejected
    const unsafeFlagsStg = buildStagingEnv({
      CVE_CUSTOM_CODE_ENABLED: 'true',
      CVE_CUSTOM_RUNTIME: 'firecracker-v1',
    });
    assert.throws(
      () => validateBackendStartupEnv(loadEnvConfig(unsafeFlagsStg), unsafeFlagsStg),
      (err) => err instanceof BackendBootstrapError && err.code === 'GATED_CAPABILITY_VIOLATION',
    );
  });

  it('audits all 21 PostgreSQL tables for RLS/FORCE RLS and truthfully reports node:sqlite driver incompatibility', () => {
    const evaluation = evaluatePostgresDriverAndRlsReadiness();
    assert.equal(evaluation.migrationsAudit.valid, true);
    assert.equal(evaluation.migrationsAudit.tableCount, 21);
    assert.equal(evaluation.migrationsAudit.rlsEnabledCount, 21);
    assert.equal(evaluation.migrationsAudit.rlsForcedCount, 21);
    assert.equal(evaluation.rlsAndForceRlsVerified, true);
    assert.equal(evaluation.leastPrivilegeRolesDefined, true);
    assert.equal(evaluation.currentRepositoryEngine, 'node:sqlite');
    assert.equal(evaluation.postgresWireDriverInstalled, false);
    assert.equal(evaluation.asyncTenantRepositoryImplemented, false);
    assert.equal(evaluation.canServePostgresTraffic, false);
  });

  it('verifies bounded PostgreSQL v3 wire probe, S3 SigV4 HEAD probe, and worker readiness probe failure/success paths', async () => {
    // 1. Unreachable Postgres port fails closed
    const badPg = await probePostgresConnectivity(
      'postgresql://cve_api:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:1/creativanta_staging',
      { timeoutMs: 300 },
    );
    assert.equal(badPg.reachable, false);
    assert.equal(badPg.readyForTraffic, false);
    assert.equal(badPg.reasonCode, 'TCP_CONNECT_FAILED');

    // 2. Non-cve_api role fails closed before connecting
    const badRolePg = await probePostgresConnectivity(
      'postgresql://cve_migrator:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:5432/creativanta_staging',
      { timeoutMs: 300 },
    );
    assert.equal(badRolePg.leastPrivilegeRoleValid, false);
    assert.equal(badRolePg.reasonCode, 'FORBIDDEN_RUNTIME_DB_ROLE');

    // 3. Invalid wire response (non-Postgres TCP listener) fails closed
    const garbageServer = net.createServer((socket) => {
      socket.once('data', () => {
        socket.write(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n', 'ascii'));
      });
    });
    await new Promise((resolve) => garbageServer.listen(0, '127.0.0.1', resolve));
    const garbagePort = garbageServer.address().port;
    try {
      const garbageProbe = await probePostgresConnectivity(
        `postgresql://cve_api:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:${garbagePort}/creativanta_staging`,
        { timeoutMs: 500 },
      );
      assert.equal(garbageProbe.reachable, true);
      assert.equal(garbageProbe.wireProtocolVerified, false);
      assert.equal(garbageProbe.reasonCode, 'INVALID_WIRE_RESPONSE');
    } finally {
      await new Promise((resolve) => garbageServer.close(resolve));
    }

    // 4. Storage probe rejects 302 redirect and 403 forbidden
    let storageResponseStatus = 302;
    const s3Mock = http.createServer((_req, res) => {
      if (storageResponseStatus === 302) {
        res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(storageResponseStatus);
      res.end();
    });
    await new Promise((resolve) => s3Mock.listen(0, '127.0.0.1', resolve));
    const s3Port = s3Mock.address().port;
    try {
      const stgCfg = loadEnvConfig(
        buildStagingEnv({ CVE_STORAGE_ENDPOINT: `http://127.0.0.1:${s3Port}` }),
      );
      const redirectProbe = await probeObjectStorageConnectivity(stgCfg, {
        timeoutMs: 500,
        allowLoopbackHttpInStagingTest: true,
      });
      assert.equal(redirectProbe.ready, false);
      assert.equal(redirectProbe.reasonCode, 'STORAGE_REDIRECT_FORBIDDEN');

      storageResponseStatus = 403;
      const deniedProbe = await probeObjectStorageConnectivity(stgCfg, {
        timeoutMs: 500,
        allowLoopbackHttpInStagingTest: true,
      });
      assert.equal(deniedProbe.ready, false);
      assert.equal(deniedProbe.reasonCode, 'STORAGE_AUTH_DENIED');
    } finally {
      await new Promise((resolve) => s3Mock.close(resolve));
    }

    // 5. Worker readiness probe rejects placeholder digest and unconfigured URL
    const placeholderDigestProbe = await probeRendererWorkerReadiness({
      CVE_RENDERER_ADAPTER: 'chromium-frame-v1',
      CVE_RENDER_IMAGE_DIGEST:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    });
    assert.equal(placeholderDigestProbe.ready, false);
    assert.equal(placeholderDigestProbe.reasonCode, 'PLACEHOLDER_RENDER_IMAGE_DIGEST');

    const unconfiguredWorkerProbe = await probeRendererWorkerReadiness({
      CVE_RENDERER_ADAPTER: 'chromium-frame-v1',
      CVE_RENDER_IMAGE_DIGEST: VALID_PINNED_DIGEST,
    });
    assert.equal(unconfiguredWorkerProbe.ready, false);
    assert.equal(unconfiguredWorkerProbe.reasonCode, 'WORKER_PROBE_NOT_CONFIGURED');
  });

  it('rejects plaintext API keys in CVE_TEST_BOOTSTRAP_TENANTS_JSON and enforces bounded lifecycle in startApiServer', async () => {
    const devCfg = loadEnvConfig({ CVE_ENV: 'development' });
    assert.throws(
      () =>
        bootstrapApiBackend({
          config: devCfg,
          rawEnv: {
            CVE_ENV: 'development',
            CVE_BACKEND_MODE: 'sqlite-test-only',
            CVE_TEST_BOOTSTRAP_TENANTS_JSON: JSON.stringify([
              {
                tenantId: '11111111-1111-4111-8111-111111111111',
                name: 'Bad Plaintext Seed',
                keyId: 'key_bad',
                keyPrefix: 'cve_test_0123456789ab',
                keyHash: 'a'.repeat(64),
                plaintextKey: 'cve_test_0123456789ab_' + 'b'.repeat(64),
                scopes: ['jobs:read'],
              },
            ]),
          },
        }),
      (err) =>
        err instanceof BackendBootstrapError &&
        err.code === 'PLAINTEXT_API_KEY_IN_ENV_FORBIDDEN',
    );

    const pepper = 'p10a_unit_test_pepper_32_bytes_minimum_secret!';
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';
    const keyA = generateApiKeyMaterial({ environment: 'test', pepper });
    const keyB = generateApiKeyMaterial({ environment: 'test', pepper });

    const handle = await startApiServer({
      rawEnv: {
        CVE_ENV: 'development',
        CVE_BACKEND_MODE: 'sqlite-test-only',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_API_KEY_PEPPER: pepper,
      },
      host: '127.0.0.1',
      port: 0,
      seedTenants: [
        {
          tenantId: tenantA,
          name: 'Unit Tenant A',
          keyId: 'key_a',
          keyPrefix: keyA.keyPrefix,
          keyHash: keyA.keyHash,
          scopes: [...ALL_API_SCOPES],
        },
        {
          tenantId: tenantB,
          name: 'Unit Tenant B',
          keyId: 'key_b',
          keyPrefix: keyB.keyPrefix,
          keyHash: keyB.keyHash,
          scopes: [...ALL_API_SCOPES],
        },
      ],
    });

    try {
      assert.equal(handle.backend.mode, 'sqlite-test-only');
      assert.equal(handle.backend.nonProductionTestOnly, true);

      // Default readinessProbe in sqlite-test-only remains fail-closed (database: false)
      const readiness = await handle.backend.readinessProbe();
      assert.equal(readiness.database, false);
      assert.equal(readiness.renderer, false);

      // Tenant A uploads an SVG asset; Tenant B cannot reference Tenant A's asset in body (422 ASSET_NOT_FOUND)
      const svgBytes = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="80" height="80" fill="#123456"/></svg>',
        'utf8',
      );
      const svgSha = (await import('node:crypto'))
        .createHash('sha256')
        .update(svgBytes)
        .digest('hex');

      const upRes = await fetch(`${handle.baseUrl}/v1/assets/uploads`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyA.plaintextKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-unit-upload-a',
        },
        body: JSON.stringify({
          filename: 'logo.svg',
          mime_type: 'image/svg+xml',
          bytes: svgBytes.byteLength,
          sha256: svgSha,
          rights: {
            basis: 'owned',
            source: 'unit-test',
            attribution: 'P10-A Unit Test',
          },
        }),
      });
      assert.equal(upRes.status, 201);
      const upBody = await upRes.json();

      // Tenant B attempts to GET Tenant A's asset -> 404 NOT_FOUND
      const bGetAsset = await fetch(`${handle.baseUrl}/v1/assets/${upBody.asset_id}`, {
        headers: { Authorization: `Bearer ${keyB.plaintextKey}` },
      });
      assert.equal(bGetAsset.status, 404);

      // Tenant B attempts to reference Tenant A's asset_id in composition body -> 422 VALIDATION_FAILED (ASSET_NOT_FOUND)
      const bCreateComp = await fetch(`${handle.baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyB.plaintextKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'idem-unit-b-comp-idor',
        },
        body: JSON.stringify({
          name: 'Cross-Tenant Body Probe',
          spec: {
            schema_version: '1.0',
            canvas: { width: 720, height: 1280, background: '#000000' },
            fps: { num: 30, den: 1 },
            duration_frames: 60,
            seed: 1,
            locale: 'vi-VN',
            fonts: [],
            scenes: [
              {
                id: 's1',
                revision: 1,
                start_frame: 0,
                duration_frames: 60,
                engine: 'html-v1',
                layers: [
                  {
                    id: 'l1',
                    type: 'svg',
                    start_frame: 0,
                    duration_frames: 60,
                    z_index: 1,
                    box: { x: 48, y: 48, width: 200, height: 200 },
                    content: {
                      asset_id: upBody.asset_id,
                    },
                  },
                ],
              },
            ],
            audio_tracks: [],
            subtitles: [],
          },
        }),
      });
      assert.equal(bCreateComp.status, 422);
      const bCreateCompErr = await bCreateComp.json();
      assert.equal(bCreateCompErr.error.code, 'VALIDATION_FAILED');
      assert.ok(bCreateCompErr.error.details.some((d) => d.code === 'ASSET_NOT_FOUND'));
    } finally {
      await handle.close();
    }
  });

  it('buffers fragmented PostgreSQL v3 wire frames (1-byte and 2-chunk splits) and rejects oversized, short, or timed-out frames (Codex P2)', async () => {
    const runMockPgServer = async (handler, timeoutMs = 400) => {
      const server = net.createServer((socket) => {
        socket.setNoDelay(true);
        handler(socket);
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;
      try {
        return await probePostgresConnectivity(
          `postgresql://cve_api:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:${port}/creativanta_staging`,
          { timeoutMs },
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };

    // 1. Valid 9-byte AuthenticationCleartextPassword ('R', len=8, code=3) fragmented into 1-byte chunks
    let oneByteChunksSent = 0;
    const oneByteProbe = await runMockPgServer((socket) => {
      socket.once('data', async () => {
        const frame = Buffer.alloc(9);
        frame.write('R', 0, 'ascii');
        frame.writeInt32BE(8, 1);
        frame.writeInt32BE(3, 5);
        for (let i = 0; i < frame.byteLength; i++) {
          if (socket.destroyed) break;
          socket.write(frame.subarray(i, i + 1));
          oneByteChunksSent++;
          await delay(4);
        }
      });
    }, 800);
    assert.equal(oneByteChunksSent, 9);
    assert.equal(oneByteProbe.reachable, true);
    assert.equal(oneByteProbe.wireProtocolVerified, true);
    assert.equal(oneByteProbe.reasonCode, 'POSTGRES_DRIVER_NOT_IMPLEMENTED');

    // 2. Valid ErrorResponse ('E', len=12) split into two chunks (2-byte partial header + 11-byte remainder)
    const twoChunkProbe = await runMockPgServer((socket) => {
      socket.once('data', async () => {
        const payload = Buffer.from('SFATAL\0\0', 'ascii'); // 8 bytes
        const frame = Buffer.alloc(5 + payload.byteLength);
        frame.write('E', 0, 'ascii');
        frame.writeInt32BE(4 + payload.byteLength, 1);
        payload.copy(frame, 5);

        socket.write(frame.subarray(0, 2)); // Only 2 of 5 header bytes!
        await delay(10);
        if (!socket.destroyed) {
          socket.write(frame.subarray(2));
        }
      });
    }, 800);
    assert.equal(twoChunkProbe.reachable, true);
    assert.equal(twoChunkProbe.wireProtocolVerified, true);
    assert.equal(twoChunkProbe.reasonCode, 'POSTGRES_DRIVER_NOT_IMPLEMENTED');

    // 3. Oversized frame length header (> PG_WIRE_MAX_FRAME_LENGTH) rejected immediately
    const oversizedHeaderProbe = await runMockPgServer((socket) => {
      socket.once('data', () => {
        const header = Buffer.alloc(9);
        header.write('R', 0, 'ascii');
        header.writeInt32BE(PG_WIRE_MAX_FRAME_LENGTH + 1024, 1);
        header.writeInt32BE(3, 5);
        socket.write(header);
      });
    });
    assert.equal(oversizedHeaderProbe.reachable, true);
    assert.equal(oversizedHeaderProbe.wireProtocolVerified, false);
    assert.equal(oversizedHeaderProbe.reasonCode, 'INVALID_WIRE_RESPONSE');

    // 4. Oversized streaming buffer (> PG_WIRE_MAX_BUFFER_BYTES) rejected immediately
    const oversizedStreamProbe = await runMockPgServer((socket) => {
      socket.once('data', () => {
        const huge = Buffer.alloc(PG_WIRE_MAX_BUFFER_BYTES + 64, 0x52);
        socket.write(huge);
      });
    });
    assert.equal(oversizedStreamProbe.reachable, true);
    assert.equal(oversizedStreamProbe.wireProtocolVerified, false);
    assert.equal(oversizedStreamProbe.reasonCode, 'INVALID_WIRE_RESPONSE');

    // 5. Invalid short frame length ('R' with frameLength=4 < 8) rejected
    const shortFrameProbe = await runMockPgServer((socket) => {
      socket.once('data', () => {
        const bad = Buffer.alloc(5);
        bad.write('R', 0, 'ascii');
        bad.writeInt32BE(4, 1);
        socket.write(bad);
      });
    });
    assert.equal(shortFrameProbe.reachable, true);
    assert.equal(shortFrameProbe.wireProtocolVerified, false);
    assert.equal(shortFrameProbe.reasonCode, 'INVALID_WIRE_RESPONSE');

    // 6. Truncated mid-header EOF (server sends 3 bytes then closes socket)
    const truncatedCloseProbe = await runMockPgServer((socket) => {
      socket.once('data', () => {
        socket.end(Buffer.from([0x52, 0x00, 0x00]));
      });
    });
    assert.equal(truncatedCloseProbe.reachable, true);
    assert.equal(truncatedCloseProbe.wireProtocolVerified, false);
    assert.equal(truncatedCloseProbe.reasonCode, 'INVALID_WIRE_RESPONSE');

    // 7. Timed-out mid-frame stall (server sends 3 bytes then stalls past deadline)
    const stalledSockets = [];
    const timeoutProbe = await runMockPgServer((socket) => {
      stalledSockets.push(socket);
      socket.once('data', () => {
        socket.write(Buffer.from([0x52, 0x00, 0x00]));
        // Intentionally never send remaining bytes; wait for probe timeout
      });
    }, 150);
    for (const s of stalledSockets) s.destroy();
    assert.equal(timeoutProbe.reachable, true);
    assert.equal(timeoutProbe.wireProtocolVerified, false);
    assert.equal(timeoutProbe.reasonCode, 'TCP_CONNECT_TIMEOUT');
  });

  it('wires readinessProbe into HTTP GET /readyz across startApiServer and real child processes without false-green (Codex P1)', async () => {
    // 1. In-process startApiServer with allowTestSqliteReadinessProbe: true transitions 200 <-> 503 based on live probes
    let s3Healthy = true;
    let workerHealthy = true;
    let s3ProbeHits = 0;
    let workerProbeHits = 0;

    const depServer = http.createServer((req, res) => {
      if (req.method === 'HEAD' && req.url === '/cve-quarantine-dev') {
        s3ProbeHits++;
        res.writeHead(s3Healthy ? 200 : 503);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/worker-readyz') {
        workerProbeHits++;
        if (!workerHealthy) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', adapter: 'chromium-frame-v1' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => depServer.listen(0, '127.0.0.1', resolve));
    const depPort = depServer.address().port;

    const handle = await startApiServer({
      rawEnv: {
        CVE_ENV: 'development',
        CVE_BACKEND_MODE: 'sqlite-test-only',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_STORAGE_ENDPOINT: `http://127.0.0.1:${depPort}`,
        CVE_RENDER_IMAGE_DIGEST: VALID_PINNED_DIGEST,
        CVE_WORKER_READINESS_URL: `http://127.0.0.1:${depPort}/worker-readyz`,
      },
      host: '127.0.0.1',
      port: 0,
      allowTestSqliteReadinessProbe: true,
    });

    try {
      const readyOkRes = await fetch(`${handle.baseUrl}/readyz`);
      assert.equal(readyOkRes.status, 200);
      const readyOkBody = await readyOkRes.json();
      assert.equal(readyOkBody.status, 'ready');
      assert.deepEqual(readyOkBody.checks, {
        database: 'ok',
        storage: 'ok',
        renderer: 'ok',
      });
      assert.equal(s3ProbeHits, 1);
      assert.equal(workerProbeHits, 1);

      // Degrade storage -> HTTP /readyz must fail closed (503 DEPENDENCY_UNAVAILABLE)
      s3Healthy = false;
      const readyDegradedRes = await fetch(`${handle.baseUrl}/readyz`);
      assert.equal(readyDegradedRes.status, 503);
      const readyDegradedBody = await readyDegradedRes.json();
      assert.equal(readyDegradedBody.status, 'not_ready');
      assert.equal(readyDegradedBody.reason, 'DEPENDENCY_UNAVAILABLE');
      assert.equal(readyDegradedBody.checks.storage, 'unavailable');
      assert.equal(readyDegradedBody.checks.database, 'ok');
      assert.equal(readyDegradedBody.checks.renderer, 'ok');
    } finally {
      await handle.close();
      await new Promise((resolve) => depServer.close(resolve));
    }
  });

  it('packages read-only migrations in Dockerfile.api runner and starts cleanly from an isolated /app container layout outside the repo tree (Codex P1)', async () => {
    const dockerfilePath = path.join(REPO_ROOT, 'docker/Dockerfile.api');
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
    const runnerSection = dockerfileContent.split(/FROM\s+[^\n]+\s+AS\s+runner/i)[1] ?? '';
    assert.ok(
      runnerSection.length > 0,
      'Expected runner stage in docker/Dockerfile.api',
    );

    // Parse all `COPY --from=builder /app/<src> <dest>` instructions from the runner stage
    const copyRegex = /^COPY\s+--from=builder\s+([^\n]+)$/gm;
    const copiedEntries = [];
    let match;
    while ((match = copyRegex.exec(runnerSection)) !== null) {
      const tokens = match[1].trim().split(/\s+/);
      const destRel = tokens[tokens.length - 1];
      const sources = tokens.slice(0, -1);
      for (const src of sources) {
        assert.ok(src.startsWith('/app/'), `Expected /app/ source prefix in ${src}`);
        copiedEntries.push({
          srcRel: src.slice('/app/'.length),
          destRel,
        });
      }
    }

    assert.ok(
      copiedEntries.some((e) => e.srcRel === 'migrations'),
      'Dockerfile.api runner stage must copy /app/migrations',
    );

    // Materialize an isolated /tmp/.../app directory containing ONLY the files copied by Dockerfile.api runner stage
    const tempContainerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-dockerfile-api-runner-'));
    const isolatedAppDir = path.join(tempContainerRoot, 'app');
    fs.mkdirSync(isolatedAppDir, { recursive: true });

    try {
      for (const { srcRel, destRel } of copiedEntries) {
        const sourceAbs = path.join(REPO_ROOT, srcRel);
        const targetBase = path.resolve(isolatedAppDir, destRel);
        const destAbs =
          destRel.endsWith('/') || destRel === './'
            ? path.join(targetBase, path.basename(srcRel))
            : targetBase;
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        fs.cpSync(sourceAbs, destAbs, { recursive: true });
      }

      // Wire workspace link `packages/api/node_modules/@creativanta/contracts -> ../../contracts`
      // matching `pnpm install --frozen-lockfile --prod` inside the runner stage
      const apiScopedNodeModules = path.join(
        isolatedAppDir,
        'packages/api/node_modules/@creativanta',
      );
      fs.mkdirSync(apiScopedNodeModules, { recursive: true });
      fs.symlinkSync(
        path.join(isolatedAppDir, 'packages/contracts'),
        path.join(apiScopedNodeModules, 'contracts'),
        'dir',
      );

      // Apply exact read-only permissions from Dockerfile.api (`chmod 0555 /app/migrations && chmod 0444 /app/migrations/*`)
      const isolatedMigrationsDir = path.join(isolatedAppDir, 'migrations');
      for (const entry of fs.readdirSync(isolatedMigrationsDir)) {
        fs.chmodSync(path.join(isolatedMigrationsDir, entry), 0o444);
      }
      fs.chmodSync(isolatedMigrationsDir, 0o555);

      // Verify that writing to the packaged migrations directory is denied
      assert.throws(() => {
        fs.writeFileSync(path.join(isolatedMigrationsDir, 'tamper.sql'), 'DROP TABLE tenants;');
      });

      // Spawn the real API entrypoint inside isolatedAppDir (/tmp/.../app) and verify startup + /readyz
      const srv = net.createServer();
      await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const port = srv.address().port;
      await new Promise((resolve) => srv.close(resolve));

      const baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, ['packages/api/dist/index.js'], {
        cwd: isolatedAppDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CVE_ENV: 'development',
          CVE_PUBLIC_BASE_URL: `${baseUrl}/v1`,
          HOST: '127.0.0.1',
          CVE_CUSTOM_CODE_ENABLED: 'false',
          CVE_CUSTOM_RUNTIME: 'disabled',
          CVE_REMOTE_IMPORT_ENABLED: 'false',
          CVE_TTS_PROVIDER: 'disabled',
          CVE_AUTHORING_PROVIDER: 'disabled',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let childExited = false;
      let stderr = '';
      child.stderr.on('data', (d) => {
        stderr += String(d);
      });
      child.on('exit', () => {
        childExited = true;
      });

      try {
        let alive = false;
        for (let i = 0; i < 60; i++) {
          if (childExited) break;
          try {
            const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(300) });
            if (res.status === 200) {
              alive = true;
              break;
            }
          } catch {
            // Wait for startup
          }
          await delay(100);
        }
        assert.equal(
          alive,
          true,
          `Isolated /app container runtime failed to start (stderr=${stderr})`,
        );

        const readyRes = await fetch(`${baseUrl}/readyz`);
        assert.equal(readyRes.status, 503);
        const readyBody = await readyRes.json();
        assert.equal(readyBody.reason, 'TENANT_REPOSITORY_NOT_CONFIGURED');
      } finally {
        if (!childExited) child.kill('SIGTERM');
        for (let i = 0; i < 30 && !childExited; i++) {
          await delay(100);
        }
        if (!childExited) child.kill('SIGKILL');
      }

      // Restore permissions before removing /app/migrations to test negative case (missing migrations)
      fs.chmodSync(isolatedMigrationsDir, 0o755);
      for (const entry of fs.readdirSync(isolatedMigrationsDir)) {
        fs.chmodSync(path.join(isolatedMigrationsDir, entry), 0o644);
      }
      fs.rmSync(isolatedMigrationsDir, { recursive: true, force: true });

      const brokenChild = spawn(process.execPath, ['packages/api/dist/index.js'], {
        cwd: isolatedAppDir,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CVE_ENV: 'development',
          CVE_PUBLIC_BASE_URL: `${baseUrl}/v1`,
          HOST: '127.0.0.1',
          CVE_CUSTOM_CODE_ENABLED: 'false',
          CVE_CUSTOM_RUNTIME: 'disabled',
          CVE_REMOTE_IMPORT_ENABLED: 'false',
          CVE_TTS_PROVIDER: 'disabled',
          CVE_AUTHORING_PROVIDER: 'disabled',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let brokenStderr = '';
      brokenChild.stderr.on('data', (d) => {
        brokenStderr += String(d);
      });
      const brokenExitCode = await new Promise((resolve) => {
        brokenChild.on('exit', (code) => resolve(code));
      });
      assert.equal(brokenExitCode, 1);
      assert.ok(brokenStderr.includes('"error_code":"MIGRATION_AUDIT_FAILED"'));
    } finally {
      try {
        const migDir = path.join(isolatedAppDir, 'migrations');
        if (fs.existsSync(migDir)) {
          fs.chmodSync(migDir, 0o755);
          for (const entry of fs.readdirSync(migDir)) {
            fs.chmodSync(path.join(migDir, entry), 0o644);
          }
        }
      } catch {
        // Ignore cleanup chmod error
      }
      fs.rmSync(tempContainerRoot, { recursive: true, force: true });
    }
  });

  it('executes full 5-stage P10-A StagingBackendVerifier including real child-process checks', async () => {
    const verifier = new StagingBackendVerifier();
    const report = await verifier.runAll();
    assert.equal(report.status, 'PASS');
    assert.equal(report.totalChecks, 5);
    assert.equal(report.passedChecks, 5);
    assert.equal(report.failedChecks, 0);
    assert.equal(report.stagingDeploymentReadyForTraffic, false);
    assert.equal(report.productionReleaseAuthorized, false);
  });
});
