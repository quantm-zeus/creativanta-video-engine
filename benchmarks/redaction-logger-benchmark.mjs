/**
 * Creativanta Video Engine - Redaction & Structured Logging Benchmark
 * Benchmarks string redaction, object sanitization, and 64KiB stderr truncation.
 */

import {
  redactString,
  redactObject,
  sanitizeAndCapStderr,
  RedactedLogger,
} from '../ops/logging/redacted-logger.mjs';

export function runRedactionBenchmark(iterations = 5000) {
  const sampleText =
    'Starting render job with key cve_live_abcdef0123456789abcdef0123456789 and signed url https://storage.example.com/assets/video.mp4?token=secret123456&sig=xyz789 for user prompt Hello world';

  const sampleObject = {
    apiKey: 'cve_live_0123456789abcdef0123456789abcdef',
    upload_url: 'https://minio.internal/upload?X-Amz-Signature=secret_sig',
    prompt: 'Private video script content that must be redacted',
    metadata: {
      profile: 'mp4-720p-v1',
      scenes: 3,
      auth_token: 'Bearer sensitive_token_value_here',
    },
  };

  const largeStderr =
    'Render log line: frame processed\n'.repeat(3000) +
    'cve_live_secret_leaked_in_stderr_output_0123456789\n' +
    'More frame data\n'.repeat(2000); // Exceeds 64KiB

  const startTime = Date.now();

  for (let i = 0; i < iterations; i++) {
    redactString(sampleText);
    redactObject(sampleObject);
  }

  const durationMs = Date.now() - startTime;
  const opsPerSec = Math.round((iterations / (durationMs || 1)) * 1000);

  // Stderr truncation test
  const stderrStart = Date.now();
  const cappedStderr = sanitizeAndCapStderr(largeStderr);
  const stderrDurationMs = Date.now() - stderrStart;

  return {
    iterations,
    durationMs,
    opsPerSec,
    largeStderrOriginalBytes: Buffer.byteLength(largeStderr),
    cappedStderrBytes: Buffer.byteLength(cappedStderr),
    stderrTruncationSuccessful: cappedStderr.includes('[STDERR_TRUNCATED_MAX_64KIB]'),
    stderrDurationMs,
  };
}

if (process.argv[1] && process.argv[1].endsWith('redaction-logger-benchmark.mjs')) {
  const result = runRedactionBenchmark(5000);
  console.log('Redaction Benchmark Result:', JSON.stringify(result, null, 2));
}
