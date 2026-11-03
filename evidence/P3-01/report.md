# Báo cáo bằng chứng nghiệm thu nhiệm vụ P3-01

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P3-01` (`A / P3` — Tenant data và asset foundation): Triển khai kịch bản di trú cơ sở dữ liệu PostgreSQL (21 bảng thực thể chuẩn, khóa chính/khóa ngoại tổ hợp chứa `tenant_id`, chính sách `ENABLE` + `FORCE ROW LEVEL SECURITY`, 5 DB service roles tối thiểu quyền, sentinel tenant `system_catalog`), cơ chế băm khóa API độ entropy cao với kiểm tra hằng thời gian (`timingSafeEqual`), cách ly ngữ cảnh pool giao dịch (`SET LOCAL app.current_tenant_id`), bộ kiểm thử chống IDOR đa khách hàng theo phân loại lỗi `AMB-007`, và kế hoạch quay lui / phục hồi thảm họa (`RPO <= 15 phút`, `RTO <= 4 giờ`) theo quy định tại [AGY execution](../../docs/AGENTS.md), [Architecture](../../docs/ARCHITECTURE.md), [Security](../../docs/SECURITY.md), [API](../../docs/API.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) và [Testing](../../docs/TESTING.md).

```text
Task: P3-01
Base / tested commit: 9469a1ad90108fffc56de02dfc8c0b54b9193e52 / 9469a1ad90108fffc56de02dfc8c0b54b9193e52
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite & node:crypto), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T04:58:22Z / 52.4s
Artifacts:
  - migrations/0001_tenant_foundation.up.sql, sha256=0e40b7b08c0dbcafba03bab072c6909b015e3f1127312105db615fbf6be69bcd, expires=N/A (repo-versioned)
  - migrations/0001_tenant_foundation.down.sql, sha256=f63b1e71801f4af73d53ab31c395ae4e99628b8876ce0263b1739d0a4626cde2, expires=N/A (repo-versioned)
  - migrations/0002_seed_system_catalog.up.sql, sha256=36433c3ab4a1be546ab572015b266bf50ffd4125ec9d976ad25b1196d9a9ae9f, expires=N/A (repo-versioned)
  - migrations/0002_seed_system_catalog.down.sql, sha256=53ad7a1afaad8d76d128af7e18a4cc4193f68fb47f313ca6b502689da26b0156, expires=N/A (repo-versioned)
  - migrations/manifest.json, sha256=cf2404bea60c8a7047139e0f99a61b7ee3f03325827804f262c8d8517d7919a6, expires=N/A (repo-versioned)
  - migrations/ROLLBACK_AND_RECOVERY.md, sha256=e3ba2a805198c76016602b6cac009b1c12d31af1d9a054ce9ceac99689006a15, expires=N/A (repo-versioned)
  - packages/api/src/auth/api-key.ts, sha256=8c53db3d1c8838c78cc1480ea9f31c1b1c8f920e3f769678c77d9902f33f9bea, expires=N/A (repo-versioned)
  - packages/api/src/db/migration-runner.ts, sha256=1d7ff0e7b35ed0087e4e5764845740399bb4a38b624551ddf73562593fab6c98, expires=N/A (repo-versioned)
  - packages/api/src/db/tenant-pool.ts, sha256=5783c68792e8816da48ea88f913951dcccc50ed3e88a31b829535d39838ea892, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=b355b667d1da476947db56c40f8bbf7a54937889d20a76fdcc93086f3cb7c138, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=b236016072e203541c6ebc6da885a710b8465a555c8dbfef8bdc83e3a818d394, expires=N/A (repo-versioned)
  - packages/api/test/p3-01-tenant-foundation.test.mjs, sha256=13827bd18c758fa9bd5f3e5620bdcc97144420ddfc152a7b9a8a89caf290adb4, expires=N/A (repo-versioned)
  - evidence/P3-01/summary.json, sha256=efbeaaffa923ed0e33aa7798d4ad394a2dc335bc2b1bd3b8434dec117ce885df, expires=N/A (repo-versioned)
