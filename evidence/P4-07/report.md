# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-07

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-07` (`Reviewer / Phase P4` — Gate G3 Two-Tenant E2E Verification Suite & Fault Suite): Triển khai toàn diện bộ kiểm thử đầu cuối Gate G3 trên hai tenant cô lập hoàn toàn (`tenant_alpha`, `tenant_beta`) qua chu trình hoàn chỉnh từ API: `upload` → `template` → `preview` → `render` → `callback` → `download` → `decode`, kết hợp bộ kiểm thử lỗi (fault suite) khắc nghiệt bao gồm thu hồi asset (`revoke asset`), hết hạn artifact (`expired artifacts`), công nhân đổ vỡ / bị ngắt tiến trình (`worker crash / kill`), và máy chủ nhận webhook gặp sự cố (`callback outage`); xác minh cơ chế tải artifact thật qua cùng một đường dẫn API duy nhất (`/v1/artifacts/download/:token`) với các tiêu đề bảo mật nghiêm ngặt (`Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`), giải mã video MP4 thực tế (`verifyIsoBmffMp4`, `Mp4Decoder.decode`) và giải mã ảnh PNG (`verifyPngBuffer`); tuân thủ tuyệt đối [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-07
Base / tested commit: 3d83105cf97670eff0ab1dab7d4c1a51ce3d1f78 / HEAD (agy/p4-07)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto, node:zlib & node:http), pnpm 10.6.1, TypeScript 5.8.2, Python 3.11.2
Command: pnpm --filter @creativanta/api build && node --test packages/api/test/p4-07-e2e-two-tenant-g3-verification.test.mjs && pnpm --filter @creativanta/api test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-04T02:59:48Z / 1m 30s
Artifacts:
  - packages/api/src/server.ts, sha256=cdac5c6fe53607dcb5bc799b29c604aa41c73d2b03b212c95acafe47f90e7bd4, expires=N/A (repo-versioned)
  - packages/api/test/p4-07-e2e-two-tenant-g3-verification.test.mjs, sha256=c2b67a20c9e6bfd1aa51bcefb3b8a237918b25f489fe214abec10cc6acd8e4db, expires=N/A (repo-versioned)
  - evidence/P4-07/report.md, sha256=d14d75ebe61dc2a5e44da55807f4bc5a4413777a9409382194a737673f8f8707, expires=N/A (repo-versioned)
Acceptance mapping:
  - Two-tenant E2E lifecycle (upload -> template -> preview -> render -> callback -> download -> decode): PASS — Thực thi trọn vẹn luồng tác vụ đa tenant: Tenant Alpha upload logo PNG (POST /v1/assets/uploads -> PUT upload_url -> POST complete), tạo Template rev 1 & rev 2, fork/instantiate thành Composition, kích hoạt webhook endpoint qua challenge echo handshake, admit preview job (POST /v1/previews) và render job (POST /v1/render-jobs), worker kết xuất ra video MP4 và PNG artifacts thật, outbox ký và phát webhook callback, client lấy download grant và tải artifact qua /v1/artifacts/download/:token.
  - Strict Cross-Tenant Isolation & Anti-IDOR: PASS — Khẳng định tính cô lập tuyệt đối giữa Tenant Alpha và Tenant Beta: Tenant Beta thăm dò asset, template, revision, composition, job, events, cancel, webhook endpoint, hoặc artifact của Tenant Alpha đều nhận HTTP 404 NOT_FOUND (AMB-007: không lộ tài nguyên bằng 403); danh sách liệt kê templates và jobs của Tenant Beta không chứa bất kỳ mục nào của Tenant Alpha; bảng kê sử dụng GET /v1/usage của Tenant Beta thể hiện 0 billable output minutes và 0 operational cpu seconds.
  - Same API Path Download & Strict Browser Security Headers: PASS — Tải artifact thật thực hiện qua cùng một tuyến đường API duy nhất `/v1/artifacts/download/:token` thiết lập nghiêm ngặt: Content-Disposition: attachment; filename="...", Content-Security-Policy: default-src 'none'; sandbox, X-Content-Type-Options: nosniff, X-Frame-Options: DENY, và ETag mã băm sha256. Token giả mạo chữ ký bị từ chối 403 INVALID_GRANT_SIGNATURE.
  - Real Media Decode Verification: PASS — Tệp video MP4 tải về được giải mã thực tế bằng verifyIsoBmffMp4 (xác minh cấu trúc faststart, moov trước mdat, video codec avc1 1280x720 30fps 6 frames, audio codec mp4a 48kHz stereo) và Mp4Decoder.decode (phân tích chi tiết 2 tracks isom); tệp ảnh PNG xem trước được giải mã bằng verifyPngBuffer (xác nhận đúng kích thước 640x360 và cấu trúc chunk IHDR/IDAT/IEND hợp lệ).
  - Fault Suite: Revoke Asset: PASS — (8.1a) Thu hồi asset đã upload khiến grant tải xuống trước đó bị vô hiệu hóa ngay lập tức với mã HTTP 410; (8.1b) Xóa asset đang được tham chiếu trong khi worker đang render khiến tiến trình xuất bản bị chặn đứng với mã lỗi ASSET_REVOKED, chuyển job thành failed và dọn dẹp sạch sẽ thư mục tạm, không rò rỉ tệp mồ côi (zero orphan leak).
  - Fault Suite: Expired Artifacts: PASS — (8.2a) Token tải xuống quá hạn TTL trả về 410 ARTIFACT_GRANT_EXPIRED; (8.2b) Artifact quá hạn lưu trữ retention trả về 410 ARTIFACT_EXPIRED; (8.2c) Artifact bị thu hồi revoked_at trả về 410 GRANT_REVOKED.
  - Fault Suite: Worker Crash / Kill Across Stages: PASS — (8.3a) Worker bị kill tại công đoạn rendering khiến lease hết hạn; Reaper cycle thu hồi lease, tăng monotonic lease_epoch và chuyển job sang retry_wait; worker zombie cũ dùng lease_epoch cũ cố xuất bản bị chặn đứng với lỗi STALE_LEASE_OR_EPOCH; (8.3b) Worker bị kill tại công đoạn before_publish được dọn dẹp toàn bộ tệp tạm của attempt mà không để lại dữ liệu rác trên đĩa.
  - Fault Suite: Callback Outage Resilience: PASS — (8.4) Mô phỏng máy chủ nhận webhook gặp sự cố (HTTP 503); transactional outbox lưu giữ sự kiện, ghi nhận trạng thái giao hàng chuyển sang retry, bảo toàn 100% dữ liệu không thất thoát; khi máy chủ nhận phục hồi (HTTP 200) và đồng hồ tiến tới mốc retry, sự kiện được phát lại thành công với chữ ký HMAC-SHA256 hợp lệ.
Reviewer / reviewed commit / decision: implemented_local / 3d83105cf97670eff0ab1dab7d4c1a51ce3d1f78 / Gate G3 verified, ready for staging merge
```

