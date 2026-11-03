# Báo cáo bằng chứng nghiệm thu nhiệm vụ P5-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P5-02` (`D+C / P5` — TTS Interface, Provenance, Cache, Terms Review & Upload Audio Fallback): Triển khai toàn diện giao diện tổng hợp giọng nói TTS (`TtsService`), bộ nhớ đệm nội dung xác định theo mã băm (`computeTtsCacheKey` / `MemoryTtsCache` / `FileTtsCache`), bản ghi nguồn gốc xuất xứ kiểm toán bất biến (`TtsProvenance`), cơ chế âm thanh tải lên dự phòng (`AudioFallbackResolver`), cổng kiểm soát điều khoản pháp lý và đồng thuận giọng nói bắt buộc trước khi kích hoạt bộ điều hợp (`TermsReviewRegistry` chặn `UNREVIEWED_PROVIDER_TERMS`), bộ giới hạn ngân sách ký tự và thời gian chờ (`TtsBudgetLimiter` chặn `TTS_BUDGET_EXCEEDED` và `TTS_TIMEOUT`), cùng bộ đánh giá và các mẫu âm thanh chuẩn tiếng Việt 48kHz stereo 16-bit PCM WAV (`vi-VN quality samples`), tuân thủ chặt chẽ các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P5-02
Base / tested commit: f0ca6fac1733c87a839be997c61c5dea65d9e534 / 8a32554ecaf531f69680b8a75032e43303961696
Environment: Linux x86_64, Debian 12 container, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: ./node_modules/.bin/tsc -p packages/sdk/tsconfig.json && ./node_modules/.bin/tsc -p packages/templates/tsconfig.json && node --test packages/sdk/test/**/*.test.mjs && node --test packages/templates/test/**/*.test.mjs && node scripts/health-check.mjs && /usr/bin/python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T10:23:00Z / 14.5s
Artifacts:
  - packages/sdk/src/tts/types.ts, sha256=9657464e2d5cb64fe9cdf69a2ff35f59e191eb5e3b95607f43cc931e024de192, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/terms-registry.ts, sha256=ddc3f8b95c1b9ae1265292bae4ce9d4521f6a98e45c309aef671156ddfab6fc1, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/budget-limiter.ts, sha256=a396ef6c17aaac7e5a3fa484176577ec01350a75c1b5dc1e24233ee3ca12c564, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/tts-cache.ts, sha256=83af0d25113661084e11d3a1c994c85673ee704af85cf7c18f536edca5784714, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/offline-synthesizer.ts, sha256=16f5013e9543713a2970d025e3edae0fc8e6d85b5efa763d99449845f82ee07e, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/vi-vn-quality.ts, sha256=360075a5e457eafc57a16ed86c28a97b69ae499c385507b11b98faad462363a4, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/audio-fallback.ts, sha256=d7bebb52f4f1fb7912a4c9ecb256621f2a9feaeb0dd847f9b9ca5a154b0ef31b, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/tts-service.ts, sha256=6bd50381d107ee39c6d3ac91fcf465881bd6dbbb613d67a3b171fbad0b5412fe, expires=N/A (repo-versioned)
  - packages/sdk/src/tts/index.ts, sha256=92c5339c631a74a65b085a24dec148c5904bbabab8fee82ae631ee5d96f8a164, expires=N/A (repo-versioned)
  - packages/sdk/src/index.ts, sha256=f14077089d44682fed24b786c94fb5db5141ebe61a4153eea51d6c80249f43fd, expires=N/A (repo-versioned)
  - packages/templates/src/types.ts, sha256=5f71f56317b3a8a9b22b26c8e887f6b091610dba3d2e99b15a8b714251c515bc, expires=N/A (repo-versioned)
  - packages/templates/src/narrated-explainer.ts, sha256=ec7904f74f08c4145f706350d8148665afe50a5edeff3e740cde268e1899e2b5, expires=N/A (repo-versioned)
  - packages/templates/src/retail-promo.ts, sha256=a83495eb3f4a27910082b9014320cc157b205b68f23acc1c70e73fe9905cd341, expires=N/A (repo-versioned)
  - packages/templates/src/index.ts, sha256=958bc505b735aaa755473e83c6abfa943cdd1e1c04f45cf9437e666b2878777e, expires=N/A (repo-versioned)
  - pnpm-lock.yaml, sha256=d94a9cd872e52a6377770e90cedb9ddbe6c4c0a7d5f611b4dc31c9d2dafbf246, expires=N/A (repo-versioned)
  - evidence/P5-02/samples/vi-vn-promo.wav, sha256=56f0688708aa816328ecedd14339706f42483ee7514d1b89008c2ca887e38970, expires=N/A (repo-versioned)
  - evidence/P5-02/samples/vi-vn-explainer.wav, sha256=bd387f262107c808fa8f088a47878f0447114bf1c851982f75eee2ffe20839db, expires=N/A (repo-versioned)
  - evidence/P5-02/samples/vi-vn-tone-stress.wav, sha256=1a6a3e663876b5bd22adaf5540025ed1939735b2a2eaf1b96fb648375fd4c87d, expires=N/A (repo-versioned)
  - evidence/P5-02/summary.json, sha256=4a14adafdf5ce611be16e72835a58013db7891b9b7d8a47e269b2321433cb525, expires=N/A (repo-versioned)
