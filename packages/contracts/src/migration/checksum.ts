/**
 * Migration Checksum Calculation & Canonical SQL Normalizer
 * Canonical specification: docs/DEPLOYMENT.md & docs/TESTING.md
 */

import { createHash } from 'node:crypto';

/**
 * Normalizes SQL string for deterministic checksumming:
 * - Unifies CRLF to LF
 * - Trims trailing whitespace from lines
 * - Trims leading/trailing overall whitespace
 */
export function normalizeSql(sql: string): string {
  return sql
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Computes canonical lowercase 64-hex SHA-256 hash of normalized SQL content.
 */
export function calculateMigrationChecksum(sql: string): string {
  const normalized = normalizeSql(sql);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
