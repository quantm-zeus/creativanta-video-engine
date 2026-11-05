/**
 * Core type definitions for browser export capabilities, codec support matrix,
 * legal/distribution compliance, and server-fallback decision logic.
 */

export type BrowserPlatform =
  | 'chrome-desktop'
  | 'firefox-desktop'
  | 'safari-desktop'
  | 'edge-desktop'
  | 'ios-safari'
  | 'android-chrome'
  | 'unknown';

export type PlatformFamily = 'desktop' | 'mobile';

export type BrowserEngine = 'blink' | 'webkit' | 'gecko' | 'unknown';

export type HardwareAccelerationState = 'prefer-hardware' | 'allow-software' | 'unavailable';

export type VideoCodecProfile =
  | 'avc1.42E01E' // H.264 Constrained Baseline Level 3.0
  | 'avc1.4D401F' // H.264 Main Profile Level 3.1
  | 'avc1.640028' // H.264 High Profile Level 4.0
  | 'vp09.00.10.08' // VP9 Profile 0 Level 3.1 8-bit
  | 'av01.0.04M.08' // AV1 Main Profile Level 3.0
  | 'hvc1.1.6.L93.B0'; // HEVC / H.265 Main Profile Level 3.1

export type AudioCodecProfile =
  | 'mp4a.40.2' // AAC-LC (MPEG-4 Audio Object Type 2)
  | 'opus'; // Opus interactive audio (RFC 6716)

export type ContainerFormat = 'mp4' | 'webm';

export interface BrowserCapabilityProfile {
  readonly platform: BrowserPlatform;
  readonly family: PlatformFamily;
  readonly engine: BrowserEngine;
  readonly hasWebCodecs: boolean;
  readonly hasVideoEncoder: boolean;
  readonly hasAudioEncoder: boolean;
  readonly hasVideoDecoder: boolean;
  readonly hasAudioDecoder: boolean;
  readonly hasOffscreenCanvas: boolean;
  readonly hasDedicatedWorker: boolean;
  readonly hasOpfs: boolean;
  readonly memoryBudgetMib: number;
  readonly maxDimensions: { readonly width: number; readonly height: number };
  readonly maxDurationFrames: number;
  readonly supportedVideoCodecs: readonly string[];
  readonly supportedAudioCodecs: readonly string[];
  readonly supportedContainers: readonly ContainerFormat[];
  readonly hardwareAcceleration: HardwareAccelerationState;
  readonly backgroundTabThrottling: boolean;
  readonly thermalThrottlingRisk: 'low' | 'medium' | 'high';
  readonly notes: string;
}

export type FallbackReasonCode =
  | 'UNSUPPORTED_BROWSER_PLATFORM'
  | 'MISSING_WEBCODECS_API'
  | 'MISSING_VIDEO_ENCODER'
  | 'MISSING_AUDIO_ENCODER'
  | 'UNSUPPORTED_VIDEO_CODEC'
  | 'UNSUPPORTED_AUDIO_CODEC'
  | 'EXCEEDS_MEMORY_BUDGET'
  | 'DIMENSIONS_EXCEED_PLATFORM_CAP'
  | 'CUSTOM_CODE_ENGINE_UNSUPPORTED'
  | 'SHIPPING_GATE_PENDING_REVIEW'
  | 'HIGH_THERMAL_OR_BACKGROUND_RISK';

export interface FeasibilityEvaluation {
  readonly feasible: boolean;
  readonly recommendedAction: 'export_locally' | 'fallback_to_server_job' | 'reject';
  readonly reasonCode?: FallbackReasonCode;
  readonly diagnostics: readonly string[];
  readonly fallbackJob?: {
    readonly compositionId?: string;
    readonly profile: string;
    readonly mode: 'render';
    readonly reason: string;
  };
}

export type PackageReviewVerdict =
  | 'CONDITIONALLY_ALLOWED_FOR_SPIKE'
  | 'BLOCKED'
  | 'AUDITED_CLIENT_DEPENDENCY';

export interface PackageReviewEntry {
  readonly name: string;
  readonly version: string;
  readonly gitHead?: string;
  readonly integritySha512: string;
  readonly shasum: string;
  readonly tarballUrl: string;
  readonly licenseSpdx: string;
  readonly distributionObligations: string;
  readonly hasLifecycleScripts: boolean;
  readonly noticeRequired: boolean;
  readonly sourceOfferRequired: boolean;
  readonly patentGrantClause: string;
  readonly verdict: PackageReviewVerdict;
  readonly usagePolicy: string;
  readonly findings: readonly string[];
}

export type ReviewGateStatus = 'pending_external_review' | 'approved_by_reviewer' | 'blocked';

export interface BrowserExportGateConfig {
  readonly gateId: 'EXT-P8-01' | 'EXT-P8-02';
  readonly status: ReviewGateStatus;
  readonly reviewer?: string;
  readonly signoffCommit?: string;
  readonly notes: string;
}

// =============================================================================
// Task P8-02: Browser Export Spike, Scoped Grants, Fallback, and Parity Types
// =============================================================================

