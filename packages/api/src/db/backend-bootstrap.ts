/**
 * Staging & Local Backend Bootstrap, Fail-Closed Environment Guard,
 * Driver Compatibility Evaluator, and Bounded Dependency Connectivity Probes (Task P10-A).
 *
 * Canonical specifications:
 *   - docs/DEPLOYMENT.md ("Startup contract khi code tồn tại" & "Environment specification", lines 50-102)
 *   - docs/SECURITY.md ("Tenant identity và secrets", lines 19-24 & "Arbitrary agent/user code", lines 41-52)
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", lines 37-55)
 *
 * Truthfulness & Safety Invariants:
 *   1. Real staging (`CVE_ENV=staging` or `CVE_ENV=production`) NEVER falls back to in-memory/local
 *      `node:sqlite` or hardcoded development credentials (`cve_dev_api_secret`, `minioadmin`, etc.).
 *   2. `TenantConnectionPool` and `TenantRepository` currently execute synchronous SQL against
 *      `node:sqlite` (`DatabaseSync`). Until an async PostgreSQL wire-protocol repository adapter
 *      is implemented and reviewed, `CVE_BACKEND_MODE=postgres` truthfully reports
 *      `repositoryDriverCompatible: false` and leaves `repository` undefined (fail-closed 503).
 *   3. Isolated test-only SQLite startup (`CVE_BACKEND_MODE=sqlite-test-only`) is strictly gated
 *      to `CVE_ENV=development`, labeled `nonProductionTestOnly: true`, accepts only pre-hashed
 *      `cve_test_*` API key records (never plaintext tokens in env), and keeps `/readyz` fail-closed
 *      by default unless live dependency probes are verified.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { CveEnvConfig, redactUrlCredentials } from '@creativanta/contracts';
import { ALL_API_SCOPES, ApiScope } from '../auth/api-key.js';
import { QuarantineStore } from '../assets/quarantine-store.js';
import {
  MigrationAuditReport,
  MigrationRunner,
  auditPostgresMigrations,
  resolveDefaultMigrationsDir,
} from './migration-runner.js';
import { TenantConnectionPool } from './tenant-pool.js';
import { TenantRepository } from './repository.js';

export type BackendMode = 'unconfigured' | 'postgres' | 'sqlite-test-only';

export class BackendBootstrapError extends Error {
  public readonly code: string;
  public readonly details: string[];

  constructor(code: string, message: string, details: string[] = []) {
    super(message);
    this.name = 'BackendBootstrapError';
    this.code = code;
    this.details = details;
  }
}

const UUID_V4_OR_CANONICAL_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEST_KEY_PREFIX_REGEX = /^cve_test_[0-9a-f]{12}$/;
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/i;
const PLACEHOLDER_ZERO_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

const FORBIDDEN_DEFAULT_SECRETS = new Set([
  'cve_dev_api_secret',
  'cve_dev_migrator_secret',
  'cve_dev_dispatcher_secret',
  'cve_dev_ingest_secret',
  'cve_dev_sender_secret',
  'staging_redacted',
  'minioadmin',
  'postgres',
  'password',
  'admin',
  'changeme',
  'replace_me',
  'dev_pepper_0123456789abcdef0123456789abcdef',
  'dev-kms-local-key-1',
]);

const REQUIRED_EXPLICIT_STAGING_ENV_KEYS: readonly string[] = Object.freeze([
  'CVE_PUBLIC_BASE_URL',
  'CVE_DATABASE_URL',
  'CVE_STORAGE_ENDPOINT',
  'CVE_STORAGE_REGION',
  'CVE_STORAGE_ACCESS_KEY_ID',
  'CVE_STORAGE_SECRET_ACCESS_KEY',
  'CVE_QUARANTINE_BUCKET',
  'CVE_ASSET_BUCKET',
  'CVE_ARTIFACT_BUCKET',
  'CVE_API_KEY_PEPPER',
  'CVE_SECRET_ENCRYPTION_KEY_ID',
  'CVE_RENDER_IMAGE_DIGEST',
]);

export interface SeededTestTenantInput {
  tenantId: string;
  name: string;
  keyId: string;
  keyPrefix: string;
  keyHash: string;
  pepperVersion?: string;
  scopes: ApiScope[];
}

export interface SeededTestTenantSummary {
  tenantId: string;
  name: string;
  keyId: string;
  keyPrefix: string;
  scopes: ApiScope[];
}

export interface DriverCompatibilityEvaluation {
  migrationsAudit: MigrationAuditReport;
  rlsAndForceRlsVerified: boolean;
  leastPrivilegeRolesDefined: boolean;
  currentRepositoryEngine: 'node:sqlite';
  targetStagingEngine: 'postgresql-16';
  postgresWireDriverInstalled: false;
  asyncTenantRepositoryImplemented: false;
  canServePostgresTraffic: false;
  summary: string;
  incompatibilities: string[];
}

export interface PostgresConnectivityProbeResult {
  reachable: boolean;
  wireProtocolVerified: boolean;
  host: string;
  port: number;
  database: string;
  role: string;
  leastPrivilegeRoleValid: boolean;
  rlsMigrationsAudited: boolean;
  repositoryDriverCompatible: boolean;
  readyForTraffic: boolean;
  latencyMs: number;
  reasonCode:
    | 'POSTGRES_DRIVER_NOT_IMPLEMENTED'
    | 'INVALID_DATABASE_URL'
    | 'FORBIDDEN_RUNTIME_DB_ROLE'
    | 'INSECURE_DATABASE_CREDENTIALS'
    | 'MIGRATION_AUDIT_FAILED'
    | 'TCP_CONNECT_TIMEOUT'
    | 'TCP_CONNECT_FAILED'
    | 'INVALID_WIRE_RESPONSE';
  redactedEndpoint: string;
}

export interface ObjectStorageConnectivityProbeResult {
  reachable: boolean;
  bucketAccessible: boolean;
  ready: boolean;
  httpStatus: number | null;
  bucket: string;
  region: string;
  latencyMs: number;
  reasonCode:
    | 'OK'
    | 'INVALID_STORAGE_CONFIG'
    | 'INSECURE_STORAGE_CREDENTIALS'
    | 'STORAGE_AUTH_DENIED'
    | 'STORAGE_BUCKET_NOT_FOUND'
    | 'STORAGE_REDIRECT_FORBIDDEN'
    | 'STORAGE_HTTP_ERROR'
    | 'STORAGE_CONNECT_TIMEOUT_OR_NETWORK_ERROR';
  redactedEndpoint: string;
}

export interface RendererWorkerProbeResult {
  ready: boolean;
  adapter: string;
  imageDigestValid: boolean;
  httpStatus: number | null;
  latencyMs: number;
  reasonCode:
    | 'OK'
    | 'PLACEHOLDER_RENDER_IMAGE_DIGEST'
    | 'WORKER_PROBE_NOT_CONFIGURED'
    | 'WORKER_NOT_READY'
    | 'WORKER_PROBE_FAILED';
}

export interface BackendDetailedDiagnostics {
  mode: BackendMode;
  environment: string;
  nonProductionTestOnly: boolean;
  repositoryConfigured: boolean;
  driverEvaluation: DriverCompatibilityEvaluation;
  probes: {
    postgres: PostgresConnectivityProbeResult | null;
    sqliteTestDbOk: boolean | null;
    storage: ObjectStorageConnectivityProbeResult;
    renderer: RendererWorkerProbeResult;
  };
  overallReady: boolean;
  evaluatedAt: string;
}

export interface BootstrapApiBackendOptions {
  config: CveEnvConfig;
  rawEnv?: Record<string, string | undefined>;
  mode?: BackendMode;
  migrationsDir?: string;
  sqliteDbPath?: string;
  storageDir?: string;
  seedTenants?: SeededTestTenantInput[];
  probeTimeoutMs?: number;
  workerProbeUrl?: string;
  allowLoopbackHttpInStagingTest?: boolean;
  allowTestSqliteReadinessProbe?: boolean;
}

export interface BootstrappedApiBackend {
  mode: BackendMode;
  nonProductionTestOnly: boolean;
  config: CveEnvConfig;
  repository?: TenantRepository;
  quarantineStore?: QuarantineStore;
  seededTenants: SeededTestTenantSummary[];
  driverEvaluation: DriverCompatibilityEvaluation;
  readinessProbe: () => Promise<{
    database: boolean;
    storage: boolean;
    renderer: boolean;
  }>;
  runDetailedDiagnostics: () => Promise<BackendDetailedDiagnostics>;
  close: () => Promise<void>;
}

function clampTimeoutMs(timeoutMs?: number, defaultMs = 1500): number {
  if (timeoutMs === undefined || Number.isNaN(timeoutMs)) {
    return defaultMs;
  }
  return Math.max(100, Math.min(10000, Math.floor(timeoutMs)));
}

function isForbiddenSecretValue(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_DEFAULT_SECRETS.has(trimmed) || FORBIDDEN_DEFAULT_SECRETS.has(lower)) {
    return true;
  }
  if (
    lower.includes('cve_dev_') ||
    lower.includes('staging_redacted') ||
    lower.includes('changeme') ||
    lower.includes('replace_me') ||
    lower.includes('minioadmin')
  ) {
    return true;
  }
  return false;
}

/**
 * Resolves the active backend mode from `CVE_ENV` and `CVE_BACKEND_MODE`.
 * - In `staging` and `production`, only `'postgres'` is permitted; `'sqlite-test-only'`
 *   and `'unconfigured'` are rejected fail-closed.
 * - In `development`, defaults to `'unconfigured'` unless `CVE_BACKEND_MODE` is explicitly
 *   set to `'sqlite-test-only'` or `'postgres'`.
 */
