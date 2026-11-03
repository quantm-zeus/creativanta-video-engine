# Báo cáo bằng chứng nghiệm thu nhiệm vụ P1-05

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P1-05` (`A+C / P1`): Thiết lập các công việc CI hoàn chỉnh (docs, contracts, lint, typecheck, unit), bộ kiểm thử khói di trú cơ sở dữ liệu (migration smoke harness), cơ chế bảo vệ che giấu thông tin bí mật (secrets redacted), chốt phiên bản runner và cache bất biến (pinned runners/cache), chuẩn hóa định dạng bằng chứng theo chuẩn quy định tại [AGY execution](../../docs/AGENTS.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security](../../docs/SECURITY.md), [Deployment](../../docs/DEPLOYMENT.md), [Architecture](../../docs/ARCHITECTURE.md) và [Testing](../../docs/TESTING.md).

```text
Task: P1-05
Base / tested commit: 0f532f82d3c0294b5bba427e722aa074036e0897 / 74013317a8eecc237cb3ae1835568a5322f5065e
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.12
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm test && node packages/contracts/dist/migration/cli.js --smoke && node packages/controller/dist/index.js --self-test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T04:35:00Z / 15.2s
Artifacts:
  - .github/workflows/video-engine-ci.yml, sha256=809f4819efbb91ee042ab35a314802337cee52b42c00a6cf83bd11461a32f5d1, expires=N/A (repo-versioned)
  - docker/migrations/001_init_schema_migrations.sql, sha256=9071443efe4fe372e7a5ee7499df2ea6a69eac06140bb9ac896ffab4b9eb81f0, expires=N/A (repo-versioned)
  - docker/migrations/002_scaffold_system_catalog.sql, sha256=4fd5167f97b0a6d3f34c80cdcf29ec615980888123f57ec7cba9ab4130988a0a, expires=N/A (repo-versioned)
  - docker/migrations/003_seed_synthetic_catalog.sql, sha256=ed42e11391b50ec896b695c5332127d4b20b463c005f9657a461d0080af22c35, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/types.ts, sha256=c12e68c7f875677c625c430e6a69d25690f8d7eadaa808cfeee4c5371813b885, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/checksum.ts, sha256=111a7a287ba820606fc35b1dec78022dc7aeff9cce04987206a632b251c1a0af, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/discovery.ts, sha256=e8ca7c1ac77c449eceaee0ba245feb306aff98957abe6efe2917423a4ab20793, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/in-memory-client.ts, sha256=b6ea8009571aa259f60999217ba7f95e34c5e14d844c6f81e2087a7df257ea92, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/wire-client.ts, sha256=dc47c684dec0d282830152b246e30841ae8cc4197a37ad989881f8ae02ce7f5c, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/runner.ts, sha256=7e4c820d866e063738c073b180bf0f19bd55152e3de6d18ffab1a24696fcf4f4, expires=N/A (repo-versioned)
  - packages/contracts/src/migration/cli.ts, sha256=905a8862f25984d602e4aa82341e11d341f3af663568eaa244ff1b750aa69e54, expires=N/A (repo-versioned)
  - packages/contracts/test/migration.test.mjs, sha256=0565e95952ef9b3519a41b145a12d11efeab3b8aa02621a53087c59f9a8234dd, expires=N/A (repo-versioned)
  - evidence/P1-05/summary.json, sha256=fc7ec4de51a4b3f0df1bc7f37f18d770ea798192cbafdce7b00f73cd2e5db72e, expires=N/A (repo-versioned)
