# Báo cáo bằng chứng nghiệm thu P10-A: Isolated Staging Backend Bootstrap & Connectivity Probes

Báo cáo nghiệm thu kỹ thuật cho luồng công việc `P10-A` (GitHub issue `#65`, parent `#63`), triển khai lớp khởi động backend an toàn (`fail-closed`), kiểm tra kết nối giao thức có giới hạn thời gian (`PostgreSQL v3 StartupMessage`, `AWS SigV4 HEAD`, `Worker Readiness HTTP`), đánh giá tính tương thích trình điều khiển `node:sqlite` so với `PostgreSQL 16+`, và xác thực tiến trình con HTTP loopback độc lập (`CVE_BACKEND_MODE=sqlite-test-only`, gán nhãn rõ ràng phi sản xuất `nonProductionTestOnly: true`). Phù hợp với [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) và hướng dẫn vận hành tại [ops/staging/STAGING_BACKEND.md](../../ops/staging/STAGING_BACKEND.md).

## 1. Khối bằng chứng bắt buộc (Mandatory Machine-Verifiable Block)

```text
Task: P10-A
Base / tested commit: f37bf5f784ce7533f88f8be8bc98d78ef2bf1082 / f37bf5f784ce7533f88f8be8bc98d78ef2bf1082
Environment: Linux x86_64, evergreen worktree (.worktrees/p10-backend), Node v24.21.0, pnpm v12.16.1, Python 3.12.3
Command: node ops/staging/staging-backend-verifier.mjs && node --test packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-06T16:05:52Z / 3.1s
Artifacts:
  - packages/api/src/db/backend-bootstrap.ts, sha256=23139aa7cb9008a0669e3b118a157715925f3ef9d87ff69c538a612d15e08c51, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=ceb02111c6e32ba660c962fd80cf79a38e18a457874df2e4cc7fe93ac2250681, expires=N/A (repo-versioned)
  - packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs, sha256=d2ae5b223a46d5a1fd0ca6528fa168aa35034313ec58685fbd04ee11a31a3bdc, expires=N/A (repo-versioned)
  - ops/staging/staging-backend-verifier.mjs, sha256=f00fc9b7c67cc018209a04abca9d11d82c93fd1f3fad7cdaa7f68f24cd814b66, expires=N/A (repo-versioned)
  - ops/staging/STAGING_BACKEND.md, sha256=c6c690ae3cd92d7ae3c3c2c39d3b4517dbcc087cb8b6ef3266870956cf927d71, expires=N/A (repo-versioned)
  - docker/staging/docker-compose.staging-isolated.yml, sha256=460579dfe1301a7e36e7cfeee7233f355b88706ce97805fbce4de2c9d15ce05c, expires=N/A (repo-versioned)
  - docker/staging/init-staging-roles.sql, sha256=930d1af280d957b4a5a03cf83f981a466a1b857e4c3b6b58078bcaaaabe63065, expires=N/A (repo-versioned)
  - docker/staging/staging.env.example, sha256=4c3455668af048216fd55c0883539c32bc4f85dc349c26d40e562a86cc30a033, expires=N/A (repo-versioned)
  - evidence/P10-A/backend-verification-summary.json, sha256=e7c45f3cd12caa542094dc2f5b80388a0ce1e3306419e106b01a7d358531d5a8, expires=N/A (repo-versioned)
Acceptance mapping:
  - Fail-closed staging environment validation (no default secrets, explicit vars, HTTPS, distinct buckets, least-privilege cve_api DB role, custom code & remote import off): PASS — Verified by P10A-ENV-01 in ops/staging/staging-backend-verifier.mjs and packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs
  - Honest node:sqlite vs PostgreSQL driver evaluation & 21-table RLS/FORCE RLS audit: PASS — Verified by P10A-RLS-02 (canServePostgresTraffic=false, 21/21 tables RLS & FORCE RLS verified, 5 DB roles verified)
  - Bounded protocol connectivity probes (PG v3 wire StartupMessage + Terminate, S3 AWS4-HMAC-SHA256 HEAD with redirect:manual, Worker readiness HTTP): PASS — Verified by P10A-PROBE-03 and unit fault-injection tests
  - Real child-process API startup in staging fail-closed mode & isolated sqlite-test-only two-tenant loopback mode: PASS — Verified by P10A-PROC-STAGING-04 and P10A-PROC-SQLITE-TEST-05 against packages/api/dist/index.js
Reviewer / reviewed commit / decision: pending independent reviewer / f37bf5f784ce7533f88f8be8bc98d78ef2bf1082 / local completion awaiting review
```

## 2. Chi tiết thực thi lệnh và trạng thái các cổng (Commands &Candid Gate Status)

