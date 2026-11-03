/**
 * Chromium Baseline Renderer Adapter (chromium-frame-v1).
 * Independent deterministic frame capture & FFmpeg compilation pipeline.
 * Canonical specification: docs/ADR/0001-engine-selection.md, docs/SCENE-SPEC.md, docs/SECURITY.md
 */

import {
  CanonicalCompilerManifest,
  evaluateFrame,
  FrameEvaluationResult,
} from '@creativanta/contracts';
import { BaseRendererSession } from '../common/base-adapter.js';
import { buildFrameHtml } from '../common/dom-builder.js';
import { rasterizeFrame } from '../common/frame-capture.js';
import { buildFfmpegCommand } from '../common/ffmpeg-builder.js';
import {
  RendererAdapter,
  RendererName,
  RendererPrepareOptions,
  FrameRenderResult,
  CapturedFrameBuffer,
  FfmpegCommandOptions,
  FfmpegArgvResult,
  EvaluatedLayerSummary,
} from '../types.js';

export class ChromiumBaselineSession extends BaseRendererSession {
  private readonly defaultChromiumFlags: readonly string[] = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--mute-audio',
    '--run-all-compositor-stages-before-draw',
    '--disable-extensions',
    '--remote-debugging-port=0',
  ];

  constructor(
    manifest: CanonicalCompilerManifest,
    options: RendererPrepareOptions = {}
  ) {
    super(manifest, options);
    this.validateRuntimeConfiguration();
  }

  private validateRuntimeConfiguration(): void {
    const extraFlags = this.options.extraChromiumFlags || [];
    for (const flag of extraFlags) {
      if (flag === '--no-sandbox' || flag === '--disable-setuid-sandbox') {
        throw new Error(
          `Security violation: "${flag}" is strictly prohibited by CVE sandbox policy.`
        );
      }
    }
  }

  public getChromiumSandboxArgs(): string[] {
    const flags = [...this.defaultChromiumFlags];
    if (this.options.extraChromiumFlags) {
      for (const f of this.options.extraChromiumFlags) {
        if (!flags.includes(f)) {
          flags.push(f);
        }
      }
    }
    return flags;
  }

  public async seek(frameIndex: number): Promise<FrameRenderResult> {
    this.assertActive();
    this.validateFrameIndex(frameIndex);

    const t0 = performance.now();
    const frameEval: FrameEvaluationResult = evaluateFrame(this.manifest, frameIndex);

    // Build DOM representation
    const domHtml = buildFrameHtml(this.manifest, frameEval);

    // Rasterize frame for checksum verification
    const captured = rasterizeFrame(this.manifest, frameEval, 'png');

    const durationMs = performance.now() - t0;

    const evaluatedLayers: EvaluatedLayerSummary[] = frameEval.layers.map((l) => ({
      layerId: l.layer_id,
      type: l.type,
      zIndex: l.z_index,
      opacity: l.opacity,
      box: l.box,
      transform: {
        translateX: l.transform.translate_x,
        translateY: l.transform.translate_y,
        scaleX: l.transform.scale_x,
        scaleY: l.transform.scale_y,
        rotateDeg: l.transform.rotate_deg,
      },
    }));

    return {
      frameIndex,
      timestampSeconds: frameEval.timestamp_seconds,
      audioSampleOffset: frameEval.audio_sample_offset,
      sceneId: frameEval.scene.id,
      sceneRevision: frameEval.scene.revision,
      sceneAlpha: frameEval.scene.scene_alpha,
      transitionActive: frameEval.scene.transition_active,
      activeLayerCount: frameEval.layers.length,
      evaluatedLayers,
      renderedWidth: this.manifest.canvas.width,
      renderedHeight: this.manifest.canvas.height,
      checksumSha256: captured.checksumSha256,
      domSnapshot: domHtml,
      durationMs,
    };
  }

  public async captureFrame(
    frameIndex: number,
    format: 'png' | 'raw_rgba' = 'png'
  ): Promise<CapturedFrameBuffer> {
    this.assertActive();
    this.validateFrameIndex(frameIndex);

    const frameEval = evaluateFrame(this.manifest, frameIndex);
    return rasterizeFrame(this.manifest, frameEval, format);
  }

  public generateFfmpegCommand(options: FfmpegCommandOptions): FfmpegArgvResult {
    this.assertActive();
    return buildFfmpegCommand(this.manifest, options);
  }
}

export class ChromiumBaselineRenderer implements RendererAdapter {
  public readonly name: RendererName = 'chromium-frame-v1';
  public readonly version: string = '0.1.0';
  public readonly engineType: string = 'chromium-frame-v1';

  public async prepare(
    manifest: CanonicalCompilerManifest,
    options: RendererPrepareOptions = {}
  ): Promise<ChromiumBaselineSession> {
    return new ChromiumBaselineSession(manifest, options);
  }
}
