# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-05

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-05` (`A / P4` — Usage Ledger, Reserve, Settle, Release, Operational vs Billable Reports, Repeated Completion Double Debit Protection & Separation of Canceled/Failed Units): Triển khai toàn diện và kiểm định nghiêm ngặt cơ chế sổ cái sử dụng bất biến (`usage_ledger` / `usage_entries`), quản lý vòng đời hạn ngạch dự trữ (`usage_reservations`: `reserved` -> `settled` / `released`), bảo vệ tuyệt đối chống tính phí lặp (`repeated completion không double debit`), miễn trừ tính phí đầu ra cho công việc xem trước (`kind === 'preview'` debit `0` billable output minutes), tách bạch triệt để giữa chi phí vận hành nền tảng (`operational` CPU seconds / attempts) và khối lượng tính phí khách hàng (`billable` output minutes / jobs), phân tách rạch ròi các đơn vị hủy (`canceled_units`) và lỗi (`failed_units`) với `0` phí dịch vụ, cung cấp API báo cáo sử dụng chi tiết (`GET /v1/usage`) kèm kiểm tra khoảng thời gian ISO (`<= 31 ngày`) và cơ chế kiểm toán đối soát (`reconcileUsage` / `GET /v1/usage/reconcile`) hỗ trợ ghi nhận bản ghi bù (`compensating`), tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md) và [docs/OPERATIONS.md](../../docs/OPERATIONS.md).

```text
Task: P4-05
Base / tested commit: b86920a2e5d167f08d0e7226db99c824c2db4811 / HEAD (agy/p4-05 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:zlib & node:http), pnpm 12.16.1, TypeScript 5.8.2, Python 3.12.0
Command: pnpm build && pnpm typecheck && pnpm lint && node --test packages/api/test/p4-05-usage-ledger-reserve-settle-release.test.mjs && pnpm --filter @creativanta/api test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T18:26:00Z / 0.72s (P4-05 suite), 40.6s (full API suite)
Artifacts:
  - packages/api/src/db/repository.ts, sha256=20e60a92f617ed8db620cd986b5fd453d24ae4527c5677024509e0bcab22786d, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/job-dispatcher.ts, sha256=b5be69e5fd2399b406f66b648b1d71025acdbaa4ad520d55dd822531675d10c5, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=cdb80e3eb8337df5536427afd8f9fe48f0c6f7d9971478c3ffe19b5fb9b5bf44, expires=N/A (repo-versioned)
  - packages/api/test/p4-05-usage-ledger-reserve-settle-release.test.mjs, sha256=9b72ea4df41807c6e804d2ed0e8e1bd34d5d1cf0cbe1de56534a82e71b76d43e, expires=N/A (repo-versioned)
  - evidence/P4-05/summary.json, sha256=3c72f4e338718bb9cac24f4ffe48ac2b08056c3d24328d5f452c50b2e5908aee, expires=N/A (repo-versioned)
