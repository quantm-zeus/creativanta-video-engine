# Báo cáo bằng chứng nghiệm thu nhiệm vụ P6-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P6-02` (`C+A / P6` — Backup/PITR + object consistency + restore drill vào isolated env, measured RPO<=15min/RTO<=4h; custom/import stay off sau restore đến revalidation): Triển khai trọn vẹn kiến trúc sao lưu và khôi phục điểm thời gian (Point-In-Time Recovery - PITR) kết hợp đối soát dữ liệu kho lưu trữ đối tượng (Object Storage Consistency Reconciliation), diễn tập khôi phục tự động trong môi trường cách ly (isolated disaster recovery drill), đo lường chỉ số RPO thực tế <= 15 phút và RTO thực tế <= 4 giờ theo chuẩn SLO tại [docs/OPERATIONS.md](../../docs/OPERATIONS.md), đồng thời cưỡng chế cơ chế khóa cứng an toàn hậu phục hồi (`PostRestoreSafetyGate` giữ `customCodeEnabled = false`, `remoteImportEnabled = false`, `outboundWebhooksEnabled = false`) cho đến khi hoàn tất quy trình tái thẩm định an ninh chính thức có ký duyệt bởi operator. Toàn bộ tuân thủ nghiêm ngặt các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), [docs/OPERATIONS.md](../../docs/OPERATIONS.md) và [docs/API.md](../../docs/API.md).

