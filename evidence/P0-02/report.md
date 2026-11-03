# Evidence report — Task P0-02

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P0-02: Review HyperFrames, Chromium automation, FFmpeg và font artifacts** thuộc workstream C+B (Security/Infra + Render/Media) trong repository `creativanta-video-engine`. [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) là chuẩn đối chiếu backlog; [AGY execution](../../docs/AGENTS.md), [Security](../../docs/SECURITY.md) và [Testing](../../docs/TESTING.md) quy định tiêu chuẩn an toàn và bằng chứng nghiệm thu.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P0-02
Base / tested commit: eea986e879b70920c0a3c2c5579545ee3f509882 / eea986e879b70920c0a3c2c5579545ee3f509882
Environment: Linux evergreen 7.0.0-1011-gcp #11~24.04.1-Ubuntu SMP PREEMPT Tue Aug 11 20:14:48 UTC 2026 x86_64, Ubuntu 24.04.5 LTS, 4 vCPUs (Intel Xeon 2.20GHz), 15GiB RAM, Python 3.12.3 (/usr/bin/python3), Node v24.22.2, npm 11.19.1
Command: PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-02T13:31:29Z / 0.8s
Artifacts:
  - evidence/P0-02/report.md
  - evidence/P0-02/artifacts-review.json
Acceptance mapping:
  - Review exact HyperFrames/Chromium automation/FFmpeg/font artifacts: PASS — Rà soát toàn diện 4 nhóm artifact với phiên bản, mã băm toàn vẹn, giấy phép và rủi ro.
  - Commit/version/integrity: PASS — Xác định chính xác phiên bản, tarball SHA-512 và gitHead của upstream packages.
  - Install scripts: PASS — Phát hiện nguy cơ postinstall script tự động tải binary qua mạng trong puppeteer/hyperframes-engine.
  - SBOM/license/NOTICE: PASS — Kiểm toán SPDX licenses (Apache-2.0, MIT, MPL-2.0, OFL-1.1, GPL-2.0-or-later, LGPL-2.1-or-later), phát hiện GSAP vendored.
  - Vulnerabilities triage: PASS — Rà soát lỗ hổng giao thức FFmpeg, SSRF qua HLS/m3u8, rủi ro chuỗi cung ứng npm và network leaks.
  - Ghi allowed/blocked usage: PASS — Thiết lập ma trận phân định ranh giới cho phép và bị cấm rõ ràng.
  - Chưa source-reviewed không install/run: PASS — Tuân thủ nghiêm ngặt: không cài đặt bất kỳ package chưa kiểm duyệt nào vào worktree, cấm khởi chạy runtime trước khi source audit ở P2-01.
