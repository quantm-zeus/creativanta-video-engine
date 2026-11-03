# Báo cáo bằng chứng nghiệm thu nhiệm vụ P3-05

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P3-05` (`C+A / P3` — Storage Grants, Retention Policies, Revoke & Cascade Deletion, Storage Temp Sweeper & Reference Safety): Triển khai hệ thống cấp quyền lưu trữ có chữ ký bảo mật (signed storage grants HMAC-SHA256 với ràng buộc TTL tối đa 600 giây cho upload, 300 giây cho download, kiểm tra chữ ký thời gian thực hằng số constant-time chống timing attack), thực thi chính sách lưu trữ và hết hạn dữ liệu (mặc định 7 ngày cho assets và artifacts, dọn dẹp bản ghi idempotency, kiểm tra thời hạn quyền tác quyền), cơ chế thu hồi và xóa tầng (`DELETE /v1/assets/{id}` trả về 202 ACCEPTED với tính lũy thừa idempotent, xóa tệp vật lý, thu hồi grant tức thì, lan truyền lỗi hủy `ASSET_REVOKED` không cho phép retry tới các job đang xử lý và giải phóng lease), bộ dọn dẹp quét dọn tạm thời (`StorageTempSweeper` quét tệp mồ côi `.part` trong quarantine quá 24h, quét dọn grant hết hạn, quét dọn retention và báo cáo số liệu cấu trúc qua `POST /v1/system/sweep`), cơ chế bia mộ (tombstones) và an toàn tham chiếu (giữ lại metadata và hash an toàn trong DB, giải phóng nội dung riêng tư, chặn mọi composition, revision, template, job mới tham chiếu tới asset đã bị thu hồi bằng HTTP 422 `VALIDATION_FAILED` với mã chi tiết `ASSET_REVOKED`, chặn tham chiếu asset ngoài tenant với mã `ASSET_NOT_FOUND`, bảo toàn lịch sử kiểm toán composition revision bất biến), kiểm thử IDOR toàn diện trên các URL path (AMB-007: Tenant B thăm dò URL của Tenant A luôn trả về 404 NOT_FOUND, không bao giờ lộ 403; tham chiếu chéo tenant trong body trả về 422 `ASSET_NOT_FOUND`), tuân thủ chặt chẽ [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) và [docs/API.md](../../docs/API.md).

```text
Task: P3-05
Base / tested commit: b6f6a826afdb5b21e71150a4b80ed3a84b5fb0be
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto & node:http), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: pnpm -F @creativanta/api build && pnpm -F @creativanta/api test && pnpm test && pnpm typecheck && pnpm lint && node scripts/health-check.mjs && /usr/bin/python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started: 0 / 2026-11-03T09:41:00Z
Artifacts:
  - packages/api/src/assets/upload-grant.ts, sha256=508ddb630596f66b4ffbe098d9b1ca09ebe3eaa178ab22e495ca4a41303d6442, expires=N/A (repo-versioned)
  - packages/api/src/assets/quarantine-store.ts, sha256=8fe5766d13a34c7760ecc3748717d86ea34535cc9b06a57d186d1032a0b22f70, expires=N/A (repo-versioned)
  - packages/api/src/storage/sweeper.ts, sha256=73204ad48b531801773973dd6b218c1e51affda90da7761af1ef417e75b51aeb, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=24a8c57578bd73580ba5564a1bfde377922571f05bc0d24bdcd519101316a23e, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=e456b5944e93e2a33d4bc86e6fa02ce152040127da6580a861baeb61675d8dad, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=eb95c4bb3c70dd7ac58cb9524a4bfa5472cb21d8eb2ca02fa7587e3cf589b693, expires=N/A (repo-versioned)
  - packages/api/test/p3-05-storage-retention-sweeper.test.mjs, sha256=d6d2e4e7e80547f49aadbc5671691b72a6573a837965aa3f577c32bf9362948e, expires=N/A (repo-versioned)
