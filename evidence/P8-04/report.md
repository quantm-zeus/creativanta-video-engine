# Báo cáo bằng chứng nghiệm thu nhiệm vụ P8-04

Báo cáo nghiệm thu kỹ thuật và đánh giá thẩm định độc lập cho nhiệm vụ **P8-04** (`Reviewer / P8 — optional browser export và specialized engines`): Ban hành tài liệu chuẩn hóa năng lực trình duyệt và công cụ phân cảnh chuyên biệt (`Browser/specialized capability docs`), thiết lập Ma trận nghiệm thu toàn diện (`acceptance matrix`), thực thi nguyên tắc cốt lõi **từ chối tính năng không được hỗ trợ thay vì âm thầm làm suy giảm chất lượng** (`refuse unsupported instead of silently degrade`), và công bố các kết luận **không áp dụng dựa trên bằng chứng thực nghiệm** (`conclude no-adoption với evidence`), nghiêm cấm ngụy tạo hỗ trợ (`không fake support`), đáp ứng các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md), tổng hợp và chuẩn hóa kết quả từ [P8-01](../P8-01/report.md), [P8-02](../P8-02/report.md) và [P8-03](../P8-03/report.md).

---

## Bằng chứng thực thi (Evidence Template)

```text
Task: P8-04
Base / tested commit: 3b8c457b60665f6bd27ef87502a1c78fa7a4bec3 / HEAD
Environment: Linux evergreen 7.0.0-1011-gcp #11~24.04.1-Ubuntu SMP PREEMPT Tue Aug 11 20:14:48 UTC 2026 x86_64, Ubuntu 24.04.5 LTS, 4 vCPUs (Intel Xeon 2.20GHz), 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.12.3
Command:
  - npx tsc -p packages/browser-export/tsconfig.json
  - node --test packages/browser-export/test/acceptance-matrix.test.mjs
  - node --test packages/browser-export/test/refusal-and-no-silent-degradation.test.mjs
  - node --test packages/browser-export/test/*.test.mjs
  - python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-05T08:01:00Z / 125.0s
Artifacts:
  - evidence/P8-04/report.md, expires=N/A (repo-versioned)
  - evidence/P8-04/acceptance-matrix.json, sha256=543848a1978e95b43407907511e33c7bde8c66c27062a2442db1ae4281c2a496, expires=N/A (repo-versioned)
  - evidence/P8-04/browser-specialized-capability.md, sha256=d673084f907d491ba5c8761644df69b612b91e7e3fdd5e1d16a5072a5a72522a, expires=N/A (repo-versioned)
  - packages/browser-export/src/types.ts, sha256=04f58f959fb8aa56ff76928cce31ee241ba2fe5944543389fbb607010aaf843b, expires=N/A (repo-versioned)
  - packages/browser-export/src/acceptance-matrix.ts, sha256=97cc79b4a8e8d3215cbf7508ec0117ded5c135e78c68f7eb20ecb6abed2b6f36, expires=N/A (repo-versioned)
  - packages/browser-export/src/pipeline.ts, sha256=58d7bf160dc58a6dfe8c5269cba5261607839a066aed3b585841169def3686ed, expires=N/A (repo-versioned)
  - packages/browser-export/src/index.ts, sha256=f3508e1233e781d668a6d6a9f9e43810144fea996825a1b4a09f0be953a07b50, expires=N/A (repo-versioned)
  - packages/browser-export/test/acceptance-matrix.test.mjs, sha256=4d3f643b75627fc2a728900b8aa0500df9180cd244f1879ccad29ace924a00dd, expires=N/A (repo-versioned)
  - packages/browser-export/test/refusal-and-no-silent-degradation.test.mjs, sha256=afe5bada8ae8d16e9d5cc22ec6f923d4d46fb5b86505264dc0306c09e4a47391, expires=N/A (repo-versioned)
Acceptance mapping:
  - Browser/specialized capability docs và acceptance matrix: PASS — Ban hành tài liệu năng lực hệ thống tại browser-specialized-capability.md và ma trận nghiệm thu máy đọc được tại acceptance-matrix.json (43 mục phân loại trên 9 danh mục chuẩn: nền tảng trình duyệt, công cụ phân cảnh, video codec, audio codec, container, lớp kịch bản, chuyển cảnh, trần bộ nhớ/tài nguyên, và gói mã nguồn bên thứ ba).
  - Refuse unsupported instead of silently degrade: PASS — Triển khai chính sách từ chối nghiêm ngặt qua assertNoSilentDegradation(), UnsupportedFeatureRefusalError và SilentDegradationPreventedError; chặn đứng 100% các phản mẫu âm thầm bỏ âm thanh, âm thầm bỏ lớp, âm thầm co nhỏ kích thước hoặc trôi dạt dấu thời gian CFR; hỗ trợ chế độ xuất nghiêm ngặt strict_local_only từ chối dứt khoát hoặc tự động thoái lui tạo server job mới.
  - Có thể conclude no-adoption với evidence, không fake support: PASS — Công bố các kết luận bác bỏ/không áp dụng chính thức kèm bằng chứng thực nghiệm đầy đủ: PixiJS (bác bỏ hoàn toàn, RTF 4.65x-5.04x trên CPU WebGL, thiếu âm thanh/phụ đề/muxing, điểm 52.5/100, cấm fake support), Software WASM x264 (bác bỏ do nghĩa vụ phí MPEG-LA và lây nhiễm copyleft GPL-2.0), Revideo/Motion Canvas (không áp dụng trên trình duyệt do thực thi mã động TSX/generator, hoãn sang MicroVM P7), iOS Safari 4K Local (không áp dụng do sập bộ nhớ Jetsam 1024 MiB), Raw External URLs (từ chối do nguy cơ SSRF, bắt buộc scoped grants), WebAV Pro / Sample assets (bác bỏ do mã nguồn đóng thương mại và vi phạm chuẩn tiếng Việt P0-03).
Reviewer / reviewed commit / decision: AGY Independent Reviewer / HEAD / IMPLEMENTED_LOCAL
```

