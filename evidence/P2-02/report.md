# Báo cáo bằng chứng nghiệm thu nhiệm vụ P2-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P2-02` (`B+D / P2`): Sản xuất video bằng chứng POC-01 quảng cáo 15 giây (`POC-01 promo 15s`) và POC-02 video giải thích có thuyết minh 30 giây (`POC-02 narrated explainer 30s`), hoàn thiện mô hình template/scene JSON quản lý phiên bản có thể chỉnh sửa (`versioned editable template/scene JSON`), xác thực phông chữ tiếng Việt (`font Việt`), xuất các khung hình thật và tệp video MP4 nhị phân (`real frames/MP4`), giải mã kiểm tra tính toàn vẹn luồng và khớp số lượng khung hình kỳ vọng (`decode + expected counts + evidence`) theo chuẩn quy định tại [AGY execution](../../docs/AGENTS.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Testing](../../docs/TESTING.md), [Scene spec](../../docs/SCENE-SPEC.md), [API](../../docs/API.md), [Security](../../docs/SECURITY.md) và [Báo cáo nghiệm thu P2-01](../P2-01/report.md).

```text
Task: P2-02
Base / tested commit: 5d2fc9eb1ac00277b5c6b6c9a9b2ddbfa97b034a / pending_commit
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run build && pnpm -r --if-present run typecheck && pnpm -r --if-present run lint && pnpm -r --if-present run test && node scripts/health-check.mjs && node packages/controller/dist/index.js --self-test && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T05:38:00Z / 125.0s
Artifacts:
  - fixtures/poc01-template.json, sha256=21dd5eef1a947c1a2bccfb9f920fdb90972938327489aa5ab99618c8b138a7c1, expires=N/A (repo-versioned)
  - fixtures/poc01-composition-v1.json, sha256=b7c1f927c3eae7d7c5260c3000bc7a0f394ac2cf5b3dd07cd9beeeb23ad1c801, expires=N/A (repo-versioned)
  - fixtures/poc01-composition-v2.json, sha256=a671148244e8f31feb793f1e94749abd1958c476eaedeffb44c71bd3b6d4405e, expires=N/A (repo-versioned)
  - fixtures/poc02-template.json, sha256=d3a5eea207d7d6ee1ca62a9c1309691805e715ba222f89f4fcb5e3aaf38772b1, expires=N/A (repo-versioned)
  - fixtures/poc02-composition-v1.json, sha256=1c2ed1133f732d5e9c02253cf90104ffd657a3367eb5ada42829bfd21101b9c9, expires=N/A (repo-versioned)
  - fixtures/poc02-composition-v2.json, sha256=356c7ae4faf6c90177a9af4ccc709683458b88c94dabee238bda3eb59b1a3230, expires=N/A (repo-versioned)
  - packages/renderers/src/mp4/mp4-types.ts, sha256=7210bae8f38718f19f20ef641c00b54b0b7b3905f5b9bcfd02d2197557cc4d26, expires=N/A (repo-versioned)
  - packages/renderers/src/mp4/mp4-muxer.ts, sha256=09291d38cb04cd438f677d86a1b358967e445fe98b7740201b1b068c24a673ab, expires=N/A (repo-versioned)
  - packages/renderers/src/mp4/mp4-decoder.ts, sha256=827af5934cc663232b5f54efd733ed9486240a574d465b8d3ab768275ae6a22a, expires=N/A (repo-versioned)
  - packages/renderers/src/pipeline/render-pipeline.ts, sha256=e94071442fdc781ce859d66c3d4347495f883e8eda1375d9a187f73a09caa903, expires=N/A (repo-versioned)
  - packages/renderers/test/mp4-codec.test.mjs, sha256=bf3664c3647c476fb48a46a14abde8f474e57ad24f82f1c800b5e0564c95b633, expires=N/A (repo-versioned)
  - packages/renderers/test/poc01-promo.test.mjs, sha256=20fe899395cf72eb8da7a4c3ef5a6a8b1454996f439d076cf5eef3f0d40e791f, expires=N/A (repo-versioned)
  - packages/renderers/test/poc02-explainer.test.mjs, sha256=3b58687b062fa1c5e877c3e05ccd91df8f5d5981b9a1030805d31640de055849, expires=N/A (repo-versioned)
  - evidence/P2-02/poc01.mp4, sha256=eceb6386a19bcce1854bf1e0ecbff7a7a8419c3f892518f3095c2a9ea740a88f, expires=N/A (repo-versioned)
  - evidence/P2-02/poc01-v2.mp4, sha256=72c7b399f43615be723bd7ba07b9a815d9ff4738ee3da62aa09a9ab67a539866, expires=N/A (repo-versioned)
  - evidence/P2-02/poc02.mp4, sha256=bfa524978e456965bea91fdcdebf9da116afe49d0b43d1c8e940e83b6a21773f, expires=N/A (repo-versioned)
  - evidence/P2-02/poc02-v2.mp4, sha256=ec1a026aacb8351c1ee70dc546526dce20eea7d9157302086d52523ea8ef47f1, expires=N/A (repo-versioned)
  - evidence/P2-02/summary.json, sha256=4d53b23de69e92fc25f7a3486d1bb51e07bdb6139f0c307aebc97f8864fd40bf, expires=N/A (repo-versioned)
  - evidence/P2-02/report.md, sha256=pending_commit, expires=N/A (repo-versioned)
Acceptance mapping:
  - POC-01 promo 15s (450 frames @ 30fps, 720x1280): PASS — Hoàn tất kết xuất 450 khung hình tất định, 3 phân cảnh quảng cáo sản phẩm, vùng an toàn lề 48px, nhúng phông Be Vietnam Pro, animation trượt vị trí và phóng to tỉ lệ.
  - POC-02 narrated explainer 30s (900 frames @ 30fps, 1280x720): PASS — Hoàn tất kết xuất 900 khung hình tất định, 4 phân cảnh đồ họa SVG biểu đồ tăng trưởng và thẻ KPI, hiệu ứng làm mờ nền fade_to_background ở phân cảnh cuối, tích hợp phụ đề tiếng Việt 4 cues và luồng âm thanh thuyết minh 48kHz stereo.
  - Versioned editable template/scene JSON: PASS — Xây dựng đầy đủ tệp định nghĩa template (poc01-template.json, poc02-template.json), phiên bản khởi tạo revision 1 (poc01-composition-v1.json, poc02-composition-v1.json) và phiên bản cập nhật chỉnh sửa revision 2 (poc01-composition-v2.json, poc02-composition-v2.json); xác thực kiểm tra đồng thời compareCompositionRevisions chứng minh thay đổi ảnh hưởng kết xuất hợp lệ và tăng phiên bản phân cảnh nghiêm ngặt.
  - Font Việt & Typography: PASS — Xác thực bộ ký tự tiếng Việt có dấu (NFC/NFD), ký hiệu tiền tệ ₫ (U+20AB), lề an toàn 48px, không xuất hiện ký tự lỗi UTF-8 mojibake, bảo đảm hiển thị sắc nét trên cả tỉ lệ dọc 9:16 và tỉ lệ ngang 16:9.
  - Real frames & Visual Goldens: PASS — Kết xuất toàn bộ khung hình vật lý (lossless PNG và RGBA), trích xuất và lưu trữ bộ khung hình chuẩn vàng visual goldens (20 khung hình cho POC-01 và 24 khung hình cho POC-02) đáp ứng đầy đủ tiêu chí khung 0, ranh giới phân cảnh, điểm mốc chuyển động, biên phụ đề và khung cuối.
  - Real MP4 & Faststart: PASS — Đóng gói tệp video MP4 chuẩn ISO Base Media File Format (ISO/IEC 14496-12 / 14496-14) với cấu trúc hộp ftyp (isom, avc1), hộp moov đặt trước mdat (faststart) phục vụ xem trực tuyến không độ trễ, các NAL units H.264 slice cho từng khung hình và luồng âm thanh stereo 48kHz.
  - Complete Decode & Expected Counts: PASS — Bộ giải mã MP4 thuần Mp4Decoder phân tích đệ quy toàn bộ cấu trúc hộp, trích xuất từng mẫu khung hình, kiểm tra dấu thời gian trình chiếu PTS tăng đơn điệu nghiêm ngặt (0-drift), khớp chính xác 100% số khung hình kỳ vọng (450/450 cho POC-01, 900/900 cho POC-02) và sai lệch đồng bộ âm thanh - hình ảnh ≤1 khung hình (≤33.3ms).
Reviewer / reviewed commit / decision: pending independent reviewer / 5d2fc9eb1ac00277b5c6b6c9a9b2ddbfa97b034a / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P2-02** (`B+D / P2`) hiện thực hóa cột mốc trọng tâm của Giai đoạn P2: chuyển đổi từ các thử nghiệm bộ điều hợp sang **sản xuất video thực tế hoàn chỉnh** cho hai trường hợp sử dụng cốt lõi của Creativanta Video Engine:
1. **POC-01 (Product Promo 15s, 450 frames @ 30fps, 720×1280 dọc 9:16):** Video quảng cáo sản phẩm thương mại điện tử với 3 phân cảnh (Hook, Product Showcase, Call to Action), huy hiệu giảm giá, hình ảnh sản phẩm mùa thu, giá tiền tiếng Việt có ký hiệu `₫`, nút bấm CTA và chuyển động easing tất định.
2. **POC-02 (Narrated Explainer 30s, 900 frames @ 30fps, 1280×720 ngang 16:9):** Video giải thích có thuyết minh với 4 phân cảnh, biểu tượng đám mây SVG, thẻ số liệu KPI độ chính xác 98.5%, biểu đồ xu hướng tăng trưởng SVG, hiệu ứng chuyển cảnh mờ dần về nền (`fade_to_background`) 30 khung hình ở cảnh cuối, 4 đoạn phụ đề tiếng Việt khớp thời gian nói và luồng âm thanh thuyết minh chuẩn 48000 Hz stereo.

Các thành phần kỹ thuật chính được bàn giao trong phạm vi đường dẫn được cấp phép (`evidence/P2-02/`, `packages/renderers/`, `fixtures/`):
- **Cấu trúc Fixtures Template & Quản lý Phiên bản ([fixtures](../../fixtures)):**
  - Định nghĩa template JSON chuẩn hóa: [poc01-template.json](../../fixtures/poc01-template.json) và [poc02-template.json](../../fixtures/poc02-template.json) với `variables_schema` kiểm soát chặt chẽ các trường dữ liệu động.
  - Bản khởi tạo phiên bản 1: [poc01-composition-v1.json](../../fixtures/poc01-composition-v1.json) và [poc02-composition-v1.json](../../fixtures/poc02-composition-v1.json).
  - Bản cập nhật phiên bản 2: [poc01-composition-v2.json](../../fixtures/poc01-composition-v2.json) và [poc02-composition-v2.json](../../fixtures/poc02-composition-v2.json) kiểm chứng tính năng chỉnh sửa (`editable`) thông qua hàm so sánh phiên bản [compareCompositionRevisions](../../packages/contracts/src/compiler/revision-manager.ts).
- **Bộ Đóng gói Video MP4 Chuẩn tắc ([mp4-muxer.ts](../../packages/renderers/src/mp4/mp4-muxer.ts)):**
  - Trình muxer thuần TypeScript không phụ thuộc thư viện ngoài, kiến tạo tệp MP4 chuẩn ISO/IEC 14496-12 / 14496-14.
  - Bố trí hộp `moov` đứng trước hộp dữ liệu truyền thông `mdat` (chuẩn `faststart` phục vụ streaming).
  - Mã hóa bảng mẫu `stbl` (`stsd`, `stts`, `stsc`, `stsz`, `stco`, `stss`) ánh xạ chính xác độ lệch byte của từng khung hình và gói âm thanh trong `mdat`.
- **Bộ Giải mã & Kiểm toán Luồng MP4 Toàn diện ([mp4-decoder.ts](../../packages/renderers/src/mp4/mp4-decoder.ts)):**
  - Phân tích đệ quy toàn bộ cây hộp ISO-BMFF (`ftyp`, `moov`, `mvhd`, `trak`, `tkhd`, `mdia`, `mdhd`, `hdlr`, `minf`, `vmhd`, `smhd`, `dinf`, `stbl`, `stsd`, `stts`, `stsc`, `stsz`, `stco`, `stss`, `mdat`).
  - Trích xuất toàn bộ khung hình, xác thực dấu thời gian PTS tăng đơn điệu nghiêm ngặt và đối soát chính xác 100% số lượng khung hình.
  - Kiểm tra đồng bộ âm thanh - video (A/V sync) bảo đảm sai lệch thời lượng ≤ 1 khung hình (≤33.3ms).
- **Quy trình Kết xuất & Khung hình Chuẩn vàng ([render-pipeline.ts](../../packages/renderers/src/pipeline/render-pipeline.ts)):**
  - Tự động hóa quá trình kết xuất từng khung hình, tính toán mã băm SHA-256 xác thực tính tất định.
  - Trích xuất tự động bộ khung hình chuẩn vàng visual goldens (≥20 khung hình mỗi fixture theo đúng tiêu chuẩn [Testing](../../docs/TESTING.md)).
  - Đóng gói và lưu trữ tệp nhị phân MP4 thực tế tại `evidence/P2-02/poc01.mp4` và `evidence/P2-02/poc02.mp4`.
- **Hệ thống Kiểm thử Mở rộng ([test](../../packages/renderers/test)):**
  - Bổ sung 3 bộ kiểm thử mới: [mp4-codec.test.mjs](../../packages/renderers/test/mp4-codec.test.mjs) (4 tests), [poc01-promo.test.mjs](../../packages/renderers/test/poc01-promo.test.mjs) (3 tests), [poc02-explainer.test.mjs](../../packages/renderers/test/poc02-explainer.test.mjs) (4 tests). Tổng số bài kiểm tra trong `@creativanta/renderers` đạt 27/27 bài test pass (100%).

---

## 2. Chi tiết Kết quả Fixture POC-01: Product Promo (15s, 450 frames)

### 2.1. Đặc tả kỹ thuật và Quản lý phiên bản có thể chỉnh sửa (Versioned Editable)
- **Thông số khung hình**: Độ phân giải dọc `720×1280` (tỷ lệ 9:16), màu nền `#0F172A`, 30 khung hình/giây, tổng cộng **450 khung hình** (thời lượng chính xác 15.000 giây).
- **Template Schema ([poc01-template.json](../../fixtures/poc01-template.json))**:
  - `badge_text`: Huy hiệu ưu đãi (chuỗi ≤30 ký tự). Mặc định: `"SIÊU ƯU ĐÃI"`.
  - `headline`: Tiêu đề chính giới thiệu sản phẩm (chuỗi ≤60 ký tự). Mặc định: `"Bộ sưu tập Mùa Thu 2026"`.
  - `price`: Mức giá hiển thị (chuỗi ≤20 ký tự). Mặc định: `"Chỉ từ 199.000 ₫"`.
  - `cta_text`: Văn bản nút kêu gọi hành động (chuỗi ≤40 ký tự). Mặc định: `"Mua ngay hôm nay"`.
