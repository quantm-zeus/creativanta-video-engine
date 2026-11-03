# Báo cáo bằng chứng nghiệm thu nhiệm vụ P1-03

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P1-03` (`B / P1`): Trình kiểm định ngữ nghĩa (Semantic validator), trình biên dịch đặc tả chuẩn tắc (Canonical compiler manifest), tính toán thời gian hữu tỉ (Rational time & frame math), quản lý phiên bản cảnh (Scene revisions & hash), kiểm soát lỗi khả năng (Capability & policy errors), cùng bộ kiểm thử ranh giới và thuộc tính (Boundary & property tests) theo đúng quy định tại [AGY execution](../../docs/AGENTS.md), [Scene spec](../../docs/SCENE-SPEC.md), [API](../../docs/API.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Testing](../../docs/TESTING.md) và [Báo cáo rà soát hợp đồng P0-04](../P0-04/report.md).

```text
Task: P1-03
Base / tested commit: 0f532f82d3c0294b5bba427e722aa074036e0897 / 8add8a587683b4c48e621b8369adbd44b697461a
Environment: Linux x86_64, 4 vCPUs, 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm build && pnpm typecheck && pnpm lint && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T04:26:00Z / 18.5s
Artifacts:
  - evidence/P1-03/manifest-minimal.json, sha256=258b029e8eaeb47586adcf5b50faaef2a71c9ad1290628be3ee6b3f4a76321ef, expires=N/A (repo-versioned)
  - evidence/P1-03/manifest-poc01.json, sha256=d495fcb30f9b655eb83ca5aa6e3e642a61e81047c41f4d207962110052ce4d90, expires=N/A (repo-versioned)
  - evidence/P1-03/manifest-poc02.json, sha256=4f0dd6722b2a1b73680b7804973f3d54cb67d661b625dd420166ccf3d7d5a1e0, expires=N/A (repo-versioned)
  - evidence/P1-03/manifest-poc03.json, sha256=6965d77956a1a36725e7cf249b607b391eb7f728e52e47604a3b9b98971640e5, expires=N/A (repo-versioned)
  - evidence/P1-03/summary.json, sha256=4948fa0d9e7ee9fcdf9dc32db72a6fd63520d6dc2fbe7d486f9fbdbc8221326d, expires=N/A (repo-versioned)
Acceptance mapping:
  - Semantic validator: PASS — Kiểm tra toàn vẹn thời gian nửa khoảng [start, end), tính liên tục timeline không gap/overlap (TIMELINE_BOUNDS), giới hạn layer trong scene, chuyển cảnh cut và fade_to_background (2 <= F <= min(300, duration)), xung đột animation trùng thuộc tính (ANIMATION_CONFLICT), tính duy nhất của mọi định danh (DUPLICATE_ID), và tính hợp lệ của tham chiếu phông chữ (UNKNOWN_FONT).
  - Canonical compiler manifest: PASS — Trình biên dịch tạo manifest bất biến chuẩn hóa RFC 8785 JCS, băm SHA-256 tách biệt spec_hash (bỏ qua metadata), render_hash, và scene_hash từng cảnh; hỗ trợ hàm thuần evaluateFrame(k) tính toán độ mờ đục hiệu dụng và biến đổi hình học ở bất kỳ khung hình nào.
  - Frames / rational time: PASS — Đại số số hữu tỉ chuẩn xác cho FPS {num, den}, chuyển đổi khung hình sang giây (k * den / num), mili-giây phụ đề và mẫu âm thanh 48kHz (round_half_up); bảo toàn bất biến zero-drift khi nối các đoạn âm thanh liên tiếp.
  - Scene references / hash / defaults / revisions: PASS — Hiện thực hóa toàn bộ giá trị mặc định chuẩn tắc (defaults materialization), đối chiếu phiên bản base_revision vs new_revision, phát hiện chính xác cảnh sửa đổi bắt buộc tăng revision, và phân biệt thay đổi chỉ ở metadata vs thay đổi ảnh hưởng kết xuất.
  - Capability errors: PASS — Kiểm định tầng 3 phân tách lỗi khả năng và hồ sơ (PROFILE_CONSTRAINT_VIOLATED cho kích thước canvas, thời lượng quá hạn, FPS không hỗ trợ; CAPABILITY_DISABLED cho custom-html-v1 khi tắt custom code hoặc rtl khi tắt RTL).
  - Boundary / property tests: PASS — Bộ kiểm thử tự động gồm 99 tests trong packages/contracts, 7 tests trong packages/api và 21 tests trong packages/controller chứng minh các bất biến toán học, tính đơn điệu của hàm easing, và độ dốc suy giảm tuyến tính của fade transition.
