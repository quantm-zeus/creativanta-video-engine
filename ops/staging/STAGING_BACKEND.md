# Isolated Staging Backend Bootstrap, Connectivity Probes, and Driver Compatibility Runbook (P10-A)

This operational runbook documents the `P10-A` backend and staging infrastructure slice (GitHub issue `#65`, parent `#63`). It complements [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), [docs/SECURITY.md](../../docs/SECURITY.md), and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) without authorizing production deployment or overriding the six external GA hold gates tracked in issue `#61`.

## 1. Verified Defect & Scope Boundary

Prior to `P10-A`, the API service entrypoint [index.ts](../../packages/api/src/index.ts) invoked `createServer({ config })` without a `TenantRepository`, `QuarantineStore`, or backend bootstrap lifecycle:

- Every authenticated endpoint (`/v1/templates`, `/v1/compositions`, `/v1/assets/*`, `/v1/render-jobs`, `/v1/previews`, `/v1/jobs/*`, `/v1/webhook-endpoints`, `/v1/usage`) was unavailable when running `node packages/api/dist/index.js`.
- The preexisting [staging-smoke-runner.mjs](../release/staging-smoke-runner.mjs) exercised `CreativantaContractMock` in-memory rather than the compiled API process, and [p4-07-e2e-two-tenant-g3-verification.test.mjs](../../packages/api/test/p4-07-e2e-two-tenant-g3-verification.test.mjs) ran against an in-process `node:sqlite` instance.
- Separately, PR `#64` (`ops/api-readiness-fail-closed-20261106`) updates [server.ts](../../packages/api/src/server.ts) so `/readyz` fails closed (`503`) unless both `repository` and `readinessProbe` are wired and healthy.

`P10-A` implements the backend bootstrap, fail-closed environment validator, driver compatibility evaluator, and bounded protocol connectivity probes in [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts) and wires them into [index.ts](../../packages/api/src/index.ts) while preserving clean compatibility with PR `#64`.

## 2. Backend Modes (`CVE_BACKEND_MODE`)

[backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts) resolves one of three explicit modes via `resolveBackendMode(config, rawEnv)`:

| `CVE_BACKEND_MODE` | Allowed `CVE_ENV` | `repository` Wired? | Purpose & Readiness Behavior |
| --- | --- | --- | --- |
| `unconfigured` (default in `development`) | `development` only | `false` (`undefined`) | Default unconfigured development process startup; `/readyz` fails closed (`503 TENANT_REPOSITORY_NOT_CONFIGURED`). |
| `postgres` (mandatory in `staging` / `production`) | `development`, `staging`, `production` | `false` (`undefined` until async PG driver is implemented) | Enforces strict staging env validation, audits 21-table PostgreSQL RLS migrations, and wires bounded PostgreSQL v3 wire, S3 SigV4, and worker readiness probes. Remains `503` (no silent fallback to SQLite). |
| `sqlite-test-only` | `development` only (**blocked** in `staging`/`production`) | `true` (`DatabaseSync` + `MigrationRunner`) | Explicitly labeled `nonProductionTestOnly: true` for isolated real-process HTTP loopback tests. Seeds only pre-hashed `cve_test_<12hex>` API key digests (`PLAINTEXT_API_KEY_IN_ENV_FORBIDDEN`) and keeps `/readyz` fail-closed (`database: false`) by default. |

## 3. Fail-Closed Staging Environment Guard

`validateBackendStartupEnv(config, rawEnv)` in [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts) rejects startup (`SERVER_STARTUP_REJECTED`, exit code `1`) before binding a port if any of the following conditions occur:

1. **Unsafe Capability Flags:** `CVE_CUSTOM_CODE_ENABLED` is not `false`, `CVE_CUSTOM_RUNTIME` is not `'disabled'`, `CVE_REMOTE_IMPORT_ENABLED` is not `false`, `CVE_TTS_PROVIDER` is not `'disabled'`, or `CVE_AUTHORING_PROVIDER` is not `'disabled'`.
2. **Missing Explicit Staging Variables:** When `CVE_ENV` is `staging` or `production` (or `CVE_BACKEND_MODE=postgres`), all 12 required variables in [staging.env.example](../../docker/staging/staging.env.example) must be explicitly provided in the environment; the bootstrap layer refuses to inherit `loadEnvConfig()` development fallbacks.
3. **Default or Placeholder Secrets:** Rejects `cve_dev_*`, `minioadmin`, `staging_redacted`, `dev_pepper_*`, `dev-kms-local-key-1`, passwords shorter than 16 characters, peppers shorter than 32 bytes, and all-zero `CVE_RENDER_IMAGE_DIGEST` (`sha256:0000...`).
4. **Least-Privilege Runtime Database Role:** Requires `CVE_DATABASE_URL` to authenticate as `cve_api` (`NOBYPASSRLS`). Rejects `cve_migrator`, `postgres`, `cve_dispatcher`, `cve_ingest`, `cve_sender`, or reuse of `CVE_MIGRATION_DATABASE_URL`.
5. **Transport & Bucket Segregation:** Requires `https://` for `CVE_PUBLIC_BASE_URL` and `CVE_STORAGE_ENDPOINT`, and requires `CVE_QUARANTINE_BUCKET`, `CVE_ASSET_BUCKET`, and `CVE_ARTIFACT_BUCKET` to be three distinct bucket names without `-dev` suffixes.

