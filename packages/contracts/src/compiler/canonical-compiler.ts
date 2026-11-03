/**
 * Canonical Compiler for Creativanta Video Engine.
 * Translates a verified CompositionSpec into an immutable, deterministic CanonicalCompilerManifest
 * with full frame evaluation, rational time calculations, and reproducible hashing.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, docs/ARCHITECTURE.md
 */

import {
  CompositionSpec,
  LayerSpec,
  StandardSceneSpec,
  CustomSceneSpec,
} from '../types/scene.js';
import {
  CanonicalCompilerManifest,
  SceneManifest,
  LayerManifest,
  AudioTrackManifest,
  SubtitleTrackManifest,
  AssetManifestEntry,
  FrameEvaluationResult,
  EvaluatedLayerState,
} from '../types/manifest.js';
import {
  JsonSchemaValidator,
  ValidationResult,
} from '../validation/composition-validator.js';
import {
  SemanticValidator,
  SemanticValidationResult,
} from '../validation/semantic-validator.js';
import {
  CapabilityValidator,
  CapabilityValidationResult,
  CapabilityValidationOptions,
} from '../validation/capability-validator.js';
import {
  materializeCompositionDefaults,
  computeSpecHash,
  computeSceneHash,
  computeRenderHash,
} from './canonical-json.js';
import {
  frameToSeconds,
  frameToMilliseconds,
  frameToAudioSamples,
  audioSegmentSamples,
} from './rational-time.js';
import {
  evaluateLayerAnimations,
  calculateTransitionAlpha,
} from './animation.js';

export interface CompilerOptions {
  compositionId?: string;
  revision?: number;
  profile?: 'mp4-720p-v1' | 'preview-360p-v1' | string;
  compilerVersion?: string;
  skipSchemaValidation?: boolean;
  skipSemanticValidation?: boolean;
  skipCapabilityValidation?: boolean;
  capabilityOptions?: CapabilityValidationOptions;
  assetHashes?: Record<string, string>;
}

export interface UnifiedValidationResult {
  valid: boolean;
  schema: ValidationResult;
  semantic: SemanticValidationResult;
  capabilities: CapabilityValidationResult;
  all_errors: { pointer: string; code: string; message: string; stage: 'schema' | 'semantic' | 'capability' }[];
  warnings: string[];
}

/**
 * Unified 3-tier validation: Schema -> Semantic -> Policy/Capability.
 */
export function validateCompositionUnified(
  spec: unknown,
  options: CompilerOptions = {}
): UnifiedValidationResult {
  const schemaValidator = new JsonSchemaValidator();
  const schemaRes = schemaValidator.validate(spec);

  const allErrors: { pointer: string; code: string; message: string; stage: 'schema' | 'semantic' | 'capability' }[] = [];
  for (const err of schemaRes.errors) {
    allErrors.push({ ...err, stage: 'schema' });
  }

  // If schema is invalid, we return early
  if (!schemaRes.valid) {
    return {
      valid: false,
      schema: schemaRes,
      semantic: { valid: false, errors: [], warnings: [] },
      capabilities: { valid: false, errors: [], required_capabilities: [] },
      all_errors: allErrors,
      warnings: [],
    };
  }

  const composition = spec as CompositionSpec;

  // Tier 2: Semantic Validator
  const semanticValidator = new SemanticValidator();
  const semanticRes = semanticValidator.validate(composition);
  for (const err of semanticRes.errors) {
    allErrors.push({ ...err, stage: 'semantic' });
  }

  // Tier 3: Capability Validator
  const capValidator = new CapabilityValidator();
  const capOpts: CapabilityValidationOptions = {
    profile: options.profile ?? 'mp4-720p-v1',
    ...options.capabilityOptions,
  };
  const capRes = capValidator.validate(composition, capOpts);
  for (const err of capRes.errors) {
    allErrors.push({ ...err, stage: 'capability' });
  }

  const warnings: string[] = [];
  for (const w of semanticRes.warnings) {
    warnings.push(`[${w.code}] ${w.pointer}: ${w.message}`);
  }

  return {
    valid: allErrors.length === 0,
    schema: schemaRes,
    semantic: semanticRes,
    capabilities: capRes,
    all_errors: allErrors,
    warnings,
  };
}

/**
 * Compiles a CompositionSpec into a CanonicalCompilerManifest.
 */
