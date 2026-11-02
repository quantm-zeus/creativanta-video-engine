# Evidence report — Task P0-05

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P0-05: Thiết lập task ledger, worktree policy, evidence template và kiểm thử recovery bằng synthetic task state** thuộc stream Supervisor trong repository `creativanta-video-engine`. [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) là chuẩn đối chiếu backlog; [AGY execution](../../docs/AGENTS.md), [Security](../../docs/SECURITY.md) và [Testing](../../docs/TESTING.md) quy định tiêu chuẩn vận hành, bảo mật và bằng chứng nghiệm thu.

## Bằng chứng thực thi (Evidence Template)

```text
Task: P0-05
Base / tested commit: 704e03ef5410f94116d3652f5671d7afb7ef2b95 / 704e03ef5410f94116d3652f5671d7afb7ef2b95
Environment: Linux 6.6.137+ x86_64, Debian/Ubuntu container environment, Python 3.11.2 (/usr/bin/python3), SQLite 3.40.1 (WAL enabled)
Command: PATH=/usr/bin:$PATH python3 evidence/P0-05/task_ledger.py && PATH=/usr/bin:$PATH python3 -m unittest discover -s evidence/P0-05 -p "test_*.py" -v && PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-02T14:17:32Z / 2.1s
Artifacts:
  - evidence/P0-05/task_ledger.py, sha256=06227dff676191a09cd8c5ad9e562be2ac924cfa0696db84b63f53127a4b994f, expires=N/A (repo-versioned)
  - evidence/P0-05/test_task_ledger.py, sha256=c649d6d952e1fd07e035c7462164b97ea5ea65ba6e58c174547bac91d798136e, expires=N/A (repo-versioned)
  - evidence/P0-05/recovery-drill.json, sha256=af1e5c55b20d59562f31a0259b5aa6f049fa96ba0de4df8cbc203ddcdc1494c5, expires=N/A (repo-versioned)
  - evidence/P0-05/evidence-template.md, sha256=20af6a3eb34391e63c587f2e53e1be65d3b163bb84e4a55d504f26c43ca0328a, expires=N/A (repo-versioned)
Acceptance mapping:
  - Thiết lập task ledger theo AGENTS: PASS — Hiện thực hóa SQLite WAL ledger (.agy/state.sqlite) với đầy đủ 8 bảng chuẩn (tasks, dependencies, leases, file_claims, runs, evidence, reviews, events) + supervisor_meta, import 52 tasks, kiểm tra DAG acyclic, atomic claim và lease_epoch fencing.
  - Thiết lập worktree policy theo AGENTS: PASS — Thực thi kiểm tra .worktrees/<task-id>-<run-id>, nhánh agy/<task-id>-<slug>, chặn sửa main/root checkout, chặn lệnh git phá hủy (reset --hard, clean -fd, checkout --force, push --force), chặn xóa worktree bẩn và kiểm tra phạm vi file allowed_paths/file_claims.
  - Thiết lập evidence template theo AGENTS: PASS — Chuẩn hóa khuôn mẫu tại evidence/P0-05/evidence-template.md và trình xác thực tự động EvidenceValidator kiểm tra 9 trường bắt buộc, mã thoát, sha256 và không rò rỉ bí mật.
  - Thử recovery bằng synthetic task state: PASS — Thực thi diễn tập crash/reboot thực tế (evidence/P0-05/recovery-drill.json): bảo toàn file chưa commit trong worktree, reattach worker còn sống đúng (boot_id, pid, start_time, run_id), thu hồi lease hết hạn với tăng fence lease_epoch (1 -> 2 -> 3), chặn zombie worker ghi đè, đánh dấu lệnh dở dang là NOT_RUN, ngắt mạch sau 2 lần lỗi lặp lại và khôi phục từ SQLite backup + replay events.jsonl.
  - Credentials không vào queue/log: PASS — Bộ lọc CredentialSanitizer tự động làm sạch API key, Bearer token, PEM private key, DB password, presigned URL trước khi ghi SQLite và xuất status.json/events.jsonl; quét byte thô trên 6 tệp trạng thái/WAL/backup xác nhận 0 rò rỉ.
Reviewer / reviewed commit / decision: pending independent reviewer / 704e03ef5410f94116d3652f5671d7afb7ef2b95 / local completion awaiting review
```

## 1. Kiến trúc Sổ cái Nhiệm vụ Bền vững (SQLite WAL Task Ledger)