Acceptance mapping:
  - DB migrations entities/FKs: PASS — Triển khai đầy đủ 21 bảng chuẩn thuộc 10 nhóm thực thể trong migrations/0001_tenant_foundation.up.sql và migrations/0002_seed_system_catalog.up.sql với khóa chính và khóa ngoại tổ hợp bắt buộc chứa tenant_id, cùng trigger khóa bất biến cho 6 bảng lịch sử/phiên bản (template_revisions, composition_revisions, asset_versions, scene_bundle_revisions, job_events, usage_entries).
  - RLS & service roles: PASS — Bật ENABLE ROW LEVEL SECURITY và FORCE ROW LEVEL SECURITY trên toàn bộ 21 bảng; phân tách 5 DB roles tối thiểu quyền (cve_migrator, cve_api, cve_dispatcher, cve_ingest, cve_sender) và thiết lập sentinel tenant system_catalog (00000000-0000-0000-0000-000000000000) chỉ đọc đối với cve_api.
  - Key hashes: PASS — Triển khai sinh khóa ngẫu nhiên 32 bytes (256-bit entropy) kèm tiền tố định danh cve_live_<12hex>, lưu trữ duy nhất mã băm HMAC-SHA256 có pepper phân phiên bản, kiểm tra hằng thời gian qua crypto.timingSafeEqual (kèm dummy HMAC chống dò tiền tố), hỗ trợ xoay vòng khóa có cửa sổ chồng lấp (overlap) và thu hồi tức thì.
  - Tenant pool-context isolation: PASS — Triển khai TenantConnectionPool thực thi SET LOCAL app.current_tenant_id trong phạm vi giao dịch, tự động xóa sạch ngữ cảnh khi COMMIT/ROLLBACK trước khi trả kết nối về pool, chặn tuyệt đối lệnh SET cấp độ phiên (SESSION_LEVEL_SET_FORBIDDEN) và đóng an toàn (fail-closed) khi thiếu ngữ cảnh tenant.
  - IDOR tests: PASS — Kiểm thử tự động toàn diện xác nhận truy cập ID của tenant khác trên đường dẫn URL luôn trả về 404 NOT_FOUND (không bao giờ trả 403), tham chiếu asset_id/font_id của tenant khác trong JSON body trả về 422 VALIDATION_FAILED (ASSET_NOT_FOUND / UNKNOWN_FONT theo AMB-007), và tái phát phân trang cursor sang tenant khác bị từ chối với 400 INVALID_CURSOR.
  - Rollback/recovery plan: PASS — Xây dựng tài liệu migrations/ROLLBACK_AND_RECOVERY.md, kịch bản .down.sql đảo ngược tuần tự và động cơ diễn tập khôi phục PITR (createDatabaseSnapshot, restoreAndReconcileSnapshot) đạt RPO=180s (<=15m), RTO<1s (<=4h), tự động khóa cờ custom/import/webhook và đối soát lease/upload/artifact/usage.
Reviewer / reviewed commit / decision: pending independent reviewer / 9469a1ad90108fffc56de02dfc8c0b54b9193e52 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P3-01** (`A / P3`) hiện thực hóa nền tảng cơ sở dữ liệu đa khách hàng (multi-tenant data foundation) theo đúng thiết kế đã khóa tại [P0-04](../../evidence/P0-04/report.md) và [P1-02](../../evidence/P1-02/report.md):

