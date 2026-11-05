# Báo cáo bằng chứng nghiệm thu nhiệm vụ P8-02

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ **P8-02** (`B+D / P8 — optional browser export và specialized engines`): Triển khai thử nghiệm xuất video trên trình duyệt máy khách (`Browser export spike`) theo tập con phân cảnh đã phê duyệt (`scene subset`), cơ chế tự động thoái lui tạo **server job mới** (`server job mới`) khi phát hiện tính năng không được hỗ trợ, bộ kiểm thử toàn diện về quản lý bộ nhớ (`memory bounding`), hủy bỏ tác vụ (`cancellation`), tải xuống (`download`), và đối chuẩn chất lượng so với máy chủ (`quality parity`); tuân thủ nghiêm ngặt nguyên tắc **tài sản ngoại tuyến chỉ qua scoped grants** (`offline assets chỉ scoped grants`), đáp ứng các quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md), [docs/API.md](../../docs/API.md) và kết quả rà soát từ [P8-01](../P8-01/report.md) & [P8-03](../P8-03/report.md).

---

## Bằng chứng thực thi (Evidence Template)

```text
Task: P8-02
Base / tested commit: 6581c5d9472e399c55b6c31bf0b60481c9ec8d00 / HEAD
Environment: Linux evergreen 7.0.0-1011-gcp #11~24.04.1-Ubuntu SMP PREEMPT Tue Aug 11 20:14:48 UTC 2026 x86_64, Ubuntu 24.04.5 LTS, 4 vCPUs (Intel Xeon 2.20GHz), 15GiB RAM, Node v24.22.2, pnpm 12.16.1, TypeScript 5.7.3, Python 3.12.3
Command:
  - pnpm install --frozen-lockfile
  - pnpm -r --if-present lint
  - pnpm -r --if-present typecheck
  - pnpm -r --if-present test
  - pnpm -r --if-present build
  - node --test packages/browser-export/test/scene-subset-and-fallback.test.mjs
  - node --test packages/browser-export/test/scoped-asset-loader.test.mjs
  - node --test packages/browser-export/test/memory-and-cancel.test.mjs
  - node --test packages/browser-export/test/download-and-quality-parity.test.mjs
  - node --test packages/browser-export/test/browser-export-spike.test.mjs
  - python3 scripts/validate_repo.py
  - python3 -m unittest discover -s tooling/agent_harness/tests -v
  - node scripts/health-check.mjs
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-05T07:45:00Z / 215.0s
Artifacts:
  - evidence/P8-02/report.md
  - evidence/P8-02/browser-export-spike-verification.json, sha256=64826c957305fe7bee8f1c723562f4b66ce9f24506bb8806eca27648074bf749
  - evidence/P8-02/quality-parity-report.json, sha256=3c5ca755ecdeeacbc66db835689dc72b186d6968150596b87a1f2fa4f0bc9ec4
  - packages/browser-export/src/types.ts, sha256=b86ee619d585b166ec0a59ec76475bae4a487c2b843cb1c63b991da4be563f66
  - packages/browser-export/src/index.ts, sha256=355d03a7b13feacf957a84d628b112407bbeadcb35923fe8af4e3feedfe27d4f
  - packages/browser-export/src/scene-subset.ts, sha256=efa717a48e30bf1ddede92bc46b54d751d5b180450f9a34ae446c8c2b80f7815
  - packages/browser-export/src/scoped-asset-loader.ts, sha256=490f43ff6e8399010e6751c8f5434573b89027249dc06e955b78f679c21e85cb
  - packages/browser-export/src/server-fallback.ts, sha256=bfea7b53cd6feb6929f778fc541ab876868326dde22763496313a1bb091b223d
  - packages/browser-export/src/memory-guard.ts, sha256=ae54ea062f3651e0168ece951bd46dc7331fd8bec28a35d5a24454e91dda4396
  - packages/browser-export/src/browser-download.ts, sha256=b01ca0b3195414522b6f579470e3b2a883da57300381217eda051e2bb07036a4
  - packages/browser-export/src/quality-parity.ts, sha256=58451a89bfd6c02e44ad5d1922b01e68af0d183e1835d96ff171642cfe3fc853
  - packages/browser-export/src/pipeline.ts, sha256=27f28a4c479d5764ddbdfca2388ea2867121614e8492ff53872216db5472b8b6
  - packages/browser-export/test/scene-subset-and-fallback.test.mjs, sha256=58126e28250e9f066a3fab44c25b321697bf9006895d3e44825cf5042f97f1c5
  - packages/browser-export/test/scoped-asset-loader.test.mjs, sha256=1c87e9d881bd73e32987e0a245671189df2be21d152f0b4d229d8d1146ba3dd9
  - packages/browser-export/test/memory-and-cancel.test.mjs, sha256=ea074e7b52c2464f4a60e3996a0e89111aa80374229d4fbcaee6e6ea59bfcc6f
  - packages/browser-export/test/download-and-quality-parity.test.mjs, sha256=5462ce0df873df969045b457e2e6878666aa5dc3488b1b9b91185e7298579516
  - packages/browser-export/test/browser-export-spike.test.mjs, sha256=37eaf8f760b7cf3ee38dce20e24ffdb14c8406eb4dda8d0f6ed3e28b9fcec693
Acceptance mapping:
  - Browser export spike theo scene subset: PASS — Triển khai pipeline xuất video trình duyệt hỗ trợ tập con 2D Canvas chuẩn (text, shape, image, fade transitions, CFR timing); từ chối dứt khoát custom code hoặc layer vượt ngưỡng.
  - Unsupported feature fallback server job mới: PASS — Tự động chuyển giao sang POST /v1/render-jobs tạo job máy chủ mới với Idempotency-Key chuẩn canonical hóa khi gặp tính năng không hỗ trợ hoặc rủi ro tràn RAM.
  - Memory/cancel/download/quality parity tests: PASS — Thiết lập MemoryGuard giới hạn cửa sổ khung hình trôi nổi (peak <= 4 frames, <= 32 MiB); hỗ trợ AbortSignal hủy tác vụ sạch sẽ; kiểm định chữ ký container fMP4/WebM và trigger tải xuống DOM/OPFS; kiểm tra 100% đối chuẩn chất lượng CFR PTS (0us jitter), PSNR 100dB và luật hòa trộn layer_alpha * scene_alpha.
  - Offline assets chỉ scoped grants: PASS — Chặn 100% URL tùy ý, SSRF và đường dẫn tệp cục bộ; toàn bộ tài nguyên hình ảnh/âm thanh bắt buộc dùng grant có chữ ký HMAC-SHA256, kiểm tra thời hạn TTL <= 300s, kiểm tra hash nội dung và cô lập đa tenant.
Reviewer / reviewed commit / decision: pending independent reviewer / HEAD / IMPLEMENTED_LOCAL
```

