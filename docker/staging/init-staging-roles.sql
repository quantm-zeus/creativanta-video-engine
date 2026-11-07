-- ==============================================================================
-- Creativanta Video Engine - Staging Least-Privilege Role Bootstrap (Task P10-A)
-- Canonical specifications:
--   - docs/ARCHITECTURE.md (5 segregated DB service roles, NOBYPASSRLS, FORCE RLS)
--   - docs/SECURITY.md (No hardcoded credentials, least privilege, composite tenant FKs)
--   - migrations/0001_tenant_foundation.up.sql (Section 7 table-specific grants)
--
-- SECURITY NOTE:
-- - Does NOT embed hardcoded passwords (unlike local dev 01-init.sql).
-- - Roles are created with NOLOGIN until an operator/secret-rotator binds unique
--   staging credentials from protected secret mounts.
-- - Does NOT grant blanket ALTER DEFAULT PRIVILEGES ... GRANT ALL/CRUD to cve_api;
--   per-table privileges are granted solely by migration 0001_tenant_foundation.up.sql.
-- ==============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_migrator') THEN
    CREATE ROLE cve_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  ELSE
    ALTER ROLE cve_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT BYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_api') THEN
    CREATE ROLE cve_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE cve_api NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_dispatcher') THEN
    CREATE ROLE cve_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE cve_dispatcher NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_ingest') THEN
    CREATE ROLE cve_ingest NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE cve_ingest NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_sender') THEN
    CREATE ROLE cve_sender NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  ELSE
    ALTER ROLE cve_sender NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO cve_migrator;
GRANT USAGE ON SCHEMA public TO cve_api, cve_dispatcher, cve_ingest, cve_sender;