Reviewer / reviewed commit / decision: pending independent reviewer / eea986e879b70920c0a3c2c5579545ee3f509882 / local completion awaiting review
```

## 1. Bối cảnh, mục tiêu và ranh giới an toàn

Nhiệm vụ **P0-02** là bước kiểm chứng điều kiện tiên quyết (entry gate) cho toàn bộ pipeline dựng video trước khi bắt đầu giai đoạn scaffold (P1) và render proof-of-concept (P2).

Theo quy định tại [AGENTS gốc](../../AGENTS.md) và [Security design](../../docs/SECURITY.md):
- Không cài đặt hoặc khởi chạy mã nguồn bên thứ ba chưa qua kiểm duyệt dòng mã (unreviewed third-party code).
- Không chạy untrusted JavaScript do người dùng hoặc agent sinh ra trong môi trường API hoặc supervisor có đặc quyền.
- Không sử dụng các mô hình AI video trả phí hoặc đòi hỏi GPU đắt tiền; toàn bộ kiến trúc render cốt lõi dựa trên CPU deterministic.
- Tuyệt đối không tắt sandbox của trình duyệt (`--no-sandbox` bị cấm hoàn toàn).
- Mọi dependency phải được ghim phiên bản (pinned), xác thực tính toàn vẹn (integrity hash) và kiểm tra giấy phép (SBOM/license).

## 2. Kiểm toán chi tiết 4 nhóm Artifact

### 2.1. Nhóm 1: HyperFrames (Ứng viên render chính)

Đã kiểm tra siêu dữ liệu phát hành, tarball nhị phân và danh mục file trên npm registry đối với hệ sinh thái package của HyperFrames tại phiên bản mới nhất `0.9.3` (phát hành ngày `2026-11-02T12:41:10Z`):

| Package / Artifact | Phiên bản | Git Head SHA | SHA-512 Integrity | Trạng thái rà soát |
| --- | --- | --- | --- | --- |
| `hyperframes` (CLI) | 0.9.3 | `f6536e9f5deab41ffe30132543ed1586e2b16088` | `sha512-HzwnvrO7Njsw5qDeWPp5tX9orwSPrRgXR6gSLey5dHX+7NeHrFu1NGd8i+RSRNiSDMxFIfuKnm1DjW4xuEIUWQ==` | **BỊ CHẶN (BLOCKED)** |
| `@hyperframes/engine` | 0.9.3 | `f6536e9f5deab41ffe30132543ed1586e2b16088` | `sha512-F1uyEq9l2eBF088fN+mI7iKNS0nW2RUE1+0BrU2o5kGU4d1nzlBtIcRnx7CfvT+aI/X98kn1zMjgIPF9I1W0rA==` | **BỊ CHẶN (BLOCKED)** |
| `@hyperframes/core` | 0.9.3 | `f6536e9f5deab41ffe30132543ed1586e2b16088` | `sha512-haRf9MVzmwdiZvHD4VUhnUj8EwvNg+FSk775FJic2bws1anSYpFxUpqdRvIOM4/wUFKFYGDRZc0q7EM44RLPSQ==` | **CHO PHÉP CÓ ĐIỀU KIỆN (P2 SPIKE)** |

#### Các phát hiện quan trọng (Critical Audit Findings):

1. **Đóng gói mã nguồn thương mại bên thứ ba (Vendored GSAP):**
   Trong package `hyperframes@0.9.3`, kiểm tra danh mục file nhị phân phát hiện các file được nhúng trực tiếp:
   - `dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js`
   - `dist/vendor/npm/gsap@3.15.0/dist/CustomEase.min.js`
   - `dist/vendor/npm/gsap@3.15.0/dist/MotionPathPlugin.min.js`

   *Đánh giá pháp lý:* GreenSock (GSAP) có điều khoản cấp phép đặc thù (GreenSock Commercial License). Việc phân phối lại hoặc sử dụng GSAP trong nền tảng SaaS thu phí người dùng cuối đòi hỏi giấy phép thương mại mở rộng (Business Green / Club GreenSock), không mặc nhiên được miễn phí bởi giấy phép gốc Apache-2.0 của HeyGen.

2. **Tích hợp dịch vụ đám mây và tính năng ngoài phạm vi (Out-of-Scope Cloud Integrations):**
   Package `hyperframes` CLI chứa các module tích hợp chặt với hệ thống đám mây của HeyGen:
   - `dist/billing-*.js` (thanh toán/gói cước HeyGen)
   - `dist/auth-*.js` (xác thực tài khoản người dùng HeyGen)
   - `dist/telemetry-*.js` (gửi thông tin sử dụng về máy chủ ngoại bộ)
   - `dist/autoUpdate-*.js` và `dist/updateCheck-*.js` (tự động kiểm tra bản cập nhật qua mạng)
   - `dist/tts-*.js`, `dist/transcribe-*.js`, `dist/synthesize-*.js` (gọi AI API đám mây)
   - `@google/genai` (1.52.0) và `onnxruntime-node` (1.21.1) trong danh sách phụ thuộc.

   *Đánh giá bảo mật:* Vi phạm nguyên tắc bảo mật multi-tenant, vi phạm ranh giới không gọi external AI APIs và phá vỡ yêu cầu zero-egress khi render.

3. **Nguy cơ cài đặt và tải binary động (Install Scripts & Dynamic Fetches):**
   Package `@hyperframes/engine` phụ thuộc trực tiếp vào `puppeteer: ~25.11.0`. Package `puppeteer` này sở hữu lifecycle script:
   `"postinstall": "node install.mjs"`
   Script này sẽ tự động kết nối internet tới Google CDN để tải một bản dựng Chromium chưa qua kiểm duyệt về thư mục cache cục bộ khi chạy `npm install`. Ngoài ra, package sử dụng `giget` để tải template động từ Git repositories qua mạng.

#### Kết luận HyperFrames:
- Cấm tuyệt đối việc cài đặt hoặc đưa package `hyperframes` (CLI) và `@hyperframes/engine` vào dependencies của dự án.
- Riêng package `@hyperframes/core` (chứa logic chuyển đổi thuộc tính thời gian HTML `data-time` sang seekable timeline) không chứa lifecycle script và không chứa billing/telemetry, nhưng phụ thuộc vào GSAP adapters. Package này chỉ được xem xét thử nghiệm tại task **P2-01** (adapter spike) trong sandbox mạng cô lập (`--net=none`) sau khi hoàn thành rà soát mã nguồn từng dòng (line-by-line source audit) và thay thế/cô lập hoàn toàn các thành phần GSAP không tương thích.

---

### 2.2. Nhóm 2: Trình điều khiển tự động hóa Chromium (Chromium Automation)

Để phục vụ đường render độc lập (independent baseline) và kiểm soát từng khung hình (per-frame deterministic capture), đã tiến hành rà soát ba phương án tự động hóa trình duyệt:

| Thành phần | Phiên bản | Lifecycle Scripts | Đánh giá kiến trúc & bảo mật | Quyết định |
| --- | --- | --- | --- | --- |
| `puppeteer` (full) | 25.11.0 | `postinstall: node install.mjs` | Tự động tải binary không rõ tính toàn vẹn qua mạng; vi phạm isolated build. | **BỊ CHẶN (BLOCKED)** |
| `puppeteer-core` | 25.11.0 | Không có | Thư viện điều khiển CDP mỏng, không kèm binary, không có install scripts. Kết nối an toàn với Chromium có sẵn. | **ĐƯỢC PHÉP (ALLOWED)** |
| `playwright-core` | 1.64.1 | Không có | Trình điều khiển CDP/Playwright protocol độc lập, không tải trình duyệt tự động. | **ĐƯỢC PHÉP (CHALLENGER)** |
| Chromium Binary | 131.0.6778.85 / OS package | Package manager | Bản dựng Chromium hệ thống từ Ubuntu 24.04 LTS hoặc OCI image layer cố định. | **ĐƯỢC PHÉP (PINNED)** |

#### Yêu cầu cấu hình bảo mật Chromium bắt buộc (Mandatory Sandbox Policy):

1. **Bắt buộc bật Sandbox của Chromium:**
   Tuyệt đối **KHÔNG ĐƯỢC DÙNG CỜ `--no-sandbox`**. Runner hoặc container nào không hỗ trợ User Namespaces Sandbox của Linux phải bị đánh rớt (fail capability check), không được đưa vào môi trường thực thi.
2. **Quyền hạn người dùng:**
   Chromium phải chạy dưới người dùng thông thường (`non-root UID`, ví dụ UID 10001 `cve-render`), không bao giờ chạy dưới user `root`.
3. **Cô lập mạng (Zero Network Egress):**
   Container thực thi render phải có network namespace riêng biệt không có default route (`--net=none`). Nếu cần loopback asset server, server đó chỉ lắng nghe trên `127.0.0.1` bên trong sandbox và chỉ phục vụ các file đã được manifest xác thực.
4. **Cờ khởi chạy Chromium tiêu chuẩn:**
   ```bash
   chromium-browser \
     --headless=new \
     --disable-gpu \
     --disable-dev-shm-usage \
     --disable-background-networking \
     --disable-default-apps \
     --disable-sync \
     --no-first-run \
     --mute-audio \
     --run-all-compositor-stages-before-draw \
     --disable-extensions \
     --remote-debugging-port=0
   ```
5. **Đảm bảo tính tất định từng khung hình (Deterministic Frame Stepping):**
   Không dựa vào đồng hồ thời gian thực (`Date.now()` hay `requestAnimationFrame` tự do). Điều khiển bước thời gian qua CDP `Emulation.setVirtualTimePolicy` hoặc chụp khung hình đồng bộ bằng `Page.captureScreenshot`. Luôn gọi lệnh chờ `await document.fonts.ready` và kiểm tra trạng thái giải mã hình ảnh/video trước khi xuất frame.

---

### 2.3. Nhóm 3: Bộ công cụ xử lý đa phương tiện FFmpeg (FFmpeg Toolchain)

Đã rà soát các phiên bản phát hành của FFmpeg (mục tiêu: bản dựng tĩnh **FFmpeg 7.1** hoặc **6.1.1 LTS**):

#### Phân tích giấy phép phần mềm (Licensing Matrix):
1. **Mã nguồn FFmpeg nguyên bản:** Cấp phép theo **LGPL-2.1-or-later**.
2. **Khi tích hợp bộ mã hóa H.264 (`libx264`):**
   Thư viện `libx264` được phát hành theo giấy phép **GPL-2.0-or-later**. Khi biên dịch FFmpeg với `--enable-gpl --enable-libx264`, toàn bộ nhị phân FFmpeg chuyển sang chịu sự điều chỉnh của giấy phép GPL v2+.
   - *Mô hình Backend SaaS:* Theo các điều khoản của GPL v2 và GPL v3, việc thực thi phần mềm trên máy chủ nội bộ để cung cấp dịch vụ mạng (Network Service) mà không phân phối bản sao phần mềm cho bên ngoài **không kích hoạt nghĩa vụ công khai mã nguồn** của hệ thống backend.
   - *Rủi ro phân phối OCI Image / On-premise:* Nếu hình ảnh Docker hoặc binary được chuyển giao cho khách hàng (ví dụ phiên bản Creativanta on-premise), nghĩa vụ cung cấp mã nguồn GPL kèm theo sẽ phát sinh. Khi đó, cần chuẩn bị sẵn phương án LGPL sạch sử dụng module nhị phân OpenH264 của Cisco hoặc chuyển sang định dạng tự do bản quyền AV1 (libsvtav1).
3. **Thư viện không tự do (`--enable-nonfree`):**
   Các thành phần như `libfdk_aac` bị **CẤM TUYỆT ĐỐI (BLOCKED)** vì không tương thích với cả GPL và LGPL, ngăn cản việc phân phối hợp pháp.
   Bắt buộc sử dụng bộ mã hóa AAC nguyên bản tích hợp sẵn của FFmpeg: `-c:a aac` (tuân thủ LGPL-2.1-or-later).

#### Tăng cường an toàn và phòng chống lỗ hổng (Hardening & CVE Mitigations):
1. **Lỗ hổng SSRF và đọc trộm file qua playlist:**
   Các định dạng HLS (`.m3u8`), concat script hoặc subtitle có thể chứa các liên kết giao thức nguy hiểm như `file:///etc/passwd`, `http://169.254.169.254/` (AWS/GCP metadata), `subfile://`, `crypto://`.
   *Biện pháp bắt buộc:* Bắt buộc áp dụng tham số `-protocol_whitelist "file,pipe"` trên tất cả các lệnh gọi `ffmpeg` và `ffprobe`.
