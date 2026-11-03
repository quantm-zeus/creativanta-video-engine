# Scene specification 1.0

Thiết kế canonical composition, không phụ thuộc engine upstream. [API](API.md) sở hữu HTTP/revisions; [Architecture](ARCHITECTURE.md) sở hữu snapshot/render lifecycle. Tài liệu này là nguồn chuẩn cho JSON Schema 2020-12 do `P1-02` tạo; chưa có validator/compiler hoạt động.

## Mô hình và quy tắc schema

Composition là JSON UTF-8, normalized Unicode NFC, không HTML hoặc JS tùy ý trong structured layers. Root bắt buộc `schema_version`, `canvas`, `fps`, `duration_frames`, `seed`, `locale`, `fonts`, `scenes`, `audio_tracks`, `subtitles`. Các object đóng (`additionalProperties:false`), trừ `metadata` map chuỗi bounded và `extensions` map được namespace. Default được materialize trước hash; canonical serialization sắp key, giữ thứ tự arrays, finite numbers; không NaN/Infinity. `schema_version="1.0"` được support explicit, version tương lai trả lỗi, không bỏ qua trường âm thầm.

| Field/type | Ràng buộc và ý nghĩa |
| --- | --- |
| canvas `{width,height,background}` | Integer pixels dương/chẵn; schema max 3840 mỗi chiều; admission theo profile chặt hơn. Background `#RRGGBB` hoặc `#RRGGBBAA`, export opaque mặc định đen |
| fps `{num,den}` | Integer >0, reduced rational; v1 capabilities 24/1,25/1,30/1; starter chỉ 30/1. 30000/1001 mở sau test, không float fps |
| duration_frames | Integer 1..10800 schema; admission theo duration/profile, không tính round seconds |
| seed | Integer uint32; PRNG version pinned, không dùng Math.random trực tiếp |
| locale / direction | BCP47 trong allowlist (`vi-VN`,`en-US` MVP); `direction` default ltr, RTL cần capability riêng |
| fonts | Array ≤16 `{id,asset_id,sha256,family,weight,style}`; id unique, weight integer 100..900, style normal/italic |
| scenes | Array 1..50, ordered, contiguous; scene ID unique và stable khi edit |
| audio_tracks | Array ≤16, explicit placement/trim/gain; không lấy audio ngầm từ video layer |
| subtitles | Array ≤8 tracks, locale/cues/style; cue times là frames |
| metadata | Optional map ≤32 keys, key ≤64/value ≤256 chars, không secrets; không ảnh hưởng render hash nếu chỉ metadata |
| extensions | Optional namespaced objects, chỉ key được capability registry biết; unknown extension reject khi ảnh hưởng render |

