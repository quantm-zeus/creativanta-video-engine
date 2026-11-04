# Runbook: Webhook không tới (Webhook Delivery Failures & Outbox Backlog)

Tài liệu vận hành và quy trình chẩn đoán sự cố thông báo webhook callback không gửi được tới máy chủ của khách hàng sau khi render hoàn tất (`cve_webhook_pending > 0` hoặc trễ quá 5 phút), kiểm tra chữ ký HMAC-SHA256, và cơ chế phát lại (replay delivery).

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert trigger:** `CveWebhookDeliveryBacklog` (hàng đợi webhook outbox còn tồn đọng sự kiện trên 5 phút).
- **Mức độ nghiêm trọng:** `P2 - Warning / Integration Degradation`.
- **Synthetic Tenant ID:** `tenant-synth-delta-44444444`
- **Synthetic Webhook Endpoint ID:** `ep-synth-delta-004`
- **Synthetic Event ID:** `evt-synth-004-complete`
- **Synthetic Delivery Attempt ID:** `dlv-synth-004-att1`
- **Synthetic Target URL:** `https://client.example.com/api/cve-webhook`

## 2. Nguyên nhân cốt lõi thường gặp

1. **Máy chủ khách hàng gặp sự cố / Quá tải (HTTP 5xx / 429 / Timeout):** Máy chủ nhận phản hồi 500, 502, 503, 504 hoặc không trả lời trong vòng 5 giây.
2. **Khách hàng xóa hoặc đổi URL không hợp lệ (HTTP 404 / 410):** Điểm cuối không còn tồn tại.
3. **Lỗi xác thực chữ ký (Signature Verification Failed):** Phía khách hàng giải mã sai hoặc tuần tự hóa lại JSON làm thay đổi chuỗi bytes ký gốc.
4. **Endpoint chưa hoàn tất kích hoạt (Pending Verification Challenge):** Điểm cuối chưa hoàn thành handshake bắt tay echo challenge nên bị chặn gửi sự kiện thật.

## 3. Các bước kiểm tra và xử lý (Diagnostic Workflow)

### Bước 1: Kiểm tra trạng thái hàng đợi Outbox của Điểm cuối
Truy vấn thông tin endpoint bằng quyền tenant:

```bash
curl -s -X GET "http://127.0.0.1:8080/v1/webhook-endpoints/ep-synth-delta-004" \
  -H "Authorization: Bearer <authorized_tenant_key>"
```

Dữ liệu mẫu:
```json
{
  "endpoint_id": "ep-synth-delta-004",
  "url": "https://client.example.com/api/cve-webhook",
  "status": "active",
  "consecutive_failures": 3,
  "last_delivery_at": "2026-11-04T04:15:00.000Z",
  "last_status_code": 503,
  "pending_events_count": 1
}
```

### Bước 2: Kiểm tra lịch sử các lần chuyển giao (Delivery Attempts)
```bash
curl -s -X GET "http://127.0.0.1:8080/v1/webhook-endpoints/ep-synth-delta-004/deliveries" \
  -H "Authorization: Bearer <authorized_tenant_key>"
```

Mẫu kết quả phân tích:
```json
[
  {
    "delivery_id": "dlv-synth-004-att1",
    "event_id": "evt-synth-004-complete",
    "status": "retry_wait",
    "attempt_number": 1,
    "http_status": 503,
    "error_message": "Service Unavailable from receiver",
    "next_retry_at": "2026-11-04T04:20:00.000Z"
  }
]
```

### Bước 3: Kiểm tra tiêu đề chữ ký HMAC và độ lệch thời gian (Clock Skew)
Mỗi bản tin webhook được ký bằng tiêu đề chuẩn:
```text
Creativanta-Signature: t=1730693700,v1=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
```
1. Tiêu đề `t` là Unix timestamp giây. Kiểm tra xem đồng hồ của máy chủ nhận có lệch quá 300 giây (5 phút) so với thời gian UTC chuẩn hay không.
2. Kiểm tra quy trình xác thực phía khách hàng:
   - Phải lấy chuỗi bytes thô (`raw body`) để tính HMAC-SHA256: `HMAC_SHA256(secret, "${t}.${rawBody}")`.
   - Nếu phía khách hàng parse JSON rồi `JSON.stringify` lại trước khi kiểm tra chữ ký, thứ tự các trường hoặc khoảng trắng bị thay đổi sẽ dẫn đến chữ ký không khớp.

## 4. Hành động khắc phục (Remediation)

1. **Khách hàng vẫn có thể truy cập kết quả qua Polling:**
   Nhắc nhở khách hàng rằng việc webhook chậm trễ không làm mất video. Video đã render xong vẫn có thể truy vấn trạng thái và lấy liên kết tải xuống bình thường qua:
   ```bash
   GET /v1/render-jobs/job-synth-004
   ```
2. **Kích hoạt phát lại sự kiện (Replay Event):**
   Sau khi khách hàng đã khắc phục máy chủ nhận, gọi API phát lại sự kiện mà không cần render lại video:
   ```bash
   curl -s -X POST "http://127.0.0.1:8080/v1/webhook-endpoints/ep-synth-delta-004/events/evt-synth-004-complete/replay" \
     -H "Authorization: Bearer <authorized_tenant_key>"
   ```
   Hệ thống tái phát sự kiện với cùng `event_id` gốc để khách hàng thực hiện khử trùng lặp (idempotent deduplication) an toàn.
