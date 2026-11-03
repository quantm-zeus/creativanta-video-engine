/**
 * Base Renderer Adapter implementation providing lifecycle management and verification.
 * Canonical specification: docs/SCENE-SPEC.md, docs/ARCHITECTURE.md
 */

import { CanonicalCompilerManifest } from '@creativanta/contracts';
import {
  RendererStatus,
  RendererPrepareOptions,
  FrameRenderResult,
  CapturedFrameBuffer,
  RandomSeekVerificationResult,
  FfmpegCommandOptions,
  FfmpegArgvResult,
  RendererSession,
} from '../types.js';

export abstract class BaseRendererSession implements RendererSession {
  protected status: RendererStatus = 'prepared';

  constructor(
    public readonly manifest: CanonicalCompilerManifest,
    public readonly options: RendererPrepareOptions
  ) {
    if (!manifest || !manifest.scenes || manifest.scenes.length === 0) {
      throw new Error('Cannot prepare renderer with invalid or empty manifest');
    }
  }

  public getStatus(): RendererStatus {
    return this.status;
  }

  protected assertActive(): void {
    if (this.status === 'disposed') {
      throw new Error('Renderer session is disposed. Cannot perform operations.');
    }
  }

  protected validateFrameIndex(frameIndex: number): void {
    if (
      !Number.isInteger(frameIndex) ||
      frameIndex < 0 ||
      frameIndex >= this.manifest.duration_frames
    ) {
      throw new RangeError(
        `Frame index ${frameIndex} out of valid range [0, ${this.manifest.duration_frames})`
      );
    }
  }

  public abstract seek(frameIndex: number): Promise<FrameRenderResult>;

  public abstract captureFrame(
    frameIndex: number,
    format?: 'png' | 'raw_rgba'
  ): Promise<CapturedFrameBuffer>;

  public async renderRange(
    startFrame: number,
    endFrame: number,
    onFrame?: (result: FrameRenderResult) => void
  ): Promise<FrameRenderResult[]> {
    this.assertActive();
    this.validateFrameIndex(startFrame);
    if (endFrame < startFrame || endFrame > this.manifest.duration_frames) {
      throw new RangeError(
        `Invalid endFrame ${endFrame}; must be in [${startFrame}, ${this.manifest.duration_frames}]`
      );
    }

    const previousStatus = this.status;
    this.status = 'rendering';
    const results: FrameRenderResult[] = [];

    try {
      for (let f = startFrame; f < endFrame; f++) {
        const frameResult = await this.seek(f);
        results.push(frameResult);
        if (onFrame) {
          onFrame(frameResult);
        }
      }
      return results;
    } finally {
      if (this.status === 'rendering') {
        this.status = previousStatus;
      }
    }
  }

  public async verifyRandomSeek(
    sampleFrames?: number[]
  ): Promise<RandomSeekVerificationResult> {
    this.assertActive();
    const duration = this.manifest.duration_frames;
    const defaultSamples = [
      0,
      Math.min(1, duration - 1),
      Math.floor(duration * 0.25),
      Math.floor(duration * 0.5),
      Math.floor(duration * 0.75),
      duration - 1,
    ];
    const uniqueSamples = Array.from(new Set(sampleFrames ?? defaultSamples)).filter(
      (f) => f >= 0 && f < duration
    );

    // Build a non-linear seek sequence that visits frames out of order and revisits them
    const seekSequence: number[] = [];
    for (let i = uniqueSamples.length - 1; i >= 0; i--) {
      seekSequence.push(uniqueSamples[i]!);
    }
    for (let i = 0; i < uniqueSamples.length; i += 2) {
      seekSequence.push(uniqueSamples[i]!);
    }
    for (let i = 1; i < uniqueSamples.length; i += 2) {
      seekSequence.push(uniqueSamples[i]!);
    }
    // Revisit frame 0 and last frame at the end
    seekSequence.push(0);
    seekSequence.push(duration - 1);

    const firstSeenChecksums = new Map<number, string>();
    const mismatches: Array<{ frameIndex: number; expectedChecksum: string; actualChecksum: string }> = [];
    let totalDurationMs = 0;

    for (const frameIdx of seekSequence) {
      const t0 = performance.now();
      const result = await this.seek(frameIdx);
      const elapsed = performance.now() - t0;
      totalDurationMs += elapsed;

      const checksum = result.checksumSha256;
      if (!firstSeenChecksums.has(frameIdx)) {
        firstSeenChecksums.set(frameIdx, checksum);
      } else {
        const expected = firstSeenChecksums.get(frameIdx)!;
        if (expected !== checksum) {
          mismatches.push({
            frameIndex: frameIdx,
            expectedChecksum: expected,
            actualChecksum: checksum,
          });
        }
      }
    }

    const passed = mismatches.length === 0;
    return {
      passed,
      framesTested: uniqueSamples,
      seekSequence,
      reproducible: passed,
      checksumMatches: passed,
      mismatches,
      averageSeekDurationMs: totalDurationMs / seekSequence.length,
    };
  }

  public abstract generateFfmpegCommand(options: FfmpegCommandOptions): FfmpegArgvResult;

  public async dispose(): Promise<void> {
    this.status = 'disposed';
  }
}