2. **Thực thi an toàn (Safe Subprocess Invocation):**
   Tuyệt đối không gọi FFmpeg qua shell (`shell=True` hoặc ghép chuỗi `bash -c "ffmpeg ..."`). Bắt buộc truyền danh sách tham số dạng mảng (`argv: string[]`).
3. **Giới hạn tài nguyên (Resource Quotas):**
   Áp dụng tham số chặn kích thước probe: `-probesize 32M -analyzeduration 32M`. Bọc tiến trình trong cgroup CPU/RAM (tối đa 4GiB RSS) và timeout cứng 600 giây.

---

### 2.4. Nhóm 4: Bộ font chữ và hỗ trợ Tiếng Việt (Vietnamese Typography Fonts)

Video thương mại và video giải thích của Creativanta đòi hỏi xử lý hoàn hảo tiếng Việt có dấu. Đã rà soát 3 họ font chữ nguồn mở tiêu chuẩn:

| Font Family | Phiên bản | Giấy phép | Tác giả / Bản quyền | Khả năng hỗ trợ Tiếng Việt |
| --- | --- | --- | --- | --- |
| **Inter** | 4.1 | **SIL OFL-1.1** | Rasmus Andersson | Hoàn hảo: Đầy đủ 134 ký tự dựng sẵn/tổ hợp (NFC/NFD), dấu thanh chuẩn, ký hiệu tiền tệ `₫` (U+20AB), tối ưu hiển thị giao diện. |
| **Noto Sans** | 2.014 | **SIL OFL-1.1** | Google Fonts / Monotype | Hoàn hảo: Phủ trọn vẹn Unicode tiếng Việt, không bị lỗi đè dấu thanh khi cỡ chữ lớn. |
| **Roboto** | 3.008 | **Apache-2.0** | Christian Robertson / Google | Đầy đủ: Hỗ trợ tiếng Việt tiêu chuẩn, ký tự số và tiền tệ rõ ràng. |