Acceptance mapping:
  - CI jobs docs/contracts/lint/typecheck/unit: PASS — .github/workflows/video-engine-ci.yml phân tách 6 jobs độc lập, song song (docs, contracts, lint, typecheck, unit, migration) bao phủ 100% kiểm tra tài liệu, hợp đồng JSON Schema/OpenAPI, linting, typechecking nghiêm ngặt và toàn bộ unit/harness test suites
  - migration smoke harness: PASS — Triển khai đầy đủ gói di trú và kiểm tra khói cơ sở dữ liệu (docker/migrations/, packages/contracts/src/migration/), hỗ trợ giao thức PostgreSQL Wire Protocol v3.0 thuần TypeScript, kiểm định mã băm SHA-256 chống giả mạo, kiểm tra tính lũy đan (idempotency), thu hồi giao dịch (transactional rollback), kiểm định độ tương thích phiên bản schema cho probe /readyz và kiểm tra phân tách quyền 5 roles
  - secrets redacted: PASS — Khóa cứng persist-credentials: false trên toàn bộ bước checkout; hàm redactUrlCredentials và redactSecretString loại bỏ hoàn toàn mật khẩu khỏi logs, chuỗi kết nối và báo cáo lỗi; kiểm tra tự động quét regex ngăn chặn token nhạy cảm trong repository
  - pinned runners/cache: PASS — Khóa cứng runner trên toàn bộ jobs (runs-on: ubuntu-24.04), các actions chỉ định phiên bản chính xác (actions/checkout@v4.2.2, actions/setup-node@v4.2.0, actions/setup-python@v5.4.0, actions/cache@v4.2.0), Node.js v24.22.2, pnpm 12.16.1 và khóa cache pnpm store theo mã băm pnpm-lock.yaml
  - evidence format standardized: PASS — Báo cáo bằng chứng tuân thủ nghiêm ngặt khuôn mẫu evidence/P0-05/evidence-template.md với 9 trường chuẩn và tệp JSON kết quả hợp lệ tại evidence/P1-05/summary.json
  - No fake render pass: PASS — Khẳng định nguyên tắc Milestone P1 chỉ là G1 Scaffold; quy trình CI tuyệt đối không chứa bước giả mạo render hoặc video giả, việc dựng video thật được bảo vệ và hoãn lại cho tới Milestone P2 (P2-01..P2-05)
Reviewer / reviewed commit / decision: pending independent reviewer / 79a4dd67524ea4e3f8f4baf333e71870dddcf419 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P1-05** (`A+C / P1`) là cột mốc hoàn thiện giai đoạn **P1 — Scaffold có thể kiểm chứng** trong [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md). Nhiệm vụ này thiết lập toàn diện hệ thống tích hợp liên tục (CI), bộ kiểm thử khói di trú dữ liệu (migration smoke harness) và các rào chắn bảo mật nghiêm ngặt theo đúng đặc tả tại [Testing](../../docs/TESTING.md), [Security](../../docs/SECURITY.md) và [AGY execution](../../docs/AGENTS.md).

Toàn bộ các tiêu chí nghiệm thu kỹ thuật đã được triển khai và kiểm chứng đầy đủ trong phạm vi các thư mục được cấp phép (`.github/`, `docker/`, `packages/`, `evidence/P1-05/`):

1. **Kiến trúc GitHub Actions CI 6 Jobs Độc lập ([video-engine-ci.yml](../../.github/workflows/video-engine-ci.yml)):**
   - Phân tách cấu trúc thành 6 jobs chuyên biệt, có thể chạy song song và tự hủy khi có commit mới (`cancel-in-progress: true`):
     - `docs`: Kiểm tra toàn vẹn 16 tài liệu bắt buộc, 26 tệp markdown, 266 liên kết nội bộ, 15 khối JSON, 11 tệp JSON, 3 biểu đồ Mermaid, DAG 52 tasks không có chu trình bằng [validate_repo.py](../../scripts/validate_repo.py); đồng thời quét bảo mật chặn commit chứa token/khóa bí mật.
     - `contracts`: Kiểm định hợp đồng JSON Schema 2020-12, đặc tả OpenAPI 3.1 và toàn bộ fixtures hợp lệ / không hợp lệ.
     - `lint`: Kiểm tra chuẩn mã nguồn và cú pháp TypeScript strict mode trên toàn monorepo (`pnpm -r --if-present run lint`).
     - `typecheck`: Kiểm tra kiểu tĩnh strict mode không sinh code phát sinh trên toàn bộ workspace packages (`pnpm -r --if-present run typecheck`).
     - `unit`: Chạy toàn bộ 69 test cases Node.js trên 4 packages, bộ kiểm tra tự thân sandbox controller (`node packages/controller/dist/index.js --self-test`), bộ test supervisor harness (10/10 tests), bộ test task ledger & worktree policy (13/13 tests) và probe sức khỏe hệ thống ([health-check.mjs](../../scripts/health-check.mjs)).
     - `migration`: Khởi chạy container dịch vụ PostgreSQL 16 (`postgres:16-alpine`), nạp các vai trò phân tách từ [01-init.sql](../../docker/init-db/01-init.sql) và chạy bộ kiểm thử khói di trú cơ sở dữ liệu thực tế.

