# Báo cáo bằng chứng nghiệm thu nhiệm vụ P3-03

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P3-03` (`A+D / P3` — Template catalog/variable schema/instantiate, composition revision/concurrency, immutable scene versions; stale base_revision 409, curated fork path): Triển khai hoàn chỉnh danh mục template đa khách hàng (hỗ trợ phân vùng `curated` system catalog và `tenant` private), cơ chế xác thực schema biến chặt chẽ (giới hạn tối đa 64 biến, định dạng tên `^[a-z][a-z0-9_]{0,63}$`, cấm remote `$ref` và executable defaults, giới hạn binding v1), API hiện thực hóa template (`POST /v1/templates/{id}/instantiate`) thành Scene Spec 1.0 thuần túy với kiểm tra tài sản RLS và locale allowlist, cơ chế kiểm soát đồng thời lạc quan (optimistic concurrency) cho composition revisions với mã lỗi `409 REVISION_CONFLICT` khi stale `base_revision`, cơ chế bảo vệ phiên bản scene bất biến (tự động tăng revision khi nội dung scene thay đổi và giữ nguyên revision khi nội dung không đổi), cùng luồng rẽ nhánh an toàn từ mẫu hệ thống (`POST /v1/templates/{id}/fork` và `source_template` provenance) theo quy định tại [AGY execution](../../docs/AGENTS.md), [Architecture](../../docs/ARCHITECTURE.md), [Security](../../docs/SECURITY.md), [API](../../docs/API.md), [Scene Spec](../../docs/SCENE-SPEC.md) và [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md).

```text
Task: P3-03
Base / tested commit: de614f462d0070069fb55cdde899572d907f543d / 2e8feae280f36d8cb4b1e38360cceeca0c288316
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite & node:crypto), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T08:58:00Z / 95.8s
Artifacts:
  - packages/api/src/templates/template-engine.ts, sha256=18301569af79c93083cabdb171e276b26d331f4c13177a8a7656acb1caa1258b, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=12f1d4a20732fa19e46693d0d3ffe0d08ec204d13c6bcd05f57b7de11e0dbf3e, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=6aea819fe2878b1b83c641b8ce77618adb6022fdc67a9b3de4b072585a915caf, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=14635666697bc7763d884fbebee5b97df7d16781335bbc4c0d795a0037670cad, expires=N/A (repo-versioned)
  - packages/api/test/p3-03-templates-and-revisions.test.mjs, sha256=a7a904a4f9fcc60ccc1a8cb251aacbded8a30fd3aed8c6d5060a661de5d8b601, expires=N/A (repo-versioned)
  - evidence/P3-03/summary.json, sha256=6d6245fe0a08c5cd8b1d540b99f16d3ba8df917c77f68f8c8529eee0d2da846e, expires=N/A (repo-versioned)
