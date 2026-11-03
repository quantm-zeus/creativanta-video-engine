# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-06

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-06` (`Stream B+D / Phase P4` — Frame/Clip Previews, Compiler/Runtime, Download Grants, Thumbnails, Captions, Manifest & 360p Parity): Triển khai đầy đủ năng lực xem trước khung hình (`mode: frame`) và đoạn clip ngắn (`mode: clip`) chuẩn hồ sơ `preview-360p-v1` (tỷ lệ thu phóng chính xác `0.5` so với canvas 720p, thời lượng tối đa `300` khung hình = 10 giây), đảm bảo tính toán đồng đẳng toán học tuyệt đối (mathematical parity) với bản kết xuất đầy đủ `mp4-720p-v1` về tọa độ tương đối, nội suy hoạt ảnh (animation interpolation), hàm chuyển cảnh mờ dần vào nền (`fade_to_background` với độ mờ `scene_alpha(k) = (end - 1 - k) / (F - 1)`), và hòa trộn âm thanh chuẩn mẫu (sample-accurate 48kHz audio mixing); cơ chế cấp quyền tải xuống có chữ ký HMAC-SHA256 (`getArtifactDownloadGrant`, `generateSignedArtifactDownloadGrant`, `verifySignedArtifactDownloadGrant`) với thời hạn giới hạn `<= 300s` (5 phút) và kiểm tra thu hồi (`StorageGrantRevocationStore`); điểm cuối thực thi tải xuống `/v1/artifacts/download/:token` thiết lập nghiêm ngặt các tiêu đề bảo mật (`Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`), vô hiệu hóa mọi rủi ro thực thi HTML tùy ý trên nguồn gốc API (`no raw custom HTML origin`), tạo ảnh thu nhỏ tự động (`thumbnail.png`), phụ đề WebVTT/SubRip trượt mốc thời gian theo phân đoạn xem trước (`captions.vtt`), và tệp đặc tả kết quả kết xuất `manifest.json` chứa đầy đủ metadata xem trước, thông số đồng đẳng và mã băm toàn vẹn SHA-256; tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-06
Base / tested commit: b86920a7b415f65f060829597384ca9d8f44d603 / 26b1e16dfc8d31b3bcafb06df8718b7af5e1500d (agy/p4-06 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:zlib & node:http), pnpm 10.6.1, TypeScript 5.8.2, Python 3.11.2
Command: pnpm --filter @creativanta/api build && node --test packages/api/test/p4-06-previews-grants-captions-parity.test.mjs && pnpm --filter @creativanta/api test && pnpm test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T18:54:15Z / 3m 45s
Artifacts:
  - packages/api/src/assets/upload-grant.ts, sha256=93eed634d699d15d7538e01d58b86fe6544ed1204d4dd71fd07c8506ce26e031, expires=N/A (repo-versioned)
  - packages/api/src/assets/quarantine-store.ts, sha256=52c6e506aee431e005ca164e74ef84cbd9abeae46712f3373add5d8c3de62823, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=3ee306d02b47c8d5f5d10490e17effcf81ba9a9162e9f58d279b86567f04ca7e, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/job-dispatcher.ts, sha256=16b177198910ecb49487e29518073aacdfc15e64f30015d652b9da75f0dc6a51, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/renderer-worker.ts, sha256=76f08b1aff68bcbf046af138f3623c71caae725a2b4f47e7243d5fed3a50bb3e, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=d8713b11501fda826c661d8bc678009fb82083898030914c1516904d189da3c4, expires=N/A (repo-versioned)
  - packages/api/test/p4-06-previews-grants-captions-parity.test.mjs, sha256=d9ae234ba25da2ab39e0a9b5359921fb6ddaab43926cbbfcf4bb8bca9b1c9895, expires=N/A (repo-versioned)
  - evidence/P4-06/summary.json, sha256=72b3697821759cd7f063f2f03aa5717dae775fe0d3c88efbc8aa18108c440669, expires=N/A (repo-versioned)
Acceptance mapping:
  - Frame/clip previews with compiler/runtime (mode: frame, mode: clip, profile: preview-360p-v1): PASS — RealRendererWorker và canonical compiler hỗ trợ xem trước frame (đánh giá khung hình frame_index, kết xuất PNG 360p không suy hao) và clip (kết xuất video MP4 faststart 360p bắt đầu từ t=0 tương ứng khoảng start_frame..start_frame+duration_frames); kiểm tra chặn vi phạm ranh giới timeline (TIMELINE_BOUNDS) khi frame_index hoặc start_frame/duration_frames vượt ngoài thời lượng composition.
  - Mathematical parity between 360p preview and full 720p render: PASS — Xác minh tính toán đồng đẳng tuyệt đối trên toàn bộ 10 khung hình thử nghiệm: tỷ lệ thu nhỏ kích thước hình ảnh chính xác 0.5 (640x360 từ 1280x720), bảo toàn các thuộc tính tương đối (opacity, scale, translate), hàm chuyển cảnh fade_to_background khớp công thức `(end - 1 - k)/(F - 1)`, nội suy animation tuyến tính đồng nhất và hòa trộn âm thanh chính xác theo từng mẫu 48kHz.
  - Download grant, execution endpoint & strict security headers: PASS — Repository và upload-grant cấp token tải artifact có chữ ký HMAC-SHA256, kiểm tra thời hạn TTL <= 300s (5 phút) và kiểm tra danh sách thu hồi (`StorageGrantRevocationStore`); điểm cuối `/v1/artifacts/download/:token` phục vụ tệp với các tiêu đề an toàn: `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
  - No raw custom HTML origin: PASS — Điểm cuối tải xuống phát hiện và vô hiệu hóa mọi yêu cầu tải tệp HTML/HTM (hoặc có Content-Type text/html) bằng cách ép kiểu MIME thành `application/octet-stream` kèm cờ sandbox CSP và ép tải về dạng tệp đính kèm (`attachment`), ngăn chặn hoàn toàn trình duyệt thực thi mã JavaScript tùy ý trên nguồn gốc API.
  - Thumbnails, captions sidecar & enriched manifest: PASS — Tạo ảnh thu nhỏ `thumbnail.png` (PNG 360p), trích xuất phụ đề định dạng chuẩn WebVTT (`captions.vtt`) kèm tính năng trượt mốc thời gian (time-shift) tương ứng với khoảng clip xem trước, và ghi tệp đặc tả kết xuất `manifest.json` chứa siêu dữ liệu preview, thông số đồng đẳng toán học parity và danh sách artifacts kèm mã băm SHA-256.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-06** (`Stream B+D / Phase P4`) hoàn thiện toàn diện năng lực xem trước (preview) và cơ chế tải artifact an toàn của hệ thống video engine Creativanta:

1. **Xem Trước Khung Hình (`mode: frame`) & Xem Trước Clip (`mode: clip`) Chuẩn Hồ Sơ `preview-360p-v1`:**
   - Hỗ trợ hồ sơ `preview-360p-v1`: kích thước canvas `640x360` (ngang) hoặc `360x640` (dọc), thời lượng tối đa `300` khung hình (10 giây ở 30fps).
   - Với `mode: frame`: Đánh giá trạng thái tại `frame_index`, kết xuất ảnh PNG 360p không suy hao (`image/png`) dưới dạng artifact chính (`kind: 'video'`), đồng thời tự động tạo ảnh thu nhỏ (`kind: 'thumbnail'`), phụ đề tương ứng (`kind: 'captions'`) và tệp đặc tả (`kind: 'manifest'`).
   - Với `mode: clip`: Kết xuất đoạn video ngắn `start_frame .. start_frame + duration_frames` thành tệp MP4 chuẩn ISO-BMFF `faststart` (H.264 `avc1` + AAC `mp4a` 48kHz stereo), trong đó dòng thời gian của clip được chuẩn hóa bắt đầu từ `t = 0`, kèm phụ đề WebVTT được trượt mốc thời gian chính xác tương ứng.
   - Kiểm tra ranh giới dòng thời gian nghiêm ngặt: API từ chối các yêu cầu có `frame_index < 0` hoặc `frame_index >= duration_frames`, cũng như `start_frame + duration_frames > duration_frames` với lỗi `422 VALIDATION_FAILED` và mã chi tiết `TIMELINE_BOUNDS`.