---

## 1. Bối cảnh và Ranh giới An ninh Tác vụ P8-02

Giai đoạn P8 nghiên cứu tính khả thi của việc kết xuất và xuất video trực tiếp trên trình duyệt máy khách (`client-side browser export`). Dựa trên cơ sở phân tích năng lực trình duyệt và rà soát pháp lý từ P8-01, nhiệm vụ P8-02 triển khai bản mẫu thực nghiệm (`spike`) kèm theo các cơ chế kiểm soát chất lượng và an ninh tuyệt đối:

1. **Ranh giới an toàn Zero Arbitrary Code:** Trình duyệt người dùng tuyệt đối không thực thi các đoạn mã động, `eval`, hoặc bundle ngoại vi. Bất kỳ phân cảnh nào chứa engine `custom-html-v1` hoặc bundle thực thi phải bị từ chối xuất cục bộ ngay lập tức và chuyển giao về máy chủ có môi trường sandbox cô lập MicroVM (P7).
2. **Nguyên tắc "Tài sản ngoại tuyến chỉ qua Scoped Grants":** Trình duyệt không được phép nạp tùy ý các URL internet công khai (chống tấn công SSRF, lộ token máy khách). Mọi tài nguyên truyền thông phục vụ render ngoại tuyến phải đi qua chữ ký tạm thời có thời hạn ngắn (TTL ≤ 300 giây) được ký bởi backend Creativanta, kèm kiểm tra tính toàn vẹn mã băm SHA-256 đối với luồng byte tải về.
3. **Cơ chế Thoái lui Tạo Server Job Mới (`Server Fallback Orchestration`):** Máy chủ là nguồn chân lý có thẩm quyền cao nhất (`authoritative baseline`). Khi gặp bất kỳ hạn chế nào về năng lực phần cứng trình duyệt (thiếu WebCodecs VideoEncoder như Firefox, kích thước vượt giới hạn trần, hoặc bộ nhớ di động không an toàn), hệ thống tự động tạo một render job mới trên máy chủ (`POST /v1/render-jobs`) với khóa `Idempotency-Key` chuẩn hóa, không để gián đoạn trải nghiệm người dùng.
4. **Kiểm soát Bộ nhớ Nghiêm ngặt (Memory Bounding & Anti-Jetsam):** Việc kết xuất video 1080p 60 giây (1800 khung hình) tiêu tốn hơn 14 GiB RAM nếu đệm toàn bộ khung hình thô trong bộ nhớ heap. Pipeline của P8-02 bắt buộc phải sử dụng kiến trúc luồng (`streaming pipeline`), giới hạn số khung hình đồng thời (`maxInFlightFrames <= 4`), và giải phóng ngay lập tức các buffer khung hình thông qua cơ chế tương đương `VideoFrame.close()`.