export function compileComposition(
  spec: CompositionSpec,
  options: CompilerOptions = {}
): CanonicalCompilerManifest {
  // Validate if not explicitly skipped
  if (!options.skipSchemaValidation || !options.skipSemanticValidation || !options.skipCapabilityValidation) {
    const valResult = validateCompositionUnified(spec, options);
    if (!valResult.valid) {
      const firstErr = valResult.all_errors[0]!;
      throw new Error(`Composition validation failed at ${firstErr.pointer} (${firstErr.code}): ${firstErr.message}`);
    }
  }

  const normalized = materializeCompositionDefaults(spec);
  const profile = options.profile ?? 'mp4-720p-v1';
  const compilerVersion = options.compilerVersion ?? '0.1.0';

  const specHash = computeSpecHash(normalized);

  const fontHashes: Record<string, string> = {};
  for (const f of normalized.fonts) {
    fontHashes[f.id] = f.sha256;
  }

  const renderHash = computeRenderHash(normalized, profile, {
    assetHashes: options.assetHashes,
    fontHashes,
    compilerVersion,
  });

  const durationSeconds = frameToSeconds(normalized.duration_frames, normalized.fps);

  // Extract referenced assets
  const assetMap: Record<string, AssetManifestEntry> = {};

  const sceneManifests: SceneManifest[] = [];

  for (let sIdx = 0; sIdx < normalized.scenes.length; sIdx++) {
    const s = normalized.scenes[sIdx]!;
    const endFrame = s.start_frame + s.duration_frames;
    const sceneHash = computeSceneHash(s);

    const transOut = s.transition_out ?? { type: 'cut', duration_frames: 0 };
    const fadeStart = transOut.type === 'fade_to_background' ? endFrame - transOut.duration_frames : undefined;
    const fadeEnd = transOut.type === 'fade_to_background' ? endFrame : undefined;

    let layerManifests: LayerManifest[] = [];

    if ('layers' in s) {
      const stdScene = s as StandardSceneSpec;
      layerManifests = stdScene.layers.map((layer: LayerSpec): LayerManifest => {
        // Collect assets
        if (layer.type === 'image' && 'asset_id' in layer.content) {
          assetMap[layer.content.asset_id] = { asset_id: layer.content.asset_id, kind: 'image' };
        } else if (layer.type === 'video' && 'asset_id' in layer.content) {
          assetMap[layer.content.asset_id] = { asset_id: layer.content.asset_id, kind: 'video' };
        } else if (layer.type === 'svg' && 'asset_id' in layer.content) {
          assetMap[layer.content.asset_id] = { asset_id: layer.content.asset_id, kind: 'svg' };
        }

        const globalStart = s.start_frame + layer.start_frame;
        const globalEnd = globalStart + layer.duration_frames;

        return {
          id: layer.id,
          type: layer.type,
          z_index: layer.z_index,
          global_start_frame: globalStart,
          global_end_frame: globalEnd,
          local_start_frame: layer.start_frame,
          local_duration_frames: layer.duration_frames,
          box: { ...layer.box },
          opacity: layer.opacity ?? 1,
          transform: {
            translate_x: layer.transform?.translate_x ?? 0,
            translate_y: layer.transform?.translate_y ?? 0,
            scale_x: layer.transform?.scale_x ?? 1,
            scale_y: layer.transform?.scale_y ?? 1,
            rotate_deg: layer.transform?.rotate_deg ?? 0,
            origin_x: layer.transform?.origin_x ?? 0.5,
            origin_y: layer.transform?.origin_y ?? 0.5,
          },
          animations: (layer.animations ?? []).map((a) => ({ ...a })),
          content: layer.content,
        };
      });
    } else {
      const customScene = s as CustomSceneSpec;
      assetMap[customScene.bundle.id] = {
        asset_id: customScene.bundle.id,
        kind: 'bundle',
        sha256: customScene.bundle.build_sha256,
      };
    }

    sceneManifests.push({
      id: s.id,
      revision: s.revision,
      scene_hash: sceneHash,
      start_frame: s.start_frame,
      duration_frames: s.duration_frames,
      end_frame: endFrame,
      engine: s.engine,
      background: s.background ?? normalized.canvas.background ?? '#000000',
      transition_out: {
        type: transOut.type,
        duration_frames: transOut.duration_frames,
        fade_start_frame: fadeStart,
        fade_end_frame: fadeEnd,
      },
      layers: layerManifests,
    });
  }

  // Audio track manifests
  const audioManifests: AudioTrackManifest[] = normalized.audio_tracks.map((track) => {
    assetMap[track.asset_id] = { asset_id: track.asset_id, kind: 'audio' };
    const sampleStart = frameToAudioSamples(track.start_frame, normalized.fps, 48000);
    const sampleCount = audioSegmentSamples(
      track.start_frame,
      track.start_frame + track.duration_frames,
      normalized.fps,
      48000
    );

    return {
      id: track.id,
      asset_id: track.asset_id,
      start_frame: track.start_frame,
      duration_frames: track.duration_frames,
      end_frame: track.start_frame + track.duration_frames,
      sample_start: sampleStart,
      sample_count: sampleCount,
      source_in_samples: track.source_in_samples,
      gain_db: track.gain_db,
      role: track.role ?? 'effect',
      fade_in_frames: track.fade_in_frames ?? 0,
      fade_out_frames: track.fade_out_frames ?? 0,
      gain_keyframes: (track.gain_keyframes ?? []).map((k) => ({ ...k })),
    };
  });

  // Subtitle track manifests
  const subtitleManifests: SubtitleTrackManifest[] = normalized.subtitles.map((track) => {
    return {
      id: track.id,
      locale: track.locale,
      burn_in: track.burn_in ?? false,
      style: {
        font_id: track.style?.font_id ?? normalized.fonts[0]?.id ?? 'default',
        font_size: track.style?.font_size ?? 28,
        color: track.style?.color ?? '#FFFFFF',
        background: track.style?.background ?? '#000000CC',
        align: track.style?.align ?? 'center',
        max_lines: track.style?.max_lines ?? 2,
        safe_margin_px: track.style?.safe_margin_px ?? 48,
      },
      cues: track.cues.map((cue) => ({
        id: cue.id,
        start_frame: cue.start_frame,
        end_frame: cue.end_frame,
        start_ms: frameToMilliseconds(cue.start_frame, normalized.fps),
        end_ms: frameToMilliseconds(cue.end_frame, normalized.fps),
        text: cue.text.normalize('NFC'),
      })),
    };
  });

  const requiredCaps = new Set<string>();
  requiredCaps.add(`profile:${profile}`);
  for (const s of normalized.scenes) {
    requiredCaps.add(`engine:${s.engine}`);
  }
  if (normalized.direction === 'rtl') {
    requiredCaps.add('feature:rtl');
  }

  const manifest: CanonicalCompilerManifest = {
    manifest_version: '1.0',
    compiler_version: compilerVersion,
    composition_id: options.compositionId ?? 'cmp_compiled',
    revision: options.revision ?? 1,
    profile,
    canvas: {
      width: normalized.canvas.width,
      height: normalized.canvas.height,
      background: normalized.canvas.background ?? '#000000',
    },
    fps: normalized.fps,
    duration_frames: normalized.duration_frames,
    duration_seconds: durationSeconds,
    seed: normalized.seed,
    locale: normalized.locale,
    direction: normalized.direction ?? 'ltr',
    spec_hash: specHash,
    render_hash: renderHash,
    scenes: sceneManifests,
    audio_tracks: audioManifests,
    subtitles: subtitleManifests,
    fonts: normalized.fonts.map((f) => ({ ...f })),
    assets: assetMap,
    required_capabilities: Array.from(requiredCaps).sort(),
    compiled_at: new Date().toISOString(),
  };

  return manifest;
}

