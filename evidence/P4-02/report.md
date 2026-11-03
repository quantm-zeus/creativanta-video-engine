# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-02` (`B+A / P4` — Postgres Dispatcher, Lease/Heartbeat/Fencing, Fair Multi-Tenant Scheduling & Real Renderer Worker): Triển khai bộ điều phối công việc trên cơ sở dữ liệu (`JobDispatcher`), quản lý thuê bao thực thi (`60s` lease / `15s` heartbeat) dựa trên đồng hồ máy chủ cơ sở dữ liệu `now()` bất biến trước độ lệch đồng hồ của worker (`AMB-009`), thẻ rào chắn đơn điệu (`job_id`, `attempt_id`, `lease_epoch`), bộ lập lịch công bằng đa tenant (Round-Robin giữa các tenant, FIFO trong từng tenant, tối đa `2` khe active/tenant, trọng số ưu tiên `2:1` giữa preview và render kèm trần `<= 50%` tổng khe toàn cục cho preview khi có render đang chờ), bộ điều khiển worker kết xuất thực (`RealRendererWorker` biên dịch `CompositionSpec` qua `compileComposition`, đánh giá từng khung hình qua `evaluateFrame`, kết xuất PNG không suy hao, đóng gói MP4 H.264 `avc1` + AAC `mp4a` 48kHz stereo chuẩn `faststart` `moov` trước `mdat`, giải mã kiểm tra toàn vẹn ISO-BMFF), máy trạng thái công việc/lần thử/sự kiện đơn điệu, lưu trữ tạm theo phạm vi `attempt_id` và xuất bản nguyên tử có rào chắn đảm bảo worker cũ (`stale worker`) tuyệt đối không thể ghi đè hay xuất bản (`stale worker không publish`), tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-02
Base / tested commit: 66620df6861040292f42d86e3ef4bc3c3823d0d9 / HEAD (agy/p4-02 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:zlib & node:http), pnpm 10.6.1, TypeScript 5.8.2, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm --filter @creativanta/api test && pnpm test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T17:19:27Z / 31.4s
Artifacts:
  - packages/api/src/dispatcher/job-dispatcher.ts, sha256=f7f0603978e34941a667d5ff4bf8519b867ddb1728871b4d9f7569fee07c5707, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/renderer-worker.ts, sha256=da6f76ea98b06f1e7468613a67967f186f52bbf417692f637faddeb5a841f75c, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/index.ts, sha256=8f9a3a6dfaec7a073e813e1f3cc66fef3e31fb36be0c575fbce71594409cc858, expires=N/A (repo-versioned)
  - packages/api/src/assets/quarantine-store.ts, sha256=cfeee590a8d69a9f9b1a1a67b5c74357b691c57052404a62679db94da3073092, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=eaf906c009934e9de429901a1241037adbb83b8e3a266f19c6765a43678fc689, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=14def78e0acd908eba84f8accd2fa10843b8d18ddd729e5eb6251c4e229d3435, expires=N/A (repo-versioned)
  - packages/dispatcher/index.mjs, sha256=9a548d8044fa8a1e6fc1f066ed416ea4b09191deb72422a8d091835f0eb9cefc, expires=N/A (repo-versioned)
  - packages/api/test/p4-02-dispatcher-and-worker.test.mjs, sha256=30d99670b52675beb01691b6bfeb0dccb385a860d8af2368a4bab8b1c2fb3689, expires=N/A (repo-versioned)
  - evidence/P4-02/summary.json, sha256=ae17a2a9cdaa011de6769351bfc45a35f10b3e0c62ca539d155e574333d3f4fb, expires=N/A (repo-versioned)
