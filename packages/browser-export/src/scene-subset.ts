/**
 * Scene Subset Specification and Validation for Browser Export Spike (Task P8-02).
 *
 * Defines the approved deterministic scene subset that can be rendered safely
 * inside client browsers without native binary dependencies or arbitrary JS execution.
 * Any composition exceeding this subset automatically triggers server fallback.
 */

import type {
  BrowserPlatform,
  SceneSubsetValidation,
  SupportedSubsetLayerType,
} from './types.js';
import { BROWSER_CAPABILITY_PROFILES } from './capability-matrix.js';

export interface SceneSubsetLimits {
  readonly allowedLayerTypes: readonly SupportedSubsetLayerType[];
  readonly allowedEngines: readonly (string | undefined)[];
  readonly maxDurationFrames: number;
  readonly maxScenesCount: number;
  readonly maxLayersPerScene: number;
  readonly maxAudioTracks: number;
}

export const APPROVED_BROWSER_EXPORT_SUBSET: SceneSubsetLimits = {
  allowedLayerTypes: ['text', 'image', 'shape'],
  allowedEngines: [undefined, '', 'video-engine-v1', 'default'],
  maxDurationFrames: 5400, // 3 minutes @ 30fps
  maxScenesCount: 16,
  maxLayersPerScene: 32,
  maxAudioTracks: 4,
};

/**
 * Validates whether a composition conforms to the approved browser export scene subset.
 * Identifies any unsupported features (custom code, exceeding dimensions, unsupported layers)
 * to trigger automatic server fallback.
 */