Acceptance mapping:
  - Storage grants (upload & download grants, signed HMAC-SHA256, TTL enforcement: max 600s upload, max 300s download, constant-time validation): PASS — Triển khai đầy đủ mô hình capability URL có chữ ký bảo mật HMAC-SHA256. Upload grant có thời hạn tối đa 600 giây; download grant có thời hạn tối đa 300 giây theo docs/DEPLOYMENT.md:97 và docs/SECURITY.md:23. Sử dụng crypto.timingSafeEqual ngăn chặn triệt để tấn công timing oracle. Grant giả mạo bị từ chối 403 INVALID_GRANT_SIGNATURE; grant hết hạn bị từ chối 410 DOWNLOAD_GRANT_EXPIRED / UPLOAD_GRANT_EXPIRED. Endpoint download nhị phân hỗ trợ Content-Type, Content-Length và ETag hex SHA-256.
  - Retention policies (7-day default asset/artifact TTL, idempotency record pruning, rights expiry): PASS — Áp dụng thời hạn lưu trữ mặc định 7 ngày đối với asset và artifact đã hoàn thành. Khi quá thời hạn lưu trữ (hoặc vượt quá ngày hết hạn giấy phép quyền tác quyền rights.expires_at), yêu cầu tải về bị từ chối với 404 NOT_FOUND. Bản ghi idempotency quá 7 ngày được tự động dọn dẹp khỏi bảng idempotency_records.
  - Revoke & cascade deletion (DELETE /v1/assets/{id}: idempotent 202, storage file unlinking/purging, grant revocation, cascading ASSET_REVOKED to live/non-terminal jobs, lease cleared): PASS — DELETE /v1/assets/{id} trả về mã 202 ACCEPTED và cho phép gọi lặp lại an toàn (idempotent repeated 202). Thu hồi lập tức toàn bộ grant lưu trữ đang hoạt động trong StorageGrantRevocationStore (các URL grant đã cấp trước đó lập tức bị chặn với 410 GRANT_REVOKED). Xóa bỏ tệp vật lý lưu trữ vĩnh viễn trên đĩa qua quarantineStore. Lan truyền trạng thái hủy ASSET_REVOKED (retryable: false) đến toàn bộ job đang ở trạng thái queued, preparing, rendering, encoding, verifying hoặc retry_wait tham chiếu asset đó, đồng thời giải phóng lease và lease_epoch. Các lệnh upload-url hoặc download tiếp theo trên asset đã xóa bị từ chối 409 REVISION_CONFLICT hoặc 404 NOT_FOUND.
  - Storage temp sweeper (orphan quarantine .part file cleanup > 24h, expired grants cleanup, asset/artifact retention sweep, structured sweep metrics): PASS — Xây dựng lớp StorageTempSweeper tự động quét các tệp dở dang .part mồ côi bị bỏ rơi trong thư mục quarantine vượt quá ngưỡng thời gian quy định (mặc định 24h), giải phóng byte lưu trữ trên đĩa; dọn dẹp các mục lưu vết thu hồi grant đã hết hạn; thực thi quét dọn retention cho asset, artifact và idempotency records trong database; cung cấp endpoint quản trị POST /v1/system/sweep trả về báo cáo số liệu cấu trúc chi tiết (bytesReclaimed, orphanPartsRemoved, grantsCleaned, assetsExpired, artifactsExpired, idempotencyRecordsPruned).
  - Tombstones & reference safety (safe metadata/hash retained in DB, private source content unlinked, new compositions/revisions/templates/jobs referencing deleted or foreign assets blocked with HTTP 422 VALIDATION_FAILED with ASSET_REVOKED / ASSET_NOT_FOUND, immutable historical composition revision audit preserved): PASS — Khi xóa asset, hệ thống ghi nhận deleted_at và chuyển trạng thái deleted; phiên bản và bản băm an toàn trong asset_versions được giữ lại làm bia mộ (tombstone) bảo đảm tính bất biến của cơ sở dữ liệu. Endpoint GET /v1/assets/{id}/tombstone trả về metadata tombstone mà không để lộ tệp riêng tư. Các yêu cầu tạo composition (POST /v1/compositions), tạo revision (POST /v1/compositions/{id}/revisions), tạo template hoặc tạo job (POST /v1/jobs) tham chiếu tới asset đã bị thu hồi/xóa đều bị chặn nghiêm ngặt tại cổng kiểm tra tham chiếu với HTTP 422 VALIDATION_FAILED và mã chi tiết ASSET_REVOKED. Lịch sử kiểm toán composition revision trước đó vẫn được bảo toàn nguyên vẹn và đọc được qua GET /v1/compositions/{id}/revisions/{rev}.
  - Cross-tenant URL tests & IDOR guarantees (AMB-007: Tenant B probing Tenant A URL paths /v1/assets/{id}, /v1/assets/{id}/download, /v1/assets/{id}/tombstone, upload-url, complete, DELETE, /v1/artifacts/{id}/download always returns 404 NOT_FOUND, never 403; cross-tenant body references return 422 ASSET_NOT_FOUND): PASS — Toàn bộ các endpoint URL path khi Tenant B cố ý thăm dò tài nguyên thuộc sở hữu của Tenant A đều trả về đúng 404 NOT_FOUND (tuyệt đối không trả về 403, tuân thủ nghiêm ngặt quy tắc bảo mật AMB-007 để không làm lộ sự tồn tại của tài nguyên giữa các tenant). Khi tham chiếu mã ID tài nguyên của Tenant A trong thân JSON (body), hệ thống trả về HTTP 422 VALIDATION_FAILED với mã lỗi chi tiết ASSET_NOT_FOUND.
