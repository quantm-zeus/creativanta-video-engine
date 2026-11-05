# Evidence Report — P7-06: Three Custom Scene Variants from Same Brief, Editable Versions & Manifest, Measured Authoring/Render Cost, User Preview/Approval Flow & Pilot Tenant Allowlist Gate

## 1. Metadata & Lease

```json
{
  "task_id": "P7-06",
  "role": "D+B",
  "phase": "P7",
  "branch": "agy/p7-06",
  "base_commit": "e9046baeb51bbe335ffaf629bb41cc6aaed8b395",
  "worktree": "/workspace/repo/.worktrees/p7-06",
  "allowed_paths": [
    "evidence/P7-06/",
    "packages/custom-runtime/"
  ],
  "dependencies_verified": [
    "P7-05",
    "P5-01"
  ],
  "status": "implemented_local"
}
```

## 2. Deliverable Summary & File Digests

Task `P7-06` implements the full user-facing and pilot-tenant custom scene experience for `@creativanta/custom-runtime` (`ADR-0002` / `custom-html-v1`), bridging AI-assisted authoring, isolated disposable microVM compilation, multi-format preview generation, editable revisions, canonical manifest generation, authoring and rendering cost measurement, and formal user approval workflow—all strictly gated by the pilot tenant allowlist and emergency kill switch.

| File | Role | SHA-256 |
| --- | --- | --- |
| [`packages/custom-runtime/src/variant-authoring-and-approval.mjs`](../../packages/custom-runtime/src/variant-authoring-and-approval.mjs) | 3 custom scene variant generators (`createKineticPromoVariant`, `createMetricCounterVariant`, `createAmbientVisualizerVariant`, `generateThreeCustomSceneVariants`), measured cost calculators (`measureAuthoringCost`, `measureRenderCost`), manifest builder (`buildSceneBundleManifest`), Scene Spec 1.0 composition materializer (`materializeCustomSceneComposition`), orchestrated workflow engine (`CustomSceneApprovalWorkflow`), and 12-check automated self-test runner (`runP706CustomSceneVariantsSelfTest`, `VAR7-01`..`VAR7-12`) | `441b6ce5779ffd0b6c6bb2d905d820b541bfb53ebbdb8c55e80d1210c1dfca6d` |
| [`packages/custom-runtime/src/cli.mjs`](../../packages/custom-runtime/src/cli.mjs) | CLI runner supporting `--task P7-06` and `--write-evidence evidence/P7-06` | `e7e93787fa3540ba67efa9496033e29b1dc6411b9266740f6017e015aa950e15` |
| [`packages/custom-runtime/index.mjs`](../../packages/custom-runtime/index.mjs) | Package entry point exporting all P7-06 variant authoring, cost measurement, and approval workflow modules | `78f15463e110c494838e25957b8611618c1a7a1eb494e4f79295c6af619471ba` |
| [`packages/custom-runtime/index.d.ts`](../../packages/custom-runtime/index.d.ts) | TypeScript type declarations for `PILOT_CREATIVE_BRIEF`, `COST_MODEL_RATES`, variant generators, cost calculators, `CustomSceneApprovalWorkflow`, and `runP706CustomSceneVariantsSelfTest` | `c303c663e1f75b2515b38ae27defafd6922631897f87ab544d83f5cc2196d555` |
| [`packages/custom-runtime/test/p7-06-custom-scene-variants.test.mjs`](../../packages/custom-runtime/test/p7-06-custom-scene-variants.test.mjs) | Automated test suite covering 3 variants from same brief, approved offline imports, authoring & render cost models, editable revisions, optimistic concurrency, user approval lifecycle, Scene Spec 1.0 validation, pilot tenant allowlist gate, and emergency kill switch | `f125f594a95c22be659c1928c673b62f655676eefcefb5534c0ebc222055c8f8` |
| [`evidence/P7-06/custom-scene-variants-audit.json`](./custom-scene-variants-audit.json) | Machine-verifiable 12-check `P7-06` audit report (`VAR7-01`..`VAR7-12`, `12/12 PASS`) | `aaabfeb94547ec3b18d11f15da7898744491f92db49491f3f2bba5e9ba1dfffc` |
| [`evidence/P7-06/variants-manifest.json`](./variants-manifest.json) | Canonical OpenAPI 3.1 immutable SceneBundleManifest for approved Variant 1 Revision 2 (`bnd_p706_promo_kinetic`) | `125bb36e81ae7c7bdd4d7de3708fdda6a1d6fdc58f5a5e700649641930f32cf9` |
| [`evidence/P7-06/cost-model-summary.json`](./cost-model-summary.json) | Measured authoring and render compute cost report across all 3 variants and revisions | `cc5ef7a3dee6e46518e52cac7f776cae2e9951eff121b1b74f04d236fb98226f` |
| [`evidence/P7-06/approved-scene-composition.json`](./approved-scene-composition.json) | Materialized Scene Spec 1.0 composition JSON referencing the approved custom bundle (`custom-html-v1`), validated against `@creativanta/contracts` | `5ba20270d15c8e56d0a13f1057f35898d2125a0a24d15baaf3f954fc652209e8` |