Acceptance mapping:
  - Usage ledger / reserve / settle / release: PASS — Khi tiếp nhận công việc (`admitJob`), hệ thống tính toán và ghi nhận hạn ngạch trần dự trữ (`usage_reservations`) ở trạng thái `reserved`. Khi công việc kết xuất (`render`) thành công, giao dịch xuất bản (`publishJobAttempt`) tất toán (`state = 'settled'`) và tạo đúng 1 bản ghi `billable` output_minutes cùng 1 bản ghi `operational` cpu_seconds. Với công việc xem trước (`preview`), hệ thống tất toán reservation nhưng áp dụng chính sách miễn trừ tính phí (`quantity = 0`, `terminal_preview_exempt`). Khi công việc bị hủy (`cancelJob`) hoặc gặp lỗi kết thúc (`failOrRetryAttempt` với lỗi fatal hoặc hết số lần thử), reservation chuyển sang `released` trong khi vẫn bảo lưu đầy đủ số giây CPU vận hành của các lần thử đã chạy.
  - Repeated completion không double debit: PASS — Cơ chế bảo vệ 3 lớp đảm bảo không bao giờ bị tính phí hai lần: (1) Hàng rào token thuê (`lease_epoch` fencing) và kiểm tra trạng thái công việc chặn đứng worker gọi lại `publishJobAttempt` với mã `STALE_LEASE_OR_EPOCH`; (2) Lớp phân giải tranh chấp đồng thời (`concurrent race`) chỉ cho phép đúng 1 giao dịch commit thành công, giao dịch thứ hai bị loại trừ tương hỗ; (3) Khóa duy nhất cấp cơ sở dữ liệu `UNIQUE (tenant_id, job_id, meter, ledger_version)` và trigger bất biến `trg_usage_entries_no_update` ngăn chặn hoàn toàn việc ghi đè hay ghi đúp bản ghi sổ cái.
  - Canceled / failed units tách rõ: PASS — Báo cáo tổng hợp sử dụng (`GET /v1/usage` và `getUsageSummary`) phân định rõ ràng các khối đơn vị: `succeeded_units` (có cả operational CPU và billable minutes), `canceled_units` (thống kê jobs, attempts, operational CPU seconds, released seconds, cam kết `billable_output_minutes = 0`), và `failed_units` (thống kê jobs, attempts, operational CPU seconds, released seconds, cam kết `billable_output_minutes = 0`).
  - Operational vs billable reports & reconciliation: PASS — Endpoint `GET /v1/usage` chuẩn hóa và kiểm tra nghiêm ngặt định dạng ISO của `from` / `to`, chặn các dải thời gian ngược chiều hoặc vượt quá 31 ngày (`400 INVALID_QUERY_PARAM`). Hàm `reconcileUsage` (kèm endpoint `GET /v1/usage/reconcile` và tham số `?reconcile=true`) quét toàn bộ lịch sử job, reservation và ledger entries để phát hiện sớm các dấu hiệu `DOUBLE_DEBIT`, `UNEXPECTED_BILLABLE_ENTRY`, `MISSING_BILLABLE_ENTRY` hoặc `RESERVATION_STATE_MISMATCH`. Cơ chế chèn bản ghi bù (`insertCompensatingUsageEntry` với `usage_class = 'compensating'`) tuân thủ tính bất biến chỉ thêm (`append-only`) của cơ sở dữ liệu.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-05** (`Stream A / Phase P4`) hoàn thiện cơ chế kế toán sổ cái tài nguyên (Usage Ledger), bảo vệ dự trữ - tất toán - giải phóng (Reserve / Settle / Release), kiểm soát tính phí lặp (Repeated Completion & Double Debit Protection), phân tách rạch ròi chi phí vận hành và chi phí tính phí khách hàng, cũng như công cụ đối soát sổ cái theo đúng các văn bản quy chuẩn [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/API.md](../../docs/API.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/OPERATIONS.md](../../docs/OPERATIONS.md) và [docs/TESTING.md](../../docs/TESTING.md):

### 1.1 Vòng Đời Dự Trữ, Tất Toán & Giải Phóng (Reserve, Settle & Release)
- **Dự trữ khi tiếp nhận (`admitJob` -> `usage_reservations`):**
  - Khi một công việc được gửi vào hệ thống (`render` hoặc `preview`), bộ phận tiếp nhận tính toán khối lượng dự trù tối đa (`reserved_output_seconds` và `reserved_cpu_seconds`) dựa trên thời lượng bố cục (`duration_seconds`), cấu hình phân giải và giới hạn deadline.
  - Bản ghi được chèn vào bảng `usage_reservations` với trạng thái ban đầu `reserved`. Hệ thống cộng dồn các giá trị dự trữ đang hoạt động vào bộ đếm `pending_units` để so khớp hạn ngạch chính sách của tenant (`max_reserved_output_seconds`). Nếu vượt trần, công việc bị từ chối ngay lập tức với mã lỗi `429 RESERVATION_LIMIT_EXCEEDED`.
- **Tất toán khi thành công (`publishJobAttempt` -> `settled`):**
  - Khi công việc hoàn tất kết xuất và vượt qua toàn bộ các bước kiểm định tệp tạm, giao dịch xuất bản chuyển trạng thái reservation sang `settled` và ghi nhận `settled_output_seconds` cùng `settled_cpu_seconds` thực tế.
  - Đồng thời, giao dịch tạo ra đúng 2 bản ghi trên sổ cái bất biến `usage_entries`:
    1. Bản ghi tính phí (`usage_class = 'billable'`, `meter = 'output_minutes'`): tính chính xác theo số phút video đầu ra thực tế (`effectiveOutputSeconds / 60`).
    2. Bản ghi vận hành (`usage_class = 'operational'`, `meter = 'renderer_cpu_seconds'`): ghi nhận tổng thời gian CPU mà các worker đã tiêu tốn.