export function resolveBackendMode(
  config: CveEnvConfig,
  rawEnv: Record<string, string | undefined> = process.env,
  explicitMode?: BackendMode,
): BackendMode {
  const rawMode = explicitMode ?? rawEnv['CVE_BACKEND_MODE']?.trim().toLowerCase();

  if (config.CVE_ENV === 'staging' || config.CVE_ENV === 'production') {
    if (!rawMode || rawMode === 'postgres') {
      return 'postgres';
    }
    if (rawMode === 'sqlite-test-only') {
      throw new BackendBootstrapError(
        'SQLITE_TEST_MODE_FORBIDDEN_IN_STAGING_OR_PROD',
        `CVE_BACKEND_MODE='sqlite-test-only' is strictly non-production and forbidden when CVE_ENV='${config.CVE_ENV}'`,
        [`CVE_ENV=${config.CVE_ENV}`, 'CVE_BACKEND_MODE=sqlite-test-only'],
      );
    }
    throw new BackendBootstrapError(
      'INVALID_BACKEND_MODE_FOR_ENV',
      `Unsupported CVE_BACKEND_MODE='${rawMode}' for CVE_ENV='${config.CVE_ENV}'; expected 'postgres'`,
      [`CVE_ENV=${config.CVE_ENV}`, `CVE_BACKEND_MODE=${rawMode}`],
    );
  }

  if (!rawMode || rawMode === 'unconfigured') {
    return 'unconfigured';
  }
  if (rawMode === 'sqlite-test-only' || rawMode === 'postgres') {
    return rawMode;
  }

  throw new BackendBootstrapError(
    'UNSUPPORTED_BACKEND_MODE',
    `Unsupported CVE_BACKEND_MODE='${rawMode}'; expected 'unconfigured', 'sqlite-test-only', or 'postgres'`,
    [`CVE_BACKEND_MODE=${rawMode}`],
  );
}

/**
 * Validates startup environment configuration for fail-closed security invariants:
 * - Gated capabilities (`CVE_CUSTOM_CODE_ENABLED`, `CVE_REMOTE_IMPORT_ENABLED`, etc.) MUST be off.
 * - Staging/production or `postgres` mode requires explicit env vars (no fallback defaults),
 *   rejects placeholder credentials, requires HTTPS URLs, distinct non-dev buckets, non-zero
 *   renderer image digest, and least-privilege `cve_api` database role.
 */
