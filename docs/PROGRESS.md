# Tiến độ triển khai — Creativanta Video Engine

Tài liệu theo dõi trạng thái triển khai, các mốc kiểm chứng và sự kiện vận hành trong repository. [AGENTS gốc](../AGENTS.md) và [AGY execution](AGENTS.md) quy định quy trình thực thi; [Plan](IMPLEMENTATION_PLAN.md) là backlog chuẩn; [Testing](TESTING.md) và [Security](SECURITY.md) là release gates.

## Sự kiện audit handoff ngày 2026-11-02

Vào ngày 2026-11-02 UTC, một phiên AGY trước đó đã gặp lỗi `permission-denied` trong quá trình thực thi nhưng tiến trình shell vẫn exit code 0. Do đó, thông báo hoàn thành trong nhật ký bàn giao (host handoff log) trước đây là **SAI THỰC TẾ (FALSE)**: không có bất kỳ dòng code hay artifact triển khai nào thực sự được tạo ra trên repository tại thời điểm đó (HEAD commit vẫn dừng ở `aaac0a6` chỉ chứa tài liệu thiết kế của `DOC-001`).

Để bảo đảm tính trung thực tuyệt đối:
- Mọi báo cáo tiến độ phải dựa trên evidence thực tế được commit và kiểm chứng độc lập.
- Không bao giờ đánh dấu `done` cho bất kỳ task nào chỉ dựa trên tự báo cáo của AGY worker.
- Các task hoàn tất ở local chỉ được ghi nhận ở trạng thái `review` và chờ independent review/CI phê duyệt.

## Trạng thái hàng đợi và nhiệm vụ khởi tạo (Bootstrap P0-01)

Theo quy định tại [AGY execution](AGENTS.md), hàng đợi SQLite WAL (`.agy/state.sqlite`) chỉ được thiết lập tại task P0-05. Do đó, **chưa có hàng đợi bền vững an toàn (no safe durable queue)** trong repo trước P0-05.

Trong giai đoạn bootstrap:
- Supervisor/worker chạy tuần tự theo exception ghi nhận trong [Execution log](EXECUTION_LOG.md) và báo cáo kiểm chứng [P0-01 report](../evidence/P0-01/report.md).
- Toàn bộ 52 task trong [Implementation plan](IMPLEMENTATION_PLAN.md) được ánh xạ thành snapshot máy đọc được tại [P0-01 backlog snapshot](../evidence/P0-01/backlog.json).
- Base commit nguồn được xác định chính xác: `aaac0a6ecd464bf3f4798e18c94a003fb6ef0487`.
- Trạng thái ban đầu:
  - Task sẵn sàng ban đầu (ready): duy nhất `P0-01` (phụ thuộc `DOC-001` đã đạt).
  - Task bị chặn bởi quan hệ phụ thuộc (blocked by dependencies): 51 task (`P0-02` đến `P9-05`).
  - Sau khi `P0-01` hoàn tất kiểm chứng và được review phê duyệt, các task kế tiếp sẵn sàng chạy song song: `P0-02`, `P0-03`, `P0-04`.

## Bảng tổng hợp tiến độ 52 nhiệm vụ