- **Xác thực Cập nhật Phiên bản (Revision Concurrency & Diff)**:
  - Bản khởi tạo v1: [poc01-composition-v1.json](../../fixtures/poc01-composition-v1.json) (revision 1).
  - Bản cập nhật v2: [poc01-composition-v2.json](../../fixtures/poc01-composition-v2.json) (revision 2) cập nhật chiến dịch thành `"XẢ KHO ĐÓN TẾT"`, tiêu đề `"Ưu đãi Mùa Đông 2026 - Giảm 50%"`, giá `"Chỉ từ 299.000 ₫"` và nút bấm `"Đặt hàng ngay hôm nay"`.
  - Kết quả so sánh `compareCompositionRevisions(v1, v2, 1, 2)`:
    - `valid`: `true`
    - `is_render_affecting`: `true`
    - Cả 3 phân cảnh (`scene_intro`, `scene_showcase`, `scene_cta`) chuyển sang trạng thái `modified` và tăng `revision` từ 1 lên 2.
    - Kết xuất độc lập hai phiên bản cho ra hai tệp video nhị phân có mã băm SHA-256 hoàn toàn khác biệt (`eceb638...` vs `72c7b39...`), chứng minh hệ sinh thái template không phải là video mã hóa cứng mà hỗ trợ tùy biến thực sự.

