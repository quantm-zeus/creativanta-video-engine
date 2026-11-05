/**
 * Creativanta Video Engine - Tenant Quota Plans & Admission Policy Manager
 *
 * Canonical specifications:
 *   - docs/API.md ("Quy tắc chung", "Errors, metering và optional authoring", line 56, 172)
 *   - docs/SECURITY.md ("Filesystem, quotas và content", lines 57-58)
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", lines 41-56)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02: "Usage export/quota plans/retention tiers, pricing simulation và reconciliation")
 */

export const STANDARD_QUOTA_PLANS = Object.freeze({
  free: Object.freeze({
    planId: 'free',
    name: 'Free Trial',
    monthlyPriceUsd: 0,
    includedBillableMinutes: 10,
    overageRatePerMinuteUsd: 0.20,
    maxConcurrentActiveSlots: 1,
    maxQueuedJobs: 5,
    monthlyBillableMinutesQuota: 10,
    monthlyComputeBudgetCapUsd: 1.00,
    rateLimitRps: 5,
    maxAssetUploadBytes: 25 * 1024 * 1024, // 25 MB
    maxStorageCapacityGb: 1,
    allowedProfiles: Object.freeze(['preview-360p-v1', 'mp4-720p-v1']),
    features: Object.freeze({
      ttsEnabled: false,
      customCodeEnabled: false,
      remoteImportEnabled: false,
      maxWebhookEndpoints: 1,
    }),
  }),
  starter: Object.freeze({
    planId: 'starter',
    name: 'Starter Growth',
    monthlyPriceUsd: 29.00,
    includedBillableMinutes: 60,
    overageRatePerMinuteUsd: 0.15,
    maxConcurrentActiveSlots: 2,
    maxQueuedJobs: 20,
    monthlyBillableMinutesQuota: 60,
    monthlyComputeBudgetCapUsd: 15.00,
    rateLimitRps: 15,
    maxAssetUploadBytes: 100 * 1024 * 1024, // 100 MB
    maxStorageCapacityGb: 10,
    allowedProfiles: Object.freeze(['preview-360p-v1', 'mp4-720p-v1']),
    features: Object.freeze({
      ttsEnabled: true,
      customCodeEnabled: false,
      remoteImportEnabled: false,
      maxWebhookEndpoints: 5,
    }),
  }),
  pro: Object.freeze({
    planId: 'pro',
    name: 'Professional',
    monthlyPriceUsd: 99.00,
    includedBillableMinutes: 300,
    overageRatePerMinuteUsd: 0.10,
    maxConcurrentActiveSlots: 5,
    maxQueuedJobs: 50,
    monthlyBillableMinutesQuota: 300,
    monthlyComputeBudgetCapUsd: 75.00,
    rateLimitRps: 30,
    maxAssetUploadBytes: 500 * 1024 * 1024, // 500 MB
    maxStorageCapacityGb: 50,
    allowedProfiles: Object.freeze(['preview-360p-v1', 'mp4-720p-v1']),
    features: Object.freeze({
      ttsEnabled: true,
      customCodeEnabled: true,
      remoteImportEnabled: true,
      maxWebhookEndpoints: 20,
    }),
  }),
  enterprise: Object.freeze({
    planId: 'enterprise',
    name: 'Enterprise Scale',
    monthlyPriceUsd: 299.00,
    includedBillableMinutes: 1200,
    overageRatePerMinuteUsd: 0.08,
    maxConcurrentActiveSlots: 10,
    maxQueuedJobs: 100,
    monthlyBillableMinutesQuota: 1200,
    monthlyComputeBudgetCapUsd: 300.00,
    rateLimitRps: 50,
    maxAssetUploadBytes: 2048 * 1024 * 1024, // 2 GB
    maxStorageCapacityGb: 500,
    allowedProfiles: Object.freeze(['preview-360p-v1', 'mp4-720p-v1']),
    features: Object.freeze({
      ttsEnabled: true,
      customCodeEnabled: true,
      remoteImportEnabled: true,
      maxWebhookEndpoints: 100,
    }),
  }),
});

export const QUOTA_WARNING_THRESHOLD_RATIO = 0.80; // 80% usage triggers warning

export class QuotaPolicyManager {
  constructor(options = {}) {
    this.plans = { ...STANDARD_QUOTA_PLANS, ...(options.customPlans || {}) };
    this.defaultPlanId = options.defaultPlanId || 'starter';
    // Map<tenantId, planConfig>
    this.tenantPlans = new Map();
    // Map<tenantId, QuotaState>
    this.tenantStates = new Map();
  }

