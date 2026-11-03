-- ==============================================================================
-- Creativanta Video Engine — Migration 0001 (UP): Tenant Data & Asset Foundation
-- Task: P3-01 (Stream A / Phase P3)
-- Canonical specifications:
--   - docs/ARCHITECTURE.md (21 tables, composite tenant_id FKs, 5 DB roles, RLS)
--   - docs/SECURITY.md (API key prefix/hash, transaction-local RLS, IDOR defense)
--   - docs/API.md (error taxonomy, idempotency, state transitions, usage ledger)
--   - evidence/P0-04/contract-threat-review.json
-- ==============================================================================

BEGIN;

-- ------------------------------------------------------------------------------
-- 0. Schema Migrations Ledger
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    up_sha256 TEXT NOT NULL CHECK (up_sha256 ~ '^[0-9a-f]{64}$'),
    down_sha256 TEXT NOT NULL CHECK (down_sha256 ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_by TEXT NOT NULL DEFAULT current_user
);

-- ------------------------------------------------------------------------------
-- 1. Segregated Minimum-Privilege Database Service Roles (5 Canonical Roles)
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_migrator') THEN
        CREATE ROLE cve_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_api') THEN
        CREATE ROLE cve_api NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_dispatcher') THEN
        CREATE ROLE cve_dispatcher NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_ingest') THEN
        CREATE ROLE cve_ingest NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cve_sender') THEN
        CREATE ROLE cve_sender NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

-- ------------------------------------------------------------------------------
-- 2. Transaction-Local Tenant Context & Immutability Helper Functions
-- ------------------------------------------------------------------------------
-- Sentinel UUID for global curated catalog (templates & system fonts):
CREATE OR REPLACE FUNCTION cve_system_catalog_tenant_id()
RETURNS UUID
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT '00000000-0000-0000-0000-000000000000'::uuid;
$$;

-- Reads the transaction-local tenant UUID set via:
--   SET LOCAL app.current_tenant_id = '<tenant_uuid>';
-- Returns NULL if unset or empty (failing closed on RLS comparisons).
CREATE OR REPLACE FUNCTION cve_current_tenant_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    raw_val TEXT;
BEGIN
    raw_val := NULLIF(current_setting('app.current_tenant_id', true), '');
    IF raw_val IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN raw_val::uuid;
EXCEPTION
    WHEN invalid_text_representation THEN
        RETURN NULL;
END;
$$;

-- Prevents UPDATE or DELETE on immutable revision/event/ledger tables
-- unless parent tenant/resource cascade deletion is in progress by migrator/sweeper.
CREATE OR REPLACE FUNCTION cve_prevent_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'IMMUTABLE_RECORD_VIOLATION: table % does not permit UPDATE of committed rows', TG_TABLE_NAME
            USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' AND COALESCE(current_setting('app.allow_cascade_purge', true), 'false') <> 'true' THEN
        RAISE EXCEPTION 'IMMUTABLE_RECORD_VIOLATION: table % does not permit direct row DELETE outside authorized retention purge', TG_TABLE_NAME
            USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
END;
$$;

-- Prevents non-migrator roles from mutating sentinel system_catalog rows.
CREATE OR REPLACE FUNCTION cve_guard_system_catalog_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    target_tenant UUID;
    active_role TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_tenant := OLD.tenant_id;
    ELSE
        target_tenant := NEW.tenant_id;
    END IF;

    active_role := COALESCE(NULLIF(current_setting('app.current_service_role', true), ''), current_user);

    IF target_tenant = cve_system_catalog_tenant_id() AND active_role <> 'cve_migrator' THEN
        RAISE EXCEPTION 'SYSTEM_CATALOG_READ_ONLY: role % cannot mutate sentinel system_catalog tenant rows in %', active_role, TG_TABLE_NAME
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- ==============================================================================
-- 3. Canonical 21 Tables Across 10 Entity Groups
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Group 1: Identity & Policies (tenants, api_keys, policies)
-- ------------------------------------------------------------------------------
CREATE TABLE tenants (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    key_prefix TEXT NOT NULL CHECK (key_prefix ~ '^cve_(live|test)_[0-9a-f]{12}$'),
    key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    pepper_version TEXT NOT NULL DEFAULT 'v1',
    name TEXT NOT NULL DEFAULT 'default',
    scopes TEXT[] NOT NULL DEFAULT '{}',
    rotated_from_key_id TEXT,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_api_keys_key_prefix UNIQUE (key_prefix),
    CONSTRAINT fk_api_keys_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_api_keys_rotated_from FOREIGN KEY (tenant_id, rotated_from_key_id)
        REFERENCES api_keys(tenant_id, id)
);

