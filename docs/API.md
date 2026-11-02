# REST API v1 — hợp đồng dự kiến

Chưa có server/OpenAPI đang chạy. `P1-02` phải chuyển hợp đồng này thành OpenAPI 3.1 và contract fixtures; [Scene spec](SCENE-SPEC.md) thành JSON Schema 2020-12. Base URL minh họa `https://video.example.invalid/v1`. UUID/opaque IDs trong ví dụ là ký hiệu ngắn, không secrets thật.

## Quy tắc chung

- TLS bắt buộc ngoài loopback dev. `Authorization: Bearer <tenant-api-key>`. API key lưu hash; scopes `templates:read/write`, `compositions:read/write`, `assets:read/write`, `jobs:read/write`, `webhooks:manage`, `usage:read`, `authoring:write`. Tenant lấy từ key; không nhận `tenant_id` trong body. Không dùng tenant key ở browser public.
- JSON UTF-8, thời gian RFC3339 UTC. `X-Request-Id` response do server sinh/validate; metadata client ≤4 KiB, không dùng làm routing/auth. Body unknown fields bị 422; response additive fields client phải bỏ qua.
- `Idempotency-Key` bắt buộc mọi POST (1–128 ký tự ASCII `[A-Za-z0-9._:-]`; sai định dạng trả 400 `INVALID_IDEMPOTENCY_KEY`, thiếu trả 400 `IDEMPOTENCY_KEY_REQUIRED`). GET/DELETE không cần. Key scoped theo `(tenant_id, method, normalized_path, key)` với `normalized_path` giữ tiền tố `/v1/...`, bỏ dấu `/` cuối, không query string; `request_hash` tính bằng SHA-256 (`64 lowercase hex`) trên chuỗi JSON canonical hóa theo RFC 8785 (JCS, Unicode NFC, body rỗng chuẩn hóa thành `""`), không tính raw whitespace hay auth token. Record giữ 7 ngày, quá hạn có thể tạo thao tác mới; client lưu job ID để tránh retry mù sau thời hạn.
- Cùng key/body trả nguyên status/body resource IDs của lần đầu, header `Idempotency-Replayed: true`; job có thể đã tiến triển, hãy GET status. Khác body trả 409 `IDEMPOTENCY_CONFLICT`. Đồng thời cùng key có unique constraint/transaction: chờ ngắn rồi 409 `IDEMPOTENCY_IN_PROGRESS` kèm `Retry-After: 1`. Các lỗi từ chối trước hoặc trong khi admission (`400`, `401`, `403`, `404`, `409`, `413`, `422`, `429 RATE_LIMITED`, `429 QUOTA_EXCEEDED`, `503 SERVICE_UNAVAILABLE`) phải rollback/release idempotency claim, tuyệt đối không lưu cứng lỗi `429`/`503` vào `idempotency_records` để client có thể retry an toàn với cùng `Idempotency-Key` sau `Retry-After`. Chỉ các POST mutation đã commit thành công (`200`, `201`, `202`) mới chốt record `completed`; commit rồi mất kết nối mạng sẽ replay đúng resource.
- Với `POST /jobs/{id}/cancel`: nếu gửi lại cùng `Idempotency-Key` và cùng body sẽ replay nguyên response ban đầu kèm `Idempotency-Replayed: true`; nếu gửi bằng `Idempotency-Key` mới khi job đang `cancel_requested` trả `202 Accepted`, khi job đã `canceled` trả `200 OK` (state confirmation), còn khi job đã `succeeded` hoặc `failed` trả `409 JOB_TERMINAL`.
- Các POST có side effect DB đều claim key và mutation trong cùng transaction. Endpoint có signed upload URL lưu resource/session ID; replay trả cùng session, nếu URL hết hạn dùng endpoint refresh thay vì upload lại resource.
- Ngoại lệ replay chứa secret: webhook endpoint create/rotate chỉ trả signing secret ở response đầu, không lưu plaintext secret vào idempotency response. Replay giữ resource/key IDs và status, trả `secret_redacted:true` thay secret; mất response đầu thì rotate bằng key mới (kể cả endpoint còn pending). Secret gốc encrypted trong secret store cho sender, không đọc lại qua GET. Các response có signed grants được encrypt at rest trong idempotency store và không log.
- Pagination `?limit=20&cursor=...`, max 100, cursor opaque/signed gắn tenant/filter, sort `(created_at,id)` ổn định. Response `{ "data": [], "next_cursor": null }`. Foreign/not-found ID đều 404.
- `/v1` major ổn định; additive response changes có thể thêm, breaking request/meaning cần v2. Scene schema version độc lập. Deprecation tối thiểu 90 ngày có changelog và headers `Deprecation`, `Sunset`, `Link` (mục tiêu policy trước GA).

