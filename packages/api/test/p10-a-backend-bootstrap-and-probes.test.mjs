/**
 * Task P10-A: Staging Backend Bootstrap, Fail-Closed Environment Guard,
 * Driver Compatibility Assessment, Bounded Protocol Probes, and Real-Process
 * Non-Production SQLite Test Loopback Verification (GitHub Issue #65 / Parent #63).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { describe, it } from 'node:test';

import { loadEnvConfig } from '@creativanta/contracts';
import {
  ALL_API_SCOPES,
  BackendBootstrapError,
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
