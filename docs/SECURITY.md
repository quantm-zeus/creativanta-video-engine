# Security design và release gates

Chưa có control nào được triển khai/kiểm thử. Mọi gate bên dưới là bắt buộc trước feature tương ứng, owner theo [Implementation plan](IMPLEMENTATION_PLAN.md). Xem [Architecture](ARCHITECTURE.md), [API](API.md), [Deployment](DEPLOYMENT.md).

## Threat model

Tin cậy có giới hạn: reviewed compiler/template catalog, pinned binaries, controller và policy config. Không tin: tenant payload, URL, media/font/SVG, generated HTML/JS/TS, provider output, npm dependency, callback receiver. Đe dọa chính: tenant data leak/IDOR, SSRF/metadata access, browser/codec exploit, code escape, CPU/disk bombs, dependency supply chain, token exfiltration và double usage/publication.

| Boundary | Bắt buộc |
| --- | --- |
| Internet → API | TLS, key scope/tenant, schema/byte limit, rate limit, audit |
| API → DB/storage | Composite tenant FK/RLS, role separation, signed scoped grants |
| External URL → ingest | SSRF egress proxy, allowlist, bounded fetch, isolated decode |
| Controller → renderer | No credentials, staged assets, read-only input, job workspace, no external network |
| Generated source → build | Hard isolation, allowlisted preinstalled deps, no install lifecycle scripts/network |
| Renderer → artifact publication | Untrusted output verification, fence, checksums, DB-authorized access |
| Webhook → client | HTTPS allowlist, HMAC timestamp/replay protection, bounded retry |

## Tenant identity và secrets

API key high-entropy 32 bytes, opaque prefix cho lookup, salted/keyed hash lưu DB; hiển thị một lần, scopes minimal, revoke tức thì, rotate overlap theo policy. Key check constant-time. Không lấy tenant từ request header/body do client tự chọn. Object access dùng tenant-scoped query, foreign IDs trả 404; list/cursor/error/usage/cache đều test tenant boundary. RLS transaction-local context, DB service roles riêng; audit mọi cross-tenant administrative action.

Control plane secrets ở secret store hoặc env mount protected; không đưa key vào render manifests, HTML, browser env, command line/logs. Renderer có env allowlist rất nhỏ (`TZ=UTC`, locale, runtime flags), không inherit controller env. Webhook signing secret encrypted at rest với key ID/version; AI provider key chỉ authoring adapter/secret broker, không generated bundle. Log redaction trước sink, không chỉ ở dashboard. Signed URLs là bearer capabilities: TTL ≤5min download/10min upload, strip query trong logs, không gửi vào analytics.

## URL allowlists và SSRF

Mặc định remote imports off; upload là baseline. Khi bật, server-managed tenant allowlist exact host/path prefixes, chỉ HTTPS port 443. Tenant không tự whitelist private endpoint. Reject userinfo, fragments, IP literals, alternate numeric IP encodings, non-HTTP schemes, backslashes và parser ambiguity. Normalize bằng một URL parser và IDNA policy trước match; không wildcard suffix như `endsWith("example.com")` thiếu boundary.

Resolve tất cả A/AAAA, reject loopback/link-local/RFC1918/ULA/multicast/reserved/unspecified, IPv4-mapped IPv6 và cloud metadata ranges. Kiểm tại connect time, pin approved resolved IP cho connection nhưng giữ TLS hostname verification; DNS rebinding hoặc đổi record không được vượt policy. Egress firewall/proxy deny private/metadata là lớp thứ hai. Redirect mặc định 0; nếu stock connector cần thì max 3 và revalidate từng hop/host/IP/port. Không cookie/authorization forwarding giữa hosts.

Fetch timeout connect 3s/total 30s; max 100MiB streaming, check bytes thực và decompressed size, không chỉ Content-Length/MIME. Download vào quarantine; magic bytes/probe isolated, reject HTML giả media, playlist/concat/protocol reference và archive bombs. Stock connector OAuth/keys chỉ ở ingest, signed source URL không persist nguyên query. Webhook sender áp dụng cùng network guard, không follow redirects, không dùng renderer để verify URL.

## Chromium và structured template sandbox

