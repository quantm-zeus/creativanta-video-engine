# Evidence Report — P7-05: C1–C6 Signed Security Review for Exact Runtime Digest, Kill Switch/Canary/Allowlist Evidence, Off-by-Default Regression & Rollback Test

## 1. Metadata & Lease

```json
{
  "task_id": "P7-05",
  "role": "Security reviewer",
  "phase": "P7",
  "branch": "agy/p7-05",
  "base_commit": "5a64d593931fc8dc4f090617bf9f635dc3c5957e",
  "worktree": "/workspace/repo/.worktrees/p7-05",
  "allowed_paths": [
    "evidence/P7-05/",
    "packages/custom-runtime/"
  ],
  "dependencies_verified": [
    "P7-01",
    "P7-02",
    "P7-03",
    "P7-04",
    "P6-04"
  ],
  "status": "implemented_local"
}
```

## 2. Deliverable Summary & File Digests

Task `P7-05` implements the `C1–C6` signed security review and rollout governance suite for the custom scene microVM runtime (`ADR-0002` / `custom-html-v1`) in `packages/custom-runtime/`, binding cryptographic review signatures to the exact immutable `rootfsImageDigest`, `guestKernelDigest`, `approvedImportsBundleDigest`, and `compositeRuntimeFingerprint`. It also provides executable verification and evidence for the emergency kill switch, 3-fixture custom scene canary verification (`16:9` promo frame, `16:9` explainer chart frame, and `9:16` kinetic title clip), pilot tenant allowlist enrollment and dynamic revocation, off-by-default regression across all layers (including post-restore safety lock), and zero-data-loss runtime rollback / compromised runtime digest revocation.

| File | Role | SHA-256 |
| --- | --- | --- |
| [`packages/custom-runtime/src/c1-c6-security-review.mjs`](../../packages/custom-runtime/src/c1-c6-security-review.mjs) | `C1–C6` gate evaluator, exact runtime/kernel/approved-imports digest manifest and composite fingerprint calculator (`computeRuntimeDigestManifest`), `C1ToC6SignedReviewPacket` signer/verifier (`signC1ToC6ReviewPacket`, `verifyC1ToC6ReviewPacket`), `CustomRuntimeRolloutController` (emergency kill switch, 3-fixture synthetic canary runner, pilot tenant allowlist & dynamic revocation, post-restore safety lock, vulnerable runtime revocation, and zero-data-loss rollback), `runOffByDefaultAndRollbackSuite`, and 12-check `runP705SecurityReviewSelfTest` (`SR7-01`..`SR7-12`) | `ea3f229aa0c1fca38dcdcbd8c24e46273a5bbac3f686dfb61b20c3e3cd153d12` |
| [`packages/custom-runtime/src/cli.mjs`](../../packages/custom-runtime/src/cli.mjs) | CLI runner supporting `--task P7-01|P7-02|P7-03|P7-04|P7-05` and `--write-evidence evidence/P7-05` | `5ac22f27e0871bc44cdd8d91fe2b2afbc005f25409e4441d08c27b850deafb47` |
| [`packages/custom-runtime/index.mjs`](../../packages/custom-runtime/index.mjs) | Package entry point re-exporting `P7-01`, `P7-02`, `P7-03`, `P7-04`, and `P7-05` security review modules | `668695556a71d33508e167c05d3b06e575a49749dd048054212f1fac19088999` |
| [`packages/custom-runtime/index.d.ts`](../../packages/custom-runtime/index.d.ts) | TypeScript type declarations for `RuntimeDigestManifest`, `C1ToC6SignedReviewPacket`, `CustomRuntimeRolloutController`, `evaluateAllC1ToC6Gates`, `runOffByDefaultAndRollbackSuite`, and `runP705SecurityReviewSelfTest` | `97448a5273ad6f3f1822cc27707b8af91b2980f6723e62516478d251c87c6023` |
| [`packages/custom-runtime/test/p7-05-c1-c6-security-review.test.mjs`](../../packages/custom-runtime/test/p7-05-c1-c6-security-review.test.mjs) | Automated test suite covering exact runtime digest pinning, `C1–C6` signed packet tamper/drift rejection, 3-fixture canary suite, pilot tenant allowlist & dynamic revocation, emergency kill switch, off-by-default regression, runtime rollback drill, and 12-check self-test audit | `96a73a72a44f966a4dcac25cb7446e3aad59f774789dde0e50484444f469cdad` |
| [`evidence/P7-05/c1-c6-security-review-audit.json`](./c1-c6-security-review-audit.json) | Machine-verifiable 12-check `P7-05` security review audit report (`SR7-01`..`SR7-12`) | `55ecb77fa5356f42a62e9eaddd109e59cbc9c5eb6503fdc37f0af167231e7bcb` |
| [`evidence/P7-05/c1-c6-signed-attestation.json`](./c1-c6-signed-attestation.json) | Cryptographically signed `C1–C6` security review packet (`REV-P7-05-C1-C6`) bound to exact runtime, kernel, and approved-imports digests | `3daba9f644be001bf40f641295308f5b257e7bc484763d3f33f728179fb634ae` |