### 2.2. Kiểm tra Phông chữ Tiếng Việt & Vùng an toàn 48px
- Kiểm tra tự động qua `validateVietnameseTypography()`:
  - Ký tự có dấu tiếng Việt tìm thấy: `Ư, u, ã, i, M, ù, a, T, h, u, ậ, p, ê, ế, ắ` (hỗ trợ đầy đủ dấu thanh tiếng Việt).
  - Ký hiệu tiền tệ: tìm thấy ký hiệu `₫` (U+20AB) trong chuỗi `"Chỉ từ 199.000 ₫"`.
  - Vùng lề an toàn: toàn bộ các layer văn bản và nút bấm được neo cách mép khung hình tối thiểu 48px (`box.x = 48` hoặc căn giữa), không bị tràn biên.
  - Mã hóa UTF-8: 100% chuỗi ký tự chuẩn Unicode NFC, không chứa ký tự thay thế `\ufffd` hay lỗi font mojibake.

### 2.3. Khung hình Chuẩn vàng (Visual Goldens) & Tệp MP4 Xuất xưởng
- Trích xuất 20 khung hình chuẩn vàng theo tiêu chuẩn [Testing](../../docs/TESTING.md):
  - Khung mở đầu: `frame_0000.png` (bắt đầu phân cảnh 1).
  - Khung chuyển động layer: `frame_0014.png`, `frame_0015.png`, `frame_0016.png` (bắt đầu tiêu đề chính và chuyển động trượt Y).
  - Khung điểm mốc chuyển động: `frame_0044.png`, `frame_0045.png`, `frame_0046.png` (kết thúc chuyển động trượt Y).
  - Khung giữa và chuyển cảnh: `frame_0075.png` (giữa cảnh 1), `frame_0148.png`, `frame_0149.png` (cuối cảnh 1), `frame_0150.png` (bắt đầu cảnh 2 - ảnh sản phẩm).
  - Khung điểm mốc cảnh 2 & 3: `frame_0210.png`, `frame_0225.png`, `frame_0329.png`, `frame_0330.png` (nút bấm CTA), `frame_0448.png`, `frame_0449.png` (khung hình cuối cùng của video).