- **Miễn trừ tính phí xem trước (`preview exemption`):**
  - Theo chuẩn thiết kế tại [docs/API.md:172](../../docs/API.md#L172) và [docs/OPERATIONS.md:30-33](../../docs/OPERATIONS.md#L30-L33), các công việc xem trước chất lượng thấp (`kind === 'preview'`) được miễn phí thời lượng xuất bản (`quantity = 0`, lý do `terminal_preview_exempt`).
  - Dù vậy, hệ thống vẫn ghi nhận đầy đủ chi phí thời gian CPU vận hành nền tảng (`operational`) để kiểm soát tài nguyên hạ tầng.
- **Giải phóng khi hủy hoặc lỗi kết thúc (`cancelJob` / `failOrRetryAttempt` -> `released`):**
  - Khi một công việc bị người dùng hủy tại bất kỳ giai đoạn nào (`queued`, `preparing`, `rendering`, `encoding`, `verifying`, `retry_wait`), hoặc gặp lỗi kết thúc không thể thử lại (`fatal error` hoặc cạn số lần thử `attempt >= max_attempts`), reservation lập tức chuyển sang trạng thái `released`.
  - Khối lượng thời lượng dự trữ được giải phóng ngay lập tức khỏi hạn ngạch tenant (`released_output_seconds = reserved_output_seconds`).
  - Tuyệt đối không có bất kỳ bản ghi tính phí (`billable`) nào được tạo ra (`0 billable minutes`). Các nỗ lực worker đã chạy trước đó vẫn được ghi nhận đầy đủ vào sổ cái vận hành (`operational`) với lý do lỗi/hủy tương ứng (`attempt_failed_exhausted`, `attempt_failed_fatal`, `attempt_canceled_pre_publish`).

### 1.2 Bảo Vệ Chống Tính Phí Hai Lần (Repeated Completion & Double Debit Protection)
- **Hàng rào Epoch & Fencing Token (`lease_epoch`):**
  - Mọi thao tác xuất bản `publishJobAttempt` đều yêu cầu `lease_token` và kiểm tra `lease_epoch` khớp chính xác với bản ghi công việc đang mở trong DB.
  - Nếu worker bị trễ, bị thu hồi bởi Reaper hoặc cố tình gọi lại `publishJobAttempt` lần thứ hai, trạng thái công việc đã ở `succeeded` hoặc epoch đã tăng sẽ khiến câu lệnh cập nhật có điều kiện trả về 0 dòng và ném ngay ngoại lệ `STALE_LEASE_OR_EPOCH`. Không có thêm bản ghi sổ cái nào được chèn.
- **Tính Bất Biến & Chống Trùng Khi Replay Yêu Cầu (`Idempotency-Key`):**
  - Khi người dùng gửi lại cùng một yêu cầu tạo job hoặc yêu cầu hủy với cùng `Idempotency-Key`, hệ thống trả về kết quả đã lưu trữ từ bảng `idempotency_keys` mà không tạo thêm reservation mới hoặc kích hoạt lại quy trình tất toán/giải phóng.
- **Khóa Bất Biến Cấp Cơ Sở Dữ Liệu:**
  - Bảng `usage_entries` sở hữu ràng buộc khóa duy nhất `UNIQUE (tenant_id, job_id, meter, ledger_version)`.
  - Trigger `trg_usage_entries_no_update` chặn đứng toàn bộ lệnh `UPDATE` trên bảng, đảm bảo sổ cái là cấu trúc append-only bất biến.
  - Khi có tranh chấp đồng thời giữa hai worker cố xuất bản cùng lúc, chỉ duy nhất một tiến trình thành công commit giao dịch, tiến trình còn lại bị chặn bởi điều kiện hàng rào và không bao giờ xảy ra tình trạng double debit.

### 1.3 Báo Cáo Phân Tách Chi Tiết Vận Hành vs Tính Phí (Operational vs Billable Reporting)
- **API `GET /v1/usage` chuẩn hóa:**
  - Tiếp nhận các tham số truy vấn `from` và `to`.
  - Kiểm tra tính hợp lệ của chuỗi ISO 8601, bảo đảm `to >= from` và khoảng cách thời gian giữa `from` và `to` không vượt quá 31 ngày (tránh tấn công DoS quét toàn bộ cơ sở dữ liệu). Vi phạm trả về `400 INVALID_QUERY_PARAM`.
  - Trả về cấu trúc tương thích hoàn toàn với OpenAPI schema (`UsageResponse`): `from`, `to`, `operational_attempts`, `billable_output_minutes`, `estimated_cost`, `currency`.
- **Phân định rõ ràng 3 nhóm đơn vị (`succeeded`, `canceled`, `failed`):**
  - `succeeded_units`: số công việc hoàn tất, số lần thử, CPU vận hành, số giây đầu ra đã tất toán, số phút tính phí.
  - `canceled_units`: số công việc bị hủy, số lần thử đã chạy trước khi hủy, CPU vận hành đã tiêu thụ, số giây dự trữ đã giải phóng, cam kết `billable_output_minutes: 0`.
  - `failed_units`: số công việc thất bại cuối cùng, số lần thử đã thực hiện, CPU vận hành đã tiêu thụ, số giây dự trữ đã giải phóng, cam kết `billable_output_minutes: 0`.
  - Cung cấp số liệu thống kê reservation tổng thể: số lượng và dung lượng các khoản đang giữ (`reserved`), đã chốt (`settled`), và đã trả (`released`).

### 1.4 Kiểm Toán Đối Soát Sổ Cái & Bản Ghi Bù (Reconciliation & Compensating Entries)
- **Công cụ đối soát `reconcileUsage` (`GET /v1/usage/reconcile` hoặc `GET /v1/usage?reconcile=true`):**
  - Quét toàn bộ các công việc và đối chiếu chéo giữa trạng thái công việc (`jobs.status`), trạng thái dự trữ (`usage_reservations.state`), và các dòng ghi nhận trong `usage_entries`.
  - Tự động phát hiện và cảnh báo các loại sai lệch:
    - `DOUBLE_DEBIT`: phát hiện nhiều hơn 1 bản ghi tính phí dương cho cùng một công việc.
    - `UNEXPECTED_BILLABLE_ENTRY`: phát hiện bản ghi tính phí trên công việc không ở trạng thái `succeeded` hoặc công việc thuộc loại `preview`.
    - `MISSING_BILLABLE_ENTRY`: phát hiện công việc `render` đã `succeeded` nhưng chưa có bản ghi tính phí.
    - `RESERVATION_STATE_MISMATCH`: trạng thái reservation không tương ứng với trạng thái kết thúc của công việc (ví dụ: công việc `succeeded` nhưng reservation vẫn ở `reserved` hoặc `released`).
- **Bản ghi bù (`insertCompensatingUsageEntry`):**
  - Vì trigger `trg_usage_entries_no_update` cấm cập nhật trực tiếp dòng đã ghi, mọi điều chỉnh số liệu kế toán (hoàn tiền, điều chỉnh sai sót kỹ thuật) bắt buộc phải thực hiện thông qua việc chèn bản ghi bù (`usage_class = 'compensating'`) với `ledger_version` tăng dần.
  - Quyền ghi này được thực thi an toàn thông qua vai trò dịch vụ `cve_dispatcher` vốn có quyền `INSERT` trên bảng `usage_entries`.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `pnpm build` | `0` | `PASS` | Biên dịch TypeScript thành công cho toàn bộ 7 packages trong workspace |
| 2 | `pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript (`tsc --noEmit`) đạt chuẩn không phát sinh lỗi |
| 3 | `pnpm lint` | `0` | `PASS` | Kiểm tra cú pháp và quy tắc mã nguồn tĩnh trên toàn bộ monorepo |
| 4 | `node --test packages/api/test/p4-05-usage-ledger-reserve-settle-release.test.mjs` | `0` | `PASS` | Đạt 100% (11/11 tests) bộ kiểm thử chuyên biệt P4-05 cho Reserve, Settle, Release, Double Debit Guards và Báo cáo đối soát |
| 5 | `pnpm --filter @creativanta/api test` | `0` | `PASS` | Toàn bộ 207 tests / 57 suites trong `@creativanta/api` chạy đạt kết quả hoàn hảo |
| 6 | `pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên tất cả các packages trong monorepo đều đạt 100% |
| 7 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận dịch vụ API khỏe mạnh trên `/healthz`, `/readyz`, và kiểm tra đúng năng lực engine |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra 16 tài liệu bắt buộc, 43 tệp markdown, 621 liên kết nội bộ, 52 tasks trong kế hoạch, DAG không có chu trình (acyclic), 0 lỗi, 0 cảnh báo |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Staging CI Gate & GitHub Integration:** Nhánh `agy/p4-05` được bàn giao cục bộ cho supervisor tích hợp vào `staging` và kích hoạt chu trình CI tự động trên GitHub Actions.
2. **Independent Technical Review Gate:** Chờ người đánh giá độc lập xem xét báo cáo nghiệm thu kỹ thuật, mã nguồn sửa đổi và các bằng chứng thực thi trước khi hợp nhất.
3. **External Upstream Tasks:** Các nhiệm vụ độc lập trong luồng `P4` và giai đoạn `P5` sẵn sàng kế thừa hạ tầng kế toán sổ cái chính xác và an toàn này.
