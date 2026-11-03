/**
 * Transaction-Local Tenant Connection Pool, Service Role Privilege Enforcer,
 * and Row-Level Security (RLS) Context Guard (Task P3-01).
 *
 * Canonical specifications:
 *   - docs/ARCHITECTURE.md ("Queue và dữ liệu", line 54)
 *   - docs/SECURITY.md ("Tenant identity và secrets", lines 19-23)
 *   - evidence/P0-04/contract-threat-review.json ("tenant_entities_and_rls")
 */

import { DatabaseSync } from 'node:sqlite';
import {
  CANONICAL_21_TABLES,
  DbServiceRole,
  SYSTEM_CATALOG_TENANT_ID,
} from './migration-runner.js';

export type SqlOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export class PoolContextSecurityError extends Error {
  public readonly code: string;
  public readonly sqlState: string;

  constructor(code: string, message: string, sqlState = '42501') {
    super(message);
    this.name = 'PoolContextSecurityError';
    this.code = code;
    this.sqlState = sqlState;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Minimum-privilege matrix for the 5 canonical DB service roles per docs/ARCHITECTURE.md
 * and migrations/0001_tenant_foundation.up.sql.
 */
const ROLE_PRIVILEGE_MATRIX: Readonly<
  Record<DbServiceRole, Readonly<Record<string, readonly SqlOperation[]>>>
> = Object.freeze({
  cve_migrator: Object.fromEntries(
    CANONICAL_21_TABLES.map((t) => [t, ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const]),
  ),
  cve_api: {
    tenants: ['SELECT'],
    api_keys: ['SELECT', 'INSERT', 'UPDATE'],
    policies: ['SELECT'],
    templates: ['SELECT', 'INSERT', 'UPDATE'],
    template_revisions: ['SELECT', 'INSERT'],
    compositions: ['SELECT', 'INSERT', 'UPDATE'],
    composition_revisions: ['SELECT', 'INSERT'],
    assets: ['SELECT', 'INSERT', 'UPDATE'],
    asset_versions: ['SELECT', 'INSERT'],
    scene_bundles: ['SELECT', 'INSERT', 'UPDATE'],
    scene_bundle_revisions: ['SELECT', 'INSERT'],
    jobs: ['SELECT', 'INSERT', 'UPDATE'],
    job_attempts: ['SELECT'],
    job_events: ['SELECT', 'INSERT'],
    artifacts: ['SELECT'],
    idempotency_records: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    outbox: ['SELECT', 'INSERT', 'UPDATE'],
    webhook_endpoints: ['SELECT', 'INSERT', 'UPDATE'],
    webhook_deliveries: ['SELECT', 'INSERT', 'UPDATE'],
    usage_reservations: ['SELECT', 'INSERT', 'UPDATE'],
    usage_entries: ['SELECT'],
  },
  cve_dispatcher: {
    tenants: ['SELECT'],
    policies: ['SELECT'],
    templates: ['SELECT'],
    template_revisions: ['SELECT'],
    compositions: ['SELECT'],
    composition_revisions: ['SELECT'],
    assets: ['SELECT'],
    asset_versions: ['SELECT'],
    scene_bundles: ['SELECT'],
    scene_bundle_revisions: ['SELECT'],
    jobs: ['SELECT', 'INSERT', 'UPDATE'],
    job_attempts: ['SELECT', 'INSERT', 'UPDATE'],
    job_events: ['SELECT', 'INSERT'],
    artifacts: ['SELECT', 'INSERT', 'UPDATE'],
    usage_reservations: ['SELECT', 'INSERT', 'UPDATE'],
    usage_entries: ['SELECT', 'INSERT'],
    outbox: ['SELECT', 'INSERT', 'UPDATE'],
  },
  cve_ingest: {
    tenants: ['SELECT'],
    policies: ['SELECT'],
    assets: ['SELECT', 'UPDATE'],
    asset_versions: ['SELECT', 'INSERT'],
    jobs: ['SELECT', 'UPDATE'],
    job_events: ['SELECT', 'INSERT'],
  },
  cve_sender: {
    tenants: ['SELECT'],
    jobs: ['SELECT'],
    outbox: ['SELECT', 'UPDATE'],
    webhook_endpoints: ['SELECT', 'UPDATE'],
    webhook_deliveries: ['SELECT', 'INSERT', 'UPDATE'],
  },
});

const PUBLIC_CATALOG_TABLES = new Set([
  'templates',
  'template_revisions',
  'assets',
  'asset_versions',
]);

export interface PooledConnectionState {
  slotId: string;
  reuseCount: number;
  inTransaction: boolean;
  localTenantId: string | null;
  localRole: DbServiceRole | null;
  lastTenantIdBeforeRelease: string | null;
}

export interface TenantTransactionOptions {
  tenantId: string | null;
  role?: DbServiceRole;
}

/**
 * Represents a transaction-scoped database client bound to a pooled connection slot.
 * Enforces `SET LOCAL app.current_tenant_id`, role privileges, and `FORCE ROW LEVEL SECURITY`.
 */
export class TenantTransactionContext {
  private readonly db: DatabaseSync;
  private readonly slot: PooledConnectionState;
  private active = true;

  constructor(db: DatabaseSync, slot: PooledConnectionState) {
    this.db = db;
    this.slot = slot;
  }

  public getSlotId(): string {
    return this.slot.slotId;
  }

  public getReuseCount(): number {
    return this.slot.reuseCount;
  }

  public getCurrentTenantId(): string | null {
    this.assertActive();
    return this.slot.localTenantId;
  }

  public getCurrentRole(): DbServiceRole {
    this.assertActive();
    return this.slot.localRole ?? 'cve_api';
  }

  /**
   * Executes `SET LOCAL app.current_tenant_id = '<uuid>'`.
   * Rejects any attempt to run session-level `SET` (without `LOCAL`) so tenant context
   * can never leak across pooled connections.
   */
  public executeSetCommand(sqlCommand: string): void {
    this.assertActive();
    const trimmed = sqlCommand.trim();
    if (/^SET\s+(?!LOCAL\b)/i.test(trimmed) && /app\.current_tenant_id/i.test(trimmed)) {
      throw new PoolContextSecurityError(
        'SESSION_LEVEL_SET_FORBIDDEN',
        'Session-level SET app.current_tenant_id is forbidden on pooled connections; use SET LOCAL app.current_tenant_id within a transaction',
        '42501',
      );
    }

    const match = /^SET\s+LOCAL\s+app\.current_tenant_id\s*=\s*'([^']*)'\s*;?$/i.exec(trimmed);
    if (!match) {
      throw new PoolContextSecurityError(
        'INVALID_SET_LOCAL_SYNTAX',
        `Unsupported SET command: ${trimmed}`,
        '42601',
      );
    }
    const candidateUuid = match[1]!;
    if (!UUID_REGEX.test(candidateUuid)) {
      throw new PoolContextSecurityError(
        'INVALID_TENANT_UUID',
        `Invalid UUID for app.current_tenant_id: '${candidateUuid}'`,
        '22P02',
      );
    }
    this.slot.localTenantId = candidateUuid.toLowerCase();
  }

  public assertRolePrivilege(tableName: string, operation: SqlOperation): void {
    this.assertActive();
    const role = this.getCurrentRole();
    const tablePerms = ROLE_PRIVILEGE_MATRIX[role]?.[tableName];
    if (!tablePerms || !tablePerms.includes(operation)) {
      throw new PoolContextSecurityError(
        'ROLE_PRIVILEGE_DENIED',
        `permission denied for table ${tableName}: role '${role}' cannot perform ${operation}`,
        '42501',
      );
    }
  }

  /**
   * Evaluates Row-Level Security for a row being read (USING clause).
   */
  public checkRlsUsing(tableName: string, row: Record<string, unknown>): boolean {
    this.assertActive();
    const role = this.getCurrentRole();
    if (role === 'cve_migrator') {
      return true;
    }

    const activeTenant = this.slot.localTenantId;
    if (!activeTenant) {
      // Fail closed when app.current_tenant_id is unset under FORCE ROW LEVEL SECURITY
      return false;
    }

    if (tableName === 'tenants') {
      return row['id'] === activeTenant;
    }

    const rowTenantId = row['tenant_id'];
    if (rowTenantId === activeTenant) {
      return true;
    }

    // Curated public catalog visibility for templates, template_revisions, assets, asset_versions
    if (
      PUBLIC_CATALOG_TABLES.has(tableName) &&
      rowTenantId === SYSTEM_CATALOG_TENANT_ID
    ) {
      if (tableName === 'templates' || tableName === 'assets') {
        return row['visibility'] === 'curated_public';
      }
      if (tableName === 'template_revisions') {
        const parent = this.db
          .prepare('SELECT visibility FROM templates WHERE tenant_id = ? AND id = ?')
          .get(SYSTEM_CATALOG_TENANT_ID, String(row['template_id'])) as
          | { visibility: string }
          | undefined;
        return parent?.visibility === 'curated_public';
      }
      if (tableName === 'asset_versions') {
        const parent = this.db
          .prepare('SELECT visibility FROM assets WHERE tenant_id = ? AND id = ?')
          .get(SYSTEM_CATALOG_TENANT_ID, String(row['asset_id'])) as
          | { visibility: string }
          | undefined;
        return parent?.visibility === 'curated_public';
      }
    }

    return false;
  }

  /**
   * Evaluates Row-Level Security WITH CHECK clause for INSERT/UPDATE/DELETE mutations.
   */
  public assertRlsWithCheck(tableName: string, targetTenantId: string): void {
    this.assertActive();
    const role = this.getCurrentRole();
    if (role === 'cve_migrator') {
      return;
    }

    const activeTenant = this.slot.localTenantId;
    if (!activeTenant) {
      throw new PoolContextSecurityError(
        'RLS_CONTEXT_MISSING',
        `new row for table "${tableName}" violates row-level security policy (app.current_tenant_id is not set)`,
        '42501',
      );
    }

    if (targetTenantId === SYSTEM_CATALOG_TENANT_ID) {
      throw new PoolContextSecurityError(
        'SYSTEM_CATALOG_READ_ONLY',
        `role '${role}' cannot insert, update, or delete rows in sentinel system_catalog (${SYSTEM_CATALOG_TENANT_ID}) on table "${tableName}"`,
        '42501',
      );
    }

    if (targetTenantId !== activeTenant) {
      throw new PoolContextSecurityError(
        'RLS_POLICY_VIOLATION',
        `new row for table "${tableName}" violates row-level security policy (row tenant_id=${targetTenantId} != current_tenant_id=${activeTenant})`,
        '42501',
      );
    }
  }

  /**
   * Executes a tenant-scoped SELECT on `tableName` with automatic RLS filtering.
   */
  public selectScoped<T extends Record<string, unknown> = Record<string, unknown>>(
    tableName: string,
    whereClause = '1=1',
    params: Array<string | number | null> = [],
    orderByClause = '',
  ): T[] {
    this.assertRolePrivilege(tableName, 'SELECT');
    const orderSql = orderByClause ? ` ORDER BY ${orderByClause}` : '';
    const rawRows = this.db
      .prepare(`SELECT * FROM ${tableName} WHERE ${whereClause}${orderSql}`)
      .all(...params) as T[];
    return rawRows.filter((row) => this.checkRlsUsing(tableName, row));
  }

  /**
   * Executes a tenant-scoped INSERT on `tableName` enforcing role privilege and RLS WITH CHECK.
   */
  public insertScoped(tableName: string, record: Record<string, string | number | null>): void {
    this.assertRolePrivilege(tableName, 'INSERT');
    const targetTenantId =
      tableName === 'tenants' ? String(record['id'] ?? '') : String(record['tenant_id'] ?? '');
    this.assertRlsWithCheck(tableName, targetTenantId);

    const cols = Object.keys(record);
    const placeholders = cols.map(() => '?').join(', ');
    this.db
      .prepare(`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => record[c] ?? null));
  }

  /**
   * Executes a tenant-scoped UPDATE on `tableName` enforcing role privilege, RLS USING, and RLS WITH CHECK.
   */
  public updateScoped(
    tableName: string,
    updates: Record<string, string | number | null>,
    whereClause: string,
    params: Array<string | number | null>,
  ): number {
    this.assertRolePrivilege(tableName, 'UPDATE');
    const matchingRows = this.selectScoped(tableName, whereClause, params);
    if (matchingRows.length === 0) {
      return 0;
    }

    for (const existing of matchingRows) {
      const existingTenantId =
        tableName === 'tenants'
          ? String(existing['id'] ?? '')
          : String(existing['tenant_id'] ?? '');
      this.assertRlsWithCheck(tableName, existingTenantId);
      if (updates['tenant_id'] !== undefined && updates['tenant_id'] !== null) {
        this.assertRlsWithCheck(tableName, String(updates['tenant_id']));
      }
    }

    const updateCols = Object.keys(updates);
    const setSql = updateCols.map((c) => `${c} = ?`).join(', ');
    const setValues = updateCols.map((c) => updates[c] ?? null);

    // Scope UPDATE strictly to current tenant (or migrator)
    const role = this.getCurrentRole();
    const tenantCol = tableName === 'tenants' ? 'id' : 'tenant_id';
    if (role === 'cve_migrator') {
      const res = this.db
        .prepare(`UPDATE ${tableName} SET ${setSql} WHERE ${whereClause}`)
        .run(...setValues, ...params);
      return Number(res.changes);
    }

    const activeTenant = this.slot.localTenantId;
    if (!activeTenant) {
      return 0;
    }
    const res = this.db
      .prepare(
        `UPDATE ${tableName} SET ${setSql} WHERE (${whereClause}) AND ${tenantCol} = ? AND ${tenantCol} <> ?`,
      )
      .run(...setValues, ...params, activeTenant, SYSTEM_CATALOG_TENANT_ID);
    return Number(res.changes);
  }

  /**
   * Executes a tenant-scoped DELETE on `tableName` enforcing role privilege and RLS USING/WITH CHECK.
   */
  public deleteScoped(
    tableName: string,
    whereClause: string,
    params: Array<string | number | null>,
  ): number {
    this.assertRolePrivilege(tableName, 'DELETE');
    const matchingRows = this.selectScoped(tableName, whereClause, params);
    if (matchingRows.length === 0) {
      return 0;
    }

    for (const existing of matchingRows) {
      const existingTenantId =
        tableName === 'tenants'
          ? String(existing['id'] ?? '')
          : String(existing['tenant_id'] ?? '');
      this.assertRlsWithCheck(tableName, existingTenantId);
    }

    const role = this.getCurrentRole();
    const tenantCol = tableName === 'tenants' ? 'id' : 'tenant_id';
    if (role === 'cve_migrator') {
      const res = this.db
        .prepare(`DELETE FROM ${tableName} WHERE ${whereClause}`)
        .run(...params);
      return Number(res.changes);
    }

    const activeTenant = this.slot.localTenantId;
    if (!activeTenant) {
      return 0;
    }
    const res = this.db
      .prepare(
        `DELETE FROM ${tableName} WHERE (${whereClause}) AND ${tenantCol} = ? AND ${tenantCol} <> ?`,
      )
      .run(...params, activeTenant, SYSTEM_CATALOG_TENANT_ID);
    return Number(res.changes);
  }

  public deactivate(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active || !this.slot.inTransaction) {
      throw new PoolContextSecurityError(
        'TRANSACTION_CLOSED',
        'Cannot use TenantTransactionContext after transaction has completed and returned to pool',
        '25P01',
      );
    }
  }
}

/**
 * Pooled connection manager guaranteeing transaction-local tenant context (`SET LOCAL`)
 * that automatically resets on commit/rollback so reused pooled connections never leak
 * tenant context across requests.
 */
export class TenantConnectionPool {
  private readonly db: DatabaseSync;
  private readonly slots: PooledConnectionState[];
  private nextSlotIndex = 0;

  constructor(db: DatabaseSync, options: { poolSize?: number } = {}) {
    this.db = db;
    const poolSize = Math.max(1, options.poolSize ?? 4);
    this.slots = Array.from({ length: poolSize }, (_, idx) => ({
      slotId: `pool_conn_${idx + 1}`,
      reuseCount: 0,
      inTransaction: false,
      localTenantId: null,
      localRole: null,
      lastTenantIdBeforeRelease: null,
    }));
  }

  public getDatabase(): DatabaseSync {
    return this.db;
  }

  public getPoolDiagnostics(): ReadonlyArray<Readonly<PooledConnectionState>> {
    return this.slots.map((s) => ({ ...s }));
  }

  /**
   * Acquires a pooled connection slot, opens a database transaction, sets
   * `SET LOCAL app.current_tenant_id` (if provided) and service role, executes
   * `callback`, and guarantees transaction-local context reset before returning
   * the connection slot to the pool.
   */
  public withTransaction<T>(
    options: TenantTransactionOptions,
    callback: (tx: TenantTransactionContext) => T,
  ): T {
    const slot = this.acquireIdleSlot();
    const role: DbServiceRole = options.role ?? 'cve_api';

    slot.inTransaction = true;
    slot.reuseCount += 1;
    slot.localRole = role;
    slot.localTenantId = null;

    const tx = new TenantTransactionContext(this.db, slot);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      if (options.tenantId !== null && options.tenantId !== undefined) {
        tx.executeSetCommand(`SET LOCAL app.current_tenant_id = '${options.tenantId}'`);
      }
      const result = callback(tx);
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore secondary rollback error
      }
      throw err;
    } finally {
      tx.deactivate();
      slot.lastTenantIdBeforeRelease = slot.localTenantId;
      // Transaction-local SET LOCAL context is strictly cleared upon COMMIT/ROLLBACK
      slot.localTenantId = null;
      slot.localRole = null;
      slot.inTransaction = false;
    }
  }

  private acquireIdleSlot(): PooledConnectionState {
    for (let i = 0; i < this.slots.length; i++) {
      const idx = (this.nextSlotIndex + i) % this.slots.length;
      const candidate = this.slots[idx]!;
      if (!candidate.inTransaction) {
        this.nextSlotIndex = (idx + 1) % this.slots.length;
        // Invariant check: idle slot in pool must NEVER carry residual localTenantId
        if (candidate.localTenantId !== null || candidate.localRole !== null) {
          throw new PoolContextSecurityError(
            'POOL_STATE_CONTAMINATION',
            `Idle slot ${candidate.slotId} had dirty tenant context`,
          );
        }
        return candidate;
      }
    }
    throw new PoolContextSecurityError(
      'POOL_EXHAUSTED',
      'All pooled connections are currently in an active transaction',
      '53300',
    );
  }
}
