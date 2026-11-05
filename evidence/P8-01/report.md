# Evidence report — Task P8-01

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P8-01: Rà soát WebAV/Mediabunny (phiên bản chính xác, pháp lý, phân phối trình duyệt) và thiết lập Ma trận năng lực Desktop/Mobile/Browser Codec/Bảo mật** thuộc workstream D+C (Product/Integration + Security/Infra) trong repository `creativanta-video-engine`. [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) là chuẩn đối chiếu backlog; [AGY execution](../../docs/AGENTS.md), [Security](../../docs/SECURITY.md) và [Testing](../../docs/TESTING.md) quy định tiêu chuẩn an toàn và chứng cứ nghiệm thu.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P8-01
Base / tested commit: e9046baeb51bbe335ffaf629bb41cc6aaed8b395 / 97bca0129f00991cc3c40a937d4edfb3d781be36
Environment: Linux evergreen 7.0.0-1011-gcp #11~24.04.1-Ubuntu SMP PREEMPT Tue Aug 11 20:14:48 UTC 2026 x86_64, Ubuntu 24.04.5 LTS, 4 vCPUs (Intel Xeon 2.20GHz), 15GiB RAM, Python 3.12.3 (/usr/bin/python3), Node v24.22.2, pnpm 12.16.1
Command:
  - pnpm install --frozen-lockfile
  - pnpm -r --if-present lint
  - pnpm -r --if-present typecheck
  - pnpm -r --if-present test
  - pnpm -r --if-present build
  - node --test packages/browser-export/test/capability-matrix.test.mjs
  - node scripts/health-check.mjs
  - python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-05T02:33:00Z / 295.0s
Artifacts:
  - evidence/P8-01/report.md
  - evidence/P8-01/artifacts-review.json
  - evidence/P8-01/browser-capability-matrix.json
  - pnpm-lock.yaml
  - packages/browser-export/package.json
  - packages/browser-export/tsconfig.json
  - packages/browser-export/src/types.ts
  - packages/browser-export/src/capability-matrix.ts
  - packages/browser-export/src/legal-review.ts
  - packages/browser-export/src/index.ts
  - packages/browser-export/test/capability-matrix.test.mjs
Acceptance mapping:
  - WebAV/Mediabunny exact version/legal/browser-distribution review: PASS — Rà soát toàn diện siêu dữ liệu npm registry, mã băm SHA-512, shasum, license SPDX, rủi ro phân phối trình duyệt theo MPL-2.0 và MIT.
  - Capability matrix desktop/mobile/browser codec/security: PASS — Thiết lập ma trận 6 nền tảng (Chrome/Edge/Safari/Firefox Desktop, iOS Safari, Android Chrome), codec H.264/HEVC/VP9/AV1/AAC/Opus, container MP4/WebM, và giới hạn bộ nhớ jetsam di động.
  - Fallback to server job: PASS — Tự động chuyển giao sang POST /render-jobs khi trình duyệt thiếu encoder, vượt trần bộ nhớ hoặc chứa custom code.
  - No code shipping trước review: PASS — Kiểm soát nghiêm ngặt cổng EXT-P8-01 bằng assertBrowserExportGateApproved; chặn khởi tạo render pipeline trước khi có chữ ký phê duyệt độc lập.
  - Monorepo lockfile synchronization: PASS — Đồng bộ pnpm-lock.yaml với packages/browser-export giải quyết dứt điểm lỗi ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER trong GitHub CI PR #49.
