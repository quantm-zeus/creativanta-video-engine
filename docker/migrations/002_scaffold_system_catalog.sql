-- ==============================================================================
-- Migration 002: Scaffold system catalog and baseline tenant structure
-- Canonical specification: docs/ARCHITECTURE.md (lines 44-55) & docs/SCENE-SPEC.md
-- ==============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Global system catalog table for capabilities, profiles, and runtime configuration
CREATE TABLE IF NOT EXISTS system_catalog (
  key VARCHAR(64) PRIMARY KEY,
  category VARCHAR(32) NOT NULL,
  value JSONB NOT NULL,
  visibility VARCHAR(32) NOT NULL DEFAULT 'curated_public',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Minimal tenants table for tenant-scoped references
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Grant minimum segregated privileges
-- cve_migrator has full privileges
GRANT ALL ON system_catalog TO cve_migrator;
GRANT ALL ON tenants TO cve_migrator;

-- cve_api can read system_catalog and read/write tenants
GRANT SELECT ON system_catalog TO cve_api;
GRANT SELECT, INSERT, UPDATE ON tenants TO cve_api;

-- Other roles only have read access to system_catalog if needed
GRANT SELECT ON system_catalog TO cve_dispatcher, cve_ingest, cve_sender;
