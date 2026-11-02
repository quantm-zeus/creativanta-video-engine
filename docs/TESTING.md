# Kiểm thử và acceptance gates

**Chưa chạy bất kỳ test ứng dụng/video/benchmark nào trong phiên design.** Tài liệu này mô tả bộ chứng cứ AGY phải tạo. Kiểm tra docs thực tế được ghi riêng trong [Execution log](EXECUTION_LOG.md). Requirements lấy từ [PRD](PRD.md), [Scene spec](SCENE-SPEC.md), [Security](SECURITY.md).

## Các mức gate

| Gate | Khi nào | Điều kiện và evidence |
| --- | --- | --- |
| G0 docs/contracts | P0/P1 | Required docs, links, OpenAPI/schema examples và task dependencies hợp lệ; schema fragment trong docs không giả là validator |
| G1 scaffold | P1 | Reproducible build, lint/typecheck, migrations, health, unit contract tests; **không được gọi là video engine working** |
| G2 useful video | P2 | Ba real MP4 fixtures dưới đây + manifest + ffprobe/decode + goldens + cost + human review |
| G3 tenant service | P3/P4 | Async API, isolation, idempotency, cancellation, webhook, usage và failure recovery tests |
| G4 private beta | P6 | Security suite, load/soak, restore drill, monitoring, dependency/license approval, Creativanta harness |
| G5 custom code | P7 | C1–C6 security evidence, isolated provider/build/render, malicious bundles; default off trước gate |
| G6 optional browser/scale | P8/P9 | Browser compatibility or scaling experiment riêng, không trì hoãn G2/G3 |

## Ba video POC bắt buộc

| Fixture/task | Spec cố định | Nội dung/chất lượng cần kiểm |
| --- | --- | --- |
| POC-01 / P2-02 | 15s, 450 frames, 720×1280, 30fps | Product promo 3 scenes, tự tạo hình/logo fixture hoặc licensed image; title/price/CTA editable; opacity/translate animation; silence được phép |
| POC-02 / P2-02 | 30s, 900 frames, 1280×720, 30fps | Explainer 4 scenes, SVG/chart/data labels, narration upload có quyền hoặc TTS đã review, captions Việt và fade_to_background |
| POC-03 / P2-03 | 45s, 1350 frames, 720×1280, 30fps | Licensed/self-recorded footage ≥2 clips, source trim/crop, music+voice gain envelope, Vietnamese captions; audio không lấy ngầm từ video |

Mỗi fixture có composition JSON, variables schema/template revision, exact licensed asset/font hashes, rights evidence, seeded manifest và expected frames/cues. Tạo revision thay headline/scene duration rồi render lại để chứng minh editable/versioned, không chỉ video hardcoded. POC-01 im lặng không miễn yêu cầu audio ở POC-02/03. Không substitute screenshot, HTML preview, placeholder MP4 hoặc upstream demo cho output của pipeline.

## Test pyramid theo rủi ro

- Unit: JSON/semantic/capability validation; rational time/sample conversion; scene boundary, transition interpolation, overflow/glyph preflight; canonical hashes/defaults; migrations; usage settlement; idempotency request normalization; HMAC raw-byte verification. Property tests frame intervals không gap/overlap và sample rounding không drift.
- Integration: real PostgreSQL RLS/constraints/leases/outbox, object store grants/expiry, worker sandbox + approved tiny media, real FFmpeg probe. Mock provider chỉ ở contract tests; real render gate không dùng mock renderer. Race tests concurrent same key, quota reservation, stale revision, cancel vs publish, double lease, ledger dedupe.
- E2E: tenant A upload→ready→instantiate→preview→render→callback→download→decode; tenant B không đọc được mọi ID/list/cursor/output; revoke asset, expired artifacts, worker crash và callback outage. Client harness theo API không truy DB.
- Security: malicious HTML/JS/SVG/fonts/media, URL encodings/redirect/rebinding, file traversal/symlink, infinite loop/memory/PID/disk bombs, secret canary exfiltration (synthetic secret), custom disable flag. Chỉ chạy payload trong isolated CI runner không secrets.
- Contract: OpenAPI examples được validate tự động; unsupported features fail trước queue; additive fields backward compatible; errors không raw stderr; previous v1 client vẫn chạy.

Không cần viết test cho từng câu tài liệu hay mirror implementation. Ưu tiên invariant có thể làm mất video/dữ liệu hoặc sai cost/tenant boundary.

## Visual golden frames

Golden set: frame 0, scene start/end-1, animation keyframes ±1, subtitle cue start/end-1, frame giữa, frame cuối; ≥20 frames mỗi fixture. Lưu PNG lossless từ capture và manifest. Cùng exact runtime/font/image profile: repeated capture phải pixel-identical cho structured static/text/shape fixtures; media decode có threshold riêng documented nếu decoder đổi. Không dùng MP4 byte equality vì metadata/encoder có thể khác.

Cross-runtime upgrade/candidate comparison: compare SSIM ≥0.99 và changed pixels ≤0.5% ở tolerance 8/255 cho baseline frames, cùng masked regions được review trước (không mask text để giấu lỗi). Text/caption boxes, missing glyph, clipping, blank/black frame ngoài expected bắt buộc manual review dù aggregate score đạt. Ngưỡng là starting gate cần hiệu chỉnh bằng evidence, không tự relax trong CI. Golden update PR ghi before/after, reason/runtime diff và reviewer; không auto-accept ảnh mới.

