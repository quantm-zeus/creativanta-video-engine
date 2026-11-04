# Evidence Report — Task P7-02: Versioned Scene-Bundle Registry, Digests, Parameter Schema, Provenance & OpenAPI Extension

## 1. Thông tin chung (Task Metadata)

| Trường | Giá trị |
| :--- | :--- |
| **Task ID** | `P7-02` |
| **Phase / Owner** | `P7` / `A+D` |
| **Branch / Worktree** | `agy/p7-02` (`/workspace/repo/.worktrees/p7-02`) |
| **Base Commit** | `2b58565293a43b12d8f4138c76d98c65e1566bdd` |
| **Allowed Paths** | `["evidence/P7-02/", "packages/custom-runtime/"]` |
| **Dependencies** | `P7-01`, `P1-02` |
| **Acceptance Criteria** | `Versioned scene-bundle registry/source/build digests/parameter schema/provenance, full OpenAPI extension, editable revisions/download access; feature still off` |
| **Tài liệu chuẩn tắc đối chiếu** | [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md) |

---

## 2. Tóm tắt kiến trúc và các hạng mục đã triển khai (Deliverables Summary)

### 2.1. Versioned Scene-Bundle Registry & Cô lập Multi-Tenant
- Triển khai lớp `SceneBundleRegistry` tại [packages/custom-runtime/src/scene-bundle-registry.mjs](../../packages/custom-runtime/src/scene-bundle-registry.mjs):
  - Quản lý thực thể `SceneBundleRecord` (`id`, `tenant_id`, `name`, `description`, `tags`, `latest_revision`, `is_global`, `is_archived`) và tập hợp các phiên bản `SceneBundleRevisionRecord`.
  - **Cô lập Tenant & Chống rò rỉ IDOR:** Mọi thao tác truy vấn (`getBundle`, `getRevision`, `downloadSource`, `updateBundle`) bắt buộc gắn với `tenantId`. Khi tenant truy vấn bundle thuộc tenant khác, hệ thống chủ động trả về `BUNDLE_NOT_FOUND` (tương ứng HTTP `404`) thay vì `403` để ngăn chặn việc rà quét sự tồn tại của tài nguyên ngoài phạm vi (IDOR timing/enumeration protection).
  - **Global Curated Catalog (Catalog dùng chung hệ thống):** Khởi tạo sẵn bundle chuẩn mẫu `global-kinetic-title` (`is_global: true`, `tenant_id: 'global'`). Mọi tenant đều có quyền đọc và tải về kiểm tra, nhưng **tuyệt đối không được sửa đổi trực tiếp** (`FORBIDDEN`). Khi tenant muốn tùy biến, phải sử dụng quy trình `forkBundle()`.

### 2.2. Kiểm soát đồng thời bằng Khóa lạc quan (409 REVISION_CONFLICT), Bản sửa đổi Draft & Tính bất biến
- **Optimistic Concurrency Control:** Khi tạo bản sửa đổi mới (`createRevision`), client bắt buộc truyền `base_revision` tương ứng với `latest_revision` hiện hành. Nếu `base_revision` bị trôi lệch (stale), hệ thống ném `CustomRuntimeError('REVISION_CONFLICT', ...)` tương ứng mã HTTP `409 REVISION_CONFLICT`, ngăn chặn hoàn toàn việc ghi đè mù giữa các tác vụ phân tán.
- **Editable Draft Revisions:** Bản sửa đổi mới bắt đầu ở trạng thái `status: 'draft'`, cho phép thêm, thay thế, xóa tệp nguồn (`updateDraftRevision`), cập nhật lược đồ tham số (`parameter_schema`) và cập nhật nhật ký thay đổi (`change_summary`). Mỗi lần chỉnh sửa, mã băm nguồn `source_sha256` và mã băm CSP `'sha256-...'` được tự động tính toán lại.
- **Sealed & Immutable Published Revisions:** Khi gọi `publishRevision()`, hệ thống kích hoạt quét an ninh mã nguồn (`scanCustomSourceForForbiddenCapabilities`), kiểm tra tính hợp lệ của schema tham số và tính toán mã băm. Sau khi phát hành (`status: 'published'`), bản sửa đổi được **khóa bất biến vĩnh viễn** (`sealed_at`); mọi hành vi chỉnh sửa sau đó đều bị chặn với lỗi `REVISION_SEALED`. Muốn thay đổi, bắt buộc phải tạo bản sửa đổi mới qua `createRevision`.
- **Forking Workflow:** Phương thức `forkBundle()` tạo bản sao độc lập thuộc quyền sở hữu của tenant mục tiêu, sao chép toàn bộ tệp nguồn và lược đồ tham số, đồng thời lưu vết phả hệ nguồn (`source_bundle: { bundle_id, revision }`) trong hồ sơ provenance.

