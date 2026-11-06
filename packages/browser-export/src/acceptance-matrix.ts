/**
 * Browser & Specialized Engine Capability Documentation and Acceptance Matrix (Task P8-04).
 *
 * Implements the normative Acceptance Matrix and Strict Refusal Enforcement:
 * 1. Definitive classification of Browser Platforms, Specialized Engines, Codecs, Containers,
 *    Layer Types, Transitions, and Memory Limits.
 * 2. Explicit Adoption Verdicts:
 *    - ACCEPTED_BASELINE_SUPPORT
 *    - ACCEPTED_WITH_FALLBACK (authoritative server job fallback)
 *    - REFUSED_UNSUPPORTED (refuse unsupported instead of silently degrade)
 *    - CONCLUDED_NO_ADOPTION (concluded with empirical evidence, strictly prohibiting fake support)
 * 3. Enforces the core invariant: "refuse unsupported instead of silently degrade".
 *    No layer, audio track, font, transition, or resolution may be silently dropped,
 *    skipped, or downscaled without client knowledge or consent.
 */

import type {
  BrowserPlatform,
  FallbackReasonCode,
  AcceptanceMatrixEntry,
  AcceptancePolicyReport,
} from './types.js';
import { BROWSER_CAPABILITY_PROFILES, type MinimalSceneSpec } from './capability-matrix.js';
import { validateSceneSubset } from './scene-subset.js';

// =============================================================================
// Error Classes for Strict Refusal and No Fake Support
// =============================================================================

export class UnsupportedFeatureRefusalError extends Error {
  public readonly code = 'UNSUPPORTED_FEATURE_REFUSED';
  public readonly reasonCode: FallbackReasonCode;
  public readonly feature: string;
  public readonly evidenceReference: string;
  public readonly diagnostics: readonly string[];

  constructor(params: {
    feature: string;
    reasonCode: FallbackReasonCode;
    evidenceReference?: string;
    diagnostics?: readonly string[];
    message?: string;
  }) {
    const msg =
      params.message ??
      `Unsupported feature '${params.feature}' is refused (${params.reasonCode}). ` +
      `Policy strictly refuses unsupported features instead of silently degrading video/audio quality. ` +
      `(Evidence: ${params.evidenceReference ?? 'docs/IMPLEMENTATION_PLAN.md: P8-04'})`;
    super(msg);
    this.name = 'UnsupportedFeatureRefusalError';
    this.reasonCode = params.reasonCode;
    this.feature = params.feature;
    this.evidenceReference = params.evidenceReference ?? 'docs/IMPLEMENTATION_PLAN.md: P8-04';
    this.diagnostics = params.diagnostics ?? [msg];
  }
}

export class SilentDegradationPreventedError extends Error {
  public readonly code = 'SILENT_DEGRADATION_PREVENTED';
  public readonly violation: string;
  public readonly diagnostics: readonly string[];

  constructor(violation: string, diagnostics: readonly string[] = []) {
    const msg =
      `Silent degradation prevented: '${violation}'. ` +
      `Under Creativanta Video Engine specification, unsupported features must be explicitly refused ` +
      `or routed to server fallback, NEVER silently dropped, clipped, or degraded.`;
    super(msg);
    this.name = 'SilentDegradationPreventedError';
    this.violation = violation;
    this.diagnostics = diagnostics.length > 0 ? diagnostics : [msg];
  }
}

export class NoFakeSupportError extends Error {
  public readonly code = 'NO_FAKE_SUPPORT_VIOLATION';
  public readonly candidate: string;
  public readonly evidenceReference: string;
  public readonly rationale: string;

  constructor(candidate: string, evidenceReference: string, rationale: string) {
    const msg =
      `No fake support violation: Candidate '${candidate}' has been concluded as NO-ADOPTION ` +
      `based on empirical evidence. Fake support, mock emulation, or unvalidated claims are strictly forbidden. ` +
      `Evidence: ${evidenceReference}. Rationale: ${rationale}`;
    super(msg);
    this.name = 'NoFakeSupportError';
    this.candidate = candidate;
    this.evidenceReference = evidenceReference;
    this.rationale = rationale;
  }
}

// =============================================================================
// Comprehensive Acceptance Matrix Dataset
// =============================================================================