## 4. `node:sqlite` vs PostgreSQL Driver Incompatibility Assessment

`evaluatePostgresDriverAndRlsReadiness()` audits [manifest.json](../../migrations/manifest.json) and [0001_tenant_foundation.up.sql](../../migrations/0001_tenant_foundation.up.sql) (`21/21` tables with `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`, composite `tenant_id` primary/foreign keys, `current_setting('app.current_tenant_id', true)` transaction-local context, and 5 segregated service roles) and truthfully reports why `TenantRepository` cannot yet serve live PostgreSQL traffic:

- [tenant-pool.ts](../../packages/api/src/db/tenant-pool.ts) wraps synchronous `DatabaseSync` from `node:sqlite` and executes synchronous `withTransaction<T>()` callbacks with `BEGIN IMMEDIATE` and `?` positional parameter bindings.
- [repository.ts](../../packages/api/src/db/repository.ts) (5,758 lines) and [server.ts](../../packages/api/src/server.ts) invoke synchronous repository methods on the request thread rather than `async/await` over a PostgreSQL wire-protocol pool.
- Zero external runtime npm packages (`pg` or `postgres`) are installed in [pnpm-lock.yaml](../../pnpm-lock.yaml), as currently enforced by `SBOM-01` (`externalRuntimeDependenciesCount === 0`) in [sbom-license-codec-auditor.mjs](../security/sbom-license-codec-auditor.mjs).

Consequently, `probePostgresConnectivity()` reports `repositoryDriverCompatible: false` and `readyForTraffic: false` (`reasonCode: 'POSTGRES_DRIVER_NOT_IMPLEMENTED'`) even when the TCP and PostgreSQL v3 wire-protocol `StartupMessage` handshake succeeds.

## 5. Bounded Connectivity Probes

All three dependency probes use Node.js built-in modules with bounded timeouts (`100ms..10000ms`, default `1500ms`) and redact credentials prior to returning diagnostics:

- **`probePostgresConnectivity(databaseUrl, options)`:** Validates the `cve_api` role and migration checksums, opens a TCP socket (`node:net`), sends a PostgreSQL v3.0 `StartupMessage` (`0x00030000`), verifies a valid server response header (`'R'`, `'E'`, or `'N'`), and always transmits a `Terminate` (`'X'`) packet before destroying the socket.
- **`probeObjectStorageConnectivity(config, options)`:** Signs a `HEAD /<CVE_QUARANTINE_BUCKET>` request using AWS Signature Version 4 (`AWS4-HMAC-SHA256`) and sends it with `redirect: 'manual'`. Rejects redirects (`3xx`), auth failures (`401`/`403`), missing buckets (`404`), and timeouts.
- **`probeRendererWorkerReadiness(config, options)`:** Verifies a non-zero pinned `CVE_RENDER_IMAGE_DIGEST` and queries `CVE_WORKER_READINESS_URL` (`redirect: 'manual'`), requiring HTTP `200` with `{ "status": "ready", "adapter": "<configured-adapter>" }`.

## 6. Verification Commands & Staging Compose Templates

- Isolated staging Compose template (no default secrets, loopback-only bind, read-only rootfs, dropped capabilities): [docker-compose.staging-isolated.yml](../../docker/staging/docker-compose.staging-isolated.yml)
- Least-privilege `NOBYPASSRLS` role bootstrap SQL (no hardcoded passwords, no blanket default privileges): [init-staging-roles.sql](../../docker/staging/init-staging-roles.sql)
- Explicit staging environment template: [staging.env.example](../../docker/staging/staging.env.example)
- Real-process backend & probe verifier:

```bash
node ops/staging/staging-backend-verifier.mjs
node --test packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs
```

## 7. Remaining Work & Unresolved Release Gates

`P10-A` does **not** claim live PostgreSQL host E2E or production readiness. Before staging can report `200 OK` on `/readyz` or pass full non-mock deployment smoke:

1. Introduce a reviewed, pinned PostgreSQL client dependency (or async wire adapter) with SPDX license review and update `SBOM-01` in [sbom-license-codec-auditor.mjs](../security/sbom-license-codec-auditor.mjs).
2. Refactor `TenantConnectionPool`, `TenantRepository`, and `server.ts` from synchronous `node:sqlite` calls to `async/await` PostgreSQL transactions using `SET LOCAL app.current_tenant_id`.
3. Provision isolated staging PostgreSQL, S3-compatible object storage buckets, and renderer worker sandboxes with operator-supplied secrets and verify full two-tenant E2E (`P10-B`).
4. Resolve the six external GA hold gates in GitHub issue `#61` (production deployment authorization, Creativanta integration credentials, H.264/AAC commercial rights, data residency/DPA sign-off, Firecracker microVM host isolation, and physical browser/client compatibility).
