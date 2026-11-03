# Báo cáo bằng chứng nghiệm thu nhiệm vụ P3-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P3-02` (`C+A / P3` — Asset Ingestion Pipeline & Security Guards): Triển khai luồng tiếp nhận đa phương tiện an toàn gồm 4 giai đoạn chuẩn (Signed upload grant với HMAC-SHA256, lưu trữ cách ly vùng quarantine với kiểm tra streaming SHA-256 và chặn path traversal, đối soát hoàn tất complete, thăm dò probe metadata trong sandbox cô lập và thăng cấp trạng thái ready), các bộ phòng vệ kiểm soát kích thước/mã băm/bản quyền/phông chữ/SVG/kích thước ảnh pixel bomb, bẫy truyền thông biến dạng (malformed media containment) không thoát khỏi sandbox, và bảo đảm tính cách ly tuyệt đối trả về 404 NOT_FOUND đối với tài nguyên của tenant khác theo quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P3-02
Base / tested commit: 985f471f21b074ae2de2771c63ecce0b40b179b6 / 985f471f21b074ae2de2771c63ecce0b40b179b6
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite & node:crypto), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api build && pnpm -F @creativanta/api test && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T05:31:30Z / 25.8s
Artifacts:
  - packages/api/src/assets/upload-grant.ts, sha256=393bee715fda01ae47e3360e26b3b363add6d59ab2df6603b756690a2bef3317, expires=N/A (repo-versioned)
  - packages/api/src/assets/quarantine-store.ts, sha256=a0cab815e65fd634db9948bf97c1110b06f5a6285c16c05d8b464cd13791ad24, expires=N/A (repo-versioned)
  - packages/api/src/assets/media-guard.ts, sha256=e2d572c0ee9734b9e413804213005ed60ebe8822e5d9476f6ab5eb7ff6989acc, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=bd2fc6728b2e700b69837c8ee6963e02d699c19a3b553a4d140d2b9cc047a198, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=ae29be7026f1198d7299e52956652a68cbdad703c9af537098db03792d122b1a, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=fedbfe342e30b5ebb9c3df7f8bb1f884b20a7901afcf2377da26ac2ab2fac9fd, expires=N/A (repo-versioned)
  - packages/api/test/p3-02-asset-pipeline.test.mjs, sha256=b39a335313ce60b02d6cf1035754f28de83f7fce1a5c32c87f8bff68c0185f61, expires=N/A (repo-versioned)
  - evidence/P3-02/summary.json, sha256=261b082a49c85cebeeafd087b8c0549afaeb606952092b2a94f14d9b34f22025, expires=N/A (repo-versioned)