Reviewer / reviewed commit / decision: pending independent reviewer / 97bca0129f00991cc3c40a937d4edfb3d781be36 / local completion awaiting external review
```

---

## 1. Bối cảnh, mục tiêu và ranh giới an toàn

Giai đoạn P8 trong lộ trình `creativanta-video-engine` khảo sát khả năng xuất video trực tiếp trên trình duyệt máy khách (client-side browser export). Đây là tính năng tùy chọn (optional) nhằm giảm tải tài nguyên tính toán của máy chủ đối với các tác vụ dựng video đơn giản của người dùng.

Tuy nhiên, theo quy định bất biến tại [AGENTS gốc](../../AGENTS.md) và [Security design](../../docs/SECURITY.md):
1. **Không phân phối mã chưa kiểm duyệt (No code shipping trước review):** Không cài đặt hoặc khởi chạy bất kỳ mã nhị phân hay mã nguồn bên thứ ba nào vào môi trường phân phối người dùng cuối trước khi hoàn tất rà soát pháp lý và an ninh.
2. **Không chạy mã tùy ý trên trình duyệt:** Trình duyệt người dùng chỉ thông dịch cấu trúc định dạng chuẩn Scene Spec 1.0; tuyệt đối không thực thi các đoạn mã JavaScript động (`eval`, `new Function`) hoặc nạp mã ngoại vi.
3. **Bảo toàn ranh giới Zero-Egress và cách ly Tenant:** Trình duyệt máy khách chỉ được tiếp cận các tài sản thông qua chữ ký tạm thời có thời hạn ngắn (signed URLs TTL ≤10 phút) hoặc các tệp cục bộ do người dùng cung cấp (OPFS / File API); không lưu trữ khóa bí mật API lâu dài trong trình duyệt.
4. **Không nhầm lẫn giữa engine trình duyệt và máy chủ:** Máy chủ xuất video chuẩn MP4 (với Chromium sandbox và FFmpeg hợp đồng nội bộ) vẫn là nguồn chân lý có thẩm quyền cao nhất (`authoritative baseline`). Trình duyệt chỉ là môi trường dựng tăng tốc tùy chọn có cơ chế thoái lui (`server fallback`) tự động.

---

## 2. Kiểm toán chi tiết 2 họ thư viện ứng viên: WebAV và Mediabunny

Đã thực hiện kiểm tra siêu dữ liệu registry npm, cây phụ thuộc, tập lệnh cài đặt và mã băm mật mã đối với toàn bộ các gói phần mềm liên quan:

### 2.1. Họ thư viện WebAV (`WebAV-Tech/WebAV`)

| Gói phần mềm | Phiên bản | Mã băm toàn vẹn SHA-512 | Shasum SHA-1 | Giấy phép | Trạng thái rà soát |
| --- | --- | --- | --- | --- | --- |
| `@webav/av-cliper` | 1.2.8 | `sha512-lxCXgP5AJsl+6xRo1puU5lTv7rAsxX9StQVK8xYdbg02p9FswCt76iTPqNxmlJ0ZfV1g+lmyNufLXu/qBAnJnA==` | `d1ad2e65f8baa0f37dca91c070d582ff4f5d5daa` | MIT (repo gốc) | **CHO PHÉP THỬ NGHIỆM CÓ ĐIỀU KIỆN (P8-02 SPIKE)** |
| `@webav/av-canvas` | 1.2.8 | `sha512-j7wvlmdQcwSeMDPiOjfnw2LR/+F/yqYScs9dzwh8SHQre6nnnxS/eOPBghhgVx/RlqFk6VR4UYtnXlhfgnhWtA==` | `87a059ef51b6b61e331f06e183fdb1fccd0bf0a5` | MIT (repo gốc) | **CHO PHÉP THỬ NGHIỆM CÓ ĐIỀU KIỆN (P8-02 SPIKE)** |
| `@webav/av-recorder` | 1.2.8 | `sha512-Ju7/BOTU7p/BPXh98oZHzBGF2B849lmEI1j0G76y4Aiv8S3MoX1l5FTIj0J2gFZudw0p0/NS41AGqsT4PhY6ng==` | `f55ac27806c370c1c2e6d03fd5701620a683192e` | MIT (repo gốc) | **CHO PHÉP THỬ NGHIỆM CÓ ĐIỀU KIỆN (P8-02 SPIKE)** |
| `@webav/internal-utils` | 1.2.8 | `sha512-ZiEXl4U6PRqotkux0eTUdVn5zxbzXYm4Xfjt+HvH5bowwGSJVho/mmbPrdPf3ZRtfIu0aWCWa04LUDBQuY5ltA==` | `dd16608363eb1bedbbb6e592bfdd0bdcba26d353` | MIT (repo gốc) | **PHỤ THUỘC NỘI BỘ (KHÔNG GỌI TRỰC TIẾP)** |
| `@webav/mp4box.js` | 0.5.7 | `sha512-KgScEtDpiLnWvj1Rj8Ri9fDWxTjfdNr7cmY/PT88EmttHh6cLxMAeyD/W8Vydes4z7qV/c5VDAaP4cTlaO0E9g==` | `fa100d724c3ddd4cd24fb1243f8a274823c49d38` | BSD-3-Clause | **CHO PHÉP CÓ ĐIỀU KIỆN (LƯU NOTICE BSD)** |
| `opfs-tools` | 0.7.2 | `sha512-ITMh4BnRCh/wFDFFaTsZOFLGUCoXbtn4KH1qh4S2LLF31+afqhXxz0NK74wqyRB5tbgnDD2SDcn7J4HeEVuvgg==` | `3d1be1260fe1efd43f61de981ec57cd133effd60` | MIT | **ĐÃ KIỂM TOÁN (AUDITED CLIENT DEP)** |
| `wave-resampler` | 1.0.0 | `sha512-bE3rbpZXuKAV52Cd8/BeJvy82ZqEHK8pPWHrZ9JioaVVTBlmWbDC+u4p9blhFcf0Skepb4hlOAHc25XfqLC48g==` | `127502338d28e6d5315be1abb06665c04bbb4fc6` | MIT | **ĐÃ KIỂM TOÁN (AUDITED CLIENT DEP)** |

#### Các phát hiện kiểm toán đối với WebAV:
1. **Tập lệnh vòng đời (Lifecycle Scripts):** Đã kiểm tra `has_lifecycle_scripts: false` đối với toàn bộ các gói trên npm. Không có postinstall script nào tự động tải nhị phân từ internet (khác với rủi ro puppeteer trong P0-02).
2. **Thiếu trường license trong package.json:** Các tệp `package.json` phát hành của `@webav/av-cliper`, `@webav/av-canvas`, `@webav/av-recorder` bỏ trống trường `"license"`. Tuy nhiên, kho chứa gốc `WebAV-Tech/WebAV` khai báo rõ ràng tệp `LICENSE` theo chuẩn MIT (1059 bytes). Cần lưu ý bổ sung rõ ràng khai báo SPDX khi đóng gói.
3. **Phân tách tính năng thương mại "WebAV Pro":** Tác giả WebAV duy trì phiên bản "WebAV Pro" (chứa giao diện dòng thời gian dựng video nâng cao, bộ lọc chuyển cảnh phức tạp) dưới dạng mã nguồn đóng thương mại. **Quy định nghiêm ngặt:** Chỉ sử dụng phần lõi mã nguồn mở; tuyệt đối không tham chiếu hoặc phụ thuộc vào bất kỳ thành phần WebAV Pro nào.
4. **Nhiễm bẩn tài sản mẫu (Sample Contamination):** Các đoạn mã ví dụ upstream của WebAV sử dụng video hoạt hình Big Buck Bunny và Tears of Steel không chứa dấu tiếng Việt, không có tỷ lệ dọc 9:16 và không có cấu hình hòa âm 48kHz chuẩn. Đã bị chặn hoàn toàn theo chính sách bản quyền P0-03 và `checkAntiContamination`.

---

### 2.2. Thư viện Mediabunny (`Vanilagy/mediabunny`)

| Gói phần mềm | Phiên bản | Git Head Commit | Mã băm toàn vẹn SHA-512 | Shasum SHA-1 | Giấy phép | Kích thước giải nén |
| --- | --- | --- | --- | --- | --- | --- |
| `mediabunny` | 1.65.2 | `173f6b70765fa3a6ffc1c82737514416fa559ef5` | `sha512-goZpibvo/5hkc/56WVNm93Ini+o7K4y8aXA20c/BN1B+m3L5aHQa8MTvO+S1APg/YI8kMILtrX6QCqUtxLW7bA==` | `ef1db034a70f11702dba2fbe65e8342d268dfd38` | MPL-2.0 | 11,355,831 bytes (~11.35 MiB) |

#### Các phát hiện kiểm toán đối với Mediabunny:
1. **Độc lập phụ thuộc hoàn toàn (Zero Runtime Dependencies):** Gói `mediabunny` thuần TypeScript, không có bất kỳ runtime dependency nào (chỉ có `@types/dom-webcodecs` và `@types/dom-mediacapture-transform` trong devDependencies).
2. **Không có tập lệnh cài đặt mạng:** `has_lifecycle_scripts: false`. Cài đặt hoàn toàn tĩnh và có tính lặp lại tất định.
3. **Phạm vi chức năng:** Cung cấp đầy đủ năng lực phân tách (demuxing), ghép luồng (muxing), tích hợp WebCodecs và tạo tệp chứa phân mảnh MP4 (`fragmented MP4` - fMP4) hoặc WebM trực tiếp trong bộ nhớ hoặc OPFS của trình duyệt.

---

## 3. Rà soát pháp lý bằng sáng chế và nghĩa vụ phân phối trình duyệt (Patent Licensing & Browser Distribution)

### 3.1. Vấn đề bằng sáng chế H.264 (AVC) và AAC
- **Mã hóa H.264 qua WebCodecs bản địa trình duyệt (`ALLOWED_NO_ROYALTY_FOR_WEBAPP`):**
  Khi trình duyệt thực hiện mã hóa video H.264 thông qua API WebCodecs chuẩn (`VideoEncoder` với codec `avc1.42E01E` hoặc `avc1.4D401F`), trình duyệt gọi trực tiếp vào bộ giải mã phần cứng/hệ điều hành (như Apple VideoToolbox trên macOS/iOS, Microsoft Media Foundation trên Windows, Android MediaCodec trên Android). Các nhà sản xuất nền tảng (Apple, Microsoft, Google) đã sở hữu giấy phép bằng sáng chế từ liên minh MPEG-LA / Via LA cho phần cứng và hệ điều hành của họ. Ứng dụng web Creativanta không phân phối tệp nhị phân phần mềm mã hóa và **không phải chịu nghĩa vụ nộp phí bản quyền bằng sáng chế phần mềm H.264**.
- **Cấm đóng gói bộ mã hóa H.264 phần mềm WASM (`STRICTLY_BLOCKED`):**
  Nghiêm cấm tuyệt đối việc biên dịch thư viện x264 (GPL) sang WebAssembly để phân phối về trình duyệt máy khách. Việc này không những gây rủi ro lây nhiễm giấy phép copyleft GPL vào toàn bộ mã nguồn frontend của Creativanta mà còn trực tiếp vi phạm nghĩa vụ cấp phép bằng sáng chế MPEG-LA mà không có điều khoản bảo hộ miễn trừ.
- **Mã hóa AAC:** WebCodecs `AudioEncoder` với `mp4a.40.2` (AAC-LC) được cấp phép thông qua nền tảng thiết bị người dùng. Nếu trình duyệt không hỗ trợ (như Firefox trên Linux), hệ thống tự động chuyển sang fallback máy chủ.
- **Codec tự do (Royalty-free):** VP9, AV1 và Opus là các chuẩn mở hoàn toàn miễn phí tiền bản quyền, được khuyến nghị sử dụng khi xuất tệp WebM.

### 3.2. Đánh giá giấy phép MPL-2.0 và phân phối JavaScript trên trình duyệt (Browser Distribution)
Giấy phép **Mozilla Public License 2.0 (MPL-2.0)** áp dụng cơ chế copyleft yếu ở cấp độ tệp (file-level weak copyleft):
1. **Điều khoản Tác phẩm Lớn hơn (Larger Work - Mục 3.3):**
   Việc tích hợp `mediabunny` vào gói phân phối trình duyệt của Creativanta hoàn toàn hợp pháp dưới hình thức Tác phẩm Lớn hơn (`Larger Work`), với điều kiện mã nguồn của `mediabunny` được giữ nguyên vẹn như một module độc lập và không bị sửa đổi, trộn lẫn trực tiếp vào các tệp mã nguồn độc quyền của Creativanta.
2. **Nghĩa vụ khi phân phối dạng thực thi trên trình duyệt (Distribution of Executable Form - Mục 3.2):**
   Khi phân phối mã JavaScript đã đóng gói/minified cho người dùng trình duyệt, Creativanta phải:
   - Giữ nguyên thông báo bản quyền và giấy phép MPL-2.0 trong tệp tín dụng mã nguồn (`client bundle credits / NOTICE`).
   - Cung cấp đường dẫn hướng dẫn người dùng cách thức truy cập mã nguồn mở của Mediabunny (ví dụ: liên kết tới kho mã nguồn công khai `https://github.com/Vanilagy/mediabunny`).
