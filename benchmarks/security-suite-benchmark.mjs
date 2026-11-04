/**
 * Creativanta Video Engine — P6-04 Security Guard & Suite Latency Benchmark
 *
 * Measures execution latency (p50, p95, max) of hot-path security guards:
 *   1. Constant-time API key HMAC-SHA256 verification (verifyApiKeyConstantTime)
 *   2. Multi-encoding SSRF URL validation (validateAndNormalizeImportUrl)
 *   3. HTML/CSS/SVG zero-egress & XXE sandbox inspection (validateHtmlSecurityInvariants + probeAndSanitizeSvg)
 *   4. Structured log secret redaction (redactString + redactSecretsFromLogs)
 *   5. Full P6-04 24-check security review suite execution
 */

import {
  verifyApiKeyConstantTime,
  generateApiKeyMaterial,
  validateAndNormalizeImportUrl,
  probeAndSanitizeSvg,
} from '../packages/api/dist/index.js';
import {
  TRUSTED_TEMPLATE_CSP,
  validateTemplateHtmlPolicy,
  redactSecretOutput,
} from '../packages/controller/dist/index.js';
import { redactString } from '../ops/logging/redacted-logger.mjs';
import { SecurityReviewRunner } from '../ops/security/security-review-runner.mjs';

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * sortedValues.length));
  return Number(sortedValues[idx].toFixed(4));
}

function measureMicroBenchmark(name, iterations, fn) {
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return {
    benchmark: name,
    iterations,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Number(samples[samples.length - 1].toFixed(4)),
  };
}

export async function runSecuritySuiteBenchmark() {
  const pepper = 'bench-pepper-secret-0123456789abcdef';
  const keyMat = generateApiKeyMaterial({ environment: 'live', pepper, pepperVersion: 'v1' });
  const storedRecord = {
    tenant_id: 'ten_bench_01',
    id: 'key_bench_01',
    key_prefix: keyMat.keyPrefix,
    key_hash: keyMat.keyHash,
    pepper_version: 'v1',
    name: 'bench',
    scopes: ['jobs:read'],
    rotated_from_key_id: null,
    expires_at: null,
    revoked_at: null,
    last_used_at: null,
    created_at: new Date().toISOString(),
    tenant_status: 'active',
  };

  const apiKeyBench = measureMicroBenchmark('api_key_constant_time_hmac_verify', 500, () => {
    verifyApiKeyConstantTime({
      rawToken: keyMat.plaintextKey,
      lookupByPrefix: () => storedRecord,
      pepper,
    });
  });

  const ssrfBench = measureMicroBenchmark('ssrf_url_normalization_and_ip_guard', 500, () => {
    validateAndNormalizeImportUrl('https://cdn.partner-stock.com/assets/banner-720p.png');
  });

  const sampleHtml = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${TRUSTED_TEMPLATE_CSP}"></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50" fill="#10b981"/></svg></body></html>`;
  const sampleSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#3b82f6"/></svg>'
  );
  const htmlSvgBench = measureMicroBenchmark('html_csp_and_svg_sanitization_guard', 500, () => {
    validateTemplateHtmlPolicy(sampleHtml);
    probeAndSanitizeSvg(sampleSvg);
  });

  const sampleLog = `Auth=${keyMat.plaintextKey} Webhook=whsec_0123456789abcdef0123456789abcdef URL=https://minio.internal/v.mp4?X-Amz-Signature=abcd`;
  const redactionBench = measureMicroBenchmark('dual_log_secret_redaction', 500, () => {
    redactString(sampleLog);
    redactSecretOutput(sampleLog);
  });

  const runner = new SecurityReviewRunner();
  const fullReviewReport = await runner.runFullReview();

  return {
    benchmarkSuite: 'P6-04 Security Guard & Review Suite Benchmark',
    timestamp: new Date().toISOString(),
    microBenchmarks: [apiKeyBench, ssrfBench, htmlSvgBench, redactionBench],
    fullSecurityReviewRun: {
      overallStatus: fullReviewReport.overallStatus,
      totalChecks: fullReviewReport.summary.totalChecks,
      passedChecks: fullReviewReport.summary.passedChecks,
      durationMs: fullReviewReport.durationMs,
    },
  };
}

if (process.argv[1] && process.argv[1].endsWith('security-suite-benchmark.mjs')) {
  runSecuritySuiteBenchmark()
    .then((res) => {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res.fullSecurityReviewRun.overallStatus === 'PASS' ? 0 : 1);
    })
    .catch((err) => {
      process.stderr.write(`Benchmark error: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}