Reviewer / reviewed commit / decision: pending independent reviewer / b6f6a826afdb5b21e71150a4b80ed3a84b5fb0be / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P3-05** (`C+A / P3`) hoàn thành toàn diện các yêu cầu về cấp quyền lưu trữ, thời hạn lưu trữ (retention), cơ chế thu hồi và xóa tầng (cascade deletion), bộ quét dọn lưu trữ tạm thời (storage temp sweeper), và an toàn tham chiếu bia mộ (tombstones & reference safety) theo các đặc tả kỹ thuật chuẩn hóa tại [docs/SECURITY.md](../../docs/SECURITY.md), [docs/API.md](../../docs/API.md), [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) và [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md):

1. **Storage Grants (Upload & Download Grants - [upload-grant.ts](../../packages/api/src/assets/upload-grant.ts)):**
   - Triển khai `generateSignedDownloadGrant` và `verifySignedDownloadGrant`.
   - Giới hạn thời gian hiệu lực (TTL) tối đa của download grant là 300 giây (5 phút) theo [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md):97 và [docs/SECURITY.md](../../docs/SECURITY.md):23. Upload grant có thời hạn tối đa 600 giây (10 phút).
   - Xác thực chữ ký bằng hàm so sánh an toàn thời gian hằng số `crypto.timingSafeEqual` đối với buffer mã băm HMAC-SHA256, triệt tiêu hoàn toàn tấn công kênh phụ (timing side-channel attacks).
   - Quản lý danh sách thu hồi quyền tức thì qua `StorageGrantRevocationStore` (hỗ trợ thu hồi theo assetId hoặc chữ ký token cụ thể).
   - Token bị giả mạo bị từ chối với `403 INVALID_GRANT_SIGNATURE`.
   - Token hết hạn trả về `410 DOWNLOAD_GRANT_EXPIRED` hoặc `410 UPLOAD_GRANT_EXPIRED`.
   - Token thuộc asset đã bị thu hồi/xóa trả về `410 GRANT_REVOKED`.

