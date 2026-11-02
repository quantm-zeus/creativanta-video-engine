# Evidence report — Task P0-04

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P0-04: Contract and threat-model review** thuộc workstream A+C (Contracts/Control + Security/Infra) trong repository `creativanta-video-engine`. [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) là chuẩn đối chiếu backlog; [AGY execution](../../docs/AGENTS.md), [Security](../../docs/SECURITY.md), [Scene spec](../../docs/SCENE-SPEC.md), [API](../../docs/API.md), [Architecture](../../docs/ARCHITECTURE.md) và [Testing](../../docs/TESTING.md) quy định hợp đồng và tiêu chuẩn nghiệm thu.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P0-04
Base / tested commit: c3ff673791ac383c003bdbe6490e6ac4b007f066 / c3ff673791ac383c003bdbe6490e6ac4b007f066
Environment: Linux 6.6.137+ x86_64, Debian/Ubuntu container environment, Python 3.11.2 (/usr/bin/python3)
Command: PATH=/usr/bin:$PATH python3 scripts/validate_repo.py && PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-02T13:54:15Z / 1.2s
Artifacts:
  - evidence/P0-04/report.md
  - evidence/P0-04/contract-threat-review.json, sha256=f6da754d418ac23517e950c5637bbf9f70496838170dc809f0518c464f48bae9
Acceptance mapping:
  - Chốt starter limits: PASS — Phân tách 3 tầng kiểm tra (JSON Schema vs Semantic vs Profile/Capability policy) và chốt toàn bộ giới hạn cho mp4-720p-v1, preview-360p-v1, payload, media, SVG/font/image, rate limit và slot quota.
  - Chốt transitions: PASS — Chốt quy tắc scene transitions v1 (cut duration=0, fade_to_background 2<=F<=min(300, scene.duration_frames) và công thức nhân alpha) cùng state machine đầy đủ cho Job, Asset và Webhook Endpoint.
  - Chốt tenant entities: PASS — Chốt 21 bảng PostgreSQL thuộc 10 nhóm thực thể cho P3-01, khóa ngoại tổ hợp có tenant_id, RLS SET LOCAL app.current_tenant_id, sentinel tenant system_catalog (00000000-0000-0000-0000-000000000000) và 5 DB roles tách biệt.
  - Chốt errors: PASS — Chuẩn hóa danh mục HTTP error codes, 17 mã lỗi chi tiết validation (details[].code), quy tắc phân biệt 404 (path ID) vs 422 (JSON body ref), và 13 mã job.error.code bất đồng bộ.
  - Chốt lease/cancel/idempotency: PASS — Chốt đồng hồ lease chuẩn tắc trên PostgreSQL (now(), 60s lease / 15s heartbeat, fence attempt_id + lease_epoch), giao thức đua khóa dòng cancel-vs-publish, và Idempotency-Key RFC 8785 JCS SHA-256 không lưu cứng lỗi 429/503/validation.
  - Mở issues cụ thể cho ambiguity, sửa docs cùng quyết định: PASS — Mở và giải quyết triệt để 10 ambiguity issues (AMB-001..AMB-010), cập nhật đồng bộ 6 tài liệu thiết kế chuẩn tắc (PRD, API, SCENE-SPEC, ARCHITECTURE, SECURITY, PROGRESS/EXECUTION_LOG).
