# Báo cáo bằng chứng nghiệm thu nhiệm vụ P5-04

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P5-04` (`A+D / P5` — API Integration Guide, Typed SDK Client Examples & v1 Compatibility Tests): Hoàn thành tài liệu hướng dẫn tích hợp toàn diện [API Integration Guide](api-integration-guide.md) và [packages/sdk/README.md](../../packages/sdk/README.md); phát triển bộ ví dụ định kiểu mẫu (`typed client example`) bao quát toàn bộ quy trình đầu-cuối từ kiểm tra capabilities, nạp asset, khởi tạo template, gửi render-job với Idempotency-Key và externalReference, nhận webhook HMAC, đối soát polling 2s->10s, đến tải video và xác thực tính toàn vẹn SHA-256; phát triển bộ công thức xử lý lỗi và thử lại tự động (`error/retry examples`) cho 409 IN_PROGRESS, 429 RATE_LIMITED, 503 SERVICE_UNAVAILABLE, 410 GRANT_EXPIRED, 422 VALIDATION_FAILED, 409 JOB_TERMINAL và hủy bỏ qua AbortSignal; xây dựng bộ kiểm thử tính tương thích hợp đồng giao thức v1 (`v1 compatibility tests`) 15/15 bài kiểm thử; mở rộng bộ mô phỏng hợp đồng `CreativantaContractMock` và toàn bộ 102/102 bài kiểm thử trong `@creativanta/sdk` đều đạt kết quả PASS với nguyên tắc bảo mật **mọi thông tin ủy nhiệm (credentials) đều là placeholders** theo đúng đặc tả tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P5-04
Base / tested commit: 19ce9d282e90efd64362a9981809c9d6a2f7154d / HEAD (agy/p5-04)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: ./node_modules/.bin/tsc -p packages/sdk/tsconfig.json && ./node_modules/.bin/tsc -p packages/templates/tsconfig.json && node packages/sdk/scripts/run-client-examples.mjs && node --test packages/sdk/test/v1-compatibility.test.mjs && node --test packages/sdk/test/error-and-retry-examples.test.mjs && node --test packages/sdk/test/**/*.test.mjs && node --test packages/templates/test/**/*.test.mjs && node scripts/health-check.mjs && python3 scripts/validate_repo.py && python3 -m unittest discover -s tooling/agent_harness/tests -v
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-04T03:47:00Z / 35.8s
Artifacts:
  - packages/sdk/package.json, sha256=5c51c72afff147c22d005f2b687cdfc08cf898007bcee3c1dd35e7aea0f52d9c, expires=N/A (repo-versioned)
  - packages/sdk/src/index.ts, sha256=4694428cabb70e93c202a6c148e851b2c66d465e4fcf591504f00bea59770f7f, expires=N/A (repo-versioned)
  - packages/sdk/src/client/types.ts, sha256=d4eda507415e059ab114e3539805e2c325692a0acbe294790dd625d7dde07240, expires=N/A (repo-versioned)
  - packages/sdk/src/client/errors.ts, sha256=a16e2a552438e65a40988c3527cd88aaad4e40972327d1eab7ad4a4c13ff03a1, expires=N/A (repo-versioned)
  - packages/sdk/src/client/http-transport.ts, sha256=caf742390fa44335024b718bb6248298683b61d2b40e1c6e0d89a9483d4a3133, expires=N/A (repo-versioned)
  - packages/sdk/src/client/creativanta-client.ts, sha256=d686d961817e2ea9143fc4235b5147eda14310d9c092fc6bc6f0fbe557848c39, expires=N/A (repo-versioned)
  - packages/sdk/src/client/webhook-receiver.ts, sha256=a011f91591beeed50b6baf608b967d05f706750163c270c782f4d87eee859a5a, expires=N/A (repo-versioned)
  - packages/sdk/src/client/reconciliation-manager.ts, sha256=bf99301d7cc2a7aa0b2fad4a7f2b9e31bf199da4a003fb73d5c33d46c2713524, expires=N/A (repo-versioned)
  - packages/sdk/src/client/contract-mock.ts, sha256=e8ef92a857746a0336fe05c126346424a51ba4f7318a1b29d7bc314124873948, expires=N/A (repo-versioned)
  - packages/sdk/src/examples/typed-client.ts, sha256=05433db3eddfd8e7a3a3fd2c65b4110ab1da3d991e5812d62cbac30253eb7879, expires=N/A (repo-versioned)
  - packages/sdk/src/examples/error-and-retry.ts, sha256=030ebe34b363b257bbd391034da402d1e745cc7d1fe0264d06341d01c0f32046, expires=N/A (repo-versioned)
  - packages/sdk/src/examples/index.ts, sha256=39f5bfdd9882dcbfdda686957f844bba412b3526d12fd1f261dad17bf9b2d2fa, expires=N/A (repo-versioned)
  - packages/sdk/scripts/run-client-examples.mjs, sha256=a23c620289b275e00ae8171ad7e7df3067aab54431aa92d7edf52267da8e4d34, expires=N/A (repo-versioned)
  - packages/sdk/docs/API_INTEGRATION_GUIDE.md, sha256=de72f0f6f6a5b4e78f3f9d2a72b23fef85684c79d91251e790698627e0db53e7, expires=N/A (repo-versioned)
  - packages/sdk/README.md, sha256=966999d50a7d1727761310bbe5dda06cae241ea01527ca8b3c74ca5c323f64e2, expires=N/A (repo-versioned)
  - packages/sdk/test/v1-compatibility.test.mjs, sha256=581310ad662735082012baeee06b506a234d99665993aef1be6d44cf0a4a74cc, expires=N/A (repo-versioned)
  - packages/sdk/test/error-and-retry-examples.test.mjs, sha256=67f019d963299790c668f39aa09929cac70311b7b3667900c32a4efb47649ad3, expires=N/A (repo-versioned)
  - evidence/P5-04/api-integration-guide.md, sha256=de72f0f6f6a5b4e78f3f9d2a72b23fef85684c79d91251e790698627e0db53e7, expires=N/A (repo-versioned)
Acceptance mapping:
  - API integration guide: PASS — Hoàn thành tài liệu tích hợp toàn diện [API Integration Guide](api-integration-guide.md) và packages/sdk/docs/API_INTEGRATION_GUIDE.md; mô tả ranh giới zero-shared-DB, xác thực Bearer token, cấu trúc tiêu đề Idempotency-Key và chuẩn hóa JCS RFC 8785, danh mục 18 endpoint v1, chữ ký webhook HMAC-SHA256 timingSafeEqual, cơ chế đối soát trạng thái lùi số nhân 2s->10s, máy trạng thái hủy tác vụ, tự động làm mới grant tải hết hạn (TTL <= 5min), và bảng tra cứu mã lỗi chuẩn.
  - generated SDK hoặc typed client example: PASS — Phát triển bộ SDK định kiểu mở rộng trên CreativantaClient hỗ trợ toàn diện các phương thức API v1 (capabilities, compositions, templates, assets, jobs, webhooks, usage); cung cấp ví dụ mẫu có thể chạy được (runnable) packages/sdk/src/examples/typed-client.ts và runner packages/sdk/scripts/run-client-examples.mjs kiểm chứng thành công luồng E2E thực tế.
  - v1 compatibility tests: PASS — Xây dựng bộ kiểm thử tương thích wire contract v1 tại packages/sdk/test/v1-compatibility.test.mjs (15/15 bài kiểm thử) bao quát định dạng JSON Schema, trường additive resilience, kiểm tra xung đột revision lạc hậu 409 REVISION_CONFLICT, mã phản hồi tiếp nhận 202 Accepted, Location, Retry-After, Idempotency-Replayed, xung đột 409 IDEMPOTENCY_CONFLICT, máy trạng thái hủy tác vụ (202 -> 200 -> 409 JOB_TERMINAL), bảo mật bí mật webhook (không leak trong GET), và phân định số liệu sử dụng operational vs billable.
  - error/retry examples: PASS — Xây dựng bộ công thức mẫu packages/sdk/src/examples/error-and-retry.ts và bộ kiểm thử chuyên sâu packages/sdk/test/error-and-retry-examples.test.mjs (19/19 bài kiểm thử) chứng minh khả năng tự động phục hồi khi gặp 409 IDEMPOTENCY_IN_PROGRESS (chờ Retry-After và giữ nguyên Idempotency-Key), 429 RATE_LIMITED (lùi số nhân kèm jitter và giữ nguyên key per docs/API.md line 10 & 167), 503 SERVICE_UNAVAILABLE, 410 GRANT_EXPIRED (tự lấy URL mới không rerender), phân loại các lỗi định kiểu không thử lại (400, 401, 403, 404, 409, 413, 422), xử lý AbortSignal và từ chối chữ ký webhook giả mạo/lệch giờ.
  - credentials chỉ placeholders: PASS — Kiểm toán tĩnh 100% mã nguồn ví dụ, tài liệu hướng dẫn, và bộ kiểm thử chứng minh chỉ sử dụng định danh giữ chỗ hợp lệ (ví dụ cve_live_placeholder_key_000000000000000000000000, whsec_placeholder_secret_000000000000000000000000, https://video.example.invalid/v1); không chứa bất kỳ secret, private key, hay token thật nào.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD (agy/p5-04) / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P5-04** (`A+D / P5`) hiện thực hóa tài liệu hướng dẫn tích hợp chuẩn tắc, bộ thư viện SDK định kiểu, các ví dụ mẫu tích hợp, bộ kịch bản xử lý lỗi/thử lại tự động, và bộ kiểm thử độ tương thích hợp đồng mạng REST API v1 cho Creativanta:

1. **Tài liệu Hướng dẫn Tích hợp API ([packages/sdk/docs/API_INTEGRATION_GUIDE.md](../../packages/sdk/docs/API_INTEGRATION_GUIDE.md) & [api-integration-guide.md](api-integration-guide.md)):**
   - Hướng dẫn chi tiết nguyên tắc ranh giới hệ thống: zero shared database assumptions, kiến trúc bất đồng bộ (asynchronous job model), và rào chắn an toàn idempotency.
   - Đặc tả quy chuẩn tiêu đề xác thực Bearer token, phạm vi quyền hạn (scopes).
   - Hướng dẫn tính toán canonical request hash theo RFC 8785 (JCS) với Unicode NFC và sắp xếp khóa từ điển.
   - Bảng tổng hợp chi tiết 18 endpoint chính của REST API v1.
   - Quy trình xác thực Webhook ký số HMAC-SHA256 trên chuỗi byte thô `timestamp + '.' + raw_body_bytes`, so sánh an toàn `timingSafeEqual`, chặn lệch giờ > 300s, khử trùng 7 ngày và bảo vệ đơn điệu `monotonic state_version`.
   - Cơ chế polling reconciliation lùi số nhân từ 2s lên 10s (tuân thủ docs/API.md dòng 139).
   - Cơ chế làm mới link tải ngắn hạn (TTL <= 5 phút) mà không phải kết xuất lại video khi gặp HTTP 410 GRANT_EXPIRED.
   - Bảng phân loại mã lỗi HTTP và hành vi ứng xử tương ứng của client.

2. **Bộ Khách hàng SDK Định kiểu Toàn diện ([packages/sdk/src/client/creativanta-client.ts](../../packages/sdk/src/client/creativanta-client.ts)):**
   - Mở rộng lớp `CreativantaClient` cung cấp đầy đủ các phương thức định kiểu:
     - `getCapabilities()`: Đọc profile, engine và giới hạn hệ thống.
     - `validateComposition(options)`: Kiểm tra spec trước khi dựng hình.
     - `createComposition(options)` / `getComposition(id)` / `createCompositionRevision(id, options)`: Quản lý composition với concurrency lock qua `base_revision`.
     - `listTemplates(query)` / `getTemplateRevision(id, rev)` / `createTemplate(options)` / `instantiateTemplate(id, options)`: Tra cứu và khởi tạo mẫu.
     - `initiateAssetUpload(options)` / `completeAssetUpload(id, sha)` / `deleteAsset(id)`: Quản lý vòng đời tải media lên vùng cách ly quarantine.
     - `createRenderJob(options)` / `createPreviewJob(options)`: Đăng ký tác vụ dựng hình kèm `Idempotency-Key` và `externalReference`.
     - `listJobs(query)` / `getJob(id)` / `getJobEvents(id)`: Theo dõi tiến độ tác vụ.
     - `cancelJob(id, options)`: Hủy tác vụ an toàn theo máy trạng thái (202 / 200 / 409).
     - `getArtifactDownloadGrant(id)` / `refreshDownloadGrant(id)` / `downloadArtifact(id, options)`: Tự động phục hồi grant tải hết hạn và kiểm tra toàn vẹn byte count/SHA-256.
     - `registerWebhookEndpoint(options)` / `verifyWebhookEndpoint(id, challenge)` / `getWebhookEndpoint(id)` / `rotateWebhookEndpointSecret(id)` / `deleteWebhookEndpoint(id)`: Quản lý webhook endpoint với cơ chế bảo vệ bí mật (secret không bao giờ lộ trong GET).
     - `getUsage(query)`: Đọc báo cáo sử dụng đo lường chi phí operational và billable.

3. **Ví dụ Mẫu Định kiểu & Runner Chương trình ([packages/sdk/src/examples/](../../packages/sdk/src/examples/)):**
   - File `packages/sdk/src/examples/typed-client.ts`: Hiện thực hóa quy trình tích hợp mẫu từ đầu đến cuối (E2E) sử dụng SDK, từ tra cứu capabilities, nạp asset, khởi tạo template, gửi render job, nhận webhook có chữ ký số, đối soát trạng thái polling, đến tải video kết quả.
   - File `packages/sdk/src/examples/error-and-retry.ts`: Cung cấp 7 công thức xử lý lỗi chuẩn cho các kỹ sư Creativanta:
     1. Tự động thử lại khi gặp `409 IDEMPOTENCY_IN_PROGRESS` theo `Retry-After: 1` với cùng khóa `Idempotency-Key`.
     2. Tự động thử lại khi gặp `429 RATE_LIMITED` hoặc `503 SERVICE_UNAVAILABLE` với lùi số nhân kèm jitter ngẫu nhiên và bảo toàn khóa `Idempotency-Key`.
     3. Tự động khôi phục khi gặp `410 GRANT_EXPIRED` bằng cách cấp grant mới mà không rerender video.
     4. Bắt và phân tích lỗi `422 VALIDATION_FAILED` định kiểu `ValidationError` với mảng `details[]` (JSON Pointer và mã lỗi chi tiết).
     5. Bắt lỗi `409 JOB_TERMINAL` định kiểu `JobTerminalError` khi cố gắng hủy tác vụ đã hoàn tất hoặc thất bại.
     6. Hủy tác vụ đang chạy trên mạng bằng tiêu chuẩn `AbortController` / `AbortSignal`.
     7. Chặn đứng các cuộc tấn công webhook: chữ ký giả mạo (`401 INVALID_SIGNATURE`), lệch giờ clock skew > 300s (`400 CLOCK_SKEW_EXCEEDED`), và sự kiện trễ out-of-order có `state_version` thấp hơn.
   - Runner `packages/sdk/scripts/run-client-examples.mjs`: Kịch bản Node thực thi trực tiếp cả hai bộ ví dụ mẫu với máy chủ mô phỏng hợp đồng `CreativantaContractMock` cục bộ, xác nhận 100% các bước vận hành thành công.

4. **Bộ Kiểm thử Tương thích Wire Giao thức v1 ([packages/sdk/test/v1-compatibility.test.mjs](../../packages/sdk/test/v1-compatibility.test.mjs)):**
   - 15 bài kiểm thử xác thực cấu trúc dữ liệu theo đúng chuẩn [docs/API.md](../../docs/API.md).
   - Kiểm tra khả năng tương thích tiến (additive resilience): Client bỏ qua các trường mới chưa công bố trong response mà không bị crash.
   - Cưỡng chế quy tắc phân định lỗi: tài nguyên không tồn tại trên URL trả 404, tham chiếu sai trong JSON body trả 422, xung đột revision trả 409 REVISION_CONFLICT.

5. **Bộ Kiểm thử Chuyên sâu Xử lý Lỗi và Thử lại ([packages/sdk/test/error-and-retry-examples.test.mjs](../../packages/sdk/test/error-and-retry-examples.test.mjs)):**
   - 19 bài kiểm thử bao quát toàn diện các trường hợp lỗi quá độ, lỗi kiên định, timeout, và cạn kiệt số lần thử lại tối đa (`maxRetries`).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `./node_modules/.bin/tsc -p packages/sdk/tsconfig.json` | 0 | PASS | Biên dịch TypeScript sạch sẽ cho `@creativanta/sdk` bao gồm cả module examples |
| 2 | `./node_modules/.bin/tsc -p packages/templates/tsconfig.json` | 0 | PASS | Biên dịch TypeScript sạch sẽ cho `@creativanta/templates` |
| 3 | `node packages/sdk/scripts/run-client-examples.mjs` | 0 | PASS | Chạy thực tế bộ ví dụ mẫu typed-client và 7 kịch bản error-and-retry với CreativantaContractMock |
| 4 | `node --test packages/sdk/test/v1-compatibility.test.mjs` | 0 | PASS (15/15 tests) | Kiểm tra tính tương thích wire contract v1, capabilities, compositions, templates, assets, idempotency, cancel state machine, webhooks, usage |
| 5 | `node --test packages/sdk/test/error-and-retry-examples.test.mjs` | 0 | PASS (19/19 tests) | Kiểm tra xử lý lỗi tự động thử lại 409 IN_PROGRESS, 429, 503, phục hồi 410 GRANT_EXPIRED, 422 VALIDATION_FAILED, AbortSignal, webhook security |
| 6 | `node --test packages/sdk/test/creativanta-*.test.mjs` | 0 | PASS (32/32 tests) | Toàn bộ 32 bài kiểm thử hợp đồng mock/client P5-03 tiếp tục vượt qua 100% |
| 7 | `node --test packages/sdk/test/**/*.test.mjs` | 0 | PASS (102/102 tests) | Toàn bộ 102 bài kiểm thử trong `@creativanta/sdk` (25 TTS, 11 brand-tokens, 32 P5-03, 34 P5-04) đều đạt kết quả PASS |
| 8 | `node --test packages/templates/test/**/*.test.mjs` | 0 | PASS (17/17 tests) | Toàn bộ 17 bài kiểm thử mẫu video trong `@creativanta/templates` đạt kết quả PASS |
| 9 | `node scripts/health-check.mjs` | 0 | PASS | Kiểm tra cấu hình môi trường, endpoints `/healthz`, `/readyz`, và năng lực hệ thống |
| 10 | `python3 scripts/validate_repo.py` | 0 | PASS | Kiểm tra tính hợp lệ toàn repo: 16 tài liệu, 49 markdown, 682 internal links, 35 JSON files, 0 lỗi, đồ thị phụ thuộc acyclic |
| 11 | `python3 -m unittest discover -s tooling/agent_harness/tests -v` | 0 | PASS (10/10 tests) | Toàn bộ 10 bài kiểm thử vòng đời supervisor và quy chế quản lý nhiệm vụ đều đạt kết quả PASS |

---

## 3. Bản đồ Nghiệm thu Tiêu chí Chấp thuận (Acceptance Criteria Mapping)

| Tiêu chí Nghiệm thu | Hiện thực hóa kỹ thuật | Bằng chứng kiểm thử | Trạng thái |
|---|---|---|---|
| **API integration guide** | Tài liệu hướng dẫn tích hợp chuẩn [packages/sdk/docs/API_INTEGRATION_GUIDE.md](../../packages/sdk/docs/API_INTEGRATION_GUIDE.md) và [api-integration-guide.md](api-integration-guide.md) bao quát: zero shared DB, Bearer auth, RFC 8785 JCS Idempotency-Key, catalog 18 endpoint, Webhook HMAC-SHA256, polling backoff 2s->10s, download-expiry refresh, bảng mã lỗi chuẩn. | Kiểm tra cấu trúc `validate_repo.py` xác thực định dạng Markdown, đơn tiêu đề H1, code fence cân bằng, không gãy liên kết nội bộ (682 links). | **PASS** |
| **Generated SDK hoặc typed client example** | Mở rộng `CreativantaClient` thành typed client hoàn chỉnh; xây dựng kịch bản mẫu có thể chạy được [packages/sdk/src/examples/typed-client.ts](../../packages/sdk/src/examples/typed-client.ts) và runner [packages/sdk/scripts/run-client-examples.mjs](../../packages/sdk/scripts/run-client-examples.mjs). | Thực thi thực tế qua `node packages/sdk/scripts/run-client-examples.mjs` đạt exit code 0; tải thành công video 41 bytes và xác thực toàn bộ các bước. | **PASS** |
| **v1 compatibility tests** | Bộ kiểm thử [packages/sdk/test/v1-compatibility.test.mjs](../../packages/sdk/test/v1-compatibility.test.mjs) kiểm tra toàn bộ định dạng wire response theo docs/API.md: Capabilities (`mp4-720p-v1`, `preview-360p-v1`), Template catalog & instantiate, Compositions & 409 REVISION_CONFLICT, Asset upload & delete 202, Job 202 Location Retry-After, Idempotent replay `isReplayed: true`, 409 IDEMPOTENCY_CONFLICT, Cancel state machine (202 -> 200 -> 409 JOB_TERMINAL), Webhook secret redaction trong GET, và Usage metrics. | 15/15 bài kiểm thử tương thích wire contract vượt qua 100%. | **PASS** |
| **error/retry examples** | Module [packages/sdk/src/examples/error-and-retry.ts](../../packages/sdk/src/examples/error-and-retry.ts) và bộ kiểm thử [packages/sdk/test/error-and-retry-examples.test.mjs](../../packages/sdk/test/error-and-retry-examples.test.mjs): xử lý tự động thử lại 409 IDEMPOTENCY_IN_PROGRESS, 429 RATE_LIMITED, 503 SERVICE_UNAVAILABLE với cùng khóa Idempotency-Key, tự động làm mới khi gặp 410 GRANT_EXPIRED, bắt lỗi định kiểu không thử lại (400, 401, 403, 404, 409, 413, 422), xử lý AbortController, và từ chối webhook giả mạo/lệch giờ. | 19/19 bài kiểm thử xử lý lỗi và thử lại đạt kết quả PASS; kiểm chứng thành công trong script runner. | **PASS** |
| **credentials chỉ placeholders** | Rà soát toàn bộ các tệp mã nguồn và tài liệu mới: chỉ sử dụng các chuỗi giữ chỗ mẫu chuẩn (`cve_live_placeholder_key_...`, `whsec_placeholder_secret_...`, `https://video.example.invalid/v1`). | Regex heuristic secret scan trong `python3 scripts/validate_repo.py` xác nhận 0 phát hiện bí mật rò rỉ. | **PASS** |

