# API real-process readiness gate evidence (2026-11-06 UTC)

**Scope:** isolated actual Node child process, loopback-only, with development
placeholders and no external credentials. Source: `scripts/api-real-process-smoke.mjs`.
Data: [api-process-readiness-smoke.json](api-process-readiness-smoke.json).

Repro commands on evergreen:

- `pnpm install --frozen-lockfile`
- `pnpm -r --if-present build`
- `node --test packages/api/test/server.test.mjs packages/api/test/readiness-gates.test.mjs`
- `pnpm smoke:api-runtime`
- `pnpm health`

**Observed:** 200 liveness, 503 readiness with a missing tenant repository,
no false database/storage/renderer success, and disabled custom-code/remote
import. A dependency probe returns 200 only when independently supplied and
all three checks succeed; missing, failing and thrown probes return 503.
Docker healthcheck now uses readiness instead of liveness.

**Release decision: HOLD.** The stock API entrypoint has no tenant repository
wired. This smoke is not an authenticated tenant workflow, real PostgreSQL,
real S3, container sandbox, production rendering or full external E2E.
Do not promote to beta/GA/production until issue
[#62](https://github.com/quantm-zeus/creativanta-video-engine/issues/62),
GA hold [#61](https://github.com/quantm-zeus/creativanta-video-engine/issues/61),
and other security/legal issues have independent verified sign-offs.