```text
Task: P6-02
Base / tested commit: 19ce9d2dc9080e75a337aa31f99c15858cfd7ba3 / HEAD (agy/p6-02)
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Node v24.22.2 (built-in node:sqlite, node:crypto), pnpm 12.16.1, TypeScript 5.7.3, Python 3.12.0
Command: node --test ops/test/*.test.mjs && node benchmarks/restore-drill-benchmark.mjs && node ops/recovery/recovery-cli.mjs drill --json && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-04T03:50:48Z / 3.8s
Artifacts:
  - ops/recovery/backup-manager.mjs, sha256=fc69fa01cd45452d77b15d784efe05b09062dc0a43678b18b9793f16a1fdf6b0, expires=N/A (repo-versioned)
  - ops/recovery/object-reconciler.mjs, sha256=63887cf5539b9afe58264fe1a40f52252514a54ec0d6d10a211c2b934ba4805b, expires=N/A (repo-versioned)
  - ops/recovery/safety-gate-manager.mjs, sha256=980a502e052ad23bd14f69f115840d50a3a99d1fbdcb31178c1d6f3b6f670b80, expires=N/A (repo-versioned)
  - ops/recovery/restore-drill-runner.mjs, sha256=f0a83c4f30cff66eb6c1de0b22cca3c447a71487a22a8150a4cf5e24b1f01985, expires=N/A (repo-versioned)
  - ops/recovery/recovery-cli.mjs, sha256=2dd33f018984b6ffb996adbe3be62816086b08f1b779e03ba612bbe2b3e4304e, expires=N/A (repo-versioned)
  - ops/runbooks/RUNBOOK-05-DB-STORAGE-OUTAGE.md, sha256=e5e6326d5123d5ccce4200cc167b8a1dc93e2fb023b9ca98301eae1527164263, expires=N/A (repo-versioned)
  - ops/runbooks/synthetic-runbook-runner.mjs, sha256=a0d55d3fa61f6b170c629ba6f443e00685ebd0ec31b308bde2bdd14a0e76cf12, expires=N/A (repo-versioned)
  - benchmarks/restore-drill-benchmark.mjs, sha256=2039d3a05707bb4393067ee82e79957b6226bfbc6b3e474094c5137583b6fd9d, expires=N/A (repo-versioned)
  - ops/test/restore-drill.test.mjs, sha256=6dad8a530e8025e3045f15ac5f2340fee9ebed1e0b4f065cc4b0bba496829c5e, expires=N/A (repo-versioned)
  - evidence/P6-02/summary.json, sha256=2203445648bee513fed822b0cf4ecf85cdd550e990a77f6cfdf812a8d55ecf6e, expires=N/A (repo-versioned)
  - evidence/P6-02/report.md, sha256=pending-commit, expires=N/A (repo-versioned)
Acceptance mapping:
  - Backup & PITR Engine: PASS — Tạo bản chụp cơ sở dữ liệu nguyên tử trên toàn bộ 21 bảng canonical kèm schema_migrations; xác thực mã băm SHA-256 chống giả mạo; hỗ trợ replay nhật ký giao dịch WAL đến mốc cutoff chính xác; tính toán độ trễ RPO thực tế đối chiếu ngưỡng RPO <= 15 phút; thực thi chính sách dọn dẹp bản sao lưu quá 30 ngày (bảo toàn legal hold).
  - Object Storage Consistency Reconciliation: PASS — Đối soát từng artifact đã xuất bản với kho lưu trữ đối tượng (xác thực bytes và SHA-256, đánh dấu OBJECT_UNAVAILABLE nếu thiếu hoặc sai lệch mã băm, tuyệt đối không bịa tệp rỗng); chuyển các asset tải dở dang sang rejected; quét và cách ly tệp mồ côi (orphaned keys); tăng lease_epoch cấp fencing token mới thu hồi worker mồ côi; hội tụ cancel_requested sang canceled; đóng băng outbox webhooks (disabled); giải phóng reservation và bảo toàn bất biến sổ cái thanh toán.
  - Isolated Restore Drill & RPO/RTO Measurement: PASS — Khởi tạo môi trường diễn tập cô lập (isolated database và isolated storage); kiểm tra toàn vẹn khóa ngoại (0 vi phạm PRAGMA foreign_key_check); kiểm thử cách ly đa tenant (Tenant A không đọc được dữ liệu Tenant B); kiểm tra tính bất biến của catalog tenant; đo lường RPO thực tế (0s - 10m <= 15m) và RTO thực tế (~0.018s - 0.5s <= 4h).
  - Safety Locks Enforcement (custom/import stay off): PASS — Cưỡng chế trạng thái RESTORED_PENDING_REVALIDATION; khóa cứng customCodeEnabled = false, remoteImportEnabled = false, outboundWebhooksEnabled = false; chặn mọi yêu cầu thực thi mã tùy biến hoặc tải import ngoài với lỗi FEATURE_LOCKED_PENDING_REVALIDATION; hỗ trợ quy trình tái thẩm định an ninh chính thức có đối soát đa điểm và xác thực danh tính operator.
Reviewer / reviewed commit / decision: implemented_local / 19ce9d2dc9080e75a337aa31f99c15858cfd7ba3 / Acceptance met, full verification pass
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P6-02** (`C+A / P6`) hoàn thành xây dựng và kiểm định toàn diện hệ thống sao lưu khôi phục thảm họa (Disaster Recovery & Point-In-Time Recovery), động cơ đối soát tính nhất quán giữa cơ sở dữ liệu và kho lưu trữ đối tượng (Object Consistency Reconciler), quy trình diễn tập khôi phục trong môi trường cách ly (Isolated Restore Drill Runner) đạt chỉ số **RPO <= 15 phút** và **RTO <= 4 giờ**, cùng cơ chế khóa an toàn hậu phục hồi cưỡng chế các cờ tính năng `custom/import stay off` cho đến khi hoàn tất tái thẩm định an ninh theo quy chuẩn tại [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/OPERATIONS.md](../../docs/OPERATIONS.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md), [docs/SECURITY.md](../../docs/SECURITY.md) và [migrations/ROLLBACK_AND_RECOVERY.md](../../migrations/ROLLBACK_AND_RECOVERY.md).

---

## 2. Chi tiết các thành phần bàn giao chính

### 2.1. Động cơ Sao lưu & Phục hồi Điểm thời gian (`ops/recovery/backup-manager.mjs`)
- **Sao lưu toàn vẹn nguyên tử (Atomic Snapshot):** Xuất bản snapshot JSON trọn vẹn 21 bảng canonical và bảng theo dõi migration `schema_migrations`, đính kèm số lượng bản ghi từng bảng, thời điểm tạo, mốc cắt giao dịch `cutoffTimestamp`, và mã băm toàn vẹn SHA-256.
- **Xác thực toàn vẹn & Chống giả mạo:** Trước khi nạp snapshot vào bộ nhớ hoặc cơ sở dữ liệu, hàm `loadSnapshotFromDisk` băm lại toàn bộ nội dung và so sánh với `metadata.sha256`. Nếu phát hiện sửa đổi dù chỉ 1 byte, hệ thống từ chối với lỗi cấu trúc `BackupIntegrityError` (`BACKUP_INTEGRITY_MISMATCH`).
- **Tua lại nhật ký giao dịch (WAL Replay / PITR):** Hỗ trợ nạp chuỗi bản ghi WAL tuần tự theo `lsn` và mốc thời gian `timestamp`. Các giao dịch commit trước hoặc tại mốc `targetCutoffTimestamp` được áp dụng nguyên tử trong giao dịch DB; các giao dịch phát sinh sau mốc cutoff bị bỏ qua.
- **Đo lường RPO (Recovery Point Objective):** Tính toán khoảng cách thời gian giữa mốc cutoff và giao dịch commit cuối cùng trước cutoff:
  $$\text{RPO} = \max(0, \text{targetCutoff} - \text{lastCommittedTx})$$
  Xác minh nghiệm thu đạt mục tiêu SLO $\text{RPO} \le 15\text{ phút}$ (900 giây).
- **Chính sách lưu trữ sao lưu 30 ngày (Retention Pruning):** Quét thư mục sao lưu, tự động dọn dẹp các tệp bản sao lưu cũ hơn 30 ngày theo quy định tại [docs/SECURITY.md](../../docs/SECURITY.md):63 và [docs/OPERATIONS.md](../../docs/OPERATIONS.md):17, đồng thời tôn trọng cờ giữ pháp lý `legalHold: true`.

### 2.2. Động cơ Đối soát Tính nhất quán Đối tượng (`ops/recovery/object-reconciler.mjs`)
Xử lý triệt để sai lệch dữ liệu giữa DB và kho lưu trữ vật lý sau sự cố:
1. **Đối soát Artifacts đã xuất bản:**
   - Quét toàn bộ bản ghi trong bảng `artifacts` chưa bị thu hồi (`revoked_at IS NULL`).
   - Đối chiếu với tệp vật lý trong storage backend: kiểm tra sự tồn tại, dung lượng bytes và mã băm SHA-256.
   - Nếu tệp bị thiếu hoặc sai lệch mã băm: đánh dấu artifact là `unavailable`, đưa vào danh sách `missingStorageArtifacts` / `corruptedStorageArtifacts`. Tuyệt đối không bao giờ bịa tệp rỗng hoặc tạo artifact giả.
2. **Xử lý Upload Assets dở dang:**
   - Các asset ở trạng thái `uploading` hoặc `processing` không có tệp đối tượng hoàn chỉnh tại mốc cutoff được chuyển sang `rejected` để khách hàng upload lại an toàn, tránh treo trạng thái vĩnh viễn.
3. **Phát hiện và cách ly đối tượng mồ côi (Orphan Storage Detection):**
   - Quét toàn bộ khóa đối tượng trong storage; phát hiện các tệp không được tham chiếu bởi bất kỳ bản ghi DB nào (tàn dư từ render attempt bị crash hoặc giao dịch bị rollback).
   - Đưa vào danh sách `orphanedStorageKeys` phục vụ cách ly hoặc dọn dẹp tự động sau 24h (`cve_orphan_objects`).
4. **Cập nhật Fencing Token & Thu hồi Lease công nhân:**
   - Đối với các job đang hoạt động (`preparing`, `rendering`, `encoding`, `verifying`) có lease đã hết hạn:
     - Tăng thế hệ hàng rào bảo vệ: `lease_epoch = lease_epoch + 1` để vô hiệu hóa hoàn toàn nỗ lực xuất bản muộn từ zombie worker.
     - Nếu còn lượt thử (`attempt_count < max_attempts`) và chưa quá deadline: chuyển về `retry_wait` để dispatcher cấp phát lại.
     - Nếu đã quá hạn deadline hoặc hết lượt thử: chuyển về `failed` với mã lỗi `WORKER_LOST` hoặc `JOB_DEADLINE_EXCEEDED` (`retryable: false`).
5. **Hội tụ các lệnh hủy đang chờ (`cancel_requested`):**
   - Chuyển toàn bộ job ở `cancel_requested` sang trạng thái kết thúc `canceled`, dọn dẹp lease.
6. **Đóng băng đường phát Webhook (Outbox Freezing):**
   - Cập nhật toàn bộ endpoint webhook sang `state = 'disabled'` nhằm ngăn chặn môi trường diễn tập phát lại sự kiện ra ngoài mạng.
7. **Bảo toàn bất biến Sổ cái Thanh toán (Usage Ledger Invariant):**
   - Giải phóng các đặt trước tài nguyên (`usage_reservations`) của job bị hủy hoặc thất bại sang `state = 'released'`.
   - Đối soát bảo đảm bất biến: mỗi logical job thành công chỉ có tối đa 1 bút toán billable duy nhất cho mỗi `(tenant_id, job_id, meter, ledger_version)`.

### 2.3. Cổng An toàn Hậu phục hồi (`ops/recovery/safety-gate-manager.mjs`)
Thực thi nghiêm ngặt yêu cầu "custom/import stay off sau restore đến revalidation":
- **Trạng thái an toàn:** Sau khi khôi phục, hệ thống lập tức khóa vào trạng thái `RESTORED_PENDING_REVALIDATION`.
- **Khóa cứng tính năng:**
  - `customCodeEnabled = false` (chặn toàn bộ kịch bản dựng cảnh tùy biến).
  - `remoteImportEnabled = false` (chặn toàn bộ luồng tải tài nguyên từ URL ngoài).
  - `outboundWebhooksEnabled = false` (chặn gửi webhook ra ngoài).
- **Ngăn chặn truy cập:** Mọi yêu cầu gọi `assertCustomCodeAllowed()` hoặc `assertRemoteImportAllowed()` đều bị chặn đứng và ném lỗi `PostRestoreSafetyError` (`FEATURE_LOCKED_PENDING_REVALIDATION`).
- **Quy trình tái thẩm định an ninh (Security Revalidation Protocol):**
  - Chỉ operator có thẩm quyền với định danh hợp lệ và mã phiếu sự cố (ticket ID) mới được thực hiện tái thẩm định.
  - Bắt buộc kiểm tra 4 điều kiện tiên quyết: tính toàn vẹn khóa ngoại (foreignKeys), đối soát đối tượng (objectConsistency), cách ly đa tenant (tenantIsolation), và toàn vẹn danh mục hệ thống (catalogIntegrity). Nếu bất kỳ kiểm tra nào thất bại, hệ thống từ chối mở khóa.
  - Khi thẩm định thành công, hệ thống chuyển sang `REVALIDATED_ACTIVE`, ghi nhận nhật ký kiểm toán có thể truy vết và cho phép mở lại các tính năng theo chính sách.

### 2.4. Trình Điều phối Diễn tập Khôi phục Cô lập (`ops/recovery/restore-drill-runner.mjs`)
- Tự động hóa toàn bộ quy trình 6 bước diễn tập phục hồi thảm họa vào môi trường hoàn toàn cách ly (in-memory hoặc isolated database file riêng biệt, isolated memory/disk storage backend, zero external network).
- Tự động nạp snapshot, replay WAL, kích hoạt safety gate, đối soát đối tượng, chạy bộ kiểm tra toàn vẹn đa tenant và tính toán RPO/RTO.

### 2.5. Công cụ Dòng lệnh Vận hành (`ops/recovery/recovery-cli.mjs`)
Cung cấp giao diện dòng lệnh cho đội ngũ vận hành:
- `node ops/recovery/recovery-cli.mjs drill [--cutoff <timestamp>] [--json]`: Thực hiện diễn tập khôi phục cô lập.
- `node ops/recovery/recovery-cli.mjs snapshot [--out <dir>]`: Chụp bản sao lưu cơ sở dữ liệu có băm SHA-256.
- `node ops/recovery/recovery-cli.mjs revalidate --operator <id> --ticket <id>`: Thực hiện tái thẩm định an ninh.
- `node ops/recovery/recovery-cli.mjs status`: Kiểm tra trạng thái an toàn hiện tại.

### 2.6. Cẩm nang Vận hành Sự cố Lưu trữ (`ops/runbooks/RUNBOOK-05-DB-STORAGE-OUTAGE.md`)
- Cập nhật chi tiết quy trình ứng cứu sự cố DB/storage outage theo chuẩn vận hành thực tế.
- Tích hợp vào động cơ kiểm thử giả lập `ops/runbooks/synthetic-runbook-runner.mjs` chạy trực tiếp trên `RestoreDrillRunner`.

---

## 3. Kết quả kiểm thử thực tế

Toàn bộ **41 ca kiểm thử** trong thư mục `ops/test/` bao gồm bộ kiểm thử chuyên biệt `restore-drill.test.mjs` (8 bài test), bộ kiểm thử runbooks tổng hợp (6 bài test), viễn trắc chỉ số, quy tắc cảnh báo, nhật ký che giấu bí mật, bảng điều khiển và vết phân tán đều vượt qua 100%:

```text
▶ Prometheus Alerting Rules Suite (11.16ms) - 6 tests pass
▶ Grafana Dashboards Suite (13.25ms) - 4 tests pass
▶ Prometheus Metrics & Telemetry Suite (99.37ms) - 5 tests pass
▶ Per-Tenant Cost Reporting Suite (13.14ms) - 4 tests pass
▶ Redacted Structured Logging Suite (16.19ms) - 5 tests pass
▶ P6-02: Disaster Recovery Backup, PITR, Object Consistency & Restore Drill (129.21ms)
  ▶ 1. Atomic Base Snapshot & Tamper Detection
    ✔ creates full snapshot of all 21 tables with SHA-256 integrity hash
    ✔ persists and loads snapshot to/from disk and detects tamper modifications
  ▶ 2. WAL Transaction Logging & Point-In-Time Recovery (PITR)
    ✔ replays WAL mutations up to cutoff timestamp and ignores post-cutoff entries
    ✔ calculates measured RPO accurately and checks against RPO <= 15m SLO
    ✔ enforces 30-day backup retention pruning policy and honors legal hold
  ▶ 3. Object Storage Consistency & Database Reconciler
    ✔ detects missing artifacts, rejects incomplete uploads, fences expired leases, and converges cancel requests
  ▶ 4. Post-Restore Safety Gate (custom/import stay off)
    ✔ locks custom code, remote import, and outbound webhooks off until operator revalidation
  ▶ 5. End-to-End Isolated Restore Drill Runner
    ✔ executes full drill, verifies RPO<=15m, RTO<=4h, FKs, tenant isolation, and safety locks