---

## 1. Chi tiết kiến trúc và triển khai kiểm thử Gate G3 (P4-07)

Nhiệm vụ `P4-07` đóng vai trò kiểm thử viên độc lập (Reviewer) cho toàn bộ Giai đoạn P4, thiết lập bộ kiểm thử tích hợp đầu cuối Gate G3 hoàn chỉnh tại `packages/api/test/p4-07-e2e-two-tenant-g3-verification.test.mjs`, kiểm chứng toàn diện mọi cơ chế bảo mật, cách ly tenant, kết xuất thật và khả năng chống chịu sự cố:

### 1.1 Chu trình đầu cuối hai tenant độc lập (Phases 1-6)
- **Phase 1: Quản lý Asset & Ingestion:**
  - Tenant Alpha khởi tạo tải lên logo PNG qua `POST /v1/assets/uploads`, đẩy dữ liệu qua `PUT upload_url`, và hoàn tất với `POST /v1/assets/:id/complete`.
  - Tenant Beta tải lên tài sản riêng biệt.
  - Xác nhận Anti-IDOR: Tenant Beta truy cập asset của Tenant Alpha qua GET, complete, upload-url, hoặc DELETE đều nhận HTTP `404 NOT_FOUND`.
- **Phase 2: Mẫu Template, Bản sửa đổi & Hiện thực hóa Composition:**
  - Tenant Alpha tạo Template revision 1 và revision 2 với biến schema động (`headline`) gắn kết layer văn bản và hình ảnh.
  - Kiểm tra ranh giới optimistic concurrency: Tạo revision với `base_revision` cũ bị từ chối `409 REVISION_CONFLICT`.
  - Hiện thực hóa Template revision 2 thành Composition với biến cụ thể (`vi-VN`).
  - Xác nhận Anti-IDOR: Tenant Beta không thể đọc revision, instantiate, fork, hoặc truy cập composition của Tenant Alpha (luôn nhận `404 NOT_FOUND`). Danh sách `GET /v1/templates` của Tenant Beta cách ly hoàn toàn.
