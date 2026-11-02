# Creativanta Video Engine

Nền tảng Video-as-a-Service độc lập, API-first, tạo video bằng code trên CPU. Creativanta là một client của API; khách hàng khác dùng cùng hợp đồng multi-tenant. Video được dựng từ HTML/CSS/WAAPI/SVG/Canvas/TypeScript, media có quyền sử dụng, phụ đề, âm thanh và FFmpeg. Không dùng mô hình sinh video GPU tự host hay API sinh video đắt tiền.

**Trạng thái triển khai:** Đã hoàn thành scaffold `P1-01` (TS workspace, pinned pnpm lockfile, local Docker Compose, health checks và env sample). Các giai đoạn tiếp theo triển khai JSON Schema / OpenAPI (`P1-02`), validator (`P1-03`), sandbox launcher (`P1-04`), và ba MP4 video POC thực tế (`P2`). Không production deployment từ repository này.

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

## Setup và phát triển cục bộ

Hệ thống sử dụng Node.js v24+, pnpm pinned qua Corepack, TypeScript 5.7, và Docker Compose cho các dịch vụ phụ trợ cục bộ (PostgreSQL 16, MinIO S3 dev store).

### 1. Yêu cầu môi trường

- **Node.js**: `>= 24.0.0`
- **Corepack**: Đã tích hợp sẵn trong Node.js để quản lý `pnpm` đã pin (`pnpm@12.16.1`)
- **Docker & Docker Compose**: Cho môi trường phụ trợ cục bộ (PostgreSQL 16, MinIO)
- **Python 3**: `>= 3.10` cho các script kiểm tra và supervisor harness

### 2. Cài đặt và build workspace

Kích hoạt pnpm, cài đặt dependencies với lockfile đã pin, biên dịch và chạy kiểm thử:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

### 3. Cấu hình môi trường

Sao chép file mẫu `.env.example` sang `.env` để chạy môi trường development:

```bash
cp .env.example .env
```

Toàn bộ thông số cấu hình và biến môi trường được chuẩn hóa tại [Deployment](docs/DEPLOYMENT.md).

### 4. Khởi động dịch vụ phụ trợ với Docker Compose

Khởi động PostgreSQL 16 và MinIO S3 dev store:

```bash
docker compose up -d postgres object-store
```

Hoặc khởi động toàn bộ cụm dịch vụ phát triển:

```bash
docker compose up -d
```

### 5. Kiểm tra sức khỏe hệ thống (Health Check)

Kiểm tra trạng thái cấu hình và endpoints liveness / readiness:

```bash
node scripts/health-check.mjs
```

Khi API server đang chạy:

```bash
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8080/readyz
curl -s http://127.0.0.1:8080/v1/capabilities
```

### 6. Kiểm định toàn vẹn repository

```bash
python3 scripts/validate_repo.py
```