## Endpoint catalog

| Method/path dưới `/v1` | Scope | Thành công / ý nghĩa |
| --- | --- | --- |
| GET `/capabilities` | jobs:read | 200 engines/profiles/limits/feature flags của tenant |
| GET `/templates` | templates:read | 200 curated + tenant catalog, `visibility` rõ ràng |
| GET `/templates/{id}/revisions/{revision}` | templates:read | 200 exact immutable schema/defaults/spec |
| POST `/templates` | templates:write | 201 tenant template revision 1 |
| POST `/templates/{id}/revisions` | templates:write | 201 revision mới, `base_revision` bắt buộc |
| POST `/templates/{id}/instantiate` | compositions:write + templates:read | 201 composition revision 1, exact template revision/variables |
| POST `/compositions` | compositions:write | 201 từ full scene document |
| GET `/compositions/{id}` | compositions:read | 200 metadata/current revision |
| GET `/compositions/{id}/revisions/{revision}` | compositions:read | 200 immutable document + ETag hash |
| POST `/compositions/{id}/revisions` | compositions:write | 201 full replacement + base_revision, optimistic concurrency |
| POST `/compositions/validate` | compositions:write | 200 valid + estimates/warnings, hoặc 422; không render |
| POST `/assets/uploads` | assets:write | 201 quarantine asset/session + upload grant |
| POST `/assets/{id}/upload-url` | assets:write | 200 refresh grant cho session còn mở |
| POST `/assets/{id}/complete` | assets:write | 202 probe/normalize async, GET asset để theo dõi |
| POST `/assets/imports` | assets:write | 202 remote import nếu enabled/allowlisted |
| GET `/assets/{id}` | assets:read | 200 `uploading/processing/ready/rejected/deleted` + safe metadata |
| DELETE `/assets/{id}` | assets:write | 202 revoke + async deletion; repeated 202 |
| POST `/previews` | jobs:write | 202 job kind preview |
| POST `/render-jobs` | jobs:write | 202 job kind render |
| GET `/jobs` | jobs:read | 200 list; filter kind/state, cursor |
| GET `/jobs/{id}` | jobs:read | 200 status, stage, attempts, artifact IDs |
| POST `/jobs/{id}/cancel` | jobs:write | 202 cancel accepted, 200 already canceled, 409 other terminal |
| GET `/jobs/{id}/events` | jobs:read | 200 ordered event sequence, pagination |
| GET `/artifacts/{id}/download` | jobs:read | 200 `{url,expires_at,sha256,bytes}`; URL ≤5min |
| POST `/webhook-endpoints` | webhooks:manage | 201 endpoint pending verification, secret shown once |
| POST `/webhook-endpoints/{id}/verify` | webhooks:manage | 202 challenge delivery; activate after signed echo handshake |
| GET `/webhook-endpoints/{id}` | webhooks:manage | 200 state + delivery summary, never secret |
| POST `/webhook-endpoints/{id}/rotate-secret` | webhooks:manage | 201 new secret once, previous valid 24h |
| DELETE `/webhook-endpoints/{id}` | webhooks:manage | 204 disabled; pending deliveries stop |
| GET `/webhook-deliveries` | webhooks:manage | 200 status/filter job ID |
| POST `/webhook-deliveries/{id}/replay` | webhooks:manage | 202 new delivery attempt, same event_id |
| GET `/usage?from=...&to=...` | usage:read | 200 settled/pending units and estimated cost, ≤31-day window |

