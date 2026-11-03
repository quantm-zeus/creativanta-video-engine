# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-04

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-04` (`Stream A+C / Phase P4` — Signed Webhook Lifecycle, Challenge Echo Handshake, Rotation, Outbox Delivery & Bounded Retries): Triển khai toàn diện hệ thống Webhook có chữ ký bảo mật gồm đăng ký endpoint (`POST /v1/webhook-endpoints`), mã hóa signing secret ở trạng thái nghỉ (`AES-256-GCM`), phòng vệ SSRF đa tầng (cấm IP loopback, dải IP nội bộ RFC 1918/6598, cloud metadata `169.254.169.254`, userinfo, fragment, non-HTTPS), bắt tay xác thực quyền sở hữu (`endpoint.challenge`, random 32 bytes, phản hồi `<= 5s`, TTL 10 phút), xoay vòng khóa bí mật (`POST /v1/webhook-endpoints/{id}/rotate-secret`) hỗ trợ khóa cũ có hiệu lực 24 giờ (dual-key grace period), mô hình Transactional Outbox đảm bảo sự cố mạng/outage không bao giờ mất sự kiện hay công việc (`outage không mất event/job`), cơ chế gửi hàng loạt và thử lại có chặn (`bounded retries`: lịch 8 lần thử tại `0, 60s, 300s, 900s, 3600s, 14400s, 43200s, 86400s` kèm jitter `<= 10%`, clamp không vượt quá hard deadline 25 giờ, xử lý đặc biệt HTTP 410 vô hiệu hóa endpoint vĩnh viễn, HTTP 3xx cấm redirect chuyển `dead_letter`, HTTP 4xx không thử lại), xóa endpoint dừng toàn bộ phát sự kiện chờ (`DELETE /v1/webhook-endpoints/{id}`), truy vấn lịch sử và phát lại (`POST /v1/webhook-deliveries/{id}/replay`) giữ nguyên `outbox_event_id` với hạn ngạch 5 lần/ngày/delivery trong cửa sổ 7 ngày (sau đó trả HTTP 410 `DELIVERY_EXPIRED`), kiểm định chữ ký HMAC-SHA256 trên byte thô UTF-8 (`HMAC raw bytes`) với so sánh thời gian bất biến (`crypto.timingSafeEqual`), từ chối lệch đồng hồ `> 300s`, và khử trùng lặp sự kiện trong 7 ngày kèm kiểm tra tính đơn điệu `state_version` loại bỏ sự kiện cũ, tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-04
Base / tested commit: b86920a / HEAD (agy/p4-04 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:dns, node:net, node:tls, node:http & node:https), TypeScript 5.7.3, Python 3.11.2
Command: ./node_modules/.bin/tsc -p packages/api/tsconfig.json && ./node_modules/.bin/tsc -p packages/api/tsconfig.json --noEmit && node --test packages/api/test/p4-04-signed-webhooks.test.mjs && node --test packages/api/test/p4-01-admission-and-quotas.test.mjs && node --test packages/api/test/server.test.mjs && node --test packages/api/test/p4-03-cancel-timeout-retry-reaper-races.test.mjs && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T18:27:00Z / 0.7s (P4-04 suite: 21/21 pass), 31.8s (full integration verification)
Artifacts:
  - packages/api/src/webhook/types.ts, sha256=bc5192b61694c9b92c15b24b85c130ce407ba6d9120d9715f91421e3cba12f01, expires=N/A (repo-versioned)
  - packages/api/src/webhook/crypto.ts, sha256=d27694328c7e5b34dac4da1074a82716a9ef1565f1edec5b2ddc27ff8c7be58c, expires=N/A (repo-versioned)
  - packages/api/src/webhook/http-client.ts, sha256=6bf2ad2e62372bcb24f00af9afcf44eb22da83f0c55e5cec0f953d93bedf89db, expires=N/A (repo-versioned)
  - packages/api/src/webhook/receiver-verifier.ts, sha256=6ca6be7ff3e6fc6c0e3284255808657c4c1ab9a1df501d5ecf2b673d3b66bd51, expires=N/A (repo-versioned)
  - packages/api/src/webhook/delivery-service.ts, sha256=b88fa3afe6c12109f9e4355c8b6034c26bb24a73bf4a78f746fc7f6c6ac79be1, expires=N/A (repo-versioned)
  - packages/api/src/webhook/index.ts, sha256=a878a74c25d6e9b239f11c4fff365954167818b7427b84449f13699663e7414e, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=613b75d0c42c4828e6d47165a17d80954624481eb1f4bfce6edf17c224f47d7a, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=72401c3c0f7d98d0eceb42b930e9895ad218fef78b854493372977f733ff0031, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=1b77a30d29db24d4d35139197d7d466f8d317697dfeb111c5e81f6281b5af38d, expires=N/A (repo-versioned)
  - packages/dispatcher/index.mjs, sha256=ba4834e258826094a18ae591346562be1755a54233593c5d167d418c46d75810, expires=N/A (repo-versioned)
  - packages/api/test/p4-04-signed-webhooks.test.mjs, sha256=96fa0f1f22b0df213a4ef0f96ae9f71fa4f09d77190c14eb81170cf0ffe74961, expires=N/A (repo-versioned)
  - evidence/P4-04/report.md, sha256=pending_commit, expires=N/A (repo-versioned)
Acceptance mapping:
  - Signed webhook registration & at-rest encryption: PASS — `POST /v1/webhook-endpoints` đăng ký endpoint ở trạng thái `pending_verification`, sinh secret `whsec_<hex>` và trả plaintext secret duy nhất một lần ở response đầu. Yêu cầu idempotent gửi lại cùng khóa trả `secret_redacted: true`, không bao giờ lưu secret thô trong idempotency store. Secret được mã hóa tĩnh (`AES-256-GCM`) bằng master key trong DB (`enc:v1:<iv>:<tag>:<ciphertext>`). `GET /v1/webhook-endpoints/{id}` trả trạng thái và thống kê tổng kết, không bao giờ lộ secret. Ngăn chặn IDOR hoàn toàn: Tenant B thăm dò ID của Tenant A luôn nhận `404 NOT_FOUND` (không phải 403).
  - Challenge echo handshake: PASS — `POST /v1/webhook-endpoints/{id}/verify` kích hoạt quy trình bắt tay: gửi sự kiện `endpoint.challenge` với 32 byte ngẫu nhiên (`data.challenge`), có chữ ký HMAC-SHA256 hợp lệ. Receiver phải kiểm chữ ký và phản hồi JSON `{ "challenge": "<exact received value>" }` trong `<= 5s`. Challenge token có hạn 10 phút, dùng 1 lần duy nhất; endpoint chỉ chuyển sang `active` khi token trùng khớp chính xác. Hỗ trợ xác nhận trực tiếp qua body khi người dùng cung cấp challenge token.
  - Secret rotation & dual-key verification: PASS — `POST /v1/webhook-endpoints/{id}/rotate-secret` tạo secret mới với `active_key_id` mới (`whk_2`), lưu secret cũ vào `prev_key_id` và cấp thời hạn ân hạn 24 giờ (`prev_secret_expires_at = now + 24h`). Thư viện xác thực receiver hỗ trợ kiểm tra song song cả hai khóa trong thời gian ân hạn. Replay rotation trả `secret_redacted: true`.
  - Transactional Outbox & Outage resilience ("Outage không mất event/job"): PASS — Sự kiện `jobs` và bản ghi `outbox` được lưu trong cùng transaction atomic. Khi endpoint hoặc hạ tầng mạng gặp sự cố (receiver trả 503/5xx), sự kiện và công việc tuyệt đối không bị mất; `WebhookDeliveryService.processOutbox()` đưa vào hàng đợi `webhook_deliveries` và lên lịch thử lại (`retry_scheduled`). Khi sự cố được khắc phục, chu kỳ phân phối tiếp theo gửi thành công và chốt trạng thái `delivered`.
  - Bounded SSRF-safe retries: PASS — Tuân thủ nghiêm ngặt lịch 8 lần thử tại `[0, 60s, 300s, 900s, 3600s, 14400s, 43200s, 86400s]` (+jitter `<= 10%`). Mọi độ trễ, jitter và header `Retry-After` đều được clamp không bao giờ vượt quá hard deadline 25 giờ từ lúc tạo delivery; lần thử thứ 8 thất bại chuyển sang `failed`. Phản hồi HTTP 410 Gone lập tức vô hiệu hóa endpoint vĩnh viễn (`disabled`) và chuyển delivery sang `dead_letter`. HTTP 3xx Redirect bị cấm tuyệt đối, chuyển ngay `dead_letter`. Lỗi client HTTP 4xx (400, 401, 404) chuyển ngay sang `dead_letter`.
  - Endpoint deletion halts deliveries: PASS — `DELETE /v1/webhook-endpoints/{id}` đánh dấu `disabled` endpoint; bộ điều phối kiểm tra trạng thái endpoint trước khi gửi và dừng ngay lập tức mọi delivery đang chờ (`state = 'dead_letter'`), đảm bảo nguyên tắc "Endpoint bị xóa thì không gửi tiếp".
  - Delivery list & Replay API: PASS — `GET /v1/webhook-deliveries` hỗ trợ phân trang, lọc theo `job_id`, `endpoint_id`, cô lập tenant tuyệt đối. `POST /v1/webhook-deliveries/{id}/replay` đặt lại trạng thái `queued` và bảo toàn nguyên vẹn `outbox_event_id` ban đầu. Giới hạn tối đa 5 lần phát lại mỗi ngày trên mỗi delivery (`429 QUOTA_EXCEEDED` kèm `Retry-After`) và chỉ cho phép trong vòng 7 ngày từ ngày tạo sự kiện (sau đó trả `410 DELIVERY_EXPIRED`).
  - HMAC raw bytes & dedupe tests: PASS — Ký và xác thực chữ ký trên byte thô UTF-8 chính xác: `HMAC-SHA256(secret, timestamp + "." + raw_body_bytes)` với so sánh thời gian bất biến `crypto.timingSafeEqual`. Reserialize JSON (thay đổi khoảng trắng, định dạng) dẫn đến sai lệch HMAC. Từ chối độ lệch đồng hồ `> 300s`. `WebhookDeduplicator` loại bỏ sự kiện trùng lặp theo `event_id` trong cửa sổ 7 ngày và loại bỏ sự kiện cũ có `state_version <= latest_state_version`.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-04** (`Stream A+C / Phase P4`) hoàn thiện trọn vẹn kiến trúc Webhook có chữ ký mật mã, mô hình Transactional Outbox, chống SSRF, bắt tay thử thách, xoay vòng khóa và cơ chế thử lại có chặn theo đúng đặc tả tại [docs/API.md](../../docs/API.md), [docs/SECURITY.md](../../docs/SECURITY.md) và [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md):

1. **Vòng đời Webhook Endpoint, Mã hóa Bí mật & Phòng vệ SSRF:**
   - **Đăng ký (`POST /v1/webhook-endpoints`):**
     - Tiếp nhận URL và danh sách sự kiện cần đăng ký (`job.succeeded`, `job.failed`, `job.canceled`, `*`).
     - Kiểm tra SSRF nghiêm ngặt: chuẩn hóa WHATWG URL, yêu cầu giao thức `https:`, cổng chuẩn 443 (chỉ cho phép cổng khác hoặc loopback khi bật cờ test nội bộ), cấm thông tin định danh `user:pass`, cấm fragment `#anchor`, cấm địa chỉ IP trực tiếp (IPv4/IPv6 literal), cấm dải địa chỉ riêng tư (RFC 1918, RFC 6598, loopback 127.0.0.0/8), cấm địa chỉ liên kết cục bộ và cloud metadata `169.254.169.254`.
     - Phân giải DNS trước và kiểm tra danh sách IP cấm (`resolveAndAuditHostDns`). Khi kết nối HTTP, sử dụng kết nối ghim IP (pinned IP) kèm kiểm tra TLS SNI hostname để triệt tiêu hoàn toàn tấn công DNS Rebinding / Time-of-Check to Time-of-Use (TOCTOU).
     - Khóa bí mật signing secret (`whsec_<32 hex bytes>`) được sinh bằng `crypto.randomBytes(32)` và chỉ hiển thị duy nhất 1 lần trong phản hồi 201 Created. Khi lưu vào cơ sở dữ liệu, secret được mã hóa đối xứng `AES-256-GCM` bằng khóa chính (`masterKey`), lưu dưới dạng `enc:v1:<iv>:<tag>:<ciphertext>`.
     - Yêu cầu lặp lại cùng `Idempotency-Key` trả lại bản ghi với `secret_redacted: true`, không bao giờ lưu trữ secret dạng thô trong bảng `idempotency_records`.
   - **Bảo vệ chống rò rỉ IDOR (`GET /v1/webhook-endpoints/{id}`):**
     - Trả về thông tin trạng thái (`pending_verification`, `active`, `disabled`), danh sách sự kiện lọc, active key ID và bảng tổng kết số lượng deliveries theo trạng thái (`delivered`, `failed`, `dead_letter`, `queued`).
     - Tuyệt đối không bao giờ trả về trường `signing_secret`.
     - Tenant B khi truy cập endpoint của Tenant A luôn nhận về HTTP `404 NOT_FOUND` (không bao giờ trả 403, không làm rò rỉ sự tồn tại của endpoint).