  /**
   * Assigns a quota plan to a tenant, with optional custom parameter overrides.
   */
  assignTenantPlan(tenantId, planId, overrides = {}) {
    if (!this.plans[planId]) {
      throw new Error(`Unknown quota plan '${planId}'. Available plans: ${Object.keys(this.plans).join(', ')}`);
    }
    const basePlan = this.plans[planId];
    const assignedPlan = Object.freeze({
      ...basePlan,
      ...overrides,
      features: Object.freeze({
        ...basePlan.features,
        ...(overrides.features || {}),
      }),
    });
    this.tenantPlans.set(tenantId, assignedPlan);

    if (!this.tenantStates.has(tenantId)) {
      this.initTenantState(tenantId);
    }
    return assignedPlan;
  }

  /**
   * Retrieves the effective quota plan for a tenant.
   */
  getTenantPlan(tenantId) {
    if (!this.tenantPlans.has(tenantId)) {
      this.assignTenantPlan(tenantId, this.defaultPlanId);
    }
    return this.tenantPlans.get(tenantId);
  }

  /**
   * Initializes or resets tenant tracking state for the billing window.
   */
  initTenantState(tenantId) {
    const state = {
      tenantId,
      billingCycleStart: new Date().toISOString(),
      activeSlotsInUse: 0,
      queuedJobsCount: 0,
      activeJobIds: new Set(),
      queuedJobIds: new Set(),
      periodBillableMinutes: 0.0,
      periodAccruedBudgetUsd: 0.0,
      totalSubmittedJobs: 0,
      totalSucceededJobs: 0,
      totalFailedJobs: 0,
      totalCanceledJobs: 0,
      quotaWarnings: [],
    };
    this.tenantStates.set(tenantId, state);
    return state;
  }

