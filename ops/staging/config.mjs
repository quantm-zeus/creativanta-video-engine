/**
 * Creativanta Video Engine — Non-Mock Live Staging E2E Configuration & Target Safety Guards
 * Canonical specifications:
 *   - docs/AGENTS.md & AGENTS.md (Strict boundaries, no production access, fail-closed)
 *   - docs/SECURITY.md (SSRF guards, tenant isolation, deny public/production targets by default)
 *   - docs/DEPLOYMENT.md (Staging topology, loopback & private internal endpoints)
 *   - docs/TESTING.md (E2E tenant isolation, non-mock verification)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import { URL } from 'node:url';

/**
 * Expected baseline staging environment configuration invariants.
 * All optional and custom code engines must be OFF by default.
 */
export const STAGING_SAFETY_INVARIANTS = Object.freeze({
  CVE_ENV: 'staging',
  CVE_CUSTOM_CODE_ENABLED: false,
  CVE_CUSTOM_RUNTIME: 'disabled',
  CVE_REMOTE_IMPORT_ENABLED: false,
  CVE_TTS_PROVIDER: 'disabled',
  CVE_AUTHORING_PROVIDER: 'disabled',
  CVE_SIGNED_DOWNLOAD_TTL_SECONDS_MAX: 300,
});

/**
 * Custom error thrown when a prohibited production or public endpoint is targeted.
 */
export class TargetEndpointSecurityError extends Error {
  constructor(message, targetUrl) {
    super(message);
    this.name = 'TargetEndpointSecurityError';
    this.targetUrl = targetUrl;
  }
}

/**
 * Custom error thrown when required staging credentials or configurations are missing.
 */
export class StagingConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StagingConfigurationError';
  }
}

/**
 * Checks if a hostname or IPv4 address qualifies as loopback.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  if (!hostname) return false;
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (clean === 'localhost' || clean === '::1') return true;
  if (/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(clean)) {
    return true;
  }
  return false;
}

/**
 * Checks if an IPv4 address is in RFC1918 private ranges.
 * @param {string} ip
 * @returns {boolean}
 */
export function isRfc1918PrivateIp(ip) {
  if (!ip) return false;
  const match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((oct) => oct < 0 || oct > 255)) return false;

  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
}

/**
 * Checks if a hostname matches approved private internal naming conventions for staging.
 * @param {string} hostname
 * @returns {boolean}
 */
export function isApprovedInternalDomain(hostname) {
  if (!hostname) return false;
  const clean = hostname.toLowerCase();
  return (
    clean.endsWith('.internal') ||
    clean.endsWith('.local') ||
    clean.endsWith('.test') ||
    clean.endsWith('.corp')
  );
}

/**
 * Validates that the staging target endpoint is strictly loopback or an approved private endpoint.
 * Denies production and public targets by default.
 *
 * @param {string} rawUrl
 * @param {object} [options]
 * @param {boolean} [options.allowPrivateIps=true] Whether to allow RFC1918 private IPs
 * @param {boolean} [options.allowInternalDomains=true] Whether to allow approved *.internal domains
 * @returns {string} Normalized base URL (without trailing slashes or sensitive query params)
 */
export function validateTargetEndpoint(rawUrl, options = {}) {
  const allowPrivateIps = options.allowPrivateIps ?? true;
  const allowInternalDomains = options.allowInternalDomains ?? true;

  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new TargetEndpointSecurityError('Target endpoint URL must not be empty', rawUrl);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (err) {
    throw new TargetEndpointSecurityError(
      `Invalid URL format: ${err.message}`,
      rawUrl
    );
  }

  // Scheme enforcement
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TargetEndpointSecurityError(
      `Forbidden protocol scheme "${parsed.protocol}". Only http: and https: are allowed.`,
      rawUrl
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // 1. Loopback is always permitted for local operator testing
  if (isLoopbackHost(hostname)) {
    return normalizeUrl(parsed);
  }

  // 2. Approved internal domain suffix (e.g. staging.creativanta.internal)
  if (allowInternalDomains && isApprovedInternalDomain(hostname)) {
    return normalizeUrl(parsed);
  }

  // 3. RFC1918 private IP range (e.g. 10.x.x.x, 192.168.x.x)
  if (allowPrivateIps && isRfc1918PrivateIp(hostname)) {
    return normalizeUrl(parsed);
  }

  // All other domains (public domains like video.creativanta.com, non-private IPs) are denied
  throw new TargetEndpointSecurityError(
    `PRODUCTION/PUBLIC TARGET DENIED: The target endpoint "${hostname}" is not an approved loopback (127.0.0.1/localhost) or private staging internal address. Non-mock live staging verifier refuses public or production endpoints by default.`,
    rawUrl
  );
}

/**
 * Normalizes URL: removes trailing slashes, strips query and hash.
 * @param {URL} parsedUrl
 * @returns {string}
 */
function normalizeUrl(parsedUrl) {
  const portPart = parsedUrl.port ? `:${parsedUrl.port}` : '';
  const pathname = parsedUrl.pathname.replace(/\/+$/, '');
  return `${parsedUrl.protocol}//${parsedUrl.hostname}${portPart}${pathname}`;
}

/**
 * Loads and validates configuration for the live staging E2E runner from environment.
 * Tokens are read strictly from runtime env and never hardcoded.
 *
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {object} Validated staging E2E configuration
 */
export function loadStagingE2EConfig(env = process.env) {
  // Resolve target API endpoint: explicit env takes precedence, fallback to default loopback
  const rawBaseUrl =
    env.CVE_STAGING_API_BASE_URL ||
    env.CVE_LIVE_API_BASE_URL ||
    env.CVE_PUBLIC_BASE_URL ||
    'http://127.0.0.1:8080/v1';

  const validatedBaseUrl = validateTargetEndpoint(rawBaseUrl);

  // Runtime test API keys for Tenant A and Tenant B
  // Must be provided in environment for real non-mock execution
  const apiKeyA =
    env.CVE_STAGING_API_KEY_A ||
    env.CVE_STAGING_API_KEY ||
    env.CVE_TEST_API_KEY_A ||
    '';

  const apiKeyB =
    env.CVE_STAGING_API_KEY_B ||
    env.CVE_TEST_API_KEY_B ||
    '';

  const webhookSecret =
    env.CVE_STAGING_WEBHOOK_SECRET ||
    env.CVE_WEBHOOK_SECRET ||
    '';

  // Feature flags validation
  const customCodeEnabled = (env.CVE_CUSTOM_CODE_ENABLED || '').toLowerCase() === 'true';
  const customRuntime = env.CVE_CUSTOM_RUNTIME || 'disabled';
  const remoteImportEnabled = (env.CVE_REMOTE_IMPORT_ENABLED || '').toLowerCase() === 'true';
  const ttsProvider = env.CVE_TTS_PROVIDER || 'disabled';
  const authoringProvider = env.CVE_AUTHORING_PROVIDER || 'disabled';

  return {
    baseUrl: validatedBaseUrl,
    apiKeyA,
    apiKeyB,
    webhookSecret,
    timeoutMs: Number(env.CVE_STAGING_TIMEOUT_MS) || 15000,
    pollIntervalMs: Number(env.CVE_STAGING_POLL_INTERVAL_MS) || 1000,
    pollTimeoutMs: Number(env.CVE_STAGING_POLL_TIMEOUT_MS) || 30000,
    flags: {
      customCodeEnabled,
      customRuntime,
      remoteImportEnabled,
      ttsProvider,
      authoringProvider,
    },
    invariants: STAGING_SAFETY_INVARIANTS,
  };
}
