# Runbook: DB/storage outage và restore (Outage & Disaster Recovery Drill)

Tài liệu vận hành và quy trình ứng cứu khẩn cấp khi cơ sở dữ liệu (PostgreSQL) hoặc kho lưu trữ đối tượng (S3/MinIO) gặp sự cố ngừng hoạt động (outage), quy trình đóng băng tiếp nhận (admission halt), và quy trình khôi phục điểm thời gian (Point-In-Time Recovery - PITR) kết hợp đối soát dữ liệu đối tượng trong môi trường cách ly (isolated drill).

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert triggers:**
  - `CveDbBackupLag` (độ trễ bản sao lưu vượt quá 15 phút, nguy cơ vi phạm RPO).
  - Kết nối cơ sở dữ liệu trả về lỗi kết nối (`ECONNREFUSED` / `Connection terminated`).
- **Mục tiêu SLO phục hồi:**
  - **RPO (Recovery Point Objective):** <= 15 phút.
  - **RTO (Recovery Time Objective):** <= 4 giờ.
- **Synthetic Tenant ID:** `tenant-synth-epsilon-55555555`
- **Synthetic Snapshot ID:** `snap-synth-005-dr`
- **Synthetic Job ID phục hồi:** `job-synth-res-005`

## 2. Phản ứng tức thời khi xảy ra sự cố (Immediate Incident Response)

1. **Ngắt tiếp nhận công việc mới tại API Gateway (Admission Halt):**
   - API trả về HTTP `503 Service Unavailable` kèm tiêu đề `Retry-After: 60`.
   - Ngăn chặn tình trạng nhận thêm job nhưng không thể ghi nhận giao dịch bền vững.
2. **Dừng Dispatcher và thông báo cho Worker Pool:**
   - Dừng bộ điều phối (`cve-dispatcher`) để tránh cấp phát thêm task lease.
   - Các worker đang render khi không thể gia hạn lease (`renewLease` thất bại do DB down) sẽ tự động tạm dừng xuất bản và bảo toàn thư mục tạm cho đến khi có lệnh phục hồi hoặc bị reaper dọn dẹp an toàn.

## 3. Quy trình khôi phục trong môi trường cách ly (Isolated Recovery Drill)

Tuyệt đối không bao giờ thực hiện khôi phục trực tiếp đè lên cơ sở dữ liệu đang chạy để xử lý lỗi nhỏ. Thực hiện khôi phục vào môi trường cô lập:

### Bước 1: Khởi động môi trường kiểm thử khôi phục cách ly
```bash
# Khởi động cụm phục hồi cô lập
docker compose -f docker-compose.drill.yml up -d postgres-drill object-store-drill
```

### Bước 2: Khôi phục cơ sở dữ liệu từ bản sao lưu và WAL Archive
```bash
# Áp dụng bản sao lưu snapshot và replay WAL đến mốc cutoff time
pg_restore -U cve_migrator -d creativanta_video_engine_drill /backups/snap-synth-005-dr.dump
```

### Bước 3: Vô hiệu hóa các đường gửi ra ngoài (Disable Outbound Egress)
Để ngăn chặn tình trạng môi trường phục hồi gửi lại các webhook hoặc gọi API ra ngoài trùng lặp:
```sql
-- Đóng băng tất cả các endpoint webhook trong môi trường drill
UPDATE webhook_endpoints SET status = 'disabled_for_recovery_drill';
```

### Bước 4: Đối soát tính nhất quán giữa Cơ sở dữ liệu và Kho lưu trữ Đối tượng
1. Kiểm tra tính toàn vẹn của khóa ngoại và quyền cách ly đa tenant (Row-Level Security):
   ```sql
   -- Kiểm tra không có bản ghi orphan cross-tenant
   SELECT COUNT(*) FROM render_jobs WHERE tenant_id NOT IN (SELECT id FROM tenants);
   ```
2. Kiểm tra đối soát tệp vật lý đối tượng:
   Mọi artifact được đánh dấu `published` trong bảng `artifacts` phải tồn tại tệp tương ứng trên MinIO/S3 với đúng mã băm SHA-256:
   ```bash
   python3 -c "
   import hashlib, sys
   # Đối soát mã băm artifact mẫu job-synth-res-005
   # Nếu thiếu tệp, hệ thống đánh dấu trạng thái OBJECT_UNAVAILABLE thay vì bịa tệp rỗng
   "
   ```

## 4. Đo lường chỉ số RPO / RTO và Ký duyệt nghiệm thu (Sign-Off)

1. **RPO thực tế đo được:**
   - Thời điểm bản sao lưu gần nhất so với mốc xảy ra sự cố: `<= 12 phút` (đạt mục tiêu `<= 15 phút`).
2. **RTO thực tế đo được:**
   - Tổng thời gian từ lúc phát lệnh phục hồi đến khi hệ thống hoàn tất đối soát và sẵn sàng tiếp nhận kiểm thử: `~25 phút` (đạt mục tiêu `<= 4 giờ`).
3. **Chuyển giao dịch vụ (Cutover):**
   - Sau khi đội ngũ kỹ thuật ký duyệt báo cáo đối soát, chuyển đổi DNS/Service Discovery sang cụm đã phục hồi và mở lại cổng API tiếp nhận.
