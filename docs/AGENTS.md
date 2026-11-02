# AGY supervisor — mô hình thực thi sau handoff

Tài liệu mô tả runner/supervisor cần dùng hoặc triển khai ở phiên coding; **không có supervisor chạy trong phiên docs**. [AGENTS gốc](../AGENTS.md) có hiệu lực cao hơn. [Plan](IMPLEMENTATION_PLAN.md) là backlog, [Testing](TESTING.md) là acceptance. AGY Gemini Flash/Argon, Codex, OpenCode, DeepSeek và provider khác là workers pluggable; không bắt model premium hoặc Opus 5.5.

## Vai trò và khởi động

Handoff runner push commit tài liệu và start supervisor bằng quyền đã được cấp riêng. Supervisor đọc base commit, docs, git status, scope và budget; không assume được deploy hay sửa Creativanta. Tối đa 3 workers + supervisor, giảm concurrency khi host thấp hoặc render benchmark cần máy ổn định. Reviewer độc lập có thể là agent khác trong slot rảnh; legal/security sign-off cần người/role có thẩm quyền, không tự gắn nhãn.

Trước worker đầu: kiểm `.agy/`, `.worktrees/`, `.local/` được ignore; mọi state/cache/worktree trong repo. Không cài system services/cron, không sửa `$HOME`, không read secrets của user. Các script supervisor nếu cần là implementation task P0-05/P1, không được tuyên bố đã tồn tại trong docs này.

Bootstrap exception rõ ràng: runner/supervisor làm P0-01 tuần tự bằng execution/evidence log khi durable queue chưa có; P0-02/P0-03/P0-04 cũng chạy tuần tự hoặc dùng queue có sẵn của runner với evidence tương đương. P0-05 materialize/import những trạng thái đó vào SQLite rồi mới bật parallel workers/worktrees. Nếu cần ignore rules trước P1, P0-05 tạo phần tối thiểu rồi P1 hoàn thiện. Không giả queue đã tồn tại để claim task đầu tiên, không spawn workers không có durable ownership.

## Durable queue và state files

Đề xuất SQLite WAL tại `.agy/state.sqlite` là authoritative task store, single supervisor writer; workers gửi events qua local IPC, không tự sửa DB. Export `.agy/status.json` và `.agy/events.jsonl` phục vụ đọc/monitoring, không có secrets/raw prompts/private payload. State files runtime gitignored; compact sanitized evidence vào `evidence/<task-id>/report.md` sau task theo [khuôn mẫu chuẩn P0-05](../evidence/P0-05/evidence-template.md). Không dùng chat memory làm source of truth. Implementation chuẩn của task ledger, worktree policy, credential redactor và crash recovery drill được xác thực tại [P0-05 report](../evidence/P0-05/report.md) và [task_ledger.py](../evidence/P0-05/task_ledger.py).

Tables tối thiểu: `tasks`, `dependencies`, `leases`, `file_claims`, `runs`, `evidence`, `reviews`, `events`. Unique task ID; task state/revision update transaction; dependency DAG kiểm cycle; file claims ngăn overlapping writers. Fields bắt buộc:

```json
{
  "task_id":"P2-01","state":"ready","state_version":1,
  "dependencies":["P1-03","P1-04","P0-03"],
  "owner":null,"run_id":null,"lease_epoch":0,"lease_expires_at":null,
  "base_commit":"<actual-base-sha>","branch":null,"worktree":null,
  "allowed_paths":["packages/renderers/","evidence/P2-01/"],
  "acceptance_ref":"docs/IMPLEMENTATION_PLAN.md: P2-01",
  "heartbeat_at":null,"attempts":0,"evidence":[],"blocker":null
}
```

`allowed_paths` ví dụ là layout tương lai, supervisor chốt sau P1; không hardcode đường dẫn chưa tồn tại rồi làm task fail vô nghĩa. Một task có generation `lease_epoch` tăng mỗi reclaim; worker stale không được submit commit/mark done cho lease mới. Atomic claim `ready→claimed`, dependency done và file claim free trong cùng transaction. Durable event append commit cùng state, exported JSONL có thể rebuild từ DB. Backup state DB bằng SQLite backup API vào `.agy/backups/`, không copy WAL file đang ghi rồi giả nhất quán.

Task states: `planned` (dependencies chưa đủ), `ready`, `claimed`, `running`, `verifying`, `review`, `done`, `blocked`, `canceled`. Retry task dùng attempt/run mới giữ evidence cũ; `done` chỉ sau review đúng commit. Blocked ghi reason, dependency/decision cần, owner, next check, không chỉ “waiting”. Không tự retry lỗi cùng nguyên nhân vô hạn; tối đa 2 implementation attempts không tiến triển thì supervisor phân tích/chia task hoặc báo blocker.

## Worktrees, commits và conflicts

Một task/worker một Git worktree trong `.worktrees/<task-id>-<run-id>`, branch `agy/<task-id>-<slug>` từ reviewed integration/base commit. Không để workers cùng edit main checkout. Worktree dùng common Git metadata, mọi lệnh quản lý branch/worktree được supervisor serialize. Không `git reset --hard`, clean xóa files, force checkout, xóa worktree có uncommitted changes hoặc overwrite user's changes.

Worker đọc task packet trước sửa, chỉ file scope leased; phát hiện cần shared schema/lockfile thì gửi change request, supervisor chuyển ownership hoặc tạo prerequisite task. Root lockfile updates serialized một owner; không ghép lockfile bằng text merge thủ công. Mỗi commit implementation có task ID, meaningful message, tests/evidence note. Docs-only commit ngoại lệ đúng message user chỉ định.