2. **Bộ kiểm thử khói di trú cơ sở dữ liệu (Migration Smoke Harness):**
   - **Tệp di trú chuẩn tắc ([docker/migrations/](../../docker/migrations/)):**
     - `001_init_schema_migrations.sql`: Khởi tạo bảng theo dõi `schema_migrations` (`version`, `name`, `checksum`, `applied_at`, `execution_time_ms`) và cấp quyền `SELECT` cho các vai trò ứng dụng (`cve_api`, `cve_dispatcher`, `cve_ingest`, `cve_sender`).
     - `002_scaffold_system_catalog.sql`: Khởi tạo bảng `system_catalog` (`key`, `category`, `value`, `visibility`) và bảng `tenants` cơ sở, phân quyền tối thiểu nghiêm ngặt.
     - `003_seed_synthetic_catalog.sql`: Nạp các hồ sơ cấu hình chuẩn tắc (`mp4-720p-v1`, `preview-360p-v1`, engines `html-v1`, `canvas-v1`, `svg-v1`, `custom-html-v1: false`).
   - **Module Di trú thuần TypeScript ([packages/contracts/src/migration/](../../packages/contracts/src/migration/)):**
     - [checksum.ts](../../packages/contracts/src/migration/checksum.ts): Chuẩn hóa SQL và tính toán mã băm SHA-256 tất định.
     - [discovery.ts](../../packages/contracts/src/migration/discovery.ts): Phân tích tên tệp di trú, tự động nạp từ thư mục hoặc bộ định nghĩa tích hợp sẵn (bundled definitions).
     - [wire-client.ts](../../packages/contracts/src/migration/wire-client.ts): Client kết nối giao thức PostgreSQL Wire Protocol v3.0 thuần TypeScript (không cần thư viện bên ngoài), hỗ trợ xác thực mật khẩu Cleartext, MD5 và bắt lỗi kèm che giấu thông tin bí mật.
     - [in-memory-client.ts](../../packages/contracts/src/migration/in-memory-client.ts): Client giả lập trong bộ nhớ phục vụ unit test nhanh, tất định, kiểm thử giao dịch (`BEGIN`, `COMMIT`, `ROLLBACK`) và khóa tư vấn (`pg_advisory_lock`).
     - [runner.ts](../../packages/contracts/src/migration/runner.ts): Quản lý vòng đời di trú, kiểm tra tính toàn vẹn mã băm (phát hiện giả mạo qua `ChecksumMismatchError`), thực thi lũy đan, thu hồi an toàn khi gặp lỗi, và cung cấp API kiểm tra tương thích schema (`checkCompatibility`) phục vụ probe `/readyz`.
     - [cli.ts](../../packages/contracts/src/migration/cli.ts): Giao diện dòng lệnh (`--smoke`, `--migrate`, `--status`, `--mock`) tự động làm sạch URL và che giấu toàn bộ credentials trong output.

3. **Cơ chế che giấu thông tin bí mật (Secrets Redaction):**
   - Thiết lập `persist-credentials: false` trên toàn bộ 6 bước `actions/checkout` của workflow.
   - Hàm `redactUrlCredentials` tự động thay thế mật khẩu trong chuỗi kết nối PostgreSQL thành `REDACTED` trước khi ghi vào log hoặc thông báo lỗi.
   - Quét regex trong CI chặn đứng việc vô tình lưu trữ private key hoặc API token thật trong kho mã nguồn.