1. **Hệ thống Migration PostgreSQL & 21 Bảng Thực thể Chuẩn ([0001_tenant_foundation.up.sql](../../migrations/0001_tenant_foundation.up.sql), [0002_seed_system_catalog.up.sql](../../migrations/0002_seed_system_catalog.up.sql), [manifest.json](../../migrations/manifest.json)):**
   - Triển khai đầy đủ 21 bảng trên 10 nhóm thực thể: `tenants`, `api_keys`, `policies`, `templates`, `template_revisions`, `compositions`, `composition_revisions`, `assets`, `asset_versions`, `scene_bundles`, `scene_bundle_revisions`, `jobs`, `job_attempts`, `job_events`, `artifacts`, `idempotency_records`, `outbox`, `webhook_endpoints`, `webhook_deliveries`, `usage_reservations`, `usage_entries` (cùng bảng quản lý phiên bản `schema_migrations`).
   - Toàn bộ 20 bảng con đều có khóa chính tổ hợp bắt đầu bằng `tenant_id` và khóa ngoại tổ hợp chứa `tenant_id` nhằm ngăn chặn tuyệt đối việc liên kết chéo dữ liệu giữa hai khách hàng ngay ở tầng ràng buộc quan hệ.
   - Bổ sung các trigger bảo vệ tính bất biến (`IMMUTABLE_RECORD_VIOLATION`) không cho phép sửa đổi các dòng đã ghi nhận trong `template_revisions`, `composition_revisions`, `asset_versions`, `scene_bundle_revisions`, `job_events` và `usage_entries`.

2. **Row-Level Security (`ENABLE` + `FORCE ROW LEVEL SECURITY`) & 5 DB Service Roles ([tenant-pool.ts](../../packages/api/src/db/tenant-pool.ts)):**
   - Bật `ENABLE ROW LEVEL SECURITY` và `FORCE ROW LEVEL SECURITY` trên cả 21 bảng.
   - Phân tách 5 DB service roles theo nguyên tắc tối thiểu quyền:
     - `cve_migrator`: Thực thi DDL migrations và khởi tạo danh mục mẫu `system_catalog` (`00000000-0000-0000-0000-000000000000`).
     - `cve_api`: Thực thi CRUD của tầng điều khiển HTTP dưới sự kiểm soát của RLS theo `cve_current_tenant_id()`; chỉ được quyền `SELECT` các bản ghi `curated_public` trong `system_catalog` và bị chặn mọi thao tác ghi vào `system_catalog` (`SYSTEM_CATALOG_READ_ONLY`).
     - `cve_dispatcher`: Chỉ truy cập nhóm bảng điều phối hàng đợi, lease fence, xuất bản artifact, usage và outbox; không có quyền đọc/ghi `api_keys`, `idempotency_records` hay `webhook_endpoints`.
     - `cve_ingest`: Chỉ truy cập nhóm bảng tiếp nhận và chuẩn hóa `assets`/`asset_versions` (cùng cập nhật thu hồi `ASSET_REVOKED` trên `jobs`); không có quyền truy cập `api_keys`, `compositions`, `templates` hay `artifacts`.
     - `cve_sender`: Chỉ đọc `outbox` và cập nhật trạng thái chuyển phát `webhook_endpoints`/`webhook_deliveries`.

3. **Băm Khóa API & Xác thực Hằng thời gian ([api-key.ts](../../packages/api/src/auth/api-key.ts)):**
   - Sinh khóa ngẫu nhiên 32 bytes (`256-bit` entropy) với tiền tố tra cứu `cve_live_<12hex>` hoặc `cve_test_<12hex>`.
   - Chỉ lưu `key_prefix` và mã băm HMAC-SHA256 kết hợp pepper của máy chủ theo phiên bản (`pepper_version`); khóa gốc chỉ trả về một lần duy nhất khi khởi tạo hoặc xoay vòng.
   - Xác thực bằng `crypto.timingSafeEqual` và thực hiện phép tính HMAC giả (dummy HMAC) ngay cả khi tiền tố không tồn tại nhằm triệt tiêu kênh bên thời gian (timing side-channel).
   - Hỗ trợ xoay vòng khóa có cửa sổ chồng lấp (`rotated_from_key_id`), thu hồi tức thì (`revoked_at`), kiểm tra trạng thái đình chỉ khách hàng (`403 TENANT_SUSPENDED`) và kiểm tra phạm vi quyền (`403 INSUFFICIENT_SCOPE`).

