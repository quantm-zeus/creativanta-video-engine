# Hướng dẫn tích hợp API và Thư viện SDK Creativanta Video Engine

Tài liệu này cung cấp hướng dẫn toàn diện dành cho các kỹ sư tích hợp nền tảng Creativanta với dịch vụ kết xuất video **Creativanta Video Engine (CVE) REST API v1**, cùng bộ thư viện khách hàng định kiểu chuẩn `@creativanta/sdk`.

Mọi thông tin định danh, khóa API, chữ ký webhook và đường dẫn mạng trong tài liệu này đều là **thông tin giữ chỗ (placeholders)** tuân thủ nghiêm ngặt chính sách bảo mật tại [docs/SECURITY.md](../../docs/SECURITY.md) và [AGENTS.md](../../AGENTS.md).

---

## 1. Nguyên tắc kiến trúc và Ranh giới tích hợp

Hệ thống tích hợp giữa Creativanta và Creativanta Video Engine vận hành dựa trên các nguyên tắc cốt lõi:

1. **Không chia sẻ cơ sở dữ liệu (`No Shared DB Assumptions`):**
   Creativanta và Video Engine là hai hệ thống độc lập. Mọi giao tiếp diễn ra 100% qua giao thức mạng chuẩn **REST API v1 (HTTPS)** và **Signed Webhooks**, không truy cập trực tiếp vào bảng cơ sở dữ liệu nội bộ (PostgreSQL, SQLite, Redis) hay vùng lưu trữ tệp (MinIO/S3).

2. **Mô hình xử lý bất đồng bộ (Asynchronous Job Lifecycle):**
   Do tác vụ kết xuất video tiêu tốn tài nguyên tính toán (CPU-first, CFR 30fps), các yêu cầu dựng hình không trả về video trực tiếp mà tiếp nhận yêu cầu với mã HTTP `202 Accepted`, xếp hàng đợi và gửi thông báo hoàn tất qua webhook hoặc cho phép truy vấn định kỳ (polling reconciliation).

3. **Tính bất biến và an toàn phát lại (Idempotency by Design):**
   Mọi đột biến dữ liệu qua phương thức HTTP `POST` đều yêu cầu tiêu đề `Idempotency-Key` (1–128 ký tự ASCII). Hệ thống chuẩn hóa canonical request hash theo chuẩn **RFC 8785 (JCS)**, bảo đảm an toàn tuyệt đối khi gửi lại yêu cầu bị mất kết nối mạng.

---

## 2. Xác thực và Bảo mật (Authentication & Security)

### 2.1 Tiêu đề xác thực Bearer Token

Mọi yêu cầu gọi đến CVE API v1 đều bắt buộc gửi kèm tiêu đề HTTP `Authorization`:

```http
Authorization: Bearer cve_live_placeholder_key_000000000000000000000000
```

> [!IMPORTANT]
> Khóa API của CVE được lưu trữ dưới dạng băm kèm salt (salted/keyed hash) trên máy chủ. Máy chủ chỉ trả về khóa một lần duy nhất lúc khởi tạo. Không bao giờ gửi trực tiếp `tenant_id` trong thân yêu cầu (body); định danh tenant được máy chủ trích xuất an toàn từ khóa API đã xác thực.

### 2.2 Phạm vi quyền hạn (Scopes)

Khóa API được phân quyền theo các phạm vi chức năng:
- `compositions:read/write`: Tạo, truy vấn, và cập nhật tài liệu composition.
- `templates:read/write`: Tra cứu catalog mẫu, quản lý revision, và khởi tạo composition.
- `assets:read/write`: Đăng ký cấp quyền tải lên quarantine, xác thực probe và thu hồi media.
- `jobs:read/write`: Gửi lệnh kết xuất video, tạo ảnh preview, truy vấn trạng thái và yêu cầu hủy tác vụ.
- `webhooks:manage`: Đăng ký, kích hoạt challenge, xoay vòng secret và theo dõi delivery.
- `usage:read`: Đọc nhật ký sử dụng đo lường chi phí hoạt động và thời lượng xuất video.

---

## 3. Giao thức Idempotency và Tham chiếu Đối ngoại

### 3.1 Quy chuẩn Khóa Idempotency-Key