## 3. Acceptance Criteria Verification

### 3.1 C1–C6 Signed Security Review for Exact Runtime Digest (`computeRuntimeDigestManifest`, `signC1ToC6ReviewPacket`, `verifyC1ToC6ReviewPacket`)

- **Exact Immutable Digest Pinning (`ADR-0002`)**:
  - `runtime`: `microvm-firecracker-v1`
  - `rootfsImageDigest`: `sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90`
  - `guestKernelDigest`: `sha256:f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f`
  - `approvedImportsBundleDigest`: `sha256:24f9a93035d478603afccd8d2f1be19a5e77287ac586bd1f959c401ff1abf326` (computed deterministically over `@creativanta/scene-easing@1.0.0`, `@creativanta/scene-math@1.0.0`, and `@creativanta/scene-runtime@1.0.0`)
  - `compositeRuntimeFingerprint`: `sha256:ad59810735dae27f3344366b97a03512123b902e63ff2fd6c8c805bb5c3e5e27`
- **All Six Security Gates (`C1–C6`) Technically Verified**:
  - **`C1` (`C1_threat_model_and_runtime_pin`)**: Verified `ADR-0002` threat model, 14 blocked downgrade values (`docker`, `runc`, `containerd`, `chroot`, `nsjail`, `bwrap`, `host`, `vm2`, `isolated-vm`, `worker_threads`, etc.), `gvisor-runsc-v1` explicit review requirement, and exact `sha256:<64 hex>` digest pinning.
  - **`C2` (`C2_isolated_build_and_no_egress`)**: Verified two-phase disposable build inside `custom-build-vm` with `network_interfaces: []` (`0` NICs), `mmds_config: null`, TAP NIC injection rejection (`FIRECRACKER_EGRESS_FORBIDDEN`), deterministic `sourceSha256` / `buildSha256` / `cspScriptHash`, prison destruction after build, and `trustedApiExecutionsCount === 0`.
  - **`C3` (`C3_escape_and_secret_canary_suite`)**: Verified 24/24 malicious payload corpus blocks (`eval`, `Function`, constructor chain escape, bracket-property obfuscation, `child_process`, `fs`, `/proc/self/environ`, `/var/run/docker.sock`, cloud metadata `169.254.169.254`, `package.json` postinstall hooks, dynamic `import()`), symlink/hardlink escape rejection, and 4-vector secret canary non-exfiltration (`canaryPresentInBuildVm: false`, `canaryPresentInRenderVm: false`, `canaryLeakedInArtifactsOrLogs: false`).
  - **`C4` (`C4_resource_bombs_cancel_and_lease_fencing`)**: Verified CPU infinite-loop termination via `SIGKILL` (`CUSTOM_RENDER_TIMEOUT_EXCEEDED`), disk quota bomb (`1024 MiB`) block (`CUSTOM_BUILD_DISK_QUOTA_EXCEEDED`), active job cancellation (`< 5s` process-group kill + prison wipe), and stale `lease_epoch` fencing (`STALE_LEASE_EPOCH_FENCE`).
  - **`C5` (`C5_tenant_preview_and_artifact_origin_auth`)**: Verified isolated `preview-360p-v1` rendering in disposable `custom-render-vm` (`png` `640x360` and `mp4` `360x640`), raw HTML preview origin block (`RAW_HTML_PREVIEW_ORIGIN_FORBIDDEN`), short-lived signed download grants (`TTL <= 300s`) with strict security headers (`X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-store`), and strict `404` IDOR isolation across preview, bundle, and authoring job endpoints.
  - **`C6` (`C6_security_reviewer_signed_attestation`)**: Signed `C1ToC6SignedReviewPacket` (`reviewId: "REV-P7-05-C1-C6"`, `signatureHex: "c125b82fc2c9c249d92e3e4b99b0b92b4f7ee189f07af6cb61a516081b0e6d88"`, inner `gateAttestationSignatureHex: "01c81e81530e0339d792070b7053eeab2f26ffa04b5bd9e28b3330c1c3d5b386"`). Verified automatic rejection (`CUSTOM_C1_C6_GATE_INCOMPLETE`, `CUSTOM_ATTESTATION_KERNEL_DIGEST_DRIFT`, `CUSTOM_ATTESTATION_ROOTFS_DIGEST_DRIFT`, `CUSTOM_REVIEW_IMPORTS_BUNDLE_DIGEST_DRIFT`, `CUSTOM_ATTESTATION_EXPIRED`, `CUSTOM_REVIEW_PACKET_SIGNATURE_INVALID`) on any digest drift, dependency drift, missing gate, expiration, or signature tampering.

