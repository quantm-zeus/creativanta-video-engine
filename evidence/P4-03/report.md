# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-03

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-03` (`C+B / P4` — Cancel/Timeout/Retry/Reaper, Object Temp Verification, Atomic Publication, Kill Tests & Race Stabilization): Triển khai toàn diện cơ chế hủy công việc (`POST /v1/jobs/{id}/cancel`), dừng nhóm tiến trình worker trong `<= 10s` và thu hồi qua Reaper (`cancel_requested -> canceled` theo `AMB-003`), thực thi bộ giới hạn thời gian chuẩn (`FRAME_READINESS_TIMEOUT` `5,000 ms`, `RENDER_TIMEOUT` `600s` cho render / `120s` cho preview, `JOB_DEADLINE_EXCEEDED` `1800s` cho render / `300s` cho preview trên cả trạng thái `queued`, `retry_wait` lẫn các bước thực thi đang chạy), lịch thử lại chuẩn (`5s`, `30s + jitter`, tối đa `max_attempts = 3`) cho 5 mã lỗi cho phép thử lại và dừng ngay cho 8 mã lỗi không thử lại, kiểm định nghiêm ngặt tệp tạm theo phạm vi `attempt_id` (tệp thường `isFile()`, cấm symlink/hardlink `nlink === 1`, kiểm tra `realpath` nằm trong thư mục tạm, đối chiếu kích thước byte, hạn ngạch tạm `8 GiB`/attempt, băm `SHA-256`, magic bytes và cấu trúc container ISO-BMFF `faststart` MP4 / PNG / JSON / VTT) trước khi xuất bản nguyên tử (`.tmp` + `renameSync`) kèm cơ chế hoàn tác tệp đích nếu giao dịch cơ sở dữ liệu thất bại, kiểm thử `SIGKILL` ở mọi giai đoạn (`preparing`, `rendering`, `encoding`, `verifying`, `before_publish`, `cancel_requested`), ổn định tranh chấp đồng thời `cancel-vs-success` và `asset-revoke-vs-publish`, và bộ dọn rác thư mục tạm mồ côi (`> 24h`) bảo vệ tuyệt đối đầu ra của các lease đang sống (`don't delete live lease output`), tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-03
Base / tested commit: d969ec66263d6f34b2963e46e4763df6ed2255f7 / HEAD (agy/p4-03 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:zlib & node:http), pnpm 10.6.1, TypeScript 5.8.2, Python 3.11.2
Command: pnpm build && pnpm typecheck && pnpm lint && pnpm --filter @creativanta/api test && pnpm test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T17:57:10Z / 23.9s (P4-03 suite), 203.1s (full monorepo suite)
Artifacts:
  - packages/api/src/assets/quarantine-store.ts, sha256=cd83e7c1bc6dc40020a01f981a19a8976228ef4400aed6228049f7c309df7295, expires=N/A (repo-versioned)
  - packages/api/src/storage/sweeper.ts, sha256=0671e6d9bdad721740714c241d8d3a708776e9bb89a97f4155d6fa52190e21fe, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/job-dispatcher.ts, sha256=726536acc0a998dfe26086d6a0e3a3c9d941bd49dae86e3119b9f3d544a2248b, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/renderer-worker.ts, sha256=68e0cbf6f7865ada3ed185c57be73b2e1f2e24eed18fe706fad72cf8c15f9799, expires=N/A (repo-versioned)
  - packages/api/src/dispatcher/index.ts, sha256=8f9a3a6dfaec7a073e813e1f3cc66fef3e31fb36be0c575fbce71594409cc858, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=4fa68cbebc16f4f6d670c4a291e33438a6ead932a75f41afe5fd67640b4cb395, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=14def78e0acd908eba84f8accd2fa10843b8d18ddd729e5eb6251c4e229d3435, expires=N/A (repo-versioned)
  - packages/dispatcher/index.mjs, sha256=9a548d8044fa8a1e6fc1f066ed416ea4b09191deb72422a8d091835f0eb9cefc, expires=N/A (repo-versioned)
  - packages/api/test/p4-03-cancel-timeout-retry-reaper-races.test.mjs, sha256=baa5f8b66601ee6be8dcf3f34cd094163be8a477446523aa5a9104846112e4d5, expires=N/A (repo-versioned)
  - evidence/P4-03/summary.json, sha256=39a6a9d66ccc3f430a51486beb56ff82751c154c124bedbd2c131459afbfb0ae, expires=N/A (repo-versioned)
