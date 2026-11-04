/**
 * Test Suite: Prometheus Metrics & Operational Telemetry
 * Canonical specification: docs/OPERATIONS.md ("Metrics và logs", lines 22-36)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MetricsRegistry, validateLabels } from '../metrics/metrics-registry.mjs';
import { createMetricsServer } from '../metrics/metrics-server.mjs';

describe('Prometheus Metrics & Telemetry Suite', () => {
  it('registers all 23 canonical metrics specified in docs/OPERATIONS.md', () => {
    const registry = new MetricsRegistry();

    const expectedMetrics = [
      'cve_api_requests_total',
      'cve_api_duration_seconds',
      'cve_jobs_queued',
      'cve_queue_oldest_seconds',
      'cve_queue_wait_seconds',
      'cve_jobs_terminal_total',
      'cve_job_stage_seconds',
      'cve_worker_slots',
      'cve_lease_expired_total',
      'cve_stale_publish_rejected_total',
      'cve_render_cpu_seconds',
      'cve_render_wall_seconds',
      'cve_peak_memory_bytes',
      'cve_temp_bytes',
      'cve_orphan_objects',
      'cve_disk_free_ratio',
      'cve_webhook_pending',
      'cve_webhook_delivery_seconds',
      'cve_webhook_attempts_total',
      'cve_usage_reserved_units',
      'cve_usage_settled_units',
      'cve_usage_reconcile_errors_total',
      'cve_sandbox_denials_total',
      'cve_asset_rejections_total',
    ];

    for (const name of expectedMetrics) {
      const metric = registry.getMetric(name);
      assert.ok(metric, `Metric '${name}' must be registered`);
    }
  });

  it('strictly forbids job_id or tenant_id as Prometheus labels to prevent cardinality/leakage', () => {
    assert.throws(
      () => validateLabels({ job_id: 'job_12345' }),
      /Security\/Cardinality Violation: Label 'job_id' is forbidden/
    );

    assert.throws(
      () => validateLabels({ tenant_id: 'tenant_alpha' }),
      /Security\/Cardinality Violation: Label 'tenant_id' is forbidden/
    );

    assert.throws(
      () => validateLabels({ customer_id: 'cust_001' }),
      /Security\/Cardinality Violation: Label 'customer_id' is forbidden/
    );
  });

  it('allows bounded metric labels (profile, adapter, stage, pool, error_code, etc.)', () => {
    assert.doesNotThrow(() => {
      validateLabels({
        profile: 'mp4-720p-v1',
        adapter: 'chromium-frame-v1',
        stage: 'render',
        pool: 'default',
        status: '200',
        error_code: 'NONE',
      });
    });
  });

  it('tracks counters, gauges, and histograms accurately', () => {
    const registry = new MetricsRegistry();

    const counter = registry.getMetric('cve_api_requests_total');
    counter.inc({ method: 'GET', route: '/v1/render-jobs/:id', status: '200' }, 3);
    assert.strictEqual(counter.get({ method: 'GET', route: '/v1/render-jobs/:id', status: '200' }), 3);

    const gauge = registry.getMetric('cve_worker_slots');
    gauge.set({ pool: 'default', state: 'active' }, 4);
    assert.strictEqual(gauge.get({ pool: 'default', state: 'active' }), 4);
    gauge.dec({ pool: 'default', state: 'active' }, 1);
    assert.strictEqual(gauge.get({ pool: 'default', state: 'active' }), 3);

    const histogram = registry.getMetric('cve_api_duration_seconds');
    histogram.observe({ method: 'GET', route: '/v1/render-jobs/:id', status: '200' }, 0.045);
    histogram.observe({ method: 'GET', route: '/v1/render-jobs/:id', status: '200' }, 0.120);

    const output = registry.toPrometheus();
    assert.ok(output.includes('# TYPE cve_api_requests_total counter'));
    assert.ok(output.includes('cve_api_requests_total{method="GET",route="/v1/render-jobs/:id",status="200"} 3'));
    assert.ok(output.includes('cve_worker_slots{pool="default",state="active"} 3'));
    assert.ok(output.includes('cve_api_duration_seconds_bucket'));
    assert.ok(output.includes('cve_api_duration_seconds_sum'));
    assert.ok(output.includes('cve_api_duration_seconds_count'));
  });

  it('serves Prometheus exposition text over HTTP server', async () => {
    const registry = new MetricsRegistry();
    registry.getMetric('cve_jobs_queued').set({ pool: 'default', profile: 'mp4-720p-v1', adapter: 'chromium-frame-v1' }, 2);

    const testPort = 19092;
    const server = createMetricsServer(registry, testPort);
    await server.listen();

    try {
      const res = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${testPort}/metrics`, (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
          res.on('error', reject);
        });
      });

      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/plain'));
      assert.ok(res.data.includes('cve_jobs_queued{adapter="chromium-frame-v1",pool="default",profile="mp4-720p-v1"} 2'));
    } finally {
      await server.close();
    }
  });
});
