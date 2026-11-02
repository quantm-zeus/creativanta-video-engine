# Execution log — DOC-001

Ngày: 2026-11-02 UTC. Scope: design/documentation trong `/home/whaleorcale/evergreen/projects/creativanta-video-engine`; chỉ đọc thêm `/tmp/video-engine-research.json`. Bootstrap base commit `616677f` trên `main`. Working tree ban đầu sạch, chỉ README bootstrap được liệt kê; không có AGENTS.md sẵn trong repo.

## Việc đã thực hiện

- Đọc bootstrap README, git status/branch/base commit và research JSON phiên trước; không coi research JSON là chứng cứ adoption cuối cùng.
- Viết bộ thiết kế tiếng Việt với identifiers/code examples tiếng Anh: README, root AGENTS và 13 tài liệu yêu cầu trong docs/ (bao gồm ADR, log này). Thêm [upstream verification](UPSTREAM_VERIFICATION.json) để lưu evidence rút gọn và báo cáo validation sau kiểm tra.
- Đọc lại metadata, root LICENSE và README của 10 repo bằng GitHub connector; tất cả 30 reads thành công. License name và metadata đối chiếu với research cũ; ghi pushed_at hiện tại, archived=false, canonical URL/branch. Không clone/vendor/install/run external source.
- Đọc nguồn chính thức về [FFmpeg licensing](https://ffmpeg.org/legal.html), [Mozilla MPL](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) và [gVisor](https://gvisor.dev/docs/) để qualify license/isolation notes. Hai lần mở supplemental Chromium sandbox/JSON Schema URLs qua web tool không thành công; không dùng hai lần fetch đó làm verified evidence. Core architecture/schema là design proposal, không claim đã kiểm thử theo các nguồn đó.
- Chọn hướng có điều kiện: HyperFrames candidate đầu, independent Chromium/FFmpeg baseline, PostgreSQL durable queue/outbox, private object storage, structured frame timeline, explicit tenant scopes, custom code mặc định disabled đến security gate.

## Phân biệt verification và design

| Hạng mục | Trạng thái thực trong phiên này |
| --- | --- |
| Repo/bootstrap/research input | Đã đọc |
| Upstream metadata/root README/LICENSE | V1/V2 đã kiểm tra, xem [evaluation](OPEN_SOURCE_EVALUATION.md) |
| Exact upstream package pin/release/commit SHA | Chưa audit/pin; giá trị trong research cũ không được coi verified |
| Transitive license/codec/model/stock review | Chưa hoàn tất; P0/P2/P6 gates |
| App/API/OpenAPI artifact/full JSON Schema | Chưa viết/chạy; docs chỉ contract và schema fragment |
| Docker/worker/sandbox/DB/storage | Chưa tạo/chạy/deploy |
| Video/POC/benchmark/architecture tests | **NOT_RUN, chưa có output sản xuất** |
| AGY/sub-agents/implementation | Không khởi động |
| GitHub push/live Creativanta integration | Không thực hiện; runner/phiên scope riêng xử lý |
| Documentation validation | PASS Python checker; xem thống kê bên dưới |
| Local commit | Commit chứa log này dùng message được yêu cầu; SHA trong Git history/final handoff, không push |

## Validation và commit

Đã chạy Python documentation checker, exit 0: 15/15 files yêu cầu có nội dung, 16 Markdown files có đúng một H1/fences balanced, 84 internal links resolve, 11 JSON snippets và 1 JSON evidence file parse, 52 task IDs unique/known với dependency graph acyclic; 3 Mermaid blocks chỉ đếm, chưa render. Lần check sơ bộ báo link VALIDATION.md thiếu trong lúc file chưa tạo; đã sửa và rerun pass. `git diff --check` trên tracked diff trước staging cũng exit 0. [Validation report](VALIDATION.md) chứa script có thể chạy lại và giới hạn; kiểm tra tài liệu không thay test app/renderer.

Manual consistency review sửa P2 engine gate để không phụ thuộc ngược vào P4 job fencing, chia asset revoke foundation P3 khỏi live-job race P4, làm rõ bootstrap supervisor trước durable queue, secret-safe idempotency replay, preview offsets và template binding allowlist. Đã chạy `git diff --cached --check` exit 0 và kiểm staged names/stat: đúng 17 files tài liệu (15 yêu cầu + upstream JSON + validation report), không app/deployment/runtime files. Stage lại hai báo cáo sau khi ghi kết quả và rerun checks trước commit.

Commit local được yêu cầu dùng message `docs: design independent code-first video engine`; không push. Commit SHA cuối cùng báo trong handoff, không tự nhúng SHA của commit vào chính nó.

## Quyết định mở và owner

| Câu hỏi | Default hiện tại / task giải quyết |
| --- | --- |
| Engine/package/runtime pin nào thắng? | HyperFrames thử trước, baseline độc lập; P0-02/P2-04 + ADR E1–E6 |
| License binary FFmpeg/codecs/dependencies có được ship? | Chưa approved; P0-02, P6-04 legal/security evidence |
| CPU capacity/cost/RTF thực? | Reference budget chỉ giả định; P2-04/P6-03 đo, không giá bán |
| Cloud/region/data residency/storage provider? | Independent CPU + S3 contract; P6-05/P9-05 review trước môi trường thật |
| Vietnamese TTS provider/voice nào? | Audio upload baseline, TTS optional off; P5-02/P5-05 |
| Custom isolation runtime phù hợp host? | Disabled; preferred microVM, alternative phải ADR; P7-01/P7-05 |
| Browser export có đáng đầu tư? | Optional sau core, P8-01/P8-02 evidence |
| Credentials/URL/client mapping Creativanta thật? | Harness trong repo; P5-03/P9-04 handoff, không đọc/sửa project hiện hữu |
| On-call/legal/security reviewer thực? | Role placeholder, phải gán trước P6 beta go/no-go |

Không cần giải hết câu hỏi mở để bắt đầu P0/P1; không bỏ release gate khi chưa có answer/evidence.

## Handoff thực thi

Runner push commit docs theo quy trình ngoài phiên này, rồi start AGY riêng ở đúng repo. AGY đọc [root AGENTS](../AGENTS.md), [plan](IMPLEMENTATION_PLAN.md), [execution model](AGENTS.md), claim `P0-01` và dựng evidence/queue. Sau audit và scaffold, ưu tiên `P2-02`/`P2-03`: ba real MP4 và `P2-04` đo cost/quality. Tiếp đó async tenant API P3/P4, Creativanta harness P5, beta gates P6. Custom code/TTS/import/browser export không được tự bật để làm demo nếu gate chưa đạt. Không triển khai hoặc sửa VPS/Creativanta hiện hữu từ handoff này.