3. **Điều khoản cấp phép bằng sáng chế (Mục 5):**
   MPL-2.0 chứa điều khoản cấp phép bằng sáng chế rõ ràng từ mọi bên đóng góp mã nguồn cho Mediabunny, bảo vệ bên sử dụng khỏi các khiếu nại bằng sáng chế trực tiếp liên quan đến mã nguồn của gói.

---

## 4. Ma trận năng lực trình duyệt, thiết bị di động, codec và bảo mật (Capability Matrix)

Đã thiết lập bộ ma trận phân tích năng lực chi tiết tại `evidence/P8-01/browser-capability-matrix.json` và triển khai bộ logic thẩm định tại `packages/browser-export/src/capability-matrix.ts`:

### 4.1. Ma trận nền tảng (Desktop vs Mobile)

| Nền tảng | Nhân duyệt | WebCodecs VideoEncoder | WebCodecs AudioEncoder | DedicatedWorker + OffscreenCanvas | Giới hạn bộ nhớ an toàn (Memory Ceiling) | Khả thi xuất video cục bộ | Hành vi khi không đủ điều kiện |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Chrome Desktop** | Blink | **HỖ TRỢ** (H.264, VP9, AV1) | **HỖ TRỢ** (AAC, Opus) | **HỖ TRỢ ĐẦY ĐỦ** | 4,096 MiB | **ĐẠT (720p & 1080p)** | Thoái lui sang máy chủ nếu vượt 1080p |
| **Edge Desktop** | Blink | **HỖ TRỢ** (H.264, VP9, AV1) | **HỖ TRỢ** (AAC, Opus) | **HỖ TRỢ ĐẦY ĐỦ** | 4,096 MiB | **ĐẠT (720p & 1080p)** | Thoái lui sang máy chủ nếu vượt 1080p |
| **Safari Desktop (macOS)** | WebKit | **HỖ TRỢ** (H.264, HEVC) | **HỖ TRỢ** (AAC, Opus) | **HỖ TRỢ** (macOS 16.4+) | 4,096 MiB | **ĐẠT (H.264/HEVC MP4)** | Thiếu VP9/AV1 -> Thoái lui máy chủ |
| **Firefox Desktop** | Gecko | **KHÔNG HỖ TRỢ** (Bị khóa cờ) | **KHÔNG HỖ TRỢ** | **HỖ TRỢ** | 2,048 MiB | **BỊ CHẶN** | **BẮT BUỘC THOÁI LUI SANG MÁY CHỦ** |
| **iOS Safari (iPhone/iPad)** | WebKit | **HỖ TRỢ** (H.264, HEVC) | **HỖ TRỢ** (AAC) | **HỖ TRỢ** (iOS 17+) | **1,024 MiB (Jetsam Ceiling)** | **ĐẠT GIỚI HẠN 720p** | **1080p/4K BẮT BUỘC THOÁI LUI MÁY CHỦ** |
| **Android Chrome** | Blink | **HỖ TRỢ** (Android MediaCodec) | **HỖ TRỢ** (AAC, Opus) | **HỖ TRỢ** | 2,048 MiB | **ĐẠT (Cần kẹp 1-2 encoder)** | Quá tải phần cứng -> Thoái lui máy chủ |