Reviewer / reviewed commit / decision: pending independent reviewer / c3ff673791ac383c003bdbe6490e6ac4b007f066 / local completion awaiting review
```

## 1. Bối cảnh và mục tiêu rà soát hợp đồng / mô hình mối đe dọa

Nhiệm vụ **P0-04** là cổng khóa hợp đồng (contract freeze) và mô hình mối đe dọa (threat-model gate) trước khi triển khai sổ cái trạng thái supervisor (`P0-05`), dựng workspace (`P1-01`), xuất bản bộ lược đồ JSON Schema 2020-12 & OpenAPI 3.1 (`P1-02`), và viết migration cơ sở dữ liệu phân tách đa khách hàng (`P3-01`).

Toàn bộ kết quả rà soát được chuẩn hóa dưới dạng máy đọc được tại [contract-threat-review.json](contract-threat-review.json) và được đồng bộ trực tiếp vào [PRD](../../docs/PRD.md), [API](../../docs/API.md), [Scene spec](../../docs/SCENE-SPEC.md), [Architecture](../../docs/ARCHITECTURE.md), [Security](../../docs/SECURITY.md), [Progress](../../docs/PROGRESS.md) và [Execution log](../../docs/EXECUTION_LOG.md).

---

## 2. Chốt giới hạn khởi điểm (`starter-v1` Starter Limits)

### 2.1. Phân tách giới hạn cấu trúc (Schema Bounds) và giới hạn Admission (`starter-v1` Profile Bounds)

| Hạng mục | Tầng 1: JSON Schema 2020-12 (`P1-02`) | Tầng 3: Policy `starter-v1` (`mp4-720p-v1` / `preview-360p-v1`) | Mã lỗi khi vượt ngưỡng |
| --- | --- | --- | --- |
| Kích thước Canvas (`width`, `height`) | Số nguyên dương chẵn `2..3840` px | Render `mp4-720p-v1`: đúng `720×1280` (9:16) hoặc `1280×720` (16:9). Preview `preview-360p-v1`: scale `0.5` (`360×640` hoặc `640×360`) | Vượt 3840 hoặc số lẻ → `422 VALIDATION_FAILED` (`OUT_OF_RANGE`); khác 720p ở starter → `422 UNSUPPORTED_CAPABILITY` (`PROFILE_CONSTRAINT_VIOLATED`) |
| Tốc độ khung hình (`fps`) | Rational `{num, den}` rút gọn; v1 catalog `24/1`, `25/1`, `30/1` | Chỉ bật `30/1` (`{"num": 30, "den": 1}`) | Float/sai kiểu → `422 VALIDATION_FAILED` (`TYPE_MISMATCH`); `24/1` hoặc `25/1` khi chưa mở profile → `422 UNSUPPORTED_CAPABILITY` (`PROFILE_CONSTRAINT_VIOLATED`) |
| Thời lượng (`duration_frames`) | Số nguyên `1..10800` (tối đa 360s ở 30fps) | Render `mp4-720p-v1`: `1..1800` frames (`≤60s`). Clip preview `preview-360p-v1`: `1..300` frames (`≤10s`) | Ngoài `1..10800` → `422 VALIDATION_FAILED` (`OUT_OF_RANGE`); `1801..10800` trên `mp4-720p-v1` → `422 UNSUPPORTED_CAPABILITY` (`PROFILE_CONSTRAINT_VIOLATED`) |
| Scene engine (`scenes[].engine`) | Enum `html-v1`, `canvas-v1`, `svg-v1`, `custom-html-v1` | Chỉ bật `html-v1`; `canvas-v1`, `svg-v1`, `custom-html-v1` mặc định tắt (`supported=false`) | Engine chưa bật → `422 UNSUPPORTED_CAPABILITY` (`CAPABILITY_DISABLED`) |
| Ngôn ngữ & hướng chữ (`locale`, `direction`) | `locale` thuộc `["vi-VN", "en-US"]`, `direction` thuộc `["ltr", "rtl"]` | `vi-VN`, `en-US` với `direction="ltr"` (`rtl` đòi hỏi capability riêng) | `direction="rtl"` khi chưa bật → `422 UNSUPPORTED_CAPABILITY` (`CAPABILITY_DISABLED`) |

### 2.2. Ma trận giới hạn Payload, Composition, Media, Ingest và Quota Tenant

| Nhóm giới hạn | Thông số kỹ thuật khóa cứng (`starter-v1`) | Cơ chế kiểm soát |
| --- | --- | --- |
| HTTP JSON Body | Tối đa `1 MiB` (`1,048,576` bytes) | Chặn ngay tại HTTP ingress trước khi parse JSON, trả `413 PAYLOAD_TOO_LARGE` |
| Client Metadata | Tối đa `4 KiB` (`4,096` bytes), `≤32` keys, `key ≤64` chars, `value ≤256` chars | Không chứa secrets, không ảnh hưởng `render_hash` |
| Cấu trúc Composition | `1..50` scenes; `≤100` layers/scene; `≤500` layers/composition; `≤50` assets/job; `≤16` fonts; `≤16` audio tracks; `≤8` subtitle tracks (`≤500` cues/track, `≤1000` chars/cue) | Kiểm tra tại JSON Schema + Semantic Validator (`P1-02`, `P1-03`) |
| Text & Animation | Text `≤10,000` chars, `font_size` `1..512` px, `max_lines` `1..20` (mặc định `5`), `overflow` mặc định `error`; Animation `2..64` keyframes/thuộc tính | Preflight glyph/box check; cấm tự cắt chữ âm thầm |
| Media Upload & Ingest | File đơn lẻ `≤100 MiB`; tổng input mỗi job `≤500 MiB`; thời lượng media nguồn `≤600s`; ảnh tĩnh `≤40 MP` và mỗi chiều `≤8192` px; file font `.woff2`/`.ttf` `≤32 MiB` | Kiểm tra byte stream thực tế trong quarantine và probe cô lập bằng FFmpeg (`-probesize 32M -analyzeduration 32M`) |
| SVG Sanitization | File SVG `≤5 MiB`, `≤5,000` DOM nodes, độ sâu lồng nhau `≤16` | Cấm `<!DOCTYPE>`, `<!ENTITY>` (XXE), `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`, thuộc tính `on*`, external `href`/`xlink:href` và CSS `url()`/`@import` |
| Rate Limit & Concurrency | Token bucket refill `1 token/s`, burst capacity `20` (`60 req/phút` duy trì); `2` active slots (`preparing/rendering/encoding/verifying/cancel_requested`), `20` pending admission slots (`queued + retry_wait`), tổng `≤22` non-terminal jobs/tenant | Kiểm tra nguyên tử (atomic DB transaction); preview dùng chung quota với render |
| Ngân sách Sandbox Worker | `2 vCPU`, `4096 MiB` RAM, `256` PIDs, `8192 MiB` temp disk; frame readiness timeout `5,000 ms`; render attempt timeout `600s` (deadline `1,800s`); preview attempt timeout `120s` (deadline `300s`); tối đa `3` attempts (backoff `5s`, `30s` + jitter) | Enforced bởi cgroups v2, network namespace `--net=none`, non-root UID |
| Vòng đời lưu trữ (Retention) | Signed upload URL `≤600s`; signed download URL `≤300s`; assets/artifacts/idempotency records `7 ngày`; orphan temp sweep `24 giờ`; job/usage metadata `90 ngày`; security audit logs `180 ngày`; backups `≤30 ngày` | Enforced bởi storage sweeper và chính sách vòng đời dữ liệu |

---

## 3. Chốt quy tắc chuyển cảnh (Scene Transitions) và máy trạng thái (State Transitions)

### 3.1. Chuyển cảnh trong Scene Spec 1.0 (`transition_out`)

1. **Phân nhánh kiểu dữ liệu (`oneOf` trong JSON Schema):**
   - `{"type": "cut", "duration_frames": 0}` (giá trị mặc định nếu lược bỏ `transition_out`; `duration_frames` bắt buộc bằng `0`).
   - `{"type": "fade_to_background", "duration_frames": F}` với `F` là số nguyên thỏa mãn `2 <= F <= min(300, scene.duration_frames)`. Nếu `F > scene.duration_frames`, bộ kiểm tra ngữ nghĩa (semantic validator) từ chối với mã `TIMELINE_BOUNDS` tại con trỏ `/scenes/{i}/transition_out/duration_frames`.
2. **Phạm vi áp dụng và công thức toán học tất định:**
   - `fade_to_background` được phép áp dụng trên bất kỳ scene nào, bao gồm cả scene cuối cùng của composition.
   - Chuyển cảnh chiếm đúng `F` khung hình cuối cùng của scene đang kết thúc: tại khung hình toàn cục `k` thuộc nửa khoảng `[scene_end - F, scene_end - 1]`, độ mờ đục cấp scene được tính chính xác bằng:
     `scene_alpha(k) = (scene_end - 1 - k) / (F - 1)`
   - Độ mờ đục hiệu dụng của từng layer hoạt động trong scene tại khung hình `k` bằng tích `effective_alpha(k) = layer_alpha(k) * scene_alpha(k)` trên nền `canvas.background`.
   - Scene kế tiếp bắt đầu tại `scene_end` với `scene_alpha = 1.0`. Tổng số khung hình của composition (`duration_frames`) không thay đổi.
   - Kiểu `crossfade` chồng lấp hai scene bị khóa ngoài phạm vi v1 để giữ bất biến các scene liên tiếp không giao nhau.

### 3.2. Máy trạng thái của Job (`jobs.state`)

Đã rà soát và bổ sung các cạnh chuyển trạng thái còn thiếu trong [Architecture](../../docs/ARCHITECTURE.md):

| Trạng thái nguồn | Trạng thái đích | Điều kiện kích hoạt (Trigger) | Ghi chú bất biến |
| --- | --- | --- | --- |
| `[*]` | `queued` | Transaction admission commit thành công | Trả HTTP `202 Accepted` |
| `queued` | `preparing` | Dispatcher cấp lease `(attempt_id, lease_epoch)` | Chuyển từ pending slot sang active slot |
| `queued` | `canceled` | Khách gọi `POST /jobs/{id}/cancel` | Terminal ngay lập tức, giải phóng reservation |
| `queued` | `failed` | Vượt `job_deadline_seconds` (`JOB_DEADLINE_EXCEEDED`) hoặc asset bị xóa (`ASSET_REVOKED`) | Cạnh mới được tường minh hóa trong sơ đồ P0-04 |
| `preparing / rendering / encoding / verifying` | `rendering / encoding / verifying / succeeded` | Hoàn thành từng giai đoạn; `verifying -> succeeded` yêu cầu fenced publication transaction | Kiểm tra khớp `(job_id, attempt_id, lease_epoch)` và asset chưa bị thu hồi |
| `preparing / rendering / encoding / verifying` | `retry_wait` | Lỗi tạm thời (worker mất kết nối, lease hết hạn, lỗi storage tạm) và `attempt < max_attempts` | Giữ nguyên slot reservation đã được duyệt khi admission |
| `preparing / rendering / encoding / verifying` | `cancel_requested` | Khách gọi `POST /jobs/{id}/cancel` thắng khóa dòng trước khi publish | Vẫn giữ active slot cho đến khi tiến trình dừng hẳn |
| `preparing / rendering / encoding / verifying` | `failed` | Lỗi vĩnh viễn, hết `max_attempts`, quá hạn deadline, hoặc `ASSET_REVOKED` | Ghi `job.error` chuẩn hóa, không lộ raw stderr |
| `retry_wait` | `queued` | Hết thời gian chờ backoff (`5s` / `30s` + jitter) trong hạn deadline | Đưa lại vào hàng đợi điều phối công bằng theo tenant |
| `retry_wait` | `canceled` | Khách gọi `POST /jobs/{id}/cancel` | Terminal ngay lập tức |
| `retry_wait` | `failed` | Vượt `job_deadline_seconds` (`JOB_DEADLINE_EXCEEDED`) hoặc `ASSET_REVOKED` | Cạnh mới được tường minh hóa trong sơ đồ P0-04 |
| `cancel_requested` | `canceled` | Worker dừng process group (`≤10s`) hoặc reaper thu hồi lease hết hạn | **Đường ra duy nhất**: một khi đã vào `cancel_requested`, job chỉ có thể kết thúc ở `canceled` |

### 3.3. Máy trạng thái của Asset và Webhook Endpoint

- **Asset (`assets.status`):**
  - `uploading -> processing` (`POST /assets/{id}/complete`), `uploading -> rejected` (quá hạn upload grant 10 phút hoặc lệch kích thước/hash), `uploading -> deleted` (`DELETE /assets/{id}`).
  - `processing -> ready` (probe/normalize/sanitize thành công), `processing -> rejected` (file hỏng, sai codec, vi phạm giới hạn SVG/font/ảnh), `processing -> deleted` (`DELETE /assets/{id}`).
  - `ready -> deleted` (`DELETE /assets/{id}` hoặc hết hạn TTL 7 ngày; kích hoạt thu hồi dây chuyền `ASSET_REVOKED` đối với mọi job chưa terminal đang tham chiếu asset).
  - `rejected -> deleted` (`DELETE /assets/{id}` hoặc dọn dẹp định kỳ).
- **Webhook Endpoint (`webhook_endpoints.state`):**
  - `pending_verification -> active` (echo đúng `challenge` 32 bytes có chữ ký HMAC hợp lệ trong `≤5s`), `pending_verification -> disabled` (`DELETE /webhook-endpoints/{id}`).
  - `active -> disabled` (`DELETE /webhook-endpoints/{id}` hoặc máy nhận trả về HTTP `410 Gone`).

---

## 4. Chốt mô hình thực thể đa khách hàng (Tenant Entities & PostgreSQL RLS)

Để chuẩn bị trực tiếp cho nhiệm vụ **P3-01**, cấu trúc cơ sở dữ liệu được khóa với **21 bảng chuẩn** thuộc 10 nhóm thực thể và **5 DB service roles**:

### 4.1. Danh mục 21 bảng và khóa ngoại tổ hợp (`tenant_id`)

1. **Định danh & Chính sách:**
   - `tenants (id PK, status, created_at, updated_at)`
   - `api_keys (tenant_id, id, PK(tenant_id, id), UNIQUE(key_prefix), key_hash, scopes, expires_at, revoked_at)`
   - `policies (tenant_id, policy_version, PK(tenant_id, policy_version), limits_json, active)`
2. **Template Catalog:**
   - `templates (tenant_id, id, PK(tenant_id, id), visibility, source_template_tenant_id, source_template_id, source_template_revision)`
   - `template_revisions (tenant_id, template_id, revision, PK(tenant_id, template_id, revision), variables_schema, defaults_json, composition_spec, supported_locales, source_digest)`
3. **Compositions:**
   - `compositions (tenant_id, id, PK(tenant_id, id), current_revision, template_id, template_revision)`
   - `composition_revisions (tenant_id, composition_id, revision, PK(tenant_id, composition_id, revision), schema_version, spec_json, render_hash, change_note)`
4. **Assets:**
   - `assets (tenant_id, id, PK(tenant_id, id), kind, status, current_version, visibility, rights_json, deleted_at)`
   - `asset_versions (tenant_id, asset_id, version, PK(tenant_id, asset_id, version), original_sha256, normalized_sha256, mime_type, bytes, probe_metadata, storage_key)`
5. **Custom Scene Bundles (Gated P7):**
   - `scene_bundles (tenant_id, id, PK(tenant_id, id), current_revision, status)`
   - `scene_bundle_revisions (tenant_id, bundle_id, revision, PK(tenant_id, bundle_id, revision), source_sha256, build_sha256, entrypoint, parameters_schema, capabilities_json, security_gate_digest)`
6. **Jobs & Execution Leases:**
   - `jobs (tenant_id, id, PK(tenant_id, id), kind, state, state_version, stage, composition_id, composition_revision, profile, snapshot_json, attempt_count, max_attempts, active_attempt_id, lease_epoch, lease_expires_at, cancel_requested_at, deadline_at, error_json)`
   - `job_attempts (tenant_id, job_id, attempt_id, PK(tenant_id, job_id, attempt_id), UNIQUE(tenant_id, job_id, lease_epoch), lease_epoch, worker_id, state, started_at, heartbeat_at, lease_expires_at, ended_at, cpu_seconds, peak_rss_bytes, error_json)`
   - `job_events (tenant_id, job_id, event_seq, PK(tenant_id, job_id, event_seq), state, state_version, event_type, payload_json, created_at)`
7. **Artifacts:**
   - `artifacts (tenant_id, id, PK(tenant_id, id), UNIQUE(tenant_id, job_id, kind), job_id, attempt_id, kind, mime_type, sha256, bytes, storage_key, expires_at, revoked_at)`
8. **Idempotency Store:**
   - `idempotency_records (tenant_id, method, normalized_path, key, PK(tenant_id, method, normalized_path, key), request_hash, state, http_status, response_body_encrypted, resource_id, created_at, expires_at)`
9. **Webhooks & Transactional Outbox:**
   - `outbox (tenant_id, id, PK(tenant_id, id), event_type, job_id, state_version, payload_json, created_at, processed_at)`
   - `webhook_endpoints (tenant_id, id, PK(tenant_id, id), url, state, events_filter, active_key_id, secret_ciphertext, prev_key_id, prev_secret_ciphertext, prev_secret_expires_at)`
   - `webhook_deliveries (tenant_id, id, PK(tenant_id, id), endpoint_id, outbox_event_id, job_id, state, attempt_count, next_attempt_at, deadline_at, last_http_status, replay_count_today)`
10. **Usage & Metering Ledger:**
    - `usage_reservations (tenant_id, job_id, PK(tenant_id, job_id), reserved_vcpu_seconds, reserved_output_seconds, state, created_at, settled_at)`
    - `usage_entries (tenant_id, id, PK(tenant_id, id), UNIQUE(tenant_id, job_id, meter, ledger_version), job_id, attempt_id, usage_class, meter, quantity, rate_version, created_at)`

### 4.2. Sentinel Tenant cho Global Curated Catalog và 5 DB Roles

- **Sentinel Tenant (`system_catalog`):**
  - Để giữ tính nhất quán của khóa ngoại tổ hợp `(tenant_id, ...)` mà không làm rò rỉ dữ liệu giữa các khách hàng, các template mẫu (curated templates) và font chữ chuẩn (Inter, Noto Sans, Roboto) thuộc sở hữu của sentinel tenant cố định `00000000-0000-0000-0000-000000000000` với `visibility = 'curated_public'`.
  - Chính sách RLS cho phép role `cve_api` thực hiện `SELECT` trên các dòng thuộc `current_setting('app.current_tenant_id')::uuid` hoặc các dòng có `(tenant_id = '00000000-0000-0000-0000-000000000000' AND visibility = 'curated_public')`, nhưng chặn tuyệt đối mọi thao tác `INSERT/UPDATE/DELETE` vào `system_catalog` từ `cve_api`.
- **5 DB Roles tách biệt:** `cve_migrator` (DDL & seed `system_catalog`), `cve_api` (HTTP API chịu sự kiểm soát của `FORCE ROW LEVEL SECURITY`), `cve_dispatcher` (điều phối lease/reap/publish), `cve_ingest` (xử lý quarantine sang ready asset), `cve_sender` (xử lý `outbox` và `webhook_deliveries`).

---

## 5. Chốt phân loại lỗi (Error Taxonomy), Lease, Cancel và Idempotency

### 5.1. Quy tắc phân định HTTP 404 vs HTTP 422 và Mã lỗi chuẩn

1. **Tham chiếu trên URL Path vs Tham chiếu trong JSON Body:**
   - Mọi truy vấn mà định danh tài nguyên trên đường dẫn URL (`/v1/assets/{id}`, `/v1/compositions/{id}`, `/v1/jobs/{id}`, ...) không tồn tại **hoặc thuộc về tenant khác** luôn trả về HTTP `404 NOT_FOUND` (không bao giờ trả `403` để chống dò quét IDOR).
   - Khi payload JSON của composition, template hoặc job chứa tham chiếu `asset_id` hoặc `font_id` không tồn tại hoặc thuộc về tenant khác, API trả về HTTP `422 VALIDATION_FAILED` kèm phần tử trong `error.details[]` chỉ rõ JSON Pointer và `code: "ASSET_NOT_FOUND"` hoặc `"UNKNOWN_FONT"`.
2. **Danh mục 13 mã `job.error.code` cho Job thất bại bất đồng bộ:**
   - Nhóm được phép retry tự động khi `attempt < max_attempts`: `RENDER_TIMEOUT`, `FRAME_READINESS_TIMEOUT`, `WORKER_LOST`, `STORAGE_TRANSIENT_ERROR`, `INTERNAL_WORKER_ERROR` (khi chạm `max_attempts`, job chuyển sang `failed` với `retryable: false`).
   - Nhóm lỗi tất định không retry (`retryable: false` ngay lập tức): `SANDBOX_RESOURCE_LIMIT`, `SANDBOX_SECURITY_VIOLATION`, `MEDIA_DECODE_FAILED`, `ENCODE_VERIFICATION_FAILED`, `TEXT_OVERFLOW`, `MISSING_GLYPH`, `ASSET_REVOKED`, `JOB_DEADLINE_EXCEEDED`.

### 5.2. Giao thức Lease, Cancel và Idempotency

1. **Đồng hồ chuẩn tắc và Fencing Token của Render Lease:**
   - Thời hạn lease của render job là `60s`, nhịp tim (heartbeat) `15s` (tách biệt hoàn toàn với coding task lease `600s`/`30s` của AGY supervisor trong `.agy/state.sqlite`).
   - Mọi phép tính `lease_expires_at` và `heartbeat_at` bắt buộc dùng thời gian của máy chủ PostgreSQL (`now()`).
   - Lệnh gia hạn lease và lệnh publish kết quả đều phải kiểm tra khớp bộ ba `(job_id, attempt_id, lease_epoch)` và `lease_expires_at > now()`. Nếu số dòng cập nhật bằng `0`, worker controller phải lập tức hủy tiến trình render (`SIGKILL` process group trong `≤10s`) và không được publish artifact.
2. **Đua khóa dòng giữa Cancel và Publication:**
   - Cả `POST /jobs/{id}/cancel` và transaction publication (`verifying -> succeeded`) đều phải lấy khóa dòng `SELECT ... FOR UPDATE` trên bảng `jobs`.
   - Giao dịch nào commit trước sẽ thắng: nếu publication thắng, lệnh cancel đến sau nhận `409 JOB_TERMINAL`; nếu cancel thắng, job chuyển sang `cancel_requested`, từ chối publication của worker và tiến tới trạng thái cuối `canceled`.
3. **Chuẩn hóa `Idempotency-Key`:**
   - Bắt buộc trên mọi lệnh `POST` (`^[A-Za-z0-9._:-]{1,128}$`).
   - `request_hash` là mã băm SHA-256 (`64 lowercase hex`) của chuỗi JSON đã chuẩn hóa theo **RFC 8785 (JSON Canonicalization Scheme - JCS)** với chuỗi Unicode NFC (body rỗng chuẩn hóa thành `""`).
   - Các phản hồi lỗi từ chối trước hoặc trong khi admission (`400`, `401`, `403`, `404`, `409`, `413`, `422`, `429 RATE_LIMITED`, `429 QUOTA_EXCEEDED`, `503 SERVICE_UNAVAILABLE`) phải rollback/release bản ghi claim để client có thể retry an toàn với cùng `Idempotency-Key` sau thời gian `Retry-After`.

---

## 6. Danh mục 10 Ambiguity Issues đã mở và giải quyết (`AMB-001` .. `AMB-010`)

| Mã Issue | Mô tả điểm mơ hồ (Ambiguity) | Quyết định chốt & Tài liệu đã cập nhật |
| --- | --- | --- |
| `AMB-001` | Chưa rõ mã lỗi khi payload hợp lệ với JSON Schema (`duration_frames <= 10800`, `canvas <= 3840`) nhưng vượt giới hạn profile `starter-v1` (`mp4-720p-v1` `<= 1800` frames). | Tách rõ 3 tầng: lỗi Schema/Semantic trả `422 VALIDATION_FAILED`; vượt giới hạn profile/capability trả `422 UNSUPPORTED_CAPABILITY` kèm detail `PROFILE_CONSTRAINT_VIOLATED` hoặc `CAPABILITY_DISABLED`. Cập nhật [PRD](../../docs/PRD.md), [SCENE-SPEC](../../docs/SCENE-SPEC.md), [API](../../docs/API.md). |
| `AMB-002` | `fade_to_background` chưa khóa ngưỡng trên của `F` so với `scene.duration_frames` và chưa nêu rõ có hợp lệ ở scene cuối cùng hay không. | Khóa `cut` có `duration_frames = 0`; `fade_to_background` có `2 <= F <= min(300, scene.duration_frames)` (vượt `scene.duration_frames` báo `TIMELINE_BOUNDS`), hợp lệ trên mọi scene kể cả scene cuối. Cập nhật [SCENE-SPEC](../../docs/SCENE-SPEC.md). |
| `AMB-003` | Sơ đồ trạng thái thiếu cạnh `queued/retry_wait -> failed` khi quá hạn/thu hồi asset, và chưa tách biệt kết quả hủy của khách (`canceled`) với xóa asset (`failed`). | Cập nhật sơ đồ Mermaid trong [ARCHITECTURE](../../docs/ARCHITECTURE.md) và [SECURITY](../../docs/SECURITY.md): bổ sung `queued/retry_wait -> failed`, khóa `cancel_requested -> canceled` là nhánh thoát duy nhất, và quy định `DELETE /assets/{id}` chuyển job sang `failed` (`ASSET_REVOKED`). |
| `AMB-004` | Nguy cơ job đã qua admission khi gặp lỗi tạm thời chuyển về `retry_wait` bị chặn ngược bởi giới hạn 20 pending slots. | Chốt kiểm tra tại thời điểm admission: `count(queued + retry_wait) < 20` và `count(non_terminal) < 22`; job đã qua admission khi chuyển về `retry_wait` giữ nguyên reservation. Cập nhật [PRD](../../docs/PRD.md), [API](../../docs/API.md), [ARCHITECTURE](../../docs/ARCHITECTURE.md). |
| `AMB-005` | Nếu lưu cứng lỗi `429 QUOTA_EXCEEDED` vào `idempotency_records`, client retry cùng `Idempotency-Key` theo hướng dẫn sẽ bị kẹt vĩnh viễn ở lỗi 429. | Quy định chuẩn hóa RFC 8785 JCS SHA-256 và bắt buộc rollback/release claim đối với mọi lỗi `400/401/403/404/409/413/422/429/503`; chỉ lưu bền các mutation thành công (`200/201/202`). Cập nhật [API](../../docs/API.md). |
| `AMB-006` | Làm thế nào lưu trữ curated templates và system fonts dùng chung khi mọi bảng đều bắt buộc khóa ngoại tổ hợp chứa `tenant_id` và bật RLS? | Thiết lập sentinel tenant `00000000-0000-0000-0000-000000000000` (`system_catalog`, `visibility='curated_public'`) chỉ đọc đối với `cve_api` dưới RLS, cùng 21 bảng và 5 DB roles cho `P3-01`. Cập nhật [ARCHITECTURE](../../docs/ARCHITECTURE.md). |
| `AMB-007` | Chưa phân biệt rõ khi nào `asset_id` không tồn tại/thuộc tenant khác trả HTTP `404` và khi nào trả HTTP `422`. | Định danh trên URL path trả HTTP `404 NOT_FOUND`; tham chiếu `asset_id`/`font_id` bên trong JSON body trả HTTP `422 VALIDATION_FAILED` kèm detail `ASSET_NOT_FOUND`/`UNKNOWN_FONT`. Cập nhật [API](../../docs/API.md). |
| `AMB-008` | Chưa liệt kê danh sách đóng các mã lỗi `job.error.code` cho các job thất bại trong quá trình xử lý bất đồng bộ. | Chuẩn hóa 13 mã `job.error.code` (5 mã cho phép retry đến `max_attempts`, 8 mã lỗi tất định không retry). Cập nhật [API](../../docs/API.md). |
| `AMB-009` | Nguy cơ lệch đồng hồ (clock skew) giữa các node worker và DB khi kiểm tra hạn lease 60s, cũng như nhầm lẫn với lease 10 phút của AGY task. | Bắt buộc dùng thời gian máy chủ PostgreSQL (`now()`) cho mọi phép tính lease 60s/heartbeat 15s và phân biệt rõ với lease 10 phút của AGY coding task. Cập nhật [ARCHITECTURE](../../docs/ARCHITECTURE.md). |
| `AMB-010` | Cần lượng hóa ngưỡng chặn SVG bomb/XXE tại bước ingest và đồng bộ danh sách chặn package từ `P0-02` vào tài liệu bảo mật. | Khóa giới hạn SVG (`≤5 MiB`, `≤5000` DOM nodes, depth `≤16`, cấm XXE/script/foreignObject/external refs) và cập nhật danh sách cấm `hyperframes` CLI, `@hyperframes/engine`, `puppeteer` full, `--no-sandbox`, FFmpeg `--enable-nonfree` vào [SECURITY](../../docs/SECURITY.md). |

---

## 7. Kết quả kiểm tra xác thực thực tế (Verification Results)

Đã thực thi bộ công cụ kiểm tra tính toàn vẹn của kho chứa và bộ kiểm thử đơn vị của harness:

1. **Kiểm tra cấu trúc kho chứa, tài liệu, liên kết nội bộ, khối JSON và đồ thị DAG:**
   ```bash
   PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
   ```
   - Exit code: `0` (`PASS`, `0` errors, `0` warnings).
2. **Kiểm thử hồi quy bộ điều phối supervisor (`tooling/agent_harness/tests/test_supervisor.py`):**
   ```bash
   PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v
   ```
   - Exit code: `0` (`Ran 10 tests`, `OK`).

---

## 8. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer Sign-off:** Chờ reviewer độc lập kiểm tra báo cáo bằng chứng `P0-04`, đối chiếu diff tài liệu hợp đồng và phê duyệt tích hợp vào nhánh `staging`.
2. **Downstream Implementation Verification Gates:**
   - `P0-05`: Hiện thực hóa sổ cái trạng thái `.agy/state.sqlite` và kiểm thử cơ chế thu hồi lease bằng trạng thái giả lập.
   - `P1-02`: Biên dịch các quy tắc đã chốt trong `P0-04` thành các tệp JSON Schema 2020-12 và OpenAPI 3.1 thực thi tự động kèm bộ test mẫu hợp lệ/không hợp lệ.
   - `P3-01`: Hiện thực hóa migration PostgreSQL cho 21 bảng, 5 roles, chính sách RLS và bộ kiểm thử chống IDOR xuyên tenant.

## 9. Kết luận

Task **P0-04** đã hoàn thành đầy đủ mọi yêu cầu nghiệm thu trong phạm vi được giao (`evidence/P0-04/` và `docs/`). Trạng thái tại worktree cục bộ là **`implemented_local`**, sẵn sàng cho bước kiểm duyệt độc lập và CI trên nhánh `staging`.
