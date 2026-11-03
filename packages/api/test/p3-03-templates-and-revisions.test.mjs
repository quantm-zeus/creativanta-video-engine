/**
 * Task P3-03 Acceptance Suite:
 * - Template catalog & visibility (curated vs tenant)
 * - Variable schema validation, bounds, regex, and binding v1 position guards
 * - Curated template fork path & provenance tracking (system catalog immutability)
 * - Template instantiation with typed variable substitution, defaults, and asset validation
 * - Composition revision optimistic concurrency & stale base_revision 409 conflict
 * - Immutable scene versions & database immutability triggers
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  ALL_API_SCOPES,
  MigrationRunner,
  SYSTEM_CATALOG_TENANT_ID,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  RevisionConflictError,
  BodyReferenceValidationError,
  ResourceNotFoundError,
} from '../dist/index.js';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'test_pepper_0123456789abcdef0123456789abcdef';

function buildBaseSpec({
  headline = 'Sáng tạo mỗi ngày',
  sceneRevision = 1,
  durationFrames = 150,
} = {}) {
  return {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#101828' },
    fps: { num: 30, den: 1 },
    duration_frames: durationFrames,
    seed: 42,
    locale: 'vi-VN',
    fonts: [
      {
        id: 'brand_regular',
        asset_id: 'ast_font_noto_sans_regular',
        sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        family: 'Noto Sans',
        weight: 400,
        style: 'normal',
      },
    ],
    scenes: [
      {
        id: 'intro',
        revision: sceneRevision,
        start_frame: 0,
        duration_frames: durationFrames,
        engine: 'html-v1',
        layers: [
          {
            id: 'headline',
            type: 'text',
            start_frame: 0,
            duration_frames: durationFrames,
            z_index: 1,
            box: { x: 48, y: 400, width: 624, height: 240 },
            content: {
              text: headline,
              font_id: 'brand_regular',
              font_size: 54,
              color: '#FFFFFF',
              align: 'center',
              max_lines: 3,
              overflow: 'error',
            },
          },
        ],
        transition_out: { type: 'cut', duration_frames: 0 },
      },
    ],
    audio_tracks: [],
    subtitles: [],
  };
}

function buildTemplateSpecWithBindings({
  textBinding = 'headline',
  assetBinding = null,
} = {}) {
  const layers = [
    {
      id: 'headline',
      type: 'text',
      start_frame: 0,
      duration_frames: 150,
      z_index: 1,
      box: { x: 48, y: 400, width: 624, height: 240 },
      content: {
        text: textBinding ? { variable: textBinding } : 'Fallback Text',
        font_id: 'brand_regular',
        font_size: 54,
        color: '#FFFFFF',
        align: 'center',
        max_lines: 3,
        overflow: 'error',
      },
    },
  ];

  if (assetBinding) {
    layers.push({
      id: 'hero_image',
      type: 'image',
      start_frame: 0,
      duration_frames: 150,
      z_index: 2,
      box: { x: 48, y: 100, width: 624, height: 280 },
      content: {
        asset_id: { variable: assetBinding },
        fit: 'cover',
      },
    });
  }

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
        asset_id: 'ast_font_noto_sans_regular',
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
    audio_tracks: [],
    subtitles: [],
  };
}

describe('P3-03: Template Catalog, Variable Schema, Instantiate, Composition Revisions, Concurrency & Scene Immutability', () => {
  let db;
  let pool;
  let repo;
  let server;
  let baseUrl;
  let keyAlpha;
  let keyBeta;
  let keyAlphaNoCompositionsWrite;

  before(async () => {
    db = new DatabaseSync(':memory:');
    const runner = new MigrationRunner(db);
    runner.migrateUp({ role: 'cve_migrator' });

    pool = new TenantConnectionPool(db, { poolSize: 4 });
    repo = new TenantRepository(pool, { pepper: TEST_PEPPER });

    repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha' });
    repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta' });

    keyAlpha = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha_p303',
      scopes: [...ALL_API_SCOPES],
    }).plaintextKey;

    keyBeta = repo.issueApiKey({
      tenantId: TENANT_B_ID,
      keyId: 'key_beta_p303',
      scopes: [...ALL_API_SCOPES],
    }).plaintextKey;

    keyAlphaNoCompositionsWrite = repo.issueApiKey({
      tenantId: TENANT_A_ID,
      keyId: 'key_alpha_ro',
      scopes: ['templates:read', 'compositions:read'],
    }).plaintextKey;

    // Seed ready image asset under Tenant A
    repo.createAsset(TENANT_A_ID, {
      id: 'ast_alpha_product',
      filename: 'product.png',
      kind: 'image',
      mimeType: 'image/png',
      bytes: 10240,
      sha256: 'a'.repeat(64),
      rights: { basis: 'owned', source: 'Alpha Studio', attribution: 'Alpha Corp' },
    });

    // Seed processing (non-ready) image asset under Tenant A
    pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
      tx.insertScoped('assets', {
        tenant_id: TENANT_A_ID,
        id: 'ast_alpha_pending',
        filename: 'pending.png',
        kind: 'image',
        status: 'processing',
        current_version: 1,
        visibility: 'tenant_private',
        rights_json: '{}',
        created_at: '2026-11-03T00:00:00Z',
        updated_at: '2026-11-03T00:00:00Z',
      });
    });

    // Seed ready video asset under Tenant A (to test kind mismatch)
    pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
      tx.insertScoped('assets', {
        tenant_id: TENANT_A_ID,
        id: 'ast_alpha_video',
        filename: 'clip.mp4',
        kind: 'video',
        status: 'ready',
        current_version: 1,
        visibility: 'tenant_private',
        rights_json: '{}',
        created_at: '2026-11-03T00:00:00Z',
        updated_at: '2026-11-03T00:00:00Z',
      });
    });

    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });

    server = createServer({ config, repository: repo });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });

  // ==========================================================================
  // 1. Template Catalog
  // ==========================================================================
  describe('1. Template Catalog (Curated vs Tenant-Private, Listing & IDOR)', () => {
    it('GET /v1/templates lists curated starter template and tenant-private templates with correct visibility', async () => {
      // Create a private template under Tenant A
      const createRes = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-create-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'tpl_alpha_sale',
          name: 'Flash Sale Template',
          variables_schema: {
            type: 'object',
            properties: {
              headline: { type: 'string', minLength: 1, maxLength: 100 },
            },
            required: ['headline'],
          },
          defaults: { headline: 'Siêu giảm giá' },
          composition_spec: buildTemplateSpecWithBindings({ textBinding: 'headline' }),
          supported_locales: ['vi-VN', 'en-US'],
        }),
      });
      assert.strictEqual(createRes.status, 201);

      // Tenant A lists templates
      const listResA = await fetch(`${baseUrl}/v1/templates`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(listResA.status, 200);
      const listA = await listResA.json();
      assert.ok(Array.isArray(listA.data));

      const curatedStarter = listA.data.find((t) => t.id === 'tpl_promo_starter');
      assert.ok(curatedStarter, 'Curated template tpl_promo_starter must be visible to Tenant A');
      assert.strictEqual(curatedStarter.visibility, 'curated');

      const alphaTpl = listA.data.find((t) => t.id === 'tpl_alpha_sale');
      assert.ok(alphaTpl, 'Tenant A template must be visible to Tenant A');
      assert.strictEqual(alphaTpl.visibility, 'tenant');

      // Tenant B lists templates: should see curated template, but NOT Tenant A's private template
      const listResB = await fetch(`${baseUrl}/v1/templates`, {
        headers: { Authorization: `Bearer ${keyBeta}` },
      });
      assert.strictEqual(listResB.status, 200);
      const listB = await listResB.json();
      assert.ok(listB.data.some((t) => t.id === 'tpl_promo_starter'));
      assert.strictEqual(listB.data.some((t) => t.id === 'tpl_alpha_sale'), false);
    });

    it('GET /v1/templates/{id}/revisions/{revision} returns exact immutable spec or 404 for cross-tenant IDOR', async () => {
      // 1. Curated template revision 1 is accessible to any tenant
      const resCurated = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/revisions/1`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(resCurated.status, 200);
      const curated = await resCurated.json();
      assert.strictEqual(curated.id, 'tpl_promo_starter');
      assert.strictEqual(curated.revision, 1);
      assert.ok(curated.source_digest);
      assert.ok(curated.variables_schema);
      assert.deepStrictEqual(curated.supported_locales, ['vi-VN', 'en-US']);

      // 2. Tenant A reads its own private template revision
      const resAlpha = await fetch(`${baseUrl}/v1/templates/tpl_alpha_sale/revisions/1`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(resAlpha.status, 200);

      // 3. Tenant B probing Tenant A's private template gets 404 NOT_FOUND (never 403)
      const resProbing = await fetch(`${baseUrl}/v1/templates/tpl_alpha_sale/revisions/1`, {
        headers: { Authorization: `Bearer ${keyBeta}` },
      });
      assert.strictEqual(resProbing.status, 404);
      const err = await resProbing.json();
      assert.strictEqual(err.error.code, 'NOT_FOUND');

      // 4. Non-existent revision gets 404
      const resNonExistent = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/revisions/999`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(resNonExistent.status, 404);
    });

    it('supports signed cursor pagination on /v1/templates', async () => {
      const page1Res = await fetch(`${baseUrl}/v1/templates?limit=1`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(page1Res.status, 200);
      const page1 = await page1Res.json();
      assert.strictEqual(page1.data.length, 1);
      assert.ok(page1.next_cursor);

      const page2Res = await fetch(`${baseUrl}/v1/templates?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(page2Res.status, 200);
      const page2 = await page2Res.json();
      assert.strictEqual(page2.data.length, 1);
      assert.notStrictEqual(page2.data[0].id, page1.data[0].id);
    });
  });

  // ==========================================================================
  // 2. Variable Schema Validation & Binding Position Guards
  // ==========================================================================
  describe('2. Variable Schema Validation & Binding Position Guards', () => {
    it('rejects invalid variable names (e.g. uppercase, starting with number)', async () => {
      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-bad-name-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Bad Var Template',
          variables_schema: {
            type: 'object',
            properties: {
              'INVALID-NAME': { type: 'string' },
            },
          },
          defaults: { 'INVALID-NAME': 'value' },
          composition_spec: buildBaseSpec(),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'INVALID_VARIABLE_NAME'));
    });

    it('rejects remote $ref in variables_schema', async () => {
      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-remote-ref-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Remote Ref Template',
          variables_schema: {
            type: 'object',
            properties: {
              headline: { $ref: 'https://evil.example.invalid/schema.json' },
            },
          },
          defaults: {},
          composition_spec: buildBaseSpec(),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'FORBIDDEN_REMOTE_REF'));
    });

    it('rejects variable bindings in forbidden positions (e.g. canvas, fps, engine, font_id)', async () => {
      // Attempting to bind variable in canvas.width
      const badSpec = buildBaseSpec();
      badSpec.canvas.width = { variable: 'bad_width' };

      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-bad-binding-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Bad Binding Template',
          variables_schema: {
            type: 'object',
            properties: {
              bad_width: { type: 'integer' },
            },
          },
          defaults: { bad_width: 720 },
          composition_spec: badSpec,
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'INVALID_BINDING_POSITION'));
    });

    it('rejects binding referencing an undeclared variable', async () => {
      const specWithUndeclared = buildTemplateSpecWithBindings({ textBinding: 'not_in_schema' });

      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-undeclared-var-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Undeclared Var Template',
          variables_schema: {
            type: 'object',
            properties: {
              declared_var: { type: 'string' },
            },
          },
          defaults: { declared_var: 'ok' },
          composition_spec: specWithUndeclared,
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(body.error.details.some((d) => d.code === 'UNDECLARED_VARIABLE'));
    });
  });

  // ==========================================================================
  // 3. Curated Fork Path & Template Revisions (System Catalog Immutability)
  // ==========================================================================
  describe('3. Curated Fork Path & Template Revisions (Catalog Immutability)', () => {
    it('blocks direct revision creation on curated public template (returns 404 NOT_FOUND)', async () => {
      // Attempting to add revision 2 directly to tpl_promo_starter in system_catalog
      const res = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-mutate-curated-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Illegal mutation attempt on curated public catalog',
          name: 'Hacked Curated Starter',
          variables_schema: { type: 'object' },
          defaults: {},
          composition_spec: buildBaseSpec(),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'NOT_FOUND');
    });

    it('successfully forks curated template via POST /v1/templates with source_template provenance', async () => {
      // Curated fork path: create a tenant template declaring source_template provenance
      const res = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-fork-curated-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'tpl_alpha_curated_fork',
          name: 'Alpha Forked Promo Starter',
          source_template: {
            id: 'tpl_promo_starter',
            revision: 1,
          },
          variables_schema: {
            type: 'object',
            required: ['headline'],
            properties: {
              headline: { type: 'string', minLength: 1, maxLength: 200 },
              badge: { type: 'string', maxLength: 50 },
            },
          },
          defaults: {
            headline: 'Khuyến mãi đặc biệt Alpha',
            badge: 'MỚI',
          },
          composition_spec: buildTemplateSpecWithBindings({ textBinding: 'headline' }),
          supported_locales: ['vi-VN', 'en-US'],
        }),
      });
      assert.strictEqual(res.status, 201);
      const created = await res.json();
      assert.strictEqual(created.id, 'tpl_alpha_curated_fork');
      assert.strictEqual(created.revision, 1);
      assert.match(created.source_digest, /^[0-9a-f]{64}$/);

      // Verify provenance stored in database
      pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_migrator' }, (tx) => {
        const rows = tx.selectScoped(
          'templates',
          "id = 'tpl_alpha_curated_fork'",
        );
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(rows[0].source_template_id, 'tpl_promo_starter');
        assert.strictEqual(rows[0].source_template_revision, 1);
        assert.strictEqual(rows[0].source_template_tenant_id, SYSTEM_CATALOG_TENANT_ID);
        assert.strictEqual(rows[0].visibility, 'tenant_private');
      });
    });

    it('successfully forks via convenience POST /v1/templates/{id}/fork', async () => {
      const res = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/fork`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-fork-endpoint-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Convenience Fork Promo',
        }),
      });
      assert.strictEqual(res.status, 201);
      const forked = await res.json();
      assert.ok(forked.id.startsWith('tpl_'));
      assert.strictEqual(forked.revision, 1);
    });

    it('allows tenant to create revision 2 on their forked template, but rejects stale base_revision with 409', async () => {
      // 1. Creating revision 2 with stale base_revision (e.g. 99 instead of 1) -> 409 REVISION_CONFLICT
      const staleRes = await fetch(`${baseUrl}/v1/templates/tpl_alpha_curated_fork/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-rev2-stale-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 99,
          change_note: 'Stale attempt',
          name: 'Alpha Forked Promo v2',
          variables_schema: {
            type: 'object',
            properties: { headline: { type: 'string' } },
            required: ['headline'],
          },
          defaults: { headline: 'Tập 2' },
          composition_spec: buildTemplateSpecWithBindings({ textBinding: 'headline' }),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(staleRes.status, 409);
      const staleBody = await staleRes.json();
      assert.strictEqual(staleBody.error.code, 'REVISION_CONFLICT');

      // 2. Creating revision 2 with correct base_revision: 1 -> 201 Created
      const validRes = await fetch(`${baseUrl}/v1/templates/tpl_alpha_curated_fork/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-rev2-valid-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Updated headline schema to v2',
          name: 'Alpha Forked Promo v2',
          variables_schema: {
            type: 'object',
            properties: { headline: { type: 'string', minLength: 5 } },
            required: ['headline'],
          },
          defaults: { headline: 'Tiêu đề phiên bản 2' },
          composition_spec: buildTemplateSpecWithBindings({ textBinding: 'headline' }),
          supported_locales: ['vi-VN', 'en-US'],
        }),
      });
      assert.strictEqual(validRes.status, 201);
      const validBody = await validRes.json();
      assert.strictEqual(validBody.id, 'tpl_alpha_curated_fork');
      assert.strictEqual(validBody.revision, 2);
    });
  });

  // ==========================================================================
  // 4. Template Instantiation (POST /v1/templates/{id}/instantiate)
  // ==========================================================================
  describe('4. Template Instantiation (POST /v1/templates/{id}/instantiate)', () => {
    it('enforces required scopes (compositions:write + templates:read)', async () => {
      // API key with only templates:read and compositions:read lacks compositions:write
      const res = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlphaNoCompositionsWrite}`,
          'Idempotency-Key': 'idem-instantiate-scope-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Unauthorized Instantiate Test',
          variables: { headline: 'Test' },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(res.status, 403);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'INSUFFICIENT_SCOPE');
    });

    it('successfully instantiates a composition from curated starter template', async () => {
      const res = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-instantiate-curated-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Khuyến mãi tháng 11',
          variables: {
            headline: 'Ưu đãi hôm nay',
            price: '199.000 ₫',
          },
          locale: 'vi-VN',
        }),
      });

      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.ok(body.id.startsWith('cmp_'));
      assert.strictEqual(body.revision, 1);
      assert.deepStrictEqual(body.template, {
        id: 'tpl_promo_starter',
        revision: 1,
      });
      assert.strictEqual(body.schema_version, '1.0');
      assert.strictEqual(body.editable, true);

      // Verify composition is saved and bindings materialized into pure string
      const compRes = await fetch(`${baseUrl}/v1/compositions/${body.id}/revisions/1`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(compRes.status, 200);
      const comp = await compRes.json();
      assert.strictEqual(comp.spec.locale, 'vi-VN');
      assert.strictEqual(comp.spec.scenes[0].layers[0].content.text, 'Ưu đãi hôm nay');
    });

    it('applies defaults only when variable is absent; rejects explicit null for required variables', async () => {
      // 1. Absent optional variable: 'price' is omitted in variables, should take default '199.000 ₫'
      const resDefault = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-instantiate-default-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Default Test',
          variables: {
            headline: 'Tiêu đề cung cấp',
            // price omitted
          },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resDefault.status, 201);

      // 2. Explicit null provided for required 'headline': defaults must NOT replace null
      const resNull = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-instantiate-null-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Null Required Test',
          variables: {
            headline: null,
          },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resNull.status, 422);
      const nullBody = await resNull.json();
      assert.strictEqual(nullBody.error.code, 'VALIDATION_FAILED');
      assert.ok(nullBody.error.details.some((d) => d.code === 'MISSING_REQUIRED_VARIABLE'));
    });

    it('rejects unknown variables and missing required variables', async () => {
      const resUnknown = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-instantiate-unknown-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Unknown Var Test',
          variables: {
            headline: 'Valid',
            malicious_injection: 'DROP TABLE',
          },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resUnknown.status, 422);
      const unknownBody = await resUnknown.json();
      assert.strictEqual(unknownBody.error.code, 'VALIDATION_FAILED');
      assert.ok(unknownBody.error.details.some((d) => d.code === 'UNKNOWN_VARIABLE'));
    });

    it('rejects unsupported locale', async () => {
      const resLocale = await fetch(`${baseUrl}/v1/templates/tpl_promo_starter/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-instantiate-locale-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Locale Test',
          variables: { headline: 'Test' },
          locale: 'fr-FR', // not in ['vi-VN', 'en-US']
        }),
      });
      assert.strictEqual(resLocale.status, 422);
      const localeBody = await resLocale.json();
      assert.strictEqual(localeBody.error.code, 'VALIDATION_FAILED');
      assert.ok(localeBody.error.details.some((d) => d.code === 'UNSUPPORTED_LOCALE'));
    });

    it('validates bound asset_id variables: rejects nonexistent/foreign, non-ready, and kind-mismatched assets', async () => {
      // 1. Create template with an image asset variable binding
      const tplRes = await fetch(`${baseUrl}/v1/templates`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-tpl-asset-var-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'tpl_alpha_image_card',
          name: 'Image Card Template',
          variables_schema: {
            type: 'object',
            required: ['hero_image_id'],
            properties: {
              hero_image_id: { type: 'string' },
            },
          },
          defaults: {
            hero_image_id: 'ast_alpha_product',
          },
          composition_spec: buildTemplateSpecWithBindings({
            textBinding: null,
            assetBinding: 'hero_image_id',
          }),
          supported_locales: ['vi-VN'],
        }),
      });
      assert.strictEqual(tplRes.status, 201);

      // 2. Instantiate referencing non-existent / foreign asset -> 422 ASSET_NOT_FOUND
      const resForeign = await fetch(`${baseUrl}/v1/templates/tpl_alpha_image_card/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-inst-foreign-asset-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Foreign Asset Probe',
          variables: { hero_image_id: 'ast_foreign_ghost' },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resForeign.status, 422);
      const foreignBody = await resForeign.json();
      assert.ok(foreignBody.error.details.some((d) => d.code === 'ASSET_NOT_FOUND'));

      // 3. Instantiate referencing non-ready asset -> 422 ASSET_NOT_READY
      const resPending = await fetch(`${baseUrl}/v1/templates/tpl_alpha_image_card/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-inst-pending-asset-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Pending Asset Probe',
          variables: { hero_image_id: 'ast_alpha_pending' },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resPending.status, 422);
      const pendingBody = await resPending.json();
      assert.ok(pendingBody.error.details.some((d) => d.code === 'ASSET_NOT_READY'));

      // 4. Instantiate referencing kind mismatch (video asset in image layer) -> 422 INVALID_ASSET_TYPE
      const resKindMismatch = await fetch(`${baseUrl}/v1/templates/tpl_alpha_image_card/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-inst-kind-mismatch-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Kind Mismatch Probe',
          variables: { hero_image_id: 'ast_alpha_video' },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resKindMismatch.status, 422);
      const mismatchBody = await resKindMismatch.json();
      assert.ok(mismatchBody.error.details.some((d) => d.code === 'INVALID_ASSET_TYPE'));

      // 5. Instantiate with valid ready image asset succeeds -> 201
      const resValid = await fetch(`${baseUrl}/v1/templates/tpl_alpha_image_card/instantiate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-inst-valid-asset-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template_revision: 1,
          name: 'Valid Asset Instantiation',
          variables: { hero_image_id: 'ast_alpha_product' },
          locale: 'vi-VN',
        }),
      });
      assert.strictEqual(resValid.status, 201);
    });
  });

  // ==========================================================================
  // 5. Composition Revisions, Optimistic Concurrency & 409 Stale Base Revision
  // ==========================================================================
  describe('5. Composition Revisions, Optimistic Concurrency & Stale Base Revision 409', () => {
    let testCompId;

    it('creates composition revision 1 and creates revision 2 with matching base_revision: 1', async () => {
      const createRes = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-comp-create-rev-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Versioned Campaign Video',
          spec: buildBaseSpec({ headline: 'Original Title v1', sceneRevision: 1 }),
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const created = await createRes.json();
      testCompId = created.id;
      assert.strictEqual(created.revision, 1);

      // Create revision 2
      const rev2Res = await fetch(`${baseUrl}/v1/compositions/${testCompId}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-comp-rev2-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Update headline text',
          spec: buildBaseSpec({ headline: 'Updated Title v2', sceneRevision: 2 }),
        }),
      });
      assert.strictEqual(rev2Res.status, 201);
      const rev2Body = await rev2Res.json();
      assert.strictEqual(rev2Body.id, testCompId);
      assert.strictEqual(rev2Body.revision, 2);
      assert.match(rev2Body.render_hash, /^[0-9a-f]{64}$/);
    });

    it('rejects stale base_revision with 409 REVISION_CONFLICT', async () => {
      // Current revision is 2. Submitting with base_revision: 1 must fail with 409
      const staleRes = await fetch(`${baseUrl}/v1/compositions/${testCompId}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-comp-stale-409-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Stale update attempt',
          spec: buildBaseSpec({ headline: 'Stale Title' }),
        }),
      });

      assert.strictEqual(staleRes.status, 409);
      const body = await staleRes.json();
      assert.strictEqual(body.error.code, 'REVISION_CONFLICT');
      assert.ok(body.error.message.includes('Expected base_revision 2, received 1'));
    });

    it('enforces concurrency race safety: concurrent requests with same base_revision result in exactly one 201 and one 409', async () => {
      // Current revision is 2. Fire two concurrent requests both claiming base_revision: 2
      const [res1, res2] = await Promise.all([
        fetch(`${baseUrl}/v1/compositions/${testCompId}/revisions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha}`,
            'Idempotency-Key': 'idem-race-A',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            base_revision: 2,
            change_note: 'Concurrent candidate A',
            spec: buildBaseSpec({ headline: 'Candidate A Title' }),
          }),
        }),
        fetch(`${baseUrl}/v1/compositions/${testCompId}/revisions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${keyAlpha}`,
            'Idempotency-Key': 'idem-race-B',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            base_revision: 2,
            change_note: 'Concurrent candidate B',
            spec: buildBaseSpec({ headline: 'Candidate B Title' }),
          }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      assert.deepStrictEqual(
        statuses,
        [201, 409],
        `Concurrent race must yield exactly one 201 and one 409, got ${JSON.stringify(statuses)}`,
      );
    });
  });

  // ==========================================================================
  // 6. Immutable Scene Versions & Database Triggers
  // ==========================================================================
  describe('6. Immutable Scene Versions & Database Immutability Triggers', () => {
    it('automatically increments scene revision when content changed and client kept revision low ("không tin revision client tự giữ thấp")', async () => {
      // 1. Create composition with scene_intro at revision 1
      const createRes = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-scene-immut-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Scene Revision Auto-Increment Test',
          spec: buildBaseSpec({ headline: 'Original Headline', sceneRevision: 1 }),
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const comp = await createRes.json();

      // 2. Post revision 2 with modified scene content BUT keeping scene revision at 1
      const modifiedSpec = buildBaseSpec({ headline: 'Modified Headline Content', sceneRevision: 1 });
      const revRes = await fetch(`${baseUrl}/v1/compositions/${comp.id}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-scene-immut-2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Edited scene text without bumping scene revision',
          spec: modifiedSpec,
        }),
      });

      assert.strictEqual(revRes.status, 201);
      const revBody = await revRes.json();
      assert.strictEqual(revBody.revision, 2);

      // Verify server auto-incremented scene revision to 2
      const getRev2 = await fetch(`${baseUrl}/v1/compositions/${comp.id}/revisions/2`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      assert.strictEqual(getRev2.status, 200);
      const rev2Doc = await getRev2.json();
      assert.strictEqual(
        rev2Doc.spec.scenes[0].revision,
        2,
        'Server must have auto-incremented scene revision to 2 because scene content was modified',
      );
    });

    it('keeps scene revision unchanged when scene content is unchanged across composition revisions', async () => {
      // Create composition revision 1
      const createRes = await fetch(`${baseUrl}/v1/compositions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-scene-unchanged-1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Unchanged Scene Test',
          spec: buildBaseSpec({ headline: 'Stable Headline', sceneRevision: 1 }),
        }),
      });
      assert.strictEqual(createRes.status, 201);
      const comp = await createRes.json();

      // Post revision 2 with SAME scene content (only composition change_note or metadata changed)
      const sameSpec = buildBaseSpec({ headline: 'Stable Headline', sceneRevision: 1 });
      const rev2Res = await fetch(`${baseUrl}/v1/compositions/${comp.id}/revisions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyAlpha}`,
          'Idempotency-Key': 'idem-scene-unchanged-2',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          base_revision: 1,
          change_note: 'Metadata note update',
          spec: sameSpec,
        }),
      });
      assert.strictEqual(rev2Res.status, 201);

      const getRev2 = await fetch(`${baseUrl}/v1/compositions/${comp.id}/revisions/2`, {
        headers: { Authorization: `Bearer ${keyAlpha}` },
      });
      const rev2Doc = await getRev2.json();
      assert.strictEqual(
        rev2Doc.spec.scenes[0].revision,
        1,
        'Scene revision must remain 1 because content was completely identical',
      );
    });

    it('database immutability triggers block direct UPDATE on composition_revisions and template_revisions', () => {
      // Attempt direct UPDATE on composition_revisions
      assert.throws(
        () => {
          db.prepare("UPDATE composition_revisions SET render_hash = 'tampered'").run();
        },
        (err) => err instanceof Error && err.message.includes('IMMUTABLE_RECORD_VIOLATION'),
        'Direct UPDATE on composition_revisions must fail with IMMUTABLE_RECORD_VIOLATION',
      );

      // Attempt direct UPDATE on template_revisions
      assert.throws(
        () => {
          db.prepare("UPDATE template_revisions SET name = 'tampered'").run();
        },
        (err) => err instanceof Error && err.message.includes('IMMUTABLE_RECORD_VIOLATION'),
        'Direct UPDATE on template_revisions must fail with IMMUTABLE_RECORD_VIOLATION',
      );
    });
  });
});