### 4.2. Khung kiểm soát an ninh xuất video trình duyệt (Security Boundaries)
1. **Kiểm soát rủi ro tràn bộ nhớ và sập tab (Memory DoS & Jetsam Protection):**
   Trên các thiết bị di động như iOS Safari, tiến trình WebKit bị hệ điều hành giám sát gắt gao qua cơ chế Jetsam. Việc cấp phát các khung hình 1080p không nén trong bộ nhớ canvas sẽ dẫn tới tình trạng cạn kiệt RAM và sập tab đột ngột. Hàm `evaluateExportFeasibility` tự động từ chối kết xuất 1080p và 4K trên thiết bị di động, tự động chuyển tác vụ thành một job gửi lên máy chủ (`POST /render-jobs`).
2. **Khắc phục đóng băng tiến trình nền (Background Tab Freezing):**
   Trình duyệt tự động dừng `requestAnimationFrame` và điều tiết giảm xung nhịp CPU khi người dùng chuyển sang tab khác. Giải pháp kiến trúc bắt buộc: Toàn bộ vòng lặp render và mã hóa phải được thực thi bên trong `DedicatedWorker` kết hợp `OffscreenCanvas`.
3. **Cấm thực thi mã tùy ý (Zero Arbitrary Script Execution):**
   Bộ xuất video trình duyệt chỉ thông dịch cây cú pháp Scene Spec 1.0 thuần túy. Nếu phát hiện scene sử dụng `engine: "custom-html-v1"` hoặc chứa gói `bundle`, hệ thống lập tức từ chối xuất cục bộ và định tuyến về cụm máy chủ sandbox chuyên dụng.
