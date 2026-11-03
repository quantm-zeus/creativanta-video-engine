/**
 * Central TTS Orchestration Service.
 * Manages provider adapters, legal terms review gates, budget & timeout limits,
 * content-addressable cache, and asset provenance records.
 * Specification: docs/ARCHITECTURE.md (Line 107), docs/SECURITY.md (Line 59), docs/IMPLEMENTATION_PLAN.md (P5-02).
 */

import { createHash } from 'node:crypto';
import {
  TtsService,
  TtsAdapter,
  TtsSynthesisRequest,
  TtsSynthesisResult,
  TtsVoiceDefinition,
  TtsProvenance,
  TtsError,
  TtsCache,
} from './types.js';
import { TermsReviewRegistry } from './terms-registry.js';
import { TtsBudgetLimiter } from './budget-limiter.js';
import { MemoryTtsCache, computeTtsCacheKey } from './tts-cache.js';
import { OfflineTtsAdapter } from './offline-synthesizer.js';

export interface TtsServiceOptions {
  termsRegistry?: TermsReviewRegistry;
  budgetLimiter?: TtsBudgetLimiter;
  cache?: TtsCache;
  defaultAdapter?: TtsAdapter;
}

export class TtsServiceImpl implements TtsService {
  private adapters = new Map<string, TtsAdapter>();
  private defaultProviderId: string;
  public readonly termsRegistry: TermsReviewRegistry;
  public readonly budgetLimiter: TtsBudgetLimiter;
  public readonly cache: TtsCache;

  constructor(options?: TtsServiceOptions) {
    this.termsRegistry = options?.termsRegistry ?? new TermsReviewRegistry(true);
    this.budgetLimiter = options?.budgetLimiter ?? new TtsBudgetLimiter();
    this.cache = options?.cache ?? new MemoryTtsCache();

    const offline = options?.defaultAdapter ?? new OfflineTtsAdapter();
    this.registerAdapter(offline);
    this.defaultProviderId = offline.providerId;
  }

  public registerAdapter(adapter: TtsAdapter): void {
    this.adapters.set(adapter.providerId.toLowerCase(), adapter);
  }

  public getAdapter(providerId?: string): TtsAdapter | undefined {
    const id = (providerId || this.defaultProviderId).toLowerCase();
    return this.adapters.get(id);
  }

  public setDefaultProvider(providerId: string): void {
    if (!this.adapters.has(providerId.toLowerCase())) {
      throw new Error(`Cannot set default provider '${providerId}': adapter not registered`);
    }
    this.defaultProviderId = providerId.toLowerCase();
  }

  /**
   * Lists all available voices across registered adapters.
   */
  public async listAvailableVoices(locale?: string): Promise<TtsVoiceDefinition[]> {
    const results: TtsVoiceDefinition[] = [];
    for (const adapter of this.adapters.values()) {
      const voices = await adapter.getAvailableVoices();
      for (const v of voices) {
        if (!locale || v.locale.toLowerCase() === locale.toLowerCase()) {
          results.push(v);
        }
      }
    }
    return results;
  }