Acceptance mapping:
  - Signed upload / quarantine / complete / ready pipeline: PASS — Triển khai đầy đủ quy trình tiếp nhận asset 4 bước: POST /v1/assets/uploads cấp signed grant HMAC-SHA256 (TTL 10 phút), PUT /v1/assets/upload-quarantine/:token tiếp nhận dữ liệu nhị phân vào vùng cách ly quarantine kèm kiểm tra maxBytes, POST /v1/assets/{id}/complete đối soát toàn vẹn SHA-256/bytes, thăm dò probe metadata an toàn và thăng cấp trạng thái sang ready (hoặc rejected nếu sai lệch).
  - Size / hash / rights guards: PASS — Chặn tải lên >100 MiB (413 PAYLOAD_TOO_LARGE), phông chữ >32 MiB (413 OVERSIZED_FONT), SVG >5 MiB (413 OVERSIZED_SVG); bắt buộc bản quyền hợp lệ (reject basis không hợp lệ hoặc expired_at đã qua); từ chối và đánh dấu rejected khi hash SHA-256 hoặc kích thước bytes thực tế không khớp với khai báo.
  - Font & SVG guards: PASS — Phân tích cấu trúc font TrueType/OpenType/WOFF2, kiểm tra sfnt offset/bounds của từng bảng chống tràn bộ nhớ, bắt buộc các bảng tối thiểu (cmap, head, hhea, hmtx, maxp); phân tích cú pháp SVG triệt tiêu hoàn toàn XXE (chặn <!DOCTYPE, <!ENTITY), loại bỏ thẻ nguy hiểm (<script>, <foreignObject>, <iframe>, <embed>, <object>), chặn inline event handlers (on*), chặn liên kết ngoại (href, xlink:href tới HTTP/HTTPS/FTP), chặn CSS ngoại (@import, url()), giới hạn tối đa 5000 DOM nodes và độ sâu cây <= 16.
  - Image dimension guards: PASS — Phân tích header ảnh PNG (IHDR), JPEG (SOF0/SOF2), WebP (VP8/VP8L/VP8X), chặn ảnh có kích thước cạnh > 8192px hoặc tổng điểm ảnh > 40 Megapixels chống cạn kiệt tài nguyên bộ nhớ (pixel/decompression bomb).
  - Malformed media sandbox containment: PASS — Tách biệt trình thăm dò đa phương tiện (probe container / ffprobe) trong sandbox cô lập hoàn toàn với giới hạn tài nguyên nghiêm ngặt (timeout 5000ms, maxBuffer 1MB, chỉ cho phép file/pipe protocol); bẫy gọn mọi file hỏng, thiếu header ftyp/RIFF/sync-word hoặc file độc hại mà không làm sập server hay thoát sandbox; chuyển trạng thái asset sang rejected kèm mã lỗi MALFORMED_MEDIA.
  - Foreign asset 404 guarantee (AMB-007): PASS — Đảm bảo khi Tenant B truy cập tài nguyên của Tenant A qua các endpoints URL (/v1/assets/{id}, /v1/assets/{id}/upload-url, /v1/assets/{id}/complete, DELETE /v1/assets/{id}) luôn trả về 404 NOT_FOUND (không bao giờ trả 403), triệt tiêu hoàn toàn rò rỉ thông tin qua tấn công IDOR. Token grant giả mạo hoặc sai chữ ký bị từ chối với 403 INVALID_GRANT_SIGNATURE.
Reviewer / reviewed commit / decision: pending independent reviewer / 985f471f21b074ae2de2771c63ecce0b40b179b6 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P3-02** (`C+A / P3`) hiện thực hóa toàn diện đường ống tiếp nhận tài nguyên (asset ingestion pipeline) và các chốt phòng vệ an ninh đa tầng (security guards) theo đặc tả chuẩn tắc tại [docs/SECURITY.md](../../docs/SECURITY.md) và [docs/API.md](../../docs/API.md):

1. **Cơ chế Cấp quyền Tải lên có Ký số (Signed Upload Grant & Quarantine Token - [upload-grant.ts](../../packages/api/src/assets/upload-grant.ts)):**
   - Khởi tạo phiên tải lên tại `POST /v1/assets/uploads` tạo bản ghi tài nguyên ở trạng thái `uploading` và sinh mã cấp quyền ký số HMAC-SHA256 (`upload_grant`) có thời hạn sống tối đa 10 phút (`600s`) theo [docs/SECURITY.md](../../docs/SECURITY.md) dòng 23.
   - Chữ ký bao bọc toàn bộ thuộc tính quan trọng: `tenantId`, `assetId`, `filename`, `mimeType`, `sha256`, `declaredBytes`, `maxBytes` và `expiresAt`.
   - Xác thực token bằng kiểm tra so sánh hằng thời gian (`crypto.timingSafeEqual`) chống tấn công dò kênh bên (timing attack side-channel); từ chối token giả mạo với `403 INVALID_GRANT_SIGNATURE` và token hết hạn với `410 UPLOAD_GRANT_EXPIRED`.
   - Hỗ trợ làm mới grant tại `POST /v1/assets/{id}/upload-url` (chặn khi tài nguyên đã rời trạng thái `uploading` với `409 REVISION_CONFLICT`).

