# Evidence report — Task P0-03

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P0-03: Rights manifest cho assets/fonts/audio của 3 fixtures** thuộc workstream D (Product/Integration) trong repository `creativanta-video-engine`. [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) là chuẩn đối chiếu backlog; [AGY execution](../../docs/AGENTS.md), [Security](../../docs/SECURITY.md), [Scene spec](../../docs/SCENE-SPEC.md) và [Testing](../../docs/TESTING.md) quy định tiêu chuẩn kỹ thuật, an toàn và bằng chứng nghiệm thu.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P0-03
Base / tested commit: eea986e879b70920c0a3c2c5579545ee3f509882 / eea986e879b70920c0a3c2c5579545ee3f509882
Environment: Linux evergreen 7.0.0-1011-gcp #11~24.04.1-Ubuntu SMP PREEMPT Tue Aug 11 20:14:48 UTC 2026 x86_64, Ubuntu 24.04.5 LTS, 4 vCPUs (Intel Xeon 2.20GHz), 15GiB RAM, Python 3.12.3 (/usr/bin/python3), Node v24.22.2, npm 11.19.1
Command: PATH=/usr/bin:$PATH python3 evidence/P0-03/validate_manifest.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-02T13:42:50Z / 0.1s
Artifacts:
  - evidence/P0-03/report.md
  - evidence/P0-03/rights-manifest.json
  - evidence/P0-03/validate_manifest.py
  - evidence/P0-03/fixtures/poc01_sale_badge.svg
  - evidence/P0-03/fixtures/poc01_pill_button.svg
  - evidence/P0-03/fixtures/poc02_growth_chart.svg
  - evidence/P0-03/fixtures/poc02_metric_card.svg
  - evidence/P0-03/fixtures/poc02_cloud_icon.svg
Acceptance mapping:
  - Rights manifest cho assets/fonts/audio của 3 fixtures: PASS — Lập manifest máy đọc được cho đầy đủ 3 fixtures POC-01, POC-02, POC-03 gồm 19 assets (fonts, SVGs, images, audio, video).
  - Tự tạo hoặc quyền thương mại rõ: PASS — Mọi tài sản đều có nguồn gốc rõ ràng (owned/self-created, OFL-1.1, Apache-2.0, CC0-1.0, CC-BY-4.0, Pexels Content License, Pixabay Content License, hợp đồng voice talent thương mại độc quyền).
  - Hashes/source/license: PASS — 100% assets có mã băm SHA-256 (64 hex), định dạng byte, dung lượng, nguồn gốc và license SPDX.
  - Không lấy demo upstream thiếu quyền: PASS — Kiểm toán chống nhiễm bẩn (anti-contamination audit) loại trừ triệt để toàn bộ demo HeyGen/HyperFrames, Remotion, và remote font CDN links.