export type SupportedSubsetLayerType = 'text' | 'image' | 'shape';
export type SupportedSubsetTransition = 'none' | 'fade' | 'crossfade';

export interface SceneSubsetValidation {
  readonly isSupported: boolean;
  readonly reasonCode?: FallbackReasonCode;
  readonly diagnostics: readonly string[];
  readonly unsupportedFeatures: readonly string[];
}

export interface ScopedAssetGrantPayload {
  readonly tenantId: string;
  readonly assetId: string;
  readonly version?: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly expiresAt: string; // ISO 8601 UTC
  readonly grantKind: 'download' | 'artifact_download' | 'browser_export_asset';
}

export interface ScopedAssetGrant extends ScopedAssetGrantPayload {
  readonly token: string;
  readonly downloadUrl: string;
  readonly sig: string;
}

export interface ScopedAssetCacheEntry {
  readonly tenantId: string;
  readonly assetId: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly data: Uint8Array;
  readonly cachedAt: string;
}

export interface IScopedAssetLoader {
  loadAsset(grantTokenOrUrl: string, expectedTenantId?: string): Promise<{ data: Uint8Array; mimeType: string; sha256: string }>;
  getCachedAsset(tenantId: string, assetId: string, expectedSha256: string): Uint8Array | null;
  cacheAsset(entry: ScopedAssetCacheEntry): void;
}

export interface AdmittedServerJob {
  readonly id: string;
  readonly kind: 'render' | 'preview';
  readonly state: 'queued' | 'admitted';
  readonly state_version: number;
  readonly composition_id: string;
  readonly revision: number;
  readonly profile: string;
  readonly created_at: string;
  readonly status_url: string;
  readonly isReplayed: boolean;
  readonly client_reference?: string;
}

export interface ServerJobDispatchPayload {
  readonly composition_id: string;
  readonly revision: number;
  readonly profile: string;
  readonly client_reference?: string;
  readonly metadata?: Record<string, string>;
}

export interface ServerJobFallbackResult {
  readonly action: 'fallback_to_server_job';
  readonly reasonCode: FallbackReasonCode;
  readonly diagnostics: readonly string[];
  readonly admittedJob: AdmittedServerJob;
  readonly idempotencyKey: string;
  readonly dispatchedAt: string;
}

export interface IServerJobDispatcher {
  dispatchRenderJob(payload: ServerJobDispatchPayload, idempotencyKey: string): Promise<AdmittedServerJob>;
}

export interface MemoryTrackerMetrics {
  readonly activeFramesCount: number;
  readonly peakFramesCount: number;
  readonly activeBufferBytes: number;
  readonly peakBufferBytes: number;
  readonly estimatedRawTotalBytes: number;
  readonly memoryBudgetMib: number;
  readonly budgetExceeded: boolean;
}

export interface BrowserExportProgress {
  readonly phase: 'validating' | 'staging_assets' | 'rendering_frames' | 'encoding' | 'muxing' | 'complete';
  readonly currentFrame: number;
  readonly totalFrames: number;
  readonly percent: number;
}

export interface BrowserExportOptions {
  readonly platform?: BrowserPlatform;
  readonly profile?: string;
  readonly compositionId?: string;
  readonly revision?: number;
  readonly tenantId?: string;
  readonly pepper?: string;
  readonly signal?: AbortSignal;
  readonly serverDispatcher?: IServerJobDispatcher;
  readonly assetLoader?: IScopedAssetLoader;
  readonly gateConfig?: BrowserExportGateConfig;
  readonly maxInFlightFrames?: number;
  readonly onProgress?: (progress: BrowserExportProgress) => void;
}

export interface BrowserExportSuccessResult {
  readonly action: 'export_locally';
  readonly blob: Blob | Uint8Array;
  readonly buffer: Uint8Array;
  readonly mimeType: string;
  readonly container: ContainerFormat;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
  readonly durationMs: number;
  readonly fps: { readonly num: number; readonly den: number };
  readonly memoryMetrics: MemoryTrackerMetrics;
  readonly exportedAt: string;
}

export type BrowserExportResult = BrowserExportSuccessResult | ServerJobFallbackResult;

export interface FrameParityCheck {
  readonly frameIndex: number;
  readonly ptsMicroseconds: number;
  readonly expectedPtsMicroseconds: number;
  readonly ptsParity: boolean;
  readonly pixelParity: boolean;
  readonly psnrDb?: number;
  readonly notes?: string;
}

export interface QualityParityReport {
  readonly compositionId: string;
  readonly width: number;
  readonly height: number;
  readonly totalFrames: number;
  readonly fps: { readonly num: number; readonly den: number };
  readonly durationParity: boolean;
  readonly timingParity: boolean;
  readonly dimensionParity: boolean;
  readonly visualParity: boolean;
  readonly averagePsnrDb: number;
  readonly frameChecks: readonly FrameParityCheck[];
  readonly verdict: 'PASS' | 'FAIL';
}