2. **Lưu trữ Cách ly Vùng Kiểm dịch (Quarantine Storage Engine - [quarantine-store.ts](../../packages/api/src/assets/quarantine-store.ts)):**
   - Ngăn cách tuyệt đối giữa các tenant bằng đường dẫn lưu trữ cô lập `/quarantine/<tenantId>/<assetId>.part`.
   - Chống tấn công duyệt thư mục (path traversal protection) bằng cách chuẩn hóa và xác thực tiền tố đường dẫn thư mục gốc (`validateTenantSafePath`).
   - Tiếp nhận stream nhị phân tại `PUT /v1/assets/upload-quarantine/:token`, tính toán mã băm SHA-256 tức thời (streaming SHA-256) và giám sát kích thước stream; ngắt luồng ngay lập tức và trả về `413 PAYLOAD_TOO_LARGE` nếu vượt quá giới hạn `maxBytes`.
   - Chỉ khi quá trình đối soát và thăm dò (complete & probe) thành công, tệp kiểm dịch mới được thăng cấp an toàn sang vùng lưu trữ chính thức `/assets/<tenantId>/<assetId>.<ext>`, xóa bỏ file kiểm dịch tạm thời.

3. **Hệ thống Phòng vệ Đa tầng & Thăm dò Sandbox (Multi-Tier Security Guards & Sandbox Probe - [media-guard.ts](../../packages/api/src/assets/media-guard.ts)):**
   - **Giới hạn Kích thước (Size Guards):**
     - Giới hạn chung toàn bộ tài nguyên: Tối đa `100 MiB` (`104,857,600` bytes).
     - Giới hạn phông chữ: Tối đa `32 MiB` (`33,554,432` bytes) — từ chối với `413 OVERSIZED_FONT`.
     - Giới hạn tệp vectơ SVG: Tối đa `5 MiB` (`5,242,880` bytes) — từ chối với `413 OVERSIZED_SVG`.
   - **Bảo vệ Bản quyền (Rights Guards):** Bắt buộc thuộc tính `rights.basis` hợp lệ (`owned`, `licensed`, `public_domain`, `permissive_open_source`, `fair_use`); kiểm tra thời hạn giấy phép `expires_at` không được ở quá khứ (`422 VALIDATION_FAILED`).
   - **Phòng vệ Tệp SVG (SVG Sanitization & DoS Guards):**
     - Chặn đứng lỗ hổng XXE: Cấm tuyệt đối `<!DOCTYPE` và `<!ENTITY`.
     - Loại bỏ mã thực thi độc hại: Cấm các thẻ nguy hiểm `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`.
     - Cấm inline event handlers (các thuộc tính bắt đầu bằng `on\w+`, ví dụ `onload`, `onclick`, `onerror`).
     - Chặn tấn công SSRF & Exfiltration: Cấm các liên kết tuyệt đối ngoại bộ trong `href` hoặc `xlink:href` (`http:`, `https:`, `ftp:`).
     - Chặn nạp tài nguyên CSS từ xa: Cấm `@import` và biểu thức `url()` trong thẻ `<style>`.
     - Chống DoS cây DOM phức tạp: Giới hạn tối đa 5000 DOM nodes và độ sâu lồng nhau tối đa 16 tầng.
   - **Phòng vệ Phông chữ (Font Integrity Guards):**
     - Kiểm tra magic bytes đối với phông chữ TrueType (`0x00010000`), OpenType (`OTTO`), và WOFF2 (`wOF2`).
     - Phân tích bảng sfnt header và kiểm tra phạm vi (offset/length) của từng bảng không được tràn ra ngoài kích thước tệp (table boundary validation).
     - Bắt buộc các bảng định dạng cốt lõi: `cmap`, `head`, `hhea`, `hmtx`, `maxp`.
   - **Phòng vệ Kích thước Ảnh & Chống Pixel Bomb (Image Dimension Guards):**
     - Phân tích thông số kích thước ảnh từ binary header (PNG `IHDR`, JPEG `SOF0`/`SOF2`, WebP `VP8`/`VP8L`/`VP8X`).
     - Giới hạn kích thước tối đa cho mỗi chiều không vượt quá `8192 px`.
     - Giới hạn tổng số điểm ảnh không vượt quá `40 Megapixels` (`40,000,000` pixels) nhằm ngăn chặn cạn kiệt tài nguyên đồ họa (decompression bomb).
   - **Cô lập Truyền thông Biến dạng trong Sandbox (Malformed Media Sandbox Containment):**
     - Mọi tệp video/audio/container được thăm dò trong môi trường sandbox biệt lập bằng tiến trình con `ffprobe` với các tham số an toàn nghiêm ngặt (`-v error`, `-protocol_whitelist file,pipe`, `-probesize 32M`, `-analyzeduration 32M`, timeout 5000ms, maxBuffer 1MB) hoặc bộ phân tích container dự phòng.
     - Các tệp truyền thông bị hỏng (thiếu `ftyp` box trong MP4, thiếu `RIFF`/`WAVE` trong WAV, sai khung `ID3`/sync word) hoặc cố tình gây crash trình giải mã đều bị bẫy gọn trong sandbox mà không gây sập ứng dụng hay rò rỉ bộ nhớ.
     - Cập nhật trạng thái tài nguyên thành `rejected` với mã lỗi `MALFORMED_MEDIA` hoặc `PROBE_FAILED` và dọn dẹp sạch vùng kiểm dịch.

