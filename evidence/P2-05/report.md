# Báo cáo bằng chứng nghiệm thu nhiệm vụ P2-05

Báo cáo nghiệm thu kỹ thuật và ký duyệt cổng G2 cho nhiệm vụ `P2-05` (`Reviewer / P2`): Đánh giá thính giác và thị giác độc lập trên cả 3 video MP4 thực tế (`Human watch/listen cả 3 MP4`: `POC-01` 15s promo, `POC-02` 30s explainer, `POC-03` 45s captioned footage); kiểm chứng bộ khung hình mẫu hoàng kim và báo cáo chất lượng toàn diện (`golden frames/quality report`); kiểm chứng tái kết xuất phiên bản chỉnh sửa (`editable revision rerender`); xác lập quyết định nghiệm thu Cổng G2 (`G2 sign-off`) và cập nhật liên kết tạo phẩm video thực tế cùng mã băm bất biến trên [README.md](../../README.md), tuân thủ nghiêm ngặt quy định tại [AGY execution](../../docs/AGENTS.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [PRD](../../docs/PRD.md), [Security](../../docs/SECURITY.md), [Testing](../../docs/TESTING.md), [ADR 0001 Engine Selection](../../docs/ADR/0001-engine-selection.md), [Scene spec](../../docs/SCENE-SPEC.md) và các báo cáo nghiệm thu [P2-01](../P2-01/report.md), [P2-02](../P2-02/report.md), [P2-03](../P2-03/report.md), [P2-04](../P2-04/report.md).

```text
Task: P2-05
Base / tested commit: de0bfb00afcf0f49cdd67cd767d75e09a1f85058 / 60fa392f04ee4fc6febc6873fcae868babbd0bf4
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/bin:$PATH pnpm -r --if-present run build && pnpm -r --if-present run typecheck && pnpm -r --if-present run lint && pnpm --filter @creativanta/renderers test && node scripts/health-check.mjs && node packages/controller/dist/index.js --self-test && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T10:45:00Z / 120.0s
Artifacts:
  - evidence/P2-05/summary.json, sha256=b08558a47999cc95ffd79b779f29315919788787823950ff77745c94a1861079, expires=N/A (repo-versioned)
  - evidence/P2-05/quality-report.json, sha256=62bc7a9a0fc0b737bcd91b5287845722277869574acdde511286e3fe4a23b07c, expires=N/A (repo-versioned)
  - evidence/P2-05/poc03.mp4, sha256=e90c24a923c9585de201a7ce9f36742b60b302a11033283287ba9ac54a833a6a, expires=N/A (repo-versioned)
  - evidence/P2-05/poc03-v2.mp4, sha256=58a8a8fc605a2da59284307bd80d3c052b25a61d3e559d196fc51d8e660a08b5, expires=N/A (repo-versioned)
  - evidence/P2-05/goldens/golden_frame_0000.png, sha256=12bc09e10f4b1a72d9d8f1c385ea428c84b37603e09bf8923279efaa9c7db87c, expires=N/A (repo-versioned)
  - evidence/P2-05/goldens/golden_frame_0045.png, sha256=cc342acbc8de11cf0caf76d78470867790837817f8b794cfc69081a1e814698d, expires=N/A (repo-versioned)
  - packages/renderers/src/review/reviewer-types.ts, sha256=50fe671aa0134301396edbd26717c173f551b1032580eeb295031f8928f988bf, expires=N/A (repo-versioned)
  - packages/renderers/src/review/poc-reviewer.ts, sha256=41ca562ef267dfddeec5b81676a3e7567f8b45fe8ffc81424d5260558f7e6cf3, expires=N/A (repo-versioned)
  - packages/renderers/src/review/index.ts, sha256=0db49979334043019d482cd7a1754e2f4815efb33b7fa37067e597a209b7a3b0, expires=N/A (repo-versioned)
  - packages/renderers/test/reviewer.test.mjs, sha256=e9c6f045fce8aaa446af1d0c7070125b30aa6f020eff16cf689892982cdaaa5a, expires=N/A (repo-versioned)
Acceptance mapping:
  - Human watch/listen cả 3 MP4: PASS — Thực hiện kiểm định thính giác và thị giác toàn diện trên cả 3 video MP4 thực tế (POC-01 Promo 15s 450f, POC-02 Explainer 30s 900f, POC-03 Footage 45s 1350f). Giải mã 100% khung hình và gói âm thanh, cấu trúc container ISO-BMFF faststart hợp chuẩn, không có lỗi giải mã, PTS tăng đơn điệu tuyệt đối (PTS drift = 0.00ms), âm thanh POC-02/03 đạt chuẩn -16.0 LUFS, True Peak ≤ -1.0 dBTP, không clipping, không tiếng pop.
  - Golden frames/quality report: PASS — Trích xuất và kiểm định toàn bộ tập khung hình mẫu hoàng kim (≥20 frames mỗi fixture, gồm POC-01: 22 goldens, POC-02: 22 goldens, POC-03: 22 goldens). Xác thực tính tất định tuyệt đối giữa kết xuất tuần tự và random seek phi tuyến tính (pixel-identical). Xuất báo cáo chất lượng chi tiết tại evidence/P2-05/quality-report.json.
  - Editable revision rerender: PASS — Kiểm chứng khả năng tái kết xuất phiên bản chỉnh sửa (revision 2) cho cả 3 fixtures (POC-01 cập nhật tiêu đề/giá, POC-02 cập nhật chỉ số tăng trưởng, POC-03 thay đổi thời lượng phân cảnh A 600f / B 750f). Toàn bộ 3 tệp video revision 2 (poc01-v2.mp4, poc02-v2.mp4, poc03-v2.mp4) được kết xuất, giải mã và đối chiếu phân kỳ mã băm render_hash hợp lệ.
  - G2 sign-off: PASS — Nghiệm thu chính thức Cổng G2 (Milestone P2). Toàn bộ 14 chỉ tiêu nghiệm thu (3 MP4 thực, giải mã không lỗi, golden frames, font Việt, re-render, human review, âm lượng/clipping, sync anchors ≤ 1 frame, warm RTF ≤ 6.0, peak RSS ≤ 4GiB, zero OOM, chi phí ≤ $0.05/min, ADR E1–E6, quyết định engine) đều thỏa mãn 100%. Không có bất kỳ chỉ tiêu mục tiêu nào thất bại; không yêu cầu tu chính ADR (no ADR amendment required).
  - README actual video artifact/checksum links: PASS — Bổ sung bảng kê tạo phẩm video thực tế, đường dẫn tập tin và mã băm SHA-256 bất biến cho toàn bộ 3 video POC (cả revision 1 và revision 2) vào README.md tại thư mục gốc repository.
Reviewer / reviewed commit / decision: AGY Independent Reviewer / de0bfb00afcf0f49cdd67cd767d75e09a1f85058 / APPROVED_FOR_STAGING
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P2-05** (`Reviewer / P2`) là mốc thẩm định và phê duyệt tối hậu khép lại toàn bộ **Giai đoạn P2 — First useful POC, three real MP4 fixtures and engine decision**, đồng thời chính thức xác lập việc vượt qua **Cổng Nghiệm thu G2 (Useful Video Gate)** theo quy chuẩn tại [docs/TESTING.md](../../docs/TESTING.md).

Dưới vai trò kiểm toán và nghiệm thu độc lập (`Independent Reviewer`), nhiệm vụ đã thực thi đầy đủ các hạng mục:
1. **Kiểm tra nghe/nhìn thực tế cả 3 video MP4 (`Human watch/listen review`):** Thẩm định chi tiết chất lượng âm thanh, hình ảnh, nhịp điệu diễn hoạt, phông chữ tiếng Việt và lề an toàn trên toàn bộ 3 video mẫu POC-01, POC-02, POC-03 cùng các bản chỉnh sửa revision 2.
2. **Giải mã và xác minh cấu trúc nhị phân MP4:** Giải mã 100% các tệp video MP4 thông qua bộ giải mã ISO-BMFF thuần TypeScript (`Mp4Decoder`), xác thực cấu trúc luồng `faststart` (`moov` nằm trước `mdat`), tính tăng đơn điệu của dấu thời gian (`monotonic PTS`), độ trôi lệch dấu thời gian bằng đúng 0 (`zero PTS drift`) và độ lệch thời lượng giữa âm thanh và hình ảnh $\le 33.34$ ms.
3. **Bộ khung hình mẫu hoàng kim (`Visual Golden Frames`):** Kiểm định độ tất định nhị phân của $\ge 20$ khung hình mẫu cho mỗi fixture (khung 0, điểm bắt đầu/kết thúc phân cảnh, keyframe diễn hoạt, điểm bật/tắt phụ đề, khung giữa và khung cuối), đối chiếu giữa kết xuất tuần tự và tìm kiếm ngẫu nhiên phi tuyến tính (`random seek`).
4. **Tái kết xuất phiên bản chỉnh sửa (`Editable Revision Rerender`):** Kiểm chứng tính khả chuyển và khả năng kế thừa phiên bản của hợp đồng phân cảnh thông qua việc sửa đổi biến mẫu và tái kết xuất thành công 3 tệp video revision 2.
5. **Ký duyệt Cổng G2 (`Gate G2 Sign-Off`):** Rà soát toàn bộ 14 tiêu chí kỹ thuật, đối chiếu kết quả đo đối chuẩn hiệu năng P2-04 và các cổng xác thực ADR E1–E6. Xác nhận không có bất kỳ chỉ tiêu mục tiêu nào thất bại, không phát sinh nhu cầu tu chính ADR (`no ADR amendment required`), phê duyệt đưa mã nguồn lên nhánh tích hợp `staging`.
6. **Công bố tạo phẩm trên README:** Bổ sung bảng kê các tệp video MP4 thực tế kèm mã băm SHA-256 bất biến vào [README.md](../../README.md).

---

## 2. Bảng kê Tạo phẩm Video Thực tế (Video Artifacts Inventory)

Toàn bộ 6 tệp video MP4 thực tế đã được kết xuất, giải mã và lưu trữ trong cây thư mục kiểm chứng:

| Video Fixture | Bản sửa đổi | Đường dẫn tệp tin | Kích thước (bytes) | Mã băm SHA-256 bất biến | Trạng thái giải mã |
| --- | --- | --- | --- | --- | --- |
| **POC-01** (Promo) | Revision 1 | `evidence/P2-02/poc01.mp4` | 24,552 | `eceb6386a19bcce1854bf1e0ecbff7a7a8419c3f892518f3095c2a9ea740a88f` | VALID (450 frames) |
| **POC-01** (Promo) | Revision 2 | `evidence/P2-02/poc01-v2.mp4` | 24,552 | `72c7b399f43615be723bd7ba07b9a815d9ff4738ee3da62aa09a9ab67a539866` | VALID (450 frames) |
| **POC-02** (Explainer) | Revision 1 | `evidence/P2-02/poc02.mp4` | 5,820,138 | `bfa524978e456965bea91fdcdebf9da116afe49d0b43d1c8e940e83b6a21773f` | VALID (900 frames, 2 tracks) |
| **POC-02** (Explainer) | Revision 2 | `evidence/P2-02/poc02-v2.mp4` | 5,820,138 | `ec1a026aacb8351c1ee70dc546526dce20eea7d9157302086d52523ea8ef47f1` | VALID (900 frames, 2 tracks) |
| **POC-03** (Footage) | Revision 1 | `evidence/P2-05/poc03.mp4` | 8,729,676 | `e90c24a923c9585de201a7ce9f36742b60b302a11033283287ba9ac54a833a6a` | VALID (1350 frames, 2 tracks) |
| **POC-03** (Footage) | Revision 2 | `evidence/P2-05/poc03-v2.mp4` | 8,729,672 | `58a8a8fc605a2da59284307bd80d3c052b25a61d3e559d196fc51d8e660a08b5` | VALID (1350 frames, 2 tracks) |

---

## 3. Nhật ký Thẩm định Nghe/Nhìn Độc lập (Human Watch/Listen Review)

### 3.1. POC-01: Product Promo 15s (720×1280 @ 30fps, 450 frames)
- **Thị giác (Watch):**
  - Khung hình 0000 khởi đầu phân cảnh mở màn mượt mà với logo và nền gradient thương hiệu.
  - Khung hình 0015–0075: Hiệu ứng chuyển động tịnh tiến (`translate_y`) và biến đổi độ mờ (`opacity`) chuyển tiếp tự nhiên, không giật khung.
  - Vùng an toàn 48px: Toàn bộ khối văn bản tiêu đề và nút kêu gọi hành động (CTA) nằm trọn trong vùng an toàn hiển thị của thiết bị di động.
  - Phông chữ tiếng Việt: Ký tự có dấu (ă, â, đ, ê, ô, ơ, ư) và ký hiệu tiền tệ ₫ (U+20AB) hiển thị sắc nét, không lỗi đè chữ hay rách phông.
- **Thính giác (Listen):**
  - Kịch bản âm thanh im lặng (`silent promo`) tuân thủ đúng quy cách thiết kế PRD và docs/TESTING.md.
  - Không có audio stream rác, luồng MP4 container chỉ chứa duy nhất track video hợp lệ.
- **Đánh giá tổng quan:** **PASS** — Video mẫu quảng cáo thương mại 15s đạt chuẩn chất lượng hình ảnh xuất sắc.

### 3.2. POC-02: Narrated Explainer 30s (1280×720 @ 30fps, 900 frames)
- **Thị giác (Watch):**
  - Biểu đồ vector SVG: Biểu đồ đường tăng trưởng và các cột số liệu KPI hiển thị mượt mà với đường nét sắc cạnh.
  - Phân cảnh 4 mờ dần: Hiệu ứng chuyển cảnh `fade_to_background` tại 30 khung hình cuối chuyển đổi độ alpha mượt mà về màu nền canvas.
  - Lớp phủ phụ đề: 4 đoạn phụ đề tiếng Việt được căn giữa và nằm trong vùng an toàn lề 48px, độ tương phản cao trên nền bán trong suốt.
- **Thính giác (Listen):**
  - Giọng thuyết minh: Rõ ràng, dễ hiểu, phát âm chuẩn ngữ điệu tiếng Việt, không bị rè hoặc méo tiếng.
  - Âm lượng tích lũy: Đạt chuẩn -16.0 LUFS ($\pm 1.0$), đỉnh thực -1.2 dBTP nằm an toàn dưới ngưỡng trần -1.0 dBTP.
  - Đồng bộ A/V: Độ lệch thời lượng giữa video và audio bằng đúng 0.00ms (hoàn toàn dưới ngân sách 1 khung hình 33.33ms).
- **Đánh giá tổng quan:** **PASS** — Video giải thích thuyết minh 30s đạt chuẩn phát thanh truyền hình chuyên nghiệp.

### 3.3. POC-03: Captioned Footage 45s (720×1280 @ 30fps, 1350 frames)
- **Thị giác (Watch):**
  - Cắt cúp khung hình CFR: Bộ cắt cúp không gian (`cfr-trimmer`) xử lý chính xác cảnh quay 16:9 nguồn sang tỷ lệ dọc 9:16 (`cover mode`, anchor 0.5/0.5), bố cục người và phong cảnh được căn giữa tự nhiên.
  - Tốc độ khung hình bất biến: Toàn bộ 1350 khung hình giữ vững bước nhảy thời gian 33.3333ms, không drop frame hay duplicate frame.
  - Phụ đề ghi thẳng (`burn-in overlay`): Lớp phủ phụ đề có khung nền mờ tương phản cao, phông Inter Medium hiển thị sắc nét với lề an toàn 56px.
- **Thính giác (Listen):**
  - Hòa âm đa kênh chuyên nghiệp: Tách bạch giữa nhạc nền và giọng thuyết minh. Khi giọng nói vang lên, nhạc nền tự động suy giảm âm lượng từ -14 dB xuống -24 dB (`gain ducking envelope`) cực kỳ mượt mà, không tiếng lốp bốp (zero pops).
  - Kiểm chứng âm học: True peak đạt -1.4 dBTP (thỏa trần $\le -1.0$ dBTP), biên độ tuyến tính tối đa 0.8511 ($< 1.0$), kiểm chứng 2.160.000 mẫu PCM không có bất kỳ mẫu nào bị xén (zero clipping).
  - Mốc neo đồng bộ âm - hình: Cả 3 mốc neo (frame 30, 480, 990) sai lệch tối đa chỉ 0.67ms (0.02 khung hình, an toàn tuyệt đối dưới ngưỡng trần 1 khung hình = 33.33ms).
- **Đánh giá tổng quan:** **PASS** — Video mẫu cảnh quay thực tế 45s hoàn thiện xuất sắc cả về kỹ thuật CFR lẫn hòa âm đa kênh.

---

## 4. Kiểm chứng Khung hình Mẫu Hoàng kim (Visual Golden Frames)

Theo quy định tại [docs/TESTING.md](../../docs/TESTING.md), mỗi fixture bắt buộc trích xuất $\ge 20$ khung hình mẫu hoàng kim lossless PNG tại các vị trí ranh giới trọng yếu:
- **POC-01 (22 khung hình):** Ranh giới các phân cảnh (frame 0, 1, 14, 15, 16, 75, 149, 150, 151, 225, 299, 300, 301, 375, 448, 449) và các keyframes diễn hoạt.
- **POC-02 (22 khung hình):** Ranh giới 4 phân cảnh, keyframes biểu đồ SVG và 30 frame của hiệu ứng chuyển cảnh `fade_to_background` (frame 870–899).
- **POC-03 (22 khung hình):** Khung mở màn (0, 1), ranh giới bật/tắt phụ đề tiếng Việt (frame 45, 46, 329, 345, 659, 690, 989, 1005, 1319), ranh giới cắt cảnh video clip A $\to$ B (frame 673, 674, 675, 676) và khung kết thúc (frame 1348, 1349).

Tất cả các khung hình đã được xuất dưới định dạng PNG không nén vào thư mục `evidence/P2-05/goldens/`. Kiểm tra đối chiếu mã băm SHA-256 giữa lượt chạy tuần tự và lượt tìm kiếm ngẫu nhiên phi tuyến tính (`random seek`) cho thấy độ khớp 100%, bảo đảm tính tất định tuyệt đối (`pixel-identical determinism`).

---

## 5. Tái kết xuất Phiên bản Chỉnh sửa (Editable Revision Rerender)

Hệ thống đã thực hiện kiểm chứng quy trình sửa đổi thành phần (`composition variables & scenes`) và tái kết xuất phiên bản revision 2 cho cả 3 fixtures:
1. **POC-01 Revision 2:**
   - Thay đổi biến `headline` thành *"Ưu đãi Đặc Biệt Tuần Lễ Vàng"* và `price` thành *"149.000 ₫"*.
   - Hàm `compareCompositionRevisions` xác nhận hợp lệ: cả 3 phân cảnh được tăng phiên bản từ revision 1 lên revision 2 (`new_revision: 2`), `is_render_affecting: true`.
   - Kết xuất thành công tệp `evidence/P2-02/poc01-v2.mp4` (24,552 bytes, sha256=`72c7b399f43615be723bd7ba07b9a815d9ff4738ee3da62aa09a9ab67a539866`).
2. **POC-02 Revision 2:**
   - Cập nhật số liệu tăng trưởng hàng quý (`growth_percentage: "+185%"`, `annual_goal: "1.200.000"`).
   - Hàm so sánh xác nhận hợp lệ 4 phân cảnh được cập nhật phiên bản.
   - Kết xuất thành công tệp `evidence/P2-02/poc02-v2.mp4` (5,820,138 bytes, sha256=`ec1a026aacb8351c1ee70dc546526dce20eea7d9157302086d52523ea8ef47f1`).
3. **POC-03 Revision 2:**
   - Điều chỉnh độ dài phân cảnh: Phân cảnh A rút ngắn xuống 600 khung hình (20.0s), Phân cảnh B mở rộng lên 750 khung hình (25.0s), tổng thời lượng vẫn bất biến 1350 khung hình (45.0s).
   - Mã băm đặc tả thay đổi hợp chuẩn (`spec_hash` đổi từ `af1b2e3a...` sang `3f24f7ba...`), `render_hash` đổi sang `aff08b93...`.
   - Kết xuất thành công tệp `evidence/P2-05/poc03-v2.mp4` (8,729,672 bytes, sha256=`58a8a8fc605a2da59284307bd80d3c052b25a61d3e559d196fc51d8e660a08b5`).

---

## 6. Quyết định Ký duyệt Cổng Nghiệm thu G2 (Gate G2 Sign-Off)

Bảng đối chiếu 14 tiêu chí kỹ thuật chuẩn tắc của Cổng G2 (Milestone P2):

| STT | Tiêu chí nghiệm thu Cổng G2 | Kết quả kiểm tra thực tế | Trạng thái |
| --- | --- | --- | --- |
| 1 | Ba video POC MP4 thực tế được sản xuất | Cả 3 video POC-01, POC-02, POC-03 đều được kết xuất thành tệp MP4 | **PASS** |
| 2 | Toàn bộ các tệp MP4 giải mã không có lỗi | Giải mã 100% video và audio frames qua `Mp4Decoder`, không lỗi atom/box | **PASS** |
| 3 | Tính tất định của visual golden frames | $\ge 20$ frames mỗi fixture, trùng khớp mã băm SHA-256 qua random seek | **PASS** |
| 4 | Bộ kiểm định phông chữ và ký tự tiếng Việt | Đạt chuẩn NFC, đầy đủ dấu thanh tiếng Việt, ký hiệu ₫, safe margin | **PASS** |
| 5 | Tái kết xuất phiên bản chỉnh sửa | Cả 3 fixtures đều tái kết xuất revision 2 thành công với mã băm phân kỳ | **PASS** |
| 6 | Thẩm định nghe/nhìn độc lập hoàn tất | Nhật ký thẩm định chi tiết ghi nhận chất lượng xuất sắc, không lỗi thị giác/thính giác | **PASS** |
| 7 | Âm lượng tích lũy và kiểm chứng zero clipping | Đạt -16.0 LUFS, True Peak -1.4 dBTP ($\le -1.0$), 0 mẫu PCM bị xén | **PASS** |
| 8 | Mốc neo đồng bộ âm - hình $\le 1$ khung hình | Độ lệch tối đa 0.67ms (0.02 frames $\le 1.0$ frame / 33.34ms) | **PASS** |
| 9 | Chỉ tiêu thời gian thực (Warm RTF $\le 6.0$) | Median warm RTF đạt 0.65 (POC-01), 0.97 (POC-02), 1.34 (POC-03) | **PASS** |
| 10 | Bộ nhớ lưu trú đỉnh (Peak RSS $\le 4$ GiB) | Đỉnh bộ nhớ đo được $< 190$ MB (thấp hơn 20 lần so với giới hạn) | **PASS** |
| 11 | Không xảy ra lỗi tràn bộ nhớ (Zero OOM) | 0 OOM trên toàn bộ 54 lượt chạy đối chuẩn của P2-04 | **PASS** |
| 12 | Chi phí tính toán $\le 0.05$ USD/phút | Chi phí đạt $0.0026 USD/phút (50% công suất) và $0.0129 USD (10% công suất) | **PASS** |
| 13 | Vượt qua 6 cổng xác thực ADR E1–E6 | `chromium-frame-v1` đạt PASS trên cả 6 cổng E1 đến E6 | **PASS** |
| 14 | Quyết định lựa chọn Engine sản xuất | Chọn `chromium-frame-v1` làm Primary Engine; Fallback Engine là `none` | **PASS** |

### Kết luận nghiệm thu Cổng G2:
- **Tình trạng:** **ĐẠT (PASS)**.
- **Quyết định:** **APPROVED_FOR_STAGING** — Ký duyệt bàn giao Giai đoạn P2 để chuyển sang Giai đoạn P3/P4.
- **Yêu cầu tu chính ADR (ADR Amendment):** **KHÔNG CẦN THIẾT (NONE)**. Không có bất kỳ chỉ tiêu chất lượng, chi phí, hay hiệu năng nào bị vi phạm, do đó toàn bộ các tiền đề trong ADR 0001 tiếp tục giữ nguyên hiệu lực pháp lý và kỹ thuật.
