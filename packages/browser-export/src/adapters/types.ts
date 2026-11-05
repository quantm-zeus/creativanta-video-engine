/**
 * Types and interfaces for Specialized Scene Engine Spikes & Adapters.
 * Evaluates VideoFlow, Revideo, Motion Canvas, and PixiJS against
 * Creativanta Video Engine requirements (docs/SCENE-SPEC.md, docs/ARCHITECTURE.md, docs/SECURITY.md).
 */

import {
  AnimationEasing,
  AnimationProperty,
  BoxSpec,
  TransformSpec
} from '@creativanta/contracts';

export type CandidateEngine = 'videoflow' | 'revideo' | 'motion-canvas' | 'pixijs';

export type AdrDecisionVerdict = 'selected' | 'deferred' | 'rejected';

export type SoftwareRasterizerType = 'swiftshader' | 'llvmpipe' | 'pure-cpu-dom';

export interface CpuBenchmarkMetrics {
  readonly engine: CandidateEngine;
  readonly fixtureName: string;
  readonly totalFrames: number;
  readonly durationMs: number;
  readonly rtf: number; // Real-Time Factor (duration / (totalFrames / fps))
  readonly cpuUtilizationPct: number;
  readonly peakRssMib: number;
  readonly coldStartMs: number;
  readonly softwareRasterizer: SoftwareRasterizerType;
  readonly physicalGpuRequired: false;
}

export interface LicenseAuditReport {
  readonly engine: CandidateEngine;
  readonly upstreamRepository: string;
  readonly pinnedReleaseOrCommit: string;
  readonly rootLicenseSpdx: 'Apache-2.0' | 'MIT';
  readonly copyleftContaminationRisk: 'none' | 'low' | 'medium' | 'high';
  readonly transitiveDependencyCount: number;
  readonly attributionRequirement: string;
  readonly commercialUseApproved: boolean;
  readonly notes: string;
}

export type SecurityIsolationRating =
  | 'SAFE_DECLARATIVE'
  | 'HIGH_ISOLATION_REQUIRED'
  | 'HIGH_CRASH_RISK';

export interface SecurityAuditReport {
  readonly engine: CandidateEngine;
  readonly rating: SecurityIsolationRating;
  readonly arbitraryCodeExecutionRisk: boolean;
  readonly requiresMicroVmIsolation: boolean;
  readonly webglShaderJitAttackSurface: boolean;
  readonly memoryLeakOrDosRisk: 'low' | 'medium' | 'high';
  readonly networkEgressControllable: boolean;
  readonly sandboxCompatibility: 'native_safe' | 'requires_gvisor_microvm' | 'unstable_in_headless_cpu';
  readonly findings: readonly string[];
}

export interface EngineScoreBreakdown {
  readonly correctnessAndDeterminism: number; // Max 30
  readonly cpuCostAndEfficiency: number;      // Max 25
  readonly securityAndTenantIsolation: number;// Max 20
  readonly maintainabilityAndIntegration: number; // Max 15
  readonly authoringModelAlignment: number;   // Max 10
  readonly totalScore: number;                 // Max 100
}

export interface EngineSpikeSummary {
  readonly engine: CandidateEngine;
  readonly displayName: string;
  readonly upstreamRepository: string;
  readonly rootLicense: string;
  readonly authoringParadigm: string;
  readonly cpuSoftwareViability: 'high' | 'moderate' | 'poor';
  readonly benchmarkRtfAvg: number;
  readonly peakRssMibAvg: number;
  readonly determinismGrade: 'EXACT' | 'GENERATOR_REPLAY' | 'TICKER_DRIFT';
  readonly securityRating: SecurityIsolationRating;
  readonly sceneSpecCompatibilityPct: number;
  readonly scores: EngineScoreBreakdown;
  readonly adrVerdict: AdrDecisionVerdict;
  readonly justification: string;
}