4. **Tuân thủ Chuẩn AMB-007 (Foreign Asset 404 Isolation):**
   - Đảm bảo khi Tenant B cố gắng truy cập, lấy đường dẫn tải lên, hoàn tất hoặc xóa tài nguyên thuộc sở hữu của Tenant A, hệ thống luôn trả về `404 NOT_FOUND` (không bao giờ trả `403 FORBIDDEN`), triệt tiêu hoàn toàn khả năng dò quét định danh tài nguyên (resource existence oracle).
   - Quản lý tính bất biến của bảng `asset_versions`: Phiên bản `1` được thêm mới (`INSERT`) duy nhất khi tài nguyên chuyển sang trạng thái cuối `ready` hoặc `rejected`, tuân thủ trigger bất biến PostgreSQL `trg_asset_versions_immutable`.

5. **Bộ Kiểm thử Tích hợp Toàn diện ([p3-02-asset-pipeline.test.mjs](../../packages/api/test/p3-02-asset-pipeline.test.mjs)):**
   - 41 ca kiểm thử chuyên sâu bao phủ đầy đủ 10 nhóm tính năng: vòng đời hoàn chỉnh PNG, cách ly AMB-007, giới hạn kích thước, đối soát sai lệch SHA-256/bytes, bảo vệ bản quyền, an toàn SVG, kiểm tra phông chữ, kích thước ảnh pixel bomb, bẫy malformed media sandbox, cờ tính năng remote import và xóa tài nguyên có dọn dẹp bộ nhớ đệm.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api build` | `0` | `PASS` | Biên dịch TypeScript `@creativanta/api` sang ESM `dist/` sạch sẽ |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api test` | `0` | `PASS` | Chạy 59 test cases (18 bài kiểm tra nền tảng P3-01 & server + 41 bài kiểm tra pipeline P3-02) |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên cả 5 packages trong workspace |
| 4 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận `/healthz`, `/readyz`, cấu hình adapter và khả năng engine |
| 5 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn vẹn 16 tài liệu, 345 liên kết nội bộ, 16 khối JSON, và DAG 52 nhiệm vụ |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p3-02` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P3-02`.
2. **Nhiệm vụ tiếp theo mở khóa:** Nhiệm vụ `P3-02` hoàn tất việc xây dựng đường ống tiếp nhận và bảo vệ tài nguyên an toàn, mở khóa luồng dựng hình tích hợp tài nguyên đa phương tiện cho các giai đoạn tiếp theo (`P3-03` Template revisions & variable schemas, `P4-01` Dispatcher & lease scheduler).