- Định dạng: Chuỗi ASCII có độ dài từ 1 đến 128 ký tự, chỉ gồm các ký tự `[A-Za-z0-9._:-]`.
- Sai định dạng: API trả về HTTP `400 INVALID_IDEMPOTENCY_KEY`.
- Thiếu tiêu đề trên POST: API trả về HTTP `400 IDEMPOTENCY_KEY_REQUIRED`.
- Thời gian lưu giữ bản ghi: 7 ngày.

### 3.2 Canonical Hashing và Phát hiện Xung đột

Máy chủ tính toán mã băm SHA-256 (64 ký tự hex viết thường) trên chuỗi JSON canonical hóa theo chuẩn **RFC 8785 (JSON Canonicalization Scheme - JCS)**:
- Sắp xếp từ điển các khóa (sorted keys).
- Chuẩn hóa ký tự Unicode theo định dạng NFC.
- Loại bỏ khoảng trắng dư thừa ngoài chuỗi.

Khi nhận yêu cầu có cùng `Idempotency-Key`:
- **Cùng thân yêu cầu (same hash):** Máy chủ phát lại nguyên vẹn phản hồi ban đầu kèm tiêu đề `Idempotency-Replayed: true` (trong SDK tương ứng với `isReplayed: true`).
- **Khác thân yêu cầu (differing hash):** Máy chủ từ chối với HTTP `409 IDEMPOTENCY_CONFLICT`.
- **Đang xử lý đồng thời:** Máy chủ trả về HTTP `409 IDEMPOTENCY_IN_PROGRESS` kèm tiêu đề `Retry-After: 1`. Client SDK tự động chờ và thử lại với **chính xác cùng một khóa `Idempotency-Key`**.

### 3.3 Chuẩn hóa Tham chiếu Ngoài (`externalReference`)

Creativanta truyền mã đơn hàng, chiến dịch hoặc định danh nghiệp vụ qua thuộc tính `externalReference`. Thư viện SDK tự động chuẩn hóa và gửi lên máy chủ dưới tên trường `client_reference`:

```typescript
const job = await client.createRenderJob({
  compositionId: 'cmp_spring_launch',
  revision: 1,
  profile: 'mp4-720p-v1',
  externalReference: 'creativanta-order-2026-nov-001',
  idempotencyKey: 'cve_idem_order_nov_001',
});
```

---

## 4. Danh mục API v1 và Vòng đời Tác vụ

| Phương thức & Đường dẫn | Chức năng chính | Mã phản hồi chuẩn |
|---|---|---|
| `GET /v1/capabilities` | Tra cứu profile, engine và giới hạn hệ thống | `200 OK` |
| `POST /v1/compositions/validate` | Kiểm tra tính hợp lệ của spec mà không kết xuất | `200 OK` hoặc `422 VALIDATION_FAILED` |
| `POST /v1/compositions` | Tạo tài liệu composition độc lập từ Scene Spec 1.0 | `201 Created` |
| `GET /v1/compositions/{id}` | Lấy thông tin composition và revision hiện tại | `200 OK` |
| `POST /v1/compositions/{id}/revisions` | Cập nhật revision mới (yêu cầu `base_revision`) | `201 Created` hoặc `409 REVISION_CONFLICT` |
| `GET /v1/templates` | Danh sách template catalog (curated + tenant) | `200 OK` |
| `POST /v1/templates/{id}/instantiate` | Khởi tạo composition revision 1 từ template và biến | `201 Created` |
| `POST /v1/assets/uploads` | Cấp URL đã ký để tải tệp lên vùng quarantine | `201 Created` |
| `POST /v1/assets/{id}/complete` | Xác nhận tải xong, kích hoạt probe/normalize async | `202 Accepted` |
| `DELETE /v1/assets/{id}` | Thu hồi quyền truy cập và yêu cầu xóa tệp | `202 Accepted` |
| `POST /v1/render-jobs` | Tiếp nhận tác vụ kết xuất video MP4 720p | `202 Accepted` + `Location` + `Retry-After` |
| `POST /v1/previews` | Tiếp nhận tác vụ tạo ảnh preview PNG hoặc clip 360p | `202 Accepted` + `Location` |
| `GET /v1/jobs/{id}` | Truy vấn trạng thái, tiến độ và danh sách artifact | `200 OK` |
| `POST /v1/jobs/{id}/cancel` | Yêu cầu hủy tác vụ đang xử lý hoặc xếp hàng | `202 Accepted` / `200 OK` / `409 JOB_TERMINAL` |
| `GET /v1/artifacts/{id}/download` | Lấy grant tải URL đã ký ngắn hạn (TTL <= 5 phút) | `200 OK` |
| `POST /v1/webhook-endpoints` | Đăng ký endpoint nhận webhook (trả secret 1 lần) | `201 Created` |
| `POST /v1/webhook-endpoints/{id}/verify` | Kích hoạt endpoint sau challenge handshake | `202 Accepted` |
| `GET /v1/usage` | Báo cáo sử dụng đo lường chi phí và sản lượng | `200 OK` |

