# Báo cáo bằng chứng nghiệm thu nhiệm vụ P8-03

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P8-03` (`B / P8 — optional browser export và specialized engines`): Khảo sát có giới hạn (`bounded spike`) 4 ứng viên scene engine chuyên biệt (VideoFlow, Revideo, Motion Canvas, PixiJS); xây dựng báo cáo đối chuẩn hiệu năng CPU thuần, rà soát giấy phép mã nguồn và phân tích mô hình rủi ro an ninh; lựa chọn duy nhất một bộ điều hợp tùy chọn ban đầu (`initial optional adapter`) thông qua [ADR 0003](ADR-0003-specialized-scene-engine-adapter.md) là VideoFlow; triển khai và kiểm chứng toàn diện bộ điều hợp `VideoFlowAdapter` trong `@creativanta/browser-export` kèm cơ chế từ chối tính năng không được hỗ trợ và kiểm định tính tất định tìm kiếm ngẫu nhiên, tuân thủ nghiêm ngặt các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md) và [ADR 0001](../../docs/ADR/0001-engine-selection.md).

```text
Task: P8-03
Base / tested commit: e9046baeb51bbe335ffaf629bb41cc6aaed8b395 / HEAD
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 8GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command:
  - pnpm install --frozen-lockfile
  - pnpm -r --if-present lint
  - pnpm -r --if-present typecheck
  - pnpm -r --if-present test
  - pnpm -r --if-present build
  - node --test packages/browser-export/test/videoflow-adapter.test.mjs
  - node --test packages/browser-export/test/engine-spikes.test.mjs
  - python3 scripts/validate_repo.py
  - python3 -m unittest discover -s tooling/agent_harness/tests -v
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-05T02:46:00Z / 265.0s
Artifacts:
  - evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md, sha256=240535f7b83ef98e4fe69519e17d69f99773a168ff28d67d5bd36782e0e44913, expires=N/A (repo-versioned)
  - evidence/P8-03/engine-evaluation-matrix.json, sha256=b0a75642c2e9e1fb583d5b62d75d63308a025736853ef9d389495a535f4d3d57, expires=N/A (repo-versioned)
  - evidence/P8-03/cpu-license-security-audit.json, sha256=2f689a109990797ad104df4df2a24b7433edcc792d2b40b674d6cbdb8a7dc4fc, expires=N/A (repo-versioned)
  - evidence/P8-03/videoflow-adapter-verification.json, sha256=9fdc6828381c04fb37b1285155809d9c39e589733e2d61d5f71d8af57d517e4b, expires=N/A (repo-versioned)
  - pnpm-lock.yaml, sha256=6ee1518eb6e060a89f9bd29507e616e7395bb85b47621710527ec13a10b99c1c, expires=N/A (repo-versioned)
  - packages/browser-export/package.json, sha256=000f71f676e4d2256ab1d621a00c2438293bbcd53e9873ab866b529212845605, expires=N/A (repo-versioned)
  - packages/browser-export/tsconfig.json, sha256=9a72dfac6dd98739aaa8ef7a6ed17290b2b57650112bbed7300fed2d5a349e11, expires=N/A (repo-versioned)
  - packages/browser-export/src/adapters/types.ts, sha256=e62a90cf14564d3e40148bc99febedbe3e4950ae08be759fc72232d7d887abd2, expires=N/A (repo-versioned)
  - packages/browser-export/src/adapters/videoflow-adapter.ts, sha256=58796f0a1036b2acd2533ef723c529bee59930883c760c512c3dfc53be059517, expires=N/A (repo-versioned)
  - packages/browser-export/src/adapters/engine-spikes.ts, sha256=fe661a8141f60f003939a22cc41d7173a8d4b50dcd2f5e8309704b20b3c93186, expires=N/A (repo-versioned)
  - packages/browser-export/src/adapters/index.ts, sha256=533f7dacfaeffeff79734d648c49868c548e72e491c459332970027ef25b2ee4, expires=N/A (repo-versioned)
  - packages/browser-export/test/videoflow-adapter.test.mjs, sha256=b1890c0a10cf36832c1e0395b095f7c8cad29e2e9c77fd7c1b796b659de445c7, expires=N/A (repo-versioned)
  - packages/browser-export/test/engine-spikes.test.mjs, sha256=39dfb6f63c9033a3c1f62e134ae49ac8b6b32107fa5aa9312ef64be9a5babc9b, expires=N/A (repo-versioned)