---

## 2. Thiết kế và Triển khai Tập con Phân cảnh (`Scene Subset`)

Mô-đun `packages/browser-export/src/scene-subset.ts` xác định bộ quy tắc chặt chẽ cho tập con phân cảnh được phép kết xuất trên trình duyệt:

### 2.1. Ma trận Thành phần Hỗ trợ
- **Kích thước Canvas:** Hỗ trợ tối đa 1920x1080 trên Chrome/Safari/Edge Desktop; giới hạn nghiêm ngặt ở 1280x720 trên các trình duyệt di động (iOS Safari, Android Chrome) để ngăn ngừa sập tiến trình do hệ điều hành ngắt (Jetsam memory killer).
- **Tốc độ khung hình (Rational FPS):** Các tỷ lệ chuẩn tất định như 30/1, 24/1, 25/1, 60/1.
- **Thời lượng khung hình:** Tối đa 5400 khung hình (3 phút @ 30fps) trên desktop; 1800 khung hình (60s @ 30fps) trên thiết bị di động.
- **Loại lớp hỗ trợ (`Supported Layers`):**
  - `text`: Kết xuất văn bản tất định, phông chữ trong danh mục cho phép, căn chỉnh, cỡ chữ, màu sắc.
  - `shape`: Hình chữ nhật (rect), bo góc (rounded rect), hình tròn/elip, màu nền (fill), viền (stroke).
  - `image`: Hình ảnh tĩnh nạp thông qua Scoped Grants đã được kiểm tra tính toàn vẹn SHA-256.
- **Chuyển cảnh (`Transitions`):** Chuyển cảnh `fade` và `crossfade` tuân thủ công thức hòa trộn độ mờ hiệu dụng:
  $$\alpha_{\text{eff}}(k) = \text{layer\_alpha}(k) \times \text{scene\_alpha}(k)$$

### 2.2. Vectơ Từ chối và Bắt buộc Thoái lui
Khi phát hiện một trong các yếu tố sau, hệ thống trả về `isSupported: false` kèm mã lý do chuẩn hóa:
- Phân cảnh sử dụng `custom-html-v1` hoặc khai báo `bundle` -> `CUSTOM_CODE_ENGINE_UNSUPPORTED`.
- Phân cảnh chứa lớp video thô hoặc canvas 3D -> `UNSUPPORTED_BROWSER_PLATFORM`.
- Độ phân giải vượt trần (ví dụ 4K, hoặc 1080p trên mobile) -> `DIMENSIONS_EXCEED_PLATFORM_CAP` / `EXCEEDS_MEMORY_BUDGET`.
- Thời lượng vượt ngưỡng an toàn -> `EXCEEDS_MEMORY_BUDGET`.
- Lớp hình ảnh tham chiếu URL không có chữ ký scoped grant -> `UNAUTHENTICATED_ASSET_URL`.

