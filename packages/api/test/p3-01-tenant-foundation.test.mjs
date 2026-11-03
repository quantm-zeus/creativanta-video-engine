import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  ALL_API_SCOPES,
  CANONICAL_21_TABLES,
  CANONICAL_DB_ROLES,
  MigrationRunner,
  PoolContextSecurityError,
  SYSTEM_CATALOG_TENANT_ID,
  TenantConnectionPool,
  TenantRepository,
  auditPostgresMigrations,
  createDatabaseSnapshot,
  createServer,
  decodeSignedCursor,
  encodeSignedCursor,
  generateApiKeyMaterial,
  restoreAndReconcileSnapshot,
  verifyApiKeyConstantTime,
} from '../dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TENANT_SUSPENDED_ID = '33333333-3333-4333-8333-333333333333';
const TEST_PEPPER = 'test_pepper_0123456789abcdef0123456789abcdef';

function buildSampleSpec({ fontAssetId, imageAssetId, audioAssetId, fontId = 'brand_regular' }) {
  const layers = [
    {
      id: 'headline',
      type: 'text',
      start_frame: 0,
      duration_frames: 150,
      z_index: 1,
      box: { x: 48, y: 400, width: 624, height: 240 },
      content: {
        text: 'Sáng tạo mỗi ngày',
        font_id: fontId,
        font_size: 54,
        color: '#FFFFFF',
        align: 'center',
        max_lines: 3,
        overflow: 'error',
      },
    },
  ];

  if (imageAssetId) {
    layers.push({
      id: 'hero_image',
      type: 'image',
      start_frame: 0,
      duration_frames: 150,
      z_index: 2,
      box: { x: 100, y: 100, width: 520, height: 280 },
      content: {
        asset_id: imageAssetId,
        fit: 'cover',
      },
    });
  }

  const audioTracks = audioAssetId
    ? [
        {
          id: 'bgm',
          asset_id: audioAssetId,
          start_frame: 0,
          duration_frames: 150,
          source_in_samples: 0,
          gain_db: -6,
        },
      ]
    : [];

  return {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#101828' },
    fps: { num: 30, den: 1 },
    duration_frames: 150,
    seed: 42,
    locale: 'vi-VN',
    fonts: [
      {
        id: 'brand_regular',
        asset_id: fontAssetId,
        sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        family: 'Noto Sans',
        weight: 400,
        style: 'normal',
      },
    ],
    scenes: [
      {
        id: 'intro',
        revision: 1,
        start_frame: 0,
        duration_frames: 150,
        engine: 'html-v1',
        layers,
        transition_out: { type: 'cut', duration_frames: 0 },
      },
    ],
    audio_tracks: audioTracks,
    subtitles: [],
  };
}