2. **Bắt tay thử thách (`Challenge Echo Handshake`):**
   - **Xác thực quyền sở hữu (`POST /v1/webhook-endpoints/{id}/verify`):**
     - Endpoint mới tạo ở trạng thái `pending_verification` và không nhận bất kỳ sự kiện công việc nào.
     - API sinh mã thử thách ngẫu nhiên 32 byte (`challenge_token`), lưu băm SHA-256 kèm thời hạn sống 10 phút (`challenge_expires_at = now + 10min`).
     - Gửi sự kiện hệ thống `endpoint.challenge` tới URL của webhook kèm chữ ký HMAC-SHA256 đầy đủ trong header `X-CVE-Signature`.
     - Phía máy chủ nhận (receiver) phải kiểm tra chữ ký HMAC và phản hồi HTTP 200/202 với thân JSON `{ "challenge": "<exact received value>" }` trong thời gian tối đa `<= 5s`.
     - Khi phản hồi echo khớp chính xác mã thử thách, endpoint được kích hoạt (`state = 'active'`). Nếu phản hồi sai, giả mạo hoặc quá thời gian, endpoint vẫn ở `pending_verification`.
     - Hỗ trợ xác nhận trực tiếp bằng token trong thân yêu cầu phục vụ tích hợp thủ công hoặc môi trường kiểm thử.