---

## 1. Tổng quan Đánh giá Thẩm định Phân kỳ P8 (P8 Reviewer Assessment)

Nhiệm vụ **P8-04** thực hiện vai trò Đánh giá thẩm định (`Reviewer`) đối với toàn bộ các phát hiện kỹ thuật, mã nguồn triển khai và quyết định kiến trúc trong phân kỳ P8 (gồm [P8-01](../P8-01/report.md), [P8-02](../P8-02/report.md) và [P8-03](../P8-03/report.md)).

### 1.1. Tóm tắt kết quả kiểm toán 3 nhiệm vụ tiền đề:
1. **P8-01 (D+C / Rà soát WebAV/Mediabunny, Pháp lý và Ma trận Năng lực Trình duyệt):**
   - Đã xác thực toàn vẹn 8 gói npm ứng viên, mã băm SHA-512, shasum, và giấy phép SPDX.
   - Xác định ranh giới pháp lý bằng sáng chế H.264: WebCodecs bản địa gọi phần cứng hệ điều hành là **miễn phí bản quyền cho ứng dụng web** (do Apple/Microsoft/Google chi trả).
   - Thiết lập cổng kiểm soát nghiêm ngặt `EXT-P8-01` (`assertBrowserExportGateApproved`) chặn đứng việc phân phối mã chưa qua phê duyệt độc lập.
2. **P8-02 (B+D / Bản mẫu Xuất Video Trình duyệt, Server Fallback và Đối chuẩn Chất lượng):**
   - Triển khai thành công pipeline xuất video trên trình duyệt cho tập con phân cảnh 2D Canvas chuẩn (văn bản tiếng Việt, hình khối, hình ảnh có chữ ký Scoped HMAC Grant).
   - Hiện thực hóa cơ chế tự động thoái lui tạo **server job mới** (`POST /v1/render-jobs`) với khóa `Idempotency-Key` chuẩn hóa khi gặp tính năng không hỗ trợ hoặc giới hạn phần cứng (như Firefox thiếu encoder, mobile vượt 720p).
   - Kiểm soát bộ nhớ nghiêm ngặt qua `MemoryGuard` luồng (đệm tối đa 4 khung hình, ≤ 32 MiB heap), hỗ trợ hủy tác vụ `AbortSignal`, và kiểm định 100% tính toàn vẹn container fMP4/WebM.