Theo quy định tại [AGY execution](../../docs/AGENTS.md), nhiệm vụ `P0-05` chấm dứt giai đoạn ngoại lệ bootstrap để chuyển sang sổ cái trạng thái bền vững `.agy/state.sqlite` (chế độ `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, khóa đơn thể `.agy/supervisor.lock` qua `fcntl.flock`). Các tệp trạng thái thời gian chạy trong `.agy/` được cấu hình ignore trong `.gitignore`, trong khi mã nguồn thực thi, bộ kiểm thử và bằng chứng diễn tập được lưu giữ có kiểm soát phiên bản tại [task_ledger.py](task_ledger.py), [test_task_ledger.py](test_task_ledger.py), [recovery-drill.json](recovery-drill.json) và [evidence-template.md](evidence-template.md).

### 1.1. Lược đồ 8 bảng bắt buộc và bảng siêu dữ liệu Supervisor

| Tên bảng | Khóa chính & Ràng buộc | Vai trò chuẩn tắc theo `docs/AGENTS.md` |
| --- | --- | --- |
| `tasks` | `task_id PRIMARY KEY`, `CHECK (state IN ('planned','ready','claimed','running','verifying','review','done','blocked','canceled'))` | Lưu trạng thái hiện hành, `state_version`, `owner`, `run_id`, `lease_epoch` (fencing token), `lease_expires_at`, `base_commit`, `branch`, `worktree`, `allowed_paths_json`, `acceptance_ref`, `heartbeat_at`, `attempts`, `blocker_json`. |
| `dependencies` | `PRIMARY KEY (task_id, depends_on_task_id)` | Lưu đồ thị phụ thuộc DAG giữa 52 nhiệm vụ; hàm `validate_dag_acyclic()` kiểm tra chống chu trình trước mọi giao dịch cập nhật. |
| `leases` | `task_id PRIMARY KEY` | Lưu thông tin cấp phát lease cho worker: `run_id`, `lease_epoch`, `boot_id`, `worker_pid`, `process_start_time`, `acquired_at`, `heartbeat_at`, `expires_at` (`+600s`), `grace_expires_at` (`+720s`), `status`. |
| `file_claims` | `path_prefix PRIMARY KEY` | Khóa phạm vi đường dẫn đang được worker nắm giữ; ngăn chặn hai nhiệm vụ song song sửa trùng file hoặc thư mục con chồng lấn (`paths_overlap`). |
| `runs` | `run_id PRIMARY KEY` | Lịch sử từng lần thử (`attempt_number`), `lease_epoch`, thông tin tiến trình, lệnh kiểm tra gần nhất (`last_command`, `last_exit_code`, `last_result`), `checkpoint_json` và `failure_signature`. |
| `evidence` | `evidence_id PRIMARY KEY` | Lưu trữ bản ghi bằng chứng đã xác thực (`base_commit`, `tested_commit`, `report_path`, `artifact_paths_json`, `commands_json`, `result`, `sha256`). |
| `reviews` | `review_id PRIMARY KEY` | Lưu quyết định của reviewer độc lập (`approved`, `changes_requested`, `blocked`, `pending`) gắn chặt với `reviewed_commit`. |
| `events` | `event_seq INTEGER PRIMARY KEY AUTOINCREMENT`, `event_id UNIQUE` | Nhật ký sự kiện bất biến ghi trong cùng giao dịch chuyển trạng thái; dùng để xuất `.agy/events.jsonl` và replay khi khôi phục. |
| `supervisor_meta` | `singleton_id = 1` | Ghi nhịp tim của supervisor mỗi 30s gồm `boot_id`, `pid`, `run_id`, `heartbeat_at` và `last_queue_mutation`. |

### 1.2. Hiện thực hóa (Materialization) 52 nhiệm vụ từ Bootstrap

Khi thực thi `materialize_from_backlog()`, sổ cái nhập toàn bộ 52 nhiệm vụ từ [P0-01 backlog snapshot](../P0-01/backlog.json), đối chiếu với các nhiệm vụ bootstrap đã tích hợp kèm báo cáo bằng chứng và mã băm SHA-256 thực tế:
- Nhiệm vụ đã hoàn tất tích hợp (`done`): `P0-01` ([P0-01 report](../P0-01/report.md)), `P0-02` ([P0-02 report](../P0-02/report.md)), `P0-04` ([P0-04 report](../P0-04/report.md)).
- Nhiệm vụ tự động mở khóa sang `ready` nhờ đủ điều kiện phụ thuộc: `P0-03` (phụ thuộc `P0-01`) và `P0-05` (phụ thuộc `P0-04`).
- Nhiệm vụ ở trạng thái `planned` chờ phụ thuộc: 47 nhiệm vụ (`P1-01` đến `P9-05`).
- Bản sao lưu trực tuyến nhất quán được tạo bằng SQLite Backup API (`sqlite3.Connection.backup`) tại `.agy/backups/state-p0-05-bootstrap-20261102T140000Z.sqlite`.

---

## 2. Chính sách Worktree, Giao dịch Claim Nguyên tử và Khuôn mẫu Evidence

### 2.1. Thực thi chính sách Worktree (`WorktreePolicy`)

Class `WorktreePolicy` trong [task_ledger.py](task_ledger.py) kiểm soát chặt chẽ các bất biến về nhánh và thư mục làm việc:
1. **Cô lập thư mục làm việc và nhánh:** Mỗi nhiệm vụ/lần chạy có một worktree riêng biệt tại `.worktrees/<task-id>-<run-id>` trên nhánh `agy/<task-id>-<slug>`. Mọi nỗ lực sử dụng thư mục gốc của kho chứa hoặc nhánh bảo vệ (`main`, `master`, `staging`, `production`) đều bị từ chối với ngoại lệ `WorktreePolicyError`.
2. **Chặn lệnh Git phá hủy:** Phương thức `validate_git_command()` chặn hoàn toàn các lệnh `git reset --hard`, `git clean -fd`/`-fdx`, `git checkout --force`, `git switch --force`, `git push --force` và `git branch -D`.
3. **Bảo vệ dữ liệu chưa commit:** Phương thức `check_worktree_clean_before_remove()` kiểm tra `git status --porcelain` và từ chối xóa bất kỳ worktree nào còn chứa thay đổi chưa commit hoặc tệp untracked.
4. **Kiểm soát phạm vi tệp (`file_claims` & `allowed_paths`):**
   - Trong giao dịch `BEGIN IMMEDIATE` của `claim_task()`, hệ thống kiểm tra mọi đường dẫn yêu cầu phải nằm trong `allowed_paths` của task và không giao cắt (`paths_overlap`) với bất kỳ `file_claims` đang hoạt động nào của task khác.
   - Khi worker phát hiện cần chỉnh sửa schema/lockfile dùng chung ngoài phạm vi được cấp, hàm `request_scope_change()` chuyển task sang trạng thái `blocked` kèm cấu trúc yêu cầu chuyển quyền sở hữu rõ ràng thay vì tự ý sửa tràn phạm vi.

### 2.2. Khuôn mẫu và Trình xác thực Báo cáo Bằng chứng (`EvidenceValidator`)

Khuôn mẫu chuẩn được tài liệu hóa tại [evidence-template.md](evidence-template.md) và kiểm tra tự động qua `EvidenceValidator.validate_report_markdown()`:
- Bắt buộc đúng 1 tiêu đề `H1` và đầy đủ 9 trường chuẩn tắc của [AGY execution](../../docs/AGENTS.md).
- Chặn khai báo `Result: PASS` khi mã thoát khác `0`.
- Bắt buộc đính kèm mã băm `sha256=<64 hex>` cho artifacts và từ chối báo cáo nếu phát hiện chuỗi nhạy cảm chưa làm sạch.
- Chạy xác thực tự động trên các báo cáo hiện hữu ([P0-01 report](../P0-01/report.md), [P0-02 report](../P0-02/report.md), [P0-04 report](../P0-04/report.md) và báo cáo `P0-05` này) đều đạt `PASS`.

---

## 3. Kết quả Diễn tập Phục hồi sau Sự cố bằng Trạng thái Giả lập (Synthetic Recovery Drill)

Cuộc diễn tập được thực thi tự động trong môi trường cô lập bởi hàm `run_synthetic_recovery_drill()` và xuất kết quả chi tiết tại [recovery-drill.json](recovery-drill.json):

| Kịch bản kiểm thử phục hồi | Thiết lập trạng thái trước sự cố | Hành vi của bộ phục hồi (`recover_after_crash_or_reboot`) | Kết quả kiểm chứng |
| --- | --- | --- | --- |
| **1. Chặn xung đột `file_claims` chồng lấn** | `P0-03` đang giữ claim `docs/OPEN_SOURCE_EVALUATION.md`; worker thứ hai cố claim `P0-05` trên toàn bộ `docs/`. | Giao dịch `claim_task` phát hiện `paths_overlap("docs/", "docs/OPEN_SOURCE_EVALUATION.md")` và rollback. | `PASS` (`overlapping_file_claim_blocked = true`) |
| **2. Thu hồi worker chết sau reboot & bảo toàn worktree bẩn** | `P0-03` ở trạng thái `running` (`run-crash01`, `lease_epoch = 1`, `boot-001-before-crash`), im lặng `750s > 720s` (quá 10m lease + 2m grace), có tệp chưa commit `UNCOMMITTED_DRAFT.md` trong `.worktrees/p0-03-run-crash01`. | Khi supervisor khởi động ở `boot-002-after-reboot`: giữ nguyên tệp `UNCOMMITTED_DRAFT.md`, giải phóng `file_claims`, tăng `lease_epoch` lên `2`, chuyển `P0-03` về `ready` và ghi sự kiện `RECOVERY_CHECKPOINT_AND_RECLAIM`. | `PASS` (`orphaned_task_reclaimed_to_ready = true`, `uncommitted_worktree_edits_preserved = true`, `fenced_epoch = 2`) |
| **3. Đánh dấu lệnh đang chạy dở dang là `NOT_RUN`** | `P0-03` (`run-crash01`) đang thực thi lệnh kiểm tra nhưng bị ngắt khi crash (`last_exit_code = null`). | Không công nhận lệnh dở dang là `PASS`; cập nhật `last_result = 'NOT_RUN'` trên bản ghi `runs` để buộc chạy lại khi reclaim. | `PASS` (`in_flight_marked_not_run = ["P0-03"]`) |
| **4. Chặn worker cũ (zombie) bằng `lease_epoch` fence** | Worker cũ của `P0-03` (`run-crash01`, `lease_epoch = 1`) tỉnh dậy muộn và cố gọi `transition_task(to_state="review")`; sau đó worker mới `worker-gamma` claim lại task. | `_verify_fence_in_tx()` từ chối worker cũ với lỗi `StaleLeaseFenceError` và ghi sự kiện `STALE_WORKER_REJECTED`. Worker mới claim thành công ở `lease_epoch = 3`. | `PASS` (`stale_worker_write_rejected = true`, `fresh_worker_new_lease_epoch = 3`) |
| **5. Gắn kết lại (Reattach) worker còn sống thực sự** | `P0-05` đang `running` (`run-live01`, `lease_epoch = 1`, silence `60s < 90s`), khớp bộ tứ `(boot-002-after-reboot, pid=9202, start_time=1730556100, run-live01)`. | Xác nhận tiến trình còn sống trên cùng `boot_id`, giữ nguyên lease `running` và `run_id`, ghi sự kiện `RECOVERY_REATTACHED`. | `PASS` (`live_task_reattached_running = true`) |
| **6. Đối chiếu commit & bằng chứng đã hoàn tất trước khi crash** | Nhiệm vụ giả lập `SYNTH-01` đã ghi `evidence` đạt `PASS` và có `head_commit` hợp lệ ở trạng thái `verifying` trước khi tiến trình worker tắt đột ngột. | Thay vì bắt làm lại từ đầu, bộ phục hồi tăng fence `lease_epoch` (`1 -> 2`) và chuyển nhiệm vụ sang `review` chờ reviewer độc lập. | `PASS` (`test_reconcile_crashed_worker_with_existing_passing_evidence_to_review`) |
| **7. Ngắt mạch (Circuit Breaker) khi lỗi lặp lại không tiến triển** | Nhiệm vụ thất bại liên tiếp 2 lần (`MAX_NON_PROGRESS_ATTEMPTS = 2`) với cùng chữ ký lỗi `compile_err_ts2322`. | Lần 1 đưa về `ready`; lần 2 tự động chuyển sang `blocked` kèm cấu trúc `{reason, dependency_or_decision_needed, owner, next_check}`. | `PASS` (`test_circuit_breaker_blocks_after_two_identical_failures`) |
| **8. Sao lưu trực tuyến SQLite và khôi phục + replay sự kiện** | Tạo bản sao lưu bằng `sqlite3.Connection.backup()`, giả lập mất DB, khôi phục từ backup và replay `.agy/events.jsonl`. | `PRAGMA integrity_check` đạt `ok`, tái tạo chính xác trạng thái và `lease_epoch`, tuyệt đối không tự bịa trạng thái `done`. | `PASS` (`restored_integrity_check = "ok"`, `no_invented_done_states = true`) |

---

## 4. Kiểm toán Chống Rò rỉ Thông tin Xác thực (Zero Credentials in Queue & Logs)

Class `CredentialSanitizer` trong [task_ledger.py](task_ledger.py) được đặt tại biên ghi của mọi bảng SQLite (`tasks`, `runs`, `evidence`, `reviews`, `events`) và biên xuất bản của `.agy/status.json` cùng `.agy/events.jsonl`:
- **Các mẫu nhạy cảm bị phát hiện và thay thế bằng `[REDACTED]` / `[REDACTED_API_KEY]` / `[REDACTED_PRIVATE_KEY]`:**
  1. Header xác thực `Authorization: Bearer [REDACTED]`, `Authorization: Basic [REDACTED]`.
  2. Khóa API theo mẫu tiền tố (`cve_live_*`, `cve_test_*`, `cve_secret_*`, GitHub tokens, OpenAI/provider keys, AWS access keys).
  3. Khóa riêng tư định dạng PEM (`BEGIN ... PRIVATE KEY`).
  4. Chuỗi kết nối cơ sở dữ liệu/broker có nhúng mật khẩu (`postgres://user:[REDACTED]@host`, `redis://:[REDACTED]@host`).
  5. Chữ ký và token trên URL (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, `X-Goog-Signature`, `Signature`, `token`, `access_token`, `client_secret`, `webhook_secret`).
  6. Các trường từ điển hoặc biến môi trường mang tên khóa nhạy cảm (`password`, `secret`, `api_key`, `private_key`, `webhook_secret`, `signing_secret`).
- **Kiểm chứng quét byte thô trên đĩa (`scan_files_for_canary_leaks`):**
  Trong diễn tập, 5 chuỗi canary đại diện cho API key nội bộ, token kho mã nguồn, khóa provider, mật khẩu PostgreSQL và chữ ký presigned URL đã được tiêm trực tiếp vào `last_command` và `checkpoint` của worker. Sau khi ghi xuống SQLite và xuất snapshots, hàm quét byte thô kiểm tra toàn bộ 6 tệp trên đĩa (`.agy/state.sqlite`, `.agy/state.sqlite-wal`, `.agy/status.json`, `.agy/events.jsonl` và các tệp `.sqlite` backup) xác nhận **`leaks_found_count = 0`** (`zero_credential_leak_verified = true`).

---

## 5. Kết quả Chạy Kiểm thử Thực tế (Verification Commands)

1. **Thực thi diễn tập ledger & tạo tạo phẩm `recovery-drill.json`:**
   ```bash
   PATH=/usr/bin:$PATH python3 evidence/P0-05/task_ledger.py
   ```
   - Exit code: `0` (`status: PASS`, `tasks_materialized: 52`, `zero_credential_leak_verified: true`).
2. **Chạy bộ kiểm thử đơn vị & tích hợp của `P0-05` (`13` test cases):**
   ```bash
   PATH=/usr/bin:$PATH python3 -m unittest discover -s evidence/P0-05 -p "test_*.py" -v
   ```
   - Exit code: `0` (`Ran 13 tests`, `OK`).
3. **Chạy bộ kiểm thử hồi quy của `tooling/agent_harness` (`10` test cases):**
   ```bash
   PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v
   ```
   - Exit code: `0` (`Ran 10 tests`, `OK`).
4. **Chạy trình xác thực toàn diện kho chứa (`validate_repo.py`):**
   ```bash
   PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
   ```
   - Exit code: `0` (`status: PASS`, `errors_count: 0`).

---

## 6. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor mở PR tự động vào nhánh `staging`, chạy GitHub Actions workflow `Validate Video Engine` và reviewer độc lập phê duyệt chuyển trạng thái từ `review` sang `done`.
2. **Prerequisite Task `P0-03`:** Nhiệm vụ `P1-01` (TS workspace + pinned toolchain + local Compose) phụ thuộc vào `P0-02`, `P0-04` và `P0-05` (đã hoàn tất triển khai); các nhiệm vụ `P2-01` và `P3-03` vẫn chờ `P0-03` (Rights manifest cho 3 fixtures) hoàn thành.

## 7. Kết luận

Nhiệm vụ **P0-05** đã hoàn thành đầy đủ mọi hạng mục bàn giao và tiêu chí nghiệm thu trong đúng phạm vi đường dẫn được phép (`evidence/P0-05/` và `docs/`). Trạng thái tại worktree cục bộ là **`implemented_local`**, sẵn sàng cho bước kiểm duyệt độc lập và tích hợp vào nhánh `staging`.
