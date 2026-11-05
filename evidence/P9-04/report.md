# Báo cáo bằng chứng nghiệm thu nhiệm vụ P9-04

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ **P9-04: D+Supervisor / P9** (External Creativanta handoff packet: base URL/env/scopes/fixtures/mapping/runbook; phối hợp integration task ngoài repo **chỉ sau quyền riêng**, ghi status harness vs live rõ ràng) trong repository độc lập `creativanta-video-engine`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), [API specification](../../docs/API.md), [API Integration Guide](../../packages/sdk/docs/API_INTEGRATION_GUIDE.md), [P5-04 Report](../P5-04/report.md) và [P6-05 Report](../P6-05/report.md).

> [!IMPORTANT]
> **Ranh giới tích hợp đối ngoại và Cổng cấp quyền (External Integration Boundary & Authority Gate):**
> Việc phối hợp và triển khai nhiệm vụ tích hợp trên kho lưu trữ ngoài của Creativanta, hạ tầng live production, DNS thương mại, và cấp phát thông tin ủy nhiệm môi trường thật **CHỈ ĐƯỢC PHÉP THỰC HIỆN KHI CÓ QUYỀN VÀ PHẠM VI RIÊNG** được cấp bởi Supervisor/Operator (`EXT-GATE-CREATIVANTA-02`).
> Báo cáo này xác nhận hoàn tất đầy đủ gói bàn giao kỹ thuật độc lập tại [handoff-packet.json](handoff-packet.json), cẩm nang vận hành tích hợp tại [handoff-runbook.md](handoff-runbook.md), bộ dữ liệu mẫu E2E chuẩn mực, và kiểm chứng thành công 100% trên bộ mô phỏng hợp đồng nội bộ (`CreativantaContractMock`) với nguyên tắc tuyệt đối **không chia sẻ cơ sở dữ liệu** (`no shared DB assumptions`).

## Bằng chứng thực thi (Evidence Template)