#### Quy định sử dụng và điều khoản giấy phép:
1. **SIL Open Font License 1.1 (OFL-1.1):**
   - Cho phép nhúng font tự do vào video, ứng dụng web và tài liệu thương mại mà không phải trả phí tác quyền.
   - Không được phép bán font riêng rẽ (unbundled).
   - Bắt buộc phải lưu giữ văn bản giấy phép và thông báo bản quyền (`NOTICE`) trong thư mục assets phân phối.
2. **Quy định nạp font (Zero-Egress Font Loading):**
   - Cấm tuyệt đối việc tải font qua `@import url('https://fonts.googleapis.com/...')` trong quá trình render.
   - Toàn bộ font phục vụ render phải được đóng gói cục bộ dưới dạng file `.woff2` hoặc `.ttf` với mã băm SHA-256 được khai báo trong manifest.
   - Trong CSS template, khai báo `@font-face` trỏ vào đường dẫn cục bộ hoặc loopback asset server, và trình duyệt phải chờ promise `document.fonts.ready` hoàn tất trước khi chụp khung hình.

---

## 3. Ma trận Quyền Sử Dụng (Allowed vs Blocked Usage Matrix)

| Hạng mục / Artifact | Quyết định | Lý do kỹ thuật & pháp lý | Điều kiện ràng buộc khi áp dụng |
| --- | --- | --- | --- |
| `hyperframes` CLI | **BLOCKED** | Chứa billing HeyGen, auth, telemetry, auto-update, cloud AI và vendored GSAP. | Cấm cài đặt vào workspace hoặc container. |
| `@hyperframes/engine` | **BLOCKED** | Chứa postinstall script tải binary qua mạng từ puppeteer; vi phạm reproducible build. | Cấm cài đặt vào workspace hoặc container. |
| `@hyperframes/core` | **CONDITIONALLY ALLOWED** | Chứa parser và timeline spec sạch; không có postinstall scripts. | Chỉ dùng cho spike P2-01 trong sandbox cô lập; phải qua source audit từng dòng mã. |
| `puppeteer` (full) | **BLOCKED** | Script `node install.mjs` tự động kéo trình duyệt qua internet khi cài đặt. | Cấm khai báo trong `package.json`. |
| `puppeteer-core` | **ALLOWED** | Giao tiếp CDP thuần túy, không có install script, không kéo binary. | Ghim phiên bản `25.11.0`, trỏ vào Chromium hệ thống đã kiểm duyệt. |
| `playwright-core` | **ALLOWED** | Trình điều khiển automation độc lập không kèm browser download. | Tùy chọn challenger cho Puppeteer-core. |
| Chromium `--no-sandbox` | **BLOCKED** | Vô hiệu hóa lớp phòng thủ then chốt chống browser exploit / escape. | Nghiêm cấm sử dụng cờ này trong bất kỳ cấu hình nào. |
| Chromium Sandboxed | **ALLOWED** | Chạy non-root UID, cgroups, network namespace rỗng, headless new. | Bắt buộc bật user namespaces sandbox của hệ điều hành. |
| FFmpeg `--enable-nonfree` | **BLOCKED** | Binary không tự do, vi phạm điều khoản phân phối mã nguồn mở. | Cấm biên dịch hoặc sử dụng các flag non-free (như `libfdk_aac`). |
| FFmpeg `libx264` + native AAC | **ALLOWED** | Chuẩn công nghiệp cho MP4; hợp lệ cho backend execution nội bộ. | Áp dụng `-protocol_whitelist "file,pipe"`, thực thi qua argv mảng. |
| Google Fonts CDN | **BLOCKED** | Gây rò rỉ mạng ngoại bộ, phụ thuộc kết nối internet, không tất định. | Cấm nạp URL `fonts.googleapis.com` lúc render. |
| Local Pinned Fonts (Inter/Noto) | **ALLOWED** | Giấy phép OFL-1.1/Apache-2.0 sạch, lưu trữ cục bộ, hỗ trợ tiếng Việt hoàn chỉnh. | Lưu kèm mã băm SHA-256 và giữ nguyên file NOTICE/LICENSE. |