Assets/fonts/bundles references phải tồn tại và thuộc tenant hoặc approved global catalog. Revision create với stale `base_revision` trả 409 `REVISION_CONFLICT`; server không merge mù. Exact revision mandatory khi instantiate/submit; không hỗ trợ `latest` trong jobs. Template edits gồm full spec, variables schema/defaults và change note; fork curated template bằng POST tenant template với `source_template` provenance, không mutate catalog.

Rate limiter starter dùng token bucket refill 1 token/giây, capacity 20, tính theo tenant và API key cap không vượt tenant cap; returned 429 có Retry-After và request ID. Tại thời điểm admission (`POST /render-jobs`, `POST /previews`), hệ thống kiểm tra đồng thời `count(queued + retry_wait) < 20` (20 pending admission slots) và tổng non-terminal jobs `< 22`; các trạng thái `preparing/rendering/encoding/verifying/cancel_requested` tính vào 2 active slots đến khi process group thực sự dừng hoặc lease được reaper thu hồi. Một job đã qua admission khi chuyển từ active về `retry_wait` giữ nguyên slot reservation đã cấp, không bị từ chối ngược bởi ngưỡng admission. Budget/slot checks atomic trong admission/claim (khóa hàng tenant policy/counter), không chỉ đếm rows rồi insert không khóa. Preview dùng cùng giới hạn.

`GET /capabilities` trả `{api_version,scene_schema_versions,engines,profiles,limits,features,policy_version}`. Mỗi profile có ID immutable, dimensions rules/fps/container/codecs/max_duration và adapter/runtime capability revision. `mp4-720p-v1`: 1280×720 hoặc 720×1280 canvas, 30/1 fps, opaque sRGB/yuv420p H.264 + AAC 48kHz stereo khi có audio, faststart; encoder/build/config cụ thể được pin sau P0 review/P2 benchmark trước công bố profile là supported. `preview-360p-v1` scale chính xác 0.5 từ các canvas 720p đó, giữ fps; PNG cho mode frame, MP4 cho clip. Không upscale hoặc tự crop theo profile. Profile khác phải được công bố trước admission; supported=false khi runtime chưa có.

## Ví dụ template và composition

`POST /templates/tpl_promo/instantiate`, key `promo-campaign-001`:

```json
{
  "template_revision": 3,
  "name": "Khuyến mãi tháng 11",
  "variables": {"headline": "Ưu đãi hôm nay", "price": "199.000 ₫", "image_asset_id": "ast_product"},
  "locale": "vi-VN"
}
```

201 trả:

```json
{"id":"cmp_promo","revision":1,"template":{"id":"tpl_promo","revision":3},"schema_version":"1.0","editable":true}
```

GET template revision trả `id`, `revision`, `name`, `variables_schema`, `defaults`, `composition_spec`, `supported_locales`, `required_capabilities`, `source_digest`; biến không phải code interpolation. Text escape, asset variable là typed reference, không HTML tùy ý. `POST /compositions` body `{ "name": "Demo", "spec": <scene document> }`; revision mới body `{ "base_revision": 1, "spec": <full document>, "change_note": "Đổi tiêu đề" }`. Scene IDs ổn định, scene revision tăng theo nội dung, xem [Scene spec](SCENE-SPEC.md).

`POST /templates` nhận `name` (1–200 chars), `variables_schema`, `defaults`, `composition_spec`, `supported_locales`, optional `source_template:{id,revision}`; response `{id,revision:1,source_digest}`. Template revision create nhận các trường content tương tự cộng `base_revision` và `change_note` (≤1000 chars), trả revision mới. Variable schema chỉ JSON types/bounds/enums và local `$defs`, không remote `$ref`/executable defaults. Bindings được lưu riêng trong `composition_spec` template dưới dạng typed `{variable:"name"}` ở vị trí field phù hợp; sau instantiate phải materialize thành Scene Spec 1.0 thuần, không giữ binding trong composition renderable. Required variables thiếu/unknown/type sai → 422; defaults chỉ áp dụng trường absent, không tự thay null.

