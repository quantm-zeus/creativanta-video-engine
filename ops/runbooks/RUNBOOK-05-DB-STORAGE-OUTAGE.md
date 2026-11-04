# Runbook: DB/storage outage và restore (Outage & Disaster Recovery Drill)

Tài liệu vận hành và quy trình ứng cứu khẩn cấp khi cơ sở dữ liệu hoặc kho lưu trữ đối tượng gặp sự cố ngừng hoạt động (outage), quy trình đóng băng tiếp nhận (admission halt), và quy trình khôi phục điểm thời gian (Point-In-Time Recovery - PITR) kết hợp đối soát dữ liệu đối tượng trong môi trường cách ly (isolated drill), đo lường RPO <= 15 phút, RTO <= 4 giờ và khóa cứng các cờ tính năng an toàn (`custom/import stay off`) cho đến khi hoàn tất tái thẩm định an ninh.

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert triggers:**
  - `CveDbBackupLag` (độ trễ bản sao lưu vượt quá 15 phút, nguy cơ vi phạm RPO).
  - Kết nối cơ sở dữ liệu trả về lỗi kết nối (`ECONNREFUSED` / `Connection terminated`).
- **Mục tiêu SLO phục hồi:**
  - **RPO (Recovery Point Objective):** <= 15 phút (900 giây).
  - **RTO (Recovery Time Objective):** <= 4 giờ (14,400 giây).
- **Synthetic Tenant ID:** `tenant-synth-epsilon-55555555`
- **Synthetic Snapshot ID:** `snap-synth-005-dr`
- **Synthetic Job ID phục hồi:** `job-synth-res-005`
- **Synthetic Artifact ID phục hồi:** `art-synth-res-005`

## 2. Phản ứng tức thời khi xảy ra sự cố (Immediate Incident Response)

1. **Ngắt tiếp nhận công việc mới tại API Gateway (Admission Halt):**
   - API Gateway chuyển sang trả về HTTP `503 Service Unavailable` kèm tiêu đề `Retry-After: 60`.
   - Ngăn chặn tình trạng nhận thêm job nhưng không thể ghi nhận giao dịch bền vững vào DB.
2. **Dừng Dispatcher và bảo vệ Worker Pool:**
   - Dừng bộ điều phối (`cve-dispatcher`) để tránh cấp phát thêm task lease.
   - Các worker đang render khi không thể gia hạn lease (`renewLease` thất bại do DB down) sẽ tự động tạm dừng xuất bản và bảo toàn thư mục tạm cho đến khi có lệnh phục hồi hoặc bị reaper dọn dẹp an toàn.

## 3. Quy trình khôi phục trong môi trường cách ly (Isolated Recovery Drill)

Tuyệt đối không bao giờ thực hiện khôi phục trực tiếp đè lên cơ sở dữ liệu đang chạy để xử lý lỗi nhỏ. Thực hiện khôi phục vào môi trường cô lập:

### Bước 1: Khởi động môi trường kiểm thử khôi phục cách ly

Khởi tạo môi trường cô lập (isolated database và isolated storage backend), ngắt toàn bộ egress mạng:

```bash
# Thực hiện diễn tập khôi phục cô lập thông qua CLI
node ops/recovery/recovery-cli.mjs drill --cutoff 2026-11-04T03:00:00.000Z
```

### Bước 2: Khôi phục cơ sở dữ liệu từ bản sao lưu và WAL Archive (PITR)

- Tải bản snapshot hợp lệ gần nhất trước mốc sự cố.
- Xác thực mã băm toàn vẹn SHA-256 (`actualSha256 === expectedSha256`). Mọi sai lệch mã băm đều bị từ chối với lỗi `BACKUP_INTEGRITY_MISMATCH`.
- Replay tuần tự các bản ghi nhật ký giao dịch WAL đến đúng thời điểm cutoff (`cutoff_utc`).

### Bước 3: Vô hiệu hóa các đường gửi ra ngoài & Khóa an toàn hậu phục hồi

Để ngăn chặn tình trạng môi trường phục hồi gửi lại các webhook hoặc gọi API ra ngoài trùng lặp:

```sql
-- Đóng băng tất cả các endpoint webhook trong môi trường drill
UPDATE webhook_endpoints SET state = 'disabled', updated_at = CURRENT_TIMESTAMP;
```