/**
 * Pure frame function: evaluates active scene, layer opacities and transforms at global frame k.
 */
export function evaluateFrame(
  manifest: CanonicalCompilerManifest,
  globalFrame: number
): FrameEvaluationResult {
  if (globalFrame < 0 || globalFrame >= manifest.duration_frames) {
    throw new RangeError(
      `Frame index ${globalFrame} out of bounds [0, ${manifest.duration_frames})`
    );
  }

  // 1. Locate active scene
  let activeScene = manifest.scenes.find(
    (s) => globalFrame >= s.start_frame && globalFrame < s.end_frame
  );

  // Boundary check fallback for last frame
  if (!activeScene && globalFrame === manifest.duration_frames - 1 && manifest.scenes.length > 0) {
    activeScene = manifest.scenes[manifest.scenes.length - 1];
  }

  if (!activeScene) {
    throw new Error(`No active scene found at frame ${globalFrame}`);
  }

  const localSceneFrame = globalFrame - activeScene.start_frame;

  // 2. Evaluate transition alpha
  const transAlpha = calculateTransitionAlpha(
    {
      type: activeScene.transition_out.type,
      duration_frames: activeScene.transition_out.duration_frames as any,
    },
    activeScene.start_frame,
    activeScene.duration_frames,
    globalFrame
  );

  // 3. Locate active layers and evaluate properties
  const activeLayers = activeScene.layers.filter(
    (l) => globalFrame >= l.global_start_frame && globalFrame < l.global_end_frame
  );

  // Sort by z_index ascending
  activeLayers.sort((a, b) => a.z_index - b.z_index);

  const evaluatedLayers: EvaluatedLayerState[] = activeLayers.map((l) => {
    const localLayerFrame = globalFrame - l.global_start_frame;
    const animState = evaluateLayerAnimations(
      l.animations,
      localLayerFrame,
      l.transform,
      l.opacity
    );

    // Effective opacity = layer opacity * scene transition alpha
    const effectiveOpacity = Math.max(0, Math.min(1, animState.opacity * transAlpha.sceneAlpha));

    return {
      layer_id: l.id,
      type: l.type,
      z_index: l.z_index,
      opacity: effectiveOpacity,
      transform: animState.transform,
      box: l.box,
      content: l.content,
    };
  });

  return {
    frame_index: globalFrame,
    timestamp_seconds: frameToSeconds(globalFrame, manifest.fps),
    audio_sample_offset: frameToAudioSamples(globalFrame, manifest.fps, 48000),
    scene: {
      id: activeScene.id,
      revision: activeScene.revision,
      engine: activeScene.engine,
      background: activeScene.background,
      local_frame: localSceneFrame,
      scene_alpha: transAlpha.sceneAlpha,
      transition_active: transAlpha.transitionActive,
    },
    layers: evaluatedLayers,
  };
}