CREATE TABLE policies (
    tenant_id UUID NOT NULL,
    policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 64),
    limits_json JSONB NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, policy_version),
    CONSTRAINT fk_policies_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 2: Template Catalog (templates, template_revisions)
-- ------------------------------------------------------------------------------
CREATE TABLE templates (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
    visibility TEXT NOT NULL DEFAULT 'tenant_private'
        CHECK (visibility IN ('curated_public', 'tenant_private')),
    source_template_tenant_id UUID,
    source_template_id TEXT,
    source_template_revision INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_templates_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT chk_templates_curated_owner CHECK (
        (visibility = 'curated_public' AND tenant_id = '00000000-0000-0000-0000-000000000000'::uuid)
        OR (visibility = 'tenant_private' AND tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    )
);

CREATE TABLE template_revisions (
    tenant_id UUID NOT NULL,
    template_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    variables_schema JSONB NOT NULL,
    defaults_json JSONB NOT NULL,
    composition_spec JSONB NOT NULL,
    supported_locales TEXT[] NOT NULL CHECK (cardinality(supported_locales) >= 1),
    required_capabilities TEXT[] NOT NULL DEFAULT ARRAY['html-v1'],
    source_digest TEXT NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
    change_note TEXT CHECK (change_note IS NULL OR char_length(change_note) <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, template_id, revision),
    CONSTRAINT fk_template_revisions_template FOREIGN KEY (tenant_id, template_id)
        REFERENCES templates(tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE templates
    ADD CONSTRAINT fk_templates_source_revision
    FOREIGN KEY (source_template_tenant_id, source_template_id, source_template_revision)
    REFERENCES template_revisions(tenant_id, template_id, revision);

-- ------------------------------------------------------------------------------
-- Group 3: Compositions (compositions, composition_revisions)
-- ------------------------------------------------------------------------------
CREATE TABLE compositions (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
    current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
    template_tenant_id UUID,
    template_id TEXT,
    template_revision INTEGER,
    editable BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_compositions_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_compositions_template_revision
        FOREIGN KEY (template_tenant_id, template_id, template_revision)
        REFERENCES template_revisions(tenant_id, template_id, revision)
);

CREATE TABLE composition_revisions (
    tenant_id UUID NOT NULL,
    composition_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    schema_version TEXT NOT NULL DEFAULT '1.0' CHECK (schema_version = '1.0'),
    spec_json JSONB NOT NULL,
    render_hash TEXT NOT NULL CHECK (render_hash ~ '^[0-9a-f]{64}$'),
    change_note TEXT CHECK (change_note IS NULL OR char_length(change_note) <= 1000),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, composition_id, revision),
    CONSTRAINT fk_composition_revisions_composition FOREIGN KEY (tenant_id, composition_id)
        REFERENCES compositions(tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 4: Assets (assets, asset_versions)
-- ------------------------------------------------------------------------------
CREATE TABLE assets (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio', 'font', 'svg', 'subtitle')),
    status TEXT NOT NULL CHECK (status IN ('uploading', 'processing', 'ready', 'rejected', 'deleted')),
    current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
    visibility TEXT NOT NULL DEFAULT 'tenant_private'
        CHECK (visibility IN ('curated_public', 'tenant_private')),
    rights_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_assets_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT chk_assets_curated_owner CHECK (
        (visibility = 'curated_public' AND tenant_id = '00000000-0000-0000-0000-000000000000'::uuid)
        OR (visibility = 'tenant_private' AND tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid)
    )
);

CREATE TABLE asset_versions (
    tenant_id UUID NOT NULL,
    asset_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    original_sha256 TEXT NOT NULL CHECK (original_sha256 ~ '^[0-9a-f]{64}$'),
    normalized_sha256 TEXT CHECK (normalized_sha256 IS NULL OR normalized_sha256 ~ '^[0-9a-f]{64}$'),
    mime_type TEXT NOT NULL,
    bytes BIGINT NOT NULL CHECK (bytes > 0 AND bytes <= 104857600),
    probe_metadata JSONB,
    storage_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, asset_id, version),
    CONSTRAINT fk_asset_versions_asset FOREIGN KEY (tenant_id, asset_id)
        REFERENCES assets(tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 5: Custom Scene Bundles — Gated P7 (scene_bundles, scene_bundle_revisions)
-- ------------------------------------------------------------------------------
CREATE TABLE scene_bundles (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    name TEXT NOT NULL DEFAULT 'custom-bundle',
    current_revision INTEGER NOT NULL DEFAULT 1 CHECK (current_revision >= 1),
    status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (status IN ('draft', 'approved', 'revoked', 'disabled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_scene_bundles_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE
);

CREATE TABLE scene_bundle_revisions (
    tenant_id UUID NOT NULL,
    bundle_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
    build_sha256 TEXT NOT NULL CHECK (build_sha256 ~ '^[0-9a-f]{64}$'),
    entrypoint TEXT NOT NULL CHECK (entrypoint !~ '(\.\.|^/|://)'),
    parameters_schema JSONB NOT NULL,
    capabilities_json JSONB NOT NULL,
    security_gate_digest TEXT,
    runtime_pin TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, bundle_id, revision),
    CONSTRAINT fk_scene_bundle_revisions_bundle FOREIGN KEY (tenant_id, bundle_id)
        REFERENCES scene_bundles(tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 9a: Webhook Endpoints (created before jobs so jobs can FK to endpoints)
-- ------------------------------------------------------------------------------
CREATE TABLE webhook_endpoints (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    url TEXT NOT NULL CHECK (url ~ '^https://'),
    state TEXT NOT NULL DEFAULT 'pending_verification'
        CHECK (state IN ('pending_verification', 'active', 'disabled')),
    events_filter TEXT[] NOT NULL CHECK (cardinality(events_filter) >= 1),
    active_key_id TEXT NOT NULL,
    secret_ciphertext TEXT NOT NULL,
    prev_key_id TEXT,
    prev_secret_ciphertext TEXT,
    prev_secret_expires_at TIMESTAMPTZ,
    challenge_token_hash TEXT,
    challenge_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_delivery_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_webhook_endpoints_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 6: Jobs, Execution Leases & Events (jobs, job_attempts, job_events)
-- ------------------------------------------------------------------------------
CREATE TABLE jobs (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('render', 'preview')),
    state TEXT NOT NULL DEFAULT 'queued' CHECK (
        state IN (
            'queued',
            'preparing',
            'rendering',
            'encoding',
            'verifying',
            'retry_wait',
            'cancel_requested',
            'succeeded',
            'failed',
            'canceled'
        )
    ),
    state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
    stage TEXT NOT NULL DEFAULT 'queued',
    progress DOUBLE PRECISION NOT NULL DEFAULT 0.0 CHECK (progress >= 0.0 AND progress <= 1.0),
    composition_id TEXT NOT NULL,
    composition_revision INTEGER NOT NULL CHECK (composition_revision >= 1),
    profile TEXT NOT NULL CHECK (profile IN ('mp4-720p-v1', 'preview-360p-v1')),
    snapshot_json JSONB NOT NULL,
    webhook_endpoint_id TEXT,
    client_reference TEXT CHECK (client_reference IS NULL OR char_length(client_reference) <= 128),
    metadata_json JSONB,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 5),
    active_attempt_id TEXT,
    lease_epoch BIGINT NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
    lease_expires_at TIMESTAMPTZ,
    heartbeat_at TIMESTAMPTZ,
    cancel_requested_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    error_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_jobs_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE,
    CONSTRAINT fk_jobs_composition_revision
        FOREIGN KEY (tenant_id, composition_id, composition_revision)
        REFERENCES composition_revisions(tenant_id, composition_id, revision),
    CONSTRAINT fk_jobs_webhook_endpoint
        FOREIGN KEY (tenant_id, webhook_endpoint_id)
        REFERENCES webhook_endpoints(tenant_id, id)
);

CREATE TABLE job_attempts (
    tenant_id UUID NOT NULL,
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL CHECK (attempt_id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    lease_epoch BIGINT NOT NULL CHECK (lease_epoch >= 1),
    worker_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
        state IN (
            'preparing',
            'rendering',
            'encoding',
            'verifying',
            'retry_wait',
            'cancel_requested',
            'succeeded',
            'failed',
            'canceled'
        )
    ),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ NOT NULL,
    ended_at TIMESTAMPTZ,
    cpu_seconds DOUBLE PRECISION CHECK (cpu_seconds IS NULL OR cpu_seconds >= 0),
    peak_rss_bytes BIGINT CHECK (peak_rss_bytes IS NULL OR peak_rss_bytes >= 0),
    error_json JSONB,
    PRIMARY KEY (tenant_id, job_id, attempt_id),
    CONSTRAINT uq_job_attempts_lease_epoch UNIQUE (tenant_id, job_id, lease_epoch),
    CONSTRAINT fk_job_attempts_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE job_events (
    tenant_id UUID NOT NULL,
    job_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL CHECK (state_version >= 1),
    event_type TEXT NOT NULL,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, job_id, event_seq),
    CONSTRAINT fk_job_events_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 7: Artifacts (artifacts)
-- ------------------------------------------------------------------------------
CREATE TABLE artifacts (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    job_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('video', 'manifest', 'thumbnail', 'captions', 'quality_report')),
    mime_type TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    bytes BIGINT NOT NULL CHECK (bytes >= 0),
    storage_key TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_artifacts_job_kind UNIQUE (tenant_id, job_id, kind),
    CONSTRAINT fk_artifacts_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_artifacts_attempt FOREIGN KEY (tenant_id, job_id, attempt_id)
        REFERENCES job_attempts(tenant_id, job_id, attempt_id)
);

-- ------------------------------------------------------------------------------
-- Group 8: Idempotency Store (idempotency_records)
-- ------------------------------------------------------------------------------
CREATE TABLE idempotency_records (
    tenant_id UUID NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('POST')),
    normalized_path TEXT NOT NULL CHECK (normalized_path ~ '^/v1/'),
    key TEXT NOT NULL CHECK (key ~ '^[A-Za-z0-9._:-]{1,128}$'),
    request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed')),
    http_status INTEGER CHECK (http_status IS NULL OR http_status IN (200, 201, 202)),
    response_body_encrypted TEXT,
    resource_id TEXT,
    secret_redacted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, method, normalized_path, key),
    CONSTRAINT fk_idempotency_records_tenant FOREIGN KEY (tenant_id)
        REFERENCES tenants(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 9b: Transactional Outbox & Webhook Deliveries (outbox, webhook_deliveries)
-- ------------------------------------------------------------------------------
CREATE TABLE outbox (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    event_type TEXT NOT NULL CHECK (event_type IN ('job.succeeded', 'job.failed', 'job.canceled')),
    job_id TEXT NOT NULL,
    state_version INTEGER NOT NULL CHECK (state_version >= 1),
    payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_outbox_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE webhook_deliveries (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    endpoint_id TEXT NOT NULL,
    outbox_event_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'delivered', 'failed', 'dead_letter')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 8),
    next_attempt_at TIMESTAMPTZ,
    deadline_at TIMESTAMPTZ NOT NULL,
    last_http_status INTEGER,
    replay_count_today INTEGER NOT NULL DEFAULT 0 CHECK (replay_count_today >= 0 AND replay_count_today <= 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT fk_webhook_deliveries_endpoint FOREIGN KEY (tenant_id, endpoint_id)
        REFERENCES webhook_endpoints(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_webhook_deliveries_outbox FOREIGN KEY (tenant_id, outbox_event_id)
        REFERENCES outbox(tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_webhook_deliveries_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------------------
-- Group 10: Usage & Metering Ledger (usage_reservations, usage_entries)
-- ------------------------------------------------------------------------------
CREATE TABLE usage_reservations (
    tenant_id UUID NOT NULL,
    job_id TEXT NOT NULL,
    reserved_vcpu_seconds DOUBLE PRECISION NOT NULL CHECK (reserved_vcpu_seconds >= 0),
    reserved_output_seconds DOUBLE PRECISION NOT NULL CHECK (reserved_output_seconds >= 0),
    state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved', 'settled', 'released')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, job_id),
    CONSTRAINT fk_usage_reservations_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE usage_entries (
    tenant_id UUID NOT NULL,
    id TEXT NOT NULL CHECK (id ~ '^[a-zA-Z0-9_-]{3,64}$'),
    job_id TEXT NOT NULL,
    attempt_id TEXT,
    usage_class TEXT NOT NULL CHECK (usage_class IN ('operational', 'billable', 'compensating')),
    meter TEXT NOT NULL CHECK (meter IN ('cpu_seconds', 'reserved_vcpu_seconds', 'billable_output_minutes', 'storage_byte_hours', 'egress_bytes')),
    ledger_version INTEGER NOT NULL DEFAULT 1 CHECK (ledger_version >= 1),
    quantity NUMERIC(18, 6) NOT NULL,
    rate_version TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id),
    CONSTRAINT uq_usage_entries_job_meter_version UNIQUE (tenant_id, job_id, meter, ledger_version),
    CONSTRAINT fk_usage_entries_job FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, id) ON DELETE CASCADE
);

-- ==============================================================================
-- 4. Performance & Queue Indexes
-- ==============================================================================
CREATE INDEX idx_api_keys_tenant_active ON api_keys (tenant_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_templates_visibility ON templates (tenant_id, visibility, created_at DESC, id DESC);
CREATE INDEX idx_compositions_tenant_created ON compositions (tenant_id, created_at DESC, id DESC);
CREATE INDEX idx_assets_tenant_status ON assets (tenant_id, status, created_at DESC, id DESC);
CREATE INDEX idx_jobs_tenant_state_created ON jobs (tenant_id, state, created_at DESC, id DESC);
CREATE INDEX idx_jobs_dispatch_queue ON jobs (state, kind, created_at ASC) WHERE state IN ('queued', 'retry_wait');
CREATE INDEX idx_jobs_expired_leases ON jobs (lease_expires_at) WHERE state IN ('preparing', 'rendering', 'encoding', 'verifying', 'cancel_requested');
CREATE INDEX idx_outbox_unprocessed ON outbox (created_at ASC) WHERE processed_at IS NULL;
CREATE INDEX idx_webhook_deliveries_pending ON webhook_deliveries (next_attempt_at ASC) WHERE state = 'queued';
CREATE INDEX idx_usage_entries_tenant_created ON usage_entries (tenant_id, created_at ASC);

-- ==============================================================================
-- 5. Immutability & System Catalog Guard Triggers
-- ==============================================================================
CREATE TRIGGER trg_template_revisions_immutable
    BEFORE UPDATE OR DELETE ON template_revisions
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_composition_revisions_immutable
    BEFORE UPDATE OR DELETE ON composition_revisions
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_asset_versions_immutable
    BEFORE UPDATE OR DELETE ON asset_versions
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_scene_bundle_revisions_immutable
    BEFORE UPDATE OR DELETE ON scene_bundle_revisions
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_job_events_immutable
    BEFORE UPDATE OR DELETE ON job_events
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_usage_entries_immutable
    BEFORE UPDATE OR DELETE ON usage_entries
    FOR EACH ROW EXECUTE FUNCTION cve_prevent_immutable_mutation();

CREATE TRIGGER trg_templates_guard_system_catalog
    BEFORE INSERT OR UPDATE OR DELETE ON templates
    FOR EACH ROW EXECUTE FUNCTION cve_guard_system_catalog_write();

CREATE TRIGGER trg_template_revisions_guard_system_catalog
    BEFORE INSERT OR UPDATE OR DELETE ON template_revisions
    FOR EACH ROW EXECUTE FUNCTION cve_guard_system_catalog_write();

CREATE TRIGGER trg_assets_guard_system_catalog
    BEFORE INSERT OR UPDATE OR DELETE ON assets
    FOR EACH ROW EXECUTE FUNCTION cve_guard_system_catalog_write();

CREATE TRIGGER trg_asset_versions_guard_system_catalog
    BEFORE INSERT OR UPDATE OR DELETE ON asset_versions
    FOR EACH ROW EXECUTE FUNCTION cve_guard_system_catalog_write();

-- ==============================================================================
-- 6. Row-Level Security (ENABLE + FORCE ROW LEVEL SECURITY on All 21 Tables)
-- ==============================================================================
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;

ALTER TABLE policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE policies FORCE ROW LEVEL SECURITY;

ALTER TABLE templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE templates FORCE ROW LEVEL SECURITY;

ALTER TABLE template_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE compositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compositions FORCE ROW LEVEL SECURITY;

ALTER TABLE composition_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE composition_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;

ALTER TABLE asset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_versions FORCE ROW LEVEL SECURITY;

ALTER TABLE scene_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_bundles FORCE ROW LEVEL SECURITY;

ALTER TABLE scene_bundle_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_bundle_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

ALTER TABLE job_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_attempts FORCE ROW LEVEL SECURITY;

ALTER TABLE job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_events FORCE ROW LEVEL SECURITY;

ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifacts FORCE ROW LEVEL SECURITY;

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;

ALTER TABLE usage_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_entries FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- 6.1 RLS Policies for Tenants Table (id = cve_current_tenant_id())
-- ------------------------------------------------------------------------------
CREATE POLICY rls_tenants_isolation ON tenants
    FOR ALL
    TO cve_api, cve_dispatcher, cve_ingest, cve_sender
    USING (id = cve_current_tenant_id())
    WITH CHECK (id = cve_current_tenant_id() AND id <> cve_system_catalog_tenant_id());

-- ------------------------------------------------------------------------------
-- 6.2 RLS Policies for Global Curated Catalog + Tenant Tables
--     (templates, template_revisions, assets, asset_versions)
--     cve_api may SELECT own tenant rows OR system_catalog rows with curated_public,
--     but may ONLY INSERT/UPDATE/DELETE own non-sentinel tenant rows.
-- ------------------------------------------------------------------------------
CREATE POLICY rls_templates_select ON templates
    FOR SELECT
    TO cve_api, cve_dispatcher
    USING (
        tenant_id = cve_current_tenant_id()
        OR (tenant_id = cve_system_catalog_tenant_id() AND visibility = 'curated_public')
    );

CREATE POLICY rls_templates_write ON templates
    FOR ALL
    TO cve_api
    USING (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id());

CREATE POLICY rls_template_revisions_select ON template_revisions
    FOR SELECT
    TO cve_api, cve_dispatcher
    USING (
        tenant_id = cve_current_tenant_id()
        OR (
            tenant_id = cve_system_catalog_tenant_id()
            AND EXISTS (
                SELECT 1 FROM templates t
                WHERE t.tenant_id = template_revisions.tenant_id
                  AND t.id = template_revisions.template_id
                  AND t.visibility = 'curated_public'
            )
        )
    );

CREATE POLICY rls_template_revisions_write ON template_revisions
    FOR ALL
    TO cve_api
    USING (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id());

CREATE POLICY rls_assets_select ON assets
    FOR SELECT
    TO cve_api, cve_dispatcher, cve_ingest
    USING (
        tenant_id = cve_current_tenant_id()
        OR (tenant_id = cve_system_catalog_tenant_id() AND visibility = 'curated_public')
    );

CREATE POLICY rls_assets_write ON assets
    FOR ALL
    TO cve_api, cve_ingest
    USING (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id());

CREATE POLICY rls_asset_versions_select ON asset_versions
    FOR SELECT
    TO cve_api, cve_dispatcher, cve_ingest
    USING (
        tenant_id = cve_current_tenant_id()
        OR (
            tenant_id = cve_system_catalog_tenant_id()
            AND EXISTS (
                SELECT 1 FROM assets a
                WHERE a.tenant_id = asset_versions.tenant_id
                  AND a.id = asset_versions.asset_id
                  AND a.visibility = 'curated_public'
            )
        )
    );

CREATE POLICY rls_asset_versions_write ON asset_versions
    FOR ALL
    TO cve_api, cve_ingest
    USING (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id() AND tenant_id <> cve_system_catalog_tenant_id());

-- ------------------------------------------------------------------------------
-- 6.3 Strict Single-Tenant RLS Policies for Remaining 16 Tenant-Owned Tables
-- ------------------------------------------------------------------------------
CREATE POLICY rls_api_keys_tenant_isolation ON api_keys
    FOR ALL TO cve_api
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_policies_tenant_isolation ON policies
    FOR SELECT TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_compositions_tenant_isolation ON compositions
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_composition_revisions_tenant_isolation ON composition_revisions
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_scene_bundles_tenant_isolation ON scene_bundles
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_scene_bundle_revisions_tenant_isolation ON scene_bundle_revisions
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_jobs_tenant_isolation ON jobs
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_job_attempts_tenant_isolation ON job_attempts
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_job_events_tenant_isolation ON job_events
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_artifacts_tenant_isolation ON artifacts
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_idempotency_records_tenant_isolation ON idempotency_records
    FOR ALL TO cve_api
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_outbox_tenant_isolation ON outbox
    FOR ALL TO cve_api, cve_dispatcher, cve_sender
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_webhook_endpoints_tenant_isolation ON webhook_endpoints
    FOR ALL TO cve_api, cve_sender
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_webhook_deliveries_tenant_isolation ON webhook_deliveries
    FOR ALL TO cve_api, cve_sender
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_usage_reservations_tenant_isolation ON usage_reservations
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

CREATE POLICY rls_usage_entries_tenant_isolation ON usage_entries
    FOR ALL TO cve_api, cve_dispatcher
    USING (tenant_id = cve_current_tenant_id())
    WITH CHECK (tenant_id = cve_current_tenant_id());

-- ==============================================================================
-- 7. Role-Specific Table Privilege Grants (Principle of Least Privilege)
-- ==============================================================================
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- 7.1 cve_migrator: Full DDL & seed privilege
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO cve_migrator;

-- 7.2 cve_api: HTTP control plane CRUD under FORCE ROW LEVEL SECURITY
GRANT SELECT ON tenants, policies, job_attempts, job_events, artifacts, usage_entries TO cve_api;
GRANT SELECT, INSERT, UPDATE ON api_keys, templates, compositions, assets, scene_bundles, jobs, idempotency_records, webhook_endpoints, webhook_deliveries, usage_reservations, outbox TO cve_api;
GRANT DELETE ON idempotency_records TO cve_api;
GRANT SELECT, INSERT ON template_revisions, composition_revisions, asset_versions, scene_bundle_revisions, job_events TO cve_api;

-- 7.3 cve_dispatcher: Queue claim, lease heartbeat, reaper, fenced publication & usage settlement
GRANT SELECT ON tenants, policies, templates, template_revisions, compositions, composition_revisions, assets, asset_versions, scene_bundles, scene_bundle_revisions TO cve_dispatcher;
GRANT SELECT, INSERT, UPDATE ON jobs, job_attempts, artifacts, usage_reservations, outbox TO cve_dispatcher;
GRANT SELECT, INSERT ON job_events, usage_entries TO cve_dispatcher;

-- 7.4 cve_ingest: Quarantine asset probe, normalization, SVG sanitization, ready transition
GRANT SELECT ON tenants, policies TO cve_ingest;
GRANT SELECT, UPDATE ON assets TO cve_ingest;
GRANT SELECT, INSERT ON asset_versions TO cve_ingest;
GRANT SELECT, UPDATE ON jobs TO cve_ingest;
GRANT SELECT, INSERT ON job_events TO cve_ingest;

-- 7.5 cve_sender: Transactional outbox reader and webhook delivery state writer
GRANT SELECT ON tenants, jobs TO cve_sender;
GRANT SELECT, UPDATE ON outbox, webhook_endpoints TO cve_sender;
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO cve_sender;

COMMIT;