**Khóa cứng cờ an toàn hậu phục hồi (`custom/import stay off`):**
- `CVE_CUSTOM_CODE_ENABLED=false` (chặn toàn bộ kịch bản dựng cảnh tùy biến microVM).
- `CVE_REMOTE_IMPORT_ENABLED=false` (chặn toàn bộ luồng tải tài nguyên từ URL ngoài).
- `CVE_OUTBOUND_WEBHOOKS_ENABLED=false` (chặn tiến trình sender phát webhook).
- Trạng thái an toàn chuyển sang `RESTORED_PENDING_REVALIDATION`. Mọi yêu cầu gọi custom code hoặc remote import bị từ chối với mã lỗi `FEATURE_LOCKED_PENDING_REVALIDATION`.

### Bước 4: Đối soát nhất quán giữa Cơ sở dữ liệu và Kho lưu trữ Đối tượng (Reconciliation)

1. **Đối soát Artifacts đã xuất bản (`artifacts`):**
   - Đối chiếu từng bản ghi `artifacts` với đối tượng trên kho lưu trữ.
   - Kiểm tra tồn tại vật lý, độ dài bytes và mã băm SHA-256.
   - Nếu tệp bị thiếu hoặc sai lệch mã băm, ghi nhận vào danh sách `missingStorageArtifacts` / `corruptedStorageArtifacts`. Tuyệt đối không tự bịa tệp rỗng!
2. **Đối soát Assets tải lên dở dang (`assets`):**
   - Các asset ở trạng thái `uploading` hoặc `processing` không có tệp đối tượng hoàn chỉnh tại điểm cắt được chuyển sang trạng thái `rejected` để khách hàng upload lại an toàn.
3. **Phát hiện và cách ly đối tượng mồ côi (`orphanedStorageKeys`):**
   - Quét các tệp lưu trữ không được tham chiếu bởi bất kỳ bản ghi DB nào (tàn dư từ attempt thất bại/crash), đưa vào danh sách cách ly chờ dọn dẹp sau 24h.
4. **Cập nhật Fencing Token và thu hồi Lease mồ côi (`jobs`):**
   - Tăng `lease_epoch = lease_epoch + 1` để chặn zombie worker xuất bản đè.
   - Chuyển các job còn lượt thử về `retry_wait`; chuyển các job quá hạn deadline hoặc hết lượt thử về `failed` (`WORKER_LOST`).
   - Chuyển các job ở `cancel_requested` về `canceled`.
5. **Giải phóng đặt trước ngân sách (`usage_reservations`):**
   - Chuyển các đặt trước của job thất bại/hủy về `released`. Đảm bảo bất biến tối đa 1 bản ghi thanh toán cho mỗi job.

### Bước 5: Kiểm tra toàn vẹn và thẩm định cách ly đa tenant (Verification Suite)

- **Foreign Key Check:** Chạy `PRAGMA foreign_key_check` xác nhận 0 vi phạm khóa ngoại.
- **Tenant Isolation RLS:** Xác nhận Tenant A không truy vấn được dữ liệu của Tenant B.
- **System Catalog:** Xác nhận tenant danh mục hệ thống `00000000-0000-0000-0000-000000000000` chỉ cho phép đọc.

## 4. Đo lường chỉ số RPO / RTO và Tái thẩm định Ký duyệt (Revalidation Sign-Off)

1. **RPO thực tế đo được:**
   - Khoảng cách từ giao dịch commit cuối cùng đến điểm cắt sự cố: `<= 15 phút` (đạt mục tiêu SLO).
2. **RTO thực tế đo được:**
   - Tổng thời gian hoàn tất nạp DB, replay WAL, đối soát đối tượng và kiểm tra toàn vẹn: `<= 4 giờ` (thực tế diễn tập tự động hoàn tất trong vài giây).
3. **Quy trình tái thẩm định an ninh của Operator (Security Revalidation):**
   - Cờ tính năng `custom` và `import` chỉ được phép bật lại sau khi operator có thẩm quyền thực hiện quy trình tái thẩm định chính thức:

```bash
# Thực hiện tái thẩm định an ninh sau phục hồi
node ops/recovery/recovery-cli.mjs revalidate --operator sec_lead_01 --ticket INC-DR-9921
```

- Lệnh trên kiểm tra toàn bộ 4 điều kiện tiên quyết (foreign keys, object consistency, tenant isolation, catalog integrity), ghi nhận nhật ký kiểm toán có thể truy vết, chuyển trạng thái sang `REVALIDATED_ACTIVE` và cho phép mở lại các tính năng theo chính sách.