---

## 5. Webhook Ký số và Xác thực HMAC-SHA256

### 5.1 Cấu trúc Tiêu đề Webhook

Máy chủ CVE gửi webhook qua giao thức HTTPS (cổng 443) kèm các tiêu đề ký số bảo mật:
- `X-CVE-Signature`: Chuỗi chữ ký dạng `v1=<64_hex_digits>`.
- `X-CVE-Timestamp`: Thời gian phát sự kiện tính theo giây Unix (ASCII decimal).
- `X-CVE-Event-Id`: Mã định danh duy nhất của sự kiện.
- `X-CVE-Key-Id`: Mã định danh khóa ký bí mật.

### 5.2 Thuật toán Xác thực Chữ ký

Chữ ký được tính toán bằng thuật toán HMAC-SHA256 trên chuỗi byte thô chưa bị biến đổi:

$$\text{payload} = \text{timestamp} + \text{"."} + \text{raw\_body\_bytes}$$
$$\text{signature} = \text{HMAC-SHA256}(\text{secret}, \text{payload})$$

Client SDK thực hiện so sánh an toàn thời gian cố định bằng `crypto.timingSafeEqual` nhằm ngăn chặn tấn công kênh phụ (timing attacks):

```typescript
import { CreativantaWebhookReceiver } from '@creativanta/sdk';

const receiver = new CreativantaWebhookReceiver({
  secrets: 'whsec_placeholder_secret_000000000000000000000000',
  maxSkewSeconds: 300, // Chặn lệch đồng hồ > 5 phút
  retentionMs: 7 * 86400 * 1000, // Khử trùng lặp sự kiện trong 7 ngày
});

receiver.on('job.succeeded', async (event) => {
  console.log(`Job ${event.data.job_id} đã hoàn tất thành công!`);
});

receiver.on('job.failed', async (event) => {
  console.error(`Job ${event.data.job_id} thất bại:`, event.data.error);
});
```

### 5.3 Bảo vệ Đơn điệu Phiên bản Trạng thái (`monotonic state_version`)

Mạng Internet không bảo đảm thứ tự phân phối gói tin. Để ngăn chặn sự kiện cũ đến sau làm ghi đè trạng thái mới, `CreativantaWebhookReceiver` theo dõi trường `state_version` của từng `job_id`:
- Bất kỳ sự kiện nào có `state_version <= lastKnownStateVersion` đều tự động bị bỏ qua (`isStaleStateVersion: true`).

---

## 6. Đối soát Trạng thái và Hủy Tác vụ (Reconciliation & Cancellation)

### 6.1 Cơ chế Polling Reconciliation Lùi số nhân (Exponential Backoff)

Theo đặc tả tại [docs/API.md](../../docs/API.md) dòng 139:
> *"Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation."*

SDK cung cấp hàm `client.reconcileJob(jobId, options)` và lớp điều phối `JobReconciliationManager`:

```typescript
import { JobReconciliationManager } from '@creativanta/sdk';

const reconManager = new JobReconciliationManager({
  client,
  receiver: webhookReceiver,
});

// Chờ tác vụ đạt trạng thái kết thúc (succeeded, failed, canceled)
const finalJob = await reconManager.waitForJobTerminal('job_demo_123', {
  initialIntervalMs: 2000,
  maxIntervalMs: 10000,
  backoffFactor: 1.5,
  timeoutMs: 600000, // 10 phút
});
```

### 6.2 Máy trạng thái Hủy Tác vụ (Cancellation Semantics)