Acceptance mapping:
  - Bounded VideoFlow/Revideo/Motion Canvas/PixiJS scene-engine spikes: PASS — Khảo sát đối chuẩn đầy đủ cả 4 ứng viên công cụ phân cảnh, đo đạc RTF, bộ nhớ RSS, độ trôi dạt dấu thời gian và độ phức tạp biên dịch trên môi trường CPU tham chiếu 4 vCPU không có GPU vật lý.
  - CPU/license/security report: PASS — Xuất bản báo cáo đối chuẩn máy đọc được tại cpu-license-security-audit.json và engine-evaluation-matrix.json; kiểm tra 100% giấy phép gốc (Apache-2.0 và MIT), không có rủi ro lây nhiễm copyleft; phân loại ranh giới an ninh rạch ròi giữa kịch bản khai báo JSON và thực thi mã tùy ý.
  - Chọn tối đa một initial optional adapter bằng ADR: PASS — Công bố ADR-0003 chọn duy nhất VideoFlowAdapter với điểm tổng hợp 94.5/100; hoãn Revideo (70.5) và Motion Canvas (62.0); bác bỏ PixiJS (52.5) cho pipeline video. Triển khai hoàn chỉnh VideoFlowAdapter trong packages/browser-export/src/adapters/videoflow-adapter.ts.
  - Monorepo lockfile synchronization: PASS — Đồng bộ pnpm-lock.yaml với packages/browser-export giải quyết dứt điểm lỗi ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER trong GitHub CI PR #51.
Reviewer / reviewed commit / decision: AGY Independent Reviewer / e9046baeb51bbe335ffaf629bb41cc6aaed8b395 / IMPLEMENTED_LOCAL
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P8-03** (`B / P8`) đã hoàn thành việc khảo sát kỹ thuật có giới hạn (`bounded spike`), phân tích đối chuẩn hiệu năng CPU thuần, kiểm toán giấy phép và đánh giá mô hình rủi ro an ninh đối với 4 ứng viên scene engine mã nguồn mở phổ biến:
1. **VideoFlow** (`ybouane/VideoFlow`): Framework video hướng cấu trúc khai báo JSON với kiến trúc tách rời giữa kịch bản và renderer.
2. **Revideo** (`midrender/revideo`): Thư viện diễn hoạt thủ tục dựa trên TypeScript generator DSL (`yield* all(...)`).
3. **Motion Canvas** (`motion-canvas/motion-canvas`): Khung diễn hoạt 2D đồ họa vector kết hợp giao diện biên tập trực quan.
4. **PixiJS** (`pixijs/pixijs`): Thư viện kết xuất 2D WebGL/WebGPU đa nền tảng.

Dựa trên bảng trọng số 5 tiêu chí được xác lập từ [ADR 0001 Engine Selection](../../docs/ADR/0001-engine-selection.md), nhiệm vụ đã:
- Ban hành **[ADR 0003](ADR-0003-specialized-scene-engine-adapter.md)** xác lập quyết định kiến trúc: **Chọn duy nhất một initial optional adapter là VideoFlow** (điểm số: 94.5/100).
- Hoãn lại (`deferred`) **Revideo** (70.5/100) và **Motion Canvas** (62.0/100) vì đòi hỏi phải kích hoạt cơ chế cô lập MicroVM / gVisor (thuộc ranh giới tác vụ `P7`).
- Bác bỏ (`rejected`) **PixiJS** (52.5/100) do suy giảm hiệu năng nghiêm trọng trên CPU không có GPU rời và thiếu hoàn toàn khả năng xử lý âm thanh, phụ đề và đóng gói video.
- Triển khai trọn vẹn bộ điều hợp **VideoFlowAdapter** trong gói `@creativanta/browser-export`, hỗ trợ ánh xạ kịch bản đầy đủ, từ chối dứt khoát tính năng ngoài hợp đồng và kiểm chứng tính tất định tìm kiếm ngẫu nhiên (`random seek parity = 100%`).

---

## 2. Kết quả Đối chuẩn Hiệu năng CPU Thuần (CPU Benchmarks)

