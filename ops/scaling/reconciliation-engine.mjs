/**
 * Creativanta Video Engine - Usage Reconciliation & Ledger Invariant Engine
 *
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", line 15:
 *     "0 lost accepted jobs / duplicate published artifact / duplicate billed entries. Invariant, bất kỳ violation là incident",
 *     "Usage/cost ledger và report", line 43:
 *     "Usage entries append-only, correction bằng compensating entry có reason/reference, không sửa lịch sử âm thầm",
 *     line 71: "Usage reconcile đảm bảo chỉ một billable entry/logical job")
 *   - docs/API.md ("GET /v1/usage/reconcile", line 172)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P9-02: "Usage export/quota plans/retention tiers, pricing simulation và reconciliation")
 */

import crypto from 'node:crypto';

export class ReconciliationEngine {
  constructor(options = {}) {
    // Ledger entries: Array<LedgerEntry> (append-only)
    this.ledger = [];
    // Job states: Map<jobId, JobStateRecord>
    this.jobStates = new Map();
    // Audit logs for reconciliation runs
    this.reconciliationAuditLog = [];
  }

  /**
   * Records a job state snapshot into the engine.
   */
  recordJobState(jobRecord) {
    if (!jobRecord || !jobRecord.jobId) {
      throw new Error("Job record must have 'jobId'");
    }
    this.jobStates.set(jobRecord.jobId, { ...jobRecord });
  }

  /**
   * Appends an operational, reservation, settlement, or release entry to the ledger.
   * Strictly maintains append-only integrity.
   */
  appendLedgerEntry(entry) {
    if (!entry.tenantId || !entry.jobId || !entry.entryType) {
      throw new Error("Ledger entry must specify 'tenantId', 'jobId', and 'entryType'");
    }

    const normalized = {
      entryId: entry.entryId || `led_${crypto.randomBytes(8).toString('hex')}`,
      tenantId: entry.tenantId,
      jobId: entry.jobId,
      entryType: entry.entryType, // 'RESERVATION', 'OPERATIONAL', 'SETTLEMENT', 'RELEASE', 'COMPENSATING_RECONCILIATION'
      isBillable: Boolean(entry.isBillable),
      billableOutputMinutes: Number(entry.billableOutputMinutes || 0),
      reservedUnitsUsd: Number(entry.reservedUnitsUsd || 0),
      settledUnitsUsd: Number(entry.settledUnitsUsd || 0),
      releasedUnitsUsd: Number(entry.releasedUnitsUsd || 0),
      wallSeconds: Number(entry.wallSeconds || 0),
      cpuSecondsActual: Number(entry.cpuSecondsActual || 0),
      reservedVcpuSeconds: Number(entry.reservedVcpuSeconds || 0),
      reason: entry.reason || null,
      discrepancyRef: entry.discrepancyRef || null,
      createdAt: entry.createdAt || new Date().toISOString(),
    };

    this.ledger.push(Object.freeze(normalized));
    return normalized;
  }

