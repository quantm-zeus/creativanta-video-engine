/**
 * Test Suite: Redacted Structured Logger & Stderr Bounding
 * Canonical specifications:
 *   - docs/OPERATIONS.md (line 37)
 *   - docs/SECURITY.md (line 23, line 39)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RedactedLogger,
  redactString,
  redactSignedUrl,
  redactObject,
  sanitizeAndCapStderr,
  MAX_STDERR_BYTES_PER_ATTEMPT,
} from '../logging/redacted-logger.mjs';

describe('Redacted Structured Logging Suite', () => {
  it('redacts API keys and bearer tokens from log messages', () => {
    const raw =
      'Client authenticated with API key cve_live_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d and header Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
    const redacted = redactString(raw);

    assert.ok(!redacted.includes('cve_live_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d'));
    assert.ok(redacted.includes('[REDACTED_API_KEY]'));
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
    assert.ok(redacted.includes('Bearer [REDACTED_TOKEN]'));
  });

  it('redacts signed capability query parameters while preserving scheme and path', () => {
    const signedUrl =
      'https://minio.internal/cve-artifacts/art_123.mp4?token=sig_secret_token_12345&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcd9876';
    const redacted = redactSignedUrl(signedUrl);

    assert.ok(!redacted.includes('sig_secret_token_12345'));
    assert.ok(!redacted.includes('abcd9876'));
    assert.strictEqual(redacted, 'https://minio.internal/cve-artifacts/art_123.mp4?[REDACTED_QUERY]');
  });

  it('redacts sensitive fields in structured payload objects (prompts, voice text, secrets)', () => {
    const payload = {
      apiKey: 'cve_live_secret_key_0123456789abcdef',
      prompt: 'Summarize customer confidential legal contract for video narration',
      voice_text: 'Xin chào quý khách, đây là thông tin bí mật',
      upload_url: 'https://objectstore.internal/upload/1.png?token=secret123',
      safeConfig: {
        width: 1280,
        height: 720,
        fps: 30,
      },
    };

    const sanitized = redactObject(payload);

    assert.strictEqual(sanitized.apiKey, '[REDACTED_CREDENTIAL]');
    assert.strictEqual(sanitized.prompt, '[REDACTED_PROMPT_OR_SCRIPT]');
    assert.strictEqual(sanitized.voice_text, '[REDACTED_PROMPT_OR_SCRIPT]');
    assert.strictEqual(sanitized.upload_url, 'https://objectstore.internal/upload/1.png?[REDACTED_QUERY]');
    assert.strictEqual(sanitized.safeConfig.width, 1280);
    assert.strictEqual(sanitized.safeConfig.fps, 30);
  });

  it('strictly bounds worker stderr to 64KiB per attempt and marks truncation flag', () => {
    // Generate 128KiB of stderr logs
    const largeOutput = 'Worker frame rendered ok\n'.repeat(5500);
    assert.ok(Buffer.byteLength(largeOutput) > 64 * 1024);

    const bounded = sanitizeAndCapStderr(largeOutput);
    const boundedBytes = Buffer.byteLength(bounded);

    // Bounded bytes should be around 64KiB (65536 + length of truncation marker)
    assert.ok(boundedBytes <= MAX_STDERR_BYTES_PER_ATTEMPT + 100);
    assert.ok(bounded.includes('[STDERR_TRUNCATED_MAX_64KIB]'));
  });

  it('emits valid structured JSON log entries with trace correlation fields', () => {
    const buffer = [];
    const logger = new RedactedLogger('test-logger', (json) => buffer.push(JSON.parse(json)));

    logger.info('admission', 'Render job accepted', {
      requestId: 'req_1',
      jobId: 'job_1',
      details: {
        profile: 'mp4-720p-v1',
        apiKey: 'cve_live_secret_token_123',
      },
    });

    assert.strictEqual(buffer.length, 1);
    const entry = buffer[0];
    assert.ok(entry.timestamp);
    assert.strictEqual(entry.level, 'info');
    assert.strictEqual(entry.service, 'test-logger');
    assert.strictEqual(entry.stage, 'admission');
    assert.strictEqual(entry.request_id, 'req_1');
    assert.strictEqual(entry.job_id, 'job_1');
    assert.strictEqual(entry.details.profile, 'mp4-720p-v1');
    assert.strictEqual(entry.details.apiKey, '[REDACTED_CREDENTIAL]');
  });
});