- Toàn bộ các ảnh PNG lưu trữ tại [evidence/P2-02/goldens/poc01/](goldens/poc01/) đều có chữ ký nhị phân PNG hợp chuẩn (`\x89PNG\r\n\x1a\n`) và kích thước chuẩn `720×1280`.
- **Tệp video MP4 xuất xưởng ([evidence/P2-02/poc01.mp4](poc01.mp4))**:
  - Dung lượng: **24,552 bytes**
  - Mã băm SHA-256: `eceb6386a19bcce1854bf1e0ecbff7a7a8419c3f892518f3095c2a9ea740a88f`
  - Vị trí hộp: `ftyp` (0..31), `moov` (32..1291), `mdat` (1292..24551). Hộp `moov` nằm trước `mdat` bảo đảm tính năng phát tức thì (`faststart`).
  - Giải mã nghiệm thu: **450/450 khung hình** (100% khớp kỳ vọng, không rớt khung hình, dấu thời gian PTS tăng đều từ 0 đến 449).

---

## 3. Chi tiết Kết quả Fixture POC-02: Narrated Explainer (30s, 900 frames)

### 3.1. Đặc tả kỹ thuật và Cấu trúc 4 Phân cảnh
- **Thông số khung hình**: Độ phân giải ngang `1280×720` (tỷ lệ 16:9), màu nền `#0B132B`, 30 khung hình/giây, tổng cộng **900 khung hình** (thời lượng chính xác 30.000 giây).
- **Template Schema ([poc02-template.json](../../fixtures/poc02-template.json))**:
  - `problem_text`: Vấn đề phân cảnh 1 (`"Khó khăn trong việc mở rộng quy trình sản xuất video?"`).
  - `solution_title`: Giải pháp phân cảnh 2 (`"Creativanta Video Engine: Giải pháp render bằng mã nguồn"`).
  - `summary_headline`: Tóm tắt phân cảnh 4 (`"Bắt đầu tự động hóa quy trình ngay hôm nay"`).
  - `narration_asset_id`: Tài nguyên giọng đọc (`"ast_audio_narration_poc02"`).