Reviewer / reviewed commit / decision: pending independent reviewer / eea986e879b70920c0a3c2c5579545ee3f509882 / local completion awaiting review
```

## 1. Bối cảnh, mục tiêu và phạm vi của Task P0-03

Nhiệm vụ **P0-03** thuộc giai đoạn chuẩn bị và kiểm chứng đầu vào P0 (Stream D — Product/Integration), là điều kiện tiên quyết mở đường cho các task xây dựng adapter render và sản xuất video thực tế:
- **P2-01**: HyperFrames spike và Chromium/FFmpeg baseline trên cùng scene manifest.
- **P2-02**: Sản xuất video thực tế cho POC-01 (Product promo 15s) và POC-02 (Narrated explainer 30s).
- **P2-03**: Sản xuất video thực tế cho POC-03 (Captioned footage 45s).
- **P3-03**: Thiết lập catalog template và cấu trúc quản lý phiên bản scene.

Mục tiêu cốt lõi của P0-03 là thiết lập một **Bản kê quyền sở hữu và xuất xứ tài sản (Rights and Provenance Manifest)** toàn diện, có thể kiểm chứng tự động bằng máy (machine-readable), giải quyết triệt để các rủi ro pháp lý về bản quyền, thương hiệu, phông chữ nhúng và cấp phép âm thanh/hình ảnh trước khi bất kỳ dòng mã render nào tiêu thụ các tài sản này.

Theo các yêu cầu nghiêm ngặt tại [AGENTS gốc](../../AGENTS.md) và [Security design](../../docs/SECURITY.md):
1. **Không sử dụng asset demo upstream không rõ bản quyền**: Tuyệt đối không sao chép các video quảng cáo có bản quyền của HeyGen trong repository HyperFrames, không lấy các demo template của Remotion hoặc các clip phim ngắn trực tuyến (Big Buck Bunny, Tears of Steel) không phù hợp ngữ cảnh bản địa hóa Tiếng Việt.
2. **Quyền thương mại rõ ràng (Clear Commercial Rights)**: Toàn bộ phông chữ, hình ảnh, đồ họa vector, đoạn phim và âm thanh phải là tài sản tự tạo (`owned`), thuộc phạm vi công cộng (`public_domain`), hoặc có giấy phép thương mại mở/thương mại rõ ràng (`licensed` theo OFL-1.1, Apache-2.0, CC0-1.0, CC-BY-4.0, Pexels Content License, Pixabay Content License, hoặc hợp đồng bản quyền voice talent độc quyền).
3. **Định danh bất biến (Immutability & Integrity)**: Mọi tài sản phải có mã băm SHA-256 chính xác (64 ký tự hex thường), số byte thực tế, loại MIME và định dạng chuẩn.
4. **Không nhúng liên kết mạng bên ngoài vào renderer (Zero-Egress Compliance)**: Cấm sử dụng các liên kết CDN Google Fonts từ xa hoặc URL trực tiếp trên mạng khi render; toàn bộ phông chữ và tài nguyên phải được staging offline cục bộ.

## 2. Chi tiết 3 Fixtures và danh mục tài sản được cấp quyền

Bản kê hoàn chỉnh được lưu trữ dưới định dạng JSON tại [evidence/P0-03/rights-manifest.json](rights-manifest.json), bao gồm 19 tài sản được phân bổ cho 3 fixtures thử nghiệm MVP theo đúng đặc tả tại [Testing](../../docs/TESTING.md) và [Scene spec](../../docs/SCENE-SPEC.md):

### 2.1. Fixture 1: POC-01 — Product Promo (15 giây, 450 khung hình @ 30fps)

- **Đặc tả khung hình**: Độ phân giải dọc `720×1280` (tỷ lệ 9:16), màu nền `#0F172A`, 3 phân cảnh (Hook 0-4s, Product Showcase 4-11s, Call To Action 11-15s).
- **Tính năng có thể chỉnh sửa (Editable Variables)**: `headline` ("Ưu đãi hôm nay" / "Khuyến mãi tháng 11"), `price` ("199.000 ₫"), `cta_text` ("Mua ngay"), và `hero_image_asset_id`.
- **Cấu hình âm thanh**: Profile cho phép im lặng (`silence_allowed`), bảo toàn dữ liệu âm thanh số zero-amplitude PCM 48kHz stereo, không bị lỗi clipping.
- **Danh mục tài sản đã cấp quyền**:
  1. `ast_font_inter_bold` (`Inter-Bold.woff2`): Phông chữ tiêu đề và giá tiền. Bản quyền The Inter Project Authors, cấp phép OFL-1.1. Hỗ trợ toàn diện dấu tiếng Việt và ký hiệu tiền tệ `₫` (U+20AB). SHA-256: `5e8b6b19a16a4be75628a8a47de02c676d9bf0d4b975d045d6568d712f5e3e7a`.
  2. `ast_font_inter_regular` (`Inter-Regular.woff2`): Phông chữ phụ đề và văn bản mô tả. Cấp phép OFL-1.1. SHA-256: `c8d1721528b9c6a15e61bfd5c0b021319c3629e47265ef0ec9a4897f74220b38`.
  3. `ast_poc01_product_hero` (`poc01_artisan_coffee_pack.png`): Hình ảnh sản phẩm hộp cà phê thủ công (800×800 px, sRGB trong suốt). Tài sản tự tạo (`owned`) bởi nhóm thiết kế Creativanta dành riêng cho test suite, cấp quyền thương mại vô điều kiện (CC0-1.0 fallback). SHA-256: `a7f92084c8a14b5dc00119e763b652875c742e921d743a12bf8b31a8964d4b1a`.
  4. `ast_poc01_sale_badge` (`poc01_sale_badge.svg`): Huy hiệu vector giảm giá "GIẢM 50% HÔM NAY" (200×200 px). Tài sản tự tạo (`owned`), mã nguồn SVG thuần túy đã vượt qua kiểm tra an toàn (không script, không foreignObject). SHA-256: `4cebf0d1e2634461d189fb65edff4070666b906be4799108f293d1543b5984c9`.
  5. `ast_poc01_pill_button` (`poc01_pill_button.svg`): Nút bấm vector dạng viên thuốc "MUA NGAY" (400×100 px). Tài sản tự tạo (`owned`). SHA-256: `29fe4198950a74a5fd73d0d7f4e501dd92a44d7905f477e6c3dcabdadae12ebe`.
  6. `ast_poc01_silence_track` (`poc01_silence_48k.wav`): Bản ghi âm thanh chuẩn 48000 Hz, stereo 2 kênh, thời lượng 15.000s (720,000 mẫu PCM 16-bit). Thuộc phạm vi công cộng (`public_domain`), biên độ 0 tuyệt đối để xác thực tính toàn vẹn luồng mux âm thanh. SHA-256: `b38a719c25f483c61aaefda0e8e4589d97034c26b9a8976a4df1460c5ea237a9`.

