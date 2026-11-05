/**
 * Creativanta Video Engine - Pricing Simulation & Commercial Model Engine
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", "Usage/cost ledger và report", lines 45-56:
 *     "Host 4 vCPU bật 1h nhưng chỉ dùng 10% vẫn tốn nguyên giờ theo mô hình provisioned;
 *      report 10/50/80% utilization để thấy ảnh hưởng... Mức giá bán/margin chưa quyết; scope MVP không charge card.")
 *   - docs/TESTING.md ("Benchmark protocol và cost", line 64: "Báo 3 scenarios utilization 10/50/80%")
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02: "Usage export/quota plans/retention tiers, pricing simulation và reconciliation")
 */

import {
  DEFAULT_VCPU_HOURLY_RATE_USD,
  DEFAULT_STORAGE_RATE_PER_GB_MONTH,
  DEFAULT_EGRESS_RATE_PER_GB,
  DEFAULT_HOST_VCPUS,
  DEFAULT_RESERVED_VCPUS,
} from '../cost/cost-calculator.mjs';
import { STANDARD_QUOTA_PLANS } from './quota-plans.mjs';

export const HOURS_PER_MONTH = 730; // 365 * 24 / 12 = 730 hours
export const MONTHLY_NODE_COST_USD = DEFAULT_HOST_VCPUS * DEFAULT_VCPU_HOURLY_RATE_USD * HOURS_PER_MONTH; // 4 * 0.04 * 730 = $116.80

export const STANDARD_PAYG_VOLUME_TIERS = Object.freeze([
  { maxMinutes: 100, ratePerMinuteUsd: 0.18 },
  { maxMinutes: 500, ratePerMinuteUsd: 0.14 },
  { maxMinutes: 2000, ratePerMinuteUsd: 0.10 },
  { maxMinutes: Infinity, ratePerMinuteUsd: 0.07 },
]);

export class PricingSimulator {
  constructor(options = {}) {
    this.vcpuHourlyRateUsd = options.vcpuHourlyRateUsd ?? DEFAULT_VCPU_HOURLY_RATE_USD;
    this.hostVcpus = options.hostVcpus ?? DEFAULT_HOST_VCPUS;
    this.reservedVcpus = options.reservedVcpus ?? DEFAULT_RESERVED_VCPUS;
    this.storageRatePerGbMonth = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
    this.egressRatePerGb = options.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB;
    this.quotaPlans = { ...STANDARD_QUOTA_PLANS, ...(options.quotaPlans || {}) };
  }

  /**
   * Calculates monthly provisioned hardware cost for a given node count.
   */
  calculateHostProvisioningCost(nodeCount = 1) {
    const hourlyCostPerNode = this.hostVcpus * this.vcpuHourlyRateUsd;
    const monthlyCostPerNode = hourlyCostPerNode * HOURS_PER_MONTH;
    const totalMonthlyCost = monthlyCostPerNode * nodeCount;

    return {
      nodeCount,
      hostVcpus: this.hostVcpus,
      vcpuHourlyRateUsd: this.vcpuHourlyRateUsd,
      hourlyCostPerNode: Number(hourlyCostPerNode.toFixed(4)),
      monthlyCostPerNode: Number(monthlyCostPerNode.toFixed(2)),
      totalMonthlyProvisionedCostUsd: Number(totalMonthlyCost.toFixed(2)),
    };
  }

  /**
   * Evaluates PAYG volume-tiered pricing for a given number of output minutes.
   */
  calculatePaygRevenue(outputMinutes = 0, volumeTiers = STANDARD_PAYG_VOLUME_TIERS) {
    let remaining = Math.max(0, outputMinutes);
    let totalRevenue = 0;
    let prevMax = 0;
    const tierBreakdown = [];

    for (const tier of volumeTiers) {
      if (remaining <= 0) break;
      const tierBand = tier.maxMinutes - prevMax;
      const minutesInTier = Math.min(remaining, tierBand);
      const tierAmount = minutesInTier * tier.ratePerMinuteUsd;

      totalRevenue += tierAmount;
      remaining -= minutesInTier;
      prevMax = tier.maxMinutes;

      tierBreakdown.push({
        ratePerMinuteUsd: tier.ratePerMinuteUsd,
        minutesBilled: Number(minutesInTier.toFixed(4)),
        subtotalUsd: Number(tierAmount.toFixed(4)),
      });
    }

    const effectiveRate = outputMinutes > 0 ? totalRevenue / outputMinutes : 0;

    return {
      outputMinutes: Number(outputMinutes.toFixed(4)),
      totalRevenueUsd: Number(totalRevenue.toFixed(2)),
      effectiveRatePerMinuteUsd: Number(effectiveRate.toFixed(4)),
      tierBreakdown,
    };
  }