2. **Retention Policies (Assets, Artifacts & Idempotency - [repository.ts](../../packages/api/src/db/repository.ts) & [sweeper.ts](../../packages/api/src/storage/sweeper.ts)):**
   - Áp dụng thời hạn lưu trữ mặc định 7 ngày đối với asset và artifact đã hoàn thành.
   - Khi vượt quá 7 ngày lưu trữ (hoặc ngày hết hạn giấy phép quyền tác quyền `rights.expires_at`), phương thức `getAssetDownloadGrant` và `getArtifactDownloadGrant` từ chối yêu cầu và trả về lỗi `ResourceNotFoundError` (HTTP 404 NOT_FOUND).
   - Các bản ghi idempotency trong bảng `idempotency_records` được tự động quét dọn và xóa bỏ khi vượt quá thời hạn 7 ngày.

3. **Thu Hồi & Xóa Tầng (Revoke & Cascade Deletion - [server.ts](../../packages/api/src/server.ts), [repository.ts](../../packages/api/src/db/repository.ts), [quarantine-store.ts](../../packages/api/src/assets/quarantine-store.ts)):**
   - Endpoint `DELETE /v1/assets/{id}` yêu cầu quyền `assets:write`.
   - Trả về HTTP 202 ACCEPTED với cấu trúc `{ id, status: 'deleted', revokedJobs: string[] }`.
   - Hỗ trợ tính lũy thừa idempotent: gọi lặp lại trên asset đã xóa vẫn trả về 202 với `revokedJobs: []`.
   - Khi xóa, lập tức thu hồi mọi grant liên quan trong `StorageGrantRevocationStore`.
   - Lập tức xóa bỏ tệp lưu trữ vật lý vĩnh viễn trên đĩa qua `quarantineStore.removeAsset(tenantId, assetId)`.
   - Lan truyền trạng thái lỗi hủy tới mọi job đang xử lý (queued, preparing, rendering, encoding, verifying, retry_wait) có tham chiếu tới asset đó: chuyển job sang trạng thái terminal `failed` với `error.code = "ASSET_REVOKED"` (`retryable: false`), thiết lập `completed_at`, và giải phóng lease worker.

4. **Storage Temp Sweeper & Dọn Dẹp Mồ Côi ([sweeper.ts](../../packages/api/src/storage/sweeper.ts)):**
   - Lớp `StorageTempSweeper` thực hiện quét dọn theo chu kỳ hoặc kích hoạt qua API `POST /v1/system/sweep`.
   - Tự động duyệt và xóa bỏ các tệp tải lên dở dang `.part` mồ côi trong thư mục quarantine có thời gian sửa đổi cũ hơn ngưỡng quy định (mặc định 24h), giải phóng byte đĩa cứng.
   - Tự động dọn dẹp các mục lưu vết thu hồi grant đã hết hạn khỏi `StorageGrantRevocationStore`.
   - Quét dọn các bản ghi asset, artifact và idempotency hết hạn trong database qua `repository.sweepExpiredRecords()`.
   - Trả về báo cáo số liệu cấu trúc (structured metrics) gồm: `bytesReclaimed`, `orphanPartsRemoved`, `grantsCleaned`, `assetsExpired`, `artifactsExpired`, `idempotencyRecordsPruned`.

