# Báo cáo bằng chứng nghiệm thu nhiệm vụ P1-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P1-02` (`A / P1`): Xây dựng JSON Schema 2020-12 hoàn chỉnh cho Composition Spec 1.0, OpenAPI 3.1 cho REST API v1, bộ kiểu TypeScript tương ứng, cơ chế kiểm định schema và bộ mẫu dữ liệu (fixtures) hợp lệ / không hợp lệ theo chuẩn quy định tại [AGY execution](../../docs/AGENTS.md), [Scene spec](../../docs/SCENE-SPEC.md), [API](../../docs/API.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) và [Testing](../../docs/TESTING.md).

```text
Task: P1-02
Base / tested commit: 340ac073513591b59764a57297ba59da1f25c4cb / 0b536be28f6fbea914845d349fbd41755ebc9149
Environment: Linux x86_64, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T04:14:00Z / 18.2s
Artifacts:
  - packages/contracts/schemas/scene.schema.json, sha256=cb8914b52d0d61efaa59b61be86b676005723e662501e106f61e0afb4f43585a, expires=N/A (repo-versioned)
  - packages/contracts/schemas/scene.expanded.schema.json, sha256=e0164c605ffdb0b561dd951e4f5ea3037a9230a2795fee832bd88ee6fbb9d661, expires=N/A (repo-versioned)
  - packages/contracts/schemas/openapi.json, sha256=0ee1515d35a3e3fe4d25a0daa60174b538d4637588451204139555818c57455b, expires=N/A (repo-versioned)
  - evidence/P1-02/summary.json, sha256=17df20b001a1bbcfc48d4fb983bcba525656bb0d3ae82f4eece1a9b23b49ecb3, expires=N/A (repo-versioned)
Acceptance mapping:
  - Full JSON Schema 2020-12: PASS — Chuẩn https://json-schema.org/draft/2020-12/schema, $id https://schemas.example.invalid/cve/composition/1.0, additionalProperties: false trên toàn bộ đối tượng trừ metadata và extensions
  - Expand mọi $defs fragment: PASS — 24 mảnh định nghĩa chuẩn tắc được hiện thực đầy đủ (canvas, rationalFps, font, scene, bundle, transitionOut, layer, box, transform, animation, keyframe, layerContent, textContent, imageContent, videoContent, shapeContent, svgContent, audioTrack, gainKeyframe, subtitleTrack, subtitleCue, subtitleStyle, metadata, extensions) và sinh bản dereferenced scene.expanded.schema.json
  - OpenAPI 3.1: PASS — Đặc tả OpenAPI 3.1.0 đầy đủ 32 endpoints trong catalog, 24 path patterns, cấu trúc BearerAuth, parameters, headers, schemas và responses chuẩn
  - Generated types: PASS — Định nghĩa TypeScript đầy đủ và nhất quán trong packages/contracts/src/types/ (scene.ts, api.ts, job.ts, capabilities.ts)
  - Unknown fields / invalid timing examples fail: PASS — 10 fixture không hợp lệ kiểm tra unknown root field, unknown layer field, duration_frames=0, float fps, invalid cut/fade transition, negative box dimensions, invalid schema_version, invalid locale, out-of-range font weight đều bị từ chối chính xác với các mã lỗi chuẩn (UNKNOWN_FIELD, OUT_OF_RANGE, TYPE_MISMATCH, ENUM_MISMATCH, ONE_OF_MISMATCH)
  - Valid fixture parse pass: PASS — 4 composition fixtures (minimal 150-frame, POC-01 promo 15s, POC-02 explainer 30s, POC-03 footage 45s) và 3 API request fixtures đều vượt qua kiểm định 100%
Reviewer / reviewed commit / decision: pending independent reviewer / 0b536be28f6fbea914845d349fbd41755ebc9149 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P1-02** (`A / P1`) thuộc luồng hợp đồng và điều khiển (Contracts/Control stream) trong [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md). Toàn bộ tiêu chí nghiệm thu kỹ thuật đã được triển khai đầy đủ:

1. **JSON Schema 2020-12 chuẩn tắc (`scene.schema.json`):**
   - Đạt chuẩn meta-schema `https://json-schema.org/draft/2020-12/schema` với `$id: "https://schemas.example.invalid/cve/composition/1.0"`.
   - Cơ chế đóng đối tượng chặt chẽ (`additionalProperties: false`) trên toàn bộ cấp độ (root composition, canvas, fps, font, scene, transition, layer, box, transform, animation, keyframe, layer content, audio track, subtitle track, cue, subtitle style).
   - Ngoại lệ mở có kiểm soát duy nhất: `metadata` (tối đa 32 keys, key <= 64 chars, value string <= 256 chars) và `extensions` (namespaced objects) theo đúng quy định tại [Scene spec](../../docs/SCENE-SPEC.md).

