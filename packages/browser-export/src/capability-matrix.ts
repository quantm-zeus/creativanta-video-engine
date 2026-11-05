import type {
  BrowserPlatform,
  BrowserCapabilityProfile,
  FeasibilityEvaluation,
} from './types.js';

/**
 * Standard Capability Profiles for Core Target Browser Platforms.
 * Reflects empirical WebCodecs, memory ceilings, and platform constraints.
 */
export const BROWSER_CAPABILITY_PROFILES: Readonly<Record<BrowserPlatform, BrowserCapabilityProfile>> = {
  'chrome-desktop': {
    platform: 'chrome-desktop',
    family: 'desktop',
    engine: 'blink',
    hasWebCodecs: true,
    hasVideoEncoder: true,
    hasAudioEncoder: true,
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 4096,
    maxDimensions: { width: 1920, height: 1920 },
    maxDurationFrames: 5400, // 3 minutes @ 30fps
    supportedVideoCodecs: [
      'avc1.42E01E', // Baseline
      'avc1.4D401F', // Main 3.1
      'avc1.640028', // High 4.0
      'vp09.00.10.08', // VP9
      'av01.0.04M.08', // AV1
    ],
    supportedAudioCodecs: ['mp4a.40.2', 'opus'],
    supportedContainers: ['mp4', 'webm'],
    hardwareAcceleration: 'prefer-hardware',
    backgroundTabThrottling: false, // Solved via DedicatedWorker + OffscreenCanvas
    thermalThrottlingRisk: 'low',
    notes: 'Primary desktop candidate. Full WebCodecs hardware encoder support in Worker.',
  },
  'edge-desktop': {
    platform: 'edge-desktop',
    family: 'desktop',
    engine: 'blink',
    hasWebCodecs: true,
    hasVideoEncoder: true,
    hasAudioEncoder: true,
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 4096,
    maxDimensions: { width: 1920, height: 1920 },
    maxDurationFrames: 5400,
    supportedVideoCodecs: [
      'avc1.42E01E',
      'avc1.4D401F',
      'avc1.640028',
      'vp09.00.10.08',
      'av01.0.04M.08',
    ],
    supportedAudioCodecs: ['mp4a.40.2', 'opus'],
    supportedContainers: ['mp4', 'webm'],
    hardwareAcceleration: 'prefer-hardware',
    backgroundTabThrottling: false,
    thermalThrottlingRisk: 'low',
    notes: 'Blink engine parity with Chrome Desktop on Windows/macOS.',
  },
  'safari-desktop': {
    platform: 'safari-desktop',
    family: 'desktop',
    engine: 'webkit',
    hasWebCodecs: true,
    hasVideoEncoder: true,
    hasAudioEncoder: true,
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 4096,
    maxDimensions: { width: 1920, height: 1920 },
    maxDurationFrames: 3600, // 2 minutes @ 30fps
    supportedVideoCodecs: [
      'avc1.42E01E',
      'avc1.4D401F',
      'avc1.640028',
      'hvc1.1.6.L93.B0', // HEVC supported via VideoToolbox
    ],
    supportedAudioCodecs: ['mp4a.40.2', 'opus'],
    supportedContainers: ['mp4'],
    hardwareAcceleration: 'prefer-hardware',
    backgroundTabThrottling: false,
    thermalThrottlingRisk: 'low',
    notes: 'macOS Safari 16.4+ / 17+. H.264/HEVC and AAC via VideoToolbox. Missing VP9/AV1 encoders.',
  },
  'firefox-desktop': {
    platform: 'firefox-desktop',
    family: 'desktop',
    engine: 'gecko',
    hasWebCodecs: true,
    hasVideoEncoder: false, // VideoEncoder disabled or lacks H.264 encoder on most platforms
    hasAudioEncoder: false, // AudioEncoder incomplete across Gecko versions
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 2048,
    maxDimensions: { width: 1280, height: 1280 },
    maxDurationFrames: 1800,
    supportedVideoCodecs: [],
    supportedAudioCodecs: ['opus'],
    supportedContainers: ['webm'],
    hardwareAcceleration: 'unavailable',
    backgroundTabThrottling: true,
    thermalThrottlingRisk: 'medium',
    notes: 'Gecko lacks stable WebCodecs VideoEncoder/AudioEncoder implementation. Server fallback required.',
  },
  'ios-safari': {
    platform: 'ios-safari',
    family: 'mobile',
    engine: 'webkit',
    hasWebCodecs: true,
    hasVideoEncoder: true,
    hasAudioEncoder: true,
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 1024, // Strict WebKit jetsam memory ceiling
    maxDimensions: { width: 1280, height: 1280 }, // 720p maximum recommended for stability
    maxDurationFrames: 1800, // 60 seconds @ 30fps maximum on mobile
    supportedVideoCodecs: [
      'avc1.42E01E',
      'avc1.4D401F',
      'hvc1.1.6.L93.B0',
    ],
    supportedAudioCodecs: ['mp4a.40.2'],
    supportedContainers: ['mp4'],
    hardwareAcceleration: 'prefer-hardware',
    backgroundTabThrottling: true, // Aggressive iOS background tab freezing
    thermalThrottlingRisk: 'high',
    notes: 'iOS Safari 17+. Strict 1GB memory limit. Capped at 720p. 1080p/4K must fallback to server.',
  },
  'android-chrome': {
    platform: 'android-chrome',
    family: 'mobile',
    engine: 'blink',
    hasWebCodecs: true,
    hasVideoEncoder: true,
    hasAudioEncoder: true,
    hasVideoDecoder: true,
    hasAudioDecoder: true,
    hasOffscreenCanvas: true,
    hasDedicatedWorker: true,
    hasOpfs: true,
    memoryBudgetMib: 2048,
    maxDimensions: { width: 1280, height: 1280 },
    maxDurationFrames: 1800,
    supportedVideoCodecs: [
      'avc1.42E01E',
      'avc1.4D401F',
      'vp09.00.10.08',
    ],
    supportedAudioCodecs: ['mp4a.40.2', 'opus'],
    supportedContainers: ['mp4', 'webm'],
    hardwareAcceleration: 'prefer-hardware',
    backgroundTabThrottling: true,
    thermalThrottlingRisk: 'high',
    notes: 'Android MediaCodec hardware encoder. Limited concurrent codec instances (1-2 max).',
  },
  unknown: {
    platform: 'unknown',
    family: 'desktop',
    engine: 'unknown',
    hasWebCodecs: false,
    hasVideoEncoder: false,
    hasAudioEncoder: false,
    hasVideoDecoder: false,
    hasAudioDecoder: false,
    hasOffscreenCanvas: false,
    hasDedicatedWorker: false,
    hasOpfs: false,
    memoryBudgetMib: 512,
    maxDimensions: { width: 640, height: 640 },
    maxDurationFrames: 900,
    supportedVideoCodecs: [],
    supportedAudioCodecs: [],
    supportedContainers: [],
    hardwareAcceleration: 'unavailable',
    backgroundTabThrottling: true,
    thermalThrottlingRisk: 'high',
    notes: 'Unrecognized browser environment. Automatic fallback to authoritative server render.',
  },
};