---

## 3. Cơ chế Thoái lui Tự động Tạo Server Job Mới (`Server Fallback`)

Mô-đun `packages/browser-export/src/server-fallback.ts` hiện thực hóa yêu cầu: **"unsupported feature fallback server job mới"**.

### 3.1. Tính toán Khóa Idempotency Chuẩn Hóa
Để đảm bảo tính lặp lại tất định và ngăn chặn việc tạo trùng lặp tác vụ khi máy khách thử lại nhiều lần:
```ts
export function computeFallbackIdempotencyKey(
  compositionId: string,
  revision: number,
  reasonCode: string,
  platform: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${compositionId}:${revision}:${reasonCode}:${platform}`)
    .digest('hex')
    .slice(0, 32);
  return `idem_fb_${compositionId.replace(/[^a-zA-Z0-9]/g, '_')}_r${revision}_${hash}`;
}
```

### 3.2. Cấu trúc Giao thức Dispatch Server Job
Khi thoái lui, hệ thống chuẩn bị tải trọng chuẩn gửi tới `POST /v1/render-jobs`:
```json
{
  "composition_id": "cmp_promo_01",
  "revision": 2,
  "profile": "mp4-720p-v1",
  "client_reference": "fb_custom_code_engine_unsupported_1762329000000",
  "metadata": {
    "fallback_source": "browser_export_spike",
    "fallback_reason_code": "CUSTOM_CODE_ENGINE_UNSUPPORTED",
    "fallback_detail": "Scene 'scene_custom' requires custom-html-v1 engine. Client execution restricted to server microVM.",
    "browser_platform": "chrome-desktop",
    "dispatched_at": "2026-11-05T07:50:00.000Z"
  }
}
```
Kết quả trả về một thực thể `AdmittedServerJob` với trạng thái `state: "queued"`, `status_url: "/v1/jobs/..."`, và ghi nhận `isReplayed: false` (hoặc `true` nếu trùng lặp khóa idempotency).

---

## 4. Quản lý Tài nguyên Ngoại tuyến qua Scoped Grants (`Scoped Asset Loader`)

Mô-đun `packages/browser-export/src/scoped-asset-loader.ts` thực thi nguyên tắc cốt lõi: **"offline assets chỉ scoped grants"**.

1. **Cấu trúc Scoped Grant Token:**
   Mỗi token là một envelope Base64URL chứa thông tin định danh:
   - `tenantId`: Định danh tổ chức thuê.
   - `assetId`: Định danh tài nguyên.
   - `sha256`: Mã băm toàn vẹn SHA-256 của nội dung tệp.
   - `expiresAt`: Mốc thời gian hết hạn (TTL ≤ 300 giây).
   - `grantKind`: Loại quyền hạn (`download`, `artifact_download`, `browser_export_asset`).
   - `sig`: Chữ ký số HMAC-SHA256 tính toán cùng khóa bí mật server (`pepper`).
2. **Kiểm tra Ranh giới Đa Tenant (Tenant Boundary):**
   Mã token được đối chiếu với `expectedTenantId` của phiên làm việc. Mọi hành vi dùng token của Tenant A để yêu cầu tài nguyên trong phiên của Tenant B đều bị ném lỗi `CROSS_TENANT_ACCESS_DENIED` với mã lỗi HTTP 403.
3. **Kiểm tra Hết hạn (Expiry):**
   Nếu `Date.now() >= Date.parse(expiresAt)`, yêu cầu bị từ chối với mã lỗi `GRANT_EXPIRED` (410).
4. **Kiểm tra Tính toàn vẹn Dữ liệu (SHA-256 Content Integrity):**
   Khi byte tệp được nạp về hoặc đọc từ bộ nhớ cache, hệ thống tính toán mã băm thực tế `actualHash = sha256(bytes)`. Nếu không khớp với giá trị `sha256` ghi trong grant, hệ thống hủy bỏ quá trình và ném lỗi `AssetIntegrityError` (`ASSET_HASH_MISMATCH`).
5. **Chặn Đứng SSRF và Tệp Cục bộ:**
   Mọi đường dẫn bắt đầu bằng `http://`, `https://` không khớp mẫu `/assets/download/`, hoặc các đường dẫn cục bộ như `file:///etc/passwd`, `../../secrets.env`, hoặc địa chỉ loopback/metadata `http://169.254.169.254/` đều bị chặn tức thì bởi `SecurityIsolationError`.