2. **Hiện thực hóa và mở rộng toàn bộ 24 `$defs` fragments:**
   - `canvas`: Kích thước điểm ảnh chẵn dương `[2, 3840]`, background mã hex `#RRGGBB` hoặc `#RRGGBBAA`.
   - `rationalFps`: Tỷ số khung hình hữu tỉ dương `{ num, den }`, loại bỏ hoàn toàn float fps.
   - `font`: Định danh font nội bộ, asset ID server cấp, mã băm SHA-256 (64 hex lowercase), font family, weight (100..900), style (normal/italic).
   - `scene`: Hỗ trợ cả cảnh tiêu chuẩn (`layers`) và cảnh tùy biến (`bundle` cho `custom-html-v1`), loại trừ lẫn nhau qua cấu trúc `oneOf`.
   - `transitionOut`: Phân biệt chuyển cảnh `cut` (`duration_frames = 0`) và `fade_to_background` (`2 <= duration_frames <= 300`).
   - `layer` & `box` & `transform`: Giới hạn tọa độ hữu hạn `[-100000, 100000]`, kích thước dương `<= 100000`, transform scale `[0.01, 100]`, origin normalized `[0, 1]`.
   - `animation` & `keyframe`: Thuộc tính biến đổi trong allowlist, 4 hàm easing Quad/Linear chuẩn, mảng keyframes tăng dần nghiêm ngặt (2..64 keys).
   - `layerContent`: Discriminated union phân tách theo 5 loại layer: `textContent`, `imageContent`, `videoContent`, `shapeContent`, `svgContent`.
   - `audioTrack` & `gainKeyframe`: Audio stereo 48kHz, khoảng gain `[-60, 12] dB`, vai trò voice/music/effect, fade frames và gain keyframes.
   - `subtitleTrack` & `subtitleCue` & `subtitleStyle`: Phụ đề burn-in / sidecar, BCP-47 locale (`vi-VN`, `en-US`), tối đa 500 cues/track, text <= 1000 ký tự.
   - Xuất bản tự động bản dereferenced `scene.expanded.schema.json` giải quyết toàn bộ tham chiếu nội tại `$defs`.

3. **OpenAPI 3.1 Specification (`openapi.json`):**
   - Đạt chuẩn OpenAPI `3.1.0`.
   - Bao phủ toàn diện **32 endpoints** trong catalog của [API.md](../../docs/API.md) trên 24 mẫu URL path.
   - Định nghĩa bảo mật `BearerAuth` (tenant API key 32 bytes).
   - Chuẩn hóa các header bắt buộc: `Idempotency-Key` (bắt buộc cho POST mutations, regex `^[A-Za-z0-9._:-]{1,128}$`), `X-Request-Id`, `Retry-After`, `Location`.
   - 41 component schemas định nghĩa đầy đủ cấu trúc request/response, phân biệt rõ ràng mã trạng thái HTTP (`400`, `401`, `403`, `404`, `409`, `410`, `413`, `422`, `429`, `503`) và taxonomy lỗi theo tài liệu rà soát [P0-04](../../evidence/P0-04/report.md).

