/**
 * Per-Tenant and Per-API-Key Token-Bucket Rate Limiter (Task P4-01).
 *
 * Canonical specifications:
 *   - docs/PRD.md (line 108: Request rate limit 1 token/s refill, burst 20)
 *   - docs/ARCHITECTURE.md (line 18: token-bucket request rate, cap per API key <= cap tenant)
 *   - docs/API.md (lines 165, 169: 429 RATE_LIMITED with Retry-After and X-Request-Id)
 */

export const DEFAULT_TOKEN_BUCKET_REFILL_PER_SECOND = 1;
export const DEFAULT_TOKEN_BUCKET_BURST_CAPACITY = 20;

export interface TokenBucketLimits {
  refillPerSecond: number;
  burstCapacity: number;
}

export interface RateLimitConsumeInput {
  tenantId: string;
  keyId?: string;
  tenantLimits?: Partial<TokenBucketLimits>;
  keyLimits?: Partial<TokenBucketLimits>;
  cost?: number;
  nowMs?: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  tenantRemainingTokens: number;
  keyRemainingTokens: number;
  limitedBy?: 'tenant' | 'api_key';
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  refillPerSecond: number;
  burstCapacity: number;
}

export class TokenBucketRateLimiter {
  private readonly tenantBuckets = new Map<string, BucketState>();
  private readonly keyBuckets = new Map<string, BucketState>();
  private readonly defaultRefillPerSecond: number;
  private readonly defaultBurstCapacity: number;
  private nowFn: () => number;

  constructor(
    options: {
      defaultRefillPerSecond?: number;
      defaultBurstCapacity?: number;
      nowFn?: () => number;
    } = {},
  ) {
    this.defaultRefillPerSecond =
      options.defaultRefillPerSecond ?? DEFAULT_TOKEN_BUCKET_REFILL_PER_SECOND;
    this.defaultBurstCapacity =
      options.defaultBurstCapacity ?? DEFAULT_TOKEN_BUCKET_BURST_CAPACITY;
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public setNowFn(nowFn: () => number): void {
    this.nowFn = nowFn;
  }

  public reset(tenantId?: string): void {
    if (!tenantId) {
      this.tenantBuckets.clear();
      this.keyBuckets.clear();
      return;
    }
    this.tenantBuckets.delete(tenantId);
    for (const compositeKey of this.keyBuckets.keys()) {
      if (compositeKey.startsWith(`${tenantId}:`)) {
        this.keyBuckets.delete(compositeKey);
      }
    }
  }

  public consume(input: RateLimitConsumeInput): RateLimitDecision {
    const nowMs = input.nowMs ?? this.nowFn();
    const cost = Math.max(1, input.cost ?? 1);

    const tenantRefill = Math.max(
      0.001,
      input.tenantLimits?.refillPerSecond ?? this.defaultRefillPerSecond,
    );
    const tenantBurst = Math.max(
      1,
      input.tenantLimits?.burstCapacity ?? this.defaultBurstCapacity,
    );

    // Per docs/ARCHITECTURE.md line 18: cap per API key <= cap tenant
    const keyRefill = Math.min(
      tenantRefill,
      Math.max(0.001, input.keyLimits?.refillPerSecond ?? tenantRefill),
    );
    const keyBurst = Math.min(
      tenantBurst,
      Math.max(1, input.keyLimits?.burstCapacity ?? tenantBurst),
    );

    const tenantBucket = this.getOrRefillBucket(
      this.tenantBuckets,
      input.tenantId,
      tenantRefill,
      tenantBurst,
      nowMs,
    );

    const compositeKeyId = input.keyId ? `${input.tenantId}:${input.keyId}` : null;
    const keyBucket = compositeKeyId
      ? this.getOrRefillBucket(this.keyBuckets, compositeKeyId, keyRefill, keyBurst, nowMs)
      : null;

    const tenantShortfall = cost - tenantBucket.tokens;
    const keyShortfall = keyBucket ? cost - keyBucket.tokens : 0;

    if (tenantShortfall > 0 || keyShortfall > 0) {
      const tenantWaitSec =
        tenantShortfall > 0 ? Math.ceil(tenantShortfall / tenantBucket.refillPerSecond) : 0;
      const keyWaitSec =
        keyBucket && keyShortfall > 0 ? Math.ceil(keyShortfall / keyBucket.refillPerSecond) : 0;
      const retryAfterSeconds = Math.max(1, tenantWaitSec, keyWaitSec);
      const limitedBy: 'tenant' | 'api_key' =
        keyWaitSec > tenantWaitSec ? 'api_key' : 'tenant';

      return {
        allowed: false,
        retryAfterSeconds,
        tenantRemainingTokens: Math.floor(Math.max(0, tenantBucket.tokens)),
        keyRemainingTokens: keyBucket
          ? Math.floor(Math.max(0, keyBucket.tokens))
          : Math.floor(Math.max(0, tenantBucket.tokens)),
        limitedBy,
      };
    }

    // Both tenant and API key buckets have sufficient tokens; deduct atomically
    tenantBucket.tokens -= cost;
    if (keyBucket) {
      keyBucket.tokens -= cost;
    }

    return {
      allowed: true,
      retryAfterSeconds: 0,
      tenantRemainingTokens: Math.floor(Math.max(0, tenantBucket.tokens)),
      keyRemainingTokens: keyBucket
        ? Math.floor(Math.max(0, keyBucket.tokens))
        : Math.floor(Math.max(0, tenantBucket.tokens)),
    };
  }

  private getOrRefillBucket(
    map: Map<string, BucketState>,
    id: string,
    refillPerSecond: number,
    burstCapacity: number,
    nowMs: number,
  ): BucketState {
    const existing = map.get(id);
    if (!existing) {
      const created: BucketState = {
        tokens: burstCapacity,
        lastRefillMs: nowMs,
        refillPerSecond,
        burstCapacity,
      };
      map.set(id, created);
      return created;
    }

    // Update limits if tenant policy changed dynamically
    existing.refillPerSecond = refillPerSecond;
    if (burstCapacity !== existing.burstCapacity) {
      if (burstCapacity > existing.burstCapacity) {
        existing.tokens += burstCapacity - existing.burstCapacity;
      } else {
        existing.tokens = Math.min(existing.tokens, burstCapacity);
      }
      existing.burstCapacity = burstCapacity;
    }

    const elapsedMs = Math.max(0, nowMs - existing.lastRefillMs);
    if (elapsedMs > 0) {
      const replenished = (elapsedMs / 1000) * existing.refillPerSecond;
      existing.tokens = Math.min(existing.burstCapacity, existing.tokens + replenished);
      existing.lastRefillMs = nowMs;
    }

    return existing;
  }
}
