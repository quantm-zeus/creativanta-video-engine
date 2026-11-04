/**
 * Tenant-Isolated Repository Enforcing Composite Foreign Keys, Transaction-Local RLS,
 * API Key Hashing, Cursor Binding, and AMB-007 Path-404 vs Body-422 IDOR Taxonomy (Task P3-01).
 */

import crypto from 'node:crypto';
import {
  CompositionSpec,
  ErrorDetail,
  SceneSpec,
  compileComposition,
  compareCompositionRevisions,
  validateCompositionUnified,
} from '@creativanta/contracts';
import {
  ApiScope,
  decodeSignedCursor,
  encodeSignedCursor,
  generateApiKeyMaterial,
  StoredApiKeyRecord,
} from '../auth/api-key.js';
import { SYSTEM_CATALOG_TENANT_ID } from './migration-runner.js';
import { TenantConnectionPool, TenantTransactionContext } from './tenant-pool.js';
import {
  generateSignedDownloadGrant,
  generateSignedArtifactDownloadGrant,
  StorageGrantRevocationStore,
  defaultGrantRevocationStore,
} from '../assets/upload-grant.js';
import { QuarantineStore } from '../assets/quarantine-store.js';
import {
  computeSceneContentHash,
  inspectAndValidateBindings,
  materializeCompositionFromTemplate,
  resolveAndValidateVariables,
  validateDefaultsAgainstSchema,
  validateVariableSchema,
} from '../templates/template-engine.js';
import {
  AdmissionServiceUnavailableError,
  AssetNotReadyError,
  DEFAULT_ACTIVE_JOB_SLOTS_MAX,
  DEFAULT_MAX_ASSETS_PER_JOB,
  DEFAULT_MAX_TOTAL_INPUT_BYTES_PER_JOB,
  DEFAULT_NON_TERMINAL_JOBS_TOTAL_MAX,
  DEFAULT_PENDING_ADMISSION_SLOTS_MAX,
  JobTerminalError,
  QuotaExceededError,
  TenantPolicyLimits,
  UnsupportedCapabilityError,
  ValidatedJobAdmissionRequest,
  WebhookNotVerifiedError,
  calculateJobReservation,
  validatePreviewBoundsAgainstComposition,
} from '../admission/job-admission.js';
import {
  encryptSecretAtRest,
  generateWebhookSecret,
} from '../webhook/crypto.js';
import {
  MAX_DELIVERY_DEADLINE_MS,
  MAX_REPLAYS_PER_DAY,
  WEBHOOK_REPLAY_RETENTION_MS,
  WebhookDeliveryRecord,
  WebhookEndpointRecord,
} from '../webhook/types.js';

export class ResourceNotFoundError extends Error {
  public readonly httpStatus = 404;
  public readonly code = 'NOT_FOUND';

  constructor(message = 'Requested resource was not found') {
    super(message);
    this.name = 'ResourceNotFoundError';
  }
}

export class RevisionConflictError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'REVISION_CONFLICT';

  constructor(message = 'Stale base_revision; resource has been modified') {
    super(message);
    this.name = 'RevisionConflictError';
  }
}

export class InvalidCursorError extends Error {
  public readonly httpStatus = 400;
  public readonly code = 'INVALID_CURSOR';

  constructor(message = 'Invalid, tampered, or cross-tenant pagination cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

export class BodyReferenceValidationError extends Error {
  public readonly httpStatus = 422;
  public readonly code = 'VALIDATION_FAILED';
  public readonly details: ErrorDetail[];

  constructor(details: ErrorDetail[], message = 'Composition references invalid or unauthorized assets/fonts') {
    super(message);
    this.name = 'BodyReferenceValidationError';
    this.details = details;
  }
}

export class IdempotencyConflictError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message = 'Idempotency key reused with different request payload') {
    super(message);
    this.name = 'IdempotencyConflictError';
  }
}

export class IdempotencyInProgressError extends Error {
  public readonly httpStatus = 409;
  public readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  constructor(message = 'Request with this idempotency key is currently in progress') {
    super(message);
    this.name = 'IdempotencyInProgressError';
  }
}

export class DeliveryExpiredError extends Error {
  public readonly httpStatus = 410;
  public readonly code = 'DELIVERY_EXPIRED';

  constructor(message = 'Webhook delivery expired (replay retention is 7 days from event creation)') {
    super(message);
    this.name = 'DeliveryExpiredError';
  }
}

export class ReplayQuotaExceededError extends Error {
  public readonly httpStatus = 429;
  public readonly code = 'QUOTA_EXCEEDED';
  public readonly retryAfterSeconds: number;

  constructor(message = 'Daily replay quota exceeded for delivery (maximum 5 replays per day)', retryAfterSeconds = 86400) {
    super(message);
    this.name = 'ReplayQuotaExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ChallengeExpiredError extends Error {
  public readonly httpStatus = 410;
  public readonly code = 'CHALLENGE_EXPIRED';

  constructor(message = 'Webhook challenge has expired (validity is 10 minutes)') {
    super(message);
    this.name = 'ChallengeExpiredError';
  }
}

export function computeSha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface IssuedApiKeyResult {
  id: string;
  tenantId: string;
  plaintextKey: string;
  keyPrefix: string;
  keyHash: string;
  pepperVersion: string;
  scopes: ApiScope[];
  expiresAt: string | null;
  createdAt: string;
}

export interface UsageEntryRecord {
  id: string;
  job_id: string;
  attempt_id: string | null;
  usage_class: string;
  meter: string;
  ledger_version: number;
  quantity: number;
  rate_version: string;
  reason: string | null;
  created_at: string;
}

export interface UsageEntriesFilter {
  jobId?: string;
  from?: string;
  to?: string;
  usageClass?: 'operational' | 'billable' | 'compensating';
  meter?: 'cpu_seconds' | 'reserved_vcpu_seconds' | 'billable_output_minutes' | 'storage_byte_hours' | 'egress_bytes';
}

export interface UsageSummaryResponse {
  from: string;
  to: string;
  operational_attempts: number;
  billable_output_minutes: number;
  estimated_cost: number;
  currency: string;
  operational_cpu_seconds: number;
  billable_jobs: number;
  preview_jobs: number;
  reservations: {
    pending_count: number;
    pending_vcpu_seconds: number;
    pending_output_seconds: number;
    settled_count: number;
    released_count: number;
  };
  canceled_units: {
    jobs_count: number;
    attempts_count: number;
    operational_cpu_seconds: number;
    released_output_seconds: number;
    billable_output_minutes: number;
  };
  failed_units: {
    jobs_count: number;
    attempts_count: number;
    operational_cpu_seconds: number;
    released_output_seconds: number;
    billable_output_minutes: number;
  };
  succeeded_units: {
    jobs_count: number;
    attempts_count: number;
    operational_cpu_seconds: number;
    settled_output_seconds: number;
    billable_output_minutes: number;
  };
  reconciliation: {
    clean: boolean;
    double_debit_detected: boolean;
    discrepancies: string[];
  };
}

export interface UsageReconciliationReport {
  clean: boolean;
  tenant_id: string;
  evaluated_at: string;
  summary: {
    succeeded_jobs_count: number;
    failed_jobs_count: number;
    canceled_jobs_count: number;
    non_terminal_jobs_count: number;
    settled_reservations_count: number;
    released_reservations_count: number;
    pending_reservations_count: number;
    total_billable_output_minutes: number;
    total_operational_cpu_seconds: number;
  };
  discrepancies: Array<{
    type: 'DOUBLE_DEBIT' | 'UNEXPECTED_BILLABLE_ENTRY' | 'MISSING_BILLABLE_ENTRY' | 'RESERVATION_STATE_MISMATCH';
    job_id: string;
    message: string;
  }>;
}

export interface CompensatingUsageEntryInput {
  jobId: string;
  meter: 'cpu_seconds' | 'reserved_vcpu_seconds' | 'billable_output_minutes' | 'storage_byte_hours' | 'egress_bytes';
  quantity: number;
  reason: string;
  rateVersion?: string;
  now?: Date;
}

export class TenantRepository {
  private readonly pool: TenantConnectionPool;
  private readonly pepper: string;
  private readonly quarantineStore?: QuarantineStore;
  private readonly revocationStore: StorageGrantRevocationStore;
  private readonly baseUrl: string;
  private readonly tenantImportAllowlists = new Map<string, string[]>();
  private readonly masterKey?: Buffer | string;

  constructor(
    pool: TenantConnectionPool,
    options: {
      pepper: string;
      quarantineStore?: QuarantineStore;
      revocationStore?: StorageGrantRevocationStore;
      baseUrl?: string;
      masterKey?: Buffer | string;
    },
  ) {
    this.pool = pool;
    this.pepper = options.pepper;
    this.quarantineStore = options.quarantineStore;
    this.revocationStore = options.revocationStore ?? defaultGrantRevocationStore;
    this.baseUrl = options.baseUrl ?? (process.env['CVE_PUBLIC_BASE_URL'] || 'http://127.0.0.1:8080/v1');
    this.masterKey = options.masterKey;
  }

  public getPool(): TenantConnectionPool {
    return this.pool;
  }

  public getPepper(): string {
    return this.pepper;
  }

  public getQuarantineStore(): QuarantineStore | undefined {
    return this.quarantineStore;
  }

  public getRevocationStore(): StorageGrantRevocationStore {
    return this.revocationStore;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getTenantImportAllowlist(tenantId: string): string[] {
    const specific = this.tenantImportAllowlists.get(tenantId);
    if (specific !== undefined) return specific;
    const globalDefault = this.tenantImportAllowlists.get('*');
    if (globalDefault !== undefined) return globalDefault;
    return [
      'https://approved-stock.example.invalid/assets/',
      'approved-stock.example.invalid',
      'cdn.partner-stock.com',
    ];
  }

  public setTenantImportAllowlist(tenantId: string, prefixes: string[]): void {
    this.tenantImportAllowlists.set(tenantId, prefixes);
  }

  // --------------------------------------------------------------------------
  // 1. Tenant & API Key Management
  // --------------------------------------------------------------------------

  public createTenant(input: {
    id: string;
    name: string;
    status?: 'active' | 'suspended' | 'deleted';
    now?: Date;
  }): { id: string; name: string; status: string; created_at: string } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const status = input.status ?? 'active';

    return this.pool.withTransaction(
      { tenantId: input.id, role: 'cve_migrator' },
      (tx) => {
        tx.insertScoped('tenants', {
          id: input.id,
          name: input.name,
          status,
          created_at: nowIso,
          updated_at: nowIso,
        });

        tx.insertScoped('policies', {
          tenant_id: input.id,
          policy_version: 'starter-v1',
          limits_json: JSON.stringify({
            active_job_slots_max: 2,
            pending_admission_slots_max: 20,
            non_terminal_jobs_total_max: 22,
            token_bucket_refill_per_second: 1,
            token_bucket_burst_capacity: 20,
          }),
          active: 1,
          created_at: nowIso,
        });

        return { id: input.id, name: input.name, status, created_at: nowIso };
      },
    );
  }

  public setTenantStatus(
    tenantId: string,
    status: 'active' | 'suspended' | 'deleted',
    now = new Date(),
  ): void {
    this.pool.withTransaction({ tenantId, role: 'cve_migrator' }, (tx) => {
      tx.updateScoped(
        'tenants',
        { status, updated_at: now.toISOString() },
        'id = ?',
        [tenantId],
      );
    });
  }

  public getTenantPolicyLimitsInTx(tx: TenantTransactionContext): TenantPolicyLimits {
    const rows = tx.selectScoped<{
      policy_version: string;
      limits_json: string;
      active: number;
    }>('policies', 'active = 1', [], 'created_at DESC');

    let parsed: Record<string, unknown> = {};
    if (rows[0]?.limits_json) {
      try {
        parsed = JSON.parse(rows[0].limits_json) as Record<string, unknown>;
      } catch {
        // fallback to defaults
      }
    }

    return {
      active_job_slots_max:
        typeof parsed['active_job_slots_max'] === 'number'
          ? parsed['active_job_slots_max']
          : DEFAULT_ACTIVE_JOB_SLOTS_MAX,
      pending_admission_slots_max:
        typeof parsed['pending_admission_slots_max'] === 'number'
          ? parsed['pending_admission_slots_max']
          : DEFAULT_PENDING_ADMISSION_SLOTS_MAX,
      non_terminal_jobs_total_max:
        typeof parsed['non_terminal_jobs_total_max'] === 'number'
          ? parsed['non_terminal_jobs_total_max']
          : DEFAULT_NON_TERMINAL_JOBS_TOTAL_MAX,
      token_bucket_refill_per_second:
        typeof parsed['token_bucket_refill_per_second'] === 'number'
          ? parsed['token_bucket_refill_per_second']
          : 1,
      token_bucket_burst_capacity:
        typeof parsed['token_bucket_burst_capacity'] === 'number'
          ? parsed['token_bucket_burst_capacity']
          : 20,
      api_key_token_bucket_refill_per_second:
        typeof parsed['api_key_token_bucket_refill_per_second'] === 'number'
          ? parsed['api_key_token_bucket_refill_per_second']
          : undefined,
      api_key_token_bucket_burst_capacity:
        typeof parsed['api_key_token_bucket_burst_capacity'] === 'number'
          ? parsed['api_key_token_bucket_burst_capacity']
          : undefined,
      max_assets_per_job:
        typeof parsed['max_assets_per_job'] === 'number'
          ? parsed['max_assets_per_job']
          : DEFAULT_MAX_ASSETS_PER_JOB,
      max_total_input_bytes_per_job:
        typeof parsed['max_total_input_bytes_per_job'] === 'number'
          ? parsed['max_total_input_bytes_per_job']
          : DEFAULT_MAX_TOTAL_INPUT_BYTES_PER_JOB,
      max_reserved_vcpu_seconds:
        typeof parsed['max_reserved_vcpu_seconds'] === 'number'
          ? parsed['max_reserved_vcpu_seconds']
          : undefined,
      max_reserved_output_seconds:
        typeof parsed['max_reserved_output_seconds'] === 'number'
          ? parsed['max_reserved_output_seconds']
          : undefined,
      custom_code_enabled:
        typeof parsed['custom_code_enabled'] === 'boolean'
          ? parsed['custom_code_enabled']
          : undefined,
      canvas_engine_enabled:
        typeof parsed['canvas_engine_enabled'] === 'boolean'
          ? parsed['canvas_engine_enabled']
          : undefined,
      svg_engine_enabled:
        typeof parsed['svg_engine_enabled'] === 'boolean'
          ? parsed['svg_engine_enabled']
          : undefined,
      rtl_enabled:
        typeof parsed['rtl_enabled'] === 'boolean' ? parsed['rtl_enabled'] : undefined,
    };
  }

