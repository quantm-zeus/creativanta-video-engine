/**
 * TTS & Audio Fallback Interface Types and Contracts.
 * Conforms to Creativanta Video Engine specification:
 * - docs/IMPLEMENTATION_PLAN.md (P5-02)
 * - docs/ARCHITECTURE.md (Line 107: TTS asset provenance before render admission)
 * - docs/SECURITY.md (Line 59: Abuse policy, terms review, voice consent)
 * - docs/SCENE-SPEC.md (Line 86-87: 48kHz audio track normalization)
 */

export type TtsAudioFormat = 'wav-48k-pcm16' | 'mp3' | 'ogg';

export type TtsVoiceGender = 'male' | 'female' | 'neutral';

export interface TtsVoiceDefinition {
  id: string;
  name: string;
  locale: string;
  gender: TtsVoiceGender;
  providerId: string;
  modelId: string;
  sampleRate: number;
  channels: number;
  description: string;
  supportedStyles?: string[];
}

export interface TtsSynthesisRequest {
  text: string;
  locale: 'vi-VN' | 'en-US' | string;
  voiceId?: string;
  speechRate?: number; // 0.5 to 2.0 (default 1.0)
  pitch?: number; // -20.0 to +20.0 semitones (default 0.0)
  volumeDb?: number; // -60 to +12 dB (default 0.0)
  outputFormat?: TtsAudioFormat; // default 'wav-48k-pcm16'
  targetFps?: number; // default 30
  tenantId?: string;
  requestId?: string;
}

export interface TtsProvenance {
  assetId: string;
  provider: string;
  model: string;
  modelVersion: string;
  voiceId: string;
  voiceName: string;
  locale: string;
  inputTextSha256: string;
  characterCount: number;
  wordCount: number;
  audioSha256: string;
  audioByteLength: number;
  durationSeconds: number;
  durationFrames: number;
  sampleRate: number;
  channels: number;
  termsReviewStatus: 'reviewed_approved' | 'unreviewed' | 'revoked';
  termsReviewId: string;
  termsReviewedBy: string;
  termsReviewedAt: string;
  voiceConsentBasis: 'commercial_licensed' | 'open_weights_permissive' | 'contract_authorized';
  impersonationProhibited: boolean;
  synthesizedAt: string;
  billableCharacters: number;
  estimatedCostUsd: number;
}

export interface TtsSynthesisResult {
  assetId: string;
  audioBuffer: Buffer;
  audioSha256: string;
  byteLength: number;
  durationSeconds: number;
  durationFrames: number;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  provenance: TtsProvenance;
  fromCache: boolean;
  synthesisDurationMs: number;
}

export type LicenseBasis = 'commercial_licensed' | 'open_weights_permissive' | 'contract_authorized';

export interface TermsReviewEntry {
  reviewId: string;
  providerId: string;
  modelId: string;
  voiceId: string;
  locale: string;
  commercialTermsReviewed: boolean;
  commercialTermsAccepted: boolean;
  voiceConsentVerified: boolean;
  impersonationProhibited: boolean;
  dataExfiltrationGuarded: boolean;
  licenseBasis: LicenseBasis;
  reviewedBy: string;
  reviewedAt: string;
  expiresAt: string;
  status: 'active' | 'revoked' | 'expired';
  notes: string;
}

export interface TtsBudgetConfig {
  maxCharactersPerRequest: number;
  maxCharactersPerTenantPerMonth?: number;
  defaultTimeoutMs: number;
  hardMaxTimeoutMs: number;
  costPer1kCharsUsd: number;
}

export interface TtsCacheStats {
  hits: number;
  misses: number;
  entriesCount: number;
  totalBytes: number;
}

export interface TtsCache {
  get(key: string): Promise<TtsSynthesisResult | null>;
  set(key: string, result: TtsSynthesisResult, ttlMs?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  getStats(): TtsCacheStats;
}

export interface TtsAdapter {
  providerId: string;
  providerName: string;
  supportedLocales: string[];
  getAvailableVoices(): Promise<TtsVoiceDefinition[]>;
  synthesize(
    request: TtsSynthesisRequest,
    signal?: AbortSignal
  ): Promise<{
    audioBuffer: Buffer;
    durationSeconds: number;
    sampleRate: number;
    channels: number;
    model: string;
    modelVersion: string;
    voiceName: string;
  }>;
  estimateCost(characters: number): number;
}

export interface TtsService {
  synthesize(request: TtsSynthesisRequest, timeoutMs?: number): Promise<TtsSynthesisResult>;
  getAdapter(providerId?: string): TtsAdapter | undefined;
  listAvailableVoices(locale?: string): Promise<TtsVoiceDefinition[]>;
}

export interface AudioFallbackConfig {
  ttsEnabled: boolean;
  allowFallbackToUpload: boolean;
  requireTermsReview: boolean;
}

export interface AudioTrackResolutionRequest {
  trackId: string;
  role?: 'voice' | 'music' | 'effect';
  ttsSpec?: {
    text: string;
    locale: string;
    voiceId?: string;
    speechRate?: number;
    pitch?: number;
    volumeDb?: number;
  };
  uploadFallbackAssetId?: string;
  startFrame?: number;
  durationFrames?: number;
  gainDb?: number;
  tenantId?: string;
}

export type FallbackReason =
  | 'TTS_DISABLED'
  | 'SYNTHESIS_FAILED'
  | 'BUDGET_EXCEEDED'
  | 'TIMEOUT'
  | 'UNREVIEWED_TERMS'
  | 'TEXT_EMPTY';

export interface ResolvedAudioTrack {
  trackId: string;
  assetId: string;
  source: 'tts' | 'upload_fallback' | 'direct_upload';
  fallbackEngaged: boolean;
  fallbackReason?: FallbackReason;
  durationSeconds: number;
  durationFrames: number;
  gainDb: number;
  provenance?: TtsProvenance;
  audioBuffer?: Buffer;
}

// Error Classes
export class TtsError extends Error {
  code: string;
  statusCode: number;
  details?: Record<string, unknown>;

  constructor(message: string, code: string, statusCode = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class TermsNotReviewedError extends TtsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'UNREVIEWED_PROVIDER_TERMS', 422, details);
    this.name = 'TermsNotReviewedError';
  }
}

export class TtsBudgetExceededError extends TtsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TTS_BUDGET_EXCEEDED', 429, details);
    this.name = 'TtsBudgetExceededError';
  }
}

export class TtsTimeoutError extends TtsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'TTS_TIMEOUT', 504, details);
    this.name = 'TtsTimeoutError';
  }
}

export class TtsSynthesisError extends TtsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SYNTHESIS_FAILED', 502, details);
    this.name = 'TtsSynthesisError';
  }
}

export class AudioResolutionError extends TtsError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'AUDIO_ASSET_UNRESOLVABLE', 422, details);
    this.name = 'AudioResolutionError';
  }
}