4. **Bộ kiểu TypeScript (Generated Types):**
   - Cập nhật và mở rộng [packages/contracts/src/types/scene.ts](../../packages/contracts/src/types/scene.ts) bao phủ toàn bộ cây đối tượng Composition Spec 1.0.
   - Bổ sung [packages/contracts/src/types/api.ts](../../packages/contracts/src/types/api.ts) bao phủ toàn bộ đối tượng REST API v1.
   - Duy trì tính nhất quán kiểu dữ liệu với [job.ts](../../packages/contracts/src/types/job.ts), [capabilities.ts](../../packages/contracts/src/types/capabilities.ts) và [env.ts](../../packages/contracts/src/config/env.ts).

5. **Trình kiểm định Schema độc lập (`JsonSchemaValidator`):**
   - Triển khai bộ kiểm định thuần TypeScript không phụ thuộc gói npm ngoài [packages/contracts/src/validation/composition-validator.ts](../../packages/contracts/src/validation/composition-validator.ts).
   - Hỗ trợ đầy đủ từ khóa Draft 2020-12: `type`, `required`, `properties`, `additionalProperties: false`, `propertyNames`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `enum`, `const`, `$ref`, `oneOf`, `anyOf`, `allOf`, `if / then`.
   - Báo lỗi kèm JSON Pointer chính xác và mã lỗi ổn định: `UNKNOWN_FIELD`, `OUT_OF_RANGE`, `TYPE_MISMATCH`, `MISSING_REQUIRED_FIELD`, `PATTERN_MISMATCH`, `ENUM_MISMATCH`, `ONE_OF_MISMATCH`.

6. **Bộ Fixtures kiểm thử toàn diện:**
   - 4 fixtures hợp lệ: `minimal-valid.json` (150 frames, 5s), `poc01-promo.json` (450 frames, 15s), `poc02-explainer.json` (900 frames, 30s), `poc03-footage.json` (1350 frames, 45s).
   - 3 API request fixtures: `template-instantiate-request.json`, `job-create-render-request.json`, `job-create-preview-request.json`.
   - 10 fixtures không hợp lệ bao quát các biến thể lỗi bảo mật, trường lạ, và sai lệch thời gian / ranh giới.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Thời gian | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run build` | `0` | 4.3s | `PASS` | Biên dịch TypeScript 4 packages sang ESM dist |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run typecheck` | `0` | 3.3s | `PASS` | Kiểm tra kiểu tĩnh TypeScript strict mode không có lỗi |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run lint` | `0` | 3.2s | `PASS` | Kiểm tra cú pháp và quy chuẩn mã nguồn |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run test` | `0` | 1.1s | `PASS` | Chạy toàn bộ 51 test cases qua native Node.js test runner |
| 5 | `node scripts/health-check.mjs` | `0` | 0.15s | `PASS` | Kiểm tra sức khỏe môi trường, /healthz, /readyz, /v1/capabilities |
| 6 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | 0.35s | `PASS` | Kiểm tra toàn vẹn tài liệu, liên kết nội bộ, và DAG không chu trình |

---

## 3. Cổng kiểm soát ngoại bộ và bước tiếp theo (External Gates)

1. **Cổng kiểm soát ngoại bộ chưa hoàn tất (Pending External Gates):**
   - Đánh giá độc lập (Peer review) của reviewer và kích hoạt CI staging trên GitHub PR.
   - Chưa triển khai render video thật (nhiệm vụ của `P2-01` đến `P2-05`).
   - Chưa chạy kiểm thử cơ sở dữ liệu thật / di trú PostgreSQL (nhiệm vụ của `P3-01`).
2. **Kế hoạch nhiệm vụ tiếp theo:**
   - Khởi tạo nhiệm vụ `P1-03` (`B / P1`): Trình biên dịch và kiểm định ngữ nghĩa (Semantic validator & canonical compiler manifest) kế thừa các schemas và types từ `P1-02`.