  /**
   * Evaluates admission for an incoming render or preview job request.
   * Enforces concurrent slots, queue capacity, monthly billable minutes, and compute budget cap.
   */
  evaluateAdmission(tenantId, request = {}) {
    const plan = this.getTenantPlan(tenantId);
    const state = this.tenantStates.get(tenantId) || this.initTenantState(tenantId);

    const profile = request.profile || 'mp4-720p-v1';
    const estimatedMinutes = Number(request.estimatedMinutes ?? 0.25);
    const estimatedCostUsd = Number(request.estimatedCostUsd ?? 0.005);
    const requestedCustomCode = Boolean(request.requiresCustomCode);
    const requestedTts = Boolean(request.requiresTts);

    // 1. Profile capability check
    if (plan.allowedProfiles && !plan.allowedProfiles.includes(profile)) {
      return {
        allowed: false,
        statusCode: 422,
        errorCode: 'UNSUPPORTED_CAPABILITY',
        reason: `Profile '${profile}' is not permitted under tenant quota plan '${plan.planId}'`,
        details: [{ code: 'PROFILE_NOT_ALLOWED', profile, allowedProfiles: plan.allowedProfiles }],
      };
    }

    // 2. Feature capability checks
    if (requestedCustomCode && !plan.features.customCodeEnabled) {
      return {
        allowed: false,
        statusCode: 422,
        errorCode: 'CAPABILITY_DISABLED',
        reason: `Custom code authoring is disabled for tenant plan '${plan.planId}'`,
        details: [{ code: 'CUSTOM_CODE_PLAN_RESTRICTED', planId: plan.planId }],
      };
    }

    if (requestedTts && !plan.features.ttsEnabled) {
      return {
        allowed: false,
        statusCode: 422,
        errorCode: 'CAPABILITY_DISABLED',
        reason: `TTS audio synthesis is disabled for tenant plan '${plan.planId}'`,
        details: [{ code: 'TTS_PLAN_RESTRICTED', planId: plan.planId }],
      };
    }

    // 3. Concurrent active slots check
    if (state.activeSlotsInUse >= plan.maxConcurrentActiveSlots) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QUOTA_EXCEEDED',
        reason: `Tenant concurrent active slot limit reached (${state.activeSlotsInUse}/${plan.maxConcurrentActiveSlots})`,
        retryAfterSeconds: 2,
        details: [
          {
            metric: 'maxConcurrentActiveSlots',
            limit: plan.maxConcurrentActiveSlots,
            current: state.activeSlotsInUse,
          },
        ],
      };
    }

    // 4. Queued jobs buffer check
    if (state.queuedJobsCount >= plan.maxQueuedJobs) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QUOTA_EXCEEDED',
        reason: `Tenant pending queue limit reached (${state.queuedJobsCount}/${plan.maxQueuedJobs})`,
        retryAfterSeconds: 5,
        details: [
          {
            metric: 'maxQueuedJobs',
            limit: plan.maxQueuedJobs,
            current: state.queuedJobsCount,
          },
        ],
      };
    }

    // 5. Monthly billable minutes quota check
    const projectedMinutes = state.periodBillableMinutes + estimatedMinutes;
    if (projectedMinutes > plan.monthlyBillableMinutesQuota) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QUOTA_EXCEEDED',
        reason: `Tenant monthly billable minutes quota exceeded (${projectedMinutes.toFixed(2)} > ${plan.monthlyBillableMinutesQuota} min)`,
        retryAfterSeconds: 3600,
        details: [
          {
            metric: 'monthlyBillableMinutesQuota',
            limit: plan.monthlyBillableMinutesQuota,
            current: state.periodBillableMinutes,
            projected: projectedMinutes,
          },
        ],
      };
    }

    // 6. Monthly compute budget cap check
    const projectedBudget = state.periodAccruedBudgetUsd + estimatedCostUsd;
    if (projectedBudget > plan.monthlyComputeBudgetCapUsd) {
      return {
        allowed: false,
        statusCode: 429,
        errorCode: 'QUOTA_EXCEEDED',
        reason: `Tenant monthly compute budget cap exceeded ($${projectedBudget.toFixed(4)} > $${plan.monthlyComputeBudgetCapUsd.toFixed(2)})`,
        retryAfterSeconds: 3600,
        details: [
          {
            metric: 'monthlyComputeBudgetCapUsd',
            limit: plan.monthlyComputeBudgetCapUsd,
            current: state.periodAccruedBudgetUsd,
            projected: projectedBudget,
          },
        ],
      };
    }

    // 7. Calculate warning threshold (80% utilization)
    const warnings = [];
    const minutesRatio = projectedMinutes / plan.monthlyBillableMinutesQuota;
    if (minutesRatio >= QUOTA_WARNING_THRESHOLD_RATIO) {
      const warningMsg = `Tenant has utilized ${(minutesRatio * 100).toFixed(1)}% of monthly billable minutes quota (${projectedMinutes.toFixed(2)}/${plan.monthlyBillableMinutesQuota} min)`;
      warnings.push({
        code: 'CVE_QUOTA_WARNING_80',
        metric: 'monthlyBillableMinutesQuota',
        ratio: minutesRatio,
        message: warningMsg,
      });
      state.quotaWarnings.push({ timestamp: new Date().toISOString(), ...warnings[warnings.length - 1] });
    }

    const budgetRatio = projectedBudget / plan.monthlyComputeBudgetCapUsd;
    if (budgetRatio >= QUOTA_WARNING_THRESHOLD_RATIO) {
      const warningMsg = `Tenant has utilized ${(budgetRatio * 100).toFixed(1)}% of monthly budget cap ($${projectedBudget.toFixed(2)}/$${plan.monthlyComputeBudgetCapUsd.toFixed(2)})`;
      warnings.push({
        code: 'CVE_BUDGET_WARNING_80',
        metric: 'monthlyComputeBudgetCapUsd',
        ratio: budgetRatio,
        message: warningMsg,
      });
      state.quotaWarnings.push({ timestamp: new Date().toISOString(), ...warnings[warnings.length - 1] });
    }

    return {
      allowed: true,
      statusCode: 202,
      planId: plan.planId,
      warnings,
      currentUsage: {
        activeSlots: state.activeSlotsInUse,
        queuedJobs: state.queuedJobsCount,
        periodBillableMinutes: Number(state.periodBillableMinutes.toFixed(4)),
        periodAccruedBudgetUsd: Number(state.periodAccruedBudgetUsd.toFixed(6)),
      },
      remainingQuota: {
        activeSlotsAvailable: plan.maxConcurrentActiveSlots - state.activeSlotsInUse,
        queueCapacityAvailable: plan.maxQueuedJobs - state.queuedJobsCount,
        minutesRemaining: Math.max(0, plan.monthlyBillableMinutesQuota - state.periodBillableMinutes),
        budgetRemainingUsd: Math.max(0, plan.monthlyComputeBudgetCapUsd - state.periodAccruedBudgetUsd),
      },
    };
  }

  /**
   * Tracks admission of an admitted job into queued or active tracking.
   */
  recordJobAdmission(tenantId, jobId, options = {}) {
    const state = this.tenantStates.get(tenantId) || this.initTenantState(tenantId);
    state.totalSubmittedJobs += 1;
    if (options.isActive) {
      state.activeSlotsInUse += 1;
      state.activeJobIds.add(jobId);
    } else {
      state.queuedJobsCount += 1;
      state.queuedJobIds.add(jobId);
    }
  }

  /**
   * Transitions a job from queued to active execution slot.
   */
  transitionJobToActive(tenantId, jobId) {
    const state = this.tenantStates.get(tenantId);
    if (!state) return;
    if (state.queuedJobIds.has(jobId)) {
      state.queuedJobIds.delete(jobId);
      state.queuedJobsCount = Math.max(0, state.queuedJobsCount - 1);
    }
    if (!state.activeJobIds.has(jobId)) {
      state.activeJobIds.add(jobId);
      state.activeSlotsInUse += 1;
    }
  }

  /**
   * Finalizes tracking when a job enters terminal state (succeeded, failed, canceled).
   */
  recordJobCompletion(tenantId, jobId, usage = {}) {
    const state = this.tenantStates.get(tenantId);
    if (!state) return;

    if (state.activeJobIds.has(jobId)) {
      state.activeJobIds.delete(jobId);
      state.activeSlotsInUse = Math.max(0, state.activeSlotsInUse - 1);
    }
    if (state.queuedJobIds.has(jobId)) {
      state.queuedJobIds.delete(jobId);
      state.queuedJobsCount = Math.max(0, state.queuedJobsCount - 1);
    }

    const billableMinutes = Number(usage.billableMinutes || 0);
    const operationalCostUsd = Number(usage.operationalCostUsd || 0);
    const status = usage.status || (usage.isSucceeded ? 'succeeded' : 'failed');

    if (status === 'succeeded') {
      state.totalSucceededJobs += 1;
      state.periodBillableMinutes += billableMinutes;
    } else if (status === 'canceled') {
      state.totalCanceledJobs += 1;
    } else {
      state.totalFailedJobs += 1;
    }

    state.periodAccruedBudgetUsd += operationalCostUsd;
  }

  /**
   * Returns current quota state and consumption summary for a tenant.
   */
  getTenantQuotaStatus(tenantId) {
    const plan = this.getTenantPlan(tenantId);
    const state = this.tenantStates.get(tenantId) || this.initTenantState(tenantId);

    const minutesRatio = plan.monthlyBillableMinutesQuota > 0
      ? state.periodBillableMinutes / plan.monthlyBillableMinutesQuota
      : 0;
    const budgetRatio = plan.monthlyComputeBudgetCapUsd > 0
      ? state.periodAccruedBudgetUsd / plan.monthlyComputeBudgetCapUsd
      : 0;

    return {
      tenantId,
      plan: {
        planId: plan.planId,
        name: plan.name,
        monthlyPriceUsd: plan.monthlyPriceUsd,
        includedBillableMinutes: plan.includedBillableMinutes,
        maxConcurrentActiveSlots: plan.maxConcurrentActiveSlots,
        maxQueuedJobs: plan.maxQueuedJobs,
        monthlyBillableMinutesQuota: plan.monthlyBillableMinutesQuota,
        monthlyComputeBudgetCapUsd: plan.monthlyComputeBudgetCapUsd,
      },
      usage: {
        activeSlotsInUse: state.activeSlotsInUse,
        queuedJobsCount: state.queuedJobsCount,
        periodBillableMinutes: Number(state.periodBillableMinutes.toFixed(4)),
        periodAccruedBudgetUsd: Number(state.periodAccruedBudgetUsd.toFixed(6)),
        totalSubmittedJobs: state.totalSubmittedJobs,
        totalSucceededJobs: state.totalSucceededJobs,
        totalFailedJobs: state.totalFailedJobs,
        totalCanceledJobs: state.totalCanceledJobs,
      },
      ratios: {
        minutesUtilizationPercent: Number((minutesRatio * 100).toFixed(2)),
        budgetUtilizationPercent: Number((budgetRatio * 100).toFixed(2)),
      },
      headroom: {
        availableActiveSlots: Math.max(0, plan.maxConcurrentActiveSlots - state.activeSlotsInUse),
        availableQueueSlots: Math.max(0, plan.maxQueuedJobs - state.queuedJobsCount),
        remainingBillableMinutes: Math.max(0, Number((plan.monthlyBillableMinutesQuota - state.periodBillableMinutes).toFixed(4))),
        remainingBudgetUsd: Math.max(0, Number((plan.monthlyComputeBudgetCapUsd - state.periodAccruedBudgetUsd).toFixed(6))),
      },
      warnings: [...state.quotaWarnings],
    };
  }
}
