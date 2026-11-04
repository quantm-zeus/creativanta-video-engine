# Evidence Report — Task P6-04: Security Reviewer (Structured Renderer Security Suite, SBOM/License/Codec/Asset Review, Secrets/IDOR/SSRF/Abuse/Deletion Verification)

Báo cáo bằng chứng nghiệm thu cho nhiệm vụ **P6-04: Security reviewer (P6)** trong repository độc lập `creativanta-video-engine`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), [Scene specification](../../docs/SCENE-SPEC.md), [API specification](../../docs/API.md) và [AGY workflow](../../docs/AGENTS.md).

## Bằng chứng thực thi (Evidence Template)

```text
Task: P6-04
Role / Phase: Security reviewer / P6
Base commit: df3b3df45e7e0cb262d9f81dc7b8103b0f561613
Environment: Linux x86_64, Node.js v24.x (built-in node:sqlite, node:crypto, node:test), Python 3.12
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0)
  2. node --test ops/test/security-review-p6-04.test.mjs -> PASS (exit code 0, 4/4 suites, 24/24 security checks passed)
  3. node --test ops/test/*.test.mjs -> PASS (exit code 0, 19/19 suites, 64/64 tests passed)
  4. node ops/security/security-cli.mjs --write-evidence evidence/P6-04 -> PASS (exit code 0, Status=PASS, Decision=APPROVED_FOR_PRIVATE_BETA_PENDING_EXTERNAL_GATES)
  5. node benchmarks/security-suite-benchmark.mjs -> PASS (exit code 0, 4 micro-benchmarks + full 24-check review in ~612ms)
  6. node packages/controller/dist/index.js --self-test -> PASS (exit code 0)
  7. node scripts/health-check.mjs -> PASS (exit code 0)
Artifacts:
  - evidence/P6-04/report.md
  - evidence/P6-04/summary.json
  - evidence/P6-04/sbom-and-security-audit.json
  - ops/security/renderer-security-suite.mjs
  - ops/security/sbom-license-codec-auditor.mjs
  - ops/security/api-tenant-security-suite.mjs
  - ops/security/security-review-runner.mjs
  - ops/security/security-cli.mjs
  - ops/logging/redacted-logger.mjs
  - ops/runbooks/synthetic-runbook-runner.mjs
  - ops/test/redacted-logger.test.mjs
  - ops/test/security-review-p6-04.test.mjs
  - benchmarks/security-suite-benchmark.mjs
Acceptance mapping:
  - Structured renderer security suite: PASS (9/9 checks: nonroot UID/GID 10001:10001, Chromium sandbox flags & --no-sandbox ban, HTML/CSP/SVG zero-egress & XXE guards, FFmpeg safe argv array & -protocol_whitelist "file,pipe", read-only input directory enforcement, symlink/hardlink/path traversal rejection, cgroup/wall-clock/CPU/disk/PID resource bombs & process-group kill, secret canary exfiltration prevention, internal loopback asset server guard & CVE_CUSTOM_CODE_ENABLED=false hard lock)
  - SBOM / license / codec / asset review: PASS (5/5 checks: CycloneDX-style SBOM & pnpm-lock.yaml SHA-256 verification with 0 external runtime dependencies, 0 banned packages, 0 untrusted install hooks; clean-room anti-contamination audit across 106 source files; FFmpeg LGPL/GPL build policy & seccomp syscall blocklist verification; P0-03 19 fixture assets + 5 on-disk SVG fixtures + 6 curated templates SHA-256 & commercial rights audit; TTS TermsReviewRegistry commercial terms, speaker consent & anti-impersonation gate)
  - Secrets / IDOR / SSRF / abuse / deletion verification: PASS (10/10 checks: 32-byte API key constant-time HMAC-SHA256 verification & rotation/revocation; 10-endpoint cross-tenant URL path IDOR matrix returning 100% 404 NOT_FOUND + JSON body cross-tenant reference returning 422 ASSET_NOT_FOUND per AMB-007; signed pagination cursor tenant/route/filter binding; 19 multi-encoding SSRF & 5 DNS rebinding vectors blocked; SVG XXE/script/foreignObject/DOM bomb + WOFF2 table bomb + PNG 64MP pixel bomb + MP4 signature & MIME spoofing blocked; rate limiting 429 + active job slot quota + idempotency conflict 409; webhook secret one-time display & idempotent replay redaction + AES-256-GCM at rest; DELETE /v1/assets/:id cascade ASSET_REVOKED + 410 GRANT_REVOKED + audit tombstone without private payload; LeaseManager epoch fencing + StorageTempSweeper live-lease preservation; PostRestoreSafetyGate lock verification)
  - Critical findings resolved hoặc beta blocked: PASS (2/2 security audit findings SEC-P6-001 and SEC-P6-002 resolved in code and verified by automated tests; 0 open critical or high findings)
```