```text
Task: P9-04
Role / Phase: D+Supervisor / P9
Base commit: 526d3c80a25ee743ad2954a6db24ce22c3666f28 / HEAD (agy/p9-04)
Environment: Linux x86_64, Node.js v24.x, TypeScript 5.7.3, Python 3.12, pnpm 12.16.1
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0, 52 tasks acyclic, 0 errors)
  2. node evidence/P9-04/verify-handoff-packet.mjs -> PASS (exit code 0, 14/14 checks passed)
  3. node packages/sdk/scripts/run-client-examples.mjs -> PASS (exit code 0, client & error recipes passed)
  4. node --test packages/sdk/test/v1-compatibility.test.mjs -> PASS (exit code 0, 15/15 tests passed)
  5. node --test packages/sdk/test/error-and-retry-examples.test.mjs -> PASS (exit code 0, 19/19 tests passed)
  6. node --test ops/scaling/*.test.mjs -> PASS (exit code 0, 10/10 tests passed)
  7. node scripts/health-check.mjs -> PASS (exit code 0, environment & capabilities verified)
Artifacts:
  - evidence/P9-04/handoff-packet.json
  - evidence/P9-04/handoff-runbook.md
  - evidence/P9-04/verify-handoff-packet.mjs
  - evidence/P9-04/summary.json
  - evidence/P9-04/report.md
  - evidence/P9-04/fixtures/template-instantiate-retail-promo.json
  - evidence/P9-04/fixtures/render-job-request.json
  - evidence/P9-04/fixtures/webhook-job-succeeded.json
  - evidence/P9-04/fixtures/webhook-job-failed.json
  - evidence/P9-04/fixtures/webhook-challenge-handshake.json
  - evidence/P9-04/fixtures/asset-upload-grant-and-complete.json
  - evidence/P9-04/fixtures/error-responses.json
  - evidence/P9-04/fixtures/idempotency-replay-response.json
Acceptance mapping:
  - Base URL: PASS — Định nghĩa và kiểm chứng 3 môi trường phân định rõ ràng (Local Mock Harness: http://127.0.0.1:4000/v1, Staging Private Beta: https://staging-cve.creativanta.internal/v1 bắt buộc TLS 1.2+, và Production Target: https://video.creativanta.com/v1 bắt buộc TLS 1.3).
  - Env: PASS — Đặc tả đầy đủ 11 biến môi trường tích hợp kèm kiểu dữ liệu, ràng buộc regex, giá trị mặc định, ví dụ placeholder chuẩn bảo mật (không rò rỉ private keys hay tokens thực tế), và cơ chế quản lý cấu hình client.
  - Scopes: PASS — Danh mục toàn diện 11 quyền hạn API (scopes) chuẩn docs/API.md cùng tập hợp 8 quyền khuyến nghị tối thiểu cho dịch vụ nền tảng Creativanta (jobs:read/write, templates:read, compositions:write, assets:read/write, webhooks:manage, usage:read).
  - Fixtures: PASS — 8 tệp dữ liệu mẫu JSON thực tế bao quát toàn bộ vòng đời: khởi tạo template bán lẻ Tiếng Việt (tpl_retail_promo), đệ trình render job có Idempotency-Key và client_reference, sự kiện webhook job.succeeded kèm thông số tạo tác MP4, sự kiện webhook job.failed kèm mã lỗi định kiểu, bắt tay xác thực endpoint thử thách (challenge echo handshake), nạp tài sản cách ly (asset intake grant & complete), phản hồi phát lại an toàn (Idempotency-Replayed: true), và danh mục mã lỗi chuẩn HTTP 400..503.
  - Mapping: PASS — Ma trận ánh xạ 2 chiều minh bạch giữa các thực thể nghiệp vụ Creativanta (OrderId, CampaignId, Media Asset, Video Request, Polling Fallback, Webhook, Video Download) và các tài nguyên REST API v1 của Video Engine kèm quy tắc chuyển trạng thái chu kỳ làm việc.
  - Runbook: PASS — Cẩm nang vận hành chi tiết từng bước (evidence/P9-04/handoff-runbook.md) hướng dẫn đội ngũ tích hợp Creativanta kiểm thử với local harness, thiết lập Webhook bắt tay thử thách, gửi tác vụ an toàn với khóa Idempotency, đối soát lùi số mũ 2s->10s, làm mới URL tải xuống có thời hạn <= 300s, và sổ tay xử lý sự cố.
  - Phối hợp integration task ngoài repo chỉ sau quyền riêng: PASS — Ranh giới an ninh được tuyên bố rõ ràng trong handoff packet, runbook và báo cáo; không tự ý chỉnh sửa repo Creativanta bên ngoài, không sửa hạ tầng host/production.
  - Ghi status harness vs live rõ ràng: PASS — In-repo Contract Harness được đánh dấu VERIFIED_READY (kiểm chứng 100% qua bộ giả lập CreativantaContractMock và 102 SDK tests); Live External Integration được đánh dấu BLOCKED_PENDING_SEPARATE_AUTHORIZED_SCOPE (chờ phân bổ quyền riêng).
Reviewer / reviewed commit / decision: implemented_local / 526d3c80a25ee743ad2954a6db24ce22c3666f28 / HEAD (agy/p9-04) / Acceptance met, 14/14 packet checks passed, zero secrets leaked
```

---

## 1. Tóm tắt kết quả bàn giao (Handoff Executive Summary)

Nhiệm vụ **P9-04** hoàn thành toàn bộ các thành phần của Gói bàn giao tích hợp đối ngoại Creativanta (**External Creativanta Handoff Packet**) theo đúng khế ước kỹ thuật và các quy định tại [AGENTS.md](../../AGENTS.md) và [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md):

| Trụ cột bàn giao | Tài liệu / Tệp cấu hình | Trạng thái kỹ thuật | Mô tả nội dung nghiệm thu |
| --- | --- | :---: | --- |
| **Gói dữ liệu máy đọc (Handoff Packet)** | [handoff-packet.json](handoff-packet.json) | **PASS** | Tệp JSON chuẩn xác thực cấu trúc máy chủ, biến môi trường, scopes, fixtures, và ma trận ánh xạ |
| **Cẩm nang vận hành tích hợp (Runbook)** | [handoff-runbook.md](handoff-runbook.md) | **PASS** | Hướng dẫn 7 bước từ kiểm thử local mock, đăng ký webhook, đệ trình tác vụ, đến xử lý sự cố vận hành |
| **Kịch bản kiểm chứng tự động** | [verify-handoff-packet.mjs](verify-handoff-packet.mjs) | **PASS** | Kiểm chứng 14/14 chỉ tiêu: tính toàn vẹn schema, fixtures, scopes, env vars, zero secrets, và mô phỏng E2E |
| **Bộ dữ liệu mẫu hợp đồng (Fixtures)** | `evidence/P9-04/fixtures/*.json` | **PASS** | 8 tệp fixtures thực tế bao quát đầy đủ các nhánh nghiệp vụ, webhook, idempotency và mã lỗi |
| **Bản tóm tắt nghiệm thu kỹ thuật** | [summary.json](summary.json) | **PASS** | Tổng kết số liệu kiểm tra, trạng thái cổng đối ngoại và ranh giới tích hợp |