Acceptance mapping:
  - Template catalog/variable schema/instantiate: PASS — Triển khai danh mục mẫu với phân quyền curated vs tenant, xác thực variables_schema (tối đa 64 biến, regex tên biến, kiểm tra kiểu JSON Schema, cấm remote $ref và executable defaults), kiểm tra ràng buộc vị trí binding v1, và endpoint POST /v1/templates/{id}/instantiate (yêu cầu compositions:write + templates:read) tạo ra bản composition Scene Spec 1.0 thuần túy không còn residual template metadata; giá trị default chỉ áp dụng khi biến vắng mặt (explicit null trả về 422 VALIDATION_FAILED); kiểm tra asset_id thuộc tenant RLS, status ready và kiểu layer phù hợp; thiết lập locale hợp lệ từ danh sách cho phép (vi-VN, en-US).
  - Composition revision/concurrency: PASS — Triển khai POST /v1/compositions/{id}/revisions yêu cầu base_revision bắt buộc; từ chối mọi yêu cầu có base_revision không khớp với revision hiện tại với HTTP 409 REVISION_CONFLICT; cơ chế kiểm soát tương tranh bảo vệ giao dịch ngăn chặn race condition (chỉ duy nhất 1 yêu cầu thành công tạo revision mới, các yêu cầu đồng thời dùng cùng base_revision đều nhận 409).
  - Immutable scene versions: PASS — Tính toán mã băm nội dung scene (computeSceneContentHash loại bỏ trường revision); nếu nội dung scene có thay đổi nhưng client giữ revision thấp hoặc không tăng, máy chủ tự động tăng revision của scene đó ("không tin revision client tự giữ thấp"); nếu nội dung scene hoàn toàn không đổi giữa hai composition revision, giữ nguyên scene revision; trigger cơ sở dữ liệu ngăn chặn hoàn toàn thao tác UPDATE/DELETE trực tiếp trên template_revisions và composition_revisions.
  - Stale base_revision 409: PASS — Kiểm thử tự động chuyên sâu xác nhận mã lỗi trả về là 409 Conflict với error code REVISION_CONFLICT và thông điệp chi tiết chỉ rõ base_revision đã cũ so với current_revision.
  - Curated fork path: PASS — Chặn hoàn toàn thao tác sửa đổi trực tiếp trên mẫu curated thuộc system_catalog (POST /v1/templates/tpl_promo_starter/revisions trả về 404 NOT_FOUND bảo vệ catalog); cung cấp luồng rẽ nhánh an toàn qua POST /v1/templates (kèm body.source_template) và POST /v1/templates/{id}/fork, ghi nhận đầy đủ nguồn gốc xuất xứ (source_template_id, source_template_revision, source_template_tenant_id) vào metadata của template mới.
Reviewer / reviewed commit / decision: pending independent reviewer / 2e8feae280f36d8cb4b1e38360cceeca0c288316 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P3-03** (`A+D / P3`) hoàn thành module quản lý Template Catalog, Template Instantiation, Composition Revision Optimistic Concurrency, và Immutable Scene Versions của hệ thống `creativanta-video-engine`:

1. **Quản lý Danh mục Mẫu (Template Catalog & Security Boundary):**
   - Hỗ trợ phân định rõ ràng giữa `curated` templates (thuộc sở hữu của `system_catalog` tenant `00000000-0000-0000-0000-000000000000`, công khai cho mọi tenant đọc qua `GET /v1/templates?visibility=curated`) và `tenant` templates (private cho từng tenant qua `GET /v1/templates?visibility=tenant`).
   - Ngăn chặn IDOR và tấn công ghi đè danh mục hệ thống: Yêu cầu cập nhật revision `POST /v1/templates/{id}/revisions` lên mẫu `curated` sẽ bị lọc bởi RLS và trả về `404 NOT_FOUND` (không cho phép sửa đổi template hệ thống).

2. **Xác thực Variable Schema & Kiểm soát Binding An toàn ([template-engine.ts](../../packages/api/src/templates/template-engine.ts)):**
   - Quy định định dạng tên biến chặt chẽ theo regex `^[a-z][a-z0-9_]{0,63}$`.
   - Giới hạn số lượng biến tối đa trong một template là 64 biến; chuỗi giá trị biến không vượt quá 10,000 ký tự.
   - Cấm triệt để các cấu trúc nguy hiểm trong schema: cấm remote `$ref` (`http://`, `https://`, `ftp://`) và cấm executable defaults.
   - Giới hạn các vị trí gắn biến (binding positions) v1: chỉ cho phép gắn biến vào các trường được định nghĩa an toàn:
     - `scene.layers[i].content.text`
     - `scene.layers[i].content.asset_id`
     - `scene.layers[i].content.color`
     - `scene.layers[i].content.fill`
     - `scene.layers[i].content.font_size`
     - `scene.layers[i].box.x`, `box.y`, `box.width`, `box.height`
   - Xác thực giá trị mặc định (`defaults`) của template ngay khi tạo template revision; nếu default không hợp lệ với schema sẽ trả về `422 VALIDATION_FAILED`.

