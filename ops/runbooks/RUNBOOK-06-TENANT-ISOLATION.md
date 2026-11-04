# Runbook: Tenant isolation/abuse incident (Multi-Tenant Security Incident)

Tài liệu vận hành và quy trình phản ứng khẩn cấp khi phát hiện hành vi tấn công xuyên tenant (cross-tenant IDOR), tấn công từ chối dịch vụ (DoS / resource bombing), cố gắng thoát khỏi sandbox Chromium, hoặc vi phạm chính sách sử dụng và hạn ngạch tài nguyên.

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert triggers:**
  - `CveSandboxDenialsAnomaly` (phát hiện vi phạm syscall hoặc cố gắng kết nối mạng trái phép từ bên trong sandbox).
  - `CveAssetRejectionsAnomaly` (tải lên tệp chứa payload độc hại hoặc bom giải nén).
  - Báo cáo truy cập trái phép chéo tài nguyên giữa các tenant.
- **Mức độ nghiêm trọng:** `P0 - Critical Security Incident`.
- **Synthetic Attacker Tenant ID:** `tenant-synth-attacker-66666666`
- **Synthetic Victim Tenant ID:** `tenant-synth-victim-66666667`
- **Synthetic Victim Resource ID:** `res-synth-victim-006`

## 2. Nguyên tắc an ninh bất biến (Security Invariants)

1. **Anti-IDOR / Tuyệt đối không lộ diện tài nguyên:**
   - Mọi truy vấn từ một tenant nhằm đọc, sửa, xóa, hoặc lấy link tải tài nguyên của tenant khác bắt buộc phải trả về mã lỗi HTTP `404 NOT_FOUND` (không được trả `403 FORBIDDEN` vì 403 xác nhận tài nguyên đó có tồn tại).
2. **Cách ly danh sách và phân trang (List Isolation):**
   - Lệnh liệt kê (`GET /v1/templates`, `GET /v1/render-jobs`, `GET /v1/assets`) chỉ trả về tập hợp con thuộc sở hữu của tenant đang thực hiện cuộc gọi.
3. **Cô lập bộ nhớ và hạn mức tính toán:**
   - Hành vi lạm dụng tài nguyên của tenant tấn công không được phép làm cạn kiệt CPU/RAM hay ảnh hưởng tới độ trễ xử lý của các tenant lương thiện khác.

## 3. Quy trình phản ứng sự cố tuần tự (Incident Containment Workflow)

### Bước 1: Khóa tạm thời quyền tiếp nhận của Tenant vi phạm (Tenant Suspension)
Khi phát hiện hành vi cố ý quét IDOR hoặc tấn công sandbox:

```bash
# Đình chỉ API Key và vô hiệu hóa quyền truy cập của tenant vi phạm
curl -s -X POST "http://127.0.0.1:8080/v1/admin/tenants/tenant-synth-attacker-66666666/suspend" \
  -H "Authorization: Bearer <master_operator_key>" \
  -d '{"reason": "CROSS_TENANT_IDOR_SCAN_DETECTED"}'
```

Ngay sau khi đình chỉ:
- Mọi yêu cầu tiếp theo từ tenant vi phạm sẽ lập tức bị từ chối với mã HTTP `403 TENANT_SUSPENDED`.
- Các job đang xếp hàng (`queued`) của tenant này bị hủy ngay lập tức, giải phóng hạn mức.

### Bước 2: Hủy các tiến trình đang thực thi trong Sandbox (Kill Active Jobs)
Thu hồi toàn bộ task lease và hủy các container đang render của tenant vi phạm:

```bash
# Kiểm tra danh sách các job đang chạy của attacker
curl -s -X GET "http://127.0.0.1:8080/v1/admin/jobs?tenant_id=tenant-synth-attacker-66666666&status=running" \
  -H "Authorization: Bearer <master_operator_key>"
```

Tiến hành gửi tín hiệu ngắt tiến trình cách ly và dọn dẹp sạch sẽ ổ đĩa tạm của attempt.

### Bước 3: Thu hồi các Token tải xuống đã phát hành (Revoke Download Grants)
Nếu có bất kỳ nghi ngờ nào về việc rò rỉ token tải xuống:
```bash
# Vô hiệu hóa toàn bộ grant tải xuống của các artifact liên quan
curl -s -X POST "http://127.0.0.1:8080/v1/admin/artifacts/res-synth-victim-006/revoke" \
  -H "Authorization: Bearer <master_operator_key>"
```
Tất cả các yêu cầu tải qua `/v1/artifacts/download/:token` trước đó sẽ bị trả về HTTP `410 GRANT_REVOKED`.

### Bước 4: Kiểm tra và Thu thập bằng chứng Kiểm toán (Audit Timeline Extraction)
Xuất log kiểm toán phục vụ phân tích nguyên nhân gốc rễ (Root Cause Analysis - RCA), bảo đảm log đã được che mờ toàn bộ bí mật:

```bash
# Trích xuất lịch sử truy cập liên quan tới resource bị thăm dò
grep "res-synth-victim-006" /var/log/cve/audit.log | tail -n 50
```

Xác nhận:
- Tenant tấn công chỉ nhận được phản hồi `404 NOT_FOUND`.
- Không có bất kỳ byte dữ liệu hay siêu dữ liệu nào của tenant nạn nhân bị rò rỉ.

## 4. Báo cáo sau sự cố (Post-Mortem & Reopen Gate)

1. Lập báo cáo phân tích mã nguồn và rà soát các câu lệnh truy vấn SQL (đảm bảo mệnh đề `WHERE tenant_id = $1` hiện diện tại 100% các câu lệnh SELECT/UPDATE/DELETE).
2. Kiểm tra bộ quy tắc kiểm thử tự động Anti-IDOR để bổ sung regression test cho endpoint bị tấn công.
3. Chỉ mở lại quyền truy cập sau khi có chữ ký phê duyệt (security sign-off) của người chịu trách nhiệm an ninh hệ thống.
