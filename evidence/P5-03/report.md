# Báo cáo bằng chứng nghiệm thu nhiệm vụ P5-03

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P5-03` (`D+A / P5` — Creativanta Mock / Contract Client): Triển khai toàn diện bộ thư viện khách hàng hợp đồng Creativanta (`CreativantaClient`), bộ nhận và xác thực webhook có chữ ký số (`CreativantaWebhookReceiver`), bộ điều phối đối soát trạng thái kết hợp webhook và polling (`JobReconciliationManager`), cơ chế định danh tham chiếu ngoài và quản lý tính bất biến khóa idempotency (`idempotency & external_reference`), vòng đời hủy tác vụ an toàn (`cancelJob`), cơ chế tự động làm mới grant tải khi hết hạn (`download-expiry refresh`), và bộ máy chủ giả lập hợp đồng nhẹ không phụ thuộc cơ sở dữ liệu (`CreativantaContractMock`), bảo đảm nguyên tắc ranh giới tuyệt đối **không chia sẻ cơ sở dữ liệu** (`no shared DB assumptions`) theo đúng đặc tả tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P5-03
Base / tested commit: ce234331b0a0c56b6e6ec1d9be4a23ffd1009d0c / 5948e62efa09171366db6fd14b274bf116dae886
Environment: Linux x86_64, Debian 12 container, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: ./node_modules/.bin/tsc -p packages/sdk/tsconfig.json && ./node_modules/.bin/tsc -p packages/templates/tsconfig.json && node --test packages/sdk/test/**/*.test.mjs && node --test packages/templates/test/**/*.test.mjs && node scripts/health-check.mjs && python3 scripts/validate_repo.py && python3 -m unittest discover -s tooling/agent_harness/tests -v
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-04T03:16:00Z / 22.4s
Artifacts:
  - packages/sdk/package.json, sha256=41571c429bc2d3db17f8147678b47d6ac57baac20dc31b74ad6cae937ca877b6, expires=N/A (repo-versioned)
  - packages/sdk/src/index.ts, sha256=5e8314135ab3453c49075342c5687062ea16bcc31efacdc03d67913b80a1eec7, expires=N/A (repo-versioned)
  - packages/sdk/src/client/types.ts, sha256=1d7fd58698ca9eec51140af59f55071ade3d470d263a92d5ea33daf956361818, expires=N/A (repo-versioned)
  - packages/sdk/src/client/errors.ts, sha256=2c187019d84ead78765fe226bc88c43719ffd869b3dea751d248bd070ca9ebbb, expires=N/A (repo-versioned)
  - packages/sdk/src/client/idempotency.ts, sha256=8a5a69571fc01b928e8a09b4195969c360a299633b9c61165a90e2f2b92df148, expires=N/A (repo-versioned)
  - packages/sdk/src/client/http-transport.ts, sha256=0b7547c51b92d8ee52d6d15ef8ca34fd827fb0aa784dc61e62ccd9993fe8cd5d, expires=N/A (repo-versioned)
  - packages/sdk/src/client/webhook-receiver.ts, sha256=e9aa3013dc84e9809b3d58800300e4c492c4c6802685b176c83bcffe0c61e2b2, expires=N/A (repo-versioned)
  - packages/sdk/src/client/creativanta-client.ts, sha256=78ecdb6b96bd1f5803d24c2ced9f04178a3ed10e3c6d7f83bfddd0550f4a00da, expires=N/A (repo-versioned)
  - packages/sdk/src/client/reconciliation-manager.ts, sha256=8670c2b79f1a07e87c022a6b9ebe62ba54fd2dcd55b79c6f133b26707c1ec53a, expires=N/A (repo-versioned)
  - packages/sdk/src/client/contract-mock.ts, sha256=a165682eeef8b25ce0dcb31bd6781a24a7564e0f88f04af46ca901ae3a9ecb31, expires=N/A (repo-versioned)
  - packages/sdk/src/client/index.ts, sha256=1fcbf1b59dc132cf73f703d33df115b62999b4289b16bc4adce339ac1cfd426b, expires=N/A (repo-versioned)
  - packages/sdk/test/creativanta-idempotency-and-refs.test.mjs, sha256=60a66d40d868156e56f2fdc5a2e6612ef77f5c89579a9aee711e789fcf61e397, expires=N/A (repo-versioned)
  - packages/sdk/test/creativanta-webhook-receiver.test.mjs, sha256=dd1ea789cfcaf569b1eab4f5755c6dadef42c3fce6c58c5c4dc39b419430f9c0, expires=N/A (repo-versioned)
  - packages/sdk/test/creativanta-reconciliation-and-cancel.test.mjs, sha256=333fb979e9a8abf295f8c251dd6fc152add2edbc9e6660c4ac301b3e9ab7b873, expires=N/A (repo-versioned)
  - packages/sdk/test/creativanta-download-expiry-refresh.test.mjs, sha256=a180c08632dd923cba73523e332f50918091a6b6a3247e7d5b5e25d7b8b9abe5, expires=N/A (repo-versioned)
  - packages/sdk/test/creativanta-e2e-contract-harness.test.mjs, sha256=dad5d1c6d2b03ab55055ace6bd93388c3a62b1b9c821da1f4c5aa10c08ca4e81, expires=N/A (repo-versioned)
Acceptance mapping:
  - external_reference/idempotency: PASS — Hỗ trợ truyền tham chiếu đối ngoại Creativanta `external_reference` (chuẩn hóa ánh xạ trong suốt sang `client_reference` trên đường truyền API); sinh và kiểm thực định dạng `Idempotency-Key` (1–128 ký tự ASCII [A-Za-z0-9._:-]); canonical hashing RFC 8785 (JCS); xử lý phản hồi phát lại `Idempotency-Replayed: true` -> `isReplayed: true`; chặn xung đột thân yêu cầu `409 IDEMPOTENCY_CONFLICT`; tự động thử lại với cùng khóa Idempotency-Key khi nhận `409 IDEMPOTENCY_IN_PROGRESS`, `429 RATE_LIMITED`, hoặc `503 SERVICE_UNAVAILABLE` tuân thủ docs/API.md dòng 10 & 167.
  - signed webhook receiver: PASS — Triển khai `CreativantaWebhookReceiver` xác thực chữ ký HMAC-SHA256 trên chuỗi byte thô `timestamp + '.' + raw_body_bytes` với thuật toán so sánh an toàn thời gian cố định `crypto.timingSafeEqual`; từ chối chữ ký giả mạo (401 INVALID_SIGNATURE) và độ lệch đồng hồ clock skew > 300s (400 CLOCK_SKEW_EXCEEDED); lọc trùng lặp `eventId` trong cửa sổ lưu giữ 7 ngày; cưỡng chế tính đơn điệu `state_version` (loại bỏ các sự kiện gửi muộn đến sau); hỗ trợ xoay vòng khóa bí mật (secret rotation); và tự động xử lý bắt tay sở hữu endpoint qua cơ chế challenge echo handshake `{"challenge": "<token>"}`.
  - polling reconciliation: PASS — Hiện thực hóa phương thức `reconcileJob(jobId)` theo đúng docs/API.md dòng 139 ("Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation"); cưỡng chế rào chắn `knownStateVersion` ngăn chặn dữ liệu trễ làm tụt lùi trạng thái; giới hạn thời gian chờ với `ReconciliationTimeoutError`; và cung cấp `JobReconciliationManager` tích hợp thống nhất giữa webhook thời gian thực và polling dự phòng theo cả `jobId` và `externalReference`.
  - cancel: PASS — Triển khai `cancelJob(jobId, options)` gửi `POST /v1/jobs/{id}/cancel` kèm Idempotency-Key; xử lý chuẩn xác mã 202 Accepted (khi hủy tác vụ đang chạy hoặc queued), mã 200 OK (xác nhận trạng thái khi tác vụ đã ở trạng thái canceled), và mã 409 JOB_TERMINAL (`JobTerminalError` khi tác vụ đã thành công hoặc thất bại); hỗ trợ phát lại an toàn idempotent replay.
  - download-expiry refresh: PASS — Hiện thực hóa cơ chế quản lý grant tải tài nguyên có thời hạn ngắn (<= 5 phút); phương thức `refreshDownloadGrant(artifactId)` cấp lại URL đã ký mới mà không cần render lại video; phương thức `downloadArtifact(artifactId)` chủ động làm mới grant trước khi hết hạn (với vùng đệm `refreshBufferMs`), tự động bắt lỗi `410 GRANT_EXPIRED` giữa chừng để lấy URL mới và tải lại thành công; kiểm tra toàn vẹn độ dài byte và mã băm SHA-256 (`DownloadIntegrityError` khi có sai lệch).
  - no shared DB assumptions: PASS — Kiểm toán tĩnh tự động chứng minh thư viện SDK khách hàng (`packages/sdk/src/client`) không chứa bất kỳ lệnh import cơ sở dữ liệu nào (`node:sqlite`, `DatabaseSync`, `TenantRepository`, `TenantConnectionPool`, `@creativanta/api`, `pg`, `knex`); toàn bộ giao tiếp diễn ra 100% qua giao thức REST API v1 (`fetch`, `Headers`, `Request`, `Response`) và Webhook HTTP endpoints; kiểm chứng thành công trong bộ kiểm thử E2E tích hợp.
Reviewer / reviewed commit / decision: pending independent reviewer / 5948e62efa09171366db6fd14b274bf116dae886 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P5-03** (`D+A / P5`) hiện thực hóa toàn diện bộ máy khách hợp đồng và kiểm thử hợp đồng mô phỏng Creativanta (`CreativantaClient`, `CreativantaWebhookReceiver`, `CreativantaContractMock`) trong kho mã này mà **hoàn toàn không giả định hay chia sẻ bất kỳ kết nối cơ sở dữ liệu nội bộ nào** (`no shared DB assumptions`):

1. **Khách hàng HTTP Độc lập & Tính Bất Biến Idempotency ([packages/sdk/src/client/](../../packages/sdk/src/client/)):**
   - Lớp `CreativantaClient` giao tiếp độc quyền thông qua giao thức chuẩn REST API v1 trên nền tảng `fetch` native của Node.js, không phụ thuộc SQLite, PostgreSQL hay mã nguồn máy chủ.
   - Hỗ trợ tham số `externalReference` (mã đơn hàng / campaign của Creativanta), được tự động chuẩn hóa và gửi lên máy chủ dưới trường `client_reference` mà không làm thay đổi các trường dữ liệu bắt buộc khác.
   - Cưỡng chế nghiêm ngặt định dạng khóa bất biến `Idempotency-Key` (1–128 ký tự ASCII `[A-Za-z0-9._:-]`), tự động sinh khóa duy nhất với tiền tố định danh khi không truyền vào.
   - Chuẩn hóa canonical request hashing theo RFC 8785 (JSON Canonicalization Scheme - JCS) với Unicode NFC và sắp xếp khóa từ điển.
   - Phát hiện cờ tiêu đề `Idempotency-Replayed: true` và gắn cờ `isReplayed: true` trong đối tượng kết quả.
   - Tự động bắt và xử lý các lỗi quá độ:
     - `409 IDEMPOTENCY_IN_PROGRESS`: đọc tiêu đề `Retry-After: 1`, chờ và tự động gửi lại với **chính xác cùng một khóa `Idempotency-Key`**.
     - `429 RATE_LIMITED` / `429 QUOTA_EXCEEDED` / `503 SERVICE_UNAVAILABLE`: đọc `Retry-After`, áp dụng backoff kèm jitter ngẫu nhiên, tự động thử lại an toàn với cùng khóa `Idempotency-Key` theo đúng quy định tại [docs/API.md](../../docs/API.md) dòng 10 & 167.

2. **Bộ Nhận & Xác Thực Webhook Chữ Ký Số ([packages/sdk/src/client/webhook-receiver.ts](../../packages/sdk/src/client/webhook-receiver.ts)):**
   - Kiểm tra tiêu đề chữ ký bắt buộc: `X-CVE-Signature: v1=<hex>`, `X-CVE-Timestamp`, `X-CVE-Event-Id`, `X-CVE-Key-Id`.
   - Tính toán và xác thực mã băm HMAC-SHA256 trên chuỗi byte thô chưa bị biến đổi `timestamp + '.' + raw_body_bytes` với thuật toán so sánh thời gian cố định `crypto.timingSafeEqual` nhằm loại trừ rủi ro tấn công timing attack.
   - Chặn đứng các yêu cầu có độ lệch đồng hồ lớn hơn 300 giây (`maxSkewSeconds: 300` per docs/API.md line 149).
   - Cơ chế loại trừ trùng lặp (Event Deduplication) lưu giữ danh sách mã sự kiện `eventId` trong thời gian 7 ngày (`retentionMs = 7 * 86400 * 1000`); các sự kiện trùng lặp được đánh dấu `isDuplicate: true` và không kích hoạt lại các hàm xử lý nghiệp vụ.
   - Rào chắn phiên bản trạng thái đơn điệu (`monotonic state_version guard`): theo dõi số phiên bản trạng thái cao nhất đã ghi nhận của từng tác vụ (`job_id`); loại bỏ ngay lập tức các sự kiện bị trễ mạng hoặc out-of-order có `state_version <= lastKnownStateVersion`.
   - Hỗ trợ xoay vòng khóa ký bảo mật (Secret Rotation): cho phép cấu hình đồng thời nhiều khóa ký bí mật với thời hạn hết hạn cụ thể, bảo đảm không gián đoạn dịch vụ trong khoảng thời gian chuyển tiếp 24 giờ.
   - Tự động hoàn thành thủ tục bắt tay xác thực endpoint (`endpoint.challenge` handshake): phát hiện sự kiện thử thách và tự động phản hồi mã JSON `{"challenge": "<token>"}` trong thời gian <= 5 giây.

3. **Cơ Chế Đối Soát Trạng Thái Bằng Polling & Quản Lý Vòng Đời Hủy ([packages/sdk/src/client/reconciliation-manager.ts](../../packages/sdk/src/client/reconciliation-manager.ts)):**
   - Phương thức `reconcileJob(jobId, options)` tiến hành truy vấn định kỳ trạng thái tác vụ qua `GET /v1/jobs/{id}` với cơ chế lùi theo hàm mũ từ 2 giây lên tối đa 10 giây (tuân thủ nghiêm ngặt [docs/API.md](../../docs/API.md) dòng 139: "Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation").
   - Quản lý trạng thái hợp nhất thông qua `JobReconciliationManager`: kết hợp nguồn tin webhook thời gian thực và polling định kỳ; truy xuất trạng thái tác vụ theo cả `jobId` máy chủ lẫn `externalReference` đối ngoại của Creativanta.
   - Triển khai phương thức hủy tác vụ `cancelJob(jobId, options)` theo đúng đặc tả máy trạng thái:
     - Tác vụ đang xếp hàng hoặc đang xử lý: máy chủ chấp nhận và trả về mã `202 Accepted` kèm trạng thái `canceled` hoặc `cancel_requested`.
     - Tác vụ đã ở trạng thái hủy: gửi yêu cầu với khóa mới trả về mã `200 OK` (xác nhận trạng thái).
     - Tác vụ đã về đích thành công hoặc thất bại: trả về mã `409 JOB_TERMINAL` (ném lỗi định kiểu `JobTerminalError`).
     - Gửi lại với cùng khóa Idempotency-Key: phát lại kết quả ban đầu kèm cờ `isReplayed: true`.

4. **Tự Động Làm Mới Grant Tải Hết Hạn & Kiểm Tra Tính Toàn Vẹn ([packages/sdk/src/client/creativanta-client.ts](../../packages/sdk/src/client/creativanta-client.ts)):**
   - Các URL tải tài nguyên xuất ra từ `GET /v1/artifacts/{id}/download` có thời hạn ngắn (<= 5 phút per docs/API.md dòng 44).
   - Khi URL hết hạn hoặc sắp hết hạn (nằm trong vùng đệm `refreshBufferMs` mặc định 30 giây), phương thức `downloadArtifact` chủ động gọi `refreshDownloadGrant(artifactId)` để lấy URL đã ký mới mà không cần kết xuất (rerender) lại video.
   - Khi xảy ra lỗi hết hạn grant giữa chừng trong lúc truyền tải (máy chủ trả về mã HTTP `410 GRANT_EXPIRED`), client tự động bắt lỗi, yêu cầu cấp URL mới và thử lại việc tải tệp.
   - Kiểm tra tính toàn vẹn dữ liệu: xác thực số lượng byte thực tế và tính toán mã băm SHA-256 so khớp với giá trị cam kết của máy chủ; ném lỗi `DownloadIntegrityError` khi phát hiện tệp tin bị hỏng hoặc bị cắt cụt.

5. **Bộ Mô Phỏng Hợp Đồng Độc Lập Cho Kiểm Thử Creativanta ([packages/sdk/src/client/contract-mock.ts](../../packages/sdk/src/client/contract-mock.ts)):**
   - Lớp `CreativantaContractMock` đóng vai trò là một test double / mock server gọn nhẹ, chạy trên cổng mạng ngẫu nhiên qua module chuẩn `node:http`, mô phỏng 100% hợp đồng API của máy chủ dựng hình video.
   - Cho phép các nhóm phát triển và bộ kiểm thử tự động của Creativanta kiểm thử tích hợp toàn bộ quy trình gửi tác vụ, xử lý phản hồi phát lại idempotency, thử lại khi quá tải, nhận webhook có chữ ký số và làm mới link tải hết hạn mà không cần khởi chạy PostgreSQL, MinIO hay Docker containers.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `./node_modules/.bin/tsc -p packages/sdk/tsconfig.json` | 0 | PASS | Biên dịch TypeScript sạch sẽ cho `@creativanta/sdk` |
| 2 | `./node_modules/.bin/tsc -p packages/templates/tsconfig.json` | 0 | PASS | Biên dịch TypeScript sạch sẽ cho `@creativanta/templates` |
| 3 | `node --test packages/sdk/test/creativanta-idempotency-and-refs.test.mjs` | 0 | PASS (7/7 tests) | Kiểm tra định dạng khóa, JCS canonical hashing, external_reference, phát lại replay, xung đột 409, tự động thử lại 409 IN_PROGRESS / 429 / 503 |
| 4 | `node --test packages/sdk/test/creativanta-webhook-receiver.test.mjs` | 0 | PASS (7/7 tests) | Kiểm tra xác thực chữ ký HMAC-SHA256, timing-safe compare, chặn chữ ký giả mạo, chặn lệch giờ >300s, khử trùng 7 ngày, bảo vệ đơn điệu state_version, xoay vòng secret, echo challenge handshake |
| 5 | `node --test packages/sdk/test/creativanta-reconciliation-and-cancel.test.mjs` | 0 | PASS (7/7 tests) | Kiểm tra polling reconciliation lùi số nhân 2s->10s, timeout guard, hủy tác vụ 202/200/409 terminal, phát lại replay cancel, và JobReconciliationManager |
| 6 | `node --test packages/sdk/test/creativanta-download-expiry-refresh.test.mjs` | 0 | PASS (5/5 tests) | Kiểm tra grant có hạn ngắn, làm mới không rerender, tự phục hồi khi gặp 410 GRANT_EXPIRED, kiểm tra toàn vẹn byte count và SHA-256 |
| 7 | `node --test packages/sdk/test/creativanta-e2e-contract-harness.test.mjs` | 0 | PASS (6/6 tests) | Kiểm thử E2E tích hợp trực tiếp với máy chủ HTTP thật: kiểm toán tĩnh zero-DB imports, bắt tay endpoint.challenge, nạp asset, tạo template/composition, submit render, nhận webhook thật, đối soát và tải video MP4 thành công |
| 8 | `node --test packages/sdk/test/**/*.test.mjs` | 0 | PASS (68/68 tests) | Toàn bộ 68 bài kiểm thử trong `@creativanta/sdk` (25 bài TTS P5-02, 11 bài brand-tokens/text-overflow P5-01 và 32 bài Client/Webhook/Contract P5-03) đều vượt qua 100% |
| 9 | `node --test packages/templates/test/**/*.test.mjs` | 0 | PASS (17/17 tests) | Toàn bộ 17 bài kiểm thử mẫu video trong `@creativanta/templates` đạt kết quả PASS |
| 10 | `node scripts/health-check.mjs` | 0 | PASS | Kiểm tra cấu hình môi trường, endpoints `/healthz`, `/readyz`, và năng lực hệ thống |
| 11 | `python3 scripts/validate_repo.py` | 0 | PASS | Kiểm tra tính hợp lệ toàn repo: 16 tài liệu, 47 markdown, 662 internal links, 34 JSON files, 0 lỗi, đồ thị phụ thuộc acyclic |
| 12 | `python3 -m unittest discover -s tooling/agent_harness/tests -v` | 0 | PASS (10/10 tests) | Toàn bộ 10 bài kiểm thử vòng đời supervisor và quy chế quản lý nhiệm vụ đều đạt kết quả PASS |

---

## 3. Ranh giới, giới hạn kỹ thuật và công việc tiếp theo (Boundaries & Next Steps)

- **Ranh giới thực thi:**
  - Tuyệt đối chỉ chỉnh sửa và tạo tệp bên trong worktree cục bộ được cấp phép (`packages/sdk/`, `evidence/P5-03/`).
  - Không sửa đổi mã nguồn dự án Creativanta hiện hữu ở các kho mã khác; không triển khai dịch vụ lên hạ tầng production.
  - Không import hay sử dụng chung bất kỳ cơ sở dữ liệu nào của máy chủ; ranh giới giao tiếp duy nhất là hợp đồng REST API v1 và Webhook HTTP endpoints.
  - Không sử dụng các mô hình GPU AI-video hay các API tạo video trả phí.

- **Cổng phê duyệt bên ngoài còn hiệu lực (External Gates):**
  - Cổng xem xét độc lập của Reviewer và Staging CI workflow trên GitHub trước khi tích hợp vào nhánh `staging`.
  - Cổng phê duyệt pháp lý và thỏa thuận thương mại đối với các nhà cung cấp bên ngoài trước khi kích hoạt các bộ điều hợp môi trường production.

- **Nhiệm vụ tiếp theo:**
  - Nhiệm vụ **P5-04** (`A+D / P5`): Xây dựng tài liệu hướng dẫn tích hợp API (`API integration guide`) và ví dụ mẫu client định kiểu (`typed client example`), bộ kiểm thử tương thích v1, và các kịch bản xử lý lỗi/thử lại mẫu với thông tin xác thực placeholder.
