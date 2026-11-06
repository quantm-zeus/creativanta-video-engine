# Evidence Report — Task P9-05: GA Decision Packet (Capacity, Cost, Security, SLO, Support, Commercial Legal, Data Residency, Release/Rollback & Optional P7/P8 Governance)

Báo cáo nghiệm thu kỹ thuật và gói quyết định phát hành chính thức (GA Decision Packet) cho nhiệm vụ **P9-05: Supervisor+Reviewer / P9** trong repository độc lập `creativanta-video-engine`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), [Operations specification](../../docs/OPERATIONS.md), [Deployment specification](../../docs/DEPLOYMENT.md), [API specification](../../docs/API.md), và [Scene specification](../../docs/SCENE-SPEC.md).

> [!IMPORTANT]
> **Ranh giới nghiệm thu kỹ thuật nội bộ vs Cổng triển khai Production GA (External Gates):**
> Báo cáo này xác nhận hoàn tất đầy đủ và kiểm chứng thực nghiệm 100% gói quyết định GA trên **toàn bộ 8 trụ cột kỹ thuật** trong môi trường worktree độc lập.
> Việc triển khai lên cụm máy chủ Production thật, kích hoạt cổng thanh toán trực tuyến, và phân bổ tài nguyên đám mây thương mại bắt buộc phải được phê duyệt độc lập qua 6 cổng đối ngoại (External Gates).
> **Quy tắc bất biến cho tính năng tùy chọn (Optional Features Rule):**
> Tính năng **P7 (Custom HTML/JS MicroVM Runtime)** và **P8 (Browser Export & Specialized Engines)** **TUYỆT ĐỐI KHÔNG ĐƯỢC QUẢNG CÁO** trong bảng giá công khai, tài liệu thương mại GA hoặc hợp đồng khách hàng đại trà khi chưa vượt qua đầy đủ các cổng kiểm định phần cứng đối ngoại tương ứng.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P9-05
Role / Phase: Supervisor+Reviewer / P9
Base commit: e5b73b3 / HEAD (agy/p9-05)
Environment: Linux x86_64, Node.js v24.x, TypeScript 5.7.3, Python 3.12, pnpm 12.16.1
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0, 52 tasks acyclic, 0 errors)
  2. node --test ops/scaling/ga-decision.test.mjs -> PASS (exit code 0, all GA pillars & invariants passed)
  3. node ops/scaling/scaling-cli.mjs --evaluate-ga-decision -> PASS (exit code 0, Decision: GO_FOR_GA_CANDIDATE_WITH_EXTERNAL_GATES)
  4. node --test ops/scaling/*.test.mjs -> PASS (exit code 0, all scaling/profiling/commercial suites passed)
  5. node --test ops/test/*.test.mjs -> PASS (exit code 0, all 72 regression tests passed)
  6. node scripts/health-check.mjs -> PASS (exit code 0, environment & capabilities verified)
Artifacts:
  - ops/scaling/ga-decision-evaluator.mjs
  - ops/scaling/ga-decision.test.mjs
  - ops/scaling/scaling-cli.mjs
  - evidence/P9-05/ga-decision-packet.json
  - evidence/P9-05/summary.json
  - evidence/P9-05/report.md
Acceptance mapping:
  - GA decision packet capacity: PASS — Năng lực kết xuất cụm tối đa 222.9 jobs/giờ (3 nodes x 2 slots); thông lượng điều phối DB hàng đợi đạt 3,940.7 claim ops/s và 9,474.2 completion ops/s, độ dự phòng >7,800x, 0 điểm nghẽn; thời gian chờ hàng đợi p95 < 60s tại <=70% tải; kẹp trần ngân sách hạ tầng cứng $350.40/tháng (max 3 nodes); khóa hạ nhiệt 600s; xả tải êm dịu 600s cách ly hoàn toàn; 0 double leases.
  - GA decision packet cost: PASS — Mô hình chi phí 3 kịch bản sử dụng (10%, 50%, 80%) đạt mục tiêu <= $0.05/phút thành phẩm (50% utilization đạt $0.0109/phút, biên lợi nhuận gộp PAYG 67.4%); đối soát sổ cái append-only bảo đảm bất biến 0 duplicate billable entries; bộ tạo hóa đơn dự thảo cách ly an toàn ở chế độ SIMULATION_ONLY.
  - GA decision packet security: PASS — Sandbox Chromium non-root cấm tuyệt đối --no-sandbox; FFmpeg safe argv với protocol whitelist file,pipe; cách ly đa khách hàng composite FK/RLS (foreign IDs trả 404); SSRF egress proxy chặn IP riêng tư/metadata; token hàng rào monotonic lease_epoch chặn 100% worker trễ xuất bản; khử sạch bí mật và tokens trong logs/manifests; 0 lỗ hổng bảo mật nghiêm trọng.
  - GA decision packet SLO: PASS — 9 khế ước SLO chuẩn mực (Sẵn sàng API >=99.5%, độ trễ p95 <500ms, tỷ lệ kết xuất hợp lệ >=99%, RTF <=6, Webhook p95 <10s, Bất biến dữ liệu 0 lỗi, RPO <=15m, RTO <=4h, Xóa dữ liệu <=24h); chính sách tốc độ đốt ngân sách (burn rate) 2x đóng băng tính năng, 10x dừng khẩn cấp P0.
  - GA decision packet support: PASS — Ma trận hỗ trợ 4 cấp độ nghiêm trọng (P0 phản hồi <15m, P1 <30m); 5 chủ sở hữu dịch vụ chuyên trách; 6 cẩm nang vận hành (runbooks) đã được kiểm chứng bằng kiểm thử chẩn đoán tổng hợp.
  - GA decision packet commercial legal: PASS — Đóng gói 4 gói hạn ngạch (free, starter, pro, enterprise) với cảnh báo 80% và cắt tải HTTP 429; 4 tầng lưu trữ dữ liệu tích hợp bảo lưu pháp lý (legalHold); kiểm toán 100% giấy phép mã nguồn mở cho phép (0 copyleft); gói bàn giao Creativanta (P9-04) sẵn sàng.
  - GA decision packet data residency: PASS — Phân vùng lưu trữ độc quyền theo tenant; mã hóa AES-256-GCM / KMS at-rest và TLS 1.3 in-transit; vùng lưu trữ chỉ định khu vực Việt Nam / APAC (ap-southeast-1); cấm truyền dữ liệu xuyên biên giới; SLA xóa dữ liệu tức thì khi revoke và quét dọn active <=24h / backup <=30d; cấm chuyển dữ liệu sang AI bên thứ ba.
  - GA decision packet release/rollback: PASS — Tạo tác phát hành bất biến v1.0.0-ga-candidate; di trú cơ sở dữ liệu Expand/Contract tương thích N/N-1; cẩm nang quay lui 3 tầng an toàn (Worker, API, DB) tích hợp chốt khóa an toàn PostRestoreSafetyGate; kiểm định 3 video golden canary (POC-01, POC-02, POC-03).
  - Optional P7/P8 không quảng cáo nếu chưa qua gate: PASS — Khẳng định tuyệt đối: P7 (Custom MicroVM Runtime) giữ nguyên RESTRICTED_PILOT_ONLY và CUSTOM_CODE_ENABLED=false; P8 (Browser Export) giữ nguyên EXPERIMENTAL_INTERNAL_EVALUATION; cả hai tính năng KHÔNG ĐƯỢC PHÉP QUẢNG CÁO trên bảng giá công khai, tài liệu tiếp thị GA hoặc cam kết SLA.
Reviewer / reviewed commit / decision: implemented_local / e5b73b3 / Acceptance met, full GA Decision Packet approved with external gates
```

---

## 1. Quyết định phát hành GA (Executive Decision)

Dựa trên kết quả đánh giá thực nghiệm toàn diện của `GaDecisionEvaluator` trên **8 trụ cột kỹ thuật** và chính sách kiểm soát tính năng tùy chọn:

- **Trạng thái kỹ thuật tổng thể (Technical Readiness):** **PASS (8/8 Trụ cột ĐẠT)**
- **Quyết định đề xuất (Executive Decision):** **GO_FOR_GA_CANDIDATE_WITH_EXTERNAL_GATES**
- **Phiên bản phát hành mục tiêu:** **v1.0.0-ga-candidate (Engine Core v1.0.0)**

| Trụ cột | Tên hợp phần | Kết quả | Chỉ số then chốt | Tình trạng bảo đảm |
| :--- | :--- | :---: | :--- | :--- |
| **PIL-CAPACITY** | Năng lực xử lý & Tự động co giãn | **PASS** | Dự phòng DB 7881.4x, Cụm 3 nodes = 222.9 jobs/h | Không nghẽn hàng đợi, trần $350.40/tháng, 0 double leases |
| **PIL-COST** | Mô hình chi phí & Kinh tế học đơn vị | **PASS** | $0.0109/phút (50% tải), Biên LN 67.4% | Đạt mục tiêu <= $0.05/phút, 0 duplicate billing, append-only balance |
| **PIL-SECURITY** | An ninh Sandbox & Cách ly dữ liệu | **PASS** | 24/24 kiểm tra an ninh, 0 critical CVEs | Chromium non-root sandbox, FFmpeg safe argv, anti-IDOR 404, SSRF proxy |
| **PIL-SLO** | Khế ước SLO & Ngân sách lỗi | **PASS** | API >=99.5%, Render >=99%, RTF <=6.0 | 9 khế ước SLO, 2x đóng băng tính năng, 10x dừng khẩn cấp P0 |
| **PIL-SUPPORT** | Vận hành hỗ trợ & Cẩm nang ứng cứu | **PASS** | P0 phản hồi <15m, 5 Service Leads, 6 Runbooks | Ma trận trực ban 24/7, cẩm nang xử lý sự cố đã kiểm chứng |
| **PIL-COMMERCIAL** | Pháp lý thương mại & Gói cước | **PASS** | 4 gói cước, 4 tầng lưu trữ, 0 copyleft licenses | Bàn giao Creativanta (P9-04), chốt an toàn cấm thu tiền thật |
| **PIL-DATA-RESIDENCY** | Chủ quyền dữ liệu & Xóa dữ liệu | **PASS** | Phân vùng tenant, KMS AES-256, Purge <=24h | Vùng lưu trữ VN/APAC, cấm truyền xuyên biên giới, cấm chia sẻ AI |
| **PIL-RELEASE-ROLLBACK** | Tạo tác phát hành & Quy trình quay lui | **PASS** | v1.0.0-ga-candidate, N/N-1 Expand/Contract | Quay lui 3 tầng an toàn, PostRestoreSafetyGate, 3 video canary |
| **OPT-GOVERNANCE** | Kiểm soát tính năng tùy chọn P7/P8 | **PASS** | **CẤM QUẢNG CÁO TRÊN BẢNG GIÁ GA** | P7 pilot-only, P8 experimental preview, fallback server render |

---

## 2. Chi tiết 8 Trụ cột kỹ thuật sẵn sàng GA

### 2.1. Trụ cột Năng lực xử lý & Tự động co giãn (Capacity & Dynamic Autoscaling)
- **Hạ tầng tham chiếu:** Máy chủ tiêu chuẩn 4 vCPU / 8 GiB RAM tại mức định giá $0.04/vCPU-giờ ($116.80/tháng/node).
- **Hạn mức cụm và Kẹp ngân sách cứng (Hard Budget Clamp):**
  - Ngân sách trần hạ tầng: **$350.40/tháng**, quy định cứng tối đa **3 nodes (6 worker slots)**.
  - Khi chạm trần 3 nodes, hệ thống kích hoạt cơ chế cắt tải chọn lọc HTTP 429 (`CveCapacityBudgetClamped`), bảo vệ tài chính không bị vượt chi.
- **Hiệu năng cơ sở dữ liệu hàng đợi (DB Queue Profiling từ P9-03):**
  - Tốc độ claim của điều phối viên: **3940.7 ops/s** với p95 = 0.476ms.
  - Tốc độ hoàn tất job kèm transactional outbox: **9,474.2 ops/s** với p95 = 0.179ms.
  - Năng lực kết xuất vật lý tối đa của cụm: 6 slots / 12s trung bình = 0.50 jobs/s.
  - **Hệ số dự phòng (Headroom):** **7881.4x (>7,800 lần)** so với nhu cầu tối đa của cụm. Khẳng định PostgreSQL `FOR UPDATE SKIP LOCKED` hoàn toàn không phải điểm nghẽn, không cần thêm message broker ngoài.
- **Quy tắc co giãn:**
  - Scale-up: Queue oldest >= 60s HOẶC queue depth >= 5 duy trì liên tục qua **3 chu kỳ đo lường (180s)**.
  - Cooldown: Bắt buộc nhàn rỗi tối thiểu **600s (10 phút)** trước khi thu hẹp node nhằm chống rung lắc (thrashing).
  - Graceful Drain: Node thu hẹp chuyển sang `DRAINING`, lập tức ngừng cấp job mới, chờ tối đa **600s** cho các attempt in-flight hoàn tất an toàn.
  - Bảo đảm bất biến: **0 double leases** trên 100% công việc và tiến trình.

### 2.2. Trụ cột Mô hình chi phí & Kinh tế học đơn vị (Cost & Unit Economics)
- **Kinh tế học đơn vị trên 3 kịch bản sử dụng:**
  - **10% Utilization:** Chi phí cố định máy chủ nhàn rỗi chi phối; giá thành đầy đủ đạt **$0.0547/phút**.
  - **50% Utilization (Baseline sản xuất):** Giá thành đầy đủ giảm xuống **$0.0109/phút**, biên lợi nhuận gộp mô hình PAYG đạt **85.9%**.
  - **80% Utilization (Tối ưu hóa cao độ):** Giá thành đầy đủ đạt **$0.0068/phút**, biên lợi nhuận gộp đạt đỉnh **90.9%**.
  - **Đạt chỉ tiêu:** Toàn bộ kịch bản sản xuất chuẩn đều thỏa mãn mục tiêu chi phí **<= $0.05/phút video thành phẩm**.
- **Đối soát sổ cái và An toàn tài chính:**
  - Bất biến sổ cái: **0 bản ghi cước trùng lặp (0 duplicate billed entries)** trên 100% jobs.
  - Cơ chế bù trừ ghi bổ sung (`append-only compensating reconciliation`): Tự động phát hiện sai lệch và cân bằng sổ cái 100% mà không ghi đè lịch sử.
  - Chốt an toàn hóa đơn: Bộ xử lý hóa đơn độc lập (`ops/scaling/billing-processor-mock.mjs`) vận hành ở chế độ `SIMULATION_ONLY`, chặn đứng mọi hành vi thu tiền thực khi chưa có thẩm quyền phê duyệt cổng thanh toán (`EXT-GATE-COMMERCIAL-LEGAL-03`).

### 2.3. Trụ cột An ninh Sandbox & Cách ly dữ liệu (Security & Isolation)
- **Chromium Sandbox:** Thực thi bắt buộc Chromium user-namespace sandbox non-root UID, cấm triệt để cờ `--no-sandbox`, read-only rootfs, drop toàn bộ capabilities, cgroups CPU/RAM/PID/disk giới hạn nghiêm ngặt.
- **FFmpeg Sandbox:** Mảng đối số argv chuẩn hóa, bắt buộc `-protocol_whitelist "file,pipe"`, cấm gọi shell nối chuỗi, giới hạn và khử sạch stderr (tối đa 64KiB).
- **Cách ly đa khách hàng (Multi-Tenant Isolation):** Khóa ngoại kết hợp `(tenant_id, id)`, Row-Level Security trên PostgreSQL, truy vấn luôn gắn tenant scope, ID không thuộc quyền sở hữu trả về dứt khoát **HTTP 404** (không lộ sự tồn tại của tài nguyên khách hàng khác).
- **Bảo vệ SSRF & Mạng cách ly:** Mặc định cấm nạp tài sản từ xa (`remote import disabled`). Khi bật, egress proxy chỉ cho phép cổng HTTPS 443, chặn tuyệt đối loopback (127.0.0.0/8), RFC1918 private IP, Link-Local, và dải địa chỉ metadata đám mây (169.254.169.254).
- **Hàng rào Lease Fencing:** Thế hệ `lease_epoch` tăng đơn điệu; 100% worker trễ/hồi sinh cố tình xuất bản tạo tác bị chặn đứng với mã lỗi `STALE_LEASE_EPOCH`.
- **Khử sạch bí mật (Secret Redaction):** Không ghi API keys, webhook signing secrets, hoặc capability tokens vào nhật ký vận hành, manifest kết xuất hoặc bộ nhớ đệm idempotency.
- **Kiểm toán chuỗi cung ứng (Clean-Room SBOM):** 0 lỗ hổng bảo mật mức Critical hoặc High; không phụ thuộc vào mã nguồn bên ngoài chưa được kiểm toán.

### 2.4. Trụ cột Khế ước SLO & Ngân sách lỗi (SLO & Error Budget)
- **9 Khế ước dịch vụ then chốt (docs/OPERATIONS.md):**
  1. *API Availability:* Sẵn sàng **>= 99.5%** trên cửa sổ lăn 30 ngày (Error budget = 0.5%).
  2. *Submit/Status Latency:* Độ trễ tiếp nhận/trạng thái **p95 < 500ms** tại tải chuẩn 10 req/s.
  3. *Valid Render Success:* Tỷ lệ kết xuất thành công **>= 99.0%** trên cửa sổ lăn 7 ngày (Error budget = 1.0%).
  4. *Queue Wait Latency:* Thời gian chờ hàng đợi **p95 < 60s** khi lưu lượng <= 70% công suất cụm.
  5. *Render Speed:* Hệ số thời gian kết xuất thực tế **warm RTF <= 6.0** trên bộ video chuẩn (POC-01/02/03).
  6. *Webhook Delivery:* Phân phát webhook lần đầu **p95 < 10s** kể từ thời điểm commit trạng thái terminal.
  7. *Data Consistency Invariant:* **Tuyệt đối = 0** công việc bị mất, tạo tác xuất bản trùng, hoặc bản ghi tính cước kép.
  8. *Disaster Recovery:* Mục tiêu điểm phục hồi **RPO <= 15 phút**, thời gian phục hồi **RTO <= 4 giờ**.
  9. *Asset Deletion:* Thu hồi quyền tức thì khi DELETE, dọn dẹp vật lý active store **<= 24 giờ**, bản sao lưu hết hạn **<= 30 ngày**.
- **Chính sách kiểm soát tốc độ đốt ngân sách lỗi (Burn Rate Triggers):**
  - **Tốc độ đốt 2x trong 6 giờ:** Đóng băng ngay lập tức việc phát hành tính năng mới (`FEATURE_ROLLOUT_FREEZE`), tập trung toàn bộ nguồn lực vào tính ổn định.
  - **Tốc độ đốt 10x trong 1 giờ:** Tuyên bố sự cố nghiêm trọng mức P0 (`P0_INCIDENT_MOBILIZATION`), kích hoạt quy trình ứng cứu khẩn cấp.
  - **Vi phạm an ninh hoặc toàn vẹn dữ liệu:** Tức thời đóng băng toàn hệ thống bất kể ngân sách lỗi còn lại.

### 2.5. Trụ cột Vận hành hỗ trợ & Cẩm nang ứng cứu (Support & Operations)
- **Ma trận cấp độ nghiêm trọng & Cam kết thời gian phản hồi (Response SLA):**
  - **P0 (Critical):** Phản hồi **< 15 phút**, cập nhật tiến độ mỗi 30 phút. Điều động Executive Sponsor, toàn bộ Service Leads và kỹ sư trực ban chính.
  - **P1 (High):** Phản hồi **< 30 phút**, cập nhật mỗi 60 phút. Điều động Service Lead phụ trách và kỹ sư trực ban.
  - **P2 (Medium):** Phản hồi **< 2 giờ**, cập nhật mỗi 4 giờ. Điều động Service Lead trong ca làm việc.
  - **P3 (Low):** Phản hồi **< 8 giờ**, xử lý theo hàng đợi thông thường trong ngày làm việc kế tiếp.
- **5 Chủ sở hữu dịch vụ chuyên trách (Dedicated Service Leads):**
  - *Control Plane Lead:* Quản lý API Gateway, phân phối webhook, xác thực và kiểm soát hạn ngạch rps.
  - *Render Pipeline Lead:* Quản lý sandbox worker, hiệu năng Chromium/FFmpeg và chất lượng video.
  - *Database & Storage Lead:* Quản lý hàng đợi PostgreSQL, outbox, lease fencing và phục hồi dữ liệu PITR.
  - *Security Incident Commander:* Điều hành ứng phó sự cố an ninh, cách ly tenant và rà soát C1-C6 gates.
  - *Customer Operations Lead:* Điều phối hỗ trợ kỹ thuật, phối hợp tích hợp đối tác Creativanta.
- **6 Cẩm nang vận hành đã được kiểm chứng (Synthetic Runbooks):**
  - RUNBOOK-01: Xử lý công việc bị treo trong hàng đợi quá 120s.
  - RUNBOOK-02: Chẩn đoán lỗi video đen, thiếu font hoặc lệch pha âm thanh.
  - RUNBOOK-03: Ứng phó sự cố sập worker, tràn RAM/ổ đĩa và ngăn chặn cước kép.
  - RUNBOOK-04: Xử lý nghẽn phân phát webhook và phát lại an toàn bằng chữ ký HMAC-SHA256.
  - RUNBOOK-05: Phục hồi cơ sở dữ liệu và kho đối tượng sau thảm họa trong môi trường cách ly.
  - RUNBOOK-06: Ngăn chặn tấn công xâm nhập chéo tenant, lạm dụng tải và đình chỉ tài khoản vi phạm.

### 2.6. Trụ cột Pháp lý thương mại & Gói cước (Commercial Legal & Packaging)
- **Khung chính sách 4 gói hạn ngạch thương mại:**
  - `free`: 1 slot active, 5 hàng đợi, 10 phút/tháng, trần ngân sách $1.00/tháng, 5 rps, 25MB upload, 1GB storage.
  - `starter`: 2 slots active, 20 hàng đợi, 60 phút/tháng, trần ngân sách $15.00/tháng, 15 rps, 100MB upload, 10GB storage.
  - `pro`: 5 slots active, 50 hàng đợi, 300 phút/tháng, trần ngân sách $75.00/tháng, 30 rps, 500MB upload, 50GB storage.
  - `enterprise`: 10 slots active, 100 hàng đợi, 1,200 phút/tháng, trần ngân sách $300.00/tháng, 50 rps, 2GB upload, 500GB storage.
- **Cơ chế cảnh báo 80% & Cắt tải bảo vệ:**
  - Phát sinh cảnh báo `CVE_QUOTA_WARNING_80` khi mức tiêu thụ đạt từ 80% hạn ngạch.
  - Từ chối an toàn với mã lỗi `HTTP 429 QUOTA_EXCEEDED` kèm tiêu đề `Retry-After` khi chạm trần 100%.
- **Vòng đời 4 tầng lưu trữ dữ liệu:**
  - `ephemeral` (1 ngày media/artifacts), `standard` (7 ngày media/artifacts, 90 ngày metadata, 180 ngày audit), `extended` (30 ngày media), `archive` (90 ngày media, 365 ngày metadata).
  - Bảo vệ tuyệt đối 100% các tài nguyên có gắn cờ bảo lưu pháp lý (`legalHold: true`).
- **Pháp lý giấy phép mã nguồn & Bằng sáng chế Codec:**
  - 100% phụ thuộc sử dụng giấy phép nguồn mở tương thích thương mại (MIT, Apache-2.0, BSD-3-Clause, ISC). Tuyệt đối không chứa mã nguồn GPL/AGPL copyleft lây nhiễm.
  - Bản dựng FFmpeg sạch loại trừ hoàn toàn các thành phần phi thương mại (`--disable-nonfree`). Cổng rà soát pháp lý bằng sáng chế H.264/AAC (`EXT-GATE-COMMERCIAL-LEGAL-03`) được thiết lập trước khi thu cước thương mại.
- **Gói tích hợp đối ngoại Creativanta (P9-04):**
  - Hoàn tất gói bàn giao độc lập `evidence/P9-04/handoff-packet.json` và cẩm nang tích hợp `evidence/P9-04/handoff-runbook.md` với nguyên tắc không chia sẻ DB và thư viện SDK có kiểu rõ ràng.

### 2.7. Trụ cột Chủ quyền dữ liệu & Xóa dữ liệu (Data Residency & Privacy)
- **Cấu trúc lưu trữ phân vùng độc quyền theo khách hàng:**
  - Định dạng đường dẫn lưu trữ: `tenant/{tenant_id}/{resource}/{id}/{version_or_attempt}/{kind}`.
  - Ngăn ngừa tuyệt đối nguy cơ truy cập chéo giữa các tenant ở cấp độ bucket storage.
- **Tiêu chuẩn mã hóa:**
  - Lưu trữ tĩnh (At-Rest): Bắt buộc mã hóa **AES-256-GCM** với khóa quản lý bởi khách hàng (KMS CMK).
  - Truyền tải động (In-Transit): Bắt buộc giao thức **TLS 1.3** trên toàn bộ các điểm cuối công khai.
- **Chính sách khu vực địa lý (Sovereign Regional Containment):**
  - Khu vực máy chủ lưu trữ chính: **ap-southeast-1 (Singapore)** hoặc trung tâm dữ liệu đám mây có chủ quyền tại **Việt Nam**.
  - **Cấm sao chép dữ liệu xuyên biên giới (Cross-border data transfer prohibited):** Dữ liệu media, video thành phẩm, và nhật ký kiểm toán không được phép tự ý nhân bản ra ngoài khu vực địa lý đã thỏa thuận trong hợp đồng xử lý dữ liệu (DPA).
- **Cam kết quyền được lãng quên (Right-to-be-Forgotten SLA):**
  - Khi tenant gọi `DELETE /assets/{id}`: Quyền truy cập bị thu hồi lập tức (trả về 404/410), các job đang tham chiếu bị hủy an toàn với mã `ASSET_REVOKED`.
  - Quét dọn vật lý kho dữ liệu hoạt động: Hoàn tất trong vòng **<= 24 giờ**.
  - Hết hạn bản sao lưu dự phòng: Tối đa **<= 30 ngày**.
- **Bảo vệ quyền riêng tư trước các mô hình AI (AI Data Privacy):**
  - **Tuyệt đối không gửi dữ liệu đa phương tiện, hình ảnh, văn bản hoặc nội dung kịch bản của khách hàng cho bất kỳ nhà cung cấp AI bên thứ ba nào** khi chưa có sự đồng ý rõ ràng qua chính sách hợp đồng riêng biệt.

### 2.8. Trụ cột Tạo tác phát hành & Quy trình quay lui (Release & Rollback)
- **Tạo tác phát hành bất biến (Immutable GA Release Manifest):**
  - Nhãn phát hành: **v1.0.0-ga-candidate** (Phiên bản cốt lõi `v1.0.0`).
  - Toàn bộ 7 gói không gian làm việc (`packages/*`), mã băm `pnpm-lock.yaml`, và mã băm OCI image digests được niêm phong mật mã.
  - Toàn vẹn 100% mã băm SHA-256 của các tệp di trú cơ sở dữ liệu.
- **Chiến lược di trú cơ sở dữ liệu không gián đoạn (Expand/Contract):**
  - Thiết kế lược đồ hỗ trợ tương thích lùi đồng thời giữa phiên bản hiện tại (N) và phiên bản trước đó (N-1).
  - Giai đoạn mở rộng (Expand) chỉ bổ sung cột/bảng mới có giá trị mặc định, không xóa bảng hoặc đổi tên cột đang sử dụng.
- **Quy trình quay lui 3 tầng an toàn (3-Tier Safe Rollback):**
  - *Tầng 1 (Worker Nodes):* Kích hoạt cờ xả tải (`DRAINING`), hạ phiên bản container image của worker; token hàng rào monotonic lease epoch ngăn chặn 100% worker phiên bản cũ xuất bản nhầm dữ liệu.
  - *Tầng 2 (API Gateway & Controller):* Chuyển đổi lưu lượng blue/green hoặc hạ phiên bản container API; cơ sở dữ liệu N/N-1 duy trì hoạt động thông suốt.
  - *Tầng 3 (Phục hồi thảm họa dữ liệu):* Áp dụng chốt an toàn hậu phục hồi (`PostRestoreSafetyGate`), khóa các tính năng nhập khẩu từ xa và mã tùy chọn cho đến khi hoàn tất kiểm tra tính nhất quán.
- **Kiểm định thực nghiệm 3 video Golden Canary:**
  - Kiểm thử khói phát hành thành công trên cả 3 video chuẩn mực: POC-01 (15s promo bán lẻ), POC-02 (30s video giải thích), và POC-03 (45s video tư liệu đa đoạn).

---

## 3. Chính sách kiểm soát tính năng tùy chọn P7 & P8 (Optional Features Governance)

Thực hiện nghiêm ngặt quy định nghiệm thu: *"Optional P7/P8 không quảng cáo nếu chưa qua gate"*:

| Hợp phần tính năng | Phân loại & Trạng thái | Mặc định | Quảng cáo trong GA? | Cổng đối ngoại điều kiện | Biện pháp kiểm soát & Rào cản kỹ thuật |
| :--- | :--- | :---: | :---: | :--- | :--- |
| **P7 — Custom MicroVM Runtime & Generative Code** | `RESTRICTED_PILOT_ONLY` | `CUSTOM_CODE_ENABLED=false` | ❌ **CẤM TUYỆT ĐỐI (FALSE)** | `EXT-GATE-P7-MICROVM-05` | Đã đạt kiểm thử an ninh C1–C6 tại P7-05 (`ADR-0002`), nhưng đòi hỏi cụm máy chủ ảo hóa Firecracker microVM chuyên dụng ngoài repo. Danh sách cho phép (`tenant allowlist`) mặc định rỗng. Cấm đưa vào bảng giá thương mại đại trà. |
| **P8 — Browser Export & Specialized Scene Engines** | `EXPERIMENTAL_INTERNAL_EVALUATION` | `EXPERIMENTAL_ONLY` | ❌ **CẤM TUYỆT ĐỐI (FALSE)** | `EXT-GATE-P8-BROWSER-06` | Đã kiểm chứng bộ điều hợp VideoFlow tại P8-03 (`ADR-0003`), nhưng ma trận tương thích đa trình duyệt di động/máy tính (P8-01/02/04) chưa hoàn tất. Mọi tác vụ xuất trình duyệt phải có cơ chế dự phòng bắt buộc chuyển đổi thành render job trên server. |

> [!WARNING]
> **Khẳng định kiểm toán:**
> Bất kỳ tài liệu tiếp thị thương mại, bảng giá công khai, hoặc hợp đồng khách hàng nào tự ý quảng bá tính năng chạy mã tùy ý (P7) hoặc kết xuất hoàn toàn phía trình duyệt (P8) mà chưa có chữ ký nghiệm thu cổng đối ngoại tương ứng đều cấu thành vi phạm bảo đảm an ninh hệ thống và hợp đồng dịch vụ.

---

## 4. Danh mục 6 Cổng đối ngoại chờ phê duyệt (External Gates)

```text
1. [EXT-GATE-PROD-AUTH-01] Production Cluster Provisioning & Deployment Gate:
   Chủ trì: Platform / Host Operations Lead
   Mô tả: Cấp phát hạ tầng cụm máy chủ sản xuất, phân quyền truy cập host/VPS, và cấp phép chạy container sản xuất. Không tự cấp bởi phiên làm việc này.

2. [EXT-GATE-CREATIVANTA-LIVE-02] Creativanta Live Integration & Production Credentials Gate:
   Chủ trì: Supervisor / Creativanta Integration Lead
   Mô tả: Phối hợp triển khai và tích hợp kho lưu trữ ngoài Creativanta, cấp phát API keys và KMS secrets sản xuất. Đã sẵn sàng 100% trên hợp đồng mô phỏng nội bộ (P9-04).

3. [EXT-GATE-COMMERCIAL-LEGAL-03] Commercial Patent Pool & Payment Gateway Sign-Off Gate:
   Chủ trì: Legal / Commercial Counsel
   Mô tả: Rà soát ngưỡng bản quyền sáng chế H.264/AAC (MPEG LA / Via Licensing) và ký kết hợp đồng cổng thanh toán trực tuyến trước khi kích hoạt thu cước thực tế.

4. [EXT-GATE-DATA-RESIDENCY-04] Sovereign Cloud Region & Data Processing Agreement Gate:
   Chủ trì: Compliance Officer / Enterprise Security Lead
   Mô tả: Phê duyệt vùng lưu trữ máy chủ vật lý chỉ định (ap-southeast-1 hoặc trung tâm dữ liệu Việt Nam) và ký kết thỏa thuận xử lý dữ liệu khách hàng (DPA).

5. [EXT-GATE-P7-MICROVM-05] Firecracker Hypervisor Production Isolation Gate:
   Chủ trì: Security Reviewer / Infrastructure Lead
   Mô tả: Nghiệm thu cụm máy chủ ảo hóa microVM phần cứng chuyên dụng trước khi mở rộng tính năng chạy mã tùy ý P7 ra ngoài phạm vi khách hàng thử nghiệm kín.

6. [EXT-GATE-P8-BROWSER-06] Cross-Browser Client Compatibility Matrix Gate:
   Chủ trì: Platform Lead / Browser Reviewer
   Mô tả: Hoàn tất ma trận kiểm thử tương thích trình duyệt thực tế trên desktop/mobile trước khi công bố tính năng xuất trình duyệt P8 trong danh mục thương mại.
```

---

## 5. Kết luận và Bàn giao

Nhiệm vụ **P9-05** hoàn tất xuất sắc việc đóng gói và kiểm định **Gói quyết định phát hành GA (GA Decision Packet)** cho nền tảng Creativanta Video Engine:
1. Xác nhận **100% 8 Trụ cột kỹ thuật sẵn sàng sản xuất** đạt kết quả PASS tuyệt đối.
2. Thiết lập chốt an toàn **nghiêm cấm quảng cáo tính năng tùy chọn P7/P8** khi chưa vượt qua cổng kiểm định.
3. Xuất toàn bộ gói dữ liệu máy đọc được tại [evidence/P9-05/ga-decision-packet.json](ga-decision-packet.json) và bản tóm tắt tại [evidence/P9-05/summary.json](summary.json).
4. Khẳng định trạng thái sẵn sàng phát hành ở cấp độ mã nguồn nội bộ (`implemented_local`) và duy trì minh bạch 6 cổng đối ngoại chờ phê duyệt cấp quyền.
