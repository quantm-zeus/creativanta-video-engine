# Đánh giá open source

Ngày kiểm tra: **2026-11-02**. Đây là research/adoption proposal, không phải legal approval hoặc security audit. [ADR 0001](ADR/0001-engine-selection.md) quy định gates; [Testing](TESTING.md) quy định benchmark.

## Chất lượng chứng cứ

Đã đọc `/tmp/video-engine-research.json` như đầu mối từ phiên trước, sau đó dùng GitHub connector đọc lại metadata repo, README và LICENSE gốc của **cả 10 upstream**. [UPSTREAM_VERIFICATION.json](UPSTREAM_VERIFICATION.json) lưu kết quả rút gọn, URL, ngày push và phạm vi kiểm chứng, không chứa source code vendored.

`V1` = metadata repo hiện tại, bao gồm archived/pushed_at/default branch. `V2` = đã đọc README + root LICENSE hiện tại, đối chiếu tên license. `V3` = dependency/source audit ở exact commit/package tarball. `V4` = chạy benchmark/security test. **Hiện tất cả 10 repo đạt V1/V2; chưa repo nào đạt V3/V4 trong nhiệm vụ này.** GitHub SPDX metadata chỉ là tín hiệu, không thay việc đọc license. Branch reads không phải snapshot atomic; commit/tag/release trong file `/tmp` **chưa được xác minh lại**, không dùng làm production pin. Tất cả repo trả archived=false lúc kiểm tra; pushed_at không chứng minh release ổn định, khả năng bảo trì hoặc support SLA.

## Ma trận upstream

Mô tả capability trong bảng là claim của README; cột quyết định là đánh giá thiết kế của dự án, chưa benchmark.