---

## 1. Phạm vi và mục tiêu nghiệm thu (P6-04 Security Reviewer)

Nhiệm vụ `P6-04` đóng vai trò cổng kiểm toán bảo mật độc lập (Security Release Gate) cho giai đoạn P6 trước khi bàn giao private beta. Toàn bộ kiểm tra được tự động hóa thành bộ công cụ thực thi thật (không mock giả tạo trạng thái pass) trong `ops/security/` và `benchmarks/security-suite-benchmark.mjs`, kiểm chứng trực tiếp các gói thực thi `@creativanta/contracts`, `@creativanta/api`, `@creativanta/controller`, `@creativanta/templates`, `@creativanta/sdk` và `ops/`.

---

## 2. Các phát hiện bảo mật đã được phát hiện và khắc phục triệt để (Resolved Findings)

Trong quá trình rà soát mã nguồn `ops/` đối chiếu với `@creativanta/api` và `@creativanta/controller`, nhóm Security Reviewer đã phát hiện và khắc phục triệt để **2 lỗ hổng bảo mật** trước khi đóng cổng P6-04:

| Mã phát hiện | Mức độ | Thành phần bị ảnh hưởng | Mô tả lỗ hổng phát hiện | Biện pháp khắc phục & Kiểm chứng | Trạng thái |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`SEC-P6-001`** | **HIGH** | `ops/logging/redacted-logger.mjs` | Biểu thức chính quy `API_KEY_PREFIX_REGEX` ban đầu chỉ giới hạn `{12,64}` ký tự sau tiền tố `cve_live_`/`cve_test_`, trong khi `generateApiKeyMaterial()` tại `packages/api/src/auth/api-key.ts` sinh chuỗi hậu tố dài **77 ký tự** (`<12hex>_<64hex>`), khiến 13 ký tự hex cuối của khóa API có nguy cơ lọt qua log. Đồng thời thiếu bộ lọc cho `whsec_` (webhook signing secret), `sk-`/`ghp_`/`AKIA`, khóa PEM private key và thông tin xác thực trong URI kết nối DB/Redis/AMQP. | Mở rộng `API_KEY_PREFIX_REGEX` lên `{12,128}` ký tự; bổ sung `WEBHOOK_SECRET_REGEX`, `EXTERNAL_SECRET_REGEX`, `PRIVATE_KEY_BLOCK_REGEX`, `CONNECTION_URI_CREDENTIALS_REGEX` và mở rộng danh sách khóa nhạy cảm trong `redactObject()`. Kiểm chứng tại `ops/test/redacted-logger.test.mjs` và `RND-SEC-08`. | **RESOLVED** |
| **`SEC-P6-002`** | **MEDIUM** | `ops/runbooks/synthetic-runbook-runner.mjs` (`runRunbook6TenantIsolation`) | Kịch bản kiểm tra sự cố `RUNBOOK-06` (Multi-Tenant Isolation Breach / Cross-Tenant IDOR Attempt) trước đó mới chỉ mô phỏng trạng thái `404` trên đối tượng in-memory thay vì thực thi truy vấn thật qua `TenantRepository` và cơ chế cô lập `TenantConnectionPool` (SQLite RLS emulation + `tenant_id` scoping). | Nâng cấp `runRunbook6TenantIsolation()` khởi tạo cơ sở dữ liệu SQLite `:memory:` với `MigrationRunner`, `TenantConnectionPool` và `TenantRepository`, tạo tài sản của Victim (`00000000-0000-4000-8000-666666666667`), dùng tài khoản Attacker (`00000000-0000-4000-8000-666666666666`) truy cập chéo để xác minh ngoại lệ `ResourceNotFoundError` (`404 NOT_FOUND`) thật từ tầng DB, sau đó đình chỉ (`suspend`) tenant vi phạm. Kiểm chứng tại `ops/test/synthetic-runbooks.test.mjs`. | **RESOLVED** |

