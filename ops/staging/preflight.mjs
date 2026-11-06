/**
 * Creativanta Video Engine — Live Staging Fail-Closed Preflight Validator
 * Canonical specifications:
 *   - docs/TESTING.md (Preflight requirements, fail-closed on absent dependencies)
 *   - docs/SECURITY.md (Invariants: custom code OFF, VideoFlow/remote imports OFF)
 *   - docs/DEPLOYMENT.md (Startup contract, readiness and capabilities checks)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import { URL } from 'node:url';
import { validateTargetEndpoint, TargetEndpointSecurityError } from './config.mjs';
import { sanitizeUrl, maskSecret } from './redaction.mjs';

/**
 * Derives the server origin from a base URL (e.g. "http://127.0.0.1:8080/v1" -> "http://127.0.0.1:8080").
 * @param {string} baseUrl
 * @returns {string}
 */
export function deriveServerOrigin(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return baseUrl;
  }
}

/**
 * Runs fail-closed preflight checks against an explicit live target API.
 * Never mocks external dependencies. If live services are down or absent,
 * fails closed and records structured missing-dependency status.
 *
 * @param {object} config
 * @param {string} config.baseUrl
 * @param {string} [config.apiKeyA]
 * @param {string} [config.apiKeyB]
 * @param {object} [options]
 * @param {typeof fetch} [options.customFetch=globalThis.fetch]
 * @param {number} [options.timeoutMs=5000]
 * @returns {Promise<object>} Structured preflight report
 */