| Upstream / chứng cứ trực tiếp | Root license V2 | Push UTC (V1) | Phù hợp và quyết định |
| --- | --- | --- | --- |
| [HyperFrames README](https://github.com/heygen-com/hyperframes/blob/main/README.md), [LICENSE](https://github.com/heygen-com/hyperframes/blob/main/LICENSE) | Apache-2.0 | 2026-11-02 05:27:13 | HTML/CSS/media và seekable animations, headless Chrome + FFmpeg. **Ứng viên chính**; chỉ dùng local render core, không kéo cloud/AI-video workflows vào sản phẩm |
| [HTML-Video README](https://github.com/nexu-io/html-video/blob/main/README.md), [LICENSE](https://github.com/nexu-io/html-video/blob/main/LICENSE) | Apache-2.0 | 2026-06-21 16:18:31 | Agent/template orchestration và engine adapters. **Tham khảo/reuse có chọn lọc**, không làm core service; README nói HyperFrames wired, các engine khác roadmap |
| [WebAV README](https://github.com/WebAV-Tech/WebAV/blob/main/README.md), [LICENSE](https://github.com/WebAV-Tech/WebAV/blob/main/LICENSE) | MIT | 2026-01-10 09:53:51 | WebCodecs SDK cho browser editing/compose. **Optional browser export spike** sau server MVP; không assume feature Pro thuộc MIT core |
| [Mediabunny README](https://github.com/Vanilagy/mediabunny/blob/main/README.md), [LICENSE](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE) | MPL-2.0 | 2026-10-30 17:27:03 | TS demux/mux/conversion, WebCodecs integration. **Candidate browser media layer**, không scene orchestrator; review file-level obligations trước bundle ra client |
| [VideoFlow README](https://github.com/ybouane/VideoFlow/blob/main/README.md), [LICENSE](https://github.com/ybouane/VideoFlow/blob/main/LICENSE) | Apache-2.0 | 2026-09-16 06:36:48 | TS → portable JSON; DOM/server/browser renderers. **Secondary challenger** cho ADR benchmark; giữ canonical scene spec riêng và đánh giá transitive Mediabunny/WebGL effects |
| [explainroo README](https://github.com/vincentsch/explainroo/blob/main/README.md), [LICENSE](https://github.com/vincentsch/explainroo/blob/main/LICENSE) | MIT | 2026-10-20 07:47:04 | Narration/timing/canvas/Chrome/FFmpeg. **Tham khảo pipeline explainer/audio/subtitles**, không adopt local workflow thành multi-tenant service nguyên khối |
| [Motion Canvas README](https://github.com/motion-canvas/motion-canvas/blob/main/README.md), [LICENSE](https://github.com/motion-canvas/motion-canvas/blob/main/LICENSE) | MIT | 2026-07-02 20:01:32 | TS animation framework/editor, 2D/core packages. **Optional specialized animation adapter**; authoring model khác HTML, chưa cần cho POC đầu |
| [PixiJS README](https://github.com/pixijs/pixijs/blob/dev/README.md), [LICENSE](https://github.com/pixijs/pixijs/blob/dev/LICENSE) | MIT | 2026-10-30 22:31:56 | 2D WebGL/WebGPU renderer, không toàn bộ video pipeline. **Hoãn**, chỉ scene adapter nếu software-render CPU benchmark tốt; không assume GPU acceleration miễn phí |
| [MoneyPrinterTurbo README](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/README.md), [LICENSE](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/LICENSE) | MIT | 2026-11-02 02:29:36 | Script/stock/TTS/subtitle workflow. **Tham khảo nghiệp vụ**, không deploy nguyên repo: provider keys/stock rights/TTS ToS và tenant boundaries cần thiết kế riêng |
| [Revideo README](https://github.com/midrender/revideo/blob/main/README.md), [LICENSE](https://github.com/midrender/revideo/blob/main/LICENSE) | MIT | 2026-07-15 22:43:55 | TS scene render, headless renderVideo, media và parallel render claims. **Fallback challenger sau baseline**, review relationship/licenses với Motion Canvas và frame/audio behavior |

WebAV dùng canonical repo `WebAV-Tech/WebAV`; `/tmp` ghi tên cũ `hughfenghen/WebAV` và URL mới. Không infer cả hai là hai dự án. Revideo được xác minh tại `midrender/revideo`; root license vẫn có attribution Motion Canvas. PixiJS đọc branch `dev`, tuyệt đối không dùng branch mutable làm release pin.

## Điều kiện reuse và rủi ro compatibility

- **HyperFrames:** contract HTML/time attributes có thể giảm công viết renderer, nhưng phải chứng minh seek ngẫu nhiên, media CFR, font ready, CPU-only, offline mode và worker isolation. README có CDN/agent/media workflows; không mang URL CDN hoặc generative video helpers vào runtime. GSAP/animation libs, template catalog, fonts và codec build cần license riêng; root Apache không bao phủ mặc nhiên mọi thứ. Không để upstream auto-update skills/runtime trên production.
- **HTML-Video:** dùng HyperFrames không tạo engine dự phòng độc lập. Chỉ tái sử dụng adapter/pattern đã audit; dịch vụ tự quản auth/jobs/outbox/quota. Claim template “license-clean” chưa thay rights audit từng asset/template. Server-side fetch của upstream không mặc định đủ SSRF protection cho SaaS.
- **VideoFlow:** có tiềm năng JSON portability, nhưng không đổi public scene schema theo internal upstream JSON. Cần adapter mapping với explicit unsupported features; kiểm CPU shader fallback và preview/export parity. Browser renderer dùng Mediabunny theo README, nên kiểm cả transitive license.
- **WebAV/Mediabunny:** browser codec availability, memory, Safari/mobile support và client hardware khác nhau; export browser chỉ opt-in capability test. Server MP4 vẫn authoritative. WebAV README nêu Chrome/Edge và Pro khác biệt; không sử dụng headline performance claim như số đo của nền tảng.
- **Motion Canvas/Revideo:** generator/timeline TS cần pin semantics và isolate build. Học lại authoring DSL có cost; không bắt template service phụ thuộc vào editor. Split-frame parallelization phải kiểm state reset và audio concat, không dùng chỉ vì README nói hỗ trợ.
- **PixiJS:** scene renderer không giải quyết encode/audio/jobs; WebGL/WebGPU paths có thể làm chi phí CPU software rasterization tăng mạnh. Chỉ mở engine sau benchmark không cần physical GPU.
- **explainroo/MoneyPrinterTurbo:** hữu ích cho sequencing narration/stock/captions; TTS weights, voice license, alignment model, network providers và stock rights không được root MIT cấp. Không mặc định free consumer TTS endpoint được phép commercial SaaS; dùng upload audio baseline.

## License/SaaS review checklist

MIT/Apache root licenses cho phép nhiều hình thức thương mại nhưng phải thực hiện nghĩa vụ notices/attribution và điều kiện cụ thể. Reviewer cần đọc exact pinned LICENSE/NOTICE, package licenses, assets và dependency tree; phân biệt sử dụng server nội bộ với phân phối Docker image/SDK/browser bundle. Đây là gate adoption, không kết luận pháp lý cuối cùng.

MPL có copyleft ở cấp file và nghĩa vụ khi phân phối; browser JS được gửi cho khách là trường hợp cần review distribution. Giữ notices và khả năng cung cấp source của covered files/modifications theo license; không diễn giải MPL là MIT hoặc yêu cầu mở toàn bộ proprietary service. Nguồn chuẩn: [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

FFmpeg có thành phần LGPL và optional GPL; build flags/dependencies quyết định license binary, libx264 là vấn đề GPL cần xét. Gọi FFmpeg subprocess không tự xóa nghĩa vụ phân phối; `--enable-nonfree` không phải đường tắt thương mại. Lưu `ffmpeg -version`/`-buildconf`, notices/source offer khi cần và review H.264/AAC patents theo thị trường. Không tuyên bố “mọi render miễn license”. Nguồn: [FFmpeg legal](https://ffmpeg.org/legal.html).

Asset/font/voice có chain of rights riêng: stock license cho commercial/re-distribution/end-product, logo/trademark consent, font embedding (ví dụ OFL phải đọc exact license), TTS/model terms. Không download stock trong nhiệm vụ design; fixture POC dùng tài sản tự tạo hoặc có evidence license.

## Adoption record cần ở P0/P2

Mỗi dependency dự định ship cần: repo/package URL, immutable commit và package version/integrity, root/transitive SPDX inventory, LICENSE/NOTICE hashes, enabled feature/build flags, known vulnerability triage, maintainer/update assessment, reviewer/date, allowed usage (server/browser/distribution), benchmark report. Không có release tag ổn định thì pin commit + reproducible package build sau review; không chạy main trực tiếp. SBOM/license report và audit evidence mới cho phép V3; video/test artifacts mới cho phép V4. Báo cáo kiểm toán artifact thực tế cho HyperFrames, Chromium automation, FFmpeg và font tiếng Việt theo task P0-02 được lưu tại [P0-02 report](../evidence/P0-02/report.md) và [artifacts-review.json](../evidence/P0-02/artifacts-review.json).

Build-versus-reuse: tự xây public API/tenant isolation/scene schema/job orchestration vì yêu cầu riêng; reuse vetted rendering/encoding/media primitives. Không fork cả “AI video app” rồi coi đã có tenant-safe VaaS. Default: thử HyperFrames, benchmark fallback Chromium/FFmpeg, giữ VideoFlow/Revideo challenger nếu hai đường đầu không đạt gate. Chi phí thời gian evaluation có giới hạn trong [plan](IMPLEMENTATION_PLAN.md), không research vô hạn.