3. **Xoay vòng khóa bí mật (`Secret Rotation & Dual-Key Grace Period`):**
   - **Quy trình xoay vòng (`POST /v1/webhook-endpoints/{id}/rotate-secret`):**
     - Sinh khóa bí mật mới và cấp phát `active_key_id` mới (`whk_2`, `whk_3`...).
     - Khóa bí mật cũ được chuyển sang `prev_key_id` và mã hóa lưu vào `prev_secret_ciphertext`, cấp thời gian ân hạn đúng 24 giờ (`prev_secret_expires_at = now + 24h`).
     - Thư viện xác thực receiver `verifyWebhookSignature` tự động kiểm tra chữ ký dựa trên `X-CVE-Key-Id`: nếu trùng `active_key_id` sẽ dùng khóa hiện tại; nếu trùng `prev_key_id` và chưa quá hạn 24 giờ sẽ dùng khóa cũ. Nhờ đó, khách hàng có thể cập nhật cấu hình mà không gây gián đoạn tiếp nhận webhook.

4. **Mô hình Transactional Outbox & Chống mất mát sự kiện ("Outage Không Mất Event/Job"):**
   - **Transactional Outbox (`outbox` table):**
     - Mọi thay đổi trạng thái công việc (`job.succeeded`, `job.failed`, `job.canceled`) đều được ghi nguyên tử cùng một transaction cơ sở dữ liệu với bản ghi công việc vào bảng `outbox`.
     - `WebhookDeliveryService.processOutbox()` định kỳ quét các bản ghi `outbox` chưa xử lý (`processed_at IS NULL`), tìm các webhook endpoint đang `active` của tenant có đăng ký loại sự kiện tương ứng, tạo bản ghi `webhook_deliveries` với trạng thái `queued` và cập nhật `processed_at` cho `outbox`.
     - Khi hạ tầng receiver bị mất điện, sập mạng hoặc trả về HTTP 503 / 5xx, bản ghi `webhook_deliveries` được cập nhật `last_http_status = 503`, tăng số lần thử và lên lịch thử lại tiếp theo (`next_attempt_at`), nhưng vẫn giữ nguyên trạng thái `queued`. Sự kiện tuyệt đối không bị mất. Khi receiver phục hồi, đợt phân phối tiếp theo sẽ gửi thành công và chuyển trạng thái sang `delivered`.