describe('P3-01: Tenant Data & Asset Foundation (Migrations, FKs, RLS, Service Roles, Key Hashes, Pool Isolation, IDOR & Recovery)', () => {
  describe('1. PostgreSQL Migrations Audit, Composite FKs & Immutability Triggers', () => {
    it('verifies all 21 canonical tables, composite tenant_id PK/FKs, ENABLE+FORCE RLS, 5 DB roles, and SHA-256 checksums', () => {
      const report = auditPostgresMigrations();
      assert.strictEqual(report.valid, true, `Audit errors: ${report.errors.join('; ')}`);
      assert.strictEqual(report.tableCount, 21);
      assert.strictEqual(report.rlsEnabledCount, 21);
      assert.strictEqual(report.rlsForcedCount, 21);
      assert.deepStrictEqual(report.rolesVerified, [...CANONICAL_DB_ROLES]);
      assert.strictEqual(report.verifiedMigrations.length, 2);
    });

    it('enforces composite foreign keys with tenant_id and blocks cross-tenant FK references at the DB level', () => {
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      const applied = runner.migrateUp({ role: 'cve_migrator' });
      assert.deepStrictEqual(applied, ['0001', '0002']);

      const pool = new TenantConnectionPool(db, { poolSize: 2 });
      const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
      repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

      const spec = buildSampleSpec({ fontAssetId: 'ast_font_noto_sans_regular' });
      repo.createComposition(TENANT_A_ID, {
        id: 'cmp_alpha_only',
        name: 'Alpha Composition',
        spec,
      });

      // Attempting to insert a job under Tenant B referencing Tenant A's composition_id
      // must fail the composite FK (tenant_id, composition_id, composition_revision) -> composition_revisions
      assert.throws(() => {
        pool.withTransaction({ tenantId: TENANT_B_ID, role: 'cve_migrator' }, (tx) => {
          tx.insertScoped('jobs', {
            tenant_id: TENANT_B_ID,
            id: 'job_cross_fk',
            kind: 'render',
            state: 'queued',
            state_version: 1,
            stage: 'queued',
            progress: 0,
            composition_id: 'cmp_alpha_only',
            composition_revision: 1,
            profile: 'mp4-720p-v1',
            snapshot_json: JSON.stringify(spec),
            deadline_at: '2026-11-03T12:00:00Z',
            created_at: '2026-11-03T11:00:00Z',
            updated_at: '2026-11-03T11:00:00Z',
          });
        });
      }, /FOREIGN KEY constraint failed/i);

      // Verify immutability triggers block UPDATE on template_revisions, composition_revisions, asset_versions, job_events, usage_entries
      assert.throws(() => {
        db.prepare("UPDATE composition_revisions SET change_note = 'mutated' WHERE composition_id = 'cmp_alpha_only'").run();
      }, /IMMUTABLE_RECORD_VIOLATION/);

      assert.throws(() => {
        db.prepare("UPDATE template_revisions SET change_note = 'mutated' WHERE template_id = 'tpl_promo_starter'").run();
      }, /IMMUTABLE_RECORD_VIOLATION/);

      assert.throws(() => {
        db.prepare("UPDATE asset_versions SET bytes = 123 WHERE asset_id = 'ast_font_noto_sans_regular'").run();
      }, /IMMUTABLE_RECORD_VIOLATION/);

      db.close();
    });
  });

  describe('2. Segregated Minimum-Privilege Service Roles & Sentinel System Catalog', () => {
    it('enforces least-privilege access across cve_migrator, cve_api, cve_dispatcher, cve_ingest, and cve_sender', () => {
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      runner.migrateUp({ role: 'cve_migrator' });

      // Non-migrator roles cannot execute DDL migrations
      assert.throws(
        () => runner.migrateUp({ role: 'cve_api' }),
        /MIGRATION_ROLE_DENIED/,
      );
      assert.throws(
        () => runner.migrateDown({ role: 'cve_dispatcher' }),
        /MIGRATION_ROLE_DENIED/,
      );

      const pool = new TenantConnectionPool(db, { poolSize: 2 });
      const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });
      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });

      // cve_api can SELECT curated_public templates from system_catalog, but cannot write to system_catalog
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        const templates = tx.selectScoped('templates');
        assert.strictEqual(templates.length, 1);
        assert.strictEqual(templates[0].id, 'tpl_promo_starter');
        assert.strictEqual(templates[0].tenant_id, SYSTEM_CATALOG_TENANT_ID);

        assert.throws(
          () =>
            tx.insertScoped('templates', {
              tenant_id: SYSTEM_CATALOG_TENANT_ID,
              id: 'tpl_illegal_inject',
              name: 'Illegal System Template',
              current_revision: 1,
              visibility: 'curated_public',
              created_at: '2026-11-03T00:00:00Z',
              updated_at: '2026-11-03T00:00:00Z',
            }),
          (err) =>
            err instanceof PoolContextSecurityError && err.code === 'SYSTEM_CATALOG_READ_ONLY',
        );
      });

      // cve_dispatcher cannot read or write api_keys or webhook_endpoints
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
        assert.throws(
          () => tx.selectScoped('api_keys'),
          (err) => err instanceof PoolContextSecurityError && err.code === 'ROLE_PRIVILEGE_DENIED',
        );
        assert.throws(
          () => tx.selectScoped('webhook_endpoints'),
          (err) => err instanceof PoolContextSecurityError && err.code === 'ROLE_PRIVILEGE_DENIED',
        );
      });

      // cve_ingest can SELECT/UPDATE assets and INSERT asset_versions, but cannot read api_keys or compositions
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_ingest' }, (tx) => {
        const assets = tx.selectScoped('assets');
        assert.strictEqual(assets.length, 2); // 2 curated system fonts
        assert.throws(
          () => tx.selectScoped('compositions'),
          (err) => err instanceof PoolContextSecurityError && err.code === 'ROLE_PRIVILEGE_DENIED',
        );
      });

      // cve_sender can access outbox/webhook_endpoints/webhook_deliveries, but cannot read assets or api_keys
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_sender' }, (tx) => {
        const endpoints = tx.selectScoped('webhook_endpoints');
        assert.strictEqual(endpoints.length, 0);
        assert.throws(
          () => tx.selectScoped('assets'),
          (err) => err instanceof PoolContextSecurityError && err.code === 'ROLE_PRIVILEGE_DENIED',
        );
      });

      db.close();
    });
  });

  describe('3. API Key Entropy, Salted/Keyed Hashes, Constant-Time Check, Rotation & Revocation', () => {
    it('generates 32-byte high-entropy keys, stores only prefix+hash, and verifies in constant time', () => {
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      runner.migrateUp({ role: 'cve_migrator' });
      const pool = new TenantConnectionPool(db, { poolSize: 2 });
      const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
      repo.createTenant({ id: TENANT_SUSPENDED_ID, name: 'Suspended Corp', status: 'suspended' });

      const material = generateApiKeyMaterial({ pepper: TEST_PEPPER });
      assert.strictEqual(material.entropyBytes, 32);
      assert.match(material.keyPrefix, /^cve_live_[0-9a-f]{12}$/);
      assert.match(material.keyHash, /^[0-9a-f]{64}$/);

      const issued = repo.issueApiKey({
        tenantId: TENANT_A_ID,
        keyId: 'key_alpha_1',
        scopes: ['jobs:read', 'compositions:read'],
      });

      // Verify raw database row never contains the plaintext secret
      const rawRow = db
        .prepare('SELECT * FROM api_keys WHERE tenant_id = ? AND id = ?')
        .get(TENANT_A_ID, 'key_alpha_1');
      assert.ok(rawRow);
      assert.strictEqual(rawRow.key_prefix, issued.keyPrefix);
      assert.strictEqual(rawRow.key_hash, issued.keyHash);
      assert.ok(!JSON.stringify(rawRow).includes(issued.plaintextKey));

      // Valid verification
      const validCheck = verifyApiKeyConstantTime({
        rawToken: issued.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
      });
      assert.strictEqual(validCheck.authenticated, true);
      assert.strictEqual(validCheck.tenantId, TENANT_A_ID);
      assert.deepStrictEqual(validCheck.scopes, ['jobs:read', 'compositions:read']);

      // Tampered secret with valid prefix fails with 401 UNAUTHENTICATED
      const tamperedToken = `${issued.keyPrefix}_${'f'.repeat(64)}`;
      const tamperedCheck = verifyApiKeyConstantTime({
        rawToken: tamperedToken,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
      });
      assert.strictEqual(tamperedCheck.authenticated, false);
      assert.strictEqual(tamperedCheck.httpStatus, 401);
      assert.strictEqual(tamperedCheck.errorCode, 'UNAUTHENTICATED');

      // Key rotation with 24h overlap keeps old key valid until overlap expiry, and links rotated_from_key_id
      const now = new Date('2026-11-03T04:00:00Z');
      const rotated = repo.rotateApiKey({
        tenantId: TENANT_A_ID,
        oldKeyId: 'key_alpha_1',
        newKeyId: 'key_alpha_2',
        overlapSeconds: 3600,
        now,
      });

      // During 1h overlap window (t + 30m), old key still authenticates
      const duringOverlap = verifyApiKeyConstantTime({
        rawToken: issued.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
        now: new Date('2026-11-03T04:30:00Z'),
      });
      assert.strictEqual(duringOverlap.authenticated, true);

      // After overlap window (t + 2h), old key fails with 401 while rotated key succeeds
      const afterOverlap = verifyApiKeyConstantTime({
        rawToken: issued.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
        now: new Date('2026-11-03T06:00:01Z'),
      });
      assert.strictEqual(afterOverlap.authenticated, false);
      assert.strictEqual(afterOverlap.httpStatus, 401);

      const newKeyCheck = verifyApiKeyConstantTime({
        rawToken: rotated.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
        now: new Date('2026-11-03T06:00:01Z'),
      });
      assert.strictEqual(newKeyCheck.authenticated, true);
      assert.strictEqual(newKeyCheck.keyId, 'key_alpha_2');

      // Immediate revocation invalidates rotated key at once
      repo.revokeApiKey(TENANT_A_ID, 'key_alpha_2', new Date('2026-11-03T06:05:00Z'));
      const revokedCheck = verifyApiKeyConstantTime({
        rawToken: rotated.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
        now: new Date('2026-11-03T06:05:00Z'),
      });
      assert.strictEqual(revokedCheck.authenticated, false);
      assert.strictEqual(revokedCheck.httpStatus, 401);

      // Suspended tenant key returns 403 TENANT_SUSPENDED
      const suspendedKey = repo.issueApiKey({
        tenantId: TENANT_SUSPENDED_ID,
        keyId: 'key_susp_1',
        scopes: ['jobs:read'],
      });
      const suspendedCheck = verifyApiKeyConstantTime({
        rawToken: suspendedKey.plaintextKey,
        lookupByPrefix: (p) => repo.lookupApiKeyByPrefix(p),
        pepper: TEST_PEPPER,
      });
      assert.strictEqual(suspendedCheck.authenticated, false);
      assert.strictEqual(suspendedCheck.httpStatus, 403);
      assert.strictEqual(suspendedCheck.errorCode, 'TENANT_SUSPENDED');

      db.close();
    });
  });

  describe('4. Tenant Pool-Context Isolation (SET LOCAL app.current_tenant_id)', () => {
    it('guarantees zero tenant context leakage across reused pooled connections on commit and rollback', () => {
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      runner.migrateUp({ role: 'cve_migrator' });

      // Single-slot pool (poolSize: 1) forces every transaction to reuse pool_conn_1
      const pool = new TenantConnectionPool(db, { poolSize: 1 });
      const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
      repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

      repo.createAsset(TENANT_A_ID, {
        id: 'ast_alpha_secret',
        filename: 'alpha.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: 4096,
        sha256: 'a'.repeat(64),
        rights: { basis: 'owned', source: 'Alpha Studio', attribution: 'Alpha' },
      });

      repo.createAsset(TENANT_B_ID, {
        id: 'ast_beta_secret',
        filename: 'beta.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: 8192,
        sha256: 'b'.repeat(64),
        rights: { basis: 'owned', source: 'Beta Studio', attribution: 'Beta' },
      });

      // 1. Transaction 1 on pool_conn_1: Tenant A reads its asset
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
        assert.strictEqual(tx.getSlotId(), 'pool_conn_1');
        const rows = tx.selectScoped('assets', "kind = 'image'");
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'ast_alpha_secret');
      });

      // 2. Transaction 2 on the SAME pooled connection (pool_conn_1) with tenantId = null:
      // Must NOT inherit Tenant A's context!
      pool.withTransaction({ tenantId: null, role: 'cve_api' }, (tx) => {
        assert.strictEqual(tx.getSlotId(), 'pool_conn_1');
        assert.strictEqual(tx.getCurrentTenantId(), null);
        const rows = tx.selectScoped('assets');
        assert.strictEqual(rows.length, 0, 'Unset tenant context must return 0 rows under FORCE RLS');
      });

      // 3. Transaction 3 on pool_conn_1: Tenant A starts a transaction, attempts a forbidden
      // session-level SET or throws mid-transaction; context must still reset cleanly on rollback
      assert.throws(() => {
        pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_api' }, (tx) => {
          tx.executeSetCommand(`SET app.current_tenant_id = '${TENANT_A_ID}'`);
        });
      }, (err) => err instanceof PoolContextSecurityError && err.code === 'SESSION_LEVEL_SET_FORBIDDEN');

      // 4. Transaction 4 on pool_conn_1: Tenant B acquires the connection after Tenant A's rollback
      // and sees ONLY Tenant B's private image asset (plus cannot write rows with Tenant A's tenant_id)
      pool.withTransaction({ tenantId: TENANT_B_ID, role: 'cve_api' }, (tx) => {
        assert.strictEqual(tx.getSlotId(), 'pool_conn_1');
        assert.strictEqual(tx.getCurrentTenantId(), TENANT_B_ID);
        const rows = tx.selectScoped('assets', "kind = 'image'");
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].id, 'ast_beta_secret');

        // Attempting to insert a row claiming Tenant A's tenant_id inside Tenant B's transaction is blocked by RLS WITH CHECK
        assert.throws(
          () =>
            tx.insertScoped('assets', {
              tenant_id: TENANT_A_ID,
              id: 'ast_spoofed',
              filename: 'spoof.png',
              kind: 'image',
              status: 'ready',
              current_version: 1,
              visibility: 'tenant_private',
              rights_json: '{}',
              created_at: '2026-11-03T00:00:00Z',
              updated_at: '2026-11-03T00:00:00Z',
              deleted_at: null,
            }),
          (err) => err instanceof PoolContextSecurityError && err.code === 'RLS_POLICY_VIOLATION',
        );
      });

      const diag = pool.getPoolDiagnostics();
      assert.strictEqual(diag.length, 1);
      assert.strictEqual(diag[0].inTransaction, false);
      assert.strictEqual(diag[0].localTenantId, null);
      assert.ok(diag[0].reuseCount >= 6);

      db.close();
    });
  });

  describe('5. End-to-End HTTP IDOR Suite, Cursor Binding & AMB-007 Path-404 vs Body-422 Taxonomy', () => {
    let db;
    let pool;
    let repo;
    let server;
    let baseUrl;
    let keyAlphaFull;
    let keyBetaFull;
    let keyAlphaReadOnly;

    before(async () => {
      db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);
      runner.migrateUp({ role: 'cve_migrator' });

      pool = new TenantConnectionPool(db, { poolSize: 4 });
      repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
      repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

      keyAlphaFull = repo.issueApiKey({
        tenantId: TENANT_A_ID,
        keyId: 'key_alpha_full',
        scopes: [...ALL_API_SCOPES],
      }).plaintextKey;

      keyBetaFull = repo.issueApiKey({
        tenantId: TENANT_B_ID,
        keyId: 'key_beta_full',
        scopes: [...ALL_API_SCOPES],
      }).plaintextKey;

      keyAlphaReadOnly = repo.issueApiKey({
        tenantId: TENANT_A_ID,
        keyId: 'key_alpha_ro',
        scopes: ['templates:read', 'jobs:read'],
      }).plaintextKey;

      // Seed Tenant A private resources (asset, template, composition, job, artifact, webhook, usage)
      repo.createAsset(TENANT_A_ID, {
        id: 'ast_alpha_img',
        filename: 'alpha-product.png',
        kind: 'image',
        mimeType: 'image/png',
        bytes: 12345,
        sha256: '1'.repeat(64),
        rights: { basis: 'owned', source: 'Alpha camera', attribution: 'Alpha' },
      });

      repo.createTemplate(TENANT_A_ID, {
        id: 'tpl_alpha_private',
        name: 'Alpha Private Template',
        variables_schema: { type: 'object' },
        defaults: {},
        composition_spec: buildSampleSpec({ fontAssetId: 'ast_font_noto_sans_regular' }),
        supported_locales: ['vi-VN'],
        source_template: { id: 'tpl_promo_starter', revision: 1 },
      });

      repo.createComposition(TENANT_A_ID, {
        id: 'cmp_alpha_1',
        name: 'Alpha Promo Video',
        spec: buildSampleSpec({
          fontAssetId: 'ast_font_noto_sans_regular',
          imageAssetId: 'ast_alpha_img',
        }),
      });

      repo.createWebhookEndpoint(TENANT_A_ID, {
        id: 'wh_alpha_1',
        url: 'https://alpha.example.invalid/webhooks/video',
        events: ['job.succeeded', 'job.failed'],
      });

      repo.createJob(TENANT_A_ID, {
        id: 'job_alpha_1',
        kind: 'render',
        compositionId: 'cmp_alpha_1',
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
        webhookEndpointId: 'wh_alpha_1',
      });

      repo.createJob(TENANT_A_ID, {
        id: 'job_alpha_2',
        kind: 'render',
        compositionId: 'cmp_alpha_1',
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
      });

      // Record a published artifact and usage entry for job_alpha_1 via cve_dispatcher
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
        tx.updateScoped(
          'jobs',
          {
            state: 'succeeded',
            stage: 'complete',
            state_version: 6,
            progress: 1,
            attempt_count: 1,
            completed_at: '2026-11-03T04:00:20Z',
            updated_at: '2026-11-03T04:00:20Z',
          },
          'id = ?',
          ['job_alpha_1'],
        );
        tx.insertScoped('job_attempts', {
          tenant_id: TENANT_A_ID,
          job_id: 'job_alpha_1',
          attempt_id: 'att_alpha_1',
          lease_epoch: 1,
          worker_id: 'worker_1',
          state: 'succeeded',
          started_at: '2026-11-03T04:00:00Z',
          heartbeat_at: '2026-11-03T04:00:15Z',
          lease_expires_at: '2026-11-03T04:01:00Z',
          ended_at: '2026-11-03T04:00:20Z',
          cpu_seconds: 14.5,
          peak_rss_bytes: 512000000,
          error_json: null,
        });
        tx.insertScoped('artifacts', {
          tenant_id: TENANT_A_ID,
          id: 'art_alpha_video',
          job_id: 'job_alpha_1',
          attempt_id: 'att_alpha_1',
          kind: 'video',
          mime_type: 'video/mp4',
          sha256: '2'.repeat(64),
          bytes: 987654,
          storage_key: `tenant/${TENANT_A_ID}/job/job_alpha_1/att_alpha_1/video.mp4`,
          expires_at: '2026-11-10T04:00:20Z',
          revoked_at: null,
          created_at: '2026-11-03T04:00:20Z',
        });
        tx.insertScoped('usage_entries', {
          tenant_id: TENANT_A_ID,
          id: 'use_alpha_1',
          job_id: 'job_alpha_1',
          attempt_id: 'att_alpha_1',
          usage_class: 'billable',
          meter: 'billable_output_minutes',
          ledger_version: 1,
          quantity: 0.25,
          rate_version: 'v1',
          reason: 'render succeeded',
          created_at: '2026-11-03T04:00:20Z',
        });
      });

      const config = loadEnvConfig({
        CVE_ENV: 'development',
        CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
        CVE_API_KEY_PEPPER: TEST_PEPPER,
      });

      server = createServer({ config, repository: repo });
      await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      });
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    });

    it('returns 404 NOT_FOUND (never 403) when Tenant B probes Tenant A resource IDs in URL paths', async () => {
      const idorPaths = [
        { method: 'GET', path: '/v1/assets/ast_alpha_img' },
        { method: 'DELETE', path: '/v1/assets/ast_alpha_img' },
        { method: 'GET', path: '/v1/templates/tpl_alpha_private/revisions/1' },
        { method: 'GET', path: '/v1/compositions/cmp_alpha_1' },
        { method: 'GET', path: '/v1/compositions/cmp_alpha_1/revisions/1' },
        { method: 'GET', path: '/v1/jobs/job_alpha_1' },
        { method: 'GET', path: '/v1/artifacts/art_alpha_video/download' },
        { method: 'GET', path: '/v1/webhook-endpoints/wh_alpha_1' },
      ];

      for (const probe of idorPaths) {
        const res = await fetch(`${baseUrl}${probe.path}`, {
          method: probe.method,
          headers: {
            Authorization: `Bearer ${keyBetaFull}`,
          },
        });
        assert.strictEqual(
          res.status,
          404,
          `Expected 404 NOT_FOUND for cross-tenant ${probe.method} ${probe.path}, got ${res.status}`,
        );
        const body = await res.json();
        assert.strictEqual(body.error.code, 'NOT_FOUND');
      }

      // Meanwhile Tenant A can read its own resources with 200 OK
      const ownAssetRes = await fetch(`${baseUrl}/v1/assets/ast_alpha_img`, {
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      assert.strictEqual(ownAssetRes.status, 200);

      const ownDownloadRes = await fetch(`${baseUrl}/v1/artifacts/art_alpha_video/download`, {
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      assert.strictEqual(ownDownloadRes.status, 200);
      const downloadBody = await ownDownloadRes.json();
      assert.strictEqual(downloadBody.sha256, '2'.repeat(64));
    });

    it('returns 422 VALIDATION_FAILED with ASSET_NOT_FOUND / UNKNOWN_FONT when Tenant B references Tenant A asset_id in JSON body (AMB-007)', async () => {
      // Tenant B submits a composition whose image layer references Tenant A's ast_alpha_img
      const specWithForeignAsset = buildSampleSpec({
        fontAssetId: 'ast_font_noto_sans_regular',
        imageAssetId: 'ast_alpha_img',
        audioAssetId: 'ast_foreign_audio',
        fontId: 'undeclared_font_id',
      });

      const res = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyBetaFull}`,
          'Idempotency-Key': 'idem-beta-body-idor-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Beta Cross-Tenant Probe Composition',
          spec: specWithForeignAsset,
        }),
      });

      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(Array.isArray(body.error.details));

      const pointersAndCodes = body.error.details.map((d) => `${d.pointer}:${d.code}`);
      assert.ok(
        pointersAndCodes.includes('/spec/scenes/0/layers/0/content/font_id:UNKNOWN_FONT'),
        `Expected UNKNOWN_FONT detail, got ${JSON.stringify(pointersAndCodes)}`,
      );
      assert.ok(
        pointersAndCodes.includes('/spec/scenes/0/layers/1/content/asset_id:ASSET_NOT_FOUND'),
        `Expected ASSET_NOT_FOUND detail on foreign image asset, got ${JSON.stringify(pointersAndCodes)}`,
      );
      assert.ok(
        pointersAndCodes.includes('/spec/audio_tracks/0/asset_id:ASSET_NOT_FOUND'),
        `Expected ASSET_NOT_FOUND detail on foreign audio asset, got ${JSON.stringify(pointersAndCodes)}`,
      );
    });

    it('isolates list endpoints, usage reports, and rejects cross-tenant pagination cursors with 400 INVALID_CURSOR', async () => {
      // Tenant A lists jobs with limit=1 to obtain a signed next_cursor
      const alphaJobsPage1 = await fetch(`${baseUrl}/v1/jobs?limit=1`, {
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      assert.strictEqual(alphaJobsPage1.status, 200);
      const alphaJobsBody = await alphaJobsPage1.json();
      assert.strictEqual(alphaJobsBody.data.length, 1);
      assert.ok(alphaJobsBody.next_cursor, 'Expected next_cursor for Tenant A jobs');

      // Tenant B lists jobs: sees 0 jobs
      const betaJobsRes = await fetch(`${baseUrl}/v1/jobs`, {
        headers: { Authorization: `Bearer ${keyBetaFull}` },
      });
      assert.strictEqual(betaJobsRes.status, 200);
      const betaJobsBody = await betaJobsRes.json();
      assert.strictEqual(betaJobsBody.data.length, 0);

      // Tenant B replays Tenant A's next_cursor on /v1/jobs -> 400 INVALID_CURSOR
      const cursorReplayRes = await fetch(
        `${baseUrl}/v1/jobs?cursor=${encodeURIComponent(alphaJobsBody.next_cursor)}`,
        {
          headers: { Authorization: `Bearer ${keyBetaFull}` },
        },
      );
      assert.strictEqual(cursorReplayRes.status, 400);
      const cursorReplayBody = await cursorReplayRes.json();
      assert.strictEqual(cursorReplayBody.error.code, 'INVALID_CURSOR');

      // Tenant B lists templates: sees ONLY curated_public template (tpl_promo_starter), NOT tpl_alpha_private
      const betaTplRes = await fetch(`${baseUrl}/v1/templates`, {
        headers: { Authorization: `Bearer ${keyBetaFull}` },
      });
      assert.strictEqual(betaTplRes.status, 200);
      const betaTplBody = await betaTplRes.json();
      assert.deepStrictEqual(
        betaTplBody.data.map((t) => t.id),
        ['tpl_promo_starter'],
      );

      // Tenant B cannot add a revision to curated_public system_catalog template -> 404 NOT_FOUND
      const mutateCuratedRes = await fetch(
        `${baseUrl}/v1/templates/tpl_promo_starter/revisions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyBetaFull}`,
            'Idempotency-Key': 'idem-mutate-curated',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            base_revision: 1,
            name: 'Hijacked Curated Template',
            variables_schema: {},
            defaults: {},
            composition_spec: {},
            supported_locales: ['vi-VN'],
          }),
        },
      );
      assert.strictEqual(mutateCuratedRes.status, 404);

      // Usage endpoint isolation: Tenant A sees 0.25 billable minutes, Tenant B sees 0
      const alphaUsageRes = await fetch(`${baseUrl}/v1/usage`, {
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      assert.strictEqual(alphaUsageRes.status, 200);
      const alphaUsage = await alphaUsageRes.json();
      assert.strictEqual(alphaUsage.billable_output_minutes, 0.25);

      const betaUsageRes = await fetch(`${baseUrl}/v1/usage`, {
        headers: { Authorization: `Bearer ${keyBetaFull}` },
      });
      assert.strictEqual(betaUsageRes.status, 200);
      const betaUsage = await betaUsageRes.json();
      assert.strictEqual(betaUsage.billable_output_minutes, 0);
    });

    it('rejects client-supplied tenant_id in headers or body and enforces API key scopes', async () => {
      // Client supplying X-Tenant-Id header -> 422 VALIDATION_FAILED
      const headerSpoofRes = await fetch(`${baseUrl}/v1/jobs`, {
        headers: {
          Authorization: `Bearer ${keyAlphaFull}`,
          'X-Tenant-Id': TENANT_B_ID,
        },
      });
      assert.strictEqual(headerSpoofRes.status, 422);

      // Client supplying tenant_id in POST body -> 422 VALIDATION_FAILED
      const bodySpoofRes = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlphaFull}`,
          'Idempotency-Key': 'idem-spoof-tenant-body',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tenant_id: TENANT_B_ID,
          name: 'Spoofed',
          spec: buildSampleSpec({ fontAssetId: 'ast_font_noto_sans_regular' }),
        }),
      });
      assert.strictEqual(bodySpoofRes.status, 422);
      const bodySpoofJson = await bodySpoofRes.json();
      assert.strictEqual(bodySpoofJson.error.details[0].pointer, '/tenant_id');

      // Read-only key attempting POST /v1/compositions -> 403 INSUFFICIENT_SCOPE
      const scopeDeniedRes = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlphaReadOnly}`,
          'Idempotency-Key': 'idem-scope-denied',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Denied Write',
          spec: buildSampleSpec({ fontAssetId: 'ast_font_noto_sans_regular' }),
        }),
      });
      assert.strictEqual(scopeDeniedRes.status, 403);
      const scopeDeniedJson = await scopeDeniedRes.json();
      assert.strictEqual(scopeDeniedJson.error.code, 'INSUFFICIENT_SCOPE');

      // Deleting Tenant A's asset revokes Tenant A's queued job_alpha_2 with ASSET_REVOKED
      const delRes = await fetch(`${baseUrl}/v1/assets/ast_alpha_img`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      assert.strictEqual(delRes.status, 202);
      const delBody = await delRes.json();
      assert.deepStrictEqual(delBody.revokedJobs, ['job_alpha_2']);

      const job2Res = await fetch(`${baseUrl}/v1/jobs/job_alpha_2`, {
        headers: { Authorization: `Bearer ${keyAlphaFull}` },
      });
      const job2Body = await job2Res.json();
      assert.strictEqual(job2Body.state, 'failed');
      assert.strictEqual(job2Body.error.code, 'ASSET_REVOKED');
    });
  });

  describe('6. Migration Rollback & Point-in-Time Recovery (PITR) Drill', () => {
    it('executes clean migration rollback (0002 -> 0001 -> 0000) and re-applies forward migrations', () => {
      const db = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(db);

      assert.deepStrictEqual(runner.migrateUp({ role: 'cve_migrator' }), ['0001', '0002']);
      assert.deepStrictEqual(runner.getAppliedVersions(), ['0001', '0002']);

      // Roll back 0002 only
      assert.deepStrictEqual(
        runner.migrateDown({ role: 'cve_migrator', targetVersion: '0001' }),
        ['0002'],
      );
      assert.deepStrictEqual(runner.getAppliedVersions(), ['0001']);

      // Roll back 0001 completely
      assert.deepStrictEqual(
        runner.migrateDown({ role: 'cve_migrator', targetVersion: '0000' }),
        ['0001'],
      );
      assert.deepStrictEqual(runner.getAppliedVersions(), []);

      // Re-apply 0001 and 0002 cleanly
      assert.deepStrictEqual(runner.migrateUp({ role: 'cve_migrator' }), ['0001', '0002']);
      assert.deepStrictEqual(runner.getAppliedVersions(), ['0001', '0002']);

      db.close();
    });

    it('restores a database snapshot into an isolated instance, reconciles leases/uploads/artifacts/reservations, and meets RPO<=15m / RTO<=4h', () => {
      const sourceDb = new DatabaseSync(':memory:');
      const runner = new MigrationRunner(sourceDb);
      runner.migrateUp({ role: 'cve_migrator' });

      const pool = new TenantConnectionPool(sourceDb, { poolSize: 2 });
      const repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

      repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
      const spec = buildSampleSpec({ fontAssetId: 'ast_font_noto_sans_regular' });
      repo.createComposition(TENANT_A_ID, {
        id: 'cmp_restore_1',
        name: 'Restore Drill Composition',
        spec,
      });

      // Create 2 jobs: one active rendering job with expired lease, one cancel_requested job
      const baseNow = new Date('2026-11-03T04:00:00Z');
      repo.createJob(TENANT_A_ID, {
        id: 'job_expired_lease',
        kind: 'render',
        compositionId: 'cmp_restore_1',
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
        now: baseNow,
      });

      repo.createJob(TENANT_A_ID, {
        id: 'job_cancel_pending',
        kind: 'render',
        compositionId: 'cmp_restore_1',
        compositionRevision: 1,
        profile: 'mp4-720p-v1',
        now: baseNow,
      });

      // Create an uploading asset that was interrupted before object upload completed
      repo.createAsset(TENANT_A_ID, {
        id: 'ast_incomplete_upload',
        filename: 'unfinished.mp4',
        kind: 'video',
        status: 'uploading',
        mimeType: 'video/mp4',
        bytes: 102400,
        sha256: '3'.repeat(64),
        rights: { basis: 'owned', source: 'upload', attribution: 'Alpha' },
      });

      // Set job states before snapshot
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
        tx.updateScoped(
          'jobs',
          {
            state: 'rendering',
            stage: 'rendering',
            attempt_count: 1,
            active_attempt_id: 'att_1',
            lease_epoch: 1,
            lease_expires_at: '2026-11-03T04:01:00Z',
          },
          'id = ?',
          ['job_expired_lease'],
        );

        tx.updateScoped(
          'jobs',
          {
            state: 'cancel_requested',
            stage: 'rendering',
            attempt_count: 1,
            active_attempt_id: 'att_cancel_1',
            lease_epoch: 1,
            lease_expires_at: '2026-11-03T04:01:00Z',
          },
          'id = ?',
          ['job_cancel_pending'],
        );
      });

      // Take point-in-time snapshot at 04:02:00Z (last transaction at 04:05:00Z -> RPO = 180s <= 900s)
      const snap = createDatabaseSnapshot(sourceDb, {
        cutoffTimestamp: '2026-11-03T04:02:00Z',
      });

      // Verify tampered checksum is rejected
      const targetDb = new DatabaseSync(':memory:');
      assert.throws(
        () =>
          restoreAndReconcileSnapshot({
            targetDb,
            payloadJson: snap.payloadJson,
            expectedSha256: '0'.repeat(64),
            availableStorageKeys: new Set(),
          }),
        /SNAPSHOT_INTEGRITY_FAILED/,
      );

      // Perform actual restore and reconciliation into isolated targetDb
      const availableStorageKeys = new Set([
        `tenant/${SYSTEM_CATALOG_TENANT_ID}/asset/ast_font_noto_sans_regular/1/NotoSans-Regular.ttf`,
        `tenant/${SYSTEM_CATALOG_TENANT_ID}/asset/ast_font_inter_bold/1/Inter-Bold.otf`,
      ]);

      const drillReport = restoreAndReconcileSnapshot({
        targetDb,
        payloadJson: snap.payloadJson,
        expectedSha256: snap.metadata.sha256,
        availableStorageKeys,
        lastTransactionAt: new Date('2026-11-03T04:05:00Z'),
        now: new Date('2026-11-03T04:10:00Z'),
      });

      assert.strictEqual(drillReport.rpoSeconds, 180);
      assert.strictEqual(drillReport.rpoTargetMet, true);
      assert.strictEqual(drillReport.rtoTargetMet, true);
      assert.deepStrictEqual(drillReport.postRestoreSafetyFlags, {
        customCodeEnabled: false,
        remoteImportEnabled: false,
        outboundWebhooksEnabled: false,
      });

      assert.deepStrictEqual(drillReport.reconciliation.requeuedExpiredJobs, [
        `${TENANT_A_ID}:job_expired_lease`,
      ]);
      assert.deepStrictEqual(drillReport.reconciliation.convergedCanceledJobs, [
        `${TENANT_A_ID}:job_cancel_pending`,
      ]);
      assert.deepStrictEqual(drillReport.reconciliation.rejectedIncompleteUploads, [
        `${TENANT_A_ID}:ast_incomplete_upload`,
      ]);
      assert.deepStrictEqual(drillReport.reconciliation.releasedUsageReservations, [
        `${TENANT_A_ID}:job_cancel_pending`,
      ]);

      // Verify restored job states and incremented lease_epoch fence in targetDb
      const restoredPool = new TenantConnectionPool(targetDb, { poolSize: 2 });
      const restoredRepo = new TenantRepository(restoredPool, { pepper: TEST_PEPPER });

      const requeuedJob = restoredRepo.getJob(TENANT_A_ID, 'job_expired_lease');
      assert.strictEqual(requeuedJob.state, 'retry_wait');

      const canceledJob = restoredRepo.getJob(TENANT_A_ID, 'job_cancel_pending');
      assert.strictEqual(canceledJob.state, 'canceled');

      const rejectedAsset = restoredRepo.getAsset(TENANT_A_ID, 'ast_incomplete_upload');
      assert.strictEqual(rejectedAsset.status, 'rejected');

      sourceDb.close();
      targetDb.close();
    });
  });
});