export const BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX: readonly AcceptanceMatrixEntry[] = [
  // ---------------------------------------------------------------------------
  // 1. Browser Platforms
  // ---------------------------------------------------------------------------
  {
    id: 'plat-chrome-desktop',
    name: 'Google Chrome Desktop',
    category: 'browser_platform',
    candidate: 'chrome-desktop',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Native WebCodecs VideoEncoder/AudioEncoder in DedicatedWorker with OffscreenCanvas. Full export parity.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Blink engine on desktop provides stable WebCodecs hardware acceleration for H.264/VP9/AV1 and AAC/Opus, 4096 MiB budget.',
    benchmarks: { peakRssMib: 215 },
  },
  {
    id: 'plat-edge-desktop',
    name: 'Microsoft Edge Desktop',
    category: 'browser_platform',
    candidate: 'edge-desktop',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Blink engine parity with Chrome Desktop. Hardware acceleration for H.264/VP9/AV1 and AAC/Opus.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Full architectural parity with Chrome Desktop on Windows/macOS. DedicatedWorker background tab throttling resistance.',
    benchmarks: { peakRssMib: 220 },
  },
  {
    id: 'plat-safari-desktop',
    name: 'Apple Safari Desktop (macOS)',
    category: 'browser_platform',
    candidate: 'safari-desktop',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Hardware acceleration via VideoToolbox for H.264 and HEVC. Missing VP9/AV1 encoders must fallback or refuse, never fake encode.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'WebKit on macOS 16.4+ / 17+ supports WebCodecs VideoEncoder/AudioEncoder via VideoToolbox. High H.264 quality parity.',
    benchmarks: { peakRssMib: 195 },
  },
  {
    id: 'plat-firefox-desktop',
    name: 'Mozilla Firefox Desktop',
    category: 'browser_platform',
    candidate: 'firefox-desktop',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'MISSING_VIDEO_ENCODER',
    noSilentDegradationPolicy:
      'Gecko lacks stable WebCodecs VideoEncoder. Refuses silent degradation (prohibits low-fps canvas capture stream hacks); automatically dispatches server render job.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Firefox desktop currently lacks full hardware WebCodecs VideoEncoder/AudioEncoder. Fallback to authoritative server worker is mandatory.',
  },
  {
    id: 'plat-ios-safari-720p',
    name: 'Apple iOS Safari (720p Promo Subset)',
    category: 'browser_platform',
    candidate: 'ios-safari-720p',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Bounded streaming pipeline (max 4 in-flight frames) stays well below 1024 MiB Jetsam memory kill threshold.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'WebKit on iOS 17+ supports WebCodecs VideoEncoder for 720p at 30fps under strictly bounded streaming memory guard.',
    benchmarks: { peakRssMib: 145 },
  },
  {
    id: 'plat-ios-safari-1080p',
    name: 'Apple iOS Safari (1080p / 4K High Resolution)',
    category: 'browser_platform',
    candidate: 'ios-safari-1080p',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'EXCEEDS_MEMORY_BUDGET',
    noSilentDegradationPolicy:
      'Refuses local 1080p rendering to prevent WebKit Jetsam process termination; routes to authoritative server worker pool.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'High-resolution frame rendering in mobile WebKit triggers iOS Jetsam memory killer. Safe boundary is capped at 720p.',
  },
  {
    id: 'plat-ios-safari-4k-local',
    name: 'Apple iOS Safari (4K Local Export)',
    category: 'browser_platform',
    candidate: 'ios-safari-4k-local',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Refuses 4K local export completely. No fake downscaling to 720p without client request.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      '4K 3840x2160 uncompressed RGBA frame is ~33 MiB per frame. Exceeds mobile Jetsam memory ceilings, making local 4K client export unfeasible.',
  },
  {
    id: 'plat-android-chrome-720p',
    name: 'Google Chrome on Android (720p Promo Subset)',
    category: 'browser_platform',
    candidate: 'android-chrome-720p',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'MediaCodec hardware encoder with single active instance clamp. Full CFR timing parity.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Blink on Android supports WebCodecs VideoEncoder backed by Android MediaCodec, within 2048 MiB memory budget.',
    benchmarks: { peakRssMib: 160 },
  },
  {
    id: 'plat-android-chrome-1080p',
    name: 'Google Chrome on Android (1080p / 4K)',
    category: 'browser_platform',
    candidate: 'android-chrome-1080p',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'EXCEEDS_MEMORY_BUDGET',
    noSilentDegradationPolicy:
      'Refuses local execution to prevent Android OOM killer and thermal throttling; dispatches new server render job.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Android thermal limits and MediaCodec instance limits make server rendering significantly more reliable for 1080p+.',
  },
  {
    id: 'plat-unknown-browser',
    name: 'Unrecognized Browser Environment',
    category: 'browser_platform',
    candidate: 'unknown-browser',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'UNSUPPORTED_BROWSER_PLATFORM',
    noSilentDegradationPolicy:
      'Unverified client environments are refused local execution; automatic fallback to authoritative server render.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Unrecognized user agents lack proven WebCodecs support and memory bounds; server rendering ensures correctness.',
  },

  // ---------------------------------------------------------------------------
  // 2. Specialized Scene Engines
  // ---------------------------------------------------------------------------
  {
    id: 'eng-videoflow',
    name: 'VideoFlow Declarative Engine',
    category: 'specialized_engine',
    candidate: 'videoflow',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Pure CPU declarative JSON composition adapter with 100% binary random seek parity and deterministic timing.',
    evidenceReference: 'evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md',
    rationale:
      'Selected as the single initial optional adapter via ADR-0003 (Score 94.5/100). Apache-2.0 license, RTF 1.23x-1.45x, 118 MiB RSS.',
    benchmarks: { rtf: 1.34, peakRssMib: 118, cpuPercent: 84.1 },
  },
  {
    id: 'eng-revideo',
    name: 'Revideo Generator DSL Engine',
    category: 'specialized_engine',
    candidate: 'revideo',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Refuses client browser execution. Requires MicroVM / gVisor isolation (Phase P7) due to dynamic code generation threats.',
    evidenceReference: 'evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md',
    rationale:
      'Score 70.5/100. Uses generator DSL (`yield* all(...)`) executing arbitrary TypeScript code, violating browser zero arbitrary code boundary. Requires MicroVM server worker pool isolation (P7).',
    benchmarks: { rtf: 2.38, peakRssMib: 245, cpuPercent: 95.0 },
  },
  {
    id: 'eng-motion-canvas',
    name: 'Motion Canvas Imperative Engine',
    category: 'specialized_engine',
    candidate: 'motion-canvas',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Refuses client browser execution. Requires MicroVM isolation and has excessive CPU overhead for video engine pipeline.',
    evidenceReference: 'evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md',
    rationale:
      'Score 62.0/100. Imperative TSX canvas code with 56 transitive vite plugins. High CPU overhead (RTF ~2.92x). Deferred to P7.',
    benchmarks: { rtf: 2.92, peakRssMib: 310, cpuPercent: 97.4 },
  },
  {
    id: 'eng-pixijs',
    name: 'PixiJS WebGL/WebGPU 2D Engine',
    category: 'specialized_engine',
    candidate: 'pixijs',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Banned from video engine pipeline. Fake support is strictly prohibited. Refuses execution with explicit empirical evidence.',
    evidenceReference: 'evidence/P8-03/ADR-0003-specialized-scene-engine-adapter.md',
    rationale:
      'Score 52.5/100 (Rejected). Catastrophic CPU penalty under software WebGL SwiftShader (RTF 4.65x-5.04x, CPU 99.5%, 542 MiB RAM). Zero support for audio mixing, subtitle cues, or MP4 container muxing.',
    benchmarks: { rtf: 4.65, peakRssMib: 542, cpuPercent: 99.5 },
  },

  // ---------------------------------------------------------------------------
  // 3. Video Codecs
  // ---------------------------------------------------------------------------
  {
    id: 'codec-h264-webcodecs',
    name: 'H.264 / AVC via Native WebCodecs',
    category: 'video_codec',
    candidate: 'avc1.42E01E / avc1.4D401F',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Encodes via OS hardware encoder without software transcoding drift. Verified CFR PTS monotonicity.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Native WebCodecs calls OS hardware encoder. Royalty-free for web applications under MPEG-LA patent terms held by platform vendors.',
  },
  {
    id: 'codec-h264-wasm',
    name: 'H.264 via Software WASM (x264 / openh264)',
    category: 'video_codec',
    candidate: 'x264-wasm',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Strictly prohibited. No bundling or distribution of software H.264 WASM binaries. Fake support prohibited.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Distributing software H.264 WASM incurs direct MPEG-LA patent royalty liabilities and GPL-2.0 copyleft license contamination into proprietary web application.',
  },
  {
    id: 'codec-hevc-webcodecs',
    name: 'HEVC / H.265 via Native WebCodecs',
    category: 'video_codec',
    candidate: 'hvc1.1.6.L93.B0',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Supported natively on Apple WebKit (macOS Safari & iOS Safari via VideoToolbox). Refuses or falls back on Blink/Gecko without silent transcoding.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Hardware-accelerated HEVC is available on Apple hardware; falls back to server for non-supporting platforms.',
  },
  {
    id: 'codec-vp9-webcodecs',
    name: 'VP9 via Native WebCodecs',
    category: 'video_codec',
    candidate: 'vp09.00.10.08',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Supported natively in Google Chrome and Microsoft Edge for WebM containers. Royalty-free open codec.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Blink provides robust software/hardware VP9 encoder in WebCodecs. Fallback to server on WebKit.',
  },
  {
    id: 'codec-av1-webcodecs',
    name: 'AV1 via Native WebCodecs',
    category: 'video_codec',
    candidate: 'av01.0.04M.08',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Supported in Blink Chrome/Edge desktop where hardware/libaom encoder is present. Royalty-free AOMedia format.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Next-generation open video codec with high compression efficiency, supported on modern Blink browsers.',
  },
  {
    id: 'codec-silent-audio-omission',
    name: 'Silent Audio Omission Antipattern',
    category: 'audio_codec',
    candidate: 'silent-audio-drop',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'SILENT_DEGRADATION_PROHIBITED',
    noSilentDegradationPolicy:
      'Strictly refused. Silently dropping audio tracks because browser lacks AudioEncoder produces corrupted output and is prohibited.',
    evidenceReference: 'docs/IMPLEMENTATION_PLAN.md: P8-04',
    rationale:
      'If composition defines audio tracks and browser cannot encode audio, system MUST route to server fallback or refuse, never omit audio silently.',
  },

  // ---------------------------------------------------------------------------
  // 4. Audio Codecs
  // ---------------------------------------------------------------------------
  {
    id: 'codec-aac-webcodecs',
    name: 'AAC-LC via Native WebCodecs',
    category: 'audio_codec',
    candidate: 'mp4a.40.2',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Native WebCodecs AudioEncoder 48kHz stereo encoding. Preserves loudness target and timing sync within 1 frame (33.3ms).',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Standard audio codec for MP4 containers, supported natively in Chrome, Edge, Safari, iOS, and Android.',
  },
  {
    id: 'codec-opus-webcodecs',
    name: 'Opus via Native WebCodecs',
    category: 'audio_codec',
    candidate: 'opus',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Low-latency high-fidelity RFC 6716 audio codec for WebM containers. Native WebCodecs AudioEncoder.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Royalty-free open audio format, primary codec for WebM on Blink and Gecko platforms.',
  },

  // ---------------------------------------------------------------------------
  // 5. Container Formats
  // ---------------------------------------------------------------------------
  {
    id: 'container-fmp4',
    name: 'Fragmented MP4 (fMP4 ISOBMFF)',
    category: 'container_format',
    candidate: 'mp4',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Validates ISO/IEC 14496-12 box headers (ftyp, moov, mdat) with zero box corruption.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Standard video container for web and mobile playback. Deterministic ISOBMFF box generation.',
  },
  {
    id: 'container-webm',
    name: 'WebM Container (EBML)',
    category: 'container_format',
    candidate: 'webm',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Validates EBML header [0x1A, 0x45, 0xDF, 0xA3] and docType webm.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Open web media format for VP9/AV1 and Opus audio streams.',
  },

  // ---------------------------------------------------------------------------
  // 6. Scene Subset & Layer Types
  // ---------------------------------------------------------------------------
  {
    id: 'layer-text',
    name: 'Text Layer (with Pinned Fonts)',
    category: 'scene_layer',
    candidate: 'text',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Requires pinned font SHA-256 in composition. Grapheme cluster wrapping, Vietnamese diacritics, safe margins.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Deterministic typography rendering in 2D canvas context without font drift.',
  },
  {
    id: 'layer-text-unpinned-font',
    name: 'Text Layer with Unpinned / Remote Font',
    category: 'scene_layer',
    candidate: 'text-unpinned',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'UNSUPPORTED_BROWSER_PLATFORM',
    noSilentDegradationPolicy:
      'Refused. Fallback to unpinned or Internet fonts is prohibited by security policy. Silent font substitution is forbidden.',
    evidenceReference: 'docs/SECURITY.md',
    rationale:
      'Fonts must have immutable SHA-256 digests in the composition manifest. Remote font fetches violate zero-egress boundary.',
  },
  {
    id: 'layer-shape',
    name: 'Shape Layer (Rect, Rounded Rect, Ellipse)',
    category: 'scene_layer',
    candidate: 'shape',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Deterministic vector paths, fill, stroke, and corner radius. 100% pixel parity.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Mathematical 2D shapes render identically across platforms with zero external assets.',
  },
  {
    id: 'layer-image-grant',
    name: 'Image Layer via Scoped HMAC Grant',
    category: 'scene_layer',
    candidate: 'image-grant',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Validates HMAC-SHA256 signature, TTL <= 300s, tenant isolation, and SHA-256 byte payload integrity.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Complies with the rule: "offline assets chỉ scoped grants". Prevents unauthorized cross-tenant media access.',
  },
  {
    id: 'layer-image-raw-url',
    name: 'Image Layer with Raw Unauthenticated URL',
    category: 'scene_layer',
    candidate: 'image-raw-url',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'UNAUTHENTICATED_ASSET_URL',
    noSilentDegradationPolicy:
      'Refused. Prohibits SSRF, client token exfiltration, and arbitrary network fetches. Must use scoped grant.',
    evidenceReference: 'docs/SECURITY.md',
    rationale:
      'Allowing client-side fetch of raw URLs bypasses tenant isolation and SSRF egress proxies.',
  },
  {
    id: 'layer-video',
    name: 'Video Decoder Layer (Nested Video Clips)',
    category: 'scene_layer',
    candidate: 'video',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'UNSUPPORTED_LAYER_TYPE',
    noSilentDegradationPolicy:
      'Refuses local decode/encode loop due to hardware codec instance contention. Dispatches authoritative server job.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Concurrent VideoDecoder + VideoEncoder instances on mobile/desktop browsers frequently fail or drop frames; server pipeline handles video clips reliably.',
  },
  {
    id: 'layer-custom-code',
    name: 'Custom Code / HTML Scene (custom-html-v1)',
    category: 'scene_layer',
    candidate: 'custom-html-v1',
    verdict: 'ACCEPTED_WITH_FALLBACK',
    defaultAction: 'fallback_to_server_job',
    refusalCode: 'CUSTOM_CODE_ENGINE_UNSUPPORTED',
    noSilentDegradationPolicy:
      'Client browser execution is strictly forbidden. Automatically dispatches server job targeting MicroVM sandbox pool (Phase P7).',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Arbitrary code execution requires disposable MicroVM with seccomp/cgroup and no-egress network namespace.',
  },
  {
    id: 'layer-silent-omission',
    name: 'Silent Layer Omission Antipattern',
    category: 'scene_layer',
    candidate: 'silent-layer-drop',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'SILENT_DEGRADATION_PROHIBITED',
    noSilentDegradationPolicy:
      'Strictly refused. Silently omitting an unsupported layer to force export completion is prohibited.',
    evidenceReference: 'docs/IMPLEMENTATION_PLAN.md: P8-04',
    rationale:
      'A video missing user-specified text, graphics, or branding is defective. Refusal or server fallback is mandatory.',
  },

  // ---------------------------------------------------------------------------
  // 7. Transitions
  // ---------------------------------------------------------------------------
  {
    id: 'trans-cut',
    name: 'Cut Transition (duration_frames = 0)',
    category: 'scene_transition',
    candidate: 'cut',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Exact boundary frame cut without temporal artifacts or frame bleeding.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Instantaneous transition between adjacent scenes, zero computational complexity.',
  },
  {
    id: 'trans-fade',
    name: 'Fade to Background Transition',
    category: 'scene_transition',
    candidate: 'fade_to_background',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Complies with exact mathematical alpha formula: layer_alpha(k) * scene_alpha(k).',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Linear opacity attenuation into canvas background over F frames.',
  },
  {
    id: 'trans-crossfade',
    name: 'Crossfade Transition',
    category: 'scene_transition',
    candidate: 'crossfade',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Deterministic two-scene opacity blend across transition window.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Standard 2D canvas cross-dissolve supported in the approved subset.',
  },
  {
    id: 'trans-unsupported-gl',
    name: 'Arbitrary WebGL / Shader Transitions',
    category: 'scene_transition',
    candidate: 'gl-shader-transition',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'UNSUPPORTED_TRANSITION',
    noSilentDegradationPolicy:
      'Refused. Prohibits silently falling back to a cut when shader transition is requested. Must refuse or route to server.',
    evidenceReference: 'docs/IMPLEMENTATION_PLAN.md: P8-04',
    rationale:
      'Silently turning a complex motion transition into a hard cut produces unintended visual output.',
  },

  // ---------------------------------------------------------------------------
  // 8. Memory & Resource Ceilings
  // ---------------------------------------------------------------------------
  {
    id: 'mem-streaming-guard',
    name: 'Streaming Bounded Pipeline (max 4 in-flight frames)',
    category: 'memory_and_resource',
    candidate: 'streaming-guard',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Active frame buffers are released immediately after encoding (VideoFrame.close() equivalent), maintaining <= 32 MiB heap footprint.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      'Prevents browser tab OOM crashes across thousands of frames.',
    benchmarks: { peakRssMib: 32 },
  },
  {
    id: 'mem-unbounded-heap',
    name: 'Unstreamed Full Heap Buffering',
    category: 'memory_and_resource',
    candidate: 'unstreamed-buffering',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Prohibited. Buffering all raw video frames in memory is strictly forbidden.',
    evidenceReference: 'evidence/P8-02/report.md',
    rationale:
      '1080p 60s video produces 1800 frames = ~14.4 GiB uncompressed heap data, causing instantaneous browser crash.',
  },
  {
    id: 'mem-silent-downscale',
    name: 'Silent Resolution Downscaling Antipattern',
    category: 'memory_and_resource',
    candidate: 'silent-downscale',
    verdict: 'REFUSED_UNSUPPORTED',
    defaultAction: 'refuse',
    refusalCode: 'SILENT_DEGRADATION_PROHIBITED',
    noSilentDegradationPolicy:
      'Strictly refused. Silently downscaling canvas resolution (e.g. 1080p -> 480p) to avoid memory limits is prohibited.',
    evidenceReference: 'docs/IMPLEMENTATION_PLAN.md: P8-04',
    rationale:
      'Exporting lower resolution than requested without client knowledge violates Scene Spec 1.0 contract.',
  },

  // ---------------------------------------------------------------------------
  // 9. Third-Party Packages & Upstream Artifacts
  // ---------------------------------------------------------------------------
  {
    id: 'pkg-mediabunny',
    name: 'Mediabunny Container Muxer (1.65.2)',
    category: 'third_party_package',
    candidate: 'mediabunny',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Zero runtime dependencies, clean MPL-2.0 compliance with notice obligation. Used strictly for demuxing/muxing.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Audited in P8-01. Provides deterministic fMP4 and WebM container muxing in browser.',
  },
  {
    id: 'pkg-webav-core',
    name: '@webav/av-cliper Core Utilities (1.2.8)',
    category: 'third_party_package',
    candidate: 'webav-cliper',
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    defaultAction: 'export_locally',
    noSilentDegradationPolicy:
      'Permitted for spike evaluation under MIT license with explicit copyright notice. No dynamic network scripts.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Minimalist audio/video clip utilities for browser export pipeline spike.',
  },
  {
    id: 'pkg-webav-pro',
    name: 'WebAV Pro Commercial Closed-Source Module',
    category: 'third_party_package',
    candidate: 'webav-pro',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Strictly prohibited. No proprietary closed-source code in Creativanta open engine repository.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Upstream commercial closed-source edition introduces vendor lock-in and unreviewable binaries.',
  },
  {
    id: 'pkg-sample-assets',
    name: 'Upstream Foreign Sample Assets (Big Buck Bunny, Tears of Steel)',
    category: 'third_party_package',
    candidate: 'sample-contamination',
    verdict: 'CONCLUDED_NO_ADOPTION',
    defaultAction: 'refuse',
    refusalCode: 'NO_ADOPTION_CONCLUDED',
    noSilentDegradationPolicy:
      'Strictly prohibited. All sample media must use verified Vietnamese typography, licensed audio, and 9:16 vertical standards.',
    evidenceReference: 'evidence/P8-01/report.md',
    rationale:
      'Anti-contamination policy P0-03 forbids unvetted foreign demo assets lacking Vietnamese diacritics.',
  },
];