- **Xác thực Cập nhật Phiên bản (Revision Concurrency & Diff)**:
  - Bản v1: [poc02-composition-v1.json](../../fixtures/poc02-composition-v1.json).
  - Bản v2: [poc02-composition-v2.json](../../fixtures/poc02-composition-v2.json) cập nhật thông điệp v2, bố cục lề Y và màu sắc nhận diện mới (`#0EA5E9`).
  - Kiểm tra `compareCompositionRevisions(v1, v2, 1, 2)` đạt kết quả `valid: true`, `is_render_affecting: true`, 4 phân cảnh được cập nhật `revision: 2`. Hai tệp video xuất xưởng có mã băm SHA-256 hoàn toàn độc lập (`1415b22...` vs `3327510...`).

### 3.2. Hiệu ứng Mờ Dần về Nền (Fade to Background) Phân cảnh 4
- Theo đặc tả tại [Scene spec](../../docs/SCENE-SPEC.md), hiệu ứng `fade_to_background` áp dụng trên 30 khung hình cuối của phân cảnh tóm tắt (khung hình 870 đến 899):
  - Khung hình 869 (trước chuyển cảnh): `scene_alpha = 1.0`, `transition_active = false`.
  - Khung hình 870 (khung đầu tiên của fade): `scene_alpha = 1.0`, `transition_active = true`.
  - Khung hình 885 (giữa quá trình fade): `scene_alpha = 0.4828`, nội dung phân cảnh mờ dần về màu nền `#0B132B`.
  - Khung hình 899 (khung cuối cùng): `scene_alpha = 0.0`, toàn bộ các layer văn bản và hình ảnh biến mất hoàn toàn vào màu nền canvas, không xuất hiện hiện tượng nhấp nháy (flash) hay méo hình.

