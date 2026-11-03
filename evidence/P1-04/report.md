# Báo cáo bằng chứng nghiệm thu nhiệm vụ P1-04

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P1-04` (`C / P1`): Triển khai sandbox và narrow runtime launcher tối thiểu cho structured trusted templates (`nonroot`, `Chromium sandbox`, `no egress`, `read-only inputs`, `cgroup/time/disk/PID limits`, `no host socket`, `self-test pass`, `custom off`) theo chuẩn quy định tại [AGY execution](../../docs/AGENTS.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security](../../docs/SECURITY.md), [Deployment](../../docs/DEPLOYMENT.md), [Architecture](../../docs/ARCHITECTURE.md) và [Testing](../../docs/TESTING.md).

```text
Task: P1-04
Base / tested commit: 340ac073513591b59764a57297ba59da1f25c4cb / 340ac073513591b59764a57297ba59da1f25c4cb
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPUs, 15GiB RAM, Python 3.11.2, Node v24.22.2, pnpm 12.16.1
Command: pnpm build && pnpm typecheck && pnpm lint && pnpm test && node packages/controller/dist/index.js --self-test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T03:59:49Z / 6.2s
Artifacts:
  - packages/controller/src/sandbox.ts, sha256=abcff2046cfe8964599b2c3215d95260bf8eb1169dfaa61580f9dda8984d5c8b, expires=N/A (repo-versioned)
  - packages/controller/src/index.ts, sha256=d53061b14c969fbb238fc19132866d55f305d316aa484944abf06a371fc8d9a1, expires=N/A (repo-versioned)
  - packages/controller/test/sandbox.test.mjs, sha256=34bbc6b6b5f0061fed286ab5f0002c206707a8e10974627df0624fa92e9c937f, expires=N/A (repo-versioned)
  - docker/Dockerfile.renderer-sandbox, sha256=6bc598e7e9e66d5b8f14768cf3846c3e246490ee96bfe820bb0029d8c30bb127, expires=N/A (repo-versioned)
  - docker/seccomp-renderer.json, sha256=df1672d7c6fc22956e096cfd34492ecb3930e8c4e20baefdcfcb9409df954ea0, expires=N/A (repo-versioned)
  - evidence/P1-04/sandbox-self-test.json, sha256=02e67ae635855f7cf5f3b7f88f10d54bf03e5334f763a17a43c431ecf9ffc8f1, expires=N/A (repo-versioned)
Acceptance mapping:
  - nonroot: PASS — Thực thi bắt buộc dưới UID/GID 10001 (cve-render), từ chối UID/GID 0 (root), readOnlyRootfs=true, noNewPrivileges=true, privileged=false, capDrop=[ALL], capAdd=[] và hồ sơ seccomp docker/seccomp-renderer.json
  - Chromium sandbox: PASS — Bắt buộc bật Chromium sandbox, chặn tuyệt đối --no-sandbox và 11 cờ làm yếu sandbox, áp dụng 24 cờ khởi chạy tất định, CSP connect-src 'none' và FFmpeg argv mảng kèm -protocol_whitelist "file,pipe"
  - no egress: PASS — Cô lập mạng --network=none không có kết nối ngoại bộ; LoopbackAssetServer chỉ lắng nghe 127.0.0.1 và phục vụ các tài sản đã đăng ký trong manifest khớp SHA-256
  - read-only inputs: PASS — Staged inputs được khóa quyền 0440/0550 và mount readonly (/workspace/inputs:ro), chặn symlink/hardlink/path traversal, xác thực magic bytes (MP4 ftyp / PNG header) và dọn dẹp sạch sau mỗi attempt
  - cgroup/time/disk/PID limits: PASS — Áp đặt ngân sách cgroup v2 (cpu.max="200000 100000" cho 2 vCPU, memory.max=4294967296 cho 4096 MiB, memory.swap.max="0", pids.max="256"), hạn ngạch đĩa tạm 8192 MiB và timeout cứng kèm hủy toàn bộ process group (-pgid SIGKILL)
  - no host socket: PASS — Chặn mount Docker socket (/var/run/docker.sock), containerd/podman socket, SSH agent, /proc, /sys, /etc, /root, và lọc bỏ mọi biến môi trường nhạy cảm của controller khỏi tiến trình render
  - self-test pass: PASS — Bộ kiểm tra tự động runSandboxSelfTest() và CLI (--self-test) vượt qua 8/8 bài kiểm tra thực tế, tích hợp trực tiếp vào probe /readyz của controller
  - custom off: PASS — Giữ CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled, danh sách tenant rỗng và từ chối mọi yêu cầu custom-html-v1 hoặc bundle với mã lỗi CAPABILITY_DISABLED
