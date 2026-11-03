/**
 * Common Renderer and Adapter interfaces for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md, docs/ARCHITECTURE.md, docs/SECURITY.md
 */

import { CanonicalCompilerManifest } from '@creativanta/contracts';

export type RendererName = 'chromium-frame-v1' | 'hyperframes-v1';
export type RendererStatus = 'uninitialized' | 'prepared' | 'rendering' | 'disposed';

export interface RendererPrepareOptions {
  width?: number;
  height?: number;
  fps?: { num: number; den: number };
  quality?: 'draft' | 'preview' | 'production';
  assetDirectory?: string;
  loopbackUrl?: string;
  disableSandboxedBrowser?: boolean;
  extraChromiumFlags?: string[];
  pixelFormat?: 'rgba' | 'rgb24';
}

export interface EvaluatedLayerSummary {
  layerId: string;
  type: string;
  zIndex: number;
  opacity: number;
  box: { x: number; y: number; width: number; height: number };
  transform: {
    translateX: number;
    translateY: number;
    scaleX: number;
    scaleY: number;
    rotateDeg: number;
  };
}

export interface FrameRenderResult {
  frameIndex: number;
  timestampSeconds: number;
  audioSampleOffset: number;
  sceneId: string;
  sceneRevision: number;
  sceneAlpha: number;
  transitionActive: boolean;
  activeLayerCount: number;
  evaluatedLayers: EvaluatedLayerSummary[];
  renderedWidth: number;
  renderedHeight: number;
  checksumSha256: string;
  domSnapshot?: string;
  durationMs: number;
}

export interface CapturedFrameBuffer {
  frameIndex: number;
  format: 'png' | 'raw_rgba';
  width: number;
  height: number;
  buffer: Buffer;
  checksumSha256: string;
  byteLength: number;
}

export interface FfmpegCommandOptions {
  inputPatternOrPipe?: string;
  outputPath: string;
  audioTrackFiles?: Record<string, string>;
  fontDirectory?: string;
  subtitleFilePath?: string;
  burnInSubtitles?: boolean;
  crf?: number;
  preset?: 'ultrafast' | 'fast' | 'medium' | 'slow';
  profile?: 'mp4-720p-v1' | 'preview-360p-v1';
}

export interface FfmpegArgvResult {
  argv: string[];
  commandLine: string;
  audioTracksIncluded: number;
  subtitlesIncluded: boolean;
  protocolWhitelist: string;
}

export interface RandomSeekVerificationResult {
  passed: boolean;
  framesTested: number[];
  seekSequence: number[];
  reproducible: boolean;
  checksumMatches: boolean;
  mismatches: Array<{ frameIndex: number; expectedChecksum: string; actualChecksum: string }>;
  averageSeekDurationMs: number;
}

export interface HyperFramesBlockerItem {
  id: string;
  title: string;
  severity: 'CRITICAL_BLOCKER' | 'HIGH_RISK' | 'LEGAL_BLOCKER';
  component: string;
  description: string;
  reproducerOrEvidence: string;
  recommendation: string;
}

export interface HyperFramesBlockerReport {
  evaluatedAt: string;
  status: 'BLOCKED' | 'PASS';
  candidate: 'hyperframes-v1';
  blockers: HyperFramesBlockerItem[];
  summary: string;
  transitionRecommendation: string;
}

export interface AdapterComparisonResult {
  manifestId: string;
  durationFrames: number;
  chromiumBaseline: {
    name: string;
    status: string;
    framesRendered: number;
    sampleChecksums: Record<number, string>;
    randomSeekPassed: boolean;
    audioCfrSupported: boolean;
    zeroEgressCompliant: boolean;
    commercialLicenseRisk: boolean;
  };
  hyperframesSpike: {
    name: string;
    status: string;
    framesRendered: number;
    sampleChecksums: Record<number, string>;
    randomSeekPassed: boolean;
    audioCfrSupported: boolean;
    zeroEgressCompliant: boolean;
    commercialLicenseRisk: boolean;
    blockerReport: HyperFramesBlockerReport;
  };
  stateParityFrames: number[];
  parityPercentage: number;
  recommendation: 'chromium-frame-v1' | 'hyperframes-v1';
}

export interface RendererAdapter {
  readonly name: RendererName;
  readonly version: string;
  readonly engineType: string;
  prepare(manifest: CanonicalCompilerManifest, options?: RendererPrepareOptions): Promise<RendererSession>;
}

export interface RendererSession {
  readonly manifest: CanonicalCompilerManifest;
  readonly options: RendererPrepareOptions;
  getStatus(): RendererStatus;
  seek(frameIndex: number): Promise<FrameRenderResult>;
  captureFrame(frameIndex: number, format?: 'png' | 'raw_rgba'): Promise<CapturedFrameBuffer>;
  renderRange(startFrame: number, endFrame: number, onFrame?: (result: FrameRenderResult) => void): Promise<FrameRenderResult[]>;
  verifyRandomSeek(sampleFrames?: number[]): Promise<RandomSeekVerificationResult>;
  generateFfmpegCommand(options: FfmpegCommandOptions): FfmpegArgvResult;
  dispose(): Promise<void>;
}
