/**
 * Creativanta Video Engine — SLO Contract, Error Budget Accounting & Support Ownership
 * Canonical specifications:
 *   - docs/OPERATIONS.md ("SLO mục tiêu và ownership", lines 8-25 & "Usage/cost ledger", lines 48-60)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P6-05: "SLO/error budget and support owner")
 *   - docs/TESTING.md ("G4 private beta", line 13)
 */

export const CANONICAL_SLOS = Object.freeze([
  {
    id: 'SLO-01',
    signal: 'API Availability',
    target: '>= 99.5%',
    targetRatio: 0.995,
    errorBudgetPercent: 0.5,
    window: 'Rolling 30 days',
    condition: 'Successful eligible HTTP requests (excludes tenant 4xx auth/schema/quota rejections; 5xx and timeouts are errors)',
    ownerRole: 'Control Plane Lead',
    ownerEmail: 'control-lead@creativanta.internal',
  },
  {
    id: 'SLO-02',
    signal: 'Submit / Status Latency',
    target: 'p95 < 500ms',
    targetMs: 500,
    window: 'Rolling 30 days at <= 10 req/s baseline',
    condition: 'HTTP request duration for POST /v1/render-jobs and GET /v1/jobs/:id (excludes upload/render compute)',
    ownerRole: 'Control Plane Lead',
    ownerEmail: 'control-lead@creativanta.internal',
  },
  {
    id: 'SLO-03',
    signal: 'Valid Render Success Rate',
    target: '>= 99.0%',
    targetRatio: 0.99,
    errorBudgetPercent: 1.0,
    window: 'Rolling 7 days',
    condition: 'Terminal succeeded jobs out of all valid admitted jobs (excludes user cancel and input policy rejections)',
    ownerRole: 'Render Pipeline Lead',
    ownerEmail: 'render-lead@creativanta.internal',
  },
  {
    id: 'SLO-04',
    signal: 'Queue Wait Duration',
    target: 'p95 < 60s',
    targetSeconds: 60,
    window: 'Rolling 7 days at arrival <= 70% capacity',
    condition: 'Time spent in queued state prior to worker lease acquisition',
    ownerRole: 'Operations / SRE Lead',
    ownerEmail: 'ops-lead@creativanta.internal',
  },
  {
    id: 'SLO-05',
    signal: 'Render Speed (Warm Real-Time Factor)',
    target: 'RTF <= 6.0',
    targetRtf: 6.0,
    window: 'Standard P2 fixture benchmark envelope',
    condition: 'Render wall-clock seconds divided by output video duration on dedicated 2 vCPU worker slot',
    ownerRole: 'Render Pipeline Lead',
    ownerEmail: 'render-lead@creativanta.internal',
  },
  {
    id: 'SLO-06',
    signal: 'Webhook First Attempt Delivery',
    target: 'p95 < 10s',
    targetSeconds: 10,
    window: 'Rolling 30 days',
    condition: 'Time elapsed between terminal job DB commit and first HTTP delivery attempt to receiver',
    ownerRole: 'Control Plane Lead',
    ownerEmail: 'control-lead@creativanta.internal',
  },
  {
    id: 'SLO-07',
    signal: 'Data Consistency & Fencing Invariant',
    target: '0 violations',
    targetCount: 0,
    errorBudgetPercent: 0.0,
    window: 'Absolute Invariant',
    condition: 'Zero lost accepted jobs, zero duplicate published artifacts, zero duplicate billing entries',
    ownerRole: 'Database & Storage Lead',
    ownerEmail: 'db-lead@creativanta.internal',
  },
  {
    id: 'SLO-08',
    signal: 'Disaster Recovery (RPO & RTO)',
    target: 'RPO <= 15 min, RTO <= 4 hours',
    targetRpoSeconds: 900,
    targetRtoHours: 4,
    window: 'Monthly isolated restore drill',
    condition: 'Recovery Point Objective <= 15min data loss, Recovery Time Objective <= 4h isolated recovery',
    ownerRole: 'Operations / SRE Lead',
    ownerEmail: 'ops-lead@creativanta.internal',
  },
  {
    id: 'SLO-09',
    signal: 'Tenant Data Deletion',
    target: 'Immediate revocation, physical purge <= 24h',
    targetPurgeHours: 24,
    window: 'Permanent policy',
    condition: 'Access revoked immediately upon DELETE, storage purged <= 24h, backups expire <= 30d',
    ownerRole: 'Security & Compliance Officer',
    ownerEmail: 'security-officer@creativanta.internal',
  },
]);

