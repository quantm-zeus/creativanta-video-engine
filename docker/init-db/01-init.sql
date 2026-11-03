-- ==============================================================================
-- Creativanta Video Engine - Database Initialization Script
-- Canonical specification: docs/ARCHITECTURE.md (line 54) & docs/DEPLOYMENT.md
-- ==============================================================================

-- Create application roles with segregated minimum privileges
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cve_migrator') THEN
    CREATE ROLE cve_migrator WITH LOGIN PASSWORD 'cve_dev_migrator_secret' CREATEDB;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cve_api') THEN
    CREATE ROLE cve_api WITH LOGIN PASSWORD 'cve_dev_api_secret';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cve_dispatcher') THEN
    CREATE ROLE cve_dispatcher WITH LOGIN PASSWORD 'cve_dev_dispatcher_secret';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cve_ingest') THEN
    CREATE ROLE cve_ingest WITH LOGIN PASSWORD 'cve_dev_ingest_secret';
  END IF;

  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cve_sender') THEN
    CREATE ROLE cve_sender WITH LOGIN PASSWORD 'cve_dev_sender_secret';
  END IF;
END $$;

-- Grant schema usage on public schema
GRANT ALL ON SCHEMA public TO cve_migrator;
GRANT USAGE ON SCHEMA public TO cve_api, cve_dispatcher, cve_ingest, cve_sender;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cve_api;
