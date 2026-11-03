# Kế hoạch Rollback và Phục hồi Cơ sở Dữ liệu Đa khách hàng (P3-01)

Tài liệu chuẩn hóa quy trình di trú lược đồ (Database Migration), quay lui an toàn (Rollback Plan) và diễn tập phục hồi thảm họa (Point-in-Time Recovery / Restore Drill) cho nền tảng `creativanta-video-engine`, tuân thủ nghiêm ngặt [Architecture](../docs/ARCHITECTURE.md), [Security](../docs/SECURITY.md), [Deployment](../docs/DEPLOYMENT.md) và [Operations](../docs/OPERATIONS.md).

---

## 1. Kiến trúc Di trú & Nguyên tắc Expand / Contract (`N` / `N-1`)

1. **Phân tách quyền thực thi DDL (`cve_migrator`):**
   - Chỉ tài khoản `cve_migrator` (kết nối qua `CVE_MIGRATION_DATABASE_URL`) mới có quyền thực thi DDL và ghi dữ liệu khởi tạo vào sentinel tenant `00000000-0000-0000-0000-000000000000` (`system_catalog`).
   - Các tiến trình runtime (`cve_api`, `cve_dispatcher`, `cve_ingest`, `cve_sender`) chạy dưới `NOBYPASSRLS` và `FORCE ROW LEVEL SECURITY`, tuyệt đối không tự chạy migration khi khởi động hoặc khi nhân bản replica.
2. **Kiểm tra tính toàn vẹn trước khi áp dụng:**
   - Trình chạy di trú (`MigrationRunner`) đối chiếu mã băm `SHA-256` của từng tệp `.up.sql` và `.down.sql` với [manifest.json](manifest.json).
   - Mọi sai lệch mã băm hoặc thay đổi tệp lịch sử đã áp dụng trong bảng `schema_migrations` đều bị chặn ngay lập tức (`MIGRATION_CHECKSUM_MISMATCH`).
3. **Quy tắc tương thích `N` / `N-1` (Expand / Contract):**
   - **Bước 1 (Expand):** Thêm bảng mới, cột nullable hoặc cột có `DEFAULT`, tạo index `CONCURRENTLY` (khi chạy trên bảng lớn), giữ nguyên cột/hợp đồng cũ để bản chạy `N-1` của API/worker vẫn hoạt động bình thường trong lúc rollout.
   - **Bước 2 (Rollout & Drain):** Chuyển lưu lượng sang image `N`; chờ các job đang chạy trên image `N-1` hoàn tất trong giới hạn `CVE_JOB_DEADLINE_SECONDS` (`1800s`).
   - **Bước 3 (Contract):** Chỉ xóa cột/ràng buộc cũ ở phiên bản migration tiếp theo sau khi xác nhận không còn tiến trình `N-1` nào hoạt động.

---

## 2. Quy trình Quay lui Di trú (Migration Rollback Procedure)

Khi phát hiện lỗi ở phiên bản ứng dụng hoặc migration mới, operator thực hiện quy trình quay lui từng bước, **không xóa mù dữ liệu khách hàng**:

1. **Đóng cổng nhận việc mới & Thu hồi Lease đang chạy:**
   - Chuyển trạng thái readiness `/readyz` sang bảo trì hoặc tạm dừng nhận `POST /v1/render-jobs`, `POST /v1/previews`.
   - Đợi các worker đang giữ lease (`lease_Seconds = 60s`) hoàn tất hoặc thu hồi về `retry_wait` / `queued`.
2. **Chụp bản sao lưu trước khi quay lui (Pre-Rollback Snapshot):**
   - Luôn tạo bản chụp cơ sở dữ liệu (`createSnapshot` / `pg_dump --format=custom`) kèm mã băm SHA-256 trước khi chạy bất kỳ lệnh `.down.sql` nào.
3. **Thực thi kịch bản `.down.sql` theo thứ tự ngược lại:**
   - Quay lui `0002_seed_system_catalog.down.sql` trước (dỡ bỏ dữ liệu danh mục mẫu `system_catalog`, giữ nguyên bảng).
   - Chỉ thực thi `0001_tenant_foundation.down.sql` trong môi trường phát triển/staging hoặc khi khởi tạo cụm mới chưa phát sinh dữ liệu khách hàng thực, hoặc sau khi đã xuất bản sao lưu đầy đủ.
4. **Kiểm tra hậu kiểm (Post-Rollback Verification):**
   - Đối chiếu bảng `schema_migrations` khớp với phiên bản mục tiêu.
   - Xác minh toàn bộ bảng còn lại vẫn bật `ENABLE ROW LEVEL SECURITY` và `FORCE ROW LEVEL SECURITY`.

---

## 3. Kế hoạch Phục hồi Thảm họa & Diễn tập Restore (`RPO <= 15 phút`, `RTO <= 4 giờ`)

