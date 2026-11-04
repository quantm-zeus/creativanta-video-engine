// @ts-check
/**
 * Provider-Neutral Authoring Adapter Contract & Specifications (Task P7-03).
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (line 115: Task P7-03 deliverable & acceptance)
 *   - docs/API.md (lines 7, 153-174: authoring:write scope, POST /authoring-jobs, GET /authoring-jobs/{id})
 *   - docs/SECURITY.md (lines 23, 57: secret redaction, token/time/cost budgets, source-only isolation)
 *   - docs/DEPLOYMENT.md (lines 92-94, 102: CVE_AUTHORING_PROVIDER, tenant authoring budgets)
 *   - docs/SCENE-SPEC.md (line 92: Vietnamese NFC text preservation, font diacritics)
 */

import crypto from 'node:crypto';
import { CustomRuntimeError } from './adr-policy.mjs';

/**
 * Supported provider classification.
 * @typedef {'mock' | 'local' | 'remote'} AuthoringProviderType
 */

/**
 * Standard default budgets for AI authoring jobs.
 */
export const AUTHORING_DEFAULT_BUDGETS = Object.freeze({
  maxPromptTokens: 8192,
  maxCompletionTokens: 8192,
  maxTotalTokens: 16384,
  timeoutMs: 60000, // 60 seconds default
  maxCostUsd: 0.50, // $0.50 default cap
});

/**
 * Hard system upper caps for AI authoring jobs (tenant cannot exceed via request).
 */
export const AUTHORING_SYSTEM_LIMITS = Object.freeze({
  maxBriefLength: 10000, // characters
  maxApprovedAssetsCount: 50,
  maxTimeoutMs: 180000, // 3 minutes maximum wall clock
  maxTokensUpperCap: 65536,
  maxCompletionTokensUpperCap: 32768,
  maxCostUsdUpperCap: 10.00, // $10.00 hard limit
  minTimeoutMs: 1000, // 1 second minimum
});

/**
 * Standard model pricing table (rates per 1,000 tokens in USD).
 * Local and mock routes have zero subscription requirement and $0.00 cost.
 */
export const AUTHORING_PRICING_TABLE = Object.freeze({
  'mock-creative-coder-v1': Object.freeze({
    provider: 'mock-deterministic',
    promptCostPer1k: 0.00,
    completionCostPer1k: 0.00,
    requiresSubscription: false,
    contextWindow: 32768,
  }),
  'mock-fast-wireframe-v1': Object.freeze({
    provider: 'mock-deterministic',
    promptCostPer1k: 0.00,
    completionCostPer1k: 0.00,
    requiresSubscription: false,
    contextWindow: 16384,
  }),
  'opencode-14b': Object.freeze({
    provider: 'opencode',
    promptCostPer1k: 0.00,
    completionCostPer1k: 0.00,
    requiresSubscription: false,
    contextWindow: 32768,
  }),
  'qwen2.5-coder-7b': Object.freeze({
    provider: 'opencode',
    promptCostPer1k: 0.00,
    completionCostPer1k: 0.00,
    requiresSubscription: false,
    contextWindow: 32768,
  }),
  'ollama-codellama-13b': Object.freeze({
    provider: 'local-ollama',
    promptCostPer1k: 0.00,
    completionCostPer1k: 0.00,
    requiresSubscription: false,
    contextWindow: 16384,
  }),
  'deepseek-chat': Object.freeze({
    provider: 'deepseek',
    promptCostPer1k: 0.00014,
    completionCostPer1k: 0.00028,
    requiresSubscription: false, // Low-cost utility token route, no recurring subscription required
    contextWindow: 65536,
  }),
  'deepseek-coder': Object.freeze({
    provider: 'deepseek',
    promptCostPer1k: 0.00014,
    completionCostPer1k: 0.00028,
    requiresSubscription: false,
    contextWindow: 65536,
  }),
  'gemini-1.5-flash': Object.freeze({
    provider: 'agy-gemini',
    promptCostPer1k: 0.000075,
    completionCostPer1k: 0.00030,
    requiresSubscription: false, // Pay-as-you-go / free-tier compatible, subscription optional
    contextWindow: 65536,
  }),
  'gemini-2.0-flash': Object.freeze({
    provider: 'agy-gemini',
    promptCostPer1k: 0.00010,
    completionCostPer1k: 0.00040,
    requiresSubscription: false,
    contextWindow: 65536,
  }),
  'gpt-4o-mini': Object.freeze({
    provider: 'codex',
    promptCostPer1k: 0.00015,
    completionCostPer1k: 0.00060,
    requiresSubscription: true, // Commercial subscription optional
    contextWindow: 65536,
  }),
  'codex-gpt-4o': Object.freeze({
    provider: 'codex',
    promptCostPer1k: 0.0025,
    completionCostPer1k: 0.010,
    requiresSubscription: true, // Commercial subscription optional
    contextWindow: 65536,
  }),
});

