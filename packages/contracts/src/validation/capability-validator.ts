/**
 * Policy & Capability Validator (Tier 3) for Creativanta Video Engine.
 * Enforces profile dimensions, duration clamp, engine allowlists and tenant quotas.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, and evidence/P0-04/report.md
 */

import { CompositionSpec } from '../types/scene.js';
import { ProfileDefinition } from '../types/capabilities.js';

export type CapabilityErrorCode = 'PROFILE_CONSTRAINT_VIOLATED' | 'CAPABILITY_DISABLED';

export interface CapabilityValidationError {
  pointer: string;
  code: CapabilityErrorCode;
  message: string;
}

export interface CapabilityValidationResult {
  valid: boolean;
  errors: CapabilityValidationError[];
  required_capabilities: string[];
}

export interface CapabilityValidationOptions {
  profile?: 'mp4-720p-v1' | 'preview-360p-v1' | string;
  customCodeEnabled?: boolean;
  rtlEnabled?: boolean;
  canvasEngineEnabled?: boolean;
  svgEngineEnabled?: boolean;
  maxScenes?: number;
  maxLayersPerScene?: number;
  maxLayersTotal?: number;
  maxAudioTracks?: number;
  maxSubtitles?: number;
  maxFonts?: number;
  maxDurationFrames?: number;
}

export const STARTER_PROFILES: Record<string, ProfileDefinition> = {
  'mp4-720p-v1': {
    id: 'mp4-720p-v1',
    description: 'Standard 720p H.264 MP4 render',
    supported: true,
    dimensions: [
      { width: 1280, height: 720 },
      { width: 720, height: 1280 },
    ],
    fps: { num: 30, den: 1 },
    container: 'mp4',
    video_codec: 'h264',
    audio_codec: 'aac',
    max_duration_seconds: 60,
  },
  'preview-360p-v1': {
    id: 'preview-360p-v1',
    description: 'Fast 360p preview',
    supported: true,
    dimensions: [
      { width: 640, height: 360 },
      { width: 360, height: 640 },
    ],
    fps: { num: 30, den: 1 },
    container: 'mp4',
    video_codec: 'h264',
    audio_codec: 'aac',
    max_duration_seconds: 10,
  },
};