export function validateSceneSubset(
  spec: {
    readonly canvas?: { readonly width: number; readonly height: number; readonly background?: string };
    readonly fps?: { readonly num: number; readonly den: number };
    readonly duration_frames?: number;
    readonly scenes?: readonly {
      readonly id?: string;
      readonly engine?: string;
      readonly bundle?: unknown;
      readonly duration_frames?: number;
      readonly layers?: readonly {
        readonly id?: string;
        readonly type?: string;
        readonly content?: Record<string, unknown>;
        readonly filters?: readonly unknown[];
      }[];
    }[];
    readonly audio_tracks?: readonly unknown[];
  },
  platform: BrowserPlatform = 'chrome-desktop',
): SceneSubsetValidation {
  const diagnostics: string[] = [];
  const unsupportedFeatures: string[] = [];
  const profile = BROWSER_CAPABILITY_PROFILES[platform] ?? BROWSER_CAPABILITY_PROFILES.unknown;

  // 1. Basic Canvas Bounds
  if (!spec.canvas || typeof spec.canvas.width !== 'number' || typeof spec.canvas.height !== 'number') {
    diagnostics.push('Missing or invalid canvas dimensions');
    return {
      isSupported: false,
      reasonCode: 'DIMENSIONS_EXCEED_PLATFORM_CAP',
      diagnostics,
      unsupportedFeatures: ['invalid_canvas'],
    };
  }

  const { width, height } = spec.canvas;
  if (width <= 0 || height <= 0) {
    diagnostics.push(`Canvas dimensions (${width}x${height}) must be positive`);
    return {
      isSupported: false,
      reasonCode: 'DIMENSIONS_EXCEED_PLATFORM_CAP',
      diagnostics,
      unsupportedFeatures: ['zero_or_negative_dimensions'],
    };
  }

  if (width > profile.maxDimensions.width || height > profile.maxDimensions.height) {
    diagnostics.push(
      `Canvas dimensions (${width}x${height}) exceed platform capability limit (${profile.maxDimensions.width}x${profile.maxDimensions.height}) on ${platform}.`,
    );
    unsupportedFeatures.push(`dimensions_exceed_cap:${width}x${height}`);
    return {
      isSupported: false,
      reasonCode: 'DIMENSIONS_EXCEED_PLATFORM_CAP',
      diagnostics,
      unsupportedFeatures,
    };
  }

  // 2. Mobile Jetsam Limit Check (e.g. 1080p or 4K on iOS Safari)
  if (profile.family === 'mobile' && (width > 1280 || height > 1280)) {
    diagnostics.push(
      `High-resolution canvas (${width}x${height}) on mobile platform ${platform} risks memory exhaustion and Jetsam tab kill.`,
    );
    unsupportedFeatures.push('mobile_resolution_above_720p');
    return {
      isSupported: false,
      reasonCode: 'EXCEEDS_MEMORY_BUDGET',
      diagnostics,
      unsupportedFeatures,
    };
  }

  // 3. Duration Limits
  const durationFrames = spec.duration_frames ?? 0;
  if (durationFrames <= 0) {
    diagnostics.push('Composition duration_frames must be positive');
    return {
      isSupported: false,
      reasonCode: 'EXCEEDS_MEMORY_BUDGET',
      diagnostics,
      unsupportedFeatures: ['invalid_duration'],
    };
  }

  const platformMaxFrames = Math.min(profile.maxDurationFrames, APPROVED_BROWSER_EXPORT_SUBSET.maxDurationFrames);
  if (durationFrames > platformMaxFrames) {
    diagnostics.push(
      `Composition duration (${durationFrames} frames) exceeds safe platform limit (${platformMaxFrames} frames).`,
    );
    unsupportedFeatures.push(`duration_exceeds_cap:${durationFrames}>${platformMaxFrames}`);
    return {
      isSupported: false,
      reasonCode: 'EXCEEDS_MEMORY_BUDGET',
      diagnostics,
      unsupportedFeatures,
    };
  }

  // 4. Inspect Scenes and Engines
  const scenes = spec.scenes ?? [];
  if (scenes.length === 0) {
    diagnostics.push('Composition contains no scenes');
    return {
      isSupported: false,
      reasonCode: 'UNSUPPORTED_BROWSER_PLATFORM',
      diagnostics,
      unsupportedFeatures: ['empty_scenes'],
    };
  }

  if (scenes.length > APPROVED_BROWSER_EXPORT_SUBSET.maxScenesCount) {
    diagnostics.push(`Scene count (${scenes.length}) exceeds browser subset ceiling (${APPROVED_BROWSER_EXPORT_SUBSET.maxScenesCount})`);
    unsupportedFeatures.push(`excessive_scene_count:${scenes.length}`);
  }

  for (const scene of scenes) {
    // Custom Code / Bundled JS check
    if (scene.engine === 'custom-html-v1' || Boolean(scene.bundle)) {
      diagnostics.push(
        `Scene '${scene.id ?? 'unnamed'}' requires custom-html-v1 engine or executable bundle. Client execution is restricted to server microVM.`,
      );
      unsupportedFeatures.push('custom_code_engine');
      return {
        isSupported: false,
        reasonCode: 'CUSTOM_CODE_ENGINE_UNSUPPORTED',
        diagnostics,
        unsupportedFeatures,
      };
    }

    if (scene.engine && !APPROVED_BROWSER_EXPORT_SUBSET.allowedEngines.includes(scene.engine)) {
      diagnostics.push(
        `Scene '${scene.id ?? 'unnamed'}' specifies engine '${scene.engine}' which is not in the approved browser subset.`,
      );
      unsupportedFeatures.push(`unsupported_engine:${scene.engine}`);
      return {
        isSupported: false,
        reasonCode: 'CUSTOM_CODE_ENGINE_UNSUPPORTED',
        diagnostics,
        unsupportedFeatures,
      };
    }

    const layers = scene.layers ?? [];
    if (layers.length > APPROVED_BROWSER_EXPORT_SUBSET.maxLayersPerScene) {
      diagnostics.push(
        `Scene '${scene.id ?? 'unnamed'}' has ${layers.length} layers, exceeding subset maximum of ${APPROVED_BROWSER_EXPORT_SUBSET.maxLayersPerScene}.`,
      );
      unsupportedFeatures.push(`excessive_layers:${layers.length}`);
    }

    for (const layer of layers) {
      const layerType = (layer.type ?? '') as SupportedSubsetLayerType;
      if (!APPROVED_BROWSER_EXPORT_SUBSET.allowedLayerTypes.includes(layerType)) {
        diagnostics.push(
          `Layer '${layer.id ?? 'unnamed'}' has unsupported layer type '${layer.type}'. Browser export spike only supports 'text', 'image', and 'shape'.`,
        );
        unsupportedFeatures.push(`unsupported_layer_type:${layer.type}`);
      }

      // Check for advanced shaders or unsupported filter arrays
      if (layer.filters && layer.filters.length > 0) {
        diagnostics.push(`Layer '${layer.id ?? 'unnamed'}' specifies complex filters not supported in browser 2D canvas spike.`);
        unsupportedFeatures.push('unsupported_canvas_filters');
      }

      // If image layer: check for raw external URLs without scoped grant
      if (layerType === 'image' && layer.content) {
        const src = String(layer.content['src'] || layer.content['url'] || layer.content['asset_id'] || '');
        if (src.startsWith('http://') || src.startsWith('https://')) {
          if (!src.includes('/download/') && !src.includes('grant=') && !src.includes('token=')) {
            diagnostics.push(
              `Image layer '${layer.id ?? 'unnamed'}' references unauthenticated external URL '${src}'. Offline assets must use scoped grants only.`,
            );
            unsupportedFeatures.push('unauthenticated_image_url');
          }
        }
      }
    }
  }

  // 5. Audio tracks count
  const audioTracks = spec.audio_tracks ?? [];
  if (audioTracks.length > APPROVED_BROWSER_EXPORT_SUBSET.maxAudioTracks) {
    diagnostics.push(
      `Audio track count (${audioTracks.length}) exceeds browser spike maximum (${APPROVED_BROWSER_EXPORT_SUBSET.maxAudioTracks}).`,
    );
    unsupportedFeatures.push(`excessive_audio_tracks:${audioTracks.length}`);
  }

  if (unsupportedFeatures.length > 0) {
    return {
      isSupported: false,
      reasonCode: 'UNSUPPORTED_BROWSER_PLATFORM',
      diagnostics,
      unsupportedFeatures,
    };
  }

  diagnostics.push('Composition fully conforms to approved browser export scene subset.');
  return {
    isSupported: true,
    diagnostics,
    unsupportedFeatures: [],
  };
}