Reviewer / reviewed commit / decision: pending independent reviewer / 8add8a587683b4c48e621b8369adbd44b697461a / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P1-03** (`B / P1`) thuộc luồng kết xuất và truyền thông (Render/Media stream) trong [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md). Toàn bộ tiêu chí nghiệm thu kỹ thuật đã được triển khai đầy đủ và tích hợp liền mạch vào hệ thống:

1. **Bộ kiểm định ngữ nghĩa Tầng 2 (`SemanticValidator`):**
   - Triển khai tại [packages/contracts/src/validation/semantic-validator.ts](../../packages/contracts/src/validation/semantic-validator.ts).
   - Kiểm tra tính liên tục của dòng thời gian (Timeline continuity): cảnh đầu tiên bắt buộc `start_frame = 0`; các cảnh tiếp theo phải liên tiếp không có khoảng trống (gaps) hoặc chồng lấn (overlaps) (`scene[i].start_frame === scene[i-1].start_frame + scene[i-1].duration_frames`); cảnh cuối cùng phải kết thúc đúng tại `duration_frames` của composition. Nếu vi phạm, trả về mã lỗi chuẩn `TIMELINE_BOUNDS`.
   - Kiểm tra ranh giới thời gian của layer: `start_frame >= 0`, `duration_frames > 0`, và `start_frame + duration_frames <= scene.duration_frames`.
   - Kiểm tra chuyển cảnh: `cut` bắt buộc `duration_frames = 0`; `fade_to_background` bắt buộc `2 <= F <= min(300, scene.duration_frames)`. Trường hợp `F > scene.duration_frames`, trả về `TIMELINE_BOUNDS` tại con trỏ `/scenes/{i}/transition_out/duration_frames` theo đúng quyết định `AMB-002` trong [P0-04 report](../P0-04/report.md).
   - Kiểm tra xung đột hoạt ảnh (Animation conflicts): mỗi thuộc tính biến đổi (`opacity`, `translate_x`, `translate_y`, `scale_x`, `scale_y`, `rotate_deg`) chỉ được phép có tối đa một animation trên một layer; vi phạm trả về `ANIMATION_CONFLICT`. Mảng keyframes bắt buộc có từ 2 đến 64 điểm, tăng nghiêm ngặt theo chỉ số khung hình nội bộ, và nằm trong `[0, layer.duration_frames - 1]`.
   - Kiểm tra tính duy nhất của ID: cảnh (`/scenes/{i}/id`), layer trong từng cảnh (`/scenes/{i}/layers/{j}/id`), audio track (`/audio_tracks/{i}/id`), subtitle track (`/subtitles/{i}/id`), và subtitle cue (`/subtitles/{i}/cues/{j}/id`) đều được kiểm tra tính duy nhất tuyệt đối (`DUPLICATE_ID`).
   - Kiểm tra tham chiếu phông chữ: mọi layer văn bản và kiểu phụ đề (`subtitle.style`) tham chiếu `font_id` không tồn tại trong danh mục `spec.fonts` đều bị từ chối với mã lỗi `UNKNOWN_FONT`.

2. **Đại số thời gian hữu tỉ và chuyển đổi âm thanh không trôi dạt (`RationalTime`):**
   - Triển khai tại [packages/contracts/src/compiler/rational-time.ts](../../packages/contracts/src/compiler/rational-time.ts).
   - Biểu diễn tỷ số khung hình hữu tỉ `{ num, den }`, tối giản qua ước số chung lớn nhất (GCD).
   - Chuyển đổi khung hình sang giây theo công thức đại số chính xác `(k * den) / num`.
   - Chuyển đổi khung hình sang mili-giây phụ đề và sang mẫu âm thanh 48kHz sử dụng thuật toán số học số nguyên làm tròn nửa lên (`roundHalfUpRational`), loại trừ sai số dấu phẩy động.
   - Tính toán mẫu âm thanh từng đoạn `[start, end)` bằng hiệu số vị trí tuyệt đối (`frameToAudioSamples(end) - frameToAudioSamples(start)`), chứng minh bất biến zero-drift trên mọi phân hoạch thời gian qua bài kiểm thử thuộc tính.