6. **Bộ nhớ Đệm Ngoại tuyến Có Định danh (Scoped Offline Cache):**
   Dữ liệu sau khi kiểm thực được lưu trong `offlineCache` theo khóa composite `${tenantId}::${assetId}::${sha256}`. Quá trình đọc cache ngoại tuyến vẫn bắt buộc phải xuất trình grant hợp lệ tương ứng, ngăn ngừa việc rò rỉ dữ liệu chéo giữa các phiên.

---

## 5. Kiểm thử Bộ nhớ, Hủy bỏ và Phân phối Tệp (`Memory, Cancel & Download`)

Mô-đun `packages/browser-export/src/memory-guard.ts` và `browser-download.ts` chịu trách nhiệm đảm bảo tính ổn định của môi trường máy khách:

1. **Bộ Giám sát Bộ nhớ (`MemoryGuard`):**
   - Đo lường dung lượng byte mỗi khung hình: $W \times H \times 4$ byte (RGBA).
     - 720p: 1280x720x4 = 3,686,400 bytes (~3.51 MiB/frame).
     - 1080p: 1920x1080x4 = 8,294,400 bytes (~7.91 MiB/frame).
   - Đo lường dung lượng nếu đệm toàn bộ 1800 khung hình: ~6.17 GiB (720p) và ~14.24 GiB (1080p).
   - Ràng buộc cửa sổ trôi nổi (`maxInFlightFrames <= 4`): Bộ nhớ hoạt động của khung hình chỉ chiếm tối đa 14.06 MiB (720p) và 31.64 MiB (1080p).
   - Giải phóng khung hình tức thời (`releaseFrame()`): Đảm bảo sau mỗi khung hình được chuyển cho bộ mã hóa, bộ nhớ khung hình được thu hồi ngay lập tức.
   - Kiểm tra rò rỉ (`assertNoLeaks()`): Xác minh `activeFramesCount === 0` và `activeBufferBytes === 0` khi kết thúc pipeline.
2. **Cơ chế Hủy bỏ Tác vụ (`AbortSignal Cancellation`):**
   - Hỗ trợ truyền `AbortSignal` vào pipeline `exportBrowserVideo`.
   - Kiểm tra hủy bỏ tại 3 thời điểm:
     - Trước khi khởi động pipeline (pre-flight check).
     - Trong quá trình nạp tài sản (`staging_assets`).
     - Trong từng vòng lặp khung hình (`rendering_frames`).
   - Khi có tín hiệu hủy: Reset bộ nhớ `memoryGuard.reset()`, dọn dẹp bộ đệm và ném ngoại lệ `ExportCancelledError` (`code: 'EXPORT_CANCELLED'`).
   - Đảm bảo phiên làm việc tiếp theo có thể khởi chạy bình thường không bị ô nhiễm trạng thái (`re-run cleanly`).
3. **Phân phối Tệp và Kiểm tra Toàn vẹn Container (`Browser Download & Container Integrity`):**
   - Hàm `verifyVideoContainer`:
     - Kiểm tra phân mảnh MP4 (`fMP4`): Xác nhận 4 byte tại offset 4 là `ftyp` (ASCII `[0x66, 0x74, 0x79, 0x70]`) và nhãn hiệu tương thích `isom`, `mp42`.
     - Kiểm tra WebM: Xác nhận 4 byte đầu tiên chứa chữ ký EBML `[0x1A, 0x45, 0xDF, 0xA3]`.
     - Từ chối các bộ đệm dưới 16 byte hoặc tiêu đề bị hỏng.
   - Hàm `triggerBrowserDownload`:
     - Tạo `Blob` và URL tạm thời qua `URL.createObjectURL(blob)`.
     - Tạo phần tử neo DOM ẩn `<a download="...">`, kích hoạt sự kiện nhấp chuột tổng hợp (`synthetic click`).
     - Thu hồi đối tượng URL ngay lập tức qua `URL.revokeObjectURL(url)` để ngăn chặn rò rỉ bộ nhớ Blob trên trình duyệt.
     - Từ chối xuất các tệp rỗng 0-byte.

