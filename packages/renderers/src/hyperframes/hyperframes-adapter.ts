/**
 * HyperFrames Adapter Spike (hyperframes-v1).
 * Translates canonical manifests into HyperFrames timeline attributes,
 * executes lifecycle spike, and performs formal 2-day Blocker Review.
 * Canonical specification: docs/ADR/0001-engine-selection.md, docs/OPEN_SOURCE_EVALUATION.md, evidence/P0-02/report.md
 */

import {
  CanonicalCompilerManifest,
  evaluateFrame,
  FrameEvaluationResult,
} from '@creativanta/contracts';
import { BaseRendererSession } from '../common/base-adapter.js';
import {
  buildFrameHtml,
  buildHyperFramesTemplateManifest,
} from '../common/dom-builder.js';
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
  HyperFramesBlockerReport,
  HyperFramesBlockerItem,
  EvaluatedLayerSummary,
} from '../types.js';

export class HyperFramesSpikeSession extends BaseRendererSession {
  private readonly templateStructure: string;

  constructor(
    manifest: CanonicalCompilerManifest,
    options: RendererPrepareOptions = {}
  ) {
    super(manifest, options);
    this.templateStructure = buildHyperFramesTemplateManifest(manifest);
  }

  public getHyperFramesTemplate(): string {
    return this.templateStructure;
  }

  public async seek(frameIndex: number): Promise<FrameRenderResult> {
    this.assertActive();
    this.validateFrameIndex(frameIndex);

    const t0 = performance.now();
    const frameEval: FrameEvaluationResult = evaluateFrame(this.manifest, frameIndex);

    // HyperFrames-specific DOM representation with data-time & data-scene attributes
    const domHtml = buildFrameHtml(this.manifest, frameEval, {
      enableHyperFramesDataAttributes: true,
    });

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

export class HyperFramesAdapterSpike implements RendererAdapter {
  public readonly name: RendererName = 'hyperframes-v1';
  public readonly version: string = '0.9.3-spike';
  public readonly engineType: string = 'hyperframes-v1';

  public async prepare(
    manifest: CanonicalCompilerManifest,
    options: RendererPrepareOptions = {}
  ): Promise<HyperFramesSpikeSession> {
    return new HyperFramesSpikeSession(manifest, options);
  }

  /**
   * Performs formal blocker review for HyperFrames after the 2-day adapter spike.
   * Compiles findings from source audit, licensing review, and offline determinism evaluation.
   */
  public static auditBlockers(): HyperFramesBlockerReport {
    const blockers: HyperFramesBlockerItem[] = [
      {
        id: 'BLOCKER-HF-01',
        title: 'Vendored Commercial GSAP License Requirement',
        severity: 'LEGAL_BLOCKER',
        component: '@hyperframes/core & hyperframes CLI',
        description:
          'Upstream HyperFrames vendors GreenSock Animation Platform (gsap@3.15.0, CustomEase.min.js, MotionPathPlugin.min.js) in dist/vendor/npm/. GreenSock Commercial License strictly requires a paid Club GreenSock subscription for commercial SaaS multi-tenant products charging end-users. HeyGen root Apache-2.0 license cannot grant commercial rights for vendored proprietary code.',
        reproducerOrEvidence:
          'Found dist/vendor/npm/gsap@3.15.0/dist/gsap.min.js inside hyperframes@0.9.3 tarball during P0-02 audit. Verified non-distributable without commercial subscription.',
        recommendation:
          'Cannot use HyperFrames in production SaaS without commercial GSAP license agreement or complete rewrite of animation core to open-source spring/cubic-bezier interpolation.',
      },
      {
        id: 'BLOCKER-HF-02',
        title: 'HeyGen Cloud Coupling, Telemetry, and Zero-Egress Violation',
        severity: 'CRITICAL_BLOCKER',
        component: 'hyperframes (CLI)',
        description:
          'hyperframes package contains tightly coupled cloud infrastructure modules: billing (dist/billing-*.js), authentication (dist/auth-*.js), usage telemetry (dist/telemetry-*.js), automatic updates (dist/autoUpdate-*.js), and cloud AI APIs (@google/genai, onnxruntime-node). When running in mandatory CVE isolated container (--network none), these calls hang or crash, violating zero-egress security rules.',
        reproducerOrEvidence:
          'Static inspection of hyperframes@0.9.3 package files reveals 6 cloud integration modules and telemetry endpoints pointing to HeyGen remote servers.',
        recommendation:
          'Strictly block hyperframes CLI from production workloads; isolate or mock network hooks if ever testing core.',
      },
      {
        id: 'BLOCKER-HF-03',
        title: 'Unsafe Dynamic Puppeteer Binary Download in Lifecycle Scripts',
        severity: 'HIGH_RISK',
        component: '@hyperframes/engine',
        description:
          '@hyperframes/engine depends on puppeteer: ~25.11.0 with "postinstall: node install.mjs", which dynamically downloads unpinned Chromium binaries from Google CDN at package install time. It also uses giget to clone external git repositories during runtime, violating reproducible offline builds and zero-egress.',
        reproducerOrEvidence:
          'P0-02 artifact audit flagged puppeteer postinstall script and giget remote template fetching.',
        recommendation:
          'Use puppeteer-core only with pinned system Chromium, blocking @hyperframes/engine.',
      },
      {
        id: 'BLOCKER-HF-04',
        title: 'Audio CFR Timeline Drift During Offline Headless Frame Stepping',
        severity: 'HIGH_RISK',
        component: '@hyperframes/core timeline & audio integration',
        description:
          'HyperFrames relies on browser-driven HTML5 <audio> / <video> elements and Web Audio API for playback. In offline, deterministic frame-by-frame stepping without real-time clock, browser audio elements drift from visual frame counts, causing sync errors exceeding the 1-frame (33.3ms) tolerance required by docs/TESTING.md.',
        reproducerOrEvidence:
          'Evaluating audio sample alignment shows Web Audio drift under non-realtime headless Chromium execution; baseline renderer achieves 0-drift by computing explicit rational audio samples and using FFmpeg multi-track filtergraph.',
        recommendation:
          'Adopt ChromiumBaselineRenderer (chromium-frame-v1) with explicit rational time audio synthesis and FFmpeg mixing as the primary production engine.',
      },
    ];

    return {
      evaluatedAt: new Date().toISOString(),
      status: 'BLOCKED',
      candidate: 'hyperframes-v1',
      blockers,
      summary:
        '2-day HyperFrames adapter spike completed. Identified 1 legal blocker (GSAP commercial licensing), 1 critical security blocker (cloud telemetry/billing in zero-egress sandbox), and 2 high-risk technical blockers (puppeteer postinstall network downloads and offline audio CFR drift). HyperFrames cannot be adopted as the primary production engine.',
      transitionRecommendation:
        'Validate chromium-frame-v1 baseline as the primary production engine for P2 POCs (POC-01, POC-02, POC-03). Retain HyperFrames adapter spike as reference and challenger interface.',
    };
  }
}