// =============================================================================
// Query and Inspection Functions
// =============================================================================

export function getAcceptanceMatrix(): readonly AcceptanceMatrixEntry[] {
  return BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX;
}

export function getAcceptanceMatrixEntry(id: string): AcceptanceMatrixEntry | undefined {
  return BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX.find((entry) => entry.id === id);
}

export function queryAcceptanceMatrix(filter: Partial<AcceptanceMatrixEntry>): readonly AcceptanceMatrixEntry[] {
  return BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX.filter((entry) => {
    for (const [key, value] of Object.entries(filter)) {
      if (entry[key as keyof AcceptanceMatrixEntry] !== value) {
        return false;
      }
    }
    return true;
  });
}

// =============================================================================
// Validation & Enforcement: No Fake Support & No Silent Degradation
// =============================================================================

/**
 * Asserts that a candidate engine or feature is not marked CONCLUDED_NO_ADOPTION.
 * Throws NoFakeSupportError if an attempt is made to claim or run an engine
 * that has been empirically concluded as non-viable.
 */
export function validateNoFakeSupport(candidateName: string): void {
  const normalized = candidateName.trim().toLowerCase();
  const entry = BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX.find(
    (e) => e.candidate.toLowerCase() === normalized,
  );

  if (entry && entry.verdict === 'CONCLUDED_NO_ADOPTION') {
    throw new NoFakeSupportError(entry.name, entry.evidenceReference, entry.rationale);
  }
}