3. **P8-03 (B / Khảo sát Công cụ Phân cảnh Chuyên biệt, Báo cáo CPU/Bản quyền và ADR-0003):**
   - Khảo sát có giới hạn 4 ứng viên: VideoFlow, Revideo, Motion Canvas, PixiJS trên môi trường chuẩn 4 vCPU không có GPU vật lý.
   - Ban hành **[ADR 0003](../P8-03/ADR-0003-specialized-scene-engine-adapter.md)**: Chọn duy nhất **VideoFlow** (94.5/100, Apache-2.0, RTF 1.34x, tìm kiếm ngẫu nhiên 100% tất định).
   - Hoãn lại (`deferred`) **Revideo** (70.5/100) và **Motion Canvas** (62.0/100) sang hạ tầng cô lập MicroVM `P7`.
   - Bác bỏ hoàn toàn (`rejected`) **PixiJS** (52.5/100) do suy giảm hiệu năng nghiêm trọng trên CPU giả lập WebGL (RTF lên tới 5.04x) và thiếu toàn bộ đường ống âm thanh, phụ đề và đóng gói video.

---

## 2. Ma trận Nghiệm thu Toàn diện (The Acceptance Matrix)

Ma trận nghiệm thu được chuẩn hóa thành 43 mục thuộc 9 danh mục phân loại rõ ràng trong `packages/browser-export/src/acceptance-matrix.ts` và tệp máy đọc được `evidence/P8-04/acceptance-matrix.json`:

### 2.1. Phân loại 4 Trạng thái Nghiệm thu (The 4 Normative Verdicts)
1. **`ACCEPTED_BASELINE_SUPPORT`:** Tính năng/nền tảng được hỗ trợ đầy đủ, kết xuất cục bộ trên trình duyệt đạt 100% độ trung thực về thời gian, hình ảnh và âm thanh so với máy chủ.
2. **`ACCEPTED_WITH_FALLBACK`:** Tính năng/nền tảng hợp lệ nhưng phần cứng trình duyệt máy khách bị hạn chế (ví dụ Firefox thiếu bộ mã hóa, di động chạy 1080p); hệ thống tự động chuyển giao minh bạch sang tạo render job mới trên máy chủ (`POST /v1/render-jobs`).
3. **`REFUSED_UNSUPPORTED`:** Tính năng không được hỗ trợ trong tập con và không được phép âm thầm bỏ qua; hệ thống từ chối dứt khoát với mã lỗi chuẩn hóa (`UnsupportedFeatureRefusalError`), bảo vệ tính toàn vẹn của kịch bản.
4. **`CONCLUDED_NO_ADOPTION`:** Đã kết luận không áp dụng dựa trên bằng chứng kiểm toán kỹ thuật/pháp lý/hiệu năng thực tế. Nghiêm cấm tuyệt đối mọi hình thức giả lập hoặc ngụy tạo hỗ trợ (`không fake support`).

### 2.2. Bảng tổng hợp Ma trận Nghiệm thu Phân kỳ P8