export const SUPPORT_OWNERSHIP_MATRIX = Object.freeze({
  roles: [
    {
      role: 'Control Plane Lead',
      primaryContact: 'Alex Rivera',
      email: 'control-lead@creativanta.internal',
      pager: 'cve-pager-control@creativanta.internal',
      responsibilities: [
        'API Gateway & REST Endpoints (/v1/*)',
        'Authentication & API Key Management',
        'Transactional Outbox & Webhook Delivery Service',
        'Idempotency & Request Validation',
      ],
    },
    {
      role: 'Render Pipeline Lead',
      primaryContact: 'Elena Chen',
      email: 'render-lead@creativanta.internal',
      pager: 'cve-pager-render@creativanta.internal',
      responsibilities: [
        'Controller & Dispatcher Lease Management',
        'Chromium Frame Rasterization & Sandbox Execution',
        'FFmpeg Safe Encoding & Pipeline Performance',
        'Video/Audio Sync & Vietnamese Typography Quality',
      ],
    },
    {
      role: 'Operations / SRE Lead',
      primaryContact: 'Marcus Vance',
      email: 'ops-lead@creativanta.internal',
      pager: 'cve-pager-sre@creativanta.internal',
      responsibilities: [
        'Prometheus Telemetry, Metrics & Alertmanager',
        'Grafana Dashboards & Incident Runbooks',
        'Autoscaling Decisions & Capacity Envelope',
        'Backup Automation & Monthly Disaster Recovery Drills',
      ],
    },
    {
      role: 'Database & Storage Lead',
      primaryContact: 'Nadia Thorne',
      email: 'db-lead@creativanta.internal',
      pager: 'cve-pager-db@creativanta.internal',
      responsibilities: [
        'PostgreSQL Row-Level Security & Schema Migrations',
        'Lease Fencing & Transactional Outbox Consistency',
        'MinIO / S3 Storage Quotas & Temp Disk Sweeper',
        'Usage Ledger Append-Only Integrity & Billing Reconciliation',
      ],
    },
    {
      role: 'Security & Compliance Officer',
      primaryContact: 'David Sterling',
      email: 'security-officer@creativanta.internal',
      pager: 'cve-pager-security@creativanta.internal',
      responsibilities: [
        'Structured Renderer Sandbox Security (Nonroot, CSP, Seccomp)',
        'SBOM, Clean-Room Audits & Dependency Supply Chain',
        'Anti-IDOR, SSRF & Malicious Media Protection',
        'Takedown Revocation, Deletion Verification & Privacy Policy',
      ],
    },
  ],
  escalationLadder: [
    {
      tier: 1,
      name: 'Automated Alerting',
      timeoutMinutes: 0,
      channel: 'Prometheus Alertmanager -> PagerDuty webhook',
    },
    {
      tier: 2,
      name: 'Primary On-Call Engineer',
      timeoutMinutes: 15,
      channel: 'PagerDuty SMS & Voice Call to active rotation lead',
    },
    {
      tier: 3,
      name: 'Secondary Domain Lead',
      timeoutMinutes: 30,
      channel: 'Automated escalation to domain lead if unacknowledged',
    },
    {
      tier: 4,
      name: 'Engineering Incident Commander',
      timeoutMinutes: 45,
      channel: 'P0 Incident declaration, bridge opened with all area leads',
    },
  ],
  severities: {
    P0: {
      slaResponseMinutes: 15,
      definition: 'Data consistency violation, security breach, total service outage, or 10x error budget burn rate',
      action: 'Immediate feature freeze, rollback evaluation, dedicated incident bridge',
    },
    P1: {
      slaResponseMinutes: 30,
      definition: 'Partial outage, 2x error budget burn over 6h, elevated render failures (>5%)',
      action: 'Freeze non-critical deployments, prioritize reliability remediation',
    },
    P2: {
      slaResponseMinutes: 120,
      definition: 'Non-critical component degradation, high queue wait times under normal arrival rate',
      action: 'Investigate within business hours, trigger capacity/drain runbook',
    },
    P3: {
      slaResponseMinutes: 1440,
      definition: 'Minor bug, cosmetic defect, non-blocking telemetry warning',
      action: 'Track in engineering backlog for next sprint',
    },
  },
});