/**
 * Standard authoring adapter capabilities.
 */
export const AUTHORING_CAPABILITIES = Object.freeze([
  'custom-html-v1',
  'source-only',
  'cancellation',
  'token-budgeting',
  'time-budgeting',
  'cost-estimation',
  'deterministic-seed',
  'vietnamese-nfc',
  'asset-binding',
  'parameter-schema-generation',
]);

/**
 * Conservative estimation of tokens for a given prompt text.
 * Uses character & byte heuristic (~3.5 chars/token for Latin, ~1.5 chars/token for Vietnamese NFC).
 * @param {string} text
 * @returns {number}
 */
export function estimatePromptTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Normalize to NFC
  const normalized = text.normalize('NFC');
  // Vietnamese characters with tone marks or non-ASCII take more sub-tokens
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (normalized.charCodeAt(i) <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  const estimated = Math.ceil(asciiCount / 3.5 + nonAsciiCount / 1.5);
  return Math.max(1, estimated);
}

/**
 * Calculate cost in USD given model, prompt tokens, and completion tokens.
 * @param {string} modelId
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @param {Record<string, { promptCostPer1k: number; completionCostPer1k: number }>} [customPricing]
 * @returns {number} Cost in USD rounded to 6 decimal places.
 */
export function calculateAuthoringCost(modelId, promptTokens, completionTokens, customPricing) {
  const table = /** @type {Record<string, { promptCostPer1k: number; completionCostPer1k: number }>} */ (AUTHORING_PRICING_TABLE);
  const pricing = customPricing?.[modelId] || table[modelId] || {
    promptCostPer1k: 0.0,
    completionCostPer1k: 0.0,
  };
  const promptCost = (promptTokens / 1000) * pricing.promptCostPer1k;
  const completionCost = (completionTokens / 1000) * pricing.completionCostPer1k;
  const total = promptCost + completionCost;
  return Math.round(total * 1e6) / 1e6;
}

/**
 * Validate and sanitize an incoming authoring request.
 * @param {Record<string, unknown>} request
 * @returns {Record<string, unknown>}
 */