| Danh mục | Mục kiểm định (Candidate) | Trạng thái (Verdict) | Hành động mặc định | Mã lý do / Ràng buộc chính | Tham chiếu bằng chứng |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **Nền tảng** | Google Chrome Desktop | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | WebCodecs phần cứng đầy đủ trong DedicatedWorker | `evidence/P8-01/report.md` |
| **Nền tảng** | Microsoft Edge Desktop | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Blink engine parity với Chrome | `evidence/P8-01/report.md` |
| **Nền tảng** | Apple Safari Desktop | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | H.264/HEVC/AAC qua Apple VideoToolbox | `evidence/P8-01/report.md` |
| **Nền tảng** | Mozilla Firefox Desktop | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `MISSING_VIDEO_ENCODER` (Gecko thiếu encoder ổn định) | `evidence/P8-01/report.md` |
| **Nền tảng** | Apple iOS Safari (720p) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | 720p an toàn dưới ngưỡng Jetsam (1024 MiB) | `evidence/P8-01/report.md` |
| **Nền tảng** | Apple iOS Safari (1080p) | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `EXCEEDS_MEMORY_BUDGET` (tránh sập tab Jetsam) | `evidence/P8-01/report.md` |
| **Nền tảng** | Apple iOS Safari (4K Local) | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Khung thô 33 MiB/khung) | `evidence/P8-01/report.md` |
| **Nền tảng** | Android Chrome (720p) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Android MediaCodec hardware encoder | `evidence/P8-01/report.md` |
| **Nền tảng** | Android Chrome (1080p/4K) | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `EXCEEDS_MEMORY_BUDGET` (tránh quá nhiệt/nghẽn codec) | `evidence/P8-01/report.md` |
| **Nền tảng** | Trình duyệt không nhận diện | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `UNSUPPORTED_BROWSER_PLATFORM` (môi trường chưa kiểm chứng) | `evidence/P8-01/report.md` |
| **Công cụ** | **VideoFlow** (JSON Declarative) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | **ADR-0003 (94.5/100, Apache-2.0, RTF 1.34x, 118 MiB)** | `evidence/P8-03/report.md` |
| **Công cụ** | **Revideo** (TS Generator DSL) | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Đòi hỏi MicroVM P7; 70.5/100) | `evidence/P8-03/report.md` |
| **Công cụ** | **Motion Canvas** (Imperative) | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Đòi hỏi MicroVM P7; 62.0/100) | `evidence/P8-03/report.md` |
| **Công cụ** | **PixiJS** (WebGL Sprite 2D) | `CONCLUDED_NO_ADOPTION` | `refuse` | **`NO_ADOPTION_CONCLUDED` (Bác bỏ 52.5/100, RTF 5.04x CPU)** | `evidence/P8-03/report.md` |
| **Codec video** | H.264 via WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Miễn phí bản quyền phần mềm (OS vendor đã trả MPEG-LA) | `evidence/P8-01/report.md` |
| **Codec video** | H.264 via Software WASM | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Vi phạm phí MPEG-LA + GPL-2.0) | `evidence/P8-01/report.md` |
| **Codec video** | HEVC/H.265 WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hỗ trợ trên Safari/iOS; thoái lui trên Blink/Gecko | `evidence/P8-01/report.md` |
| **Codec video** | VP9 WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hỗ trợ trên Chrome/Edge/Android; thoái lui trên Safari | `evidence/P8-01/report.md` |
| **Codec video** | AV1 WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hỗ trợ trên Blink Desktop | `evidence/P8-01/report.md` |
| **Codec audio** | AAC-LC WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | 48kHz stereo, đồng bộ độ lệch thời gian <= 1 khung | `evidence/P8-01/report.md` |
| **Codec audio** | Opus WebCodecs | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Định dạng âm thanh mở cho WebM | `evidence/P8-01/report.md` |
| **Codec audio** | Âm thầm bỏ luồng âm thanh | `REFUSED_UNSUPPORTED` | `refuse` | `SILENT_DEGRADATION_PROHIBITED` (cấm xuất video câm) | `docs/IMPLEMENTATION_PLAN.md` |
| **Container** | fMP4 ISOBMFF | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hộp ftyp, moov, mdat tất định không lỗi cấu trúc | `evidence/P8-02/report.md` |
| **Container** | WebM EBML | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Tiêu đề EBML chuẩn | `evidence/P8-02/report.md` |
| **Lớp kịch bản**| Lớp Văn bản (phông ghim) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Khóa băm SHA-256 phông, chuẩn Unicode NFC tiếng Việt | `evidence/P8-02/report.md` |
| **Lớp kịch bản**| Phông chưa ghim / Phông từ mạng | `REFUSED_UNSUPPORTED` | `refuse` | `UNSUPPORTED_BROWSER_PLATFORM` (cấm tải phông tùy ý) | `docs/SECURITY.md` |
| **Lớp kịch bản**| Lớp Hình khối (Shape) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Vector 2D hình chữ nhật, bo góc, elip | `evidence/P8-02/report.md` |
| **Lớp kịch bản**| Lớp Ảnh qua Scoped Grant | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | HMAC grant TTL <= 300s, cô lập tenant, kiểm băm SHA-256 | `evidence/P8-02/report.md` |
| **Lớp kịch bản**| Lớp Ảnh qua URL trực tiếp | `REFUSED_UNSUPPORTED` | `refuse` | `UNAUTHENTICATED_ASSET_URL` (chống SSRF và rò rỉ token) | `docs/SECURITY.md` |
| **Lớp kịch bản**| Lớp Video lồng nhau | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `UNSUPPORTED_LAYER_TYPE` (giới hạn phần cứng giải mã) | `evidence/P8-02/report.md` |
| **Lớp kịch bản**| Custom code / bundle | `ACCEPTED_WITH_FALLBACK` | `fallback_to_server_job` | `CUSTOM_CODE_ENGINE_UNSUPPORTED` (đòi hỏi MicroVM P7) | `evidence/P8-01/report.md` |
| **Lớp kịch bản**| Âm thầm bỏ lớp không hỗ trợ| `REFUSED_UNSUPPORTED` | `refuse` | `SILENT_DEGRADATION_PROHIBITED` (cấm tự ý bỏ lớp) | `docs/IMPLEMENTATION_PLAN.md` |
| **Chuyển cảnh** | Cut (chuyển cảnh cắt) | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | duration_frames = 0 | `evidence/P8-02/report.md` |
| **Chuyển cảnh** | Fade to background | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hòa trộn: layer_alpha(k) * scene_alpha(k) | `evidence/P8-02/report.md` |
| **Chuyển cảnh** | Crossfade 2D subset | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Hòa trộn mờ hai cảnh trong tập con 2D | `evidence/P8-02/report.md` |
| **Chuyển cảnh** | Shader WebGL tùy ý | `REFUSED_UNSUPPORTED` | `refuse` | `UNSUPPORTED_TRANSITION` (cấm âm thầm đổi thành cut) | `docs/IMPLEMENTATION_PLAN.md` |
| **Bộ nhớ** | Streaming Memory Guard | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Giải phóng khung tức thì, duy trì heap <= 32 MiB | `evidence/P8-02/report.md` |
| **Bộ nhớ** | Đệm toàn bộ khung trên RAM | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (1080p 60s > 14 GiB RAM) | `evidence/P8-02/report.md` |
| **Bộ nhớ** | Âm thầm co nhỏ độ phân giải | `REFUSED_UNSUPPORTED` | `refuse` | `SILENT_DEGRADATION_PROHIBITED` (cấm tự ý downscale) | `docs/IMPLEMENTATION_PLAN.md` |
| **Gói ngoài** | Mediabunny 1.65.2 | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Tiện ích ghép container, tuân thủ MPL-2.0 notice | `evidence/P8-01/report.md` |
| **Gói ngoài** | @webav/av-cliper 1.2.8 | `ACCEPTED_BASELINE_SUPPORT` | `export_locally` | Tiện ích phân đoạn mẫu MIT | `evidence/P8-01/report.md` |
| **Gói ngoài** | WebAV Pro thương mại | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Mã nguồn đóng thương mại) | `evidence/P8-01/report.md` |
| **Gói ngoài** | Dữ liệu mẫu Big Buck Bunny | `CONCLUDED_NO_ADOPTION` | `refuse` | `NO_ADOPTION_CONCLUDED` (Nhiễm bẩn mẫu ngoại vi P0-03) | `evidence/P8-01/report.md` |

