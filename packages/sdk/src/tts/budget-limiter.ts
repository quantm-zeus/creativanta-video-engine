/**
 * TTS Budget & Timeout Limiter.
 * Enforces per-request and per-tenant character limits, spend caps, and synthesis timeouts.
 * Specification: docs/IMPLEMENTATION_PLAN.md (P5-02), docs/SECURITY.md (Line 57).
 */

import {
  TtsBudgetConfig,
  TtsBudgetExceededError,
  TtsTimeoutError,
} from './types.js';

export interface TenantUsageRecord {
  tenantId: string;
  month: string; // 'YYYY-MM'
  totalCharacters: number;
  totalSyntheses: number;
  totalCostUsd: number;
  lastSynthesizedAt: string;
}

export class TtsBudgetLimiter {
  private config: TtsBudgetConfig;
  private tenantUsage = new Map<string, TenantUsageRecord>();

  constructor(config?: Partial<TtsBudgetConfig>) {
    this.config = {
      maxCharactersPerRequest: 5000,
      maxCharactersPerTenantPerMonth: 100000,
      defaultTimeoutMs: 5000,
      hardMaxTimeoutMs: 15000,
      costPer1kCharsUsd: 0.015,
      ...config,
    };
  }

  private currentMonthKey(tenantId: string): string {
    const d = new Date();
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return `${tenantId}::${ym}`;
  }

  public getConfig(): TtsBudgetConfig {
    return { ...this.config };
  }

  public estimateCost(characterCount: number): number {
    return Math.round((characterCount / 1000) * this.config.costPer1kCharsUsd * 1000000) / 1000000;
  }

  /**
   * Pre-flight checks character count and tenant budget.
   * Throws TtsBudgetExceededError if limits are breached.
   */
  public checkBudget(tenantId: string, characterCount: number): { estimatedCostUsd: number; remainingBudget: number } {
    if (characterCount <= 0) {
      throw new Error('TTS text must not be empty');
    }

    if (characterCount > this.config.maxCharactersPerRequest) {
      throw new TtsBudgetExceededError(
        `TTS request exceeds maximum allowed characters per request (${characterCount} > ${this.config.maxCharactersPerRequest})`,
        {
          characterCount,
          maxAllowed: this.config.maxCharactersPerRequest,
          tenantId,
        }
      );
    }

    const key = this.currentMonthKey(tenantId);
    const usage = this.tenantUsage.get(key) || {
      tenantId,
      month: key.split('::')[1] ?? '',
      totalCharacters: 0,
      totalSyntheses: 0,
      totalCostUsd: 0,
      lastSynthesizedAt: new Date().toISOString(),
    };

    const monthlyLimit = this.config.maxCharactersPerTenantPerMonth ?? Infinity;
    if (usage.totalCharacters + characterCount > monthlyLimit) {
      const remaining = Math.max(0, monthlyLimit - usage.totalCharacters);
      throw new TtsBudgetExceededError(
        `TTS request would exceed tenant monthly character budget (${usage.totalCharacters + characterCount} > ${monthlyLimit}). Remaining: ${remaining} chars.`,
        {
          tenantId,
          requestedCharacters: characterCount,
          currentMonthlyUsage: usage.totalCharacters,
          monthlyLimit,
          remainingCharacters: remaining,
        }
      );
    }

    const estimatedCostUsd = this.estimateCost(characterCount);
    const remainingBudget = Math.max(0, monthlyLimit - (usage.totalCharacters + characterCount));

    return { estimatedCostUsd, remainingBudget };
  }

  /**
   * Records committed characters and spend after successful synthesis.
   */
  public recordUsage(tenantId: string, characterCount: number): TenantUsageRecord {
    const key = this.currentMonthKey(tenantId);
    const usage = this.tenantUsage.get(key) || {
      tenantId,
      month: key.split('::')[1] ?? '',
      totalCharacters: 0,
      totalSyntheses: 0,
      totalCostUsd: 0,
      lastSynthesizedAt: new Date().toISOString(),
    };

    usage.totalCharacters += characterCount;
    usage.totalSyntheses += 1;
    usage.totalCostUsd += this.estimateCost(characterCount);
    usage.lastSynthesizedAt = new Date().toISOString();

    this.tenantUsage.set(key, usage);
    return { ...usage };
  }

  public getTenantUsage(tenantId: string): TenantUsageRecord | undefined {
    const key = this.currentMonthKey(tenantId);
    const rec = this.tenantUsage.get(key);
    return rec ? { ...rec } : undefined;
  }

  /**
   * Creates an AbortSignal bounded by timeoutMs (or defaultTimeoutMs).
   * Automatically clears timer on cleanup.
   */
  public createTimeoutSignal(requestedTimeoutMs?: number): {
    signal: AbortSignal;
    cleanup: () => void;
    effectiveTimeoutMs: number;
  } {
    const controller = new AbortController();
    let timeoutMs = requestedTimeoutMs ?? this.config.defaultTimeoutMs;
    if (timeoutMs > this.config.hardMaxTimeoutMs) {
      timeoutMs = this.config.hardMaxTimeoutMs;
    }
    if (timeoutMs <= 0) {
      timeoutMs = this.config.defaultTimeoutMs;
    }

    const timer = setTimeout(() => {
      controller.abort(
        new TtsTimeoutError(`TTS synthesis timed out after ${timeoutMs}ms`, {
          timeoutMs,
        })
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
    };

    return {
      signal: controller.signal,
      cleanup,
      effectiveTimeoutMs: timeoutMs,
    };
  }
}