5. **Cơ chế Thử Lại Có Chặn (`Bounded SSRF-Safe Retries`):**
   - **Lịch 8 lần thử chuẩn:**
     - Lịch chờ chuẩn gồm 8 lần thử: `[0, 60s, 300s, 900s, 3600s, 14400s, 43200s, 86400s]` (+jitter ngẫu nhiên `<= 10%`).
     - Tôn trọng header `Retry-After` (dạng giây nguyên) từ máy chủ nhận.
     - **Hard deadline clamp (25 giờ):** Mọi độ trễ tính toán, jitter và giá trị `Retry-After` đều được clamp sao cho `next_attempt_at <= deadline_at` (với `deadline_at = created_at + 25h`). Nếu thời gian hiện tại đã vượt quá 25 giờ (`nowMs > deadlineMs`), lần thử lập tức bị hủy và đánh dấu `failed` với lỗi `Delivery deadline (25h) exceeded`.
     - Sau lần thử thứ 8, nếu vẫn không thành công, trạng thái chuyển sang `failed`.
   - **Xử lý mã trạng thái HTTP đặc thù:**
     - **HTTP 410 Gone:** Máy chủ nhận thông báo endpoint đã bị xóa/hủy vĩnh viễn; dịch vụ lập tức vô hiệu hóa endpoint (`state = 'disabled'`) và chuyển delivery sang `dead_letter`.
     - **HTTP 3xx (Redirects):** Nghiêm cấm tuyệt đối việc chuyển hướng (chống SSRF chuyển hướng vào mạng nội bộ); chuyển ngay delivery sang `dead_letter` mà không follow.
     - **HTTP 4xx (400, 401, 403, 404, 422):** Các lỗi client không thể tự phục hồi được chuyển ngay sang `dead_letter`.
     - **HTTP 429 & HTTP 5xx / Network Errors:** Được phân loại là lỗi tạm thời (`retryable`), lên lịch thử lại theo backoff.
   - **Xóa endpoint (`DELETE /v1/webhook-endpoints/{id}`):**
     - Đánh dấu `disabled` endpoint. Khi tiến trình gửi quét thấy endpoint đã bị vô hiệu hóa hoặc xóa, delivery lập tức chuyển sang `dead_letter` mà không thực hiện yêu cầu HTTP ("Endpoint bị xóa thì không gửi tiếp").

