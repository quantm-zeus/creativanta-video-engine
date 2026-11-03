/**
 * Migration Discovery, Parsing & Bundled Baseline Definitions
 * Canonical specification: docs/DEPLOYMENT.md (line 54) & docs/ARCHITECTURE.md (line 54)
 */

import fs from 'node:fs';
import path from 'node:path';
import { calculateMigrationChecksum } from './checksum.js';
import { MigrationDefinition } from './types.js';

export const SQL_001_INIT_SCHEMA_MIGRATIONS = `-- Migration 001: Initialize schema migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_time_ms INTEGER NOT NULL
);

GRANT SELECT ON schema_migrations TO cve_api, cve_dispatcher, cve_ingest, cve_sender;
`;

export const SQL_002_SCAFFOLD_SYSTEM_CATALOG = `-- Migration 002: Scaffold system catalog and baseline tenant structure
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS system_catalog (
  key VARCHAR(64) PRIMARY KEY,
  category VARCHAR(32) NOT NULL,
  value JSONB NOT NULL,
  visibility VARCHAR(32) NOT NULL DEFAULT 'curated_public',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

GRANT ALL ON system_catalog TO cve_migrator;
GRANT ALL ON tenants TO cve_migrator;
GRANT SELECT ON system_catalog TO cve_api;
GRANT SELECT, INSERT, UPDATE ON tenants TO cve_api;
GRANT SELECT ON system_catalog TO cve_dispatcher, cve_ingest, cve_sender;
`;

export const SQL_003_SEED_SYNTHETIC_CATALOG = `-- Migration 003: Seed synthetic system catalog with baseline profiles and starter fonts
INSERT INTO system_catalog (key, category, value, visibility)
VALUES
  ('profile:mp4-720p-v1', 'profile', '{
    "id": "mp4-720p-v1",
    "description": "Standard 720p H.264 MP4 render (1280x720 landscape or 720x1280 portrait at 30fps)",
    "supported": true,
    "dimensions": [
      { "width": 1280, "height": 720 },
      { "width": 720, "height": 1280 }
    ],
    "fps": { "num": 30, "den": 1 },
    "container": "mp4",
    "video_codec": "h264",
    "audio_codec": "aac",
    "max_duration_seconds": 180
  }'::jsonb, 'curated_public'),
  ('profile:preview-360p-v1', 'profile', '{
    "id": "preview-360p-v1",
    "description": "Fast 360p preview (scale 0.5 from 720p canvas; PNG frame or MP4 clip)",
    "supported": true,
    "dimensions": [
      { "width": 640, "height": 360 },
      { "width": 360, "height": 640 }
    ],
    "fps": { "num": 30, "den": 1 },
    "container": "mp4",
    "video_codec": "h264",
    "audio_codec": "aac",
    "max_duration_seconds": 60
  }'::jsonb, 'curated_public'),
  ('engine:html-v1', 'engine', '{"name": "html-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:canvas-v1', 'engine', '{"name": "canvas-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:svg-v1', 'engine', '{"name": "svg-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:custom-html-v1', 'engine', '{"name": "custom-html-v1", "supported": false}'::jsonb, 'curated_public')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
`;

export const BUNDLED_MIGRATIONS: MigrationDefinition[] = [
  {
    version: 1,
    name: 'init_schema_migrations',
    filename: '001_init_schema_migrations.sql',
    sql: SQL_001_INIT_SCHEMA_MIGRATIONS,
    checksum: calculateMigrationChecksum(SQL_001_INIT_SCHEMA_MIGRATIONS),
  },
  {
    version: 2,
    name: 'scaffold_system_catalog',
    filename: '002_scaffold_system_catalog.sql',
    sql: SQL_002_SCAFFOLD_SYSTEM_CATALOG,
    checksum: calculateMigrationChecksum(SQL_002_SCAFFOLD_SYSTEM_CATALOG),
  },
  {
    version: 3,
    name: 'seed_synthetic_catalog',
    filename: '003_seed_synthetic_catalog.sql',
    sql: SQL_003_SEED_SYNTHETIC_CATALOG,
    checksum: calculateMigrationChecksum(SQL_003_SEED_SYNTHETIC_CATALOG),
  },
];

/**
 * Parses migration filename into version and descriptive name.
 * Format: ^(?<version>\d{3,})_(?<name>[a-zA-Z0-9_-]+)\.sql$
 */
export function parseMigrationFilename(
  filename: string,
): { version: number; name: string } | null {
  const match = /^(\d{3,})_([a-zA-Z0-9_-]+)\.sql$/.exec(filename);
  if (!match || !match[1] || !match[2]) return null;
  const version = parseInt(match[1], 10);
  const name = match[2];
  return { version, name };
}

/**
 * Discovers and validates migration files from a directory on disk.
 * Enforces strictly positive unique versions sorted in ascending order.
 */
export function loadMigrationsFromDirectory(dirPath: string): MigrationDefinition[] {
  if (!fs.existsSync(dirPath)) {
    return [...BUNDLED_MIGRATIONS];
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const migrations: MigrationDefinition[] = [];
  const seenVersions = new Set<number>();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    const parsed = parseMigrationFilename(entry.name);
    if (!parsed) continue;

    if (seenVersions.has(parsed.version)) {
      throw new Error(`Duplicate migration version detected: ${parsed.version} (${entry.name})`);
    }
    seenVersions.add(parsed.version);

    const fullPath = path.join(dirPath, entry.name);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = calculateMigrationChecksum(sql);

    migrations.push({
      version: parsed.version,
      name: parsed.name,
      filename: entry.name,
      sql,
      checksum,
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return migrations.length > 0 ? migrations : [...BUNDLED_MIGRATIONS];
}
