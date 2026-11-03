/**
 * Deterministic Animation and Transition interpolation for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md
 */

import {
  AnimationEasing,
  AnimationSpec,
  KeyframeSpec,
  TransformSpec,
  TransitionOutSpec,
} from '../types/scene.js';

/**
 * Standard easing functions operating on normalized progress t in [0, 1].
 */
export function applyEasing(t: number, easing: AnimationEasing): number {
  const clampedT = Math.max(0, Math.min(1, t));
  switch (easing) {
    case 'linear':
      return clampedT;
    case 'ease_in_quad':
      return clampedT * clampedT;
    case 'ease_out_quad':
      return clampedT * (2 - clampedT);
    case 'ease_in_out_quad':
      return clampedT < 0.5
        ? 2 * clampedT * clampedT
        : -1 + (4 - 2 * clampedT) * clampedT;
    default:
      return clampedT;
  }
}

/**
 * Evaluates an animation at a given local layer frame index.
 * - Before first keyframe: holds first keyframe value.
 * - After last keyframe: holds last keyframe value.
 * - Between keyframes: interpolates using segment easing.
 */
export function evaluateKeyframes(
  keyframes: KeyframeSpec[],
  easing: AnimationEasing,
  localFrame: number
): number {
  if (keyframes.length === 0) {
    return 0;
  }
  if (keyframes.length === 1 || localFrame <= keyframes[0]!.frame) {
    return keyframes[0]!.value;
  }
  const lastIdx = keyframes.length - 1;
  if (localFrame >= keyframes[lastIdx]!.frame) {
    return keyframes[lastIdx]!.value;
  }

  // Find the active segment
  for (let i = 0; i < lastIdx; i++) {
    const k0 = keyframes[i]!;
    const k1 = keyframes[i + 1]!;
    if (localFrame >= k0.frame && localFrame <= k1.frame) {
      const segSpan = k1.frame - k0.frame;
      if (segSpan === 0) {
        return k0.value;
      }
      const rawProgress = (localFrame - k0.frame) / segSpan;
      const easedProgress = applyEasing(rawProgress, easing);
      return k0.value + (k1.value - k0.value) * easedProgress;
    }
  }

  return keyframes[lastIdx]!.value;
}

export interface EvaluatedAnimationState {
  opacity: number;
  transform: Required<TransformSpec>;
}

/**
 * Evaluates all layer animations at a given local frame, combining them with the base transform/opacity.
 */
export function evaluateLayerAnimations(
  animations: AnimationSpec[] | undefined,
  localFrame: number,
  baseTransform: Required<TransformSpec>,
  baseOpacity: number
): EvaluatedAnimationState {
  const resultTransform: Required<TransformSpec> = { ...baseTransform };
  let resultOpacity = baseOpacity;

  if (!animations || animations.length === 0) {
    return {
      opacity: resultOpacity,
      transform: resultTransform,
    };
  }

  for (const anim of animations) {
    const val = evaluateKeyframes(anim.keyframes, anim.easing, localFrame);
    switch (anim.property) {
      case 'opacity':
        resultOpacity = Math.max(0, Math.min(1, val));
        break;
      case 'translate_x':
        resultTransform.translate_x = val;
        break;
      case 'translate_y':
        resultTransform.translate_y = val;
        break;
      case 'scale_x':
        resultTransform.scale_x = Math.max(0.01, Math.min(100, val));
        break;
      case 'scale_y':
        resultTransform.scale_y = Math.max(0.01, Math.min(100, val));
        break;
      case 'rotate_deg':
        resultTransform.rotate_deg = val;
        break;
    }
  }

  return {
    opacity: resultOpacity,
    transform: resultTransform,
  };
}

export interface TransitionAlphaResult {
  sceneAlpha: number;
  transitionActive: boolean;
}

/**
 * Calculates the scene opacity alpha for transition_out at a global frame.
 * For 'cut': sceneAlpha = 1.0.
 * For 'fade_to_background':
 *   Takes F frames at the end of the scene: [sceneEnd - F, sceneEnd - 1].
 *   scene_alpha(k) = (sceneEnd - 1 - k) / (F - 1).
 *   For k < sceneEnd - F: sceneAlpha = 1.0.
 */
export function calculateTransitionAlpha(
  transition: TransitionOutSpec | undefined,
  sceneStartFrame: number,
  sceneDurationFrames: number,
  globalFrame: number
): TransitionAlphaResult {
  if (!transition || transition.type === 'cut' || transition.duration_frames === 0) {
    return { sceneAlpha: 1.0, transitionActive: false };
  }

  const F = transition.duration_frames;
  const sceneEnd = sceneStartFrame + sceneDurationFrames;
  const fadeStart = sceneEnd - F;

  if (globalFrame < fadeStart) {
    return { sceneAlpha: 1.0, transitionActive: false };
  }

  if (globalFrame >= sceneEnd) {
    return { sceneAlpha: 0.0, transitionActive: true };
  }

  if (F <= 1) {
    return { sceneAlpha: 0.0, transitionActive: true };
  }

  // Exact formula: (sceneEnd - 1 - k) / (F - 1)
  const alpha = (sceneEnd - 1 - globalFrame) / (F - 1);
  return {
    sceneAlpha: Math.max(0.0, Math.min(1.0, alpha)),
    transitionActive: true,
  };
}