### 2.3. Mã băm Nguồn/Bản dựng Xác định (Deterministic Digests), Định mức & Đóng gói UStar Tarball
- Triển khai tại [packages/custom-runtime/src/digests-and-provenance.mjs](../../packages/custom-runtime/src/digests-and-provenance.mjs):
  - **Deterministic Source Digest (`source_sha256`):** Chuẩn hóa đường dẫn tệp (chuyển đổi dấu gạch chéo POSIX, loại bỏ tiền tố `./`), sắp xếp danh sách tệp theo thứ tự từ điển nhị phân cố định, băm nội dung và siêu dữ liệu bằng SHA-256. Thứ tự truyền tệp vào mảng không làm thay đổi giá trị digest (`order-invariance verified`).
  - **Deterministic Build Digest (`build_sha256`):** Tính toán mã băm SHA-256 xác định cho toàn bộ tài sản sau biên dịch (`build_artifacts`).
  - **Cưỡng chế Định mức & Bảo vệ Đường dẫn:** Bắt buộc tuân thủ hạn mức theo [docs/SECURITY.md](../../docs/SECURITY.md):
    - Tối đa `100` tệp nguồn (`CUSTOM_BUNDLE_QUOTAS.maxFiles`).
    - Tổng dung lượng nguồn `<= 5 MiB` (`CUSTOM_BUNDLE_QUOTAS.maxSourceBytes`).
    - Tổng dung lượng tài sản dựng `<= 20 MiB` (`CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes`).
    - Độ sâu lồng thư mục tối đa `<= 8` (`CUSTOM_BUNDLE_QUOTAS.maxNestingDepth`).
    - Chặn đứng mọi hành vi leo thang đường dẫn (`..`), đường dẫn tuyệt đối (`/etc/...`), byte rỗng (`\0`) và các tệp nhạy cảm (`.env`, `.git`, `node_modules`, `/proc`).
  - **POSIX UStar Tarball Packaging:** Đóng gói và giải nén chuẩn POSIX UStar tarball thuần Node.js trong bộ nhớ (`packFilesToTarArchive`, `unpackFilesFromTarArchive`) không phụ thuộc gói bên ngoài, phục vụ xuất/tải gói cảnh nén đồng nhất.

