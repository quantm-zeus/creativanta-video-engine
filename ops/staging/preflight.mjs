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
import { validateTargetEndpoint } from './config.mjs';
import { sanitizeUrl, maskSecret } from './redaction.mjs';

export const PROTECTED_CAPABILITY_FEATURES = Object.freeze([
  { key: 'custom_code', envInvariant: 'CVE_CUSTOM_CODE_ENABLED must be false' },
  { key: 'remote_import', envInvariant: 'CVE_REMOTE_IMPORT_ENABLED must be false' },
  { key: 'tts', envInvariant: 'CVE_TTS_PROVIDER must be disabled' },
  { key: 'authoring_adapter', envInvariant: 'CVE_AUTHORING_PROVIDER must be disabled' },
]);

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
 * Reads a fetch response body with an active abort signal and strict byte cap.
 * Ensures stalled response bodies or oversized payloads cannot hang preflight.
 *
 * @param {Response} res
 * @param {AbortSignal} signal
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readBoundedBuffer(res, signal, maxBytes) {
  const contentLengthHeader = res.headers?.get?.('content-length');
  if (contentLengthHeader !== null && contentLengthHeader !== undefined) {
    const declaredBytes = Number(contentLengthHeader);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      try {
        await res.body?.cancel?.();
      } catch {
        // Ignore cancel errors
      }
      throw new Error(
        `RESPONSE_BODY_TOO_LARGE: Content-Length (${declaredBytes} bytes) exceeds cap of ${maxBytes} bytes`
      );
    }
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });

    try {
      while (true) {
        if (signal?.aborted) {
          throw signal.reason || new Error('Request aborted');
        }
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        totalBytes += buf.length;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(
            `RESPONSE_BODY_TOO_LARGE: Streamed body (${totalBytes} bytes) exceeded cap of ${maxBytes} bytes`
          );
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks, totalBytes);
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  // Fallback for custom fetch doubles without ReadableStream
  const arrayBuf = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuf);
  if (buf.length > maxBytes) {
    throw new Error(
      `RESPONSE_BODY_TOO_LARGE: Response body (${buf.length} bytes) exceeded cap of ${maxBytes} bytes`
    );
  }
  return buf;
}

/**
 * Executes an HTTP GET with an AbortController covering both headers and full body read.
 *
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {object} options
 * @param {Record<string, string>} [options.headers]
 * @param {number} [options.timeoutMs=5000]
 * @param {number} [options.maxBytes=262144]
 */