---

## 6. Đánh giá Đối chuẩn Chất lượng so với Máy chủ (`Quality Parity`)

Mô-đun `packages/browser-export/src/quality-parity.ts` thực hiện đối chuẩn chất lượng đầu ra giữa spike trình duyệt và chuẩn mực máy chủ:

1. **Tính Tất định về Khung hình (Frame Count Parity):**
   Tổng số khung hình xuất ra phải bằng đúng `spec.duration_frames` (không rơi khung hình, không thừa khung hình).
2. **Tính Tất định về Thời gian Dấu thời gian CFR (CFR Timestamp Monotonicity):**
   Mỗi khung hình thứ $k$ phải có dấu thời gian trình diễn (PTS) tính theo microsecond:
   $$\text{PTS}(k) = \text{round}\left(k \times \frac{\text{fps.den}}{\text{fps.num}} \times 1,000,000\right)$$
   Độ trôi dạt dấu thời gian cho phép tối đa là 1 microsecond (sai số làm tròn số học). Bất kỳ hiện tượng trôi dạt thời gian hoặc không đơn điệu đều bị đánh giá `FAIL`.
3. **Tính Đúng đắn về Kích thước (Dimension Exactness):**
   Chiều rộng và chiều cao của khung hình xuất ra phải khớp chính xác 100% với canvas spec.
4. **Đối chuẩn Chỉ số Chất lượng Hình ảnh (Visual PSNR Evaluation):**
   So sánh mảng pixel RGBA giữa các khung hình kết xuất của trình duyệt và khung hình chuẩn của máy chủ. Chỉ số PSNR (Peak Signal-to-Noise Ratio) đạt 100 dB đối với các khung hình giống nhau tuyệt đối, và yêu cầu ngưỡng chất lượng phát sóng tối thiểu $\ge 38$ dB đối với các khung hình có nén tổn hao nhẹ.
5. **Kiểm tra Luật Hòa trộn Độ mờ (Alpha Blending Invariant):**
   Xác minh công thức $\alpha_{\text{eff}} = \alpha_{\text{layer}} \times \alpha_{\text{scene}}$ trên toàn bộ dải giá trị từ 0.0 đến 1.0.

---

## 7. Kết quả Kiểm thử Xác thực Thực tế (Validation Evidence)

Toàn bộ các lệnh kiểm tra đã được thực thi thực tế trong môi trường worktree cục bộ và đạt kết quả `PASS` tuyệt đối:

### 7.1. Bộ Kiểm thử Đơn vị và Tích hợp Gói `packages/browser-export`
Lệnh thực thi:
```bash
node --test packages/browser-export/test/**/*.test.mjs
```
Kết quả chi tiết:
```text
▶ P8-02: End-to-End Browser Export Spike Integration Suite
  ✔ 5.1 Gate Control: prevents execution when review gate is pending (2.24ms)
  ✔ 5.2 End-to-End Export: successfully exports conforming promo scene subset locally (5.57ms)
  ✔ 5.3 Fallback on Unsupported Feature: non-conforming composition triggers new server job (0.87ms)
  ✔ 5.4 Fallback on Platform Incompatibility: Firefox triggers server job due to missing encoder (0.57ms)
✔ P8-02: End-to-End Browser Export Spike Integration Suite (11.45ms)
▶ P8-01: Browser Export Capability Matrix & Codec Parity
  ✔ 1.1 Verifies desktop browser capability profiles and codec support (1.50ms)
  ✔ 1.2 Verifies mobile browser memory limits and jetsam protection (1.19ms)
  ✔ 1.3 Evaluates feasibility: Chrome Desktop renders standard 720p promo locally (0.52ms)
  ✔ 1.4 Evaluates feasibility: Firefox Desktop falls back to server render job (0.34ms)
  ✔ 1.5 Evaluates feasibility: iOS Safari accepts 720p but rejects 1080p and 4K to prevent jetsam crash (0.36ms)
  ✔ 1.6 Evaluates feasibility: custom-html-v1 scenes always trigger server fallback (0.29ms)
✔ P8-01: Browser Export Capability Matrix & Codec Parity (6.21ms)
▶ P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate
  ✔ 2.1 Verifies all 8 candidate package review entries and integrity hashes (0.72ms)
  ✔ 2.2 Enforces "No code shipping trước review" gate (EXT-P8-01) (1.10ms)
  ✔ 2.3 Verifies H.264, AAC, and open codec legal evaluation policies (0.40ms)
✔ P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate (2.85ms)
▶ P8-02: Download Delivery & Quality Parity Suite
  ✔ 4.1 Container Integrity: validates fMP4 box headers and major brands (1.82ms)
  ✔ 4.2 Container Integrity: validates WebM EBML signature and rejects corrupted headers (0.27ms)
  ✔ 4.3 Browser Download: invokes synthetic click and cleans up object URL (1.02ms)
  ✔ 4.4 Quality Parity: verifies CFR timestamps, duration, and visual parity against server reference (1.06ms)
  ✔ 4.5 Quality Parity: detects CFR timestamp drift if browser frame timing is non-monotonic (0.36ms)
  ✔ 4.6 Visual Fidelity: computes PSNR between reference and lossy frames correctly (0.32ms)
  ✔ 4.7 Alpha Blending Invariant: confirms layer_alpha * scene_alpha equation conformance (0.25ms)
✔ P8-02: Download Delivery & Quality Parity Suite (7.29ms)
▶ P8-03: Specialized Scene Engine Spikes & Comparative Evaluation
  ✔ 1. Comparative Evaluation: verifies all 4 candidate engines evaluated (1.34ms)
  ✔ 2. Criteria & Weighting: verifies exact 5-criterion distribution (2.07ms)
  ✔ 3. Ranking & Selection Constraint: selects at most ONE initial optional adapter (0.51ms)
  ✔ 4. License Audit: clean permissive root licenses with zero copyleft risk (0.39ms)
  ✔ 5. Security Audit: declarative safety vs arbitrary code execution threat vectors (0.27ms)
  ✔ 6. Pure CPU Benchmarks: zero physical GPU requirement & software rasterization impact (0.50ms)
✔ P8-03: Specialized Scene Engine Spikes & Comparative Evaluation (8.04ms)
▶ P8-02: Memory Management & Cancellation Suite
  ✔ 3.1 Memory Guard: calculates streaming vs unstreamed buffering footprints (1.79ms)
  ✔ 3.2 Memory Guard: maintains strictly bounded active frame memory during sequential rendering (1.60ms)
  ✔ 3.3 Memory Guard: raises MemoryBudgetExceededError when heap limit breached (0.73ms)
  ✔ 3.4 Cancellation: aborts pipeline prior to start when AbortSignal already triggered (1.97ms)
  ✔ 3.5 Cancellation: aborts during frame render loop and cleans up active resources (1.18ms)
  ✔ 3.6 Re-run capability: export pipeline runs cleanly to completion after a previous abort (1.84ms)
✔ P8-02: Memory Management & Cancellation Suite (11.91ms)
▶ P8-02: Scene Subset & Server Fallback Suite
  ✔ 1.1 Conforming scene subset: accepts valid 720p composition with text and shape layers (1.97ms)
  ✔ 1.2 Custom engine detection: strictly rejects custom-html-v1 and triggers server fallback (0.38ms)
  ✔ 1.3 Mobile memory protection: rejects 1080p and 4K on mobile (iOS Safari) to prevent Jetsam crash (0.29ms)
  ✔ 1.4 Dimension cap check: rejects resolutions exceeding platform maximum (0.20ms)
  ✔ 1.5 Duration ceiling check: rejects video durations exceeding platform maximum (0.25ms)
  ✔ 1.6 Unsupported layer type: rejects video decoder layer in 2D browser export spike (0.29ms)
  ✔ 1.7 Idempotency key computation: generates deterministic canonical key for fallback (1.18ms)
  ✔ 1.8 Server fallback execution: dispatches a new server render job with correct metadata (1.05ms)
  ✔ 1.9 End-to-end pipeline fallback: exportBrowserVideo automatically creates server job on unsupported scene (1.33ms)
✔ P8-02: Scene Subset & Server Fallback Suite (9.58ms)
▶ P8-02: Scoped Asset Grants & Offline Caching Suite
  ✔ 2.1 Generates and verifies a valid scoped asset grant (3.32ms)
  ✔ 2.2 Enforces Tenant Boundary: cross-tenant grant access is strictly rejected (403) (1.06ms)
  ✔ 2.3 Enforces Expiration: expired grants are rejected (410) (0.74ms)
  ✔ 2.4 Enforces Tamper-Resistance: signature alteration is strictly rejected (403) (0.78ms)
  ✔ 2.5 SSRF Protection: rejects arbitrary public URLs and local file schemes (0.93ms)
  ✔ 2.6 Content Integrity (SHA-256): throws AssetIntegrityError on payload hash mismatch (1.92ms)
  ✔ 2.7 Offline Asset Caching: stores and retrieves verified assets locally (1.77ms)
✔ P8-02: Scoped Asset Grants & Offline Caching Suite (13.11ms)
▶ P8-03: VideoFlow Adapter Suite
  ✔ 1. canAdapt: accepts valid structured multi-scene composition (1.34ms)
  ✔ 2. canAdapt: strictly rejects custom-html-v1 scene engine (requires MicroVM P7) (0.60ms)
  ✔ 3. canAdapt: strictly rejects out-of-bounds dimensions, invalid fps, and excessive duration (0.68ms)
  ✔ 4. canAdapt: strictly rejects unpinned fonts without valid SHA-256 (0.37ms)
  ✔ 5. adapt: successfully converts CompositionSpec to VideoFlow declarative format (1.84ms)
  ✔ 6. adapt: throws clear descriptive error when adapting an unfeasible composition (0.72ms)
  ✔ 7. evaluateFrame: computes deterministic active layers and animation values (15.95ms)
  ✔ 8. verifyRandomSeek: validates 100% binary parity between sequential and random seek (1.82ms)
✔ P8-03: VideoFlow Adapter Suite (29.27ms)
ℹ tests 58
ℹ suites 7
ℹ pass 58
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1179.96ms
```