/**
 * Checks that the composition specification contains no features that would be
 * silently omitted or degraded during rendering.
 * Throws SilentDegradationPreventedError if silent degradation would occur.
 */
export function assertNoSilentDegradation(
  spec: MinimalSceneSpec,
  platform: BrowserPlatform = 'chrome-desktop',
): void {
  const profile = BROWSER_CAPABILITY_PROFILES[platform] ?? BROWSER_CAPABILITY_PROFILES.unknown;

  // 1. Audio track presence vs encoder availability
  const audioTracks = spec.audio_tracks ?? [];
  if (audioTracks.length > 0 && !profile.hasAudioEncoder) {
    throw new SilentDegradationPreventedError(
      `Composition specifies ${audioTracks.length} audio tracks, but platform '${platform}' lacks WebCodecs AudioEncoder. ` +
        `Silently dropping audio is prohibited.`,
      [`Platform ${platform} hasAudioEncoder=false`],
    );
  }

  // 2. Video encoder presence
  if (!profile.hasVideoEncoder) {
    throw new SilentDegradationPreventedError(
      `Platform '${platform}' lacks WebCodecs VideoEncoder. ` +
        `Silently dropping video or substituting low-fps canvas capture stream is prohibited.`,
      [`Platform ${platform} hasVideoEncoder=false`],
    );
  }

  // 3. Layer type support: no silent layer omission
  for (const scene of spec.scenes) {
    const rawScene = scene as { layers?: readonly { id?: string; type?: string }[] };
    for (const layer of rawScene.layers ?? []) {
      const t = layer.type ?? '';
      if (!['text', 'image', 'shape'].includes(t)) {
        throw new SilentDegradationPreventedError(
          `Layer '${layer.id ?? 'unnamed'}' specifies unsupported type '${t}'. ` +
            `Silently omitting this layer during export is prohibited.`,
          [`Unsupported layer type: ${t}`],
        );
      }
    }
  }

  // 4. Custom code engine: no silent stripping of custom bundles
  for (const scene of spec.scenes) {
    if (scene.engine === 'custom-html-v1' || Boolean(scene.bundle)) {
      throw new SilentDegradationPreventedError(
        `Scene '${scene.id}' specifies custom-html-v1 or bundle. ` +
          `Silently stripping custom code or rendering a blank background is prohibited.`,
        ['Custom code execution is disallowed in browser; MicroVM server isolation required.'],
      );
    }
  }
}