  /**
   * Synthesizes audio with full terms review gate, budget checks, cache lookup,
   * timeout boundary, and provenance generation.
   */
  public async synthesize(
    request: TtsSynthesisRequest,
    timeoutMs?: number
  ): Promise<TtsSynthesisResult> {
    const startTime = Date.now();

    if (!request.text || request.text.trim().length === 0) {
      throw new TtsError('TTS text must not be empty', 'EMPTY_TEXT', 400);
    }

    const normText = request.text.normalize('NFC').trim();
    const charCount = normText.length;
    const wordCount = normText.split(/\s+/).length;
    const inputTextSha256 = createHash('sha256').update(normText, 'utf8').digest('hex');
    const tenantId = request.tenantId || 'tenant_default';
    const targetFps = request.targetFps || 30;

    // 1. Locate adapter and resolve target voice
    const adapter = this.getAdapter();
    if (!adapter) {
      throw new TtsError('No TTS adapter available', 'NO_ADAPTER', 500);
    }

    const availableVoices = await adapter.getAvailableVoices();
    const voice =
      availableVoices.find((v) => v.id.toLowerCase() === (request.voiceId || '').toLowerCase()) ||
      availableVoices.find((v) => v.locale.toLowerCase() === (request.locale || 'vi-VN').toLowerCase()) ||
      availableVoices[0];

    if (!voice) {
      throw new TtsError(`No matching voice found for locale '${request.locale}'`, 'VOICE_NOT_FOUND', 404);
    }

    // 2. LEGAL TERMS GATE: assert provider/model/voice terms are reviewed and approved
    // In accordance with docs/SECURITY.md (Line 59) and docs/IMPLEMENTATION_PLAN.md (P5-02)
    const review = this.termsRegistry.assertVoiceApproved(
      adapter.providerId,
      voice.modelId,
      voice.id
    );

    // 3. BUDGET & SPEND LIMITS
    const { estimatedCostUsd } = this.budgetLimiter.checkBudget(tenantId, charCount);

    // 4. CONTENT-ADDRESSABLE CACHE LOOKUP
    const cacheKey = computeTtsCacheKey(adapter.providerId, voice.modelId, voice.id, {
      ...request,
      text: normText,
      voiceId: voice.id,
      targetFps,
    });

    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // 5. EXECUTE SYNTHESIS UNDER TIMEOUT
    const { signal, cleanup } = this.budgetLimiter.createTimeoutSignal(timeoutMs);

    let synthOutput: {
      audioBuffer: Buffer;
      durationSeconds: number;
      sampleRate: number;
      channels: number;
      model: string;
      modelVersion: string;
      voiceName: string;
    };

    try {
      synthOutput = await adapter.synthesize(
        {
          ...request,
          text: normText,
          voiceId: voice.id,
          targetFps,
        },
        signal
      );
    } finally {
      cleanup();
    }

    const synthesisDurationMs = Date.now() - startTime;

    // 6. PROCESS AUDIO & COMPUTE PROVENANCE
    const audioBuffer = synthOutput.audioBuffer;
    const audioSha256 = createHash('sha256').update(audioBuffer).digest('hex');
    const assetId = `ast_tts_${audioSha256.substring(0, 16)}`;
    const durationFrames = Math.ceil(synthOutput.durationSeconds * targetFps);

    const provenance: TtsProvenance = {
      assetId,
      provider: adapter.providerId,
      model: synthOutput.model,
      modelVersion: synthOutput.modelVersion,
      voiceId: voice.id,
      voiceName: synthOutput.voiceName,
      locale: voice.locale,
      inputTextSha256,
      characterCount: charCount,
      wordCount,
      audioSha256,
      audioByteLength: audioBuffer.length,
      durationSeconds: synthOutput.durationSeconds,
      durationFrames,
      sampleRate: synthOutput.sampleRate,
      channels: synthOutput.channels,
      termsReviewStatus: 'reviewed_approved',
      termsReviewId: review.reviewId,
      termsReviewedBy: review.reviewedBy,
      termsReviewedAt: review.reviewedAt,
      voiceConsentBasis: review.licenseBasis,
      impersonationProhibited: review.impersonationProhibited,
      synthesizedAt: new Date().toISOString(),
      billableCharacters: charCount,
      estimatedCostUsd,
    };

    const result: TtsSynthesisResult = {
      assetId,
      audioBuffer,
      audioSha256,
      byteLength: audioBuffer.length,
      durationSeconds: synthOutput.durationSeconds,
      durationFrames,
      sampleRate: synthOutput.sampleRate,
      channels: synthOutput.channels,
      bitDepth: 16,
      provenance,
      fromCache: false,
      synthesisDurationMs,
    };

    // 7. RECORD TENANT USAGE & STORE IN CACHE
    this.budgetLimiter.recordUsage(tenantId, charCount);
    await this.cache.set(cacheKey, result);

    return result;
  }
}