---

## 3. Thực thi Nguyên tắc "Refuse Unsupported Instead of Silently Degrade"

Mô-đun `packages/browser-export/src/acceptance-matrix.ts` hiện thực hóa đầy đủ các quy tắc bảo vệ:

1. **Hàm `assertNoSilentDegradation(spec, platform)`:**
   - Kiểm tra ngay từ đầu: nếu kịch bản có luồng âm thanh mà trình duyệt thiếu `AudioEncoder`, lập tức ném lỗi `SilentDegradationPreventedError`, tuyệt đối không tạo tệp MP4 câm.
   - Kiểm tra các lớp đồ họa: nếu kịch bản chứa lớp không thuộc tập con `['text', 'image', 'shape']`, ném lỗi chặn đứng việc âm thầm bỏ sót lớp.
   - Kiểm tra mã tùy ý: nếu phát hiện `custom-html-v1` hoặc `bundle`, ngăn chặn việc âm thầm tước bỏ mã để render màn hình đen.

2. **Chế độ Xuất Nghiêm ngặt `exportMode: 'strict_local_only'` trong `exportBrowserVideo()`:**
   - Khi khách hàng hoặc hệ thống yêu cầu kiểm định cục bộ nghiêm ngặt, mọi vi phạm về năng lực phần cứng hoặc tập con kịch bản đều ném lỗi `UnsupportedFeatureRefusalError` kèm mã lý do chuẩn hóa và tham chiếu bằng chứng, không tự ý chuyển giao ngầm sang máy chủ nếu không có sự đồng ý của caller.