Acceptance mapping:
  - Postgres dispatcher, 60s lease, 15s heartbeat on DB clock `now()` & worker clock-skew immunity (AMB-009): PASS — JobDispatcher cấp phát lease 60s và gia hạn heartbeat mỗi 15s dựa hoàn toàn trên đồng hồ máy chủ cơ sở dữ liệu (`getDbNow()`), bỏ qua mọi mốc thời gian cục bộ lệch múi giờ/lệch đồng hồ từ worker (`workerLocalTime`); khi gia hạn trả về 0 dòng khớp (do hết hạn lease, bị thu hồi epoch hoặc bị hủy), worker tự động dừng thực thi ngay lập tức (`shouldAbortWorker: true`).
  - Monotonic fencing token `(job_id, attempt_id, lease_epoch)` & stale worker không publish: PASS — Mỗi lần nhận việc (`claimNextJob`), thu hồi lease hết hạn (`reclaimExpiredLeases`), chuyển sang `retry_wait`/`failed`/`canceled` đều tăng đơn điệu `lease_epoch`; mọi thao tác `renewLease`, `advanceJobStage` và `publishJobAttempt` bắt buộc đối chiếu khớp `(job_id, active_attempt_id, lease_epoch)` và `lease_expires_at > db_now`. Kiểm thử chứng minh Worker 1 bị treo qua hạn lease sau khi dựng xong khung hình tuyệt đối bị chặn khi cố heartbeat, chuyển bước hoặc xuất bản artifact sau khi Worker 2 đã tiếp quản; không có bất kỳ bản ghi `artifacts`, `usage_entries` hay `outbox` trùng lặp/sai lệch nào từ Worker 1.
  - Fair multi-tenant scheduling (Round-Robin, FIFO, max 2 active/tenant, 2:1 preview-to-render priority with <= 50% preview cap): PASS — Bộ lập lịch chọn tenant theo vòng tròn Round-Robin công bằng giữa tenant ồn ào (nhiều job) và tenant yên tĩnh (ít job), giữ thứ tự FIFO (`created_at ASC, id ASC`) trong từng tenant, thực thi trần `active_job_slots_max = 2` mỗi tenant, và điều phối ưu tiên có trọng số `2:1` (`[preview, preview, render]`) đồng thời giới hạn số preview đang chạy không vượt quá `50%` tổng khe toàn cục khi có công việc render đang chờ, không chiếm quyền công việc đang chạy và không gây đói (starvation) cho render.
  - Real renderer, attempt-scoped temp staging & ISO-BMFF faststart MP4 verification: PASS — `RealRendererWorker` biên dịch bản chụp bất biến qua `compileComposition`, tính toán trạng thái từng khung hình qua `evaluateFrame`, kết xuất khung hình RGBA/PNG 8-bit không suy hao, tổng hợp âm thanh stereo 48kHz, đóng gói MP4 H.264 (`avc1`/`avcC`) + AAC (`mp4a`/`esds`) chuẩn `faststart` (`moov` nằm trước `mdat`), ghi tạm vào thư mục cô lập theo lần thử `temp/tenant/<tenantId>/job/<jobId>/<attemptId>/`, kiểm tra giải mã hoàn chỉnh qua cả `verifyIsoBmffMp4` và `Mp4Decoder` của `@creativanta/renderers` trước khi xuất bản nguyên tử sang `tenant/<tenantId>/job/<jobId>/<attemptId>/`.
  - Canonical state machine, monotonic `job_events`, `job_attempts`, retry backoff & `ASSET_REVOKED` guard: PASS — Thực thi đầy đủ chu trình trạng thái `queued -> preparing -> rendering -> encoding -> verifying -> succeeded`, phân loại chính xác 5 mã lỗi cho phép thử lại (`5s` sau lần 1, `30s + jitter` sau lần 2, tối đa `max_attempts = 3`) và 8 mã lỗi không thử lại, giữ nguyên khe và `usage_reservations` (`reserved`) khi ở `retry_wait` (`AMB-004`), thu hồi công việc `cancel_requested` hết hạn lease sang `canceled` (`AMB-003`), và chặn xuất bản ngay lập tức với lỗi `ASSET_REVOKED` nếu tài nguyên đầu vào bị xóa trước thời điểm xuất bản.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-02** (`Stream B+A / Phase P4`) hiện thực hóa toàn diện bộ điều phối công việc trên cơ sở dữ liệu, cơ chế thuê bao và nhịp tim dựa trên đồng hồ máy chủ DB, thẻ rào chắn đơn điệu chống worker cũ, thuật toán lập lịch công bằng đa tenant, bộ kết xuất thực (Real Renderer) kèm kiểm định container MP4/PNG và máy trạng thái công việc/lần thử/sự kiện theo đúng đặc tả tại [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/API.md](../../docs/API.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/TESTING.md](../../docs/TESTING.md):