---

## 3. Kết quả kiểm định Structured Renderer Security Suite (`ops/security/renderer-security-suite.mjs`)

Tất cả **9/9** bài kiểm tra bảo mật hộp cát trình kết xuất (Renderer Sandbox) đều đạt **PASS**:

1. **`RND-SEC-01` — Non-root execution (`UID 10001 / GID 10001`) & Privilege Drop Guard**:
   - Xác minh `DEFAULT_SANDBOX_SECURITY_CONFIG` bắt buộc `nonRootUid: 10001`, `nonRootGid: 10001`, `noNewPrivileges: true`, `capDropAll: true`, `networkMode: 'none'`, `readOnlyRootfs: true`.
   - Khi mô phỏng tiến trình chạy dưới `uid: 0` hoặc `gid: 0` trong `verifyRuntimeEnvironment()`, hộp cát lập tức từ chối khởi chạy và ném lỗi `SandboxSecurityError (SANDBOX_SECURITY_VIOLATION)`.
2. **`RND-SEC-02` — Chromium Sandbox Flags & Strict `--no-sandbox` Ban**:
   - Xác minh `buildChromiumSandboxFlags()` luôn bật user-namespace sandbox của Chromium và chứa các cờ cô lập mạng/tài nguyên (`--disable-background-networking`, `--disable-extensions`, `--disable-sync`, `--disable-default-apps`, `--no-first-run`, `--mute-audio`).
   - Bất kỳ cấu hình nào cố tình chèn `--no-sandbox` hoặc `--disable-setuid-sandbox` đều bị chặn bởi `assertNoForbiddenChromiumFlags()`.
3. **`RND-SEC-03` — CSP & HTML/SVG Zero-Egress Enforcement**:
   - Xác minh `TRUSTED_TEMPLATE_CSP` khóa chặt `default-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'`.
   - `validateHtmlSecurityInvariants()` chặn 100% các mẫu tấn công: `<script src="https://...">`, `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon()`, `<iframe src="https://...">`, `<foreignObject>`, CSS `@import url("https://...")`, `url("http://...")`, và khai báo `<!DOCTYPE ... <!ENTITY xxe SYSTEM "file:///etc/passwd">>`.
4. **`RND-SEC-04` — FFmpeg Safe `argv` Array & `-protocol_whitelist "file,pipe"`**:
   - Xác minh `buildSafeFfmpegEncodeArgs()` và `validateFfmpegArgs()` truyền đối số dưới dạng mảng `argv` thuần túy (không qua `/bin/sh -c`), bắt buộc `-protocol_whitelist file,pipe`, và chặn mọi URI ngoại mạng (`http://`, `https://`, `rtmp://`, `tcp://`, `udp://`, `concat:`, `subfile:`) cũng như cờ `--enable-nonfree`.
5. **`RND-SEC-05` — Read-Only Staged Inputs (`0o550` / `0o440`)**:
   - Thực thi `SandboxWorkspaceManager` dựng thư mục `/inputs` ở chế độ chỉ đọc (`0o550`) và tệp tài sản ở chế độ `0o440`; xác minh `verifyInputsReadOnly()` phát hiện ngay lập tức nếu quyền ghi (`0o644`) bị bật trái phép.
