# Vận hành, SLO và chi phí

Runbooks dự kiến cho operator sau implementation; **không có dịch vụ được triển khai hoặc thay đổi trong phiên docs**. Mọi bước production cần scope môi trường đã được cấp. [Deployment](DEPLOYMENT.md) quy định env/resources; [Architecture](ARCHITECTURE.md) quy định state; [Security](SECURITY.md) quy định boundaries; [AGY execution](AGENTS.md) quy định progress agent.

## SLO mục tiêu và ownership

| Signal | Mục tiêu private beta | Window/điều kiện | Owner |
| --- | --- | --- | --- |
| API availability | ≥99.5% successful eligible requests | Rolling 30d; 5xx/timeouts là lỗi, invalid auth/schema/expected quota 4xx tách riêng | Control lead |
| Submit/status latency | p95 <500ms | 10req/s workload chuẩn Testing; không gồm upload/render | Control lead |
| Valid render success | ≥99% terminal succeeded | Rolling 7d, excludes user cancel/input-policy failures, vẫn report mọi failure theo code | Render lead |
| Queue wait | p95 <60s | Arrival ≤70% measured sustainable capacity, starter profile; overload báo riêng | Operator |
| Render latency | warm RTF ≤6 target | P2 fixture envelope; real production p95 theo profile sau đo, chưa là SLA | Render lead |
| Webhook first attempt | p95 <10s từ terminal commit | Không tính thời gian receiver xử lý vượt timeout; outbox backlog alert | Control lead |
| Data consistency | 0 lost accepted jobs / duplicate published artifact / duplicate billed entries | Invariant, bất kỳ violation là incident | DB/control lead |
| Restore | RPO ≤15min, RTO ≤4h | Monthly isolated drill DB + object consistency | Operator |
| Deletion | Access revoke ngay, physical active-store purge ≤24h | Backups expire ≤30d; documented policy | Security/operator |

Đây là SLO thiết kế, không báo cáo uptime thực hay hợp đồng SLA. Một VPS nhỏ có thể đủ thử nghiệm nhưng không tự đảm bảo availability. Error budget API =0.5% eligible requests/30d; render=1% eligible jobs/7d. Burn >2× trong 6h hoặc >10× trong 1h thì freeze feature rollout, ưu tiên reliability; security/data integrity breach luôn ưu tiên dù error budget còn. On-call/contact thực phải được gán trước P6 release, không để role tên chung là đường báo động duy nhất.

## Metrics và logs

Metrics names dự kiến, labels bounded (`profile`, `adapter`, `stage`, `error_code`, `pool`), **không job_id/tenant_id làm Prometheus label**. Tenant breakdown từ usage DB/logs authorized để tránh cardinality và data leak.

| Metric | Dùng để phát hiện |
| --- | --- |
| `cve_api_requests_total`, `cve_api_duration_seconds` | Error/latency theo route template/status, không raw URL |
| `cve_jobs_queued`, `cve_queue_oldest_seconds`, `cve_queue_wait_seconds` | Backlog, noisy tenant, stalled dispatcher |
| `cve_jobs_terminal_total`, `cve_job_stage_seconds` | Success/failure/cancel và stage bottleneck |
| `cve_worker_slots`, `cve_lease_expired_total`, `cve_stale_publish_rejected_total` | Capacity, lost workers, fencing activity |
| `cve_render_cpu_seconds`, `cve_render_wall_seconds`, `cve_peak_memory_bytes` | CPU vs wall/IO, RTF, sizing |
| `cve_temp_bytes`, `cve_orphan_objects`, `cve_disk_free_ratio` | Disk exhaustion/cleanup leaks |
| `cve_webhook_pending`, `cve_webhook_delivery_seconds`, `cve_webhook_attempts_total` | Receiver outage, delivery backlog |
| `cve_usage_reserved_units`, `cve_usage_settled_units`, `cve_usage_reconcile_errors_total` | Budget stuck, duplicate/missing ledger |
| `cve_sandbox_denials_total`, `cve_asset_rejections_total` | Attack/invalid media; codes bounded |

Trace từ request_id → job_id → attempt_id/lease_epoch → artifact IDs → event_id/delivery ID. Logs JSON chứa timestamps/stage/error category và IDs, không raw scripts/voice text/upload URLs/API keys. Worker stderr capped 64KiB/attempt sau redaction; full debug artifacts chỉ synthetic fixtures hoặc explicit private restricted retention. Sampling không áp dụng cho billing ledger/security incident audit. Health endpoints riêng: liveness process, readiness DB/schema/sandbox capabilities; render canary mới chứng minh path làm việc.