▶ Synthetic Runbooks Diagnostic Verification Suite (83.24ms)
  ✔ RUNBOOK-05: verifies RPO <= 15min and RTO <= 4h targets and object consistency in isolated restore drill
▶ Distributed Tracing & Context Propagation Suite (21.54ms) - 3 tests pass

Total: 41 tests, 13 suites, 41 pass, 0 fail, 0 cancelled
```

---

## 4. Đo lường RPO / RTO thực tế đối chiếu SLO

Kết quả đo lường hiệu năng thực tế từ bộ benchmark tải lớn `benchmarks/restore-drill-benchmark.mjs` với tập dữ liệu **2.000 render jobs**, **5.816 bản ghi** trên toàn bộ 21 bảng canonical:

| Chỉ số | Ngưỡng mục tiêu SLO | Kết quả đo thực tế | Trạng thái | Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| **RPO (Recovery Point Objective)** | $\le 15\text{ phút}$ (900s) | **0.0 giây** (0m) | **PASS** | Dữ liệu được bảo toàn nguyên vẹn đến điểm cắt WAL |
| **RTO (Recovery Time Objective)** | $\le 4\text{ giờ}$ (14,400s) | **0.498 giây** | **PASS** | Hoàn tất toàn bộ nạp DB, đối soát 2.000 jobs, và kiểm tra toàn vẹn trong < 0.5s |
| **Tốc độ tạo snapshot** | N/A | **36.579 dòng/giây** (23.89 MB/s) | **PASS** | Tạo snapshot 3.98 MB trong 159ms |
| **Vi phạm khóa ngoại (FKs)** | 0 vi phạm | **0 vi phạm** | **PASS** | `PRAGMA foreign_key_check` sạch 100% |
| **Cách ly đa tenant (RLS)** | Tuyệt đối không rò rỉ | **PASS** | **PASS** | Không có giao thoa dữ liệu giữa Tenant A và Tenant B |
| **Khóa an toàn hậu phục hồi** | `custom/import stay off` | **LOCKED_OFF** | **PASS** | Chặn toàn bộ custom code và remote import đến khi revalidate |

---

## 5. Giới hạn & Các cổng thẩm định bên ngoài (External Gates)

1. **Phạm vi môi trường cục bộ:** Bản diễn tập P6-02 được chứng minh và xác thực hoàn chỉnh trên môi trường Node.js / SQLite độc lập trong worktree. Việc áp dụng kịch bản PITR vào cụm PostgreSQL managed (RDS/CloudSQL) hoặc MinIO S3 bucket sản xuất phải tuân theo ủy quyền hạ tầng tại nhiệm vụ `P6-05` (Staging/Production release).
2. **Tái thẩm định an ninh (Security Revalidation):** Việc kích hoạt cờ `CVE_CUSTOM_CODE_ENABLED` cho phép chạy microVM cảnh tùy biến chỉ được xem xét sau khi hoàn tất gói kiểm thử an ninh chuyên sâu `P6-04` và các cổng thẩm định C1–C6 tại `P7`.
3. **Quy trình Supervisor:** Không tự ý push commit lên remote hoặc tạo Pull Request; toàn bộ kết quả đã được xác thực cục bộ và ghi nhận tại `/var/lib/video-engine-harness/results/P6-02.json` để supervisor tiếp nhận và điều phối.
