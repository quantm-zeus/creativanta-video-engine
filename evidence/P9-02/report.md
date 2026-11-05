# Evidence Report — Task P9-02: Usage Export, Quota Plans, Retention Tiers, Pricing Simulation & Reconciliation

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ **P9-02: A / P9** (Usage export/quota plans/retention tiers, pricing simulation và reconciliation; billing processor riêng chỉ khi scope được cấp, không charging thật ở task này) trong repository độc lập `creativanta-video-engine`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [API specification](../../docs/API.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), và [Operations specification](../../docs/OPERATIONS.md).

> [!IMPORTANT]
> **Production deploy và Real Charging KHÔNG được cấp trong task này.**
> Báo cáo này xác nhận việc hiện thực hóa toàn diện:
> 1. Bộ xuất dữ liệu sử dụng đa định dạng (JSON, CSV, JSONL) phân định rạch ròi chỉ số vận hành (`operational`) và chỉ số tính cước (`billable`).
> 2. Khung chính sách hạn ngạch đa tầng (`free`, `starter`, `pro`, `enterprise`) với cơ chế cảnh báo 80% (`CVE_QUOTA_WARNING_80`) và cắt tải bảo vệ HTTP 429 (`QUOTA_EXCEEDED`).
> 3. Các tầng vòng đời lưu trữ (`ephemeral`, `standard`, `extended`, `archive`) tích hợp quét dọn rác tự động và bảo vệ lệnh giữ pháp lý (`legalHold`).
> 4. Mô hình mô phỏng giá bán thương mại và kinh tế học đơn vị trên 3 kịch bản sử dụng tải (10%, 50%, 80%) theo chuẩn `docs/OPERATIONS.md` và `docs/TESTING.md`.
> 5. Động cơ đối soát tự động bảo đảm bất biến **0 bản ghi cước trùng lặp (0 duplicate billed entries)** và cơ chế bù trừ ghi bổ sung (`append-only compensating reconciliation`).
> 6. Bộ xử lý hóa đơn độc lập cách ly tuyệt đối với chốt an toàn chống thanh toán thực (`SIMULATION_ONLY` / `DRY_RUN_NO_CHARGE`).

## Bằng chứng thực thi (Evidence Template)