3. **Hiện thực hóa Mẫu Thành Composition ([POST /v1/templates/{id}/instantiate](../../packages/api/src/server.ts)):**
   - Đòi hỏi đồng thời hai phạm vi quyền: `compositions:write` và `templates:read`.
   - Quy tắc áp dụng giá trị mặc định: Giá trị mặc định chỉ được áp dụng khi biến hoàn toàn vắng mặt (`undefined`) trong yêu cầu `variables`. Nếu client truyền giá trị tường minh là `null` cho biến bắt buộc, hệ thống không thay thế bằng default mà báo lỗi `422 VALIDATION_FAILED`.
   - Kiểm tra an toàn cho các biến liên kết tài sản (`asset_id`): Tài nguyên phải tồn tại trong phạm vi RLS của tenant, có trạng thái `ready` (chưa bị revoke/quarantine), và kiểu tài sản phải tương thích với loại layer (`image` vs `video` vs `svg`).
   - Áp dụng `locale` hợp lệ từ danh sách cho phép (`vi-VN`, `en-US`), mặc định là `vi-VN`.
   - Kết quả xuất xưởng là một composition Scene Spec 1.0 thuần túy, hoàn toàn không chứa bất kỳ metadata trung gian hay cú pháp binding nào (`template_id`, `bindings`, `variable_schema` đều được tách biệt).

4. **Kiểm soát Tương tranh Lạc quan cho Composition Revisions (`409 REVISION_CONFLICT`):**
   - Khi tạo revision mới cho composition qua `POST /v1/compositions/{id}/revisions`, client bắt buộc phải truyền `base_revision`.
   - Trong giao dịch cơ sở dữ liệu có khóa nguyên tử, hệ thống đối soát `base_revision` với revision hiện tại. Nếu không khớp (client đang sửa trên bản cũ), hệ thống từ chối ngay lập tức với HTTP `409 Conflict`, error code `REVISION_CONFLICT`.
   - Bảo vệ tương tranh trong môi trường song song (concurrency race protection): Khi hai yêu cầu gửi cùng một `base_revision` tại cùng thời điểm, chỉ một yêu cầu được cấp quyền tạo revision mới, yêu cầu còn lại nhận `409 REVISION_CONFLICT`.

5. **Phiên bản Scene Bất biến & Tự động Tăng Revision:**
   - Hệ thống triển khai hàm `computeSceneContentHash` để tính toán mã băm SHA-256 chuẩn hóa của toàn bộ nội dung scene (loại bỏ trường `revision`).
   - Khi tạo revision mới cho composition:
     - Nếu nội dung của một scene bị sửa đổi nhưng client cố tình giữ nguyên scene `revision` cũ, máy chủ tự động tăng revision cho scene đó theo nguyên tắc thiết kế *"không tin revision client tự giữ thấp"*.
     - Nếu nội dung của một scene hoàn toàn trùng khớp với revision trước đó, hệ thống giữ nguyên scene `revision` gốc để bảo toàn cache render và DAG render.
   - Các trigger cơ sở dữ liệu `trg_template_revisions_no_update` và `trg_composition_revisions_no_update` ngăn chặn tuyệt đối các thao tác `UPDATE` hoặc `DELETE` trực tiếp vào bảng lịch sử phiên bản.