async function fetchJsonBounded(fetchFn, url, { headers = {}, timeoutMs = 5000, maxBytes = 262144 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', ...headers },
    });

    const rawBuf = await readBoundedBuffer(res, controller.signal, maxBytes);
    let data = {};
    if (rawBuf.length > 0) {
      try {
        data = JSON.parse(rawBuf.toString('utf8'));
      } catch {
        data = {};
      }
    }

    return { status: res.status, ok: res.ok, data };
  } catch (err) {
    if (timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new Error(`REQUEST_TIMEOUT: GET ${sanitizeUrl(url)} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates the `/v1/capabilities` payload fail-closed.
 * Protected features (`custom_code`, `remote_import`, `tts`, `authoring_adapter`)
 * MUST be present and explicitly boolean `false`. Missing or non-boolean fields fail closed.
 *
 * @param {unknown} caps
 * @returns {{ valid: boolean; violations: string[] }}
 */
export function validateCapabilitiesInvariants(caps) {
  const violations = [];

  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    return {
      valid: false,
      violations: ['Capabilities response payload must be a non-null JSON object'],
    };
  }

  const features = caps.features;
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    violations.push('Capabilities payload is missing required "features" object');
  } else {
    for (const { key, envInvariant } of PROTECTED_CAPABILITY_FEATURES) {
      if (!(key in features)) {
        violations.push(`Protected capability feature "features.${key}" is missing (${envInvariant})`);
      } else if (typeof features[key] !== 'boolean') {
        violations.push(
          `Protected capability feature "features.${key}" must be explicitly boolean false, got ${typeof features[key]} (${JSON.stringify(features[key])}) (${envInvariant})`
        );
      } else if (features[key] !== false) {
        violations.push(`${envInvariant} (features.${key}=true)`);
      }
    }
  }

  // Also check custom-html-v1 engine if engines is a map
  if (caps.engines && typeof caps.engines === 'object' && !Array.isArray(caps.engines)) {
    if ('custom-html-v1' in caps.engines && caps.engines['custom-html-v1'] !== false) {
      violations.push('Engine "custom-html-v1" must be explicitly disabled (false)');
    }
  }

  // Verify required profiles
  const profiles = caps.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    violations.push('Missing required profiles: mp4-720p-v1 and/or preview-360p-v1');
  } else {
    const mp4Profile = profiles['mp4-720p-v1'];
    const previewProfile = profiles['preview-360p-v1'];
    const hasMp4 = Boolean(mp4Profile && typeof mp4Profile === 'object' && mp4Profile.supported !== false);
    const hasPreview = Boolean(
      previewProfile && typeof previewProfile === 'object' && previewProfile.supported !== false
    );

    if (!hasMp4 || !hasPreview) {
      violations.push('Missing required profiles: mp4-720p-v1 and/or preview-360p-v1');
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Extracts subsystem health from either `/readyz` checks (`'ok'`) or legacy subsystems (`true`).
 * @param {object} readyzData
 * @param {'database' | 'storage' | 'renderer'} key
 * @param {boolean} defaultWhenOk
 * @returns {'HEALTHY' | 'UNAVAILABLE'}
 */
function resolveSubsystemHealth(readyzData, key, defaultWhenOk = false) {
  if (readyzData && typeof readyzData === 'object') {
    if (readyzData.checks && typeof readyzData.checks === 'object' && key in readyzData.checks) {
      const val = readyzData.checks[key];
      return val === 'ok' || val === true ? 'HEALTHY' : 'UNAVAILABLE';
    }
    if (readyzData.subsystems && typeof readyzData.subsystems === 'object' && key in readyzData.subsystems) {
      const val = readyzData.subsystems[key];
      return val === true || val === 'ok' ? 'HEALTHY' : 'UNAVAILABLE';
    }
  }
  return defaultWhenOk ? 'HEALTHY' : 'UNAVAILABLE';
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
  try {
    const healthUrl = `${origin}/healthz`;
    const res = await fetchJsonBounded(fetchFn, healthUrl, { timeoutMs });

    if (res.ok) {
      const healthzData = res.data || {};
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
    const res = await fetchJsonBounded(fetchFn, readyUrl, { timeoutMs });
    const readyzData = res.data || {};

    const dbHealth = resolveSubsystemHealth(readyzData, 'database', res.ok);
    const storageHealth = resolveSubsystemHealth(readyzData, 'storage', res.ok);
    const rendererHealth = resolveSubsystemHealth(readyzData, 'renderer', res.ok);

    dependencies.database = dbHealth;
    dependencies.storage = storageHealth;
    dependencies.renderer = rendererHealth;

    const allSubsystemsHealthy =
      dbHealth === 'HEALTHY' && storageHealth === 'HEALTHY' && rendererHealth === 'HEALTHY';

    if (res.ok && readyzData.status !== 'not_ready' && allSubsystemsHealthy) {
      checks.push({
        id: 'PRE-03',
        title: 'API Readiness Probe (GET /readyz)',
        status: 'PASS',
        httpStatus: res.status,
        details: `Readiness probe succeeded (HTTP ${res.status}). Subsystems: database, storage, and renderer verified ready.`,
      });
    } else {
      ready = false;
      const msg = `API readiness probe failed with HTTP status ${res.status} (FAIL_CLOSED)`;
      blockers.push(`API_READINESS_FAIL_CLOSED: ${msg}`);
      checks.push({
        id: 'PRE-03',
        title: 'API Readiness Probe (GET /readyz)',
        status: 'FAIL',
        httpStatus: res.status,
        error: msg,
        subsystems: readyzData?.checks || readyzData?.subsystems,
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
    const headers = {};
    if (config.apiKeyA) {
      headers['Authorization'] = `Bearer ${config.apiKeyA}`;
    }

    const res = await fetchJsonBounded(fetchFn, capsUrl, { headers, timeoutMs });

    if (res.ok) {
      const caps = res.data;
      const { valid, violations } = validateCapabilitiesInvariants(caps);

      if (valid) {
        checks.push({
          id: 'PRE-04',
          title: 'Capabilities & Invariants Guard (GET /v1/capabilities)',
          status: 'PASS',
          details: `Required profiles present (mp4-720p-v1, preview-360p-v1). Safety invariants satisfied (custom_code=false, remote_import=false, tts=false, authoring_adapter=false).`,
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