6. **Truy vấn Lịch sử & Phát Lại Sự Kiện (`Replay API`):**
   - **Danh sách deliveries (`GET /v1/webhook-deliveries`):**
     - Cho phép lọc theo `job_id`, `endpoint_id`, `state`, hỗ trợ phân trang chuẩn, cô lập tenant triệt để.
   - **Phát lại (`POST /v1/webhook-deliveries/{id}/replay`):**
     - Đưa delivery trở lại hàng đợi `queued` với số lần thử được reset về 0 và thời hạn mới.
     - Bảo toàn tuyệt đối `outbox_event_id` ban đầu, giúp receiver nhận đúng ID sự kiện để thực hiện đối chiếu/khử trùng lặp.
     - Giới hạn hạn ngạch phát lại: tối đa 5 lần mỗi ngày trên mỗi delivery (`replay_count_today < 5`); nếu vượt quá trả về HTTP `429 QUOTA_EXCEEDED` kèm `Retry-After`. Bộ đếm tự động reset khi bước sang ngày dương lịch mới (UTC).
     - Giới hạn thời gian lưu trữ: chỉ cho phép phát lại trong vòng 7 ngày kể từ khi tạo sự kiện (`WEBHOOK_REPLAY_RETENTION_MS = 7 * 86400 * 1000`); quá 7 ngày trả về HTTP `410 DELIVERY_EXPIRED` hướng dẫn client đối chiếu trạng thái qua `GET /v1/jobs/{id}`.