---

## 2. Chi tiết 8 thành phần bàn giao cốt lõi

### 2.1. Điểm cuối dịch vụ và Yêu cầu Mạng (Base URLs & Network Policy)

Hệ thống cung cấp 3 môi trường phân định độc lập:

1. **Local Contract Mock Harness (`http://127.0.0.1:4000/v1`):**
   - Vận hành trên vòng lặp nội bộ (Loopback dev).
   - Tích hợp sẵn trong `@creativanta/sdk` qua lớp `CreativantaContractMock`.
   - Không yêu cầu mã hóa TLS; phục vụ chạy kiểm thử CI/CD và phát triển chức năng không phụ thuộc hạ tầng mạng.

2. **Staging / Private Beta (`https://staging-cve.creativanta.internal/v1`):**
   - Môi trường Staging biệt lập dành cho đối tác tích hợp Creativanta.
   - Bắt buộc mã hóa bảo mật giao vận TLS 1.2+.
   - Cung cấp khóa API thử nghiệm `cve_test_...` và webhook signing secret riêng biệt.

3. **Production Target (`https://video.creativanta.com/v1`):**
   - Điểm cuối thương mại chính thức (chờ kích hoạt sau cổng quyết định GA P9-05).
   - Bắt buộc mã hóa TLS 1.3 với chứng chỉ công khai hợp lệ.
   - Cơ chế bảo vệ rate limit và hạn ngạch (quota) thương mại.

---

### 2.2. Đặc tả Biến Môi trường (Environment Configuration)

11 biến môi trường được chuẩn hóa tại [handoff-packet.json](handoff-packet.json) bao gồm:

- `CREATIVANTA_API_BASE_URL`: Điểm cuối API v1 (HTTPS bắt buộc ngoài local).
- `CREATIVANTA_API_KEY`: Khóa Bearer token 32-byte độ hỗn loạn cao (placeholder: `cve_live_placeholder_key_000000000000000000000000`).
- `CREATIVANTA_WEBHOOK_SECRET`: Khóa bí mật HMAC-SHA256 (placeholder: `whsec_placeholder_secret_000000000000000000000000`).
- `CREATIVANTA_WEBHOOK_ENDPOINT_URL`: URL tiếp nhận callback có chữ ký của Creativanta.
- `CREATIVANTA_CLIENT_TIMEOUT_MS`: Hạn mức thời gian chờ kết nối và đọc HTTP (mặc định 30.000ms).
- `CREATIVANTA_MAX_RETRIES`: Số lần thử lại tối đa cho các lỗi tạm thời 409 IN_PROGRESS, 429, 503 (mặc định 3 lần).
- `CREATIVANTA_INITIAL_BACKOFF_MS` / `CREATIVANTA_MAX_BACKOFF_MS`: Giới hạn lùi số mũ (1.000ms -> 10.000ms).
- `CREATIVANTA_POLL_INTERVAL_INITIAL_MS` / `CREATIVANTA_POLL_INTERVAL_MAX_MS`: Nhịp thăm dò đối soát dự phòng (2.000ms -> 10.000ms per docs/API.md dòng 139).
- `CREATIVANTA_GRANT_REFRESH_BUFFER_MS`: Vùng đệm làm mới URL tải xuống trước hạn (mặc định 60.000ms).

---

### 2.3. Danh mục Phân quyền (Permission Scopes)

Danh mục phân quyền được đối chiếu nghiêm ngặt với [API specification](../../docs/API.md):

- `jobs:read` / `jobs:write`: Quản lý toàn diện tác vụ kết xuất và kiểm tra trạng thái.
- `templates:read` / `templates:write`: Tra cứu danh mục mẫu và đăng ký mẫu tùy chỉnh.
- `compositions:read` / `compositions:write`: Đọc và cập nhật tài liệu cảnh động (scene specification).
- `assets:read` / `assets:write`: Quản lý tài sản số qua khu cách ly (quarantine).
- `webhooks:manage`: Quản lý điểm nhận thông báo, thử thách quyền sở hữu, và xoay vòng secret.
- `usage:read`: Đo lường chi phí hoạt động và thời lượng kết xuất phục vụ đối soát cước.
- `authoring:write`: Quyền hạn tạo cảnh qua AI (giữ khóa mặc định, không cấp cho luồng kết xuất thông thường).