Acceptance mapping:
  - Cancel / timeout / retry / reaper: PASS — `POST /v1/jobs/{id}/cancel` hủy ngay công việc ở `queued` / `retry_wait` (`202` sang `canceled`), đánh dấu `cancel_requested` (`202`) cho công việc đang thực thi và dừng nhóm tiến trình worker trong `<= 10s` (`CVE_CANCEL_KILL_TIMEOUT_MS = 10_000`) hoặc được Reaper thu hồi sang `canceled` (`AMB-003`), trả về `200 OK` cho công việc đã `canceled` và `409 JOB_TERMINAL` cho công việc đã `succeeded` / `failed`. Thực thi đầy đủ `FRAME_READINESS_TIMEOUT` (`5,000 ms`), `RENDER_TIMEOUT` (`600s` render / `120s` preview), `JOB_DEADLINE_EXCEEDED` (`1800s` render / `300s` preview trên cả `queued`, `retry_wait` và active states), cùng lịch thử lại `5s`, `30s + jitter`, `max_attempts = 3` cho 5 mã lỗi retryable và dừng ngay cho 8 mã lỗi non-retryable.
  - Object temp verification & atomic publication: PASS — Mọi tệp đầu ra của worker bắt buộc ghi vào đường dẫn tạm do máy chủ sinh theo phạm vi lần thử `temp/tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>`. Trước khi quảng bá, `verifyAttemptTempArtifact` xác minh bằng `lstatSync` tệp tồn tại, là tệp thường (`isFile()`), không phải symlink (`!isSymbolicLink()`), không có đa liên kết cứng (`nlink === 1`), `realpathSync` nằm gọn trong thư mục tạm, kích thước byte khớp chính xác, tổng dung lượng tạm của lần thử `<= 8 GiB`, mã băm `SHA-256` khớp chính xác, và cấu trúc container hợp lệ (MP4 ISO-BMFF `faststart` `moov < mdat`, PNG IHDR/IDAT/IEND, JSON manifest, WebVTT). Quảng bá thực hiện nguyên tử qua tệp ẩn `.tmp` + `fs.renameSync` sang `tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>` và tự động hoàn tác (xóa tệp đích) nếu giao dịch cơ sở dữ liệu gặp lỗi.
  - Kill tests across all stages: PASS — Kiểm thử tiêm lỗi `SIGKILL` đột ngột tại từng giai đoạn `preparing`, `rendering`, `encoding`, `verifying`, `before_publish` và khi đang ở `cancel_requested` chứng minh không có bất kỳ bản ghi `artifacts`, `usage_entries` tính phí (`billable`) hay `outbox` nào bị rò rỉ một phần; Reaper (`runReaperCycle` / `reclaimExpiredLeases`) thu hồi lease hết hạn, tăng đơn điệu `lease_epoch`, dọn sạch thư mục tạm của lần thử bị chết, ghi nhận `cpu_seconds` vận hành (`operational`), chuyển công việc sang `retry_wait` (hoặc `canceled` nếu `cancel_requested`), chặn hoàn toàn worker zombie cũ và hoàn tất thành công ở lần thử kế tiếp.
  - Cancel-vs-success & asset-revoke-vs-publish races stable: PASS — Chạy 20 vòng lặp tranh chấp đồng thời cho mỗi cặp `POST /v1/jobs/{id}/cancel` vs `publishJobAttempt` và `DELETE /v1/assets/{id}` vs `publishJobAttempt`, chứng minh tính loại trừ tương hỗ tuyệt đối: nếu `cancel` thắng trước khi commit xuất bản thì công việc ở `canceled` (`released` reservation, `0` artifacts, `0` billable entries, `1` `job.canceled` outbox, lệnh cancel tiếp theo trả `200 OK`); nếu `publish` thắng trước thì công việc ở `succeeded` (`settled` reservation, `3` artifacts, `1` billable + `1` operational entry, `1` `job.succeeded` outbox, lệnh cancel tiếp theo trả `409 JOB_TERMINAL`, lệnh xóa asset sau đó không làm hỏng job đã `succeeded`). Đồng thời chứng minh công việc đã ở `cancel_requested` miễn nhiễm với `ASSET_REVOKED` (`AMB-003`) và luôn kết thúc ở `canceled`.
  - No orphan leak & live-lease-safe temp sweeper: PASS — Thư mục tạm `temp/tenant/<tenantId>/job/<jobId>/<attemptId>/` được dọn sạch ngay sau mọi lần xuất bản thành công, lỗi lần thử, hủy công việc, thu hồi tài nguyên hoặc Reaper thu hồi lease; đồng thời `StorageTempSweeper.sweep()` quét và xóa các thư mục tạm mồ côi quá hạn `> 24h` trong khi đối chiếu `repository.getLiveLeasedAttemptKeys(now)` để tuyệt đối không bao giờ xóa tệp tạm của các lease đang hoạt động (`don't delete live lease output`).
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-03** (`Stream C+B / Phase P4`) hoàn thiện vòng đời độ tin cậy của bộ điều phối công việc, hệ thống lưu trữ tạm theo lần thử và giao dịch xuất bản nguyên tử theo đúng đặc tả tại [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/API.md](../../docs/API.md), [docs/SECURITY.md](../../docs/SECURITY.md) và [docs/TESTING.md](../../docs/TESTING.md):

