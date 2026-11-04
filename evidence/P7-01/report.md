# Evidence Report — Task P7-01: Custom Runtime ADR & Disposable MicroVM Isolated Build/Render

## 1. Thông tin chung (Task Metadata)

| Trường | Giá trị |
| :--- | :--- |
| **Task ID** | `P7-01` |
| **Phase / Owner** | `P7` / `C+Security reviewer` |
| **Branch / Worktree** | `agy/p7-01` (`/workspace/repo/.worktrees/p7-01`) |
| **Base Commit** | `8f44192f5fa7f7939988ef767b5d32dad2276070` |
| **Allowed Paths** | `["evidence/P7-01/", "packages/custom-runtime/"]` |
| **Dependencies** | `P6-05` |
| **Acceptance Criteria** | `Custom runtime ADR + disposable microVM isolated build/render, no egress/secrets/host FS, bounds; gVisor alternative cần explicit review, không downgrade` |
| **Tài liệu chuẩn tắc đối chiếu** | [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) |

---

## 2. Tóm tắt kiến trúc và các hạng mục đã triển khai (Deliverables Summary)

### 2.1. Quyết định kiến trúc Custom Runtime (`ADR-0002`)
- Ban hành đầy đủ **ADR 0002** tại [packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md](../../packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md) (và bản sao đồng nhất từng byte tại [evidence/P7-01/ADR-0002-custom-scene-microvm-runtime.md](./ADR-0002-custom-scene-microvm-runtime.md)).
- Thiết lập mô hình mối đe dọa cho mã cảnh tùy ý (`custom-html-v1`) do AI hoặc khách hàng cung cấp: chỉ dùng static AST scan, `node:vm`, `iframe` hoặc container chia sẻ host kernel (`docker`/`runc`) **không bao giờ đủ** để bật custom code.
- Giữ mặc định tắt (`CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME=disabled`, `CVE_CUSTOM_TENANT_ALLOWLIST=[]`) và tôn trọng công tắc ngắt khẩn cấp (`KILL_SWITCH_ACTIVE`).

### 2.2. Kiến trúc Disposable MicroVM tách biệt 2 pha (`custom-build-vm` & `custom-render-vm`)
- Triển khai tại [packages/custom-runtime/src/disposable-microvm-runtime.mjs](../../packages/custom-runtime/src/disposable-microvm-runtime.mjs) và [packages/custom-runtime/src/microvm-bounds.mjs](../../packages/custom-runtime/src/microvm-bounds.mjs):
  1. **Disposable Build MicroVM (`custom-build-vm`):**
     - Khởi tạo máy ảo dùng một lần chỉ dành cho pha biên dịch ngoại tuyến (`1 vCPU`, `1024 MiB RAM`, `swap = 0`, `128 PIDs`, `512 MiB` đĩa tạm, timeout `30_000 ms`).
     - Quét chính sách nguồn (`scanCustomSourceForForbiddenCapabilities`), kiểm tra danh sách trắng gói phụ thuộc đã cài sẵn trong ảnh chỉ đọc (`@creativanta/scene-runtime`, `@creativanta/scene-math`, `@creativanta/scene-easing`), cấm tuyệt đối `npm install` và các hook `preinstall`/`install`/`postinstall`.
     - Xuất gói đã biên dịch (`<= 20 MiB`), tính `sourceSha256`, `buildSha256` và mã băm kịch bản CSP `'sha256-<base64>'`, sau đó **hủy ngay lập tức** (`destroy`) máy ảo build và xóa sạch thư mục giam giữ.
  2. **Disposable Render MicroVM (`custom-render-vm`):**
     - Khởi tạo một microVM **mới hoàn toàn** cho mỗi lần render/preview (`2 vCPU`, `4096 MiB RAM`, `swap = 0`, `256 PIDs`, `8192 MiB` đĩa tạm, frame timeout `5000 ms`, render timeout `600 s`, preview timeout `120 s`, kill grace `<= 5000 ms`).
     - Cấm tái sử dụng microVM giữa pha build và pha render hoặc giữa hai lần chạy (`MICROVM_REUSE_FORBIDDEN`).
     - Bên trong guest VM vẫn bắt buộc chạy dưới UID/GID không đặc quyền `10001:10001`, giữ nguyên **Chromium sandbox** (từ chối `--no-sandbox` và các cờ nguy hiểm), truyền mảng đối số FFmpeg với `-protocol_whitelist "file,pipe"`, và kiểm tra magic byte đầu ra (`ftyp` cho MP4, chữ ký `89 50 4E 47` cho PNG).