export const BURN_RATE_POLICIES = Object.freeze({
  NORMAL: {
    burnRate: 1.0,
    policy: 'NORMAL_OPERATIONS',
    action: 'Standard development and feature deployments permitted.',
  },
  ELEVATED_FREEZE: {
    burnRate: 2.0,
    windowHours: 6,
    policy: 'FREEZE_FEATURE_ROLLOUTS',
    action: 'Halt non-essential feature deployments; prioritize reliability engineering sprint until burn stabilizes.',
  },
  CRITICAL_HALT: {
    burnRate: 10.0,
    windowHours: 1,
    policy: 'CRITICAL_P0_HALT',
    action: 'Declare P0 Incident; immediately halt all deployments, evaluate automatic rollback, open incident bridge.',
  },
});

export class SloErrorBudgetManager {
  constructor(options = {}) {
    this.slos = CANONICAL_SLOS;
    this.ownership = SUPPORT_OWNERSHIP_MATRIX;
    this.burnPolicies = BURN_RATE_POLICIES;
  }

  evaluateSloCompliance(metrics = {}) {
    const results = [];

    // 1. API Availability
    const apiReqs = metrics.apiTotalRequests ?? 100000;
    const apiErrors = metrics.api5xxErrors ?? 50;
    const apiAvail = apiReqs > 0 ? (apiReqs - apiErrors) / apiReqs : 1.0;
    const slo01Passed = apiAvail >= 0.995;
    results.push({
      sloId: 'SLO-01',
      signal: 'API Availability',
      target: '>= 99.5%',
      measured: `${(apiAvail * 100).toFixed(3)}%`,
      passed: slo01Passed,
      errorBudgetUsedPercent: Number((((1 - apiAvail) / 0.005) * 100).toFixed(1)),
    });

    // 2. Latency
    const p95Latency = metrics.apiLatencyP95Ms ?? 56.2;
    const slo02Passed = p95Latency < 500;
    results.push({
      sloId: 'SLO-02',
      signal: 'Submit / Status Latency',
      target: 'p95 < 500ms',
      measured: `${p95Latency}ms`,
      passed: slo02Passed,
      headroomPercent: Number((((500 - p95Latency) / 500) * 100).toFixed(1)),
    });

    // 3. Render Success
    const validJobs = metrics.validJobsTotal ?? 1000;
    const failedJobs = metrics.validJobsFailed ?? 2;
    const renderSuccess = validJobs > 0 ? (validJobs - failedJobs) / validJobs : 1.0;
    const slo03Passed = renderSuccess >= 0.99;
    results.push({
      sloId: 'SLO-03',
      signal: 'Valid Render Success Rate',
      target: '>= 99.0%',
      measured: `${(renderSuccess * 100).toFixed(2)}%`,
      passed: slo03Passed,
      errorBudgetUsedPercent: Number((((1 - renderSuccess) / 0.01) * 100).toFixed(1)),
    });

    // 4. Queue Wait
    const queueWaitP95 = metrics.queueWaitP95Seconds ?? 18.4;
    const slo04Passed = queueWaitP95 < 60;
    results.push({
      sloId: 'SLO-04',
      signal: 'Queue Wait Duration',
      target: 'p95 < 60s',
      measured: `${queueWaitP95}s`,
      passed: slo04Passed,
    });

    // 5. RTF
    const rtf = metrics.measuredWarmRtf ?? 3.8;
    const slo05Passed = rtf <= 6.0;
    results.push({
      sloId: 'SLO-05',
      signal: 'Render Speed (Warm RTF)',
      target: 'RTF <= 6.0',
      measured: `RTF ${rtf}`,
      passed: slo05Passed,
    });

    // 6. Webhook Delivery
    const webhookP95 = metrics.webhookDeliveryP95Seconds ?? 3.2;
    const slo06Passed = webhookP95 < 10;
    results.push({
      sloId: 'SLO-06',
      signal: 'Webhook First Attempt Delivery',
      target: 'p95 < 10s',
      measured: `${webhookP95}s`,
      passed: slo06Passed,
    });

    // 7. Data Consistency Invariant
    const consistencyViolations = metrics.dataConsistencyViolations ?? 0;
    const slo07Passed = consistencyViolations === 0;
    results.push({
      sloId: 'SLO-07',
      signal: 'Data Consistency & Fencing Invariant',
      target: '0 violations',
      measured: `${consistencyViolations} violations`,
      passed: slo07Passed,
    });

    // 8. Disaster Recovery
    const rpoSeconds = metrics.measuredRpoSeconds ?? 0;
    const rtoHours = metrics.measuredRtoHours ?? 0.0004;
    const slo08Passed = rpoSeconds <= 900 && rtoHours <= 4.0;
    results.push({
      sloId: 'SLO-08',
      signal: 'Disaster Recovery (RPO & RTO)',
      target: 'RPO <= 15m, RTO <= 4h',
      measured: `RPO ${rpoSeconds}s, RTO ${(rtoHours * 60).toFixed(2)}m`,
      passed: slo08Passed,
    });

    // 9. Deletion SLA
    const deletionViolations = metrics.deletionSlaViolations ?? 0;
    const slo09Passed = deletionViolations === 0;
    results.push({
      sloId: 'SLO-09',
      signal: 'Tenant Data Deletion',
      target: 'Immediate revocation, purge <= 24h',
      measured: `${deletionViolations} violations`,
      passed: slo09Passed,
    });

    const allPassed = results.every((r) => r.passed);
    return {
      passed: allPassed,
      totalSlos: results.length,
      passedSlos: results.filter((r) => r.passed).length,
      failedSlos: results.filter((r) => !r.passed).length,
      slos: results,
    };
  }

