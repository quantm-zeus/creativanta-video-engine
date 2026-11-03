-- ==============================================================================
-- Creativanta Video Engine — Migration 0002 (UP): Seed Sentinel System Catalog
-- Task: P3-01 (Stream A / Phase P3)
-- Executed as cve_migrator to populate the read-only sentinel tenant
-- 00000000-0000-0000-0000-000000000000 (visibility = 'curated_public').
-- ==============================================================================

BEGIN;

SET LOCAL app.current_service_role = 'cve_migrator';
SET LOCAL app.current_tenant_id = '00000000-0000-0000-0000-000000000000';

-- 1. Sentinel system_catalog tenant
INSERT INTO tenants (id, name, status, created_at, updated_at)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'system_catalog',
    'active',
    '2026-11-02T00:00:00Z'::timestamptz,
    '2026-11-02T00:00:00Z'::timestamptz
)
ON CONFLICT (id) DO NOTHING;

-- 2. Default starter-v1 policy template on sentinel catalog
INSERT INTO policies (tenant_id, policy_version, limits_json, active, created_at)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'starter-v1',
    '{
        "active_job_slots_max": 2,
        "pending_admission_slots_max": 20,
        "non_terminal_jobs_total_max": 22,
        "token_bucket_refill_per_second": 1,
        "token_bucket_burst_capacity": 20,
        "http_json_body_max_bytes": 1048576,
        "upload_file_max_bytes": 104857600,
        "job_total_input_max_bytes": 524288000
    }'::jsonb,
    true,
    '2026-11-02T00:00:00Z'::timestamptz
)
ON CONFLICT (tenant_id, policy_version) DO NOTHING;

-- 3. Curated public system font assets (OFL-1.1 verified in P0-03)
INSERT INTO assets (
    tenant_id, id, filename, kind, status, current_version, visibility, rights_json, created_at, updated_at
)
VALUES
    (
        '00000000-0000-0000-0000-000000000000'::uuid,
        'ast_font_noto_sans_regular',
        'NotoSans-Regular.ttf',
        'font',
        'ready',
        1,
        'curated_public',
        '{"basis": "public_domain", "source": "fonts-noto-core Debian package (OFL-1.1)", "attribution": "Google Noto Fonts"}'::jsonb,
        '2026-11-02T00:00:00Z'::timestamptz,
        '2026-11-02T00:00:00Z'::timestamptz
    ),
    (
        '00000000-0000-0000-0000-000000000000'::uuid,
        'ast_font_inter_bold',
        'Inter-Bold.otf',
        'font',
        'ready',
        1,
        'curated_public',
        '{"basis": "public_domain", "source": "fonts-inter Debian package (OFL-1.1)", "attribution": "Rasmus Andersson Inter Project"}'::jsonb,
        '2026-11-02T00:00:00Z'::timestamptz,
        '2026-11-02T00:00:00Z'::timestamptz
    )
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO asset_versions (
    tenant_id, asset_id, version, original_sha256, normalized_sha256, mime_type, bytes, probe_metadata, storage_key, created_at
)
VALUES
    (
        '00000000-0000-0000-0000-000000000000'::uuid,
        'ast_font_noto_sans_regular',
        1,
        'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        'font/ttf',
        559924,
        '{"family": "Noto Sans", "weight": 400, "style": "normal", "vietnamese_glyphs": true}'::jsonb,
        'tenant/00000000-0000-0000-0000-000000000000/asset/ast_font_noto_sans_regular/1/font.ttf',
        '2026-11-02T00:00:00Z'::timestamptz
    ),
    (
        '00000000-0000-0000-0000-000000000000'::uuid,
        'ast_font_inter_bold',
        1,
        'b24b1fc1ac9fc8d07ed4052aa2045c676eb866a7894bdab8b25fc4116df43374',
        'b24b1fc1ac9fc8d07ed4052aa2045c676eb866a7894bdab8b25fc4116df43374',
        'font/otf',
        412628,
        '{"family": "Inter", "weight": 700, "style": "normal", "vietnamese_glyphs": true}'::jsonb,
        'tenant/00000000-0000-0000-0000-000000000000/asset/ast_font_inter_bold/1/font.otf',
        '2026-11-02T00:00:00Z'::timestamptz
    )
ON CONFLICT (tenant_id, asset_id, version) DO NOTHING;

-- 4. Curated public starter template (tpl_promo_starter rev 1)
INSERT INTO templates (
    tenant_id, id, name, current_revision, visibility, created_at, updated_at
)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'tpl_promo_starter',
    'Khuyến mãi sản phẩm 9:16 (Curated Starter)',
    1,
    'curated_public',
    '2026-11-02T00:00:00Z'::timestamptz,
    '2026-11-02T00:00:00Z'::timestamptz
)
ON CONFLICT (tenant_id, id) DO NOTHING;

INSERT INTO template_revisions (
    tenant_id, template_id, revision, name, variables_schema, defaults_json,
    composition_spec, supported_locales, required_capabilities, source_digest, change_note, created_at
)
VALUES (
    '00000000-0000-0000-0000-000000000000'::uuid,
    'tpl_promo_starter',
    1,
    'Khuyến mãi sản phẩm 9:16 (Curated Starter)',
    '{
        "type": "object",
        "additionalProperties": false,
        "required": ["headline"],
        "properties": {
            "headline": {"type": "string", "minLength": 1, "maxLength": 200},
            "price": {"type": "string", "minLength": 1, "maxLength": 64}
        }
    }'::jsonb,
    '{"headline": "Ưu đãi hôm nay", "price": "199.000 ₫"}'::jsonb,
    '{
        "schema_version": "1.0",
        "canvas": {"width": 720, "height": 1280, "background": "#101828"},
        "fps": {"num": 30, "den": 1},
        "duration_frames": 150,
        "seed": 42,
        "locale": "vi-VN",
        "fonts": [{
            "id": "brand_regular",
            "asset_id": "ast_font_noto_sans_regular",
            "sha256": "bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5",
            "family": "Noto Sans",
            "weight": 400,
            "style": "normal"
        }],
        "scenes": [{
            "id": "intro",
            "revision": 1,
            "start_frame": 0,
            "duration_frames": 150,
            "engine": "html-v1",
            "layers": [{
                "id": "headline",
                "type": "text",
                "start_frame": 0,
                "duration_frames": 150,
                "z_index": 1,
                "box": {"x": 48, "y": 400, "width": 624, "height": 240},
                "content": {
                    "text": {"variable": "headline"},
                    "font_id": "brand_regular",
                    "font_size": 54,
                    "color": "#FFFFFF",
                    "align": "center",
                    "max_lines": 3,
                    "overflow": "error"
                }
            }],
            "transition_out": {"type": "cut", "duration_frames": 0}
        }],
        "audio_tracks": [],
        "subtitles": []
    }'::jsonb,
    ARRAY['vi-VN', 'en-US'],
    ARRAY['html-v1'],
    '7bc0f3c7e6a9c6980217b43fa3c2a44c3c13d6ca8e4fb543284f01d75888a41e',
    'Initial curated starter template revision',
    '2026-11-02T00:00:00Z'::timestamptz
)
ON CONFLICT (tenant_id, template_id, revision) DO NOTHING;

COMMIT;