Ngay cả template reviewed vẫn có untrusted media. Mỗi attempt có container/process group mới: non-root UID, read-only rootfs, drop capabilities, no-new-privileges, seccomp/AppArmor policy, cgroup CPU/RAM/PID/disk/time limits, no host mounts/sockets, no privileged mode. Chromium sandbox phải hoạt động; **không dùng `--no-sandbox`** để sửa CI. Runner không hỗ trợ sandbox thì fail capability/deployment check, không chạy production.

Network namespace không có external egress/DNS. Có thể dùng loopback asset server **bên trong sandbox** chỉ serve allowlisted local manifest paths, không proxy/fetch, không directory listing; đây không phải quyền truy cập host loopback. Browser request interception chặn URL ngoài internal asset origin nhưng không coi interception là security boundary duy nhất. Chặn service workers, WebRTC, external navigation/popups/downloads và device/clipboard permissions. CSP chỉ cho bundled scripts/styles/assets được manifest cấp, `connect-src 'none'`, `object-src 'none'`, không CDN. Custom scripts cần CSP hash/nonce từ build, không cho `unsafe-eval` tùy tiện.

FFmpeg/ffprobe chạy sandbox riêng tương đương, argv array, protocol/demuxer allowlist local file/pipe thực sự cần; không shell command nối input. Decode exploit/memory bomb bị resource limit. Stdout/stderr bounded/redacted. Output file path server sinh, verify regular file/no symlink/expected magic bytes trước đọc/publish.

## Arbitrary agent/user code — mặc định disabled

`CUSTOM_CODE_ENABLED=false` và tenant allowlist rỗng. Structured text/layers không được mở script escape. Static scan/sanitizer, Node `vm`, iframe hoặc container thường **không đủ một mình** để bật arbitrary code multi-tenant.

