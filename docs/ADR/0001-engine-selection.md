# ADR 0001 — lựa chọn renderer code-first CPU

- Ngày: 2026-11-02.
- Trạng thái: **Proposed / conditional**. Chưa Accepted; chưa có benchmark hoặc source/security audit.
- Owner tương lai: renderer lead + security reviewer + supervisor, tasks `P0-02`, `P2-01`, `P2-04`.
- Liên quan: [evaluation](../OPEN_SOURCE_EVALUATION.md), [scene spec](../SCENE-SPEC.md), [testing](../TESTING.md), [plan](../IMPLEMENTATION_PLAN.md).

## Bối cảnh

Cần video CPU deterministic, HTML-friendly, dễ agent tạo/sửa, tương thích multi-tenant và không gọi API sinh video. Engine không được sở hữu hợp đồng API/scene hay buộc dịch vụ dùng premium coding model. Renderer có thể có arbitrary JS nên security boundary phải ở ngoài engine.

## Quyết định có điều kiện

Ưu tiên **HyperFrames local rendering core**, sau adapter nội bộ. Chuẩn bị baseline **Chromium frame capture + FFmpeg** độc lập, chỉ hỗ trợ structured HTML subset đầu tiên. Chưa pin package/version trong design; P0 review exact artifact rồi P2 benchmark. Dù HyperFrames thắng, scene spec/public API vẫn của dịch vụ và manifest pin runtime.

Không coi HTML-Video là fallback độc lập vì upstream mô tả đường render đang wired bằng HyperFrames. VideoFlow là challenger JSON/DOM; Revideo/Motion Canvas là challenger animation nếu core blockers có evidence. WebAV/Mediabunny phục vụ nhánh browser export tùy chọn, không thay server default; PixiJS là layer renderer, không cả pipeline. Nguồn xác minh chi tiết ở evaluation.

| Tiêu chí | HyperFrames | Chromium + FFmpeg | VideoFlow | Revideo/Motion Canvas |
| --- | --- | --- | --- | --- |
| HTML/agent authoring | Phù hợp theo README | Tự compiler/contract nhưng kiểm soát tốt | TS/JSON abstraction cần mapping | TS animation DSL cần mapping |
| Work phải viết | Adapter + policy, kiểm seek | Capture/readiness/media/timing nhiều hơn | Adapter/schema/capability mapping | Adapter, build/seek, media |
| Determinism | Upstream claim; cần đo | Kiểm soát nhưng dễ sai nếu seek đơn giản | Cần parity test từng renderer | Cần reset state/seek test |
| CPU/cost | Chưa đo | Baseline cần đo | WebGL effects có rủi ro | Chưa đo |
| Isolation | Không engine nào tự thay thế sandbox của platform | Tương tự | Tương tự | Tương tự |
| License | Root Apache; transitive chưa audit | Chromium/FFmpeg/codecs riêng | Root Apache + transitive | Root MIT + transitive |

Không chấm điểm số bịa khi chưa đo. P2 ghi điểm có evidence theo weights: correctness/quality 30%, CPU cost 25%, security/offline compatibility 20%, integration/maintainability 15%, authoring flexibility 10%. License và security là hard gate, không bù bằng điểm hiệu năng.

## Verification gates để Accepted

1. `E1 Legal/dependency`: exact source/package pin, SBOM, install script review, notices, assets/fonts/codecs/animation libs review; không dependency trái scope video-gen.
2. `E2 Offline/CPU`: không network sau staging; không GPU device; 3 POC trên 4 vCPU/8GiB reference runner, runtime/image digest và encoder flags ghi lại.
3. `E3 Correctness`: exact frame count; seek same-frame repeat; Việt đủ glyph/line wrapping; audio/caption anchors ≤1 frame; ffprobe + decode + human watch/listen.
4. `E4 Cost/reliability`: ≥5 measured runs/fixture sau 1 warmup, cold start riêng; RTF, CPU, RSS, output bytes/cost; 3 POC đạt targets Testing hoặc owner chấp thuận target mới bằng ADR amendment có evidence. Không âm thầm hạ chất lượng để đạt cost.
5. `E5 Engine security`: Chromium sandbox không bị tắt, isolation/limits, local attempt cancellation/kill/cleanup, malformed media và zero-egress tests. Đây là gate engine P2, chưa phải chứng nhận tenant service. DB lease fencing/cancel-vs-publication/SSRF ingest tests thuộc P4/P6 trước beta, không tạo dependency vòng ngược từ P2 sang P4. Custom code vẫn off đến P7.
6. `E6 Integration`: adapter contract tests, capability errors, preview/export parity, no vendor-specific JSON in public spec; fallback replay dưới adapter khác là **job mới**, không mutate attempt.

Evidence trong `evidence/P2-04/` sau implementation: `report.md`, `runs.jsonl`, manifest/checksums, golden frames, CI link, video artifact location/expiry và reviewer. Các path này là deliverable tương lai, chưa tồn tại trong docs-only repo.

## Fallback và timebox

P0 audit tối đa 1 ngày công mỗi primary candidate, P2 adapter spike tối đa 2 ngày công cho HyperFrames trước blocker review. Nếu core cần Internet, không thể giữ browser sandbox, vi phạm license policy, hoặc không seek/audio đúng, ghi reproducible blocker và chuyển baseline. Nếu cả hai không đạt, mở bounded VideoFlow/Revideo spike bằng task bổ sung, không tuyên bố P2 done. Timebox là trigger quyết định, không permission bỏ acceptance.

Chọn baseline không có nghĩa phải viết mọi primitive; vẫn reuse vetted Chromium automation/FFmpeg/image/audio tools. Nếu HyperFrames thắng, không duy trì hai production engines ngang tính năng ngay MVP; baseline giữ fixture/benchmark reference và adapter boundary. Mọi đổi default sau beta cần render canary/golden diff, immutable image rollout, rollback và ADR mới/updated.

## Hệ quả và chưa quyết

Tốn công canonical schema/compiler nhưng tránh lock-in và hỗ trợ chỉnh sửa versioned scenes. Không đảm bảo pixel giống giữa engine, chỉ cùng nghĩa timeline/profile và thresholds công bố. Runtime/font/codec changes có thể đổi pixels, phải version. Còn mở: pin cụ thể, software rasterization performance, FFmpeg build license, exact production VM/SLO, browser-export codec support. Mỗi mục có owner task; không cản viết structured POC sau audit.