```text
Task: P9-02
Role / Phase: A / P9
Base commit: a3313e0 / HEAD (agy/p9-02)
Environment: Linux x86_64, Node.js v24.x, TypeScript 5.7.3, Python 3.12, pnpm 12.16.1
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0, 52 tasks acyclic, 0 errors)
  2. node --test ops/scaling/commercial.test.mjs -> PASS (exit code 0, all 7 commercial suites passed)
  3. node ops/scaling/scaling-cli.mjs --run-commercial-evaluation -> PASS (exit code 0, 100% invariants balanced)
  4. node --test ops/scaling/scaling.test.mjs -> PASS (exit code 0, all autoscaling/chaos tests passed)
  5. node --test ops/test/*.test.mjs -> PASS (exit code 0, all 72 regression tests passed)
Artifacts:
  - ops/scaling/quota-plans.mjs
  - ops/scaling/retention-tiers.mjs
  - ops/scaling/usage-exporter.mjs
  - ops/scaling/pricing-simulator.mjs
  - ops/scaling/reconciliation-engine.mjs
  - ops/scaling/billing-processor-mock.mjs
  - ops/scaling/commercial-suite.mjs
  - ops/scaling/commercial.test.mjs
  - evidence/P9-02/report.md
  - evidence/P9-02/summary.json
Acceptance mapping:
  - Usage export: PASS — Xuất toàn diện dữ liệu sử dụng theo tenant/profile/loại job ra JSON, RFC 4180 CSV, JSONL; tách bạch operational CPU/wall/storage vs billable output minutes (làm tròn 6 số thập phân), giới hạn cửa sổ truy vấn 31 ngày.
  - Quota plans: PASS — Thiết lập 4 tầng hạn ngạch chuẩn (free, starter, pro, enterprise) kiểm soát concurrent slots (1-10), queue depth (5-100), monthly output minutes (10-1200) và ngân sách trần ($1-$300); kích hoạt cảnh báo ngưỡng 80% (CVE_QUOTA_WARNING_80) và chặn HTTP 429 khi vượt trần.
  - Retention tiers: PASS — Định nghĩa 4 tầng lưu trữ (ephemeral 1d/7d, standard 7d/90d/180d, extended 30d/180d, archive 90d/365d/730d); máy quét dọn rác phát hiện 3 mục hết hạn, tiết kiệm ước tính $0.00332/tháng, bảo toàn tuyệt đối 100% tài sản có gắn cờ legalHold.
  - Pricing simulation: PASS — Mô phỏng chi phí và doanh thu đa mô hình (Cost-Plus margin, Tiered Subscription, PAYG volume tiers) qua 3 kịch bản sử dụng máy chủ (10%, 50%, 80%) theo chuẩn OPERATIONS.md và TESTING.md; tính toán điểm hòa vốn và biên lợi nhuận gộp.
  - Reconciliation: PASS — Đối soát toàn diện trạng thái job và sổ cái usage; bảo đảm bất biến 0 duplicate billable entries; tự động sinh bản ghi bù trừ (compensating entries) theo nguyên tắc append-only để cân bằng sổ cái khi phát hiện bất thường.
  - Billing processor riêng: PASS — Bộ tạo hóa đơn dự thảo cách ly, chốt an toàn cấm thanh toán thực tế (realChargingExecuted = false, SIMULATION_ONLY), tạo hóa đơn có chữ ký băm toàn vẹn SHA-256.
Reviewer / reviewed commit / decision: implemented_local / a3313e0 / Acceptance met, full commercial verification pass
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P9-02** mở rộng năng lực thương mại, kiểm soát tài nguyên và đối soát tài chính cho nền tảng Creativanta Video Engine mà không kích hoạt bất kỳ cổng thanh toán thực tế nào:

| Tiêu chí kiểm định cốt lõi | Giá trị đo đạc / Thực nghiệm | Ngưỡng yêu cầu | Kết quả |
| :--- | :--- | :--- | :--- |
| **Duplicate Billed Entries** | **0 bản ghi** (trên 100% jobs) | **Tuyệt đối = 0** | ✅ **ĐẠT** |
| **Post-Recon Ledger Balance** | **100% CÂN BẰNG (BALANCED)** | **0 sai lệch tồn đọng** | ✅ **ĐẠT** |
| **Compensating Append-Only** | **2 bản ghi bù trừ sinh mới** | **Không sửa đè lịch sử** | ✅ **ĐẠT** |
| **Quota 80% Warning Trigger** | **Kích hoạt thành công** | **Ngưỡng >= 80%** | ✅ **ĐẠT** |
| **Quota Breach Shedding** | **HTTP 429 QUOTA_EXCEEDED** | **Chặn an toàn khi chạm trần** | ✅ **ĐẠT** |
| **Legal Hold Data Protection** | **1 tài sản được bảo vệ 100%** | **Tuyệt đối không xóa** | ✅ **ĐẠT** |
| **Multi-Scenario Modeling** | **3 kịch bản đo đạc (10%, 50%, 80%)** | **Đầy đủ 3 kịch bản chuẩn** | ✅ **ĐẠT** |
| **Export Formats Verified** | **JSON, RFC 4180 CSV, JSONL** | **Đầy đủ 3 định dạng** | ✅ **ĐẠT** |
| **Real Charging Safety Assertion** | **KHÔNG kích hoạt (false)** | **Chế độ SIMULATION_ONLY** | ✅ **ĐẠT** |

---

## 2. Chi tiết các thành phần kỹ thuật đã hiện thực hóa

### 2.1. Quota Plans & Admission Controller (`ops/scaling/quota-plans.mjs`)
- **Phân tầng chuẩn:**
  - `free`: 1 active slot, 5 queued jobs, 10 billable minutes/tháng, trần ngân sách $1.00/tháng, 5 rps, max 25MB upload, 1GB storage.
  - `starter`: 2 active slots, 20 queued jobs, 60 billable minutes/tháng, trần ngân sách $15.00/tháng, 15 rps, max 100MB upload, 10GB storage.
  - `pro`: 5 active slots, 50 queued jobs, 300 billable minutes/tháng, trần ngân sách $75.00/tháng, 30 rps, max 500MB upload, 50GB storage.
  - `enterprise`: 10 active slots, 100 queued jobs, 1200 billable minutes/tháng, trần ngân sách $300.00/tháng, 50 rps, max 2GB upload, 500GB storage.
- **Cảnh báo sớm và từ chối tải:**
  - Khi mức tiêu thụ đạt từ 80% hạn ngạch phút hoặc ngân sách, hệ thống sinh cảnh báo `CVE_QUOTA_WARNING_80` / `CVE_BUDGET_WARNING_80` nhưng vẫn tiếp nhận job hợp lệ.
  - Khi vượt 100%, admission từ chối lập tức với mã lỗi `HTTP 429 QUOTA_EXCEEDED` kèm tiêu đề `Retry-After`.

### 2.2. Retention Tiers & Purge Lifecycle Engine (`ops/scaling/retention-tiers.mjs`)
- **Các tầng lưu trữ:**
  - `ephemeral`: media 1 ngày, artifacts 1 ngày, metadata 7 ngày, audit 30 ngày.
  - `standard`: media 7 ngày, artifacts 7 ngày, metadata 90 ngày, audit 180 ngày (khớp chuẩn PRD & SECURITY.md).
  - `extended`: media 30 ngày, artifacts 14 ngày, metadata 180 ngày, audit 365 ngày.
  - `archive`: media 90 ngày, artifacts 30 ngày, metadata 365 ngày, audit 730 ngày (2 năm).
- **Quản lý an toàn dữ liệu:**
  - Máy quét tự động phát hiện 3 đối tượng hết hạn, giải phóng 0.166 GB dữ liệu.
  - Cơ chế `legalHold` được áp dụng chặt chẽ: bất kỳ tài sản nào có cờ bảo lưu pháp lý đều được loại trừ khỏi danh sách xóa.

### 2.3. Multi-Tenant Usage Exporter (`ops/scaling/usage-exporter.mjs`)
- Cung cấp API xuất dữ liệu sử dụng theo bộ lọc tenant, khung thời gian (chặn cửa sổ >31 ngày), profile và loại job.
- Tách biệt rành mạch:
  - **Operational:** tổng wall time, CPU seconds thực tế, reserved vCPU seconds, chi phí tính toán, chi phí lưu trữ, chi phí egress và tỷ số RTF trung bình.
  - **Billable:** số phút xuất video tính cước (`exact output_seconds / 60`, làm tròn 6 chữ số thập phân), miễn tính cước thời lượng cho job preview.
- Xuất thành công ra 3 định dạng: JSON phân cấp, CSV chuẩn RFC 4180 và JSONL luồng.

### 2.4. Pricing Simulator & Unit Economics Engine (`ops/scaling/pricing-simulator.mjs`)
- **Mô phỏng 3 kịch bản hiệu suất sử dụng máy chủ (10%, 50%, 80%):**
  - **10% Utilization:** Chi phí máy chủ nhàn rỗi lớn ($116.80/node/tháng), giá thành đầy đủ (fully allocated cost) đạt $0.0547/phút.
  - **50% Utilization:** Baseline sản xuất ổn định, giá thành đầy đủ giảm xuống $0.0109/phút, biên lợi nhuận gộp PAYG đạt 85.9%.
  - **80% Utilization:** Vùng tối ưu hóa cao độ, giá thành đầy đủ đạt mức tối thiểu $0.0068/phút, biên lợi nhuận gộp PAYG đạt đỉnh 90.9%.
- **Mô phỏng phân bổ tải chuẩn (What-If Workload):**
  - Kiểm thử 1000 jobs với tỷ lệ 80% POC-01 (15s promo) và 20% POC-03 (45s footage) theo `docs/TESTING.md`, đo lường tổng thời gian render, vCPU seconds và biên lợi nhuận Cost-Plus 35%.

### 2.5. Reconciliation Engine & Append-Only Compensation (`ops/scaling/reconciliation-engine.mjs`)
- Rà soát toàn diện giữa trạng thái xử lý công việc và sổ cái ghi nhận.
- Phát hiện chính xác các sai lệch tiêm vào thử nghiệm:
  - Ghi nhận thừa cước tính kép (`DOUBLE_BILLABLE_ENTRY`).
  - Tồn đọng ngân sách tạm giữ trên công việc đã kết thúc (`DANGLING_RESERVATION`).
- Cơ chế sửa sai hoàn toàn **không ghi đè lịch sử (append-only)**:
  - Sinh tự động các bút toán bù trừ có tham chiếu (`COMPENSATING_RECONCILIATION`).
  - Sau khi bù trừ, trạng thái sổ cái chuyển sang **BALANCED**, khôi phục 100% các bất biến tài chính.

### 2.6. Mock Billing Processor (`ops/scaling/billing-processor-mock.mjs`)
- Được thiết kế cách ly hoàn toàn nhằm thực hiện đúng cam kết: *billing processor riêng chỉ khi scope được cấp, không charging thật ở task này*.
- Tích hợp chốt chặn an toàn `assertNoRealCharging`: nếu phát hiện cờ kích hoạt thanh toán thực hoặc token cổng thanh toán, ném ngoại lệ bảo mật ngay lập tức.
- Tạo ra bản thảo hóa đơn định dạng văn bản và JSON với mã băm toàn vẹn SHA-256 (`SHA-256 Verified`).

---

## 3. Các cổng đối ngoại chờ phê duyệt (External Gates)

```text
1. [EXT-P9-02] Staging Integration Gate: Supervisor review và sáp nhập nhánh agy/p9-02 vào staging.
2. [EXT-P9-03] Commercial Billing Provider Gateway Gate: Phê duyệt cổng thanh toán trực tuyến (Stripe/Payment Gateway) và ký kết hợp đồng pháp lý thương mại trước khi bật tính cước thực tế.
3. [EXT-P9-04] Commercial Pricing & Margin Sign-Off Gate: Hội đồng quản trị và Ban Tài chính phê duyệt bảng giá bán lẻ chính thức (Retail Pricing Schedule) trước khi công bố GA.
```