1. **Vòng Đời Hủy (`Cancel`), Giới Hạn Thời Gian (`Timeouts`), Thử Lại (`Retries`) & Bộ Thu Hồi (`Reaper`) ([job-dispatcher.ts](../../packages/api/src/dispatcher/job-dispatcher.ts), [renderer-worker.ts](../../packages/api/src/dispatcher/renderer-worker.ts), [repository.ts](../../packages/api/src/db/repository.ts)):**
   - **Hủy công việc (`POST /v1/jobs/{id}/cancel`):**
     - Với công việc ở `queued` hoặc `retry_wait`: chuyển ngay lập tức sang `canceled` (`202 Accepted`), tăng `lease_epoch`, giải phóng `usage_reservations` (`state = 'released'`), phát sự kiện `job.canceled` vào `job_events` và `outbox`, giữ nguyên các bản ghi `cpu_seconds` vận hành (`operational`) của những lần thử trước và đảm bảo `0` bản ghi tính phí (`billable`).
     - Với công việc đang chạy (`preparing`, `rendering`, `encoding`, `verifying`): chuyển sang `cancel_requested` (`202 Accepted`). Khi worker phát hiện trạng thái `cancel_requested` qua nhịp tim hoặc chuyển bước, worker dừng nhóm tiến trình con trong `<= 10s` (`CVE_CANCEL_KILL_TIMEOUT_MS = 10_000`), xóa thư mục tạm của lần thử và hoàn tất chuyển sang `canceled`. Nếu worker bị treo hoặc bị giết đột ngột (`SIGKILL`) khi đang ở `cancel_requested`, Reaper (`reclaimExpiredLeases` / `runReaperCycle`) tự động thu hồi và chuyển công việc sang `canceled` (không bao giờ sang `retry_wait` hay `failed` theo **AMB-003**).
     - Ngữ nghĩa bất biến (idempotent): gọi lại với cùng `Idempotency-Key` trả lại đúng mã `202` đã lưu; gọi với khóa mới trên công việc đã `canceled` trả về `200 OK`; gọi trên công việc đã `succeeded` hoặc `failed` trả về `409 Conflict` (`JOB_TERMINAL`).
   - **Hệ thống giới hạn thời gian chuẩn (`Timeouts`):**
     - `CVE_FRAME_TIMEOUT_MS = 5_000`: giới hạn thời gian kết xuất mỗi khung hình `<= 5,000 ms`; nếu vượt quá sẽ ném mã lỗi cho phép thử lại `FRAME_READINESS_TIMEOUT`.
     - `CVE_RENDER_TIMEOUT_SECONDS = 600` & `CVE_PREVIEW_TIMEOUT_SECONDS = 120`: giới hạn thời gian thực thi mỗi lần thử (`attempt`); nếu vượt quá sẽ ném mã lỗi cho phép thử lại `RENDER_TIMEOUT`.
     - `CVE_JOB_DEADLINE_SECONDS = 1800` (render) & `CVE_PREVIEW_DEADLINE_SECONDS = 300` (preview): giới hạn thời hạn toàn cục của công việc (`deadline_at`), được kiểm tra cả khi đang chờ ở `queued` / `retry_wait` (`reapExpiredQueuedJobs` & `claimNextJob`) lẫn khi đang chạy (`renewLease`, `advanceJobStage`, `failOrRetryAttempt`, `publishJobAttempt`); nếu quá hạn sẽ chuyển thẳng sang trạng thái kết thúc `failed` với mã lỗi không thử lại `JOB_DEADLINE_EXCEEDED`.
   - **Phân loại thử lại và bộ thu hồi Reaper:**
     - Áp dụng lịch chờ `5,000 ms` sau lần thử 1, `30,000 ms + jitter (0..2,000 ms)` sau lần thử 2, tối đa `max_attempts = 3` cho đúng 5 mã lỗi cho phép thử lại (`RENDER_TIMEOUT`, `FRAME_READINESS_TIMEOUT`, `WORKER_LOST`, `STORAGE_TRANSIENT_ERROR`, `INTERNAL_WORKER_ERROR`), và dừng ngay ở lần thử đầu tiên (`attempt_count = 1`) đối với 8 mã lỗi không thử lại (`SANDBOX_RESOURCE_LIMIT`, `SANDBOX_SECURITY_VIOLATION`, `MEDIA_DECODE_FAILED`, `ENCODE_VERIFICATION_FAILED`, `TEXT_OVERFLOW`, `MISSING_GLYPH`, `ASSET_REVOKED`, `JOB_DEADLINE_EXCEEDED`).