export function validateAuthoringRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Authoring request body must be a valid non-null object',
      false,
      { field: 'request' },
    );
  }

  // 1. Validate brief
  const rawBrief = request.brief;
  if (typeof rawBrief !== 'string' || !rawBrief.trim()) {
    throw new CustomRuntimeError(
      'INVALID_BRIEF',
      'Authoring brief is required and must be a non-empty string',
      false,
      { field: 'brief' },
    );
  }
  if (rawBrief.length > AUTHORING_SYSTEM_LIMITS.maxBriefLength) {
    throw new CustomRuntimeError(
      'INVALID_BRIEF',
      `Brief length (${rawBrief.length} chars) exceeds maximum allowed limit of ${AUTHORING_SYSTEM_LIMITS.maxBriefLength} chars`,
      false,
      { field: 'brief', length: rawBrief.length, max: AUTHORING_SYSTEM_LIMITS.maxBriefLength },
    );
  }

  // Normalize brief to Unicode NFC (per docs/SCENE-SPEC.md line 92)
  const brief = rawBrief.normalize('NFC').trim();

  // 2. Validate locale (default 'vi-VN')
  let locale = 'vi-VN';
  if (request.locale !== undefined) {
    if (typeof request.locale !== 'string' || !/^[a-z]{2}(-[A-Z]{2})?$/.test(request.locale)) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Invalid locale "${String(request.locale)}": must be format "vi-VN" or "en"`,
        false,
        { field: 'locale', value: request.locale },
      );
    }
    locale = request.locale;
  }

  // 3. Validate approved_asset_ids
  /** @type {string[]} */
  const approvedAssetIds = [];
  if (request.approved_asset_ids !== undefined) {
    if (!Array.isArray(request.approved_asset_ids)) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'approved_asset_ids must be an array of strings',
        false,
        { field: 'approved_asset_ids' },
      );
    }
    if (request.approved_asset_ids.length > AUTHORING_SYSTEM_LIMITS.maxApprovedAssetsCount) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `approved_asset_ids count (${request.approved_asset_ids.length}) exceeds maximum limit of ${AUTHORING_SYSTEM_LIMITS.maxApprovedAssetsCount}`,
        false,
        { field: 'approved_asset_ids', count: request.approved_asset_ids.length },
      );
    }
    for (const assetId of request.approved_asset_ids) {
      if (typeof assetId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(assetId)) {
        throw new CustomRuntimeError(
          'UNAPPROVED_ASSET_REFERENCE',
          `Invalid asset ID "${String(assetId)}" in approved_asset_ids`,
          false,
          { field: 'approved_asset_ids', invalidAssetId: assetId },
        );
      }
      if (!approvedAssetIds.includes(assetId)) {
        approvedAssetIds.push(assetId);
      }
    }
  }

  // 4. Validate provider_preference
  let providerPreference = 'mock-deterministic';
  if (request.provider_preference !== undefined) {
    if (typeof request.provider_preference !== 'string' || !request.provider_preference.trim()) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'provider_preference must be a non-empty string',
        false,
        { field: 'provider_preference' },
      );
    }
    providerPreference = request.provider_preference.trim().toLowerCase();
  }

  // 5. Validate model
  let model = request.model ? String(request.model).trim() : undefined;

  // 6. Validate budgets
  const rawBudgets = /** @type {Record<string, unknown> | undefined} */ (request.budgets) || {};
  const maxTokens = Number.isInteger(rawBudgets.max_tokens)
    ? Math.min(Math.max(1, Number(rawBudgets.max_tokens)), AUTHORING_SYSTEM_LIMITS.maxTokensUpperCap)
    : AUTHORING_DEFAULT_BUDGETS.maxTotalTokens;

  const maxCompletionTokens = Number.isInteger(rawBudgets.max_completion_tokens)
    ? Math.min(Math.max(1, Number(rawBudgets.max_completion_tokens)), AUTHORING_SYSTEM_LIMITS.maxCompletionTokensUpperCap)
    : AUTHORING_DEFAULT_BUDGETS.maxCompletionTokens;

  const timeoutMs = Number.isInteger(rawBudgets.timeout_ms)
    ? Math.min(
        Math.max(AUTHORING_SYSTEM_LIMITS.minTimeoutMs, Number(rawBudgets.timeout_ms)),
        AUTHORING_SYSTEM_LIMITS.maxTimeoutMs,
      )
    : AUTHORING_DEFAULT_BUDGETS.timeoutMs;

  const maxCostUsd = typeof rawBudgets.max_cost_usd === 'number' && rawBudgets.max_cost_usd >= 0
    ? Math.min(Number(rawBudgets.max_cost_usd), AUTHORING_SYSTEM_LIMITS.maxCostUsdUpperCap)
    : AUTHORING_DEFAULT_BUDGETS.maxCostUsd;

  const budgets = {
    max_tokens: maxTokens,
    max_completion_tokens: maxCompletionTokens,
    timeout_ms: timeoutMs,
    max_cost_usd: maxCostUsd,
  };

  // 7. Validate target canvas/output options
  const rawTarget = /** @type {Record<string, unknown> | undefined} */ (request.target) || {};
  const target = {
    bundle_type: typeof rawTarget.bundle_type === 'string' ? rawTarget.bundle_type : 'custom-html-v1',
    width: Number.isInteger(rawTarget.width) ? Number(rawTarget.width) : 1920,
    height: Number.isInteger(rawTarget.height) ? Number(rawTarget.height) : 1080,
    fps: Number.isInteger(rawTarget.fps) ? Number(rawTarget.fps) : 30,
    duration_seconds: typeof rawTarget.duration_seconds === 'number' ? Number(rawTarget.duration_seconds) : 5,
  };

  // 8. Optional seed for determinism
  const seed = request.seed !== undefined ? String(request.seed) : undefined;

  // 9. Compute brief hash
  const briefHash = crypto.createHash('sha256').update(brief).digest('hex');

  return {
    brief,
    brief_hash: briefHash,
    locale,
    approved_asset_ids: approvedAssetIds,
    provider_preference: providerPreference,
    model,
    budgets,
    target,
    seed,
    options: request.options && typeof request.options === 'object' ? request.options : {},
  };
}

/**
 * Base abstract class for Provider-Neutral Authoring Adapters.
 */
export class AuthoringAdapter {
  /**
   * @param {{
   *   id: string;
   *   name: string;
   *   providerType: AuthoringProviderType;
   *   displayName?: string;
   *   isSubscriptionRequired?: boolean;
   *   supportedModels?: Array<{
   *     id: string;
   *     name: string;
   *     contextTokens: number;
   *     requiresSubscription: boolean;
   *     promptCostPer1k: number;
   *     completionCostPer1k: number;
   *   }>;
   *   defaultModel?: string;
   *   capabilities?: string[];
   * }} options
   */
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('AuthoringAdapter options must be a valid object');
    }
    if (!options.id || typeof options.id !== 'string') {
      throw new TypeError('AuthoringAdapter requires a non-empty string id');
    }

    this.id = options.id.toLowerCase().trim();
    this.name = options.name || this.id;
    this.displayName = options.displayName || this.name;
    this.providerType = options.providerType || 'mock';
    this.isSubscriptionRequired = Boolean(options.isSubscriptionRequired);
    this.supportedModels = Array.isArray(options.supportedModels) ? Object.freeze([...options.supportedModels]) : Object.freeze([]);
    this.defaultModel = options.defaultModel || (this.supportedModels[0]?.id ?? 'mock-creative-coder-v1');
    this.capabilities = Array.isArray(options.capabilities) ? Object.freeze([...options.capabilities]) : AUTHORING_CAPABILITIES;
  }

  /**
   * Returns list of supported models.
   * @returns {ReadonlyArray<Record<string, unknown>>}
   */
  listModels() {
    return this.supportedModels;
  }

  /**
   * Estimate token usage and cost for a request.
   * @param {Record<string, unknown>} request
   * @returns {{ estimatedPromptTokens: number; estimatedCompletionTokens: number; estimatedCostUsd: number; estimatedDurationMs: number }}
   */
  estimateBudget(request) {
    const brief = String(request.brief || '');
    const promptTokens = estimatePromptTokens(brief) + 300; // prompt + system instructions
    const completionTokens = 1200; // estimated source files output
    const model = String(request.model || this.defaultModel);
    const cost = calculateAuthoringCost(model, promptTokens, completionTokens);
    return {
      estimatedPromptTokens: promptTokens,
      estimatedCompletionTokens: completionTokens,
      estimatedCostUsd: cost,
      estimatedDurationMs: 250,
    };
  }

  /**
   * Generate source files for custom scene bundle based on creative brief.
   * Must be implemented by subclasses.
   *
   * @param {Record<string, unknown>} _request Validated authoring request
   * @param {{
   *   signal?: AbortSignal;
   *   tenantId: string;
   *   jobId: string;
   *   logger?: Record<string, unknown>;
   * }} _context Execution context including AbortSignal for cancellation
   * @returns {Promise<{
   *   status: 'succeeded' | 'failed' | 'canceled';
   *   files: Array<{ path: string; content: string | Buffer }>;
   *   entrypoint: string;
   *   parameter_schema: Record<string, unknown>;
   *   declared_capabilities: string[];
   *   metadata: {
   *     provider: string;
   *     model: string;
   *     prompt_tokens: number;
   *     completion_tokens: number;
   *     total_tokens: number;
   *     duration_ms: number;
   *     cost_usd: number;
   *     brief_hash: string;
   *     seed?: string | number;
   *     finish_reason: string;
   *   };
   * }>}
   */
  async generateSceneSource(_request, _context) {
    throw new CustomRuntimeError(
      'UNSUPPORTED_CAPABILITY',
      `generateSceneSource() not implemented on abstract AuthoringAdapter "${this.id}"`,
      false,
    );
  }
}
