# Báo cáo bằng chứng nghiệm thu nhiệm vụ P5-01

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P5-01` (`D+B / P5` — Curated template pack 3 families với variable schema/locales/revisions/license evidence, safe brand tokens/overflow errors; user edits regenerate đúng): Triển khai gói bản mẫu video chuẩn biên tập gồm 3 dòng họ hoàn chỉnh (`retail_promo`, `narrated_explainer`, `captioned_story`), mỗi dòng họ hỗ trợ tối thiểu 2 phiên bản bất biến (`revision 1` và `revision 2`), sơ đồ biến nhập liệu định kiểu chặt chẽ theo JSON Schema Draft 2020-12 (`variables_schema`), hỗ trợ đa ngôn ngữ (`vi-VN` chuẩn hóa Unicode NFC và `en-US`), bảo vệ an toàn thương hiệu thông qua bộ mã định danh thương hiệu an toàn (`BrandTokens` chặn đứng mọi nguy cơ tiêm mã CSS/HTML/script), tính toán dàn trang trước kết xuất nhằm phát hiện lỗi tràn văn bản (`TextOverflowError` trong chế độ `overflow: 'error'`, hỗ trợ `shrink` và `ellipsis`), liên kết 100% tài sản với bằng chứng bản quyền thương mại đối chiếu từ `evidence/P0-03/rights-manifest.json`, cùng cơ chế khởi tạo và tái tạo khi người dùng chỉnh sửa (`instantiateCuratedTemplate` và `regenerateTemplate`) bảo toàn tính ổn định của định danh phân cảnh (`scene ID stability`) và biên dịch chuẩn xác sang bản kê kết xuất `CanonicalCompilerManifest`. Toàn bộ tuân thủ nghiêm ngặt các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P5-01
Base / tested commit: ce234331b0a0c56b6e6ec1d9be4a23ffd1009d0c / HEAD (agy/p5-01)
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: ./node_modules/.bin/tsc -p packages/sdk/tsconfig.json && ./node_modules/.bin/tsc -p packages/templates/tsconfig.json && node --test packages/sdk/test/**/*.test.mjs && node --test packages/templates/test/**/*.test.mjs && node scripts/health-check.mjs && /usr/bin/python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-04T03:15:00Z / 12.4s
Artifacts:
  - packages/sdk/src/brand-tokens.ts, sha256=6203a8c4aed4b712e7e7e8a4714848f1c4d04d984439fd9eaab4665d9f51f6f7, expires=N/A (repo-versioned)
  - packages/sdk/src/text-overflow.ts, sha256=74f315601e54b29a3c3116abfa95856bc835981b42f2be57e5a6e6ca1af311e9, expires=N/A (repo-versioned)
  - packages/sdk/src/index.ts, sha256=4c5ce23a64e95378ecbb47617822b4c67ef1b7ba71d50f8f6d1cb6c1811d5b24, expires=N/A (repo-versioned)
  - packages/sdk/test/brand-tokens.test.mjs, sha256=9445c3af8c124f1d6f24537783fd8f3c4a2d9b0a96db25ad0c7af713dfa54226, expires=N/A (repo-versioned)
  - packages/sdk/test/text-overflow.test.mjs, sha256=abd5514724b853df6e919750e585ae099c7298129598e80dd1a1fb54a40896f7, expires=N/A (repo-versioned)
  - packages/templates/src/types.ts, sha256=50c4ea6a525201d745a5c659f81e23b690bac9342b1b08fb6be1adf52ee91796, expires=N/A (repo-versioned)
  - packages/templates/src/license-evidence.ts, sha256=0ca1291c8fd339fbf55beb7727c80b1cdc6a0ef833315b04f90a9a3ddd020fb7, expires=N/A (repo-versioned)
  - packages/templates/src/retail-promo.ts, sha256=c2afadbe5ccdd284b175068ef10677ed67f0e3d33d9a4edf66952d40d5a47138, expires=N/A (repo-versioned)
  - packages/templates/src/narrated-explainer.ts, sha256=10a9d5d993de04a10daed7326f204312bc01754940ee1a843f6d596e86875b9d, expires=N/A (repo-versioned)
  - packages/templates/src/captioned-story.ts, sha256=b207c8f37c50535a0815befad58d68bcaf8645dea94795026e7e8c6fa227af7c, expires=N/A (repo-versioned)
  - packages/templates/src/catalog.ts, sha256=97f123137112c3e5e6cac9db4b45257fc86962644a886b6c04b3cc45539c3f71, expires=N/A (repo-versioned)
  - packages/templates/src/template-engine.ts, sha256=e40f80b836f56ceceeb91bce98dd2f6790d3d32a55b7f01d58ac0baf6759264a, expires=N/A (repo-versioned)
  - packages/templates/src/index.ts, sha256=f34aea990cc59624d2c99477a5d5667fb6cf48223d301551d7a32f2312f84bf5, expires=N/A (repo-versioned)
  - packages/templates/test/curated-pack.test.mjs, sha256=4d503e3b6a6399dcd7159791797651710476148d649e94a9245ca39459c12d28, expires=N/A (repo-versioned)
  - packages/templates/test/user-edits-and-regeneration.test.mjs, sha256=4dd5c9efe811b087d68bc289a7d23d38ce9992059f2f30f723781f0143a8f668, expires=N/A (repo-versioned)
  - evidence/P5-01/summary.json, sha256=2ab2d884d585c455bbfca3b512e80645124459c139b49a875a359dd8971f2e27, expires=N/A (repo-versioned)
Acceptance mapping:
  - Curated template pack 3 families: PASS — Đóng gói hoàn chỉnh 3 dòng họ bản mẫu video đạt chuẩn Scene Spec 1.0: (1) retail_promo (9:16 dọc 15s 450 frames @ 30fps), (2) narrated_explainer (16:9 ngang 30s 900 frames @ 30fps), (3) captioned_story (9:16 dọc 45s 1350 frames @ 30fps) tích hợp 2 đoạn phim thực tế và hòa âm đa kênh giọng nói + nhạc nền ducking.
  - Variable schema & defaults: PASS — Mỗi dòng họ định nghĩa sơ đồ biến JSON Schema Draft 2020-12 chặt chẽ, ràng buộc kiểu dữ liệu, giới hạn ký tự tối đa (maxLength), định dạng tiền tệ Việt Nam (₫), mô tả chi tiết và giá trị mặc định (defaults) cho 100% biến.
  - Multi-locale support: PASS — Hỗ trợ đầy đủ ngôn ngữ tiếng Việt (vi-VN) với chuẩn hóa Unicode NFC và tiếng Anh (en-US); kiểm tra từ chối mã ngôn ngữ ngoài danh sách cho phép với mã lỗi UNSUPPORTED_LOCALE.
  - Immutable revision history: PASS — Mỗi dòng họ bản mẫu có tối thiểu 2 phiên bản (Revision 1 và Revision 2) với ghi chú thay đổi (change_note), duy trì định danh phân cảnh ổn định (scene ID stability) và tăng số hiệu phân cảnh khi nội dung thay đổi.
  - Clear commercial license evidence: PASS — 100% tài sản (phông chữ, âm thanh, video clip, đồ họa vector và hình ảnh) được xác minh và liên kết với Bản kê quyền sở hữu P0-03 (rights-manifest.json), bảo đảm đầy đủ quyền sử dụng thương mại, mã băm SHA-256 chính xác và không chứa tài nguyên upstream chưa duyệt.
  - Safe brand tokens: PASS — Bộ thẩm định BrandTokens cưỡng chế định dạng màu hex (#RGB, #RRGGBB, #RRGGBBAA), chặn đứng triệt để các vector tấn công CSS/HTML injection (; url() expression() javascript: <script>), kiểm tra phông chữ ghim và mã định danh tài sản hợp lệ (ast_*), chuyển đổi an toàn màu nền canvas, màu chữ và kiểu dáng nút bấm.
  - Text overflow preflight & error guard: PASS — Cơ chế tính toán dàn trang trước kết xuất (calculateTextLayout) mô phỏng chính xác số dòng và chiều cao văn bản tiếng Việt; phát hiện và ném lỗi TextOverflowError khi số dòng vượt max_lines hoặc vượt chiều cao khung viền (box.height) ở chế độ overflow: 'error'; hỗ trợ chế độ co chữ (shrink) và chấm lửng (ellipsis).
  - User edits regeneration: PASS — Hiện thực hóa luồng instantiateCuratedTemplate và regenerateTemplate; kiểm chứng các chỉnh sửa của người dùng được vật chất hóa chính xác, chuẩn hóa Unicode NFC, biên dịch thành công sang CanonicalCompilerManifest và xác thực tính tương thích qua compareCompositionRevisions.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD (agy/p5-01) / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P5-01** (`D+B / P5`) triển khai trọn vẹn bộ bản mẫu video chuẩn biên tập (**Curated Template Pack**) gồm 3 dòng họ bản mẫu độc lập, thiết lập cơ chế bảo vệ thương hiệu an toàn (**Safe Brand Tokens**), bộ giải thuật tính toán dàn trang phát hiện tràn văn bản (**Preflight Text Layout & Overflow Guard**), quản lý phiên bản bất biến (**Multi-Revision Versioning**), hồ sơ chứng minh quyền sở hữu tài sản thương mại (**Asset License Evidence Registry**) và động cơ vật chất hóa biến số cùng tái tạo video khi người dùng chỉnh sửa (**Instantiation & Regeneration Engine**), đáp ứng đầy đủ các tiêu chuẩn tại [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md) và [docs/API.md](../../docs/API.md).

---

## 2. Kiến trúc 3 Dòng họ Bản mẫu Video (Curated Template Pack Families)

### 2.1. Dòng họ 1: Retail Promo (`retail_promo`)
- **Mã định danh**: `tpl_retail_promo_v1`
- **Tỷ lệ & Kích thước**: 9:16 dọc (`720×1280`), thời lượng 15 giây (450 khung hình @ 30fps).
- **Phân cảnh**: 3 phân cảnh (Hook mở đầu `scene_promo_intro`, Giới thiệu giá sốc `scene_promo_deal`, Lời kêu gọi hành động `scene_promo_cta`).
- **Nội dung & Bản địa hóa**: Tối ưu hóa cho chiến dịch khuyến mãi, flash sale thương mại điện tử, định dạng tiền tệ Việt Nam (`₫`), kênh lồng tiếng TTS tích hợp cơ chế âm thanh tải lên dự phòng (`upload_fallback_asset_id`).
- **Phiên bản quản lý**:
  - `Revision 1`: Mẫu khuyến mãi tiêu chuẩn ("Khuyến mãi đặc biệt hôm nay!", "Chỉ từ 199.000 ₫", "Mua ngay kẻo lỡ!").
  - `Revision 2`: Phiên bản xả kho mùa hè nâng cấp ("Xả kho mùa hè — Giảm tới 70%!", "Đồng giá chỉ 149.000 ₫", "Chớp cơ hội ngay hôm nay!") với độ tương phản màu sắc được tinh chỉnh.

### 2.2. Dòng họ 2: Narrated Explainer (`narrated_explainer`)
- **Mã định danh**: `tpl_narrated_explainer_v1`
- **Tỷ lệ & Kích thước**: 16:9 ngang (`1280×720`), thời lượng 30 giây (900 khung hình @ 30fps).
- **Phân cảnh**: 4 phân cảnh (Đặt vấn đề `scene_problem`, Giới thiệu giải pháp `scene_solution`, Trình bày tính năng `scene_features`, Tóm tắt kêu gọi `scene_summary`).
- **Chuyển cảnh**: Hiệu ứng chuyển cảnh làm mờ nền `fade_to_background` 30 khung hình ở cuối mỗi phân cảnh.
- **Kênh âm thanh & Phụ đề**: Thuyết minh tiếng Việt chuẩn kết hợp 4 đoạn phụ đề ghi thẳng (`burn_in: true`) trong vùng an toàn lề 48px.
- **Phiên bản quản lý**:
  - `Revision 1`: Video giải thích công nghệ SaaS tiêu chuẩn.
  - `Revision 2`: Phiên bản hướng tới khách hàng doanh nghiệp (Enterprise), điều chỉnh cấu trúc thông điệp và lời kêu gọi dùng thử giải pháp tự động hóa.

### 2.3. Dòng họ 3: Captioned Story (`captioned_story`)
- **Mã định danh**: `tpl_captioned_story_v1`
- **Tỷ lệ & Kích thước**: 9:16 dọc (`720×1280`), thời lượng 45 giây (1350 khung hình @ 30fps).
- **Phân cảnh**: 3 phân cảnh (Toàn cảnh Đắk Lắk `scene_story_landscape` 22.5s, Xưởng rang xay thủ công `scene_story_workshop` 17.5s, Phần kết thương hiệu `scene_story_outro` 5.0s).
- **Lớp phim thực tế**: Tích hợp 2 đoạn phim quay thực tế (`ast_poc03_clip1_daklak` và `ast_poc03_clip2_workshop`) được xử lý cắt gọt tốc độ khung hình bất biến (CFR trim/crop cover).
- **Hòa âm đa kênh chuyên nghiệp**: Kênh giọng nói thuyết minh (`role: voice`, 0 dB) phối trộn cùng kênh nhạc nền acoustic (`role: music`, -14 dB) có phong bì suy giảm âm lượng (ducking) tự động.
- **Phiên bản quản lý**:
  - `Revision 1`: Mẫu phóng sự văn hóa cà phê Đắk Lắk ("ĐẮK LẮK — HƯƠNG SẮC CAO NGUYÊN").
  - `Revision 2`: Phiên bản di sản 2026 ("HƯƠNG VỊ DI SẢN — ĐẮK LẮK 2026") với lời kêu gọi đặt hàng gói quà tặng di sản.

---

## 3. Hệ thống Mã định danh Thương hiệu An toàn (Safe Brand Tokens)

Được hiện thực hóa tại [packages/sdk/src/brand-tokens.ts](../../packages/sdk/src/brand-tokens.ts) nhằm cho phép người dùng tùy biến giao diện video mà không gây rủi ro an ninh:
1. **Kiểm tra định dạng màu sắc nghiêm ngặt**: Cưỡng chế biểu thức chính quy màu Hex chuẩn (`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`).
2. **Loại trừ triệt để nguy cơ tiêm mã độc**: Chặn đứng các chuỗi chứa ký tự nguy hiểm hoặc biểu thức CSS/HTML như `;`, `url()`, `<script>`, `>`, `<`, `expression()`, `javascript:`.
3. **Kiểm tra phông chữ đã ghim (Pinned Fonts Guard)**: Chỉ chấp nhận các mã phông chữ tồn tại trong mảng `fonts` đã đăng ký của bản mẫu, ngăn ngừa việc tải phông chữ từ xa vi phạm chính sách Zero-Egress.
4. **Kiểm tra định danh tài sản**: Cưỡng chế định dạng tài sản máy chủ cấp phát `ast_[a-z0-9_-]+`.
5. **Chuyển đổi giao diện bất biến (`applyBrandTokens`)**: Cập nhật màu nền canvas, màu sắc các lớp tiêu đề (primaryColor), giá tiền / huy hiệu (accentColor), nút bấm (secondaryColor), và ảnh đại diện thương hiệu (logoAssetId) mà không làm biến đổi đối tượng gốc.

---

## 4. Giải thuật Tính toán Dàn trang & Phát hiện Tràn chữ (Preflight Text Layout & Overflow Guard)

Được triển khai tại [packages/sdk/src/text-overflow.ts](../../packages/sdk/src/text-overflow.ts) theo đặc tả tại [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) dòng 64 và 92:
1. **Ước tính bề rộng ký tự và từ vựng**:
   - Nhận diện các dấu thanh tổ hợp tiếng Việt (`\u0300-\u036f`) có độ rộng bước tiến bằng 0 (zero advance width).
   - Đo đạc chính xác bước tiến của ký tự hẹp (`i, l, 1, !`), ký tự hoa / số, và ký tự rộng (`W, M, %, ₫`).
2. **Mô phỏng ngắt dòng theo từ (Word Wrapping)**: Tự động phân tách dòng văn bản dựa trên giới hạn chiều rộng hộp chứa (`box.width`).
3. **Cưỡng chế các chế độ tràn chữ (Overflow Strategies)**:
   - `overflow: 'error'` (Mặc định): Nếu số dòng vượt quá `max_lines` hoặc tổng chiều cao vượt quá `box.height`, hệ thống lập tức ném lỗi cấu trúc `TextOverflowError` chứa đầy đủ thông tin vị trí vi phạm (`pointer`, `sceneId`, `layerId`, `lineCount`, `maxLines`, `requiredHeight`, `boxHeight`).
   - `overflow: 'shrink'`: Tự động hạ kích thước phông chữ theo từng bước điểm ảnh cho đến khi văn bản nằm vừa vặn trong hộp chứa; ném lỗi nếu kích thước cần hạ thấp hơn `min_font_size`.
   - `overflow: 'ellipsis'`: Cắt gọn văn bản ở dòng cuối cùng được phép và gắn dấu chấm lửng (`…`).

---

## 5. Bản kê Chứng cứ Bản quyền Thương mại (License Evidence Registry)

Tại [packages/templates/src/license-evidence.ts](../../packages/templates/src/license-evidence.ts), toàn bộ 22 tài sản được kiểm toán đối chiếu khớp 100% với `evidence/P0-03/rights-manifest.json`:
- **Phông chữ nhúng**: Inter (Bold, Regular, SemiBold - OFL-1.1), Noto Sans (Bold, Regular - OFL-1.1), Roboto (Bold, Regular - Apache-2.0).
- **Đồ họa & Hình ảnh**: Huy hiệu giảm giá SVG, nút bấm pill SVG, biểu đồ tăng trưởng SVG, thẻ chỉ số KPI SVG, biểu tượng đám mây SVG, hình ảnh hộp cà phê thủ công 3D (CC0-1.0 / Apache-2.0).
- **Âm thanh**: Track âm thanh im lặng chuẩn 48kHz (CC0-1.0), giọng đọc thuyết minh tiếng Việt bản quyền thương mại độc quyền (#CVE-VO-2026-01, #CVE-VO-2026-02), nhạc nền công nghệ ambient (CC0-1.0), nhạc cụ mộc Highland Acoustic Journey (CC-BY-4.0).
- **Đoạn phim thực tế**: Cảnh quay nương cà phê Đắk Lắk (Pexels Content License), cảnh quay xưởng rang xay thủ công (Pixabay Content License).
- **Hàm thẩm định tự động**: `verifyTemplateLicenseEvidence` quét duyệt toàn bộ cây phân cảnh của bản mẫu và xác nhận không có bất kỳ tài sản nào thiếu giấy phép thương mại hoặc sai lệch mã băm SHA-256.

---

## 6. Động cơ Khởi tạo và Tái tạo khi Người dùng Chỉnh sửa (Template Engine)

Được triển khai tại [packages/templates/src/template-engine.ts](../../packages/templates/src/template-engine.ts):
1. **Khởi tạo bản mẫu (`instantiateCuratedTemplate`)**:
   - Kiểm tra tính đầy đủ và hợp lệ của biến số theo `variables_schema`.
   - Gán giá trị mặc định cho các biến số vắng mặt.
   - Chuẩn hóa toàn bộ chuỗi ký tự sang Unicode NFC (`String.prototype.normalize('NFC')`).
   - Áp dụng các mã thương hiệu an toàn (`BrandTokens`).
   - Chạy kiểm tra chống tràn văn bản trước khi đưa vào hàng đợi dựng hình.
   - Biên dịch và xác thực thành công sang `CanonicalCompilerManifest`.
2. **Tái tạo phiên bản mới (`regenerateTemplate`)**:
   - Nhận bản đặc tả hiện tại và tập biến số chỉnh sửa mới.
   - Bảo toàn tuyệt đối tính ổn định của các định danh phân cảnh (`scene.id`).
   - Tự động tăng số hiệu phân cảnh (`scene.revision`) cho những phân cảnh có thay đổi nội dung.
   - So sánh chi tiết hai phiên bản thông qua `compareCompositionRevisions` để xác nhận các thay đổi có ảnh hưởng kết xuất (`is_render_affecting: true`).

---

## 7. Nhật ký Thực thi Kiểm thử Thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm thử | Mã thoát | Kết quả | Ghi chú |
|---|---|:---:|:---:|---|
| 1 | `./node_modules/.bin/tsc -p packages/sdk/tsconfig.json` | 0 | PASS | Biên dịch TypeScript SDK không cảnh báo |
| 2 | `./node_modules/.bin/tsc -p packages/templates/tsconfig.json` | 0 | PASS | Biên dịch TypeScript Templates không cảnh báo |
| 3 | `node --test packages/sdk/test/**/*.test.mjs` | 0 | PASS | 36/36 tests đạt (Brand Tokens, Text Overflow, TTS, Fallback, Quality) |
| 4 | `node --test packages/templates/test/**/*.test.mjs` | 0 | PASS | 17/17 tests đạt (Curated Pack, 3 Families, Revisions, License, Regeneration) |
| 5 | `node scripts/health-check.mjs` | 0 | PASS | Kiểm tra sức khỏe toàn bộ workspace đạt 100% |
| 6 | `/usr/bin/python3 scripts/validate_repo.py` | 0 | PASS | Kiểm tra tài liệu, liên kết và đồ thị phụ thuộc không lỗi |

---

## 8. Kết luận và Cổng Phê duyệt Tiếp theo (Next Steps & Gates)

- Nhiệm vụ `P5-01` đã hoàn thành toàn diện toàn bộ phạm vi kỹ thuật tại worktree cục bộ.
- Trạng thái công việc: `implemented_local`.
- Quyết định: Sẵn sàng bàn giao cho người đánh giá độc lập (`local completion awaiting review`).
- Không thực hiện push lên remote, không mở pull request (tuân thủ quy trình của AGY supervisor).
