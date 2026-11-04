/**
 * Test Suite: Distributed Tracing & Correlation Pipeline
 * Canonical specification: docs/OPERATIONS.md (line 37)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Tracer,
  parseW3cTraceparent,
  generateW3cTraceparent,
} from '../tracing/trace-context.mjs';

describe('Distributed Tracing & Context Propagation Suite', () => {
  it('generates and parses standard W3C traceparent headers', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    const header = generateW3cTraceparent(traceId, spanId);

    assert.strictEqual(header, `00-${traceId}-${spanId}-01`);

    const parsed = parseW3cTraceparent(header);
    assert.ok(parsed);
    assert.strictEqual(parsed.version, '00');
    assert.strictEqual(parsed.traceId, traceId);
    assert.strictEqual(parsed.parentSpanId, spanId);
    assert.strictEqual(parsed.traceFlags, '01');
  });

  it('preserves complete correlation chain across execution stages', () => {
    const tracer = new Tracer('cve-test-tracer');

    const requestId = 'req-synth-1001';
    const jobId = 'job-synth-1002';
    const attemptId = 'att-synth-1003';
    const leaseEpoch = 2;
    const artifactIds = ['art-synth-vid-01', 'art-synth-thumb-01'];
    const eventId = 'evt-synth-1004';
    const deliveryId = 'dlv-synth-1005';

    // 1. Admission span
    const admissionSpan = tracer.startSpan('api.admit_job', {
      correlation: { requestId, jobId },
    });
    admissionSpan.setTag('http.method', 'POST');
    admissionSpan.finish('OK');

    // 2. Dispatcher span (child of admission or correlated)
    const renderSpan = tracer.startSpan('worker.render_attempt', {
      traceId: admissionSpan.traceId,
      parentSpanId: admissionSpan.spanId,
      correlation: { requestId, jobId, attemptId, leaseEpoch },
    });
    renderSpan.setCorrelation({ artifactIds });
    renderSpan.addEvent('compile_complete', { duration_ms: 120 });
    renderSpan.addEvent('render_frames_complete', { frame_count: 450 });
    renderSpan.finish('OK');

    // 3. Webhook delivery span
    const webhookSpan = tracer.startSpan('outbox.deliver_webhook', {
      traceId: admissionSpan.traceId,
      correlation: { requestId, jobId, artifactIds, eventId, deliveryId },
    });
    webhookSpan.finish('OK');

    // Verification
    const jobSpans = tracer.findSpansByJobId(jobId);
    assert.strictEqual(jobSpans.length, 3);

    const deliverySpans = tracer.findSpansByDeliveryId(deliveryId);
    assert.strictEqual(deliverySpans.length, 1);
    assert.deepStrictEqual(deliverySpans[0].correlation.artifactIds, artifactIds);
    assert.strictEqual(deliverySpans[0].correlation.leaseEpoch, null); // not attached to delivery span
    assert.strictEqual(deliverySpans[0].correlation.eventId, eventId);
  });

  it('records errors and stack traces accurately in spans', () => {
    const tracer = new Tracer('cve-test-tracer');
    const span = tracer.startSpan('worker.render_attempt', {
      correlation: { jobId: 'job-err-01' },
    });

    const error = new Error('Chromium rendering timed out after 30s');
    error.code = 'RENDER_TIMEOUT';
    span.recordError(error);
    span.finish();

    assert.strictEqual(span.status, 'ERROR');
    assert.ok(span.error);
    assert.strictEqual(span.error.code, 'RENDER_TIMEOUT');
    assert.ok(span.error.message.includes('timed out'));
    assert.ok(span.durationMs >= 0);
  });
});
