# Codex Review Remediation Report — Task P10-B (GitHub #66, Parent #63)

Independent Codex review remediation for commit `83926d5` on branch `agy/p10-e2e-nonmock` in `/workspace/repo/.worktrees/p10-e2e` (merged with `origin/staging` including PR #64 fail-closed readiness).

> [!IMPORTANT]
> **Boundaries & Release Gate Posture**
> - **Branch**: `agy/p10-e2e-nonmock` (merged with `origin/staging`)
> - **Issue**: GitHub `#66` (parent `#63`), GA release issue `#61` remains **HOLD**.
> - **Live Host Status**: External staging services (`API`, `PostgreSQL`, `S3/MinIO`, `Renderer`) are not running in this environment. Running `node scripts/live-staging-e2e.mjs` fails closed at preflight with `status: "NOT_READY"` and exit code `2` (`HOLD_SERVICES_NOT_DEPLOYED`). No mock server is invoked during CLI execution and no live host E2E pass is claimed.

---

## 1. Summary of 7 Codex Review Findings & Remediations

| # | Severity | Location in `83926d5` | Defect Summary | Remediation Implemented | Regression Tests Added |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **1** | **P1** | `ops/staging/live-e2e.mjs:27-35` | `MINIMAL_STAGING_SCENE_SPEC` was schema-invalid: included forbidden top-level `meta`, lacked required `canvas`, `fps`, `duration_frames`, `seed`, `locale`, `fonts`, `audio_tracks`, `subtitles`, and used invalid layer/scene structures. | Replaced `MINIMAL_STAGING_SCENE_SPEC` with a canonical Scene Spec 1.0 document (`720x1280`, `30/1` fps, `vi-VN`, curated font `ast_font_noto_sans_regular`, `html-v1` scene with valid `shape` and `text` layers, `box`/`transform`/`content`, and `subtitles` with `end_frame`). Added `buildStagingCompositionSpec` (with `svg` layer) and `buildStagingTemplatePayload` (`CreateTemplateRequest`). Updated `LIVE-02`, `LIVE-03`, `LIVE-04`, `LIVE-05`, `LIVE-06` to match exact real API contracts (including `POST /compositions/validate`, `POST /templates`, `POST /templates/{id}/instantiate`, and `Idempotency-Key` on `POST /webhook-endpoints/{id}/verify`). | Suite 7 (`ops/test/live-e2e.test.mjs`): validates `MINIMAL_STAGING_SCENE_SPEC`, `buildStagingCompositionSpec`, and `buildStagingTemplatePayload` against real `@creativanta/contracts` (`validateCompositionSchema`, `SemanticValidator`, `CapabilityValidator`, `validateCompositionUnified`, `compileComposition`), confirms rejection of the legacy invalid spec, and executes an end-to-end contract test against the real `createServer` from `packages/api/dist/index.js`. |
| **2** | **P1** | `ops/staging/media-verify.mjs:217-223` | Invalid MP4, empty `ftyp+moov` without a video stream or `mdat`, or `ffprobe` missing/non-zero exit could still return `valid: true`. | Hardened `inspectMp4Boxes(buffer)` to parse top-level and nested `moov`/`mvhd`/`trak`/`tkhd`/`mdia`/`mdhd`/`hdlr`/`minf`/`stbl`/`stsd`/`stts`/`stsz` boxes, requiring exact box boundaries, a `'vide'` handler track, supported video codec (`avc1`/`h264`/etc.), positive dimensions, `sampleCount > 0`, `durationSeconds > 0`, and non-empty `mdat`. Hardened `verifyArtifactIntegrity(buffer, options)` to fail CLOSED (`valid: false`) when `ffprobe` is missing (`requireFfprobe: true`), exits non-zero, or reports no decodable `'video'` stream, zero decoded frames (`nb_read_frames`), or non-positive duration. | Suite 3 (`ops/test/live-e2e.test.mjs`): tests rejection of empty `ftyp+moov` without video/`mdat`, truncated boxes, non-MP4/short buffers, missing `ffprobe` binary, `ffprobe` non-zero exit status, audio-only streams without video, zero frames, and zero duration. |
| **3** | **P2** | `ops/staging/live-e2e.mjs:540-545` | `LIVE-07` passed when webhook registration failed (`if (!whRes.ok) return 'skipped'`) or by computing a local HMAC string without receiving a real callback, and registered the webhook after jobs had already finished. | Implemented `StagingWebhookReceiver` (ephemeral HTTP callback server bound strictly to loopback/approved private IP) and `verifyWebhookHmacSignature`. Reworked `LIVE-06` to register the webhook endpoint (`POST /webhook-endpoints`), configure the signing secret, and complete the signed challenge handshake (`POST /webhook-endpoints/{id}/verify` with `Idempotency-Key`) BEFORE submitting the render job with `webhook_endpoint_id`. Reworked `LIVE-07` to await the actual delivered `job.succeeded` callback for `renderJobId`, verify `X-CVE-Timestamp` freshness and constant-time `X-CVE-Signature: v1=<hex>` HMAC-SHA256 over the raw body, and report `BLOCKED` / `HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED` (never `PASS`) if callback delivery does not arrive. | Suite 8 (`ops/test/live-e2e.test.mjs`): tests `verifyWebhookHmacSignature` against valid, tampered, and expired signatures; verifies `LIVE-06` fails when registration fails; verifies `LIVE-07` fails on tampered callback HMAC; and verifies `LIVE-07` reports `BLOCKED` / `HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED` when callback delivery is suppressed. |
| **4** | **P2** | `ops/staging/live-e2e.mjs:140-144` | Request and response body reads were unbounded; stalled fetch/poll/upload/download could hang beyond timeout. | Implemented `_fetchRaw` in `ops/staging/live-e2e.mjs` and `fetchJsonBounded` / `readBoundedBuffer` in `ops/staging/preflight.mjs` using per-request `AbortController` timers spanning connection, headers, AND streaming body reads (`res.body.getReader()`), with strict byte caps (`DEFAULT_MAX_JSON_RESPONSE_BYTES = 1 MiB`, `DEFAULT_MAX_DOWNLOAD_BYTES = 64 MiB`, `DEFAULT_MAX_WEBHOOK_BODY_BYTES = 256 KiB`), explicit `REQUEST_TIMEOUT` / `RESPONSE_BODY_TOO_LARGE` errors, and stream/timer cleanup in `finally`. | Suite 9 (`ops/test/live-e2e.test.mjs`): tests stalled response body stream aborting with `REQUEST_TIMEOUT` and oversized JSON responses aborting with `RESPONSE_BODY_TOO_LARGE`. |
| **5** | **P2** | `ops/staging/preflight.mjs:246-252` | Protected capability fields (`custom_code`, `remote_import`, `tts`, `authoring_adapter`) missing or non-boolean were treated as disabled because only `=== true` was checked. | Implemented `validateCapabilitiesInvariants(caps)` in `ops/staging/preflight.mjs` (used in both `PRE-04` and `LIVE-09`). Requires `caps.features` to be a non-null plain object and requires every protected capability flag (`custom_code`, `remote_import`, `tts`, `authoring_adapter`) to be present and strictly boolean `false` (`typeof features[key] === 'boolean' && features[key] === false`). Also updated `PRE-03` to inspect both `readyzData.checks` (`'ok'`) and `readyzData.subsystems` (`true`). | Suite 5 (`ops/test/live-e2e.test.mjs`): tests preflight failure when `features` is missing/null, when any protected key is omitted (`undefined`), or when any protected key has a non-boolean value (`"false"`, `0`, `null`). |
| **6** | **P2** | `ops/staging/live-e2e.mjs:501-505` | Cancellation drill was optional (`if (auxJobRes.ok)`) and only checked HTTP 200/202 without polling terminal state. | Made auxiliary preview job creation mandatory in `LIVE-06` (requires HTTP `202` and job ID), requires `POST /jobs/{id}/cancel` to return `200`/`202` (or marks `BLOCKED` on `404`/`405`/`501`), and polls `GET /jobs/{id}` until terminal state, requiring `state === 'canceled'`. Fails if the job terminates in `'succeeded'` or `'failed'` or times out. | Suite 10 (`ops/test/live-e2e.test.mjs`): tests `LIVE-06` failing when cancellation is ignored and the auxiliary job finishes as `'succeeded'`, and marking `BLOCKED` when `/cancel` returns `501`. |
| **7** | **P2** | `ops/staging/live-e2e.mjs:660-661` | Checked non-existent `operational_jobs` instead of canonical `operational_attempts` and allowed all-zero usage responses to pass. | Captured a baseline `GET /v1/usage` snapshot in `LIVE-01` before job execution and implemented `validateUsageSettlementDelta(baseline, current)` in `LIVE-10`. Requires numeric `operational_attempts`, `billable_output_minutes`, `billable_jobs`, and `reservations.settled_count` to be positive and strictly advance from the baseline (`operational_attempts` delta $\ge 1$, `billable_output_minutes` delta $> 0$, `billable_jobs` delta $\ge 1$, `settled_count` delta $\ge 1$), and requires `reconciliation.clean === true` and `reconciliation.double_debit_detected === false`. | Suite 11 (`ops/test/live-e2e.test.mjs`): tests rejection of all-zero usage, legacy `operational_jobs` without `operational_attempts`, zero deltas from baseline, and unclean reconciliation / double-debit anomalies. |

---

## 2. Detailed Remediation Notes

### Finding 1 [P1] — Canonical Scene Spec 1.0 & Real Contract Validation
- **Root Cause**: `MINIMAL_STAGING_SCENE_SPEC` in `83926d5` used a non-existent `meta` wrapper, omitted required top-level fields (`canvas`, `fps`, `duration_frames`, `seed`, `locale`, `fonts`, `audio_tracks`, `subtitles`), and used non-schema layer properties (`font_size_px` instead of `content.font_size`, `duration_frames` instead of `end_frame` in subtitle cues). Furthermore, `POST /webhook-endpoints/{id}/verify` lacked an `Idempotency-Key` header required by the real API server.
- **Fix**:
  - Updated [ops/staging/live-e2e.mjs](../../ops/staging/live-e2e.mjs) so `MINIMAL_STAGING_SCENE_SPEC`, `buildStagingCompositionSpec`, and `buildStagingTemplatePayload` conform 100% to `packages/contracts/schemas/scene.schema.json`, `SemanticValidator`, `CapabilityValidator` (`mp4-720p-v1`), and `compileComposition`.
  - Added `POST /compositions/validate` verification in `LIVE-02`, `POST /templates` + `POST /templates/{id}/instantiate` in `LIVE-04`, and `Idempotency-Key` on `POST /webhook-endpoints/{id}/verify` in `LIVE-06`.
  - Added direct contract validation tests and a full endpoint-level integration test against the real `createServer` from `packages/api/dist/index.js` in [ops/test/live-e2e.test.mjs](../../ops/test/live-e2e.test.mjs).

### Finding 2 [P1] — MP4 Container & Fail-Closed `ffprobe` Verification
- **Root Cause**: `inspectMp4Boxes` in `83926d5` only checked the first 8 bytes for `ftyp` and scanned top-level box headers without verifying `hasMoov`, `mdat` payload presence, or video track metadata (`trak`/`mdia`/`hdlr` `'vide'`, `stsd` codec, `stsz` sample count, `mvhd` duration). In `verifyArtifactIntegrity`, `probeMp4WithFfprobe` returned `null` when `ffprobe` was absent and never set `result.valid = false` even when `probe.error` was present.
- **Fix**:
  - Rewrote `inspectMp4Boxes` in [ops/staging/media-verify.mjs](../../ops/staging/media-verify.mjs) to parse and validate exact box bounds across top-level boxes and nested `moov` -> `mvhd` + `trak` -> `tkhd` + `mdia` -> `mdhd` + `hdlr` (`vide`) + `minf` -> `stbl` -> `stsd` + `stts` + `stsz`, plus non-empty `mdat`.
  - Updated `verifyArtifactIntegrity` in [ops/staging/media-verify.mjs](../../ops/staging/media-verify.mjs) to fail CLOSED (`result.valid = false`) whenever `ffprobe` is missing (`requireFfprobe: true`), exits non-zero, or fails to report a valid `mp4`/`mov` format and a `'video'` stream with supported codec, positive dimensions, decoded frames (`nb_read_frames > 0`), and positive duration.

### Finding 3 [P2] — Real Loopback Webhook Receiver, Pre-Job Challenge & Signed Delivery Verification
- **Root Cause**: `LIVE-07` in `83926d5` registered a dummy URL after the render job had already finished, returned PASS if registration failed, and only computed a local HMAC over a synthetic string without receiving any callback.
- **Fix**:
  - Added `StagingWebhookReceiver` and `verifyWebhookHmacSignature` in [ops/staging/live-e2e.mjs](../../ops/staging/live-e2e.mjs).
  - Bound the ephemeral HTTP receiver to loopback/approved private staging before running stages.
  - Registered the webhook endpoint and verified its signed challenge handshake (`POST /webhook-endpoints/{id}/verify`) in `LIVE-06` prior to submitting `POST /render-jobs` with `webhook_endpoint_id`.
  - Verified the actual delivered `job.succeeded` callback in `LIVE-07`, checking `X-CVE-Timestamp` freshness and constant-time `X-CVE-Signature: v1=<hex>` HMAC-SHA256 digest over the raw request body. If no callback is delivered within the timeout, raises `StageBlockedError` (`BLOCKED` / `HOLD_WEBHOOK_CALLBACK_NOT_VERIFIED`, never `PASS`).

### Finding 4 [P2] — Per-Request Header/Body Timeouts & Response Byte Caps
- **Root Cause**: `_request`, S3 `PUT`, and artifact `GET` in `83926d5` did not pass an `AbortSignal` or bound response body streaming, allowing stalled responses or oversized payloads to hang or exhaust memory.
- **Fix**:
  - Implemented `_fetchRaw` in [ops/staging/live-e2e.mjs](../../ops/staging/live-e2e.mjs) and `fetchJsonBounded` / `readBoundedBuffer` in [ops/staging/preflight.mjs](../../ops/staging/preflight.mjs) with an `AbortController` timer covering both headers and streamed body reads (`getReader()`), enforcing `maxJsonResponseBytes` (1 MiB) and `maxDownloadBytes` (64 MiB), and cleaning up timers/readers in `finally`.

### Finding 5 [P2] — Fail-Closed Capability Feature Verification
- **Root Cause**: `preflight.mjs` in `83926d5` used `const features = caps.features || {}` and only checked `=== true`, treating missing `features` or `undefined`/non-boolean flags as disabled.
- **Fix**:
  - Implemented `validateCapabilitiesInvariants` in [ops/staging/preflight.mjs](../../ops/staging/preflight.mjs) requiring `caps.features` to be a plain object and requiring all four protected fields (`custom_code`, `remote_import`, `tts`, `authoring_adapter`) to be explicitly boolean `false`. Reused the same validator in `LIVE-09`.

### Finding 6 [P2] — Mandatory Cancellation Drill & Terminal State Polling
- **Root Cause**: `LIVE-06` in `83926d5` wrapped cancellation in `if (auxJobRes.ok)` and only checked for HTTP 200/202 on `/cancel` without polling the job to confirm it actually reached `state === 'canceled'`.
- **Fix**:
  - Required auxiliary preview job creation (`202`), required `/cancel` acknowledgment (`200`/`202`, or `BLOCKED` on `404`/`405`/`501`), and polled `GET /jobs/{auxJobId}` until terminal state, failing `LIVE-06` if the terminal state is not `'canceled'`.

### Finding 7 [P2] — Usage Baseline Capture & Settlement Delta Audit
- **Root Cause**: `LIVE-10` in `83926d5` read `usage.operational_jobs ?? 0` (instead of `operational_attempts`) and passed even if all counters were `0` or reconciliation failed.
- **Fix**:
  - Captured baseline `GET /v1/usage` in `LIVE-01` and validated post-run usage in `LIVE-10` via `validateUsageSettlementDelta(baselineUsage, usage)`, requiring positive `operational_attempts`, `billable_output_minutes`, `billable_jobs`, and `reservations.settled_count` deltas from baseline, plus `reconciliation.clean === true` and `reconciliation.double_debit_detected === false`.

---

## 3. Verification Commands & Exact Exit Statuses

| # | Command | Result | Exit Status | Details |
| :--- | :--- | :---: | :---: | :--- |
| 1 | `node --test ops/test/live-e2e.test.mjs` | **PASS** | `0` | 45/45 tests across 12 suites passed (24 original + 21 new regression & real-contract tests) |
| 2 | `node --test ops/test/*.test.mjs` | **PASS** | `0` | 117/117 tests across 33 suites passed |
| 3 | `pnpm run build` | **PASS** | `0` | All 8 workspace packages compiled cleanly with `tsc` |
| 4 | `pnpm run typecheck` | **PASS** | `0` | All 8 workspace packages passed `--noEmit` typecheck |
| 5 | `pnpm run lint` | **PASS** | `0` | All 8 workspace packages passed lint checks |
| 6 | `python3 scripts/validate_repo.py` | **PASS** | `0` | 52 tasks acyclic, 0 doc/link/JSON errors |
| 7 | `node scripts/live-staging-e2e.mjs --preflight-only --write-evidence evidence/P10-B` | **NOT_READY** | `2` | Fail-closed preflight as expected because live staging services are not running on host |
| 8 | `node scripts/live-staging-e2e.mjs --write-evidence evidence/P10-B` | **NOT_READY** | `2` | Fail-closed preflight (`HOLD_SERVICES_NOT_DEPLOYED`), no mock invoked |