  /**
   * Evaluates subscription plan revenue including base fee and overage minutes.
   */
  calculateSubscriptionRevenue(planId, actualOutputMinutes = 0) {
    const plan = this.quotaPlans[planId];
    if (!plan) {
      throw new Error(`Unknown plan '${planId}'`);
    }

    const baseFee = plan.monthlyPriceUsd;
    const includedMinutes = plan.includedBillableMinutes;
    const overageMinutes = Math.max(0, actualOutputMinutes - includedMinutes);
    const overageFee = overageMinutes * plan.overageRatePerMinuteUsd;
    const totalRevenue = baseFee + overageFee;
    const effectiveRate = actualOutputMinutes > 0 ? totalRevenue / actualOutputMinutes : 0;

    return {
      planId: plan.planId,
      planName: plan.name,
      baseFeeUsd: baseFee,
      includedMinutes,
      actualOutputMinutes: Number(actualOutputMinutes.toFixed(4)),
      overageMinutes: Number(overageMinutes.toFixed(4)),
      overageRatePerMinuteUsd: plan.overageRatePerMinuteUsd,
      overageFeeUsd: Number(overageFee.toFixed(2)),
      totalRevenueUsd: Number(totalRevenue.toFixed(2)),
      effectiveRatePerMinuteUsd: Number(effectiveRate.toFixed(4)),
    };
  }

  /**
   * Models the three canonical utilization scenarios (10%, 50%, 80%) on provisioned host capacity.
   * Directly satisfies docs/OPERATIONS.md lines 53-55 and docs/TESTING.md line 64.
   */
  simulateUtilizationScenarios(options = {}) {
    const nodeCount = options.nodeCount ?? 1;
    const rtf = options.rtf ?? 4.0; // Standard warm RTF
    const storageGb = options.storageGb ?? 20; // 20 GB average stored media
    const egressGb = options.egressGb ?? 50; // 50 GB downloaded
    const hostCost = this.calculateHostProvisioningCost(nodeCount);

    // Total worker slots across nodes (2 slots per standard node)
    const totalSlots = nodeCount * (this.hostVcpus / this.reservedVcpus);
    // Total slot-seconds available in a month
    const totalSlotSecondsPerMonth = totalSlots * HOURS_PER_MONTH * 3600;

    const scenarios = [0.10, 0.50, 0.80];
    const results = [];

    for (const util of scenarios) {
      const activeSlotSeconds = totalSlotSecondsPerMonth * util;
      // Output seconds rendered = activeSlotSeconds / RTF
      const outputSeconds = activeSlotSeconds / rtf;
      const billableOutputMinutes = outputSeconds / 60;

      // Marginal costs
      const activeComputeCost = (activeSlotSeconds / 3600) * (this.reservedVcpus * this.vcpuHourlyRateUsd);
      const monthlyStorageCost = storageGb * this.storageRatePerGbMonth;
      const monthlyEgressCost = egressGb * this.egressRatePerGb;
      const marginalTotalCost = activeComputeCost + monthlyStorageCost + monthlyEgressCost;

      // Fully allocated cost (includes idle host waste)
      const fullyAllocatedHostCost = hostCost.totalMonthlyProvisionedCostUsd + monthlyStorageCost + monthlyEgressCost;

      // Unit costs per billable output minute
      const marginalUnitCost = billableOutputMinutes > 0 ? marginalTotalCost / billableOutputMinutes : 0;
      const fullyAllocatedUnitCost = billableOutputMinutes > 0 ? fullyAllocatedHostCost / billableOutputMinutes : 0;

      // Revenue simulations under 3 commercial models
      // Model A: Cost-Plus 35% margin over fully allocated cost
      const costPlusRevenue = fullyAllocatedHostCost * 1.35;
      const costPlusGrossMarginPercent = ((costPlusRevenue - fullyAllocatedHostCost) / costPlusRevenue) * 100;

      // Model B: PAYG Volume Tiered Revenue
      const payg = this.calculatePaygRevenue(billableOutputMinutes);
      const paygGrossProfit = payg.totalRevenueUsd - fullyAllocatedHostCost;
      const paygGrossMarginPercent = payg.totalRevenueUsd > 0
        ? (paygGrossProfit / payg.totalRevenueUsd) * 100
        : 0;

      // Model C: Blended Subscription Tier (equivalent to proportional starter/pro accounts)
      const avgSubscriptionRevenue = billableOutputMinutes * 0.12; // $0.12/min blended subscription revenue
      const subGrossProfit = avgSubscriptionRevenue - fullyAllocatedHostCost;
      const subGrossMarginPercent = avgSubscriptionRevenue > 0
        ? (subGrossProfit / avgSubscriptionRevenue) * 100
        : 0;

      results.push({
        utilizationPercent: Math.round(util * 100),
        activeSlotSeconds: Math.round(activeSlotSeconds),
        billableOutputMinutes: Number(billableOutputMinutes.toFixed(2)),
        rtf,
        infrastructure: {
          provisionedHostCostUsd: hostCost.totalMonthlyProvisionedCostUsd,
          activeComputeCostUsd: Number(activeComputeCost.toFixed(2)),
          storageCostUsd: Number(monthlyStorageCost.toFixed(2)),
          egressCostUsd: Number(monthlyEgressCost.toFixed(2)),
          fullyAllocatedTotalOpExUsd: Number(fullyAllocatedHostCost.toFixed(2)),
        },
        unitEconomics: {
          marginalUnitCostPerMinuteUsd: Number(marginalUnitCost.toFixed(4)),
          fullyAllocatedUnitCostPerMinuteUsd: Number(fullyAllocatedUnitCost.toFixed(4)),
        },
        commercialProjections: {
          costPlus35: {
            projectedRevenueUsd: Number(costPlusRevenue.toFixed(2)),
            grossProfitUsd: Number((costPlusRevenue - fullyAllocatedHostCost).toFixed(2)),
            grossMarginPercent: Number(costPlusGrossMarginPercent.toFixed(1)),
          },
          paygTiered: {
            projectedRevenueUsd: payg.totalRevenueUsd,
            effectiveRatePerMinuteUsd: payg.effectiveRatePerMinuteUsd,
            grossProfitUsd: Number(paygGrossProfit.toFixed(2)),
            grossMarginPercent: Number(paygGrossMarginPercent.toFixed(1)),
          },
          subscriptionBlended: {
            projectedRevenueUsd: Number(avgSubscriptionRevenue.toFixed(2)),
            grossProfitUsd: Number(subGrossProfit.toFixed(2)),
            grossMarginPercent: Number(subGrossMarginPercent.toFixed(1)),
          },
        },
      });
    }

    return {
      simulationMetadata: {
        timestamp: new Date().toISOString(),
        nodeCount,
        hostVcpus: this.hostVcpus,
        slotsPerNode: totalSlots / nodeCount,
        vcpuHourlyRateUsd: this.vcpuHourlyRateUsd,
        assumedWarmRtf: rtf,
      },
      scenarios: results,
    };
  }

