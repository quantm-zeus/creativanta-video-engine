/**
 * Creativanta Video Engine - Distributed Tracing & Correlation Module
 * Canonical specification: docs/OPERATIONS.md (line 37)
 *
 * Correlation chain:
 *   request_id -> job_id -> attempt_id / lease_epoch -> artifact_ids -> event_id / delivery_id
 */

import crypto from 'node:crypto';

/**
 * Validates or generates a standard UUID / opaque identifier.
 */
export function generateCorrelationId(prefix = 'cve') {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Generates standard W3C traceparent header: 00-{trace_id}-{span_id}-01
 */
export function generateW3cTraceparent(traceId, spanId) {
  const tId = traceId || crypto.randomBytes(16).toString('hex');
  const sId = spanId || crypto.randomBytes(8).toString('hex');
  return `00-${tId}-${sId}-01`;
}

/**
 * Parses a standard W3C traceparent header.
 */
export function parseW3cTraceparent(header) {
  if (!header || typeof header !== 'string') return null;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header.trim());
  if (!match) return null;
  return {
    version: '00',
    traceId: match[1],
    parentSpanId: match[2],
    traceFlags: match[3],
  };
}

export class Span {
  constructor({
    name,
    traceId,
    spanId,
    parentSpanId = null,
    correlation = {},
    tags = {},
  }) {
    this.name = name;
    this.traceId = traceId || crypto.randomBytes(16).toString('hex');
    this.spanId = spanId || crypto.randomBytes(8).toString('hex');
    this.parentSpanId = parentSpanId;
    this.startTime = Date.now();
    this.endTime = null;
    this.durationMs = null;
    this.status = 'UNSET'; // OK | ERROR | UNSET
    this.error = null;
    this.events = []; // array of { name, timestamp, attributes }
    this.tags = { ...tags };
    this.correlation = {
      requestId: correlation.requestId || null,
      jobId: correlation.jobId || null,
      attemptId: correlation.attemptId || null,
      leaseEpoch: correlation.leaseEpoch !== undefined ? correlation.leaseEpoch : null,
      artifactIds: correlation.artifactIds ? [...correlation.artifactIds] : [],
      eventId: correlation.eventId || null,
      deliveryId: correlation.deliveryId || null,
    };
  }

  setTag(key, value) {
    this.tags[key] = value;
    return this;
  }

  setCorrelation(fields = {}) {
    if (fields.requestId) this.correlation.requestId = fields.requestId;
    if (fields.jobId) this.correlation.jobId = fields.jobId;
    if (fields.attemptId) this.correlation.attemptId = fields.attemptId;
    if (fields.leaseEpoch !== undefined) this.correlation.leaseEpoch = fields.leaseEpoch;
    if (fields.artifactIds) {
      this.correlation.artifactIds = Array.from(new Set([...this.correlation.artifactIds, ...fields.artifactIds]));
    }
    if (fields.eventId) this.correlation.eventId = fields.eventId;
    if (fields.deliveryId) this.correlation.deliveryId = fields.deliveryId;
    return this;
  }

  addEvent(name, attributes = {}) {
    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
    return this;
  }

  recordError(error) {
    this.status = 'ERROR';
    this.error = {
      message: error instanceof Error ? error.message : String(error),
      code: error && typeof error === 'object' && 'code' in error ? error.code : 'INTERNAL_ERROR',
      stack: error instanceof Error ? error.stack : undefined,
    };
    return this;
  }

  finish(status = 'OK') {
    if (!this.endTime) {
      this.endTime = Date.now();
      this.durationMs = this.endTime - this.startTime;
      if (this.status === 'UNSET') {
        this.status = status;
      }
    }
    return this;
  }

  getTraceparent() {
    return generateW3cTraceparent(this.traceId, this.spanId);
  }

  toJSON() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      status: this.status,
      error: this.error,
      tags: this.tags,
      events: this.events,
      correlation: this.correlation,
    };
  }
}

export class Tracer {
  constructor(serviceName = 'creativanta-video-engine') {
    this.serviceName = serviceName;
    this.spans = [];
  }

  startSpan(name, options = {}) {
    let traceId = options.traceId;
    let parentSpanId = options.parentSpanId || null;

    if (options.headers) {
      const traceparent = options.headers['traceparent'] || options.headers['Traceparent'];
      const parsed = parseW3cTraceparent(traceparent);
      if (parsed) {
        traceId = parsed.traceId;
        parentSpanId = parsed.parentSpanId;
      }
    }

    const span = new Span({
      name,
      traceId,
      spanId: options.spanId,
      parentSpanId,
      correlation: options.correlation || {},
      tags: { service: this.serviceName, ...(options.tags || {}) },
    });

    this.spans.push(span);
    return span;
  }

  findSpansByJobId(jobId) {
    return this.spans.filter((s) => s.correlation.jobId === jobId);
  }

  findSpansByRequestId(requestId) {
    return this.spans.filter((s) => s.correlation.requestId === requestId);
  }

  findSpansByDeliveryId(deliveryId) {
    return this.spans.filter((s) => s.correlation.deliveryId === deliveryId);
  }

  clear() {
    this.spans = [];
  }
}

export const defaultTracer = new Tracer();
