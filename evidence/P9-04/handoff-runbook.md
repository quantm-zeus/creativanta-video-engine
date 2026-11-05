# Hướng dẫn vận hành và bàn giao tích hợp Creativanta Video Engine

Tài liệu này là cẩm nang vận hành (Integration & Operations Runbook) chuẩn mực dành cho đội ngũ kỹ thuật Creativanta để tích hợp và vận hành cùng dịch vụ **Creativanta Video Engine (CVE) REST API v1**, phối hợp cùng gói dữ liệu bàn giao kỹ thuật tại [handoff-packet.json](handoff-packet.json) và hướng dẫn tích hợp chi tiết tại [API Integration Guide](../../packages/sdk/docs/API_INTEGRATION_GUIDE.md).

> [!IMPORTANT]
> **Ranh giới tích hợp đối ngoại (External Integration Boundary):**
> Nhiệm vụ tích hợp trên kho mã nguồn ngoài của Creativanta, cấu hình hạ tầng live production, cấp phát DNS và thông tin ủy nhiệm môi trường thật **CHỈ ĐƯỢC PHÉP THỰC HIỆN KHI CÓ QUYỀN VÀ PHẠM VI RIÊNG** được cấp bởi Supervisor/Operator. Toàn bộ mã nguồn, dữ liệu mẫu, và kịch bản trong kho lưu trữ này tuân thủ nguyên tắc không chứa bí mật thực tế và vận hành trên nền tảng giả lập hợp đồng độc lập.

---

## 1. Nguyên tắc kiến trúc và Ranh giới hệ thống

1. **Không chia sẻ cơ sở dữ liệu (`No Shared DB Assumptions`):**
   Creativanta và Video Engine là hai hệ thống độc lập. Mọi trao đổi dữ liệu chỉ diễn ra thông qua giao thức chuẩn **REST API v1 (HTTPS)** và **Signed Webhooks**. Tuyệt đối không kết nối trực tiếp vào cơ sở dữ liệu nội bộ (SQLite, PostgreSQL, Redis) hay hệ thống lưu trữ tệp (MinIO/S3).
2. **Xử lý bất đồng bộ (Asynchronous Job Model):**
   Mọi yêu cầu kết xuất video đều tiếp nhận với mã HTTP `202 Accepted` và trả về định danh tác vụ `job_id`. Trạng thái tiến triển được cập nhật qua Webhook thời gian thực và cơ chế thăm dò dự phòng (Polling Reconciliation).
3. **An toàn phát lại và Khóa Idempotency (`Idempotency-Key`):**
   Mọi phương thức HTTP `POST` bắt buộc tiêu đề `Idempotency-Key` (chuỗi 1–128 ký tự ASCII `[A-Za-z0-9._:-]`). Máy chủ tính toán canonical request hash theo chuẩn **RFC 8785 (JCS)**, bảo đảm an toàn khi mạng bị ngắt quãng hoặc thử lại.
4. **Phân định rõ ràng Harness vs Live:**
   - **In-repo Contract Harness (`CreativantaContractMock`):** Sẵn sàng 100% trong repo, kiểm chứng toàn diện qua bộ kiểm thử E2E không phụ thuộc bên ngoài.
   - **Live Service Integration:** Chờ cấp quyền và phân bổ nhiệm vụ ngoài phạm vi repo này.

---

## 2. Thông số môi trường và Điểm cuối API (Base URLs)

| Môi trường | Base URL | Yêu cầu TLS | Mục đích sử dụng |
| --- | --- | :---: | --- |
| **Local Mock Harness** | `http://127.0.0.1:4000/v1` | Không (Loopback) | Phát triển nội bộ, kiểm thử hợp đồng CI/CD qua `@creativanta/sdk` |
| **Staging (Private Beta)** | `https://staging-cve.creativanta.internal/v1` | **Bắt buộc TLS 1.2+** | Môi trường tích hợp kiểm thử nghiệm thu (E2E Smoke) |
| **Production Target** | `https://video.creativanta.com/v1` | **Bắt buộc TLS 1.3** | Môi trường thương mại chính thức (sau khi qua cổng GA P9-05) |

---

## 3. Cấu hình biến môi trường (Environment Variables)

Đội ngũ kỹ thuật cấu hình các biến môi trường sau cho dịch vụ Creativanta (hoặc worker tích hợp):