**Tập hợp khuyến nghị tối thiểu cho Creativanta Platform:**
`["jobs:read", "jobs:write", "templates:read", "compositions:write", "assets:read", "assets:write", "webhooks:manage", "usage:read"]`.

---

### 2.4. Danh mục Bộ dữ liệu mẫu Hợp đồng (Contract Fixtures)

8 tệp dữ liệu mẫu JSON độc lập được lưu trữ tại `evidence/P9-04/fixtures/`:

1. `template-instantiate-retail-promo.json`: Khởi tạo mẫu quảng cáo bán lẻ Tiếng Việt với các biến tiêu đề, giá tiền, nhãn giảm giá, và mã tài sản ảnh.
2. `render-job-request.json`: Yêu cầu kết xuất kèm `Idempotency-Key` chuẩn ASCII và `client_reference` liên kết đơn hàng Creativanta.
3. `webhook-job-succeeded.json`: Thông điệp webhook kết xuất thành công kèm mã tạo tác MP4, thời lượng, và tiêu đề chữ ký `X-CVE-Signature`.
4. `webhook-job-failed.json`: Thông điệp webhook thất bại kèm mã lỗi định kiểu `RENDER_EXECUTION_TIMEOUT` và cờ `retryable: false`.
5. `webhook-challenge-handshake.json`: Cấu trúc yêu cầu thử thách sở hữu và phản hồi echo handshake `{"challenge": "<token>"}`.
6. `asset-upload-grant-and-complete.json`: Quy trình 3 bước nạp tài sản: xin cấp grant tải, tải tệp lên URL ký sẵn, và xác nhận hoàn tất kèm sha256.
7. `error-responses.json`: Bảng tra cứu mẫu cho 12 mã phản hồi lỗi HTTP chuẩn mực (400, 401, 403, 404, 409, 410, 422, 429, 503).
8. `idempotency-replay-response.json`: Phản hồi phát lại với tiêu đề `Idempotency-Replayed: true` khi gửi trùng khóa và nội dung.

---

### 2.5. Ma trận Ánh xạ Thực thể (Entity & Domain Mapping)

| Khái niệm Creativanta | Khái niệm Video Engine (CVE v1) | Ghi chú chuyển đổi và Quy tắc vận hành |
| --- | --- | --- |
| **Mã đơn hàng / Campaign ID** | `client_reference` (`external_reference`) | CVE lưu trữ và gửi kèm trong webhook/status mà không can thiệp ngữ nghĩa |
| **Lệnh xuất video** | `POST /v1/render-jobs` | Bắt buộc tiêu đề `Idempotency-Key` (1–128 ký tự ASCII) |
| **Mẫu video & Biến nội dung** | `POST /v1/templates/{id}/instantiate` | Ghim cứng số hiệu phiên bản `revision: 1` (không dùng "latest") |
| **Tài sản hình ảnh / âm thanh** | Quarantine Asset Lifecycle | Tải lên khu cách ly -> Probe kiểm tra -> Chuyển `ready` |
| **Thông báo hoàn tất** | HMAC-Signed Webhook Event | Xác thực an toàn thời gian cố định `timingSafeEqual`, kiểm tra lệch giờ <= 300s |
| **Đối soát dự phòng khi mất Webhook** | `GET /v1/jobs/{id}` Polling | Thăm dò lùi số mũ 2s -> 10s, dừng ngay khi đạt trạng thái kết thúc |
| **Tải video thành phẩm** | `GET /v1/artifacts/{id}/download` | URL ký có thời hạn <= 300s, tự động làm mới khi gặp HTTP 410 GRANT_EXPIRED |

---

### 2.6. Cẩm nang Vận hành và Xử lý Sự cố (Runbook)

Tài liệu [handoff-runbook.md](handoff-runbook.md) đặc tả quy trình vận hành toàn diện và cung cấp hướng dẫn xử lý 4 tình huống sự cố điển hình:
- **Xử lý mã 409 IDEMPOTENCY_IN_PROGRESS:** Đọc tiêu đề `Retry-After` và thử lại với cùng khóa `Idempotency-Key`.
- **Xử lý mã 409 IDEMPOTENCY_CONFLICT:** Phát hiện sai lệch thân yêu cầu, hướng dẫn sinh khóa mới cho tác vụ khác biệt.
- **Xử lý điều tiết 429 RATE_LIMITED / 503:** Áp dụng thuật toán lùi số mũ kèm jitter và bảo toàn khóa idempotency.
- **Xử lý sai lệch chữ ký Webhook:** Hướng dẫn bảo tồn chuỗi byte thô (`raw_body_bytes`), không reserialize JSON trước khi tính HMAC.