---

## 4. Giới hạn Kỹ thuật, Ranh giới An ninh & Nhiệm vụ Kế tiếp

1. **Ranh giới Môi trường:**
   - Toàn bộ các kiểm thử và ví dụ mẫu đều vận hành độc lập bên trong worktree `/workspace/repo/.worktrees/p5-04`.
   - Không can thiệp hay sửa đổi cơ sở mã Creativanta hiện hữu bên ngoài; mọi tương tác với Creativanta thật trong tương lai sẽ tuân theo hợp đồng đã được chứng minh qua bộ thư viện SDK này.
   - Không sử dụng mô hình AI-video trả phí, không sử dụng dịch vụ GPU bên ngoài, và không triển khai lên môi trường sản xuất trong phiên làm việc này.

2. **Cổng kiểm duyệt bên ngoài (External Gates):**
   - Đánh giá của kiểm toán viên độc lập và kiểm chứng luồng Staging CI workflow trên GitHub cho PR nhiệm vụ P5-04.
   - Cổng phê duyệt pháp lý/an ninh thông tin trước khi cấp phát khóa API sản xuất cho người dùng bên ngoài.

3. **Nhiệm vụ Tiếp theo trong Kế hoạch:**
   - `P5-05` (`D+C / P5`): Ma trận kiểm thử hồi quy đa ngôn ngữ/phông chữ/âm thanh (`Locale/font/audio regression matrix`), quy trình phụ đề sidecar/burn-in và kiểm soát bản quyền nội dung.