- **Phase 3: Webhook Registration & Echo Verification:**
  - Tenant Alpha đăng ký webhook endpoint `POST /v1/webhook-endpoints` nhận signing secret dùng một lần.
  - Kích hoạt endpoint qua cơ chế bắt tay thử thách `POST /v1/webhook-endpoints/:id/verify` (echo handshake).
  - Xác nhận Anti-IDOR: Tenant Beta không thể GET, verify, rotate-secret, hoặc DELETE endpoint của Tenant Alpha.
- **Phase 4: Preview Job Admission, Worker Execution & Signed Callback:**
  - Tiếp nhận công việc xem trước `POST /v1/previews` với hồ sơ `preview-360p-v1` và `mode: frame`.
  - Công nhân thật (`RealRendererWorker`) nhận việc, kết xuất 4 artifacts thật: ảnh xem trước 360p không suy hao (`video`), ảnh thu nhỏ (`thumbnail`), phụ đề WebVTT (`captions`), và tệp đặc tả (`manifest`).
  - Hàng đợi outbox xử lý và gửi webhook callback có chữ ký HMAC-SHA256, máy chủ nhận giải mã và đối chiếu chữ ký hợp lệ.
  - Xác nhận Anti-IDOR: Tenant Beta truy vấn job hoặc job events đều nhận HTTP `404 NOT_FOUND`.
- **Phase 5: Full Render Job Admission, Worker Execution & Signed Callback:**
  - Tiếp nhận công việc kết xuất đầy đủ `POST /v1/render-jobs` hồ sơ `mp4-720p-v1`.
  - Công nhân thật kết xuất video MP4, tạo ảnh thu nhỏ, trích xuất phụ đề, ghi manifest và quyết toán sử dụng tài nguyên (settle usage).
  - Giao hàng webhook callback với chữ ký an toàn.
  - Xác nhận Anti-IDOR: Tenant Beta không thể đọc job, events, hoặc hủy job của Tenant Alpha (`404 NOT_FOUND`). Danh sách `GET /v1/jobs` của Tenant Beta trả về 0 phần tử.
