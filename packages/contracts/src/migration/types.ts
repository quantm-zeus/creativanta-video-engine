/**
 * Database Migration Types & Contracts
 * Canonical specification: docs/DEPLOYMENT.md (line 54) & docs/ARCHITECTURE.md (line 54)
 */

export interface MigrationDefinition {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigrationRecord {
  version: number;
  name: string;
  checksum: string;
  applied_at: string;
  execution_time_ms: number;
}

export type MigrationExecutionStatus = 'SUCCESS' | 'ALREADY_UP_TO_DATE' | 'FAILED';

export interface MigrationPlan {
  total: number;
  appliedCount: number;
  pendingCount: number;
  currentVersion: number;
  pending: MigrationDefinition[];
  applied: AppliedMigrationRecord[];
}

export interface MigrationResult {
  status: MigrationExecutionStatus;
  currentVersion: number;
  applied: AppliedMigrationRecord[];
  durationMs: number;
  error?: string;
}

export interface SchemaCompatibilityResult {
  currentVersion: number;
  targetVersion: number;
  isCompatible: boolean;
  pendingCount: number;
  pendingVersions: number[];
}

export interface RoleSegregationResult {
  migratorCanDdl: boolean;
  apiDeniedDdl: boolean;
  dispatcherDeniedDdl: boolean;
  allRolesSegregated: boolean;
  details: Record<string, string>;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DatabaseClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}

export class ChecksumMismatchError extends Error {
  public readonly version: number;
  public readonly expectedChecksum: string;
  public readonly actualChecksum: string;

  constructor(version: number, expectedChecksum: string, actualChecksum: string) {
    super(
      `Migration checksum mismatch for version ${version}: recorded=${actualChecksum}, local=${expectedChecksum}`,
    );
    this.name = 'ChecksumMismatchError';
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}
