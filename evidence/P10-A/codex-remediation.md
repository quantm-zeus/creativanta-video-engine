# P10-A Independent Codex Review Remediation Evidence (`cdfd980` → Post-Merge Remediation)

Remediation report for independent Codex review findings on commit `cdfd9806ee017eaff81e109e50fb8a05d3fac4fa` (`agy/p10-backend-real-staging`, GitHub issue `#65`, parent `#63`). After merging `origin/staging` (`121d97b785c939ff4cbc20b62a2e1ae390ba039c`, including PR `#64` commit `100b9113a558a76af093c3addc722b6b6c09f232` via merge commit `96a6995ab6c9b4e3567371722e8f15202dc170fe`), all three actionable defects identified by Codex were resolved and verified with executable unit, child-process, and isolated container-layout regression tests.

## 1. Mandatory Machine-Verifiable Evidence Block

```text
Task: P10-A
Base / tested commit: 96a6995ab6c9b4e3567371722e8f15202dc170fe / 96a6995ab6c9b4e3567371722e8f15202dc170fe
Environment: Linux x86_64, evergreen worktree (.worktrees/p10-backend), Node v24.22.2, pnpm v12.16.1, Python 3.12.3
Command: pnpm -r --if-present lint && pnpm -r --if-present typecheck && pnpm -r --if-present build && pnpm -r --if-present test && node --test ops/test/*.test.mjs && pnpm health && pnpm smoke:api-runtime && node ops/staging/staging-backend-verifier.mjs && python3 scripts/validate_repo.py && git diff --check
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-07T05:18:14Z / 274.0s
Artifacts:
  - packages/api/src/index.ts, sha256=f66eaa11b1577f6230b3e101776722303318aa1cd497ef58142e43696cde0d49, expires=N/A (repo-versioned)
  - packages/api/src/db/backend-bootstrap.ts, sha256=ab29cf81733215bfeff23f4c0484701cd969dc2b867ec1295370e6730a14cf30, expires=N/A (repo-versioned)
  - packages/api/src/db/migration-runner.ts, sha256=384ada2639db995a4c67ad9794310b2164169ea17295553539c45c5b3fc81f1f, expires=N/A (repo-versioned)
  - docker/Dockerfile.api, sha256=b056a01dbfda71a2d1f7efc33b20b6137cd647b715f902a59eec1fde7e87bf04, expires=N/A (repo-versioned)
  - docker/staging/docker-compose.staging-isolated.yml, sha256=1a80fe2bdc4fca5165c83e9b04bfe855d748edeb8e7d99f3fe8be9f45da69f25, expires=N/A (repo-versioned)
  - packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs, sha256=5fbff49eea4d296ec10f5d83191fc63b4f887fc5dfb1e696ea79254407629347, expires=N/A (repo-versioned)
  - ops/staging/staging-backend-verifier.mjs, sha256=e1d551f949ba9f8824380c24908fd032b5cdd0ddb71fff9c5242a26f7aa7397e, expires=N/A (repo-versioned)
  - evidence/P10-A/backend-verification-summary.json, sha256=0ba9988a20a2dc697aefb8849c23f64adf754a356a71555ad50c1e1352de57f6, expires=N/A (repo-versioned)
Acceptance mapping:
  - Codex P1 (Wire readinessProbe callback into HTTP GET /readyz and prove via real child-process tests): PASS — Merged origin/staging (PR #64), removed intersection type workaround in packages/api/src/index.ts, and added real child-process & startApiServer HTTP /readyz tests in packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs and ops/staging/staging-backend-verifier.mjs
  - Codex P1 (Package read-only migrations/ into docker/Dockerfile.api and staging compose, reconcile path resolution, and verify via isolated /app container layout test): PASS — Updated docker/Dockerfile.api (builder + runner read-only 0555/0444), docker/staging/docker-compose.staging-isolated.yml, and packages/api/src/db/migration-runner.ts; verified via isolated /tmp/.../app container layout test
  - Codex P2 (Buffer fragmented PostgreSQL v3 wire responses with frame-length semantics, max input bounds, deadline, and listener cleanup): PASS — Implemented incremental buffering up to PG_WIRE_MAX_BUFFER_BYTES (8193 bytes) in packages/api/src/db/backend-bootstrap.ts; verified 1-byte and 2-chunk splits, oversized, short, truncated, and timed-out cases
Reviewer / reviewed commit / decision: pending independent reviewer / 96a6995ab6c9b4e3567371722e8f15202dc170fe / local completion awaiting review
```

