# PRD — video dựng bằng code

Thiết kế v0.1, 2026-11-02. Các chỉ tiêu là mục tiêu cần đo. Hợp đồng: [API](API.md), [Scene spec](SCENE-SPEC.md), [Architecture](ARCHITECTURE.md).

## Người dùng và giá trị

Creativanta cần video nhất quán thương hiệu, có phụ đề tiếng Việt, sửa được từng cảnh và dự đoán chi phí. Dịch vụ nhận dữ liệu/template/scene code, render bất đồng bộ và trả artifact cùng manifest/usage để client phân phối.

| Người dùng | Công việc | Bằng chứng giá trị |
| --- | --- | --- |
| Developer Creativanta/B2B | Submit/status/callback không timeout | Retry không tạo job/billing trùng |
| Marketing/content creator | Sửa text, logo, nhạc, scene giữ brand | Revision độc lập, preview, 3 template editable |
| Operator | CPU tiết kiệm, debug an toàn | Manifest, tracing, kill/retry, cost/tenant |
| Agent sáng tạo | Sinh scene mới khi template không đủ | Editable draft, validation và sandbox |

## Video families và use cases

| Family | Input | Output | Mức ưu tiên |
| --- | --- | --- | --- |
| Product promo | Text, giá, logo, ảnh/footage hợp lệ | 15–30s, 9:16, typography/chuyển cảnh | MVP, POC-01 |
| Explainer/infographic | Data, script, SVG, narration | 30–60s, 16:9, biểu đồ theo timeline | MVP, POC-02 |
| Captioned footage | Clip, voice/music, subtitle cues | 30–60s, 9:16, crop/phụ đề Việt | MVP, POC-03 |
| Batch personalized | Template + nhiều bộ biến | Nhiều job độc lập có quota/metering | Sau core API |
| Walkthrough | Screenshot/video upload sẵn | 16:9, zoom/callout | Sau MVP; không đăng nhập account khách |
| AI-authored scene | Brief + approved assets + adapter | Bundle editable, preview | Sau security gate |

Flow MVP: upload/import asset → `ready` → chọn exact template revision → instantiate variables → composition revision immutable → preview → render MP4 → callback → signed artifact URL ngắn hạn. Sửa composition tạo revision; job cũ giữ snapshot. Có thể bỏ preview, không bỏ validation.

## Yêu cầu

- Must: REST `/v1`, tenant API key/scopes, quota/idempotency, async job, polling/cancel, HMAC webhook, MP4 H.264/AAC (encoder phải qua license review), thumbnails, SRT/VTT, manifest, usage.
- Must: template variable schema/version; composition và scene có revision; asset ID/hash; audio upload; phụ đề Việt; seek theo frame; CPU không GPU.
- Must: tenant boundary ở DB/storage/queue/artifact, Chromium sandbox kể cả template tin cậy, SSRF protection, timeout/cost reservation, error ổn định.
- Should: TTS adapter CPU hoặc provider giá thấp, cache tenant/content hash; voice/model license phải review. Không có TTS vẫn render với audio upload hoặc silence. Subtitle cues do client cung cấp là baseline; forced alignment không bắt buộc.
- Should: cùng compiler cho preview/export, manifest tái lập, retention, callback replay, usage report và renderer capabilities.
- Could: browser export WebCodecs, editor UI, PixiJS/Motion Canvas scenes, custom code sau P7. Không chặn MVP vì các nhánh này.

## NFR và policy `starter-v1`

| Thuộc tính | Default/mục tiêu |
| --- | --- |
| MVP | 720×1280 hoặc 1280×720, 30/1 fps, ≤60s; MP4 yuv420p, audio 48kHz |
| Sau benchmark | ≤1920×1080 hoặc 1080×1920, ≤60/1 fps, ≤180s; chỉ capability đã đo |
| Payload | JSON ≤1 MiB, ≤50 scenes, ≤500 layers/composition, ≤50 assets/job |
| Tenant | 2 running, 20 queued, 60 requests/minute, burst 20; preview chung quota |
| Media | ≤100 MiB/file, ≤500 MiB input/job, ≤600s/media ingest; không archive tùy ý |
| API | p95 submit/status <500ms không tính upload/render, theo workload Testing |
| Reliability | Không mất accepted job; at-least-once, single logical publication/usage |
| Quality | 3 POC decode hết, đúng frame count; audio/caption anchor lệch ≤1 frame; đủ dấu Việt |
| Cost | CPU-seconds, wall time, peak RSS, storage/egress/TTS; POC compute target ≤0.05 USD/video-minute với giá giả định được ghi |
| Isolation | Zero cross-tenant access trong suite; thiếu sandbox evidence thì custom off |
| Retention | Inputs/artifacts 7 ngày; job metadata/usage 90 ngày; security audit không content 180 ngày |

Giới hạn được giảm nếu host không đáp ứng; client chỉ đọc capabilities, không tự nâng quota. Cost target không phải giá bán/cloud quote. SLO/điều kiện đo ở [Operations](OPERATIONS.md), [Testing](TESTING.md); deletion ở [Security](SECURITY.md).

## Non-goals và release

Không GPU diffusion/video-gen APIs; không dùng chung DB/queue Creativanta; không full NLE editor MVP; không live streaming/real-time SLA; không media thiếu quyền; không tự đăng social; không arbitrary code trên API/host; không cam kết MP4 bitwise identical trên mọi CPU; không payment processor MVP (chỉ usage ledger); không model premium bắt buộc.

`P1` chỉ scaffold. `P2` là ba MP4 có quyền, checksum, ffprobe, quality/cost report và người xem/nghe review. `P4` chứng minh async tenant service. `P6` mới đủ private beta khi recovery/security/SLO có evidence. `P7` mở custom code theo tenant allowlist. Creativanta integration đầu tiên là harness trong repo; sửa client thật cần handoff riêng. Xem [Implementation plan](IMPLEMENTATION_PLAN.md).