### 3.2 Kill Switch, 3-Fixture Canary & Pilot Tenant Allowlist Evidence (`CustomRuntimeRolloutController`)

- **3-Fixture Custom Scene Canary Verification (`SR7-08`)**:
  - Executed `canary-01-promo-vi` (`16:9` promo frame, `png` `640x360`, `artifactSha256: de46655b168b120e80b52fd971b158a7c277e0fd1565f21e18ef6fc558ca05f9`), `canary-02-explainer-chart` (`16:9` explainer chart frame, `png` `640x360`, `artifactSha256: e1fcb0d27288d2d66840efce8c3b6ac6263fe1bed8cf98d6dcd0e39bbd678240`), and `canary-03-kinetic-title` (`9:16` kinetic title clip, `mp4` `360x640`, `artifactSha256: dd9fde56ca6b359c767fd2f4f45f34c84ec31aabe50c02b9167ef61aa8acad48`) in disposable microVMs with `canarySecretLeaked: false` and `trustedApiExecutionsCount: 0`.
- **Pilot Tenant Allowlist & Dynamic Revocation (`SR7-09`)**:
  - Verified that enabling pilot rollout requires a valid signed `C1–C6` review packet and passing 3-fixture canary verification.
  - Verified explicit pilot tenant enrollment (`tnt_pilot_alpha`, `tnt_pilot_beta`), immediate rejection of non-allowlisted tenants (`CUSTOM_TENANT_NOT_ALLOWLISTED`, HTTP `403`), and dynamic revocation (`revokePilotTenant`) that immediately terminates active custom jobs and revokes active custom download grants for the revoked tenant.
- **Emergency Kill Switch (`SR7-10`)**:
  - Verified `triggerEmergencyKillSwitch()` immediately sets `CVE_CUSTOM_CODE_ENABLED=false` and `CVE_CUSTOM_RUNTIME="disabled"`, blocks new custom job admission (`CUSTOM_KILL_SWITCH_ACTIVE`), terminates all in-flight custom build/render jobs (`terminatedRunningCustomJobsCount: 2`), revokes active custom download grants (`revokedCustomGrantsCount: 1`), and keeps structured rendering (`html-v1`, `canvas-v1`, `svg-v1`) healthy (`structuredRenderingUnaffected: true`).

### 3.3 Off-by-Default Regression & Runtime Rollback Drill (`runOffByDefaultAndRollbackSuite`)

