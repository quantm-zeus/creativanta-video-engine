/**
 * Canonical Environment Configuration Parser & Validator.
 * Canonical specification: docs/DEPLOYMENT.md (Table lines 62-100)
 */

export type EnvironmentName = 'development' | 'staging' | 'production';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export type RendererAdapter = 'chromium-frame-v1' | 'hyperframes-v1';

export interface CveEnvConfig {
  // General
  CVE_ENV: EnvironmentName;
  CVE_PUBLIC_BASE_URL: string;
  CVE_LOG_LEVEL: LogLevel;
  CVE_COST_RATE_VERSION: string;
  CVE_TELEMETRY_ENDPOINT?: string;

  // Databases
  CVE_DATABASE_URL: string;
  CVE_MIGRATION_DATABASE_URL: string;

  // Object Storage
  CVE_STORAGE_ENDPOINT: string;
  CVE_STORAGE_REGION: string;
  CVE_STORAGE_ACCESS_KEY_ID: string;
  CVE_STORAGE_SECRET_ACCESS_KEY: string;
  CVE_QUARANTINE_BUCKET: string;
  CVE_ASSET_BUCKET: string;
  CVE_ARTIFACT_BUCKET: string;
  CVE_SIGNED_DOWNLOAD_TTL_SECONDS: number;
  CVE_ARTIFACT_RETENTION_DAYS: number;
  CVE_ASSET_RETENTION_DAYS: number;

  // Cryptographic & Security
  CVE_API_KEY_PEPPER: string;
  CVE_SECRET_ENCRYPTION_KEY_ID: string;
  CVE_EGRESS_POLICY_PATH: string;

  // Dispatcher & Worker Budgets
  CVE_RENDERER_ADAPTER: RendererAdapter;
  CVE_RENDER_IMAGE_DIGEST: string;
  CVE_RENDER_SLOTS: number;
  CVE_RENDER_CPU_LIMIT: number;
  CVE_RENDER_MEMORY_MIB: number;
  CVE_RENDER_PIDS_LIMIT: number;
  CVE_RENDER_TEMP_MIB: number;
  CVE_FRAME_TIMEOUT_MS: number;
  CVE_RENDER_TIMEOUT_SECONDS: number;
  CVE_PREVIEW_TIMEOUT_SECONDS: number;
  CVE_JOB_DEADLINE_SECONDS: number;
  CVE_LEASE_SECONDS: number;
  CVE_HEARTBEAT_SECONDS: number;
  CVE_MAX_ATTEMPTS: number;

  // Feature Flags
  CVE_REMOTE_IMPORT_ENABLED: boolean;
  CVE_CUSTOM_CODE_ENABLED: boolean;
  CVE_CUSTOM_RUNTIME: string;
  CVE_CUSTOM_TENANT_ALLOWLIST: string[];
  CVE_AUTHORING_PROVIDER: string;
  CVE_AUTHORING_SECRET_REF?: string;
  CVE_TTS_PROVIDER: string;
  CVE_TTS_SECRET_REF?: string;
}

export function parseNumber(
  val: string | undefined,
  defaultVal: number,
  minVal?: number,
  maxVal?: number,
): number {
  if (val === undefined || val.trim() === '') return defaultVal;
  const num = Number(val);
  if (Number.isNaN(num)) {
    throw new Error(`Invalid numeric environment value: "${val}"`);
  }
  if (minVal !== undefined && num < minVal) {
    throw new Error(`Value ${num} is below minimum allowed ${minVal}`);
  }
  if (maxVal !== undefined && num > maxVal) {
    throw new Error(`Value ${num} is above maximum allowed ${maxVal}`);
  }
  return num;
}

export function parseBoolean(val: string | undefined, defaultVal: boolean): boolean {
  if (val === undefined || val.trim() === '') return defaultVal;
  const lower = val.trim().toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  throw new Error(`Invalid boolean environment value: "${val}"`);
}

export function redactSecretString(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '********';
  return `${val.slice(0, 3)}...${val.slice(-3)}`;
}

export function redactUrlCredentials(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    if (url.password) {
      url.password = 'REDACTED';
    }
    return url.toString();
  } catch {
    return '[INVALID_URL]';
  }
}