2. **Đồng Đẳng Toán Học (Mathematical Parity) Giữa 360p Preview và 720p Render:**
   - Tỷ lệ thu phóng (scale factor) là chính xác `0.5` từ `1280x720` về `640x360` (hoặc `720x1280` về `360x640`), giữ nguyên tốc độ khung hình (30/1 fps).
   - Đảm bảo tính toán độc lập và nhất quán tuyệt đối giữa preview và render:
     - Tọa độ và thuộc tính biến đổi tương đối (`opacity`, `transform.scale_x`, `transform.scale_y`, `transform.translate_x`, `transform.translate_y`) khớp chính xác.
     - Hàm chuyển cảnh `fade_to_background`: công thức độ mờ `scene_alpha(k) = (end - 1 - k) / (F - 1)` được thực thi chính xác trên từng khung hình trong khoảng chuyển cảnh.
     - Hoạt ảnh (animation keyframes): nội suy tuyến tính giữa các điểm mốc hoạt ảnh diễn ra đồng nhất ở cả 360p và 720p.
     - Hòa trộn âm thanh: lấy mẫu chính xác theo thời gian thực (sample-accurate 48000 Hz) tương ứng với số khung hình được kết xuất.

3. **Cơ Chế Cấp Quyền Tải Xuống Artifacts Có Chữ Ký (Download Grants):**
   - Triển khai `getArtifactDownloadGrant` trong `TenantRepository` kết hợp các hàm ký và xác minh trong `packages/api/src/assets/upload-grant.ts`:
     - `generateSignedArtifactDownloadGrant`: Tạo token URL-safe mang chữ ký HMAC-SHA256 với khóa bí mật pepper, thời hạn hiệu lực tối đa `300` giây (5 phút) theo yêu cầu tại [docs/SECURITY.md](../../docs/SECURITY.md) dòng 23 và [docs/API.md](../../docs/API.md) dòng 44.
     - `verifySignedArtifactDownloadGrant`: Giải mã, kiểm tra cấu trúc phong bì, đối chiếu chữ ký trong thời gian hằng số (`crypto.timingSafeEqual`), và kiểm tra trạng thái thu hồi qua `StorageGrantRevocationStore`.
   - Bảo mật cách ly đa tenant (IDOR Prevention): Tenant B cố gắng lấy download grant cho artifact thuộc Tenant A luôn nhận về HTTP `404 NOT_FOUND` (tuyệt đối không để lộ sự tồn tại của tài nguyên qua mã 403).

4. **Điểm Cuối Thực Thi Tải Xuống & Ranh Giới An Toàn (`No Raw Custom HTML Origin`):**
   - Tuyến đường công khai không cần header Authorization: `GET /v1/artifacts/download/:token`.
   - Xác minh token, kiểm tra trạng thái hết hạn retention của artifact trên cơ sở dữ liệu (`revoked_at`, `expires_at`), và đọc dữ liệu từ `QuarantineStore`.
   - Thực thi nghiêm ngặt các tiêu đề HTTP bảo vệ trình duyệt:
     - `Content-Disposition: attachment; filename="..."`: Buộc trình duyệt luôn tải tệp về máy thay vì hiển thị trực tiếp.
     - `Content-Security-Policy: default-src 'none'; sandbox`: Vô hiệu hóa hoàn toàn mọi ngữ cảnh thực thi kịch bản, frame, hoặc tải tài nguyên phụ.
     - `X-Content-Type-Options: nosniff`: Ngăn chặn trình duyệt tự ý đoán định dạng MIME (MIME-sniffing).
     - `X-Frame-Options: DENY`: Chống clickjacking.
   - Ranh giới `no raw custom HTML origin`: Khi token hoặc tệp artifact có kiểu MIME là `text/html` hoặc phần mở rộng `.html`/`.htm`, điểm cuối tự động ép kiểu MIME về `application/octet-stream`, ngăn ngừa tuyệt đối trình duyệt render HTML chứa mã khai thác trên nguồn gốc API của Creativanta.