Alerts khởi điểm: oldest queue >120s trong 5min, worker heartbeat missing >60s, disk free <20%, memory >90% trong 5min, terminal failure >5%/15min với sample ≥20, webhook oldest >5min, DB backup lag >15min, usage reconciliation !=0, bất kỳ cross-tenant/security denial anomaly tăng đột biến. Điều chỉnh bằng baseline, không giảm sensitivity để giấu lỗi.

## Usage/cost ledger và report

Admission reserve worst-case policy budget, heartbeat updates actual operational consumption, terminal settle/release transactional. Reaper settle orphan attempts bằng persisted counters/upper-bound estimate có quality flag, không ghi 0 khi mất worker. Logical successful job billable output-minute một lần; retries/failed/canceled vẫn operational cost, preview cost tách. Usage entries append-only, correction bằng compensating entry có reason/reference, không sửa lịch sử âm thầm.

Các đại lượng phải tách:

- `cpu_seconds_actual` = user+system cgroup/process tree; dùng efficiency/debug.
- `reserved_vcpu_seconds` = reserved vCPU × worker occupied wall seconds; allocation estimate cho dedicated capacity.
- `host_cost` = provisioned host hours × actual/assumed host price; gồm idle và warmup. Không gọi CPU actual estimate là hóa đơn cloud.
- `storage_cost` = byte-hours/GB-hours theo unit convention provider và retention; `egress_cost` = GB transferred × rate; requests/TTS/authoring cộng riêng.
- `unit_cost` = (allocated compute + storage + egress + optional TTS/authoring + retry/idle overhead) / succeeded output minutes. Báo marginal và fully allocated, không bỏ failed attempts khỏi numerator.

Ví dụ giả định (không giá thị trường): job 15s video chiếm 60s ở 2 vCPU, rate 0.04 USD/vCPU-hour → allocated compute `2*60/3600*0.04=0.001333 USD`, tức `0.005333 USD/output-minute` trước idle/storage/egress. Host 4 vCPU bật 1h nhưng chỉ dùng 10% vẫn tốn nguyên giờ theo mô hình provisioned; report 10/50/80% utilization để thấy ảnh hưởng. TTS/agent cost ghi provider/meter/rate version; disabled thì 0 có lý do, không dùng fake free pricing.

Daily report: tenant/profile/job kind, submitted/succeeded/failed/canceled, output seconds, retries, CPU/wall, peak memory, stored bytes/TTL, egress, estimated costs và reservation age. Weekly: p50/p95 cost/minute, RTF, utilization, top error/cost drivers, actual invoice reconciliation nếu có, price assumptions/source date. Mức giá bán/margin chưa quyết; scope MVP không charge card. Quota/budget cap ngăn spend runaway, import/authoring/TTS cũng có quota riêng.

## Runbook: accepted job không tiến triển

1. GET status/events bằng đúng tenant scope, lấy request/job/attempt IDs; kiểm state_version, deadline, cancel flag, lease heartbeat và queue age. Không hỏi khách gửi key/log raw.
2. Nếu queued: kiểm tenant/global slots, reservation, dispatcher health/DB locks, node sandbox self-test và budget cap. Nếu hết deadline, dùng state transition fail đúng code, không xóa row để làm sạch dashboard.
3. Nếu running heartbeat mất: reaper kiểm current lease/fence rồi requeue bounded. Không sửa state trực tiếp bằng ad hoc SQL hoặc chạy song song cùng attempt. Stale worker kill qua launcher với đúng run ID.
4. Nếu stage hang nhưng heartbeat còn: đọc stage timers/limits/diagnostics, cancel theo API nếu cần, dùng synthetic reproduction cùng manifest/runtime (không private data exfiltration). Không tắt sandbox/raise unlimited timeout.
5. Xác nhận terminal/output/outbox/usage nhất quán, temp swept, ghi incident và regression test. Retry manual tạo job mới/key mới khi terminal; không resurrect terminal row.

## Runbook: video đen, thiếu font hoặc audio lệch