export function validateBackendStartupEnv(
  config: CveEnvConfig,
  rawEnv: Record<string, string | undefined> = process.env,
  options: {
    mode?: BackendMode;
    allowLoopbackHttpInStagingTest?: boolean;
  } = {},
): void {
  const mode = resolveBackendMode(config, rawEnv, options.mode);
  const violations: string[] = [];

  // 1. Gated capabilities must remain strictly disabled across all environments (Issue #61 / SECURITY.md)
  if (config.CVE_CUSTOM_CODE_ENABLED !== false) {
    violations.push('CVE_CUSTOM_CODE_ENABLED must be false');
  }
  if (config.CVE_CUSTOM_RUNTIME !== 'disabled') {
    violations.push("CVE_CUSTOM_RUNTIME must be 'disabled'");
  }
  if (config.CVE_REMOTE_IMPORT_ENABLED !== false) {
    violations.push('CVE_REMOTE_IMPORT_ENABLED must be false');
  }
  if (config.CVE_TTS_PROVIDER !== 'disabled') {
    violations.push("CVE_TTS_PROVIDER must be 'disabled'");
  }
  if (config.CVE_AUTHORING_PROVIDER !== 'disabled') {
    violations.push("CVE_AUTHORING_PROVIDER must be 'disabled'");
  }

  if (violations.length > 0) {
    throw new BackendBootstrapError(
      'GATED_CAPABILITY_VIOLATION',
      `Startup rejected due to unsafe capability flags: ${violations.join('; ')}`,
      violations,
    );
  }

  // 2. Enforce strict non-fallback configuration for staging/production or explicit postgres mode
  if (mode === 'postgres' || config.CVE_ENV === 'staging' || config.CVE_ENV === 'production') {
    const missingKeys: string[] = [];
    for (const key of REQUIRED_EXPLICIT_STAGING_ENV_KEYS) {
      const rawVal = rawEnv[key];
      if (rawVal === undefined || rawVal.trim() === '') {
        missingKeys.push(key);
      }
    }
    if (missingKeys.length > 0) {
      throw new BackendBootstrapError(
        'MISSING_EXPLICIT_STAGING_ENV',
        `Startup rejected: required explicit environment variables missing (${missingKeys.join(', ')})`,
        missingKeys,
      );
    }

    // Validate public base URL & storage endpoint transport security
    const allowLoopbackHttp =
      Boolean(options.allowLoopbackHttpInStagingTest) && config.CVE_ENV !== 'production';

    for (const [key, urlStr] of [
      ['CVE_PUBLIC_BASE_URL', config.CVE_PUBLIC_BASE_URL],
      ['CVE_STORAGE_ENDPOINT', config.CVE_STORAGE_ENDPOINT],
    ] as const) {
      let parsed: URL;
      try {
        parsed = new URL(urlStr);
      } catch {
        violations.push(`${key} is not a valid URL`);
        continue;
      }
      const isLoopbackHttp =
        parsed.protocol === 'http:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
      if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && isLoopbackHttp)) {
        violations.push(`${key} must use https:// in ${config.CVE_ENV}`);
      }
    }

    // Validate database URL & least-privilege cve_api role
    let dbUrl: URL | null = null;
    try {
      dbUrl = new URL(config.CVE_DATABASE_URL);
    } catch {
      violations.push('CVE_DATABASE_URL is not a valid URL');
    }

    if (dbUrl) {
      if (dbUrl.protocol !== 'postgresql:' && dbUrl.protocol !== 'postgres:') {
        violations.push('CVE_DATABASE_URL must use postgresql:// scheme');
      }
      const dbUser = decodeURIComponent(dbUrl.username || '');
      const dbPass = decodeURIComponent(dbUrl.password || '');
      const dbName = dbUrl.pathname.replace(/^\/+/, '');

      if (dbUser !== 'cve_api') {
        violations.push(
          `CVE_DATABASE_URL runtime role must be least-privilege 'cve_api' (got '${dbUser || 'empty'}')`,
        );
      }
      if (isForbiddenSecretValue(dbPass) || dbPass.length < 16) {
        violations.push(
          'CVE_DATABASE_URL password must not use default/placeholder credentials and must be >= 16 characters',
        );
      }
      if (!dbName || dbName.includes('/')) {
        violations.push('CVE_DATABASE_URL must specify a valid database name');
      }

      const rawMigrationUrl = rawEnv['CVE_MIGRATION_DATABASE_URL']?.trim();
      if (rawMigrationUrl) {
        if (rawMigrationUrl === config.CVE_DATABASE_URL) {
          violations.push(
            'CVE_MIGRATION_DATABASE_URL must not be identical to runtime CVE_DATABASE_URL (DDL role separation required)',
          );
        } else {
          try {
            const migUrl = new URL(rawMigrationUrl);
            const migUser = decodeURIComponent(migUrl.username || '');
            if (migUser !== 'cve_migrator') {
              violations.push(
                `CVE_MIGRATION_DATABASE_URL role must be 'cve_migrator' when specified (got '${migUser || 'empty'}')`,
              );
            }
          } catch {
            violations.push('CVE_MIGRATION_DATABASE_URL is not a valid URL');
          }
        }
      }
    }

    // Validate storage credentials and distinct private buckets
    if (
      isForbiddenSecretValue(config.CVE_STORAGE_ACCESS_KEY_ID) ||
      isForbiddenSecretValue(config.CVE_STORAGE_SECRET_ACCESS_KEY) ||
      config.CVE_STORAGE_SECRET_ACCESS_KEY.trim().length < 16
    ) {
      violations.push(
        'CVE_STORAGE_ACCESS_KEY_ID / CVE_STORAGE_SECRET_ACCESS_KEY must not use default/placeholder credentials',
      );
    }

    const buckets = [
      config.CVE_QUARANTINE_BUCKET.trim(),
      config.CVE_ASSET_BUCKET.trim(),
      config.CVE_ARTIFACT_BUCKET.trim(),
    ];
    if (new Set(buckets).size !== 3 || buckets.some((b) => !b)) {
      violations.push(
        'CVE_QUARANTINE_BUCKET, CVE_ASSET_BUCKET, and CVE_ARTIFACT_BUCKET must be three distinct non-empty bucket names',
      );
    }
    if (buckets.some((b) => b.endsWith('-dev'))) {
      violations.push('Storage bucket names must not use development (-dev) suffixes in staging/production');
    }

    // Validate cryptographic secrets & pinned renderer digest
    if (
      isForbiddenSecretValue(config.CVE_API_KEY_PEPPER) ||
      Buffer.byteLength(config.CVE_API_KEY_PEPPER, 'utf8') < 32
    ) {
      violations.push(
        'CVE_API_KEY_PEPPER must be a non-default high-entropy secret of at least 32 bytes',
      );
    }

    if (isForbiddenSecretValue(config.CVE_SECRET_ENCRYPTION_KEY_ID)) {
      violations.push(
        'CVE_SECRET_ENCRYPTION_KEY_ID must not use the default development key reference',
      );
    }

    if (
      !IMAGE_DIGEST_REGEX.test(config.CVE_RENDER_IMAGE_DIGEST) ||
      config.CVE_RENDER_IMAGE_DIGEST.toLowerCase() === PLACEHOLDER_ZERO_DIGEST
    ) {
      violations.push(
        'CVE_RENDER_IMAGE_DIGEST must be a pinned non-zero SHA-256 OCI digest',
      );
    }

    if (violations.length > 0) {
      throw new BackendBootstrapError(
        'INSECURE_OR_INVALID_STAGING_ENV',
        `Startup rejected by fail-closed staging environment guard: ${violations.join('; ')}`,
        violations,
      );
    }
  }
}

/**
 * Evaluates PostgreSQL migration/RLS readiness and documents the architectural
 * driver gap between `node:sqlite` (`DatabaseSync`) and PostgreSQL 16+.
 */
