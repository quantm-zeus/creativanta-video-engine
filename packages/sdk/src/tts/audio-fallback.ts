/**
 * Audio Track Fallback Resolver.
 * Implements the core upload audio fallback strategy when TTS is disabled, fails, or exceeds budget.
 * Specification: docs/ARCHITECTURE.md (Line 107), docs/DEPLOYMENT.md (Line 94), docs/IMPLEMENTATION_PLAN.md (P5-02).
 */

import {
  AudioTrackResolutionRequest,
  ResolvedAudioTrack,
  AudioResolutionError,
  FallbackReason,
  TtsService,
  TtsSynthesisResult,
} from './types.js';

export interface AudioFallbackResolverOptions {
  ttsService?: TtsService;
  ttsEnabled?: boolean;
}

export class AudioFallbackResolver {
  private ttsService?: TtsService;
  private ttsEnabled: boolean;

  constructor(options?: AudioFallbackResolverOptions) {
    this.ttsService = options?.ttsService;
    // Default follows CVE_TTS_PROVIDER !== 'disabled'
    this.ttsEnabled = options?.ttsEnabled ?? false;
  }

  public setTtsEnabled(enabled: boolean): void {
    this.ttsEnabled = enabled;
  }

  public isTtsEnabled(): boolean {
    return this.ttsEnabled;
  }

  public setTtsService(service: TtsService): void {
    this.ttsService = service;
  }

  /**
   * Resolves an audio track request, falling back to uploaded audio when TTS is unavailable.
   */
  public async resolveAudioTrack(
    request: AudioTrackResolutionRequest,
    fallbackAssetMetadata?: { durationSeconds: number; durationFrames: number }
  ): Promise<ResolvedAudioTrack> {
    const gainDb = request.gainDb ?? 0.0;

    // 1. Direct upload track (no TTS requested)
    if (!request.ttsSpec || !request.ttsSpec.text || request.ttsSpec.text.trim().length === 0) {
      if (!request.uploadFallbackAssetId) {
        throw new AudioResolutionError(
          `Audio track '${request.trackId}' has neither TTS specification nor upload asset ID.`,
          { trackId: request.trackId }
        );
      }
      return {
        trackId: request.trackId,
        assetId: request.uploadFallbackAssetId,
        source: 'direct_upload',
        fallbackEngaged: false,
        durationSeconds: fallbackAssetMetadata?.durationSeconds ?? 0,
        durationFrames: fallbackAssetMetadata?.durationFrames ?? 0,
        gainDb,
      };
    }

    // 2. TTS requested, but TTS provider is disabled globally / by config
    if (!this.ttsEnabled) {
      if (!request.uploadFallbackAssetId) {
        throw new AudioResolutionError(
          `TTS is currently disabled (CVE_TTS_PROVIDER=disabled) and no upload audio fallback asset ID was provided for track '${request.trackId}'.`,
          {
            trackId: request.trackId,
            reason: 'TTS_DISABLED_NO_FALLBACK',
          }
        );
      }

      return {
        trackId: request.trackId,
        assetId: request.uploadFallbackAssetId,
        source: 'upload_fallback',
        fallbackEngaged: true,
        fallbackReason: 'TTS_DISABLED',
        durationSeconds: fallbackAssetMetadata?.durationSeconds ?? 0,
        durationFrames: fallbackAssetMetadata?.durationFrames ?? 0,
        gainDb,
      };
    }

    // 3. TTS is enabled: attempt synthesis with fallback protection
    if (!this.ttsService) {
      if (!request.uploadFallbackAssetId) {
        throw new AudioResolutionError(
          `TTS service is not configured and no upload fallback asset is available for track '${request.trackId}'.`,
          { trackId: request.trackId }
        );
      }
      return {
        trackId: request.trackId,
        assetId: request.uploadFallbackAssetId,
        source: 'upload_fallback',
        fallbackEngaged: true,
        fallbackReason: 'TTS_DISABLED',
        durationSeconds: fallbackAssetMetadata?.durationSeconds ?? 0,
        durationFrames: fallbackAssetMetadata?.durationFrames ?? 0,
        gainDb,
      };
    }

    try {
      const synthResult: TtsSynthesisResult = await this.ttsService.synthesize({
        text: request.ttsSpec.text,
        locale: (request.ttsSpec.locale as 'vi-VN' | 'en-US') || 'vi-VN',
        voiceId: request.ttsSpec.voiceId,
        speechRate: request.ttsSpec.speechRate,
        pitch: request.ttsSpec.pitch,
        volumeDb: request.ttsSpec.volumeDb ?? request.gainDb,
        tenantId: request.tenantId,
      });

      return {
        trackId: request.trackId,
        assetId: synthResult.assetId,
        source: 'tts',
        fallbackEngaged: false,
        durationSeconds: synthResult.durationSeconds,
        durationFrames: synthResult.durationFrames,
        gainDb,
        provenance: synthResult.provenance,
        audioBuffer: synthResult.audioBuffer,
      };
    } catch (err: unknown) {
      // If synthesis fails, inspect error and evaluate upload fallback
      let fallbackReason: FallbackReason = 'SYNTHESIS_FAILED';
      const errorObj = err as { code?: string; name?: string };

      if (errorObj.code === 'UNREVIEWED_PROVIDER_TERMS' || errorObj.code === 'VOICE_CONSENT_UNVERIFIED') {
        fallbackReason = 'UNREVIEWED_TERMS';
      } else if (errorObj.code === 'TTS_BUDGET_EXCEEDED') {
        fallbackReason = 'BUDGET_EXCEEDED';
      } else if (errorObj.code === 'TTS_TIMEOUT') {
        fallbackReason = 'TIMEOUT';
      }

      // If fallback asset ID exists, engage fallback safely
      if (request.uploadFallbackAssetId) {
        return {
          trackId: request.trackId,
          assetId: request.uploadFallbackAssetId,
          source: 'upload_fallback',
          fallbackEngaged: true,
          fallbackReason,
          durationSeconds: fallbackAssetMetadata?.durationSeconds ?? 0,
          durationFrames: fallbackAssetMetadata?.durationFrames ?? 0,
          gainDb,
        };
      }

      // No fallback provided: re-throw error to client
      throw err;
    }
  }
}