6. **`RND-SEC-06` — Symlink, Hardlink & Path Traversal Rejection**:
   - Kiểm chứng thực tế trên hệ thống tệp tạm: tạo symlink trỏ ra `/etc/hosts`, hardlink (`nlink > 1`) và đường dẫn `../../etc/passwd`. `validateInputAssetPath()` sử dụng `fs.lstatSync` chặn toàn bộ 3 vector với mã lỗi `SANDBOX_SECURITY_VIOLATION`.
7. **`RND-SEC-07` — Resource Bombs (Wall-Clock, CPU, Disk Quota, PID/Fork Limit, Process-Group Kill)**:
   - Thực thi tiến trình con thực tế (`node -e "setInterval(() => {}, 1000)"`) vượt ngưỡng timeout 120ms qua `runSandboxedProcess()`, xác minh toàn bộ process group (`-pid`) bị tiêu diệt sạch sẽ và trả về `SANDBOX_RESOURCE_LIMIT`.
   - Tạo tệp vượt hạn ngạch đĩa tạm trong `/tmp` của attempt và xác minh `enforceDiskQuota()` ném `SANDBOX_RESOURCE_LIMIT`.
   - Kiểm chứng bộ tạo đối số cgroup v2 (`buildContainerRunArgs`) áp đặt `--pids-limit=256`, `--memory=3072m`, `--memory-swap=3072m`, `--cpus=2`.
8. **`RND-SEC-08` — Secret Canary Exfiltration Prevention & Dual Log Redaction**:
   - Tiêm các chuỗi canary nhạy cảm (`cve_live_0123456789ab_...`, `whsec_...`, `X-Amz-Signature=...`, `sk-proj-...`, `postgres://cve_app:super_secret_pw@...`, PEM private key) vào luồng log của cả `redactSecretOutput()` (`@creativanta/controller`) và `redactString()`/`redactSecretsFromLogs()` (`ops/logging/redacted-logger.mjs`). Xác minh **0 byte** bí mật rò rỉ ra đầu ra và bộ đệm stderr bị cắt đúng ngưỡng tối đa **64 KiB** (`MAX_STDERR_BYTES = 65536`).
9. **`RND-SEC-09` — Internal Loopback Asset Server Guard & Custom Code Hard-Off**:
   - Khởi chạy `InternalAssetServer` thực tế trên `127.0.0.1:0`, xác minh tệp được đăng ký rõ ràng trong allowlist trả về `200 OK` kèm header `Content-Security-Policy` và `X-Content-Type-Options: nosniff`, trong khi mọi yêu cầu tới tệp không nằm trong allowlist hoặc chứa `..` / `%2e%2e` trả về `403/404`.
   - Xác minh `assertCustomCodeDisabled({ CVE_CUSTOM_CODE_ENABLED: 'true' })` chặn đứng việc bật custom code trong hộp cát `trusted-template-v1`.

---

## 4. Kết quả kiểm toán SBOM, License, Codec & Asset Provenance (`ops/security/sbom-license-codec-auditor.mjs`)

Tất cả **5/5** hạng mục kiểm toán chuỗi cung ứng, bản quyền, codec và tài sản đều đạt **PASS**:

1. **`SBOM-01` — Workspace SBOM & `pnpm-lock.yaml` Integrity**:
   - Đã xuất bản kê SBOM chuẩn CycloneDX 1.5 tại [`evidence/P6-04/sbom-and-security-audit.json`](sbom-and-security-audit.json).
   - Toàn bộ **7 workspace packages** (`@creativanta/contracts`, `@creativanta/api`, `@creativanta/controller`, `@creativanta/ingest`, `@creativanta/sdk`, `@creativanta/templates`, `@creativanta/harness`) có **0 external runtime dependencies** (chỉ sử dụng Node.js 24 built-in modules) và **3 pinned devDependencies** (`typescript@5.7.3`, `@types/node@22.10.5`, `undici-types@6.20.0`).
   - Mã băm `pnpm-lock.yaml` SHA-256: `9223fd58720940a2146c2e41522b5b158e13fd4fd5bf367238d9a39b785f8c8f`.
   - **0 gói bị cấm** (`hyperframes`, `@hyperframes/engine`, `@hyperframes/cli`, `@hyperframes/producer`, `puppeteer`, `gsap`, `remotion`, `@remotion/cli`, `@remotion/renderer`) và **0 lifecycle install scripts** (`preinstall`/`install`/`postinstall`).