export class CapabilityValidator {
  public validate(
    spec: CompositionSpec,
    options: CapabilityValidationOptions = {}
  ): CapabilityValidationResult {
    const errors: CapabilityValidationError[] = [];
    const requiredCaps = new Set<string>();

    const profileId = options.profile ?? 'mp4-720p-v1';
    const profile = STARTER_PROFILES[profileId];

    // 1. Profile constraints validation
    if (!profile) {
      errors.push({
        pointer: '/profile',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Unsupported render profile '${profileId}'`,
      });
    } else {
      requiredCaps.add(`profile:${profileId}`);

      // Check canvas dimensions
      const dimMatch = profile.dimensions.some(
        (d) => d.width === spec.canvas.width && d.height === spec.canvas.height
      );
      if (!dimMatch) {
        const allowedStr = profile.dimensions
          .map((d) => `${d.width}x${d.height}`)
          .join(' or ');
        errors.push({
          pointer: '/canvas',
          code: 'PROFILE_CONSTRAINT_VIOLATED',
          message: `Canvas dimensions ${spec.canvas.width}x${spec.canvas.height} not allowed by profile '${profileId}'. Must be ${allowedStr}`,
        });
      }

      // Check FPS
      const fpsMatch = profile.fps.num === spec.fps.num && profile.fps.den === spec.fps.den;
      if (!fpsMatch) {
        errors.push({
          pointer: '/fps',
          code: 'PROFILE_CONSTRAINT_VIOLATED',
          message: `Rational FPS ${spec.fps.num}/${spec.fps.den} not supported by profile '${profileId}'. Only ${profile.fps.num}/${profile.fps.den} is currently enabled in starter limits`,
        });
      }

      // Check profile max duration (e.g. 60s * 30 = 1800 frames for mp4-720p-v1)
      const maxProfileFrames = Math.floor((profile.max_duration_seconds * profile.fps.num) / profile.fps.den);
      if (spec.duration_frames > maxProfileFrames) {
        errors.push({
          pointer: '/duration_frames',
          code: 'PROFILE_CONSTRAINT_VIOLATED',
          message: `duration_frames (${spec.duration_frames}) exceeds profile '${profileId}' maximum allowed (${maxProfileFrames})`,
        });
      }
    }

    // 2. Global Quotas & Limits
    const maxDuration = options.maxDurationFrames ?? 10800;
    if (spec.duration_frames > maxDuration) {
      errors.push({
        pointer: '/duration_frames',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `duration_frames (${spec.duration_frames}) exceeds system limit (${maxDuration})`,
      });
    }

    const maxScenes = options.maxScenes ?? 50;
    if (spec.scenes.length > maxScenes) {
      errors.push({
        pointer: '/scenes',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Total scenes count (${spec.scenes.length}) exceeds maximum limit (${maxScenes})`,
      });
    }

    const maxFonts = options.maxFonts ?? 16;
    if (spec.fonts.length > maxFonts) {
      errors.push({
        pointer: '/fonts',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Fonts count (${spec.fonts.length}) exceeds maximum limit (${maxFonts})`,
      });
    }

    const maxAudio = options.maxAudioTracks ?? 16;
    if (spec.audio_tracks.length > maxAudio) {
      errors.push({
        pointer: '/audio_tracks',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Audio tracks count (${spec.audio_tracks.length}) exceeds maximum limit (${maxAudio})`,
      });
    }

    const maxSubs = options.maxSubtitles ?? 8;
    if (spec.subtitles.length > maxSubs) {
      errors.push({
        pointer: '/subtitles',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Subtitles count (${spec.subtitles.length}) exceeds maximum limit (${maxSubs})`,
      });
    }

    // Layers limits and Engine check
    const maxLayersPerScene = options.maxLayersPerScene ?? 100;
    const maxLayersTotal = options.maxLayersTotal ?? 500;
    let totalLayers = 0;

    for (let i = 0; i < spec.scenes.length; i++) {
      const scene = spec.scenes[i]!;
      const scenePointer = `/scenes/${i}`;

      requiredCaps.add(`engine:${scene.engine}`);

      // Custom code engine check
      if (scene.engine === 'custom-html-v1') {
        const customAllowed = options.customCodeEnabled ?? false;
        if (!customAllowed) {
          errors.push({
            pointer: `${scenePointer}/engine`,
            code: 'CAPABILITY_DISABLED',
            message: `Custom code engine 'custom-html-v1' is disabled on this tenant/environment`,
          });
        }
      } else if (scene.engine === 'canvas-v1' && options.canvasEngineEnabled === false) {
        errors.push({
          pointer: `${scenePointer}/engine`,
          code: 'CAPABILITY_DISABLED',
          message: `Canvas engine 'canvas-v1' is currently disabled`,
        });
      } else if (scene.engine === 'svg-v1' && options.svgEngineEnabled === false) {
        errors.push({
          pointer: `${scenePointer}/engine`,
          code: 'CAPABILITY_DISABLED',
          message: `SVG engine 'svg-v1' is currently disabled`,
        });
      }

      if ('layers' in scene) {
        const layerCount = scene.layers.length;
        if (layerCount > maxLayersPerScene) {
          errors.push({
            pointer: `${scenePointer}/layers`,
            code: 'PROFILE_CONSTRAINT_VIOLATED',
            message: `Scene '${scene.id}' has ${layerCount} layers, exceeding maximum of ${maxLayersPerScene} layers per scene`,
          });
        }
        totalLayers += layerCount;
      }
    }

    if (totalLayers > maxLayersTotal) {
      errors.push({
        pointer: '/scenes',
        code: 'PROFILE_CONSTRAINT_VIOLATED',
        message: `Total composition layers (${totalLayers}) exceeds system limit of ${maxLayersTotal}`,
      });
    }

    // Direction capability
    if (spec.direction === 'rtl') {
      const rtlAllowed = options.rtlEnabled ?? false;
      if (!rtlAllowed) {
        errors.push({
          pointer: '/direction',
          code: 'CAPABILITY_DISABLED',
          message: `Right-to-left text direction 'rtl' capability is currently disabled`,
        });
      } else {
        requiredCaps.add('feature:rtl');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      required_capabilities: Array.from(requiredCaps).sort(),
    };
  }
}