Reviewer / reviewed commit / decision: pending independent reviewer / 340ac073513591b59764a57297ba59da1f25c4cb / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P1-04** (`C / P1`) xây dựng lớp phòng thủ thời gian chạy cốt lõi (sandbox & narrow runtime launcher) cho trình kết xuất mẫu tin cậy (structured trusted templates) dựa trên kết quả kiểm toán tại [báo cáo P0-02](../P0-02/report.md) và mô hình mối đe dọa tại [báo cáo P0-04](../P0-04/report.md).

Lưu ý phạm vi G1 Scaffold ([Testing](../../docs/TESTING.md)): nhiệm vụ này cung cấp sandbox launcher, bộ kiểm tra tự thân (`self-test`), hồ sơ container/seccomp và bộ kiểm thử bảo mật đơn vị/tích hợp; **chưa thực hiện kết xuất video MP4 thực tế** (việc tích hợp bộ dựng hình và xuất 3 video POC thuộc phạm vi `P2-01`..`P2-05`).

Các hạng mục đã hoàn thành trong phạm vi đường dẫn được cấp phép (`packages/`, `docker/`, `evidence/P1-04/`):

1. **Module Sandbox & Narrow Runtime Launcher ([sandbox.ts](../../packages/controller/src/sandbox.ts)):**
   - **Thực thi không đặc quyền (`nonroot`):** Định nghĩa `SANDBOX_DEFAULT_UID = 10001`, `SANDBOX_DEFAULT_GID = 10001` (`cve-render`), `buildDefaultSecurityContext` và `validateSecurityContext`. Từ chối tức thì mọi cấu hình dùng `uid = 0`, `gid = 0`, `userName = "root"`, `privileged = true`, `readOnlyRootfs = false`, `noNewPrivileges = false`, thiếu `capDrop: ["ALL"]`, hoặc `seccompProfile = "unconfined"`.
   - **Chính sách Chromium Sandbox & FFmpeg Argv (`Chromium sandbox`):**
     - `buildChromiumSandboxArgs` và `validateChromiumFlags` khóa cứng 24 cờ khởi chạy an toàn (`--headless=new`, `--disable-gpu`, `--disable-dev-shm-usage`, `--disable-background-networking`, `--run-all-compositor-stages-before-draw`, `--remote-debugging-port=0`, v.v.) và chặn tuyệt đối `--no-sandbox`, `--disable-setuid-sandbox`, `--no-zygote`, `--single-process`, `--disable-seccomp-filter-sandbox`, `--disable-namespace-sandbox`, `--disable-web-security`.
     - `validateTemplateHtmlPolicy` kiểm tra HTML mẫu không chứa URL mạng ngoài (`http://`, `https://`, Google Fonts CDN `@import`), XXE `<!ENTITY>`, `navigator.serviceWorker` hoặc `RTCPeerConnection`.
     - `buildFfmpegSandboxArgv` và `buildFfprobeSandboxArgv` ép buộc truyền tham số dạng mảng `string[]` kèm `-nostdin`, `-protocol_whitelist "file,pipe"`, `-probesize 32M`, `-analyzeduration 32M`; chặn `--enable-nonfree`, `libfdk_aac` và các giao thức mạng/playlist (`http:`, `https:`, `concat:`, `subfile:`, `crypto:`).
   - **Cô lập mạng hoàn toàn (`no egress`):**
     - Cấu hình container bắt buộc `--network none` và header `TRUSTED_TEMPLATE_CSP` (`connect-src 'none'`).
     - Triển khai `LoopbackAssetServer` chỉ lắng nghe trên `127.0.0.1`, chỉ phục vụ phương thức `GET`/`HEAD` đối với danh sách tài sản cục bộ đã đăng ký trong manifest và kiểm tra khớp mã băm SHA-256 trước khi trả byte; chặn truy vấn ngoài danh sách (`404`), chặn query string / path traversal (`403`) và không bao giờ liệt kê thư mục hay proxy ra ngoài.
   - **Đầu vào chỉ đọc & Cô lập Workspace (`read-only inputs`):**
     - `SandboxWorkspaceManager` tạo thư mục tách biệt theo `jobId` và `attemptId` đã kiểm tra biểu thức chính quy `^[a-zA-Z0-9_-]{1,64}$`.
     - `stageInputs` kiểm tra giới hạn bundle v1 (`≤100` tệp, `≤5 MiB` mã nguồn, `≤20 MiB` tài sản, độ sâu thư mục `≤8`), đối chiếu SHA-256, ghi tệp với quyền `0440` và khóa thư mục `inputs/` ở chế độ `0550` (chỉ đọc), đồng thời mount vào container với cờ `readonly`.
     - `verifyOutputArtifact` kiểm tra tệp xuất trong `output/` bằng `lstat` (chặn symlink, hardlink `nlink > 1`, FIFO/socket/device), kiểm tra kích thước khác 0, đối chiếu hạn ngạch đĩa và xác thực magic bytes định dạng (`ftyp` tại byte 4..8 cho MP4; chữ ký 8 byte chuẩn cho PNG).
   - **Giới hạn tài nguyên Cgroup v2, Thời gian, Đĩa và PID (`cgroup/time/disk/PID limits`):**
     - `buildCgroupV2Spec` và `validateResourceLimits` ánh xạ ngân sách `starter-v1`: `2 vCPU` (`cpu.max = "200000 100000"`), `4096 MiB` RAM (`memory.max = "4294967296"`, `memory.swap.max = "0"`), `256` PIDs (`pids.max = "256"`), `8192 MiB` đĩa tạm, frame timeout `5000 ms`, render timeout `600 s`, preview timeout `120 s`.
     - `TrustedTemplateLauncher.runSandboxedProcess` khởi chạy tiến trình con trong process group độc lập (`detached: true`), giám sát hạn ngạch đĩa định kỳ và tự động hủy toàn bộ cây tiến trình (`process.kill(-pid, 'SIGKILL')`) khi vượt thời gian chờ (`RENDER_TIMEOUT` / `FRAME_READINESS_TIMEOUT`).
   - **Chặn Host Socket & Làm sạch môi trường (`no host socket`):**
     - `validateHostMounts` chặn tuyệt đối việc mount `/var/run/docker.sock`, `/run/docker.sock`, `containerd.sock`, `podman.sock`, `ssh-agent`, `/proc`, `/sys`, `/dev`, `/etc`, `/root`, `.env`, `.git`, `.agy`, `.worktrees`.
     - `validateImageDigest` bắt buộc định dạng bất biến `sha256:<64 lowercase hex>`, từ chối tag động `:latest` và chặn digest placeholder phát triển khi chạy ở `staging`/`production`.
     - `buildSanitizedSandboxEnv` chỉ cấp phát tập biến môi trường tối thiểu (`TZ=UTC`, `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, `HOME=/workspace/tmp`, `TMPDIR=/workspace/tmp`, `CVE_SANDBOX_JOB_ID`, `CVE_SANDBOX_ATTEMPT_ID`, `CVE_SANDBOX_MODE=trusted-template-v1`), loại bỏ toàn bộ thông tin kết nối DB/S3/API pepper của controller.
   - **Khóa tính năng Custom Code (`custom off`):**
     - `assertCustomCodeGate` đảm bảo `CVE_CUSTOM_CODE_ENABLED = false` và `CVE_CUSTOM_RUNTIME = "disabled"`, từ chối mọi yêu cầu `engine = "custom-html-v1"` hoặc `bundle` với mã lỗi `CAPABILITY_DISABLED` (`retryable: false`), đồng thời ngăn chặn hạ cấp sang container thông thường nếu chưa có microVM và chứng nhận cổng bảo mật `C1–C6`.
2. **Tích hợp Controller Readiness & CLI Self-Test ([index.ts](../../packages/controller/src/index.ts)):**
   - Bổ sung endpoint `GET /readyz` trên controller thực thi trực tiếp `runSandboxSelfTest()`; nếu bất kỳ kiểm tra sandbox nào thất bại hoặc `CVE_CUSTOM_CODE_ENABLED` bị bật trái phép, worker trả về HTTP `503` (`not_ready`).
   - Hỗ trợ cờ CLI `node packages/controller/dist/index.js --self-test` xuất báo cáo JSON đầy đủ của 8 hạng mục kiểm tra tự thân.
3. **Định nghĩa Container Sandbox & Hồ sơ Seccomp ([Dockerfile.renderer-sandbox](../../docker/Dockerfile.renderer-sandbox), [seccomp-renderer.json](../../docker/seccomp-renderer.json)):**
   - Thiết lập container renderer tách biệt chạy dưới `USER 10001:10001` (`cve-render`) với Chromium, FFmpeg và font chữ nguồn mở Noto, kèm hồ sơ seccomp chặn các lời gọi hệ thống nguy hiểm (`mount`, `ptrace`, `kexec_load`, `bpf`, `init_module`, `swapon`, `reboot`, `userfaultfd`, `keyctl`).

---

## 2. Nhật ký kiểm tra thực tế (Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Chi tiết nghiệm thu |
| --- | --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | `0` | `PASS` | Lockfile bất biến khớp hoàn toàn, không cài đặt thêm dependency bên thứ ba |
| 2 | `pnpm build` | `0` | `PASS` | Biên dịch TypeScript thành công toàn bộ 4 packages trong workspace |
| 3 | `pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh strict mode không có lỗi |
| 4 | `pnpm lint` | `0` | `PASS` | Kiểm tra quy chuẩn mã nguồn thành công |
| 5 | `pnpm test` | `0` | `PASS` | Vượt qua toàn bộ 41/41 unit & integration tests (bao gồm 17 test cases mới trong [sandbox.test.mjs](../../packages/controller/test/sandbox.test.mjs)) |
| 6 | `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | Vượt qua 8/8 bài kiểm tra tự thân thực tế của sandbox (`status: "PASS"`) |
| 7 | `node scripts/health-check.mjs` | `0` | `PASS` | Kiểm tra cấu hình môi trường và endpoints `/healthz`, `/readyz`, `/v1/capabilities` đạt `PASS` |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Tất cả tài liệu chuẩn tắc, liên kết nội bộ, khối JSON và DAG đều hợp lệ (`0` lỗi) |
| 9 | `python3 -m unittest discover -s tooling/agent_harness/tests -v` | `0` | `PASS` | 10/10 bài kiểm thử supervisor harness vượt qua |
| 10 | `python3 -m unittest evidence/P0-05/test_task_ledger.py` | `0` | `PASS` | 13/13 bài kiểm thử task ledger, worktree policy và evidence validator vượt qua |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor đẩy nhánh `agy/p1-04`, mở PR vào `staging`, chạy GitHub Actions workflow `Validate Video Engine` và reviewer độc lập phê duyệt chuyển trạng thái nhiệm vụ sang `done`.
2. **Container Runtime & Host Kernel User-Namespace Verification (P2-01):** Việc khởi chạy thực tế trình duyệt Chromium headless bên trong container OCI với `--network=none` để chụp khung hình và mã hóa video MP4 sẽ được thực hiện và đo kiểm tại nhiệm vụ `P2-01` sau khi `P1-03` và `P1-04` hoàn tất.