Theo [Operations](../docs/OPERATIONS.md) và [Deployment](../docs/DEPLOYMENT.md), quy trình phục hồi từ bản sao lưu (PITR + Object Store Consistency) vào môi trường cô lập tuân thủ 6 bước bắt buộc:

### Bước 1: Cô lập môi trường đích & Khóa các tính năng có tác dụng phụ bên ngoài
- Khởi tạo môi trường đích tách biệt hoàn toàn với production.
- **Bắt buộc khóa cứng các cờ an toàn trước khi mở DB:**
  - `CVE_CUSTOM_CODE_ENABLED=false` (`CVE_CUSTOM_RUNTIME=disabled`)
  - `CVE_REMOTE_IMPORT_ENABLED=false`
  - Tạm dừng tiến trình `cve_sender` (không phát lại webhook ra mạng ngoài từ môi trường diễn tập).

### Bước 2: Khôi phục Cơ sở dữ liệu tại điểm cắt WAL (Cutoff Timestamp)
- Khôi phục bản sao lưu nền cộng nhật ký WAL đến đúng thời điểm `cutoff_utc` (`RPO <= 15 phút`).
- Kiểm tra tính toàn vẹn của 21 bảng, các khóa ngoại tổ hợp `(tenant_id, ...)` và trạng thái `FORCE ROW LEVEL SECURITY`.

### Bước 3: Đối soát nhất quán giữa DB và Object Storage (Reconciliation)
- **Kiểm tra Artifacts đã xuất bản (`artifacts`):** Đối chiếu từng bản ghi `artifacts` của các job `succeeded` với đối tượng trên `CVE_ARTIFACT_BUCKET` (kiểm tra tồn tại + khớp `bytes` và `sha256`). Nếu đối tượng lưu trữ bị thiếu sau điểm cắt backup, đánh dấu artifact/job cần xử lý ngoại lệ rõ ràng, tuyệt đối không trả về tệp giả.
- **Kiểm tra Assets (`assets`, `asset_versions`):** Các asset đang ở trạng thái `uploading` hoặc `processing` dở dang tại thời điểm sự cố mà không có đối tượng hợp lệ được chuyển về `rejected` để khách hàng upload lại an toàn.
- **Thu hồi Lease mồ côi (`jobs`, `job_attempts`):** Mọi job đang ở trạng thái active (`preparing`, `rendering`, `encoding`, `verifying`) có `lease_expires_at <= now()` được reaper tăng `lease_epoch` (fencing token mới) và đưa về `retry_wait` (nếu `attempt_count < max_attempts` và chưa quá `deadline_at`) hoặc `failed` (`WORKER_LOST` / `JOB_DEADLINE_EXCEEDED`). Các job ở `cancel_requested` được hội tụ về `canceled`.
- **Dọn dẹp tệp tạm mồ côi:** Xóa các prefix tạm của attempt cũ không gắn với lease sống và không được tham chiếu bởi bảng `artifacts`.

### Bước 4: Đối soát Sổ cái Metering (`usage_reservations`, `usage_entries`) và Outbox (`outbox`)
- Đảm bảo bất biến: mỗi job `succeeded` chỉ có tối đa một bút toán `billable` cho mỗi `(tenant_id, job_id, meter, ledger_version)`.
- Các job chuyển về `failed` hoặc `canceled` trong bước thu hồi lease phải được giải phóng `usage_reservations` (`state = 'released'`).
- Đồng bộ trạng thái `outbox` và `webhook_deliveries`: chỉ phát sự kiện chưa gửi sau khi xác nhận môi trường chính thức nhận tải, dựa trên `event_id` bất biến để máy nhận dedupe.

### Bước 5: Kiểm thử Cách ly Đa khách hàng (Tenant Isolation Smoke Test)
- Chạy bộ kiểm thử tự động xác nhận:
  1. Kết nối `cve_api` không có `SET LOCAL app.current_tenant_id` không đọc được bất kỳ dòng nào của khách hàng.
  2. Tenant A không đọc/ghi/xóa được tài nguyên của Tenant B (nhận `404 NOT_FOUND` trên path hoặc `422 VALIDATION_FAILED` trong JSON body).
  3. Sentinel tenant `00000000-0000-0000-0000-000000000000` chỉ cho phép đọc các bản ghi `curated_public` và chặn mọi thao tác ghi từ `cve_api`.

### Bước 6: Đo lường `RPO` / `RTO` thực tế và Phê duyệt Mở tải
- Ghi nhận thời gian bắt đầu/kết thúc khôi phục (`RTO` mục tiêu `<= 4 giờ`) và độ trễ giao dịch cuối cùng (`RPO` mục tiêu `<= 15 phút`).
- Chỉ bật lại `cve_sender`, `cve_dispatcher`, `cve_api` sau khi toàn bộ kiểm tra ở Bước 3, 4, 5 đạt `PASS`. Giữ `CVE_CUSTOM_CODE_ENABLED=false` và `CVE_REMOTE_IMPORT_ENABLED=false` cho đến khi hoàn tất thẩm định bảo mật riêng.