export function evaluatePostgresDriverAndRlsReadiness(
  migrationsDir = resolveDefaultMigrationsDir(),
): DriverCompatibilityEvaluation {
  const migrationsAudit = auditPostgresMigrations(migrationsDir);
  const rlsAndForceRlsVerified =
    migrationsAudit.valid &&
    migrationsAudit.tableCount === 21 &&
    migrationsAudit.rlsEnabledCount === 21 &&
    migrationsAudit.rlsForcedCount === 21;
  const leastPrivilegeRolesDefined =
    migrationsAudit.valid && migrationsAudit.rolesVerified.length === 5;

  const incompatibilities = [
    'TenantConnectionPool (packages/api/src/db/tenant-pool.ts) binds synchronously to node:sqlite DatabaseSync and executes synchronous withTransaction<T>() callbacks with BEGIN IMMEDIATE and ? positional placeholders.',
    'TenantRepository (packages/api/src/db/repository.ts) exposes synchronous methods consumed directly by createServer (packages/api/src/server.ts) without async/await database I/O.',
    'Zero external PostgreSQL wire-protocol runtime packages (such as pg or postgres) are installed in pnpm-lock.yaml (enforced by P6-04 SBOM check externalRuntimeDependenciesCount === 0).',
  ];

  return {
    migrationsAudit,
    rlsAndForceRlsVerified,
    leastPrivilegeRolesDefined,
    currentRepositoryEngine: 'node:sqlite',
    targetStagingEngine: 'postgresql-16',
    postgresWireDriverInstalled: false,
    asyncTenantRepositoryImplemented: false,
    canServePostgresTraffic: false,
    summary:
      'PostgreSQL 21-table schema, composite tenant_id FKs, ENABLE/FORCE ROW LEVEL SECURITY, and 5 least-privilege roles are verified in SQL migrations, but runtime TenantRepository remains bound to synchronous node:sqlite DatabaseSync and cannot yet serve live PostgreSQL traffic.',
    incompatibilities,
  };
}

function buildPostgresStartupPacket(user: string, database: string): Buffer {
  const bodyParts: Buffer[] = [];
  const pushCString = (str: string) => {
    bodyParts.push(Buffer.from(str, 'utf8'));
    bodyParts.push(Buffer.from([0]));
  };
  pushCString('user');
  pushCString(user);
  pushCString('database');
  pushCString(database);
  pushCString('application_name');
  pushCString('creativanta-cve-readiness-probe');
  bodyParts.push(Buffer.from([0])); // Terminator byte

  const body = Buffer.concat(bodyParts);
  const totalLength = 8 + body.byteLength;
  const header = Buffer.alloc(8);
  header.writeInt32BE(totalLength, 0);
  header.writeInt32BE(196608, 4); // Protocol v3.0 (0x00030000)
  return Buffer.concat([header, body]);
}

export const PG_WIRE_HEADER_BYTES = 5;
export const PG_WIRE_MIN_FRAME_LENGTH = 5;
export const PG_WIRE_MIN_AUTH_FRAME_LENGTH = 8;
export const PG_WIRE_MAX_FRAME_LENGTH = 8192;
export const PG_WIRE_MAX_BUFFER_BYTES = 1 + PG_WIRE_MAX_FRAME_LENGTH;

/**
 * Performs a real bounded TCP + PostgreSQL v3 wire-protocol StartupMessage probe
 * against `databaseUrl`. Incrementally buffers fragmented TCP packets up to
 * `PG_WIRE_MAX_BUFFER_BYTES`, validates complete v3 backend frame-length semantics,
 * enforces a strict deadline, cleans up all socket event listeners, never logs or
 * returns credentials, always terminates the socket cleanly, and truthfully sets
 * `repositoryDriverCompatible: false` until an async PostgreSQL `TenantRepository`
 * is implemented.
 */