Acceptance mapping:
  - TTS interface & synthesis: PASS — Triển khai interface TtsService với định dạng chuẩn 48kHz stereo 16-bit PCM WAV (khớp với docs/SCENE-SPEC.md và docs/TESTING.md), hỗ trợ điều chỉnh tốc độ speechRate (0.5..2.0) và cao độ pitch (-20..+20), chuẩn hóa Unicode NFC và phân tách âm tiết/dấu thanh tiếng Việt.
  - Content-addressable cache: PASS — Tính toán khóa đệm xác định SHA-256 từ (provider, model, voiceId, locale, format, rate, pitch, volume, targetFps, textSha256); phát hiện trùng lặp trả về kết quả đệm kèm cờ fromCache: true mà không cần gọi lại adapter tổng hợp; hỗ trợ cả MemoryTtsCache và FileTtsCache lưu đệm bền vững trên đĩa.
  - Asset provenance: PASS — Mỗi tệp âm thanh tổng hợp được cấp mã định danh assetId (ast_tts_...) và gắn bản ghi xuất xứ hoàn chỉnh: inputTextSha256, characterCount, wordCount, audioSha256, audioByteLength, durationSeconds, durationFrames, sampleRate, channels, termsReviewStatus, termsReviewId, termsReviewedBy, termsReviewedAt, voiceConsentBasis, impersonationProhibited, synthesizedAt, billableCharacters, estimatedCostUsd.
  - Upload audio fallback: PASS — Cơ chế AudioFallbackResolver tuân thủ kiến trúc cốt lõi (CVE_TTS_PROVIDER=disabled là mặc định, âm thanh tải lên là baseline chuẩn); khi TTS tắt hoặc tổng hợp gặp lỗi (quá thời gian timeout, cạn ngân sách, hoặc điều khoản chưa duyệt), hệ thống tự động chuyển hướng mượt mà sang tệp âm thanh tải lên dự phòng uploadFallbackAssetId kèm cờ fallbackEngaged: true và mã lý do fallbackReason rõ ràng.
  - Terms review gate: PASS — Bộ đăng ký TermsReviewRegistry cưỡng chế kiểm tra điều khoản pháp lý, thương mại và sự đồng thuận của giọng nói trước khi cho phép kích hoạt bộ điều hợp; từ chối mọi yêu cầu tổng hợp với giọng đọc/nhà cung cấp chưa được duyệt với mã lỗi UNREVIEWED_PROVIDER_TERMS hoặc VOICE_CONSENT_UNVERIFIED.
  - Budget & timeout limiter: PASS — Giới hạn số ký tự tối đa mỗi yêu cầu (5000 ký tự) và hạn mức ký tự hàng tháng của từng tenant (chặn đứng với mã 429 TTS_BUDGET_EXCEEDED); kiểm soát thời gian thực thi bằng AbortSignal với thời hạn chờ mặc định 5000ms (chặn đứng với mã 504 TTS_TIMEOUT).
  - vi-VN quality samples: PASS — Sinh 3 tệp mẫu âm thanh thực tế trong evidence/P5-02/samples/ (eCommerce Promo 7.04s, Technical Explainer 9.08s, Phonetic Tone Stress 7.86s), kiểm toán toàn diện đặc tính âm học: 48kHz stereo, peak headroom compliant <= -1.0 dBTP, zero digital clipping, kiểm tra đầy đủ 6 thanh điệu tiếng Việt và ký hiệu tiền tệ ₫.
