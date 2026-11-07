#!/usr/bin/env node
/**
 * Creativanta Video Engine — P10-A Real Process & Staging Backend Infrastructure Verifier
 * Issue: #65 (Parent #63)
 *
 * IMPORTANT TRUTHFULNESS & BOUNDARY STATEMENT:
 * - This verifier exercises the REAL compiled API entrypoint (`packages/api/dist/index.js`)
 *   and backend bootstrap/probe module (`packages/api/dist/db/backend-bootstrap.js`).
 * - It does NOT use `CreativantaContractMock`.
 * - It explicitly verifies that `CVE_ENV=staging` remains fail-closed (`not_ready` / 503)
 *   because `TenantRepository` is still bound to synchronous `node:sqlite` (`DatabaseSync`)
 *   and no live PostgreSQL driver, production S3 store, or renderer sandbox worker is deployed.
 * - Isolated `CVE_BACKEND_MODE=sqlite-test-only` child-process verification is explicitly
 *   labeled `nonProductionTestOnly: true` and forbidden in `staging` and `production`.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadEnvConfig } from '../../packages/contracts/dist/index.js';
import {
  ALL_API_SCOPES,
  BackendBootstrapError,
  bootstrapApiBackend,
  evaluatePostgresDriverAndRlsReadiness,
  generateApiKeyMaterial,
  probeObjectStorageConnectivity,
  probePostgresConnectivity,
  probeRendererWorkerReadiness,
  validateBackendStartupEnv,
} from '../../packages/api/dist/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VALID_PINNED_DIGEST =
  'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

async function reserveLoopbackPort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function buildValidStagingEnvOverrides(overrides = {}) {
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

export class StagingBackendVerifier {
  constructor(options = {}) {
    this.repoRoot = options.repoRoot || REPO_ROOT;
  }

  async runAll() {
    const startedAt = Date.now();
    const checks = [];

    const runCheck = async (id, title, fn) => {
      const t0 = performance.now();
      try {
        const details = await fn();
        checks.push({
          id,
          title,
          passed: true,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          details,
        });
      } catch (err) {
        checks.push({
          id,
          title,
          passed: false,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // -------------------------------------------------------------------------
    // Check 1: Fail-Closed Staging Environment Guard
    // -------------------------------------------------------------------------
    await runCheck(
      'P10A-ENV-01',
      'Staging fail-closed environment guard rejects missing vars, default secrets, non-cve_api DB roles, sqlite-test-only mode, and unsafe flags',
      async () => {
        // 1a. Missing explicit env vars in staging
        const missingEnv = { CVE_ENV: 'staging' };
        const missingCfg = loadEnvConfig(missingEnv);
        assert.throws(
          () => validateBackendStartupEnv(missingCfg, missingEnv),
          (err) => err instanceof BackendBootstrapError && err.code === 'MISSING_EXPLICIT_STAGING_ENV',
        );

        // 1b. Default dev password / minioadmin / dev pepper / all-zero digest in staging
        const defaultSecretEnv = buildValidStagingEnvOverrides({
          CVE_DATABASE_URL:
            'postgresql://cve_api:cve_dev_api_secret@127.0.0.1:5432/creativanta_staging',
          CVE_STORAGE_ACCESS_KEY_ID: 'minioadmin',
        });
        assert.throws(
          () => validateBackendStartupEnv(loadEnvConfig(defaultSecretEnv), defaultSecretEnv),
          (err) => err instanceof BackendBootstrapError && err.code === 'INSECURE_OR_INVALID_STAGING_ENV',
        );

        // 1c. Forbidden DDL/superuser role (cve_migrator or postgres) at API runtime
        const migratorRoleEnv = buildValidStagingEnvOverrides({
          CVE_DATABASE_URL:
            'postgresql://cve_migrator:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:5432/creativanta_staging',
        });
        assert.throws(
          () => validateBackendStartupEnv(loadEnvConfig(migratorRoleEnv), migratorRoleEnv),
          (err) =>
            err instanceof BackendBootstrapError &&
            err.code === 'INSECURE_OR_INVALID_STAGING_ENV' &&
            err.details.some((d) => d.includes("least-privilege 'cve_api'")),
        );

        // 1d. sqlite-test-only mode forbidden in staging and production
        const sqliteInStagingEnv = buildValidStagingEnvOverrides({
          CVE_BACKEND_MODE: 'sqlite-test-only',
        });
        assert.throws(
          () => validateBackendStartupEnv(loadEnvConfig(sqliteInStagingEnv), sqliteInStagingEnv),
          (err) =>
            err instanceof BackendBootstrapError &&
            err.code === 'SQLITE_TEST_MODE_FORBIDDEN_IN_STAGING_OR_PROD',
        );

        // 1e. Remote import or custom code enabled rejected
        const remoteImportEnv = buildValidStagingEnvOverrides({
          CVE_REMOTE_IMPORT_ENABLED: 'true',
        });
        assert.throws(
          () => validateBackendStartupEnv(loadEnvConfig(remoteImportEnv), remoteImportEnv),
          (err) => err instanceof BackendBootstrapError && err.code === 'GATED_CAPABILITY_VIOLATION',
        );

        // 1f. Valid explicit staging env passes validation
        const validEnv = buildValidStagingEnvOverrides();
        validateBackendStartupEnv(loadEnvConfig(validEnv), validEnv);

        return {
          rejectedMissingEnv: true,
          rejectedDefaultCredentials: true,
          rejectedNonCveApiRuntimeRole: true,
          rejectedSqliteTestModeInStaging: true,
          rejectedEnabledRemoteImportOrCustomCode: true,
          acceptedValidExplicitStagingEnv: true,
        };
      },
    );

    // -------------------------------------------------------------------------
    // Check 2: Migration RLS/FORCE RLS Audit, Dockerfile.api Packaging & Driver Incompatibility
    // -------------------------------------------------------------------------
    await runCheck(
      'P10A-RLS-02',
      'PostgreSQL 21-table RLS/FORCE RLS + 5 least-privilege roles audit, Dockerfile.api read-only migrations packaging, and truthful node:sqlite vs PostgreSQL driver incompatibility evaluation',
      async () => {
        const evaluation = evaluatePostgresDriverAndRlsReadiness();
        assert.equal(evaluation.migrationsAudit.valid, true);
        assert.equal(evaluation.migrationsAudit.tableCount, 21);
        assert.equal(evaluation.migrationsAudit.rlsEnabledCount, 21);
        assert.equal(evaluation.migrationsAudit.rlsForcedCount, 21);
        assert.equal(evaluation.rlsAndForceRlsVerified, true);
        assert.equal(evaluation.leastPrivilegeRolesDefined, true);
        assert.equal(evaluation.currentRepositoryEngine, 'node:sqlite');
        assert.equal(evaluation.targetStagingEngine, 'postgresql-16');
        assert.equal(evaluation.postgresWireDriverInstalled, false);
        assert.equal(evaluation.asyncTenantRepositoryImplemented, false);
        assert.equal(evaluation.canServePostgresTraffic, false);
        assert.ok(evaluation.incompatibilities.length >= 3);

        // Verify docker/Dockerfile.api packages migrations into both builder and runner (read-only)
        const dockerfileApi = fs.readFileSync(
          path.join(this.repoRoot, 'docker/Dockerfile.api'),
          'utf8',
        );
        const runnerStage = dockerfileApi.split(/FROM\s+[^\n]+\s+AS\s+runner/i)[1] ?? '';
        assert.ok(
          /COPY\s+migrations\s+\.\/migrations/.test(dockerfileApi),
          'Dockerfile.api builder stage must COPY migrations ./migrations',
        );
        assert.ok(
          /COPY\s+--from=builder\s+\/app\/migrations\s+\.\/migrations/.test(runnerStage),
          'Dockerfile.api runner stage must COPY --from=builder /app/migrations ./migrations',
        );
        assert.ok(
          /chmod\s+0555\s+\/app\/migrations\s+&&\s+chmod\s+0444\s+\/app\/migrations\/\*/.test(
            runnerStage,
          ),
          'Dockerfile.api runner stage must enforce read-only permissions on /app/migrations',
        );

        const composeStaging = fs.readFileSync(
          path.join(this.repoRoot, 'docker/staging/docker-compose.staging-isolated.yml'),
          'utf8',
        );
        assert.ok(
          composeStaging.includes('- ../../migrations:/app/migrations:ro'),
          'docker-compose.staging-isolated.yml must mount ../../migrations:/app/migrations:ro in staging-api',
        );

        return {
          tableCount: evaluation.migrationsAudit.tableCount,
          rlsEnabledCount: evaluation.migrationsAudit.rlsEnabledCount,
          rlsForcedCount: evaluation.migrationsAudit.rlsForcedCount,
          rolesVerified: evaluation.migrationsAudit.rolesVerified,
          dockerfileApiRunnerCopiesReadOnlyMigrations: true,
          composeStagingMountsReadOnlyMigrations: true,
          currentRepositoryEngine: evaluation.currentRepositoryEngine,
          canServePostgresTraffic: evaluation.canServePostgresTraffic,
        };
      },
    );

    // -------------------------------------------------------------------------
    // Check 3: Bounded Real Protocol Probes (PG v3 Wire + Fragmented Chunks, S3 SigV4 HEAD, Worker HTTP)
    // -------------------------------------------------------------------------
    await runCheck(
      'P10A-PROBE-03',
      'Bounded PostgreSQL v3 wire StartupMessage probe (including 1-byte fragmented TCP chunks), S3 AWS4-HMAC-SHA256 HEAD probe, and renderer worker readiness probe with zero fake green',
      async () => {
        // 3a. Ephemeral PostgreSQL v3 wire protocol responder on 127.0.0.1:0
        // Streams the 9-byte AuthenticationCleartextPassword ('R', len=8, code=3) 1 byte at a time
        // to prove incremental PG frame buffering across fragmented TCP chunks.
        let receivedStartupProtocol = 0;
        let receivedTerminate = false;
        let fragmentedChunksWritten = 0;
        const pgServer = net.createServer((socket) => {
          socket.setNoDelay(true);
          socket.on('data', async (chunk) => {
            if (chunk.byteLength >= 8 && receivedStartupProtocol === 0) {
              receivedStartupProtocol = chunk.readInt32BE(4);
              const authResp = Buffer.alloc(9);
              authResp.write('R', 0, 'ascii');
              authResp.writeInt32BE(8, 1);
              authResp.writeInt32BE(3, 5);
              for (let i = 0; i < authResp.byteLength; i++) {
                if (socket.destroyed) break;
                socket.write(authResp.subarray(i, i + 1));
                fragmentedChunksWritten++;
                await delay(3);
              }
            } else if (chunk.includes(0x58)) {
              receivedTerminate = true;
            }
          });
        });
        await new Promise((resolve) => pgServer.listen(0, '127.0.0.1', resolve));
        const pgPort = pgServer.address().port;

        // 3b. Ephemeral S3 SigV4 verifier & worker readiness HTTP responder
        let receivedSigV4Header = '';
        const httpServer = http.createServer((req, res) => {
          if (req.method === 'HEAD' && req.url === '/cve-quarantine-staging') {
            receivedSigV4Header = String(req.headers['authorization'] || '');
            if (receivedSigV4Header.startsWith('AWS4-HMAC-SHA256 Credential=STAGING_ACCESS_KEY_ID_9001/')) {
              res.writeHead(200);
              res.end();
              return;
            }
            res.writeHead(403);
            res.end();
            return;
          }
          if (req.method === 'GET' && req.url === '/worker-readyz') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ready', adapter: 'chromium-frame-v1' }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        const httpPort = httpServer.address().port;

        try {
          const dbUrl = `postgresql://cve_api:stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f@127.0.0.1:${pgPort}/creativanta_staging`;
          const pgProbe = await probePostgresConnectivity(dbUrl, { timeoutMs: 1000 });
          assert.equal(pgProbe.reachable, true);
          assert.equal(pgProbe.wireProtocolVerified, true);
          assert.equal(pgProbe.leastPrivilegeRoleValid, true);
          assert.equal(pgProbe.rlsMigrationsAudited, true);
          assert.equal(pgProbe.repositoryDriverCompatible, false);
          assert.equal(pgProbe.readyForTraffic, false);
          assert.equal(pgProbe.reasonCode, 'POSTGRES_DRIVER_NOT_IMPLEMENTED');
          assert.equal(receivedStartupProtocol, 196608);
          assert.equal(fragmentedChunksWritten, 9);
          assert.ok(!pgProbe.redactedEndpoint.includes('stgruntime_9a8b7c6d5e4f3a2b1c0d9e8f'));

          const stgEnv = buildValidStagingEnvOverrides({
            CVE_STORAGE_ENDPOINT: `http://127.0.0.1:${httpPort}`,
          });
          const stgCfg = loadEnvConfig(stgEnv);
          const s3Probe = await probeObjectStorageConnectivity(stgCfg, {
            timeoutMs: 1000,
            allowLoopbackHttpInStagingTest: true,
          });
          assert.equal(s3Probe.reachable, true);
          assert.equal(s3Probe.bucketAccessible, true);
          assert.equal(s3Probe.ready, true);
          assert.equal(s3Probe.reasonCode, 'OK');
          assert.ok(receivedSigV4Header.startsWith('AWS4-HMAC-SHA256'));

          const workerProbe = await probeRendererWorkerReadiness(stgCfg, {
            workerProbeUrl: `http://127.0.0.1:${httpPort}/worker-readyz`,
            timeoutMs: 1000,
          });
          assert.equal(workerProbe.ready, true);
          assert.equal(workerProbe.reasonCode, 'OK');

          return {
            pgReachable: pgProbe.reachable,
            pgWireProtocolVerified: pgProbe.wireProtocolVerified,
            pgFragmentedOneByteChunksVerified: fragmentedChunksWritten,
            pgRepositoryDriverCompatible: pgProbe.repositoryDriverCompatible,
            pgReadyForTraffic: pgProbe.readyForTraffic,
            pgTerminateSent: receivedTerminate,
            s3SigV4Verified: s3Probe.ready,
            workerProbeVerified: workerProbe.ready,
          };
        } finally {
          await new Promise((resolve) => pgServer.close(resolve));
          await new Promise((resolve) => httpServer.close(resolve));
        }
      },
    );

    // -------------------------------------------------------------------------
    // Check 4: Real Child-Process Staging Fail-Closed Startup & Unready Verification
    // -------------------------------------------------------------------------
    await runCheck(
      'P10A-PROC-STAGING-04',
      'Real child-process API startup in CVE_ENV=staging rejects default secrets and remains fail-closed (503) on /readyz and authenticated endpoints without SQLite fallback',
      async () => {
        // 4a. Spawn child process with CVE_ENV=staging and missing/default secrets -> must exit 1
        const badChild = spawn(process.execPath, ['packages/api/dist/index.js'], {
          cwd: this.repoRoot,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            CVE_ENV: 'staging',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let badStderr = '';
        badChild.stderr.on('data', (d) => {
          badStderr += String(d);
        });
        const badExitCode = await new Promise((resolve) => {
          badChild.on('exit', (code) => resolve(code));
        });
        assert.equal(badExitCode, 1, 'Expected staging startup with missing env to exit with code 1');
        assert.ok(badStderr.includes('SERVER_STARTUP_REJECTED'));

        // 4b. Spawn child process with valid explicit staging env -> starts in postgres mode without SQLite fallback
        const port = await reserveLoopbackPort();
        const validStgEnv = buildValidStagingEnvOverrides({
          CVE_PUBLIC_BASE_URL: `https://staging-video.creativanta.internal:${port}/v1`,
          HOST: '127.0.0.1',
        });

        const stgChild = spawn(process.execPath, ['packages/api/dist/index.js'], {
          cwd: this.repoRoot,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            ...validStgEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stgStdout = '';
        let stgExited = false;
        stgChild.stdout.on('data', (d) => {
          stgStdout += String(d);
        });
        stgChild.on('exit', () => {
          stgExited = true;
        });

        try {
          const baseUrl = `http://127.0.0.1:${port}`;
          let alive = false;
          for (let i = 0; i < 60; i++) {
            if (stgExited) break;
            try {
              const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(300) });
              if (res.status === 200) {
                alive = true;
                break;
              }
            } catch {
              // Wait for child process bind
            }
            await delay(100);
          }
          assert.equal(alive, true, 'Staging API child process failed to expose /healthz');

          const startedLine = stgStdout
            .split('\n')
            .find((line) => line.includes('"event":"SERVER_STARTED"'));
          assert.ok(startedLine, 'Expected SERVER_STARTED structured log line');
          const startedEvent = JSON.parse(startedLine);
          assert.equal(startedEvent.environment, 'staging');
          assert.equal(startedEvent.backend_mode, 'postgres');
          assert.equal(startedEvent.non_production_test_only, false);
          assert.equal(startedEvent.repository_configured, false);
          assert.equal(startedEvent.postgres_driver_compatible, false);

          // Verify GET /readyz fails closed (503) in staging postgres mode without repository
          const readyzRes = await fetch(`${baseUrl}/readyz`);
          assert.equal(readyzRes.status, 503);
          const readyzBody = await readyzRes.json();
          assert.equal(readyzBody.status, 'not_ready');
          assert.equal(readyzBody.reason, 'TENANT_REPOSITORY_NOT_CONFIGURED');
          assert.equal(readyzBody.checks.database, 'unavailable');
          assert.equal(readyzBody.checks.storage, 'unverified');
          assert.equal(readyzBody.checks.renderer, 'unverified');

          // Without a Postgres-backed repository wired, tenant-scoped /v1/templates is not mounted (404 NOT_FOUND, no fake SQLite fallback!)
          const templatesRes = await fetch(`${baseUrl}/v1/templates`, {
            headers: {
              Authorization: 'Bearer cve_live_0123456789ab_' + 'a'.repeat(64),
            },
          });
          assert.equal(templatesRes.status, 404);
          const templatesErr = await templatesRes.json();
          assert.equal(templatesErr.error.code, 'NOT_FOUND');

          return {
            invalidStagingRejectedWithExit1: true,
            validStagingStartedInPostgresMode: true,
            repositoryConfiguredInStaging: startedEvent.repository_configured,
            readyzHttpStatus: readyzRes.status,
            readyzReason: readyzBody.reason,
            authenticatedRouteHttpStatus: templatesRes.status,
          };
        } finally {
          if (!stgExited) stgChild.kill('SIGTERM');
          for (let i = 0; i < 30 && !stgExited; i++) {
            await delay(100);
          }
          if (!stgExited) stgChild.kill('SIGKILL');
        }
      },
    );

    // -------------------------------------------------------------------------
    // Check 5: Real Child-Process Isolated SQLite-Test-Only Two-Tenant HTTP Loopback + Live /readyz Probe Execution
    // -------------------------------------------------------------------------
    await runCheck(
      'P10A-PROC-SQLITE-TEST-05',
      'Real child-process API startup in CVE_BACKEND_MODE=sqlite-test-only executes wired readinessProbe on GET /readyz and enforces two-tenant RLS/anti-IDOR over loopback HTTP',
      async () => {
        const port = await reserveLoopbackPort();
        const baseUrl = `http://127.0.0.1:${port}`;
        const testPepper = 'p10a_test_only_sqlite_pepper_secret_32bytes_min!';
        const tenantAId = '11111111-1111-4111-8111-111111111111';
        const tenantBId = '22222222-2222-4222-8222-222222222222';

        // Ephemeral loopback S3 & worker readiness servers to prove the child process
        // actually executes backend.readinessProbe when GET /readyz is requested.
        let s3HeadHits = 0;
        let workerReadyHits = 0;
        const probeTargetServer = http.createServer((req, res) => {
          if (req.method === 'HEAD' && req.url === '/cve-quarantine-dev') {
            s3HeadHits++;
            res.writeHead(200);
            res.end();
            return;
          }
          if (req.method === 'GET' && req.url === '/worker-readyz') {
            workerReadyHits++;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ready', adapter: 'chromium-frame-v1' }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        await new Promise((resolve) => probeTargetServer.listen(0, '127.0.0.1', resolve));
        const probeTargetPort = probeTargetServer.address().port;

        const keyMatA = generateApiKeyMaterial({
          environment: 'test',
          pepper: testPepper,
        });
        const keyMatB = generateApiKeyMaterial({
          environment: 'test',
          pepper: testPepper,
        });

        // Pass ONLY pre-hashed keyPrefix + keyHash to child process env (no plaintext keys in env!)
        const bootstrapTenantsJson = JSON.stringify([
          {
            tenantId: tenantAId,
            name: 'P10-A Test Tenant Alpha',
            keyId: 'key_alpha_01',
            keyPrefix: keyMatA.keyPrefix,
            keyHash: keyMatA.keyHash,
            pepperVersion: keyMatA.pepperVersion,
            scopes: [...ALL_API_SCOPES],
          },
          {
            tenantId: tenantBId,
            name: 'P10-A Test Tenant Beta',
            keyId: 'key_beta_01',
            keyPrefix: keyMatB.keyPrefix,
            keyHash: keyMatB.keyHash,
            pepperVersion: keyMatB.pepperVersion,
            scopes: [...ALL_API_SCOPES],
          },
        ]);

        const child = spawn(process.execPath, ['packages/api/dist/index.js'], {
          cwd: this.repoRoot,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? '',
            CVE_ENV: 'development',
            CVE_BACKEND_MODE: 'sqlite-test-only',
            CVE_PUBLIC_BASE_URL: `${baseUrl}/v1`,
            HOST: '127.0.0.1',
            CVE_API_KEY_PEPPER: testPepper,
            CVE_STORAGE_ENDPOINT: `http://127.0.0.1:${probeTargetPort}`,
            CVE_RENDER_IMAGE_DIGEST: VALID_PINNED_DIGEST,
            CVE_WORKER_READINESS_URL: `http://127.0.0.1:${probeTargetPort}/worker-readyz`,
            CVE_TEST_BOOTSTRAP_TENANTS_JSON: bootstrapTenantsJson,
            CVE_CUSTOM_CODE_ENABLED: 'false',
            CVE_CUSTOM_RUNTIME: 'disabled',
            CVE_REMOTE_IMPORT_ENABLED: 'false',
            CVE_TTS_PROVIDER: 'disabled',
            CVE_AUTHORING_PROVIDER: 'disabled',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let childExited = false;
        child.stdout.on('data', (d) => {
          stdout += String(d);
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
          assert.equal(alive, true, 'sqlite-test-only child process failed to expose /healthz');

          const startedLine = stdout
            .split('\n')
            .find((line) => line.includes('"event":"SERVER_STARTED"'));
          assert.ok(startedLine);
          const startedEvent = JSON.parse(startedLine);
          assert.equal(startedEvent.backend_mode, 'sqlite-test-only');
          assert.equal(startedEvent.non_production_test_only, true);
          assert.equal(startedEvent.repository_configured, true);
          assert.equal(startedEvent.seeded_test_tenants_count, 2);

          // 0. Verify GET /readyz executes the wired readinessProbe callback (hitting live loopback S3 + worker)
          // while keeping database: 'unavailable' (503 DEPENDENCY_UNAVAILABLE) so sqlite-test-only never false-greens.
          const readyzRes = await fetch(`${baseUrl}/readyz`);
          assert.equal(readyzRes.status, 503);
          const readyzBody = await readyzRes.json();
          assert.equal(readyzBody.status, 'not_ready');
          assert.equal(readyzBody.reason, 'DEPENDENCY_UNAVAILABLE');
          assert.equal(readyzBody.checks.database, 'unavailable');
          assert.equal(readyzBody.checks.storage, 'ok');
          assert.equal(readyzBody.checks.renderer, 'ok');
          assert.equal(s3HeadHits, 1, 'Expected GET /readyz to invoke S3 HEAD probe callback');
          assert.equal(workerReadyHits, 1, 'Expected GET /readyz to invoke worker readiness probe callback');

          // 1. Unauthenticated GET /v1/templates -> 401
          const unauthRes = await fetch(`${baseUrl}/v1/templates`);
          assert.equal(unauthRes.status, 401);

          // 2. Authenticated Tenant A lists curated templates (`tpl_promo_starter`)
          const listTplRes = await fetch(`${baseUrl}/v1/templates`, {
            headers: { Authorization: `Bearer ${keyMatA.plaintextKey}` },
          });
          assert.equal(listTplRes.status, 200);
          const listTplBody = await listTplRes.json();
          assert.ok(
            listTplBody.data.some(
              (t) =>
                t.id === 'tpl_promo_starter' &&
                (t.visibility === 'curated' || t.visibility === 'curated_public'),
            ),
            'Expected curated starter template in GET /v1/templates response',
          );

          // 3. Tenant A instantiates `tpl_promo_starter` into a composition
          const instRes = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${keyMatA.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem-p10a-inst-001',
            },
            body: JSON.stringify({
              template_revision: 1,
              name: 'Khuyến mãi P10-A',
              variables: {
                headline: 'Ưu đãi Kiểm thử P10-A',
              },
              locale: 'vi-VN',
            }),
          });
          assert.equal(instRes.status, 201);
          const instBody = await instRes.json();
          assert.ok(instBody.id);

          // 4. Tenant A submits an idempotent render job and verifies replay
          const jobPayload = JSON.stringify({
            composition_id: instBody.id,
            revision: 1,
            profile: 'mp4-720p-v1',
            client_reference: 'p10a-real-process-job-01',
          });
          const jobRes1 = await fetch(`${baseUrl}/v1/render-jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${keyMatA.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem-p10a-job-001',
            },
            body: jobPayload,
          });
          assert.equal(jobRes1.status, 202);
          const job1 = await jobRes1.json();

          const jobRes2 = await fetch(`${baseUrl}/v1/render-jobs`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${keyMatA.plaintextKey}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': 'idem-p10a-job-001',
            },
            body: jobPayload,
          });
          assert.equal(jobRes2.status, 202);
          assert.equal(jobRes2.headers.get('idempotency-replayed'), 'true');
          const job2 = await jobRes2.json();
          assert.equal(job1.id, job2.id);

          // 5. Cross-tenant isolation: Tenant B attempting to GET Tenant A's composition or job receives 404 NOT_FOUND
          const crossCompRes = await fetch(`${baseUrl}/v1/compositions/${instBody.id}`, {
            headers: { Authorization: `Bearer ${keyMatB.plaintextKey}` },
          });
          assert.equal(crossCompRes.status, 404);

          const crossJobRes = await fetch(`${baseUrl}/v1/jobs/${job1.id}`, {
            headers: { Authorization: `Bearer ${keyMatB.plaintextKey}` },
          });
          assert.equal(crossJobRes.status, 404);

          return {
            nonProductionTestOnly: startedEvent.non_production_test_only,
            readyzHttpStatus: readyzRes.status,
            readyzReason: readyzBody.reason,
            readyzChecks: readyzBody.checks,
            readyzCallbackProbedStorageAndWorker: s3HeadHits === 1 && workerReadyHits === 1,
            curatedTemplatesListed: listTplBody.data.length,
            compositionInstantiated: instBody.id,
            renderJobQueuedAndReplayed: job1.id,
            crossTenantCompositionStatus: crossCompRes.status,
            crossTenantJobStatus: crossJobRes.status,
          };
        } finally {
          if (!childExited) child.kill('SIGTERM');
          for (let i = 0; i < 30 && !childExited; i++) {
            await delay(100);
          }
          if (!childExited) child.kill('SIGKILL');
          await new Promise((resolve) => probeTargetServer.close(resolve));
        }
      },
    );

    const passedChecks = checks.filter((c) => c.passed).length;
    return {
      taskId: 'P10-A',
      issueId: '#65',
      parentIssueId: '#63',
      status: passedChecks === checks.length ? 'PASS' : 'FAIL',
      stagingDeploymentReadyForTraffic: false,
      productionReleaseAuthorized: false,
      gaExternalGatesStatus: 'HOLD_ISSUE_61',
      totalChecks: checks.length,
      passedChecks,
      failedChecks: checks.length - passedChecks,
      durationMs: Date.now() - startedAt,
      checks,
      evaluatedAt: new Date().toISOString(),
    };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const verifier = new StagingBackendVerifier();
  const report = await verifier.runAll();
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'PASS') {
    process.exitCode = 1;
  }
}