2. **Kiểm Định Tệp Tạm Theo Phạm Vi `attempt_id` & Xuất Bản Nguyên Tử Có Hoàn Tác ([quarantine-store.ts](../../packages/api/src/assets/quarantine-store.ts), [job-dispatcher.ts](../../packages/api/src/dispatcher/job-dispatcher.ts)):**
   - `verifyAttemptTempArtifact` kiểm tra nghiêm ngặt từng tệp ứng viên trong `temp/tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>` trước khi quảng bá:
     - Kiểm tra `fs.lstatSync`: tệp phải tồn tại, là tệp thường (`isFile()`), cấm liên kết mềm (`!isSymbolicLink()`), cấm đa liên kết cứng (`nlink === 1`), và đường dẫn thực (`fs.realpathSync`) phải nằm bên trong thư mục tạm của lần thử.
     - Kiểm tra kích thước byte thực tế khớp với `expectedBytes`, không rỗng (`> 0`), và tổng dung lượng tạm của lần thử không vượt quá `DEFAULT_MAX_ATTEMPT_TEMP_BYTES` (`8 GiB`).
     - Tính toán và đối chiếu mã băm `SHA-256` trên đĩa khớp tuyệt đối với `expectedSha256`.
     - Kiểm tra chữ ký byte đầu (magic bytes) và cấu trúc container theo từng loại artifact: kiểm định hộp ISO-BMFF `ftyp`/`moov`/`mdat` với `moov < mdat` (`faststart`) cho video `.mp4`, kiểm định chữ ký PNG + `IHDR`/`IDAT`/`IEND` cho ảnh `.png`, kiểm định cấu trúc JSON hợp lệ cho `manifest.json`, và tiêu đề `WEBVTT` cho phụ đề `.vtt`.
   - `promoteAttemptArtifactToPermanent` ghi tệp vào đường dẫn ẩn `.tmp` cùng thư mục đích rồi thực hiện `fs.renameSync` nguyên tử sang `tenant/<tenantId>/job/<jobId>/<attemptId>/<filename>`. Nếu bất kỳ bước cập nhật cơ sở dữ liệu nào trong giao dịch `publishJobAttempt` gặp lỗi sau khi tệp đã được quảng bá, khối `catch` tự động gọi `removePermanentArtifactByStorageKey` để thu hồi toàn bộ các tệp đích vừa tạo, đảm bảo không bao giờ tồn tại tệp xuất bản mồ côi khi DB rollback.