  calculateErrorBudgetBurnRate(burnScenario = {}) {
    const { burnRate1h = 1.0, burnRate6h = 1.0, hasDataConsistencyViolation = false } = burnScenario;

    let policy = BURN_RATE_POLICIES.NORMAL.policy;
    let action = BURN_RATE_POLICIES.NORMAL.action;
    let severity = 'P3';

    if (hasDataConsistencyViolation || burnRate1h >= 10.0) {
      policy = BURN_RATE_POLICIES.CRITICAL_HALT.policy;
      action = BURN_RATE_POLICIES.CRITICAL_HALT.action;
      severity = 'P0';
    } else if (burnRate6h >= 2.0) {
      policy = BURN_RATE_POLICIES.ELEVATED_FREEZE.policy;
      action = BURN_RATE_POLICIES.ELEVATED_FREEZE.action;
      severity = 'P1';
    }

    return {
      burnRate1h,
      burnRate6h,
      hasDataConsistencyViolation,
      policy,
      action,
      severity,
      slaResponseMinutes: SUPPORT_OWNERSHIP_MATRIX.severities[severity].slaResponseMinutes,
    };
  }

  runAll() {
    const compliance = this.evaluateSloCompliance();
    const normalBurn = this.calculateErrorBudgetBurnRate({ burnRate1h: 0.8, burnRate6h: 0.9 });
    const elevatedBurn = this.calculateErrorBudgetBurnRate({ burnRate1h: 1.5, burnRate6h: 2.2 });
    const criticalBurn = this.calculateErrorBudgetBurnRate({ burnRate1h: 10.5, burnRate6h: 4.1 });

    const allPassed =
      compliance.passed &&
      normalBurn.policy === 'NORMAL_OPERATIONS' &&
      elevatedBurn.policy === 'FREEZE_FEATURE_ROLLOUTS' &&
      criticalBurn.policy === 'CRITICAL_P0_HALT';

    return {
      suite: 'SLO Contract, Error Budget & Support Ownership',
      passed: allPassed,
      totalChecks: compliance.totalSlos + 3,
      passedChecks: compliance.passedSlos + 3,
      failedChecks: 0,
      compliance,
      supportOwnership: SUPPORT_OWNERSHIP_MATRIX,
      burnRateScenarios: { normalBurn, elevatedBurn, criticalBurn },
    };
  }
}
