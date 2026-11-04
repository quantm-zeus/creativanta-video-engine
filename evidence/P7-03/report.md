# Evidence Report — Task P7-03: Provider-Neutral Authoring Adapter Contract & Non-Premium Routes

## 1. Thông tin chung (Task Metadata)

| Trường | Giá trị |
| :--- | :--- |
| **Task ID** | `P7-03` |
| **Phase / Owner** | `P7` / `D+C` |
| **Branch / Worktree** | `agy/p7-03` (`/workspace/repo/.worktrees/p7-03`) |
| **Base Commit** | `bcfc977d3dc7d03d0b38ca39926dc7c92292a9df` (staging sau khi tích hợp P7-02 qua PR #42) |
| **Allowed Paths** | `["evidence/P7-03/", "packages/custom-runtime/"]` |
| **Dependencies** | `P7-02` |
| **Acceptance Criteria** | `Provider-neutral authoring adapter contract và ít nhất một non-premium-required route + deterministic mock; token/time/cost budgets, cancellation, source-only output. Codex/AGY/OpenCode/DeepSeek là tùy chọn, không bắt buộc subscription` |
| **Tài liệu chuẩn tắc đối chiếu** | [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) |

---

## 1.1. Khắc phục lỗi kiểm tra của Supervisor (`Verification failed: git exit=2: `)

Trong lần thẩm định trước của supervisor, công đoạn kiểm tra `git diff --check base_sha HEAD` trả về mã thoát `exit=2` do tệp `packages/custom-runtime/index.d.ts` thừa một dòng trống ở cuối tệp (line 964: `new blank line at EOF`).
- **Nguyên nhân:** Lệnh `git diff --check` bắt các lỗi khoảng trắng/dòng trống ở cuối tệp và thoát với mã `2`, kích hoạt ngoại lệ `Verification failed: git exit=2: ` trong `supervisor.py`.
- **Khắc phục:** Đã loại bỏ hoàn toàn ký tự dòng trống thừa ở cuối `packages/custom-runtime/index.d.ts`.
- **Xác minh:** Chạy `git diff --check bcfc977d3dc7d03d0b38ca39926dc7c92292a9df HEAD` trả về mã thoát `0` (không có cảnh báo hoặc lỗi khoảng trắng).

---

## 2. Tóm tắt kiến trúc và các hạng mục đã triển khai (Deliverables Summary)

### 2.1. Provider-Neutral Authoring Adapter Contract & Phân loại Tuyến (Provider Classification)
- Triển khai hợp đồng trừu tượng `AuthoringAdapter` tại [packages/custom-runtime/src/authoring-adapter-contract.mjs](../../packages/custom-runtime/src/authoring-adapter-contract.mjs):
  - **Tính trung lập nhà cung cấp (Provider Neutrality):** Hệ thống không bị trói buộc (vendor lock-in) vào bất kỳ nhà cung cấp độc quyền nào. Mọi adapter đều tuân thủ hợp đồng chuẩn hóa `generateSceneSource(request, context)`, `estimateBudget(request)`, và `listModels()`.
  - **Phân loại tuyến kết nối (`AuthoringProviderType`):** Phân định rạch ròi 3 nhóm tuyến:
    1. `mock`: Tuyến giả lập xác định 100% ngoại tuyến, không tốn chi phí và không cần mạng hay API key.
    2. `local`: Tuyến mô hình mã nguồn mở chạy nội bộ (OpenCode, Ollama, LocalAI, vLLM) không phụ thuộc dịch vụ thương mại.
    3. `remote`: Tuyến mô hình đám mây tùy chọn (DeepSeek, AGY Gemini Flash, Codex/OpenAI).
  - **Không bắt buộc đăng ký thuê bao (Subscription Optional & Zero Mandatory Subscription):** Các tuyến `mock-deterministic` và `opencode` đánh dấu cứng `isSubscriptionRequired: false`. Tuyến `deepseek` và `agy-gemini` hoạt động theo cơ chế token utility / pay-as-you-go hoặc free-tier, không ép buộc người dùng phải trả thuê bao định kỳ (non-premium-required).
  - **Bảng giá định mức chuẩn (`AUTHORING_PRICING_TABLE`):** Khai báo biểu giá quy đổi USD trên 1,000 token đầu vào/đầu ra, hỗ trợ theo dõi chi phí chính xác đến mức vi đô la (micro-USD).
  - **Chuẩn hóa Brief Unicode NFC & Ràng buộc tài sản (`validateAuthoringRequest`):** Tự động chuẩn hóa văn bản mô tả (brief) về chuẩn Unicode NFC (theo [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) dòng 92), bảo tồn đầy đủ dấu thanh tiếng Việt (`ă â đ ê ô ơ ư`), đồng thời kiểm tra danh sách trắng tài sản được phép liên kết (`approved_asset_ids` <= 50, chặn ký tự độc hại).

### 2.2. Tuyến Không Bắt Buộc Thuê Bao (Non-Premium Routes) & Deterministic Mock Adapter
- Triển khai `DeterministicMockAuthoringAdapter` tại [packages/custom-runtime/src/deterministic-mock-adapter.mjs](../../packages/custom-runtime/src/deterministic-mock-adapter.mjs):
  - **Tạo mã cảnh hoàn chỉnh chuẩn `custom-html-v1`:** Từ văn bản yêu cầu sáng tạo, adapter tổng hợp đầy đủ 4 tệp nguồn chuẩn tắc:
    1. `index.html`: Khung HTML5 Canvas/SVG sạch sẽ, liên kết stylesheet và mô-đun kịch bản an toàn.
    2. `scene.mjs`: Mô-đun ES module chứa vòng lặp kết xuất thủ tục (`renderFrame`), hàm nắn chuyển động (`easeOutCubic`), xử lý đồ họa vector và chữ động.
    3. `styles.css`: Bảng định kiểu CSS hiện đại, tối ưu vùng hiển thị và căn chỉnh khung vẽ.
    4. `manifest.json`: Tệp kê khai mô tả kích thước (`width`, `height`), tốc độ khung hình (`fps`), thời lượng (`duration_seconds`), điểm vào (`entrypoint: 'index.html'`) và lược đồ tham số (`parameter_schema`).
  - **Tính lặp lại xác định 100% (Byte-Identical Determinism):** Khi truyền cùng một `seed` (hoặc tính băm từ brief), hệ thống sinh ra chính xác từng byte nội dung mã nguồn, bảo đảm mã băm `source_sha256` và `build_sha256` hoàn toàn trùng khớp giữa các lần chạy kiểm thử phân tán.
  - **Bảo tồn chữ tiếng Việt chuẩn NFC:** Thử nghiệm thành công các chuỗi tiếng Việt có dấu phức tạp (ví dụ: *"Khám Phá Nền Tảng Video Creativanta: Đỉnh Cao Công Nghệ Render CPU Độc Lập"*), giữ nguyên vẹn trong mã nguồn kết xuất mà không bị lỗi font hay phân rã ký tự NFD.
  - **Ràng buộc an toàn tài sản (`approved_asset_ids`):** Khi yêu cầu chứa tài sản được duyệt, mã nguồn sinh ra chỉ liên kết tương đối an toàn tới các slot tài sản nội bộ; tuyệt đối không tạo URL ngoại bộ (`http://`, `https://`).
- Triển khai các adapter mã nguồn mở và tùy chọn tại [packages/custom-runtime/src/non-premium-routes.mjs](../../packages/custom-runtime/src/non-premium-routes.mjs):
  - `OpenCodeAuthoringAdapter`: Tuyến mô hình cục bộ (`opencode-14b`, `qwen2.5-coder-7b`) kết nối cổng cục bộ (`CVE_OPENCODE_BASE_URL` hoặc `http://localhost:11434/v1`), hỗ trợ chế độ giả lập an toàn ngoại tuyến khi máy chủ daemon chưa bật.
  - `DeepSeekAuthoringAdapter`: Tuyến tiện ích chi phí thấp (`deepseek-coder`, `deepseek-chat`).
  - `AgyGeminiAuthoringAdapter`: Tuyến tích hợp AGY Gemini Flash (`gemini-1.5-flash`, `gemini-2.0-flash`).
  - `CodexAuthoringAdapter`: Tuyến OpenAI Codex thương mại (`gpt-4o-mini`, `codex-gpt-4o`).

### 2.3. Cơ chế Thực thi Ngân sách: Token, Thời gian và Chi phí (Budget Enforcer)
- Triển khai `AuthoringBudgetEnforcer` tại [packages/custom-runtime/src/authoring-budget-enforcer.mjs](../../packages/custom-runtime/src/authoring-budget-enforcer.mjs):
  - **Kiểm tra trước khi thực thi (Preflight Check):** Ước tính số token đầu vào/đầu ra và chi phí dự phóng; lập tức từ chối yêu cầu với lỗi `TOKEN_BUDGET_EXCEEDED` hoặc `COST_BUDGET_EXCEEDED` nếu vượt quá giới hạn ngân sách do người dùng thiết lập hoặc trần hệ thống (`AUTHORING_SYSTEM_LIMITS.maxTokensUpperCap = 65536`, `maxCostUsdUpperCap = $10.00`).
  - **Kiểm soát thời gian thực thi (In-Flight Timeout Controller):** Khởi tạo bộ đếm thời gian gắn liền với `AbortController` thông qua `createTimeoutController(timeoutMs, parentSignal)`. Khi tác vụ chạy quá ngân sách thời gian (`timeout_ms`, mặc định 60,000 ms), tín hiệu hủy được kích hoạt tự động, ngắt tiến trình và chuyển trạng thái công việc sang `canceled` với lý do `TIME_BUDGET_EXCEEDED`.
  - **Hạch toán và kiểm tra sau thực thi (Postflight Verification):** Đo đạc chính xác số token thực tế (`prompt_tokens`, `completion_tokens`, `total_tokens`), thời gian thực thi (`duration_ms`), chi phí USD (`cost_usd`) và micro-USD (`cost_micros`). Nếu bất kỳ chỉ số nào vượt ngưỡng ngân sách yêu cầu, hệ thống từ chối trả về kết quả và ném lỗi tương ứng.

### 2.4. Khả năng Hủy bỏ Tức thì (Responsive Cancellation & AbortSignal)
- **Tích hợp `AbortSignal` xuyên suốt:** Mọi adapter đều nhận `context.signal` và kiểm tra trạng thái `aborted` trước, trong và sau các bước sinh mã.
- **Hủy công việc qua API (`cancelJob`):** Cho phép người dùng hoặc hệ thống giám sát chủ động hủy tác vụ đang chờ (`queued`) hoặc đang sinh mã (`authoring`) qua phương thức `AuthoringJobManager.cancelJob(jobId, tenantId, reason)`.
- **Chuyển đổi trạng thái sạch sẽ:** Tác vụ bị hủy chuyển sang trạng thái `canceled`, lưu vết `cancellation_reason` và thời điểm kết thúc `completed_at`, giải phóng toàn bộ tài nguyên chờ và dừng các tiến trình con ngay lập tức.

### 2.5. Bảo đảm Đầu ra Chỉ là Mã nguồn (Source-Only Output) & Bộ Quét An ninh Tĩnh
- Triển khai tại [packages/custom-runtime/src/authoring-source-guard.mjs](../../packages/custom-runtime/src/authoring-source-guard.mjs):
  - **Nguyên tắc "Chỉ sinh mã nguồn" (Source-Only Output Guarantee):** Trí tuệ nhân tạo chỉ đóng vai trò tác giả sinh tệp mã (`.html`, `.mjs`, `.css`, `.json`). Hệ thống **tuyệt đối không thực thi** mã do AI tạo ra trong tiến trình API hoặc supervisor tin cậy. Mã nguồn chỉ được biên dịch và chạy trong môi trường microVM cô lập hai pha dùng một lần (`P7-01` / `P7-04`).
  - **Bộ quét an ninh tĩnh nghiêm ngặt (`scanSourceFilesForSecurityViolations`):** Quét toàn bộ tệp kết quả trước khi tiếp nhận:
    - *Chặn thực thi mã động:* Cấm `eval()`, `Function()`, `setTimeout("...")` và `setInterval("...")`.
    - *Chặn truy cập tiến trình chủ:* Cấm `process.`, `globalThis.process`, `child_process`, `node:child_process`, `fs.`, `node:fs`.
    - *Chặn kết nối mạng ngoại bộ:* Cấm `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon` và các URL giao thức `http://` / `https://` (ngoại trừ namespace XML hợp lệ của SVG và schema của JSON Schema).
    - *Bộ dò rò rỉ bí mật canary (Canary Secret Leak Detector):** Quét phát hiện và chặn đứng mọi chuỗi token bí mật (`CVE_*_SECRET`, `CANARY_*`, OpenAI/GitHub keys) rò rỉ vào mã nguồn sinh ra.
  - **Tính toàn vẹn & Phân tích lược đồ:** Kiểm tra định mức (`maxFiles <= 100`, `maxSourceBytes <= 5 MiB`), xác thực tệp điểm vào `index.html`, kiểm tra an toàn schema tham số bằng `validateParameterSchemaDefinition`, tính toán mã băm nguồn `source_sha256`, mã băm bản dựng `build_sha256`, và sinh token CSP `'sha256-...'`.
  - **Hồ sơ Provenance AI chống làm giả:** Tự động đính kèm bản ghi `SceneBundleProvenance` với `authoring_type: 'ai'`, ghi nhận thông số mô hình, token, chi phí và tính toán mã băm xác thực `provenance_digest`.

### 2.6. Trình Quản lý Vòng đời Công việc & Đóng gói vào SceneBundleRegistry
- Triển khai `AuthoringJobManager` tại [packages/custom-runtime/src/authoring-job-manager.mjs](../../packages/custom-runtime/src/authoring-job-manager.mjs):
  - **Cô lập Multi-Tenant & Chống IDOR:** Quản lý hàng đợi công việc gắn liền với `tenant_id`. Khi tenant truy vấn hoặc cố gắng thao tác trên công việc của tenant khác, hệ thống chủ động trả về `JOB_NOT_FOUND` kèm mã HTTP `404` (zero IDOR leakage).
  - **Vòng đời trạng thái công việc:** Quản lý chuyển trạng thái minh bạch: `queued` -> `authoring` -> `succeeded` / `failed` / `canceled`.
  - **Tích hợp trực tiếp vào SceneBundleRegistry:** Cung cấp phương thức `importJobOutputToRegistry(jobId, tenantId, bundleRegistry, options)`:
    - Tạo gói cảnh mới (`bundle_created`) hoặc tạo bản sửa đổi draft tiếp theo (`revision_created`) trong gói cảnh hiện có của tenant.
    - Gói cảnh được lưu ở trạng thái `draft`, bảo đảm cổng an toàn mặc định tắt (`feature still off`), sẵn sàng cho pha biên dịch cách ly microVM của P7-04.

### 2.7. Đặc tả Mở rộng OpenAPI 3.1 cho AI Authoring
- Ban hành đặc tả chuẩn OpenAPI 3.1.0 tại [packages/custom-runtime/src/authoring-openapi.json](../../packages/custom-runtime/src/authoring-openapi.json) và mô-đun tích hợp tại [packages/custom-runtime/src/authoring-openapi.mjs](../../packages/custom-runtime/src/authoring-openapi.mjs):
  - Định nghĩa 5 tuyến đường quản trị AI authoring theo đúng [docs/API.md](../../docs/API.md) dòng 174:
    1. `POST /authoring-jobs`: Khởi tạo yêu cầu sinh cảnh AI (trả về HTTP `202 Accepted` kèm ID công việc, yêu cầu phạm vi quyền `authoring:write`).
    2. `GET /authoring-jobs`: Liệt kê danh sách các công việc authoring của tenant có phân trang và lọc theo trạng thái (`authoring:read`).
    3. `GET /authoring-jobs/{id}`: Truy vấn trạng thái, siêu dữ liệu chi phí và mã nguồn kết quả của công việc (`authoring:read`).
    4. `POST /authoring-jobs/{id}/cancel`: Yêu cầu hủy bỏ công việc authoring đang chạy hoặc đang chờ (`authoring:write`).
    5. `GET /authoring-providers`: Liệt kê danh sách các nhà cung cấp, mô hình hỗ trợ, trạng thái yêu cầu thuê bao và biểu giá định mức (`authoring:read`).
  - Cung cấp hàm `extendOpenApiWithAuthoring(baseSpec)` cho phép nhúng liền mạch đặc tả Authoring vào tài liệu API chung của nền tảng.

---

## 3. Nhật ký và Kết quả Kiểm tra Thực tế (Verification & Evidence Logs)

Tất cả các bài kiểm tra dưới đây được thực thi trực tiếp trong worktree `/workspace/repo/.worktrees/p7-03` trên môi trường Linux độc lập.

| Lệnh kiểm tra | Exit Code | Trạng thái | Chi tiết kết quả |
| :--- | :---: | :---: | :--- |
| `git diff --check bcfc977d3dc7d03d0b38ca39926dc7c92292a9df HEAD` | `0` | `PASS` | Kiểm tra quy chuẩn khoảng trắng và dòng kết thúc tệp trên toàn bộ diff so với base staging, khắc phục triệt để lỗi `git exit=2`. |
| `node packages/custom-runtime/src/cli.mjs --write-evidence evidence/P7-03` | `0` | `PASS` | Chạy toàn bộ 14/14 bài kiểm tra tự động `AUT-01`..`AUT-14` và xuất báo cáo kiểm toán tại [evidence/P7-03/authoring-adapter-audit.json](./authoring-adapter-audit.json) và OpenAPI tại [evidence/P7-03/authoring-openapi.json](./authoring-openapi.json). |
| `npx tsc -p packages/custom-runtime/tsconfig.json --noEmit` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript cho toàn bộ mã nguồn `.mjs` và `.d.ts` trong `packages/custom-runtime/` không có lỗi. |
| `node --test packages/custom-runtime/test/p7-03-authoring-adapter.test.mjs` | `0` | `PASS` | 26/26 bài kiểm thử (9 test suites) đạt 100%: hợp đồng adapter, phát hiện nhà cung cấp, tuyến non-premium, bộ sinh mock xác định, bảo tồn tiếng Việt NFC, ràng buộc asset IDs, ngân sách token/thời gian/chi phí, cơ chế hủy AbortSignal, quét mã an ninh tĩnh, chống rò rỉ canary, cô lập tenant IDOR, tích hợp SceneBundleRegistry và mở rộng OpenAPI 3.1. |
| `node --test packages/custom-runtime/test/p7-01-custom-runtime.test.mjs packages/custom-runtime/test/p7-02-scene-bundle-registry.test.mjs packages/custom-runtime/test/p7-03-authoring-adapter.test.mjs` | `0` | `PASS` | Toàn bộ 67/67 bài kiểm thử của cả 3 chặng P7-01, P7-02 và P7-03 đạt 100%, bảo đảm không suy thoái chức năng (zero regression). |
| `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | 8/8 kiểm tra an ninh hộp cát controller (non-root, cgroup v2, zero egress, CSP, custom code disabled gate) đạt 100%. |
| `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận cấu hình mặc định an toàn `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, `custom-html-v1: false`, `CVE_AUTHORING_PROVIDER="disabled"`. |
| `node --test ops/test/security-review-p6-04.test.mjs` | `0` | `PASS` | 24/24 kiểm tra an ninh nền tảng P6-04 (SBOM/lockfile, renderer security, API isolation, lease fencing, restore safety) tiếp tục đạt 100%. |
| `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra tính toàn vẹn kho lưu trữ, liên kết Markdown và 51 tệp JSON hợp lệ (tăng 2 tệp JSON mới). |

### Tóm tắt 14 hạng mục kiểm toán trong `evidence/P7-03/authoring-adapter-audit.json`

```json
{
  "taskId": "P7-03",
  "status": "PASS",
  "totalChecks": 14,
  "passedChecks": 14,
  "failedChecks": 0,
  "durationMs": 1157,
  "timestamp": "2026-11-04T16:00:08.369Z",
  "checks": [
    {
      "id": "AUT-01",
      "title": "Provider-neutral authoring adapter contract & provider registry discovery",
      "category": "adapter_contract",
      "status": "PASS",
      "details": { "providersCount": 5, "defaultProvider": "mock-deterministic" }
    },
    {
      "id": "AUT-02",
      "title": "At least one non-premium route without mandatory subscription",
      "category": "non_premium_routes",
      "status": "PASS",
      "details": { "mockSubscriptionRequired": false, "openCodeSubscriptionRequired": false }
    },
    {
      "id": "AUT-03",
      "title": "Deterministic mock produces complete valid custom-html-v1 scene files from brief",
      "category": "mock_generation",
      "status": "PASS",
      "details": {
        "filePaths": ["index.html", "scene.mjs", "styles.css", "manifest.json"],
        "sourceSha256": "87664f1303be2d406bb600010d019380394fe6b0886805616ba1f6abc6ede19a"
      }
    },
    {
      "id": "AUT-04",
      "title": "Deterministic repeatability: same brief and seed produce byte-identical source files and digest",
      "category": "determinism",
      "status": "PASS",
      "details": { "isIdentical": true }
    },
    {
      "id": "AUT-05",
      "title": "Preservation of Vietnamese NFC diacritics and tone marks (ă â đ ê ô ơ ư)",
      "category": "scene_spec_compliance",
      "status": "PASS",
      "details": { "preservesVietnamese": true }
    },
    {
      "id": "AUT-06",
      "title": "Enforces approved_asset_ids restriction and binds assets safely without external URLs",
      "category": "asset_scoping",
      "status": "PASS",
      "details": { "approvedAssetsBound": ["asset-logo-svg", "asset-bg-pattern"] }
    },
    {
      "id": "AUT-07",
      "title": "Token budget enforcement: rejects requests exceeding token limits",
      "category": "budget_enforcement",
      "status": "PASS",
      "details": { "caughtAsExpected": true, "rejectedCode": "TOKEN_BUDGET_EXCEEDED" }
    },
    {
      "id": "AUT-08",
      "title": "Time budget enforcement: timeout budget triggers AbortSignal cancellation",
      "category": "time_budget",
      "status": "PASS",
      "details": { "timedOutAsExpected": true, "finalState": "canceled" }
    },
    {
      "id": "AUT-09",
      "title": "Cost budget enforcement: blocks execution exceeding max_cost_usd cap",
      "category": "cost_budget",
      "status": "PASS",
      "details": { "budgetCapTested": true, "maxCostUsd": 0.000001 }
    },
    {
      "id": "AUT-10",
      "title": "Responsive job cancellation: active jobs abort immediately on cancel request",
      "category": "cancellation",
      "status": "PASS",
      "details": { "state": "canceled", "reason": "User canceled generation" }
    },
    {
      "id": "AUT-11",
      "title": "Source-only output guarantee: static scanner blocks eval, network egress, and host process access",
      "category": "source_only_security",
      "status": "PASS",
      "details": { "evalBlocked": true, "fetchBlocked": true }
    },
    {
      "id": "AUT-12",
      "title": "Canary secret leak detection: prevents secrets from leaking into generated code",
      "category": "secret_leak_defense",
      "status": "PASS",
      "details": { "canaryCaughtAsExpected": true }
    },
    {
      "id": "AUT-13",
      "title": "Multi-tenant isolation & IDOR defense on authoring jobs (Path 404 / JOB_NOT_FOUND)",
      "category": "tenant_isolation",
      "status": "PASS",
      "details": { "idorBlocked": true, "statusCode": 404 }
    },
    {
      "id": "AUT-14",
      "title": "Seamless import of authoring job output into SceneBundleRegistry with AI provenance",
      "category": "registry_integration",
      "status": "PASS",
      "details": { "authoringType": "ai" }
    }
  ]
}
```

---

## 4. Các cổng bên ngoài và Ranh giới An ninh (External Gates & Security Boundaries)

1. **EXT-P7-01 (Mặc định tắt & Cổng ảo hóa phần cứng):** Tương tự như P7-01 và P7-02, môi trường phát triển/CI hiện tại không có `/dev/kvm` thực tế. Tính năng thực thi mã cảnh tùy ý (`custom-html-v1`) tiếp tục được khóa mặc định tắt (`CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`).
2. **EXT-P7-02 (Cổng phê duyệt C1–C6 và Tenant Pilot):** Bất kỳ việc kích hoạt thực tế nào của hệ thống AI Authoring và Custom Runtime đều phụ thuộc vào sự phê duyệt và ký duyệt an ninh độc lập C1–C6 (P7-05) và cấp quyền cho tenant pilot thử nghiệm (P7-06).
3. **EXT-P7-03 (Chính sách Zero Generative Video / Zero Paid AI Video APIs):** Hệ thống chỉ tạo mã nguồn kịch bản hoạt hình trình duyệt tĩnh (`custom-html-v1`). Tuyệt đối không tích hợp hay phụ thuộc vào các API sinh video generative từ text/hình ảnh dựa trên GPU hoặc các dịch vụ thương mại đắt tiền.

---

## 5. Kết luận và Kế hoạch Bàn giao (Handoff & Next Steps)

- Toàn bộ mục tiêu nghiệm thu của **P7-03** đã hoàn thành trọn vẹn và được xác thực 100% bằng mã nguồn thực tế và kiểm thử tự động trong worktree `agy/p7-03`.
- Không phát sinh hồi quy chức năng trên toàn bộ monorepo (tất cả các suite kiểm thử nền tảng P6-04, custom runtime P7-01, registry P7-02 đều vượt qua).
- **Task tiếp theo:** `P7-04 / C+B` — Xây dựng môi trường biên dịch cách ly cho gói cảnh (Isolated build with approved imports, static scanner + preview + malicious payload suite, no trusted API execution).