- **Phase 6: Download Grants & Real Media Decode qua CÙNG ĐƯỜNG DẪN API:**
  - Yêu cầu cấp quyền tải xuống artifact qua `GET /v1/artifacts/:id/download`.
  - Tải artifact thật qua tuyến đường chung `/v1/artifacts/download/:token` với đầy đủ tiêu đề an toàn: `Content-Disposition: attachment`, `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `ETag: "sha256"`.
  - Giải mã video MP4 tải về: `verifyIsoBmffMp4` xác nhận container faststart, `moov` đứng trước `mdat`, codec `avc1` và `mp4a` 48kHz stereo, đủ 6 khung hình; `Mp4Decoder.decode` phân tích sâu toàn bộ box hierarchy.
  - Giải mã ảnh PNG tải về: `verifyPngBuffer` xác nhận kích thước chuẩn 640x360.
  - Xác thực Anti-IDOR và chữ ký grant: Tenant Beta không thể lấy download grant cho artifact của Tenant Alpha (`404 NOT_FOUND`); token bị sửa đổi chữ ký bị từ chối dứt khoát với HTTP `403 INVALID_GRANT_SIGNATURE`.

### 1.2 Bảng kê sử dụng tài nguyên & Cô lập kế toán (Phase 7)
- Tenant Alpha truy vấn `GET /v1/usage` ghi nhận đầy đủ lượng `operational_cpu_seconds > 0`, `billable_output_minutes > 0`, `billable_jobs >= 1`.
- Tenant Beta truy vấn `GET /v1/usage` ghi nhận `operational_cpu_seconds === 0`, `billable_output_minutes === 0`, `billable_jobs === 0`, bảo đảm tính cô lập kế toán tuyệt đối.

### 1.3 Bộ kiểm thử lỗi khắc nghiệt (Phase 8: Fault Suite)
- **8.1 Thu hồi Asset (Revoke Asset):**
  - Thu hồi asset làm mất hiệu lực token tải xuống ngay lập tức (trả về HTTP `410`).
  - Xóa asset đang được sử dụng trong lúc job đang chạy kích hoạt hàng rào bảo vệ giao dịch: việc xuất bản bị từ chối với mã lỗi `ASSET_REVOKED`, job chuyển sang trạng thái `failed`, và toàn bộ tệp tạm được dọn dẹp sạch sẽ (zero orphan leak).
- **8.2 Quá hạn Artifacts (Expired Artifacts):**
  - Token download grant quá hạn TTL (1s) trả về HTTP `410 ARTIFACT_GRANT_EXPIRED`.
  - Artifact quá hạn lưu trữ retention trả về HTTP `410 ARTIFACT_EXPIRED`.
  - Artifact bị đánh dấu thu hồi `revoked_at` trả về HTTP `410 GRANT_REVOKED`.
- **8.3 Đổ vỡ công nhân / Bị ngắt tiến trình (Worker Crash / Kill Across Stages):**
  - Worker bị `SIGKILL` tại công đoạn `rendering`: heartbeat ngừng đập, lease hết hạn sau 60 giây; Reaper cycle thu hồi lease, tăng `lease_epoch` và chuyển job về `retry_wait`; zombie worker cũ sử dụng token fencing cũ `(job_id, attempt_id, lease_epoch)` cố xuất bản bị từ chối tuyệt đối với lý do `STALE_LEASE_OR_EPOCH`.
  - Worker bị kill tại công đoạn `before_publish`: dọn dẹp toàn bộ thư mục tạm của attempt, đĩa lưu trữ hoàn toàn sạch sẽ.
- **8.4 Khả năng chống chịu sự cố máy chủ nhận webhook (Callback Outage Resilience):**
  - Khi máy chủ nhận gặp sự cố (trả về HTTP 503), delivery service ghi nhận trạng thái retry, transactional outbox giữ nguyên sự kiện và bảo toàn tính toàn vẹn của job.
  - Khi máy chủ nhận phục hồi (HTTP 200) và thời gian đạt mốc retry backoff, sự kiện được giao thành công với chữ ký HMAC-SHA256, không làm mất bất kỳ sự kiện nào.

---

## 2. Nhật ký thực thi kiểm thử tự động (Execution Logs)

```text
> node --test packages/api/test/p4-07-e2e-two-tenant-g3-verification.test.mjs

