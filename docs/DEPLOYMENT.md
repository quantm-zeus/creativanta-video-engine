# Thiết kế deployment CPU

Đây là outline, không có Compose/app đang chạy và không cấp quyền sửa VPS hiện hữu. `P1-01` tạo setup local sau dependency review; `P6` chuẩn bị staging/beta; production rollout cần quyền môi trường riêng. [Security](SECURITY.md) là điều kiện deploy, không option tiết kiệm chi phí.

## Môi trường và topology

| Môi trường | Đề xuất ban đầu | Giới hạn |
| --- | --- | --- |
| Dev | Host ≥4 vCPU/8GiB, local Compose: API, PostgreSQL, approved S3-compatible dev store, ingest, controller, webhook sender | Bind services về loopback; một render slot; custom code off |
| Staging | Control node 2 vCPU/4GiB và worker node 4 vCPU/8GiB CPU-only; private object store | Synthetic/licensed fixtures, một tenant pair test, không production keys |
| Private beta | Control plane tách worker pool, DB backup/PITR, S3-compatible private durable storage | Bắt đầu 1–2 worker nodes, concurrency đo từ P2; không giả single VPS là HA |
| Production sau beta | API replicas nếu cần availability; managed hoặc operated DB có restore đã test; independent CPU worker pool | Capacity, budget và failure domains được review trước cam kết SLO |

Không bắt buộc Kubernetes giai đoạn đầu. Compose đủ local và staging nhỏ; worker node có trusted **narrow runtime launcher** được cài bởi operator sau này. Controller gửi allowed image digest/job workspace/limits qua authenticated local IPC; launcher validate rồi tạo sandbox, không nhận arbitrary host command/path. Không mount Docker socket vào API/renderer và không để client chọn image. Custom pool cần microVM runtime riêng; nếu host không hỗ trợ thì feature disabled, structured rendering vẫn hoạt động.

Compose outline sau đây là **pseudoconfiguration**, chưa chạy được, các image phải được build/pin ở P1. Không copy thành prod deployment:

```yaml
services:
  api:
    image: <reviewed-api-image-by-digest>
    ports: ["127.0.0.1:8080:8080"]
    networks: [control]
    read_only: true
  postgres:
    image: <supported-postgres-image-by-digest>
    networks: [control]
    volumes: ["./.local/postgres:/var/lib/postgresql/data"]
  object-store:
    image: <license-reviewed-s3-dev-image-by-digest>
    networks: [control]
    volumes: ["./.local/objects:/data"]
  ingest:
    image: <reviewed-ingest-image-by-digest>
    networks: [control, restricted-egress]
  controller:
    image: <reviewed-controller-image-by-digest>
    networks: [control]
  webhook-sender:
    image: <reviewed-sender-image-by-digest>
    networks: [control, restricted-egress]
networks:
  control:
    internal: true
  restricted-egress: {}
```

`restricted-egress` một mình **không enforce SSRF policy**; triển khai phải có proxy/firewall allowlist. Ephemeral render/encode sandboxes do launcher tạo, không nối control network; loopback asset server chỉ trong sandbox. Secret mounts/healthchecks/resources/migration jobs cố ý chưa viết như config runnable; P1 bổ sung đầy đủ và validate. Dev volumes/cache/worktrees trong repo `.local/`, không credentials trong Git. Lựa chọn local object store phải review license của exact image; API/storage layer chỉ phụ thuộc S3 contract.

## Startup contract khi code tồn tại

1. Pin supported Node LTS/package manager, Chromium/FFmpeg, base images và fonts bằng lockfile/digests; ghi SBOM/licenses. Không runtime download browser/CDN lúc render.
2. Tạo env local từ `.env.example`, sinh keys local bằng script reviewed; không copy production secrets. Tạo private buckets/policies và DB role riêng.
3. Start DB/store, chạy migrations một lần bằng role migrator, seed synthetic tenant/templates/font assets. API readiness chờ schema version compatibility, không tự migrate khi scale replicas.
4. Start API/ingest/dispatcher/controller/sender; chạy sandbox capability self-test (no network, limits, browser sandbox, write restriction). Fail self-test thì worker không ready.
5. Submit smoke fixture, poll, download/probe artifact, verify signed callback bằng local receiver; ghi actual commands/results trong README. Health OK không thay video smoke.

