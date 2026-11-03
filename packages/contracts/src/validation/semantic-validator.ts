/**
 * Semantic Validator (Tier 2) for Creativanta Video Engine.
 * Validates timeline continuity, bounds, reference integrity, transitions and animation rules.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, and evidence/P0-04/report.md
 */

import {
  CompositionSpec,
  StandardSceneSpec,
} from '../types/scene.js';

export type SemanticErrorCode =
  | 'TIMELINE_BOUNDS'
  | 'TIMELINE_OVERLAP'
  | 'DUPLICATE_ID'
  | 'UNKNOWN_FONT'
  | 'ANIMATION_CONFLICT'
  | 'FONT_WEIGHT_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'UNICODE_NOT_NORMALIZED';

export interface SemanticValidationError {
  pointer: string;
  code: SemanticErrorCode;
  message: string;
}

export interface SemanticValidationWarning {
  pointer: string;
  code: string;
  message: string;
}

export interface SemanticValidationResult {
  valid: boolean;
  errors: SemanticValidationError[];
  warnings: SemanticValidationWarning[];
}

export class SemanticValidator {
  public validate(spec: CompositionSpec): SemanticValidationResult {
    const errors: SemanticValidationError[] = [];
    const warnings: SemanticValidationWarning[] = [];

    // 1. Font index & Font reference uniqueness
    const fontIds = new Set<string>();
    const fontMap = new Map<string, { weight: number; family: string }>();

    for (let i = 0; i < spec.fonts.length; i++) {
      const f = spec.fonts[i]!;
      if (fontIds.has(f.id)) {
        errors.push({
          pointer: `/fonts/${i}/id`,
          code: 'DUPLICATE_ID',
          message: `Duplicate font id '${f.id}'`,
        });
      }
      fontIds.add(f.id);
      fontMap.set(f.id, { weight: f.weight, family: f.family });
    }

    // 2. Scene timeline continuity and references
    const sceneIds = new Set<string>();
    let expectedSceneStart = 0;

    for (let i = 0; i < spec.scenes.length; i++) {
      const scene = spec.scenes[i]!;
      const scenePointer = `/scenes/${i}`;

      // Scene ID uniqueness
      if (sceneIds.has(scene.id)) {
        errors.push({
          pointer: `${scenePointer}/id`,
          code: 'DUPLICATE_ID',
          message: `Duplicate scene id '${scene.id}'`,
        });
      }
      sceneIds.add(scene.id);

      // Scene duration > 0
      if (scene.duration_frames <= 0) {
        errors.push({
          pointer: `${scenePointer}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Scene duration_frames must be greater than 0, got ${scene.duration_frames}`,
        });
      }

      // First scene must start at 0
      if (i === 0 && scene.start_frame !== 0) {
        errors.push({
          pointer: `${scenePointer}/start_frame`,
          code: 'TIMELINE_BOUNDS',
          message: `First scene start_frame must be 0, got ${scene.start_frame}`,
        });
      }

      // Subsequent scenes must be contiguous (no gap, no overlap)
      if (scene.start_frame !== expectedSceneStart) {
        errors.push({
          pointer: `${scenePointer}/start_frame`,
          code: 'TIMELINE_BOUNDS',
          message: `Scene start_frame must be ${expectedSceneStart} to preserve timeline continuity, got ${scene.start_frame}`,
        });
      }

      expectedSceneStart = scene.start_frame + scene.duration_frames;

      // Transitions
      if (scene.transition_out) {
        const trans = scene.transition_out;
        const transPointer = `${scenePointer}/transition_out`;
        if (trans.type === 'cut') {
          const cutDuration = (trans as { duration_frames: number }).duration_frames;
          if (cutDuration !== 0) {
            errors.push({
              pointer: `${transPointer}/duration_frames`,
              code: 'TIMELINE_BOUNDS',
              message: `Transition 'cut' must have duration_frames=0, got ${cutDuration}`,
            });
          }
        } else if (trans.type === 'fade_to_background') {
          const F = trans.duration_frames;
          if (F < 2) {
            errors.push({
              pointer: `${transPointer}/duration_frames`,
              code: 'TIMELINE_BOUNDS',
              message: `Transition 'fade_to_background' duration_frames must be >= 2, got ${F}`,
            });
          }
          if (F > 300) {
            errors.push({
              pointer: `${transPointer}/duration_frames`,
              code: 'TIMELINE_BOUNDS',
              message: `Transition 'fade_to_background' duration_frames must be <= 300, got ${F}`,
            });
          }
          if (F > scene.duration_frames) {
            errors.push({
              pointer: `${transPointer}/duration_frames`,
              code: 'TIMELINE_BOUNDS',
              message: `Transition 'fade_to_background' duration_frames (${F}) cannot exceed scene.duration_frames (${scene.duration_frames})`,
            });
          }
        }
      }

      // Layers validation (for standard scenes)
      if ('layers' in scene) {
        this.validateSceneLayers(
          scene as StandardSceneSpec,
          scenePointer,
          fontIds,
          fontMap,
          errors,
          warnings
        );
      }
    }

    // Last scene must end exactly at composition.duration_frames
    if (spec.scenes.length > 0) {
      const lastScene = spec.scenes[spec.scenes.length - 1]!;
      const lastSceneEnd = lastScene.start_frame + lastScene.duration_frames;
      if (lastSceneEnd !== spec.duration_frames) {
        errors.push({
          pointer: `/scenes/${spec.scenes.length - 1}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Last scene end frame (${lastSceneEnd}) must match composition duration_frames (${spec.duration_frames})`,
        });
      }
    }

    // 3. Audio tracks validation
    const audioTrackIds = new Set<string>();
    for (let i = 0; i < spec.audio_tracks.length; i++) {
      const track = spec.audio_tracks[i]!;
      const trackPointer = `/audio_tracks/${i}`;

      if (audioTrackIds.has(track.id)) {
        errors.push({
          pointer: `${trackPointer}/id`,
          code: 'DUPLICATE_ID',
          message: `Duplicate audio track id '${track.id}'`,
        });
      }
      audioTrackIds.add(track.id);

      if (track.start_frame < 0) {
        errors.push({
          pointer: `${trackPointer}/start_frame`,
          code: 'TIMELINE_BOUNDS',
          message: `Audio track start_frame must be >= 0, got ${track.start_frame}`,
        });
      }

      if (track.duration_frames <= 0) {
        errors.push({
          pointer: `${trackPointer}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Audio track duration_frames must be > 0, got ${track.duration_frames}`,
        });
      }

      if (track.start_frame + track.duration_frames > spec.duration_frames) {
        errors.push({
          pointer: `${trackPointer}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Audio track interval [${track.start_frame}, ${track.start_frame + track.duration_frames}) exceeds composition duration (${spec.duration_frames})`,
        });
      }

      if (track.source_in_samples < 0) {
        errors.push({
          pointer: `${trackPointer}/source_in_samples`,
          code: 'TIMELINE_BOUNDS',
          message: `Audio track source_in_samples must be >= 0, got ${track.source_in_samples}`,
        });
      }

      if (track.gain_db < -60 || track.gain_db > 12) {
        errors.push({
          pointer: `${trackPointer}/gain_db`,
          code: 'TIMELINE_BOUNDS',
          message: `Audio track gain_db must be in [-60, 12], got ${track.gain_db}`,
        });
      }

      if (track.gain_keyframes) {
        let prevKeyframe = -1;
        for (let k = 0; k < track.gain_keyframes.length; k++) {
          const kf = track.gain_keyframes[k]!;
          const kfPointer = `${trackPointer}/gain_keyframes/${k}`;
          if (kf.frame <= prevKeyframe) {
            errors.push({
              pointer: `${kfPointer}/frame`,
              code: 'TIMELINE_BOUNDS',
              message: `Gain keyframes must be strictly increasing, got ${kf.frame} after ${prevKeyframe}`,
            });
          }
          if (kf.frame < 0 || kf.frame >= track.duration_frames) {
            errors.push({
              pointer: `${kfPointer}/frame`,
              code: 'TIMELINE_BOUNDS',
              message: `Gain keyframe frame must be in [0, ${track.duration_frames - 1}], got ${kf.frame}`,
            });
          }
          if (kf.gain_db < -60 || kf.gain_db > 12) {
            errors.push({
              pointer: `${kfPointer}/gain_db`,
              code: 'TIMELINE_BOUNDS',
              message: `Gain keyframe gain_db must be in [-60, 12], got ${kf.gain_db}`,
            });
          }
          prevKeyframe = kf.frame;
        }
      }
    }

    // 4. Subtitles validation
    const subtitleTrackIds = new Set<string>();
    for (let i = 0; i < spec.subtitles.length; i++) {
      const subTrack = spec.subtitles[i]!;
      const subPointer = `/subtitles/${i}`;

      if (subtitleTrackIds.has(subTrack.id)) {
        errors.push({
          pointer: `${subPointer}/id`,
          code: 'DUPLICATE_ID',
          message: `Duplicate subtitle track id '${subTrack.id}'`,
        });
      }
      subtitleTrackIds.add(subTrack.id);

      if (subTrack.style && !fontIds.has(subTrack.style.font_id)) {
        errors.push({
          pointer: `${subPointer}/style/font_id`,
          code: 'UNKNOWN_FONT',
          message: `Subtitle style references unknown font_id '${subTrack.style.font_id}'`,
        });
      }

      const cueIds = new Set<string>();
      let prevCueEnd = 0;

      for (let c = 0; c < subTrack.cues.length; c++) {
        const cue = subTrack.cues[c]!;
        const cuePointer = `${subPointer}/cues/${c}`;

        if (cueIds.has(cue.id)) {
          errors.push({
            pointer: `${cuePointer}/id`,
            code: 'DUPLICATE_ID',
            message: `Duplicate subtitle cue id '${cue.id}' in track '${subTrack.id}'`,
          });
        }
        cueIds.add(cue.id);

        if (cue.start_frame < 0) {
          errors.push({
            pointer: `${cuePointer}/start_frame`,
            code: 'TIMELINE_BOUNDS',
            message: `Subtitle cue start_frame must be >= 0, got ${cue.start_frame}`,
          });
        }

        if (cue.start_frame >= cue.end_frame) {
          errors.push({
            pointer: `${cuePointer}/end_frame`,
            code: 'TIMELINE_BOUNDS',
            message: `Subtitle cue start_frame (${cue.start_frame}) must be strictly less than end_frame (${cue.end_frame})`,
          });
        }

        if (cue.end_frame > spec.duration_frames) {
          errors.push({
            pointer: `${cuePointer}/end_frame`,
            code: 'TIMELINE_BOUNDS',
            message: `Subtitle cue end_frame (${cue.end_frame}) exceeds composition duration (${spec.duration_frames})`,
          });
        }

        // Subtitle cues must not overlap within the same track
        if (c > 0 && cue.start_frame < prevCueEnd) {
          errors.push({
            pointer: `${cuePointer}/start_frame`,
            code: 'TIMELINE_OVERLAP',
            message: `Subtitle cue overlaps with previous cue (prev end: ${prevCueEnd}, current start: ${cue.start_frame})`,
          });
        }
        prevCueEnd = Math.max(prevCueEnd, cue.end_frame);

        // Unicode normalization check on cue text
        if (cue.text.normalize('NFC') !== cue.text) {
          warnings.push({
            pointer: `${cuePointer}/text`,
            code: 'UNICODE_NOT_NORMALIZED',
            message: 'Subtitle cue text is not in canonical Unicode NFC form; will be normalized during compilation',
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateSceneLayers(
    scene: StandardSceneSpec,
    scenePointer: string,
    fontIds: Set<string>,
    fontMap: Map<string, { weight: number; family: string }>,
    errors: SemanticValidationError[],
    warnings: SemanticValidationWarning[]
  ): void {
    const layerIds = new Set<string>();

    for (let j = 0; j < scene.layers.length; j++) {
      const layer = scene.layers[j]!;
      const layerPointer = `${scenePointer}/layers/${j}`;

      // Layer ID uniqueness per scene
      if (layerIds.has(layer.id)) {
        errors.push({
          pointer: `${layerPointer}/id`,
          code: 'DUPLICATE_ID',
          message: `Duplicate layer id '${layer.id}' in scene '${scene.id}'`,
        });
      }
      layerIds.add(layer.id);

      // Layer start_frame >= 0
      if (layer.start_frame < 0) {
        errors.push({
          pointer: `${layerPointer}/start_frame`,
          code: 'TIMELINE_BOUNDS',
          message: `Layer start_frame must be >= 0, got ${layer.start_frame}`,
        });
      }

      // Layer duration_frames > 0
      if (layer.duration_frames <= 0) {
        errors.push({
          pointer: `${layerPointer}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Layer duration_frames must be > 0, got ${layer.duration_frames}`,
        });
      }

      // Layer must fit inside scene timeline
      if (layer.start_frame + layer.duration_frames > scene.duration_frames) {
        errors.push({
          pointer: `${layerPointer}/duration_frames`,
          code: 'TIMELINE_BOUNDS',
          message: `Layer interval [${layer.start_frame}, ${layer.start_frame + layer.duration_frames}) exceeds scene duration (${scene.duration_frames})`,
        });
      }

      // Animation validation
      if (layer.animations && layer.animations.length > 0) {
        const animatedProperties = new Set<string>();
        for (let a = 0; a < layer.animations.length; a++) {
          const anim = layer.animations[a]!;
          const animPointer = `${layerPointer}/animations/${a}`;

          if (animatedProperties.has(anim.property)) {
            errors.push({
              pointer: `${animPointer}/property`,
              code: 'ANIMATION_CONFLICT',
              message: `Duplicate animation for property '${anim.property}' on layer '${layer.id}'`,
            });
          }
          animatedProperties.add(anim.property);

          // Keyframes bounds
          if (anim.keyframes.length < 2 || anim.keyframes.length > 64) {
            errors.push({
              pointer: `${animPointer}/keyframes`,
              code: 'TIMELINE_BOUNDS',
              message: `Animation keyframes count must be in [2, 64], got ${anim.keyframes.length}`,
            });
          }

          let prevFrame = -1;
          for (let k = 0; k < anim.keyframes.length; k++) {
            const kf = anim.keyframes[k]!;
            const kfPointer = `${animPointer}/keyframes/${k}`;
            if (kf.frame <= prevFrame) {
              errors.push({
                pointer: `${kfPointer}/frame`,
                code: 'TIMELINE_BOUNDS',
                message: `Animation keyframes must have strictly increasing frame numbers, got ${kf.frame} after ${prevFrame}`,
              });
            }
            if (kf.frame < 0 || kf.frame >= layer.duration_frames) {
              errors.push({
                pointer: `${kfPointer}/frame`,
                code: 'TIMELINE_BOUNDS',
                message: `Animation keyframe frame must be in [0, ${layer.duration_frames - 1}], got ${kf.frame}`,
              });
            }
            prevFrame = kf.frame;
          }
        }
      }

      // Content font verification
      if (layer.type === 'text' && 'font_id' in layer.content) {
        const fontId = layer.content.font_id;
        if (!fontIds.has(fontId)) {
          errors.push({
            pointer: `${layerPointer}/content/font_id`,
            code: 'UNKNOWN_FONT',
            message: `Text layer '${layer.id}' references unknown font_id '${fontId}'`,
          });
        } else if (layer.content.weight !== undefined) {
          const pinnedFont = fontMap.get(fontId);
          if (pinnedFont && pinnedFont.weight !== layer.content.weight) {
            warnings.push({
              pointer: `${layerPointer}/content/weight`,
              code: 'FONT_WEIGHT_MISMATCH',
              message: `Text layer weight (${layer.content.weight}) differs from pinned font weight (${pinnedFont.weight})`,
            });
          }
        }

        // Unicode normalization check on text content
        if (layer.content.text.normalize('NFC') !== layer.content.text) {
          warnings.push({
            pointer: `${layerPointer}/content/text`,
            code: 'UNICODE_NOT_NORMALIZED',
            message: `Text layer '${layer.id}' content text is not in canonical Unicode NFC form; will be normalized during compilation`,
          });
        }
      }
    }
  }
}