Phương thức `client.cancelJob(jobId, options)` gửi `POST /v1/jobs/{id}/cancel` tuân thủ nghiêm ngặt máy trạng thái CVE:
- **Tác vụ đang `queued`, `preparing`, hoặc `rendering`:** Máy chủ chấp nhận và trả về HTTP `202 Accepted` với trạng thái `canceled` hoặc `cancel_requested`.
- **Tác vụ đã ở trạng thái `canceled`:** Gửi yêu cầu với khóa mới trả về HTTP `200 OK` (xác nhận trạng thái).
- **Tác vụ đã kết thúc (`succeeded` hoặc `failed`):** Máy chủ từ chối với HTTP `409 JOB_TERMINAL` (ném lỗi định kiểu `JobTerminalError`).
- **Phát lại với cùng khóa Idempotency-Key:** Phản hồi kết quả ban đầu kèm `isReplayed: true`.

---

## 7. Làm mới Grant Tải Hết Hạn và Kiểm tra Toàn vẹn (Download Expiry & Integrity)

Các URL tải video xuất ra từ `GET /v1/artifacts/{id}/download` có thời hạn ngắn (TTL <= 5 phút per docs/API.md dòng 44).

Phương thức `client.downloadArtifact(artifactId, options)` tự động xử lý toàn bộ vòng đời tải an toàn:
1. **Làm mới chủ động (Proactive Refresh):** Nếu URL hiện tại sắp hết hạn (nằm trong vùng đệm `refreshBufferMs`, mặc định 30 giây), SDK chủ động gọi `refreshDownloadGrant(artifactId)` để lấy URL đã ký mới mà **không cần kết xuất (rerender) lại video**.
2. **Khôi phục khi gặp HTTP 410 GRANT_EXPIRED:** Nếu grant hết hạn giữa chừng khi kết nối, client tự động bắt lỗi, yêu cầu cấp URL mới và thử tải lại.
3. **Kiểm tra tính toàn vẹn:** Xác thực chính xác số lượng byte và mã băm SHA-256 (`DownloadIntegrityError` khi có dấu hiệu tệp bị hỏng hoặc cắt cụt).

```typescript
const videoBuffer = await client.downloadArtifact('art_video_001', {
  refreshBufferMs: 30000,
  maxRefreshRetries: 2,
  verifyIntegrity: true,
});
```

---

## 8. Xử lý Lỗi và Chiến lược Thử lại (Error Handling & Retry Matrix)

### 8.1 Khuôn mẫu Phản hồi Lỗi Chuẩn

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Composition không hợp lệ",
    "request_id": "req_demo_001",
    "retryable": false,
    "details": [
      {
        "pointer": "/spec/duration_frames",
        "code": "OUT_OF_RANGE",
        "message": "Phải lớn hơn 0"
      }
    ]
  }
}
```

### 8.2 Bảng Phân loại Mã Lỗi và Hành động Khuyến nghị

| HTTP Mã | Mã Lỗi Tiêu Biểu | Lớp Lỗi trong SDK | Tính chất Thử lại | Hành động của Khách hàng |
|---|---|---|---|---|
| **400** | `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `MALFORMED_JSON` | `BadRequestError` | Không thử lại (`retryable: false`) | Sửa cú pháp yêu cầu và định dạng khóa. |
| **401** | `UNAUTHENTICATED` | `AuthenticationError` | Không thử lại | Kiểm tra hoặc xoay vòng khóa API token. |
| **403** | `INSUFFICIENT_SCOPE`, `TENANT_SUSPENDED` | `ForbiddenError` | Không thử lại | Yêu cầu cấp bổ sung scope phù hợp. |
| **404** | `NOT_FOUND` | `NotFoundError` | Không thử lại | Kiểm tra ID tài nguyên trên đường dẫn URL. |
| **409** | `IDEMPOTENCY_IN_PROGRESS` | `IdempotencyInProgressError` | **Tự động thử lại** (`retryable: true`) | SDK tự động chờ theo `Retry-After: 1` và gửi lại với **chính xác cùng một khóa `Idempotency-Key`**. |
| **409** | `IDEMPOTENCY_CONFLICT` | `IdempotencyConflictError` | Không thử lại | Thay đổi khóa Idempotency-Key hoặc giữ nguyên thân yêu cầu cũ. |
| **409** | `REVISION_CONFLICT` | `RevisionConflictError` | Không thử lại | Đọc lại revision mới nhất từ server và hợp nhất thay đổi. |
| **409** | `JOB_TERMINAL` | `JobTerminalError` | Không thử lại | Tác vụ đã hoàn tất hoặc thất bại, không thể hủy. |
| **410** | `GRANT_EXPIRED`, `ARTIFACT_EXPIRED` | `GrantExpiredError`, `ResourceExpiredError` | Tự động làm mới grant | SDK tự động lấy URL mới qua `refreshDownloadGrant`. |
| **413** | `PAYLOAD_TOO_LARGE` | `PayloadTooLargeError` | Không thử lại | Giảm kích thước thân yêu cầu HTTP (<= 1 MiB). |
| **422** | `VALIDATION_FAILED`, `UNSUPPORTED_CAPABILITY` | `ValidationError`, `UnsupportedCapabilityError` | Không thử lại | Sửa đổi spec theo `details[]` (JSON Pointer). |
| **429** | `RATE_LIMITED`, `QUOTA_EXCEEDED` | `RateLimitedError` | **Tự động thử lại** (`retryable: true`) | Chờ theo `Retry-After` kèm jitter ngẫu nhiên, giữ nguyên `Idempotency-Key`. |
| **503** | `SERVICE_UNAVAILABLE` | `ServiceUnavailableError` | **Tự động thử lại** (`retryable: true`) | Lùi theo hàm mũ kèm jitter ngẫu nhiên, giữ nguyên `Idempotency-Key`. |

