# Creativanta Video Engine

Nền tảng Video-as-a-Service độc lập, API-first, tạo video bằng code trên CPU. Creativanta là một client của API; khách hàng khác dùng cùng hợp đồng multi-tenant. Video được dựng từ HTML/CSS/WAAPI/SVG/Canvas/TypeScript, media có quyền sử dụng, phụ đề, âm thanh và FFmpeg. Không dùng mô hình sinh video GPU tự host hay API sinh video đắt tiền.

**Trạng thái triển khai:** Đã hoàn thành Giai đoạn P1 (scaffold, schema, validator, sandbox, CI) và Giai đoạn P2 (First useful POC, engine decision chọn Chromium baseline, hoàn tất cả 3 video MP4 thực tế và đạt cổng nghiệm thu Gate G2 Sign-off). Không production deployment từ repository này.

## Luồng sản phẩm

Client chọn template có version hoặc tạo composition có version → kiểm tra schema/media → tạo preview/render job bất đồng bộ → worker cô lập render và encode → lưu artifact riêng tenant → callback có chữ ký hoặc polling. Mọi template/scene sửa được bằng revision mới; revision đã dùng để render là immutable. Manifest pin asset, font và runtime để tái lập kết quả.

HyperFrames là ứng viên ưu tiên, phải qua license/security review và benchmark; Chromium + FFmpeg là fallback. Custom code do AI/người dùng viết mặc định tắt cho đến khi đạt sandbox gate. Codex, AGY Gemini Flash/Argon, OpenCode, DeepSeek và provider khác là adapter tạo code tùy chọn; không có model hay gói premium bắt buộc.

## Tạo phẩm Video POC & Cổng Nghiệm thu G2 (Milestone P2)

Toàn bộ ba video mẫu thực tế (POC-01, POC-02, POC-03) cùng các phiên bản chỉnh sửa (revision 2) đã được kết xuất thành công bằng bộ kết xuất chuẩn tắc `chromium-frame-v1`, được giải mã và kiểm định độc lập, đáp ứng đầy đủ tiêu chí nghiệm thu [Cổng G2](docs/TESTING.md) và quyết định lựa chọn engine tại [ADR 0001](docs/ADR/0001-engine-selection.md).

| Video mẫu | Đặc tả kỹ thuật | Tập tin MP4 (Revision 1) | Mã băm SHA-256 (Rev 1) | Tập tin MP4 (Revision 2) | Mã băm SHA-256 (Rev 2) |
| --- | --- | --- | --- | --- | --- |
| **POC-01** (Promo) | 15s, 450f, 720×1280 @ 30fps | [poc01.mp4](evidence/P2-02/poc01.mp4) | `eceb6386a19bcce1854bf1e0ecbff7a7a8419c3f892518f3095c2a9ea740a88f` | [poc01-v2.mp4](evidence/P2-02/poc01-v2.mp4) | `72c7b399f43615be723bd7ba07b9a815d9ff4738ee3da62aa09a9ab67a539866` |
| **POC-02** (Explainer) | 30s, 900f, 1280×720 @ 30fps, âm thanh 48kHz | [poc02.mp4](evidence/P2-02/poc02.mp4) | `bfa524978e456965bea91fdcdebf9da116afe49d0b43d1c8e940e83b6a21773f` | [poc02-v2.mp4](evidence/P2-02/poc02-v2.mp4) | `ec1a026aacb8351c1ee70dc546526dce20eea7d9157302086d52523ea8ef47f1` |
| **POC-03** (Footage) | 45s, 1350f, 720×1280 @ 30fps, đa kênh CFR | [poc03.mp4](evidence/P2-05/poc03.mp4) | `e90c24a923c9585de201a7ce9f36742b60b302a11033283287ba9ac54a833a6a` | [poc03-v2.mp4](evidence/P2-05/poc03-v2.mp4) | `58a8a8fc605a2da59284307bd80d3c052b25a61d3e559d196fc51d8e660a08b5` |

Chi tiết báo cáo nghiệm thu, kiểm định thính giác/thị giác, đối chuẩn hiệu năng và quyết định cổng G2 được lưu tại [Báo cáo nghiệm thu P2-05](evidence/P2-05/report.md) và [Quality Report](evidence/P2-05/quality-report.json).

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
