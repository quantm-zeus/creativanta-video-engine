/**
 * Canonical JSON Serialization (RFC 8785 JCS), Defaults Materialization and Hashing.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, and docs/TESTING.md
 */

import crypto from 'node:crypto';
import {
  CompositionSpec,
  LayerSpec,
  SceneSpec,
  StandardSceneSpec,
  CustomSceneSpec,
  AudioTrackSpec,
  SubtitleTrackSpec,
} from '../types/scene.js';

/**
 * Computes SHA-256 hex digest (64 lowercase hex characters).
 */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON Canonicalization Scheme (RFC 8785 / JCS).
 * - Unicode NFC normalization on strings.
 * - Object keys strictly sorted by UTF-16 code units.
 * - Finite numbers only; IEEE 754 compact formatting without exponential notation when possible.
 * - No insignificant whitespace.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  const t = typeof value;
  if (t === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot canonicalize non-finite number: ${value}`);
    }
    // IEEE 754 float formatting conforming to RFC 8785
    return JSON.stringify(value);
  }
  if (t === 'string') {
    return JSON.stringify((value as string).normalize('NFC'));
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJson(item));
    return `[${items.join(',')}]`;
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined) {
        const canonicalKey = JSON.stringify(k.normalize('NFC'));
        entries.push(`${canonicalKey}:${canonicalizeJson(v)}`);
      }
    }
    return `{${entries.join(',')}}`;
  }

  throw new Error(`Unsupported type for canonical JSON: ${t}`);
}

/**
 * Materializes all normative defaults on a CompositionSpec before serialization/hashing.
 * Leaves the original object untouched; returns a deep-cloned materialized spec.
 */
export function materializeCompositionDefaults(spec: CompositionSpec): CompositionSpec {
  const canvasBg = spec.canvas.background ?? '#000000';

  const materializedScenes: SceneSpec[] = spec.scenes.map((scene): SceneSpec => {
    const sceneBg = scene.background ?? canvasBg;
    const transitionOut = scene.transition_out ?? {
      type: 'cut',
      duration_frames: 0,
    };

    if ('bundle' in scene) {
      const customScene: CustomSceneSpec = {
        ...scene,
        background: sceneBg,
        transition_out: transitionOut,
      };
      return customScene;
    }

    const stdScene = scene as StandardSceneSpec;
    const materializedLayers: LayerSpec[] = stdScene.layers.map((layer): LayerSpec => {
      const opacity = layer.opacity ?? 1;
      const transform = {
        translate_x: layer.transform?.translate_x ?? 0,
        translate_y: layer.transform?.translate_y ?? 0,
        scale_x: layer.transform?.scale_x ?? 1,
        scale_y: layer.transform?.scale_y ?? 1,
        rotate_deg: layer.transform?.rotate_deg ?? 0,
        origin_x: layer.transform?.origin_x ?? 0.5,
        origin_y: layer.transform?.origin_y ?? 0.5,
      };
      const animations = layer.animations ? layer.animations.map((a) => ({ ...a })) : [];

      let content = { ...layer.content };
      if (layer.type === 'text' && 'text' in content) {
        content = {
          ...content,
          align: content.align ?? 'left',
          line_height: content.line_height ?? 1.2,
          max_lines: content.max_lines ?? 5,
          overflow: content.overflow ?? 'error',
          min_font_size: content.min_font_size ?? content.font_size,
        };
      } else if (layer.type === 'image' && 'fit' in content) {
        content = {
          ...content,
          anchor_x: content.anchor_x ?? 0.5,
          anchor_y: content.anchor_y ?? 0.5,
        };
      } else if (layer.type === 'video' && 'source_in_frame' in content) {
        content = {
          ...content,
          playback_rate: 1,
          loop: content.loop ?? false,
          anchor_x: content.anchor_x ?? 0.5,
          anchor_y: content.anchor_y ?? 0.5,
        };
      } else if (layer.type === 'shape' && 'shape' in content) {
        content = {
          ...content,
          stroke: content.stroke ?? 'transparent',
          stroke_width: content.stroke_width ?? 0,
          radius: content.radius ?? 0,
        };
      } else if (layer.type === 'svg' && 'fit' in content) {
        content = {
          ...content,
          anchor_x: content.anchor_x ?? 0.5,
          anchor_y: content.anchor_y ?? 0.5,
        };
      }

      return {
        ...layer,
        opacity,
        transform,
        animations,
        content: content as LayerSpec['content'],
      };
    });

    const standardScene: StandardSceneSpec = {
      ...stdScene,
      background: sceneBg,
      transition_out: transitionOut,
      layers: materializedLayers,
    };
    return standardScene;
  });

  const materializedAudioTracks: AudioTrackSpec[] = spec.audio_tracks.map((track) => ({
    ...track,
    role: track.role ?? 'effect',
    fade_in_frames: track.fade_in_frames ?? 0,
    fade_out_frames: track.fade_out_frames ?? 0,
    gain_keyframes: track.gain_keyframes ? track.gain_keyframes.map((k) => ({ ...k })) : [],
  }));

  const materializedSubtitles: SubtitleTrackSpec[] = spec.subtitles.map((track) => {
    let style = track.style;
    if (style) {
      style = {
        ...style,
        align: style.align ?? 'center',
        max_lines: style.max_lines ?? 2,
        safe_margin_px: style.safe_margin_px ?? 48,
      };
    }
    return {
      ...track,
      burn_in: track.burn_in ?? false,
      style,
      cues: track.cues.map((c) => ({ ...c })),
    };
  });

  return {
    ...spec,
    canvas: {
      ...spec.canvas,
      background: canvasBg,
    },
    direction: spec.direction ?? 'ltr',
    scenes: materializedScenes,
    audio_tracks: materializedAudioTracks,
    subtitles: materializedSubtitles,
  };
}

/**
 * Creates a clean version of the spec omitting metadata, used for render-affecting hash calculations.
 */
export function stripMetadataForHashing(spec: CompositionSpec): Record<string, unknown> {
  const { metadata, ...rest } = spec;
  return rest as unknown as Record<string, unknown>;
}

/**
 * Computes canonical spec_hash (SHA-256 of normalized spec without metadata).
 */
export function computeSpecHash(spec: CompositionSpec): string {
  const normalized = materializeCompositionDefaults(spec);
  const strippped = stripMetadataForHashing(normalized);
  const canonical = canonicalizeJson(strippped);
  return sha256Hex(canonical);
}

/**
 * Computes canonical scene_hash (SHA-256 of normalized scene).
 */
export function computeSceneHash(scene: SceneSpec): string {
  const canonical = canonicalizeJson(scene);
  return sha256Hex(canonical);
}

export interface RenderHashOptions {
  assetHashes?: Record<string, string>;
  fontHashes?: Record<string, string>;
  compilerVersion?: string;
}

/**
 * Computes canonical render_hash combining:
 * - Normalized spec (without metadata)
 * - Profile identifier
 * - Pinned asset digests
 * - Pinned font digests
 * - Compiler version
 */
export function computeRenderHash(
  spec: CompositionSpec,
  profile: string,
  options: RenderHashOptions = {}
): string {
  const normalized = materializeCompositionDefaults(spec);
  const stripped = stripMetadataForHashing(normalized);

  const payload = {
    spec: stripped,
    profile,
    compiler_version: options.compilerVersion ?? '0.1.0',
    assets: options.assetHashes ?? {},
    fonts: options.fontHashes ?? {},
  };

  const canonical = canonicalizeJson(payload);
  return sha256Hex(canonical);
}