export async function probePostgresConnectivity(
  databaseUrl: string,
  options: { timeoutMs?: number; migrationsDir?: string } = {},
): Promise<PostgresConnectivityProbeResult> {
  const startedAt = performance.now();
  const timeoutMs = clampTimeoutMs(options.timeoutMs, 1500);
  const redactedEndpoint = redactUrlCredentials(databaseUrl);

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return {
      reachable: false,
      wireProtocolVerified: false,
      host: '',
      port: 0,
      database: '',
      role: '',
      leastPrivilegeRoleValid: false,
      rlsMigrationsAudited: false,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'INVALID_DATABASE_URL',
      redactedEndpoint,
    };
  }

  const host = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 5432;
  const role = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const database = parsed.pathname.replace(/^\/+/, '');

  if (
    (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') ||
    !host ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !database
  ) {
    return {
      reachable: false,
      wireProtocolVerified: false,
      host,
      port: Number.isInteger(port) ? port : 0,
      database,
      role,
      leastPrivilegeRoleValid: false,
      rlsMigrationsAudited: false,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'INVALID_DATABASE_URL',
      redactedEndpoint,
    };
  }

  const leastPrivilegeRoleValid = role === 'cve_api';
  if (!leastPrivilegeRoleValid) {
    return {
      reachable: false,
      wireProtocolVerified: false,
      host,
      port,
      database,
      role,
      leastPrivilegeRoleValid: false,
      rlsMigrationsAudited: false,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'FORBIDDEN_RUNTIME_DB_ROLE',
      redactedEndpoint,
    };
  }

  if (isForbiddenSecretValue(password) || password.length < 16) {
    return {
      reachable: false,
      wireProtocolVerified: false,
      host,
      port,
      database,
      role,
      leastPrivilegeRoleValid: true,
      rlsMigrationsAudited: false,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'INSECURE_DATABASE_CREDENTIALS',
      redactedEndpoint,
    };
  }

  const audit = auditPostgresMigrations(options.migrationsDir);
  const rlsMigrationsAudited =
    audit.valid &&
    audit.tableCount === 21 &&
    audit.rlsEnabledCount === 21 &&
    audit.rlsForcedCount === 21;

  if (!rlsMigrationsAudited) {
    return {
      reachable: false,
      wireProtocolVerified: false,
      host,
      port,
      database,
      role,
      leastPrivilegeRoleValid: true,
      rlsMigrationsAudited: false,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'MIGRATION_AUDIT_FAILED',
      redactedEndpoint,
    };
  }

  const wireOutcome = await new Promise<{
    reachable: boolean;
    wireProtocolVerified: boolean;
    errorType?: 'TCP_CONNECT_TIMEOUT' | 'TCP_CONNECT_FAILED' | 'INVALID_WIRE_RESPONSE';
  }>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    let connected = false;
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let expectedTotalBytes: number | null = null;

    const cleanupListeners = () => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
      socket.on('error', () => {
        // Suppress post-teardown socket error events
      });
    };

    const finish = (res: {
      reachable: boolean;
      wireProtocolVerified: boolean;
      errorType?: 'TCP_CONNECT_TIMEOUT' | 'TCP_CONNECT_FAILED' | 'INVALID_WIRE_RESPONSE';
    }) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      try {
        if (!socket.destroyed && socket.writable) {
          // PostgreSQL Terminate ('X', Int32(4))
          socket.write(Buffer.from([0x58, 0x00, 0x00, 0x00, 0x04]));
        }
      } catch {
        // Ignore write error during teardown
      }
      socket.destroy();
      resolve(res);
    };

    const timer = setTimeout(() => {
      finish({
        reachable: connected,
        wireProtocolVerified: false,
        errorType: 'TCP_CONNECT_TIMEOUT',
      });
    }, timeoutMs);

    const onError = () => {
      finish({
        reachable: connected,
        wireProtocolVerified: false,
        errorType: connected && bufferedBytes > 0 ? 'INVALID_WIRE_RESPONSE' : 'TCP_CONNECT_FAILED',
      });
    };

    const onConnect = () => {
      connected = true;
      socket.setNoDelay(true);
      const packet = buildPostgresStartupPacket(role, database);
      socket.write(packet);
    };

    const onData = (chunk: Buffer) => {
      if (settled || chunk.byteLength === 0) return;

      if (bufferedBytes + chunk.byteLength > PG_WIRE_MAX_BUFFER_BYTES) {
        finish({
          reachable: true,
          wireProtocolVerified: false,
          errorType: 'INVALID_WIRE_RESPONSE',
        });
        return;
      }

      chunks.push(chunk);
      bufferedBytes += chunk.byteLength;

      // Validate message type byte immediately once at least 1 byte is buffered:
      // 'R' (0x52) = Authentication*, 'E' (0x45) = ErrorResponse, 'N' (0x4e) = NoticeResponse
      const msgType = chunks[0]![0]!;
      if (msgType !== 0x52 && msgType !== 0x45 && msgType !== 0x4e) {
        finish({
          reachable: true,
          wireProtocolVerified: false,
          errorType: 'INVALID_WIRE_RESPONSE',
        });
        return;
      }

      // Wait for the 5-byte PostgreSQL v3 message header (1-byte tag + 4-byte Int32BE length)
      if (bufferedBytes < PG_WIRE_HEADER_BYTES) {
        return;
      }

      const combined =
        chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, bufferedBytes);
      chunks.length = 0;
      chunks.push(combined);

      if (expectedTotalBytes === null) {
        const frameLength = combined.readInt32BE(1);
        const minFrameLength =
          msgType === 0x52 ? PG_WIRE_MIN_AUTH_FRAME_LENGTH : PG_WIRE_MIN_FRAME_LENGTH;
        if (frameLength < minFrameLength || frameLength > PG_WIRE_MAX_FRAME_LENGTH) {
          finish({
            reachable: true,
            wireProtocolVerified: false,
            errorType: 'INVALID_WIRE_RESPONSE',
          });
          return;
        }
        expectedTotalBytes = 1 + frameLength;
      }

      // Wait until the entire initial frame (1 + frameLength bytes) has arrived
      if (bufferedBytes < expectedTotalBytes) {
        return;
      }

      if (msgType === 0x52) {
        const authCode = combined.readInt32BE(5);
        if (authCode < 0) {
          finish({
            reachable: true,
            wireProtocolVerified: false,
            errorType: 'INVALID_WIRE_RESPONSE',
          });
          return;
        }
      }

      finish({
        reachable: true,
        wireProtocolVerified: true,
      });
    };

    const onEnd = () => {
      if (!settled) {
        finish({
          reachable: connected,
          wireProtocolVerified: false,
          errorType: connected && bufferedBytes > 0 ? 'INVALID_WIRE_RESPONSE' : 'TCP_CONNECT_FAILED',
        });
      }
    };

    const onClose = () => {
      if (!settled) {
        finish({
          reachable: connected,
          wireProtocolVerified: false,
          errorType: connected && bufferedBytes > 0 ? 'INVALID_WIRE_RESPONSE' : 'TCP_CONNECT_FAILED',
        });
      }
    };

    socket.on('error', onError);
    socket.once('connect', onConnect);
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);

    socket.connect(port, host);
  });

  const latencyMs = Number((performance.now() - startedAt).toFixed(2));
  if (!wireOutcome.reachable || !wireOutcome.wireProtocolVerified) {
    return {
      reachable: wireOutcome.reachable,
      wireProtocolVerified: wireOutcome.wireProtocolVerified,
      host,
      port,
      database,
      role,
      leastPrivilegeRoleValid: true,
      rlsMigrationsAudited: true,
      repositoryDriverCompatible: false,
      readyForTraffic: false,
      latencyMs,
      reasonCode: wireOutcome.errorType ?? 'TCP_CONNECT_FAILED',
      redactedEndpoint,
    };
  }

  // Truthful gate: even when PostgreSQL TCP + v3 wire handshake succeeds,
  // TenantRepository is still synchronous node:sqlite and cannot serve Postgres traffic yet.
  return {
    reachable: true,
    wireProtocolVerified: true,
    host,
    port,
    database,
    role,
    leastPrivilegeRoleValid: true,
    rlsMigrationsAudited: true,
    repositoryDriverCompatible: false,
    readyForTraffic: false,
    latencyMs,
    reasonCode: 'POSTGRES_DRIVER_NOT_IMPLEMENTED',
    redactedEndpoint,
  };
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Generates AWS Signature Version 4 (`AWS4-HMAC-SHA256`) headers for a bounded
 * `HEAD /<bucket>` object storage readiness probe.
 */