| Milestone | Task ID | Stream | Trạng thái | Dependencies | Ghi chú & deliverables |
| --- | --- | --- | --- | --- | --- |
| P0 | P0-01 | Supervisor | review | DOC-001 | Bootstrap backlog snapshot, validate docs & links, script [validate_repo.py](../scripts/validate_repo.py) |
| P0 | P0-02 | C+B | review | P0-01 | Audit HyperFrames, Chromium, FFmpeg, fonts, SBOM và licenses; [P0-02 report](../evidence/P0-02/report.md) |
| P0 | P0-03 | D | planned | P0-01 | Rights manifest cho assets/fonts/audio của 3 fixtures |
| P0 | P0-04 | A+C | planned | P0-01 | Contract/threat-model review: starter limits, entities, idempotency |
| P0 | P0-05 | Supervisor | planned | P0-04 | Khởi tạo SQLite WAL state ledger `.agy/state.sqlite`, worktree policy |
| P1 | P1-01 | C | planned | P0-02, P0-04, P0-05 | TS workspace, toolchain pin, Compose, local environment |
| P1 | P1-02 | A | planned | P0-04, P1-01 | JSON Schema 2020-12, OpenAPI 3.1, generated types |
| P1 | P1-03 | B | planned | P1-02 | Semantic validator, canonical compiler manifest |
| P1 | P1-04 | C | planned | P1-01, P0-02 | Trusted-template sandbox launcher, non-root, limits |
| P1 | P1-05 | A+C | planned | P1-02, P1-04 | CI jobs docs/contracts/lint/typecheck/unit |
| P2 | P2-01 | B | planned | P1-03, P1-04, P0-03 | HyperFrames spike & Chromium/FFmpeg baseline |
| P2 | P2-02 | B+D | planned | P2-01 | POC-01 (promo 15s) và POC-02 (explainer 30s) MP4 thật |
| P2 | P2-03 | B | planned | P2-01, P0-03 | POC-03 (captioned footage 45s) MP4 thật |
| P2 | P2-04 | B+C | planned | P2-02, P2-03 | Benchmark 2 candidates theo Testing, RTF/cost/memory |
| P2 | P2-05 | Reviewer | planned | P2-04, P1-05 | Human evaluation 3 MP4s, golden frames, G2 sign-off |
| P3 | P3-01 | A | planned | P1-02, P0-04 | DB migrations, tenant RLS, service roles |
| P3 | P3-02 | C+A | planned | P3-01, P1-04 | Signed upload pipeline, quarantine, probe, asset isolation |
| P3 | P3-03 | A+D | planned | P3-01, P1-03, P0-03 | Template catalog, variables, composition revisions |
| P3 | P3-04 | C | planned | P3-02 | Optional import connector behind flag, SSRF defenses |
| P3 | P3-05 | C+A | planned | P3-02, P3-03 | Storage retention, cascade deletion, sweeper |
| P4 | P4-01 | A | planned | P3-01, P3-03 | Admission transaction, idempotency, limits |
| P4 | P4-02 | B+A | planned | P4-01, P2-05, P3-02 | Postgres dispatcher, lease, heartbeat, fencing |
| P4 | P4-03 | C+B | planned | P4-02, P3-05 | Cancel, timeout, retry, reaper, atomic publication |
| P4 | P4-04 | A+C | planned | P4-01, P4-03 | Signed webhooks, HMAC replay protection, retry |
| P4 | P4-05 | A | planned | P4-01, P4-03 | Usage ledger, reserve, settle, release |
| P4 | P4-06 | B+D | planned | P4-02, P4-03 | Frame/clip previews, download grants, captions |
| P4 | P4-07 | Reviewer | planned | P4-04, P4-05, P4-06 | G3 two-tenant E2E verification suite |
| P5 | P5-01 | D+B | planned | P4-07 | Curated template pack 3 families, Vietnamese fonts |
| P5 | P5-02 | D+C | planned | P3-02, P0-02 | TTS interface & upload fallback, provider terms |
| P5 | P5-03 | D+A | planned | P4-07 | Creativanta contract client harness trong repo |
| P5 | P5-04 | A+D | planned | P5-03 | API integration guide và typed SDK example |
| P5 | P5-05 | D+C | planned | P5-01, P5-02 | Vietnamese typography/audio regression matrix |
| P6 | P6-01 | C | planned | P4-07 | Metrics, traces, redacted logs, alerts, dashboards |
| P6 | P6-02 | C+A | planned | P6-01, P3-05 | Backup, PITR, restore drill (RPO≤15m, RTO≤4h) |
| P6 | P6-03 | C+B | planned | P6-01, P2-04 | Soak test 24h ≥1000 jobs, capacity/cost envelope |
| P6 | P6-04 | Security reviewer | planned | P6-02, P6-03, P4-07 | Structured security suite, SBOM, IDOR/SSRF audit |
| P6 | P6-05 | Supervisor | planned | P6-04, P5-04, P5-05 | G4 go/no-go readiness report, staging smoke |
| P7 | P7-01 | C+Security reviewer | planned | P6-04 | Custom runtime ADR, disposable microVM isolation |
| P7 | P7-02 | A+D | planned | P7-01, P1-02 | Scene bundle registry, build digests, schema |
| P7 | P7-03 | D+C | planned | P7-02 | Provider-neutral authoring adapter contract |
| P7 | P7-04 | C+B | planned | P7-01, P7-02, P7-03 | Isolated bundle build & static security scanner |
| P7 | P7-05 | Security reviewer | planned | P7-04 | C1–C6 signed review, kill switch, allowlist |
| P7 | P7-06 | D+B | planned | P7-05, P5-01 | 3 custom scene variants, authoring/render cost |
| P8 | P8-01 | D+C | planned | P6-05, P0-02 | WebAV/Mediabunny legal/codec evaluation |
| P8 | P8-02 | B+D | planned | P8-01 | Browser export spike, fallback to server render |
| P8 | P8-03 | B | planned | P6-05 | Specialized engines spike (VideoFlow, Revideo, etc.) |
| P8 | P8-04 | Reviewer | planned | P8-02, P8-03 | Browser/specialized engine capability matrix |
| P9 | P9-01 | C+A | planned | P6-05 | Autoscaling implementation, cooldown, budget clamp |
| P9 | P9-02 | A | planned | P4-05, P6-05 | Quota plans, retention tiers, billing model |
| P9 | P9-03 | A+C | planned | P9-01 | DB/queue profiling, broker evaluation |
| P9 | P9-04 | D+Supervisor | planned | P5-04, P6-05 | External Creativanta handoff packet |
| P9 | P9-05 | Supervisor+Reviewer | planned | P9-01, P9-02, P9-03, P9-04 | GA decision packet: capacity, SLO, legal, rollback |

## Hướng dẫn kiểm tra định kỳ

Để kiểm tra tính toàn vẹn của cấu trúc repository, tài liệu và backlog, thực thi script chuẩn của dự án:

```bash
./scripts/validate_repo.py
```

Lệnh này không phụ thuộc package bên ngoài, tự động kiểm tra:
1. Đầy đủ các file tài liệu bắt buộc và artifacts bàn giao.
2. Cú pháp Markdown, số lượng tiêu đề H1 và tính toàn vẹn của mã khối JSON.
3. Tất cả liên kết tài liệu nội bộ resolve chính xác.
4. Đồ thị 52 task không có chu trình (acyclic DAG).
5. Tính nhất quán giữa [Implementation plan](IMPLEMENTATION_PLAN.md) và [Backlog snapshot](../evidence/P0-01/backlog.json).