Root schema minh họa cấu trúc (fragment có chủ ý; `$defs` phải được tạo theo bảng chuẩn tắc bên dưới trong P1, không dùng snippet này như validator hoàn chỉnh):

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://schemas.example.invalid/cve/composition/1.0",
  "type":"object",
  "additionalProperties":false,
  "required":["schema_version","canvas","fps","duration_frames","seed","locale","fonts","scenes","audio_tracks","subtitles"],
  "properties":{
    "schema_version":{"const":"1.0"},
    "canvas":{"$ref":"#/$defs/canvas"},
    "fps":{"$ref":"#/$defs/rationalFps"},
    "duration_frames":{"type":"integer","minimum":1,"maximum":10800},
    "seed":{"type":"integer","minimum":0,"maximum":4294967295},
    "locale":{"type":"string","enum":["vi-VN","en-US"]},
    "direction":{"enum":["ltr","rtl"],"default":"ltr"},
    "fonts":{"type":"array","maxItems":16,"items":{"$ref":"#/$defs/font"}},
    "scenes":{"type":"array","minItems":1,"maxItems":50,"items":{"$ref":"#/$defs/scene"}},
    "audio_tracks":{"type":"array","maxItems":16,"items":{"$ref":"#/$defs/audioTrack"}},
    "subtitles":{"type":"array","maxItems":8,"items":{"$ref":"#/$defs/subtitleTrack"}},
    "metadata":{"$ref":"#/$defs/metadata"},
    "extensions":{"$ref":"#/$defs/extensions"}
  }
}
```

Validation có ba tầng: JSON Schema cho shape/bounds (trả HTTP `422 VALIDATION_FAILED`) → semantic validator cho timeline/references/conflicts (trả HTTP `422 VALIDATION_FAILED`) → policy/capability validator cho tenant/quota/engine/profile/license status (trả HTTP `422 UNSUPPORTED_CAPABILITY` kèm detail code `PROFILE_CONSTRAINT_VIOLATED` hoặc `CAPABILITY_DISABLED`). Schema không tự làm được cross-field sums, asset existence hoặc byte budgets. Error trả JSON Pointer chính xác, stable code, không tự sửa payload không báo. Xem chi tiết quyết định tại [P0-04 report](../evidence/P0-04/report.md).

## Scene và layer

Scene fields bắt buộc: `id` (pattern `[a-z][a-z0-9_-]{0,63}`), `revision` (integer ≥1), `start_frame` (integer ≥0), `duration_frames` (>0), `engine`, `layers`. Optional `background` mặc định canvas background và `transition_out` default `{type:"cut",duration_frames:0}`. Engine enum có version: `html-v1`, `canvas-v1`, `svg-v1`, `custom-html-v1`; acceptance chỉ với capability enabled. `layers` ≤100/scene và tổng ≤500; id unique trong scene.

Custom scene thay `layers` bằng `bundle: {id,revision,source_sha256,build_sha256,entrypoint,parameters}`; JSON Schema oneOf không cho cả hai. Parameter schema được pin từ bundle, không arbitrary runtime code string trong composition. `entrypoint` relative path từ registry, không URL/path traversal. Mọi custom source được version và tải về chỉnh sửa theo quyền tenant; compiled bundle không thay thế source.

Layer bắt buộc `id`, `type`, `start_frame`, `duration_frames`, `z_index`, `box`, `content`; optional `opacity` default 1, `transform` default identity, `animations` default `[]`. Layer times local theo scene. `box` bắt buộc `{x,y,width,height}`, finite numbers trong [-100000,100000] cho x/y, width/height >0 ≤100000, units design pixels. Clip vào canvas/scene bounds, không layout theo viewport thật. `z_index` integer -1000..1000, cùng z thì array order (phần tử sau nằm trên). `opacity` 0..1. Transform `{translate_x,translate_y,scale_x,scale_y,rotate_deg,origin_x,origin_y}` numeric, default 0/0/1/1/0/0.5/0.5; origin normalized [0,1], scale [0.01,100]. Không tùy ý CSS selectors/properties.

`content` là discriminated union, chỉ các fields dưới đây:

| type | Content bắt buộc | Optional/default và giới hạn |
| --- | --- | --- |
| text | `text`, `font_id`, `font_size`, `color` | ≤10000 chars; font_size 1..512 px; `align` left/center/right default left; `line_height` multiplier default 1.2; `max_lines` 1..20 default 5; `overflow` error/shrink/ellipsis default error; `min_font_size` default font_size; `weight` phải đúng font đã pin |
| image | `asset_id`, `fit` | fit contain/cover/stretch; `anchor_x/y` [0,1] default .5; optional `alt` metadata; asset ready image |
| video | `asset_id`, `fit`, `source_in_frame` | source_in_frame ≥0 ở normalized source fps bằng composition; `playback_rate` v1 const 1; `loop` default false; `anchor_x/y` .5; audio luôn muted |
| shape | `shape`, `fill` | shape rect/ellipse; `stroke` default transparent, `stroke_width` ≥0 ≤100 default 0; `radius` ≥0 default 0 chỉ rect |
| svg | `asset_id`, `fit` | SVG sanitize trước ready (≤5 MiB, ≤5000 DOM nodes, depth ≤16); cấm `<!DOCTYPE>`/`<!ENTITY>`, `<script>`, `<foreignObject>`, `on*`, external `href`/`url()` và filter vượt budget |

Asset IDs opaque server-issued; ready record chứa version/hash. Client không được gửi filesystem path, arbitrary URI, inline base64 media, CSS `url()`. Fonts bind bằng font_id từ fonts array; font fallback Internet bị cấm. Rich text, arbitrary shader, filters, 3D và video speed change là extension sau MVP, không tự thêm khi agent thiếu feature.

## Timing, animation và transition

Một composition N frames ở p/q fps có duration chính xác `N*q/p` giây. Frame index k trong `[0,N)` lấy sample tại `t=k*q/p`, không sample ở end time. Mọi interval half-open `[start_frame,start_frame+duration_frames)`. Scene đầu start=0; scene tiếp theo start bằng end scene trước; scene cuối end=N. Không gaps/overlap ở scene timeline v1; overlay làm bằng layers. Layer có thể bắt đầu sau scene start nhưng phải kết thúc trong scene; audio/cues nằm trong composition.

Animation item: `{property,keyframes,easing}`. Property enum `opacity`, `translate_x`, `translate_y`, `scale_x`, `scale_y`, `rotate_deg`; keyframes array 2..64 `{frame,value}` với frame integer local layer, tăng nghiêm ngặt trong [0,layer.duration_frames-1]. Giá trị theo bounds property, opacity [0,1]. Easing `linear`, `ease_in_quad`, `ease_out_quad`, `ease_in_out_quad`; easing áp dụng mỗi segment. Trước key đầu/sau key cuối giữ giá trị đầu/cuối. Một property chỉ một animation/layer. Không string expression/eval; compiler tính giá trị rồi đặt WAAPI currentTime hoặc style; không phụ thuộc raf thực.

Transition v1 `cut` hoặc `fade_to_background` (schema `oneOf`): khi `type="cut"` bắt buộc `duration_frames=0`; khi `type="fade_to_background"` bắt buộc số nguyên `2 <= F <= min(300, scene.duration_frames)` (nếu `F > scene.duration_frames` thì semantic validator trả `TIMELINE_BOUNDS` tại `/scenes/{i}/transition_out/duration_frames`). Fade `F` frames chiếm **F frames cuối scene đi**, áp dụng hợp lệ trên mọi scene kể cả scene cuối cùng; opacity cấp scene `scene_alpha(k) = (end-1-k)/(F-1)` tại global frames `k` thuộc `[end-F, end-1]` xuống màu `canvas.background`. Cảnh kế tiếp bắt đầu nguyên opacity tại `end`. Fade không làm đổi tổng frames; `crossfade` cần future schema extension xác định overlap rõ ràng, không giả hỗ trợ sẵn. Opacity hiệu dụng của mỗi layer tại frame `k` bằng `layer_alpha(k) * scene_alpha(k)`.

Renderer phải freeze wall clock/locale/timezone/seed, disable animations không được compiler điều khiển, await `document.fonts.ready`, image decode, video seek/decode ready và adapter readiness promise. Browser media `currentTime` không tự chứng minh frame đúng: normalize CFR/source PTS, dùng decoded frame mapping test hoặc stage frames trước khi cần. Pinned software rasterization/fonts/DPR=1/sRGB. Không network sau staging, không Date.now cho motion. Seek ngẫu nhiên frame phải cho cùng pixel trong cùng runtime/profile; stateful canvas phải reset/recompute từ seed hoặc pure frame function. Video bitstream có thể khác giữa encoder/CPU version; invariant chính là frame content/timing và provenance.

## Media, audio, localization và subtitles

Ingest lưu original hash + normalized derivative hash, orientation, duration, timebase, color space; VFR normalize CFR với mapping đến source timestamps. Reject source ngắn hơn requested trim trừ `loop=true` explicit; loop modulo source usable frame count. Background video crop theo fit/anchor, không tự stretch; không lấy video từ mạng khi render.

Audio track bắt buộc `{id,asset_id,start_frame,duration_frames,source_in_samples,gain_db}`. Optional `role` voice/music/effect default effect, `fade_in_frames`/`fade_out_frames` default 0; gain [-60,12], source_in_samples ≥0 ở 48kHz normalized audio. Source dài đủ segment; không loop tự động. Mix stereo 48kHz floating point nội bộ, limiter master -1 dBTP target, loudness target -16 LUFS ±1 cho voiced fixture; preserve silence cho silent fixture. Ducking không tự bật; gain envelope explicit dưới `gain_keyframes` array `{frame,gain_db}` local track, tăng nghiêm ngặt. TTS asset được tạo trước render; không infer duration từ text. V1 crop/pad output theo exact timeline, reject voice bị cắt trừ client sửa spec.

Mapping frame boundary f sang audio sample dùng integer rational `round_half_up(f*q*48000/p)`; segment boundary lấy hiệu hai absolute positions để không cộng dồn rounding drift. Mux xử lý encoder priming/delay và đo decoded audio anchors, không chỉ container duration. Audio output duration sai lệch ≤1 frame theo Testing.

Subtitle track `{id,locale,burn_in,style,cues}`: `style` gồm font_id/font_size/color/background/align/max_lines/safe_margin_px theo text bounds, max_lines default 2, safe margin default 48 design px. Cues ≤500: `{id,start_frame,end_frame,text}` với 0≤start<end≤N, không overlap trong cùng track; text ≤1000 chars/cue. Burn-in tại frame interval; sidecars SRT/VTT chuyển rational time sang ms round_half_up chỉ một lần. Cue IDs stable; line-break theo grapheme cluster, không cắt dấu tổ hợp. Không karaoke word timings ở MVP trừ extension riêng. Source captions có thể import qua ingest parser rồi normalize sang cues, không execute ASS script/fonts ngoài registry.

Vietnamese NFC, font có `ă â đ ê ô ơ ư` và mọi tone marks; test cả input decomposed NFD (normalize phải giữ ngữ nghĩa), ₫/dấu ngoặc, mixed Latin. Locale version lưu trong manifest; format số/ngày trước compile hoặc pin formatter. `overflow=error` là mặc định để tránh mất lời; shrink chỉ khi client cho phép và không dưới min_font_size. Translation là authoring revision mới, không thay text ở render time.

## Composition ví dụ hợp lệ về cấu trúc

Ví dụ 150 frames = 5s ở 30fps, cần font asset ready hợp lệ; SHA dưới đây là placeholder 64 hex và phải thay hash bytes thật trước admission.

```json
{
  "schema_version":"1.0",
  "canvas":{"width":720,"height":1280,"background":"#101828"},
  "fps":{"num":30,"den":1},"duration_frames":150,"seed":42,"locale":"vi-VN",
  "fonts":[{"id":"brand_regular","asset_id":"ast_font","sha256":"0000000000000000000000000000000000000000000000000000000000000000","family":"Noto Sans","weight":400,"style":"normal"}],
  "scenes":[{
    "id":"intro","revision":1,"start_frame":0,"duration_frames":150,"engine":"html-v1",
    "layers":[{
      "id":"headline","type":"text","start_frame":0,"duration_frames":150,"z_index":1,
      "box":{"x":48,"y":400,"width":624,"height":240},
      "content":{"text":"Sáng tạo mỗi ngày","font_id":"brand_regular","font_size":54,"color":"#FFFFFF","align":"center","max_lines":3,"overflow":"error"},
      "animations":[{"property":"opacity","easing":"linear","keyframes":[{"frame":0,"value":0},{"frame":15,"value":1}]}]
    }],
    "transition_out":{"type":"cut","duration_frames":0}
  }],
  "audio_tracks":[],"subtitles":[]
}
```

| Mutation ví dụ | Validation error / stage |
| --- | --- |
| duration_frames=0 | `/duration_frames`, OUT_OF_RANGE, schema |
| Scene end=151, root=150 | `/scenes/0/duration_frames`, TIMELINE_BOUNDS, semantic |
| Hai scenes cùng id | `/scenes/1/id`, DUPLICATE_ID, semantic |
| fps=29.97 | `/fps`, TYPE_MISMATCH, schema |
| font_id không tồn tại | `/scenes/0/layers/0/content/font_id`, UNKNOWN_FONT, semantic |
| asset_id thuộc tenant khác | pointer tương ứng, ASSET_NOT_FOUND; không tiết lộ tenant |
| raw URL trong image content | UNKNOWN_FIELD hoặc INVALID_ASSET_REF |
| engine custom khi disabled | `/scenes/0/engine`, UNSUPPORTED_CAPABILITY |
| Text quá box/không glyph | TEXT_OVERFLOW/MISSING_GLYPH lúc preflight, không silently crop |
| Hai opacity animations | ANIMATION_CONFLICT |
| Source video trim quá dài | SOURCE_RANGE_INVALID |
| `fade_to_background` có `F > scene.duration_frames` | `/scenes/0/transition_out/duration_frames`, TIMELINE_BOUNDS, semantic |
| `duration_frames=3600` trên profile `mp4-720p-v1` (max 1800) | `/duration_frames`, PROFILE_CONSTRAINT_VIOLATED, policy/capability |

## Editable revisions, migrations, reproducibility

Template revision pin variables schema + defaults + scene spec; instantiate materialize một composition riêng. Scene giữ id khi sửa nội dung và tăng revision; server kiểm scene hash, tăng revision nếu changed, không tin revision client tự giữ thấp. Xóa/reorder ghi diff provenance; không mutate job snapshot. Reusable scene library có ID/revision và copy-on-instantiation MVP; linked dynamic scenes không resolve `latest` trong render.

Migration `1.0 → 1.1` là pure function với report, tạo composition revision mới, giữ original; không rewrite historical job. Có golden migrations, backward reader cho versions supported, explicit retirement window theo API. Breaking semantic/units tạo major version mới. Extensions không được lén thay behavior nền.

Render manifest phải có source/normalized spec hash, scene/template revisions, all input hashes/rights status, renderer/compiler/runtime versions, font digests, seed, locale/timezone, fps/duration, encoder args đã allowlist và output hashes. Hash identity phân biệt metadata-only change với render-affecting change; revisions vẫn tăng để audit. Cache chỉ exact render hash + tenant + profile; rights revocation làm invalidation. Không hứa re-render được sau asset deletion; return `INPUT_EXPIRED` và giữ audit manifest không private content.