2. **`SBOM-02` — Upstream Clean-Room Anti-Contamination Audit**:
   - Đối chiếu `evidence/P0-02/artifacts-review.json`: xác nhận `hyperframes_cli`, `hyperframes_engine`, `puppeteer_full`, `ffmpeg_nonfree`, `fonts_remote_cdn` đều ở trạng thái `BLOCKED`.
   - Quét tĩnh toàn bộ **106 tệp mã nguồn** trong `packages/` và `ops/`: **0 câu lệnh import** tham chiếu tới mã nguồn nhiễm bẩn bản quyền (FSL-1.1-ALv2, Remotion License, GreenSock GSAP, HeyGen telemetry/billing).
3. **`SBOM-03` — FFmpeg Codec/Patent Configuration, Container Hardening & Seccomp Audit**:
   - Kiểm chứng `docker/Dockerfile.renderer-sandbox`: thực thi dưới `USER 10001:10001`, cài đặt qua `pnpm install --frozen-lockfile --ignore-scripts`, khóa `CVE_CUSTOM_CODE_ENABLED=false`, không chứa `--enable-nonfree` hoặc `--no-sandbox`.
   - Kiểm chứng `docker/seccomp-renderer.json`: chặn **48 syscalls nguy hiểm** (`SCMP_ACT_ERRNO`), bao gồm đầy đủ `ptrace`, `mount`, `umount2`, `kexec_load`, `init_module`, `finit_module`, `bpf`, `perf_event_open`, `pivot_root`, `open_by_handle_at`, `userfaultfd`, `process_vm_readv`, `process_vm_writev`.
4. **`SBOM-04` — Curated Fixture & Template Asset Provenance & On-Disk SHA-256 Audit**:
   - Kiểm chứng `evidence/P0-03/rights-manifest.json`: trạng thái `VERIFIED_COMPLIANT`, đầy đủ **3 fixtures (`POC-01`, `POC-02`, `POC-03`)** và **19 tài sản** đều có `commercial_use_allowed: true`, `commercial_embedding_allowed: true` và mã băm SHA-256 64 ký tự hex hợp lệ.
   - Kiểm chứng trực tiếp trên đĩa **5 tệp SVG fixture** trong `evidence/P0-03/fixtures/` (`poc01_sale_badge.svg`, `poc01_pill_button.svg`, `poc02_growth_chart.svg`, `poc02_metric_card.svg`, `poc02_cloud_icon.svg`): 100% khớp tuyệt đối mã băm SHA-256 và kích thước byte trong `rights-manifest.json`.
   - Kiểm chứng toàn bộ **6 curated templates** (3 gia đình `tpl_retail_promo`, `tpl_social_announcement`, `tpl_captioned_explainer` × 2 phiên bản `v1`, `v2`) qua `verifyTemplateLicenseEvidence()` và `assertTemplateLicenseCompliance()`. Đồng thời xác nhận template bị chèn thử phông chữ không đăng ký (`ast_unregistered_pirated_font`) bị chặn chính xác.
5. **`SBOM-05` — TTS Voice Terms, Commercial Clearance, Speaker Consent & Anti-Impersonation Gate**:
   - Kiểm chứng `TermsReviewRegistry` trong `@creativanta/sdk`: giọng đọc синтеz tiếng Việt đã duyệt (`vi-VN-HoaiMy-Neural`) được phép sử dụng, trong khi nhà cung cấp chưa duyệt bị chặn với `TERMS_NOT_FOUND`, giọng nhân bản thiếu sự đồng thuận của diễn viên bị chặn với `VOICE_CONSENT_UNVERIFIED`, và giọng vi phạm chống mạo danh bị chặn với `IMPERSONATION_NOT_PROHIBITED`.