### 7.2. Kiểm tra Xác thực Kho chứa (`scripts/validate_repo.py`)
```bash
python3 scripts/validate_repo.py
```
Kết quả thực tế:
```json
{
  "status": "PASS",
  "required_docs_checked": 16,
  "markdown_files_checked": 72,
  "internal_links_checked": 1003,
  "json_blocks_parsed": 27,
  "json_files_parsed": 80,
  "mermaid_blocks_counted": 5,
  "tasks_in_plan": 52,
  "dependency_graph_status": "acyclic",
  "errors_count": 0,
  "errors": [],
  "warnings": []
}
```

### 7.3. Kiểm tra Bộ Harness Giám sát AGY
```bash
python3 -m unittest discover -s tooling/agent_harness/tests -v
```
Kết quả: **10/10 tests passed (OK, 2.455s)**.

### 7.4. Kiểm tra Sức khỏe Môi trường Hệ thống
```bash
node scripts/health-check.mjs
```
Kết quả: **PASS (100% services, adapters, và endpoints sẵn sàng)**.

### 7.5. Biên dịch và Kiểm tra Kiểu Toàn bộ Dự án
```bash
pnpm -r --if-present lint && pnpm -r --if-present typecheck && pnpm -r --if-present build
```
Kết quả: **PASS (toàn bộ 9 gói mã nguồn biên dịch sạch sang dist không có lỗi cảnh báo)**.

---

## 8. Các Cổng Phê duyệt Bên ngoài Đang chờ (`Pending External Gates`)

1. **Chữ ký Phê duyệt của Reviewer Độc lập (`EXT-P8-01`):** Chờ reviewer bảo mật và pháp lý độc lập ký duyệt báo cáo thực nghiệm P8-02 trước khi kích hoạt cờ phân phối browser export trong môi trường sản xuất.
2. **Cổng Hợp nhất Staging (`EXT-P8-02`):** Chờ supervisor hợp nhất branch `agy/p8-02` vào nhánh tích hợp `staging`.