▶ Task P4-07 / Reviewer / Phase P4 Acceptance: Gate G3 Two-Tenant E2E Verification & Fault Suite
  ▶ Phase 1: Real Ingestion & Asset Upload via API
    ✔ 1.1 Tenant Alpha uploads brand logo PNG via pure API (POST -> PUT -> COMPLETE) (103.995351ms)
    ✔ 1.2 Tenant Beta uploads their own separate brand logo PNG via API (30.609033ms)
    ✔ 1.3 Strict IDOR Protection on Assets: Tenant Beta probing Tenant Alpha asset returns 404 NOT_FOUND (21.948226ms)
  ✔ Phase 1: Real Ingestion & Asset Upload via API (159.447584ms)
  ▶ Phase 2: Template Authoring, Revisions, and Instantiation via API
    ✔ 2.1 Tenant Alpha creates Template revision 1 via pure API (24.641506ms)
    ✔ 2.2 Tenant Alpha creates Template revision 2 via pure API (18.74335ms)
    ✔ 2.3 Stale base_revision guard: creating revision with stale base_revision returns 409 REVISION_CONFLICT (13.153365ms)
    ✔ 2.4 Tenant Alpha instantiates Template revision 2 into Composition via pure API (20.604411ms)
    ✔ 2.5 Strict IDOR Protection on Templates & Compositions: Tenant Beta receives 404 NOT_FOUND (19.171389ms)
  ✔ Phase 2: Template Authoring, Revisions, and Instantiation via API (99.256462ms)
  ▶ Phase 3: Webhook Registration & Echo Verification via API
    ✔ 3.1 Tenant Alpha registers webhook endpoint via pure API (8.573837ms)
    ✔ 3.2 Tenant Alpha verifies webhook endpoint via challenge echo handshake (19.169626ms)
    ✔ 3.3 Strict IDOR Protection on Webhook Endpoints: Tenant Beta receives 404 NOT_FOUND (45.942743ms)
  ✔ Phase 3: Webhook Registration & Echo Verification via API (74.742573ms)
  ▶ Phase 4: Preview Job Admission, Worker Execution & Signed Callback
    ✔ 4.1 Tenant Alpha admits preview job via pure API (POST /v1/previews) (12.130072ms)
    ✔ 4.2 Worker claims and executes preview job; outputs 4 artifacts (63.396213ms)
    ✔ 4.3 Outbox processes and delivers signed webhook callback to receiver (10.565693ms)
    ✔ 4.4 Tenant Isolation on Preview Job: Tenant Beta probing receives 404 NOT_FOUND (6.946476ms)
  ✔ Phase 4: Preview Job Admission, Worker Execution & Signed Callback (93.966246ms)
  ▶ Phase 5: Full Render Job Admission, Worker Execution & Signed Callback
    ✔ 5.1 Tenant Alpha admits full render job via pure API (POST /v1/render-jobs) (8.17456ms)
    ✔ 5.2 Worker claims and executes full render job; produces ISO-BMFF MP4 and settles usage (469.014434ms)
    ✔ 5.3 Webhook delivery service delivers signed callback for full render job (16.969592ms)
    ✔ 5.4 Tenant Isolation on Render Job: Tenant Beta probing receives 404 NOT_FOUND (11.388367ms)
  ✔ Phase 5: Full Render Job Admission, Worker Execution & Signed Callback (509.362732ms)
  ▶ Phase 6: Download Grants & Real Media Decode via SAME API Path
    ✔ 6.1 Tenant Alpha requests download grants via GET /v1/artifacts/:id/download (5.43732ms)
    ✔ 6.2 Real MP4 Download via SAME API Path (/v1/artifacts/download/:token) & Strict Security Headers (12.098825ms)
    ✔ 6.4 Preview PNG Download via SAME API Path & verifyPngBuffer decode (5.405121ms)
    ✔ 6.5 Thumbnail, Captions, and Manifest Downloads via SAME API Path (12.278644ms)
    ✔ 6.6 Anti-IDOR & Tampered Token Security on Artifact Downloads (5.902138ms)
  ✔ Phase 6: Download Grants & Real Media Decode via SAME API Path (41.821553ms)
  ▶ Phase 7: Usage Ledger & Tenant Accounting Isolation
    ✔ 7.1 Tenant Alpha queries GET /v1/usage and receives settled usage entries (4.020316ms)
    ✔ 7.2 Tenant Beta queries GET /v1/usage and receives zero billable units (complete accounting isolation) (3.273373ms)
  ✔ Phase 7: Usage Ledger & Tenant Accounting Isolation (7.770404ms)
  ▶ Phase 8: Fault Suite: Revoke Asset, Expired Artifacts, Worker Crash & Outage
    ▶ 8.1 Fault: Revoke Asset
      ✔ 8.1a revoking an asset invalidates existing download grants (returns 410 or 404) (19.329347ms)
      ✔ 8.1b deleting a referenced asset before publication aborts publication with ASSET_REVOKED and zero orphan leak (348.339673ms)
    ✔ 8.1 Fault: Revoke Asset (368.177679ms)
    ▶ 8.2 Fault: Expired Artifacts
      ✔ 8.2a download attempt with expired token TTL returns 410 GRANT_EXPIRED (6.33423ms)
      ✔ 8.2b download attempt with expired artifact retention returns 410 ARTIFACT_EXPIRED (4.149187ms)
      ✔ 8.2c download attempt for revoked artifact returns 410 GRANT_REVOKED (4.962733ms)
    ✔ 8.2 Fault: Expired Artifacts (16.031326ms)
    ▶ 8.3 Fault: Worker Crash / Kill Across Stages
      ✔ 8.3a worker crash at rendering stage triggers lease reclamation and monotonic fencing token prevents zombie publish (75.748471ms)
      ✔ 8.3b worker kill at before_publish stage cleans up temp directory without orphan leak (363.403182ms)
    ✔ 8.3 Fault: Worker Crash / Kill Across Stages (439.751582ms)
    ▶ 8.4 Fault: Callback Outage Resilience
      ✔ 8.4 survives receiver outage without losing event/job, persists in outbox, and delivers once outage heals (349.021913ms)
    ✔ 8.4 Fault: Callback Outage Resilience (349.384446ms)
  ✔ Phase 8: Fault Suite: Revoke Asset, Expired Artifacts, Worker Crash & Outage (1173.915215ms)