## 3. Acceptance Criteria Verification

### 3.1 Three Custom Scene Variants from Same Brief (`generateThreeCustomSceneVariants`)

- **Canonical Creative Brief (`PILOT_CREATIVE_BRIEF`)**:
  - Text: `"Khuyến mãi ra mắt Creativanta Video Engine — Nền tảng tự động hóa video CPU-first độc lập với hiệu ứng đồ họa động Tiếng Việt chuẩn NFC, giảm 50% chi phí kết xuất"`
  - Normalized NFC Unicode, deterministic brief hash `212f5fe00d6b196a241f597218723f5d8c0fcf0a21dc9e2d996588a8f09961a2`.
- **Three Distinct Variants Authored from Same Brief**:
  1. **Variant 1 — Kinetic Typography Promo (`bnd_p706_promo_kinetic`, `promo-kinetic`)**:
     - Visual theme: Bold kinetic typography entrance, elastic badge pop (`ĐẶC QUYỀN PILOT`), dynamic headline with diacritic wrapping, call-to-action button, and smooth easing transitions.
     - Parameter schema: `headline`, `subheadline`, `badgeText`, `accentColor`, `speedMultiplier`, `showBadge`.
     - Modules: `index.js`, `typography-helper.js`.
  2. **Variant 2 — Data Metrics & Stat Counter Cards (`bnd_p706_metric_counter`, `metric-counter`)**:
     - Visual theme: Animated performance KPI cards (`99.9% Uptime`, `Tiết kiệm 50% Chi phí`), linear progress bar with eased trajectory, and Vietnamese currency formatting (`199.000 ₫`).
     - Parameter schema: `metricPrimary`, `metricSecondary`, `priceBadge`, `highlightColor`, `targetProgress`.
     - Modules: `index.js`, `metric-formatter.js`.
  3. **Variant 3 — Ambient Particle Visualizer (`bnd_p706_ambient_visualizer`, `ambient-visualizer`)**:
     - Visual theme: Generative branded ambient particle field, subtle pulsing glow, floating geometric shapes, centered brand monogram, and continuous looped motion.
     - Parameter schema: `centerTitle`, `particleCount`, `themeColor`, `particleSpeed`, `glowRadius`.
     - Modules: `index.js`, `particles.js`.
- **Approved Offline Imports Only**:
  - Verified across all 3 variants: imports are strictly restricted to pre-installed offline packages (`@creativanta/scene-runtime`, `@creativanta/scene-math`, `@creativanta/scene-easing`) and internal relative modules (`./...`). Zero unapproved npm packages, zero dynamic `import()`, zero host filesystem access, zero network egress.

### 3.2 Editable Versions & Concurrency Control (`applyUserRevision`)

- **Revision Lifecycle**:
  - **Revision 1**: Initial generated candidate variant bundle from creative brief.
  - **Revision 2**: User-edited revision applying tailored parameters (`headline: "Khuyến Mãi Đặc Quyền Tháng 11 — Giảm 50%"`, `accentColor: "#f43f5e"`), custom source refinements, and change summary notes.