## Environment specification

Tên dưới đây là contract dự kiến. `secret` không được log; required chỉ cho service liên quan. Invalid/missing required env làm startup fail, không fallback sang insecure defaults.

| Variable | Dùng ở | Default/validation |
| --- | --- | --- |
| `CVE_ENV` | all | `development`, enum development/staging/production |
| `CVE_PUBLIC_BASE_URL` | API | Required absolute HTTPS; loopback HTTP chỉ development |
| `CVE_DATABASE_URL` | API/dispatcher/sender | Secret; service-specific role, TLS ngoài local |
| `CVE_MIGRATION_DATABASE_URL` | one-off migrator | Secret DDL role, không cấp cho render/API runtime |
| `CVE_STORAGE_ENDPOINT` | control/ingest | Required approved S3 endpoint, HTTPS ngoài local |
| `CVE_STORAGE_REGION` | control/ingest | Required string cho signed requests |
| `CVE_STORAGE_ACCESS_KEY_ID`, `CVE_STORAGE_SECRET_ACCESS_KEY` | control/ingest | Secrets hoặc workload identity; không renderer |
| `CVE_QUARANTINE_BUCKET`, `CVE_ASSET_BUCKET`, `CVE_ARTIFACT_BUCKET` | storage clients | Required distinct private names; không public ACL |
| `CVE_API_KEY_PEPPER` | API | Secret ≥32 random bytes; versioned rotation strategy |
| `CVE_SECRET_ENCRYPTION_KEY_ID` | API/sender | Reference tới secret manager/KMS; không key material trong manifest |
| `CVE_RENDERER_ADAPTER` | dispatcher | Explicit `hyperframes-v1` hoặc `chromium-frame-v1` đã approved; không auto-select latest |
| `CVE_RENDER_IMAGE_DIGEST` | launcher | Required immutable image digest allowlist |
| `CVE_RENDER_SLOTS` | node controller | 1 ban đầu; integer ≥1, bounded bởi CPU/RAM benchmark |
| `CVE_RENDER_CPU_LIMIT` | launcher | 2 vCPU/attempt ban đầu |
| `CVE_RENDER_MEMORY_MIB` | launcher | 4096 MiB/attempt |
| `CVE_RENDER_PIDS_LIMIT` | launcher | 256; kiểm đủ Chromium subprocesses trong P2 |
| `CVE_RENDER_TEMP_MIB` | launcher | 8192 per attempt; frame piping ưu tiên hơn full PNG dump |
| `CVE_FRAME_TIMEOUT_MS` | controller | 5000 per frame/readiness, fail sau timeout |
| `CVE_RENDER_TIMEOUT_SECONDS` | controller | 600 per render attempt |
| `CVE_JOB_DEADLINE_SECONDS` | dispatcher | 1800 từ admission gồm queue/retry, không unlimited backlog |
| `CVE_PREVIEW_TIMEOUT_SECONDS` | controller | 120 per attempt; preview deadline 300s cố định starter policy |
| `CVE_LEASE_SECONDS`, `CVE_HEARTBEAT_SECONDS` | dispatcher/controller | 60/15; heartbeat ≤lease/3 |
| `CVE_MAX_ATTEMPTS` | dispatcher | 3 total, không tăng để che deterministic failure |
| `CVE_REMOTE_IMPORT_ENABLED` | API/ingest | false |
| `CVE_EGRESS_POLICY_PATH` | ingest/sender | Required reviewed read-only allowlist config khi có egress |
| `CVE_CUSTOM_CODE_ENABLED` | API/dispatcher | false; true chỉ khi C1–C6 approval fingerprint match |
| `CVE_CUSTOM_RUNTIME` | custom launcher | `disabled` default, approved microVM profile khi bật |
| `CVE_CUSTOM_TENANT_ALLOWLIST` | API/dispatcher | Empty default, operator-managed IDs |
| `CVE_AUTHORING_PROVIDER` | authoring | `disabled`; registered adapter ID khi tenant opt-in |
| `CVE_AUTHORING_SECRET_REF` | authoring | Secret reference cho provider nếu cần, không mandatory subscription |
| `CVE_TTS_PROVIDER` | ingest/authoring | `disabled`; upload audio baseline |
| `CVE_TTS_SECRET_REF` | TTS adapter | Optional secret reference, không renderer |
| `CVE_ARTIFACT_RETENTION_DAYS`, `CVE_ASSET_RETENTION_DAYS` | sweeper | 7/7 default; policy pin per resource |
| `CVE_SIGNED_DOWNLOAD_TTL_SECONDS` | API | 300 max; upload grant 600s max |
| `CVE_TELEMETRY_ENDPOINT` | control/worker | Optional private sink, content redaction mandatory |
| `CVE_LOG_LEVEL` | all | info; debug vẫn redacted, bounded logs |
| `CVE_COST_RATE_VERSION` | metering | Required versioned rate config reference; không hardcode invoice price |