Lấy artifact manifest/quality report theo quyền, so runtime/adapter/font/asset hashes và expected frame/cue boundaries. Decode toàn file, inspect golden frames tại scene edges, probe orientation/colorspace/CFR/PTS. Thiếu glyph → fail font preflight, bổ sung approved font revision; không tải font từ Internet trong browser. Black frames → readiness/seek/asset decode, kiểm no-network denial để phát hiện asset chưa stage. Audio drift → mapping rational samples, source trim/CFR, encoder delay; không bù bằng hardcoded offset cho mọi clip. Reproduce bằng minimal authorized fixture, pin corrected compiler/profile, golden review, render **revision/job mới**; không overwrite artifact lịch sử.

## Runbook: worker crash, disk/OOM và duplicate risk

Drain affected node, stop new claims; kiểm process cgroup peak/RSS/temp usage/FFmpeg logs redacted. Preserve manifest/attempt counters, expire lease bằng official reaper path, fence stale output. Sweep chỉ orphan >24h không live/ref; không `rm -rf` rộng hoặc xóa bucket tenant. Disk <10% có thể abort active job theo bounded cleanup policy, nhưng publish vẫn cần fence. Điều chỉnh profile/concurrency qua measured config rollout, không tăng slots để chữa backlog khi OOM. Usage reconcile đảm bảo chỉ một billable entry/logical job.

## Runbook: webhook không tới

Job succeeded vẫn tải được qua polling. Kiểm active endpoint/ownership/URL policy, outbox age, delivery attempt/response class, secret key ID và receiver clock skew. Receiver phải verify raw bytes rồi durable dedupe event ID; JSON reserialization thường làm sai signature. 410 disable endpoint; 429/5xx theo retry schedule; 3xx không follow. Sau sửa, replay delivery API (cùng event ID), không submit render lại. Rotate secret nếu nghi lộ, giữ overlap 24h đúng protocol, không tắt signature verification để debug.

## Runbook: DB/storage outage và restore

DB unavailable: admission 503, dispatcher stop; workers không renew lease thì dừng/preserve temp bounded, không publish bypass DB. Storage down: retry trong deadline, không succeed với object chưa durable. Khi phục hồi, reconcile leased attempts/temp objects/published refs/outbox/ledger trước nhận toàn tải.

Restore drill vào môi trường **tách biệt**: chọn backup/WAL cutoff, restore DB và object versions phù hợp, disable outbound webhooks/authoring/import/custom để tránh gửi trùng hoặc gọi bên ngoài; validate tenant RLS/counts/hash refs, orphan handling và reservations. Rebuild outbox delivery state, phát lại chỉ theo policy event dedupe; không replay production callbacks từ staging. Đo actual RPO/RTO, smoke 3 fixtures/tenant isolation, operator review trước cutover. Không rollback live DB bằng backup chỉ để xử lý bug nhỏ. Missing object sau restore phải error typed/re-render opt-in nếu inputs còn, không fabricate artifact.

## Runbook: tenant isolation/abuse incident

Disable affected routes/capabilities hoặc suspend tenant đúng phạm vi; isolate worker pool, revoke scoped grants, rotate keys nếu có evidence exposure. Preserve redacted logs/manifest và audit timeline trong restricted evidence store, xác định tenant/job bị ảnh hưởng. Không tải hàng loạt private input để điều tra. Patch/rebuild pinned image, re-run security suite và canary, human incident owner review trước reopen. Custom kill switch hủy admission/running custom jobs; structured path chỉ tiếp tục nếu không dùng boundary bị ảnh hưởng. Postmortem có root cause/impact/corrective task IDs, không secrets.

## Theo dõi implementation và release

AGY dashboard đọc `.agy/status.json` theo [AGY execution](AGENTS.md): task done/blocked, active owner/worktree, heartbeat, tested commit, reviewer/CI, real video artifacts và cost/quality gates. “Files created”, token usage hoặc agent sống không thay evidence progress. Báo milestone G2 riêng G1; internal harness riêng live Creativanta integration.

Trước release: dependency/security review, DB migration/backup, exact image/schema compatibility, canary fixtures, rollout/rollback owner, budget cap. Rollback image có thể dùng với DB N/N-1, không downgrade schema không có plan. Weekly synthetic render canary và monthly restore drill; nâng Chromium/FFmpeg/fonts luôn golden diff + cost regression. Error budget cạn thì ưu tiên reliability trước feature expansion.