7. **Kiểm định Chữ ký HMAC Trên Byte Thô & Khử Trùng Lặp Sự Kiện:**
   - **Chữ ký HMAC-SHA256 trên byte thô:**
     - Chữ ký được tính toán theo công thức: `HMAC-SHA256(secret, timestamp + "." + raw_body_bytes)` với timestamp dạng chuỗi số nguyên giây và body là mảng byte UTF-8 thô nguyên bản.
     - Kiểm tra tính bất biến: nếu receiver deserialize rồi reserialize lại chuỗi JSON (dẫn đến thay đổi khoảng trắng hoặc thứ tự thuộc tính), chữ ký HMAC sẽ không khớp. Phải luôn xác thực trên buffer byte thô ban đầu trước khi parse JSON.
     - Sử dụng hàm `crypto.timingSafeEqual` để ngăn chặn hoàn toàn tấn công kênh phụ đo thời gian (timing attacks).
     - Kiểm tra độ lệch đồng hồ: từ chối mọi yêu cầu có `Math.abs(nowSeconds - timestamp) > 300` (`MAX_CLOCK_SKEW_SECONDS = 300`).
   - **Khử trùng lặp và loại bỏ sự kiện cũ (`WebhookDeduplicator`):**
     - Duy trì bộ nhớ đệm các `event_id` đã nhận trong cửa sổ 7 ngày; từ chối xử lý lại các sự kiện trùng lặp (`duplicate_event`).
     - Theo dõi `state_version` cao nhất theo từng `job_id`; nếu nhận được sự kiện có `state_version <= latest_state_version`, sự kiện sẽ bị bỏ qua (`stale_event`), giải quyết triệt để vấn đề mạng phân phối không đảm bảo thứ tự.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `./node_modules/.bin/tsc -p packages/api/tsconfig.json` | `0` | `PASS` | Biên dịch TypeScript package `@creativanta/api` thành công xuất sắc |
| 2 | `./node_modules/.bin/tsc -p packages/api/tsconfig.json --noEmit` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript không có bất kỳ lỗi nào |
| 3 | `node --test packages/api/test/p4-04-signed-webhooks.test.mjs` | `0` | `PASS` | Toàn bộ 21/21 tests trong 8 suites của P4-04 đạt 100% (thời gian chạy ~0.7s) |
| 4 | `node --test packages/api/test/p4-01-admission-and-quotas.test.mjs` | `0` | `PASS` | Toàn bộ 11/11 tests của nhiệm vụ P4-01 đạt 100%, không bị ảnh hưởng phụ |
| 5 | `node --test packages/api/test/server.test.mjs` | `0` | `PASS` | Toàn bộ 7/7 tests server capabilities, healthz, readyz đạt 100% |
| 6 | `node --test packages/api/test/p4-03-cancel-timeout-retry-reaper-races.test.mjs` | `0` | `PASS` | Toàn bộ 7/7 tests của nhiệm vụ P4-03 (races/kill/reaper) đạt 100% |
| 7 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận môi trường phát triển, API endpoints, capabilities và adapters |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn diện 16 tài liệu chuẩn, 42 tệp markdown, 606 liên kết, 32 tệp JSON, đồ thị phụ thuộc DAG không chu trình, 0 lỗi, 0 cảnh báo |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p4-04` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P4-04`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P4-04` hoàn tất, nhiệm vụ `P4-05` (Usage ledger / reserve / settle / release / billable vs operational) và `P4-07` (G3 two-tenant E2E integration test suite) sẵn sàng triển khai theo đúng kế hoạch triển khai [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md).