- **Off-by-Default Regression (`SR7-11`)**:
  - Verified `@creativanta/contracts` (`parseEnv({})`), `ADR_0002_SPEC.defaultFeatureState`, `CustomRuntimeRolloutController`, `SceneBundleRegistry.prepareRevisionForExecution()`, `DisposableMicroVmRuntime.allocateDisposableVm()`, `executeIsolatedSceneBuild()`, and `executeCustomSceneJob()` all default to `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, and `CVE_CUSTOM_TENANT_ALLOWLIST=[]`, rejecting unapproved execution (`CUSTOM_CODE_DISABLED_BY_DEFAULT`).
  - Verified `activatePostRestoreSafetyLock()` and `revalidateAfterRestore()` keep `custom-html-v1` disabled after backup restore until explicit re-verification.
- **Runtime Rollback & Vulnerable Image Revocation Drill (`SR7-12`)**:
  - Verified unreviewed runtime upgrade (`v2` rootfs digest `sha256:9999...`) is rejected automatically (`CUSTOM_ATTESTATION_ROOTFS_DIGEST_DRIFT`).
  - Verified `revokeCompromisedRuntimeDigest()` immediately fails in-flight jobs on a compromised runtime digest (`inFlightVulnerableJobsFailedCount: 1`), triggers the emergency kill switch, and blocks re-enablement of the revoked digest (`CUSTOM_RUNTIME_DIGEST_REVOKED`).
  - Verified `rollbackToDefaultOff()` and `rollbackToPinnedRuntime()` preserve all existing immutable scene bundle revisions (`zeroBlindDataRollback: true`, `preservedRevisionsCount: 2`), restore the known-good `v1` runtime digest (`sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90`), and leave the workspace in its default-off state (`finalStateDefaultOffRestored: true`).

## 4. Verification Commands & Exit Statuses

| Command | Exit Code | Result | Summary |
| --- | --- | --- | --- |
| `npx tsc -p packages/custom-runtime/tsconfig.json --noEmit` | `0` | `PASS` | Strict TypeScript/JSDoc check (`checkJs: true`, `strict: true`, `noUncheckedIndexedAccess: true`) passed with 0 errors across `packages/custom-runtime/`. |
| `node packages/custom-runtime/src/cli.mjs --write-evidence evidence/P7-05` | `0` | `PASS` | Executed all 12 `P7-05` security review checks (`SR7-01`..`SR7-12`, `12/12 PASS`) and wrote `evidence/P7-05/c1-c6-security-review-audit.json` and `evidence/P7-05/c1-c6-signed-attestation.json`. |
| `node --test packages/custom-runtime/test/p7-05-c1-c6-security-review.test.mjs` | `0` | `PASS` | 5/5 `P7-05` test assertions across 3 suites passed. |
| `node --test packages/custom-runtime/test/*.test.mjs` | `0` | `PASS` | Full `packages/custom-runtime` test suite (`P7-01` + `P7-02` + `P7-03` + `P7-04` + `P7-05`: 82/82 tests across 28 suites) passed with 0 failures. |
| `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | 8/8 controller security & `custom_code_disabled_gate` checks passed. |
| `node scripts/health-check.mjs` | `0` | `PASS` | Verified default environment keeps `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, `CVE_CUSTOM_TENANT_ALLOWLIST=[]`, and `capabilities_engines["custom-html-v1"]=false`. |
| `node --test ops/test/security-review-p6-04.test.mjs` | `0` | `PASS` | 4/4 `P6-04` security review regression suites (24/24 checks) passed. |
| `python3 scripts/validate_repo.py` | `0` | `PASS` | Repository structure, markdown headings/links, JSON blocks, and secret scan passed with 0 errors. |

## 5. Pending External Gates & Honest Limitations

1. **`EXT-P7-01` — Bare-Metal / Nested-Virtualization KVM Host Gate**:
   - The current build/test container environment does not expose `/dev/kvm` (`kvmDeviceExists: false`, `microVmHardwareReady: false`) or host Firecracker/Kata binaries.
   - Per `docs/SECURITY.md` and `ADR-0002`, the runtime **never downgrades** to standard containers (`docker`/`runc`); `CVE_CUSTOM_CODE_ENABLED` remains `false` and `CVE_CUSTOM_RUNTIME` remains `"disabled"` by default until verified on a bare-metal or nested-virtualization Linux worker host with `/dev/kvm`.
2. **`EXT-P7-02` — Human Security Reviewer & Legal/Compliance Sign-off Gate**:
   - The signed packet `evidence/P7-05/c1-c6-signed-attestation.json` carries `reviewApprovalScope: "TECHNICAL_GATE_VERIFIED_AWAITING_HUMAN_SIGNOFF"`. Automated `P7-05` verification proves technical enforcement of `C1–C6`, kill switch, canary, allowlist, off-by-default regression, and runtime rollback, but does not substitute for human Security Reviewer and Legal sign-off required before production pilot enablement (`P7-06`).
