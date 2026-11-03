-- ==============================================================================
-- Creativanta Video Engine — Migration 0002 (DOWN): Remove Seeded System Catalog
-- Task: P3-01 (Stream A / Phase P3)
-- ==============================================================================

BEGIN;

SET LOCAL app.current_service_role = 'cve_migrator';
SET LOCAL app.allow_cascade_purge = 'true';
SET LOCAL app.current_tenant_id = '00000000-0000-0000-0000-000000000000';

DELETE FROM template_revisions
WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND template_id = 'tpl_promo_starter';

DELETE FROM templates
WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND id = 'tpl_promo_starter';

DELETE FROM asset_versions
WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND asset_id IN ('ast_font_noto_sans_regular', 'ast_font_inter_bold');

DELETE FROM assets
WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND id IN ('ast_font_noto_sans_regular', 'ast_font_inter_bold');

DELETE FROM policies
WHERE tenant_id = '00000000-0000-0000-0000-000000000000'::uuid
  AND policy_version = 'starter-v1';

DELETE FROM tenants
WHERE id = '00000000-0000-0000-0000-000000000000'::uuid;

DELETE FROM schema_migrations WHERE version = '0002';

COMMIT;
