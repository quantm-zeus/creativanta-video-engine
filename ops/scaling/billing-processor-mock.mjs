/**
 * Creativanta Video Engine - Isolated Mock Billing Processor & Invoicing Engine
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02:
 *     "billing processor riêng chỉ khi scope được cấp, không charging thật ở task này")
 *   - docs/OPERATIONS.md ("Usage/cost ledger và report", line 55:
 *     "Mức giá bán/margin chưa quyết; scope MVP không charge card")
 *   - docs/SECURITY.md ("Tenant identity và secrets", line 7:
 *     "Không tin: tenant payload... Tin cậy có giới hạn: reviewed controller và policy config")
 */

import crypto from 'node:crypto';
import { STANDARD_QUOTA_PLANS } from './quota-plans.mjs';
import { DEFAULT_STORAGE_RATE_PER_GB_MONTH, DEFAULT_EGRESS_RATE_PER_GB } from '../cost/cost-calculator.mjs';

export const BILLING_MODE_SIMULATION = 'SIMULATION_ONLY';
export const BILLING_MODE_DRY_RUN = 'DRY_RUN_NO_CHARGE';

export class MockBillingProcessor {
  constructor(options = {}) {
    this.mode = options.mode || BILLING_MODE_SIMULATION;
    this.storageRatePerGbMonth = options.storageRatePerGbMonth ?? DEFAULT_STORAGE_RATE_PER_GB_MONTH;
    this.egressRatePerGb = options.egressRatePerGb ?? DEFAULT_EGRESS_RATE_PER_GB;
    this.quotaPlans = { ...STANDARD_QUOTA_PLANS, ...(options.quotaPlans || {}) };
    this.generatedInvoices = [];

    // Strictly enforce that live charging is disabled
    this.assertNoRealCharging(options);
  }

  /**
   * Safety guard preventing accidental real payment processing or card charges.
   */
  assertNoRealCharging(options = {}) {
    if (options.liveChargingEnabled === true || options.stripeSecretKey || options.gatewayCredentials) {
      throw new Error(
        'SECURITY VIOLATION: Real charging is strictly forbidden in task P9-02. ' +
        'Billing processor must operate in SIMULATION or DRY_RUN mode only.'
      );
    }
  }

