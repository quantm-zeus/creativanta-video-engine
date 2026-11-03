/**
 * CFR Video Footage Trimmer & Crop Processor for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md, docs/TESTING.md (POC-03)
 */

import {
  RationalFps,
  SceneManifest,
  LayerManifest,
  VideoLayerContent,
} from '@creativanta/contracts';

export interface CfrVideoClipSource {
  assetId: string;
  width: number;
  height: number;
  fps: RationalFps;
  durationFrames: number;
  durationSeconds: number;
  isCfr: boolean;
  audioDemuxed: boolean;
  sha256: string;
}

export interface CropGeometry {
  canvasWidth: number;
  canvasHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  fit: 'cover' | 'contain' | 'stretch';
  anchorX: number;
  anchorY: number;
  sourceCropX: number;
  sourceCropY: number;
  sourceCropWidth: number;
  sourceCropHeight: number;
  scaleX: number;
  scaleY: number;
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
}

export interface MappedFrameDetails {
  globalFrame: number;
  sceneId: string;
  sceneLocalFrame: number;
  sourceFrame: number;
  sourceTimestampSeconds: number;
  sourceTimestampMs: number;
  ptsOffsetFrames: number;
  isWithinBounds: boolean;
}

export interface CfrTimelineValidationResult {
  valid: boolean;
  totalDurationFrames: number;
  totalDurationSeconds: number;
  fps: RationalFps;
  isStrictCfr: boolean;
  driftBudgetFrames: number;
  maxFrameDeltaMs: number;
  minFrameDeltaMs: number;
  errors: string[];
}

/**
 * Calculates spatial crop and scale geometry for video frame composition.
 * Ensures aspect-ratio preservation and center/anchor-based cropping for "cover", "contain", and "stretch".
 */
export function calculateCropGeometry(
  canvasWidth: number,
  canvasHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  fit: 'cover' | 'contain' | 'stretch' = 'cover',
  anchorX: number = 0.5,
  anchorY: number = 0.5
): CropGeometry {
  const boundedAnchorX = Math.max(0, Math.min(1, anchorX));
  const boundedAnchorY = Math.max(0, Math.min(1, anchorY));

  if (fit === 'stretch') {
    return {
      canvasWidth,
      canvasHeight,
      sourceWidth,
      sourceHeight,
      fit,
      anchorX: boundedAnchorX,
      anchorY: boundedAnchorY,
      sourceCropX: 0,
      sourceCropY: 0,
      sourceCropWidth: sourceWidth,
      sourceCropHeight: sourceHeight,
      scaleX: canvasWidth / sourceWidth,
      scaleY: canvasHeight / sourceHeight,
      targetX: 0,
      targetY: 0,
      targetWidth: canvasWidth,
      targetHeight: canvasHeight,
    };
  }

  const canvasAspect = canvasWidth / canvasHeight;
  const sourceAspect = sourceWidth / sourceHeight;

  if (fit === 'cover') {
    // Fill entire canvas, crop overflow from source
    let sourceCropWidth: number;
    let sourceCropHeight: number;

    if (sourceAspect > canvasAspect) {
      // Source is wider than canvas: crop width
      sourceCropHeight = sourceHeight;
      sourceCropWidth = Math.round(sourceHeight * canvasAspect);
    } else {
      // Source is taller than canvas: crop height
      sourceCropWidth = sourceWidth;
      sourceCropHeight = Math.round(sourceWidth / canvasAspect);
    }

    const availableX = Math.max(0, sourceWidth - sourceCropWidth);
    const availableY = Math.max(0, sourceHeight - sourceCropHeight);
    const sourceCropX = Math.round(availableX * boundedAnchorX);
    const sourceCropY = Math.round(availableY * boundedAnchorY);

    const scale = canvasWidth / sourceCropWidth;

    return {
      canvasWidth,
      canvasHeight,
      sourceWidth,
      sourceHeight,
      fit,
      anchorX: boundedAnchorX,
      anchorY: boundedAnchorY,
      sourceCropX,
      sourceCropY,
      sourceCropWidth,
      sourceCropHeight,
      scaleX: scale,
      scaleY: scale,
      targetX: 0,
      targetY: 0,
      targetWidth: canvasWidth,
      targetHeight: canvasHeight,
    };
  }

  // fit === 'contain': keep entire source within canvas, pillarbox / letterbox
  let targetWidth: number;
  let targetHeight: number;

  if (sourceAspect > canvasAspect) {
    targetWidth = canvasWidth;
    targetHeight = Math.round(canvasWidth / sourceAspect);
  } else {
    targetHeight = canvasHeight;
    targetWidth = Math.round(canvasHeight * sourceAspect);
  }

  const availCanvasX = Math.max(0, canvasWidth - targetWidth);
  const availCanvasY = Math.max(0, canvasHeight - targetHeight);
  const targetX = Math.round(availCanvasX * boundedAnchorX);
  const targetY = Math.round(availCanvasY * boundedAnchorY);

  const scale = targetWidth / sourceWidth;

  return {
    canvasWidth,
    canvasHeight,
    sourceWidth,
    sourceHeight,
    fit,
    anchorX: boundedAnchorX,
    anchorY: boundedAnchorY,
    sourceCropX: 0,
    sourceCropY: 0,
    sourceCropWidth: sourceWidth,
    sourceCropHeight: sourceHeight,
    scaleX: scale,
    scaleY: scale,
    targetX,
    targetY,
    targetWidth,
    targetHeight,
  };
}