5. **Phụ Đề WebVTT/SubRip, Ảnh Thu Nhỏ & Tệp Đặc Tả Manifest:**
   - Hỗ trợ định dạng phụ đề WebVTT (`text/vtt`) và SubRip (`application/x-subrip`), có cơ chế bỏ qua thẻ định dạng và căn chỉnh mốc thời gian `HH:MM:SS.mmm`.
   - Với clip preview, các mốc thời gian của từng đoạn phụ đề (`cue`) được trượt lùi một khoảng thời gian `start_frame / fps`, đảm bảo phụ đề khớp đồng bộ hoàn hảo với video clip bắt đầu từ `t = 0`.
   - Mỗi công việc hoàn tất đều sinh tệp `manifest.json` ghi nhận phiên bản schema `1.0`, thông tin preview (`mode`, `frame_index`, `start_frame`, `duration_frames`), thông số đồng đẳng toán học `parity` (`scale`, `canvas_width`, `canvas_height`), và danh sách toàn bộ artifacts kèm kích thước và mã băm SHA-256.

---

## 2. Bằng chứng kiểm thử tự động (Automated Test Execution Evidence)

Bộ kiểm thử chuyên biệt `packages/api/test/p4-06-previews-grants-captions-parity.test.mjs` bao gồm 6 kịch bản kiểm thử toàn diện đã chạy thành công 100%:

```text
▶ P4-06: Frame/Clip Previews, Compiler/Runtime, Download Grants, Captions, Manifest & 360p Parity
  ✔ 1. Frame preview (mode: frame) produces lossless 360p PNG, thumbnail, manifest, and captions sidecar (243.677796ms)
  ✔ 2. Clip preview (mode: clip) produces 360p faststart ISO-BMFF MP4 starting at t=0 with audio & shifted captions (272.08475ms)
  ✔ 3. Mathematical parity between 360p preview and full 720p render (scale 0.5, animations, transitions, audio) (7.389546ms)
  ✔ 4. Artifact download grants return scoped URL (<= 5min) and download endpoint delivers files with strict headers (attachment, sandbox CSP, nosniff) (223.119ms)
  ✔ 5. Security boundary: foreign tenant ID returns 404, tampered/expired/revoked token returns error, and no raw custom HTML on origin (71.240192ms)
  ✔ 6. Re-exports canonical helpers from packages/dispatcher and verifies subtitle generation utility functions (0.847612ms)
✔ P4-06: Frame/Clip Previews, Compiler/Runtime, Download Grants, Captions, Manifest & 360p Parity (823.952803ms)
ℹ tests 6
ℹ suites 1
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1141.228375
```

### Toàn bộ test suite của package `@creativanta/api`:
- **Lệnh thực thi:** `pnpm --filter @creativanta/api test`
- **Kết quả:** `202 / 202 tests passed`, `0 failed`, thời gian chạy `42.66s`. Bao gồm toàn bộ các bài test `P3-01`, `P3-02`, `P3-03`, `P3-04`, `P3-05`, `P4-01`, `P4-02`, `P4-03`, `P4-06`.

### Toàn bộ kiểm thử toàn workspace:
- **Lệnh thực thi:** `pnpm test`
- **Kết quả:** `PASS` trên cả 8 packages (`@creativanta/contracts`, `@creativanta/renderers`, `@creativanta/assets`, `@creativanta/sdk`, `@creativanta/api`, `@creativanta/dispatcher`, v.v.).

### Kiểm tra sức khỏe & hợp lệ kho lưu trữ:
- **`node scripts/health-check.mjs`:** `PASS` (Cấu hình môi trường, kiểm tra endpoint `/healthz`, `/readyz`, `/v1/capabilities` trả về hồ sơ `mp4-720p-v1` và `preview-360p-v1`).
- **`python3 scripts/validate_repo.py`:** `PASS` (`42 markdown files`, `606 internal links`, `32 json files`, `0 errors`, đồ thị phụ thuộc phi chu trình).

---

## 3. Cổng ngoại bộ và phạm vi tiếp theo (External Gates & Next Tasks)

- **Cổng ngoại bộ:**
  - Cổng đánh giá an ninh độc lập (Gate G3): Thẩm định việc ngăn chặn thực thi HTML tùy ý trên nguồn gốc API và cơ chế token có chữ ký thời hạn 5 phút.
  - Cổng phê duyệt tích hợp staging: Giám sát viên (supervisor) thực hiện merge vào nhánh staging sau khi xác thực bằng chứng tại `evidence/P4-06/`.
- **Phạm vi còn lại / Nhiệm vụ tiếp theo:**
  - Nhiệm vụ `P4-07` / `P5-01`: Giám sát nâng cao, webhook retry với exponential backoff, và hoàn thiện hệ thống xuất bản video engine.