1. **Bộ Điều Phối Công Việc, Quản Lý Lease (`60s`) / Heartbeat (`15s`) Theo Đồng Hồ DB & Rào Chắn Đơn Điệu ([job-dispatcher.ts](../../packages/api/src/dispatcher/job-dispatcher.ts), [index.mjs](../../packages/dispatcher/index.mjs)):**
   - Thực thi thời hạn thuê bao `CVE_LEASE_DURATION_SECONDS = 60` giây và chu kỳ nhịp tim `CVE_HEARTBEAT_INTERVAL_SECONDS = 15` giây dưới quyền dịch vụ tối thiểu `cve_dispatcher` và phạm vi RLS của từng tenant.
   - Tuân thủ nghiêm ngặt quy định **AMB-009**: toàn bộ các mốc thời gian `lease_expires_at`, `heartbeat_at`, `started_at`, `ended_at` và kiểm tra hết hạn đều lấy từ đồng hồ máy chủ cơ sở dữ liệu (`getDbNow()`), hoàn toàn miễn nhiễm với đồng hồ cục bộ bị lệch của worker (`workerLocalTime`).
   - Mỗi khi cấp phát công việc (`claimNextJob`), thu hồi lease hết hạn (`reclaimExpiredLeases`), xử lý lỗi lần thử (`failOrRetryAttempt`) hoặc hoàn tất hủy (`cancel_requested -> canceled`), cột `lease_epoch` trên bảng `jobs` được tăng đơn điệu (`lease_epoch = lease_epoch + 1`).
   - Mọi lệnh `renewLease`, `advanceJobStage` và `publishJobAttempt` đều kiểm tra điều kiện rào chắn nguyên tử `(id = job_id AND active_attempt_id = attempt_id AND lease_epoch = expected_epoch AND lease_expires_at > db_now)`. Khi worker bị mất kết nối hoặc treo quá hạn lease và bị reaper thu hồi, mọi thao tác tiếp theo của worker cũ đều trả về `0` dòng cập nhật (`shouldAbortWorker: true`, `reason: 'STALE_LEASE_OR_EPOCH'`) và tuyệt đối không thể ghi đè trạng thái công việc hoặc xuất bản artifact (`stale worker không publish`).

2. **Bộ Lập Lịch Công Bằng Đa Tenant & Điều Phối Ưu Tiên Preview/Render ([job-dispatcher.ts](../../packages/api/src/dispatcher/job-dispatcher.ts)):**
   - **Round-Robin giữa các tenant & FIFO trong từng tenant:** Lựa chọn tenant kế tiếp theo vòng tròn xoay vòng dựa trên con trỏ `lastDispatchedTenantId`, đảm bảo một tenant gửi hàng loạt công việc (`noisy tenant`) không thể chặn các tenant gửi ít công việc (`quiet tenant`); bên trong mỗi tenant, các công việc được lấy theo thứ tự `created_at ASC, id ASC`.
   - **Giới hạn khe thực thi đồng thời mỗi tenant:** Tuân thủ giới hạn `active_job_slots_max = 2` trên từng tenant và `maxGlobalSlots` trên toàn hệ thống.
   - **Trọng số ưu tiên `2:1` giữa Preview và Render kèm trần `<= 50%` khe Preview toàn cục:** Khi cả `preview` và `render` đều đang chờ trong hàng đợi (`queued`), bộ lập lịch điều phối theo nhịp `[preview, preview, render]` (`2:1`), nhưng áp trần số lượng `preview` đang chạy (`active`) không bao giờ vượt quá `Math.floor(maxGlobalSlots * 0.5)` khi `maxGlobalSlots >= 2` và có `render` đang chờ — đảm bảo phản hồi nhanh cho preview mà không bao giờ gây đói (starvation) hay chiếm quyền (preempt) công việc render.

3. **Worker Kết Xuất Thực (Real Renderer), Đóng Gói Faststart MP4 & Lưu Trữ Tạm Theo Lần Thử ([renderer-worker.ts](../../packages/api/src/dispatcher/renderer-worker.ts), [quarantine-store.ts](../../packages/api/src/assets/quarantine-store.ts)):**
   - Triển khai `RealRendererWorker` thực thi quy trình 4 giai đoạn hoạt động (`preparing -> rendering -> encoding -> verifying`) trước khi gọi giao dịch xuất bản nguyên tử (`verifying -> succeeded`):
     - `preparing`: Biên dịch bản chụp `CompositionSpec` bất biến của công việc bằng `compileComposition` từ `@creativanta/contracts` và xác định độ phân giải đầu ra (`1280x720` / `720x1280` cho `mp4-720p-v1`; `640x360` / `360x640` cho `preview-360p-v1`).
     - `rendering`: Đánh giá trạng thái từng khung hình theo thời gian hữu tỷ qua `evaluateFrame`, kết xuất các lớp (`shape`, `text`, `image`, `video`, `svg`) và phụ đề đốt sẵn (`burn_in` subtitles) ra bộ đệm điểm ảnh RGBA 8-bit và ảnh PNG không suy hao, đồng thời tổng hợp các kênh âm thanh stereo `48000 Hz`.
     - `encoding`: Đóng gói luồng video H.264 (`avc1`/`avcC`, không gian màu BT.709 `colr`) và âm thanh AAC (`mp4a`/`esds` 48kHz stereo) thành tệp `.mp4` chuẩn ISO-BMFF có bố cục `faststart` (`ftyp`, `moov` đặt trước `mdat`), tạo ảnh thu nhỏ `thumbnail.png` và tệp đặc tả `manifest.json`. Toàn bộ tệp đầu ra ứng viên chỉ được ghi vào thư mục tạm cô lập theo `attempt_id`: `temp/tenant/<tenantId>/job/<jobId>/<attemptId>/`.
     - `verifying`: Giải mã và kiểm tra toàn diện cấu trúc hộp ISO-BMFF (`verifyIsoBmffMp4`) hoặc PNG (`verifyPngBuffer`), xác minh `moov < mdat`, số lượng khung hình khớp tuyệt đối, chuỗi thời gian hiển thị (PTS) tăng đơn điệu, và độ lệch thời lượng âm thanh/hình ảnh `<= 1` khung hình.

