-- ==============================================================================
-- Migration 001: Initialize schema migrations tracking table
-- Canonical specification: docs/DEPLOYMENT.md (line 54) & docs/ARCHITECTURE.md (line 54)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  execution_time_ms INTEGER NOT NULL
);

-- Grant schema read access to application roles so readiness probes can check schema compatibility
GRANT SELECT ON schema_migrations TO cve_api, cve_dispatcher, cve_ingest, cve_sender;