3. **Hiện thực hóa giá trị mặc định và chuẩn hóa JCS RFC 8785 (`CanonicalJson`):**
   - Triển khai tại [packages/contracts/src/compiler/canonical-json.ts](../../packages/contracts/src/compiler/canonical-json.ts).
   - Hiện thực hóa đầy đủ các giá trị mặc định chuẩn tắc (`materializeCompositionDefaults`): `direction="ltr"`, màu nền canvas mặc định `#000000`, chuyển cảnh mặc định `{ type: "cut", duration_frames: 0 }`, `opacity=1`, `transform` đơn vị (translate 0/0, scale 1/1, rotate 0, origin 0.5/0.5), căn lề văn bản `align="left"`, `line_height=1.2`, `max_lines=5`, `overflow="error"`, căn giữa ảnh/video/svg `anchor=(0.5, 0.5)`.
   - Chuẩn hóa chuỗi JSON theo RFC 8785 (JSON Canonicalization Scheme): chuẩn hóa Unicode NFC, sắp xếp khóa đối tượng theo đơn vị mã UTF-16, số thực hữu hạn không có khoảng trắng thừa.
   - Cơ chế băm phân tầng:
     - `spec_hash`: Mã băm SHA-256 của đặc tả đã chuẩn hóa loại trừ trường `metadata`, bảo đảm các thay đổi chỉ ở metadata không làm đổi hash kết xuất.
     - `scene_hash`: Mã băm SHA-256 chuẩn tắc của từng cảnh độc lập, làm cơ sở kiểm soát sửa đổi từng cảnh.
     - `render_hash`: Mã băm kết hợp giữa đặc tả đã chuẩn hóa, mã hồ sơ (`profile`), mã băm tài nguyên và phông chữ, cùng phiên bản trình biên dịch.

4. **Quản lý sửa đổi và xung đột phiên bản (`RevisionManager`):**
   - Triển khai tại [packages/contracts/src/compiler/revision-manager.ts](../../packages/contracts/src/compiler/revision-manager.ts).
   - Kiểm soát tiến trình phiên bản: `new_revision > base_revision`.
   - So sánh chi tiết từng cảnh theo `scene_hash`: phân loại chính xác các trạng thái `unchanged`, `modified`, `added`, `removed`.
   - Bắt buộc tăng `scene.revision` khi nội dung cảnh thay đổi, ngăn chặn client cố tình giữ nguyên số revision cũ khi đã sửa cảnh.
   - Phân biệt minh bạch giữa thay đổi chỉ ở metadata (`is_metadata_only: true`) và thay đổi ảnh hưởng kết xuất (`is_render_affecting: true`).

5. **Bộ kiểm định khả năng và chính sách Tầng 3 (`CapabilityValidator`):**
   - Triển khai tại [packages/contracts/src/validation/capability-validator.ts](../../packages/contracts/src/validation/capability-validator.ts).
   - Kiểm soát hồ sơ `mp4-720p-v1`: kích thước canvas bắt buộc `1280x720` hoặc `720x1280`, FPS `30/1`, thời lượng tối đa `1800` khung hình (60 giây); vi phạm trả về HTTP 422 `UNSUPPORTED_CAPABILITY` với chi tiết `PROFILE_CONSTRAINT_VIOLATED`.
   - Kiểm soát hồ sơ `preview-360p-v1`: kích thước `640x360` hoặc `360x640`, thời lượng tối đa `300` khung hình (10 giây).
   - Kiểm soát cờ tính năng động cơ: chặn cảnh sử dụng `custom-html-v1` khi cờ `CVE_CUSTOM_CODE_ENABLED=false` với mã `CAPABILITY_DISABLED`; chặn hướng văn bản `rtl` khi cờ RTL chưa được cấp.
   - Kiểm soát hạn mức hệ thống: tối đa 50 cảnh, tối đa 100 layer/cảnh, tối đa 500 layer/composition, tối đa 16 phông chữ, 16 audio tracks, 8 subtitle tracks.