  public getTenantPolicyLimits(tenantId: string): TenantPolicyLimits {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      return this.getTenantPolicyLimitsInTx(tx);
    });
  }

  public updateTenantPolicyLimits(
    tenantId: string,
    updates: Partial<TenantPolicyLimits>,
  ): TenantPolicyLimits {
    return this.pool.withTransaction({ tenantId, role: 'cve_migrator' }, (tx) => {
      const current = this.getTenantPolicyLimitsInTx(tx);
      const merged: TenantPolicyLimits = {
        ...current,
        ...updates,
      };
      tx.updateScoped(
        'policies',
        { limits_json: JSON.stringify(merged) },
        'active = 1',
        [],
      );
      return merged;
    });
  }

  public issueApiKey(input: {
    tenantId: string;
    keyId: string;
    name?: string;
    scopes: ApiScope[];
    environment?: 'live' | 'test';
    expiresAt?: string | null;
    rotatedFromKeyId?: string | null;
    now?: Date;
  }): IssuedApiKeyResult {
    const nowIso = (input.now ?? new Date()).toISOString();
    const material = generateApiKeyMaterial({
      environment: input.environment ?? 'live',
      pepper: this.pepper,
      pepperVersion: 'v1',
    });

    this.pool.withTransaction({ tenantId: input.tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('api_keys', {
        tenant_id: input.tenantId,
        id: input.keyId,
        key_prefix: material.keyPrefix,
        key_hash: material.keyHash,
        pepper_version: material.pepperVersion,
        name: input.name ?? 'default',
        scopes_json: JSON.stringify(input.scopes),
        rotated_from_key_id: input.rotatedFromKeyId ?? null,
        expires_at: input.expiresAt ?? null,
        revoked_at: null,
        last_used_at: null,
        created_at: nowIso,
      });
    });

    return {
      id: input.keyId,
      tenantId: input.tenantId,
      plaintextKey: material.plaintextKey,
      keyPrefix: material.keyPrefix,
      keyHash: material.keyHash,
      pepperVersion: material.pepperVersion,
      scopes: [...input.scopes],
      expiresAt: input.expiresAt ?? null,
      createdAt: nowIso,
    };
  }

  public rotateApiKey(input: {
    tenantId: string;
    oldKeyId: string;
    newKeyId: string;
    overlapSeconds?: number;
    now?: Date;
  }): IssuedApiKeyResult {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const overlapSeconds = input.overlapSeconds ?? 24 * 3600;
    const overlapExpiresIso = new Date(now.getTime() + overlapSeconds * 1000).toISOString();

    const material = generateApiKeyMaterial({
      environment: 'live',
      pepper: this.pepper,
      pepperVersion: 'v1',
    });

    return this.pool.withTransaction({ tenantId: input.tenantId, role: 'cve_api' }, (tx) => {
      const existingRows = tx.selectScoped<{
        id: string;
        name: string;
        scopes_json: string;
        revoked_at: string | null;
      }>('api_keys', 'id = ?', [input.oldKeyId]);

      const oldKey = existingRows[0];
      if (!oldKey || oldKey.revoked_at !== null) {
        throw new ResourceNotFoundError(`API key ${input.oldKeyId} not found`);
      }

      const scopes = JSON.parse(oldKey.scopes_json) as ApiScope[];

      // Update old key to expire after overlap window
      tx.updateScoped(
        'api_keys',
        { expires_at: overlapExpiresIso },
        'id = ?',
        [input.oldKeyId],
      );

      // Insert new rotated key referencing rotated_from_key_id via composite FK
      tx.insertScoped('api_keys', {
        tenant_id: input.tenantId,
        id: input.newKeyId,
        key_prefix: material.keyPrefix,
        key_hash: material.keyHash,
        pepper_version: material.pepperVersion,
        name: `${oldKey.name}-rotated`,
        scopes_json: JSON.stringify(scopes),
        rotated_from_key_id: input.oldKeyId,
        expires_at: null,
        revoked_at: null,
        last_used_at: null,
        created_at: nowIso,
      });

      return {
        id: input.newKeyId,
        tenantId: input.tenantId,
        plaintextKey: material.plaintextKey,
        keyPrefix: material.keyPrefix,
        keyHash: material.keyHash,
        pepperVersion: material.pepperVersion,
        scopes,
        expiresAt: null,
        createdAt: nowIso,
      };
    });
  }

  public revokeApiKey(tenantId: string, keyId: string, now = new Date()): void {
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const updated = tx.updateScoped(
        'api_keys',
        { revoked_at: now.toISOString() },
        'id = ?',
        [keyId],
      );
      if (updated === 0) {
        throw new ResourceNotFoundError(`API key ${keyId} not found`);
      }
    });
  }

  /**
   * Internal lookup by opaque `key_prefix` during authentication pre-stage,
   * before transaction-local `app.current_tenant_id` is established.
   */
  public lookupApiKeyByPrefix(keyPrefix: string): StoredApiKeyRecord | null {
    const db = this.pool.getDatabase();
    const row = db
      .prepare(
        `SELECT k.*, t.status AS tenant_status
         FROM api_keys k
         JOIN tenants t ON t.id = k.tenant_id
         WHERE k.key_prefix = ?`,
      )
      .get(keyPrefix) as
      | {
          tenant_id: string;
          id: string;
          key_prefix: string;
          key_hash: string;
          pepper_version: string;
          name: string;
          scopes_json: string;
          rotated_from_key_id: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          last_used_at: string | null;
          created_at: string;
          tenant_status: 'active' | 'suspended' | 'deleted';
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      tenant_id: row.tenant_id,
      id: row.id,
      key_prefix: row.key_prefix,
      key_hash: row.key_hash,
      pepper_version: row.pepper_version,
      name: row.name,
      scopes: JSON.parse(row.scopes_json) as ApiScope[],
      rotated_from_key_id: row.rotated_from_key_id,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
      tenant_status: row.tenant_status,
    };
  }

  // --------------------------------------------------------------------------
  // 2. Assets & Versions (with Cascade Revocation)
  // --------------------------------------------------------------------------

  public createAsset(
    tenantId: string,
    input: {
      id: string;
      filename: string;
      kind: 'image' | 'video' | 'audio' | 'font' | 'svg' | 'subtitle';
      status?: 'uploading' | 'processing' | 'ready' | 'rejected' | 'deleted';
      mimeType: string;
      bytes: number;
      sha256: string;
      rights: Record<string, unknown>;
      probeMetadata?: Record<string, unknown>;
      now?: Date;
    },
  ): {
    id: string;
    status: string;
    filename: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    created_at: string;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const status = input.status ?? 'ready';
    const storageKey = `tenant/${tenantId}/asset/${input.id}/1/${input.filename}`;

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('assets', {
        tenant_id: tenantId,
        id: input.id,
        filename: input.filename,
        kind: input.kind,
        status,
        current_version: 1,
        visibility: 'tenant_private',
        rights_json: JSON.stringify(input.rights),
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      });

      tx.insertScoped('asset_versions', {
        tenant_id: tenantId,
        asset_id: input.id,
        version: 1,
        original_sha256: input.sha256,
        normalized_sha256: input.sha256,
        mime_type: input.mimeType,
        bytes: input.bytes,
        probe_metadata: input.probeMetadata ? JSON.stringify(input.probeMetadata) : null,
        storage_key: storageKey,
        created_at: nowIso,
      });

      return {
        id: input.id,
        status,
        filename: input.filename,
        mime_type: input.mimeType,
        bytes: input.bytes,
        sha256: input.sha256,
        created_at: nowIso,
      };
    });
  }

  public createAssetUpload(
    tenantId: string,
    input: {
      id: string;
      filename: string;
      kind: 'image' | 'video' | 'audio' | 'font' | 'svg' | 'subtitle';
      mimeType: string;
      bytes: number;
      sha256: string;
      rights: Record<string, unknown>;
      now?: Date;
    },
  ): {
    id: string;
    status: 'uploading';
    filename: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    created_at: string;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const rightsEnvelope = {
      ...input.rights,
      _upload: {
        mime_type: input.mimeType,
        bytes: input.bytes,
        sha256: input.sha256,
      },
    };

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('assets', {
        tenant_id: tenantId,
        id: input.id,
        filename: input.filename,
        kind: input.kind,
        status: 'uploading',
        current_version: 1,
        visibility: 'tenant_private',
        rights_json: JSON.stringify(rightsEnvelope),
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      });

      return {
        id: input.id,
        status: 'uploading',
        filename: input.filename,
        mime_type: input.mimeType,
        bytes: input.bytes,
        sha256: input.sha256,
        created_at: nowIso,
      };
    });
  }

  public createAssetImport(
    tenantId: string,
    input: {
      id: string;
      filename: string;
      kind: 'image' | 'video' | 'audio' | 'font' | 'svg' | 'subtitle';
      status?: 'uploading' | 'processing' | 'ready' | 'rejected' | 'deleted';
      mimeType: string;
      expectedSha256: string;
      rights: Record<string, unknown>;
      now?: Date;
    },
  ): {
    id: string;
    status: string;
    filename: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    created_at: string;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const status = input.status ?? 'processing';
    const rightsEnvelope = {
      ...input.rights,
      _upload: {
        mime_type: input.mimeType,
        bytes: 0,
        sha256: input.expectedSha256,
      },
      _import: {
        expected_sha256: input.expectedSha256,
        mime_type: input.mimeType,
      },
    };

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('assets', {
        tenant_id: tenantId,
        id: input.id,
        filename: input.filename,
        kind: input.kind,
        status,
        current_version: 1,
        visibility: 'tenant_private',
        rights_json: JSON.stringify(rightsEnvelope),
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
      });

      return {
        id: input.id,
        status,
        filename: input.filename,
        mime_type: input.mimeType,
        bytes: 0,
        sha256: input.expectedSha256,
        created_at: nowIso,
      };
    });
  }

  public getAsset(
    tenantId: string,
    assetId: string,
  ): {
    id: string;
    status: string;
    filename: string;
    kind: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    metadata?: Record<string, unknown>;
    created_at: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const assets = tx.selectScoped<{
        tenant_id: string;
        id: string;
        filename: string;
        kind: string;
        status: string;
        current_version: number;
        rights_json: string;
        created_at: string;
        deleted_at: string | null;
      }>('assets', 'id = ?', [assetId]);

      const asset = assets[0];
      if (!asset) {
        throw new ResourceNotFoundError(`Asset ${assetId} not found`);
      }

      const versions = tx.selectScoped<{
        original_sha256: string;
        mime_type: string;
        bytes: number;
        probe_metadata: string | null;
      }>(
        'asset_versions',
        'tenant_id = ? AND asset_id = ? AND version = ?',
        [asset.tenant_id, asset.id, asset.current_version],
      );
      const ver = versions[0];

      let mimeType = 'application/octet-stream';
      let bytes = 0;
      let sha256 = '';
      let metadata: Record<string, unknown> | undefined;

      if (ver) {
        mimeType = ver.mime_type;
        bytes = ver.bytes;
        sha256 = ver.original_sha256;
        if (ver.probe_metadata) {
          try {
            metadata = JSON.parse(ver.probe_metadata);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          const parsedRights = JSON.parse(asset.rights_json) as {
            _upload?: { mime_type?: string; bytes?: number; sha256?: string };
            _probe_metadata?: Record<string, unknown>;
          };
          if (parsedRights._upload) {
            mimeType = parsedRights._upload.mime_type ?? mimeType;
            bytes = parsedRights._upload.bytes ?? bytes;
            sha256 = parsedRights._upload.sha256 ?? sha256;
          }
          if (parsedRights._probe_metadata) {
            metadata = parsedRights._probe_metadata;
          }
        } catch {
          // ignore
        }
      }

      return {
        id: asset.id,
        status: asset.status,
        filename: asset.filename,
        kind: asset.kind,
        mime_type: mimeType,
        bytes,
        sha256,
        metadata,
        created_at: asset.created_at,
        deleted_at: asset.deleted_at ?? undefined,
        tombstone: asset.status === 'deleted' ? true : undefined,
      };
    });
  }

  public getAssetTombstone(
    tenantId: string,
    assetId: string,
  ): {
    id: string;
    tenant_id: string;
    filename: string;
    kind: string;
    status: 'deleted';
    deleted_at: string;
    created_at: string;
    sha256?: string;
    bytes?: number;
    tombstone: true;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const assets = tx.selectScoped<{
        tenant_id: string;
        id: string;
        filename: string;
        kind: string;
        status: string;
        created_at: string;
        deleted_at: string | null;
      }>('assets', 'id = ?', [assetId]);

      const asset = assets[0];
      if (!asset || asset.status !== 'deleted') {
        throw new ResourceNotFoundError(`Asset tombstone for ${assetId} not found`);
      }

      const versions = tx.selectScoped<{
        original_sha256: string;
        bytes: number;
      }>('asset_versions', 'asset_id = ? ORDER BY version DESC LIMIT 1', [assetId]);

      return {
        id: asset.id,
        tenant_id: asset.tenant_id,
        filename: asset.filename,
        kind: asset.kind,
        status: 'deleted',
        deleted_at: asset.deleted_at ?? asset.created_at,
        created_at: asset.created_at,
        sha256: versions[0]?.original_sha256,
        bytes: versions[0]?.bytes,
        tombstone: true,
      };
    });
  }

  public getAssetDownloadGrant(
    tenantId: string,
    assetId: string,
    options: { now?: Date; ttlSeconds?: number; baseUrl?: string } = {},
  ): {
    url: string;
    expires_at: string;
    sha256: string;
    bytes: number;
  } {
    const now = options.now ?? new Date();
    const effectiveBaseUrl = options.baseUrl ?? this.baseUrl;
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        tenant_id: string;
        id: string;
        filename: string;
        kind: string;
        status: string;
        current_version: number;
        created_at: string;
        deleted_at: string | null;
      }>('assets', 'id = ?', [assetId]);

      const asset = rows[0];
      if (!asset || asset.status === 'deleted' || asset.deleted_at !== null) {
        throw new ResourceNotFoundError(`Asset ${assetId} not found`);
      }

      if (asset.status !== 'ready') {
        throw new RevisionConflictError(
          `Asset ${assetId} is not ready for download (current status: ${asset.status})`,
        );
      }

      // Check retention (default 7 days)
      const retentionDays = Number(process.env['CVE_ASSET_RETENTION_DAYS'] || 7);
      const ageMs = now.getTime() - new Date(asset.created_at).getTime();
      if (ageMs > retentionDays * 24 * 60 * 60 * 1000) {
        throw new ResourceNotFoundError(`Asset ${assetId} has expired`);
      }

      const versions = tx.selectScoped<{
        version: number;
        original_sha256: string;
        bytes: number;
        mime_type: string;
        storage_key: string;
      }>('asset_versions', 'asset_id = ? AND version = ?', [assetId, asset.current_version]);

      const ver = versions[0];
      if (!ver) {
        throw new ResourceNotFoundError(`Asset version ${asset.current_version} not found`);
      }

      const grant = generateSignedDownloadGrant(
        {
          tenantId,
          assetId: asset.id,
          version: ver.version,
          filename: asset.filename,
          mimeType: ver.mime_type,
          sha256: ver.original_sha256,
          bytes: ver.bytes,
          ttlSeconds: options.ttlSeconds,
        },
        {
          pepper: this.pepper,
          baseUrl: effectiveBaseUrl,
          now,
        },
      );

      return {
        url: grant.downloadUrl,
        expires_at: grant.expiresAt,
        sha256: grant.sha256,
        bytes: grant.bytes,
      };
    });
  }

  public updateAssetStatus(
    tenantId: string,
    assetId: string,
    input: {
      status: 'uploading' | 'processing' | 'ready' | 'rejected' | 'deleted';
      probeMetadata?: Record<string, unknown>;
      normalizedSha256?: string;
      bytes?: number;
      mimeType?: string;
      now?: Date;
    },
  ): {
    id: string;
    status: string;
    filename: string;
    kind: string;
    mime_type: string;
    bytes: number;
    sha256: string;
    metadata?: Record<string, unknown>;
    created_at: string;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const existing = tx.selectScoped<{
        tenant_id: string;
        id: string;
        filename: string;
        kind: string;
        status: string;
        current_version: number;
        rights_json: string;
        created_at: string;
      }>('assets', 'id = ?', [assetId])[0];

      if (!existing) {
        throw new ResourceNotFoundError(`Asset ${assetId} not found`);
      }

      let updatedRights = existing.rights_json;
      let uploadInfo: { mime_type?: string; bytes?: number; sha256?: string } = {};
      try {
        const parsed = JSON.parse(existing.rights_json);
        if (parsed._upload) uploadInfo = parsed._upload;
        if (input.probeMetadata) {
          parsed._probe_metadata = input.probeMetadata;
          updatedRights = JSON.stringify(parsed);
        }
      } catch {
        // ignore
      }

      tx.updateScoped(
        'assets',
        {
          status: input.status,
          rights_json: updatedRights,
          updated_at: nowIso,
          deleted_at: input.status === 'deleted' ? nowIso : null,
        },
        'id = ?',
        [assetId],
      );

      const ver = tx.selectScoped<{
        original_sha256: string;
        mime_type: string;
        bytes: number;
        storage_key: string;
      }>(
        'asset_versions',
        'tenant_id = ? AND asset_id = ? AND version = ?',
        [existing.tenant_id, existing.id, existing.current_version],
      )[0];

      const mimeType = input.mimeType ?? ver?.mime_type ?? uploadInfo.mime_type ?? 'application/octet-stream';
      const candidateBytes = input.bytes ?? ver?.bytes ?? uploadInfo.bytes;
      const finalBytes = typeof candidateBytes === 'number' && candidateBytes > 0 ? candidateBytes : 1;
      const sha256 = input.normalizedSha256 ?? ver?.original_sha256 ?? uploadInfo.sha256 ?? '';
      const storageKey = `tenant/${tenantId}/asset/${existing.id}/${existing.current_version}/${existing.filename}`;

      // Insert immutable version row on ready if not yet inserted
      if (!ver && input.status === 'ready') {
        tx.insertScoped('asset_versions', {
          tenant_id: tenantId,
          asset_id: existing.id,
          version: existing.current_version,
          original_sha256: sha256 || '0'.repeat(64),
          normalized_sha256: input.normalizedSha256 ?? (sha256 || '0'.repeat(64)),
          mime_type: mimeType,
          bytes: finalBytes,
          probe_metadata: input.probeMetadata ? JSON.stringify(input.probeMetadata) : null,
          storage_key: storageKey,
          created_at: nowIso,
        });
      }

      return {
        id: existing.id,
        status: input.status,
        filename: existing.filename,
        kind: existing.kind,
        mime_type: mimeType,
        bytes: finalBytes,
        sha256,
        metadata: input.probeMetadata,
        created_at: existing.created_at,
      };
    });
  }

  public deleteAsset(
    tenantId: string,
    assetId: string,
    now = new Date(),
  ): { id: string; status: 'deleted'; revokedJobs: string[] } {
    const nowIso = now.toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      // Only tenant-owned assets can be deleted (system_catalog assets return 0 / throw 404)
      const existing = tx
        .selectScoped<{ tenant_id: string; id: string; status: string }>('assets', 'id = ?', [
          assetId,
        ])
        .find((a) => a.tenant_id === tenantId);

      if (!existing) {
        throw new ResourceNotFoundError(`Asset ${assetId} not found`);
      }

      // Repeated DELETE on already deleted asset is idempotent per docs/API.md
      if (existing.status === 'deleted') {
        return { id: assetId, status: 'deleted', revokedJobs: [] };
      }

      tx.updateScoped(
        'assets',
        { status: 'deleted', deleted_at: nowIso, updated_at: nowIso },
        'id = ?',
        [assetId],
      );

      // Invalidate all active upload & download grants for this asset immediately
      this.revocationStore.revokeAssetGrants(tenantId, assetId, now.getTime());

      // Purge storage files from quarantine and permanent locations
      if (this.quarantineStore) {
        this.quarantineStore.removeAsset(tenantId, assetId);
      }

      // Cascade ASSET_REVOKED to any non-terminal jobs of this tenant referencing assetId.
      // Per docs/ARCHITECTURE.md:86 & AMB-003, `cancel_requested` only transitions to `canceled`,
      // so exclude `cancel_requested` from ASSET_REVOKED overwrite.
      const nonTerminalJobs = tx.selectScoped<{
        id: string;
        state: string;
        state_version: number;
        lease_epoch: number;
        active_attempt_id: string | null;
        snapshot_json: string;
      }>(
        'jobs',
        "state NOT IN ('succeeded', 'failed', 'canceled', 'cancel_requested')",
        [],
      );

      const revokedJobs: string[] = [];
      for (const job of nonTerminalJobs) {
        if (job.snapshot_json.includes(`"${assetId}"`)) {
          const nextStateVersion = job.state_version + 1;
          const nextEpoch = Number(job.lease_epoch) + 1;
          const previousAttemptId = job.active_attempt_id;

          if (previousAttemptId && this.quarantineStore) {
            this.quarantineStore.cleanupAttemptTempDir(tenantId, job.id, previousAttemptId);
          }

          tx.updateScoped(
            'jobs',
            {
              state: 'failed',
              stage: 'failed',
              state_version: nextStateVersion,
              lease_epoch: nextEpoch,
              active_attempt_id: null,
              lease_expires_at: null,
              error_json: JSON.stringify({
                code: 'ASSET_REVOKED',
                message: `Input asset ${assetId} was deleted by tenant`,
                retryable: false,
              }),
              completed_at: nowIso,
              updated_at: nowIso,
            },
            'id = ?',
            [job.id],
          );
          tx.updateScoped(
            'usage_reservations',
            { state: 'released', settled_at: nowIso },
            "job_id = ? AND state = 'reserved'",
            [job.id],
          );
          const existingEvents = tx.selectScoped<{ event_seq: number }>(
            'job_events',
            'job_id = ?',
            [job.id],
            'event_seq DESC',
          );
          const nextEventSeq = (existingEvents[0]?.event_seq ?? 0) + 1;
          tx.insertScoped('job_events', {
            tenant_id: tenantId,
            job_id: job.id,
            event_seq: nextEventSeq,
            state: 'failed',
            state_version: nextStateVersion,
            event_type: 'job.failed',
            payload_json: JSON.stringify({
              stage: 'failed',
              progress_percent: 0,
              error_code: 'ASSET_REVOKED',
              message: `Input asset ${assetId} was deleted by tenant`,
            }),
            created_at: nowIso,
          });
          tx.insertScoped('outbox', {
            tenant_id: tenantId,
            id: `out_${crypto.randomBytes(6).toString('hex')}`,
            event_type: 'job.failed',
            job_id: job.id,
            state_version: nextStateVersion,
            payload_json: JSON.stringify({
              job_id: job.id,
              state: 'failed',
              state_version: nextStateVersion,
              error: {
                code: 'ASSET_REVOKED',
                message: `Input asset ${assetId} was deleted by tenant`,
                retryable: false,
              },
            }),
            created_at: nowIso,
            processed_at: null,
          });
          revokedJobs.push(job.id);
        }
      }

      return { id: assetId, status: 'deleted', revokedJobs };
    });
  }

  // --------------------------------------------------------------------------
  // 3. Templates & Revisions (Curated Public Catalog + Tenant Forking)
  // --------------------------------------------------------------------------

  public listTemplates(
    tenantId: string,
    options: { limit?: number; cursor?: string } = {},
  ): {
    data: Array<{
      id: string;
      revision: number;
      name: string;
      visibility: 'curated' | 'tenant';
      created_at: string;
    }>;
    next_cursor: string | null;
  } {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    let decodedCursor: { createdAt: string; id: string } | null = null;
    if (options.cursor) {
      decodedCursor = decodeSignedCursor({
        cursor: options.cursor,
        tenantId,
        route: '/v1/templates',
        secret: this.pepper,
      });
      if (!decodedCursor) {
        throw new InvalidCursorError();
      }
    }

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const allVisible = tx.selectScoped<{
        tenant_id: string;
        id: string;
        name: string;
        current_revision: number;
        visibility: string;
        created_at: string;
      }>('templates', '1=1', [], 'created_at DESC, id DESC');

      const filtered = decodedCursor
        ? allVisible.filter(
            (r) =>
              r.created_at < decodedCursor.createdAt ||
              (r.created_at === decodedCursor.createdAt && r.id < decodedCursor.id),
          )
        : allVisible;

      const slice = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const lastItem = slice[slice.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeSignedCursor({
              tenantId,
              route: '/v1/templates',
              createdAt: lastItem.created_at,
              id: lastItem.id,
              secret: this.pepper,
            })
          : null;

      return {
        data: slice.map((r) => ({
          id: r.id,
          revision: r.current_revision,
          name: r.name,
          visibility: r.visibility === 'curated_public' ? 'curated' : 'tenant',
          created_at: r.created_at,
        })),
        next_cursor: nextCursor,
      };
    });
  }

  public getTemplateRevision(
    tenantId: string,
    templateId: string,
    revision: number,
  ): {
    id: string;
    revision: number;
    name: string;
    variables_schema: Record<string, unknown>;
    defaults: Record<string, unknown>;
    composition_spec: Record<string, unknown>;
    supported_locales: string[];
    required_capabilities: string[];
    source_digest: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        tenant_id: string;
        template_id: string;
        revision: number;
        name: string;
        variables_schema: string;
        defaults_json: string;
        composition_spec: string;
        supported_locales_json: string;
        required_capabilities_json: string;
        source_digest: string;
      }>(
        'template_revisions',
        'template_id = ? AND revision = ?',
        [templateId, revision],
      );

      // Prefer tenant-owned if shadowed, otherwise curated_public
      const match =
        rows.find((r) => r.tenant_id === tenantId) ??
        rows.find((r) => r.tenant_id === SYSTEM_CATALOG_TENANT_ID);

      if (!match) {
        throw new ResourceNotFoundError(
          `Template ${templateId} revision ${revision} not found`,
        );
      }

      return {
        id: match.template_id,
        revision: match.revision,
        name: match.name,
        variables_schema: JSON.parse(match.variables_schema) as Record<string, unknown>,
        defaults: JSON.parse(match.defaults_json) as Record<string, unknown>,
        composition_spec: JSON.parse(match.composition_spec) as Record<string, unknown>,
        supported_locales: JSON.parse(match.supported_locales_json) as string[],
        required_capabilities: JSON.parse(match.required_capabilities_json) as string[],
        source_digest: match.source_digest,
      };
    });
  }

  private validateTemplatePayloadInTx(
    tx: TenantTransactionContext,
    input: {
      name: string;
      variables_schema: Record<string, unknown>;
      defaults: Record<string, unknown>;
      composition_spec: Record<string, unknown>;
      supported_locales: string[];
    },
  ): void {
    const details: ErrorDetail[] = [];

    if (
      !input.name ||
      typeof input.name !== 'string' ||
      input.name.trim().length === 0 ||
      input.name.length > 200
    ) {
      details.push({
        pointer: '/name',
        code: 'OUT_OF_RANGE',
        message: 'Template name must be between 1 and 200 characters',
      });
    }

    if (!Array.isArray(input.supported_locales) || input.supported_locales.length === 0) {
      details.push({
        pointer: '/supported_locales',
        code: 'OUT_OF_RANGE',
        message: 'Template supported_locales must be an array of at least 1 locale',
      });
    } else {
      const allowedLocales = new Set(['vi-VN', 'en-US']);
      for (let i = 0; i < input.supported_locales.length; i++) {
        const loc = input.supported_locales[i]!;
        if (!allowedLocales.has(loc)) {
          details.push({
            pointer: `/supported_locales/${i}`,
            code: 'ENUM_MISMATCH',
            message: `Locale '${loc}' is not supported (allowed: vi-VN, en-US)`,
          });
        }
      }
    }

    // 1. Validate variable schema
    details.push(...validateVariableSchema(input.variables_schema, '/variables_schema'));

    // 2. Validate defaults against schema
    details.push(...validateDefaultsAgainstSchema(input.variables_schema, input.defaults, '/defaults'));

    // 3. Inspect bindings
    const properties =
      (input.variables_schema['properties'] as Record<string, unknown> | undefined) ?? {};
    const declaredVars = new Set(Object.keys(properties));
    const { errors: bindingErrors } = inspectAndValidateBindings(
      input.composition_spec,
      declaredVars,
      '/composition_spec',
    );
    details.push(...bindingErrors);

    if (details.length > 0) {
      throw new BodyReferenceValidationError(details);
    }

    // 4. Materialize defaults into composition_spec and validate as pure Scene Spec 1.0
    const defaultLocale = input.supported_locales[0] ?? 'vi-VN';
    const materialized = materializeCompositionFromTemplate(
      input.composition_spec,
      input.defaults,
      defaultLocale,
    );

    const unified = validateCompositionUnified(materialized, {
      profile: 'mp4-720p-v1',
    });
    if (!unified.valid) {
      details.push(
        ...unified.all_errors.map((e) => ({
          pointer: `/composition_spec${e.pointer === '/' ? '' : e.pointer}`,
          code: e.code,
          message: e.message,
        })),
      );
    }

    const refErrors = this.validateCompositionReferencesInTx(tx, materialized, '/composition_spec');
    details.push(...refErrors);

    if (details.length > 0) {
      throw new BodyReferenceValidationError(details);
    }
  }

  public createTemplate(
    tenantId: string,
    input: {
      id: string;
      name: string;
      variables_schema: Record<string, unknown>;
      defaults: Record<string, unknown>;
      composition_spec: Record<string, unknown>;
      supported_locales: string[];
      source_template?: { id: string; revision: number };
      now?: Date;
    },
  ): { id: string; revision: 1; source_digest: string } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const sourceDigest = computeSha256Hex(
      JSON.stringify({
        variables_schema: input.variables_schema,
        defaults: input.defaults,
        composition_spec: input.composition_spec,
      }),
    );

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      this.validateTemplatePayloadInTx(tx, input);

      let sourceTenantId: string | null = null;
      let sourceTemplateId: string | null = null;
      let sourceRevision: number | null = null;

      if (input.source_template) {
        const srcRows = tx.selectScoped<{ tenant_id: string; template_id: string; revision: number }>(
          'template_revisions',
          'template_id = ? AND revision = ?',
          [input.source_template.id, input.source_template.revision],
        );
        const src =
          srcRows.find((r) => r.tenant_id === tenantId) ??
          srcRows.find((r) => r.tenant_id === SYSTEM_CATALOG_TENANT_ID);
        if (!src) {
          throw new ResourceNotFoundError(
            `Source template ${input.source_template.id}@${input.source_template.revision} not found`,
          );
        }
        sourceTenantId = src.tenant_id;
        sourceTemplateId = src.template_id;
        sourceRevision = src.revision;
      }

      tx.insertScoped('templates', {
        tenant_id: tenantId,
        id: input.id,
        name: input.name,
        current_revision: 1,
        visibility: 'tenant_private',
        source_template_tenant_id: sourceTenantId,
        source_template_id: sourceTemplateId,
        source_template_revision: sourceRevision,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('template_revisions', {
        tenant_id: tenantId,
        template_id: input.id,
        revision: 1,
        name: input.name,
        variables_schema: JSON.stringify(input.variables_schema),
        defaults_json: JSON.stringify(input.defaults),
        composition_spec: JSON.stringify(input.composition_spec),
        supported_locales_json: JSON.stringify(input.supported_locales),
        required_capabilities_json: JSON.stringify(['html-v1']),
        source_digest: sourceDigest,
        change_note: 'Initial revision',
        created_at: nowIso,
      });

      return { id: input.id, revision: 1, source_digest: sourceDigest };
    });
  }

  public createTemplateRevision(
    tenantId: string,
    templateId: string,
    input: {
      base_revision: number;
      change_note?: string;
      name: string;
      variables_schema: Record<string, unknown>;
      defaults: Record<string, unknown>;
      composition_spec: Record<string, unknown>;
      supported_locales: string[];
      now?: Date;
    },
  ): { id: string; revision: number; source_digest: string } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const sourceDigest = computeSha256Hex(
      JSON.stringify({
        variables_schema: input.variables_schema,
        defaults: input.defaults,
        composition_spec: input.composition_spec,
      }),
    );

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      // Must belong to current tenant (cannot add revisions to curated_public system_catalog templates)
      const templates = tx
        .selectScoped<{ tenant_id: string; id: string; current_revision: number }>(
          'templates',
          'id = ?',
          [templateId],
        )
        .filter((t) => t.tenant_id === tenantId);

      const tpl = templates[0];
      if (!tpl) {
        throw new ResourceNotFoundError(`Template ${templateId} not found`);
      }

      if (tpl.current_revision !== input.base_revision) {
        throw new RevisionConflictError(
          `Expected base_revision ${tpl.current_revision}, received ${input.base_revision}`,
        );
      }

      this.validateTemplatePayloadInTx(tx, input);

      const nextRevision = tpl.current_revision + 1;
      tx.updateScoped(
        'templates',
        { name: input.name, current_revision: nextRevision, updated_at: nowIso },
        'id = ?',
        [templateId],
      );

      tx.insertScoped('template_revisions', {
        tenant_id: tenantId,
        template_id: templateId,
        revision: nextRevision,
        name: input.name,
        variables_schema: JSON.stringify(input.variables_schema),
        defaults_json: JSON.stringify(input.defaults),
        composition_spec: JSON.stringify(input.composition_spec),
        supported_locales_json: JSON.stringify(input.supported_locales),
        required_capabilities_json: JSON.stringify(['html-v1']),
        source_digest: sourceDigest,
        change_note: input.change_note ?? null,
        created_at: nowIso,
      });

      return { id: templateId, revision: nextRevision, source_digest: sourceDigest };
    });
  }

  public forkTemplate(
    tenantId: string,
    sourceTemplateId: string,
    input: {
      source_revision?: number;
      name?: string;
      new_id?: string;
      now?: Date;
    } = {},
  ): { id: string; revision: 1; source_digest: string } {
    let revNum = input.source_revision;
    if (!revNum) {
      // Find source template to get its current revision
      const list = this.listTemplates(tenantId, { limit: 100 });
      const found = list.data.find((t) => t.id === sourceTemplateId);
      if (!found) {
        throw new ResourceNotFoundError(`Source template ${sourceTemplateId} not found`);
      }
      revNum = found.revision;
    }

    const srcRev = this.getTemplateRevision(tenantId, sourceTemplateId, revNum);
    const newId = input.new_id ?? `tpl_${crypto.randomBytes(6).toString('hex')}`;
    const newName = input.name ?? `Fork of ${srcRev.name}`;

    return this.createTemplate(tenantId, {
      id: newId,
      name: newName,
      variables_schema: srcRev.variables_schema,
      defaults: srcRev.defaults,
      composition_spec: srcRev.composition_spec,
      supported_locales: srcRev.supported_locales,
      source_template: {
        id: sourceTemplateId,
        revision: revNum,
      },
      now: input.now,
    });
  }

  public instantiateTemplate(
    tenantId: string,
    templateId: string,
    input: {
      template_revision: number;
      name: string;
      variables: Record<string, unknown>;
      locale: string;
      now?: Date;
    },
  ): {
    id: string;
    revision: 1;
    template: { id: string; revision: number };
    schema_version: '1.0';
    editable: boolean;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();

    if (
      !input.name ||
      typeof input.name !== 'string' ||
      input.name.trim().length === 0 ||
      input.name.length > 200
    ) {
      throw new BodyReferenceValidationError([
        {
          pointer: '/name',
          code: 'OUT_OF_RANGE',
          message: 'Composition name must be between 1 and 200 characters',
        },
      ]);
    }

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        tenant_id: string;
        template_id: string;
        revision: number;
        name: string;
        variables_schema: string;
        defaults_json: string;
        composition_spec: string;
        supported_locales_json: string;
      }>(
        'template_revisions',
        'template_id = ? AND revision = ?',
        [templateId, input.template_revision],
      );

      const tpl =
        rows.find((r) => r.tenant_id === tenantId) ??
        rows.find((r) => r.tenant_id === SYSTEM_CATALOG_TENANT_ID);

      if (!tpl) {
        throw new ResourceNotFoundError(
          `Template ${templateId} revision ${input.template_revision} not found`,
        );
      }

      const supportedLocales = JSON.parse(tpl.supported_locales_json) as string[];
      if (!supportedLocales.includes(input.locale)) {
        throw new BodyReferenceValidationError([
          {
            pointer: '/locale',
            code: 'UNSUPPORTED_LOCALE',
            message: `Locale '${input.locale}' is not supported by template '${templateId}' (supported: ${supportedLocales.join(', ')})`,
          },
        ]);
      }

      const schemaObj = JSON.parse(tpl.variables_schema) as Record<string, unknown>;
      const defaultsObj = JSON.parse(tpl.defaults_json) as Record<string, unknown>;
      const rawSpec = JSON.parse(tpl.composition_spec) as Record<string, unknown>;

      const varRes = resolveAndValidateVariables(schemaObj, defaultsObj, input.variables);
      if (varRes.errors.length > 0) {
        throw new BodyReferenceValidationError(varRes.errors);
      }

      const declaredVars = new Set(
        Object.keys((schemaObj['properties'] as Record<string, unknown>) ?? {}),
      );
      const { bindings } = inspectAndValidateBindings(rawSpec, declaredVars, '/composition_spec');

      const materializedSpec = materializeCompositionFromTemplate(
        rawSpec,
        varRes.resolved,
        input.locale,
      );

      // Validate bound asset_id variables specifically for existence, readiness, and kind
      const assetBindingErrors: ErrorDetail[] = [];
      for (const b of bindings) {
        if (b.field === 'content.asset_id') {
          const resolvedAssetId = varRes.resolved[b.variableName];
          if (typeof resolvedAssetId === 'string') {
            const visibleAssets = tx.selectScoped<{
              id: string;
              kind: string;
              status: string;
            }>('assets', 'id = ?', [resolvedAssetId]);
            const targetAsset = visibleAssets[0];
            if (!targetAsset) {
              assetBindingErrors.push({
                pointer: `/variables/${b.variableName}`,
                code: 'ASSET_NOT_FOUND',
                message: `Asset '${resolvedAssetId}' was not found or is unauthorized`,
              });
            } else if (targetAsset.status !== 'ready') {
              assetBindingErrors.push({
                pointer: `/variables/${b.variableName}`,
                code: 'ASSET_NOT_READY',
                message: `Asset '${resolvedAssetId}' status is '${targetAsset.status}' (expected 'ready')`,
              });
            } else {
              const scene = materializedSpec.scenes[b.sceneIndex];
              const layer =
                scene && 'layers' in scene && Array.isArray(scene.layers)
                  ? scene.layers[b.layerIndex]
                  : null;
              if (layer && layer.type !== targetAsset.kind) {
                assetBindingErrors.push({
                  pointer: `/variables/${b.variableName}`,
                  code: 'INVALID_ASSET_TYPE',
                  message: `Asset '${resolvedAssetId}' of kind '${targetAsset.kind}' cannot be used in layer type '${layer.type}'`,
                });
              }
            }
          }
        }
      }
      if (assetBindingErrors.length > 0) {
        throw new BodyReferenceValidationError(assetBindingErrors);
      }

      const unified = validateCompositionUnified(materializedSpec, { profile: 'mp4-720p-v1' });
      if (!unified.valid) {
        throw new BodyReferenceValidationError(
          unified.all_errors.map((e) => ({
            pointer: `/spec${e.pointer === '/' ? '' : e.pointer}`,
            code: e.code,
            message: e.message,
          })),
        );
      }

      const refErrors = this.validateCompositionReferencesInTx(tx, materializedSpec, '/spec');
      if (refErrors.length > 0) {
        throw new BodyReferenceValidationError(refErrors);
      }

      const compId = `cmp_${crypto.randomBytes(6).toString('hex')}`;
      const manifest = compileComposition(materializedSpec, { profile: 'mp4-720p-v1' });
      const renderHash = manifest.render_hash;

      tx.insertScoped('compositions', {
        tenant_id: tenantId,
        id: compId,
        name: input.name,
        current_revision: 1,
        template_tenant_id: tpl.tenant_id,
        template_id: tpl.template_id,
        template_revision: tpl.revision,
        editable: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('composition_revisions', {
        tenant_id: tenantId,
        composition_id: compId,
        revision: 1,
        schema_version: '1.0',
        spec_json: JSON.stringify(materializedSpec),
        render_hash: renderHash,
        change_note: `Instantiated from template ${tpl.template_id}@${tpl.revision}`,
        created_at: nowIso,
      });

      return {
        id: compId,
        revision: 1,
        template: {
          id: tpl.template_id,
          revision: tpl.revision,
        },
        schema_version: '1.0',
        editable: true,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 4. Compositions & Body Reference Validation (AMB-007: 422 ASSET_NOT_FOUND / UNKNOWN_FONT)
  // --------------------------------------------------------------------------

  /**
   * Validates all `asset_id` and `font_id` references inside a composition JSON body
   * under the current tenant's RLS scope.
   * Per AMB-007 (docs/API.md line 170), nonexistent or foreign-tenant `asset_id` or `font_id`
   * inside a JSON body returns HTTP 422 VALIDATION_FAILED with detail code
   * `ASSET_NOT_FOUND` or `UNKNOWN_FONT` (never leaking whether the asset exists in another tenant).
   */
  public validateCompositionReferencesInTx(
    tx: TenantTransactionContext,
    spec: CompositionSpec,
    pointerPrefix = '/spec',
  ): ErrorDetail[] {
    const details: ErrorDetail[] = [];
    const declaredFontIds = new Set<string>();

    // 1. Validate fonts[].asset_id
    for (let i = 0; i < (spec.fonts ?? []).length; i++) {
      const font = spec.fonts[i]!;
      declaredFontIds.add(font.id);
      const visibleAssets = tx.selectScoped<{
        id: string;
        kind: string;
        status: string;
      }>('assets', 'id = ?', [font.asset_id]);

      const readyFont = visibleAssets.find((a) => a.status === 'ready' && a.kind === 'font');
      if (!readyFont) {
        const deletedFont = visibleAssets.find((a) => a.status === 'deleted');
        if (deletedFont) {
          details.push({
            pointer: `${pointerPrefix}/fonts/${i}/asset_id`,
            code: 'ASSET_REVOKED',
            message: `Font asset '${font.asset_id}' was revoked/deleted`,
          });
        } else {
          details.push({
            pointer: `${pointerPrefix}/fonts/${i}/asset_id`,
            code: 'ASSET_NOT_FOUND',
            message: `Font asset '${font.asset_id}' was not found or is not ready`,
          });
        }
      }
    }

    // 2. Validate scenes[].layers[] font_id and asset_id references
    for (let sIdx = 0; sIdx < (spec.scenes ?? []).length; sIdx++) {
      const scene = spec.scenes[sIdx]!;
      const layers = 'layers' in scene && Array.isArray(scene.layers) ? scene.layers : [];
      for (let lIdx = 0; lIdx < layers.length; lIdx++) {
        const layer = layers[lIdx]!;
        const content = layer.content as unknown as Record<string, unknown>;
        if (layer.type === 'text') {
          const fontId = String(content['font_id'] ?? '');
          if (!declaredFontIds.has(fontId)) {
            details.push({
              pointer: `${pointerPrefix}/scenes/${sIdx}/layers/${lIdx}/content/font_id`,
              code: 'UNKNOWN_FONT',
              message: `Referenced font_id '${fontId}' is not declared in composition fonts`,
            });
          }
        } else if (layer.type === 'image' || layer.type === 'video' || layer.type === 'svg') {
          const assetId = String(content['asset_id'] ?? '');
          const visibleAssets = tx.selectScoped<{
            id: string;
            kind: string;
            status: string;
          }>('assets', 'id = ?', [assetId]);
          const readyAsset = visibleAssets.find(
            (a) => a.status === 'ready' && a.kind === layer.type,
          );
          if (!readyAsset) {
            const deletedAsset = visibleAssets.find((a) => a.status === 'deleted');
            if (deletedAsset) {
              details.push({
                pointer: `${pointerPrefix}/scenes/${sIdx}/layers/${lIdx}/content/asset_id`,
                code: 'ASSET_REVOKED',
                message: `Layer asset '${assetId}' was revoked/deleted and cannot be referenced`,
              });
            } else {
              details.push({
                pointer: `${pointerPrefix}/scenes/${sIdx}/layers/${lIdx}/content/asset_id`,
                code: 'ASSET_NOT_FOUND',
                message: `Layer asset '${assetId}' was not found or is not authorized for tenant`,
              });
            }
          }
        }
      }
    }

    // 3. Validate audio_tracks[].asset_id
    for (let aIdx = 0; aIdx < (spec.audio_tracks ?? []).length; aIdx++) {
      const track = spec.audio_tracks[aIdx]!;
      const visibleAssets = tx.selectScoped<{
        id: string;
        kind: string;
        status: string;
      }>('assets', 'id = ?', [track.asset_id]);
      const readyAudio = visibleAssets.find((a) => a.status === 'ready' && a.kind === 'audio');
      if (!readyAudio) {
        const deletedAudio = visibleAssets.find((a) => a.status === 'deleted');
        if (deletedAudio) {
          details.push({
            pointer: `${pointerPrefix}/audio_tracks/${aIdx}/asset_id`,
            code: 'ASSET_REVOKED',
            message: `Audio asset '${track.asset_id}' was revoked/deleted and cannot be referenced`,
          });
        } else {
          details.push({
            pointer: `${pointerPrefix}/audio_tracks/${aIdx}/asset_id`,
            code: 'ASSET_NOT_FOUND',
            message: `Audio asset '${track.asset_id}' was not found or is not authorized for tenant`,
          });
        }
      }
    }

    // 4. Validate subtitles[].style.font_id
    for (let subIdx = 0; subIdx < (spec.subtitles ?? []).length; subIdx++) {
      const sub = spec.subtitles[subIdx]!;
      if (sub.style && !declaredFontIds.has(sub.style.font_id)) {
        details.push({
          pointer: `${pointerPrefix}/subtitles/${subIdx}/style/font_id`,
          code: 'UNKNOWN_FONT',
          message: `Subtitle font_id '${sub.style.font_id}' is not declared in composition fonts`,
        });
      }
    }

    return details;
  }

  public createComposition(
    tenantId: string,
    input: {
      id: string;
      name: string;
      spec: CompositionSpec;
      templateRef?: { tenantId: string; id: string; revision: number };
      now?: Date;
    },
  ): { id: string; revision: 1; name: string; render_hash: string; created_at: string } {
    const nowIso = (input.now ?? new Date()).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const allErrors: ErrorDetail[] = [];

      const limits = this.getTenantPolicyLimitsInTx(tx);
      const unified = validateCompositionUnified(input.spec, {
        profile: 'mp4-720p-v1',
        capabilityOptions: {
          customCodeEnabled: limits.custom_code_enabled ?? false,
          canvasEngineEnabled: limits.canvas_engine_enabled ?? true,
          svgEngineEnabled: limits.svg_engine_enabled ?? true,
          rtlEnabled: limits.rtl_enabled ?? false,
        },
      });
      if (!unified.valid) {
        allErrors.push(
          ...unified.all_errors.map((e) => ({
            pointer: `/spec${e.pointer === '/' ? '' : e.pointer}`,
            code: e.code,
            message: e.message,
          })),
        );
      }

      const refErrors = this.validateCompositionReferencesInTx(tx, input.spec, '/spec');
      allErrors.push(...refErrors);

      if (allErrors.length > 0) {
        throw new BodyReferenceValidationError(allErrors);
      }

      const manifest = compileComposition(input.spec, { profile: 'mp4-720p-v1' });
      const renderHash = manifest.render_hash;

      tx.insertScoped('compositions', {
        tenant_id: tenantId,
        id: input.id,
        name: input.name,
        current_revision: 1,
        template_tenant_id: input.templateRef?.tenantId ?? null,
        template_id: input.templateRef?.id ?? null,
        template_revision: input.templateRef?.revision ?? null,
        editable: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('composition_revisions', {
        tenant_id: tenantId,
        composition_id: input.id,
        revision: 1,
        schema_version: '1.0',
        spec_json: JSON.stringify(input.spec),
        render_hash: renderHash,
        change_note: 'Initial composition revision',
        created_at: nowIso,
      });

      return {
        id: input.id,
        revision: 1,
        name: input.name,
        render_hash: renderHash,
        created_at: nowIso,
      };
    });
  }

  public getComposition(
    tenantId: string,
    compositionId: string,
  ): { id: string; current_revision: number; name: string; created_at: string } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        current_revision: number;
        name: string;
        created_at: string;
      }>('compositions', 'id = ?', [compositionId]);

      const comp = rows[0];
      if (!comp) {
        throw new ResourceNotFoundError(`Composition ${compositionId} not found`);
      }
      return {
        id: comp.id,
        current_revision: comp.current_revision,
        name: comp.name,
        created_at: comp.created_at,
      };
    });
  }

  public getCompositionRevision(
    tenantId: string,
    compositionId: string,
    revision: number,
  ): {
    id: string;
    revision: number;
    spec: CompositionSpec;
    render_hash: string;
    created_at: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        composition_id: string;
        revision: number;
        spec_json: string;
        render_hash: string;
        created_at: string;
      }>(
        'composition_revisions',
        'composition_id = ? AND revision = ?',
        [compositionId, revision],
      );

      const rev = rows[0];
      if (!rev) {
        throw new ResourceNotFoundError(
          `Composition ${compositionId} revision ${revision} not found`,
        );
      }

      return {
        id: rev.composition_id,
        revision: rev.revision,
        spec: JSON.parse(rev.spec_json) as CompositionSpec,
        render_hash: rev.render_hash,
        created_at: rev.created_at,
      };
    });
  }

  public createCompositionRevision(
    tenantId: string,
    compositionId: string,
    input: {
      base_revision: number;
      change_note?: string;
      spec: CompositionSpec;
      now?: Date;
    },
  ): { id: string; revision: number; render_hash: string; created_at: string } {
    const nowIso = (input.now ?? new Date()).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const comps = tx.selectScoped<{ id: string; current_revision: number }>(
        'compositions',
        'id = ?',
        [compositionId],
      );
      const comp = comps[0];
      if (!comp) {
        throw new ResourceNotFoundError(`Composition ${compositionId} not found`);
      }

      if (comp.current_revision !== input.base_revision) {
        throw new RevisionConflictError(
          `Expected base_revision ${comp.current_revision}, received ${input.base_revision}`,
        );
      }

      const baseRevs = tx.selectScoped<{
        spec_json: string;
        render_hash: string;
      }>(
        'composition_revisions',
        'composition_id = ? AND revision = ?',
        [compositionId, input.base_revision],
      );
      const baseRev = baseRevs[0];
      if (!baseRev) {
        throw new RevisionConflictError(
          `Base revision ${input.base_revision} not found for composition ${compositionId}`,
        );
      }
      const baseSpec = JSON.parse(baseRev.spec_json) as CompositionSpec;

      // Scene revisions & immutability:
      // Compare content hashes between base and new scenes.
      // If content changed, enforce scene revision increment ("không tin revision client tự giữ thấp").
      // If content unchanged, keep base scene revision.
      const baseScenesMap = new Map<string, SceneSpec>();
      for (const s of baseSpec.scenes ?? []) {
        baseScenesMap.set(s.id, s);
      }

      for (const newScene of input.spec.scenes ?? []) {
        const baseScene = baseScenesMap.get(newScene.id);
        if (baseScene) {
          const baseContentHash = computeSceneContentHash(baseScene);
          const newContentHash = computeSceneContentHash(newScene);

          if (baseContentHash === newContentHash) {
            newScene.revision = baseScene.revision;
          } else {
            if (newScene.revision <= baseScene.revision) {
              newScene.revision = baseScene.revision + 1;
            }
          }
        } else {
          if (!newScene.revision || newScene.revision < 1) {
            newScene.revision = 1;
          }
        }
      }

      const nextRevision = comp.current_revision + 1;
      const allErrors: ErrorDetail[] = [];

      const compDiff = compareCompositionRevisions(
        baseSpec,
        input.spec,
        comp.current_revision,
        nextRevision,
      );
      if (!compDiff.valid) {
        allErrors.push(
          ...compDiff.errors.map((msg) => ({
            pointer: '/spec/scenes',
            code: 'SCENE_REVISION_INVALID',
            message: msg,
          })),
        );
      }

      const limits = this.getTenantPolicyLimitsInTx(tx);
      const unified = validateCompositionUnified(input.spec, {
        profile: 'mp4-720p-v1',
        capabilityOptions: {
          customCodeEnabled: limits.custom_code_enabled ?? false,
          canvasEngineEnabled: limits.canvas_engine_enabled ?? true,
          svgEngineEnabled: limits.svg_engine_enabled ?? true,
          rtlEnabled: limits.rtl_enabled ?? false,
        },
      });
      if (!unified.valid) {
        allErrors.push(
          ...unified.all_errors.map((e) => ({
            pointer: `/spec${e.pointer === '/' ? '' : e.pointer}`,
            code: e.code,
            message: e.message,
          })),
        );
      }

      const refErrors = this.validateCompositionReferencesInTx(tx, input.spec, '/spec');
      allErrors.push(...refErrors);

      if (allErrors.length > 0) {
        throw new BodyReferenceValidationError(allErrors);
      }

      const manifest = compileComposition(input.spec, { profile: 'mp4-720p-v1' });
      const renderHash = manifest.render_hash;

      tx.updateScoped(
        'compositions',
        { current_revision: nextRevision, updated_at: nowIso },
        'id = ?',
        [compositionId],
      );

      try {
        tx.insertScoped('composition_revisions', {
          tenant_id: tenantId,
          composition_id: compositionId,
          revision: nextRevision,
          schema_version: '1.0',
          spec_json: JSON.stringify(input.spec),
          render_hash: renderHash,
          change_note: input.change_note ?? null,
          created_at: nowIso,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes('UNIQUE constraint failed') ||
            err.message.includes('unique constraint') ||
            err.message.includes('duplicate key'))
        ) {
          throw new RevisionConflictError(
            `Concurrent modification: revision ${nextRevision} already exists`,
          );
        }
        throw err;
      }

      return {
        id: compositionId,
        revision: nextRevision,
        render_hash: renderHash,
        created_at: nowIso,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 5. Jobs, Artifacts, Webhooks & Usage (Tenant Isolation & IDOR Protection)
  // --------------------------------------------------------------------------

  public createJob(
    tenantId: string,
    input: {
      id: string;
      kind: 'render' | 'preview';
      compositionId: string;
      compositionRevision: number;
      profile: 'mp4-720p-v1' | 'preview-360p-v1';
      webhookEndpointId?: string;
      clientReference?: string;
      metadata?: Record<string, string>;
      now?: Date;
    },
  ): {
    id: string;
    kind: string;
    state: string;
    state_version: number;
    composition_id: string;
    revision: number;
    profile: string;
    created_at: string;
    status_url: string;
  } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const deadlineSeconds = input.kind === 'render' ? 1800 : 300;
    const deadlineIso = new Date(now.getTime() + deadlineSeconds * 1000).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const compRevs = tx.selectScoped<{
        composition_id: string;
        revision: number;
        spec_json: string;
      }>(
        'composition_revisions',
        'composition_id = ? AND revision = ?',
        [input.compositionId, input.compositionRevision],
      );

      const compRev = compRevs[0];
      if (!compRev) {
        throw new ResourceNotFoundError(
          `Composition ${input.compositionId}@${input.compositionRevision} not found`,
        );
      }

      // Enforce reference safety: inspect all assets in snapshot are authorized and not deleted/revoked
      try {
        const spec = JSON.parse(compRev.spec_json) as CompositionSpec;
        const refErrors = this.validateCompositionReferencesInTx(tx, spec, '/snapshot');
        if (refErrors.length > 0) {
          throw new BodyReferenceValidationError(
            refErrors,
            'Composition references deleted, revoked, or unauthorized assets',
          );
        }
      } catch (err) {
        if (err instanceof BodyReferenceValidationError) {
          throw err;
        }
      }

      if (input.webhookEndpointId) {
        const endpoints = tx.selectScoped<{ id: string; state: string }>(
          'webhook_endpoints',
          'id = ?',
          [input.webhookEndpointId],
        );
        if (!endpoints[0]) {
          throw new ResourceNotFoundError(
            `Webhook endpoint ${input.webhookEndpointId} not found`,
          );
        }
      }

      tx.insertScoped('jobs', {
        tenant_id: tenantId,
        id: input.id,
        kind: input.kind,
        state: 'queued',
        state_version: 1,
        stage: 'queued',
        progress: 0,
        composition_id: input.compositionId,
        composition_revision: input.compositionRevision,
        profile: input.profile,
        snapshot_json: compRev.spec_json,
        webhook_endpoint_id: input.webhookEndpointId ?? null,
        client_reference: input.clientReference ?? null,
        metadata_json: input.metadata ? JSON.stringify(input.metadata) : null,
        attempt_count: 0,
        max_attempts: 3,
        active_attempt_id: null,
        lease_epoch: 0,
        lease_expires_at: null,
        heartbeat_at: null,
        cancel_requested_at: null,
        deadline_at: deadlineIso,
        completed_at: null,
        error_json: null,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('job_events', {
        tenant_id: tenantId,
        job_id: input.id,
        event_seq: 1,
        state: 'queued',
        state_version: 1,
        event_type: 'job.queued',
        payload_json: JSON.stringify({ profile: input.profile }),
        created_at: nowIso,
      });

      tx.insertScoped('usage_reservations', {
        tenant_id: tenantId,
        job_id: input.id,
        reserved_vcpu_seconds: 120,
        reserved_output_seconds: 15,
        state: 'reserved',
        created_at: nowIso,
        settled_at: null,
      });

      return {
        id: input.id,
        kind: input.kind,
        state: 'queued',
        state_version: 1,
        composition_id: input.compositionId,
        revision: input.compositionRevision,
        profile: input.profile,
        created_at: nowIso,
        status_url: `/v1/jobs/${input.id}`,
      };
    });
  }

  public getJob(
    tenantId: string,
    jobId: string,
  ): {
    id: string;
    kind: string;
    state: string;
    state_version: number;
    stage: string;
    progress: number;
    attempt: number;
    max_attempts: number;
    composition_id: string;
    revision: number;
    profile: string;
    artifacts: Array<{ id: string; kind: string; mime_type: string }>;
    usage: Record<string, number>;
    error: Record<string, unknown> | null;
    created_at: string;
    completed_at: string | null;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const jobs = tx.selectScoped<{
        id: string;
        kind: string;
        state: string;
        state_version: number;
        stage: string;
        progress: number;
        attempt_count: number;
        max_attempts: number;
        composition_id: string;
        composition_revision: number;
        profile: string;
        error_json: string | null;
        created_at: string;
        completed_at: string | null;
      }>('jobs', 'id = ?', [jobId]);

      const job = jobs[0];
      if (!job) {
        throw new ResourceNotFoundError(`Job ${jobId} not found`);
      }

      const artifacts = tx.selectScoped<{
        id: string;
        kind: string;
        mime_type: string;
      }>('artifacts', 'job_id = ? AND revoked_at IS NULL', [jobId]);

      const reservations = tx.selectScoped<{
        reserved_vcpu_seconds: number;
        reserved_output_seconds: number;
        state: string;
      }>('usage_reservations', 'job_id = ?', [jobId]);

      const usageEntries = tx.selectScoped<{
        meter: string;
        quantity: number;
      }>('usage_entries', 'job_id = ?', [jobId]);

      const usage: Record<string, number> = {};
      if (reservations[0]) {
        usage['output_seconds'] = Number(reservations[0].reserved_output_seconds);
      }
      for (const entry of usageEntries) {
        if (entry.meter === 'cpu_seconds') {
          usage['cpu_seconds'] = (usage['cpu_seconds'] ?? 0) + Number(entry.quantity);
        } else if (entry.meter === 'billable_output_minutes') {
          usage['billable_output_minutes'] =
            (usage['billable_output_minutes'] ?? 0) + Number(entry.quantity);
        }
      }

      return {
        id: job.id,
        kind: job.kind,
        state: job.state,
        state_version: job.state_version,
        stage: job.stage,
        progress: job.progress,
        attempt: job.attempt_count,
        max_attempts: job.max_attempts,
        composition_id: job.composition_id,
        revision: job.composition_revision,
        profile: job.profile,
        artifacts: artifacts.map((a) => ({
          id: a.id,
          kind: a.kind,
          mime_type: a.mime_type,
        })),
        usage,
        error: job.error_json ? (JSON.parse(job.error_json) as Record<string, unknown>) : null,
        created_at: job.created_at,
        completed_at: job.completed_at,
      };
    });
  }

  /**
   * Validates and resolves all assets and fonts referenced by a composition inside
   * the current transaction, enforcing readiness (`409 ASSET_NOT_READY`), existence/type
   * (`422 ASSET_NOT_FOUND` / `UNKNOWN_FONT`), and per-job asset count (<= 50) & total input
   * byte budget (<= 500 MiB) per docs/PRD.md lines 108-109 and docs/API.md line 56.
   */
  private validateAndResolveJobAssetsInTx(
    tx: TenantTransactionContext,
    spec: CompositionSpec,
    limits: TenantPolicyLimits,
  ): {
    resolvedAssets: Array<{
      asset_id: string;
      version: number;
      kind: string;
      sha256: string;
      bytes: number;
      mime_type: string;
    }>;
    totalInputBytes: number;
    totalAssetReferences: number;
  } {
    const details: ErrorDetail[] = [];
    const declaredFontIds = new Set<string>();
    const assetReferenceList: Array<{ pointer: string; assetId: string; expectedKind: string }> = [];

    for (let i = 0; i < (spec.fonts ?? []).length; i++) {
      const font = spec.fonts[i]!;
      declaredFontIds.add(font.id);
      assetReferenceList.push({
        pointer: `/spec/fonts/${i}/asset_id`,
        assetId: font.asset_id,
        expectedKind: 'font',
      });
    }

    for (let sIdx = 0; sIdx < (spec.scenes ?? []).length; sIdx++) {
      const scene = spec.scenes[sIdx]!;
      const layers = 'layers' in scene && Array.isArray(scene.layers) ? scene.layers : [];
      for (let lIdx = 0; lIdx < layers.length; lIdx++) {
        const layer = layers[lIdx]!;
        const content = layer.content as unknown as Record<string, unknown>;
        if (layer.type === 'text') {
          const fontId = String(content['font_id'] ?? '');
          if (!declaredFontIds.has(fontId)) {
            details.push({
              pointer: `/spec/scenes/${sIdx}/layers/${lIdx}/content/font_id`,
              code: 'UNKNOWN_FONT',
              message: `Referenced font_id '${fontId}' is not declared in composition fonts`,
            });
          }
        } else if (layer.type === 'image' || layer.type === 'video' || layer.type === 'svg') {
          const assetId = String(content['asset_id'] ?? '');
          assetReferenceList.push({
            pointer: `/spec/scenes/${sIdx}/layers/${lIdx}/content/asset_id`,
            assetId,
            expectedKind: layer.type,
          });
        }
      }
    }

    for (let aIdx = 0; aIdx < (spec.audio_tracks ?? []).length; aIdx++) {
      const track = spec.audio_tracks[aIdx]!;
      assetReferenceList.push({
        pointer: `/spec/audio_tracks/${aIdx}/asset_id`,
        assetId: track.asset_id,
        expectedKind: 'audio',
      });
    }

    for (let subIdx = 0; subIdx < (spec.subtitles ?? []).length; subIdx++) {
      const sub = spec.subtitles[subIdx]!;
      if (sub.style && !declaredFontIds.has(sub.style.font_id)) {
        details.push({
          pointer: `/spec/subtitles/${subIdx}/style/font_id`,
          code: 'UNKNOWN_FONT',
          message: `Subtitle font_id '${sub.style.font_id}' is not declared in composition fonts`,
        });
      }
    }

    const resolvedMap = new Map<
      string,
      {
        asset_id: string;
        version: number;
        kind: string;
        sha256: string;
        bytes: number;
        mime_type: string;
      }
    >();

    let totalInputBytes = 0;

    for (const ref of assetReferenceList) {
      const visibleAssets = tx.selectScoped<{
        tenant_id: string;
        id: string;
        kind: string;
        status: string;
        current_version: number;
      }>('assets', 'id = ?', [ref.assetId]);

      const asset = visibleAssets[0];
      if (!asset || asset.status === 'deleted' || asset.status === 'rejected') {
        details.push({
          pointer: ref.pointer,
          code: 'ASSET_NOT_FOUND',
          message: `Referenced asset '${ref.assetId}' was not found or has been revoked/deleted`,
        });
        continue;
      }

      if (asset.status === 'uploading' || asset.status === 'processing') {
        throw new AssetNotReadyError(
          `Asset '${ref.assetId}' is currently in '${asset.status}' state and not ready for job admission`,
        );
      }

      if (asset.kind !== ref.expectedKind) {
        details.push({
          pointer: ref.pointer,
          code: 'ASSET_NOT_FOUND',
          message: `Asset '${ref.assetId}' of kind '${asset.kind}' does not match expected kind '${ref.expectedKind}'`,
        });
        continue;
      }

      const versions = tx.selectScoped<{
        original_sha256: string;
        normalized_sha256: string | null;
        mime_type: string;
        bytes: number;
      }>(
        'asset_versions',
        'tenant_id = ? AND asset_id = ? AND version = ?',
        [asset.tenant_id, asset.id, asset.current_version],
      );
      const ver = versions[0];
      const bytes = ver?.bytes ?? 0;
      const sha256 = ver?.normalized_sha256 ?? ver?.original_sha256 ?? '0'.repeat(64);
      const mimeType = ver?.mime_type ?? 'application/octet-stream';

      totalInputBytes += bytes;
      if (!resolvedMap.has(asset.id)) {
        resolvedMap.set(asset.id, {
          asset_id: asset.id,
          version: asset.current_version,
          kind: asset.kind,
          sha256,
          bytes,
          mime_type: mimeType,
        });
      }
    }

    if (details.length > 0) {
      throw new BodyReferenceValidationError(details);
    }

    const totalAssetReferences = assetReferenceList.length;
    if (totalAssetReferences > limits.max_assets_per_job) {
      throw new UnsupportedCapabilityError(
        [
          {
            pointer: '/spec',
            code: 'PROFILE_CONSTRAINT_VIOLATED',
            message: `Composition references ${totalAssetReferences} assets, exceeding per-job limit of ${limits.max_assets_per_job}`,
          },
        ],
        `Job exceeds maximum assets per job limit (${limits.max_assets_per_job})`,
      );
    }

    if (totalInputBytes > limits.max_total_input_bytes_per_job) {
      throw new UnsupportedCapabilityError(
        [
          {
            pointer: '/spec',
            code: 'PROFILE_CONSTRAINT_VIOLATED',
            message: `Total referenced asset input bytes (${totalInputBytes}) exceeds per-job limit of ${limits.max_total_input_bytes_per_job} bytes`,
          },
        ],
        `Job exceeds maximum total input bytes per job (${limits.max_total_input_bytes_per_job})`,
      );
    }

    return {
      resolvedAssets: Array.from(resolvedMap.values()),
      totalInputBytes,
      totalAssetReferences,
    };
  }

  /**
   * Executes the full atomic admission transaction for `POST /v1/render-jobs` and
   * `POST /v1/previews` (Task P4-01).
   *
   * Guarantees:
   *   1. Validates immutable composition revision, preview timeline bounds, profile/engine
   *      capabilities, approved custom scene bundles, asset readiness (`409 ASSET_NOT_READY`),
   *      asset count/byte budgets, and verified webhook endpoint (`409 WEBHOOK_NOT_VERIFIED`).
   *   2. Enforces tenant pending admission slots (`count(queued + retry_wait) < 20`),
   *      non-terminal job cap (`count(non_terminal) < 22`), and reservation budgets
   *      inside a single `BEGIN IMMEDIATE` transaction (`429 QUOTA_EXCEEDED`).
   *   3. Atomically inserts `jobs`, `job_events`, `usage_reservations`, and marks
   *      `idempotency_records` as `completed` in the same durable transaction before
   *      returning the `202 Accepted` payload.
   */
  public admitJob(
    tenantId: string,
    input: {
      id: string;
      request: ValidatedJobAdmissionRequest;
      idempotency?: {
        method: 'POST';
        normalizedPath: string;
        key: string;
        requestHash: string;
      };
      serverCapabilities?: {
        customCodeEnabled?: boolean;
      };
      beforeCommitHook?: (tx: TenantTransactionContext) => void;
      now?: Date;
    },
  ): {
    replayed: boolean;
    job: {
      id: string;
      kind: string;
      state: string;
      state_version: number;
      composition_id: string;
      revision: number;
      profile: string;
      created_at: string;
      status_url: string;
    };
    reservation: {
      job_id: string;
      reserved_vcpu_seconds: number;
      reserved_output_seconds: number;
      state: string;
    };
  } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const deadlineSeconds = input.request.kind === 'render' ? 1800 : 300;
    const deadlineIso = new Date(now.getTime() + deadlineSeconds * 1000).toISOString();
    const idemExpiresIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      // 1. Check idempotency state inside transaction if provided
      let existingIdemState: 'none' | 'in_progress' = 'none';
      if (input.idempotency) {
        const records = tx.selectScoped<{
          request_hash: string;
          state: 'in_progress' | 'completed';
          http_status: number | null;
          response_body_encrypted: string | null;
          resource_id: string | null;
          expires_at: string;
        }>(
          'idempotency_records',
          'method = ? AND normalized_path = ? AND key = ?',
          [input.idempotency.method, input.idempotency.normalizedPath, input.idempotency.key],
        );
        const rec = records[0];
        if (rec) {
          if (Date.parse(rec.expires_at) <= now.getTime()) {
            tx.deleteScoped(
              'idempotency_records',
              'method = ? AND normalized_path = ? AND key = ?',
              [input.idempotency.method, input.idempotency.normalizedPath, input.idempotency.key],
            );
          } else if (rec.request_hash !== input.idempotency.requestHash) {
            throw new IdempotencyConflictError(
              'Idempotency key reused with different request payload',
            );
          } else if (rec.state === 'completed') {
            const replayedJob = JSON.parse(rec.response_body_encrypted ?? '{}') as {
              id: string;
              kind: string;
              state: string;
              state_version: number;
              composition_id: string;
              revision: number;
              profile: string;
              created_at: string;
              status_url: string;
            };
            const existingRes = tx.selectScoped<{
              job_id: string;
              reserved_vcpu_seconds: number;
              reserved_output_seconds: number;
              state: string;
            }>('usage_reservations', 'job_id = ?', [replayedJob.id])[0];

            return {
              replayed: true,
              job: replayedJob,
              reservation: existingRes ?? {
                job_id: replayedJob.id,
                reserved_vcpu_seconds: 0,
                reserved_output_seconds: 0,
                state: 'reserved',
              },
            };
          } else {
            existingIdemState = 'in_progress';
          }
        }
      }

      // 2. Load active tenant policy limits
      const limits = this.getTenantPolicyLimitsInTx(tx);

      // 3. Load immutable composition revision
      const compRevs = tx.selectScoped<{
        composition_id: string;
        revision: number;
        spec_json: string;
        render_hash: string;
      }>(
        'composition_revisions',
        'composition_id = ? AND revision = ?',
        [input.request.compositionId, input.request.compositionRevision],
      );

      const compRev = compRevs[0];
      if (!compRev) {
        throw new BodyReferenceValidationError(
          [
            {
              pointer: '/composition_id',
              code: 'COMPOSITION_NOT_FOUND',
              message: `Composition '${input.request.compositionId}' at revision ${input.request.compositionRevision} was not found`,
            },
          ],
          `Composition ${input.request.compositionId}@${input.request.compositionRevision} was not found`,
        );
      }

      const spec = JSON.parse(compRev.spec_json) as CompositionSpec;

      // 4. Validate preview timeline bounds against composition.duration_frames
      if (input.request.kind === 'preview') {
        validatePreviewBoundsAgainstComposition(input.request, spec.duration_frames);
      }

      // 5. Validate capabilities and profile constraints
      const customCodeAllowed =
        input.serverCapabilities !== undefined
          ? Boolean(input.serverCapabilities.customCodeEnabled && (limits.custom_code_enabled ?? true))
          : Boolean(limits.custom_code_enabled);

      const baseValidationProfile =
        input.request.kind === 'preview' &&
        ((spec.canvas.width === 1280 && spec.canvas.height === 720) ||
          (spec.canvas.width === 720 && spec.canvas.height === 1280))
          ? 'mp4-720p-v1'
          : input.request.profile;

      const unified = validateCompositionUnified(spec, {
        profile: baseValidationProfile,
        capabilityOptions: {
          customCodeEnabled: customCodeAllowed,
          canvasEngineEnabled: limits.canvas_engine_enabled ?? true,
          svgEngineEnabled: limits.svg_engine_enabled ?? true,
          rtlEnabled: limits.rtl_enabled ?? false,
        },
      });

      if (!unified.valid) {
        const hasCapErr = unified.all_errors.some((e) => e.stage === 'capability');
        const mappedDetails: ErrorDetail[] = unified.all_errors.map((e) => ({
          pointer: `/spec${e.pointer === '/' ? '' : e.pointer}`,
          code: e.code,
          message: e.message,
        }));
        if (hasCapErr) {
          throw new UnsupportedCapabilityError(
            mappedDetails,
            'Composition violates profile constraints or requested capability is disabled',
          );
        }
        throw new BodyReferenceValidationError(mappedDetails);
      }

      // Verify custom-html-v1 scene bundles if present
      for (let sIdx = 0; sIdx < (spec.scenes ?? []).length; sIdx++) {
        const scene = spec.scenes[sIdx]!;
        if (scene.engine === 'custom-html-v1') {
          const rawScene = scene as unknown as {
            bundle?: { id?: string; revision?: number };
            bundle_id?: string;
            bundle_revision?: number;
          };
          const bundleId = rawScene.bundle?.id ?? rawScene.bundle_id ?? '';
          const bundleRev = rawScene.bundle?.revision ?? rawScene.bundle_revision ?? 1;
          const bundles = tx.selectScoped<{ id: string; status: string }>(
            'scene_bundles',
            'id = ?',
            [bundleId],
          );
          const bundleRevs = tx.selectScoped<{
            bundle_id: string;
            revision: number;
            security_gate_digest: string | null;
          }>('scene_bundle_revisions', 'bundle_id = ? AND revision = ?', [bundleId, bundleRev]);

          if (
            !bundles[0] ||
            bundles[0].status !== 'approved' ||
            !bundleRevs[0] ||
            !bundleRevs[0].security_gate_digest
          ) {
            throw new UnsupportedCapabilityError(
              [
                {
                  pointer: `/spec/scenes/${sIdx}/bundle/id`,
                  code: 'CAPABILITY_DISABLED',
                  message: `Custom scene bundle '${bundleId}@${bundleRev}' is not approved or lacks security gate verification`,
                },
              ],
              `Unapproved custom scene bundle '${bundleId}@${bundleRev}'`,
            );
          }
        }
      }

      // 6. Re-verify referenced assets & fonts, readiness, and input byte/count budgets
      const { resolvedAssets, totalInputBytes } = this.validateAndResolveJobAssetsInTx(
        tx,
        spec,
        limits,
      );

      // 7. Validate webhook_endpoint_id if provided (must exist and be 'active')
      if (input.request.webhookEndpointId) {
        const endpoints = tx.selectScoped<{ id: string; state: string }>(
          'webhook_endpoints',
          'id = ?',
          [input.request.webhookEndpointId],
        );
        const ep = endpoints[0];
        if (!ep) {
          throw new BodyReferenceValidationError(
            [
              {
                pointer: '/webhook_endpoint_id',
                code: 'WEBHOOK_ENDPOINT_NOT_FOUND',
                message: `Webhook endpoint '${input.request.webhookEndpointId}' was not found`,
              },
            ],
            `Webhook endpoint ${input.request.webhookEndpointId} not found`,
          );
        }
        if (ep.state !== 'active') {
          throw new WebhookNotVerifiedError(
            `Webhook endpoint '${input.request.webhookEndpointId}' is in state '${ep.state}'; must be 'active' before job admission`,
          );
        }
      }

      // 8. Enforce tenant slot quotas & reservation budgets inside the transaction
      const nonTerminalJobs = tx.selectScoped<{ id: string; state: string }>(
        'jobs',
        "state NOT IN ('succeeded', 'failed', 'canceled')",
        [],
      );
      const pendingCount = nonTerminalJobs.filter(
        (j) => j.state === 'queued' || j.state === 'retry_wait',
      ).length;
      const nonTerminalCount = nonTerminalJobs.length;

      if (pendingCount >= limits.pending_admission_slots_max) {
        throw new QuotaExceededError(
          `Tenant pending admission slots limit reached (${pendingCount}/${limits.pending_admission_slots_max})`,
          5,
        );
      }
      if (nonTerminalCount >= limits.non_terminal_jobs_total_max) {
        throw new QuotaExceededError(
          `Tenant total non-terminal jobs limit reached (${nonTerminalCount}/${limits.non_terminal_jobs_total_max})`,
          5,
        );
      }

      const { reservedVcpuSeconds, reservedOutputSeconds } = calculateJobReservation(
        input.request,
        spec,
      );

      if (
        limits.max_reserved_vcpu_seconds !== undefined ||
        limits.max_reserved_output_seconds !== undefined
      ) {
        const activeReservations = tx.selectScoped<{
          reserved_vcpu_seconds: number;
          reserved_output_seconds: number;
        }>('usage_reservations', "state = 'reserved'", []);

        const currentVcpu = activeReservations.reduce(
          (acc, r) => acc + Number(r.reserved_vcpu_seconds),
          0,
        );
        const currentOutput = activeReservations.reduce(
          (acc, r) => acc + Number(r.reserved_output_seconds),
          0,
        );

        if (
          limits.max_reserved_vcpu_seconds !== undefined &&
          currentVcpu + reservedVcpuSeconds > limits.max_reserved_vcpu_seconds
        ) {
          throw new QuotaExceededError(
            `Tenant reserved vCPU budget exceeded (${currentVcpu + reservedVcpuSeconds} > ${limits.max_reserved_vcpu_seconds})`,
            5,
          );
        }
        if (
          limits.max_reserved_output_seconds !== undefined &&
          currentOutput + reservedOutputSeconds > limits.max_reserved_output_seconds
        ) {
          throw new QuotaExceededError(
            `Tenant reserved output seconds budget exceeded (${currentOutput + reservedOutputSeconds} > ${limits.max_reserved_output_seconds})`,
            5,
          );
        }
      }

      // 9. Build immutable pinned job snapshot
      const snapshotPayload = {
        schema_version: '1.0',
        kind: input.request.kind,
        profile: input.request.profile,
        composition_id: input.request.compositionId,
        composition_revision: input.request.compositionRevision,
        render_hash: compRev.render_hash,
        compiler_version: '0.1.0',
        seed: spec.seed ?? 0,
        required_capabilities: unified.capabilities.required_capabilities.map((c) =>
          c.startsWith('profile:') ? `profile:${input.request.profile}` : c,
        ),
        resolved_assets: resolvedAssets,
        total_input_bytes: totalInputBytes,
        ...(input.request.kind === 'preview'
          ? {
              preview: {
                mode: input.request.mode,
                frame_index: input.request.frameIndex ?? null,
                start_frame: input.request.startFrame ?? null,
                duration_frames: input.request.durationFrames ?? null,
              },
            }
          : {}),
        metadata: input.request.metadata,
        spec,
      };

      const jobSummary = {
        id: input.id,
        kind: input.request.kind,
        state: 'queued' as const,
        state_version: 1,
        composition_id: input.request.compositionId,
        revision: input.request.compositionRevision,
        profile: input.request.profile,
        created_at: nowIso,
        status_url: `/v1/jobs/${input.id}`,
      };

      // 10. Insert job, initial job_event, usage_reservation, and complete idempotency record
      tx.insertScoped('jobs', {
        tenant_id: tenantId,
        id: input.id,
        kind: input.request.kind,
        state: 'queued',
        state_version: 1,
        stage: 'queued',
        progress: 0,
        composition_id: input.request.compositionId,
        composition_revision: input.request.compositionRevision,
        profile: input.request.profile,
        snapshot_json: JSON.stringify(snapshotPayload),
        webhook_endpoint_id: input.request.webhookEndpointId ?? null,
        client_reference: input.request.clientReference ?? null,
        metadata_json: input.request.metadata ? JSON.stringify(input.request.metadata) : null,
        attempt_count: 0,
        max_attempts: 3,
        active_attempt_id: null,
        lease_epoch: 0,
        lease_expires_at: null,
        heartbeat_at: null,
        cancel_requested_at: null,
        deadline_at: deadlineIso,
        completed_at: null,
        error_json: null,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('job_events', {
        tenant_id: tenantId,
        job_id: input.id,
        event_seq: 1,
        state: 'queued',
        state_version: 1,
        event_type: 'job.queued',
        payload_json: JSON.stringify({
          kind: input.request.kind,
          profile: input.request.profile,
          stage: 'queued',
          progress_percent: 0,
          message: 'Job admitted and queued for execution',
        }),
        created_at: nowIso,
      });

      tx.insertScoped('usage_reservations', {
        tenant_id: tenantId,
        job_id: input.id,
        reserved_vcpu_seconds: reservedVcpuSeconds,
        reserved_output_seconds: reservedOutputSeconds,
        state: 'reserved',
        created_at: nowIso,
        settled_at: null,
      });

      if (input.idempotency) {
        if (existingIdemState === 'in_progress') {
          tx.updateScoped(
            'idempotency_records',
            {
              state: 'completed',
              http_status: 202,
              response_body_encrypted: JSON.stringify(jobSummary),
              resource_id: input.id,
            },
            'method = ? AND normalized_path = ? AND key = ?',
            [input.idempotency.method, input.idempotency.normalizedPath, input.idempotency.key],
          );
        } else {
          tx.insertScoped('idempotency_records', {
            tenant_id: tenantId,
            method: input.idempotency.method,
            normalized_path: input.idempotency.normalizedPath,
            key: input.idempotency.key,
            request_hash: input.idempotency.requestHash,
            state: 'completed',
            http_status: 202,
            response_body_encrypted: JSON.stringify(jobSummary),
            resource_id: input.id,
            secret_redacted: 0,
            created_at: nowIso,
            expires_at: idemExpiresIso,
          });
        }
      }

      if (input.beforeCommitHook) {
        try {
          input.beforeCommitHook(tx);
        } catch (err) {
          if (err instanceof AdmissionServiceUnavailableError) {
            throw err;
          }
          throw new AdmissionServiceUnavailableError(
            err instanceof Error ? err.message : 'Database commit failed during job admission',
          );
        }
      }

      return {
        replayed: false,
        job: jobSummary,
        reservation: {
          job_id: input.id,
          reserved_vcpu_seconds: reservedVcpuSeconds,
          reserved_output_seconds: reservedOutputSeconds,
          state: 'reserved',
        },
      };
    });
  }

  /**
   * Cancels a job (`POST /v1/jobs/{id}/cancel`) per docs/API.md lines 139-158
   * and docs/ARCHITECTURE.md line 61:
   *   - `queued` / `retry_wait` -> immediately `canceled` (202 Accepted) + releases usage reservation
   *   - `preparing` / `rendering` / `encoding` / `verifying` -> `cancel_requested` (202 Accepted)
   *   - `cancel_requested` -> idempotent `cancel_requested` (202 Accepted)
   *   - `canceled` -> idempotent `canceled` (200 OK)
   *   - `succeeded` / `failed` -> 409 JOB_TERMINAL
   */
  public cancelJob(
    tenantId: string,
    jobId: string,
    options: { now?: Date } = {},
  ): {
    httpStatus: 200 | 202;
    body: {
      id: string;
      state: string;
      state_version: number;
    };
  } {
    const nowIso = (options.now ?? new Date()).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const jobs = tx.selectScoped<{
        id: string;
        state: string;
        state_version: number;
        stage: string;
      }>('jobs', 'id = ?', [jobId]);

      const job = jobs[0];
      if (!job) {
        throw new ResourceNotFoundError(`Job ${jobId} not found`);
      }

      if (job.state === 'succeeded' || job.state === 'failed') {
        throw new JobTerminalError(
          `Job ${jobId} is already in terminal state '${job.state}' and cannot be canceled`,
        );
      }

      if (job.state === 'canceled') {
        return {
          httpStatus: 200,
          body: {
            id: job.id,
            state: 'canceled',
            state_version: job.state_version,
          },
        };
      }

      if (job.state === 'cancel_requested') {
        return {
          httpStatus: 202,
          body: {
            id: job.id,
            state: 'cancel_requested',
            state_version: job.state_version,
          },
        };
      }

      const existingEvents = tx.selectScoped<{ event_seq: number }>(
        'job_events',
        'job_id = ?',
        [jobId],
        'event_seq DESC',
      );
      const nextEventSeq = (existingEvents[0]?.event_seq ?? 0) + 1;
      const nextStateVersion = job.state_version + 1;

      if (job.state === 'queued' || job.state === 'retry_wait') {
        tx.updateScoped(
          'jobs',
          {
            state: 'canceled',
            stage: 'canceled',
            state_version: nextStateVersion,
            cancel_requested_at: nowIso,
            completed_at: nowIso,
            updated_at: nowIso,
          },
          'id = ?',
          [jobId],
        );

        tx.updateScoped(
          'usage_reservations',
          {
            state: 'released',
            settled_at: nowIso,
          },
          "job_id = ? AND state = 'reserved'",
          [jobId],
        );

        tx.insertScoped('job_events', {
          tenant_id: tenantId,
          job_id: jobId,
          event_seq: nextEventSeq,
          state: 'canceled',
          state_version: nextStateVersion,
          event_type: 'job.canceled',
          payload_json: JSON.stringify({
            stage: 'canceled',
            message: `Job canceled while in ${job.state} state`,
          }),
          created_at: nowIso,
        });

        tx.insertScoped('outbox', {
          tenant_id: tenantId,
          id: `out_${crypto.randomBytes(6).toString('hex')}`,
          event_type: 'job.canceled',
          job_id: jobId,
          state_version: nextStateVersion,
          payload_json: JSON.stringify({
            job_id: jobId,
            state: 'canceled',
            state_version: nextStateVersion,
          }),
          created_at: nowIso,
          processed_at: null,
        });

        return {
          httpStatus: 202,
          body: {
            id: jobId,
            state: 'canceled',
            state_version: nextStateVersion,
          },
        };
      }

      // Active states: preparing, rendering, encoding, verifying -> cancel_requested
      tx.updateScoped(
        'jobs',
        {
          state: 'cancel_requested',
          state_version: nextStateVersion,
          cancel_requested_at: nowIso,
          updated_at: nowIso,
        },
        'id = ?',
        [jobId],
      );

      tx.insertScoped('job_events', {
        tenant_id: tenantId,
        job_id: jobId,
        event_seq: nextEventSeq,
        state: 'cancel_requested',
        state_version: nextStateVersion,
        event_type: 'job.cancel_requested',
        payload_json: JSON.stringify({
          stage: job.stage,
          message: 'Cancellation requested for active job',
        }),
        created_at: nowIso,
      });

      return {
        httpStatus: 202,
        body: {
          id: jobId,
          state: 'cancel_requested',
          state_version: nextStateVersion,
        },
      };
    });
  }

  /**
   * Lists job events (`GET /v1/jobs/{id}/events`) per docs/API.md lines 129-137.
   */
  public listJobEvents(
    tenantId: string,
    jobId: string,
    options: { afterSeq?: number; limit?: number; cursor?: string } = {},
  ): {
    data: Array<{
      event_seq: number;
      job_id: string;
      timestamp: string;
      state: string;
      stage: string;
      progress_percent: number;
      message: string;
    }>;
    next_cursor: string | null;
  } {
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const route = `/v1/jobs/${jobId}/events`;
    let minSeqExclusive = options.afterSeq ?? 0;

    if (options.cursor) {
      const decoded = decodeSignedCursor({
        cursor: options.cursor,
        tenantId,
        route,
        secret: this.pepper,
      });
      if (!decoded) {
        throw new InvalidCursorError();
      }
      const parsedSeq = Number(decoded.id);
      if (Number.isInteger(parsedSeq) && parsedSeq > minSeqExclusive) {
        minSeqExclusive = parsedSeq;
      }
    }

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const jobs = tx.selectScoped<{ id: string }>('jobs', 'id = ?', [jobId]);
      if (!jobs[0]) {
        throw new ResourceNotFoundError(`Job ${jobId} not found`);
      }

      const events = tx.selectScoped<{
        event_seq: number;
        job_id: string;
        state: string;
        state_version: number;
        event_type: string;
        payload_json: string;
        created_at: string;
      }>(
        'job_events',
        'job_id = ? AND event_seq > ?',
        [jobId, minSeqExclusive],
        'event_seq ASC',
      );

      const slice = events.slice(0, limit);
      const hasMore = events.length > limit;
      const lastItem = slice[slice.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeSignedCursor({
              tenantId,
              route,
              createdAt: lastItem.created_at,
              id: String(lastItem.event_seq),
              secret: this.pepper,
            })
          : null;

      return {
        data: slice.map((ev) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
          } catch {
            // ignore
          }
          return {
            event_seq: ev.event_seq,
            job_id: ev.job_id,
            timestamp: ev.created_at,
            state: ev.state,
            stage: typeof payload['stage'] === 'string' ? payload['stage'] : ev.state,
            progress_percent:
              typeof payload['progress_percent'] === 'number' ? payload['progress_percent'] : 0,
            message:
              typeof payload['message'] === 'string' ? payload['message'] : ev.event_type,
          };
        }),
        next_cursor: nextCursor,
      };
    });
  }

  /**
   * Transitions a queued/retry_wait job into an active worker state (`preparing`, `rendering`,
   * `encoding`, `verifying`) enforcing `active_job_slots_max` (default 2).
   */
  public transitionJobToActive(
    tenantId: string,
    jobId: string,
    input: {
      state?: 'preparing' | 'rendering' | 'encoding' | 'verifying';
      workerId?: string;
      attemptId?: string;
      now?: Date;
    } = {},
  ): { id: string; state: string; state_version: number; lease_epoch: number } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseExpiresIso = new Date(now.getTime() + 30 * 1000).toISOString();
    const targetState = input.state ?? 'preparing';

    return this.pool.withTransaction({ tenantId, role: 'cve_dispatcher' }, (tx) => {
      const limits = this.getTenantPolicyLimitsInTx(tx);
      const jobs = tx.selectScoped<{
        id: string;
        state: string;
        state_version: number;
        attempt_count: number;
        lease_epoch: number;
      }>('jobs', 'id = ?', [jobId]);
      const job = jobs[0];
      if (!job) {
        throw new ResourceNotFoundError(`Job ${jobId} not found`);
      }

      if (job.state === 'queued' || job.state === 'retry_wait') {
        const activeJobs = tx.selectScoped<{ id: string }>(
          'jobs',
          "state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested')",
          [],
        );
        if (activeJobs.length >= limits.active_job_slots_max) {
          throw new QuotaExceededError(
            `Tenant active job slots limit reached (${activeJobs.length}/${limits.active_job_slots_max})`,
            2,
          );
        }
      }

      const nextStateVersion = job.state_version + 1;
      const nextLeaseEpoch = job.lease_epoch + 1;
      const nextAttemptCount =
        job.state === 'queued' || job.state === 'retry_wait'
          ? job.attempt_count + 1
          : Math.max(1, job.attempt_count);
      const attemptId = input.attemptId ?? `att_${crypto.randomBytes(6).toString('hex')}`;

      tx.updateScoped(
        'jobs',
        {
          state: targetState,
          stage: targetState,
          state_version: nextStateVersion,
          attempt_count: nextAttemptCount,
          active_attempt_id: attemptId,
          lease_epoch: nextLeaseEpoch,
          lease_expires_at: leaseExpiresIso,
          heartbeat_at: nowIso,
          updated_at: nowIso,
        },
        'id = ?',
        [jobId],
      );

      return {
        id: jobId,
        state: targetState,
        state_version: nextStateVersion,
        lease_epoch: nextLeaseEpoch,
      };
    });
  }

  /**
   * Transitions an already-admitted active job (`preparing/rendering/encoding/verifying`)
   * back to `retry_wait` while retaining its existing non-terminal slot and usage reservation
   * without re-running admission rejection (AMB-004).
   */
  public transitionJobToRetryWait(
    tenantId: string,
    jobId: string,
    input: { reason?: string; now?: Date } = {},
  ): { id: string; state: 'retry_wait'; state_version: number; lease_epoch: number } {
    const nowIso = (input.now ?? new Date()).toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_dispatcher' }, (tx) => {
      const jobs = tx.selectScoped<{
        id: string;
        state: string;
        state_version: number;
        lease_epoch: number;
      }>('jobs', 'id = ?', [jobId]);
      const job = jobs[0];
      if (!job) {
        throw new ResourceNotFoundError(`Job ${jobId} not found`);
      }

      const nextStateVersion = job.state_version + 1;
      const nextLeaseEpoch = job.lease_epoch + 1;

      tx.updateScoped(
        'jobs',
        {
          state: 'retry_wait',
          stage: 'retry_wait',
          state_version: nextStateVersion,
          active_attempt_id: null,
          lease_epoch: nextLeaseEpoch,
          lease_expires_at: null,
          updated_at: nowIso,
        },
        'id = ?',
        [jobId],
      );

      const existingEvents = tx.selectScoped<{ event_seq: number }>(
        'job_events',
        'job_id = ?',
        [jobId],
        'event_seq DESC',
      );
      const nextEventSeq = (existingEvents[0]?.event_seq ?? 0) + 1;

      tx.insertScoped('job_events', {
        tenant_id: tenantId,
        job_id: jobId,
        event_seq: nextEventSeq,
        state: 'retry_wait',
        state_version: nextStateVersion,
        event_type: 'job.retry_wait',
        payload_json: JSON.stringify({
          stage: 'retry_wait',
          message: input.reason ?? 'Active attempt failed; job scheduled for retry',
        }),
        created_at: nowIso,
      });

      return {
        id: jobId,
        state: 'retry_wait',
        state_version: nextStateVersion,
        lease_epoch: nextLeaseEpoch,
      };
    });
  }

  public getUsageReservation(
    tenantId: string,
    jobId: string,
  ): {
    job_id: string;
    reserved_vcpu_seconds: number;
    reserved_output_seconds: number;
    state: 'reserved' | 'settled' | 'released';
    created_at: string;
    settled_at: string | null;
  } | null {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        job_id: string;
        reserved_vcpu_seconds: number;
        reserved_output_seconds: number;
        state: 'reserved' | 'settled' | 'released';
        created_at: string;
        settled_at: string | null;
      }>('usage_reservations', 'job_id = ?', [jobId]);
      return rows[0] ?? null;
    });
  }

  public listUsageReservations(
    tenantId: string,
    stateFilter?: 'reserved' | 'settled' | 'released',
  ): Array<{
    job_id: string;
    reserved_vcpu_seconds: number;
    reserved_output_seconds: number;
    state: 'reserved' | 'settled' | 'released';
    created_at: string;
    settled_at: string | null;
  }> {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      if (stateFilter) {
        return tx.selectScoped(
          'usage_reservations',
          'state = ?',
          [stateFilter],
          'created_at ASC',
        );
      }
      return tx.selectScoped('usage_reservations', '1=1', [], 'created_at ASC');
    });
  }

  public listJobAttempts(
    tenantId: string,
    jobId: string,
  ): Array<{
    attempt_id: string;
    job_id: string;
    lease_epoch: number;
    worker_id: string;
    state: string;
    started_at: string;
    heartbeat_at: string;
    lease_expires_at: string;
    ended_at: string | null;
    cpu_seconds: number | null;
    peak_rss_bytes: number | null;
    error: Record<string, unknown> | null;
  }> {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        attempt_id: string;
        job_id: string;
        lease_epoch: number;
        worker_id: string;
        state: string;
        started_at: string;
        heartbeat_at: string;
        lease_expires_at: string;
        ended_at: string | null;
        cpu_seconds: number | null;
        peak_rss_bytes: number | null;
        error_json: string | null;
      }>('job_attempts', 'job_id = ?', [jobId], 'lease_epoch ASC');

      return rows.map((r) => ({
        attempt_id: r.attempt_id,
        job_id: r.job_id,
        lease_epoch: Number(r.lease_epoch),
        worker_id: r.worker_id,
        state: r.state,
        started_at: r.started_at,
        heartbeat_at: r.heartbeat_at,
        lease_expires_at: r.lease_expires_at,
        ended_at: r.ended_at,
        cpu_seconds: r.cpu_seconds !== null ? Number(r.cpu_seconds) : null,
        peak_rss_bytes: r.peak_rss_bytes !== null ? Number(r.peak_rss_bytes) : null,
        error: r.error_json ? (JSON.parse(r.error_json) as Record<string, unknown>) : null,
      }));
    });
  }

  public listJobArtifacts(
    tenantId: string,
    jobId: string,
  ): Array<{
    id: string;
    job_id: string;
    attempt_id: string;
    kind: string;
    mime_type: string;
    sha256: string;
    bytes: number;
    storage_key: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  }> {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      return tx.selectScoped(
        'artifacts',
        'job_id = ?',
        [jobId],
        'created_at ASC, id ASC',
      );
    });
  }

  public listOutboxEvents(
    tenantId: string,
    jobId?: string,
  ): Array<{
    id: string;
    event_type: string;
    job_id: string;
    state_version: number;
    payload: Record<string, unknown>;
    created_at: string;
    processed_at: string | null;
  }> {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = jobId
        ? tx.selectScoped<{
            id: string;
            event_type: string;
            job_id: string;
            state_version: number;
            payload_json: string;
            created_at: string;
            processed_at: string | null;
          }>('outbox', 'job_id = ?', [jobId], 'state_version ASC, created_at ASC')
        : tx.selectScoped<{
            id: string;
            event_type: string;
            job_id: string;
            state_version: number;
            payload_json: string;
            created_at: string;
            processed_at: string | null;
          }>('outbox', '1=1', [], 'created_at ASC, id ASC');

      return rows.map((r) => ({
        id: r.id,
        event_type: r.event_type,
        job_id: r.job_id,
        state_version: Number(r.state_version),
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
        created_at: r.created_at,
        processed_at: r.processed_at,
      }));
    });
  }

  public getOutboxEvents(
    tenantId: string,
    jobId?: string,
  ): Array<{
    id: string;
    event_type: string;
    job_id: string;
    state_version: number;
    payload: Record<string, unknown>;
    created_at: string;
    processed_at: string | null;
  }> {
    return this.listOutboxEvents(tenantId, jobId);
  }

  public listUsageEntries(
    tenantId: string,
    filterOrJobId?: string | UsageEntriesFilter,
  ): Array<UsageEntryRecord> {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];

      if (typeof filterOrJobId === 'string') {
        conditions.push('job_id = ?');
        params.push(filterOrJobId);
      } else if (filterOrJobId && typeof filterOrJobId === 'object') {
        if (filterOrJobId.jobId) {
          conditions.push('job_id = ?');
          params.push(filterOrJobId.jobId);
        }
        if (filterOrJobId.from) {
          conditions.push('created_at >= ?');
          params.push(filterOrJobId.from);
        }
        if (filterOrJobId.to) {
          conditions.push('created_at <= ?');
          params.push(filterOrJobId.to);
        }
        if (filterOrJobId.usageClass) {
          conditions.push('usage_class = ?');
          params.push(filterOrJobId.usageClass);
        }
        if (filterOrJobId.meter) {
          conditions.push('meter = ?');
          params.push(filterOrJobId.meter);
        }
      }

      const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
      const rows = tx.selectScoped<{
        id: string;
        job_id: string;
        attempt_id: string | null;
        usage_class: string;
        meter: string;
        ledger_version: number;
        quantity: number;
        rate_version: string;
        reason: string | null;
        created_at: string;
      }>('usage_entries', whereClause, params, 'created_at ASC, ledger_version ASC');

      return rows.map((r) => ({
        ...r,
        ledger_version: Number(r.ledger_version),
        quantity: Number(r.quantity),
      }));
    });
  }

  public setWebhookEndpointState(
    tenantId: string,
    endpointId: string,
    state: 'pending_verification' | 'active' | 'disabled',
    now = new Date(),
  ): void {
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const updated = tx.updateScoped(
        'webhook_endpoints',
        { state, updated_at: now.toISOString() },
        'id = ?',
        [endpointId],
      );
      if (updated === 0) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }
    });
  }

  public verifyWebhookEndpoint(
    tenantId: string,
    endpointId: string,
    now = new Date(),
  ): { id: string; state: 'active' } {
    this.setWebhookEndpointState(tenantId, endpointId, 'active', now);
    return { id: endpointId, state: 'active' };
  }

  public initiateWebhookChallenge(
    tenantId: string,
    endpointId: string,
    now = new Date(),
  ): { challengeToken: string; expiresAt: string } {
    const challengeToken = crypto.randomBytes(32).toString('hex');
    const challengeHash = crypto.createHash('sha256').update(challengeToken).digest('hex');
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{ id: string; state: string }>(
        'webhook_endpoints',
        'id = ?',
        [endpointId],
      );
      const ep = rows[0];
      if (!ep) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }
      if (ep.state === 'disabled') {
        throw new WebhookNotVerifiedError(`Webhook endpoint ${endpointId} is disabled`);
      }

      tx.updateScoped(
        'webhook_endpoints',
        {
          challenge_token_hash: challengeHash,
          challenge_expires_at: expiresAt,
          updated_at: now.toISOString(),
        },
        'id = ?',
        [endpointId],
      );
    });

    return { challengeToken, expiresAt };
  }

  public confirmWebhookChallenge(
    tenantId: string,
    endpointId: string,
    echoedChallenge: string,
    now = new Date(),
  ): { id: string; state: 'active' } {
    const nowIso = now.toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        state: string;
        challenge_token_hash: string | null;
        challenge_expires_at: string | null;
      }>('webhook_endpoints', 'id = ?', [endpointId]);

      const ep = rows[0];
      if (!ep) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }
      if (ep.state === 'disabled') {
        throw new WebhookNotVerifiedError(`Webhook endpoint ${endpointId} is disabled`);
      }
      if (!ep.challenge_token_hash || !ep.challenge_expires_at) {
        throw new WebhookNotVerifiedError(`Webhook endpoint ${endpointId} has no pending challenge`);
      }
      if (now.getTime() > Date.parse(ep.challenge_expires_at)) {
        throw new ChallengeExpiredError(`Webhook challenge for ${endpointId} has expired`);
      }

      const expectedHash = ep.challenge_token_hash;
      const actualHash = crypto.createHash('sha256').update(echoedChallenge).digest('hex');

      const expectedBuf = Buffer.from(expectedHash, 'utf8');
      const actualBuf = Buffer.from(actualHash, 'utf8');
      const isMatch = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!isMatch) {
        throw new WebhookNotVerifiedError('Challenge token verification failed: challenge does not match');
      }

      tx.updateScoped(
        'webhook_endpoints',
        {
          state: 'active',
          challenge_token_hash: null,
          challenge_expires_at: null,
          updated_at: nowIso,
        },
        'id = ?',
        [endpointId],
      );

      return { id: endpointId, state: 'active' };
    });
  }

  public registerSceneBundle(
    tenantId: string,
    input: {
      bundleId: string;
      revision?: number;
      name?: string;
      status?: 'draft' | 'approved' | 'revoked' | 'disabled';
      securityGateDigest?: string | null;
      now?: Date;
    },
  ): { bundle_id: string; revision: number; status: string } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const revision = input.revision ?? 1;
    const status = input.status ?? 'approved';

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('scene_bundles', {
        tenant_id: tenantId,
        id: input.bundleId,
        name: input.name ?? input.bundleId,
        current_revision: revision,
        status,
        created_at: nowIso,
        updated_at: nowIso,
      });

      tx.insertScoped('scene_bundle_revisions', {
        tenant_id: tenantId,
        bundle_id: input.bundleId,
        revision,
        source_sha256: 'a'.repeat(64),
        build_sha256: 'b'.repeat(64),
        entrypoint: 'index.js',
        parameters_schema: '{}',
        capabilities_json: '["custom-html-v1"]',
        security_gate_digest:
          input.securityGateDigest === undefined ? 'c'.repeat(64) : input.securityGateDigest,
        runtime_pin: 'chromium-130.0.6723.69',
        created_at: nowIso,
      });

      return { bundle_id: input.bundleId, revision, status };
    });
  }

  public listJobs(
    tenantId: string,
    options: { kind?: string; state?: string; limit?: number; cursor?: string } = {},
  ): {
    data: Array<{
      id: string;
      kind: string;
      state: string;
      state_version: number;
      composition_id: string;
      revision: number;
      profile: string;
      created_at: string;
      status_url: string;
    }>;
    next_cursor: string | null;
  } {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const filterHash = `${options.kind ?? ''}:${options.state ?? ''}`;
    let decodedCursor: { createdAt: string; id: string } | null = null;
    if (options.cursor) {
      decodedCursor = decodeSignedCursor({
        cursor: options.cursor,
        tenantId,
        route: '/v1/jobs',
        filterHash,
        secret: this.pepper,
      });
      if (!decodedCursor) {
        throw new InvalidCursorError();
      }
    }

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const clauses: string[] = ['1=1'];
      const params: Array<string | number | null> = [];
      if (options.kind) {
        clauses.push('kind = ?');
        params.push(options.kind);
      }
      if (options.state) {
        clauses.push('state = ?');
        params.push(options.state);
      }

      const allJobs = tx.selectScoped<{
        id: string;
        kind: string;
        state: string;
        state_version: number;
        composition_id: string;
        composition_revision: number;
        profile: string;
        created_at: string;
      }>('jobs', clauses.join(' AND '), params, 'created_at DESC, id DESC');

      const filtered = decodedCursor
        ? allJobs.filter(
            (j) =>
              j.created_at < decodedCursor.createdAt ||
              (j.created_at === decodedCursor.createdAt && j.id < decodedCursor.id),
          )
        : allJobs;

      const slice = filtered.slice(0, limit);
      const hasMore = filtered.length > limit;
      const lastItem = slice[slice.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? encodeSignedCursor({
              tenantId,
              route: '/v1/jobs',
              filterHash,
              createdAt: lastItem.created_at,
              id: lastItem.id,
              secret: this.pepper,
            })
          : null;

      return {
        data: slice.map((j) => ({
          id: j.id,
          kind: j.kind,
          state: j.state,
          state_version: j.state_version,
          composition_id: j.composition_id,
          revision: j.composition_revision,
          profile: j.profile,
          created_at: j.created_at,
          status_url: `/v1/jobs/${j.id}`,
        })),
        next_cursor: nextCursor,
      };
    });
  }

  public getArtifact(
    tenantId: string,
    artifactId: string,
  ): {
    id: string;
    job_id: string;
    attempt_id: string;
    kind: string;
    filename: string;
    mime_type: string;
    sha256: string;
    bytes: number;
    storage_key: string;
    expires_at: string;
    revoked_at: string | null;
    created_at: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        job_id: string;
        attempt_id: string;
        kind: string;
        filename: string;
        mime_type: string;
        sha256: string;
        bytes: number;
        storage_key: string;
        expires_at: string;
        revoked_at: string | null;
        created_at: string;
      }>('artifacts', 'id = ?', [artifactId]);

      const art = rows[0];
      if (!art) {
        throw new ResourceNotFoundError(`Artifact ${artifactId} not found`);
      }
      return art;
    });
  }

  public getArtifactDownloadGrant(
    tenantId: string,
    artifactId: string,
    now = new Date(),
    baseUrl?: string,
  ): {
    url: string;
    expires_at: string;
    sha256: string;
    bytes: number;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        job_id: string;
        kind: string;
        filename: string;
        mime_type: string;
        sha256: string;
        bytes: number;
        storage_key: string;
        expires_at: string;
        revoked_at: string | null;
      }>('artifacts', 'id = ?', [artifactId]);

      const art = rows[0];
      if (!art || art.revoked_at !== null || Date.parse(art.expires_at) <= now.getTime()) {
        throw new ResourceNotFoundError(`Artifact ${artifactId} not found`);
      }

      if (baseUrl) {
        const derivedFilename =
          art.storage_key.split('/').pop() ||
          `${art.kind}.${art.mime_type === 'application/json' ? 'json' : art.mime_type === 'text/vtt' ? 'vtt' : art.mime_type === 'image/png' ? 'png' : 'mp4'}`;
        const grant = generateSignedArtifactDownloadGrant(
          {
            tenantId,
            artifactId: art.id,
            jobId: art.job_id,
            storageKey: art.storage_key,
            filename: derivedFilename,
            mimeType: art.mime_type,
            sha256: art.sha256,
            bytes: art.bytes,
            ttlSeconds: 300,
          },
          {
            pepper: this.pepper,
            baseUrl,
            now,
          },
        );
        return {
          url: grant.downloadUrl,
          expires_at: grant.expiresAt,
          sha256: grant.sha256,
          bytes: grant.bytes,
        };
      }

      const grantExpiresIso = new Date(now.getTime() + 300 * 1000).toISOString();
      const tokenSig = crypto
        .createHmac('sha256', Buffer.from(this.pepper, 'utf8'))
        .update(`${tenantId}:${art.id}:${grantExpiresIso}`, 'utf8')
        .digest('hex')
        .slice(0, 32);

      return {
        url: `https://storage.example.invalid/${art.storage_key}?grant=${tokenSig}`,
        expires_at: grantExpiresIso,
        sha256: art.sha256,
        bytes: art.bytes,
      };
    });
  }

  public createWebhookEndpoint(
    tenantId: string,
    input: {
      id: string;
      url: string;
      events: string[];
      now?: Date;
    },
  ): {
    id: string;
    url: string;
    state: 'pending_verification';
    signing_secret: string;
    events: string[];
    created_at: string;
  } {
    const nowIso = (input.now ?? new Date()).toISOString();
    const signingSecret = generateWebhookSecret();
    const secretCiphertext = encryptSecretAtRest(signingSecret, this.masterKey);
    const events = (input.events && input.events.length > 0)
      ? input.events
      : ['job.succeeded', 'job.failed', 'job.canceled'];

    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('webhook_endpoints', {
        tenant_id: tenantId,
        id: input.id,
        url: input.url,
        state: 'pending_verification',
        events_filter_json: JSON.stringify(events),
        active_key_id: 'whk_1',
        secret_ciphertext: secretCiphertext,
        prev_key_id: null,
        prev_secret_ciphertext: null,
        prev_secret_expires_at: null,
        challenge_token_hash: null,
        challenge_expires_at: null,
        created_at: nowIso,
        updated_at: nowIso,
        last_delivery_at: null,
      });
    });

    return {
      id: input.id,
      url: input.url,
      state: 'pending_verification',
      signing_secret: signingSecret,
      events: [...events],
      created_at: nowIso,
    };
  }

  public getWebhookEndpoint(
    tenantId: string,
    endpointId: string,
  ): {
    id: string;
    url: string;
    state: string;
    events: string[];
    created_at: string;
    last_delivery_at: string | null;
    delivery_summary?: {
      total: number;
      delivered: number;
      queued: number;
      failed: number;
      dead_letter: number;
    };
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        url: string;
        state: string;
        events_filter_json: string;
        created_at: string;
        last_delivery_at: string | null;
      }>('webhook_endpoints', 'id = ?', [endpointId]);

      const ep = rows[0];
      if (!ep) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }

      const deliveries = tx.selectScoped<{ state: string }>(
        'webhook_deliveries',
        'endpoint_id = ?',
        [endpointId],
      );

      let delivered = 0;
      let queued = 0;
      let failed = 0;
      let dead_letter = 0;

      for (const d of deliveries) {
        if (d.state === 'delivered') delivered++;
        else if (d.state === 'queued') queued++;
        else if (d.state === 'failed') failed++;
        else if (d.state === 'dead_letter') dead_letter++;
      }

      return {
        id: ep.id,
        url: ep.url,
        state: ep.state,
        events: JSON.parse(ep.events_filter_json) as string[],
        created_at: ep.created_at,
        last_delivery_at: ep.last_delivery_at,
        delivery_summary: {
          total: deliveries.length,
          delivered,
          queued,
          failed,
          dead_letter,
        },
      };
    });
  }

  public rotateWebhookSecret(
    tenantId: string,
    endpointId: string,
    now = new Date(),
  ): {
    id: string;
    active_key_id: string;
    signing_secret: string;
    prev_key_id: string;
    prev_secret_expires_at: string;
  } {
    const nowIso = now.toISOString();
    const prevSecretExpiresAt = new Date(now.getTime() + 24 * 3600 * 1000).toISOString(); // 24h grace period
    const newSigningSecret = generateWebhookSecret();
    const newSecretCiphertext = encryptSecretAtRest(newSigningSecret, this.masterKey);

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<WebhookEndpointRecord>(
        'webhook_endpoints',
        'id = ?',
        [endpointId],
      );
      const ep = rows[0];
      if (!ep) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }
      if (ep.state === 'disabled') {
        throw new WebhookNotVerifiedError(`Webhook endpoint ${endpointId} is disabled`);
      }

      const match = /^whk_(\d+)$/.exec(ep.active_key_id);
      const nextNum = match ? parseInt(match[1]!, 10) + 1 : 2;
      const nextKeyId = `whk_${nextNum}`;

      tx.updateScoped(
        'webhook_endpoints',
        {
          active_key_id: nextKeyId,
          secret_ciphertext: newSecretCiphertext,
          prev_key_id: ep.active_key_id,
          prev_secret_ciphertext: ep.secret_ciphertext,
          prev_secret_expires_at: prevSecretExpiresAt,
          updated_at: nowIso,
        },
        'id = ?',
        [endpointId],
      );

      return {
        id: endpointId,
        active_key_id: nextKeyId,
        signing_secret: newSigningSecret,
        prev_key_id: ep.active_key_id,
        prev_secret_expires_at: prevSecretExpiresAt,
      };
    });
  }

  public deleteWebhookEndpoint(
    tenantId: string,
    endpointId: string,
    now = new Date(),
  ): void {
    const nowIso = now.toISOString();
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const updated = tx.updateScoped(
        'webhook_endpoints',
        { state: 'disabled', updated_at: nowIso },
        'id = ?',
        [endpointId],
      );
      if (updated === 0) {
        throw new ResourceNotFoundError(`Webhook endpoint ${endpointId} not found`);
      }

      // "Endpoint bị xóa thì không gửi tiếp": cancel all queued deliveries for this endpoint
      tx.updateScoped(
        'webhook_deliveries',
        { state: 'dead_letter', updated_at: nowIso },
        'endpoint_id = ? AND state = ?',
        [endpointId, 'queued'],
      );
    });
  }

  public listWebhookDeliveries(
    tenantId: string,
    options: {
      jobId?: string;
      endpointId?: string;
      state?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): {
    data: Array<{
      id: string;
      endpoint_id: string;
      outbox_event_id: string;
      job_id: string;
      state: string;
      attempt_count: number;
      next_attempt_at: string | null;
      deadline_at: string;
      last_http_status: number | null;
      replay_count_today: number;
      created_at: string;
      updated_at: string;
    }>;
    next_cursor: string | null;
  } {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const clauses: string[] = ['1=1'];
      const params: any[] = [];

      if (options.jobId) {
        clauses.push('job_id = ?');
        params.push(options.jobId);
      }
      if (options.endpointId) {
        clauses.push('endpoint_id = ?');
        params.push(options.endpointId);
      }
      if (options.state) {
        clauses.push('state = ?');
        params.push(options.state);
      }

      const rows = tx.selectScoped<WebhookDeliveryRecord>(
        'webhook_deliveries',
        clauses.join(' AND '),
        params,
        'created_at DESC, id DESC',
      );

      const pageRows = rows.slice(0, limit);
      return {
        data: pageRows.map((r) => ({
          id: r.id,
          endpoint_id: r.endpoint_id,
          outbox_event_id: r.outbox_event_id,
          job_id: r.job_id,
          state: r.state,
          attempt_count: Number(r.attempt_count),
          next_attempt_at: r.next_attempt_at,
          deadline_at: r.deadline_at,
          last_http_status: r.last_http_status !== null ? Number(r.last_http_status) : null,
          replay_count_today: Number(r.replay_count_today),
          created_at: r.created_at,
          updated_at: r.updated_at,
        })),
        next_cursor: null,
      };
    });
  }

  public getWebhookDelivery(
    tenantId: string,
    deliveryId: string,
  ): {
    id: string;
    endpoint_id: string;
    outbox_event_id: string;
    job_id: string;
    state: string;
    attempt_count: number;
    next_attempt_at: string | null;
    deadline_at: string;
    last_http_status: number | null;
    replay_count_today: number;
    created_at: string;
    updated_at: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<WebhookDeliveryRecord>(
        'webhook_deliveries',
        'id = ?',
        [deliveryId],
      );
      const delivery = rows[0];
      if (!delivery) {
        throw new ResourceNotFoundError(`Webhook delivery ${deliveryId} not found`);
      }
      return {
        id: delivery.id,
        endpoint_id: delivery.endpoint_id,
        outbox_event_id: delivery.outbox_event_id,
        job_id: delivery.job_id,
        state: delivery.state,
        attempt_count: Number(delivery.attempt_count),
        next_attempt_at: delivery.next_attempt_at,
        deadline_at: delivery.deadline_at,
        last_http_status: delivery.last_http_status !== null ? Number(delivery.last_http_status) : null,
        replay_count_today: Number(delivery.replay_count_today),
        created_at: delivery.created_at,
        updated_at: delivery.updated_at,
      };
    });
  }

  public replayWebhookDelivery(
    tenantId: string,
    deliveryId: string,
    now = new Date(),
  ): {
    id: string;
    state: 'queued';
    replay_count_today: number;
    outbox_event_id: string;
  } {
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const deliveries = tx.selectScoped<WebhookDeliveryRecord>(
        'webhook_deliveries',
        'id = ?',
        [deliveryId],
      );
      const delivery = deliveries[0];
      if (!delivery) {
        throw new ResourceNotFoundError(`Webhook delivery ${deliveryId} not found`);
      }

      // 1. Check 7-day retention limit: docs/API.md line 151
      const createdAtMs = Date.parse(delivery.created_at);
      if (nowMs - createdAtMs > WEBHOOK_REPLAY_RETENTION_MS) {
        throw new DeliveryExpiredError(
          `Webhook delivery ${deliveryId} expired (> 7 days since creation); reconcile via GET /jobs/{id}`,
        );
      }

      // Check calendar day rollover for daily quota (resets each calendar day)
      const lastUpdatedMs = Date.parse(delivery.updated_at);
      const lastDate = new Date(lastUpdatedMs).toISOString().slice(0, 10);
      const currentDate = now.toISOString().slice(0, 10);
      const replayCountToday = currentDate === lastDate ? Number(delivery.replay_count_today) : 0;

      // 2. Check daily replay limit (<= 5 per day): docs/API.md line 151
      if (replayCountToday >= MAX_REPLAYS_PER_DAY) {
        throw new ReplayQuotaExceededError(
          `Daily replay limit of ${MAX_REPLAYS_PER_DAY} exceeded for delivery ${deliveryId}`,
        );
      }

      // 3. Check endpoint not disabled: "Endpoint bị xóa thì không gửi tiếp"
      const endpoints = tx.selectScoped<WebhookEndpointRecord>(
        'webhook_endpoints',
        'id = ?',
        [delivery.endpoint_id],
      );
      const endpoint = endpoints[0];
      if (!endpoint || endpoint.state === 'disabled') {
        throw new WebhookNotVerifiedError(
          `Webhook endpoint ${delivery.endpoint_id} is disabled; cannot replay delivery`,
        );
      }

      // 4. Update delivery record to queued with same outbox_event_id
      const nextReplayCount = replayCountToday + 1;
      const newDeadlineIso = new Date(nowMs + MAX_DELIVERY_DEADLINE_MS).toISOString();

      tx.updateScoped(
        'webhook_deliveries',
        {
          state: 'queued',
          attempt_count: 0,
          next_attempt_at: nowIso,
          deadline_at: newDeadlineIso,
          last_http_status: null,
          replay_count_today: nextReplayCount,
          updated_at: nowIso,
        },
        'id = ?',
        [deliveryId],
      );

      return {
        id: delivery.id,
        state: 'queued',
        replay_count_today: nextReplayCount,
        outbox_event_id: delivery.outbox_event_id,
      };
    });
  }

  public getUsageSummary(
    tenantId: string,
    fromIso: string,
    toIso: string,
  ): UsageSummaryResponse {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      // 1. Fetch usage entries in the specified time window
      const entries = tx.selectScoped<{
        id: string;
        job_id: string;
        attempt_id: string | null;
        usage_class: string;
        meter: string;
        ledger_version: number;
        quantity: number;
        reason: string | null;
        created_at: string;
      }>(
        'usage_entries',
        'created_at >= ? AND created_at <= ?',
        [fromIso, toIso],
        'created_at ASC',
      );

      // 2. Fetch reservations relevant to the window or currently active
      const reservations = tx.selectScoped<{
        job_id: string;
        reserved_vcpu_seconds: number;
        reserved_output_seconds: number;
        state: 'reserved' | 'settled' | 'released';
        created_at: string;
        settled_at: string | null;
      }>(
        'usage_reservations',
        '(created_at >= ? AND created_at <= ?) OR (settled_at >= ? AND settled_at <= ?) OR state = ?',
        [fromIso, toIso, fromIso, toIso, 'reserved'],
      );

      // 3. Collect all referenced job IDs to inspect final terminal state and kind
      const referencedJobIds = Array.from(
        new Set([
          ...entries.map((e) => e.job_id),
          ...reservations.map((r) => r.job_id),
        ]),
      );

      const jobMap = new Map<
        string,
        { id: string; kind: 'render' | 'preview'; state: string; completed_at: string | null }
      >();
      for (const jid of referencedJobIds) {
        const jrows = tx.selectScoped<{
          id: string;
          kind: 'render' | 'preview';
          state: string;
          completed_at: string | null;
        }>('jobs', 'id = ?', [jid]);
        if (jrows[0]) {
          jobMap.set(jid, jrows[0]);
        }
      }

      // Also include jobs created or completed in this window that might have been canceled before claim
      const jobsInWindow = tx.selectScoped<{
        id: string;
        kind: 'render' | 'preview';
        state: string;
        completed_at: string | null;
      }>(
        'jobs',
        '(created_at >= ? AND created_at <= ?) OR (completed_at >= ? AND completed_at <= ?)',
        [fromIso, toIso, fromIso, toIso],
      );
      for (const j of jobsInWindow) {
        if (!jobMap.has(j.id)) {
          jobMap.set(j.id, j);
        }
      }

      // 4. Summarize usage metrics
      let operationalAttempts = 0;
      let operationalCpuSeconds = 0;
      let billableMinutes = 0;
      let renderJobsCount = 0;
      let previewJobsCount = 0;
      const countedRenderJobs = new Set<string>();
      const countedPreviewJobs = new Set<string>();

      const canceledUnits = {
        jobs_count: 0,
        attempts_count: 0,
        operational_cpu_seconds: 0,
        released_output_seconds: 0,
        billable_output_minutes: 0,
      };

      const failedUnits = {
        jobs_count: 0,
        attempts_count: 0,
        operational_cpu_seconds: 0,
        released_output_seconds: 0,
        billable_output_minutes: 0,
      };

      const succeededUnits = {
        jobs_count: 0,
        attempts_count: 0,
        operational_cpu_seconds: 0,
        settled_output_seconds: 0,
        billable_output_minutes: 0,
      };

      const billableEntriesByJob = new Map<string, number>();
      const doubleDebitJobIds = new Set<string>();

      for (const e of entries) {
        const qty = Number(e.quantity);
        const job = jobMap.get(e.job_id);

        if (e.usage_class === 'operational' && e.meter === 'cpu_seconds') {
          operationalAttempts += 1;
          operationalCpuSeconds += qty;

          if (job?.state === 'canceled') {
            canceledUnits.attempts_count += 1;
            canceledUnits.operational_cpu_seconds += qty;
          } else if (job?.state === 'failed') {
            failedUnits.attempts_count += 1;
            failedUnits.operational_cpu_seconds += qty;
          } else if (job?.state === 'succeeded') {
            succeededUnits.attempts_count += 1;
            succeededUnits.operational_cpu_seconds += qty;
          }
        } else if (
          (e.usage_class === 'billable' || e.usage_class === 'compensating') &&
          e.meter === 'billable_output_minutes'
        ) {
          billableMinutes += qty;

          if (e.usage_class === 'billable') {
            const currentCount = (billableEntriesByJob.get(e.job_id) ?? 0) + 1;
            billableEntriesByJob.set(e.job_id, currentCount);
            if (currentCount > 1) {
              doubleDebitJobIds.add(e.job_id);
            }

            if (job?.kind === 'preview') {
              if (!countedPreviewJobs.has(e.job_id)) {
                countedPreviewJobs.add(e.job_id);
                previewJobsCount += 1;
              }
            } else {
              if (!countedRenderJobs.has(e.job_id)) {
                countedRenderJobs.add(e.job_id);
                renderJobsCount += 1;
              }
            }

            if (job?.state === 'succeeded' || !job) {
              succeededUnits.billable_output_minutes += qty;
            }
          }
        }
      }

      // Count distinct jobs by outcome
      for (const job of jobMap.values()) {
        if (job.state === 'succeeded') {
          succeededUnits.jobs_count += 1;
        } else if (job.state === 'failed') {
          failedUnits.jobs_count += 1;
        } else if (job.state === 'canceled') {
          canceledUnits.jobs_count += 1;
        }
      }

      // 5. Reservation metrics
      let pendingCount = 0;
      let pendingVcpu = 0;
      let pendingOutput = 0;
      let settledCount = 0;
      let releasedCount = 0;

      for (const r of reservations) {
        const vcpu = Number(r.reserved_vcpu_seconds);
        const outSec = Number(r.reserved_output_seconds);

        if (r.state === 'reserved') {
          pendingCount += 1;
          pendingVcpu += vcpu;
          pendingOutput += outSec;
        } else if (r.state === 'settled') {
          settledCount += 1;
          succeededUnits.settled_output_seconds += outSec;
        } else if (r.state === 'released') {
          releasedCount += 1;
          const job = jobMap.get(r.job_id);
          if (job?.state === 'canceled') {
            canceledUnits.released_output_seconds += outSec;
          } else if (job?.state === 'failed') {
            failedUnits.released_output_seconds += outSec;
          } else {
            canceledUnits.released_output_seconds += outSec;
          }
        }
      }

      const roundedMinutes = Number(billableMinutes.toFixed(6));
      const roundedCpuSec = Number(operationalCpuSeconds.toFixed(6));
      const roundedEstimatedCost = Number((roundedMinutes * 0.05).toFixed(6));

      canceledUnits.operational_cpu_seconds = Number(canceledUnits.operational_cpu_seconds.toFixed(6));
      canceledUnits.released_output_seconds = Number(canceledUnits.released_output_seconds.toFixed(6));
      failedUnits.operational_cpu_seconds = Number(failedUnits.operational_cpu_seconds.toFixed(6));
      failedUnits.released_output_seconds = Number(failedUnits.released_output_seconds.toFixed(6));
      succeededUnits.operational_cpu_seconds = Number(succeededUnits.operational_cpu_seconds.toFixed(6));
      succeededUnits.settled_output_seconds = Number(succeededUnits.settled_output_seconds.toFixed(6));
      succeededUnits.billable_output_minutes = Number(succeededUnits.billable_output_minutes.toFixed(6));

      // 6. Reconciliation analysis
      const discrepancies: string[] = [];
      if (doubleDebitJobIds.size > 0) {
        for (const jid of doubleDebitJobIds) {
          discrepancies.push(`Job ${jid} has multiple billable output minute entries (double debit detected)`);
        }
      }
      for (const e of entries) {
        if (e.usage_class === 'billable' && e.meter === 'billable_output_minutes' && Number(e.quantity) > 0) {
          const job = jobMap.get(e.job_id);
          if (job && (job.state === 'canceled' || job.state === 'failed')) {
            discrepancies.push(`Job ${e.job_id} is in terminal state '${job.state}' but has billable output minutes entry`);
          }
        }
      }

      return {
        from: fromIso,
        to: toIso,
        operational_attempts: operationalAttempts,
        billable_output_minutes: roundedMinutes,
        estimated_cost: roundedEstimatedCost,
        currency: 'USD',
        operational_cpu_seconds: roundedCpuSec,
        billable_jobs: renderJobsCount,
        preview_jobs: previewJobsCount,
        reservations: {
          pending_count: pendingCount,
          pending_vcpu_seconds: Number(pendingVcpu.toFixed(6)),
          pending_output_seconds: Number(pendingOutput.toFixed(6)),
          settled_count: settledCount,
          released_count: releasedCount,
        },
        canceled_units: canceledUnits,
        failed_units: failedUnits,
        succeeded_units: succeededUnits,
        reconciliation: {
          clean: discrepancies.length === 0,
          double_debit_detected: doubleDebitJobIds.size > 0,
          discrepancies,
        },
      };
    });
  }

  public reconcileUsage(
    tenantId: string,
    options: { from?: string; to?: string } = {},
  ): UsageReconciliationReport {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const nowIso = new Date().toISOString();
      const whereConditions: string[] = ['1=1'];
      const params: (string | number | null)[] = [];
      if (options.from) {
        whereConditions.push('created_at >= ?');
        params.push(options.from);
      }
      if (options.to) {
        whereConditions.push('created_at <= ?');
        params.push(options.to);
      }
      const whereClause = whereConditions.join(' AND ');

      const jobs = tx.selectScoped<{
        id: string;
        kind: 'render' | 'preview';
        state: string;
        attempt_count: number;
        created_at: string;
        completed_at: string | null;
      }>('jobs', whereClause, params, 'created_at ASC');

      const reservations = tx.selectScoped<{
        job_id: string;
        reserved_vcpu_seconds: number;
        reserved_output_seconds: number;
        state: 'reserved' | 'settled' | 'released';
        created_at: string;
        settled_at: string | null;
      }>('usage_reservations', '1=1', []);

      const reservationMap = new Map<
        string,
        {
          reserved_vcpu_seconds: number;
          reserved_output_seconds: number;
          state: 'reserved' | 'settled' | 'released';
        }
      >();
      for (const r of reservations) {
        reservationMap.set(r.job_id, r);
      }

      const entries = tx.selectScoped<{
        id: string;
        job_id: string;
        attempt_id: string | null;
        usage_class: string;
        meter: string;
        ledger_version: number;
        quantity: number;
        created_at: string;
      }>('usage_entries', '1=1', []);

      const entriesByJob = new Map<
        string,
        Array<{
          id: string;
          attempt_id: string | null;
          usage_class: string;
          meter: string;
          ledger_version: number;
          quantity: number;
        }>
      >();
      for (const e of entries) {
        const list = entriesByJob.get(e.job_id) ?? [];
        list.push(e);
        entriesByJob.set(e.job_id, list);
      }

      const discrepancies: UsageReconciliationReport['discrepancies'] = [];
      let succeededJobsCount = 0;
      let failedJobsCount = 0;
      let canceledJobsCount = 0;
      let nonTerminalJobsCount = 0;
      let settledReservationsCount = 0;
      let releasedReservationsCount = 0;
      let pendingReservationsCount = 0;
      let totalBillableOutputMinutes = 0;
      let totalOperationalCpuSeconds = 0;

      for (const job of jobs) {
        const jobEntries = entriesByJob.get(job.id) ?? [];
        const res = reservationMap.get(job.id);

        const billableEntries = jobEntries.filter(
          (e) =>
            (e.usage_class === 'billable' || e.usage_class === 'compensating') &&
            e.meter === 'billable_output_minutes',
        );
        const operationalCpuEntries = jobEntries.filter(
          (e) => e.usage_class === 'operational' && e.meter === 'cpu_seconds',
        );

        for (const b of billableEntries) {
          totalBillableOutputMinutes += Number(b.quantity);
        }
        for (const o of operationalCpuEntries) {
          totalOperationalCpuSeconds += Number(o.quantity);
        }

        if (res) {
          if (res.state === 'settled') settledReservationsCount += 1;
          else if (res.state === 'released') releasedReservationsCount += 1;
          else if (res.state === 'reserved') pendingReservationsCount += 1;
        }

        if (job.state === 'succeeded') {
          succeededJobsCount += 1;
          if (job.kind === 'render') {
            const rawBillable = jobEntries.filter(
              (e) => e.usage_class === 'billable' && e.meter === 'billable_output_minutes',
            );
            if (rawBillable.length > 1) {
              discrepancies.push({
                type: 'DOUBLE_DEBIT',
                job_id: job.id,
                message: `Job ${job.id} has ${rawBillable.length} billable output minute entries (double debit)`,
              });
            } else if (rawBillable.length === 0) {
              discrepancies.push({
                type: 'MISSING_BILLABLE_ENTRY',
                job_id: job.id,
                message: `Succeeded render job ${job.id} has no billable output minutes entry`,
              });
            }
          }
          if (res && res.state !== 'settled') {
            discrepancies.push({
              type: 'RESERVATION_STATE_MISMATCH',
              job_id: job.id,
              message: `Succeeded job ${job.id} has reservation in state '${res.state}', expected 'settled'`,
            });
          }
        } else if (job.state === 'failed') {
          failedJobsCount += 1;
          const positiveBillable = jobEntries.filter(
            (e) =>
              e.usage_class === 'billable' &&
              e.meter === 'billable_output_minutes' &&
              Number(e.quantity) > 0,
          );
          if (positiveBillable.length > 0) {
            discrepancies.push({
              type: 'UNEXPECTED_BILLABLE_ENTRY',
              job_id: job.id,
              message: `Failed job ${job.id} has positive billable entry ${positiveBillable[0]?.id ?? 'unknown'}`,
            });
          }
          if (res && res.state !== 'released') {
            discrepancies.push({
              type: 'RESERVATION_STATE_MISMATCH',
              job_id: job.id,
              message: `Failed job ${job.id} has reservation in state '${res.state}', expected 'released'`,
            });
          }
        } else if (job.state === 'canceled') {
          canceledJobsCount += 1;
          const positiveBillable = jobEntries.filter(
            (e) =>
              e.usage_class === 'billable' &&
              e.meter === 'billable_output_minutes' &&
              Number(e.quantity) > 0,
          );
          if (positiveBillable.length > 0) {
            discrepancies.push({
              type: 'UNEXPECTED_BILLABLE_ENTRY',
              job_id: job.id,
              message: `Canceled job ${job.id} has positive billable entry ${positiveBillable[0]?.id ?? 'unknown'}`,
            });
          }
          if (res && res.state !== 'released') {
            discrepancies.push({
              type: 'RESERVATION_STATE_MISMATCH',
              job_id: job.id,
              message: `Canceled job ${job.id} has reservation in state '${res.state}', expected 'released'`,
            });
          }
        } else {
          // non-terminal
          nonTerminalJobsCount += 1;
          const positiveBillable = jobEntries.filter(
            (e) =>
              e.usage_class === 'billable' &&
              e.meter === 'billable_output_minutes' &&
              Number(e.quantity) > 0,
          );
          if (positiveBillable.length > 0) {
            discrepancies.push({
              type: 'UNEXPECTED_BILLABLE_ENTRY',
              job_id: job.id,
              message: `Non-terminal job ${job.id} (state: ${job.state}) has billable entry before completion`,
            });
          }
          if (res && res.state !== 'reserved') {
            discrepancies.push({
              type: 'RESERVATION_STATE_MISMATCH',
              job_id: job.id,
              message: `Non-terminal job ${job.id} has reservation in state '${res.state}', expected 'reserved'`,
            });
          }
        }
      }

      return {
        clean: discrepancies.length === 0,
        tenant_id: tenantId,
        evaluated_at: nowIso,
        summary: {
          succeeded_jobs_count: succeededJobsCount,
          failed_jobs_count: failedJobsCount,
          canceled_jobs_count: canceledJobsCount,
          non_terminal_jobs_count: nonTerminalJobsCount,
          settled_reservations_count: settledReservationsCount,
          released_reservations_count: releasedReservationsCount,
          pending_reservations_count: pendingReservationsCount,
          total_billable_output_minutes: Number(totalBillableOutputMinutes.toFixed(6)),
          total_operational_cpu_seconds: Number(totalOperationalCpuSeconds.toFixed(6)),
        },
        discrepancies,
      };
    });
  }

  public insertCompensatingUsageEntry(
    tenantId: string,
    input: CompensatingUsageEntryInput,
  ): {
    id: string;
    job_id: string;
    attempt_id: string | null;
    usage_class: 'compensating';
    meter: string;
    ledger_version: number;
    quantity: number;
    rate_version: string;
    reason: string;
    created_at: string;
  } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();

    return this.pool.withTransaction({ tenantId, role: 'cve_dispatcher' }, (tx) => {
      const existing = tx.selectScoped<{ ledger_version: number }>(
        'usage_entries',
        'job_id = ? AND meter = ?',
        [input.jobId, input.meter],
        'ledger_version DESC',
      );
      const nextLedgerVersion = Number(existing[0]?.ledger_version ?? 0) + 1;
      const entryId = `use_comp_${input.jobId}_v${nextLedgerVersion}_${crypto.randomBytes(4).toString('hex')}`;

      tx.insertScoped('usage_entries', {
        tenant_id: tenantId,
        id: entryId,
        job_id: input.jobId,
        attempt_id: null,
        usage_class: 'compensating',
        meter: input.meter,
        ledger_version: nextLedgerVersion,
        quantity: Number(input.quantity.toFixed(6)),
        rate_version: input.rateVersion ?? 'starter-v1',
        reason: input.reason,
        created_at: nowIso,
      });

      return {
        id: entryId,
        job_id: input.jobId,
        attempt_id: null,
        usage_class: 'compensating',
        meter: input.meter,
        ledger_version: nextLedgerVersion,
        quantity: Number(input.quantity.toFixed(6)),
        rate_version: input.rateVersion ?? 'starter-v1',
        reason: input.reason,
        created_at: nowIso,
      };
    });
  }

  // --------------------------------------------------------------------------
  // 10. Idempotency Management (Task P3-02 / docs/API.md lines 9-13)
  // --------------------------------------------------------------------------

  public claimIdempotency(
    tenantId: string,
    input: {
      method: 'POST';
      normalizedPath: string;
      key: string;
      requestHash: string;
      now?: Date;
    },
  ): { replayed: false } | { replayed: true; httpStatus: number; responseBody: string; resourceId?: string } {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const records = tx.selectScoped<{
        tenant_id: string;
        method: string;
        normalized_path: string;
        key: string;
        request_hash: string;
        state: 'in_progress' | 'completed';
        http_status: number | null;
        response_body_encrypted: string | null;
        resource_id: string | null;
        expires_at: string;
      }>(
        'idempotency_records',
        'method = ? AND normalized_path = ? AND key = ?',
        [input.method, input.normalizedPath, input.key],
      );

      const record = records[0];
      if (record) {
        // If expired, delete and allow new operation
        if (Date.parse(record.expires_at) <= now.getTime()) {
          tx.deleteScoped('idempotency_records', 'method = ? AND normalized_path = ? AND key = ?', [
            input.method,
            input.normalizedPath,
            input.key,
          ]);
        } else if (record.state === 'completed') {
          if (record.request_hash !== input.requestHash) {
            throw new IdempotencyConflictError('Idempotency key reused with different request payload');
          }
          return {
            replayed: true,
            httpStatus: record.http_status ?? 200,
            responseBody: record.response_body_encrypted ?? '{}',
            resourceId: record.resource_id ?? undefined,
          };
        } else if (record.state === 'in_progress') {
          if (record.request_hash !== input.requestHash) {
            throw new IdempotencyConflictError('Idempotency key reused with different request payload');
          }
          throw new IdempotencyInProgressError('Request with this idempotency key is currently in progress');
        }
      }

      // Insert in_progress record
      tx.insertScoped('idempotency_records', {
        tenant_id: tenantId,
        method: input.method,
        normalized_path: input.normalizedPath,
        key: input.key,
        request_hash: input.requestHash,
        state: 'in_progress',
        http_status: null,
        response_body_encrypted: null,
        resource_id: null,
        secret_redacted: 0,
        created_at: nowIso,
        expires_at: expiresAt,
      });

      return { replayed: false };
    });
  }

  public completeIdempotency(
    tenantId: string,
    input: {
      method: 'POST';
      normalizedPath: string;
      key: string;
      httpStatus: number;
      responseBody: unknown;
      resourceId?: string;
      secretRedacted?: boolean;
    },
  ): void {
    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.updateScoped(
        'idempotency_records',
        {
          state: 'completed',
          http_status: input.httpStatus,
          response_body_encrypted:
            typeof input.responseBody === 'string'
              ? input.responseBody
              : JSON.stringify(input.responseBody),
          resource_id: input.resourceId ?? null,
          secret_redacted: input.secretRedacted ? 1 : 0,
        },
        'method = ? AND normalized_path = ? AND key = ?',
        [input.method, input.normalizedPath, input.key],
      );
    });
  }

  public getIdempotencyRecord(
    tenantId: string,
    input: {
      method: 'POST';
      normalizedPath: string;
      key: string;
    },
  ): {
    tenant_id: string;
    method: string;
    normalized_path: string;
    key: string;
    request_hash: string;
    state: 'in_progress' | 'completed';
    http_status: number | null;
    response_body_encrypted: string | null;
    resource_id: string | null;
    secret_redacted: number;
    created_at: string;
    expires_at: string;
  } | null {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        tenant_id: string;
        method: string;
        normalized_path: string;
        key: string;
        request_hash: string;
        state: 'in_progress' | 'completed';
        http_status: number | null;
        response_body_encrypted: string | null;
        resource_id: string | null;
        secret_redacted: number;
        created_at: string;
        expires_at: string;
      }>(
        'idempotency_records',
        'method = ? AND normalized_path = ? AND key = ?',
        [input.method, input.normalizedPath, input.key],
      );
      return rows[0] ?? null;
    });
  }

  public releaseIdempotency(
    tenantId: string,
    input: {
      method: 'POST';
      normalizedPath: string;
      key: string;
    },
  ): void {
    try {
      this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
        // Only release if it was still in_progress
        tx.deleteScoped(
          'idempotency_records',
          "method = ? AND normalized_path = ? AND key = ? AND state = 'in_progress'",
          [input.method, input.normalizedPath, input.key],
        );
      });
    } catch {
      // ignore
    }
  }

  // --------------------------------------------------------------------------
  // Retention & Storage Sweeper Purge (Task P3-05)
  // --------------------------------------------------------------------------

  public sweepExpiredRecords(options: {
    now?: Date;
    assetRetentionDays?: number;
    artifactRetentionDays?: number;
    idempotencyRetentionDays?: number;
  } = {}): {
    assetsExpired: number;
    artifactsExpired: number;
    idempotencyRecordsPruned: number;
  } {
    const now = options.now ?? new Date();
    const nowIso = now.toISOString();
    const assetDays = options.assetRetentionDays ?? 7;
    const artifactDays = options.artifactRetentionDays ?? 7;
    const idempotencyDays = options.idempotencyRetentionDays ?? 7;

    const assetCutoff = new Date(now.getTime() - assetDays * 24 * 60 * 60 * 1000).toISOString();
    const artifactCutoff = new Date(now.getTime() - artifactDays * 24 * 60 * 60 * 1000).toISOString();
    const idempotencyCutoff = new Date(now.getTime() - idempotencyDays * 24 * 60 * 60 * 1000).toISOString();

    let assetsExpiredCount = 0;
    let artifactsExpiredCount = 0;
    let idempotencyPrunedCount = 0;

    // Use migrator role to perform retention sweep across all tenants
    this.pool.withTransaction({ tenantId: SYSTEM_CATALOG_TENANT_ID, role: 'cve_migrator' }, (tx) => {
      // 1. Expire assets older than assetCutoff or rights_json.expires_at < nowIso
      const activeAssets = tx.selectScoped<{
        tenant_id: string;
        id: string;
        created_at: string;
        rights_json: string;
      }>('assets', "status = 'ready' AND visibility = 'tenant_private'", []);

      for (const ast of activeAssets) {
        let isExpired = ast.created_at < assetCutoff;
        if (!isExpired) {
          try {
            const rights = JSON.parse(ast.rights_json) as { expires_at?: string };
            if (rights.expires_at && rights.expires_at < nowIso) {
              isExpired = true;
            }
          } catch {
            // ignore
          }
        }

        if (isExpired) {
          // Soft-delete asset (create tombstone)
          tx.updateScoped(
            'assets',
            { status: 'deleted', deleted_at: nowIso, updated_at: nowIso },
            'tenant_id = ? AND id = ?',
            [ast.tenant_id, ast.id],
          );
          // Revoke active grants
          this.revocationStore.revokeAssetGrants(ast.tenant_id, ast.id, now.getTime());
          // Remove storage files
          if (this.quarantineStore) {
            this.quarantineStore.removeAsset(ast.tenant_id, ast.id);
          }

          // Cascade failure to any active jobs referencing this asset (excluding cancel_requested per AMB-003)
          const activeJobs = tx.selectScoped<{
            tenant_id: string;
            id: string;
            state_version: number;
            lease_epoch: number;
            active_attempt_id: string | null;
            snapshot_json: string;
          }>(
            'jobs',
            "state NOT IN ('succeeded', 'failed', 'canceled', 'cancel_requested') AND tenant_id = ?",
            [ast.tenant_id],
          );

          for (const job of activeJobs) {
            if (job.snapshot_json.includes(`"${ast.id}"`)) {
              if (job.active_attempt_id && this.quarantineStore) {
                this.quarantineStore.cleanupAttemptTempDir(
                  job.tenant_id,
                  job.id,
                  job.active_attempt_id,
                );
              }
              if (job.active_attempt_id) {
                tx.updateScoped(
                  'job_attempts',
                  {
                    state: 'failed',
                    ended_at: nowIso,
                    error_json: JSON.stringify({
                      code: 'ASSET_REVOKED',
                      message: `Asset ${ast.id} expired per retention policy`,
                      retryable: false,
                    }),
                  },
                  'tenant_id = ? AND job_id = ? AND attempt_id = ?',
                  [job.tenant_id, job.id, job.active_attempt_id],
                );
              }
              tx.updateScoped(
                'jobs',
                {
                  state: 'failed',
                  stage: 'failed',
                  state_version: job.state_version + 1,
                  lease_epoch: job.lease_epoch + 1,
                  active_attempt_id: null,
                  lease_expires_at: null,
                  error_json: JSON.stringify({
                    code: 'ASSET_REVOKED',
                    message: `Asset ${ast.id} expired per retention policy`,
                    retryable: false,
                  }),
                  completed_at: nowIso,
                  updated_at: nowIso,
                },
                'tenant_id = ? AND id = ?',
                [job.tenant_id, job.id],
              );
              tx.updateScoped(
                'usage_reservations',
                { state: 'released', settled_at: nowIso },
                "tenant_id = ? AND job_id = ? AND state = 'reserved'",
                [job.tenant_id, job.id],
              );
            }
          }

          assetsExpiredCount++;
        }
      }

      // 2. Expire artifacts older than artifactCutoff or past expires_at
      const activeArtifacts = tx.selectScoped<{
        tenant_id: string;
        id: string;
        expires_at: string;
        storage_key: string;
      }>('artifacts', 'revoked_at IS NULL', []);

      for (const art of activeArtifacts) {
        if (art.expires_at <= nowIso || art.expires_at < artifactCutoff) {
          tx.updateScoped(
            'artifacts',
            { revoked_at: nowIso },
            'tenant_id = ? AND id = ?',
            [art.tenant_id, art.id],
          );
          artifactsExpiredCount++;
        }
      }

      // 3. Prune expired idempotency records
      const expiredIdem = tx.selectScoped<{
        tenant_id: string;
        method: string;
        normalized_path: string;
        key: string;
        expires_at: string;
      }>('idempotency_records', 'expires_at <= ? OR expires_at < ?', [nowIso, idempotencyCutoff]);

      for (const idem of expiredIdem) {
        tx.deleteScoped(
          'idempotency_records',
          'tenant_id = ? AND method = ? AND normalized_path = ? AND key = ?',
          [idem.tenant_id, idem.method, idem.normalized_path, idem.key],
        );
        idempotencyPrunedCount++;
      }
    });

    return {
      assetsExpired: assetsExpiredCount,
      artifactsExpired: artifactsExpiredCount,
      idempotencyRecordsPruned: idempotencyPrunedCount,
    };
  }

  /**
   * Returns `${tenant_id}:${job_id}:${active_attempt_id}` keys for all active jobs with non-expired
   * worker leases (`lease_expires_at > now`). Used by StorageTempSweeper so live lease temp outputs
   * are never deleted (`don't delete live lease output`).
   */
  public getLiveLeasedAttemptKeys(now = new Date()): Set<string> {
    const nowMs = now.getTime();
    const db = this.pool.getDatabase();
    const rows = db
      .prepare(
        `SELECT tenant_id, id, active_attempt_id, lease_expires_at
         FROM jobs
         WHERE state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested')
           AND active_attempt_id IS NOT NULL`,
      )
      .all() as Array<{
      tenant_id: string;
      id: string;
      active_attempt_id: string | null;
      lease_expires_at: string | null;
    }>;

    const liveKeys = new Set<string>();
    for (const row of rows) {
      if (
        row.active_attempt_id &&
        row.lease_expires_at &&
        Date.parse(row.lease_expires_at) > nowMs
      ) {
        liveKeys.add(`${row.tenant_id}:${row.id}:${row.active_attempt_id}`);
      }
    }
    return liveKeys;
  }
}