Binding v1 chỉ ở layer `content.text`, `content.asset_id`, `content.color`, `content.fill`, `content.font_size`, và `box.x/y/width/height`. `asset_id` variable phải là ready authorized media đúng type; không thay engine/bundle entrypoint/font hash qua variables. Timeline/locale/font/scene edits dùng full composition revision hoặc template revision được validate. Name của biến pattern `[a-z][a-z0-9_]{0,63}`, max 64 variables/template; string max 10000 chars, number finite/bounded theo field; template phải validate cả defaults và instantiated result.

`POST /compositions/validate` body `{spec,profile}` và optional `base_composition_id,base_revision` cùng xuất hiện khi validate edit; response `{valid:true,normalized_spec,render_hash,required_capabilities,estimate:{output_seconds,estimated_cost,currency,rate_version},warnings:[]}`. Estimate chỉ advisory, admission vẫn revalidate/reserve. Response max cùng bounded spec size; cảnh báo không thay lỗi security/rights/unsupported. P1 OpenAPI phải expand các response metadata/asset/status shapes trong catalog, không để `any` cho resource identifiers/timing/errors.

## Asset intake

`POST /assets/uploads` body gồm `filename`, `mime_type`, `bytes`, `sha256`, `rights: {basis, source, attribution, expires_at}`. `basis` enum `owned`, `licensed`, `public_domain`; source là mô tả/provenance, không lệnh fetch. Response có `asset_id`, `upload_method`, `upload_url`, `required_headers`, `expires_at`, `max_bytes`. Signed grant ≤10min, private quarantine key server sinh, limit bytes/checksum enforced. Client PUT bytes rồi POST complete `{ "sha256": "<64 lowercase hex>" }`. Probe async reject mismatch/unsupported; `ready` mới render được. Raw URL không được đưa vào scene spec.

Remote import body `{ "url": "https://approved-stock.example.invalid/clip.mp4", "expected_sha256": "<64 hex>", "rights": {...} }`; URL phải allowlist, không credentials/query token log, SSRF rules ở [Security](SECURITY.md). Feature mặc định off. Upload là baseline khi không có licensed stock connector.

## Preview, render và status

`POST /previews`:

```json
{"composition_id":"cmp_promo","revision":1,"mode":"clip","start_frame":0,"duration_frames":300,"profile":"preview-360p-v1","webhook_endpoint_id":"wh_demo"}
```

`mode=frame` dùng `frame_index` và không có start/duration; output PNG. Clip range nằm trong composition và ≤10s. Preview scaling không sửa design canvas; cùng fps/timing. `webhook_endpoint_id` optional, phải active; endpoint URL không nhận trực tiếp trong render body.

Clip preview lấy source frames `[start_frame,start_frame+duration_frames)`, export timestamps bắt đầu 0; audio/cues giao với range được trim rồi trừ source start theo cùng rational sample conversion. Seek renderer vẫn dùng source frame index để giữ animation đúng, không restart scene từ 0. Frame preview lấy exact source frame, không audio. Range ngoài bounds trả 422, không tự clamp.

`POST /render-jobs`:

```json
{
  "composition_id":"cmp_promo",
  "revision":1,
  "profile":"mp4-720p-v1",
  "webhook_endpoint_id":"wh_demo",
  "client_reference":"campaign-2026-11-001",
  "metadata":{"campaign":"november"}
}
```

202 + `Location: /v1/jobs/job_demo` + `Retry-After: 2`:

```json
{"id":"job_demo","kind":"render","state":"queued","state_version":1,"composition_id":"cmp_promo","revision":1,"profile":"mp4-720p-v1","created_at":"2026-11-02T06:00:00Z","status_url":"/v1/jobs/job_demo"}
```

Job GET sau thành công:

```json
{
  "id":"job_demo","kind":"render","state":"succeeded","state_version":6,
  "stage":"complete","progress":1,"attempt":1,"max_attempts":3,
  "composition_id":"cmp_promo","revision":1,"profile":"mp4-720p-v1",
  "artifacts":[{"id":"art_video","kind":"video","mime_type":"video/mp4"},{"id":"art_manifest","kind":"manifest","mime_type":"application/json"}],
  "usage":{"output_seconds":15,"cpu_seconds":72,"billable_output_minutes":0.25},
  "error":null,"created_at":"2026-11-02T06:00:00Z","completed_at":"2026-11-02T06:00:40Z"
}
```