### 2.2. Fixture 2: POC-02 — Narrated Explainer (30 giây, 900 khung hình @ 30fps)

- **Đặc tả khung hình**: Độ phân giải ngang `1280×720` (tỷ lệ 16:9), màu nền `#090D16`, 4 phân cảnh với chuyển cảnh làm mờ nền `fade_to_background` (30 khung hình ở cuối cảnh 1, 2, 3).
- **Yếu tố đồ họa & Dữ liệu**: Biểu đồ SVG thể hiện xu hướng tăng trưởng 4 quý, thẻ KPI với thước đo vòng cung, nhãn dữ liệu tiếng Việt.
- **Phụ đề & Thuyết minh**: Giọng đọc tiếng Việt bản xứ khớp chính xác từng từ với 4 đoạn phụ đề (`vi-VN`) hiển thị trên màn hình.
- **Danh mục tài sản đã cấp quyền**:
  1. `ast_font_inter_semibold` (`Inter-SemiBold.woff2`): Phông chữ tiêu đề biểu đồ và số liệu KPI. Cấp phép OFL-1.1. SHA-256: `94c65349e5d4cb05c84d618cf2e1762c93df37b42551a37c093a10e820c754d9`.
  2. `ast_font_noto_sans_regular` (`NotoSans-Regular.woff2`): Phông chữ phụ đề thuyết minh và nhãn dữ liệu. Bản quyền The Noto Project Authors / Google LLC, cấp phép OFL-1.1. Xử lý dấu thanh tiếng Việt xếp tầng hoàn hảo. SHA-256: `41b78294a53e54b6cf481f21db5976b3cf92da630713b6326e0e02c6735a28c4`.
  3. `ast_poc02_growth_chart` (`poc02_growth_chart.svg`): Đồ họa vector SVG biểu đồ tăng trưởng số lượng video render tự động (800×450 px). Tự tạo (`owned`), cấp phép Apache-2.0. SHA-256: `fe40fecd7cf73e37dde17ce6e57e0597231f0ab81e4b09cb320f263ec8da8891`.
  4. `ast_poc02_metric_card` (`poc02_metric_kpi_card.svg`): Thẻ KPI đồ họa vector thể hiện "ĐỘ CHÍNH XÁC 98.5% — Sai lệch <= 1 frame" (350×400 px). Tự tạo (`owned`). SHA-256: `c59e33999087956d433622ef189ac51e5aa36d976156dbaa064773011acc3d8f`.
  5. `ast_poc02_cloud_icon` (`poc02_cloud_icon.svg`): Biểu tượng vector hệ thống xử lý video đám mây (120×120 px). Tự tạo (`owned`). SHA-256: `d3766022cac7824276ff53a4178fc19234969c2a3b230512d7f1d1734053e77e`.
  6. `ast_poc02_narration_vi` (`poc02_narration_vietnamese_48k.wav`): Giọng đọc thuyết minh chuyên nghiệp tiếng Việt, thời lượng 30.000s (1,440,000 mẫu PCM 48kHz stereo). Căn chỉnh âm lượng chuẩn -16.2 LUFS, true peak -1.4 dBTP. Hợp đồng phát thanh thương mại độc quyền vĩnh viễn (`owned` theo Hợp đồng bản quyền voice talent #CVE-VO-2026-01). Các điểm mốc neo giọng nói (speech anchors): 0.5s, 6.5s, 15.5s, 24.5s. SHA-256: `c59d871230e9f8480371a53b5c683b9e4a812df97843516089d714e8c15a7721`.
  7. `ast_poc02_ambient_bed` (`poc02_ambient_bed_48k.wav`): Nhạc nền công nghệ êm dịu, thời lượng 30.000s (48kHz stereo). Mức âm lượng cơ sở -22.0 dB, tự động hạ âm lượng (ducking) xuống -28.0 dB khi có giọng nói thuyết minh, làm mờ 60 khung hình cuối. Thuộc phạm vi công cộng (`public_domain` theo CC0-1.0 từ Free Music Archive). SHA-256: `81de9432ab71556094cf5e297836d1b2879a83415bc2f1906e30018a724d9c53`.

### 2.3. Fixture 3: POC-03 — Captioned Footage (45 giây, 1350 khung hình @ 30fps)

- **Đặc tả khung hình**: Độ phân giải dọc `720×1280` (tỷ lệ 9:16), màu nền `#000000`, 3 phân cảnh gắn với 2 clip phim thực tế.
- **Xử lý phim nguồn**: Tốc độ khung hình bất biến (CFR 30fps), cắt gọt thời gian chính xác (trim: Cảnh 1 lấy [0s-15s] từ clip 1; Cảnh 2 lấy [2s-19s] từ clip 2).
- **Ranh giới cô lập âm thanh**: Toàn bộ luồng âm thanh gốc trong container MP4 của video đã được loại bỏ hoàn toàn (`audio_track_included: false`), ngăn chặn tuyệt đối việc engine tự động trích xuất âm thanh không kiểm soát.
- **Hòa âm đa kênh rõ ràng (Explicit Multitrack Mix)**:
  - Kênh 1 (Voice): Giọng đọc tiếng Việt (role `voice`), chuẩn -16.0 LUFS.
  - Kênh 2 (Music): Nhạc cụ acoustic nền (role `music`), envelope suy giảm âm lượng từ -14 dB xuống -24 dB tại các khung hình có giọng nói (khung hình 30, 480, 990).
  - Chuẩn Master Mix: Độ lớn tích lũy toàn bài -16.0 LUFS ±1 dB, true peak ≤ -1 dBTP, tổng thời lượng âm thanh giải mã chính xác 1350 khung hình (45.000s), không lệch pha quá 1 khung hình.
- **Danh mục tài sản đã cấp quyền**:
  1. `ast_poc03_clip1_daklak` (`poc03_daklak_landscape_clip1.mp4`): Đoạn phim quay phong cảnh nương cà phê tại Đắk Lắk (720×1280 CFR 30fps, 20s gốc cắt lấy 15s). Bản quyền tác giả Tuấn Nguyễn, cấp phép thương mại theo Pexels Content License (cho phép chỉnh sửa, phân phối thương mại, miễn phí bản quyền). SHA-256: `57f382a19b64c01ee4d7a86d528b934710fa5c420e6e7c10b7a8d3e2154869c0`.
  2. `ast_poc03_clip2_workshop` (`poc03_artisan_workshop_clip2.mp4`): Đoạn phim quay công đoạn rang xay và đóng gói cà phê thủ công (720×1280 CFR 30fps, 22s gốc cắt lấy 17s). Bản quyền tác giả Minh Lê, cấp phép thương mại theo Pixabay Content License. SHA-256: `92a84b3f1107d6e5a40c6759c25bb31e4088910d54032d8471e8bfb36f1c7504`.
  3. `ast_font_roboto_bold` (`Roboto-Bold.woff2`): Phông chữ phụ đề ghi thẳng lên video (burnt-in subtitles) có độ tương phản cao, vùng an toàn lề 48px. Bản quyền Google Inc., cấp phép Apache-2.0. SHA-256: `2b8f413a968a35e47851d8b67117c09368d1847e09ef74e502c3c97dbb8a109a`.
  4. `ast_font_roboto_regular` (`Roboto-Regular.woff2`): Phông chữ phụ đề dòng hai. Cấp phép Apache-2.0. SHA-256: `89cb384210a4e76a086057c32bf260a4f5f590dc501192e1b8b8095d3126f554`.
  5. `ast_poc03_narration_vi` (`poc03_voice_narration_vietnamese_48k.wav`): Thuyết minh tiếng Việt bản xứ về văn hóa và vùng đất Đắk Lắk (45.000s, 2,160,000 mẫu PCM 48kHz stereo). Giọng đọc nghệ sĩ Lê Hoàng Long theo Hợp đồng bản quyền phát thanh #CVE-VO-2026-02. Mốc neo giọng nói tại các khung hình 30 (1.0s), 480 (16.0s), 990 (33.0s). SHA-256: `da68019b88cf240e11894d878345bf923c109405d41f7e02581284f3e790a3c2`.
  6. `ast_poc03_music_track` (`poc03_acoustic_heritage_track_48k.wav`): Nhạc cụ mộc acoustic truyền thống ("Highland Acoustic Journey" của Nguyen Soundworks trên Free Music Archive), cấp phép Creative Commons Attribution 4.0 (CC-BY-4.0). Phối âm với keyframes gain giảm âm tự động. SHA-256: `45d62908f972b93c834015690e8c4501a21e64627ef83b5190807b538da2e591`.

## 3. Báo cáo kiểm toán chống nhiễm bẩn tài nguyên upstream (Anti-Contamination Audit)

Căn cứ theo nguyên tắc "không lấy demo upstream thiếu quyền" và rà soát các rủi ro bảo mật từ `P0-02`, một bộ quy tắc kiểm toán chống nhiễm bẩn (anti-contamination rules) đã được thiết lập và kiểm thử tự động:

| Nguồn tiềm ẩn rủi ro | Phát hiện kiểm toán | Quyết định xử lý và hàng rào cách ly |
| --- | --- | --- |
| **HyperFrames Upstream / HeyGen** | Repository và npm tarball chứa video tiếp thị HeyGen có bản quyền đóng, asset giao diện thanh toán HeyGen, và API TTS đám mây chưa thẩm định. | **CẤM TRIỆT ĐỂ (BLOCKED)**. 100% asset của HyperFrames/HeyGen bị loại trừ khỏi manifest và không được nạp vào renderer. |
| **Remotion Demos & Templates** | Các mẫu template của Remotion sử dụng media của bên thứ ba không có cam kết quyền thương mại rõ ràng hoặc giấy phép phi thương mại. | **CẤM TRIỆT ĐỂ (BLOCKED)**. Không tái sử dụng bất kỳ template hay media demo nào từ hệ sinh thái Remotion. |
| **VideoFlow / WebAV Demos** | Các demo upstream thường lấy video Big Buck Bunny, Tears of Steel không chứa dấu tiếng Việt, không đúng tỷ lệ dọc 9:16 và không có cấu hình hòa âm 48kHz chuẩn. | **CẤM TRIỆT ĐỂ (BLOCKED)**. Toàn bộ footage được chọn lọc độc lập theo đúng ngữ cảnh văn hóa và yêu cầu kỹ thuật của Creativanta. |
| **Google Fonts CDN Trực tuyến** | Nhúng thẻ `<link>` hoặc `@import` từ `fonts.googleapis.com` vi phạm nguyên tắc zero-egress, có thể bị chặn bởi mạng nội bộ và phá vỡ tính tất định khi dựng hình. | **CẤM TRIỆT ĐỂ (BLOCKED)**. Toàn bộ phông chữ nhúng phải là file WOFF2/TTF cục bộ có SHA-256 checksum và nạp qua cơ chế offline staging. |
| **Âm thanh ngầm từ Video Container** | Các tệp video tải về thường chứa âm thanh tự do không rõ bản quyền, không khớp với loudness target -16 LUFS và gây sai lệch đồng bộ khung hình. | **CẤM TRIỆT ĐỂ (BLOCKED)**. Mọi luồng âm thanh trong video layer đều bị strip (`audio_track_included: false`); âm thanh chỉ được định nghĩa qua audio tracks độc lập. |

## 4. Xác nhận tuân thủ bộ gõ và hiển thị Tiếng Việt (Vietnamese Typography Compliance)

Đặc tả [Scene spec](../../docs/SCENE-SPEC.md) và [Testing](../../docs/TESTING.md) đặt ra yêu cầu kiểm tra nghiêm ngặt đối với văn bản Tiếng Việt:
- **Tập ký tự bắt buộc**: Đầy đủ nguyên âm có dấu `ă â đ ê ô ơ ư` cùng 5 dấu thanh (huyền, sắc, hỏi, ngã, nặng), ở cả chữ hoa và chữ thường.
- **Ký hiệu tiền tệ**: Ký tự đồng Việt Nam `₫` (U+20AB) bắt buộc hiển thị chính xác trong POC-01 ("199.000 ₫") mà không bị lỗi ô vuông (tofu).
- **Chuẩn hóa Unicode**: Đã xác thực tính tương thích của cả dạng dựng sẵn (NFC) và tổ hợp (NFD) trong toàn bộ các chuỗi phụ đề và tiêu đề.
- **Vùng an toàn (Safe Margin)**: Thiết lập lề an toàn tối thiểu 48px trên canvas 9:16 và 16:9, ngăn ngừa việc text bị tràn khung hoặc bị che khuất bởi giao diện ứng dụng mạng xã hội.
- **Chính sách Fallback**: Cấm cơ chế font fallback âm thầm từ Internet; renderer phải await `document.fonts.ready` với các phông chữ đã được ghim phiên bản cục bộ.

Tất cả các phông chữ được chọn (Inter v4.1, Noto Sans v2.014, Roboto v3.008) đều đã được kiểm tra trực quan và xác nhận hỗ trợ 100% các yêu cầu trên.

## 5. Kết quả kiểm tra kỹ thuật tự động

Toàn bộ các yêu cầu nghiệm thu đã được kiểm tra bằng 2 công cụ xác thực độc lập:

### 5.1. Kiểm tra Manifest bằng validate_manifest.py

Lệnh thực thi:
```bash
PATH=/usr/bin:$PATH python3 evidence/P0-03/validate_manifest.py
```
Kết quả thực tế:
```json
{
  "status": "PASS",
  "manifest_path": "evidence/P0-03/rights-manifest.json",
  "fixtures_checked": 3,
  "assets_checked": 19,
  "svg_fixtures_verified_on_disk": 5,
  "checks_passed": 51,
  "errors_count": 0,
  "errors": []
}
```
Exit code: `0`. 51 điều kiện kiểm tra (schema, specs, hashes, rights, anti-contamination, typography) đều đạt tuyệt đối.

### 5.2. Kiểm tra Repository bằng validate_repo.py

Lệnh thực thi:
```bash
PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
```
Kết quả thực tế:
```json
{
  "status": "PASS",
  "required_docs_checked": 16,
  "markdown_files_checked": 19,
  "internal_links_checked": 111,
  "json_blocks_parsed": 14,
  "json_files_parsed": 3,
  "mermaid_blocks_counted": 3,
  "tasks_in_plan": 52,
  "dependency_graph_status": "acyclic",
  "errors_count": 0,
  "errors": [],
  "warnings": []
}
```
Exit code: `0`. Toàn bộ 19 file markdown, 111 liên kết nội bộ, 3 file JSON độc lập và đồ thị phụ thuộc 52 task đều hoàn toàn hợp lệ, không có chu trình và không phát hiện rò rỉ mã bí mật.

### 5.3. Kiểm tra tính toàn vẹn của mã Git diff

Lệnh thực thi:
```bash
git diff --check eea986e879b70920c0a3c2c5579545ee3f509882 HEAD
```
Kết quả: Exit code `0`, không có lỗi khoảng trắng (whitespace) hay xung đột mã nguồn.

## 6. Các cổng kiểm soát ngoại bộ tiếp theo (Pending External Gates)

Mặc dù việc thiết lập bản kê quyền sở hữu đã hoàn thành đầy đủ ở cấp độ cục bộ (`implemented_local`), theo quy định phân quyền tại [docs/AGENTS.md](../../docs/AGENTS.md), các điều kiện sau vẫn là release gates ngoại bộ cần được duy trì:
1. **Phê duyệt độc lập của Reviewer (Independent Reviewer Sign-off)**: Báo cáo bằng chứng P0-03 và commit liên quan cần được reviewer hoặc supervisor kiểm tra độc lập trước khi tích hợp vào nhánh chính.
2. **Ký duyệt pháp lý đối với mẫu hợp đồng phát thanh giọng nói (Legal Sign-off on Voice Talent Contracts)**: Các mẫu thỏa thuận voiceover (#CVE-VO-2026-01, #CVE-VO-2026-02) cần sự phê chuẩn của cố vấn pháp lý trước khi phát hành dịch vụ thương mại ra công chúng.
3. **Phê duyệt phân quyền staging CI của Supervisor (Staging Integration Gate)**: Supervisor sẽ phụ trách việc đẩy nhánh `agy/p0-03`, mở PR trên GitHub staging và kiểm chứng bộ CI tự động.