### 2.4. Lược đồ Tham số Cảnh (Parameter Schema), Biên dịch Mặc định & Chống Prototype Pollution
- Triển khai tại [packages/custom-runtime/src/parameter-schema.mjs](../../packages/custom-runtime/src/parameter-schema.mjs):
  - Tương thích đầy đủ chuẩn JSON Schema 2020-12 và OpenAPI 3.1: hỗ trợ các kiểu dữ liệu `string`, `number`, `integer`, `boolean`, `array`, `object`, định dạng màu sắc `format: "color"` (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`), các giới hạn `minLength`, `maxLength`, `minimum`, `maximum`, `enum` và chỉ dẫn thành phần giao diện `ui_component`.
  - **Tự kiểm tra giá trị mặc định:** Kiểm tra tính hợp lệ của bản thân định nghĩa schema và bảo đảm giá trị `default` khai báo phải thỏa mãn chính các ràng buộc của trường đó.
  - **Biên dịch và Điền giá trị mặc định (`validateBundleParameters`):** Kiểm tra đối số đầu vào của người dùng, tự động điền giá trị mặc định cho các trường tùy chọn bị bỏ khuyết và định dạng báo cáo lỗi theo JSON Pointer chuẩn xác (`/title`, `/duration_sec`).
  - **Phòng thủ Prototype Pollution & ReDoS:** Phát hiện và chặn đứng mọi khóa ô nhiễm nguyên mẫu (`__proto__`, `constructor`, `prototype`, đối tượng có prototype không chuẩn), đồng thời phát hiện các mẫu biểu thức chính quy có nguy cơ thoái lui thảm họa (catastrophic backtracking / ReDoS).

### 2.5. Truy xuất Nguồn gốc Chống Làm giả (Tamper-Evident Provenance)
- Bản ghi `SceneBundleProvenance` ghi nhận chi tiết:
  - Loại tác giả: `human`, `ai`, `fork`, `import`.
  - Danh tính tác giả (`author`) và dấu thời gian ISO 8601 UTC.
  - Phả hệ bản sửa đổi gốc (`base_revision`) và gói nguồn khi fork (`source_bundle`).
  - Siêu dữ liệu AI (khi tác giả là AI): `provider`, `model`, `prompt_tokens`, `completion_tokens`, `cost_usd`, `job_id`, `brief_hash`.
  - Tuyên bố quyền và giấy phép sở hữu trí tuệ: `rights_and_license` (`license`, `copyright_holder`, `rights_provenance`, `commercial_use_allowed`).
  - Danh sách khả năng yêu cầu đã duyệt (`declared_capabilities` thuộc danh sách trắng, cấm tuyệt đối `network`, `shell`, `fs`, `eval`).
  - Mã băm toàn vẹn `provenance_digest` (SHA-256): Tính toán trên toàn bộ thuộc tính chuẩn hóa RFC 8785; phát hiện ngay lập tức nếu bất kỳ trường nào trong hồ sơ bị giả mạo.

### 2.6. Mở rộng Toàn diện Đặc tả OpenAPI 3.1 (Full OpenAPI Extension)
- Ban hành đặc tả OpenAPI 3.1.0 đầy đủ tại [packages/custom-runtime/src/scene-bundle-openapi.json](../../packages/custom-runtime/src/scene-bundle-openapi.json) và mô-đun tích hợp tại [packages/custom-runtime/src/scene-bundle-openapi.mjs](../../packages/custom-runtime/src/scene-bundle-openapi.mjs):
  - Định nghĩa đầy đủ `10` tuyến đường (routes) quản trị gói cảnh:
    1. `GET /scene-bundles`: Danh sách gói cảnh phân trang kèm bộ lọc tag.
    2. `POST /scene-bundles`: Tạo gói cảnh mới kèm revision 1 draft.
    3. `GET /scene-bundles/{id}`: Chi tiết gói cảnh.
    4. `PATCH /scene-bundles/{id}`: Cập nhật siêu dữ liệu gói cảnh.
    5. `DELETE /scene-bundles/{id}`: Lưu trữ / xóa mềm gói cảnh.
    6. `GET /scene-bundles/{id}/revisions`: Danh sách bản sửa đổi.
    7. `POST /scene-bundles/{id}/revisions`: Tạo bản sửa đổi draft mới (khóa `base_revision`).
    8. `GET /scene-bundles/{id}/revisions/{revision}`: Chi tiết bản sửa đổi, digests, schema và provenance.
    9. `PATCH /scene-bundles/{id}/revisions/{revision}`: Chỉnh sửa bản draft (tệp nguồn, schema tham số).
    10. `GET /scene-bundles/{id}/revisions/{revision}/source`: Tải toàn bộ nguồn (định dạng `manifest`, `tar` hoặc `files`).
    11. `GET /scene-bundles/{id}/revisions/{revision}/source/{filePath}`: Tải tệp nguồn đơn lẻ kèm kiểm tra đường dẫn.
    12. `GET /scene-bundles/{id}/revisions/{revision}/build`: Tải tài sản dựng và kiểm tra `build_sha256`.
    13. `POST /scene-bundles/{id}/revisions/{revision}/validate`: Chạy quét an ninh tĩnh và kiểm tra schema.
    14. `POST /scene-bundles/{id}/revisions/{revision}/publish`: Khóa và phát hành bản sửa đổi sang trạng thái bất biến.
    15. `POST /scene-bundles/fork`: Rẽ nhánh gói cảnh từ catalog toàn cục hoặc tenant khác.
  - Bao gồm đầy đủ lược đồ `components.schemas` (`SceneBundle`, `SceneBundleRevision`, `ParameterSchema`, `Provenance`, `ValidationReport`, v.v.), cơ chế xác thực `securitySchemes` (`BearerAuth`, `TenantHeader`) và ánh xạ mã lỗi chuẩn (`400`, `401`, `403`, `404`, `409`, `422`, `503`).
  - Cung cấp hàm tiện ích `extendOpenApiWithSceneBundles(baseSpec)` để ghép nối không xung đột vào đặc tả OpenAPI tổng thể của nền tảng.

### 2.7. Cơ chế Bảo đảm Tính năng Vẫn Tắt (Feature Still Off)
- Hệ thống duy trì cấu hình mặc định:
  - `CVE_CUSTOM_CODE_ENABLED=false`
  - `CVE_CUSTOM_RUNTIME="disabled"`
  - `CVE_CUSTOM_TENANT_ALLOWLIST=[]`
  - `custom-html-v1: false`
- Phương thức `prepareCustomSceneExecution()` kiểm tra nghiêm ngặt cổng tính năng (`assertCustomCodeExecutionAllowed`): khi cờ tính năng tắt, mọi yêu cầu chuẩn bị hoặc render cảnh `custom-html-v1` đều bị chặn cứng với mã lỗi `CAPABILITY_DISABLED`. Tính năng chỉ kích hoạt khi cờ tính năng được bật có chủ đích và tenant nằm trong danh sách trắng cho phép thử nghiệm.

---

## 3. Danh mục tệp tin và mã băm SHA-256 (Deliverable Artifacts & Checksums)

| Tệp tin | Vai trò | SHA-256 |
| :--- | :--- | :--- |
| [packages/custom-runtime/src/scene-bundle-registry.mjs](../../packages/custom-runtime/src/scene-bundle-registry.mjs) | Quản trị Scene Bundle Registry, vòng đời revision, khóa lạc quan, fork, tải về và bộ tự kiểm tra `SBR-01`..`SBR-13` | `4f161ea166b761899621498f6301f22ccf1e50d933501fd9cb09f001b7e7fdd9` |
| [packages/custom-runtime/src/parameter-schema.mjs](../../packages/custom-runtime/src/parameter-schema.mjs) | Định nghĩa, xác thực và biên dịch JSON Schema tham số cảnh, điền giá trị mặc định, chống ReDoS và Prototype Pollution | `e5070dcce16b9a9ab5c6acdad74225f5f0d3515091e286ad10444fccf83c459c` |
| [packages/custom-runtime/src/digests-and-provenance.mjs](../../packages/custom-runtime/src/digests-and-provenance.mjs) | Tính mã băm xác định `source_sha256`/`build_sha256`, kiểm tra định mức (100 tệp, 5MiB nguồn, 20MiB build, độ sâu 8), đóng gói UStar tarball, tạo và xác thực `SceneBundleProvenance` | `6603ce029680862b2f26817d2e95f5e897305539deb661ef707f3ba38f0bf5dc` |
| [packages/custom-runtime/src/scene-bundle-openapi.json](../../packages/custom-runtime/src/scene-bundle-openapi.json) | Bản đặc tả OpenAPI 3.1.0 JSON hoàn chỉnh cho Scene Bundle Registry | `1e6d53275165aa852e7d27fdd524fcbec4888e8cd6cbbd49fe39ca35f7ee90ef` |
| [packages/custom-runtime/src/scene-bundle-openapi.mjs](../../packages/custom-runtime/src/scene-bundle-openapi.mjs) | Mô-đun nạp, xác thực cấu trúc và hợp nhất đặc tả OpenAPI 3.1 | `1cae9512ad9644a2acbf9dd1b8e8f9ebc6bcdee96531890432c84a146dc13f93` |
| [packages/custom-runtime/src/cli.mjs](../../packages/custom-runtime/src/cli.mjs) | Công cụ dòng lệnh CLI tự động chạy kiểm toán và ghi nhận evidence cho Task P7-02 | `dfa74ed0fa746d548e2509291fdbb158068f0cbff750f19fc8f68db6a0bf205e` |
| [packages/custom-runtime/src/adr-policy.mjs](../../packages/custom-runtime/src/adr-policy.mjs) | Cập nhật định nghĩa `CustomRuntimeError` hỗ trợ các mã lỗi mở rộng của Registry | `c0566e87ecb232b32b32f949e1784b08174643bc221dec9efa44c1f7e5bc08f0` |
| [packages/custom-runtime/index.mjs](../../packages/custom-runtime/index.mjs) | Điểm nhập ESM mở rộng xuất toàn bộ mô-đun P7-01 và P7-02 | `62ecfe1fa0b441f9dfb28aee84e215f51269d7134049d07d305c1a955b72c1bb` |
| [packages/custom-runtime/index.d.ts](../../packages/custom-runtime/index.d.ts) | Khai báo kiểu TypeScript hoàn chỉnh cho gói `@creativanta/custom-runtime` | `9e69b0331c35210cee37b0b921d6d369f1717d7e3406d287a9c0bedcd30f57a4` |
| [packages/custom-runtime/test/p7-02-scene-bundle-registry.test.mjs](../../packages/custom-runtime/test/p7-02-scene-bundle-registry.test.mjs) | Bộ kiểm thử đơn vị, cô lập tenant, khóa đồng thời, schema, provenance và download (26 test cases / 8 suites) | `a05ed7a7059ab7b0b7020af64cec28f214eb27987ef61f0854f6b4586c69379e` |
| [evidence/P7-02/scene-bundle-registry-audit.json](./scene-bundle-registry-audit.json) | Kết quả kiểm toán tự động 13/13 hạng mục `SBR-01`..`SBR-13` | `bdfa59f556bf8d2c10084ea28e10aded1f388624e90c9a053c3af3d59bfd1bd3` |
| [evidence/P7-02/scene-bundle-openapi.json](./scene-bundle-openapi.json) | Bản lưu trữ bằng chứng đặc tả OpenAPI 3.1.0 trong thư mục evidence | `1e6d53275165aa852e7d27fdd524fcbec4888e8cd6cbbd49fe39ca35f7ee90ef` |

---

## 4. Bằng chứng kiểm thử thực tế (Verification & Test Evidence)

| Lệnh kiểm tra | Exit Code | Trạng thái | Chi tiết kết quả |
| :--- | :---: | :---: | :--- |
| `node packages/custom-runtime/src/cli.mjs --write-evidence evidence/P7-02` | `0` | `PASS` | Chạy 13/13 bài kiểm tra tự động `SBR-01`..`SBR-13` và ghi báo cáo kiểm toán tại [evidence/P7-02/scene-bundle-registry-audit.json](./scene-bundle-registry-audit.json). |
| `npx tsc -p packages/custom-runtime/tsconfig.json --noEmit` | `0` | `PASS` | Kiểm tra kiểu tĩnh TypeScript cho toàn bộ mã nguồn `packages/custom-runtime` đạt 100% không lỗi. |
| `node --test packages/custom-runtime/test/p7-02-scene-bundle-registry.test.mjs` | `0` | `PASS` | 26/26 bài kiểm thử (8 test suites) đạt 100%: registry CRUD, tenant isolation, concurrency 409, editable drafts, sealed immutability, digests, quotas, parameter schema, provenance, download access, OpenAPI extension, và feature-still-off gate. |
| `node --test packages/custom-runtime/test/p7-01-custom-runtime.test.mjs` | `0` | `PASS` | 15/15 bài kiểm thử bảo mật microVM runtime của P7-01 tiếp tục đạt 100% không suy thoái (zero regression). |
| `node packages/controller/dist/index.js --self-test` | `0` | `PASS` | 8/8 kiểm tra an ninh hộp cát controller (non-root, cgroup, zero egress, CSP, custom code disabled gate) đạt 100%. |
| `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận cấu hình mặc định `CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME="disabled"`, `custom-html-v1: false`. |
| `node --test ops/test/security-review-p6-04.test.mjs` | `0` | `PASS` | 24/24 kiểm tra bộ an ninh hệ thống nền tảng P6-04 tiếp tục đạt 100%. |
| `python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra cấu trúc kho lưu trữ, tính toàn vẹn liên kết nội bộ Markdown và cú pháp JSON blocks (49 tệp JSON hợp lệ). |

### Tóm tắt 13 hạng mục kiểm toán trong `evidence/P7-02/scene-bundle-registry-audit.json`

```json
{
  "taskId": "P7-02",
  "status": "PASS",
  "totalChecks": 13,
  "passedChecks": 13,
  "failedChecks": 0,
  "defaultFeatureState": {
    "CVE_CUSTOM_CODE_ENABLED": false,
    "CVE_CUSTOM_RUNTIME": "disabled",
    "CVE_CUSTOM_TENANT_ALLOWLIST": []
  },
  "checks": [
    { "id": "SBR-01", "title": "Multi-tenant scene-bundle creation, retrieval, and pagination", "status": "PASS" },
    { "id": "SBR-02", "title": "Tenant isolation & zero IDOR leakage across tenants", "status": "PASS" },
    { "id": "SBR-03", "title": "Global curated catalog bundles: visible to all tenants, read-only and immutable against tenant mutation", "status": "PASS" },
    { "id": "SBR-04", "title": "Fork curated bundle into tenant workspace with lineage link and complete provenance", "status": "PASS" },
    { "id": "SBR-05", "title": "Optimistic concurrency control: stale base_revision triggers 409 REVISION_CONFLICT", "status": "PASS" },
    { "id": "SBR-06", "title": "Editable draft revisions: add/update/remove files and parameters before publish", "status": "PASS" },
    { "id": "SBR-07", "title": "Sealed published revisions: published revisions are strictly immutable (REVISION_SEALED)", "status": "PASS" },
    { "id": "SBR-08", "title": "Deterministic canonical source & build digests with quota and depth bounds", "status": "PASS" },
    { "id": "SBR-09", "title": "Parameter schema validation, defaults compilation, and prototype pollution defenses", "status": "PASS" },
    { "id": "SBR-10", "title": "Tamper-evident provenance record generation and cryptographic digest verification", "status": "PASS" },
    { "id": "SBR-11", "title": "Download access with path traversal defense and digest verification", "status": "PASS" },
    { "id": "SBR-12", "title": "Full OpenAPI 3.1 extension: all 10 scene-bundle routes, components, and schemas", "status": "PASS" },
    { "id": "SBR-13", "title": "Feature still off: custom scene execution is strictly blocked with CAPABILITY_DISABLED", "status": "PASS" }
  ]
}
```

---

## 5. Giới hạn môi trường hiện tại và Cổng phụ thuộc bên ngoài (Pending External Gates)

Tuân thủ nghiêm ngặt nguyên tắc trung thực trong [AGENTS.md](../../AGENTS.md) và [docs/SECURITY.md](../../docs/SECURITY.md):

1. **`EXT-P7-01` — Môi trường phần cứng ảo hóa MicroVM (`NOT_RUN` trên container CI không có `/dev/kvm`):**
   - Thiết bị phần cứng `/dev/kvm` không khả dụng trên môi trường CI/container dev hiện tại và nhị phân Firecracker/Kata chưa được cấu hình ở cấp hệ điều hành host.
   - Theo thiết kế kiến trúc chuẩn tại [docs/SECURITY.md](../../docs/SECURITY.md) và ADR-0002: tính năng thực thi mã cảnh tùy ý (`custom-html-v1`) tiếp tục được giữ ở trạng thái vô hiệu hóa (`CAPABILITY_DISABLED` / `VIRTUALIZATION_UNAVAILABLE`) và **tuyệt đối không hạ cấp** xuống container thông thường.
2. **`EXT-P7-02` — Ký duyệt an ninh `C1–C6` và Phê duyệt Pilot Tenant (`P7-05` / `P7-06`):**
   - Đợt triển khai Task P7-02 hoàn tất trọn vẹn hợp đồng Registry, OpenAPI 3.1 extension, lược đồ tham số, cơ chế phân phiên bản, xuất gói tải về và lưu vết nguồn gốc; tuy nhiên cờ tính năng `CVE_CUSTOM_CODE_ENABLED` **vẫn giữ giá trị false**.
   - Việc mở cờ tính năng trong bất kỳ môi trường nào yêu cầu hoàn thành các task `P7-03` (adapter tạo mã), `P7-04` (bộ quét mã độc và biên dịch cô lập), chữ ký phê duyệt 6 cổng an ninh `C1–C6` tại `P7-05` và phê duyệt danh sách tenant pilot tại `P7-06`.