| Hạng mục kiểm tra | Lệnh thực thi | Kết quả | Chi tiết / Lý do |
| --- | --- | --- | --- |
| Build toàn bộ workspace | `pnpm -r --if-present build` | `PASS` (exit `0`) | Biên dịch sạch 8 gói TypeScript (`contracts`, `api`, `controller`, `ingest`, `renderers`, `sdk`, `templates`, `browser-export`) |
| Kiểm tra kiểu & lint | `pnpm -r --if-present lint && pnpm -r --if-present typecheck` | `PASS` (exit `0`) | Không có lỗi TypeScript; giữ tương thích hoàn toàn với PR `#64` (`server.ts` không bị chỉnh sửa trên nhánh này) |
| Kiểm thử đơn vị & tích hợp P10-A | `node --test packages/api/test/p10-a-backend-bootstrap-and-probes.test.mjs` | `PASS` (exit `0`) | `6/6` bài kiểm thử đạt (kiểm tra env guard, RLS audit, PG v3 wire probe, S3 SigV4 probe, worker probe, child-process 2-tenant anti-IDOR) |
| Trình xác thực backend P10-A | `node ops/staging/staging-backend-verifier.mjs` | `PASS` (exit `0`) | `5/5` chặng (`P10A-ENV-01` đến `P10A-PROC-SQLITE-TEST-05`) đạt trên tiến trình thực `packages/api/dist/index.js` |
| Kiểm toán bảo mật & SBOM (P6-04) | `node --test ops/test/security-review-p6-04.test.mjs` | `PASS` (exit `0`) | `externalRuntimeDependenciesCount = 0`; không thêm gói npm ngoài chưa duyệt |
| Xác thực kho lưu trữ | `python3 scripts/validate_repo.py` | `PASS` (exit `0`) | Toàn bộ tài liệu, liên kết nội bộ, khối JSON và 52 tác vụ hợp lệ |
| Kiểm tra định dạng diff Git | `git diff --check` | `PASS` (exit `0`) | Không có lỗi khoảng trắng thừa hoặc xung đột đánh dấu |
| Triển khai PostgreSQL/S3/Worker thực trên host staging | N/A (cấm tạo/sửa dịch vụ host trong phạm vi worker này) | `BLOCKED` | `TenantRepository` hiện gắn với `node:sqlite` đồng bộ (`DatabaseSync`); chưa có trình điều khiển PostgreSQL bất đồng bộ và chưa được cấp cụm dịch vụ staging thực |
| 6 cổng phê duyệt GA bên ngoài (Issue `#61`) | N/A (cần phê duyệt độc lập của con người/pháp lý/hạ tầng) | `BLOCKED` | Giữ nguyên trạng thái `HOLD` theo issue `#61` và PR `#56` (`REVIEW_REQUIRED`) |

## 3. Đánh giá kỹ thuật trung thực: Bất tương thích `node:sqlite` và `PostgreSQL`

1. **Hiện trạng `TenantConnectionPool` và `TenantRepository`:**
   - [tenant-pool.ts](../../packages/api/src/db/tenant-pool.ts) sử dụng `DatabaseSync` từ mô-đun tích hợp `node:sqlite` với giao dịch đồng bộ `withTransaction<T>()` (`BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`) và mô phỏng `SET LOCAL app.current_tenant_id` cùng ma trận phân quyền 5 role và `FORCE ROW LEVEL SECURITY` trong bộ nhớ.
   - [repository.ts](../../packages/api/src/db/repository.ts) và [server.ts](../../packages/api/src/server.ts) gọi đồng bộ tất cả các phương thức truy vấn mà không qua `async/await` hoặc kết nối mạng TCP tới PostgreSQL.
   - Kho lưu trữ hiện không cài đặt bất kỳ thư viện client PostgreSQL nào (`externalRuntimeDependenciesCount === 0` trong [pnpm-lock.yaml](../../pnpm-lock.yaml)).
2. **Cách xử lý trung thực trong `P10-A`:**
   - Khi chạy ở chế độ `CVE_ENV=staging` hoặc `CVE_BACKEND_MODE=postgres`, `bootstrapApiBackend()` kiểm tra nghiêm ngặt biến môi trường và tệp di trú SQL ([0001_tenant_foundation.up.sql](../../migrations/0001_tenant_foundation.up.sql)), gắn các probe giao thức thật (`probePostgresConnectivity`, `probeObjectStorageConnectivity`, `probeRendererWorkerReadiness`), nhưng **tuyệt đối không** khởi tạo `TenantRepository` giả bằng SQLite và giữ `repositoryDriverCompatible: false` (`readyForTraffic: false`).
   - Khi chạy ở chế độ kiểm thử tiến trình cô lập `CVE_BACKEND_MODE=sqlite-test-only` (chỉ cho phép khi `CVE_ENV=development`), tiến trình con `packages/api/dist/index.js` gắn nhãn rõ ràng `non_production_test_only: true`, chỉ chấp nhận bản ghi khóa API đã băm (`cve_test_<12hex>` + `keyHash`, cấm khóa dạng rõ trong biến môi trường), thực thi đầy đủ luồng xác thực đa tenant + chống IDOR (`404` trên đường dẫn URL, `422 ASSET_NOT_FOUND` trong thân JSON), đồng thời vẫn giữ `/readyz` ở trạng thái `not_ready` (`database: false`) theo mặc định.

## 4. Các bước tiếp theo (Next Tasks)

1. Sau khi PR `#64` (`ops/api-readiness-fail-closed-20261106`) được hợp nhất vào `staging`, hợp nhất `staging` vào nhánh này để kết hợp `readinessProbe` trong [server.ts](../../packages/api/src/server.ts) với `bootstrapApiBackend()` trong [index.ts](../../packages/api/src/index.ts).
2. Thực hiện nhiệm vụ tiếp theo để chuyển đổi `TenantConnectionPool`, `TenantRepository` và [server.ts](../../packages/api/src/server.ts) sang giao diện bất đồng bộ (`async/await`) sử dụng trình điều khiển PostgreSQL đã qua kiểm toán SBOM/SPDX và kiểm thử thực tế với PostgreSQL 16 (`SET LOCAL app.current_tenant_id`, `FORCE ROW LEVEL SECURITY`, 5 role tách biệt).
3. Giữ nguyên trạng thái `HOLD` đối với phát hành sản xuất/beta/GA cho đến khi hoàn tất kiểm thử E2E không giả lập (`P10-B`) và có đầy đủ 6 phê duyệt bên ngoài tại issue `#61`.