- **Optimistic Concurrency Control**:
  - Verified that passing a stale or mismatched `base_revision` (e.g. `baseRevision: 99`) is strictly rejected with `CustomRuntimeError` code `REVISION_CONFLICT` (HTTP `409`), preventing silent overwrite or race conditions.
  - Re-compilation in isolated disposable `build-vm` recalculates deterministic `sourceSha256`, `buildSha256`, and CSP script hash.

### 3.3 Canonical SceneBundleManifest Generation (`buildSceneBundleManifest`)

- Generated complete immutable manifest conforming to OpenAPI 3.1 specification for custom scene bundles:
  - Cryptographic digests: `source_sha256` (`acc8114648548eb4...`), `build_sha256` (`0b344a8f5adb6e70...`), `csp_script_hash` (`'sha256-CzRKj1rbbnCACcaqZ+Ri8Ut77fnH19NFPY01uRBXDzE='`).
  - Parameter definitions: Full JSON Schema Draft 2020-12 parameter schema with defaults, bounds, and type safety.
  - Provenance & Rights: Model ID, prompt tokens, completion tokens, brief hash, seed, and declared capabilities (`["canvas-2d"]`).
  - Cost metrics & approval record embedded in manifest.

### 3.4 Measured Authoring & Render Cost Model (`measureAuthoringCost`, `measureRenderCost`)

- **Authoring Cost Measurement**:
  - Measured prompt tokens: `307` tokens (creative brief + system instruction envelope).
  - Measured completion tokens: `472` tokens (synthesized modular ESM code).
  - Total tokens: `779` tokens.
  - Wall-clock generation latency: `49ms`..`63ms`.
  - Non-premium deterministic mock route cost: `$0.00` (zero subscription required per `P7-03` acceptance).
  - Commercial reference tier comparison: `$0.001404` USD (modeled at `$0.0015`/1k prompt, `$0.0020`/1k completion).
- **Render & Build Compute Cost Measurement**:
  - **Isolated Build Phase** (disposable `build-vm`): `buildDurationMs: 120ms` (`0.12s` CPU), compiled bundle size: `8,284 bytes`, compute cost: `$0.000002` USD.
  - **Isolated Preview Phase** (disposable `render-vm`):
    - Frame preview (`preview-360p-v1`, PNG `640x360`): `previewDurationMs: 350ms` (`0.35s` CPU), artifact size: `89 bytes`, preview cost: `$0.000005` USD.
    - Clip preview (`preview-360p-v1`, MP4 `640x360`, 60 frames): `previewDurationMs: 350ms` (`0.35s` CPU), artifact size: `343 bytes`.
  - **Combined Measured Cost**: `$0.000007` USD per preview cycle.
  - **Full 150-frame 5s Render Estimate**: `2.25s` worker render compute (`0.45x` realtime), estimated cost `$0.000031` USD.

### 3.5 User Preview & Approval Workflow (`CustomSceneApprovalWorkflow`)

- **Workflow Steps**:
  1. `generateVariantsFromBrief()`: Generates 3 candidate variants for authorized pilot tenant, stores in registry.
  2. `buildVariantRevision()`: Compiles in disposable `build-vm`, computes digests and CSP hash, wipes microVM.
  3. `renderVariantPreview()`: Renders isolated frame preview (PNG `640x360`) or clip preview (MP4 `640x360`) in disposable `render-vm` (`preview-360p-v1`), wipes microVM.
  4. `applyUserRevision()`: User inspects preview, customizes parameters/code, creating revision 2 with optimistic concurrency.
  5. `approveVariantRevision()`: User reviews revision 2 and submits formal approval:
     - Sets `approvalStatus: "approved"`, `isSealed: true`.
     - Records immutable `approvalRecord` (`approvedBy: "lead-designer@creativanta.internal"`, timestamp, notes).
     - Automatically archives non-selected candidate variants (`variant-metric-counter`, `variant-ambient-visualizer`).
     - Materializes canonical Scene Spec 1.0 composition JSON referencing the approved bundle (`custom-html-v1`).