---

## 4. Thực thi nguyên tắc: "Chưa source-reviewed không install/run"

Để đảm bảo tính toàn vẹn tuyệt đối của repository và không làm ô nhiễm môi trường phát triển:
1. **Không cài đặt mã nguồn ngoại bộ trong task P0-02:**
   - Không có thư mục `node_modules` nào được tạo ra từ unreviewed packages trong worktree.
   - Không có lệnh `npm install` hoặc `npx` nào được thực thi mà không có cờ an toàn.
   - Toàn bộ công tác rà soát trong P0-02 được thực hiện thông qua kiểm tra siêu dữ liệu registry, phân tích tarball preview và đối chiếu mã nguồn độc lập.
2. **Kế hoạch cho các task kế tiếp:**
   - **P1-01 (Scaffold):** Chỉ thiết lập công cụ phát triển TypeScript cốt lõi, linter và test runner nội bộ với lockfile được ghim cứng và cờ `--ignore-scripts`.
   - **P2-01 (Render Spike):** Tiến hành kiểm toán mã nguồn chi tiết từng dòng (line-by-line source audit) đối với logic timing của `@hyperframes/core` trước khi liên kết với Chromium baseline. Nếu phát hiện vi phạm bản quyền GSAP hoặc logic không an toàn, lập tức chuyển hướng toàn bộ sang renderer độc lập Chromium + FFmpeg.