3. **Kiểm Thử Giết Tiến Trình (`SIGKILL`) Ở Mọi Giai Đoạn, Ổn Định Tranh Chấp (`Races`) & Dọn Rác Không Rò Rỉ ([p4-03-cancel-timeout-retry-reaper-races.test.mjs](../../packages/api/test/p4-03-cancel-timeout-retry-reaper-races.test.mjs), [sweeper.ts](../../packages/api/src/storage/sweeper.ts)):**
   - **Kill tests ở mọi giai đoạn (`preparing`, `rendering`, `encoding`, `verifying`, `before_publish`, `cancel_requested`):** Chứng minh khi worker chết đột ngột ở bất kỳ giai đoạn nào (kể cả ngay sau khi đã ghi xong toàn bộ tệp tạm `.mp4`, `.png`, `manifest.json` trước bước publish), không có bất kỳ artifact hay bản ghi tính phí nào bị xuất bản dở dang; Reaper thu hồi lease hết hạn, tăng `lease_epoch`, xóa sạch thư mục tạm của lần thử chết, chặn worker zombie cũ và cho phép lần thử mới hoàn tất sạch sẽ.
   - **Ổn định tranh chấp `cancel-vs-success` và `asset-revoke-vs-publish`:** Kiểm thử 20 vòng lặp tranh chấp cho mỗi kịch bản chứng minh tính loại trừ tương hỗ tuyệt đối giữa giao dịch hủy/thu hồi tài nguyên và giao dịch xuất bản.
   - **Không rò rỉ tệp tạm (`no orphan leak`) & bảo vệ lease đang sống:** Tích hợp `sweepOrphanAttemptTempDirs` cùng `repository.getLiveLeasedAttemptKeys(now)` vào `StorageTempSweeper.sweep()`, đảm bảo xóa sạch các thư mục tạm mồ côi `> 24h` nhưng tuyệt đối bảo vệ thư mục tạm của mọi công việc đang có lease hợp lệ (`don't delete live lease output`).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `pnpm build` | `0` | `PASS` | Biên dịch TypeScript toàn bộ 7 packages trong workspace thành công |
| 2 | `pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript (`tsc --noEmit`) trên toàn bộ workspace không có lỗi |
| 3 | `pnpm lint` | `0` | `PASS` | Kiểm tra quy chuẩn mã nguồn tĩnh trên toàn bộ workspace |
| 4 | `node --test packages/api/test/p4-03-cancel-timeout-retry-reaper-races.test.mjs` | `0` | `PASS` | Toàn bộ 7 ca kiểm thử tích hợp Cancel/Timeout/Retry/Reaper, kiểm định tệp tạm, xuất bản nguyên tử, kill tests mọi giai đoạn, tranh chấp đồng thời và sweeper của P4-03 đạt 100% |
| 5 | `pnpm --filter @creativanta/api test` | `0` | `PASS` | Toàn bộ 196 tests / 53 suites trong `@creativanta/api` (P3-01..P3-05, P4-01, P4-02, P4-03, server) đều đạt |
| 6 | `pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên tất cả các packages trong monorepo đều đạt 100% |
| 7 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận `/healthz`, `/readyz`, cấu hình adapter và khả năng engine |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra tính toàn vẹn tài liệu, liên kết nội bộ, khối JSON và DAG nhiệm vụ |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p4-03` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P4-03`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P4-03` hoàn tất, các nhiệm vụ tiếp theo trong giai đoạn `P4`/`P5` (như `P4-04` — Signed Webhook Delivery, Outbox Sender, Usage Ledger & Artifact Download Grants) sẵn sàng triển khai theo kế hoạch.
