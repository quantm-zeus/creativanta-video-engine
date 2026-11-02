# Creativanta Video Engine

Nền tảng Video-as-a-Service độc lập, API-first, tạo video bằng code trên CPU. Creativanta là một client của API; khách hàng khác dùng cùng hợp đồng multi-tenant. Video được dựng từ HTML/CSS/WAAPI/SVG/Canvas/TypeScript, media có quyền sử dụng, phụ đề, âm thanh và FFmpeg. Không dùng mô hình sinh video GPU tự host hay API sinh video đắt tiền.

**Trạng thái ngày 2026-11-02: chỉ có thiết kế và tài liệu.** Chưa có ứng dụng, Docker Compose, API đang chạy, benchmark, test kiến trúc hay video đã render. Endpoint, cấu hình và mục tiêu hiệu năng trong docs là hợp đồng dự kiến cho agent triển khai.

## Luồng sản phẩm

Client chọn template có version hoặc tạo composition có version → kiểm tra schema/media → tạo preview/render job bất đồng bộ → worker cô lập render và encode → lưu artifact riêng tenant → callback có chữ ký hoặc polling. Mọi template/scene sửa được bằng revision mới; revision đã dùng để render là immutable. Manifest pin asset, font và runtime để tái lập kết quả.

HyperFrames là ứng viên ưu tiên, phải qua license/security review và benchmark; Chromium + FFmpeg là fallback. Custom code do AI/người dùng viết mặc định tắt cho đến khi đạt sandbox gate. Codex, AGY Gemini Flash/Argon, OpenCode, DeepSeek và provider khác là adapter tạo code tùy chọn; không có model hay gói premium bắt buộc.

## Bản đồ tài liệu

| Tài liệu | Nội dung chuẩn tắc |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Ranh giới, task ID, bằng chứng, commit |
| [PRD](docs/PRD.md) | Người dùng, phạm vi và tiêu chí sản phẩm |
| [Architecture](docs/ARCHITECTURE.md) | Thành phần, state machine, dữ liệu |
| [API](docs/API.md) | REST v1, auth, idempotency và callback |
| [Scene spec](docs/SCENE-SPEC.md) | Timeline, schema, determinism, migration |
| [Open-source evaluation](docs/OPEN_SOURCE_EVALUATION.md) | Upstream, license và quyết định có điều kiện |
| [Security](docs/SECURITY.md) | Isolation, SSRF, quota và custom code gate |
| [Testing](docs/TESTING.md) | Acceptance, POC thật, chất lượng, benchmark |
| [Deployment](docs/DEPLOYMENT.md) | Môi trường CPU và cấu hình dự kiến |
| [Implementation plan](docs/IMPLEMENTATION_PLAN.md) | P0–P9, task ID, dependencies, exit gates |
| [AGY execution](docs/AGENTS.md) | Supervisor, queue, worktree, heartbeat, review |
| [Operations](docs/OPERATIONS.md) | SLO mục tiêu, runbooks, monitoring, cost |
| [ADR 0001](docs/ADR/0001-engine-selection.md) | Lựa chọn renderer và verification gates |
| [Execution log](docs/EXECUTION_LOG.md) | Việc đã làm/chưa làm và bàn giao |

Đọc theo thứ tự AGENTS → PRD → architecture/API/scene → security → plan → AGY execution. Khi mâu thuẫn: yêu cầu người dùng/ràng buộc an toàn ưu tiên; timing theo scene spec, HTTP theo API, trạng thái job theo architecture, completion theo plan. Sửa tài liệu liên quan cùng PR trước khi đổi hợp đồng.

## Setup khi code tồn tại

Hiện chỉ cần Git và trình đọc Markdown; **chưa có lệnh khởi động app hợp lệ**. Không chạy installer upstream để thử nền tảng.

`P1-01` phải bổ sung manifest/lockfile, Node LTS/package manager đã pin, `.env.example` không secrets, Compose local và hướng dẫn đã kiểm chứng. Flow setup dự kiến: dependency review/install → sinh secret local → khởi động DB/object store/API/worker → migrate → seed fixture → submit job → kiểm MP4 bằng ffprobe. Chỉ ghi tên script là hoạt động sau khi thực sự chạy. Xem [Deployment](docs/DEPLOYMENT.md).

Mốc hữu ích đầu tiên `P2` phải có **ba MP4 thật**, manifest, quality/cost report. Scaffold hay preview HTML không đáp ứng. Handoff runner push và khởi động AGY riêng; phiên thiết kế không thực hiện hai việc này.