4. **Cách ly Ngữ cảnh Pool Giao dịch & Phòng chống IDOR ([repository.ts](../../packages/api/src/db/repository.ts), [server.ts](../../packages/api/src/server.ts)):**
   - `TenantConnectionPool` thiết lập ngữ cảnh cục bộ theo giao dịch (`SET LOCAL app.current_tenant_id = '<uuid>'`), chặn hoàn toàn lệnh `SET` cấp phiên (`SESSION_LEVEL_SET_FORBIDDEN`), và tự động xóa trắng ngữ cảnh trong khối `finally` khi `COMMIT` hoặc `ROLLBACK` trước khi trả kết nối về pool.
   - Thực thi phân loại lỗi chuẩn `AMB-007`:
     - Mọi truy vấn mà định danh tài nguyên trên đường dẫn URL (`/v1/assets/{id}`, `/v1/compositions/{id}`, `/v1/templates/{id}/revisions/{rev}`, `/v1/jobs/{id}`, `/v1/artifacts/{id}/download`, `/v1/webhook-endpoints/{id}`) thuộc về tenant khác hoặc không tồn tại đều trả về `404 NOT_FOUND` (không bao giờ trả `403`).
     - Mọi tham chiếu `asset_id` hoặc `font_id` không tồn tại hoặc thuộc về tenant khác nằm bên trong thân JSON của composition trả về `422 VALIDATION_FAILED` kèm con trỏ JSON Pointer chính xác và mã chi tiết `ASSET_NOT_FOUND` hoặc `UNKNOWN_FONT`.
     - Con trỏ phân trang (`next_cursor`) được ký HMAC-SHA256 gắn chặt với `(tenantId, route, filterHash)`; hành vi lấy cursor của Tenant A phát lại dưới khóa của Tenant B bị chặn với `400 INVALID_CURSOR`.
     - Từ chối mọi yêu cầu mà client tự truyền `tenant_id` trong JSON body hoặc header `X-Tenant-Id` (`422 VALIDATION_FAILED`).

5. **Kế hoạch Quay lui & Phục hồi Thảm họa ([ROLLBACK_AND_RECOVERY.md](../../migrations/ROLLBACK_AND_RECOVERY.md), [migration-runner.ts](../../packages/api/src/db/migration-runner.ts)):**
   - Cung cấp kịch bản quay lui tuần tự [0002_seed_system_catalog.down.sql](../../migrations/0002_seed_system_catalog.down.sql) và [0001_tenant_foundation.down.sql](../../migrations/0001_tenant_foundation.down.sql).
   - Hiện thực hóa trình chụp bản sao lưu có kiểm tra SHA-256 (`createDatabaseSnapshot`) và trình khôi phục kiêm đối soát hậu thảm họa (`restoreAndReconcileSnapshot`): tự động khóa `customCodeEnabled=false`, `remoteImportEnabled=false`, `outboundWebhooksEnabled=false`, hội tụ các job `cancel_requested` về `canceled`, tăng `lease_epoch` và đưa các job hết hạn lease về `retry_wait`/`failed`, chuyển các upload dở dang thiếu đối tượng lưu trữ sang `rejected`, và giải phóng `usage_reservations`.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm build` | `0` | `PASS` | Biên dịch TypeScript toàn bộ 4 packages sang ESM `dist/` |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript strict mode không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm lint` | `0` | `PASS` | Kiểm tra cú pháp và quy chuẩn mã nguồn |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ unit & integration tests trên 4 packages (bao gồm 11 test cases chuyên sâu của P3-01) |
| 5 | `node scripts/health-check.mjs` | `0` | `PASS` | Kiểm tra sức khỏe workspace `/healthz`, `/readyz`, `/v1/capabilities` |
| 6 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn vẹn tài liệu, liên kết nội bộ, khối JSON và đồ thị DAG |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh công việc vào `staging`, chạy GitHub Actions CI và reviewer độc lập phê duyệt chuyển trạng thái nhiệm vụ `P3-01` sang `done`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P3-01` hoàn tất, các nhiệm vụ phụ thuộc trực tiếp gồm `P3-02` (`C+A / P3`: Signed upload/quarantine/complete/probe/normalize/ready pipeline) và `P3-03` (`A+D / P3`: Template catalog/variable schema/instantiate & composition revisions) đủ điều kiện dữ liệu nền tảng để triển khai.