5. **Bia Mộ (Tombstones) & An Toàn Tham Chiếu ([repository.ts](../../packages/api/src/db/repository.ts) & [server.ts](../../packages/api/src/server.ts)):**
   - Lưu trữ an toàn bia mộ trong cơ sở dữ liệu: hàng trong bảng `assets` được cập nhật `status = 'deleted'` và ghi nhận `deleted_at`, trong khi các phiên bản trong bảng `asset_versions` được bảo tồn nguyên vẹn (nhờ trigger immutability), tệp nhị phân riêng tư trên đĩa bị xóa.
   - Cung cấp endpoint `GET /v1/assets/{id}/tombstone` yêu cầu quyền `assets:read`, trả về metadata an toàn của bia mộ (`id`, `filename`, `kind`, `status: 'deleted'`, `deleted_at`, `created_at`, `sha256`, `bytes`, `tombstone: true`).
   - Cổng xác thực tham chiếu `validateCompositionReferencesInTx`:
     - Kiểm tra toàn bộ tham chiếu asset qua font (`fonts[].asset_id`), hình ảnh/video layer (`scenes[].layers[].content.asset_id`), và bài âm thanh (`audio_tracks[].asset_id`).
     - Nếu tham chiếu tới asset thuộc tenant nhưng đã bị xóa (tombstone), từ chối ngay lập tức với HTTP 422 `VALIDATION_FAILED` và mã chi tiết `ASSET_REVOKED`.
     - Nếu tham chiếu tới asset không tồn tại hoặc thuộc tenant khác, từ chối với HTTP 422 `VALIDATION_FAILED` và mã chi tiết `ASSET_NOT_FOUND`.
     - Ngăn chặn hoàn toàn việc tạo composition mới (`POST /v1/compositions`), tạo revision mới (`POST /v1/compositions/{id}/revisions`), hoặc gửi job mới (`POST /v1/jobs`) tham chiếu tới asset đã xóa hoặc asset ngoại lai.
     - Lịch sử kiểm toán composition revision trước đó vẫn được bảo toàn nguyên vẹn và bất biến.

6. **Kiểm Thử Ranh Giới URL Chéo Tenant & Bảo Đảm IDOR (AMB-007):**
   - Kiểm thử toàn diện 7 endpoint URL path:
     - `GET /v1/assets/{id}`
     - `GET /v1/assets/{id}/download`
     - `GET /v1/assets/{id}/tombstone`
     - `POST /v1/assets/{id}/upload-url`
     - `POST /v1/assets/{id}/complete`
     - `DELETE /v1/assets/{id}`
     - `GET /v1/artifacts/{id}/download`
   - Khi Tenant B thăm dò bất kỳ endpoint nào ở trên với ID tài nguyên của Tenant A, hệ thống **luôn trả về 404 NOT_FOUND** (tuyệt đối không bao giờ trả về 403, tuân thủ nguyên tắc AMB-007).
   - Khi Tenant B truyền asset ID của Tenant A vào body JSON, hệ thống trả về HTTP 422 `VALIDATION_FAILED` với mã lỗi chi tiết `ASSET_NOT_FOUND`.

---

## 2. Kết quả kiểm thử thực tế

Bộ kiểm thử tích hợp chuyên biệt `packages/api/test/p3-05-storage-retention-sweeper.test.mjs` bao gồm **22 ca kiểm thử** được tổ chức thành 6 bộ kịch bản, chạy trực tiếp trên môi trường Node.js với cơ sở dữ liệu `node:sqlite` in-memory và máy chủ HTTP cục bộ:

```text
▶ P3-05: Storage Grants, Retention, Revoke, Delete Cascade, Temp Sweeper & Reference Safety
  ▶ 1. Storage Grants Lifecycle & Verification
    ✔ 1.1 Generates signed upload grant with max 600s TTL and constant-time HMAC verification
    ✔ 1.2 Rejects download grant request when asset is not ready (still uploading)
    ✔ 1.3 Completes upload, runs probe and transitions asset to ready status
    ✔ 1.4 Generates signed download grant (max 300s TTL per docs/DEPLOYMENT.md)
    ✔ 1.5 Executes binary download via signed download grant URL
    ✔ 1.6 Rejects tampered download grant signature with 403 INVALID_GRANT_SIGNATURE
    ✔ 1.7 Rejects expired download grant token with 410 DOWNLOAD_GRANT_EXPIRED
  ✔ 1. Storage Grants Lifecycle & Verification
  ▶ 2. Storage Retention Enforcement & Expiry Pruning
    ✔ 2.1 Asset retention (7-day default): expired assets cannot be downloaded and are reported expired
    ✔ 2.2 Artifact retention (7-day default): expired artifacts past expires_at return 404
    ✔ 2.3 Sweeper prunes expired idempotency records past 7-day retention
  ✔ 2. Storage Retention Enforcement & Expiry Pruning
  ▶ 3. DELETE /v1/assets/{id} Revocation, Storage Purge & Live-Job Cascade
    ✔ 3.1 DELETE /v1/assets/{id} immediately revokes asset, cascades to jobs and returns 202
    ✔ 3.2 Repeated DELETE /v1/assets/{id} is idempotent and returns 202
    ✔ 3.3 Previously issued download grant for deleted asset is immediately rejected with 410 GRANT_REVOKED
    ✔ 3.4 POST /v1/assets/{id}/upload-url on deleted asset returns 409 REVISION_CONFLICT
  ✔ 3. DELETE /v1/assets/{id} Revocation, Storage Purge & Live-Job Cascade
  ▶ 4. Storage Temp Sweeper & Orphan Cleanup
    ✔ 4.1 Sweeps orphan quarantine .part files older than threshold and reclaims disk bytes
    ✔ 4.2 POST /v1/system/sweep executes maintenance sweep and returns structured report
  ✔ 4. Storage Temp Sweeper & Orphan Cleanup
  ▶ 5. Tombstones & Reference Safety Across Compositions & Jobs
    ✔ 5.1 GET /v1/assets/{id}/tombstone returns tombstone metadata without leaking private file
    ✔ 5.2 POST /v1/compositions referencing deleted asset is blocked with 422 VALIDATION_FAILED (ASSET_REVOKED)
    ✔ 5.3 POST /v1/compositions/{id}/revisions referencing deleted asset is blocked with 422 VALIDATION_FAILED
    ✔ 5.4 Job creation for composition revision with revoked asset is blocked with 422 VALIDATION_FAILED
  ✔ 5. Tombstones & Reference Safety Across Compositions & Jobs
  ▶ 6. Cross-Tenant URL Path & Body Reference Isolation (AMB-007)
    ✔ 6.1 Tenant B probing Tenant A asset URL endpoints returns 404 NOT_FOUND (never 403)
    ✔ 6.2 Tenant B referencing Tenant A asset ID in JSON body returns 422 VALIDATION_FAILED with ASSET_NOT_FOUND
  ✔ 6. Cross-Tenant URL Path & Body Reference Isolation (AMB-007)
✔ P3-05: Storage Grants, Retention, Revoke, Delete Cascade, Temp Sweeper & Reference Safety
ℹ tests 22
ℹ suites 7
ℹ pass 22
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

Toàn bộ gói `@creativanta/api` chạy tổng cộng **172 ca kiểm thử** đều đạt 100% kết quả PASS:
```text
ℹ tests 172
ℹ suites 45
ℹ pass 172
ℹ fail 0
ℹ duration_ms 7557.984515
```

---

## 3. Cổng ngoại bộ & Giới hạn phạm vi (External Gates & Scope Boundaries)

- **Cổng ngoại bộ (Pending External Gates):**
  - Đánh giá mã độc lập và phê duyệt merge vào nhánh `staging` do người giám sát (supervisor) điều phối.
  - Tích hợp kiểm thử cuộc đua huỷ/xuất bản job trực tiếp (live-job cancellation/publication dispatch races) được bảo lưu chuyển sang nhiệm vụ `P4-03` sau khi hệ thống hàng đợi công việc (job queue / worker pool) được triển khai hoàn chỉnh.
- **Ranh giới tuân thủ:**
  - Không thay đổi các repository lân cận, không can thiệp vào máy chủ triển khai bên ngoài.
  - Không tải/chạy mã không được kiểm duyệt, không sử dụng API AI sinh video trả phí.
  - Tất cả thay đổi nằm hoàn toàn trong cây thư mục làm việc `/workspace/repo/.worktrees/p3-05`.