### 2.3. Cưỡng chế Zero Egress, Zero Secrets, Zero Host FS & Hard Bounds
- Triển khai tại [packages/custom-runtime/src/isolation-guards.mjs](../../packages/custom-runtime/src/isolation-guards.mjs):
  - **No Egress:** Cấu hình Firecracker khóa `network-interfaces: []` (`0` NICs, chặn gắn TAP/veth với `EGRESS_NIC_FORBIDDEN`) và tắt dịch vụ metadata `mmds_config: null` (chặn `169.254.169.254`). Header CSP khóa cứng `default-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'` kèm mã băm `'sha256-...'`. Máy chủ tài sản chỉ gắn vào `127.0.0.1` bên trong sandbox và kiểm tra khớp SHA-256 từng tệp.
  - **No Secrets:** Môi trường khách chỉ nhận danh sách trắng cố định (`ALLOWED_MICROVM_GUEST_ENV_KEYS`); chặn mọi biến môi trường chứa `SECRET`, `PASSWORD`, `PEPPER`, `TOKEN`, `API_KEY`, `DATABASE_URL`, `AWS_*`, `OPENAI_*`, `CVE_AUTHORING_*`. Đầu ra `stdout`/`stderr` bị giới hạn tối đa `64 KiB` và lọc qua bộ che giấu 2 lớp kèm bộ dò canary.
  - **No Host FS:** Chặn tuyệt đối việc gắn kết `/var/run/docker.sock`, `/proc`, `/sys`, `/dev`, `/etc`, `/root`, `.env`, `.git`, `.agy`, `.worktrees`. Mọi tệp đầu vào được khóa chỉ đọc (`0o440` cho tệp, `0o550` cho thư mục; tiến trình con ghi đè nhận lỗi `EACCES`), chặn đường dẫn `..`, symlink và hardlink (`nlink > 1`).
  - **Bounds & Lease Fencing:** Giới hạn cgroup v2 (`cpu.max`, `memory.max`, `memory.swap.max=0`, `pids.max`), `smt: false`, hủy nhóm tiến trình bằng `SIGKILL` khi quá hạn (`RENDER_TIMEOUT`), chặn bom đĩa (`SANDBOX_RESOURCE_LIMIT`), và kiểm tra hàng rào `lease_epoch` trước khi công bố kết quả (`LEASE_FENCE_REJECTED`).

### 2.4. Phương án gVisor (`gvisor-runsc-v1`) cần Explicit Review & Cấm Hạ Cấp (No Downgrade)
- Triển khai tại [packages/custom-runtime/src/adr-policy.mjs](../../packages/custom-runtime/src/adr-policy.mjs):
  - **Cấm hạ cấp (Anti-Downgrade Hard Lock):** Mọi cấu hình yêu cầu `docker`, `runc`, `crun`, `containerd`, `podman`, `lxc`, `node-vm`, `vm`, `iframe`, `host`, `process`, `trusted-template-v1`, `standard-container` hoặc `simulated-microvm-prison` trong môi trường thực thi đều bị từ chối với `SANDBOX_SECURITY_VIOLATION` (`RUNTIME_DOWNGRADE_FORBIDDEN`).
  - **Kiểm tra ảo hóa máy chủ (`probeHostVirtualization`):** Khi máy chủ không có `/dev/kvm` hoặc thiếu nhị phân Firecracker/Kata, hệ thống **tuyệt đối không hạ cấp** xuống container thường mà giữ custom code ở trạng thái tắt (`CAPABILITY_DISABLED` / `VIRTUALIZATION_UNAVAILABLE`).
  - **gVisor (`gvisor-runsc-v1`) Explicit Review Gate:** Mặc định chặn `gvisor-runsc-v1` với lỗi `GVISOR_EXPLICIT_REVIEW_REQUIRED`. Chỉ cho phép khi có chứng chỉ phê duyệt có chữ ký HMAC-SHA256 hợp lệ (`verifyGvisorExplicitReviewApproval`) gắn với mã sửa đổi ADR (`adrAmendmentId`), mã băm runtime `sha256:<64 hex>`, xác nhận vượt qua bộ kiểm thử thoát hộp cát/tương thích/giới hạn tài nguyên và chưa hết hạn, đồng thời vượt qua đầy đủ 6 cổng `C1–C6` (`verifyC1ToC6Gates`).

---

## 3. Danh mục tệp tin và mã băm SHA-256 (Deliverable Artifacts & Checksums)