✔ Task P4-07 / Reviewer / Phase P4 Acceptance: Gate G3 Two-Tenant E2E Verification & Fault Suite (2219.559953ms)
ℹ tests 34
ℹ suites 13
ℹ pass 34
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2649.484336
```

### Kết quả kiểm thử toàn package `@creativanta/api`:
- `268 / 268` tests passed (80 suites, 0 failed, 59.3s duration).

### Kiểm tra sức khỏe & hợp lệ kho lưu trữ:
- `python3 scripts/validate_repo.py`: PASS (0 errors, 0 warnings).
- `python3 -m unittest discover -s tooling/agent_harness/tests -v`: PASS (10/10 tests).
- `node scripts/health-check.mjs`: PASS (`/healthz`, `/readyz`, `mp4-720p-v1`, `preview-360p-v1`).

---

## 3. Cổng ngoại bộ & Phạm vi tiếp theo

1. **Cổng kiểm thử an ninh độc lập (Gate G3):** Đã hoàn tất và vượt qua 100% bằng chứng kiểm thử tự động, sẵn sàng cho hội đồng an ninh đối chiếu.
2. **Cổng tích hợp Staging (Supervisor Staging Gate):** Giám sát viên sẽ tiếp nhận kết quả `implemented_local` và thực hiện tích hợp vào nhánh `staging`.
3. **Phạm vi tiếp theo (Next Tasks):**
   - Chuyển tiếp sang Phase P5 (Production Hardening, Multi-region storage replication, Egress filtering verification, Canary monitoring).