Tenant policy (2 active/20 queued/60req/min/body/media/authoring budgets) nằm DB versioned, không cho tenant sửa qua env. Webhook timeouts/retry schedule theo API, không tùy chỉnh thành unbounded qua env. Profile settings v1 immutable; thay limits có policy version/event và client capabilities phản ánh.

## Resource isolation và autoscale

Ban đầu một slot 2CPU/4GiB trên worker node 4CPU/8GiB, còn headroom cho controller/OS/ingest; không mở 2 slots chỉ bằng phép chia RAM mà chưa đo peak. Ingest/encode cùng attempt budget hoặc riêng bounded pool nhưng tổng node admission phải reserve đủ, không double overcommit. CPU-only software rasterization; không map GPU device. Output pipe backpressure; temp disk hard quota, disk free <20% ngừng claim, <10% drain node.

Autoscale sau P6: sample queue age/backlog mỗi 30s. Scale up nếu oldest ready >30s hoặc estimated queued work >2×available slot-minutes trong 3 samples; desired slots = ceil(queued_estimated_seconds / target_drain_seconds) + running_slots, clamp min/max/budget. `target_drain_seconds=120`, cooldown up 60s/down 10min, worker node max ban đầu 3; budget cap luôn thắng. Node mới pre-pull pinned image/warm fonts rồi self-test trước ready. Scale down chỉ idle/draining, không kill render. Không scale DB cùng logic; monitor lock/IO trước thêm worker.

Nếu budget hết, admission 429 hoặc queue bounded với deadline rõ; không âm thầm gọi cloud GPU/video API. Scheduling/reservation tenant vẫn áp dụng khi scale. Browser export tùy chọn ở client không giảm server accounting bằng giả định; đo adoption/cost riêng.

## Storage, backup và release

Private key pattern `tenant/{tenant_id}/{resource}/{id}/{version_or_attempt}/{kind}` do server sinh. Encrypt at rest/TLS, bucket policy không list cross-tenant; upload quarantine separate lifecycle, ready assets immutable, temp objects 24h orphan cleanup, artifact TTL 7d. Partial multipart uploads abort theo sweeper; don't delete live lease output. Dedup tenant-only và reference-count safe; derivative input links để revoke/delete cascade.

DB automated backups + WAL/PITR target RPO ≤15min; object versioning/replication policy phải phù hợp deletion promise và restore cutoff. Backup retention 30d, encrypted, access audited; monthly restore drill RTO ≤4h. Local dev volume không là backup. Exact provider/region/data residency/price là quyết định trước beta, không thay đổi VPS hiện hữu trong task design.

Release immutable image + migration plan + capabilities/schema compatibility. Expand/contract migrations, API N/N-1 during rollout; drain workers, jobs giữ pinned image có sẵn đến deadline. Canary 3 fixtures và small tenant cohort; rollback image không rollback data mù, migration phải có recovery plan. Security-critical image revoke có thể fail/recreate jobs thay vì giữ vulnerable runtime. Feature flag custom/import off sau restore cho đến policy revalidation. Runbooks ở [Operations](OPERATIONS.md).