  /**
   * Simulates a custom what-if workload distribution (e.g. 80% 15s promo, 20% 45s footage).
   */
  simulateWorkloadDistribution(options = {}) {
    const totalJobs = options.totalJobs ?? 1000;
    const promoRatio = options.promoRatio ?? 0.80; // 80% POC-01 15s promo
    const footageRatio = options.footageRatio ?? 0.20; // 20% POC-03 45s footage
    const promoRtf = options.promoRtf ?? 4.0;
    const footageRtf = options.footageRtf ?? 4.5;
    const nodeCount = options.nodeCount ?? 1;

    const promoJobsCount = Math.round(totalJobs * promoRatio);
    const footageJobsCount = totalJobs - promoJobsCount;

    const promoOutputSecs = promoJobsCount * 15;
    const footageOutputSecs = footageJobsCount * 45;
    const totalOutputSeconds = promoOutputSecs + footageOutputSecs;
    const totalBillableMinutes = totalOutputSeconds / 60;

    const promoWallSecs = promoOutputSecs * promoRtf;
    const footageWallSecs = footageOutputSecs * footageRtf;
    const totalWallSeconds = promoWallSecs + footageWallSecs;

    const reservedVcpuSeconds = totalWallSeconds * this.reservedVcpus;
    const marginalComputeCost = (reservedVcpuSeconds / 3600) * this.vcpuHourlyRateUsd;

    const hostCost = this.calculateHostProvisioningCost(nodeCount);

    const payg = this.calculatePaygRevenue(totalBillableMinutes);
    const costPlus35 = marginalComputeCost * 1.35;

    return {
      workload: {
        totalJobs,
        promoJobsCount,
        footageJobsCount,
        totalOutputSeconds,
        totalBillableMinutes: Number(totalBillableMinutes.toFixed(2)),
        totalWallSeconds: Number(totalWallSeconds.toFixed(2)),
      },
      costs: {
        marginalComputeCostUsd: Number(marginalComputeCost.toFixed(4)),
        unitMarginalCostPerMinuteUsd: Number((marginalComputeCost / totalBillableMinutes).toFixed(4)),
        monthlyNodeProvisioningCostUsd: hostCost.totalMonthlyProvisionedCostUsd,
      },
      revenueProjections: {
        costPlus35Usd: Number(costPlus35.toFixed(2)),
        paygRevenueUsd: payg.totalRevenueUsd,
        effectivePaygRateUsd: payg.effectiveRatePerMinuteUsd,
      },
    };
  }
}
