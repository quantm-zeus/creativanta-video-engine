/**
 * Creativanta Video Engine - Prometheus Metrics Registry & Collector
 * Canonical specification: docs/OPERATIONS.md ("Metrics và logs", lines 22-36)
 *
 * IMPORTANT:
 * - Labels are strictly bounded (profile, adapter, stage, error_code, pool, route, status, etc.).
 * - FORBIDDEN: job_id or tenant_id as Prometheus labels to prevent cardinality explosion and data leakage.
 * - Conforms to Prometheus text exposition format v0.0.4.
 */

export const FORBIDDEN_LABEL_KEYS = new Set([
  'job_id',
  'jobid',
  'tenant_id',
  'tenantid',
  'customer_id',
  'user_id',
  'url',
  'payload',
  'prompt',
]);

export const ALLOWED_LABEL_KEYS = new Set([
  'method',
  'route',
  'status',
  'profile',
  'adapter',
  'stage',
  'error_code',
  'pool',
  'state',
  'bucket',
  'mount',
  'meter',
  'reason',
  'severity',
]);

/**
 * Validates that labels do not contain forbidden high-cardinality or sensitive keys.
 */
export function validateLabels(labels = {}) {
  for (const [key, value] of Object.entries(labels)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_LABEL_KEYS.has(lowerKey)) {
      throw new Error(
        `Security/Cardinality Violation: Label '${key}' is forbidden in Prometheus metrics. Use authorized audit/usage ledger for tenant/job breakdowns.`
      );
    }
    if (!ALLOWED_LABEL_KEYS.has(lowerKey)) {
      throw new Error(`Invalid metric label key '${key}'. Must be in bounded allowed labels set.`);
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`Metric label value for '${key}' must be a string or number.`);
    }
  }
}

/**
 * Formats label dictionary into Prometheus label string e.g. {stage="render",profile="mp4-720p-v1"}
 */
function formatLabels(labels = {}) {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const formatted = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${formatted}}`;
}

class Counter {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map(); // key -> number
  }

  inc(labels = {}, amount = 1) {
    if (amount < 0) {
      throw new Error(`Counter '${this.name}' cannot be decremented.`);
    }
    validateLabels(labels);
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + amount);
  }

  get(labels = {}) {
    const key = formatLabels(labels);
    return this.values.get(key) || 0;
  }

  reset() {
    this.values.clear();
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labels, val] of this.values.entries()) {
        lines.push(`${this.name}${labels} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

class Gauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.values = new Map(); // key -> number
  }

  set(labels = {}, value) {
    validateLabels(labels);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Gauge '${this.name}' value must be a valid number.`);
    }
    const key = formatLabels(labels);
    this.values.set(key, value);
  }

  inc(labels = {}, amount = 1) {
    validateLabels(labels);
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current + amount);
  }

  dec(labels = {}, amount = 1) {
    validateLabels(labels);
    const key = formatLabels(labels);
    const current = this.values.get(key) || 0;
    this.values.set(key, current - amount);
  }

  get(labels = {}) {
    const key = formatLabels(labels);
    return this.values.get(key) || 0;
  }

  reset() {
    this.values.clear();
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const [labels, val] of this.values.entries()) {
        lines.push(`${this.name}${labels} ${val}`);
      }
    }
    return lines.join('\n');
  }
}

class Histogram {
  constructor(name, help, labelNames = [], buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.data = new Map(); // key -> { count, sum, bucketCounts: Map(le -> count) }
  }

  observe(labels = {}, value) {
    validateLabels(labels);
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(`Histogram '${this.name}' observed value must be a valid number.`);
    }
    const key = formatLabels(labels);
    let entry = this.data.get(key);
    if (!entry) {
      entry = {
        count: 0,
        sum: 0,
        bucketCounts: new Map(this.buckets.map((b) => [b, 0])),
      };
      this.data.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (const b of this.buckets) {
      if (value <= b) {
        entry.bucketCounts.set(b, entry.bucketCounts.get(b) + 1);
      }
    }
  }

  reset() {
    this.data.clear();
  }

  toPrometheus() {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    if (this.data.size === 0) {
      lines.push(`${this.name}_count 0`);
      lines.push(`${this.name}_sum 0`);
    } else {
      for (const [labels, entry] of this.data.entries()) {
        const baseLabels = labels.length > 2 ? labels.slice(1, -1) : '';
        for (const b of this.buckets) {
          const leLabel = baseLabels ? `${baseLabels},le="${b}"` : `le="${b}"`;
          lines.push(`${this.name}_bucket{${leLabel}} ${entry.bucketCounts.get(b)}`);
        }
        const infLabel = baseLabels ? `${baseLabels},le="+Inf"` : `le="+Inf"`;
        lines.push(`${this.name}_bucket{${infLabel}} ${entry.count}`);
        lines.push(`${this.name}_sum${labels} ${entry.sum}`);
        lines.push(`${this.name}_count${labels} ${entry.count}`);
      }
    }
    return lines.join('\n');
  }
}

export class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.initializeStandardMetrics();
  }

  initializeStandardMetrics() {
    // API Metrics
    this.registerCounter(
      'cve_api_requests_total',
      'Total HTTP requests processed by route template and status',
      ['method', 'route', 'status']
    );
    this.registerHistogram(
      'cve_api_duration_seconds',
      'HTTP request processing duration in seconds',
      ['method', 'route', 'status'],
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    );

    // Queue & Dispatcher Metrics
    this.registerGauge(
      'cve_jobs_queued',
      'Number of jobs currently in queued state awaiting worker assignment',
      ['profile', 'adapter', 'pool']
    );
    this.registerGauge(
      'cve_queue_oldest_seconds',
      'Age in seconds of the oldest unassigned queued job in the pool',
      ['pool']
    );
    this.registerHistogram(
      'cve_queue_wait_seconds',
      'Time spent waiting in queue before worker lease acquisition',
      ['profile', 'pool'],
      [0.5, 1, 2, 5, 10, 30, 60, 120, 300]
    );

    // Job Lifecycle & Stage Metrics
    this.registerCounter(
      'cve_jobs_terminal_total',
      'Total jobs reaching terminal states (succeeded, failed, canceled)',
      ['profile', 'adapter', 'status', 'error_code']
    );
    this.registerHistogram(
      'cve_job_stage_seconds',
      'Execution duration per pipeline stage (compile, render, mux, publish)',
      ['stage', 'profile', 'adapter'],
      [0.1, 0.5, 1, 2, 5, 10, 20, 30, 60, 120]
    );

    // Worker Capacity & Fencing Metrics
    this.registerGauge(
      'cve_worker_slots',
      'Configured and active worker execution slots',
      ['pool', 'state']
    );
    this.registerCounter(
      'cve_lease_expired_total',
      'Number of worker task leases expired and reclaimed by the reaper',
      ['pool']
    );
    this.registerCounter(
      'cve_stale_publish_rejected_total',
      'Number of publish attempts rejected due to stale lease epoch or lost lease',
      ['pool']
    );

    // Hardware & Resource Utilization Metrics
    this.registerCounter(
      'cve_render_cpu_seconds',
      'Aggregated CPU seconds (user + system) consumed during rendering',
      ['profile', 'adapter']
    );
    this.registerCounter(
      'cve_render_wall_seconds',
      'Aggregated wall-clock seconds consumed during rendering',
      ['profile', 'adapter']
    );
    this.registerGauge(
      'cve_peak_memory_bytes',
      'Observed peak RSS memory consumption in bytes',
      ['profile', 'adapter']
    );

    // Storage & Cleanliness Metrics
    this.registerGauge(
      'cve_temp_bytes',
      'Active temporary disk space occupied by scratch/attempt directories',
      ['pool']
    );
    this.registerGauge(
      'cve_orphan_objects',
      'Count of detected orphan storage objects pending asynchronous sweep',
      ['bucket']
    );
    this.registerGauge(
      'cve_disk_free_ratio',
      'Ratio of available disk space on the primary execution filesystem (0.0 to 1.0)',
      ['mount']
    );

    // Webhook Delivery Metrics
    this.registerGauge(
      'cve_webhook_pending',
      'Number of webhook callback events pending transmission in outbox',
      ['pool']
    );
    this.registerHistogram(
      'cve_webhook_delivery_seconds',
      'Webhook callback delivery duration in seconds',
      ['status'],
      [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
    );
    this.registerCounter(
      'cve_webhook_attempts_total',
      'Total webhook delivery attempts by status outcome and error code',
      ['status', 'error_code']
    );

    // Usage Ledger & Reconciliation Metrics
    this.registerGauge(
      'cve_usage_reserved_units',
      'Currently active reserved usage quota units across admitted jobs',
      ['meter']
    );
    this.registerCounter(
      'cve_usage_settled_units',
      'Total cumulative settled usage units billed upon terminal success',
      ['meter']
    );
    this.registerCounter(
      'cve_usage_reconcile_errors_total',
      'Count of detected usage ledger discrepancies or duplicate reservation errors',
      ['reason']
    );

    // Security & Threat Detection Metrics
    this.registerCounter(
      'cve_sandbox_denials_total',
      'Security sandbox violations, blocked syscalls, or unauthorized egress attempts',
      ['reason']
    );
    this.registerCounter(
      'cve_asset_rejections_total',
      'Asset validation failures (unsupported mime, oversized, corrupt magic bytes, SVG XXE)',
      ['reason']
    );
  }

  registerCounter(name, help, labelNames = []) {
    const counter = new Counter(name, help, labelNames);
    this.counters.set(name, counter);
    return counter;
  }

  registerGauge(name, help, labelNames = []) {
    const gauge = new Gauge(name, help, labelNames);
    this.gauges.set(name, gauge);
    return gauge;
  }

  registerHistogram(name, help, labelNames = [], buckets) {
    const histogram = new Histogram(name, help, labelNames, buckets);
    this.histograms.set(name, histogram);
    return histogram;
  }

  getMetric(name) {
    return this.counters.get(name) || this.gauges.get(name) || this.histograms.get(name) || null;
  }

  resetAll() {
    for (const c of this.counters.values()) c.reset();
    for (const g of this.gauges.values()) g.reset();
    for (const h of this.histograms.values()) h.reset();
  }

  toPrometheus() {
    const sections = [];
    for (const c of this.counters.values()) sections.push(c.toPrometheus());
    for (const g of this.gauges.values()) sections.push(g.toPrometheus());
    for (const h of this.histograms.values()) sections.push(h.toPrometheus());
    return sections.join('\n\n') + '\n';
  }
}

// Default singleton registry for the process
export const defaultRegistry = new MetricsRegistry();