Số liệu trên chỉ minh họa, chưa đo. Output profile quyết định codec/scale; không override arbitrary FFmpeg flags. Status states theo [Architecture](ARCHITECTURE.md); `cancel_requested` chưa terminal. Failed job có `error.code`, safe message, `retryable` và request ID; không raw stderr/source. Danh mục chuẩn `job.error.code` cho job thất bại bất đồng bộ gồm: `RENDER_TIMEOUT`, `FRAME_READINESS_TIMEOUT`, `WORKER_LOST`, `STORAGE_TRANSIENT_ERROR`, `INTERNAL_WORKER_ERROR` (được phép retry đến `max_attempts`, sau đó terminal `failed` với `retryable: false`); và các lỗi deterministic không retry (`retryable: false` ngay lập tức): `SANDBOX_RESOURCE_LIMIT`, `SANDBOX_SECURITY_VIOLATION`, `MEDIA_DECODE_FAILED`, `ENCODE_VERIFICATION_FAILED`, `TEXT_OVERFLOW`, `MISSING_GLYPH`, `ASSET_REVOKED`, `JOB_DEADLINE_EXCEEDED`. Artifact list còn có thumbnail/captions/quality_report khi profile hỗ trợ. URL hết hạn lấy URL mới, không rerender. Artifact retention hết trả 410 `ARTIFACT_EXPIRED`.

Client retry 429/503 theo Retry-After; network timeout/5xx retry exponential 1–30s với jitter và cùng key. 4xx validation/auth không retry mù. Poll 2s tăng tới 10s, dừng terminal; webhook hỗ trợ giảm polling nhưng không thay thế reconciliation.

## Signed webhooks

Endpoint HTTPS 443, allowlist theo tenant, ownership challenge trước active, SSRF checks như ingest và không redirect. Registration body `{ "url": "https://client.example.invalid/hooks/video", "events": ["job.succeeded","job.failed","job.canceled"] }`. Verify gửi event `endpoint.challenge`, random challenge 32 bytes, receiver kiểm HMAC rồi trả JSON `{ "challenge": "<exact received value>" }` trong ≤5s; challenge sống 10min, one-use. Endpoint chỉ active sau echo đúng; secret không gửi trong payload.

```json
{"id":"evt_demo","type":"job.succeeded","api_version":"v1","created_at":"2026-11-02T06:00:40Z","data":{"job_id":"job_demo","state":"succeeded","state_version":6,"client_reference":"campaign-2026-11-001","artifact_ids":["art_video","art_manifest"]}}
```

Headers `X-CVE-Event-Id`, `X-CVE-Timestamp` (Unix seconds), `X-CVE-Key-Id`, `X-CVE-Signature: v1=<hex>`. Ký `HMAC-SHA256(secret, timestamp + "." + raw_body_bytes)`; timestamp là ASCII decimal, body UTF-8 exact bytes. Receiver constant-time compare, reject clock skew >300s, dedupe event ID ≥7 ngày, ghi event bền trước 2xx, rồi GET authoritative job theo tenant key. Không reserialize JSON trước verify. Retry dùng timestamp/signature mới, cùng event ID/body; replay cũng cùng event ID. `state_version` giúp bỏ event cũ; ordering không được bảo đảm.

Timeout connect 2s, total 5s, response body cap 8 KiB; 2xx ack, 410 disable, 3xx không follow, 429/5xx/network retry. Lịch 8 attempts tổng tại t=0, 1min, 5min, 15min, 1h, 4h, 12h, 24h (+jitter ≤10%); mọi delay/jitter/Retry-After clamp không vượt deadline 25h. Các 4xx khác dead-letter và alert cấu hình. Replay giới hạn 5/ngày/delivery và trong 7 ngày từ event creation, giữ audit; sau đó 410 `DELIVERY_EXPIRED`, client dùng GET status để reconcile. Endpoint bị xóa thì không gửi tiếp. Không có URL artifact dài hạn hoặc nội dung riêng tư trong callback.

## Errors, metering và optional authoring