/**
 * Evaluates a composition against the normative Acceptance Matrix.
 * Returns a comprehensive policy report detailing eligibility, fallback requirements,
 * refusal status, and evidence citations.
 */
export function evaluateCompositionAcceptance(
  spec: MinimalSceneSpec,
  platform: BrowserPlatform = 'chrome-desktop',
  options: {
    requestedProfile?: string;
    allowServerFallback?: boolean;
  } = {},
): AcceptancePolicyReport {
  const profileName = options.requestedProfile ?? 'mp4-720p-v1';
  const allowFallback = options.allowServerFallback ?? true;
  const diagnostics: string[] = [];
  const unsupportedFeatures: string[] = [];
  const noAdoptionViolations: string[] = [];
  const checkedEntries: AcceptanceMatrixEntry[] = [];

  const platformProfile = BROWSER_CAPABILITY_PROFILES[platform] ?? BROWSER_CAPABILITY_PROFILES.unknown;

  if (profileName === 'mp4-720p-v1') {
    const hasH264 = platformProfile.supportedVideoCodecs.some((c) => c.startsWith('avc1'));
    if (!hasH264 && platformProfile.hasVideoEncoder) {
      diagnostics.push(`Profile ${profileName} requires H.264, but platform ${platform} lacks H.264 encoder.`);
      unsupportedFeatures.push('missing_h264_encoder');
    }
  }

  // 1. Platform Check
  const platformEntry = BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX.find(
    (e) => e.category === 'browser_platform' && e.candidate.startsWith(platform),
  );
  if (platformEntry) {
    checkedEntries.push(platformEntry);
    if (platformEntry.verdict === 'CONCLUDED_NO_ADOPTION') {
      noAdoptionViolations.push(platformEntry.name);
    }
  }

  // 2. WebCodecs Encoder Availability
  if (!platformProfile.hasVideoEncoder) {
    diagnostics.push(`Platform ${platform} lacks WebCodecs VideoEncoder.`);
    unsupportedFeatures.push('missing_video_encoder');
  }

  const hasAudio = (spec.audio_tracks?.length ?? 0) > 0;
  if (hasAudio && !platformProfile.hasAudioEncoder) {
    diagnostics.push(`Platform ${platform} lacks WebCodecs AudioEncoder for audio tracks.`);
    unsupportedFeatures.push('missing_audio_encoder');
  }

  // 3. Scene Subset & Engines
  const subset = validateSceneSubset(spec as any, platform);
  if (!subset.isSupported) {
    diagnostics.push(...subset.diagnostics);
    unsupportedFeatures.push(...subset.unsupportedFeatures);
  }

  // Check scene engines against No-Adoption list (PixiJS, Revideo, Motion Canvas)
  for (const scene of spec.scenes) {
    const engineName = scene.engine ?? 'default';
    try {
      validateNoFakeSupport(engineName);
    } catch (err) {
      if (err instanceof NoFakeSupportError) {
        noAdoptionViolations.push(err.candidate);
        diagnostics.push(err.message);
      }
    }
  }

  // 4. Determine Verdict
  if (noAdoptionViolations.length > 0) {
    return {
      eligibleForLocalExport: false,
      requiresServerFallback: false,
      strictlyRefused: true,
      verdict: 'CONCLUDED_NO_ADOPTION',
      reasonCode: 'NO_ADOPTION_CONCLUDED',
      diagnostics,
      unsupportedFeatures,
      noAdoptionViolations,
      checkedEntries,
      noSilentDegradationGuaranteed: true,
    };
  }

  if (unsupportedFeatures.length > 0) {
    if (allowFallback) {
      return {
        eligibleForLocalExport: false,
        requiresServerFallback: true,
        strictlyRefused: false,
        verdict: 'ACCEPTED_WITH_FALLBACK',
        reasonCode: subset.reasonCode ?? (unsupportedFeatures.includes('missing_video_encoder') ? 'MISSING_VIDEO_ENCODER' : 'UNSUPPORTED_BROWSER_PLATFORM'),
        diagnostics,
        unsupportedFeatures,
        noAdoptionViolations: [],
        checkedEntries,
        noSilentDegradationGuaranteed: true,
      };
    } else {
      return {
        eligibleForLocalExport: false,
        requiresServerFallback: false,
        strictlyRefused: true,
        verdict: 'REFUSED_UNSUPPORTED',
        reasonCode: subset.reasonCode ?? 'UNSUPPORTED_BROWSER_PLATFORM',
        diagnostics,
        unsupportedFeatures,
        noAdoptionViolations: [],
        checkedEntries,
        noSilentDegradationGuaranteed: true,
      };
    }
  }

  return {
    eligibleForLocalExport: true,
    requiresServerFallback: false,
    strictlyRefused: false,
    verdict: 'ACCEPTED_BASELINE_SUPPORT',
    diagnostics: [`Platform ${platform} fully conforms to acceptance baseline.`],
    unsupportedFeatures: [],
    noAdoptionViolations: [],
    checkedEntries,
    noSilentDegradationGuaranteed: true,
  };
}

/**
 * Helper to explicitly throw UnsupportedFeatureRefusalError.
 */
export function refuseUnsupportedFeature(
  feature: string,
  reasonCode: FallbackReasonCode = 'UNSUPPORTED_BROWSER_PLATFORM',
  diagnostics: string[] = [],
): never {
  throw new UnsupportedFeatureRefusalError({
    feature,
    reasonCode,
    diagnostics,
  });
}