---

## 5. Kết quả kiểm định Secrets, Cross-Tenant IDOR, SSRF, Abuse, Malicious Media & Deletion (`ops/security/api-tenant-security-suite.mjs`)

Tất cả **10/10** bài kiểm tra bảo mật tầng API, cơ sở dữ liệu đa thuê bao và vòng đời dữ liệu đều đạt **PASS**:

1. **`API-SEC-01` — API Key 32-Byte Entropy, Constant-Time Verification, Scope Isolation, Rotation & Revocation**:
   - Khóa sinh ra có đúng 32 byte (64 ký tự hex) bí mật ngẫu nhiên, chỉ lưu `key_hash` (HMAC-SHA256 kèm `pepper`) trong bảng `api_keys`.
   - Xác thực hằng thời gian (`crypto.timingSafeEqual`) từ chối khóa sai bí mật; khóa chỉ có scope `jobs:read` gọi `POST /v1/assets/uploads` bị chặn với `403 FORBIDDEN`; khóa cũ sau khi `revokeApiKey` bị chặn với `401 UNAUTHORIZED` trong khi khóa mới xoay vòng (`rotateApiKey`) hoạt động bình thường (`200 OK`).
2. **`API-SEC-02` — Cross-Tenant IDOR Matrix (Path `404 NOT_FOUND` vs Body `422 ASSET_NOT_FOUND` theo `AMB-007`)**:
   - Khởi chạy máy chủ HTTP thực tế với 2 tenant độc lập (`VICTIM_A` và `ATTACKER_B`).
   - Attacker B dò quét **10 đường dẫn URL** chứa ID tài nguyên của Victim A (`GET /v1/assets/:id`, `GET /v1/assets/:id/download`, `DELETE /v1/assets/:id`, `GET /v1/compositions/:id`, `GET /v1/compositions/:id/revisions/1`, `GET /v1/jobs/:id`, `GET /v1/jobs/:id/events`, `POST /v1/jobs/:id/cancel`, `GET /v1/webhook-endpoints/:id`, `DELETE /v1/webhook-endpoints/:id`): **10/10 trả về đúng `404 NOT_FOUND`**, không tiết lộ sự tồn tại của tài nguyên.
   - Attacker B chèn `asset_id` của Victim A vào thân JSON của `POST /v1/compositions`: trả về đúng **`422 Unprocessable Entity`** với mã chi tiết **`ASSET_NOT_FOUND`** theo chuẩn `AMB-007`.
3. **`API-SEC-03` — Signed Pagination Cursor Binding & Tamper Rejection**:
   - Con trỏ phân trang ký HMAC-SHA256 ràng buộc chặt `(tenantId, route, filterHash)`. Mọi nỗ lực phát lại con trỏ sang tenant khác, route khác, bộ lọc khác hoặc sửa chữ ký đều bị `decodeSignedCursor()` từ chối (`null` -> `400 INVALID_CURSOR`).
4. **`API-SEC-04` — Multi-Encoding SSRF, Private IP Ranges, DNS Rebinding & Allowlist Enforcement**:
   - Chặn toàn bộ **19 vector URL độc hại**: `http://` thuần, thông tin xác thực nhúng (`user:pass@`), cổng lạ (`:8443`), fragment (`#`), backslash parser differential (`\@`), path traversal (`../../`), IPv4 loopback (`127.0.0.1`), IPv4 octal (`0177.0.0.1`), IPv4 decimal DWORD (`2130706433`), IPv4 hex (`0x7f000001`), AWS/GCP Cloud Metadata IMDS (`169.254.169.254`), mạng nội bộ RFC1918 (`10.0.0.42`, `172.16.5.4`, `192.168.1.1`), CGNAT (`100.64.0.10`), IPv6 loopback (`[::1]`), IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), IPv6 link-local (`[fe80::1]`) và IPv6 ULA (`[fc00::1234]`).
   - Chặn toàn bộ **5 kịch bản DNS Rebinding** (tên miền công khai phân giải về `127.0.0.1`, `169.254.169.254`, `10.24.0.5`, `100.64.1.1`, `::ffff:169.254.169.254`) với mã lỗi `SSRF_PROHIBITED_IP`.
