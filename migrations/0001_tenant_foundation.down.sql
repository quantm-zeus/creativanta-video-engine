-- ==============================================================================
-- Creativanta Video Engine — Migration 0001 (DOWN): Rollback Tenant Foundation
-- Task: P3-01 (Stream A / Phase P3)
-- Drops all 21 tenant entities, RLS policies, triggers, and helper functions
-- in reverse foreign-key dependency order.
-- ==============================================================================

BEGIN;

-- 1. Drop usage & metering tables
DROP TABLE IF EXISTS usage_entries CASCADE;
DROP TABLE IF EXISTS usage_reservations CASCADE;

-- 2. Drop webhook delivery & outbox tables
DROP TABLE IF EXISTS webhook_deliveries CASCADE;
DROP TABLE IF EXISTS outbox CASCADE;

-- 3. Drop idempotency store
DROP TABLE IF EXISTS idempotency_records CASCADE;

-- 4. Drop artifacts & job execution tables
DROP TABLE IF EXISTS artifacts CASCADE;
DROP TABLE IF EXISTS job_events CASCADE;
DROP TABLE IF EXISTS job_attempts CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;

-- 5. Drop webhook endpoints
DROP TABLE IF EXISTS webhook_endpoints CASCADE;

-- 6. Drop custom scene bundle tables
DROP TABLE IF EXISTS scene_bundle_revisions CASCADE;
DROP TABLE IF EXISTS scene_bundles CASCADE;

-- 7. Drop asset tables
DROP TABLE IF EXISTS asset_versions CASCADE;
DROP TABLE IF EXISTS assets CASCADE;

-- 8. Drop composition tables
DROP TABLE IF EXISTS composition_revisions CASCADE;
DROP TABLE IF EXISTS compositions CASCADE;

-- 9. Drop template catalog tables (break cyclic provenance FK first)
ALTER TABLE IF EXISTS templates DROP CONSTRAINT IF EXISTS fk_templates_source_revision;
DROP TABLE IF EXISTS template_revisions CASCADE;
DROP TABLE IF EXISTS templates CASCADE;

-- 10. Drop identity & policy tables
DROP TABLE IF EXISTS policies CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

-- 11. Drop helper functions
DROP FUNCTION IF EXISTS cve_guard_system_catalog_write() CASCADE;
DROP FUNCTION IF EXISTS cve_prevent_immutable_mutation() CASCADE;
DROP FUNCTION IF EXISTS cve_current_tenant_id() CASCADE;
DROP FUNCTION IF EXISTS cve_system_catalog_tenant_id() CASCADE;

DELETE FROM schema_migrations WHERE version = '0001';

COMMIT;