export function buildS3SigV4HeadHeaders(options: {
  endpointUrl: URL;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: Date;
}): { targetUrl: string; headers: Record<string, string> } {
  const now = options.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const basePath = options.endpointUrl.pathname.replace(/\/+$/, '');
  const canonicalUri = `${basePath}/${encodeURIComponent(options.bucket)}`;
  const targetUrl = new URL(canonicalUri, options.endpointUrl.origin).toString();
  const hostHeader = options.endpointUrl.host;
  const emptyPayloadHash = sha256Hex('');

  const canonicalHeaders =
    `host:${hostHeader}\n` +
    `x-amz-content-sha256:${emptyPayloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'HEAD',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    emptyPayloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${options.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, options.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf8')
    .digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    targetUrl,
    headers: {
      Host: hostHeader,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': emptyPayloadHash,
      Authorization: authorization,
    },
  };
}

/**
 * Performs a real bounded HTTP/HTTPS AWS SigV4 `HEAD /<quarantine_bucket>` probe
 * against `CVE_STORAGE_ENDPOINT` with `redirect: 'manual'` and no credential leakage.
 */
export async function probeObjectStorageConnectivity(
  config: Pick<
    CveEnvConfig,
    | 'CVE_ENV'
    | 'CVE_STORAGE_ENDPOINT'
    | 'CVE_STORAGE_REGION'
    | 'CVE_STORAGE_ACCESS_KEY_ID'
    | 'CVE_STORAGE_SECRET_ACCESS_KEY'
    | 'CVE_QUARANTINE_BUCKET'
    | 'CVE_ASSET_BUCKET'
    | 'CVE_ARTIFACT_BUCKET'
  >,
  options: {
    timeoutMs?: number;
    now?: Date;
    allowLoopbackHttpInStagingTest?: boolean;
  } = {},
): Promise<ObjectStorageConnectivityProbeResult> {
  const startedAt = performance.now();
  const timeoutMs = clampTimeoutMs(options.timeoutMs, 1500);
  const redactedEndpoint = redactUrlCredentials(config.CVE_STORAGE_ENDPOINT);
  const bucket = config.CVE_QUARANTINE_BUCKET?.trim() || '';
  const region = config.CVE_STORAGE_REGION?.trim() || '';

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(config.CVE_STORAGE_ENDPOINT);
  } catch {
    return {
      reachable: false,
      bucketAccessible: false,
      ready: false,
      httpStatus: null,
      bucket,
      region,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'INVALID_STORAGE_CONFIG',
      redactedEndpoint,
    };
  }

  const buckets = [
    config.CVE_QUARANTINE_BUCKET?.trim(),
    config.CVE_ASSET_BUCKET?.trim(),
    config.CVE_ARTIFACT_BUCKET?.trim(),
  ];
  if (new Set(buckets).size !== 3 || buckets.some((b) => !b) || !region) {
    return {
      reachable: false,
      bucketAccessible: false,
      ready: false,
      httpStatus: null,
      bucket,
      region,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'INVALID_STORAGE_CONFIG',
      redactedEndpoint,
    };
  }

  if (config.CVE_ENV === 'staging' || config.CVE_ENV === 'production') {
    const isLoopbackHttp =
      endpointUrl.protocol === 'http:' &&
      (endpointUrl.hostname === '127.0.0.1' || endpointUrl.hostname === 'localhost') &&
      Boolean(options.allowLoopbackHttpInStagingTest) &&
      config.CVE_ENV !== 'production';

    if (endpointUrl.protocol !== 'https:' && !isLoopbackHttp) {
      return {
        reachable: false,
        bucketAccessible: false,
        ready: false,
        httpStatus: null,
        bucket,
        region,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        reasonCode: 'INVALID_STORAGE_CONFIG',
        redactedEndpoint,
      };
    }

    if (
      isForbiddenSecretValue(config.CVE_STORAGE_ACCESS_KEY_ID) ||
      isForbiddenSecretValue(config.CVE_STORAGE_SECRET_ACCESS_KEY) ||
      config.CVE_STORAGE_SECRET_ACCESS_KEY.trim().length < 16
    ) {
      return {
        reachable: false,
        bucketAccessible: false,
        ready: false,
        httpStatus: null,
        bucket,
        region,
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        reasonCode: 'INSECURE_STORAGE_CREDENTIALS',
        redactedEndpoint,
      };
    }
  }

  const signed = buildS3SigV4HeadHeaders({
    endpointUrl,
    bucket,
    region,
    accessKeyId: config.CVE_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: config.CVE_STORAGE_SECRET_ACCESS_KEY,
    now: options.now,
  });

  try {
    const response = await fetch(signed.targetUrl, {
      method: 'HEAD',
      headers: signed.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    const status = response.status;

    if (status === 200 || status === 204) {
      return {
        reachable: true,
        bucketAccessible: true,
        ready: true,
        httpStatus: status,
        bucket,
        region,
        latencyMs,
        reasonCode: 'OK',
        redactedEndpoint,
      };
    }
    if (status >= 300 && status < 400) {
      return {
        reachable: true,
        bucketAccessible: false,
        ready: false,
        httpStatus: status,
        bucket,
        region,
        latencyMs,
        reasonCode: 'STORAGE_REDIRECT_FORBIDDEN',
        redactedEndpoint,
      };
    }
    if (status === 401 || status === 403) {
      return {
        reachable: true,
        bucketAccessible: false,
        ready: false,
        httpStatus: status,
        bucket,
        region,
        latencyMs,
        reasonCode: 'STORAGE_AUTH_DENIED',
        redactedEndpoint,
      };
    }
    if (status === 404) {
      return {
        reachable: true,
        bucketAccessible: false,
        ready: false,
        httpStatus: status,
        bucket,
        region,
        latencyMs,
        reasonCode: 'STORAGE_BUCKET_NOT_FOUND',
        redactedEndpoint,
      };
    }
    return {
      reachable: true,
      bucketAccessible: false,
      ready: false,
      httpStatus: status,
      bucket,
      region,
      latencyMs,
      reasonCode: 'STORAGE_HTTP_ERROR',
      redactedEndpoint,
    };
  } catch {
    return {
      reachable: false,
      bucketAccessible: false,
      ready: false,
      httpStatus: null,
      bucket,
      region,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'STORAGE_CONNECT_TIMEOUT_OR_NETWORK_ERROR',
      redactedEndpoint,
    };
  }
}

/**
 * Probes worker/renderer controller readiness over a bounded HTTP check and
 * verifies that `CVE_RENDER_IMAGE_DIGEST` is a non-placeholder SHA-256 digest.
 */
export async function probeRendererWorkerReadiness(
  config: Pick<CveEnvConfig, 'CVE_RENDERER_ADAPTER' | 'CVE_RENDER_IMAGE_DIGEST'>,
  options: { workerProbeUrl?: string; timeoutMs?: number } = {},
): Promise<RendererWorkerProbeResult> {
  const startedAt = performance.now();
  const timeoutMs = clampTimeoutMs(options.timeoutMs, 1500);
  const digest = config.CVE_RENDER_IMAGE_DIGEST?.trim() || '';
  const imageDigestValid =
    IMAGE_DIGEST_REGEX.test(digest) && digest.toLowerCase() !== PLACEHOLDER_ZERO_DIGEST;

  if (!imageDigestValid) {
    return {
      ready: false,
      adapter: config.CVE_RENDERER_ADAPTER,
      imageDigestValid: false,
      httpStatus: null,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'PLACEHOLDER_RENDER_IMAGE_DIGEST',
    };
  }

  const probeUrl = options.workerProbeUrl?.trim();
  if (!probeUrl) {
    return {
      ready: false,
      adapter: config.CVE_RENDERER_ADAPTER,
      imageDigestValid: true,
      httpStatus: null,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'WORKER_PROBE_NOT_CONFIGURED',
    };
  }

  try {
    const response = await fetch(probeUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Number((performance.now() - startedAt).toFixed(2));
    if (response.status !== 200) {
      return {
        ready: false,
        adapter: config.CVE_RENDERER_ADAPTER,
        imageDigestValid: true,
        httpStatus: response.status,
        latencyMs,
        reasonCode: 'WORKER_NOT_READY',
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const workerReady = body['status'] === 'ready' && body['adapter'] === config.CVE_RENDERER_ADAPTER;
    return {
      ready: workerReady,
      adapter: config.CVE_RENDERER_ADAPTER,
      imageDigestValid: true,
      httpStatus: 200,
      latencyMs,
      reasonCode: workerReady ? 'OK' : 'WORKER_NOT_READY',
    };
  } catch {
    return {
      ready: false,
      adapter: config.CVE_RENDERER_ADAPTER,
      imageDigestValid: true,
      httpStatus: null,
      latencyMs: Number((performance.now() - startedAt).toFixed(2)),
      reasonCode: 'WORKER_PROBE_FAILED',
    };
  }
}

function parseAndValidateSeedTenants(
  rawJson: string | undefined,
  programmaticSeeds?: SeededTestTenantInput[],
): SeededTestTenantInput[] {
  const candidates: unknown[] = [];
  if (programmaticSeeds && programmaticSeeds.length > 0) {
    candidates.push(...programmaticSeeds);
  } else if (rawJson && rawJson.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      throw new BackendBootstrapError(
        'INVALID_TEST_BOOTSTRAP_TENANTS_JSON',
        'CVE_TEST_BOOTSTRAP_TENANTS_JSON must be a valid JSON array of hashed tenant key records',
      );
    }
    if (!Array.isArray(parsed)) {
      throw new BackendBootstrapError(
        'INVALID_TEST_BOOTSTRAP_TENANTS_JSON',
        'CVE_TEST_BOOTSTRAP_TENANTS_JSON root must be an array',
      );
    }
    candidates.push(...parsed);
  }

  const validScopesSet = new Set<string>(ALL_API_SCOPES);
  const validated: SeededTestTenantInput[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BackendBootstrapError(
        'INVALID_TEST_BOOTSTRAP_TENANT_ENTRY',
        'Each test bootstrap tenant entry must be an object',
      );
    }
    const rec = item as Record<string, unknown>;
    if (
      'plaintextKey' in rec ||
      'secret' in rec ||
      'rawToken' in rec ||
      'apiKey' in rec
    ) {
      throw new BackendBootstrapError(
        'PLAINTEXT_API_KEY_IN_ENV_FORBIDDEN',
        'Test bootstrap tenant records must only supply pre-hashed keyPrefix and keyHash; plaintext API keys are forbidden',
      );
    }

    const tenantId = typeof rec['tenantId'] === 'string' ? rec['tenantId'].trim().toLowerCase() : '';
    const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
    const keyId = typeof rec['keyId'] === 'string' ? rec['keyId'].trim() : '';
    const keyPrefix = typeof rec['keyPrefix'] === 'string' ? rec['keyPrefix'].trim() : '';
    const keyHash = typeof rec['keyHash'] === 'string' ? rec['keyHash'].trim() : '';
    const pepperVersion =
      typeof rec['pepperVersion'] === 'string' && rec['pepperVersion'].trim()
        ? rec['pepperVersion'].trim()
        : 'v1';
    const rawScopes = Array.isArray(rec['scopes']) ? rec['scopes'] : [];

    if (!UUID_V4_OR_CANONICAL_REGEX.test(tenantId) || tenantId === '00000000-0000-0000-0000-000000000000') {
      throw new BackendBootstrapError(
        'INVALID_TEST_BOOTSTRAP_TENANT_ID',
        `Invalid or reserved tenantId in test bootstrap: '${tenantId}'`,
      );
    }
    if (!name || name.length > 200 || !keyId) {
      throw new BackendBootstrapError(
        'INVALID_TEST_BOOTSTRAP_TENANT_METADATA',
        `Test bootstrap tenant '${tenantId}' requires non-empty name and keyId`,
      );
    }
    if (!TEST_KEY_PREFIX_REGEX.test(keyPrefix)) {
      throw new BackendBootstrapError(
        'INVALID_TEST_KEY_PREFIX',
        `Test bootstrap keyPrefix must use non-production 'cve_test_<12hex>' format (got '${keyPrefix}')`,
      );
    }
    if (!SHA256_HEX_REGEX.test(keyHash)) {
      throw new BackendBootstrapError(
        'INVALID_TEST_KEY_HASH',
        `Test bootstrap keyHash for '${keyId}' must be a 64-character lowercase hex SHA-256 HMAC digest`,
      );
    }
    const scopes: ApiScope[] = [];
    for (const sc of rawScopes) {
      if (typeof sc !== 'string' || !validScopesSet.has(sc)) {
        throw new BackendBootstrapError(
          'INVALID_TEST_KEY_SCOPE',
          `Unsupported API scope '${String(sc)}' in test bootstrap tenant '${tenantId}'`,
        );
      }
      scopes.push(sc as ApiScope);
    }
    if (scopes.length === 0) {
      throw new BackendBootstrapError(
        'INVALID_TEST_KEY_SCOPE',
        `Test bootstrap tenant '${tenantId}' must declare at least one valid scope`,
      );
    }

    validated.push({
      tenantId,
      name,
      keyId,
      keyPrefix,
      keyHash,
      pepperVersion,
      scopes,
    });
  }

  return validated;
}

/**
 * Bootstraps the API backend layer according to `CVE_ENV` and `CVE_BACKEND_MODE`
 * with bounded lifecycle cleanup and truthful readiness probes.
 */
export function bootstrapApiBackend(options: BootstrapApiBackendOptions): BootstrappedApiBackend {
  const rawEnv = options.rawEnv ?? process.env;
  const mode = resolveBackendMode(options.config, rawEnv, options.mode);

  validateBackendStartupEnv(options.config, rawEnv, {
    mode,
    allowLoopbackHttpInStagingTest: options.allowLoopbackHttpInStagingTest,
  });

  const resolvedMigrationsDir =
    options.migrationsDir ?? resolveDefaultMigrationsDir(rawEnv);
  const driverEvaluation = evaluatePostgresDriverAndRlsReadiness(resolvedMigrationsDir);
  if (!driverEvaluation.migrationsAudit.valid) {
    throw new BackendBootstrapError(
      'MIGRATION_AUDIT_FAILED',
      `PostgreSQL migration & RLS audit failed: ${driverEvaluation.migrationsAudit.errors.join('; ')}`,
      driverEvaluation.migrationsAudit.errors,
    );
  }

  const workerProbeUrl =
    options.workerProbeUrl ?? rawEnv['CVE_WORKER_READINESS_URL']?.trim() ?? undefined;
  const probeTimeoutMs = clampTimeoutMs(options.probeTimeoutMs, 1500);

  // Mode 1: 'unconfigured' (default in development when CVE_BACKEND_MODE is unset)
  if (mode === 'unconfigured') {
    const readinessProbe = async () => ({
      database: false,
      storage: false,
      renderer: false,
    });

    return {
      mode: 'unconfigured',
      nonProductionTestOnly: false,
      config: options.config,
      repository: undefined,
      quarantineStore: undefined,
      seededTenants: [],
      driverEvaluation,
      readinessProbe,
      runDetailedDiagnostics: async () => {
        const [storage, renderer] = await Promise.all([
          probeObjectStorageConnectivity(options.config, {
            timeoutMs: probeTimeoutMs,
            allowLoopbackHttpInStagingTest: options.allowLoopbackHttpInStagingTest,
          }),
          probeRendererWorkerReadiness(options.config, {
            workerProbeUrl,
            timeoutMs: probeTimeoutMs,
          }),
        ]);
        return {
          mode: 'unconfigured',
          environment: options.config.CVE_ENV,
          nonProductionTestOnly: false,
          repositoryConfigured: false,
          driverEvaluation,
          probes: {
            postgres: null,
            sqliteTestDbOk: null,
            storage,
            renderer,
          },
          overallReady: false,
          evaluatedAt: new Date().toISOString(),
        };
      },
      close: async () => {},
    };
  }

  // Mode 2: 'postgres' (mandatory for staging/production; fail-closed until async Postgres driver is wired)
  if (mode === 'postgres') {
    const runDetailedDiagnostics = async (): Promise<BackendDetailedDiagnostics> => {
      const [postgres, storage, renderer] = await Promise.all([
        probePostgresConnectivity(options.config.CVE_DATABASE_URL, {
          timeoutMs: probeTimeoutMs,
          migrationsDir: resolvedMigrationsDir,
        }),
        probeObjectStorageConnectivity(options.config, {
          timeoutMs: probeTimeoutMs,
          allowLoopbackHttpInStagingTest: options.allowLoopbackHttpInStagingTest,
        }),
        probeRendererWorkerReadiness(options.config, {
          workerProbeUrl,
          timeoutMs: probeTimeoutMs,
        }),
      ]);

      const overallReady =
        postgres.readyForTraffic && storage.ready && renderer.ready;

      return {
        mode: 'postgres',
        environment: options.config.CVE_ENV,
        nonProductionTestOnly: false,
        repositoryConfigured: false,
        driverEvaluation,
        probes: {
          postgres,
          sqliteTestDbOk: null,
          storage,
          renderer,
        },
        overallReady,
        evaluatedAt: new Date().toISOString(),
      };
    };

    const readinessProbe = async () => {
      const diag = await runDetailedDiagnostics();
      return {
        database: Boolean(diag.probes.postgres?.readyForTraffic),
        storage: diag.probes.storage.ready,
        renderer: diag.probes.renderer.ready,
      };
    };

    return {
      mode: 'postgres',
      nonProductionTestOnly: false,
      config: options.config,
      repository: undefined,
      quarantineStore: undefined,
      seededTenants: [],
      driverEvaluation,
      readinessProbe,
      runDetailedDiagnostics,
      close: async () => {},
    };
  }

  // Mode 3: 'sqlite-test-only' (isolated non-production development/test mode ONLY)
  const seeds = parseAndValidateSeedTenants(
    rawEnv['CVE_TEST_BOOTSTRAP_TENANTS_JSON'],
    options.seedTenants,
  );

  const sqliteDbPath =
    options.sqliteDbPath ?? rawEnv['CVE_SQLITE_TEST_DB_PATH']?.trim() ?? ':memory:';
  const db = new DatabaseSync(sqliteDbPath);
  let dbClosed = false;

  let createdTempStorageDir: string | null = null;
  const resolvedStorageDir =
    options.storageDir ??
    rawEnv['CVE_STORAGE_DIR']?.trim() ??
    (() => {
      createdTempStorageDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'cve-sqlite-test-only-storage-'),
      );
      return createdTempStorageDir;
    })();

  try {
    const migrationRunner = new MigrationRunner(db, resolvedMigrationsDir);
    migrationRunner.migrateUp({ role: 'cve_migrator' });

    const pool = new TenantConnectionPool(db, { poolSize: 4 });
    const quarantineStore = new QuarantineStore(resolvedStorageDir);
    const repository = new TenantRepository(pool, {
      pepper: options.config.CVE_API_KEY_PEPPER,
      quarantineStore,
      baseUrl: options.config.CVE_PUBLIC_BASE_URL,
      masterKey: options.config.CVE_SECRET_ENCRYPTION_KEY_ID,
    });

    const seededTenants: SeededTestTenantSummary[] = [];
    const nowIso = new Date().toISOString();

    for (const seed of seeds) {
      repository.createTenant({
        id: seed.tenantId,
        name: seed.name,
        status: 'active',
      });
      pool.withTransaction({ tenantId: seed.tenantId, role: 'cve_api' }, (tx) => {
        tx.insertScoped('api_keys', {
          tenant_id: seed.tenantId,
          id: seed.keyId,
          key_prefix: seed.keyPrefix,
          key_hash: seed.keyHash,
          pepper_version: seed.pepperVersion ?? 'v1',
          name: `${seed.name}-test-key`,
          scopes_json: JSON.stringify(seed.scopes),
          rotated_from_key_id: null,
          expires_at: null,
          revoked_at: null,
          last_used_at: null,
          created_at: nowIso,
        });
      });
      seededTenants.push({
        tenantId: seed.tenantId,
        name: seed.name,
        keyId: seed.keyId,
        keyPrefix: seed.keyPrefix,
        scopes: [...seed.scopes],
      });
    }

    const checkSqliteTestDbAlive = (): boolean => {
      if (dbClosed) return false;
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM schema_migrations WHERE version IN ('0001', '0002')",
          )
          .get() as { cnt: number } | undefined;
        return row?.cnt === 2;
      } catch {
        return false;
      }
    };

    const runDetailedDiagnostics = async (): Promise<BackendDetailedDiagnostics> => {
      const sqliteTestDbOk = checkSqliteTestDbAlive();
      const [storage, renderer] = await Promise.all([
        probeObjectStorageConnectivity(options.config, {
          timeoutMs: probeTimeoutMs,
          allowLoopbackHttpInStagingTest: true,
        }),
        probeRendererWorkerReadiness(options.config, {
          workerProbeUrl,
          timeoutMs: probeTimeoutMs,
        }),
      ]);

      const dbReady = Boolean(options.allowTestSqliteReadinessProbe) && sqliteTestDbOk;
      const overallReady = dbReady && storage.ready && renderer.ready;

      return {
        mode: 'sqlite-test-only',
        environment: options.config.CVE_ENV,
        nonProductionTestOnly: true,
        repositoryConfigured: true,
        driverEvaluation,
        probes: {
          postgres: null,
          sqliteTestDbOk,
          storage,
          renderer,
        },
        overallReady,
        evaluatedAt: new Date().toISOString(),
      };
    };

    const readinessProbe = async () => {
      const diag = await runDetailedDiagnostics();
      return {
        database: Boolean(options.allowTestSqliteReadinessProbe && diag.probes.sqliteTestDbOk),
        storage: diag.probes.storage.ready,
        renderer: diag.probes.renderer.ready,
      };
    };

    const close = async (): Promise<void> => {
      if (!dbClosed) {
        dbClosed = true;
        try {
          db.close();
        } catch {
          // Ignore close error on already-closed handle
        }
      }
      if (createdTempStorageDir && fs.existsSync(createdTempStorageDir)) {
        try {
          fs.rmSync(createdTempStorageDir, { recursive: true, force: true });
        } catch {
          // Ignore temp cleanup error
        }
      }
    };

    return {
      mode: 'sqlite-test-only',
      nonProductionTestOnly: true,
      config: options.config,
      repository,
      quarantineStore,
      seededTenants,
      driverEvaluation,
      readinessProbe,
      runDetailedDiagnostics,
      close,
    };
  } catch (err) {
    try {
      db.close();
    } catch {
      // Ignore cleanup error
    }
    if (createdTempStorageDir && fs.existsSync(createdTempStorageDir)) {
      try {
        fs.rmSync(createdTempStorageDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup error
      }
    }
    throw err;
  }
}