5. **`API-SEC-05` — Malicious Media, Decompression Bombs & MIME Spoofing Quarantine**:
   - Chặn SVG chứa `<!DOCTYPE ... <!ENTITY xxe>` (`XXE_HAZARD`), `<script>`, `<foreignObject>`, `onload=`, `href="https://..."`, CSS `@import`, và bom cây DOM > 5.000 nút (`DOM_COMPLEXITY_LIMIT_EXCEEDED`).
   - Chặn WOFF2 khai báo số bảng vượt ngưỡng (`MALFORMED_FONT`), bom điểm ảnh PNG `8000×8000 = 64MP > 40MP` (`PIXEL_COUNT_EXCEEDED`), tệp MP4 giả mạo thiếu box `ftyp` (`INVALID_MEDIA_SIGNATURE`), và tệp PNG ngụy trang dưới MIME `font/ttf` (`INVALID_FONT_SIGNATURE`).
6. **`API-SEC-06` — Rate Limiting (`429 RATE_LIMITED`), Active Job Slot Quota (`QUOTA_EXCEEDED`) & Idempotency Conflict (`409`)**:
   - Kiểm chứng `TokenBucketRateLimiter` trả về `429 RATE_LIMITED` kèm header `Retry-After` khi vượt dung lượng burst; giới hạn `active_job_slots_max = 2` chặn job thứ 3 chuyển sang trạng thái `rendering` với `QuotaExceededError`; và tái sử dụng `Idempotency-Key` với thân yêu cầu bị thay đổi bị chặn với `409 IDEMPOTENCY_CONFLICT`.
7. **`API-SEC-07` — Webhook Secret One-Time Display, Idempotent Replay Redaction & Encrypted-at-Rest Storage**:
   - Yêu cầu `POST /v1/webhook-endpoints` đầu tiên trả về `201` kèm `signing_secret` (`whsec_...`); yêu cầu phát lại cùng `Idempotency-Key` trả về `201` nhưng ẩn hoàn toàn `signing_secret` và bật cờ `secret_redacted: true`; `GET /v1/webhook-endpoints/:id` không bao giờ trả về `signing_secret`; cột `secret_ciphertext` trong SQLite lưu bản mã AES-256-GCM (`v1:...`).
8. **`API-SEC-08` — `DELETE /v1/assets/:id` Cascade Revocation, Grant Invalidation (`410 GRANT_REVOKED`) & Tombstone Privacy**:
   - Khi xóa tài sản đang được sử dụng bởi một job đang chạy (`rendering`), lệnh xóa trả về `202 Accepted` (`status: "deleted"`), tự động chuyển job đang chạy sang trạng thái `failed` với mã lỗi `ASSET_REVOKED` và giải phóng (`released`) hạn ngạch sử dụng (`usage_reservations`).
   - URL tải xuống đã ký trước đó bị thu hồi tức thì (`410 GRANT_REVOKED`); bản ghi audit tombstone được giữ lại mà không chứa dữ liệu `rights` riêng tư; mọi nỗ lực tạo composition mới tham chiếu tới tài sản đã xóa đều bị chặn với `422 ASSET_REVOKED`.
9. **`API-SEC-09` — Worker Lease Epoch Fencing & Live-Lease Temp Sweeper Protection**:
   - Khi worker 1 bị hết hạn thuê bao ở `lease_epoch = 1` và worker 2 tiếp nhận ở `lease_epoch = 2`, mọi nỗ lực cập nhật/xuất bản muộn từ worker 1 bị `LeaseManager.verifyFence()` chặn đứng.
   - `StorageTempSweeper.sweep()` dọn sạch thư mục tạm của attempt mồ côi đã quá hạn nhưng **bảo toàn tuyệt đối** thư mục tạm của attempt đang có lease hoạt động (`att_live_01`).
