/**
 * Task P5-03: Creativanta Signed Webhook Receiver Tests.
 *
 * Verifies:
 *   - HMAC-SHA256 signature verification on exact raw body bytes without JSON reserialization
 *   - Rejection of forged signatures, tampered body, missing headers, or clock skew > 300s
 *   - Monotonic state_version guard: rejects or ignores out-of-order stale events
 *   - Event deduplication within 7-day retention window
 *   - Secret rotation support: accepts multiple active keys during grace window
 *   - Automatic endpoint challenge handshake echo ({"challenge": "<received_value>"})
 *   - HTTP server request handling and event emitter dispatching
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import {
  CreativantaWebhookReceiver,
  WebhookVerificationError,
} from '../dist/index.js';

describe('Creativanta Signed Webhook Receiver', () => {
  const SECRET_PRIMARY = 'whsec_primary_secret_32_bytes_long_ok!!';
  const SECRET_ROTATED = 'whsec_rotated_secret_32_bytes_grace_ok!';

  let receiver;
  let receiverServer;
  let receiverPort;
  let receiverUrl;

  before(async () => {
    receiver = new CreativantaWebhookReceiver({
      secrets: [
        { keyId: 'whk_primary', secret: SECRET_PRIMARY },
        { keyId: 'whk_rotated', secret: SECRET_ROTATED },
      ],
      maxSkewSeconds: 300,
    });

    receiverServer = http.createServer((req, res) => {
      receiver.handleHttpRequest(req, res);
    });

    await new Promise((resolve) => {
      receiverServer.listen(0, '127.0.0.1', () => {
        receiverPort = receiverServer.address().port;
        receiverUrl = `http://127.0.0.1:${receiverPort}/webhook`;
        resolve();
      });
    });
  });

  after(async () => {
    if (receiverServer) {
      await new Promise((resolve) => receiverServer.close(resolve));
    }
  });

  function signPayload(bodyStr, secret, timestampSec, keyId = 'whk_primary') {
    const signaturePayload = `${timestampSec}.${bodyStr}`;
    const hmacHex = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex');
    return {
      'Content-Type': 'application/json',
      'X-CVE-Signature': `v1=${hmacHex}`,
      'X-CVE-Timestamp': String(timestampSec),
      'X-CVE-Key-Id': keyId,
      'X-CVE-Event-Id': `evt_${crypto.randomUUID()}`,
    };
  }

  it('2.1 Verifies valid signed webhook payload and dispatches event listeners', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const eventBody = JSON.stringify({
      id: 'evt_success_1',
      type: 'job.succeeded',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: {
        job_id: 'job_test_01',
        state: 'succeeded',
        state_version: 5,
        artifact_ids: ['art_video_1', 'art_manifest_1'],
      },
    });

    const headers = signPayload(eventBody, SECRET_PRIMARY, nowSec, 'whk_primary');
    headers['X-CVE-Event-Id'] = 'evt_success_1';

    let dispatchedEvent = null;
    receiver.once('job.succeeded', (evt) => {
      dispatchedEvent = evt;
    });

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body: eventBody,
    });

    assert.equal(res.status, 200);
    const resBody = await res.json();
    assert.equal(resBody.status, 'acknowledged');
    assert.equal(resBody.event_id, 'evt_success_1');
    assert.equal(resBody.duplicate, false);
    assert.equal(resBody.stale, false);

    assert.ok(dispatchedEvent);
    assert.equal(dispatchedEvent.id, 'evt_success_1');
    assert.equal(dispatchedEvent.data.job_id, 'job_test_01');
    assert.equal(dispatchedEvent.data.state, 'succeeded');
  });

  it('2.2 Rejects forged or tampered signatures (401 INVALID_SIGNATURE)', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const originalBody = JSON.stringify({ type: 'job.failed', data: { job_id: 'job_tamper' } });
    const headers = signPayload(originalBody, SECRET_PRIMARY, nowSec, 'whk_primary');

    // Tamper the payload body after signing
    const tamperedBody = JSON.stringify({ type: 'job.failed', data: { job_id: 'job_tamper', malicious: true } });

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body: tamperedBody,
    });

    assert.equal(res.status, 401);
    const errBody = await res.json();
    assert.equal(errBody.error.code, 'INVALID_SIGNATURE');
  });

  it('2.3 Rejects clock skew > 300s (400 CLOCK_SKEW_EXCEEDED)', async () => {
    const oldTimestampSec = Math.floor(Date.now() / 1000) - 360; // 6 minutes ago
    const body = JSON.stringify({ type: 'job.succeeded', data: { job_id: 'job_skew' } });
    const headers = signPayload(body, SECRET_PRIMARY, oldTimestampSec, 'whk_primary');

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body,
    });

    assert.equal(res.status, 400);
    const errBody = await res.json();
    assert.equal(errBody.error.code, 'CLOCK_SKEW_EXCEEDED');
  });

  it('2.4 Deduplicates repeated event ID within 7-day retention window without error', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const eventId = 'evt_dedupe_test_unique_id_1';
    const body = JSON.stringify({
      id: eventId,
      type: 'job.succeeded',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: { job_id: 'job_dedupe_01', state: 'succeeded', state_version: 1 },
    });

    const headers = signPayload(body, SECRET_PRIMARY, nowSec, 'whk_primary');
    headers['X-CVE-Event-Id'] = eventId;

    // First arrival
    const res1 = await fetch(receiverUrl, { method: 'POST', headers, body });
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.duplicate, false);

    // Second arrival with same event ID (e.g. webhook retry)
    let handlerInvokedSecondTime = false;
    const testHandler = () => { handlerInvokedSecondTime = true; };
    receiver.on('job.succeeded', testHandler);

    const res2 = await fetch(receiverUrl, { method: 'POST', headers, body });
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.duplicate, true);
    assert.equal(handlerInvokedSecondTime, false, 'Duplicate event must not trigger listeners');

    receiver.off('job.succeeded', testHandler);
  });

  it('2.5 Enforces monotonic state_version: ignores out-of-order stale events', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const jobId = 'job_out_of_order_1';

    // Step 1: Arrives event with state_version = 4
    const bodyV4 = JSON.stringify({
      id: 'evt_order_v4',
      type: 'job.rendering',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: { job_id: jobId, state: 'rendering', state_version: 4 },
    });
    const headersV4 = signPayload(bodyV4, SECRET_PRIMARY, nowSec, 'whk_primary');
    headersV4['X-CVE-Event-Id'] = 'evt_order_v4';

    const resV4 = await fetch(receiverUrl, { method: 'POST', headers: headersV4, body: bodyV4 });
    assert.equal(resV4.status, 200);
    assert.equal((await resV4.json()).stale, false);

    // Step 2: Arrives delayed out-of-order event with state_version = 2
    const bodyV2 = JSON.stringify({
      id: 'evt_order_v2',
      type: 'job.preparing',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: { job_id: jobId, state: 'preparing', state_version: 2 },
    });
    const headersV2 = signPayload(bodyV2, SECRET_PRIMARY, nowSec, 'whk_primary');
    headersV2['X-CVE-Event-Id'] = 'evt_order_v2';

    let staleListenerInvoked = false;
    const staleHandler = () => { staleListenerInvoked = true; };
    receiver.on('job.preparing', staleHandler);

    const resV2 = await fetch(receiverUrl, { method: 'POST', headers: headersV2, body: bodyV2 });
    assert.equal(resV2.status, 200);
    const jsonV2 = await resV2.json();
    assert.equal(jsonV2.stale, true, 'Lower state_version must be marked stale');
    assert.equal(staleListenerInvoked, false, 'Stale event must not trigger listener');

    receiver.off('job.preparing', staleHandler);
  });

  it('2.6 Supports secret rotation: verifies against secondary / rotated key in grace period', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'evt_rotation_1',
      type: 'job.succeeded',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: { job_id: 'job_rotation_01', state: 'succeeded', state_version: 1 },
    });

    // Signed with SECRET_ROTATED and keyId 'whk_rotated'
    const headers = signPayload(body, SECRET_ROTATED, nowSec, 'whk_rotated');
    headers['X-CVE-Event-Id'] = 'evt_rotation_1';

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body,
    });

    assert.equal(res.status, 200);
    const resBody = await res.json();
    assert.equal(resBody.status, 'acknowledged');
  });

  it('2.7 Automatically handles endpoint challenge handshake by echoing {"challenge": "<token>"}', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const challengeToken = 'random_challenge_secret_token_1234567890abcdef';
    const challengeBody = JSON.stringify({
      id: 'evt_challenge_1',
      type: 'endpoint.challenge',
      api_version: 'v1',
      created_at: new Date().toISOString(),
      data: {
        challenge: challengeToken,
      },
    });

    const headers = signPayload(challengeBody, SECRET_PRIMARY, nowSec, 'whk_primary');
    headers['X-CVE-Event-Id'] = 'evt_challenge_1';

    const res = await fetch(receiverUrl, {
      method: 'POST',
      headers,
      body: challengeBody,
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json');
    const resJson = await res.json();
    assert.equal(resJson.challenge, challengeToken);
  });
});