Preferred deployment cho custom là disposable microVM mỗi attempt/build, outer dedicated worker pool, inner non-root Chromium sandbox và không egress. Nếu hạ tầng không có virtualization phù hợp, giữ custom off; có thể đề xuất gVisor qua ADR riêng với compatibility/escape/resource tests và reviewer approval, không silently downgrade sang container thông thường. gVisor cung cấp application-kernel isolation nhưng có compatibility/performance tradeoffs theo [tài liệu gVisor](https://gvisor.dev/docs/); chưa được benchmark cho nền tảng này.

Authoring flow: brief + approved asset manifest → provider adapter → source draft → schema/static policy scan → isolated build bằng preinstalled allowlisted dependencies → bundle digest/declared capabilities → isolated preview/abuse tests → approved bundle revision → render. Source và build không bao giờ chạy trong API/supervisor. Không npm install từ model output; imports chỉ package/version registry đã review, khóa dynamic import/network. Browser code không có Node bridge. Python/shell/process execution không thuộc scene API.

Adapter request gồm task ID, JSON schema target, budget/time limit, assets metadata tối thiểu, provider preference; response source files/patch + provenance/cost, không deployment commands. Codex, AGY Gemini Flash/Argon, OpenCode, DeepSeek hoặc model khác đều qua cùng policy. Provider outage không làm render approved composition ngừng hoạt động. Prompt injection trong asset/brief là untrusted content; agent không được thực thi instructions nhằm đọc secrets/host/network. Provider chỉ có task sandbox và quyền hẹp, không production credentials.

Gate `C1–C6` trước enabled: C1 threat model + runtime pin reviewed; C2 isolated build và no egress test; C3 filesystem/process/secret/metadata escape suite; C4 resource bombs/cancel/cleanup và lease fencing; C5 tenant preview/artifact origin authorization; C6 security reviewer ký evidence cho exact image/runtime + feature flag rollout/canary. Missing gate = disabled. Patch runtime/deps làm thay đổi boundary thì re-run gate; kill switch chặn admission và hủy running custom jobs khi incident.

## Filesystem, quotas và content

Workspace path từ job/attempt ID nội bộ, không filename tenant. Canonicalize path, reject `..`, absolute paths, symlinks/hardlinks/device files, zip-slip; bundle v1 giới hạn 100 files, ≤5MiB source, ≤20MiB built assets, nesting ≤8. Không mount Docker socket, SSH agent, host `/proc`, credentials hay repo checkout vào renderer. Inputs read-only; output volume quota; cleanup sau attempt, crash sweeper và host reboot reaper.

Starter limits ở [PRD](PRD.md); runtime budgets ở [Deployment](DEPLOYMENT.md). Admission reserve compute/storage budget, schedule fairness; rate limit riêng uploads/imports/authoring/webhook replay. Cấp concurrent slots theo cost profile, không để preview tránh quota. Text/SVG pathological complexity, huge image dimensions (max 40MP, ≤8192 px mỗi chiều), oversized font (≤32MiB), infinite JS/canvas loops, fork bombs, audio decode bombs phải có adversarial tests. Chặn remote font/script URL trước render; sanitize SVG tại ingest (≤5MiB, ≤5000 DOM nodes, độ sâu cây ≤16, cấm `<!DOCTYPE>`/`<!ENTITY>` XXE, `<script>`, `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`, `on*` event attributes, external `href`/`xlink:href` và CSS `url()`/`@import`).

Rights metadata bắt buộc cho media; không giả root repo license cấp quyền mọi demo. Abuse policy có report/takedown, tenant suspend, audit và budget cap; không triển khai generation/impersonation voice không có quyền. TTS optional cần commercial terms/consent phù hợp; audio upload vẫn dùng được. Không copy tenant input sang third-party provider mặc định.

## Retention, webhook và supply chain

Delete asset (`DELETE /assets/{id}`) lập tức revoke admission/access; chuyển mọi queued/retry_wait/running jobs đang tham chiếu asset đó sang trạng thái terminal `failed` với `error.code = "ASSET_REVOKED"` (`retryable: false`), thu hồi lease và chặn publication tại bước kiểm tra fence. Artifacts dẫn xuất bị revoke theo policy deletion request, purge async ≤24h; objects/backups có retention tối đa 30 ngày cho backup, disclosure trong service policy trước beta. Revisions còn metadata/hash và tombstone, không giữ private source content vô hạn. Normal 7-day TTL bắt đầu từ asset ready/artifact publication; job snapshot có thể pin input đến terminal nhưng không vượt deadline. Metadata/usage 90 ngày, security audit 180 ngày như PRD. Legal hold nếu có cần policy riêng, không tự bật.

Webhook protocol/HMAC ở [API](API.md) là canonical; endpoint ownership challenge, secret rotation, replay window, constant-time verification, event dedupe và SSRF test đều required. Receiver failures không được làm mất job/artifact.

Pin lockfile/OCI digest/Chromium/FFmpeg/fonts, review install scripts và package provenance; SBOM, license inventory, vulnerability scan ở PR/release, signature/provenance khi nguồn có hỗ trợ. Theo kết quả kiểm toán [P0-02](../evidence/P0-02/report.md) và rà soát threat model [P0-04](../evidence/P0-04/report.md), cấm cài đặt `hyperframes` CLI, `@hyperframes/engine` và `puppeteer` (full); chỉ dùng `puppeteer-core`/`playwright-core` với Chromium hệ thống có bật user-namespace sandbox (cấm `--no-sandbox`) và FFmpeg argv mảng kèm `-protocol_whitelist "file,pipe"` (cấm `--enable-nonfree`). Critical exploitable issue chặn release; ngoại lệ có owner/expiry/rationale, không bỏ qua chỉ vì scanner noisy. Automatic upgrades qua PR/canary/goldens, không auto-update runtime đang render. Scan secret cả diff và artifacts, không đưa private fixture lên public CI.

## Security acceptance và incident

P3/P6 yêu cầu test IDOR mọi resource/list/download, SSRF nhiều encoding/rebinding/redirect, malicious media/font/SVG, quota race, stale lease publish, cancellation, secret redaction, temp cleanup, backup restore auth. P7 bổ sung C1–C6. Evidence phải ghi exact runtime image, test payload category, command/result/reviewer; “containerized” không phải test result.

Incident: disable affected capability/admission → isolate pool → revoke grants/rotate exposed secrets đúng scope → preserve redacted evidence → identify impacted tenants/jobs → rebuild reviewed image → restore/canary → postmortem. Không log payload khách để điều tra đại trà. Runbooks và owners ở [Operations](OPERATIONS.md); phiên docs không chạy thao tác production.