  /**
   * Performs comprehensive reconciliation scan across all jobs and ledger entries.
   * Verifies all core financial and usage invariants.
   */
  reconcile(tenantId = null) {
    const runId = `rec_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const targetJobs = tenantId
      ? Array.from(this.jobStates.values()).filter(j => j.tenantId === tenantId)
      : Array.from(this.jobStates.values());

    const targetLedger = tenantId
      ? this.ledger.filter(e => e.tenantId === tenantId)
      : this.ledger;

    const discrepancies = [];
    const jobsReconciled = [];

    // Group ledger entries by jobId
    const ledgerByJob = new Map();
    for (const entry of targetLedger) {
      if (!ledgerByJob.has(entry.jobId)) {
        ledgerByJob.set(entry.jobId, []);
      }
      ledgerByJob.get(entry.jobId).push(entry);
    }

    let totalBillableEntriesFound = 0;
    let totalCompensatingEntriesFound = 0;

    for (const job of targetJobs) {
      const jobId = job.jobId;
      const jobEntries = ledgerByJob.get(jobId) || [];
      const isTerminal = ['succeeded', 'failed', 'canceled'].includes(job.status);
      const isSucceeded = job.status === 'succeeded';
      const isPreview = job.jobKind === 'preview';

      // 1. Invariant: Single Billable Entry per Logical Job (accounting for compensating entries)
      const billableSettlements = jobEntries.filter(e => e.entryType === 'SETTLEMENT' && e.isBillable);
      const compensatingSettlements = jobEntries.filter(e =>
        e.entryType === 'COMPENSATING_RECONCILIATION' &&
        e.discrepancyRef &&
        e.discrepancyRef.startsWith('DOUBLE_BILLABLE_ENTRY')
      );
      const effectiveBillableCount = billableSettlements.length - compensatingSettlements.length;
      totalBillableEntriesFound += effectiveBillableCount;

      if (effectiveBillableCount > 1) {
        discrepancies.push({
          code: 'DOUBLE_BILLABLE_ENTRY',
          severity: 'CRITICAL',
          tenantId: job.tenantId,
          jobId,
          message: `Job has ${effectiveBillableCount} uncompensated billable settlement entries (violates 0-duplicate-billed invariant)`,
          entries: billableSettlements.map(e => e.entryId),
          excessEntriesCount: effectiveBillableCount - 1,
        });
      }

      // 2. Invariant: Succeeded render job must have exactly one settlement
      if (isSucceeded && !isPreview && effectiveBillableCount === 0) {
        discrepancies.push({
          code: 'UNSETTLED_SUCCEEDED_JOB',
          severity: 'HIGH',
          tenantId: job.tenantId,
          jobId,
          message: `Succeeded billable render job has no settled billable ledger entry`,
        });
      }

      // 3. Invariant: Reservation release on terminal state
      if (isTerminal) {
        const reservations = jobEntries.filter(e => e.entryType === 'RESERVATION');
        const settlements = jobEntries.filter(e => e.entryType === 'SETTLEMENT');
        const releases = jobEntries.filter(e => e.entryType === 'RELEASE');

        const totalReservedUsd = reservations.reduce((acc, r) => acc + r.reservedUnitsUsd, 0);
        const totalSettledUsd = settlements.reduce((acc, s) => acc + s.settledUnitsUsd, 0);
        const totalReleasedUsd = releases.reduce((acc, r) => acc + r.releasedUnitsUsd, 0);

        const unhandledReserve = Number((totalReservedUsd - totalSettledUsd - totalReleasedUsd).toFixed(6));

        if (unhandledReserve > 0.0001) {
          discrepancies.push({
            code: 'DANGLING_RESERVATION',
            severity: 'MEDIUM',
            tenantId: job.tenantId,
            jobId,
            message: `Terminal job has $${unhandledReserve.toFixed(6)} unreleased reserved budget`,
            danglingAmountUsd: unhandledReserve,
          });
        }
      }

      jobsReconciled.push({
        jobId,
        tenantId: job.tenantId,
        status: job.status,
        entryCount: jobEntries.length,
        billableEntriesCount: effectiveBillableCount,
      });
    }

    // 4. Invariant: Non-negative units on all standard ledger entries
    for (const entry of targetLedger) {
      if (entry.entryType === 'COMPENSATING_RECONCILIATION') {
        totalCompensatingEntriesFound += 1;
        continue; // Compensating reconciliation records are explicit offset adjustments
      }
      if (entry.billableOutputMinutes < 0 || entry.reservedUnitsUsd < 0 || entry.settledUnitsUsd < 0) {
        discrepancies.push({
          code: 'NEGATIVE_BALANCE_ENTRY',
          severity: 'CRITICAL',
          tenantId: entry.tenantId,
          jobId: entry.jobId,
          entryId: entry.entryId,
          message: `Ledger entry contains negative quantity values`,
        });
      }
    }

    const isHealthy = discrepancies.length === 0;
    const report = {
      runId,
      timestamp,
      tenantId: tenantId || 'all_tenants',
      status: isHealthy ? 'BALANCED' : 'DISCREPANCY_DETECTED',
      invariants: {
        zeroDuplicateBilledEntries: !discrepancies.some(d => d.code === 'DOUBLE_BILLABLE_ENTRY'),
        reservationReleaseConsistent: !discrepancies.some(d => d.code === 'DANGLING_RESERVATION'),
        succeededJobsSettled: !discrepancies.some(d => d.code === 'UNSETTLED_SUCCEEDED_JOB'),
        nonNegativeBalances: !discrepancies.some(d => d.code === 'NEGATIVE_BALANCE_ENTRY'),
      },
      metrics: {
        scannedJobsCount: targetJobs.length,
        scannedLedgerEntriesCount: targetLedger.length,
        billableEntriesCount: totalBillableEntriesFound,
        compensatingEntriesCount: totalCompensatingEntriesFound,
        discrepanciesCount: discrepancies.length,
      },
      discrepancies,
    };

    this.reconciliationAuditLog.push(report);
    return report;
  }

  /**
   * Automatically repairs discrepancies by generating compensating append-only entries.
   * As mandated by docs/OPERATIONS.md line 43:
   * "Usage entries append-only, correction bằng compensating entry có reason/reference, không sửa lịch sử âm thầm."
   */
  generateCompensatingEntries(reconciliationReport) {
    if (!reconciliationReport || !reconciliationReport.discrepancies) {
      throw new Error("Invalid reconciliation report");
    }

    const generatedCompensations = [];

    for (const d of reconciliationReport.discrepancies) {
      if (d.code === 'DOUBLE_BILLABLE_ENTRY') {
        // Compensate the excess billable entries
        const targetJob = this.jobStates.get(d.jobId);
        const excessEntries = d.entries.slice(1); // Keep first, compensate remainder

        for (const excessId of excessEntries) {
          const comp = this.appendLedgerEntry({
            tenantId: d.tenantId,
            jobId: d.jobId,
            entryType: 'COMPENSATING_RECONCILIATION',
            isBillable: false,
            billableOutputMinutes: targetJob ? -Number((targetJob.outputDurationSeconds / 60).toFixed(6)) : 0,
            settledUnitsUsd: 0,
            reason: `Compensating double billable entry ${excessId} for job ${d.jobId}`,
            discrepancyRef: `${d.code}:${excessId}`,
          });
          generatedCompensations.push(comp);
        }
      } else if (d.code === 'DANGLING_RESERVATION') {
        // Release the dangling reservation
        const comp = this.appendLedgerEntry({
          tenantId: d.tenantId,
          jobId: d.jobId,
          entryType: 'RELEASE',
          releasedUnitsUsd: d.danglingAmountUsd,
          reason: `Compensating release for dangling reservation on terminal job ${d.jobId}`,
          discrepancyRef: `${d.code}:${d.jobId}`,
        });
        generatedCompensations.push(comp);
      } else if (d.code === 'UNSETTLED_SUCCEEDED_JOB') {
        // Generate settlement for missing succeeded job
        const targetJob = this.jobStates.get(d.jobId);
        const outputDuration = targetJob?.outputDurationSeconds || 15;
        const minutes = outputDuration / 60;
        const comp = this.appendLedgerEntry({
          tenantId: d.tenantId,
          jobId: d.jobId,
          entryType: 'SETTLEMENT',
          isBillable: true,
          billableOutputMinutes: Number(minutes.toFixed(6)),
          settledUnitsUsd: targetJob?.allocatedCostUsd || 0.005,
          reason: `Compensating settlement for previously unsettled succeeded job ${d.jobId}`,
          discrepancyRef: `${d.code}:${d.jobId}`,
        });
        generatedCompensations.push(comp);
      }
    }

    return {
      generatedCount: generatedCompensations.length,
      compensatingEntries: generatedCompensations,
    };
  }
}