| Tệp tin | Vai trò | SHA-256 |
| :--- | :--- | :--- |
| [packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md](../../packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md) | Tài liệu kiến trúc chuẩn ADR 0002 cho Custom Scene MicroVM Runtime | `c40004ef55f0722323972939bba77d7b7c0a7b33db5dec93ca496823edb87969` |
| [packages/custom-runtime/src/adr-policy.mjs](../../packages/custom-runtime/src/adr-policy.mjs) | Chính sách ADR-0002, khóa chống hạ cấp, cổng ký duyệt gVisor & cổng `C1–C6` | `0d58b4f8e2a63f43326752f7b8dc6a1354cd470196402ea9c58d1f44fac164c9` |
| [packages/custom-runtime/src/microvm-bounds.mjs](../../packages/custom-runtime/src/microvm-bounds.mjs) | Định nghĩa và kiểm tra giới hạn tài nguyên Build/Render VM, cgroup v2 & Firecracker config | `f7eff057850e12cb2d13772b0446f89e63fd2f15b43fb12559e8508b65d5492e` |
| [packages/custom-runtime/src/isolation-guards.mjs](../../packages/custom-runtime/src/isolation-guards.mjs) | Bộ bảo vệ Zero Egress, Zero Secrets, Zero Host FS, quét mã nguồn & `MicroVmWorkspacePrison` | `8dbb77427b12e2d62bbd7009d25380ac0b7e1a00dc7825071335536498a6e916` |
| [packages/custom-runtime/src/disposable-microvm-runtime.mjs](../../packages/custom-runtime/src/disposable-microvm-runtime.mjs) | Thực thi Disposable Build/Render MicroVM và bộ tự kiểm tra 12 cổng `CRM-01`..`CRM-12` | `9ab2d542bac9a554d3f0ddee588c9ed645bf86e39cfc11ef65cddb79fd9fbdcc` |
| [packages/custom-runtime/src/cli.mjs](../../packages/custom-runtime/src/cli.mjs) | Công cụ CLI chạy `--self-test` và xuất bằng chứng kiểm toán JSON | `32b7afc25a8359b8f214ea4b92771fb044931746e85483ec41f7be266a139fea` |
| [packages/custom-runtime/index.mjs](../../packages/custom-runtime/index.mjs) | Điểm nhập ESM của gói `packages/custom-runtime` | `3bd517899b660ffd60449f9301e4cacaf17b0c946f3d6a613ee515a32b2dff1e` |
| [packages/custom-runtime/index.d.ts](../../packages/custom-runtime/index.d.ts) | Khai báo kiểu TypeScript cho `packages/custom-runtime` | `4560122d597cd40e6f31619b33a4abf6a5280f4b7ebef79995bbb6a265b674f3` |
| [packages/custom-runtime/tsconfig.json](../../packages/custom-runtime/tsconfig.json) | Cấu hình kiểm tra kiểu tĩnh TypeScript (`noEmit`) | `c71773add550b4d13688126c73ff6049f97c38b9d227340d8bae8821fbadea02` |
| [packages/custom-runtime/test/p7-01-custom-runtime.test.mjs](../../packages/custom-runtime/test/p7-01-custom-runtime.test.mjs) | Bộ kiểm thử đơn vị và bảo mật toàn diện (15 test cases / 3 test suites) | `97d0309c9642ae775647b586fba54f1daa7e512f21c3250aa4b26aea84e8ccf7` |
| [evidence/P7-01/ADR-0002-custom-scene-microvm-runtime.md](./ADR-0002-custom-scene-microvm-runtime.md) | Bản lưu trữ bằng chứng ADR 0002 trong thư mục `evidence/P7-01/` | `c40004ef55f0722323972939bba77d7b7c0a7b33db5dec93ca496823edb87969` |
| [evidence/P7-01/microvm-runtime-audit.json](./microvm-runtime-audit.json) | Báo cáo JSON tự kiểm tra 12/12 hạng mục `CRM-01`..`CRM-12` | `3b4ebeaf67b30d0062233d61ed6c9c00771e868f701a56c20c51dfd5b6c9c385` |

---

## 4. Bằng chứng kiểm thử thực tế (Verification & Test Evidence)