```bash
  # Điểm cuối API của Video Engine
  CREATIVANTA_API_BASE_URL="https://staging-cve.creativanta.internal/v1"

  # Khóa API của Tenant (Dạng chuỗi 32-byte băm bảo mật, ví dụ giữ chỗ)
  CREATIVANTA_API_KEY="cve_live_placeholder_key_000000000000000000000000"

  # Khóa bí mật ký số Webhook HMAC-SHA256 (32-byte hex)
  CREATIVANTA_WEBHOOK_SECRET="whsec_placeholder_secret_000000000000000000000000"

  # URL nhận Webhook đã đăng ký của Creativanta
  CREATIVANTA_WEBHOOK_ENDPOINT_URL="https://staging-app.creativanta.internal/api/webhooks/video-engine"

  # Cấu hình thời gian chờ và thử lại
  CREATIVANTA_CLIENT_TIMEOUT_MS=30000
  CREATIVANTA_MAX_RETRIES=3
  CREATIVANTA_INITIAL_BACKOFF_MS=1000
  CREATIVANTA_MAX_BACKOFF_MS=10000

  # Cấu hình thăm dò đối soát dự phòng (Polling Reconciliation)
  CREATIVANTA_POLL_INTERVAL_INITIAL_MS=2000
  CREATIVANTA_POLL_INTERVAL_MAX_MS=10000

  # Vùng đệm làm mới grant tải xuống (TTL <= 300s)
  CREATIVANTA_GRANT_REFRESH_BUFFER_MS=60000
```

> [!WARNING]
> Tuyệt đối không commit giá trị bí mật thực tế vào Git. Sử dụng hệ thống quản lý bí mật (HashiCorp Vault, AWS Secrets Manager, Kubernetes Secrets) khi đưa lên môi trường Staging/Production.

---

## 4. Bảng phân quyền Scopes tối thiểu cho Creativanta

Khóa API cấp cho Creativanta cần kích hoạt các phạm vi (scopes) sau:

1. `jobs:read` / `jobs:write`: Tiếp nhận lệnh kết xuất, truy vấn tiến độ, nhận thông báo sự kiện, và hủy tác vụ khi cần.
2. `templates:read`: Truy xuất danh mục mẫu video có sẵn và đọc lược đồ biến (variables schema).
3. `compositions:write`: Khởi tạo mẫu hoặc định nghĩa bố cục cảnh động (scene specification).
4. `assets:read` / `assets:write`: Tải tài sản đa phương tiện (ảnh, âm thanh) vào khu cách ly kiểm tra (quarantine probe).
5. `webhooks:manage`: Đăng ký điểm cuối webhook và tham gia cơ chế xác thực bắt tay thử thách (challenge handshake).
6. `usage:read`: Đối soát hạn mức và thời lượng video đã kết xuất phục vụ tính cước.

---

## 5. Quy trình tích hợp chuẩn từng bước (Step-by-Step Integration Workflow)

### Bước 1: Kiểm chứng qua Local Contract Harness

Trước khi kết nối mạng ra bên ngoài, chạy bộ kiểm thử hợp đồng trong kho mã bằng `@creativanta/sdk`:

```bash
  # Thực thi kiểm chứng hợp đồng tích hợp
  node packages/sdk/scripts/run-client-examples.mjs
```

### Bước 2: Đăng ký Webhook Endpoint và Bắt tay Thử thách (Challenge Echo)

1. Creativanta gửi yêu cầu đăng ký điểm cuối webhook:
   - `POST /v1/webhook-endpoints`
   - Body: `{"url": "https://creativanta.internal/api/webhooks/video-engine", "events": ["job.succeeded", "job.failed"]}`
2. Máy chủ CVE gửi thử thách kiểm tra quyền sở hữu:
   - `POST https://creativanta.internal/api/webhooks/video-engine`
   - Body: `{"type": "endpoint.challenge", "data": {"challenge": "<token>"}}`
3. Điểm nhận của Creativanta phản hồi HTTP 200:
   - Body: `{"challenge": "<token>"}`
4. Điểm cuối chuyển sang trạng thái `active`.

### Bước 3: Nạp tài sản vào khu cách ly (Asset Intake)

1. Gửi yêu cầu xin cấp quyền tải lên: `POST /v1/assets/uploads` kèm thông tin quyền sở hữu bản quyền (`rights`).
2. Tải tệp trực tiếp lên `upload_url` bằng phương thức HTTP `PUT`.
3. Xác nhận hoàn tất: `POST /v1/assets/{id}/complete` kèm mã băm SHA-256.
4. Đợi trạng thái tài sản chuyển sang `ready`.

### Bước 4: Khởi tạo mẫu và Đệ trình Tác vụ (Job Dispatch)

1. Khởi tạo template với biến nghiệp vụ:
   - `POST /v1/templates/tpl_promo_retail_v1/instantiate`
   - Nhận về `composition_id` và `revision: 1`.