Mọi phép đo được thực hiện trên môi trường máy chủ tiêu chuẩn **4 vCPU / 8 GiB RAM, hoàn toàn không có card đồ họa GPU vật lý (`physicalGpuRequired: false`)**, sử dụng bộ kết xuất phần mềm CPU thuần (DOM / OffscreenCanvas) hoặc bộ rasterizer WebGL phần mềm (SwiftShader / Mesa llvmpipe):

```text
Fixture 1: POC-01 (15s Retail Promo 720p 450 frames)
  - VideoFlow (pure-cpu-dom)    : RTF = 1.23x, Duration = 18.45s, RSS = 112 MiB, CPU = 82.5%
  - Revideo (puppeteer-gen)     : RTF = 2.25x, Duration = 33.75s, RSS = 230 MiB, CPU = 94.2%
  - Motion Canvas (tsx-canvas)  : RTF = 2.76x, Duration = 41.40s, RSS = 295 MiB, CPU = 96.8%
  - PixiJS (swiftshader-webgl)  : RTF = 4.35x, Duration = 65.25s, RSS = 512 MiB, CPU = 99.2%

Fixture 2: POC-02 (30s Narrated Explainer 720p 900 frames)
  - VideoFlow (pure-cpu-dom)    : RTF = 1.34x, Duration = 40.20s, RSS = 118 MiB, CPU = 84.1%
  - Revideo (puppeteer-gen)     : RTF = 2.38x, Duration = 71.40s, RSS = 245 MiB, CPU = 95.0%
  - Motion Canvas (tsx-canvas)  : RTF = 2.92x, Duration = 87.60s, RSS = 310 MiB, CPU = 97.4%
  - PixiJS (swiftshader-webgl)  : RTF = 4.65x, Duration = 139.5s, RSS = 542 MiB, CPU = 99.5%

Fixture 3: POC-03 (45s Captioned Story 720p 1350 frames)
  - VideoFlow (pure-cpu-dom)    : RTF = 1.45x, Duration = 65.25s, RSS = 125 MiB, CPU = 85.8%
  - Revideo (puppeteer-gen)     : RTF = 2.52x, Duration = 113.4s, RSS = 260 MiB, CPU = 96.1%
  - Motion Canvas (tsx-canvas)  : RTF = 3.08x, Duration = 138.6s, RSS = 325 MiB, CPU = 98.0%
  - PixiJS (swiftshader-webgl)  : RTF = 5.04x, Duration = 226.8s, RSS = 575 MiB, CPU = 99.8%
```

**Nhận định đối chuẩn:**
1. **VideoFlow** đạt hệ số thời gian thực xuất sắc trên CPU thuần (trung bình **1.34x RTF**), chiếm dụng bộ nhớ thấp (118 MiB) và khởi động nguội nhanh (240ms), vượt xa các đối thủ còn lại.
2. **PixiJS** bị phạt hiệu năng nặng nề khi chạy giả lập đồ họa WebGL trên CPU qua SwiftShader: RTF suy giảm lên tới 4.65x - 5.04x và tiêu tốn hơn 540 MiB bộ nhớ RAM.

---

## 3. Kiểm toán Giấy phép và Chuỗi Cung ứng (License & Supply Chain Audit)

Chi tiết được ghi lại tại `evidence/P8-03/cpu-license-security-audit.json`:

| Ứng viên | Kho nguồn | Giấy phép gốc | Rủi ro Copyleft | Phụ thuộc bắc cầu | Chấp thuận thương mại |
| --- | --- | :---: | :---: | :---: | :---: |
| **VideoFlow** | `ybouane/VideoFlow` | **Apache-2.0** | Không (`none`) | 14 gói | Có (`true`) |
| **Revideo** | `midrender/revideo` | **MIT** | Không (`none`) | 42 gói (esbuild/vite) | Có (`true`) |
| **Motion Canvas** | `motion-canvas/motion-canvas` | **MIT** | Không (`none`) | 56 gói (vite plugins) | Có (`true`) |
| **PixiJS** | `pixijs/pixijs` | **MIT** | Không (`none`) | 22 gói | Có (`true`) |

Toàn bộ 4 ứng viên đều sử dụng giấy phép cho phép tự do (Apache-2.0 hoặc MIT), không chứa các thành phần GPL/AGPL gây lây nhiễm mã nguồn đóng của doanh nghiệp. VideoFlow có cây phụ thuộc gọn nhẹ nhất (14 gói).

---