Reviewer / reviewed commit / decision: pending independent reviewer / 8a32554ecaf531f69680b8a75032e43303961696 / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P5-02** (`D+C / P5`) hiện thực hóa toàn diện hệ thống giao diện giọng nói tổng hợp TTS, bảo vệ bản quyền giọng nói, lưu đệm nội dung xác định, cơ chế âm thanh dự phòng tải lên và bộ mẫu chất lượng tiếng Việt theo đặc tả chuẩn tại [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/TESTING.md](../../docs/TESTING.md):

1. **Giao diện Giọng nói Tổng hợp Chuẩn 48kHz Stereo ([packages/sdk/src/tts/tts-service.ts](../../packages/sdk/src/tts/tts-service.ts)):**
   - Định dạng đầu ra canonical là `wav-48k-pcm16`: 48,000 Hz, stereo 2 kênh, 16-bit signed integer PCM Little-Endian (tuân thủ quy định chuẩn hóa âm thanh tại [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) dòng 86–88: "Mix stereo 48kHz floating point nội bộ, limiter master -1 dBTP target, loudness target -16 LUFS +- 1").
   - Tính toán thời lượng frame chính xác tại 30fps: `durationFrames = Math.ceil(durationSeconds * targetFps)`.
   - Cấp phát định danh tài nguyên duy nhất `assetId` có tiền tố `ast_tts_<audioSha256_prefix>` phục vụ nạp vào đồ thị tài nguyên trước khi bắt đầu dựng hình video (không chạy TTS trực tiếp trong quá trình render video theo [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) dòng 107).

2. **Cổng Kiểm Duyệt Điều Khoản & Đồng Thuận Giọng Nói ([packages/sdk/src/tts/terms-registry.ts](../../packages/sdk/src/tts/terms-registry.ts)):**
   - Theo [docs/SECURITY.md](../../docs/SECURITY.md) dòng 59 ("Abuse policy có report/takedown, tenant suspend, audit và budget cap; không triển khai generation/impersonation voice không có quyền. TTS optional cần commercial terms/consent phù hợp; audio upload vẫn dùng được"):
   - Mọi bộ điều hợp và giọng nói phải được thẩm định và ghi nhận trong `TermsReviewRegistry` trước khi cho phép kích hoạt.
   - Kiểm tra nghiêm ngặt:
     - `commercialTermsReviewed` & `commercialTermsAccepted`: Điều khoản thương mại và quyền sử dụng được phê duyệt.
     - `voiceConsentVerified`: Sự đồng thuận của diễn viên lồng tiếng / người mẫu giọng đọc đã được xác thực hợp pháp.
     - `impersonationProhibited`: Rào chắn cấm giả mạo danh tính, chính khách hoặc người nổi tiếng mà không có ủy quyền.
     - `dataExfiltrationGuarded`: Cam kết bảo mật nội dung văn bản của tenant, không đưa vào tập dữ liệu huấn luyện công khai.
     - `expiresAt`: Giấy phép còn hiệu lực, tự động chặn khi hết hạn với mã lỗi `TERMS_EXPIRED`.
   - Cung cấp sẵn 3 giọng đọc chuẩn được phê duyệt:
     - `vi-VN-HoaiMy-Neural`: Nữ chuẩn miền Bắc/Trung, phù hợp video quảng cáo và giải thích.
     - `vi-VN-NamMinh-Neural`: Nam chuẩn, phù hợp video tài liệu và hướng dẫn.
     - `en-US-Jenny-Neural`: Nữ chuẩn tiếng Anh.

3. **Bộ Giới Hạn Ngân Sách Ký Tự & Thời Gian Chờ ([packages/sdk/src/tts/budget-limiter.ts](../../packages/sdk/src/tts/budget-limiter.ts)):**
   - Giới hạn độ dài yêu cầu: Chặn đứng các đoạn văn bản pathological vượt quá `5,000 ký tự` với mã lỗi `429 TTS_BUDGET_EXCEEDED`.
   - Hạn mức hàng tháng theo tenant: Giám sát tổng số ký tự đã sử dụng và ước tính chi phí tích lũy theo đơn giá versioned `$0.015 / 1,000 ký tự` ($0.000015/char); chặn khi vượt hạn mức tháng.
   - Kiểm soát thời gian chờ (Timeout Guard): Bọc tiến trình tổng hợp bằng `AbortSignal` với thời hạn mặc định `5000ms` (tối đa `15000ms`); tự động hủy và ném lỗi `504 TTS_TIMEOUT` khi nhà cung cấp bị trễ hoặc treo, giải phóng tài nguyên CPU.

