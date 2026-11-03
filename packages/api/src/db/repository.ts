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
  computeSceneContentHash,
  inspectAndValidateBindings,
  materializeCompositionFromTemplate,
  resolveAndValidateVariables,
  validateDefaultsAgainstSchema,
  validateVariableSchema,
} from '../templates/template-engine.js';

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

export class TenantRepository {
  private readonly pool: TenantConnectionPool;
  private readonly pepper: string;
  private readonly tenantImportAllowlists = new Map<string, string[]>();

  constructor(pool: TenantConnectionPool, options: { pepper: string }) {
    this.pool = pool;
    this.pepper = options.pepper;
  }

  public getPool(): TenantConnectionPool {
    return this.pool;
  }

  public getPepper(): string {
    return this.pepper;
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

      tx.updateScoped(
        'assets',
        { status: 'deleted', deleted_at: nowIso, updated_at: nowIso },
        'id = ?',
        [assetId],
      );

      // Cascade ASSET_REVOKED to any non-terminal jobs of this tenant referencing assetId
      const nonTerminalJobs = tx.selectScoped<{
        id: string;
        state: string;
        state_version: number;
        lease_epoch: number;
        snapshot_json: string;
      }>(
        'jobs',
        "state NOT IN ('succeeded', 'failed', 'canceled')",
        [],
      );

      const revokedJobs: string[] = [];
      for (const job of nonTerminalJobs) {
        if (job.snapshot_json.includes(`"${assetId}"`)) {
          const nextStateVersion = job.state_version + 1;
          const nextEpoch = job.lease_epoch + 1;
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
        details.push({
          pointer: `${pointerPrefix}/fonts/${i}/asset_id`,
          code: 'ASSET_NOT_FOUND',
          message: `Font asset '${font.asset_id}' was not found or is not ready`,
        });
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
            details.push({
              pointer: `${pointerPrefix}/scenes/${sIdx}/layers/${lIdx}/content/asset_id`,
              code: 'ASSET_NOT_FOUND',
              message: `Layer asset '${assetId}' was not found or is not authorized for tenant`,
            });
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
        details.push({
          pointer: `${pointerPrefix}/audio_tracks/${aIdx}/asset_id`,
          code: 'ASSET_NOT_FOUND',
          message: `Audio asset '${track.asset_id}' was not found or is not authorized for tenant`,
        });
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

      const unified = validateCompositionUnified(input.spec, { profile: 'mp4-720p-v1' });
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

      const unified = validateCompositionUnified(input.spec, { profile: 'mp4-720p-v1' });
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
        usage: {},
        error: job.error_json ? (JSON.parse(job.error_json) as Record<string, unknown>) : null,
        created_at: job.created_at,
        completed_at: job.completed_at,
      };
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

  public getArtifactDownloadGrant(
    tenantId: string,
    artifactId: string,
    now = new Date(),
  ): {
    url: string;
    expires_at: string;
    sha256: string;
    bytes: number;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const rows = tx.selectScoped<{
        id: string;
        sha256: string;
        bytes: number;
        storage_key: string;
        expires_at: string;
        revoked_at: string | null;
      }>('artifacts', 'id = ?', [artifactId]);

      const art = rows[0];
      if (!art || art.revoked_at !== null) {
        throw new ResourceNotFoundError(`Artifact ${artifactId} not found`);
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
    const signingSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const secretCiphertext = `enc:v1:${computeSha256Hex(signingSecret)}`;

    this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      tx.insertScoped('webhook_endpoints', {
        tenant_id: tenantId,
        id: input.id,
        url: input.url,
        state: 'pending_verification',
        events_filter_json: JSON.stringify(input.events),
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
      events: [...input.events],
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

      return {
        id: ep.id,
        url: ep.url,
        state: ep.state,
        events: JSON.parse(ep.events_filter_json) as string[],
        created_at: ep.created_at,
        last_delivery_at: ep.last_delivery_at,
      };
    });
  }

  public getUsageSummary(
    tenantId: string,
    fromIso: string,
    toIso: string,
  ): {
    from: string;
    to: string;
    operational_attempts: number;
    billable_output_minutes: number;
    estimated_cost: number;
    currency: string;
  } {
    return this.pool.withTransaction({ tenantId, role: 'cve_api' }, (tx) => {
      const entries = tx.selectScoped<{
        usage_class: string;
        meter: string;
        quantity: number;
      }>(
        'usage_entries',
        'created_at >= ? AND created_at <= ?',
        [fromIso, toIso],
      );

      let operationalAttempts = 0;
      let billableMinutes = 0;
      for (const e of entries) {
        if (e.usage_class === 'operational' && e.meter === 'cpu_seconds') {
          operationalAttempts += 1;
        }
        if (e.usage_class === 'billable' && e.meter === 'billable_output_minutes') {
          billableMinutes += Number(e.quantity);
        }
      }

      const roundedMinutes = Number(billableMinutes.toFixed(6));
      return {
        from: fromIso,
        to: toIso,
        operational_attempts: operationalAttempts,
        billable_output_minutes: roundedMinutes,
        estimated_cost: Number((roundedMinutes * 0.05).toFixed(6)),
        currency: 'USD',
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
        },
        'method = ? AND normalized_path = ? AND key = ?',
        [input.method, input.normalizedPath, input.key],
      );
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
}