4. **Máy Trạng Thái Công Việc/Lần Thử/Sự Kiện, Lịch Thử Lại & Bảo Vệ Thu Hồi Tài Nguyên ([job-dispatcher.ts](../../packages/api/src/dispatcher/job-dispatcher.ts), [repository.ts](../../packages/api/src/db/repository.ts)):**
   - Ghi nhận đầy đủ từng lần thực thi vào `job_attempts` (`attempt_id`, `lease_epoch`, `worker_id`, `state`, `started_at`, `heartbeat_at`, `lease_expires_at`, `ended_at`, `cpu_seconds`, `peak_rss_bytes`, `error_json`) và chuỗi sự kiện tăng đơn điệu `event_seq` vào `job_events`.
   - Phân loại chính xác 13 mã lỗi chuẩn (`5` mã cho phép thử lại: `RENDER_TIMEOUT`, `FRAME_READINESS_TIMEOUT`, `WORKER_LOST`, `STORAGE_TRANSIENT_ERROR`, `INTERNAL_WORKER_ERROR`; `8` mã dừng ngay: `SANDBOX_RESOURCE_LIMIT`, `SANDBOX_SECURITY_VIOLATION`, `MEDIA_DECODE_FAILED`, `ENCODE_VERIFICATION_FAILED`, `TEXT_OVERFLOW`, `MISSING_GLYPH`, `ASSET_REVOKED`, `JOB_DEADLINE_EXCEEDED`).
   - Áp dụng lịch chờ thử lại chuẩn (`5s` sau lần thử 1, `30s + jitter` sau lần thử 2, tối đa `max_attempts = 3`), giữ nguyên khe công việc và `usage_reservations` ở trạng thái `reserved` trong suốt thời gian `retry_wait` theo **AMB-004**, và tự động hoàn tất hủy (`cancel_requested -> canceled`) khi reaper thu hồi lease hết hạn theo **AMB-003**.
   - Kiểm tra lại trạng thái toàn bộ tài nguyên đầu vào ngay trong giao dịch xuất bản (`publishJobAttempt`); nếu bất kỳ tài nguyên nào đã bị xóa/thu hồi (`ASSET_REVOKED`), giao dịch lập tức từ chối xuất bản, xóa thư mục tạm của lần thử và chuyển công việc sang trạng thái `failed` (`ASSET_REVOKED`).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build` | `0` | `PASS` | Biên dịch TypeScript toàn bộ 7 packages trong workspace thành công |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript (`tsc --noEmit`) trên toàn bộ workspace không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm lint` | `0` | `PASS` | Kiểm tra quy chuẩn mã nguồn tĩnh trên toàn bộ workspace |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH node --test packages/api/test/p4-02-dispatcher-and-worker.test.mjs` | `0` | `PASS` | Toàn bộ 6 ca kiểm thử tích hợp, lập lịch công bằng, kết xuất thực và rào chắn stale worker của P4-02 đạt 100% |
| 5 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm --filter @creativanta/api test` | `0` | `PASS` | Toàn bộ 189 tests / 52 suites trong `@creativanta/api` (P3-01..P3-05, P4-01, P4-02, server) đều đạt |
| 6 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên tất cả các packages trong monorepo |
| 7 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận `/healthz`, `/readyz`, cấu hình adapter và khả năng engine |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra tính toàn vẹn tài liệu, liên kết nội bộ, khối JSON và DAG nhiệm vụ |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p4-02` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P4-02`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P4-02` hoàn tất, nhiệm vụ tiếp theo trong giai đoạn `P4` là `P4-03` (Output Artifact Finalization, Usage Settlement & Signed Webhook Delivery).