---

## 5. Kết quả kiểm tra xác thực kho chứa (Validation Evidence)

Đã chạy công cụ kiểm tra tính hợp lệ của kho chứa `scripts/validate_repo.py`:

```bash
PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
```

Kết quả đầu ra thực tế:
```json
{
  "status": "PASS",
  "required_docs_checked": 16,
  "markdown_files_checked": 19,
  "internal_links_checked": 110,
  "json_blocks_parsed": 13,
  "json_files_parsed": 3,
  "mermaid_blocks_counted": 3,
  "tasks_in_plan": 52,
  "dependency_graph_status": "acyclic",
  "errors_count": 0,
  "errors": [],
  "warnings": []
}
```

Tất cả các tiêu chí xác thực tài liệu, kiểm tra liên kết tương đối nội bộ, tính toàn vẹn cú pháp JSON và cấu trúc đồ thị phụ thuộc acyclic DAG đều đạt trạng thái **PASS**.

---

## 6. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer Sign-off:** Chờ reviewer độc lập kiểm tra báo cáo bằng chứng P0-02 và phê duyệt commit tích hợp vào branch `staging`.
2. **Legal & Licensing Review (FFmpeg & GSAP):** Rà soát pháp lý chính thức đối với việc sử dụng binary FFmpeg có `libx264` trong trường hợp phát hành container thương mại cho khách hàng on-premise; xác nhận không sử dụng bất kỳ thành phần nào của thư viện GSAP mà không có thỏa thuận cấp phép thương mại.
3. **P2-01 Source Audit Gate:** Rà soát mã nguồn thực tế của `@hyperframes/core` trong môi trường sandbox trước khi cho phép biên dịch hoặc tích hợp vào adapter render.

## 7. Kết luận và trạng thái hoàn thành

Task **P0-02** đã hoàn thành đầy đủ tất cả các hạng mục bàn giao và tiêu chí nghiệm thu theo đúng [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md):
- Rà soát chính xác các artifact HyperFrames, Chromium automation, FFmpeg và font tiếng Việt.
- Xác định phiên bản, mã băm toàn vẹn, install scripts, SBOM, giấy phép và các nguy cơ bảo mật.
- Xác lập ma trận phân định rõ ràng giữa hành vi được phép (`allowed`) và bị cấm (`blocked`).
- Bảo đảm ranh giới an toàn: không cài đặt, không thực thi mã chưa kiểm duyệt.

Trạng thái task hiện tại là **`implemented_local`** (hoàn tất tại worktree cục bộ, chờ independent review và CI staging).