Vietnamese matrix: `Tiếng Việt: Trường học, cộng đồng, Đắk Lắk, Ưu đãi 199.000 ₫`; uppercase/lowercase, NFC/NFD, nhiều dấu, punctuation, số/ngày locale, multi-line và long CTA. Test grapheme wrapping, line-height, baseline, safe margins 48px, font fallback disabled, 9:16/16:9. Unsupported emoji phải error hoặc approved glyph asset; không để tofu silently pass.

## Video/audio verification

Probe codec/profile/pixel format/dimensions/fps/duration/sample rate/channel layout và decoded frame count. Decode **toàn bộ** file không errors, timestamps tăng đều, không duplicate/drop unintended, `moov` faststart cho MP4 profile. Kiểm chuyển cảnh và scene boundary không flash; thumbnail từ expected frame. Browser/player smoke trên hai playback engines trước beta.

Audio sync fixture có visual flash và clap/chirp anchors đầu/giữa/cuối, measure decoded peaks vs frame timestamps, lệch ≤1 frame (33.33ms tại 30fps), drift cuối clip ≤1 frame. Caption cue anchors so với known speech timing ≤1 frame cho input timing chuẩn; accuracy TTS alignment cần report riêng, không coi sync pass là transcript accuracy. Loudness voiced fixtures -16 LUFS ±1, true peak ≤-1dBTP, không clipping/pop ở trims/fades; silent fixture không đo LUFS. Duration decoded audio vs video ≤1 frame sau xử lý encoder delay. Manual reviewer xem/nghe cả ba POC, ghi language/typo/naturalness issues và decision.

Ví dụ lệnh verify **sau khi có file**, không phải kết quả đã chạy:

```bash
ffprobe -v error -count_frames -show_streams -show_format -of json output.mp4
ffmpeg -v error -i output.mp4 -f null -
```

## Benchmark protocol và cost

Reference runner: Linux x86_64, 4 vCPU/8GiB, không GPU; pin CPU model/kernel/container/runtime/font versions, affinity nếu có. Một job active, worker budget 2 vCPU/4GiB, hardware allocation report rõ để so công bằng. Dùng cùng 3 fixtures, output profile/codec/quality flags và asset cache state cho HyperFrames/baseline; adapter incapable phải báo unsupported, không đổi fixture ngầm.

Mỗi candidate/fixture: 1 warmup + ≥5 measured warm runs; cold start ≥3 runs riêng. Ghi median/p95 descriptive (sample nhỏ, không gọi SLO proof), min/max, CPU user+system toàn process tree, wall stage times, peak cgroup memory, temp disk peak, input/output bytes, encoder quality config, errors/retries. `RTF=render_wall_seconds/output_seconds`, render time bao gồm prepare/encode/verify nhưng không queue. POC target warm RTF ≤6, peak memory ≤4GiB, no OOM, compute allocation estimate ≤0.05 USD/output-minute. Hard timeout 600s/attempt còn được giữ dù performance fail.

Cost model chuẩn ở [Operations](OPERATIONS.md): đo CPU actual nhưng tính server allocation theo wall time × reserved vCPU hoặc full host/hour khi idle, không lấy CPU-seconds làm invoice. Báo 3 scenarios utilization 10/50/80%, storage retention 7d, egress 1 download và TTS cost tách riêng. Giá `0.04 USD/vCPU-hour` chỉ giả định minh họa, không quote cloud; report phải nêu currency/rate source/date hoặc assumption. So quality cùng setting, không giảm resolution để thắng benchmark.

P2 report có exact commit/OCI digest, commands, raw run JSONL, ffprobe, quality metrics, frame hashes, video checksum/location/expiry, reviewer và failed runs. Nếu không đạt target: sửa bottleneck rồi đo lại hoặc ADR amendment owner ký; không gọi pass chỉ vì có file MP4.

## Reliability/load và CI

API latency test: 20 authenticated clients, 10 req/s tổng trong 15min với 80% GET status/20% submit bounded by quota; record rejected quota riêng, không tính 429 như successful submit latency. Tenant jobs nhỏ seeded, không overload render slots chỉ để đo HTTP. Gate p95 <500ms, error 5xx <0.5%. Queue/SLO load cần arrival rate ≤70% measured sustainable capacity, policy workload 80% 15s promo/20% 45s footage; benchmark max throughput và overload 2× riêng để kiểm 429/fairness, không hứa queue time khi overload.

Soak beta: ≥24h, ≥1000 valid jobs trên pool sized từ benchmark; success ≥99% (customer cancel/invalid input tách riêng), không lost accepted job/duplicate artifact/billed units; memory/temp storage không tăng vô hạn. Inject kill ở prepare/render/encode/verify/publish boundary; DB restart/storage timeout/webhook outage/host reboot. Kiểm terminal event/outbox không mất, stale lease không publish, restore RPO/RTO theo Operations.

PR CI: docs/contracts/lint/typecheck/unit + tiny real render + tenant integration; dedicated video job có pinned runner, no external fetch. Nightly/release: 3 full POC, audio/visual, crash/security/load theo gate. Không đánh flaky retry thành pass: tối đa 1 diagnostic rerun, giữ cả kết quả, owner issue; security/tenant correctness failure chặn merge. Timeouts bounded, cleanup always, artifact retention đủ 30 ngày cho CI evidence, sanitize secrets. Không install runtime “latest” mỗi run; cache theo lockfile/image digest, invalidate khi deps đổi.

Tests không chạy phải ghi `NOT_RUN` cùng lý do; lệnh dự kiến tách khỏi output thực. CI status chỉ được ghi sau đọc run/result đúng commit. Review protocol ở [AGY execution](AGENTS.md).
