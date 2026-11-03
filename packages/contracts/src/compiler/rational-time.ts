/**
 * Rational Time and Frame Math utilities for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md and docs/TESTING.md
 */

import { RationalFps } from '../types/scene.js';

/**
 * Computes greatest common divisor using Euclidean algorithm.
 */
export function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x;
}

/**
 * Simplifies a rational FPS to its lowest reduced form.
 */
export function simplifyRational(fps: RationalFps): RationalFps {
  if (fps.den === 0) {
    throw new Error('Denominator cannot be zero');
  }
  const divisor = gcd(fps.num, fps.den);
  const sign = fps.den < 0 ? -1 : 1;
  return {
    num: (sign * Math.trunc(fps.num)) / divisor,
    den: (sign * Math.trunc(fps.den)) / divisor,
  };
}

/**
 * Deterministic round-half-up for non-negative rationals using exact integer arithmetic.
 * formula: floor((2 * numerator + denominator) / (2 * denominator))
 */
export function roundHalfUpRational(numerator: number, denominator: number): number {
  if (denominator === 0) {
    throw new Error('Denominator cannot be zero');
  }
  if (numerator === 0) {
    return 0;
  }
  const n = Math.trunc(numerator);
  const d = Math.trunc(denominator);
  return Math.floor((2 * n + d) / (2 * d));
}

/**
 * Standard round-half-up for floating point values.
 */
export function roundHalfUp(val: number): number {
  return Math.floor(val + 0.5);
}

/**
 * Computes the exact timestamp in seconds for a global frame index k in [0, N).
 * Sample time is k * den / num.
 */
export function frameToSeconds(frame: number, fps: RationalFps): number {
  if (fps.num <= 0 || fps.den <= 0) {
    throw new Error('Invalid FPS');
  }
  return (frame * fps.den) / fps.num;
}

/**
 * Computes exact timestamp in milliseconds rounded half-up for subtitle sidecars.
 */
export function frameToMilliseconds(frame: number, fps: RationalFps): number {
  return roundHalfUpRational(frame * fps.den * 1000, fps.num);
}

/**
 * Computes exact audio sample offset at a frame boundary for standard 48kHz audio.
 * formula: round_half_up(f * den * sampleRate / num)
 */
export function frameToAudioSamples(
  frame: number,
  fps: RationalFps,
  sampleRate = 48000
): number {
  return roundHalfUpRational(frame * fps.den * sampleRate, fps.num);
}

/**
 * Computes the audio sample count for a segment [startFrame, endFrame) without cumulative rounding drift.
 * Takes the difference of absolute sample positions.
 */
export function audioSegmentSamples(
  startFrame: number,
  endFrame: number,
  fps: RationalFps,
  sampleRate = 48000
): number {
  const startSample = frameToAudioSamples(startFrame, fps, sampleRate);
  const endSample = frameToAudioSamples(endFrame, fps, sampleRate);
  return Math.max(0, endSample - startSample);
}

/**
 * Checks whether two half-open intervals [startA, endA) and [startB, endB) are contiguous without gap or overlap.
 */
export function isContiguousInterval(
  _startA: number,
  endA: number,
  startB: number,
  _endB: number
): boolean {
  return endA === startB;
}

/**
 * Checks whether two half-open intervals [startA, endA) and [startB, endB) overlap.
 */
export function intervalsOverlap(
  startA: number,
  endA: number,
  startB: number,
  endB: number
): boolean {
  return Math.max(startA, startB) < Math.min(endA, endB);
}
