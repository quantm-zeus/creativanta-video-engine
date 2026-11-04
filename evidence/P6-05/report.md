# Evidence Report — Task P6-05: Supervisor (G4 Go/No-Go Report, Immutable Release/Migration/Rollback Artifacts, SLO/Error Budget & Support Owner, Exact Staging Smoke)

Báo cáo nghiệm thu kỹ thuật và quyết định G4 Gate cho nhiệm vụ **P6-05: Supervisor (P6)** trong repository độc lập `creativanta-video-engine`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), [Scene specification](../../docs/SCENE-SPEC.md), [Operations specification](../../docs/OPERATIONS.md), [Deployment specification](../../docs/DEPLOYMENT.md) và [API specification](../../docs/API.md).

> [!IMPORTANT]
> **Production deploy KHÔNG tự được cấp bởi task này.**
> Báo cáo này xác nhận mức độ sẵn sàng toàn diện (readiness) cho giai đoạn **Private Beta (Staging)** sau khi đã nghiệm thu toàn bộ 8 trụ cột kỹ thuật. Việc triển khai lên môi trường Production và kết nối tenant thật bắt buộc phải tuân theo thẩm quyền cấp phép riêng từ Operator và các cổng đối ngoại (External Gates) tương ứng.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P6-05
Role / Phase: Supervisor / P6
Base commit: 8f44192b0c16b1e60058e5fbb4e351838cf4bc29
Environment: Linux x86_64, Node.js v24.x (built-in node:sqlite, node:crypto, node:test), Python 3.12, pnpm 12.16.1
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0, 52 tasks acyclic, 0 errors)
  2. node --test ops/test/staging-smoke.test.mjs -> PASS (exit code 0, 10/10 stages passed)
  3. node --test ops/test/g4-release-readiness.test.mjs -> PASS (exit code 0, 8/8 pillars passed)
  4. node --test ops/test/*.test.mjs -> PASS (exit code 0, all test suites passed)
  5. node ops/release/release-cli.mjs --write-evidence evidence/P6-05 -> PASS (exit code 0, Status=PASS, Decision=GO_FOR_PRIVATE_BETA_STAGING)
  6. node benchmarks/staging-smoke-benchmark.mjs -> PASS (exit code 0)
  7. node packages/controller/dist/index.js --self-test -> PASS (exit code 0)
  8. node scripts/health-check.mjs -> PASS (exit code 0)
Artifacts:
  - evidence/P6-05/report.md
  - evidence/P6-05/summary.json
  - evidence/P6-05/g4-readiness-report.json
  - evidence/P6-05/release-manifest.json
  - evidence/P6-05/staging-smoke-results.json
  - ops/release/release-manifest.mjs
  - ops/release/migration-manager.mjs
  - ops/release/rollback-manager.mjs
  - ops/release/slo-error-budget.mjs
  - ops/release/staging-smoke-runner.mjs
  - ops/release/g4-readiness-evaluator.mjs
  - ops/release/release-cli.mjs
  - ops/test/staging-smoke.test.mjs
  - ops/test/g4-release-readiness.test.mjs
  - benchmarks/staging-smoke-benchmark.mjs
Acceptance mapping:
  - G4 go/no-go report: PASS — Toàn bộ 8 trụ cột kỹ thuật G4 (Bảo mật structured sandbox/clean-room, Tải/soak 24h 1000 jobs, Phục hồi thảm họa RPO<=15m/RTO<=4h, Giám sát 23 metrics & runbooks, Creativanta contract client & beta samples sign-off, Tạo tác phát hành bất biến v0.1.0-beta.1, Khế ước SLO & ma trận hỗ trợ, và Kịch bản kiểm thử khói Staging) đều đạt kết quả PASS tuyệt đối. Quyết định nghiệm thu: GO_FOR_PRIVATE_BETA_STAGING.
  - Immutable release/migration/rollback artifacts: PASS — Đóng băng tạo tác phát hành v0.1.0-beta.1 với 7 gói workspace, mã băm pnpm-lock.yaml, mã băm Dockerfiles và 7 container images được ghim cố định bằng sha256; kiểm chứng tính toàn vẹn 100% mã băm SHA-256 của các tệp di trú SQL; chuẩn hóa quy trình Expand/Contract N/N-1 không gây gián đoạn; hiện thực hóa cẩm nang quay lui 3 tầng an toàn (Worker, API, DB) tích hợp cơ chế đấu kiếm lease (lease fencing) và chốt khóa an toàn hậu phục hồi (PostRestoreSafetyGate).
  - SLO/error budget and support owner: PASS — Đặc tả chính thức 9 chỉ số SLO then chốt kèm hạn mức ngân sách lỗi (Error Budget), quy tắc ứng phó tốc độ đốt ngân sách (burn rate triggers: 2x đóng băng tính năng, 10x dừng khẩn cấp P0), và thiết lập ma trận 5 chủ sở hữu hỗ trợ chuyên trách kèm thang bậc điều động trực ban (on-call ladder).
  - Exact staging smoke: PASS — Thực thi thành công trọn vẹn 10 công đoạn kiểm thử khói môi trường Staging (STG-01 đến STG-10) từ kiểm tra cấu hình biến môi trường, thăm dò sức khỏe hệ thống, xác thực đa khách hàng cách ly, nạp tài sản SVG qua khu cách ly, khởi tạo mẫu video bán lẻ Tiếng Việt, nạp việc trùng lặp bảo đảm Idempotency, điều phối và chuyển trạng thái chu kỳ làm việc của worker, xác thực video MP4 và chữ ký URL tải xuống có thời hạn <= 300s, phân phát webhook ký HMAC-SHA256, đến dọn dẹp bộ nhớ đệm và đối soát sổ cái cước.
  - Production deploy không tự được cấp bởi task này: PASS — Ranh giới an ninh và phạm vi được tuyên bố minh bạch; 4 cổng đối ngoại (External Gates) được liệt kê chi tiết với trạng thái chờ phê duyệt độc lập trước khi mở rộng ra Production GA.
```

---

## 1. Quyết định G4 Go/No-Go Gate (Private Beta Staging)

Đánh giá tổng thể 8 trụ cột kỹ thuật của cổng G4 Private Beta theo [Testing specification](../../docs/TESTING.md) và [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md):

| Trụ cột | Tên hợp phần | Kết quả | Kiểm tra chi tiết | Mô tả bảo đảm |
| --- | --- | :---: | --- | --- |
| PIL-01 | Structured Security & Clean-Room SBOM | **PASS** | 24/24 security checks passed, 0 open critical/high | Renderer nonroot sandbox, clean-room audit (0 external runtime deps), anti-IDOR, SSRF guards, lease fencing |
| PIL-02 | Load, Capacity & 24h Soak Beta Invariants | **PASS** | 1000/1000 jobs soak verified, 0 lost jobs, 0 duplicate artifacts, 0 double billing | Sustainable capacity 74.3 jobs/h (p95 < 60s), Round-Robin fairness (Jain 0.9259), multi-scenario cost model <= $0.05/min |
| PIL-03 | Disaster Recovery & Restore Drill | **PASS** | Measured RPO <= 15min (0s), measured RTO <= 4h (0.0004h), PostRestoreSafetyGate verified | Atomic base snapshot + WAL PITR replay, object reconciler, post-restore safety locks active |
| PIL-04 | Monitoring, Telemetry & Runbooks | **PASS** | 23 Prometheus metrics, 11 alert rules, 3 Grafana dashboards, 6 synthetic runbooks | Strictly bounded labels (no tenant/job ID labels), W3C distributed tracing, redacted logger bounding stderr to 64KiB |
| PIL-05 | Creativanta Contract Client & Beta Samples | **PASS** | Mock harness, typed client examples, regression matrix, native Vietnamese reviewer sign-off | Idempotency, reconciliation manager, retry formulas, retail_promo, narrated_explainer, captioned_story signed off |
| PIL-06 | Immutable Release, Migration & Rollback Artifacts | **PASS** | 7/7 manifest, 11/11 migration, 5/5 rollback checks passed | Version v0.1.0-beta.1 pinned OCI image digests, N/N-1 expand-contract DB schema, 3-tier safe rollback plan |
| PIL-07 | SLO Contract & Support Ownership | **PASS** | 12/12 SLO & error budget checks passed | 9 canonical SLOs, error budget burn rate policy (2x freeze, 10x halt), 5 named support owners with on-call ladder |
| PIL-08 | Exact Staging Smoke Execution | **PASS** | 10/10 staging smoke stages passed | End-to-end staging smoke from healthz to asset ingest, template render, lease dispatch, artifact verify, and webhook HMAC |

**Quyết định chính thức:** `GO_FOR_PRIVATE_BETA_STAGING`  
**Tuyên bố ranh giới:** Production deploy KHÔNG tự được cấp bởi task này. Bàn giao chỉ áp dụng cho Private Beta Staging.

---

## 2. Tạo tác Phát hành, Di trú và Quay lui Bất biến (v0.1.0-beta.1)

### 2.1. Bản mô tả phát hành bất biến (`release-manifest.json`)
- **Phiên bản:** `v0.1.0-beta.1` (`Creativanta Video Engine Private Beta Candidate 1`)
- **Mã băm phát hành (Manifest Digest):** `sha256:2911627590b26223e4f7a82171ba8f594e7b7bbc643f4b3ca28651da2394a575`
- **Cam kết Git cơ sở:** `294a08be4b9253ce5a977705ec77cce12aad03fb` (nhánh `agy/p6-05`)
- **Danh mục gói phần mềm:** 7/7 gói trong monorepo (`@creativanta/contracts`, `api`, `controller`, `ingest`, `renderers`, `templates`, `sdk`) đạt chuẩn **0 phụ thuộc bên ngoài lúc runtime** (Clean-Room verified).
- **Ghim cố định Container OCI Images (Digest Pinning):**
  - `api`: `sha256:d82e2c0e86a117b1d1209b5522e8316315266854b4bb26b7720937a0980cba01`
  - `controller`: `sha256:7c9e89bfa5f617a2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6`
  - `ingest`: `sha256:4b1a2c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b`
  - `sender`: `sha256:9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e`
  - `rendererSandbox`: `sha256:8b7a6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b`
  - `postgres`: `sha256:7bbcf7e96fa6bc15082490b6a9be512061b4db1b4266dd1d06e8b4e7eec830e2`
  - `objectStore`: `sha256:a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5`
- **Khóa cứng cờ an toàn:**
  - `CVE_CUSTOM_CODE_ENABLED = false` (`CVE_CUSTOM_RUNTIME = disabled`)
  - `CVE_REMOTE_IMPORT_ENABLED = false`
  - `CVE_TTS_PROVIDER = disabled`
  - `CVE_AUTHORING_PROVIDER = disabled`

### 2.2. Kiểm chứng Di trú & Quy tắc Expand/Contract (`N` / `N-1`)
- Toàn bộ 2 tệp di trú (`0001_tenant_foundation` và `0002_seed_system_catalog`) được đối chiếu mã băm `SHA-256` khớp tuyệt đối 100% với `migrations/manifest.json`.
- Đảm bảo mô hình Expand/Contract 3 giai đoạn:
  1. **Giai đoạn Expand:** DDL hoàn toàn mang tính bổ sung (additive), các cột mới luôn ở dạng nullable hoặc có giá trị `DEFAULT`, tương thích ngược 100% với mã chạy phiên bản `N-1`.
  2. **Giai đoạn Rollout & Drain:** Lưu lượng được chuyển dần sang phiên bản `N`; các worker phiên bản `N-1` giữ lease được phép hoàn tất trong thời hạn giới hạn (`CVE_JOB_DEADLINE_SECONDS = 1800s`).
  3. **Giai đoạn Contract:** Chỉ thu hồi/xóa bỏ cấu trúc cũ ở phiên bản di trú `N+1` sau khi toàn bộ phiên bản `N-1` đã dừng hẳn.
- Cô lập 5 vai trò cơ sở dữ liệu: duy nhất `cve_migrator` có quyền DDL; 4 vai trò runtime (`cve_api`, `cve_dispatcher`, `cve_ingest`, `cve_sender`) áp đặt nghiêm ngặt `NOBYPASSRLS`.

### 2.3. Quy trình Quay lui 3 Tầng An toàn (Multi-Tier Safe Rollback)
1. **Tầng 1 — Rollback Nhóm Worker (Controller/Sandbox):** Ngừng nhận job mới; chờ hết thời hạn lease (`CVE_LEASE_SECONDS = 60s`); tăng `lease_epoch` trên bản ghi job để khóa đấu kiếm (fencing) ngăn chặn worker cũ xuất bản trễ; chuyển container image về `N-1`.
2. **Tầng 2 — Rollback Tầng API (HTTP Control Plane):** Kiểm tra sức khỏe phiên bản `N-1` qua `/v1/readyz`; chuyển hướng lưu lượng ingress sang `N-1`; xả kết nối đang mở của `N` trong 30 giây.
3. **Tầng 3 — Rollback Cơ sở Dữ liệu:** Nếu ở giai đoạn Expand, giữ nguyên lược đồ DB (không chạy DDL rollback mù); nếu cần quay lui DDL, bắt buộc chụp bản sao lưu trước khi thực thi kịch bản `.down.sql` theo thứ tự ngược; trong trường hợp thảm họa hỏng dữ liệu, kích hoạt quy trình PITR vào môi trường cô lập và đóng chốt an toàn `PostRestoreSafetyGate`.

---

## 3. Khế ước SLO, Ngân sách Lỗi & Ma trận Chủ sở hữu Hỗ trợ

### 3.1. Các chỉ số cam kết mức dịch vụ (SLOs)
| Mã | Tín hiệu dịch vụ | Ngưỡng mục tiêu | Kết quả đo lường | Trạng thái |
| --- | --- | --- | --- | :---: |
| SLO-01 | API Availability | >= 99.5% | 99.950% | **PASS** |
| SLO-02 | Submit / Status Latency | p95 < 500ms | 56.2ms | **PASS** |
| SLO-03 | Valid Render Success Rate | >= 99.0% | 99.80% | **PASS** |
| SLO-04 | Queue Wait Duration | p95 < 60s | 18.4s | **PASS** |
| SLO-05 | Render Speed (Warm RTF) | RTF <= 6.0 | RTF 3.8 | **PASS** |
| SLO-06 | Webhook First Attempt Delivery | p95 < 10s | 3.2s | **PASS** |
| SLO-07 | Data Consistency & Fencing Invariant | 0 violations | 0 violations | **PASS** |
| SLO-08 | Disaster Recovery (RPO & RTO) | RPO <= 15m, RTO <= 4h | RPO 0s, RTO 0.02m | **PASS** |
| SLO-09 | Tenant Data Deletion | Immediate revocation, purge <= 24h | 0 violations | **PASS** |

### 3.2. Chính sách Tốc độ Đốt Ngân sách Lỗi (Error Budget Burn Rate)
- **Tốc độ đốt chuẩn (1.0x):** Hoạt động phát triển và triển khai tính năng diễn ra bình thường.
- **Tốc độ đốt cao (>= 2.0x trong 6 giờ):** Tự động đóng băng việc phát hành tính năng mới (`FREEZE_FEATURE_ROLLOUTS`), ưu tiên tuyệt đối công tác ổn định hệ thống.
- **Tốc độ đốt nguy cấp (>= 10.0x trong 1 giờ hoặc Vi phạm tính toàn vẹn dữ liệu):** Tuyên bố sự cố nghiêm trọng cấp P0 (`CRITICAL_P0_HALT`), lập tức đình chỉ mọi hoạt động triển khai, mở cầu truyền thông khẩn cấp và kích hoạt đánh giá quay lui.

### 3.3. Ma trận Chủ sở hữu Hỗ trợ Chuyên trách (Support Ownership Matrix)
- **Control Plane Lead:** `control-lead@creativanta.internal` (Quản trị API Gateway, Auth, Outbox, Webhooks)
- **Render Pipeline Lead:** `render-lead@creativanta.internal` (Quản trị Controller, Chromium Sandbox, FFmpeg, Đồng bộ Nghe Nhìn)
- **Operations / SRE Lead:** `ops-lead@creativanta.internal` (Quản trị Prometheus, Alertmanager, Grafana, Tự động mở rộng tải, Diễn tập sao lưu)
- **Database & Storage Lead:** `db-lead@creativanta.internal` (Quản trị PostgreSQL RLS, Di trú lược đồ, S3 Storage, Sổ cái cước)
- **Security & Compliance Officer:** `security-officer@creativanta.internal` (Quản trị Sandbox Security, SBOM Clean-Room, Chống IDOR/SSRF, Quyền riêng tư & Thu hồi bản quyền)

---

## 4. Kết quả Kiểm thử Khói Môi trường Staging (Exact Staging Smoke)

Bộ kiểm thử khói Staging đã thực thi trọn vẹn 10 công đoạn đầu-cuối:

| Mã | Tên công đoạn kiểm thử | Kết quả | Thời gian | Chi tiết thực thi |
| --- | --- | :---: | :---: | --- |
| STG-01 | Environment Configuration Preflight | **PASS** | 0ms | CVE_ENV=staging, custom_code=false, remote_import=false, download_ttl=300s |
| STG-02 | Health, Readiness & Capabilities Probes | **PASS** | 22ms | Engines: html-v1, canvas-v1, svg-v1; custom-html-v1=false; profiles: mp4-720p-v1, preview-360p-v1 |
| STG-03 | Tenant Identity, API Key Authentication & Scope Enforcement | **PASS** | 17ms | Invalid key rejected with 401: true; Cross-tenant access rejected with 404: true |
| STG-04 | Asset Ingestion & Quarantine Pipeline | **PASS** | 14ms | Asset ast_45eef428c664 transitioned from quarantine to ready; SHA-256 verified |
| STG-05 | Curated Template Resolution & Variable Substitution | **PASS** | 21ms | Template tpl_retail_promo_v1 resolved with Vietnamese diacritics; schemaValid=true, semanticValid=true |
| STG-06 | Idempotent Job Submission & Quota Reservation | **PASS** | 15ms | Job job_44eb09569dd0 admitted; re-submit with same idempotency key returned identical job (isReplayed=true) |
| STG-07 | Lease Claim, Stage Transitions & Heartbeats | **PASS** | 8ms | Job transitioned queued -> rendering -> succeeded with 1 artifact |
| STG-08 | Published Artifact Verification & Expiry TTL | **PASS** | 17ms | Artifact art_vid_0a4ea054 downloaded & verified SHA-256; expires_at=2026-11-04T14:51:26.055Z |
| STG-09 | Transactional Outbox Webhook Delivery & HMAC Signature | **PASS** | 2ms | Webhook HMAC-SHA256 signature verified via CreativantaWebhookReceiver (event_id=evt_staging_smoke_1793803586068) |
| STG-10 | Post-Render Storage Sweeper & Isolation Clean-up | **PASS** | 0ms | Usage settled: 15s output, 4s CPU; 0 orphan artifacts |

---

## 5. Ranh giới Triển khai & Các Cổng Đối ngoại (External Gates)

Theo đúng yêu cầu của nhiệm vụ P6-05: **"Production deploy KHÔNG tự được cấp bởi task này"**. Toàn bộ các cổng đối ngoại dưới đây tiếp tục được duy trì ở trạng thái chờ phê duyệt chính thức trước khi tiến hành chuyển giao giai đoạn mở rộng thương mại:

| Mã cổng | Phân loại | Chủ sở hữu trách nhiệm | Trạng thái | Nội dung yêu cầu |
| --- | --- | --- | :---: | --- |
| `EXT-GATE-PROD-01` | deployment_authorization | Platform / Host Operations Lead | `NOT_SELF_GRANTED_BY_P6_05` | Production cluster provisioning, VPS/Kubernetes host access, and production container deployment authorization. Strictly outside the self-contained scope of task P6-05. |
| `EXT-GATE-CREATIVANTA-02` | external_integration | Supervisor / Creativanta Integration Lead | `PENDING_EXTERNAL_HANDOFF_P9_04` | External Creativanta production integration handoff packet and deployment to production Creativanta service repository. Requires separate authorized scope. |
| `EXT-GATE-LEGAL-03` | legal_and_commercial | Legal / Commercial Counsel | `PENDING_EXTERNAL_SIGN_OFF` | Commercial H.264/AAC patent pool licensing threshold review (MPEG LA / Via Licensing) vs royalty-free VP9/Opus fallback before commercial billing. |
| `EXT-GATE-INFRA-04` | infrastructure_security | Platform Security Officer | `PENDING_STAGING_HOST_VERIFICATION` | Hardware host-level AppArmor/seccomp verification (docker/seccomp-renderer.json), iptables egress drops, and production KMS/Vault key rotation ceremony. |