---

### 2.7. Phân định Rõ ràng Trạng thái: Harness vs Live

| Môi trường / Thành phần | Trạng thái ghi nhận | Căn cứ kỹ thuật & Ranh giới |
| --- | :---: | --- |
| **In-repo Contract Harness** | **`VERIFIED_READY`** | Đã được kiểm chứng toàn diện qua bộ kiểm thử E2E trong kho mã (`packages/sdk/test/creativanta-e2e-contract-harness.test.mjs`), 102/102 SDK tests đạt PASS, 0 kết nối cơ sở dữ liệu dùng chung. |
| **Live External Service Integration** | **`BLOCKED_PENDING_SEPARATE_AUTHORIZED_SCOPE`** | Nhiệm vụ chỉnh sửa kho mã nguồn Creativanta thật, cấp phát hạ tầng VPS/Kubernetes production, DNS thương mại, và nạp khóa bí mật thật thuộc cổng cấp quyền đối ngoại `EXT-GATE-CREATIVANTA-02`. Tuyệt đối không tự ý thực thi trong repo này. |

---

## 3. Kết quả Kiểm thử Nghiệm thu Thực tế

Thực thi bộ script kiểm chứng bàn giao tự động [verify-handoff-packet.mjs](verify-handoff-packet.mjs):

```bash
node evidence/P9-04/verify-handoff-packet.mjs
```

Kết quả đo đạc thực tế:
- **Tổng số hạng mục kiểm tra:** 14/14 kiểm tra đạt **PASS** (100%).
- **Cấu trúc handoff-packet.json:** Đạt chuẩn cú pháp JSON Schema.
- **Phân định ranh giới Harness vs Live:** Xác thực thành công trạng thái `VERIFIED_READY` và `BLOCKED_PENDING_SEPARATE_AUTHORIZED_SCOPE`.
- **Base URLs & TLS Policies:** Xác thực đúng 3 môi trường và quy chuẩn TLS.
- **Đặc tả Biến môi trường:** 11/11 biến môi trường đầy đủ kiểu dữ liệu, ràng buộc và ví dụ placeholder an toàn.
- **Danh mục Scopes:** 11 scopes sẵn có, 8 scopes khuyến nghị tối thiểu cho Creativanta.
- **Tính toàn vẹn Fixtures:** 8/8 tệp fixtures tồn tại, cú pháp hợp lệ, và đối chiếu khớp với schema.
- **Ma trận Ánh xạ Thực thể:** 7 cặp ánh xạ thực thể và chu kỳ trạng thái non-terminal/terminal.
- **Kiểm toán An ninh Bí mật (Zero Secrets Audit):** Xác nhận 0 private keys, 0 production tokens, 0 thông tin ủy nhiệm thật trong toàn bộ gói bàn giao.
- **Mô phỏng E2E Hợp đồng trên CreativantaContractMock:**
  - `getCapabilities`: Đạt (2 profiles).
  - `instantiateTemplate`: Đạt (khởi tạo `tpl_retail_promo` thành công composition revision 1).
  - `createRenderJob`: Đạt (tiếp nhận tác vụ với `client_reference` và `Idempotency-Key`).
  - `idempotency replay`: Đạt (phản hồi `isReplayed: true` với cùng ID tác vụ).
  - `reconcileJob`: Đạt (đối soát thăm dò đạt trạng thái kết thúc `succeeded`).
  - `webhook HMAC verification`: Đạt (xác thực chữ ký số thời gian cố định thành công trên sự kiện `job.succeeded`).

---

## 4. Các Cổng Đối ngoại Tiếp theo (External Gates)

1. **`EXT-GATE-CREATIVANTA-02` (External Creativanta Integration):** Cổng phê duyệt bàn giao kỹ thuật từ Supervisor và Creativanta Integration Lead; cấp quyền phân bổ nhiệm vụ riêng để tích hợp gói này vào kho mã nguồn của Creativanta.
2. **`EXT-GATE-STAGING-P9-04` (Staging Integration):** Supervisor thực hiện review diff và tích hợp nhánh `agy/p9-04` vào nhánh `origin/staging`.
3. **`EXT-GATE-PROD-LIVE-CREDS` (Production Secrets Management):** Cổng quản lý an ninh hạ tầng cấp phát khóa API sản xuất thật và đăng ký webhook sản xuất tại thời điểm phát hành chính thức (GA P9-05).