10. **`API-SEC-10` — Post-Restore Safety Locks (`PostRestoreSafetyGate`)**:
    - Sau khi khôi phục thảm họa, `PostRestoreSafetyGate` mặc định khóa chặt `customCodeEnabled = false`, `remoteImportEnabled = false`, `outboundWebhooksEnabled = false` (`FEATURE_LOCKED_PENDING_REVALIDATION`). Việc mở khóa bị từ chối (`REVALIDATION_CHECKS_FAILED`) nếu bất kỳ kiểm tra tính toàn vẹn FK/object/tenant nào thất bại, và ngay cả sau khi mở khóa hợp lệ, `customCodeEnabled` vẫn luôn giữ ở trạng thái `false`.

---

## 6. Kết quả đo kiểm hiệu năng các chốt chặn bảo mật (`benchmarks/security-suite-benchmark.mjs`)

Kết quả chạy thực tế `node benchmarks/security-suite-benchmark.mjs` (500 vòng lặp mỗi phép đo):

| Chốt chặn bảo mật (Hot-Path Security Guard) | Số vòng lặp | Độ trễ `p50` (ms) | Độ trễ `p95` (ms) | Độ trễ `max` (ms) |
| :--- | :---: | :---: | :---: | :---: |
| `api_key_constant_time_hmac_verify` (`verifyApiKeyConstantTime`) | 500 | `0.0192` | `0.0511` | `2.0983` |
| `ssrf_url_normalization_and_ip_guard` (`validateAndNormalizeImportUrl`) | 500 | `0.0086` | `0.0213` | `8.0766` |
| `html_csp_and_svg_sanitization_guard` (`validateTemplateHtmlPolicy` + `probeAndSanitizeSvg`) | 500 | `0.0178` | `0.0342` | `5.1173` |
| `dual_log_secret_redaction` (`redactString` + `redactSecretOutput`) | 500 | `0.0122` | `0.0228` | `1.3451` |
| **Toàn bộ 24 kiểm tra bảo mật P6-04 (`SecurityReviewRunner.runFullReview`)** | **24 checks** | — | — | **`612 ms` tổng** |

---

## 7. Các cổng phụ thuộc bên ngoài (Pending External Gates) & Quyết định nghiệm thu

Các cổng vận hành/pháp lý bên ngoài được ghi nhận trung thực (không làm giả kết quả môi trường ngoài worktree):

1. **`EXT-SEC-01` (`PENDING_EXTERNAL_LEGAL_SIGNOFF`)**: Ký duyệt pháp lý thương mại cho bằng sáng chế codec H.264/AAC ở quy mô phân phối thương mại công khai và hợp đồng thương mại nhà cung cấp TTS bên ngoài (nếu bật ngoài kho giọng đọc nội bộ đã duyệt).
2. **`EXT-SEC-02` (`PENDING_STAGING_HOST_VERIFICATION`)**: Kiểm chứng kernel AppArmor/seccomp và quy tắc tường lửa egress (`iptables`/`nftables`) trực tiếp trên máy chủ VPS/staging Linux thực tế khi triển khai container `Dockerfile.renderer-sandbox`.
3. **`EXT-SEC-03` (`PENDING_EXTERNAL_KMS_ROTATION_DRILL`)**: Diễn tập xoay vòng khóa `CVE_API_KEY_PEPPER` và khóa mã hóa webhook trên hệ thống KMS/Vault staging thực tế.

**Quyết định cổng bảo mật P6-04**: **`APPROVED_FOR_PRIVATE_BETA_PENDING_EXTERNAL_GATES`** — Toàn bộ 24/24 bài kiểm tra bảo mật kỹ thuật trong repo đạt `PASS`, 2/2 phát hiện bảo mật (`SEC-P6-001`, `SEC-P6-002`) đã được khắc phục và kiểm chứng bằng test tự động, 0 lỗi nghiêm trọng (`critical`/`high`) còn tồn đọng.