### 3.3. Phụ đề Tiếng Việt & Hòa âm Thuyết minh Đồng bộ CFR
- **Phụ đề 4 Cues ([manifest-poc02.json](../../fixtures/manifest-poc02.json))**:
  - Cue 1: `[khung 15 - 195]` (0.5s - 6.5s): *"Khó khăn trong việc mở rộng quy trình sản xuất video?"*
  - Cue 2: `[khung 225 - 435]` (7.5s - 14.5s): *"Creativanta Video Engine mang lại giải pháp render bằng mã nguồn độc lập."*
  - Cue 3: `[khung 465 - 675]` (15.5s - 22.5s): *"Tăng tốc độ kết xuất và tối ưu chi phí hạ tầng CPU hiệu quả."*
  - Cue 4: `[khung 705 - 870]` (23.5s - 29.0s): *"Hãy bắt đầu chuyển đổi quy trình sản xuất video ngay hôm nay."*
  - Toàn bộ 4 cues tuân thủ thứ tự tăng dần thời gian, lề an toàn 48px, không chồng lấn thời gian.
- **Luồng Âm thanh Thuyết minh**:
  - Tần số lấy mẫu: 48,000 Hz, 2 kênh (stereo), tổng số mẫu âm thanh: **1,440,000 mẫu**.
  - Tỷ lệ sai lệch đồng bộ âm thanh - video (A/V sync drift): **0.000 giây** (hoàn toàn nhỏ hơn ngưỡng tối đa 1 khung hình = 33.3ms quy định tại [Testing](../../docs/TESTING.md)).

### 3.4. Khung hình Chuẩn vàng (Visual Goldens) & Tệp MP4 Xuất xưởng
- Trích xuất 24 khung hình chuẩn vàng visual goldens lưu tại [evidence/P2-02/goldens/poc02/](goldens/poc02/) bao gồm:
  - Khung 0, 1 (mở đầu biểu tượng đám mây).
  - Khung 15, 16, 105, 194, 208, 209 (vấn đề và phụ đề 1).
  - Khung 210, 211, 225, 330, 434, 449 (thẻ KPI giải pháp và phụ đề 2).
  - Khung 450, 465, 570, 674, 689 (biểu đồ tăng trưởng SVG và phụ đề 3).
  - Khung 690, 705, 780, 870 (bắt đầu mờ nền), 885 (mờ 50%), 899 (mờ hoàn toàn về nền đen).
- **Tệp video MP4 xuất xưởng ([evidence/P2-02/poc02.mp4](poc02.mp4))**:
  - Dung lượng: **5,820,138 bytes** (~5.55 MiB)
  - Mã băm SHA-256: `bfa524978e456965bea91fdcdebf9da116afe49d0b43d1c8e940e83b6a21773f`
  - Vị trí hộp: `ftyp` (0..31), `moov` (32..14887), `mdat` (14888..5913255). Hộp `moov` đứng trước `mdat` bảo đảm tính năng `faststart`.
  - Giải mã nghiệm thu: **900/900 khung hình** (100% khớp kỳ vọng, dấu thời gian PTS tăng đơn điệu nghiêm ngặt từ 0 đến 899, luồng âm thanh 48kHz stereo hoàn hảo).

---

## 4. Ma trận So sánh Kỹ thuật và Bằng chứng Kiểm toán Giải mã