4. **Chốt phiên bản Runner và Cache (Pinned Runners & Cache):**
   - Khóa cứng `runs-on: ubuntu-24.04` trên toàn bộ các công việc CI.
   - Khóa cứng các GitHub Actions: `actions/checkout@v4.2.2`, `actions/setup-node@v4.2.0`, `actions/setup-python@v5.4.0`, `actions/cache@v4.2.0`.
   - Khóa cứng môi trường thực thi: Node.js `24.22.2`, pnpm `12.16.1` (qua Corepack) và Python `3.12`.
   - Khóa cứng đường dẫn cache pnpm store (`~/.local/share/pnpm/store`) gắn với mã băm của tệp bất biến `pnpm-lock.yaml`.

5. **Tuyệt đối không giả mạo kết xuất video (No Fake Render Pass):**
   - Tuân thủ nghiêm ngặt nguyên tắc của Milestone P1 (Scaffold only): CI không chứa bất kỳ công việc giả vờ render video MP4 nào.
   - Toàn bộ việc kết xuất video thực tế được bảo lưu nguyên vẹn cho Milestone P2 (`P2-01` đến `P2-05`).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Thời gian | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run build` | `0` | 5.1s | `PASS` | Biên dịch TypeScript cả 4 packages sang thư mục ESM `dist/` |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run typecheck` | `0` | 4.7s | `PASS` | Kiểm tra kiểu tĩnh strict mode toàn monorepo không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run lint` | `0` | 4.5s | `PASS` | Kiểm tra quy chuẩn mã nguồn và linting toàn workspace |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run test` | `0` | 2.5s | `PASS` | 69/69 test cases native Node.js (bao gồm 18 bài test migration mới) đều vượt qua |
| 5 | `node packages/contracts/dist/migration/cli.js --smoke` | `0` | 0.08s | `PASS` | Kiểm thử khói di trú: nạp ban đầu, kiểm tra lũy đan, độ tương thích schema, phân tách quyền 5 roles |
| 6 | `node packages/controller/dist/index.js --self-test` | `0` | 0.29s | `PASS` | 8/8 bài kiểm tra tự thân môi trường sandbox renderer đều đạt chuẩn an toàn |
| 7 | `node scripts/health-check.mjs` | `0` | 0.16s | `PASS` | Xác thực cấu hình môi trường, liveness probe `/healthz`, readiness probe `/readyz` và capabilities |
| 8 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | 0.38s | `PASS` | Kiểm tra toàn vẹn 16 docs, 26 tệp md, 266 links, DAG 52 tasks không chu trình |
| 9 | `PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v` | `0` | 1.02s | `PASS` | 10/10 bài kiểm thử supervisor harness, retry budget và cơ chế CI fails-closed |
| 10 | `PATH=/usr/bin:$PATH python3 -m unittest evidence/P0-05/test_task_ledger.py` | `0` | 0.77s | `PASS` | 13/13 bài kiểm thử task ledger, worktree policy và crash recovery drill |

---

## 3. Cổng kiểm soát ngoại bộ và bước tiếp theo (External Gates & Next Steps)

1. **Cổng kiểm soát ngoại bộ chưa hoàn tất (Pending External Gates):**
   - Đánh giá độc lập (Peer review) của reviewer và kiểm duyệt CI trên nhánh `staging` của GitHub.
   - Chưa kết xuất 3 video MP4 thực tế (nhiệm vụ của Milestone P2: `P2-01` đến `P2-05`).
   - Chưa nạp toàn bộ 21 bảng production, RLS policies và bộ kiểm thử chống IDOR (nhiệm vụ của `P3-01`).

2. **Kế hoạch nhiệm vụ tiếp theo:**
   - Hoàn tất Milestone P1 (G1 Scaffold).
   - Sẵn sàng chuyển tiếp sang **Milestone P2 — First useful POC, ba MP4 thật và engine decision** bắt đầu với nhiệm vụ `P2-01` (HyperFrames adapter spike và minimal Chromium/FFmpeg baseline).
