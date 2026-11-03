/**
 * In-Memory Database Client for Fast Offline & Deterministic Unit Testing
 * Canonical specification: docs/TESTING.md (Unit pyramid)
 */

import { DatabaseClient, QueryResult } from './types.js';

export interface InMemoryTableRecord {
  [column: string]: unknown;
}

export class InMemoryDatabaseClient implements DatabaseClient {
  public tables: Map<string, InMemoryTableRecord[]> = new Map();
  public advisoryLocks: Set<number> = new Set();
  public inTransaction: boolean = false;
  private transactionSnapshot: Map<string, InMemoryTableRecord[]> | null = null;
  public queryLog: string[] = [];
  public failNextQueryWith: Error | null = null;

  public async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queryLog.push(sql.trim());

    if (this.failNextQueryWith) {
      const err = this.failNextQueryWith;
      this.failNextQueryWith = null;
      throw err;
    }

    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // Transaction controls
    if (upper === 'BEGIN' || upper.startsWith('BEGIN;')) {
      this.inTransaction = true;
      this.transactionSnapshot = this.cloneTables();
      return { rows: [], rowCount: 0 };
    }

    if (upper === 'COMMIT' || upper.startsWith('COMMIT;')) {
      this.inTransaction = false;
      this.transactionSnapshot = null;
      return { rows: [], rowCount: 0 };
    }

    if (upper === 'ROLLBACK' || upper.startsWith('ROLLBACK;')) {
      this.inTransaction = false;
      if (this.transactionSnapshot) {
        this.tables = this.transactionSnapshot;
        this.transactionSnapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }

    // Advisory locks
    if (upper.includes('PG_ADVISORY_LOCK')) {
      const match = /pg_advisory_lock\s*\(\s*(\d+)\s*\)/i.exec(trimmed);
      const lockId = match && match[1] ? parseInt(match[1], 10) : 1;
      this.advisoryLocks.add(lockId);
      return { rows: [{ pg_advisory_lock: true } as unknown as T], rowCount: 1 };
    }

    if (upper.includes('PG_ADVISORY_UNLOCK')) {
      const match = /pg_advisory_unlock\s*\(\s*(\d+)\s*\)/i.exec(trimmed);
      const lockId = match && match[1] ? parseInt(match[1], 10) : 1;
      this.advisoryLocks.delete(lockId);
      return { rows: [{ pg_advisory_unlock: true } as unknown as T], rowCount: 1 };
    }

    // Table DDL: CREATE TABLE
    if (upper.startsWith('CREATE TABLE')) {
      const match = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?([a-zA-Z0-9_]+)/i.exec(trimmed);
      if (match && match[1]) {
        const tableName = match[1].toLowerCase();
        if (!this.tables.has(tableName)) {
          this.tables.set(tableName, []);
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // INSERT INTO schema_migrations
    if (upper.startsWith('INSERT INTO SCHEMA_MIGRATIONS')) {
      const table = this.tables.get('schema_migrations') || [];
      // Extract values from params or SQL
      let record: InMemoryTableRecord;
      if (params.length >= 5) {
        record = {
          version: Number(params[0]),
          name: String(params[1]),
          checksum: String(params[2]),
          applied_at: String(params[3]),
          execution_time_ms: Number(params[4]),
        };
      } else {
        const valMatch = /VALUES\s*\(\s*(\d+)\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*\)/i.exec(
          trimmed,
        );
        if (valMatch && valMatch[1] && valMatch[2] && valMatch[3] && valMatch[4] && valMatch[5]) {
          record = {
            version: parseInt(valMatch[1], 10),
            name: valMatch[2],
            checksum: valMatch[3],
            applied_at: valMatch[4],
            execution_time_ms: parseInt(valMatch[5], 10),
          };
        } else {
          record = {
            version: 1,
            name: 'migration',
            checksum: 'checksum',
            applied_at: new Date().toISOString(),
            execution_time_ms: 10,
          };
        }
      }
      table.push(record);
      this.tables.set('schema_migrations', table);
      return { rows: [], rowCount: 1 };
    }

    // SELECT FROM schema_migrations
    if (upper.includes('FROM SCHEMA_MIGRATIONS')) {
      const table = this.tables.get('schema_migrations') || [];
      const sorted = [...table].sort((a, b) => (Number(a.version) || 0) - (Number(b.version) || 0));
      return { rows: sorted as unknown as T[], rowCount: sorted.length };
    }

    // SELECT max(version) FROM schema_migrations
    if (upper.includes('MAX(VERSION)') && upper.includes('SCHEMA_MIGRATIONS')) {
      const table = this.tables.get('schema_migrations') || [];
      const maxVersion = table.reduce((max, r) => Math.max(max, Number(r.version) || 0), 0);
      return { rows: [{ max_version: maxVersion }] as unknown as T[], rowCount: 1 };
    }

    // Generic DDL / GRANT / EXTENSION / INSERT
    return { rows: [], rowCount: 0 };
  }

  public async close(): Promise<void> {
    this.advisoryLocks.clear();
    this.inTransaction = false;
  }

  private cloneTables(): Map<string, InMemoryTableRecord[]> {
    const clone = new Map<string, InMemoryTableRecord[]>();
    for (const [key, val] of this.tables.entries()) {
      clone.set(
        key,
        val.map((item) => ({ ...item })),
      );
    }
    return clone;
  }
}