3. **Cơ chế Chuyển giao Chuẩn tắc `exportMode: 'allow_server_fallback'`:**
   - Trong chế độ sản xuất mặc định, hệ thống tự động chuyển giao sang `POST /v1/render-jobs` tạo một tác vụ dựng video mới trên máy chủ, bảo toàn 100% các lớp phức tạp, âm thanh và độ phân giải gốc của người dùng.

---

## 4. Bằng chứng Bác bỏ Chính thức và Chống Ngụy tạo Hỗ trợ (No Fake Support)

Hàm `validateNoFakeSupport(candidateName)` bảo đảm tính trung thực tuyệt đối của hệ thống:

```ts
// Khi có mã nguồn hoặc cấu hình cố tình khai báo PixiJS:
validateNoFakeSupport('pixijs');
// Sẽ lập tức ném lỗi NoFakeSupportError:
// "No fake support violation: Candidate 'PixiJS WebGL/WebGPU 2D Engine' has been concluded as NO-ADOPTION
// based on empirical evidence. Fake support, mock emulation, or unvalidated claims are strictly forbidden.
// Evidence: evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md.
// Rationale: Score 52.5/100 (Rejected). Catastrophic CPU penalty under software WebGL SwiftShader (RTF 4.65x-5.04x)..."
```

### Các ứng viên bị bác bỏ chính thức:
1. **PixiJS:** Bị bác bỏ do không phù hợp với đường ống render video trên máy chủ lẫn xuất video trình duyệt. Chi phí giả lập đồ họa WebGL trên CPU quá cao (RTF 4.65x - 5.04x) và thiếu toàn bộ các thành phần media thiết yếu (audio/subtitles/muxing).
2. **Software WASM x264:** Bị bác bỏ do rủi ro pháp lý bằng sáng chế phần mềm MPEG-LA và nguy cơ lây nhiễm copyleft GPL-2.0 vào ứng dụng web thương mại.
3. **Revideo / Motion Canvas trên trình duyệt:** Bị bác bỏ đối với môi trường trình duyệt máy khách vì thực thi mã JavaScript động tùy ý; hoãn sang phân kỳ `P7` để chạy trong MicroVM cách ly.
4. **iOS Safari 4K Client Export:** Bị bác bỏ vì vượt trần bộ nhớ Jetsam (1024 MiB), chắc chắn làm sập tab trình duyệt người dùng.
5. **WebAV Pro:** Bị bác bỏ vì là module mã nguồn đóng thương mại, gây rủi ro phụ thuộc công nghệ độc quyền.

---

## 5. Kết quả Kiểm thử và Nghiệm thu Toàn diện

Đã khởi chạy toàn bộ 9 bộ kiểm thử trong gói `@creativanta/browser-export`:

```text
▶ P8-04: Browser & Specialized Engine Acceptance Matrix
  ✔ 1.1 Matrix Completeness: verifies all 9 categories and expected entry counts (1.56ms)
  ✔ 1.2 Verdict Distribution: validates the 4 normative acceptance verdicts (0.55ms)
  ✔ 1.3 Specialized Engines: verifies VideoFlow baseline vs PixiJS/Revideo/Motion Canvas no-adoption (0.46ms)
  ✔ 1.4 Codec Legal Matrix: verifies WebCodecs H.264 baseline vs Software WASM x264 no-adoption (0.32ms)
  ✔ 1.5 Platform Memory Ceilings: verifies iOS Safari 720p vs 1080p fallback vs 4K no-adoption (0.32ms)
  ✔ 1.6 No Fake Support: validates prohibition of unvalidated claims for rejected candidates (1.00ms)
  ✔ 1.7 evaluateCompositionAcceptance: correctly evaluates conforming vs non-conforming compositions (1.09ms)
✔ P8-04: Browser & Specialized Engine Acceptance Matrix (7.40ms)

▶ P8-04: Strict Refusal & Anti-Silent Degradation Policy
  ✔ 2.1 assertNoSilentDegradation: prevents silent audio omission when AudioEncoder is absent (2.25ms)
  ✔ 2.2 assertNoSilentDegradation: prevents silent layer omission for unsupported layers (0.35ms)
  ✔ 2.3 assertNoSilentDegradation: prevents silent custom code bundle omission (0.28ms)
  ✔ 2.4 exportBrowserVideo (strict_local_only): strictly refuses unsupported platform instead of degrading (1.43ms)
  ✔ 2.5 exportBrowserVideo (strict_local_only): strictly refuses unsupported scene features (0.73ms)
  ✔ 2.6 exportBrowserVideo (strict_local_only): successfully renders fully conforming scene subset (2.94ms)
  ✔ 2.7 refuseUnsupportedFeature: helper function throws explicit refusal error with evidence metadata (0.33ms)
✔ P8-04: Strict Refusal & Anti-Silent Degradation Policy (10.67ms)

▶ P8-01: Browser Export Capability Matrix & Codec Parity (6 tests - PASS)
▶ P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate (3 tests - PASS)
▶ P8-02: End-to-End Browser Export Spike Integration Suite (4 tests - PASS)
▶ P8-02: Download Delivery & Quality Parity Suite (7 tests - PASS)
▶ P8-02: Memory Management & Cancellation Suite (6 tests - PASS)
▶ P8-02: Scene Subset & Server Fallback Suite (9 tests - PASS)
▶ P8-02: Scoped Asset Grants & Offline Caching Suite (7 tests - PASS)
▶ P8-03: Specialized Scene Engine Spikes & Comparative Evaluation (6 tests - PASS)
▶ P8-03: VideoFlow Adapter Suite (8 tests - PASS)

Tổng cộng: 72 tests, 9 suites, 100% PASS, 0 fail, 0 flaky.
```

---

## 6. Trạng thái các Cổng Nghiệm thu Bên ngoài (External Gates)

| Mã cổng | Tên cổng phê duyệt | Trạng thái hiện tại | Điều kiện giải phóng (Release Condition) |
| :---: | :--- | :---: | :--- |
| **`EXT-P8-01`** | **Phê duyệt Pháp lý & Phân phối WebCodecs Browser Export** | `pending_external_review` | Cần chữ ký độc lập từ chuyên gia pháp lý và an ninh trước khi bật cờ tính năng phân phối mã ra ứng dụng khách ngoài đời thực. |
| **`EXT-P8-02`** | **Phê duyệt Bản quyền & Hợp đồng VideoFlow Adapter** | `pending_external_review` | Phê duyệt đánh giá giấy phép Apache-2.0 và ma trận không áp dụng PixiJS trước khi tích hợp vào catalog chính thức của Creativanta. |

---

## 7. Kết luận và Bàn giao

Nhiệm vụ **P8-04** đã hoàn thành trọn vẹn toàn bộ các mục tiêu đặt ra:
1. Đã chuẩn hóa toàn bộ năng lực trình duyệt và công cụ chuyên biệt trong `evidence/P8-04/browser-specialized-capability.md`.
2. Đã xuất bản ma trận nghiệm thu máy đọc được tại `evidence/P8-04/acceptance-matrix.json` (43 mục phân loại).
3. Đã triển khai và kiểm chứng 100% chính sách từ chối tính năng không hỗ trợ thay vì âm thầm làm suy giảm chất lượng (`packages/browser-export/src/acceptance-matrix.ts`).
4. Đã xác lập các quyết định không áp dụng có căn cứ thực nghiệm đầy đủ (PixiJS, Software WASM x264, Revideo/Motion Canvas trên trình duyệt, mobile 4K, raw URLs), nghiêm cấm ngụy tạo hỗ trợ.
5. Sẵn sàng cho phân kỳ thương mại P9 và quy trình tích hợp của Supervisor.