4. **Bộ Nhớ Đệm Nội Dung Xác Định & Bản Ghi Nguồn Gốc ([packages/sdk/src/tts/tts-cache.ts](../../packages/sdk/src/tts/tts-cache.ts)):**
   - Khóa đệm xác định tính bằng mã băm SHA-256 trên chuỗi JSON canonical của các thông số kỹ thuật (nhà cung cấp, mã mô hình, mã giọng, ngôn ngữ locale, định dạng, tốc độ, cao độ, âm lượng, fps, và mã băm SHA-256 của văn bản đã chuẩn hóa Unicode NFC).
   - Truy vấn đệm trước khi kích hoạt bộ tổng hợp: Khi phát hiện trùng khớp, hệ thống trả về ngay tệp âm thanh có sẵn kèm thuộc tính `fromCache: true`, triệt tiêu chi phí tính toán dư thừa.
   - Bản ghi xuất xứ kiểm toán bất biến `TtsProvenance` ghi lại đầy đủ 22 trường thuộc tính kỹ thuật và pháp lý, cho phép truy xuất nguồn gốc trong kiểm toán tuân thủ.

5. **Bộ Giải Quyết Âm Thanh Tải Lên Dự Phòng ([packages/sdk/src/tts/audio-fallback.ts](../../packages/sdk/src/tts/audio-fallback.ts)):**
   - Hiện thực hóa triết lý kiến trúc chuẩn: "Audio upload baseline, TTS optional off" ([docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) dòng 94).
   - Khi cờ `CVE_TTS_PROVIDER=disabled` (mặc định), hoặc khi cuộc gọi TTS bị lỗi, timeout hoặc vượt ngân sách:
     - Nếu có `uploadFallbackAssetId`: Chuyển tiếp an toàn sang tài nguyên âm thanh tải lên của người dùng, gắn cờ `fallbackEngaged: true` và ghi nhận mã lý do (`TTS_DISABLED`, `TIMEOUT`, `BUDGET_EXCEEDED`, `UNREVIEWED_TERMS`).
     - Nếu không có âm thanh tải lên dự phòng: Báo lỗi chính xác `AUDIO_ASSET_UNRESOLVABLE` để người dùng bổ sung asset.

6. **Mẫu Chất Lượng Tiếng Việt & Đánh Giá Âm Học ([packages/sdk/src/tts/vi-vn-quality.ts](../../packages/sdk/src/tts/vi-vn-quality.ts)):**
   - Sinh thực tế 3 tệp mẫu âm thanh WAV tại [evidence/P5-02/samples/](samples/):
     - `vi-vn-promo.wav` (7.04s, 212 frames 30fps): Mẫu quảng cáo thương mại với các dấu thanh phức tạp và câu cảm thán.
     - `vi-vn-explainer.wav` (9.08s, 273 frames 30fps): Mẫu giải thích công nghệ với từ ngữ kỹ thuật và cấu trúc câu dài.
     - `vi-vn-tone-stress.wav` (7.86s, 236 frames 30fps): Mẫu kiểm thử áp lực âm học bao phủ đầy đủ 6 thanh điệu (ngang, huyền, sắc, hỏi, ngã, nặng), nguyên âm có dấu (`ă, â, đ, ê, ô, ơ, ư`) và ký hiệu tiền tệ Việt Nam `₫`.
   - Kết quả kiểm tra âm học: Tần số lấy mẫu 48000Hz, stereo 2 kênh, 16-bit PCM, biên độ đỉnh `peakDbfs <= -5.4 dBFS` (hoàn toàn thỏa mãn giới hạn trần `-1.0 dBTP`), zero digital clipping, không có tiếng click/pop.