---

## 9. Ví dụ Mã Tích hợp Hoàn chỉnh (End-to-End TypeScript Example)

```typescript
import {
  CreativantaClient,
  CreativantaWebhookReceiver,
  JobReconciliationManager,
  ValidationError,
  JobTerminalError,
} from '@creativanta/sdk';

// 1. Khởi tạo Khách hàng với Thông tin Giữ chỗ
const client = new CreativantaClient({
  baseUrl: 'https://video.example.invalid/v1',
  apiKey: 'cve_live_placeholder_key_000000000000000000000000',
  timeoutMs: 15000,
  maxRetries: 3,
});

async function main() {
  try {
    // 2. Tra cứu Năng lực Hệ thống
    const caps = await client.getCapabilities();
    console.log(`Kết nối CVE API phiên bản ${caps.api_version} thành công.`);

    // 3. Khởi tạo Composition từ Mẫu Curated
    const composition = await client.instantiateTemplate('tpl_retail_promo', {
      templateRevision: 1,
      name: 'Chiến dịch Khuyến mãi Mùa Đông',
      variables: {
        headline: 'Ưu đãi Đặc Biệt 50%',
        price: '199.000 ₫',
      },
      locale: 'vi-VN',
      idempotencyKey: `tpl_inst_${Date.now()}`,
    });

    // 4. Gửi Lệnh Dựng Hình Kèm Idempotency và Mã Đơn hàng Đối ngoại
    const admittedJob = await client.createRenderJob({
      compositionId: composition.id,
      revision: composition.revision,
      profile: 'mp4-720p-v1',
      externalReference: 'order_creativanta_88291',
      idempotencyKey: `render_job_${Date.now()}`,
    });
    console.log(`Đã tiếp nhận tác vụ dựng hình: ${admittedJob.id}`);

    // 5. Đối soát Trạng thái Tác vụ
    const reconManager = new JobReconciliationManager(client);
    const completedJob = await reconManager.waitForJobTerminal(admittedJob.id, {
      initialIntervalMs: 2000,
      maxIntervalMs: 10000,
      timeoutMs: 300000,
    });

    // 6. Tải Tệp Video Thành phẩm và Kiểm tra Toàn vẹn Byte & Hash
    const videoArtifact = completedJob.artifacts.find((a) => a.kind === 'video');
    if (videoArtifact) {
      const videoBuffer = await client.downloadArtifact(videoArtifact.id, {
        verifyIntegrity: true,
      });
      console.log(`Đã tải video thành công: ${videoBuffer.length} bytes.`);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      console.error('Lỗi kiểm tra tính hợp lệ dữ liệu:', err.details);
    } else if (err instanceof JobTerminalError) {
      console.error('Tác vụ đã ở trạng thái kết thúc, không thể thay đổi.');
    } else {
      console.error('Lỗi tích hợp CVE:', err);
    }
  }
}

main();
```