export async function runStagingPreflight(config, options = {}) {
  const fetchFn = options.customFetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const timestamp = new Date().toISOString();

  const dependencies = {
    api: 'UNAVAILABLE',
    database: 'UNAVAILABLE',
    storage: 'UNAVAILABLE',
    renderer: 'UNAVAILABLE',
  };

  const blockers = [];
  const checks = [];
  let ready = true;

  // ---------------------------------------------------------------------------
  // Check 1: Target URL Safety & Guardrails
  // ---------------------------------------------------------------------------
  let validatedUrl = '';
  let origin = '';
  try {
    validatedUrl = validateTargetEndpoint(config.baseUrl);
    origin = deriveServerOrigin(validatedUrl);
    checks.push({
      id: 'PRE-01',
      title: 'Target Endpoint Safety & Loopback/Private Restriction',
      status: 'PASS',
      details: `Target URL "${sanitizeUrl(validatedUrl)}" is verified loopback or approved private internal domain. Public/production targets denied.`,
    });
  } catch (err) {
    ready = false;
    blockers.push(`TARGET_ENDPOINT_SECURITY_VIOLATION: ${err.message}`);
    checks.push({
      id: 'PRE-01',
      title: 'Target Endpoint Safety & Loopback/Private Restriction',
      status: 'FAIL',
      error: err.message,
    });
    return {
      ready: false,
      status: 'NOT_READY',
      timestamp,
      targetUrl: sanitizeUrl(config.baseUrl),
      dependencies,
      checks,
      blockers,
    };
  }

  // ---------------------------------------------------------------------------
  // Check 2: Live API Liveness Probe (GET /healthz)
  // ---------------------------------------------------------------------------
  let healthzData = null;
  try {
    const healthUrl = `${origin}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchFn(healthUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    if (res.ok) {
      try {
        healthzData = await res.json();
      } catch {
        healthzData = {};
      }
      dependencies.api = 'HEALTHY';
      checks.push({
        id: 'PRE-02',
        title: 'API Liveness Probe (GET /healthz)',
        status: 'PASS',
        httpStatus: res.status,
        details: `Liveness probe succeeded (HTTP ${res.status}). Service: ${healthzData.service || 'creativanta-video-engine-api'}`,
      });
    } else {
      dependencies.api = 'DEGRADED';
      ready = false;
      const msg = `Liveness probe failed with HTTP status ${res.status}`;
      blockers.push(`API_LIVENESS_FAIL: ${msg}`);
      checks.push({
        id: 'PRE-02',
        title: 'API Liveness Probe (GET /healthz)',
        status: 'FAIL',
        httpStatus: res.status,
        error: msg,
      });
    }
  } catch (err) {
    dependencies.api = 'UNAVAILABLE';
    ready = false;
    const msg = `API service unreachable at ${sanitizeUrl(origin)} (${err.message})`;
    blockers.push(`API_SERVICE_UNAVAILABLE: ${msg}`);
    checks.push({
      id: 'PRE-02',
      title: 'API Liveness Probe (GET /healthz)',
      status: 'FAIL',
      error: msg,
    });

    // If API itself is unreachable, downstream DB, storage, renderer are definitively absent
    return {
      ready: false,
      status: 'NOT_READY',
      timestamp,
      targetUrl: sanitizeUrl(validatedUrl),
      dependencies,
      checks,
      blockers,
    };
  }

  // ---------------------------------------------------------------------------
  // Check 3: Live API Readiness Probe (GET /readyz)
  // ---------------------------------------------------------------------------
  try {
    const readyUrl = `${origin}/readyz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetchFn(readyUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);

    let readyzData = {};
    try {
      readyzData = await res.json();
    } catch {
      // Non-JSON body
    }

    if (res.ok) {
      dependencies.database = 'HEALTHY';
      dependencies.storage = 'HEALTHY';
      dependencies.renderer = 'HEALTHY';
      checks.push({
        id: 'PRE-03',
        title: 'API Readiness Probe (GET /readyz)',
        status: 'PASS',
        httpStatus: res.status,
        details: `Readiness probe succeeded (HTTP ${res.status}). Subsystems: database, storage, and renderer verified ready.`,
      });
    } else {
      ready = false;
      dependencies.database = readyzData?.subsystems?.database ? 'HEALTHY' : 'UNAVAILABLE';
      dependencies.storage = readyzData?.subsystems?.storage ? 'HEALTHY' : 'UNAVAILABLE';
      dependencies.renderer = readyzData?.subsystems?.renderer ? 'HEALTHY' : 'UNAVAILABLE';

      const msg = `API readiness probe failed with HTTP status ${res.status} (FAIL_CLOSED)`;
      blockers.push(`API_READINESS_FAIL_CLOSED: ${msg}`);
      checks.push({
        id: 'PRE-03',
        title: 'API Readiness Probe (GET /readyz)',
        status: 'FAIL',
        httpStatus: res.status,
        error: msg,
        subsystems: readyzData?.subsystems,
      });
    }
  } catch (err) {
    ready = false;
    const msg = `Failed to query /readyz: ${err.message}`;
    blockers.push(`API_READINESS_QUERY_ERROR: ${msg}`);
    checks.push({
      id: 'PRE-03',
      title: 'API Readiness Probe (GET /readyz)',
      status: 'FAIL',
      error: msg,
    });
  }

  // ---------------------------------------------------------------------------
  // Check 4: Engine Capabilities & Invariants (GET /v1/capabilities)
  // ---------------------------------------------------------------------------
  try {
    const capsUrl = `${validatedUrl}/capabilities`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = { Accept: 'application/json' };
    if (config.apiKeyA) {
      headers['Authorization'] = `Bearer ${config.apiKeyA}`;
    }

    const res = await fetchFn(capsUrl, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });
    clearTimeout(timer);

    if (res.ok) {
      const caps = await res.json();
      const features = caps.features || {};

      // Verify custom code and VideoFlow / remote imports are strictly OFF
      const violations = [];
      if (features.custom_code === true) {
        violations.push('CVE_CUSTOM_CODE_ENABLED must be false');
      }
      if (features.remote_import === true) {
        violations.push('CVE_REMOTE_IMPORT_ENABLED must be false');
      }
      if (features.tts === true) {
        violations.push('CVE_TTS_PROVIDER must be disabled');
      }
      if (features.authoring_adapter === true) {
        violations.push('CVE_AUTHORING_PROVIDER must be disabled');
      }

      // Verify profiles
      const profiles = caps.profiles || {};
      const hasMp4 = Boolean(profiles['mp4-720p-v1']);
      const hasPreview = Boolean(profiles['preview-360p-v1']);

      if (!hasMp4 || !hasPreview) {
        violations.push('Missing required profiles: mp4-720p-v1 and/or preview-360p-v1');
      }

      if (violations.length === 0) {
        checks.push({
          id: 'PRE-04',
          title: 'Capabilities & Invariants Guard (GET /v1/capabilities)',
          status: 'PASS',
          details: `Required profiles present (mp4-720p-v1, preview-360p-v1). Safety invariants satisfied (custom_code=false, remote_import=false, tts=false, authoring=false).`,
        });
      } else {
        ready = false;
        const msg = `Security/capability invariant violation: ${violations.join('; ')}`;
        blockers.push(`CAPABILITIES_INVARIANT_VIOLATION: ${msg}`);
        checks.push({
          id: 'PRE-04',
          title: 'Capabilities & Invariants Guard (GET /v1/capabilities)',
          status: 'FAIL',
          error: msg,
          violations,
        });
      }
    } else {
      ready = false;
      const msg = `Capabilities query failed with HTTP status ${res.status}`;
      blockers.push(`CAPABILITIES_QUERY_FAILED: ${msg}`);
      checks.push({
        id: 'PRE-04',
        title: 'Capabilities & Invariants Guard (GET /v1/capabilities)',
        status: 'FAIL',
        httpStatus: res.status,
        error: msg,
      });
    }
  } catch (err) {
    ready = false;
    const msg = `Failed to query capabilities: ${err.message}`;
    blockers.push(`CAPABILITIES_REQUEST_ERROR: ${msg}`);
    checks.push({
      id: 'PRE-04',
      title: 'Capabilities & Invariants Guard (GET /v1/capabilities)',
      status: 'FAIL',
      error: msg,
    });
  }

  // ---------------------------------------------------------------------------
  // Check 5: Tenant Credentials Presence (Tenant A and Tenant B)
  // ---------------------------------------------------------------------------
  const hasKeyA = Boolean(config.apiKeyA && config.apiKeyA.trim());
  const hasKeyB = Boolean(config.apiKeyB && config.apiKeyB.trim());

  if (hasKeyA && hasKeyB) {
    checks.push({
      id: 'PRE-05',
      title: 'Tenant Credentials Presence (Tenant A & B for Anti-IDOR)',
      status: 'PASS',
      details: `Tenant A key (${maskSecret(config.apiKeyA)}) and Tenant B key (${maskSecret(config.apiKeyB)}) provided exclusively via runtime environment.`,
    });
  } else {
    ready = false;
    const missing = [];
    if (!hasKeyA) missing.push('CVE_STAGING_API_KEY_A');
    if (!hasKeyB) missing.push('CVE_STAGING_API_KEY_B');
    const msg = `Missing required tenant API credentials in environment: ${missing.join(', ')}`;
    blockers.push(`MISSING_TENANT_CREDENTIALS: ${msg}`);
    checks.push({
      id: 'PRE-05',
      title: 'Tenant Credentials Presence (Tenant A & B for Anti-IDOR)',
      status: 'FAIL',
      error: msg,
    });
  }

  return {
    ready,
    status: ready ? 'READY' : 'NOT_READY',
    timestamp,
    targetUrl: sanitizeUrl(validatedUrl),
    dependencies,
    checks,
    blockers,
  };
}