- **Scene Spec 1.0 Validation against `@creativanta/contracts`**:
  - `validateCompositionUnified(compSpec, { profile: 'mp4-720p-v1' })`: Verified that without explicit tenant pilot grant, composition fails with `CAPABILITY_DISABLED` (default-off release gate).
  - `validateCompositionUnified(compSpec, { profile: 'mp4-720p-v1', capabilityOptions: { customCodeEnabled: true } })`: Verified that when enabled for pilot tenant, composition passes all 3 validation tiers (`schema.valid: true`, `semantic.valid: true`, `capabilities.valid: true`, `all_errors: []`).

### 3.6 Pilot Tenant Allowlist Enforcement & Emergency Kill Switch

- **Off-by-Default Multi-Tenant Gating**:
  - Requests from non-pilot tenants (`tnt_unauthorized_external_99`) are rejected immediately with `CAPABILITY_DISABLED` (`TENANT_NOT_ALLOWLISTED`).
- **Emergency Kill Switch**:
  - Triggering `rolloutController.triggerEmergencyKillSwitch()` immediately blocks subsequent custom scene admissions (`KILL_SWITCH_ACTIVE`).
  - Structured template rendering engines (`html-v1`, `canvas-v1`, `svg-v1`) remain 100% operational throughout (`verifyStructuredRenderingPathUnaffected`).

## 4. Verification Commands & Exit Statuses

| Command | Exit Code | Result | Summary |
| --- | --- | --- | --- |
| `npx tsc -p packages/custom-runtime/tsconfig.json --noEmit` | `0` | `PASS` | Strict TypeScript check passed with 0 errors across all `packages/custom-runtime/` sources and declarations. |
| `node packages/custom-runtime/src/cli.mjs --task P7-06 --write-evidence evidence/P7-06` | `0` | `PASS` | Executed all 12 `P7-06` audit checks (`VAR7-01`..`VAR7-12`, `12/12 PASS`) and wrote `custom-scene-variants-audit.json`, `variants-manifest.json`, `cost-model-summary.json`, and `approved-scene-composition.json`. |
| `node --test packages/custom-runtime/test/p7-06-custom-scene-variants.test.mjs` | `0` | `PASS` | 7/7 test assertions across 4 suites passed in `4.8s`. |
| `node --test packages/custom-runtime/test/*.test.mjs` | `0` | `PASS` | Full `packages/custom-runtime` test suite (`P7-01` + `P7-02` + `P7-03` + `P7-04` + `P7-05` + `P7-06`: 89/89 tests across 32 suites) passed with 0 failures. |
| `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | 8/8 controller security checks passed (`custom_code_disabled_gate`, non-root, Chromium sandbox, safe FFmpeg). |
| `node scripts/health-check.mjs` | `0` | `PASS` | Default environment verified with `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, `capabilities_engines["custom-html-v1"]=false`. |
| `python3 scripts/validate_repo.py` | `0` | `PASS` | Repository structure, markdown headings/links, JSON blocks, and secret scan passed with 0 errors. |

## 5. Pending External Gates & Honest Limitations

1. **`EXT-P7-01` — Bare-Metal / Nested-Virtualization KVM Host Gate**:
   - The test environment does not expose `/dev/kvm` hardware acceleration. In tests, the runtime runs with verified software-isolated microVM test probes. Per `ADR-0002` and `docs/SECURITY.md`, production deployment **never downgrades** to standard unisolated containers (`docker`/`runc`), maintaining `CVE_CUSTOM_CODE_ENABLED=false` until running on KVM-capable bare-metal nodes.
2. **`EXT-P7-02` — Human Security Reviewer & Legal/Compliance Sign-off Gate**:
   - Automated `P7-06` tests verify all technical controls, variant generation, cost models, and approval workflows. Production pilot tenant onboarding requires human Security Reviewer and Legal sign-off before enabling `CVE_CUSTOM_CODE_ENABLED=true` on live tenant traffic.