export function loadEnvConfig(source: Record<string, string | undefined> = process.env): CveEnvConfig {
  const envRaw = source['CVE_ENV'] || 'development';
  if (!['development', 'staging', 'production'].includes(envRaw)) {
    throw new Error(`Invalid CVE_ENV: "${envRaw}". Must be development, staging, or production.`);
  }
  const env = envRaw as EnvironmentName;

  const publicBaseUrl = source['CVE_PUBLIC_BASE_URL'] || 'http://127.0.0.1:8080/v1';
  if (env === 'production' && !publicBaseUrl.startsWith('https://')) {
    throw new Error('CVE_PUBLIC_BASE_URL must use HTTPS in production');
  }

  const leaseSeconds = parseNumber(source['CVE_LEASE_SECONDS'], 60, 10, 600);
  const heartbeatSeconds = parseNumber(source['CVE_HEARTBEAT_SECONDS'], 15, 1, 120);
  if (heartbeatSeconds > leaseSeconds / 3) {
    throw new Error(
      `CVE_HEARTBEAT_SECONDS (${heartbeatSeconds}) must be <= CVE_LEASE_SECONDS / 3 (${leaseSeconds / 3})`,
    );
  }

  const customCodeEnabled = parseBoolean(source['CVE_CUSTOM_CODE_ENABLED'], false);
  const customRuntime = source['CVE_CUSTOM_RUNTIME'] || 'disabled';
  if (customCodeEnabled && customRuntime === 'disabled') {
    throw new Error('CVE_CUSTOM_CODE_ENABLED cannot be true while CVE_CUSTOM_RUNTIME is disabled');
  }

  const allowlistRaw = source['CVE_CUSTOM_TENANT_ALLOWLIST'] || '';
  const tenantAllowlist = allowlistRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const rendererAdapterRaw = source['CVE_RENDERER_ADAPTER'] || 'chromium-frame-v1';
  if (!['chromium-frame-v1', 'hyperframes-v1'].includes(rendererAdapterRaw)) {
    throw new Error(`Unsupported CVE_RENDERER_ADAPTER: "${rendererAdapterRaw}"`);
  }

  const config: CveEnvConfig = {
    CVE_ENV: env,
    CVE_PUBLIC_BASE_URL: publicBaseUrl,
    CVE_LOG_LEVEL: (source['CVE_LOG_LEVEL'] as LogLevel) || 'info',
    CVE_COST_RATE_VERSION: source['CVE_COST_RATE_VERSION'] || 'v1',
    CVE_TELEMETRY_ENDPOINT: source['CVE_TELEMETRY_ENDPOINT'] || undefined,

    CVE_DATABASE_URL:
      source['CVE_DATABASE_URL'] ||
      'postgresql://cve_api:cve_dev_api_secret@127.0.0.1:5432/creativanta_video_engine',
    CVE_MIGRATION_DATABASE_URL:
      source['CVE_MIGRATION_DATABASE_URL'] ||
      'postgresql://cve_migrator:cve_dev_migrator_secret@127.0.0.1:5432/creativanta_video_engine',

    CVE_STORAGE_ENDPOINT: source['CVE_STORAGE_ENDPOINT'] || 'http://127.0.0.1:9000',
    CVE_STORAGE_REGION: source['CVE_STORAGE_REGION'] || 'us-east-1',
    CVE_STORAGE_ACCESS_KEY_ID: source['CVE_STORAGE_ACCESS_KEY_ID'] || 'minioadmin',
    CVE_STORAGE_SECRET_ACCESS_KEY: source['CVE_STORAGE_SECRET_ACCESS_KEY'] || 'minioadmin',
    CVE_QUARANTINE_BUCKET: source['CVE_QUARANTINE_BUCKET'] || 'cve-quarantine-dev',
    CVE_ASSET_BUCKET: source['CVE_ASSET_BUCKET'] || 'cve-assets-dev',
    CVE_ARTIFACT_BUCKET: source['CVE_ARTIFACT_BUCKET'] || 'cve-artifacts-dev',
    CVE_SIGNED_DOWNLOAD_TTL_SECONDS: parseNumber(source['CVE_SIGNED_DOWNLOAD_TTL_SECONDS'], 300, 30, 600),
    CVE_ARTIFACT_RETENTION_DAYS: parseNumber(source['CVE_ARTIFACT_RETENTION_DAYS'], 7, 1, 90),
    CVE_ASSET_RETENTION_DAYS: parseNumber(source['CVE_ASSET_RETENTION_DAYS'], 7, 1, 90),

    CVE_API_KEY_PEPPER:
      source['CVE_API_KEY_PEPPER'] || 'dev_pepper_0123456789abcdef0123456789abcdef',
    CVE_SECRET_ENCRYPTION_KEY_ID: source['CVE_SECRET_ENCRYPTION_KEY_ID'] || 'dev-kms-local-key-1',
    CVE_EGRESS_POLICY_PATH: source['CVE_EGRESS_POLICY_PATH'] || '/etc/cve/egress-policy.json',

    CVE_RENDERER_ADAPTER: rendererAdapterRaw as RendererAdapter,
    CVE_RENDER_IMAGE_DIGEST:
      source['CVE_RENDER_IMAGE_DIGEST'] ||
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    CVE_RENDER_SLOTS: parseNumber(source['CVE_RENDER_SLOTS'], 1, 1, 16),
    CVE_RENDER_CPU_LIMIT: parseNumber(source['CVE_RENDER_CPU_LIMIT'], 2, 1, 32),
    CVE_RENDER_MEMORY_MIB: parseNumber(source['CVE_RENDER_MEMORY_MIB'], 4096, 512, 65536),
    CVE_RENDER_PIDS_LIMIT: parseNumber(source['CVE_RENDER_PIDS_LIMIT'], 256, 32, 4096),
    CVE_RENDER_TEMP_MIB: parseNumber(source['CVE_RENDER_TEMP_MIB'], 8192, 1024, 65536),
    CVE_FRAME_TIMEOUT_MS: parseNumber(source['CVE_FRAME_TIMEOUT_MS'], 5000, 500, 60000),
    CVE_RENDER_TIMEOUT_SECONDS: parseNumber(source['CVE_RENDER_TIMEOUT_SECONDS'], 600, 10, 3600),
    CVE_PREVIEW_TIMEOUT_SECONDS: parseNumber(source['CVE_PREVIEW_TIMEOUT_SECONDS'], 120, 10, 600),
    CVE_JOB_DEADLINE_SECONDS: parseNumber(source['CVE_JOB_DEADLINE_SECONDS'], 1800, 60, 7200),
    CVE_LEASE_SECONDS: leaseSeconds,
    CVE_HEARTBEAT_SECONDS: heartbeatSeconds,
    CVE_MAX_ATTEMPTS: parseNumber(source['CVE_MAX_ATTEMPTS'], 3, 1, 5),

    CVE_REMOTE_IMPORT_ENABLED: parseBoolean(source['CVE_REMOTE_IMPORT_ENABLED'], false),
    CVE_CUSTOM_CODE_ENABLED: customCodeEnabled,
    CVE_CUSTOM_RUNTIME: customRuntime,
    CVE_CUSTOM_TENANT_ALLOWLIST: tenantAllowlist,
    CVE_AUTHORING_PROVIDER: source['CVE_AUTHORING_PROVIDER'] || 'disabled',
    CVE_AUTHORING_SECRET_REF: source['CVE_AUTHORING_SECRET_REF'] || undefined,
    CVE_TTS_PROVIDER: source['CVE_TTS_PROVIDER'] || 'disabled',
    CVE_TTS_SECRET_REF: source['CVE_TTS_SECRET_REF'] || undefined,
  };

  return config;
}

export function redactEnvConfig(config: CveEnvConfig): Record<string, unknown> {
  return {
    ...config,
    CVE_DATABASE_URL: redactUrlCredentials(config.CVE_DATABASE_URL),
    CVE_MIGRATION_DATABASE_URL: redactUrlCredentials(config.CVE_MIGRATION_DATABASE_URL),
    CVE_STORAGE_SECRET_ACCESS_KEY: '[REDACTED]',
    CVE_API_KEY_PEPPER: '[REDACTED]',
    CVE_AUTHORING_SECRET_REF: config.CVE_AUTHORING_SECRET_REF ? '[REDACTED]' : undefined,
    CVE_TTS_SECRET_REF: config.CVE_TTS_SECRET_REF ? '[REDACTED]' : undefined,
  };
}