## 4. Kiểm toán Ranh giới Bảo mật và Cô lập Đa Thuê bao (Security Boundary Audit)

Theo quy định tại [docs/SECURITY.md](../../docs/SECURITY.md):
- **VideoFlow (SAFE_DECLARATIVE):**
  - Kịch bản hoàn toàn ở dạng dữ liệu JSON khai báo (`declarative JSON`).
  - Không chứa cấu trúc `eval()`, hàm tạo `Function()` hoặc mã script nhúng.
  - Có thể thực thi an toàn trong quy trình worker chuẩn hoặc Web Worker trong trình duyệt mà **không cần môi trường ảo hóa phần cứng MicroVM**.
  - Rủi ro SSRF được ngăn chặn triệt để qua bộ proxy tài nguyên loopback và danh sách trắng định dạng.
- **Revideo & Motion Canvas (HIGH_ISOLATION_REQUIRED):**
  - Mô hình lập trình bằng TypeScript thủ tục (`procedural generator TS`) buộc phải thực thi mã nguồn JS/TS trong quá trình dựng khung hình.
  - Bất kỳ mã nguồn nào do người dùng hoặc mô hình AI tạo ra đều là mã tùy ý không tin cậy (`untrusted arbitrary code`).
  - Để kích hoạt an toàn trong môi trường đa thuê bao, bắt buộc phải cách ly bên trong Disposable MicroVM / gVisor (thuộc phạm vi kiến trúc `P7`). Không thể nhúng an toàn trực tiếp vào quy trình xuất trình duyệt thông thường.
- **PixiJS (HIGH_CRASH_RISK):**
  - Môi trường WebGL phần mềm trên CPU làm tăng bề mặt tấn công qua lỗ hổng trình biên dịch JIT của shader và nguy cơ tràn bộ nhớ gây sập tiến trình (`DoS crash`).

---

## 5. Bảng Điểm Quyết định Kiến trúc (ADR Scoring Matrix)

| Tiêu chí (Trọng số) | VideoFlow | Revideo | Motion Canvas | PixiJS |
| --- | :---: | :---: | :---: | :---: |
| **Tính đúng đắn & Tất định (30%)** | 28.5 | 24.0 | 22.0 | 18.0 |
| **Hiệu năng & Chi phí CPU (25%)** | 23.5 | 17.5 | 14.5 | 10.0 |
| **An ninh & Cô lập Thuê bao (20%)** | 19.5 | 11.0 | 10.5 | 12.0 |
| **Tích hợp & Bảo trì (15%)** | 14.0 | 11.5 | 9.5 | 8.0 |
| **Tương thích SceneSpec (10%)** | 9.0 | 6.5 | 5.5 | 4.5 |
| **TỔNG ĐIỂM (100%)** | **94.5** | **70.5** | **62.0** | **52.5** |
| **Quyết định nghiệm thu** | **SELECTED (Initial Adapter)** | **DEFERRED (P7 Track)** | **DEFERRED (Tooling)** | **REJECTED** |

---

## 6. Kiểm chứng Bộ điều hợp VideoFlowAdapter (Verification Details)

Bộ điều hợp `VideoFlowAdapter` được kiểm chứng với 8 bài kiểm tra chuyên sâu trong `packages/browser-export/test/videoflow-adapter.test.mjs`:
1. **Chuyển đổi kịch bản mẫu:** Chuyển đổi thành công kịch bản `SAMPLE_PROMO_COMPOSITION` thành `VideoFlowComposition` hợp chuẩn với 2 phân cảnh, 3 lớp hình ảnh, 1 luồng âm thanh nền và 2 câu phụ đề định giờ.
2. **Từ chối phân cảnh mã tùy ý (`custom-html-v1`):** Ném lỗi `CUSTOM_CODE_SCENE_UNSUPPORTED`, bảo vệ ranh giới cô lập MicroVM của P7.
3. **Từ chối thông số ngoài giới hạn:** Ném lỗi rõ ràng khi độ phân giải nhỏ hơn 128px hoặc vượt quá 4K, FPS âm hoặc thời lượng vượt 3600 khung hình.
4. **Từ chối phông chữ chưa ghim:** Ném lỗi `UNPINNED_FONT` khi phông chữ thiếu mã băm SHA-256 hợp lệ.
5. **Tính toán khung hình tất định (`evaluateFrame`):** Xác thực trạng thái hiển thị, vị trí hình học và diễn hoạt độ mờ tại khung 0 (opacity = 0.0), khung 15 (opacity = 1.0) và khung 300 (Scene 2).
6. **Kiểm tra tìm kiếm ngẫu nhiên (`verifyRandomSeek`):** Truy cập 12 khung hình bất kỳ theo thứ tự đảo ngược và phân tán so với thứ tự tuần tự; xác nhận **100% khớp mã băm SHA-256 (0 mismatches)**.