## 2. Exact Codex Findings, Fixes, and Verification Proof

### Finding 1 (Codex P1): Wire the readiness callback into HTTP handler

- **Defect on `cdfd980`:** `agy/p10-backend-real-staging` was branched from `f37bf5f` prior to PR `#64` (`100b911` / `121d97b`). In [index.ts](../../packages/api/src/index.ts), `startApiServer` and `main` passed `readinessProbe` using an intersection type (`CreateServerOptions & { readinessProbe?: ... }`), while the pre-PR `#64` [server.ts](../../packages/api/src/server.ts) ignored `readinessProbe` and returned false-green HTTP `200` on `GET /readyz`. Furthermore, `P10-A`'s tests had only called `handle.backend.readinessProbe()` directly in-memory rather than asserting `GET /readyz` over HTTP on the child process.
- **Remediation:**
  1. Merged `origin/staging` (`121d97b`) via a normal non-force merge (`96a6995`), bringing in PR `#64`'s [server.ts](../../packages/api/src/server.ts) (`CreateServerOptions.readinessProbe` and fail-closed `GET /readyz`) and [readiness-gates.test.mjs](../../packages/api/test/readiness-gates.test.mjs) unmodified.
  2. Removed the intersection type workaround in [index.ts](../../packages/api/src/index.ts#L83-L92) and [index.ts](../../packages/api/src/index.ts#L155-L162) so `serverOptions` is typed directly as `CreateServerOptions` and passes `readinessProbe: backend.readinessProbe` into `createServer(serverOptions)`.
  3. Verified HTTP `GET /readyz` across all three backend modes:
     - `CVE_BACKEND_MODE=unconfigured`: `repository` is `undefined` → `GET /readyz` returns HTTP `503` with `reason: "TENANT_REPOSITORY_NOT_CONFIGURED"` and `checks: { database: "unavailable", storage: "unverified", renderer: "unverified" }`.
     - `CVE_BACKEND_MODE=postgres` (`CVE_ENV=staging`): `repository` is `undefined` (no silent SQLite fallback) → `GET /readyz` on the real child process returns HTTP `503` with `reason: "TENANT_REPOSITORY_NOT_CONFIGURED"` (`P10A-PROC-STAGING-04` in [staging-backend-verifier.mjs](../../ops/staging/staging-backend-verifier.mjs#L422-L431)).
     - `CVE_BACKEND_MODE=sqlite-test-only` (`CVE_ENV=development`): `repository` is initialized and `readinessProbe` is wired → in `P10A-PROC-SQLITE-TEST-05` ([staging-backend-verifier.mjs](../../ops/staging/staging-backend-verifier.mjs#L533-L545)), `GET /readyz` on the real child process invokes `backend.readinessProbe()`, executing live HTTP probes against loopback S3 (`s3HeadHits === 1`) and worker readiness (`workerReadyHits === 1`) servers and returning HTTP `503` with `reason: "DEPENDENCY_UNAVAILABLE"` and `checks: { database: "unavailable", storage: "ok", renderer: "ok" }`. In [p10-a-backend-bootstrap-and-probes.test.mjs](../../packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs#L537-L614), `startApiServer` with `allowTestSqliteReadinessProbe: true` transitions from HTTP `200` (`status: "ready"`) when all three probes succeed to HTTP `503` (`reason: "DEPENDENCY_UNAVAILABLE"`) when storage degrades. Both tests would fail immediately if `readinessProbe` were ignored or if an unbacked server returned false-green `200`.

### Finding 2 (Codex P1): Package migration files required by startup audit

- **Defect on `cdfd980`:** [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts) audits `<root>/migrations/` on startup via `evaluatePostgresDriverAndRlsReadiness()`, but [Dockerfile.api](../../docker/Dockerfile.api) never copied `migrations/` into `/app/migrations` in the `builder` or `runner` stages, and [docker-compose.staging-isolated.yml](../../docker/staging/docker-compose.staging-isolated.yml) only mounted `migrations` into `staging-postgres`. Additionally, `auditPostgresMigrations()` in [migration-runner.ts](../../packages/api/src/db/migration-runner.ts) called `fs.readFileSync` on `manifest.json` without checking existence first, throwing raw `ENOENT` instead of returning a structured `MigrationAuditReport` (`valid: false`) that maps to `BackendBootstrapError('MIGRATION_AUDIT_FAILED')`.
- **Remediation:**
  1. Updated [Dockerfile.api](../../docker/Dockerfile.api#L10-L39) to copy `migrations` in `builder` (`COPY migrations ./migrations`), copy it into `runner` (`COPY --from=builder /app/migrations ./migrations`), and lock permissions read-only (`RUN chmod 0555 /app/migrations && chmod 0444 /app/migrations/*`) before `USER node`.
  2. Updated [docker-compose.staging-isolated.yml](../../docker/staging/docker-compose.staging-isolated.yml#L54-L55) so `staging-api` also mounts `- ../../migrations:/app/migrations:ro`.
  3. Reconciled `resolveDefaultMigrationsDir(rawEnv)` and `auditPostgresMigrations()` in [migration-runner.ts](../../packages/api/src/db/migration-runner.ts#L117-L246) and [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts#L1386-L1395) to honor `CVE_MIGRATIONS_DIR`, check `<moduleRoot>/../../../../migrations` (`/app/migrations` in container or `<repo>/migrations` in checkout) and `<cwd>/migrations`, and return `{ valid: false, errors: [...] }` cleanly when migration files are missing.
  4. Added an executable container-layout regression test in [p10-a-backend-bootstrap-and-probes.test.mjs](../../packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs#L616-L793) that parses `COPY --from=builder` directives from `Dockerfile.api`'s `runner` stage, materializes a standalone `/tmp/.../app` directory outside the repository tree, enforces `0555`/`0444` read-only permissions on `/app/migrations`, and spawns `node packages/api/dist/index.js` with `cwd: /tmp/.../app`. It verifies both successful startup (`/healthz` `200`, `/readyz` `503`) and fail-closed rejection (`exit 1`, `error_code: "MIGRATION_AUDIT_FAILED"`) when `/app/migrations` is removed.

### Finding 3 (Codex P2): Buffer fragmented PostgreSQL responses before validating

- **Defect on `cdfd980`:** `probePostgresConnectivity()` in [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts) attached a single `socket.once('data', ...)` callback and checked `chunk.byteLength >= 5` on the first TCP packet alone, causing false `INVALID_WIRE_RESPONSE` failures whenever the 5-byte PostgreSQL header or frame body was split across TCP segments, without checking the 4-byte `Int32BE` frame length field or enforcing an upper buffer bound.
- **Remediation:**
  1. Implemented bounded incremental PG v3 wire frame collection in [backend-bootstrap.ts](../../packages/api/src/db/backend-bootstrap.ts#L559-L837) with exported constants `PG_WIRE_HEADER_BYTES = 5`, `PG_WIRE_MIN_FRAME_LENGTH = 5`, `PG_WIRE_MIN_AUTH_FRAME_LENGTH = 8`, `PG_WIRE_MAX_FRAME_LENGTH = 8192`, and `PG_WIRE_MAX_BUFFER_BYTES = 8193`.
  2. The probe now:
     - Validates the initial message type byte (`'R'`=`0x52`, `'E'`=`0x45`, `'N'`=`0x4e`) as soon as 1 byte arrives.
     - Enforces `PG_WIRE_MAX_BUFFER_BYTES` prior to buffering each chunk, rejecting oversized streams immediately with `INVALID_WIRE_RESPONSE`.
     - Accumulates chunks until all 5 header bytes (`1`-byte tag + `4`-byte `Int32BE` length) arrive, validates `frameLength` bounds (`[8, 8192]` for `'R'`, `[5, 8192]` for `'E'`/`'N'`), and waits until the complete frame (`1 + frameLength` total bytes) is buffered before reporting `wireProtocolVerified: true`.
     - Treats premature EOF/close after partial bytes as `INVALID_WIRE_RESPONSE`, enforces the overall `timeoutMs` deadline (`TCP_CONNECT_TIMEOUT`), and detaches all socket listeners (`connect`, `data`, `end`, `close`, `error`) via `cleanupListeners()` before writing `Terminate` (`'X'`) and destroying the socket.
  3. Added regression tests in [p10-a-backend-bootstrap-and-probes.test.mjs](../../packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs#L420-L535) and [staging-backend-verifier.mjs](../../ops/staging/staging-backend-verifier.mjs#L252-L315) covering:
     - Nine 1-byte TCP chunks for a 9-byte `'R'` `AuthenticationCleartextPassword` frame (`PASS`, `wireProtocolVerified: true`).
     - Two-chunk split (2-byte partial header + 11-byte remainder) for a 13-byte `'E'` `ErrorResponse` frame (`PASS`, `wireProtocolVerified: true`).
     - Oversized header (`frameLength > PG_WIRE_MAX_FRAME_LENGTH`) and oversized stream (`> PG_WIRE_MAX_BUFFER_BYTES`) (`PASS`, rejected with `INVALID_WIRE_RESPONSE`).
     - Short frame length (`'R'` with `frameLength = 4 < 8`) and truncated mid-header close (`PASS`, rejected with `INVALID_WIRE_RESPONSE`).
     - Mid-frame stall exceeding `timeoutMs` (`PASS`, rejected with `TCP_CONNECT_TIMEOUT`).

## 3. Executed Verification Commands & Candid Status Matrix

| Check | Exact Command | Status | Exit Code / Notes |
| --- | --- | --- | --- |
| Workspace Lint | `pnpm -r --if-present lint` | `PASS` | `0` across all 8 workspace packages |
| Workspace Typecheck | `pnpm -r --if-present typecheck` | `PASS` | `0` across all 8 workspace packages |
| Workspace Build | `pnpm -r --if-present build` | `PASS` | `0` across all 8 workspace packages |
| Workspace Unit & Integration Tests | `pnpm -r --if-present test` | `PASS` | `0` across all 8 workspace packages (including `readiness-gates.test.mjs`, `server.test.mjs`, and 9/9 tests in `p10-a-backend-bootstrap-and-probes.test.mjs`) |
| Operations & Security Suites | `node --test ops/test/*.test.mjs` | `PASS` | `0` (`72/72` tests across 21 suites, including `SBOM-01` `externalRuntimeDependenciesCount === 0`) |
| Synthetic Health Contract Check | `pnpm health` | `PASS` | `0` (`/healthz` `200`, unbacked `/readyz` `503 TENANT_REPOSITORY_NOT_CONFIGURED`) |
| Real Process Fail-Closed Smoke (PR `#64`) | `pnpm smoke:api-runtime` | `PASS` | `0` (`PASS_FAIL_CLOSED`, `/healthz` `200`, `/readyz` `503 TENANT_REPOSITORY_NOT_CONFIGURED`) |
| P10-A Staging Backend Verifier | `node ops/staging/staging-backend-verifier.mjs` | `PASS` | `0` (`5/5` checks passed: `P10A-ENV-01` through `P10A-PROC-SQLITE-TEST-05`) |
| Repository Docs/Contracts Validator | `python3 scripts/validate_repo.py` | `PASS` | `0` (`16` required docs, `80` markdown files, `0` errors) |
| Git Diff Whitespace/Conflict Check | `git diff --check` | `PASS` | `0` (clean diff) |
| Live PostgreSQL `TenantRepository` & Host Staging E2E | N/A (architectural driver blocker + host boundary) | `BLOCKED` | `TenantConnectionPool` and `TenantRepository` remain synchronous `node:sqlite` (`DatabaseSync`); no async PostgreSQL driver is installed or wired |
| External GA Release Gates (Issue `#61`) | N/A (requires external human/legal/infra sign-off) | `BLOCKED` | Issue `#61` remains `OPEN` (`HOLD`); production release is **not** authorized |

## 4. Unresolved Real PostgreSQL Adapter & GA Release Blockers

1. **Synchronous `node:sqlite` Repository Binding:** [tenant-pool.ts](../../packages/api/src/db/tenant-pool.ts) and [repository.ts](../../packages/api/src/db/repository.ts) remain bound to synchronous `DatabaseSync` (`node:sqlite`), and `pnpm-lock.yaml` has zero external PostgreSQL runtime packages (`externalRuntimeDependenciesCount === 0`). Until a reviewed async PostgreSQL driver and async `TenantRepository` are implemented, `CVE_BACKEND_MODE=postgres` truthfully sets `repository: undefined` and `readyForTraffic: false` (`503` on `/readyz`).
2. **Real Multi-Service Staging Deployment (`P10-B` / `#62` / `#63`):** Live non-mock two-tenant E2E across a provisioned PostgreSQL 16 instance, S3-compatible object storage, renderer worker container sandbox, and webhook receiver remains blocked on the async PostgreSQL repository adapter and operator-provisioned staging services.
3. **GA Hold Issue `#61`:** Remains `OPEN` (`HOLD`) pending the six external gates (production deployment approval, Creativanta integration credentials, H.264/AAC codec commercial review, DPA/data residency sign-off, Firecracker microVM host isolation, and physical browser/device verification).