| Lệnh kiểm tra | Exit Code | Trạng thái | Chi tiết kết quả |
| :--- | :---: | :---: | :--- |
| `node packages/custom-runtime/src/cli.mjs --write-evidence evidence/P7-01` | `0` | `PASS` | Thực thi 12/12 bài kiểm tra tự động `CRM-01`..`CRM-12` và ghi báo cáo tại [evidence/P7-01/microvm-runtime-audit.json](./microvm-runtime-audit.json). |
| `npx tsc -p packages/custom-runtime/tsconfig.json --noEmit` | `0` | `PASS` | Kiểm tra kiểu tĩnh toàn bộ mã nguồn `.mjs` và `.d.ts` trong `packages/custom-runtime/` không có lỗi. |
| `node --test packages/custom-runtime/test/p7-01-custom-runtime.test.mjs` | `0` | `PASS` | 15/15 bài kiểm thử (3 suites) đạt 100%: ADR-0002, default-off, anti-downgrade lock, gVisor explicit review gate, C1–C6 attestation, bounds, zero egress/secrets/host FS, two-phase disposable build & render microVM. |
| `node --test ops/test/security-review-p6-04.test.mjs` | `0` | `PASS` | 4/4 suite bảo mật nền tảng (`P6-04` 24/24 checks, bao gồm SBOM/lockfile integrity, renderer security, API/tenant isolation) tiếp tục đạt 100%. |
| `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | 8/8 bài kiểm tra hộp cát của controller (`custom_code_disabled_gate`, non-root, Chromium flags, FFmpeg whitelist, cgroup v2, zero egress) đạt 100%. |
| `node scripts/health-check.mjs` | `0` | `PASS` | Kiểm tra cấu hình mặc định `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, `custom-html-v1: false`. |
| `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra cấu trúc kho lưu trữ, đường dẫn hợp lệ, tài liệu Markdown và JSON blocks. |

### Tóm tắt 12 hạng mục trong `evidence/P7-01/microvm-runtime-audit.json`

```json
{
  "taskId": "P7-01",
  "adrId": "ADR-0002",
  "status": "PASS",
  "totalChecks": 12,
  "passedChecks": 12,
  "failedChecks": 0,
  "hostVirtualization": {
    "devKvmPath": "/dev/kvm",
    "kvmDeviceExists": false,
    "kvmReadableWritable": false,
    "microVmHardwareReady": false,
    "recommendedActionWhenUnavailable": "Keep CVE_CUSTOM_CODE_ENABLED=false and CVE_CUSTOM_RUNTIME=disabled; never downgrade to standard containers."
  },
  "defaultFeatureState": {
    "CVE_CUSTOM_CODE_ENABLED": false,
    "CVE_CUSTOM_RUNTIME": "disabled",
    "CVE_CUSTOM_TENANT_ALLOWLIST": []
  }
}
```

---

## 5. Giới hạn môi trường hiện tại và Cổng phụ thuộc bên ngoài (Pending External Gates)

Tuân thủ nghiêm ngặt quy tắc trung thực trong [AGENTS.md](../../AGENTS.md) và [docs/SECURITY.md](../../docs/SECURITY.md):

1. **`EXT-P7-01` — Môi trường máy chủ KVM / Firecracker / Kata thực tế (`NOT_RUN` trên container CI không có `/dev/kvm`):**
   - Máy trạm phát triển hiện tại không gắn thiết bị phần cứng `/dev/kvm` (`kvmDeviceExists: false`) và chưa cài đặt nhị phân `firecracker`/`jailer` hoặc `kata-runtime`.
   - Đúng theo [docs/SECURITY.md](../../docs/SECURITY.md) (dòng 45) và [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md) (dòng 120): `probeHostVirtualization()` phát hiện chính xác trạng thái này, giữ tính năng custom code ở trạng thái tắt (`CAPABILITY_DISABLED` / `VIRTUALIZATION_UNAVAILABLE`) và **tuyệt đối không hạ cấp** xuống container thông thường. Các bài kiểm thử tự động sử dụng chế độ tự kiểm tra cô lập (`securitySelfTestMode: true`) để xác minh toàn bộ quy trình đóng gói, cô lập tệp chỉ đọc (`0o440`), giới hạn tài nguyên, lọc bí mật, máy chủ loopback `127.0.0.1` và vòng đời hủy máy ảo.
2. **`EXT-P7-02` — Cổng ký duyệt bảo mật `C1–C6` và phê duyệt pilot (`P7-05` / `P7-06`):**
   - Tính năng custom scene code vẫn giữ mặc định tắt (`CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME=disabled`) cho đến khi hoàn tất các task `P7-02`, `P7-03`, `P7-04`, vượt qua bộ kiểm thử thoát hộp cát tại `P7-05` và bật theo allowlist có công tắc ngắt tại `P7-06`.