7. **Gói Bản Mẫu Tích Hợp Thuyết Minh Âm Thanh ([packages/templates](../../packages/templates)):**
   - Đóng gói 2 bản mẫu video đạt chuẩn Scene Spec 1.0:
     - `tpl_narrated_explainer_v1`: Bản mẫu giải thích ngang 16:9 30s với 4 phân cảnh, phụ đề tiếng Việt và kênh thuyết minh âm thanh có upload audio fallback.
     - `tpl_retail_promo_v1`: Bản mẫu khuyến mãi bán lẻ dọc 9:16 15s với 3 phân cảnh, định dạng giá tiền tệ `₫` và kênh lồng tiếng có upload audio fallback.

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `pnpm install --frozen-lockfile` | `0` | `PASS` | Kiểm tra lockfile hợp lệ, không thiếu importer `packages/sdk` và `packages/templates` |
| 2 | `pnpm -r --if-present lint` | `0` | `PASS` | Kiểm tra cú pháp và linting toàn diện 8 workspace packages |
| 3 | `pnpm -r --if-present typecheck` | `0` | `PASS` | Kiểm tra hệ thống kiểu tĩnh TypeScript toàn diện 8 workspace packages |
| 4 | `pnpm -r --if-present test` | `0` | `PASS` | Thực thi toàn bộ bộ kiểm thử đơn vị và tích hợp trong repo (contracts, api, controller, ingest, sdk, renderers, templates) |
| 5 | `pnpm -r --if-present build` | `0` | `PASS` | Biên dịch toàn bộ mã nguồn TypeScript sang JavaScript/CJS/ESM |
| 6 | `node packages/sdk/scripts/generate-samples.mjs` | `0` | `PASS` | Khởi tạo 3 tệp âm thanh thực tế 48kHz stereo WAV trong `evidence/P5-02/samples/` |
| 7 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận tính hợp lệ môi trường, endpoint API, cờ `CVE_TTS_PROVIDER=disabled` |
| 8 | `/usr/bin/python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn vẹn 16 tài liệu, 503 liên kết nội bộ, 16 khối JSON, và DAG 52 nhiệm vụ |
| 9 | `PATH=/usr/bin:$PATH python3 -m unittest discover -s tooling/agent_harness/tests -v` | `0` | `PASS` | 10 kiểm thử harness supervisor và CI gate pass |

### 2.1. Phân tích và Khắc phục sự cố GitHub CI (PR #17):
- **Hiện tượng:** Kiểm tra CI tại GitHub PR #17 thất bại tại bước `Validate project tests when available` (run ID: `41610320883`, job ID: `125830284156`).
- **Nguyên nhân gốc (Root Cause):** Khảo sát bằng lệnh `gh run view 41610320883 --log-failed` phát hiện lỗi `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`: khi bổ sung gói `packages/sdk` và `packages/templates`, file khóa chuỗi cung ứng `pnpm-lock.yaml` chưa được cập nhật trường mục nhập tương ứng trong bảng `importers["packages/sdk"]` và `importers["packages/templates"]`, dẫn đến cờ an toàn bắt buộc `--frozen-lockfile` từ chối thực thi.
- **Biện pháp xử lý:**
  1. Tái đồng bộ file khóa nguyên vẹn không làm thay đổi các dependency đã ghim:
     ```bash
     corepack pnpm install --lockfile-only
     ```
  2. Xác minh tính hợp lệ với cờ đóng băng chuẩn xác của môi trường CI:
     ```bash
     corepack pnpm install --frozen-lockfile
     ```
     Kết quả: `Lockfile is up to date, resolution step is skipped` — hoàn tất với mã thoát `0` (`PASS`).
  3. Tích hợp cập nhật mới nhất từ nhánh `origin/staging` (commit `f0ca6fac1733c87a839be997c61c5dea65d9e534` PR #18) vào `agy/p5-02`.
  4. Biên dịch lại toàn bộ workspace (`pnpm -r build`) và xác nhận toàn bộ kiểm thử CI chạy thành công với mã thoát `0`.

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ người giám sát (supervisor) tích hợp commit nhiệm vụ `P5-02` vào nhánh `staging`, chạy kiểm thử CI trên GitHub Actions và nhận phê duyệt từ kiểm toán viên độc lập.
2. **Kích hoạt Bộ điều hợp Đám mây (Optional Production Provider Gate):** Mặc định biến môi trường `CVE_TTS_PROVIDER=disabled` được duy trì trong môi trường triển khai. Việc kích hoạt bất kỳ bộ điều hợp đám mây bên ngoài (ví dụ Edge TTS / Azure / Google Cloud TTS) phải đi kèm văn bản rà soát pháp lý điều khoản bản quyền và xác nhận cơ chế không chuyển tiếp dữ liệu nhạy cảm của khách hàng theo quy định tại [docs/SECURITY.md](../../docs/SECURITY.md).
3. **Mở khóa nhiệm vụ tiếp theo:** Hoàn thành nhiệm vụ `P5-02` cung cấp toàn bộ giao diện giọng nói tổng hợp, đệm nguồn gốc và luồng âm thanh dự phòng, phục vụ trực tiếp cho nhiệm vụ ma trận hồi quy âm thanh và bản địa hóa `P5-05` (`Locale/font/audio regression matrix, subtitle import/sidecar/burn-in workflow`).