export interface EngineComparisonReport {
  readonly reportId: string;
  readonly task: 'P8-03';
  readonly evaluatedAt: string;
  readonly weights: {
    readonly correctnessAndDeterminismPct: 30;
    readonly cpuCostAndEfficiencyPct: 25;
    readonly securityAndTenantIsolationPct: 20;
    readonly maintainabilityAndIntegrationPct: 15;
    readonly authoringModelAlignmentPct: 10;
  };
  readonly engines: readonly EngineSpikeSummary[];
  readonly rankedOrder: readonly CandidateEngine[];
  readonly selectedInitialOptionalAdapter: CandidateEngine;
  readonly selectedCount: number;
  readonly adrDocumentPath: string;
  readonly summaryNotes: string;
}

// ========================================================================
// VideoFlow Adapter Schema and Model
// ========================================================================

export interface VideoFlowKeyframe {
  readonly frame: number;
  readonly value: number;
  readonly easing?: AnimationEasing;
}

export interface VideoFlowAnimation {
  readonly property: AnimationProperty;
  readonly keyframes: readonly VideoFlowKeyframe[];
}

export interface VideoFlowClip {
  readonly id: string;
  readonly layerId: string;
  readonly type: 'text' | 'image' | 'video' | 'shape' | 'svg';
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly zIndex: number;
  readonly box: BoxSpec;
  readonly transform?: TransformSpec;
  readonly opacity?: number;
  readonly animations?: readonly VideoFlowAnimation[];
  readonly content: Record<string, unknown>;
}

export interface VideoFlowAudioClip {
  readonly id: string;
  readonly trackId: string;
  readonly assetId: string;
  readonly startFrame: number;
  readonly durationFrames: number;
  readonly sourceInSamples: number;
  readonly gainDb: number;
  readonly role?: 'voice' | 'music' | 'effect';
  readonly fadeInFrames?: number;
  readonly fadeOutFrames?: number;
}

export interface VideoFlowTrack {
  readonly id: string;
  readonly type: 'visual' | 'audio' | 'overlay';
  readonly zIndex?: number;
  readonly clips: readonly (VideoFlowClip | VideoFlowAudioClip)[];
}

export interface VideoFlowTransition {
  readonly type: 'cut' | 'fade_to_background';
  readonly durationFrames: number;
  readonly fromSceneId: string;
  readonly toSceneId: string;
}

export interface VideoFlowComposition {
  readonly version: '1.0.0';
  readonly width: number;
  readonly height: number;
  readonly fps: { readonly num: number; readonly den: number };
  readonly durationFrames: number;
  readonly background?: string;
  readonly tracks: readonly VideoFlowTrack[];
  readonly transitions: readonly VideoFlowTransition[];
  readonly metadata: {
    readonly originalSource: 'creativanta-scene-spec-v1';
    readonly sceneCount: number;
    readonly totalLayers: number;
    readonly totalAudioTracks: number;
    readonly totalSubtitles: number;
  };
}

export interface VideoFlowAdapterOptions {
  readonly assetBaseUrl?: string;
  readonly allowSoftwareRasterization?: boolean;
  readonly maxDurationFrames?: number;
  readonly strictValidation?: boolean;
}

export interface AdapterFeasibilityResult {
  readonly feasible: boolean;
  readonly unsupportedFeatures: readonly string[];
  readonly reasonCode?: string;
}

export interface VideoFlowAdapterResult {
  readonly success: boolean;
  readonly composition: VideoFlowComposition;
  readonly warnings: readonly string[];
  readonly convertedScenesCount: number;
  readonly convertedLayersCount: number;
  readonly convertedAudioTracksCount: number;
  readonly convertedSubtitlesCount: number;
  readonly deterministicChecksumSha256: string;
}

export interface EvaluatedLayerSnapshot {
  readonly clipId: string;
  readonly layerId: string;
  readonly type: string;
  readonly active: boolean;
  readonly opacity: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotateDeg: number;
}

export interface VideoFlowEvaluatedFrame {
  readonly frameIndex: number;
  readonly timestampSeconds: number;
  readonly sceneBackground: string;
  readonly transitionAlpha: number;
  readonly activeLayers: readonly EvaluatedLayerSnapshot[];
  readonly activeAudioClipsCount: number;
  readonly frameChecksumSha256: string;
}