4. **Cơ chế chuyển giao dự phòng sang máy chủ (Server Fallback Orchestration):**
   Khi trình duyệt không đáp ứng ma trận năng lực (ví dụ Firefox thiếu encoder H.264, hoặc video vượt ngưỡng thời lượng an toàn), bộ thư viện trả về tải trọng chuẩn hóa để tạo job dựng video trên máy chủ:
   ```json
   {
     "composition_id": "cmp_promo",
     "profile": "mp4-720p-v1",
     "mode": "render",
     "fallback_reason_code": "MISSING_VIDEO_ENCODER"
   }
   ```

---

## 5. Thực thi nghiêm ngặt nguyên tắc: "No code shipping trước review"

Để đảm bảo tính kỷ luật cao nhất của dự án và không tự ý đưa mã nguồn thử nghiệm vào phân phối chính thức:
1. **Cổng phê duyệt bảo vệ `EXT-P8-01`:**
   Đã xây dựng hàm bảo vệ chốt chặn `assertBrowserExportGateApproved()` trong `packages/browser-export/src/legal-review.ts`. Mặc định, cổng `EXT-P8-01` được đặt ở trạng thái `pending_external_review`. Bất kỳ lời gọi nào nhằm kích hoạt pipeline render của trình duyệt khi cổng này chưa được ký duyệt chính thức bởi reviewer có thẩm quyền đều sẽ kích hoạt lỗi `BrowserExportGatePendingError` (`SHIPPING_GATE_PENDING_REVIEW`) và dừng ngay lập tức.