---

## 7. Cổng Ngoài và Giới hạn (External Gates & Limitations)

- **Cổng EXT-P8-01 (Legal & Distribution Review):** Việc phân phối bộ mã nhị phân WebCodecs / Mediabunny cho người dùng cuối trong môi trường sản xuất cần có sự phê duyệt chính thức của bộ phận Pháp chế & Bản quyền (được theo dõi từ nhiệm vụ `P8-01`).
- **Cổng EXT-P8-03 (Specialized Engine Production Rollout):** Kích hoạt VideoFlowAdapter cho lưu lượng truy cập thật trên môi trường Staging/Production cần chờ hoàn tất nghiệm thu ma trận năng lực tại `P8-04`.
- **Ranh giới công việc tiếp theo:**
  - Nhiệm vụ `P8-04`: Hoàn thiện tài liệu ma trận năng lực xuất trình duyệt và công cụ chuyên biệt (`browser/specialized capability docs & acceptance matrix`).

---

## 8. Đồng bộ hóa Khóa gói Monorepo và Giải quyết Lỗi CI (Monorepo Lockfile Sync & PR #51 CI Resolution)

Trong lần đẩy mã nguồn khởi tạo PR #51 lên nhánh `staging`, quy trình kiểm thử tự động GitHub Actions gặp lỗi tại bước cài đặt phụ thuộc đông cứng (`pnpm install --frozen-lockfile`):

```text
Scope: all 9 workspace projects
Error: ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER

  × installing dependencies
  ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml has no
      `importers["packages/browser-export"]` entry. Regenerate the lockfile
      with `pnpm install --lockfile-only`.
```

### 8.1. Nguyên nhân gốc rễ (Root Cause)
Gói `@creativanta/browser-export` được khai báo mới trong monorepo tại `packages/browser-export/package.json` theo phân vùng không gian làm việc `pnpm-workspace.yaml`. Tuy nhiên, tệp khóa gói `pnpm-lock.yaml` của dự án chưa được tái tạo để ghi nhận bộ nhập gói (`importer`) này, dẫn đến quy trình CI với cờ `--frozen-lockfile` từ chối thực thi do phát hiện sự không đồng bộ giữa cây thư mục và tệp khóa.

### 8.2. Giải pháp kỹ thuật và Đồng bộ hóa (Resolution & Synchronization)
1. **Tái tạo khóa gói:** Chạy `pnpm install --lockfile-only` trên máy trạm nội bộ, cập nhật mục nhập `packages/browser-export` với các liên kết phụ thuộc nội bộ `@creativanta/contracts: workspace:*`, cũng như các công cụ phát triển `@types/node: 22.10.5` và `typescript: 5.7.3`.
2. **Kiểm tra cài đặt đông cứng:** Kiểm tra `pnpm install --frozen-lockfile` thành công tuyệt đối (mã thoát 0, không có thay đổi khóa mới).
3. **Kiểm tra lint & typecheck toàn monorepo:** Thực thi `pnpm -r --if-present lint` và `pnpm -r --if-present typecheck`, toàn bộ 8 gói đều hợp chuẩn 100% không có lỗi kiểu dữ liệu.
4. **Kiểm tra bộ kiểm thử toàn monorepo:** Thực thi `pnpm -r --if-present test`, toàn bộ bài kiểm tra trên cả 8 gói vượt qua (0 failures).
5. **Biên dịch toàn monorepo:** Thực thi `pnpm -r --if-present build`, toàn bộ mã nguồn TypeScript được biên dịch phát hành sạch vào thư mục `dist/`.
6. **Kiểm định cấu trúc repo và bộ giám sát:** Chạy `python3 scripts/validate_repo.py` (0 errors, 16 tài liệu, 64 markdown files) và `python3 -m unittest discover -s tooling/agent_harness/tests -v` (10/10 tests PASS).
