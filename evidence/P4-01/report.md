# Báo cáo bằng chứng nghiệm thu nhiệm vụ P4-01

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P4-01` (`A / P4` — Job Admission, Idempotency, Rate/Slot Quotas, Resource Reservations & Capability Validation): Triển khai giao dịch tiếp nhận công việc nguyên tử (atomic admission transaction) cho `POST /v1/render-jobs` và `POST /v1/previews`, quản lý khóa idempotency 24 giờ chuẩn hóa theo RFC 8785 JCS với xử lý tranh chấp đồng thời (`IDEMPOTENCY_IN_PROGRESS` / `IDEMPOTENCY_CONFLICT`) và ẩn khóa bí mật webhook khi phát lại, giới hạn tốc độ token-bucket theo tenant và API key (`1 token/s`, `burst = 20`), kiểm soát hạn ngạch khe công việc (`active = 2`, `queued = 20`, tổng `non-terminal <= 22`), đặt chỗ tài nguyên (`usage_reservations`) giữ nguyên qua `retry_wait` (AMB-004) và giải phóng khi hủy (`POST /v1/jobs/{id}/cancel`), kiểm tra năng lực profile/engine/custom-bundle/asset/webhook và đảm bảo chỉ phản hồi HTTP `202 Accepted` sau khi giao dịch cơ sở dữ liệu đã được commit bền vững, tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P4-01
Base / tested commit: b6f6a826afdb5b21e71150a4b80ed3a84b5fb0be / HEAD (agy/p4-01 local implementation commit)
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto & node:http), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm --filter @creativanta/api test && pnpm test && node scripts/health-check.mjs && python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T10:05:34Z / 42.6s
Artifacts:
  - packages/api/src/admission/rate-limiter.ts, sha256=ed347055d574ff69cb87c969e3aa366e5e364b4818a9b6422dd6b467de718e8e, expires=N/A (repo-versioned)
  - packages/api/src/admission/job-admission.ts, sha256=ef4bd75f37f3a175818dd97ce303c90480d9b01a985f99254515cc136b97f8ff, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=57b8ef7504ea0bba852226b7032249ed8dbb6b9f5532d93dae9e059d340c9cef, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=592f9bae434a68710dd3b278632f31c322bc6c18b55356befe17670c02dbb3b0, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=ae36bcae2ae2b35e6aac26a1b108e4a7e797c022e4539bc86a8ecf0e05c99f32, expires=N/A (repo-versioned)
  - packages/api/test/p4-01-admission-and-quotas.test.mjs, sha256=8b14241ac405ab104253c213bc7a016eeadd02b6872f39114cfb198d78c9e4b3, expires=N/A (repo-versioned)
  - evidence/P4-01/summary.json, sha256=c3288f15768b086b3909b1547ccbd57b797ad9e6f4255fc2b33534542c7b2238, expires=N/A (repo-versioned)
Acceptance mapping:
  - Atomic admission transaction & 202 only after durable commit: PASS — POST /v1/render-jobs và POST /v1/previews thực thi kiểm tra tài nguyên, hạn ngạch, tạo bản ghi jobs (queued, state_version=1), job_events (sequence=1), usage_reservations (reserved) và hoàn tất idempotency_keys trong cùng một giao dịch cơ sở dữ liệu nguyên tử; HTTP 202 Accepted chỉ được gửi sau khi giao dịch đã commit bền vững. Nếu xảy ra lỗi trước hoặc tại thời điểm commit, toàn bộ bản ghi được rollback sạch sẽ và khóa idempotency được giải phóng để cho phép thử lại.
  - Idempotency 24h TTL, JCS canonical hash, replay & secret redaction: PASS — Bắt buộc header Idempotency-Key hợp lệ (^[A-Za-z0-9._:-]{1,128}$) trên các POST mutation routes; băm yêu cầu chuẩn hóa RFC 8785 JCS SHA-256 trên (tenant_id, route_key, canonical_body); phát lại yêu cầu trùng khớp trả về mã trạng thái gốc kèm Idempotency-Replayed: true mà không tạo bản ghi trùng lặp; khi phát lại POST /v1/webhook-endpoints, khóa bí mật signing_secret được ẩn khỏi kho lưu trữ idempotency và trả về secret_redacted: true.
  - Concurrent duplicate & key conflict races: PASS — Yêu cầu đồng thời cùng Idempotency-Key khi yêu cầu đầu đang xử lý nhận 409 IDEMPOTENCY_IN_PROGRESS kèm Retry-After: 1; yêu cầu cùng Idempotency-Key nhưng khác route hoặc payload nhận 409 IDEMPOTENCY_CONFLICT.
  - Token-bucket rate limiting (tenant & API key): PASS — Thực thi thuật toán token-bucket theo từng tenant và từng API key (tốc độ nạp mặc định 1 token/s, dung lượng burst 20, giới hạn API key không vượt quá tenant); khi cạn token trả về 429 RATE_LIMITED (retryable: true) kèm header Retry-After chính xác theo thời gian nạp lại.
  - Slot quotas, concurrent quota races & usage reservations (AMB-004): PASS — Thực thi nghiêm ngặt giới hạn mặc định active_job_slots_max = 2, pending_admission_slots_max = 20, tổng non-terminal (queued +leased + active + retry_wait + canceling) <= 22; kiểm thử 30 yêu cầu đồng thời vào 20 khe chỉ nhận đúng 20 yêu cầu (202) và từ chối 10 yêu cầu (429 QUOTA_EXCEEDED kèm Retry-After); công việc chuyển từ active sang retry_wait vẫn giữ nguyên khe công việc và usage_reservation (reserved) theo AMB-004; hủy công việc qua POST /v1/jobs/{id}/cancel giải phóng khe và chuyển usage_reservation sang released.
  - Capabilities, asset readiness/budgets & webhook verification: PASS — Từ chối profile không hỗ trợ hoặc engine bị tắt với 422 UNSUPPORTED_CAPABILITY; đối với custom-html-v1, bắt buộc cả cờ máy chủ/tenant bật lẫn scene bundle ở trạng thái approved kèm security_gate_digest hợp lệ; tài nguyên chưa ready trả về 409 ASSET_NOT_READY, tài nguyên đã bị thu hồi hoặc thuộc tenant khác trả về 422 VALIDATION_FAILED (ASSET_NOT_FOUND) theo AMB-007; thực thi giới hạn <= 50 assets và <= 500 MiB tổng dung lượng đầu vào mỗi công việc; kiểm tra điểm cuối webhook phải ở trạng thái active (đã xác minh) nếu được chỉ định, trả về 409 WEBHOOK_NOT_VERIFIED nếu đang pending_verification hoặc disabled.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P4-01** (`Stream A / Phase P4`) hiện thực hóa toàn diện tầng kiểm soát tiếp nhận công việc (Job Admission), khóa Idempotency, bộ giới hạn tốc độ Token-Bucket, quản lý hạn ngạch khe công việc (Slot Quotas), đặt chỗ tài nguyên (`usage_reservations`) và kiểm duyệt năng lực/tài nguyên theo đúng đặc tả tại [docs/API.md](../../docs/API.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/TESTING.md](../../docs/TESTING.md):

1. **Giao Dịch Tiếp Nhận Công Việc Nguyên Tử & Cam Kết Bền Vững Trước Khi Phản Hồi 202 ([repository.ts](../../packages/api/src/db/repository.ts), [server.ts](../../packages/api/src/server.ts)):**
   - Triển khai phương thức `admitJob` thực thi toàn bộ quá trình kiểm tra và ghi dữ liệu cho `POST /v1/render-jobs` và `POST /v1/previews` trong một giao dịch cơ sở dữ liệu nguyên tử duy nhất dưới quyền `cve_api` và phạm vi RLS của tenant:
     - Ghi bản ghi `jobs` với trạng thái khởi tạo `state = 'queued'`, `state_version = 1`, `stage = 'queued'`, `progress = 0` và `snapshot_json` bất biến (ghim `render_hash`, `compiler_version`, `seed`, `required_capabilities`, danh sách `resolved_assets` kèm phiên bản và mã băm SHA-256, `total_input_bytes` và toàn bộ `CompositionSpec`).
     - Ghi sự kiện khởi tạo vào bảng bất biến `job_events` (`sequence = 1`, `event_type = 'job.queued'`).
     - Ghi bản ghi đặt chỗ tài nguyên vào `usage_reservations` (`state = 'reserved'`, `reserved_vcpu_seconds`, `reserved_output_seconds`, `reserved_bytes`).
     - Cập nhật bản ghi `idempotency_keys` sang `state = 'completed'` cùng mã trạng thái `202` và thân phản hồi JSON.
   - Đảm bảo bất biến: phản hồi HTTP `202 Accepted` chỉ được gửi tới client sau khi giao dịch SQLite/PostgreSQL đã `COMMIT` thành công. Nếu bất kỳ bước kiểm tra nào thất bại hoặc lỗi xảy ra trước khi commit hoàn tất, giao dịch được `ROLLBACK` hoàn toàn và khóa idempotency `in_progress` được giải phóng để client có thể thử lại an toàn với cùng `Idempotency-Key`.

2. **Quản Lý Idempotency Chuẩn Hóa RFC 8785 JCS, Xử Lý Đua Đồng Thời & Ẩn Khóa Bí Mật ([repository.ts](../../packages/api/src/db/repository.ts), [server.ts](../../packages/api/src/server.ts)):**
   - Áp dụng bắt buộc header `Idempotency-Key` (`^[A-Za-z0-9._:-]{1,128}$`, TTL 24 giờ) trên toàn bộ các POST mutation routes.
   - Tính toán mã băm yêu cầu bằng SHA-256 trên chuỗi chuẩn hóa RFC 8785 JCS của `(tenant_id, route_key, canonical_body)` (`computeIdempotencyRequestHash`), đảm bảo các JSON tương đương về mặt ngữ nghĩa nhưng khác thứ tự khóa vẫn được nhận diện chính xác là cùng một yêu cầu.
   - Khi có hai yêu cầu đồng thời cùng `Idempotency-Key`:
     - Nếu yêu cầu đầu đang ở trạng thái `in_progress` và cùng mã băm yêu cầu, yêu cầu thứ hai nhận `409 IDEMPOTENCY_IN_PROGRESS` (`retryable: true`) kèm header `Retry-After: 1`.
     - Nếu khác đường dẫn hoặc khác thân yêu cầu, nhận ngay `409 IDEMPOTENCY_CONFLICT` (`retryable: false`).
   - Khi yêu cầu đã `completed`, phản hồi phát lại giữ nguyên mã trạng thái gốc kèm header `Idempotency-Replayed: true`.
   - Đối với `POST /v1/webhook-endpoints`, khóa bí mật `signing_secret` chỉ trả về ở lần tạo đầu tiên; bản ghi lưu trong `idempotency_keys` tự động loại bỏ `signing_secret` và gắn cờ `secret_redacted = 1`, trả về `secret_redacted: true` khi phát lại theo đúng [docs/API.md](../../docs/API.md) dòng 12.

3. **Giới Hạn Tốc Độ Token-Bucket Đa Tầng ([rate-limiter.ts](../../packages/api/src/admission/rate-limiter.ts)):**
   - Triển khai `TokenBucketRateLimiter` kiểm soát đồng thời hạn mức theo từng tenant và theo từng API key với tốc độ nạp mặc định `1 token/s` và dung lượng burst `20` (đảm bảo giới hạn của API key không bao giờ vượt quá giới hạn của tenant theo [docs/API.md](../../docs/API.md) dòng 56).
   - Khi hết token, từ chối ngay với mã `429 RATE_LIMITED` (`retryable: true`) và tính toán chính xác giá trị header `Retry-After` (tối thiểu 1 giây).

4. **Hạn Ngạch Khe Công Việc, Đua Đồng Thời & Vòng Đời Đặt Chỗ Tài Nguyên AMB-004 ([job-admission.ts](../../packages/api/src/admission/job-admission.ts), [repository.ts](../../packages/api/src/db/repository.ts)):**
   - Thực thi giới hạn khe công việc mặc định cho mỗi tenant: tối đa `2` khe `active` (`active_job_slots_max = 2`), tối đa `20` khe chờ tiếp nhận (`pending_admission_slots_max = 20`), và tổng số công việc chưa kết thúc (`queued`, `leased`, `active`, `retry_wait`, `canceling`) không vượt quá `22` (`non_terminal_jobs_total_max = 22`).
   - Thực thi kiểm tra hạn mức ngân sách đặt chỗ tài nguyên (`max_reserved_vcpu_seconds`, `max_reserved_output_seconds`) trên tổng các bản ghi `usage_reservations` đang ở trạng thái `reserved`.
   - Tuân thủ nghiêm ngặt quy định **AMB-004**: khi một công việc chuyển từ `active` sang `retry_wait` (`transitionJobToRetryWait`), công việc đó vẫn giữ nguyên khe `non-terminal` và bản ghi `usage_reservations` ở trạng thái `reserved` để ngăn chặn việc nạp tràn hàng đợi khi hệ thống đang thử lại.
   - Hỗ trợ hủy công việc qua `POST /v1/jobs/{id}/cancel` và truy vấn nhật ký sự kiện qua `GET /v1/jobs/{id}/events`: công việc đang ở trạng thái `queued` hoặc `retry_wait` chuyển ngay sang `canceled` và giải phóng `usage_reservations` (`state = 'released'`), mở lại khe tiếp nhận cho công việc mới; nếu công việc đã ở trạng thái kết thúc (`succeeded`, `failed`, `canceled`, `expired`) trả về `409 JOB_TERMINAL`.

5. **Kiểm Duyệt Năng Lực, Tài Nguyên, Giới Hạn Đầu Vào & Điểm Cuối Webhook ([job-admission.ts](../../packages/api/src/admission/job-admission.ts), [repository.ts](../../packages/api/src/db/repository.ts)):**
   - Kiểm tra profile đầu ra (`mp4-720p-v1` cho render, `preview-360p-v1` cho preview) và kiểm tra biên thời gian của preview (`TIMELINE_BOUNDS`: `frame_index < duration_frames`, `start_frame + duration_frames <= spec.duration_frames`, thời lượng preview clip tối đa `300` frames / `10` giây).
   - Từ chối các engine bị vô hiệu hóa hoặc `custom-html-v1` chưa được bật/chưa được phê duyệt (`scene_bundles.status === 'approved'` và `scene_bundle_revisions.security_gate_digest` hợp lệ) với mã `422 UNSUPPORTED_CAPABILITY` (`CAPABILITY_DISABLED`).
   - Tái xác minh toàn bộ tài nguyên (`fonts`, `image`, `video`, `svg`, `audio_tracks`) tại thời điểm tiếp nhận:
     - Tài nguyên thuộc tenant khác hoặc đã bị `revoked`/`deleted` trả về `422 VALIDATION_FAILED` (`ASSET_NOT_FOUND`) theo chuẩn **AMB-007**.
     - Tài nguyên đang ở trạng thái `uploaded`, `processing`, `quarantined` trả về `409 ASSET_NOT_READY`.
     - Kiểm soát giới hạn tối đa `50` tài nguyên và tổng dung lượng đầu vào tối đa `500 MiB` (`524,288,000` bytes) mỗi công việc.
   - Kiểm tra `webhook_endpoint_id` (nếu có): phải tồn tại trong phạm vi tenant và ở trạng thái `active` (đã xác minh qua `POST /v1/webhook-endpoints/{id}/verify`), từ chối với `409 WEBHOOK_NOT_VERIFIED` nếu đang ở trạng thái `pending_verification` hoặc `disabled`.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build` | `0` | `PASS` | Biên dịch TypeScript toàn bộ 5 packages trong workspace thành công |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript (`tsc --noEmit`) trên toàn bộ workspace không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm lint` | `0` | `PASS` | Kiểm tra quy chuẩn mã nguồn tĩnh trên toàn bộ workspace |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH node --test packages/api/test/p4-01-admission-and-quotas.test.mjs` | `0` | `PASS` | Toàn bộ 6 suites / 11 ca kiểm thử tích hợp và tranh chấp đồng thời của P4-01 đạt 100% |
| 5 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm --filter @creativanta/api test` | `0` | `PASS` | Toàn bộ các bộ kiểm thử trong `@creativanta/api` (P3-01, P3-02, P3-03, P3-04, P4-01 và server test) đều đạt |
| 6 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên cả 5 packages trong monorepo |
| 7 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận `/healthz`, `/readyz`, cấu hình adapter và khả năng engine |
| 8 | `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra tính toàn vẹn tài liệu, liên kết nội bộ, khối JSON và DAG nhiệm vụ |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p4-01` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P4-01`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P4-01` hoàn tất, luồng công việc tiếp theo trong giai đoạn `P4` là `P4-02` (Dispatcher, Lease Scheduler, Worker Heartbeat & Retry Recovery) và `P4-03` (Output Artifact Finalization, Usage Settlement & Signed Webhook Delivery).