2. **Ranh giới công việc giữa P8-01 và P8-02:**
   - **P8-01 (Nhiệm vụ hiện tại):** Rà soát pháp lý, tính toàn vẹn phụ thuộc, ma trận năng lực trình duyệt, bộ kiểm tra tính khả thi và bộ khung bảo vệ thoái lui máy chủ. Không có mã render thực tế nào được phân phối cho người dùng cuối.
   - **P8-02 (Nhiệm vụ tương lai sau khi qua cổng):** Triển khai spike thử nghiệm xuất video thực tế trên tập con scene với các bài kiểm tra rò rỉ bộ nhớ, hủy bỏ và đối chuẩn chất lượng so với máy chủ.

---

## 6. Kết quả kiểm tra xác thực (Validation Evidence)

### 6.1. Kiểm tra xác thực kho chứa (`scripts/validate_repo.py`)
```bash
python3 scripts/validate_repo.py
```
Kết quả thực tế:
```json
{
  "status": "PASS",
  "required_docs_checked": 16,
  "markdown_files_checked": 62,
  "internal_links_checked": 905,
  "json_blocks_parsed": 25,
  "json_files_parsed": 58,
  "mermaid_blocks_counted": 5,
  "tasks_in_plan": 52,
  "dependency_graph_status": "acyclic",
  "errors_count": 0,
  "errors": [],
  "warnings": []
}
```

### 6.2. Kiểm tra biên dịch TypeScript (`packages/browser-export`)
```bash
npx tsc -p packages/browser-export/tsconfig.json
```
Trạng thái: **Thoát với mã 0 (PASS)**, tạo sạch toàn bộ tệp định nghĩa `.d.ts` và `.js` tương thích `NodeNext`.

### 6.3. Bộ kiểm thử tự động ma trận năng lực và rà soát pháp lý
```bash
node --test packages/browser-export/test/capability-matrix.test.mjs
```
Kết quả đầu ra thực tế:
```text
▶ P8-01: Browser Export Capability Matrix & Codec Parity
  ✔ 1.1 Verifies desktop browser capability profiles and codec support (1.819529ms)
  ✔ 1.2 Verifies mobile browser memory limits and jetsam protection (1.268914ms)
  ✔ 1.3 Evaluates feasibility: Chrome Desktop renders standard 720p promo locally (0.646279ms)
  ✔ 1.4 Evaluates feasibility: Firefox Desktop falls back to server render job (0.348953ms)
  ✔ 1.5 Evaluates feasibility: iOS Safari accepts 720p but rejects 1080p and 4K to prevent jetsam crash (0.414719ms)
  ✔ 1.6 Evaluates feasibility: custom-html-v1 scenes always trigger server fallback (0.251503ms)
✔ P8-01: Browser Export Capability Matrix & Codec Parity (6.95936ms)
▶ P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate
  ✔ 2.1 Verifies all 8 candidate package review entries and integrity hashes (1.210326ms)
  ✔ 2.2 Enforces "No code shipping trước review" gate (EXT-P8-01) (1.314057ms)
  ✔ 2.3 Verifies H.264, AAC, and open codec legal evaluation policies (0.583643ms)
✔ P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate (4.417233ms)
ℹ tests 9
ℹ suites 2
ℹ pass 9
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 209.378323
```

