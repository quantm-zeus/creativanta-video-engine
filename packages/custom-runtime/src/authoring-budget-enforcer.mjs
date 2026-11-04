// @ts-check
/**
 * Token, Time, and Cost Budget Enforcer for AI Authoring (Task P7-03).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (line 57: Rate limits, runtime budgets, quota/budget cap prevents spend runaway)
 *   - docs/OPERATIONS.md (lines 50-55: unit_cost, requests/authoring quotas, budget caps)
 *   - docs/IMPLEMENTATION_PLAN.md (line 115: token/time/cost budgets, cancellation, source-only output)
 */

import { CustomRuntimeError } from './adr-policy.mjs';
import { calculateAuthoringCost } from './authoring-adapter-contract.mjs';

/**
 * Budget enforcer for AI authoring operations.
 */
export class AuthoringBudgetEnforcer {
  /**
   * Preflight budget check: verifies that estimated resource consumption is acceptable.
   *
   * @param {{
   *   max_tokens: number;
   *   max_completion_tokens: number;
   *   timeout_ms: number;
   *   max_cost_usd: number;
   * }} budgets
   * @param {{
   *   estimatedPromptTokens: number;
   *   estimatedCompletionTokens: number;
   *   estimatedCostUsd: number;
   * }} estimation
   */
  static checkPreflightBudget(budgets, estimation) {
    if (estimation.estimatedCostUsd > budgets.max_cost_usd) {
      throw new CustomRuntimeError(
        'COST_BUDGET_EXCEEDED',
        `Preflight estimated cost ($${estimation.estimatedCostUsd.toFixed(4)}) exceeds requested budget cap ($${budgets.max_cost_usd.toFixed(4)})`,
        false,
        {
          estimatedCostUsd: estimation.estimatedCostUsd,
          maxCostUsd: budgets.max_cost_usd,
          phase: 'preflight',
        },
      );
    }
    const estimatedTotal = estimation.estimatedPromptTokens + estimation.estimatedCompletionTokens;
    if (estimatedTotal > budgets.max_tokens) {
      throw new CustomRuntimeError(
        'TOKEN_BUDGET_EXCEEDED',
        `Preflight estimated total tokens (${estimatedTotal}) exceeds requested budget cap (${budgets.max_tokens})`,
        false,
        {
          estimatedTokens: estimatedTotal,
          maxTokens: budgets.max_tokens,
          phase: 'preflight',
        },
      );
    }
  }

  /**
   * Postflight budget verification: checks actual consumed tokens, time, and cost.
   *
   * @param {{
   *   max_tokens: number;
   *   max_completion_tokens: number;
   *   timeout_ms: number;
   *   max_cost_usd: number;
   * }} budgets
   * @param {{
   *   prompt_tokens: number;
   *   completion_tokens: number;
   *   total_tokens: number;
   *   duration_ms: number;
   *   cost_usd: number;
   * }} actual
   */
  static checkPostflightBudget(budgets, actual) {
    // 1. Check completion tokens
    if (actual.completion_tokens > budgets.max_completion_tokens) {
      throw new CustomRuntimeError(
        'TOKEN_BUDGET_EXCEEDED',
        `Completion tokens (${actual.completion_tokens}) exceeded requested completion token budget (${budgets.max_completion_tokens})`,
        false,
        {
          actualCompletionTokens: actual.completion_tokens,
          maxCompletionTokens: budgets.max_completion_tokens,
          phase: 'postflight',
        },
      );
    }

    // 2. Check total tokens
    if (actual.total_tokens > budgets.max_tokens) {
      throw new CustomRuntimeError(
        'TOKEN_BUDGET_EXCEEDED',
        `Total tokens consumed (${actual.total_tokens}) exceeded token budget (${budgets.max_tokens})`,
        false,
        {
          actualTotalTokens: actual.total_tokens,
          maxTokens: budgets.max_tokens,
          phase: 'postflight',
        },
      );
    }

    // 3. Check cost budget
    if (actual.cost_usd > budgets.max_cost_usd) {
      throw new CustomRuntimeError(
        'COST_BUDGET_EXCEEDED',
        `Authoring cost ($${actual.cost_usd.toFixed(4)}) exceeded cost budget cap ($${budgets.max_cost_usd.toFixed(4)})`,
        false,
        {
          actualCostUsd: actual.cost_usd,
          maxCostUsd: budgets.max_cost_usd,
          phase: 'postflight',
        },
      );
    }

    // 4. Check time budget
    if (actual.duration_ms > budgets.timeout_ms) {
      throw new CustomRuntimeError(
        'TIME_BUDGET_EXCEEDED',
        `Authoring execution time (${actual.duration_ms} ms) exceeded timeout budget (${budgets.timeout_ms} ms)`,
        false,
        {
          actualDurationMs: actual.duration_ms,
          timeoutMs: budgets.timeout_ms,
          phase: 'postflight',
        },
      );
    }
  }

  /**
   * Create an AbortController linked to a timeout and an optional parent signal.
   *
   * @param {number} timeoutMs
   * @param {AbortSignal} [parentSignal]
   * @returns {{
   *   controller: AbortController;
   *   signal: AbortSignal;
   *   isTimedOut: () => boolean;
   *   cleanup: () => void;
   * }}
   */
  static createTimeoutController(timeoutMs, parentSignal) {
    const controller = new AbortController();
    let timedOut = false;

    // Timeout trigger
    const timerId = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new CustomRuntimeError(
          'TIME_BUDGET_EXCEEDED',
          `Authoring job timed out after ${timeoutMs} ms`,
          false,
          { timeoutMs },
        ),
      );
    }, timeoutMs);

    // Parent signal listener
    /** @type {(() => void) | null} */
    let parentListener = null;
    if (parentSignal) {
      if (parentSignal.aborted) {
        clearTimeout(timerId);
        controller.abort(parentSignal.reason);
      } else {
        parentListener = () => {
          clearTimeout(timerId);
          controller.abort(parentSignal.reason);
        };
        parentSignal.addEventListener('abort', parentListener, { once: true });
      }
    }

    const cleanup = () => {
      clearTimeout(timerId);
      if (parentSignal && parentListener) {
        parentSignal.removeEventListener('abort', parentListener);
      }
    };

    return {
      controller,
      signal: controller.signal,
      isTimedOut: () => timedOut,
      cleanup,
    };
  }

  /**
   * Format complete metering ledger.
   *
   * @param {string} modelId
   * @param {number} promptTokens
   * @param {number} completionTokens
   * @param {number} durationMs
   * @param {Record<string, { promptCostPer1k: number; completionCostPer1k: number }>} [customPricing]
   */
  static calculateMetering(modelId, promptTokens, completionTokens, durationMs, customPricing) {
    const totalTokens = promptTokens + completionTokens;
    const costUsd = calculateAuthoringCost(modelId, promptTokens, completionTokens, customPricing);
    const costMicros = Math.round(costUsd * 1e6);

    return {
      model: modelId,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      duration_ms: durationMs,
      cost_usd: costUsd,
      cost_micros: costMicros,
    };
  }
}