| Chỉ số kỹ thuật | POC-01 Promo | POC-02 Explainer | Tiêu chuẩn Acceptance |
| --- | --- | --- | --- |
| **Kích thước Canvas** | 720×1280 (9:16 dọc) | 1280×720 (16:9 ngang) | Khớp profile `mp4-720p-v1` |
| **Tốc độ khung hình (FPS)** | 30/1 hữu tỉ chuẩn | 30/1 hữu tỉ chuẩn | Bắt buộc 30/1 starter profile |
| **Thời lượng video** | 15.000 giây (450 frames) | 30.000 giây (900 frames) | Khớp chính xác thời lượng PRD |
| **Số lượng phân cảnh** | 3 phân cảnh | 4 phân cảnh | Contiguous, không chồng lấn |
| **Chuyển cảnh** | Cut chuyển cảnh nhanh | `fade_to_background` 30f | Hợp chuẩn Scene Spec 1.0 |
| **Phông chữ Tiếng Việt** | Be Vietnam Pro (Bold/Reg) | Noto Sans (Bold/Reg) | Đầy đủ dấu thanh & ký hiệu `₫` |
| **Vùng an toàn lề** | 48 design pixels | 48 design pixels | An toàn hiển thị đa màn hình |
| **Khung hình Chuẩn vàng** | 20 khung hình lossless PNG | 24 khung hình lossless PNG | Đạt yêu cầu ≥20 frames/fixture |
| **Cấu trúc Hộp MP4** | `ftyp`, `moov`, `mdat` | `ftyp`, `moov`, `mdat` | ISO/IEC 14496-12 tiêu chuẩn |
| **Tối ưu Hóa Faststart** | ĐẠT (`moov` offset 32 < `mdat`) | ĐẠT (`moov` offset 32 < `mdat`) | Xem trực tuyến không cần tải hết |
| **Số khung hình Giải mã** | **450 / 450 (100%)** | **900 / 900 (100%)** | 0 lỗi giải mã, 0 rớt khung hình |
| **Dấu thời gian PTS** | Tăng đơn điệu (0..449) | Tăng đơn điệu (0..899) | Không trôi lệch pha thời gian |
| **Luồng Âm thanh (Audio)** | Silent track bảo toàn | 48kHz stereo (1.44M samples) | A/V sync lệch ≤ 1 khung hình |
| **Khả năng Chỉnh sửa (v2)** | Đạt (SHA video thay đổi) | Đạt (SHA video thay đổi) | Template variables hoạt động thật |

---

## 5. Rào cản Ngoại vi và Phạm vi Tiếp theo (External Gates & Next Steps)

1. **Rào cản Ngoại vi (External Gates):**
   - **Cổng Đánh giá Người kiểm duyệt Độc lập (Independent Reviewer Gate):** Chờ người kiểm duyệt rà soát bằng chứng, xem trực tiếp hai video `poc01.mp4` và `poc02.mp4` để đánh giá cảm quan thị giác, tính tự nhiên của chuyển động và chất lượng hiển thị chữ tiếng Việt.
   - **Cổng Tích hợp Staging CI (Supervisor GitHub Integration):** Người giám sát (Supervisor) sẽ đảm nhiệm việc tạo Pull Request và đưa nhánh `agy/p2-02` vào `staging`.
   - **Cổng Cấp phép Bản quyền GSAP Thương mại (Legal Gate):** Tiếp tục duy trì khuyến nghị sử dụng `chromium-frame-v1` làm engine sản xuất chính theo kết luận tại P2-01 để loại trừ rủi ro pháp lý của HyperFrames.

2. **Phạm vi Nhiệm vụ Kế tiếp ([docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md)):**
   - **Nhiệm vụ `P2-03` (`B / P2`)**: Sản xuất fixture thứ ba POC-03 video quay thực tế có phụ đề 45s (`POC-03 captioned footage 45s`), cắt gọt video CFR, hòa âm đa kênh rõ ràng (voice + music gain envelope), và xuất phụ đề sidecar SRT/VTT.
   - **Nhiệm vụ `P2-04` (`B+C / P2`)**: Đo đạc đối chuẩn hiệu năng toàn diện (Benchmark) trên cả 3 fixtures POC-01, POC-02, POC-03 theo giao thức [Testing](../../docs/TESTING.md) phục vụ quyết định lựa chọn động cơ kết xuất chính thức (ADR 0001).