Integration trình tự: worker commit → diff/review/CI trên exact head → supervisor đưa vào integration branch qua merge/cherry-pick đã được policy cho phép → chạy impacted checks → reconcile task evidence với integrated SHA. Nếu base đổi, rebase/merge trong task worktree, rerun affected tests; không re-use CI của stale commit. Conflict owner là stream sở hữu contract; supervisor assign một resolver, không để hai agents cùng “fix conflict”. Preserve behavior/invariants, cập nhật dependent docs/contracts, rerun đúng scope. Main merge/push/PR dùng runner permissions; phiên design không làm các việc này.

## Heartbeat và progress

Worker heartbeat 30s, task lease 10min, warn sau 90s không heartbeat; reclaim sau expiry cộng 2min grace **và** kiểm process/run ID. Supervisor heartbeat 30s ghi boot ID, PID, run ID, last queue mutation. Render jobs có lease 60s riêng theo Architecture; không nhầm với coding task lease. Heartbeat không tự chứng minh tiến bộ: mỗi ≤10min worker gửi checkpoint files/commit/tests/blocker/next action; long benchmark có process/artifact heartbeat thay câu “still working”.

Supervisor status snapshot: tasks per state, dependencies ready, owner/worktree/branch/base/head, elapsed/heartbeat, current command category, last evidence/CI, real video artifact count, budgets. Báo người dùng khi milestone đạt, blocker cần quyết định hoặc rủi ro đổi scope; không gửi spam từng file. Không khai `PASS` nếu chỉ đã khởi chạy test; chờ exit code và parse result đúng run.

## PR, CI và review gates

PR chỉ tạo/push ở phiên implementation khi runner đã cấp quyền GitHub, không tự gửi Slack/email. Body gồm task IDs, concrete before/after behavior, scope, contract/security implications, actual commands/results, artifacts, limitations. Template evidence:

```text
Task: P2-03
Base / tested commit: <sha> / <sha>
Environment: <image digest, CPU/RAM, runtime/font versions>
Command: <exact command, no secrets>
Result: PASS | FAIL | NOT_RUN | BLOCKED
Exit code / UTC started / duration: <actual values>
Artifacts: <path or access-controlled URL>, sha256=<actual hash>, expires=<UTC>
Acceptance mapping: <criterion -> evidence>
Reviewer / reviewed commit / decision: <actual values>
```

Reviewer không chỉ đếm tests: kiểm đúng tenant/security behavior, spec timing, scope, dependency licenses, quality frames/audio, và executable evidence. Missing CI creds/runtime = NOT_RUN/BLOCKED với lý do; local pass không gọi remote CI pass. Repeated test retries giữ logs và issue, không ghi pass che first failure. Test mock không chứng minh real MP4. No secret/log dump vào PR.

Definition of done: implementation/documentation đúng scope + all task acceptance + appropriate tests thực + reviewer decision cho tested commit + integrated commit evidence + durable queue transaction `review→done`. Có thể local-complete-awaiting-push ghi review, không fake PR URL/merged status. Legal/security gates giữ blocked nếu chưa người có quyền approve; chuẩn bị report cụ thể để approval là bước cuối.

## Resume sau crash/reboot

1. Runner khởi động lại thủ công hoặc cơ chế đã được operator cấp; docs không tự tạo daemon. Acquire singleton supervisor lock, kiểm SQLite integrity/backups và Git worktree registry.
2. Load tasks/events; boot ID thay đổi làm process leases cũ không chứng minh worker sống. Đối chiếu PID+start time+run ID, không kill process chỉ dựa PID có thể tái sử dụng.
3. Kiểm `.worktrees/` và git status từng leased task, preserve edits/untracked files; ghi recovery checkpoint. Không delete/reset worktree chỉ vì lease expired. Nếu worker còn sống đúng run, reattach; nếu không, tăng fence và chuyển task sang review/recovery hoặc ready tùy evidence.
4. Đối chiếu commits/PR/CI/artifacts đã có để không làm lại hoặc double merge. In-flight test không có exit result là NOT_RUN/UNKNOWN, rerun; commit đã merge nhưng queue chưa done phải kiểm acceptance rồi reconcile.
5. Dependencies/file claims re-evaluate, lease stale được release transactional; resume từ task chưa đạt gần nhất. Không tự phát lại command có side effect external/deploy; kiểm quyền/trạng thái và review trước.
6. Chạy relevant checks nếu runtime/base đổi; publish concise recovery status và tiếp tục ready tasks. Nếu DB corrupt, restore backup rồi replay durable events, so Git/evidence để giải quyết uncertainty; không invent done states.

## Stop conditions và budgets

Task vượt scope, cần secrets/prod access, license bị chặn hoặc custom isolation thiếu thì dừng phần phụ thuộc, ghi blocker, tiếp tục task độc lập. Khi user yêu cầu stop/pause, checkpoint state và ngừng nhận task mới; kill/cancel chỉ process do run sở hữu theo safe cleanup. Không dùng provider khác để vượt user budget. Authoring provider content/code luôn untrusted; worker platform code review không thay runtime sandbox gate.

Mỗi provider adapter có request timeout, spend/token budget, retry count, provenance/model label; model label không là bằng chứng chất lượng. Supervisor quyết định bằng acceptance và artifacts. Handoff cuối milestone nêu completed IDs/commits, actual tests/videos/cost, gaps, ready tasks và không chạm repo/service ngoài phạm vi.