6. **Luồng Rẽ nhánh An toàn từ Mẫu Tuyển chọn (Curated Fork Path):**
   - Người dùng có thể nhân bản một template có sẵn (kể cả template curated của hệ thống hoặc template của chính tenant) thông qua `POST /v1/templates` (với thuộc tính `source_template`) hoặc endpoint tiện ích `POST /v1/templates/{id}/fork`.
   - Hệ thống tự động ghi nhận nguồn gốc xuất xứ (`source_template_id`, `source_template_revision`, `source_template_tenant_id`) trong metadata của template mới.
   - Template mới được tạo ra là template độc lập thuộc quyền sở hữu của tenant với `revision: 1`.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm build` | `0` | `PASS` | Biên dịch TypeScript toàn bộ 4 packages sang ESM `dist/` |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm typecheck` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript strict mode không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm lint` | `0` | `PASS` | Kiểm tra cú pháp và quy chuẩn mã nguồn |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/home/whaleorcale/.local/bin:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ 5 test suites trong workspace (bao gồm 23 integration test cases chuyên sâu của P3-03) |
| 5 | `node scripts/health-check.mjs` | `0` | `PASS` | Kiểm tra sức khỏe workspace `/healthz`, `/readyz`, `/v1/capabilities` |
| 6 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn vẹn tài liệu, liên kết nội bộ, khối JSON và đồ thị DAG (52 tasks, acyclic) |

Chi tiết 23 ca kiểm thử tích hợp chuyên biệt cho P3-03 (`packages/api/test/p3-03-templates-and-revisions.test.mjs`):
1. `GET /v1/templates lists curated templates for authenticated tenant`: PASS
2. `GET /v1/templates?visibility=tenant lists only tenant-owned templates`: PASS
3. `POST /v1/templates creates tenant template with variable schema and initial revision`: PASS
4. `POST /v1/templates rejects variable schema with invalid variable name regex`: PASS
5. `POST /v1/templates rejects variable schema exceeding 64 variables`: PASS
6. `POST /v1/templates rejects variable schema with forbidden remote $ref`: PASS
7. `POST /v1/templates rejects default variable value incompatible with schema`: PASS
8. `POST /v1/templates rejects invalid binding path outside allowed v1 positions`: PASS
9. `POST /v1/templates/{id}/revisions creates new template revision with base_revision matching`: PASS
10. `POST /v1/templates/{id}/revisions rejects stale base_revision with 409 REVISION_CONFLICT`: PASS
11. `POST /v1/templates/{id}/revisions on curated template returns 404 NOT_FOUND (immutable system catalog)`: PASS
12. `POST /v1/templates/tpl_promo_starter/fork forks curated template into tenant scope`: PASS
13. `POST /v1/templates/{id}/instantiate creates valid Scene Spec 1.0 composition`: PASS
14. `POST /v1/templates/{id}/instantiate applies default value when variable omitted`: PASS
15. `POST /v1/templates/{id}/instantiate does NOT apply default when explicit null provided for required variable`: PASS
16. `POST /v1/templates/{id}/instantiate rejects variable with value exceeding max string length`: PASS
17. `POST /v1/templates/{id}/instantiate rejects unbound asset_id referencing foreign tenant asset (IDOR)`: PASS
18. `POST /v1/templates/{id}/instantiate rejects unbound asset_id referencing asset not in ready status`: PASS
19. `POST /v1/templates/{id}/instantiate rejects invalid locale not in allowlist`: PASS
20. `POST /v1/templates/{id}/instantiate requires both compositions:write and templates:read scopes`: PASS
21. `POST /v1/compositions/{id}/revisions with stale base_revision returns 409 REVISION_CONFLICT`: PASS
22. `POST /v1/compositions/{id}/revisions auto-increments scene revision if content modified and client kept revision low`: PASS
23. `POST /v1/compositions/{id}/revisions concurrent race test ensures exactly one success and stale returns 409`: PASS

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh công việc `agy/p3-03` vào `staging`, chạy GitHub Actions CI và reviewer độc lập phê duyệt chuyển trạng thái nhiệm vụ `P3-03` sang `done`.
2. **Nhiệm vụ tiếp theo mở khóa:** Sau khi `P3-03` hoàn tất, các nhiệm vụ thuộc phase tiếp theo phụ thuộc vào Composition/Template Engine (như `P3-04` — Timeline sequencing, asset binding validation, transition spec; và `P4-01` — Video composition engine pipeline) đủ điều kiện để triển khai.