/**
 * Minimal Scene Spec shape required for feasibility inspection.
 */
export interface MinimalSceneSpec {
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly background?: string;
  };
  readonly fps: {
    readonly num: number;
    readonly den: number;
  };
  readonly duration_frames: number;
  readonly scenes: readonly {
    readonly id: string;
    readonly engine?: string;
    readonly bundle?: unknown;
    readonly duration_frames: number;
  }[];
  readonly audio_tracks?: readonly unknown[];
}

/**
 * Evaluates whether a composition can be rendered locally in the client browser,
 * or whether it must fallback to creating a server-side render job (POST /render-jobs).
 */
export function evaluateExportFeasibility(
  platform: BrowserPlatform,
  spec: MinimalSceneSpec,
  requestedProfile: string = 'mp4-720p-v1',
): FeasibilityEvaluation {
  const profile = BROWSER_CAPABILITY_PROFILES[platform] ?? BROWSER_CAPABILITY_PROFILES.unknown;
  const diagnostics: string[] = [];

  // 1. Check Platform Basic WebCodecs Support
  if (!profile.hasWebCodecs || !profile.hasVideoEncoder) {
    diagnostics.push(
      `Platform ${platform} does not provide a functioning WebCodecs VideoEncoder.`,
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'MISSING_VIDEO_ENCODER',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: `Browser ${platform} lacks WebCodecs VideoEncoder; dispatching server render job.`,
      },
    };
  }

  // 2. Custom Code Security Boundary Check
  const hasCustomEngine = spec.scenes.some(
    (scene) => scene.engine === 'custom-html-v1' || Boolean(scene.bundle),
  );
  if (hasCustomEngine) {
    diagnostics.push(
      'Composition contains custom-html-v1 scenes. Arbitrary custom code execution is restricted to server microVM sandbox.',
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'CUSTOM_CODE_ENGINE_UNSUPPORTED',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: 'Custom code execution is disallowed in browser export; routing to isolated server worker pool.',
      },
    };
  }

  // 3. Audio Encoder Check
  const hasAudio = (spec.audio_tracks?.length ?? 0) > 0;
  if (hasAudio && !profile.hasAudioEncoder) {
    diagnostics.push(
      `Platform ${platform} has audio tracks but lacks WebCodecs AudioEncoder.`,
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'MISSING_AUDIO_ENCODER',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: `Browser ${platform} lacks AudioEncoder for composition with audio tracks.`,
      },
    };
  }

  // 4. Dimension & Resolution Limits
  const { width, height } = spec.canvas;
  if (width > profile.maxDimensions.width || height > profile.maxDimensions.height) {
    diagnostics.push(
      `Canvas dimensions (${width}x${height}) exceed platform ceiling (${profile.maxDimensions.width}x${profile.maxDimensions.height}) on ${platform}.`,
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'DIMENSIONS_EXCEED_PLATFORM_CAP',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: `Requested resolution (${width}x${height}) exceeds safe browser export memory budget; routing to server.`,
      },
    };
  }

  // 5. Mobile Memory Protection (e.g. iOS Safari Jetsam tab kill on 1080p/4K)
  if (profile.family === 'mobile' && (width > 1280 || height > 1280)) {
    diagnostics.push(
      `Mobile platform ${platform} exceeds 720p safe boundary. High risk of WebKit jetsam memory termination.`,
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'EXCEEDS_MEMORY_BUDGET',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: `Mobile browser memory budget (${profile.memoryBudgetMib} MiB) insufficient for high-resolution render.`,
      },
    };
  }

  // 6. Duration Frame Ceiling Check
  if (spec.duration_frames > profile.maxDurationFrames) {
    diagnostics.push(
      `Duration (${spec.duration_frames} frames) exceeds platform maximum (${profile.maxDurationFrames} frames).`,
    );
    return {
      feasible: false,
      recommendedAction: 'fallback_to_server_job',
      reasonCode: 'EXCEEDS_MEMORY_BUDGET',
      diagnostics,
      fallbackJob: {
        profile: requestedProfile,
        mode: 'render',
        reason: `Long video duration exceeds safe client browser memory limits; routing to server.`,
      },
    };
  }

  // 7. Profile Codec Match Check
  if (requestedProfile === 'mp4-720p-v1') {
    const hasH264 = profile.supportedVideoCodecs.some((c) => c.startsWith('avc1'));
    if (!hasH264) {
      diagnostics.push(
        `Profile mp4-720p-v1 requires H.264 (avc1), but platform ${platform} lacks H.264 encoder.`,
      );
      return {
        feasible: false,
        recommendedAction: 'fallback_to_server_job',
        reasonCode: 'UNSUPPORTED_VIDEO_CODEC',
        diagnostics,
        fallbackJob: {
          profile: requestedProfile,
          mode: 'render',
          reason: `Platform lacks H.264 hardware encoder for mp4-720p-v1 profile.`,
        },
      };
    }
  }

  diagnostics.push(`Platform ${platform} meets all capability requirements for local browser export.`);
  return {
    feasible: true,
    recommendedAction: 'export_locally',
    diagnostics,
  };
}