  /**
   * Generates a deterministic simulated draft invoice for a tenant for a given billing cycle.
   */
  generateDraftInvoice(tenantId, usageSummary = {}, options = {}) {
    this.assertNoRealCharging(options);

    const invoiceId = `inv_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const planId = options.planId || 'starter';
    const plan = this.quotaPlans[planId] || this.quotaPlans.starter;

    const periodStart = options.periodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const periodEnd = options.periodEnd || new Date().toISOString();

    const actualOutputMinutes = Number(usageSummary.billable?.totalBillableOutputMinutes ?? usageSummary.totalBillableOutputMinutes ?? 0);
    const storedGigabytes = Number(usageSummary.storedGigabytes ?? 5.0);
    const egressGigabytes = Number(usageSummary.egressGigabytes ?? 10.0);
    const compensatingCreditsUsd = Number(options.compensatingCreditsUsd ?? 0.0);

    // Line items calculation
    const basePlanFee = plan.monthlyPriceUsd;
    const includedMinutes = plan.includedBillableMinutes;
    const overageMinutes = Math.max(0, actualOutputMinutes - includedMinutes);
    const overageAmount = overageMinutes * plan.overageRatePerMinuteUsd;

    const storageAmount = storedGigabytes * this.storageRatePerGbMonth;
    const egressAmount = egressGigabytes * this.egressRatePerGb;

    const subtotalUsd = basePlanFee + overageAmount + storageAmount + egressAmount - compensatingCreditsUsd;
    const taxRate = options.taxRate ?? 0.0; // 0% tax by default in simulation
    const taxUsd = subtotalUsd * taxRate;
    const totalUsd = Math.max(0, subtotalUsd + taxUsd);

    const lineItems = [
      {
        description: `Base Plan Subscription (${plan.name})`,
        quantity: 1,
        unitPriceUsd: basePlanFee,
        totalUsd: Number(basePlanFee.toFixed(2)),
      },
      {
        description: `Included Minutes (${includedMinutes} min quota)`,
        quantity: Math.min(actualOutputMinutes, includedMinutes),
        unitPriceUsd: 0.00,
        totalUsd: 0.00,
      },
    ];

    if (overageMinutes > 0) {
      lineItems.push({
        description: `Overage Output Minutes (${plan.overageRatePerMinuteUsd.toFixed(2)}/min)`,
        quantity: Number(overageMinutes.toFixed(4)),
        unitPriceUsd: plan.overageRatePerMinuteUsd,
        totalUsd: Number(overageAmount.toFixed(2)),
      });
    }

    if (storageAmount > 0) {
      lineItems.push({
        description: `Media Storage (${storedGigabytes.toFixed(2)} GB-month)`,
        quantity: Number(storedGigabytes.toFixed(2)),
        unitPriceUsd: this.storageRatePerGbMonth,
        totalUsd: Number(storageAmount.toFixed(2)),
      });
    }

    if (egressAmount > 0) {
      lineItems.push({
        description: `Data Egress (${egressGigabytes.toFixed(2)} GB)`,
        quantity: Number(egressGigabytes.toFixed(2)),
        unitPriceUsd: this.egressRatePerGb,
        totalUsd: Number(egressAmount.toFixed(2)),
      });
    }

    if (compensatingCreditsUsd > 0) {
      lineItems.push({
        description: `Reconciliation Compensating Credit`,
        quantity: 1,
        unitPriceUsd: -compensatingCreditsUsd,
        totalUsd: -Number(compensatingCreditsUsd.toFixed(2)),
      });
    }

    // Invoice document
    const invoice = {
      invoiceId,
      tenantId,
      status: 'SIMULATED_DRAFT',
      realChargingExecuted: false,
      paymentGatewayEngaged: false,
      billingMode: this.mode,
      period: {
        from: periodStart,
        to: periodEnd,
      },
      plan: {
        planId: plan.planId,
        name: plan.name,
        monthlyPriceUsd: plan.monthlyPriceUsd,
        includedMinutes: plan.includedBillableMinutes,
        overageRateUsd: plan.overageRatePerMinuteUsd,
      },
      usage: {
        billableOutputMinutes: Number(actualOutputMinutes.toFixed(4)),
        includedMinutesCovered: Math.min(actualOutputMinutes, includedMinutes),
        overageMinutesBilled: Number(overageMinutes.toFixed(4)),
        storedGigabytes: Number(storedGigabytes.toFixed(2)),
        egressGigabytes: Number(egressGigabytes.toFixed(2)),
      },
      financials: {
        basePlanFeeUsd: Number(basePlanFee.toFixed(2)),
        overageFeeUsd: Number(overageAmount.toFixed(2)),
        storageFeeUsd: Number(storageAmount.toFixed(2)),
        egressFeeUsd: Number(egressAmount.toFixed(2)),
        compensatingCreditsUsd: Number(compensatingCreditsUsd.toFixed(2)),
        subtotalUsd: Number(subtotalUsd.toFixed(2)),
        taxRate: Number(taxRate.toFixed(4)),
        taxUsd: Number(taxUsd.toFixed(2)),
        totalUsd: Number(totalUsd.toFixed(2)),
      },
      lineItems,
      generatedAt: new Date().toISOString(),
    };

    // Calculate integrity hash
    const hash = crypto.createHash('sha256').update(JSON.stringify(invoice)).digest('hex');
    invoice.integrityHash = hash;

    this.generatedInvoices.push(invoice);
    return invoice;
  }

  /**
   * Formats an invoice as human-readable text statement.
   */
  formatInvoiceText(invoice) {
    const lines = [
      `================================================================================`,
      `CREATIVANTA VIDEO ENGINE - BILLING STATEMENT (SIMULATION / DRY-RUN ONLY)`,
      `================================================================================`,
      `Invoice ID:   ${invoice.invoiceId}`,
      `Tenant ID:    ${invoice.tenantId}`,
      `Billing Plan: ${invoice.plan.name} ($${invoice.plan.monthlyPriceUsd}/mo)`,
      `Period:       ${invoice.period.from} to ${invoice.period.to}`,
      `Status:       ${invoice.status} (Real Charging: ${invoice.realChargingExecuted})`,
      `Integrity:    ${invoice.integrityHash.substring(0, 16)}...`,
      `--------------------------------------------------------------------------------`,
      `LINE ITEMS:`,
    ];

    for (const item of invoice.lineItems) {
      lines.push(
        `  - ${item.description.padEnd(52)} | Qty: ${String(item.quantity).padStart(8)} | $${item.totalUsd.toFixed(2).padStart(8)}`
      );
    }

    lines.push(
      `--------------------------------------------------------------------------------`,
      `Subtotal:     $${invoice.financials.subtotalUsd.toFixed(2)}`,
      `Tax (${(invoice.financials.taxRate * 100).toFixed(0)}%):       $${invoice.financials.taxUsd.toFixed(2)}`,
      `TOTAL DUE:    $${invoice.financials.totalUsd.toFixed(2)} (NO REAL CHARGE)`,
      `================================================================================`
    );

    return lines.join('\n');
  }
}