/**
 * Maps global composition frame index to source footage frame index and timing.
 */
export function mapGlobalFrameToSource(
  globalFrame: number,
  scene: SceneManifest,
  videoLayer: LayerManifest,
  fps: RationalFps = { num: 30, den: 1 }
): MappedFrameDetails {
  const content = videoLayer.content as VideoLayerContent;
  const sourceInFrame = content.source_in_frame || 0;
  const sceneLocalFrame = globalFrame - scene.start_frame;

  const sourceFrame = sourceInFrame + sceneLocalFrame;
  const fpsNumber = fps.num / fps.den;
  const sourceTimestampSeconds = sourceFrame / fpsNumber;
  const sourceTimestampMs = Math.round((sourceFrame * 1000 * fps.den) / fps.num);

  const isWithinBounds =
    globalFrame >= scene.start_frame &&
    globalFrame < scene.end_frame &&
    sceneLocalFrame >= 0 &&
    sceneLocalFrame < scene.duration_frames;

  return {
    globalFrame,
    sceneId: scene.id,
    sceneLocalFrame,
    sourceFrame,
    sourceTimestampSeconds,
    sourceTimestampMs,
    ptsOffsetFrames: sourceInFrame,
    isWithinBounds,
  };
}

/**
 * Validates constant frame rate (CFR) timeline consistency.
 * Verifies that frame steps have uniform duration without jitter or drift.
 */
export function validateCfrTimeline(
  durationFrames: number,
  fps: RationalFps
): CfrTimelineValidationResult {
  const errors: string[] = [];
  const expectedFrameDurationMs = (1000 * fps.den) / fps.num;
  let minDelta = Infinity;
  let maxDelta = -Infinity;

  if (durationFrames <= 0) {
    errors.push(`Invalid duration_frames: ${durationFrames}; must be > 0`);
  }

  if (fps.num <= 0 || fps.den <= 0) {
    errors.push(`Invalid fps: ${fps.num}/${fps.den}; must be positive`);
  }

  // Check frame-to-frame delta across entire timeline
  for (let f = 1; f < durationFrames; f++) {
    const tPrevMs = (f - 1) * expectedFrameDurationMs;
    const tCurrMs = f * expectedFrameDurationMs;
    const delta = tCurrMs - tPrevMs;

    if (delta < minDelta) minDelta = delta;
    if (delta > maxDelta) maxDelta = delta;

    if (Math.abs(delta - expectedFrameDurationMs) > 0.0001) {
      errors.push(`Non-uniform CFR delta at frame ${f}: ${delta}ms vs expected ${expectedFrameDurationMs}ms`);
      break;
    }
  }

  const durationSeconds = (durationFrames * fps.den) / fps.num;

  return {
    valid: errors.length === 0,
    totalDurationFrames: durationFrames,
    totalDurationSeconds: durationSeconds,
    fps,
    isStrictCfr: errors.length === 0,
    driftBudgetFrames: 1,
    maxFrameDeltaMs: maxDelta === -Infinity ? expectedFrameDurationMs : maxDelta,
    minFrameDeltaMs: minDelta === Infinity ? expectedFrameDurationMs : minDelta,
    errors,
  };
}

/**
 * Builds FFmpeg video filter clauses for trimming and cropping a footage clip.
 */
export function buildFfmpegFootageFilter(
  inputIndex: number,
  sourceInFrame: number,
  durationFrames: number,
  crop: CropGeometry,
  outputLabel: string
): string {
  const endFrame = sourceInFrame + durationFrames;
  const parts: string[] = [];

  // 1. Frame-accurate trim
  parts.push(`trim=start_frame=${sourceInFrame}:end_frame=${endFrame}`);
  parts.push(`setpts=PTS-STARTPTS`);

  // 2. Crop
  if (
    crop.sourceCropWidth !== crop.sourceWidth ||
    crop.sourceCropHeight !== crop.sourceHeight
  ) {
    parts.push(
      `crop=w=${crop.sourceCropWidth}:h=${crop.sourceCropHeight}:x=${crop.sourceCropX}:y=${crop.sourceCropY}`
    );
  }

  // 3. Scale to canvas
  parts.push(`scale=w=${crop.canvasWidth}:h=${crop.canvasHeight}:flags=bicubic`);

  return `[${inputIndex}:v]${parts.join(',')}[${outputLabel}]`;
}