6. **Trình biên dịch đặc tả chuẩn tắc và hàm đánh giá khung hình (`CanonicalCompiler`):**
   - Triển khai tại [packages/contracts/src/compiler/canonical-compiler.ts](../../packages/contracts/src/compiler/canonical-compiler.ts).
   - Tích hợp chu trình 3 tầng: Schema -> Semantic -> Policy/Capability qua hàm hợp nhất `validateCompositionUnified`.
   - Biên dịch thành công 4 fixtures chuẩn: `manifest-minimal.json`, `manifest-poc01.json`, `manifest-poc02.json`, `manifest-poc03.json` lưu tại `evidence/P1-03/`.
   - Hàm thuần `evaluateFrame(manifest, globalFrame)`: xác định chính xác cảnh hoạt động, khung hình cục bộ, độ mờ chuyển cảnh `scene_alpha = (end - 1 - k) / (F - 1)`, danh sách layer hoạt động sắp xếp theo `z_index`, nội suy hoạt ảnh theo 4 đường cong easing chuẩn (`linear`, `ease_in_quad`, `ease_out_quad`, `ease_in_out_quad`), và tính toán độ mờ đục hiệu dụng `effective_opacity = layer_opacity * scene_alpha`.

7. **Tích hợp Endpoint Kiểm định API (`POST /v1/compositions/validate`):**
   - Triển khai tại [packages/api/src/server.ts](../../packages/api/src/server.ts).
   - Hỗ trợ kiểm định toàn diện body composition với giới hạn tải 1 MiB (`413 PAYLOAD_TOO_LARGE`).
   - Phân biệt chính xác HTTP 422 `VALIDATION_FAILED` (lỗi schema hoặc ngữ nghĩa) và HTTP 422 `UNSUPPORTED_CAPABILITY` (lỗi hồ sơ hoặc động cơ bị tắt).
   - Trả về phản hồi thành công HTTP 200 gồm đặc tả đã chuẩn hóa (`normalized_spec`), `render_hash`, danh sách năng lực yêu cầu (`required_capabilities`), ước tính thời lượng và chi phí (`estimate`), và cảnh báo (`warnings`).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Thời gian | Kết quả | Ghi chú |
|---|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run build` | `0` | 3.5s | `PASS` | Biên dịch TypeScript 4 packages sang ESM dist không có lỗi |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run typecheck` | `0` | 3.9s | `PASS` | Kiểm tra kiểu tĩnh TypeScript strict mode đạt 100% |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run lint` | `0` | 4.2s | `PASS` | Kiểm tra quy chuẩn cú pháp và mã nguồn không có lỗi |
| 4 | `cd packages/contracts && node --test test/**/*.test.mjs` | `0` | 2.2s | `PASS` | Chạy 99 test cases trong packages/contracts bao phủ toàn bộ semantic, compiler, property, schema và revision |
| 5 | `cd packages/api && node --test test/**/*.test.mjs` | `0` | 0.4s | `PASS` | Chạy 7 test cases bao phủ health probes, capabilities và POST /v1/compositions/validate |
| 6 | `cd packages/controller && node --test test/**/*.test.mjs` | `0` | 1.3s | `PASS` | Chạy 21 test cases bộ kiểm định sandbox launcher P1-04 |
| 7 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -r --if-present run test` | `0` | 2.5s | `PASS` | Chạy toàn bộ 130 test cases xuyên suốt toàn bộ workspace monorepo |
| 8 | `node scripts/health-check.mjs` | `0` | 0.15s | `PASS` | Kiểm tra cấu hình môi trường, probes /healthz, /readyz và capabilities |
| 9 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | 0.35s | `PASS` | Kiểm tra toàn vẹn tài liệu, liên kết nội bộ, và đồ thị DAG không chu trình |

---

## 3. Cổng kiểm soát ngoại bộ và bước tiếp theo (External Gates)

1. **Cổng kiểm soát ngoại bộ chưa hoàn tất (Pending External Gates):**
   - Đánh giá độc lập (Peer review) của reviewer và kích hoạt CI staging trên GitHub PR tới nhánh staging.
   - Chưa triển khai render video thật (nhiệm vụ của `P2-01` qua spike adapter HyperFrames và Chromium baseline trên cùng manifest).
   - Chưa chạy kiểm thử cơ sở dữ liệu thật / di trú PostgreSQL (nhiệm vụ của `P3-01`).
2. **Kế hoạch nhiệm vụ tiếp theo:**
   - Handoff sang nhiệm vụ `P1-05` (`A+C / P1`): Thiết lập pipeline CI GitHub Actions chuẩn hóa kiểm tra lint, typecheck, unit tests, contracts, và sandbox harness.
   - Chuẩn bị cho nhiệm vụ `P2-01` (`B / P2`): Triển khai adapter kết xuất video đầu tiên tiêu thụ trực tiếp `CanonicalCompilerManifest` được sinh ra bởi trình biên dịch `P1-03`.