2. Gửi lệnh kết xuất với khóa Idempotency duy nhất:
   - `POST /v1/render-jobs`
   - Tiêu đề: `Idempotency-Key: cve_idemp_retail_<order_id>`
   - Body: `{"composition_id": "...", "revision": 1, "profile": "mp4-720p-v1", "client_reference": "<order_id>"}`
   - Nhận mã phản hồi `202 Accepted` kèm `job_id`.

### Bước 5: Tiếp nhận Webhook và Đối soát Thăm dò Dự phòng

1. Lắng nghe Webhook có chữ ký `X-CVE-Signature`. Xác thực chữ ký HMAC-SHA256 bằng thuật toán an toàn thời gian `crypto.timingSafeEqual`.
2. Kiểm tra lệch đồng hồ (clock skew) không vượt quá 300 giây.
3. Kiểm tra tính đơn điệu `state_version` để loại bỏ các thông báo đến trễ.
4. Nếu Webhook không tới sau 30 giây, kích hoạt thăm dò dự phòng `GET /v1/jobs/{id}` theo nhịp lùi số mũ 2s -> 4s -> 8s -> 10s cho đến khi đạt trạng thái kết thúc (`succeeded`, `failed`, `canceled`).

### Bước 6: Tải video và Xử lý URL ngắn hạn (TTL <= 300s)

1. Nhận URL tải xuống từ sự kiện hoặc `GET /v1/artifacts/{id}/download`.
2. Tải tệp và kiểm tra mã băm SHA-256 đối chiếu với thuộc tính `sha256` của tạo tác.
3. Nếu nhận mã `410 GRANT_EXPIRED`, gọi lại `GET /v1/artifacts/{id}/download` để lấy URL mới và tải lại mà **không cần kết xuất lại video**.

---

## 6. Sổ tay xử lý sự cố (Troubleshooting Playbook)

### Sự cố 1: Nhận mã `409 IDEMPOTENCY_IN_PROGRESS`
- **Nguyên nhân:** Yêu cầu trước đó với cùng `Idempotency-Key` đang được xử lý trong hàng đợi.
- **Biện pháp:** Đọc tiêu đề `Retry-After` (thường là 1 giây), tạm dừng và thử lại với **cùng Idempotency-Key**.

### Sự cố 2: Nhận mã `409 IDEMPOTENCY_CONFLICT`
- **Nguyên nhân:** Gửi cùng `Idempotency-Key` nhưng nội dung thân yêu cầu (body) khác với lần gửi đầu tiên.
- **Biện pháp:** Sinh một `Idempotency-Key` mới nếu đây là tác vụ kết xuất độc lập khác.

### Sự cố 3: Nhận mã `429 RATE_LIMITED` hoặc `503 SERVICE_UNAVAILABLE`
- **Nguyên nhân:** Hệ thống Video Engine đang áp dụng cơ chế điều tiết lưu lượng hoặc bảo trì ngắn hạn.
- **Biện pháp:** Đọc tiêu đề `Retry-After`, áp dụng thuật toán lùi số mũ kèm độ lệch ngẫu nhiên (jitter) và thử lại với cùng `Idempotency-Key`.

### Sự cố 4: Chữ ký Webhook không hợp lệ (`INVALID_SIGNATURE`)
- **Nguyên nhân:** Sai lệch khóa bí mật `CREATIVANTA_WEBHOOK_SECRET` hoặc thân yêu cầu bị thay đổi định dạng trước khi tính HMAC.
- **Biện pháp:** Luôn tính HMAC trên chuỗi byte thô nguyên bản (`raw_body_bytes`), không reserialize JSON qua `JSON.stringify`.

---

## 7. Trạng thái kiểm chứng kỹ thuật (Status: Harness vs Live)

| Hạng mục | Trạng thái | Chứng cứ kỹ thuật |
| --- | :---: | --- |
| **In-repo Contract Harness** | **VERIFIED_READY** | Kiểm chứng 100% qua 102 SDK tests tại [evidence/P5-03/report.md](../P5-03/report.md) & [evidence/P5-04/report.md](../P5-04/report.md). Mô phỏng giả lập `CreativantaContractMock` đạt chuẩn giao thức v1. |
| **Staging Integration Testing** | **READY_FOR_ENGAGEMENT** | Sẵn sàng cho phiên tích hợp Staging khi có yêu cầu điều phối. |
| **Live Production Integration** | **BLOCKED_PENDING_SEPARATE_SCOPE** | Chờ cấp quyền và phân bổ phạm vi tác vụ độc lập (`EXT-GATE-CREATIVANTA-02`). Tuyệt đối không tự ý tác động lên môi trường live từ kho mã này. |
