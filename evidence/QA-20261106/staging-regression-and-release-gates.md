# Creativanta Video Engine - independent staging regression and release-gate note

Date: 2026-11-06 UTC. Scope: code merged on `staging` at `31e2bf457193c26fbb265569e2879c715209121d` (P8-04 PR #58). Validation environment: authorized VPS `evergreen`, Linux x86_64, Node v24.21.0, pnpm v10.34.9, Python 3.12.3. Worktree was isolated from the harness, and left clean.

## Reproduced checks

Commands run on this exact staging checkout:

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --prefer-offline` | PASS |
| `python3 scripts/validate_repo.py` | PASS (52 tasks, dependency graph acyclic, no document validation errors) |
| `pnpm -r --if-present lint` | PASS |
| `pnpm -r --if-present typecheck` | PASS |
| `pnpm -r --if-present build` | PASS |
| `pnpm -r --if-present test` | PASS (674 tests in eight workspace packages; no failures) |
| `pnpm health` | PASS (test/development checks, not a production probe) |
| `python3 -m unittest discover -s tooling/agent_harness/tests -q` | PASS (10 tests) |

Workspace test counts: contracts 117, API 268, ingest 7, controller 21, renderer 46, SDK 121, templates 22, browser-export 72. Total **674/674 PASS**.

Official post-merge GitHub Actions run for the same commit: [run 42209097788](https://github.com/quantm-zeus/creativanta-video-engine/actions/runs/42209097788), **SUCCESS**.

This establishes only regression test/build readiness for the checked-out code. It does not independently validate statements about commercial rights, real hardware security, physical devices, uptime, throughput, or a user-facing deployment.

## Release readiness is NOT approved

The user authorized **provisional staging-only integration** of P8-04; PR #58 CI passed and was merged. The supervisor marks P8-04 integrated for *development bookkeeping only*. This report is **not** an independent legal/security sign-off and does **not** authorize production, beta/pilot, GA, or customer-facing browser export.

Observed on this VPS during QA: `creativanta-video-engine-supervisor`, `creativanta-agy-supervisor`, `creativanta-p0-postgres-1`, and `creativanta-p0-dragonfly-1` were running. No API/renderer service containers were visible in the local Docker container list. Successful test HTTP endpoints therefore do not prove an independently deployed live API/renderer or true external-client E2E against such deployment.

Fail-closed defaults retained in `.env.example`: `CVE_REMOTE_IMPORT_ENABLED=false`, `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME=disabled`. The P8 browser export legal gate `assertBrowserExportGateApproved` also requires external approval. Keep optional engines unadvertised and disabled until signed off.

Remaining independent approvals and evidence:

1. **GA P9-05**: [PR #56](https://github.com/quantm-zeus/creativanta-video-engine/pull/56) remains OPEN at `REVIEW_REQUIRED`. The packet calls itself `GO_FOR_GA_CANDIDATE_WITH_EXTERNAL_GATES`, not granted GA. Six listed external gates remain unresolved: production deployment authorization; real external Creativanta integration/credentials; H.264/AAC commercial rights and payment agreements; data residency/DPA approval; Firecracker microVM host isolation; physical browser/client compatibility.
2. **P8 optional features**: [issue #59](https://github.com/quantm-zeus/creativanta-video-engine/issues/59) tracks external legal/security browser-distribution review (`EXT-P8-01`) and VideoFlow license clearance (`EXT-P8-02`); both remain pending.
3. **Security and operational sign-off**: [issue #39](https://github.com/quantm-zeus/creativanta-video-engine/issues/39), [issue #46](https://github.com/quantm-zeus/creativanta-video-engine/issues/46), and [issue #47](https://github.com/quantm-zeus/creativanta-video-engine/issues/47) remain open for real-host/security and release approvals.
4. **Media quality and rights**: [issue #22](https://github.com/quantm-zeus/creativanta-video-engine/issues/22) needs independent video watch/listen; [issue #29](https://github.com/quantm-zeus/creativanta-video-engine/issues/29) needs real licensing/source provenance verification.
5. **Real deployment smoke**: run API + render worker against approved isolated staging services with signed fixtures, verify upload -> template -> preview -> video render -> callback -> download/decode, fault/retry, rollback and logs with actual artifacts, then record independent reviewer and UTC timestamp. No public or production deployment is authorized by this task.

## Decision

**Technical staging regression: PASS on the recorded commit. GA/beta/production release decision: HOLD / NOT APPROVED.** Keep P9-05 review required until authorized people provide missing external approvals. No unattended AGY job is necessary or safe merely to make the worker count nonzero when all implementable tasks have been completed.
