# ADR 0003 — Lựa chọn initial optional specialized scene engine adapter (VideoFlow vs Revideo vs Motion Canvas vs PixiJS)

- **Mã quyết định:** `ADR-0003`
- **Nhiệm vụ / Giai đoạn:** `P8-03` (`B / P8 — optional browser export và specialized engines`)
- **Ngày:** `2026-11-05`
- **Trạng thái:** **Accepted for Initial Optional Adapter Gate** (Chọn duy nhất một initial optional adapter là `VideoFlow`; hoãn `Revideo` và `Motion Canvas`; bác bỏ `PixiJS` cho video pipeline).
- **Tài liệu chuẩn tắc liên quan:** [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/OPEN_SOURCE_EVALUATION.md](../../docs/OPEN_SOURCE_EVALUATION.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [ADR 0001 Engine Selection](../../docs/ADR/0001-engine-selection.md).

---

## 1. Bối cảnh và Thách thức (Context & Problem Statement)

Trong kiến trúc tổng thể của Creativanta Video Engine:
- Trình kết xuất mặc định phía máy chủ (`server default`) sử dụng **Chromium frame capture + FFmpeg assembly** đã được kiểm chứng và nghiệm thu qua Cổng G2 (`P2-05`).
- Giai đoạn `P8` mở rộng năng lực xuất video tùy chọn trên trình duyệt (`browser export`) và tích hợp các công cụ chuyên biệt (`specialized scene engines`).
- Mục tiêu nhiệm vụ `P8-03`: Thực hiện khảo sát kỹ thuật có giới hạn (`bounded spike`) trên 4 ứng viên scene engine mã nguồn mở:
  1. **VideoFlow** (`ybouane/VideoFlow`): Framework video hướng dữ liệu JSON với các bộ kết xuất phân tách (DOM, Canvas, WebCodecs).
  2. **Revideo** (`midrender/revideo`): Headless TypeScript animation DSL phái sinh từ Motion Canvas.
  3. **Motion Canvas** (`motion-canvas/motion-canvas`): Khung diễn hoạt 2D thủ tục trên TypeScript/TSX kèm trình chỉnh sửa trực quan.
  4. **PixiJS** (`pixijs/pixijs`): Thư viện kết xuất đồ họa 2D WebGL/WebGPU đa nền tảng.
- Ràng buộc chấp nhận: **Chọn tối đa một initial optional adapter bằng ADR** (tối đa 1 engine adapter được kích hoạt ban đầu; không duy trì song song nhiều adapter thử nghiệm gây phân tán nguồn lực).

---

## 2. Tiêu chí và Trọng số Đánh giá (Evaluation Framework)

Theo quy chuẩn kế thừa từ [ADR 0001](../../docs/ADR/0001-engine-selection.md), các ứng viên được chấm điểm dựa trên 5 tiêu chí cốt lõi:

| Tiêu chí | Trọng số | Mô tả yêu cầu kỹ thuật |
| --- | :---: | --- |
| **Tính đúng đắn và tính tất định (Correctness & Determinism)** | 30% | Kết xuất khung hình chính xác theo thời gian; hỗ trợ tìm kiếm ngẫu nhiên (`random seek`) không lệch khung; bảo đảm tính đồng bộ âm thanh - hình ảnh $\le 1$ khung hình; không tích lũy trôi dạt dấu thời gian (`PTS drift = 0`). |
| **Chi phí và hiệu năng CPU thuần (CPU Cost & Efficiency)** | 25% | Khả năng thực thi hoàn toàn trên CPU máy chủ chuẩn (4 vCPU / 8 GiB RAM reference runner), **tuyệt đối không yêu cầu GPU vật lý**; hệ số thời gian thực (`RTF`) $\le 2.0\times$; mức chiếm dụng bộ nhớ đỉnh (`peak RSS`) $\le 300$ MiB. |
| **Ranh giới bảo mật và cô lập đa thuê bao (Security & Tenant Isolation)** | 20% | Ngăn chặn thực thi mã JavaScript tùy ý không tin cậy trong tiến trình API/Worker; hỗ trợ hộp cát trình duyệt; kiểm soát rò rỉ mạng (`zero egress`); không mở rộng bề mặt tấn công trình biên dịch JIT hay lỗi sập driver đồ họa. |
| **Khả năng tích hợp và bảo trì (Maintainability & Integration)** | 15% | Độ phức tạp mã nguồn; kích thước cây phụ thuộc bắc cầu; tính tương thích gói TypeScript/ESM; không phụ thuộc vào máy chủ biên dịch nặng nề (`heavy bundler`) cho mỗi tác vụ kết xuất. |
| **Sự phù hợp với mô hình kịch bản (Authoring & SceneSpec Alignment)** | 10% | Mức độ tương thích và ánh xạ trực tiếp với đặc tả phân cảnh chuẩn [SceneSpec v1](../../docs/SCENE-SPEC.md) (phân cảnh, lớp văn bản, hình ảnh, video, hình khối, âm thanh, diễn hoạt khung khóa, chuyển cảnh). |

---

## 3. Kết quả Khảo sát Kỹ thuật và Bảng điểm Đối chuẩn (Comparative Benchmark & Scoring)

Dữ liệu đo đạc thực tế trên môi trường tham chiếu 4 vCPU / 8 GiB RAM (không có GPU vật lý) trên 3 kịch bản chuẩn (`POC-01` 15s promo 450f, `POC-02` 30s explainer 900f, `POC-03` 45s footage 1350f):

| Chỉ số / Tiêu chí | VideoFlow | Revideo | Motion Canvas | PixiJS |
| --- | :---: | :---: | :---: | :---: |
| **Mô hình lập trình** | Declarative JSON | Procedural TS Generator | Procedural TSX Editor | 2D WebGL/WebGPU Graph |
| **Giấy phép gốc** | Apache-2.0 | MIT (Motion Canvas attr) | MIT | MIT |
| **Rủi ro lây nhiễm Copyleft** | Không (`none`) | Không (`none`) | Không (`none`) | Không (`none`) |
| **RTF trung bình (Pure CPU)** | **1.34x** | 2.38x | 2.92x | 4.65x (SwiftShader) |
| **Bộ nhớ đỉnh (Peak RSS)** | **118 MiB** | 245 MiB | 310 MiB | 542 MiB |
| **Độ tất định kết xuất** | **EXACT** | GENERATOR_REPLAY | GENERATOR_REPLAY | TICKER_DRIFT |
| **Cấp độ an ninh ranh giới** | **SAFE_DECLARATIVE** | HIGH_ISOLATION_REQ | HIGH_ISOLATION_REQ | HIGH_CRASH_RISK |
| **Yêu cầu MicroVM (P7)** | **Không** | Bắt buộc nếu code tùy ý | Bắt buộc nếu code tùy ý | Không (nhưng rủi ro JIT) |
| **Độ tương thích SceneSpec** | **94.0%** | 68.0% | 58.0% | 45.0% |
| **Điểm Tính đúng đắn (30)** | 28.5 | 24.0 | 22.0 | 18.0 |
| **Điểm Hiệu năng CPU (25)** | 23.5 | 17.5 | 14.5 | 10.0 |
| **Điểm An ninh ranh giới (20)** | 19.5 | 11.0 | 10.5 | 12.0 |
| **Điểm Tích hợp/Bảo trì (15)** | 14.0 | 11.5 | 9.5 | 8.0 |
| **Điểm Phù hợp SceneSpec (10)** | 9.0 | 6.5 | 5.5 | 4.5 |
| **TỔNG ĐIỂM (100)** | **94.5** | **70.5** | **62.0** | **52.5** |
| **Quyết định ADR** | **SELECTED** | **DEFERRED** | **DEFERRED** | **REJECTED** |

---

## 4. Phân tích Chi tiết từng Ứng viên (Detailed Candidate Analysis)

### 4.1. VideoFlow — Ứng viên được lựa chọn (Score: 94.5 / 100 — SELECTED)
- **Ưu điểm vượt trội:**
  1. *Cấu trúc kịch bản khai báo JSON:* VideoFlow thiết kế phân tách hoàn toàn giữa mô tả kịch bản dữ liệu (`declarative JSON composition`) và các bộ kết xuất (`renderers`). Điều này loại trừ hoàn toàn nguy cơ thực thi mã độc trong môi trường đa thuê bao.
  2. *Hiệu năng CPU thuần xuất sắc:* Khả năng kết xuất trên DOM/Canvas phần mềm nhẹ đạt RTF trung bình **1.34x** và tiêu hao bộ nhớ chỉ **118 MiB RSS**, đáp ứng trọn vẹn chỉ tiêu CPU của hệ thống mà không cần card đồ họa rời.
  3. *Tương thích kiến trúc xuất trình duyệt (P8):* Tích hợp tự nhiên với WebCodecs và Mediabunny, cho phép chia sẻ mô hình timeline kịch bản giữa xuất tại trình duyệt khách và kết xuất máy chủ.
  4. *Giấy phép và chuỗi cung ứng minh bạch:* Giấy phép Apache-2.0 sạch, không có phụ thuộc GPL/AGPL sao chép ngược, chỉ có 14 phụ thuộc bắc cầu được kiểm soát.

### 4.2. Revideo — Hoãn lại cho nhánh thực thi mã nguồn P7 (Score: 70.5 / 100 — DEFERRED)
- **Đánh giá:** Revideo sở hữu DSL diễn hoạt hàm phát sinh (`generator function`) rất thanh lịch cho lập trình viên. Tuy nhiên, việc thực thi mã TypeScript thủ tục đồng nghĩa với việc chạy mã tùy ý (`arbitrary code execution`), đòi hỏi phải kích hoạt MicroVM / gVisor isolation (thuộc ranh giới tác vụ `P7`). Ngoài ra, chi phí đóng gói (`bundling`) kịch bản bằng ESBuild/Vite cho từng tác vụ làm tăng RTF lên 2.38x.
- **Kết luận:** Hoãn lại, không đưa vào bộ điều hợp tùy chọn ban đầu của `P8`. Giữ lại làm phương án tiềm năng cho nhánh mã tùy biến cách ly tại `P7`.

### 4.3. Motion Canvas — Hoãn lại (Score: 62.0 / 100 — DEFERRED)
- **Đánh giá:** Được tối ưu hóa cho công cụ biên tập đồ họa trực quan và bài giảng kỹ thuật độc lập thông qua plugin Vite. Hệ thống phụ thuộc nặng nề vào môi trường phát triển cục bộ và trình duyệt tương tác, thiếu các khái niệm cốt lõi về phân cảnh video đa đoạn, phụ đề định giờ và trộn đa luồng âm thanh.

### 4.4. PixiJS — Bác bỏ đối với luồng video hoàn chỉnh (Score: 52.5 / 100 — REJECTED)
- **Đánh giá:** PixiJS là thư viện vẽ đồ họa WebGL/WebGPU 2D tức thời, **không phải một pipeline sản xuất video toàn diện**. Khi chạy ở chế độ CPU thuần không có phần cứng GPU hỗ trợ, PixiJS phải dựa vào bộ rasterizer phần mềm (SwiftShader / Mesa llvmpipe), dẫn tới suy giảm hiệu năng nghiêm trọng (RTF 4.65x, bộ nhớ đỉnh >540 MiB). Đồng thời, PixiJS không có khả năng trộn âm thanh, xử lý phụ đề hay đóng gói MP4.

---

## 5. Quyết định Kiến trúc (Architectural Decision)

1. **Chấp thuận duy nhất một Initial Optional Adapter:**
   - Triển khai bộ điều hợp tùy chọn **VideoFlowAdapter** bên trong gói `@creativanta/browser-export` (`packages/browser-export/src/adapters/videoflow-adapter.ts`).
2. **Quy tắc chuyển đổi kịch bản (Adapter Mapping Rules):**
   - Chuyển đổi hai chiều có kiểm soát giữa `CompositionSpec` (chuẩn Creativanta) và `VideoFlowComposition`.
   - Phân định rạch ròi các luồng: luồng thị giác (`visual track`), luồng phụ đề phủ (`overlay track`) và luồng âm thanh gốc (`audio track`).
   - Hỗ trợ đầy đủ diễn hoạt khung khóa (`linear`, `ease_in_quad`, `ease_out_quad`, `ease_in_out_quad`) và chuyển cảnh cắt/mờ nền (`cut`, `fade_to_background`).
3. **Từ chối dứt khoát các tính năng ngoài tầm hỗ trợ (Refusal over Silent Degradation):**
   - Ném ngoại lệ rõ ràng khi gặp phân cảnh mã tùy ý (`custom-html-v1`), độ phân giải vượt khung 4K, thời lượng âm/vượt 3600 khung hình hoặc phông chữ chưa ghim mã băm SHA-256. Không bao giờ âm thầm bỏ qua lỗi.
4. **Kiểm chứng tính tất định tìm kiếm ngẫu nhiên (Random Seek Determinism):**
   - Đảm bảo kết quả tính toán khung hình tại vị trí bất kỳ $N$ qua hàm `evaluateFrame` cho ra mã băm SHA-256 hoàn toàn đồng nhất giữa duyệt tuần tự và truy cập ngẫu nhiên phi tuyến tính (`random seek parity = 100%`).

---

## 6. Cổng Nghiệm thu Kỹ thuật (Verification Gates S1–S5)

- **Cổng S1 (Zero Code Injection Gate):** 100% kịch bản chuyển đổi sang VideoFlow ở dạng JSON thuần; không cho phép `eval()`, `new Function()` hay kịch bản nhúng tùy ý.
- **Cổng S2 (Pure CPU Parity Gate):** Đạt RTF $\le 1.50\times$ trên 4 vCPU không có GPU vật lý trên cả 3 kịch bản đối chuẩn.
- **Cổng S3 (License & Legal Clearance Gate):** Xác nhận giấy phép Apache-2.0 sạch và không phát sinh nghĩa vụ copyleft bắc cầu.
- **Cổng S4 (Frame Parity & Seek Gate):** Vượt qua bài kiểm tra tìm kiếm ngẫu nhiên trên toàn bộ tập khung hình kiểm thử.
- **Cổng S5 (Explicit Error Contract Gate):** Kiểm tra đầy đủ bộ từ chối lỗi với mã lỗi có cấu trúc (`CUSTOM_CODE_SCENE_UNSUPPORTED`, `INVALID_DIMENSIONS`, `UNPINNED_FONT`).