### 6.4. Kiểm tra sức khỏe toàn bộ hệ thống (`scripts/health-check.mjs`)
```bash
node scripts/health-check.mjs
```
Trạng thái: **PASS**, xác nhận môi trường development, các dịch vụ API, cấu hình adapter Chromium và hợp đồng profiles hoạt động hoàn hảo.

### 6.5. Đồng bộ hóa khóa gói monorepo và kiểm thử CI toàn trình (Monorepo Lockfile Sync & Full CI Pipeline)
Khi kiểm tra GitHub CI cho PR #49, tác vụ kiểm thử gặp lỗi `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER` do tệp `pnpm-lock.yaml` thiếu mục nhập cho gói mới `packages/browser-export`. Đã thực hiện đồng bộ hóa toàn diện:
1. `pnpm install --lockfile-only`: Cập nhật cấu hình nhập `packages/browser-export` vào `pnpm-lock.yaml`.
2. `pnpm install --frozen-lockfile`: Kiểm tra tính khả thi cài đặt với lockfile đông cứng (PASS).
3. `pnpm -r --if-present lint`: Kiểm tra lint toàn monorepo (PASS).
4. `pnpm -r --if-present typecheck`: Kiểm tra typecheck toàn monorepo (PASS).
5. `pnpm -r --if-present test`: Chạy toàn bộ các bộ kiểm thử monorepo bao gồm renderers, sdk, api, custom-runtime, browser-export (PASS, 0 failures).
6. `pnpm -r --if-present build`: Biên dịch toàn bộ gói monorepo (PASS).
7. `python3 scripts/validate_repo.py`: Kiểm tra tính nhất quán cấu trúc repo, tài liệu, links (PASS, 0 errors).
8. `python3 -m unittest discover -s tooling/agent_harness/tests -v`: Kiểm tra harness supervisor và retry gates (PASS, 10/10 tests).

---

## 7. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer Sign-off (EXT-P8-01):** Chờ reviewer độc lập và cán bộ pháp lý phê duyệt báo cáo bằng chứng P8-01 và thông qua commit tích hợp vào branch `staging`.
2. **Formal Legal & Licensing Approval (MPL-2.0 & MPEG-LA):** Xác nhận chính thức chấp thuận mô hình phân phối `mediabunny` (MPL-2.0) dạng Larger Work kèm theo thông báo và liên kết mã nguồn mở trong bản phát hành frontend thương mại.
3. **P8-02 Browser Export Spike Gate:** Điều kiện tiên quyết trước khi triển khai gói thực thi spike kết xuất video trên trình duyệt máy khách.

---

## 8. Kết luận và trạng thái hoàn thành

Task **P8-01** đã hoàn thành đầy đủ và toàn diện tất cả các tiêu chí nghiệm thu đề ra:
- Rà soát chính xác phiên bản, tính toàn vẹn mật mã SHA-512, shasum, giấy phép và các rủi ro pháp lý đối với họ thư viện WebAV (`@webav/av-cliper` 1.2.8) và Mediabunny (`mediabunny` 1.65.2).
- Thiết lập ma trận năng lực toàn diện cho 6 môi trường trình duyệt máy tính và di động, hỗ trợ phân loại codec phần cứng và trần bộ nhớ Jetsam.
- Xây dựng cơ chế thoái lui tự động (`server fallback`) sang API máy chủ `POST /render-jobs`.
- Tuân thủ tuyệt đối quy định "No code shipping trước review" thông qua cổng bảo vệ phần mềm `assertBrowserExportGateApproved`.

Trạng thái task hiện tại là **`implemented_local`** (hoàn tất tại worktree cục bộ, chờ independent review và CI staging).
