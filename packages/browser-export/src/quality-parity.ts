/**
 * Quality Parity Evaluation Engine (Task P8-02).
 *
 * Implements acceptance requirement: "memory/cancel/download/quality parity tests".
 * Validates output quality, timing determinism, and visual fidelity of the browser export spike
 * against the authoritative server baseline (docs/SCENE-SPEC.md, docs/TESTING.md).
 *
 * Quality Invariants:
 * 1. Frame Count Parity: totalFrames === spec.duration_frames (zero dropped/extra frames).
 * 2. CFR Timestamp Monotonicity: PTS(k) = k * (fps.den / fps.num) * 1,000,000 us without drift.
 * 3. Dimension Parity: export width/height === canvas width/height.
 * 4. Alpha Blending Invariant: layer_alpha(k) * scene_alpha(k).
 * 5. Visual Fidelity: PSNR >= 38 dB across sampled keyframes against server reference.
 */

import type {
  FrameParityCheck,
  QualityParityReport,
} from './types.js';

export interface ReferenceFrameData {
  readonly frameIndex: number;
  readonly ptsMicroseconds: number;
  readonly width: number;
  readonly height: number;
  /** RGBA sample pixel array or representative color hash */
  readonly samplePixels?: readonly number[];
}

export interface BrowserExportFrameData {
  readonly frameIndex: number;
  readonly ptsMicroseconds: number;
  readonly width: number;
  readonly height: number;
  readonly samplePixels?: readonly number[];
}

/**
 * Computes Peak Signal-to-Noise Ratio (PSNR) in dB between two RGBA pixel arrays.
 */
export function computePsnrDb(
  pixelsA: readonly number[],
  pixelsB: readonly number[],
): number {
  if (pixelsA.length !== pixelsB.length || pixelsA.length === 0) {
    return 0;
  }

  let sumSquaredError = 0;
  for (let i = 0; i < pixelsA.length; i++) {
    const diff = (pixelsA[i] ?? 0) - (pixelsB[i] ?? 0);
    sumSquaredError += diff * diff;
  }

  const mse = sumSquaredError / pixelsA.length;
  if (mse === 0) {
    return 100; // Perfect mathematical identity
  }

  const maxVal = 255;
  const psnr = 10 * Math.log10((maxVal * maxVal) / mse);
  return Number(psnr.toFixed(2));
}

/**
 * Evaluates Quality Parity between a browser export result and the authoritative server baseline.
 */
export function evaluateQualityParity(params: {
  compositionId: string;
  expectedFps: { num: number; den: number };
  expectedDurationFrames: number;
  expectedWidth: number;
  expectedHeight: number;
  exportedFrames: readonly BrowserExportFrameData[];
  referenceFrames?: readonly ReferenceFrameData[];
}): QualityParityReport {
  const {
    compositionId,
    expectedFps,
    expectedDurationFrames,
    expectedWidth,
    expectedHeight,
    exportedFrames,
    referenceFrames,
  } = params;

  // 1. Frame Count Parity
  const durationParity = exportedFrames.length === expectedDurationFrames;

  // 2. Dimension Parity
  const dimensionParity = exportedFrames.every(
    (f) => f.width === expectedWidth && f.height === expectedHeight,
  );

  // 3. Timing & PTS Progression Parity (CFR timebase)
  const frameDurationUs = (expectedFps.den / expectedFps.num) * 1_000_000;
  const frameChecks: FrameParityCheck[] = [];
  let timingParity = true;
  let visualParity = true;
  let totalPsnr = 0;
  let psnrCount = 0;

  for (let i = 0; i < exportedFrames.length; i++) {
    const frame = exportedFrames[i]!;
    const expectedPts = Math.round(i * frameDurationUs);
    const ptsDelta = Math.abs(frame.ptsMicroseconds - expectedPts);
    const ptsOk = ptsDelta <= 1; // Strict 1-microsecond rounding threshold

    if (!ptsOk) {
      timingParity = false;
    }

    let pixelParity = true;
    let psnrDb: number | undefined;

    if (referenceFrames && referenceFrames[i]) {
      const ref = referenceFrames[i]!;
      if (ref.samplePixels && frame.samplePixels) {
        psnrDb = computePsnrDb(frame.samplePixels, ref.samplePixels);
        totalPsnr += psnrDb;
        psnrCount += 1;
        // Quality threshold: >= 38 dB is broadcast quality parity
        if (psnrDb < 38) {
          pixelParity = false;
          visualParity = false;
        }
      }
    }

    frameChecks.push({
      frameIndex: i,
      ptsMicroseconds: frame.ptsMicroseconds,
      expectedPtsMicroseconds: expectedPts,
      ptsParity: ptsOk,
      pixelParity,
      psnrDb,
      notes: ptsOk ? undefined : `PTS drift: ${ptsDelta}us (actual ${frame.ptsMicroseconds}, expected ${expectedPts})`,
    });
  }

  const averagePsnrDb = psnrCount > 0 ? Number((totalPsnr / psnrCount).toFixed(2)) : 100;
  const verdict = durationParity && dimensionParity && timingParity && visualParity ? 'PASS' : 'FAIL';

  return {
    compositionId,
    width: expectedWidth,
    height: expectedHeight,
    totalFrames: exportedFrames.length,
    fps: expectedFps,
    durationParity,
    timingParity,
    dimensionParity,
    visualParity,
    averagePsnrDb,
    frameChecks,
    verdict,
  };
}

/**
 * Validates the Scene Spec 1.0 Alpha Blending Invariant:
 * effective_opacity(layer, frame) === layer_alpha * scene_alpha
 */
export function verifyAlphaBlendingInvariant(
  layerOpacity: number,
  sceneOpacity: number,
  computedOpacity: number,
): boolean {
  const expected = Number((layerOpacity * sceneOpacity).toFixed(4));
  const actual = Number(computedOpacity.toFixed(4));
  return Math.abs(expected - actual) <= 0.001;
}