```json
{"error":{"code":"VALIDATION_FAILED","message":"Composition không hợp lệ","request_id":"req_demo","retryable":false,"details":[{"pointer":"/spec/scenes/0/duration_frames","code":"OUT_OF_RANGE","message":"Phải lớn hơn 0"}]}}
```

| HTTP | Code tiêu biểu | Hành động client |
| --- | --- | --- |
| 400 | MALFORMED_JSON, IDEMPOTENCY_KEY_REQUIRED, INVALID_IDEMPOTENCY_KEY, INVALID_CURSOR, INVALID_QUERY_PARAM | Sửa request |
| 401/403 | UNAUTHENTICATED, INSUFFICIENT_SCOPE, TENANT_SUSPENDED | Sửa/rotate key; không leak resource (foreign ID luôn trả 404, không trả 403) |
| 404/410 | NOT_FOUND, ARTIFACT_EXPIRED, INPUT_EXPIRED, DELIVERY_EXPIRED, ASSET_DELETED | Kiểm ID trên URL path/retention |
| 409 | REVISION_CONFLICT, IDEMPOTENCY_CONFLICT, IDEMPOTENCY_IN_PROGRESS, ASSET_NOT_READY, JOB_TERMINAL, WEBHOOK_NOT_VERIFIED | Đọc trạng thái, xử lý riêng |
| 413 | PAYLOAD_TOO_LARGE | Giảm bytes (HTTP body ≤1 MiB) |
| 422 | VALIDATION_FAILED, UNSUPPORTED_CAPABILITY, ASSET_POLICY_REJECTED | Sửa spec/assets; tham chiếu `asset_id`/`font_id` không tồn tại hoặc thuộc tenant khác bên trong JSON body trả 422 `VALIDATION_FAILED` kèm detail `ASSET_NOT_FOUND`/`UNKNOWN_FONT` |
| 429 | RATE_LIMITED, QUOTA_EXCEEDED | Retry-After cùng `Idempotency-Key`; không đổi key để né quota |
| 503 | SERVICE_UNAVAILABLE | Retry cùng `Idempotency-Key` |

Quy tắc phân định HTTP status và detail code (chốt tại [P0-04 report](../evidence/P0-04/report.md)): tài nguyên trên đường dẫn URL (`/v1/assets/{id}`, `/v1/jobs/{id}`, ...) không tồn tại hoặc thuộc tenant khác luôn trả HTTP `404 NOT_FOUND`; ngược lại, khi payload JSON của composition/template/job tham chiếu tới `asset_id` hoặc `font_id` không tồn tại/thuộc tenant khác, API trả HTTP `422 VALIDATION_FAILED` với phần tử `details[]` chứa JSON Pointer và `code: "ASSET_NOT_FOUND"` hoặc `"UNKNOWN_FONT"`. Vi phạm giới hạn của profile (`mp4-720p-v1`, `preview-360p-v1`) hoặc engine chưa bật trả HTTP `422 UNSUPPORTED_CAPABILITY` kèm detail `PROFILE_CONSTRAINT_VIOLATED` hoặc `CAPABILITY_DISABLED`.

Usage tách `operational` (mọi attempt, kể cả failed) và `billable` (logical succeeded render, không duplicate; preview mặc định miễn output-minute nhưng vẫn quota/cost). Billable output-minute = exact output_seconds/60, aggregate rồi làm tròn 6 decimals; không làm tròn mỗi job thành 1 phút. Không thanh toán tiền trong v1. Reserve estimated max cost; settle actual/release surplus, debit tenant limit atomic. Price/rate version ghi kèm estimate; không hứa compute cost là invoice.

Sau P7 mới expose `POST /authoring-jobs` (202) và `GET /authoring-jobs/{id}` với scope authoring:write: input brief/locale/approved_asset_ids/provider_preference/budget; output draft composition/bundle revision và validation report. Không auto-render draft. `POST /scene-bundles`/`POST /scene-bundles/{id}/revisions` upload source qua quarantine theo asset pattern; exact endpoint schema phải bổ sung OpenAPI trước bật flag. Build isolation, provider timeouts, no shell privilege và approval state theo [Security](SECURITY.md). Đây là extension chưa thuộc MVP, không giả endpoint đã có.
