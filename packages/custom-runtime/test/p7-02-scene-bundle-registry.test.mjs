// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import crypto from 'node:crypto';

import {
  SceneBundleRegistry,
  DEFAULT_BUNDLE_PARAMETER_SCHEMA,
  DEFAULT_ENTRYPOINT_SOURCE,
  isCustomCodeFeatureEnabled,
  assertCustomCodeExecutionAllowed,
  validateBundleId,
  validateParameterSchemaDefinition,
  validateBundleParameters,
  extractParameterSchemaDefaults,
  hasCatastrophicBacktrackingRisk,
  computeDeterministicSourceDigest,
  computeDeterministicBuildDigest,
  verifySourceIntegrity,
  verifyBuildIntegrity,
  normalizeSourceFilePath,
  packFilesToTarArchive,
  unpackFilesFromTarArchive,
  createSceneBundleProvenance,
  verifyProvenanceIntegrity,
  getSceneBundleOpenApiSpec,
  validateOpenApiSpecification,
  extendOpenApiWithSceneBundles,
  runSceneBundleRegistrySelfTest,
  CustomRuntimeError,
  CUSTOM_BUNDLE_QUOTAS,
} from '../index.mjs';

describe('P7-02: Scene Bundle Registry & Multi-Tenant Isolation', () => {
  it('creates scene bundle with initial draft revision and custom source files', () => {
    const registry = new SceneBundleRegistry();
    const { bundle, revision } = registry.createBundle('tenant-alpha', {
      id: 'custom-card-v1',
      name: 'Custom Card Scene',
      description: 'Animated card component scene',
      tags: ['cards', 'ui'],
      entrypoint: 'index.js',
      source_files: [
        { path: 'index.js', content: DEFAULT_ENTRYPOINT_SOURCE },
        { path: 'styles.css', content: '.card { border-radius: 8px; }' },
      ],
    });

    assert.strictEqual(bundle.id, 'custom-card-v1');
    assert.strictEqual(bundle.tenant_id, 'tenant-alpha');
    assert.strictEqual(bundle.latest_revision, 0); // Not published yet
    assert.strictEqual(bundle.max_revision, 1);
    assert.strictEqual(revision.revision, 1);
    assert.strictEqual(revision.status, 'draft');
    assert.strictEqual(revision.source_files.size, 2);
    assert.ok(revision.source_sha256.length === 64);
    assert.ok(revision.build_sha256.length === 64);
  });

  it('retrieves scene bundle and lists with tag filters and pagination', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'bundle-1',
      name: 'Bundle One',
      tags: ['highlight', 'v1'],
    });
    registry.createBundle('tenant-alpha', {
      id: 'bundle-2',
      name: 'Bundle Two',
      tags: ['highlight', 'v2'],
    });
    registry.createBundle('tenant-alpha', {
      id: 'bundle-3',
      name: 'Bundle Three',
      tags: ['other'],
    });

    const retrieved = registry.getBundle('tenant-alpha', 'bundle-1');
    assert.strictEqual(retrieved.name, 'Bundle One');

    const filtered = registry.listBundles('tenant-alpha', { tag: 'highlight' });
    assert.strictEqual(filtered.total, 2);

    const paginated = registry.listBundles('tenant-alpha', { limit: 1, offset: 0, include_global: false });
    assert.strictEqual(paginated.items.length, 1);
    assert.strictEqual(paginated.total, 3);
  });

  it('updates bundle metadata and soft deletes/archives cleanly', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'bundle-updatable',
      name: 'Original Name',
      description: 'Original Desc',
      tags: ['orig'],
    });

    const updated = registry.updateBundle('tenant-alpha', 'bundle-updatable', {
      name: 'New Name',
      description: 'New Desc',
      tags: ['new', 'updated'],
    });

    assert.strictEqual(updated.name, 'New Name');
    assert.strictEqual(updated.description, 'New Desc');
    assert.deepStrictEqual(updated.tags, ['new', 'updated']);

    const deleted = registry.deleteBundle('tenant-alpha', 'bundle-updatable');
    assert.strictEqual(deleted, true);

    assert.throws(
      () => registry.getBundle('tenant-alpha', 'bundle-updatable'),
      (err) => err instanceof CustomRuntimeError && err.code === 'BUNDLE_NOT_FOUND',
    );
  });

  it('enforces strict multi-tenant isolation and zero IDOR leakage across tenants', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'secret-alpha-bundle',
      name: 'Alpha Secret',
    });

    // Querying by tenant-beta must return BUNDLE_NOT_FOUND, not reveal existence
    assert.throws(
      () => registry.getBundle('tenant-beta', 'secret-alpha-bundle'),
      (err) => err instanceof CustomRuntimeError && err.code === 'BUNDLE_NOT_FOUND',
    );

    assert.throws(
      () => registry.updateBundle('tenant-beta', 'secret-alpha-bundle', { name: 'Attempt' }),
      (err) => err instanceof CustomRuntimeError && err.code === 'BUNDLE_NOT_FOUND',
    );

    assert.throws(
      () => registry.createRevision('tenant-beta', 'secret-alpha-bundle', { base_revision: 0 }),
      (err) => err instanceof CustomRuntimeError && err.code === 'BUNDLE_NOT_FOUND',
    );

    assert.throws(
      () => registry.downloadSource('tenant-beta', 'secret-alpha-bundle', 1),
      (err) => err instanceof CustomRuntimeError && err.code === 'BUNDLE_NOT_FOUND',
    );
  });

  it('seeds global curated catalog and prevents direct mutation by tenants', () => {
    const registry = new SceneBundleRegistry();
    const globalBundle = registry.getBundle('tenant-alpha', 'global-kinetic-title');
    assert.strictEqual(globalBundle.is_global, true);
    assert.strictEqual(globalBundle.tenant_id, 'global');
    assert.strictEqual(globalBundle.latest_revision, 1);

    // Any tenant can view revisions and download
    const rev1 = registry.getRevision('tenant-alpha', 'global-kinetic-title', 1);
    assert.strictEqual(rev1.status, 'published');

    // Tenants cannot mutate or archive curated global catalog
    assert.throws(
      () => registry.updateBundle('tenant-alpha', 'global-kinetic-title', { name: 'Override' }),
      (err) => err instanceof CustomRuntimeError && err.code === 'FORBIDDEN',
    );

    assert.throws(
      () => registry.deleteBundle('tenant-alpha', 'global-kinetic-title'),
      (err) => err instanceof CustomRuntimeError && err.code === 'FORBIDDEN',
    );

    assert.throws(
      () => registry.createRevision('tenant-alpha', 'global-kinetic-title', { base_revision: 1 }),
      (err) => err instanceof CustomRuntimeError && err.code === 'FORBIDDEN',
    );
  });
});

describe('P7-02: Editable Revisions, Concurrency Control & Immutability', () => {
  it('creates draft revisions with optimistic concurrency control and detects conflicts (409)', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'versioned-scene',
      name: 'Versioned Scene',
    });

    // Publish revision 1
    registry.publishRevision('tenant-alpha', 'versioned-scene', 1);

    // Create revision 2 with base_revision: 1
    const rev2 = registry.createRevision('tenant-alpha', 'versioned-scene', {
      base_revision: 1,
      change_summary: 'Adding animations',
    });
    assert.strictEqual(rev2.revision, 2);
    assert.strictEqual(rev2.status, 'draft');
    assert.strictEqual(rev2.base_revision, 1);

    // Publish revision 2
    registry.publishRevision('tenant-alpha', 'versioned-scene', 2);

    // Attempting to create a revision with stale base_revision: 1 throws REVISION_CONFLICT
    assert.throws(
      () =>
        registry.createRevision('tenant-alpha', 'versioned-scene', {
          base_revision: 1, // Stale! Current latest is 2
        }),
      (err) => err instanceof CustomRuntimeError && err.code === 'REVISION_CONFLICT',
    );

    // Providing correct base_revision: 2 succeeds
    const rev3 = registry.createRevision('tenant-alpha', 'versioned-scene', {
      base_revision: 2,
    });
    assert.strictEqual(rev3.revision, 3);
  });

  it('allows editing draft revisions and recalculates digests and CSP hash', () => {
    const registry = new SceneBundleRegistry();
    const { revision } = registry.createBundle('tenant-alpha', {
      id: 'draft-editor-test',
      name: 'Draft Editor',
    });

    const originalSha = revision.source_sha256;

    // Update draft revision by adding a file and updating parameter schema
    const updated = registry.updateDraftRevision('tenant-alpha', 'draft-editor-test', 1, {
      add_or_update_files: [
        { path: 'theme.json', content: '{"primary":"#00ff00"}' },
      ],
      change_summary: 'Added theme.json',
      parameter_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', default: 'Hello' },
        },
      },
    });

    assert.strictEqual(updated.status, 'draft');
    assert.ok(updated.source_files.has('theme.json'));
    assert.notStrictEqual(updated.source_sha256, originalSha);
    assert.strictEqual(updated.change_summary, 'Added theme.json');
  });

  it('enforces that sealed/published revisions are strictly immutable (REVISION_SEALED)', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'immutable-test',
      name: 'Immutable Test',
    });

    // Publish revision 1
    const published = registry.publishRevision('tenant-alpha', 'immutable-test', 1);
    assert.strictEqual(published.status, 'published');
    assert.ok(published.sealed_at !== null);

    // Attempting to edit sealed revision must throw REVISION_SEALED
    assert.throws(
      () =>
        registry.updateDraftRevision('tenant-alpha', 'immutable-test', 1, {
          change_summary: 'Illegal mutation',
        }),
      (err) => err instanceof CustomRuntimeError && err.code === 'REVISION_SEALED',
    );
  });

  it('forks curated global bundle into tenant bundle with complete lineage and provenance', () => {
    const registry = new SceneBundleRegistry();
    const { bundle, revision } = registry.forkBundle('global-kinetic-title', 'tenant-alpha', {
      new_bundle_id: 'tenant-kinetic-custom',
      name: 'Tenant Kinetic Custom',
    });

    assert.strictEqual(bundle.id, 'tenant-kinetic-custom');
    assert.strictEqual(bundle.tenant_id, 'tenant-alpha');
    assert.strictEqual(bundle.is_global, false);
    assert.strictEqual(revision.provenance.authoring_type, 'fork');
    assert.deepStrictEqual(revision.provenance.source_bundle, {
      bundle_id: 'global-kinetic-title',
      revision: 1,
    });
    assert.ok(verifyProvenanceIntegrity(revision.provenance));
  });
});

describe('P7-02: Deterministic Digests, Quotas & Tarball Packaging', () => {
  it('computes deterministic source digest invariant to file order', () => {
    const files1 = [
      { path: 'b.js', content: 'const b = 20;' },
      { path: 'a.js', content: 'const a = 10;' },
      { path: 'nested/c.js', content: 'const c = 30;' },
    ];

    const files2 = [
      { path: 'nested/c.js', content: 'const c = 30;' },
      { path: 'a.js', content: 'const a = 10;' },
      { path: 'b.js', content: 'const b = 20;' },
    ];

    const res1 = computeDeterministicSourceDigest(files1);
    const res2 = computeDeterministicSourceDigest(files2);

    assert.strictEqual(res1.sourceSha256, res2.sourceSha256);
    assert.strictEqual(res1.totalFiles, 3);
    assert.strictEqual(res1.manifest[0]?.path, 'a.js');
    assert.strictEqual(res1.manifest[1]?.path, 'b.js');
    assert.strictEqual(res1.manifest[2]?.path, 'nested/c.js');
  });

  it('verifies source and build digests and detects tampering', () => {
    const files = [{ path: 'main.js', content: 'console.log("hello");' }];
    const { sourceSha256 } = computeDeterministicSourceDigest(files);

    assert.strictEqual(verifySourceIntegrity(files, sourceSha256), true);

    // Tampered files
    const tampered = [{ path: 'main.js', content: 'console.log("tampered");' }];
    assert.throws(
      () => verifySourceIntegrity(tampered, sourceSha256),
      (err) => err instanceof CustomRuntimeError && err.code === 'DIGEST_MISMATCH',
    );
  });

  it('enforces quotas: max 100 files, max 5 MiB source, max 20 MiB built assets', () => {
    // Test max files quota
    const tooManyFiles = Array.from({ length: 101 }, (_, i) => ({
      path: `file_${i}.js`,
      content: 'var x = 1;',
    }));
    assert.throws(
      () => computeDeterministicSourceDigest(tooManyFiles),
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_RESOURCE_LIMIT',
    );

    // Test max source bytes quota (5 MiB)
    const giantFile = [
      {
        path: 'big.js',
        content: Buffer.alloc(CUSTOM_BUNDLE_QUOTAS.maxSourceBytes + 1, 'x'),
      },
    ];
    assert.throws(
      () => computeDeterministicSourceDigest(giantFile),
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_RESOURCE_LIMIT',
    );

    // Test max built assets bytes quota (20 MiB)
    const giantArtifact = [
      {
        path: 'bundle.js',
        content: Buffer.alloc(CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes + 1, 'x'),
      },
    ];
    assert.throws(
      () => computeDeterministicBuildDigest(giantArtifact),
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_RESOURCE_LIMIT',
    );
  });

  it('rejects path traversal, absolute paths, null bytes, and depth > 8', () => {
    assert.throws(() => normalizeSourceFilePath('../evil.js'), /traversal/);
    assert.throws(() => normalizeSourceFilePath('/etc/passwd'), /Absolute paths/);
    assert.throws(() => normalizeSourceFilePath('evil\0.js'), /Null bytes/);
    assert.throws(() => normalizeSourceFilePath('1/2/3/4/5/6/7/8/9/overflow.js'), /nesting depth/);
    assert.throws(() => normalizeSourceFilePath('.env'), /Forbidden/);
    assert.throws(() => normalizeSourceFilePath('node_modules/pkg/index.js'), /Forbidden/);
  });

  it('packs and unpacks UStar POSIX tarball preserving file names and contents', () => {
    const rawFiles = [
      { path: 'index.js', content: Buffer.from('console.log("test");') },
      { path: 'data/config.json', content: Buffer.from('{"key":"value"}') },
    ];

    const tarBuffer = packFilesToTarArchive(rawFiles);
    assert.ok(Buffer.isBuffer(tarBuffer));
    assert.ok(tarBuffer.length >= 1024);

    const unpacked = unpackFilesFromTarArchive(tarBuffer);
    assert.strictEqual(unpacked.length, 2);
    assert.strictEqual(unpacked[0]?.path, 'data/config.json');
    assert.strictEqual(unpacked[0]?.content.toString('utf-8'), '{"key":"value"}');
    assert.strictEqual(unpacked[1]?.path, 'index.js');
    assert.strictEqual(unpacked[1]?.content.toString('utf-8'), 'console.log("test");');
  });
});

describe('P7-02: Parameter Schema Validation & Parameter Compilation', () => {
  const testSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        minLength: 1,
        maxLength: 100,
        default: 'Welcome to Creativanta',
      },
      accent_color: {
        type: 'string',
        format: 'color',
        default: '#e94560',
      },
      duration_sec: {
        type: 'number',
        minimum: 1,
        maximum: 60,
        default: 10,
      },
      particle_count: {
        type: 'integer',
        minimum: 0,
        maximum: 500,
        default: 50,
      },
      enable_bloom: {
        type: 'boolean',
        default: true,
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 5,
        default: ['intro'],
      },
    },
    required: ['headline'],
    additionalProperties: false,
  };

  it('validates schema definition and extracts defaults', () => {
    const { valid, errors } = validateParameterSchemaDefinition(testSchema);
    assert.strictEqual(valid, true);
    assert.strictEqual(errors.length, 0);

    const defaults = extractParameterSchemaDefaults(testSchema);
    assert.strictEqual(defaults.headline, 'Welcome to Creativanta');
    assert.strictEqual(defaults.accent_color, '#e94560');
    assert.strictEqual(defaults.duration_sec, 10);
    assert.strictEqual(defaults.particle_count, 50);
    assert.strictEqual(defaults.enable_bloom, true);
    assert.deepStrictEqual(defaults.tags, ['intro']);
  });

  it('validates user parameters, injecting defaults for omitted optional properties', () => {
    const res = validateBundleParameters(testSchema, {
      headline: 'Custom Title',
      duration_sec: 15,
    });

    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.validatedParameters.headline, 'Custom Title');
    assert.strictEqual(res.validatedParameters.duration_sec, 15);
    // Defaults injected
    assert.strictEqual(res.validatedParameters.accent_color, '#e94560');
    assert.strictEqual(res.validatedParameters.particle_count, 50);
    assert.strictEqual(res.validatedParameters.enable_bloom, true);
  });

  it('detects type mismatches, range errors, and required missing parameters with JSON pointers', () => {
    const strictSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        duration_sec: { type: 'number', maximum: 60 },
        accent_color: { type: 'string', format: 'color' },
        particle_count: { type: 'integer' },
      },
      required: ['title'],
      additionalProperties: false,
    };

    const res = validateBundleParameters(strictSchema, {
      duration_sec: 999, // exceeds maximum 60
      accent_color: 'not-a-color', // invalid hex color
      particle_count: 3.14, // not an integer
    });

    assert.strictEqual(res.valid, false);
    assert.ok(res.errors.some((e) => e.pointer === '/title' && e.code === 'REQUIRED_FIELD_MISSING'));
    assert.ok(res.errors.some((e) => e.pointer === '/duration_sec' && e.code === 'OUT_OF_RANGE'));
    assert.ok(res.errors.some((e) => e.pointer === '/accent_color' && e.code === 'PATTERN_MISMATCH'));
    assert.ok(res.errors.some((e) => e.pointer === '/particle_count' && e.code === 'TYPE_MISMATCH'));
  });

  it('blocks prototype pollution attempts and ReDoS pattern risks', () => {
    const protoResult = validateBundleParameters(
      testSchema,
      JSON.parse('{"__proto__": {"admin": true}}'),
    );
    assert.strictEqual(protoResult.valid, false);
    assert.ok(protoResult.errors.some((e) => e.code === 'SECURITY_VIOLATION'));

    assert.strictEqual(hasCatastrophicBacktrackingRisk('(a+)+$'), true);
    assert.strictEqual(hasCatastrophicBacktrackingRisk('^[a-z0-9_-]+$'), false);
  });
});

describe('P7-02: Tamper-Evident Provenance Tracking', () => {
  it('creates AI-authored provenance record and verifies cryptographic digest', () => {
    const provenance = createSceneBundleProvenance({
      authoring_type: 'ai',
      author: 'agent-codex-v1',
      ai_metadata: {
        provider: 'anthropic-neutral-adapter',
        model: 'claude-3-5-sonnet',
        prompt_tokens: 1500,
        completion_tokens: 600,
        cost_usd: 0.021,
        job_id: 'job-987',
        brief_hash: 'c'.repeat(64),
      },
      rights_and_license: {
        license: 'MIT',
        copyright_holder: 'Tenant Beta',
        rights_provenance: 'prompt-contract-cleared',
        commercial_use_allowed: true,
      },
      declared_capabilities: ['webgl2', 'custom-fonts'],
      source_sha256: '1'.repeat(64),
      build_sha256: '2'.repeat(64),
    });

    assert.strictEqual(provenance.authoring_type, 'ai');
    assert.strictEqual(provenance.ai_metadata?.model, 'claude-3-5-sonnet');
    assert.strictEqual(provenance.provenance_digest.length, 64);
    assert.strictEqual(verifyProvenanceIntegrity(provenance), true);

    // Tampering with author or model invalidates integrity
    const tampered = { ...provenance, author: 'evil-spoof' };
    assert.strictEqual(verifyProvenanceIntegrity(tampered), false);
  });

  it('rejects forbidden capabilities like network, shell, or fs in declared_capabilities', () => {
    assert.throws(
      () =>
        createSceneBundleProvenance({
          authoring_type: 'human',
          author: 'dev',
          declared_capabilities: ['canvas-2d', 'network'],
          rights_and_license: { license: 'MIT' },
          source_sha256: '1'.repeat(64),
          build_sha256: '2'.repeat(64),
        }),
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });
});

describe('P7-02: Download Access & Path Traversal Defenses', () => {
  it('provides manifest download, tar download, and individual file download', () => {
    const registry = new SceneBundleRegistry();
    registry.createBundle('tenant-alpha', {
      id: 'download-suite',
      name: 'Download Suite',
      source_files: [
        { path: 'index.js', content: DEFAULT_ENTRYPOINT_SOURCE },
        { path: 'assets/badge.svg', content: '<svg></svg>' },
      ],
    });

    // Manifest format
    const manifest = registry.downloadSource('tenant-alpha', 'download-suite', 1, { format: 'manifest' });
    assert.strictEqual(manifest.format, 'manifest');
    assert.strictEqual(manifest.totalFiles, 2);

    // Tar format
    const tarDl = registry.downloadSource('tenant-alpha', 'download-suite', 1, { format: 'tar' });
    assert.strictEqual(tarDl.format, 'tar');
    assert.ok(Buffer.isBuffer(tarDl.data));

    // Single file download
    const single = registry.downloadSourceFile('tenant-alpha', 'download-suite', 1, 'assets/badge.svg');
    assert.strictEqual(single.path, 'assets/badge.svg');
    assert.strictEqual(single.mime_type, 'image/svg+xml');

    // Path traversal attempt in single file download
    assert.throws(
      () => registry.downloadSourceFile('tenant-alpha', 'download-suite', 1, '../index.js'),
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });
});

describe('P7-02: Full OpenAPI 3.1 Extension Specification', () => {
  it('validates OpenAPI 3.1 structure and confirms all 10 required routes', () => {
    const spec = getSceneBundleOpenApiSpec();
    const result = validateOpenApiSpecification(spec);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(spec.openapi, '3.1.0');

    const paths = /** @type {Record<string, unknown>} */ (spec.paths);
    const expected = [
      '/scene-bundles',
      '/scene-bundles/{id}',
      '/scene-bundles/{id}/revisions',
      '/scene-bundles/{id}/revisions/{revision}',
      '/scene-bundles/{id}/revisions/{revision}/source',
      '/scene-bundles/{id}/revisions/{revision}/source/{filePath}',
      '/scene-bundles/{id}/revisions/{revision}/build',
      '/scene-bundles/{id}/revisions/{revision}/validate',
      '/scene-bundles/{id}/revisions/{revision}/publish',
      '/scene-bundles/fork',
    ];

    for (const route of expected) {
      assert.ok(paths[route], `Route ${route} must exist in OpenAPI extension`);
    }
  });

  it('merges scene bundle OpenAPI extension into base OpenAPI spec cleanly', () => {
    const baseSpec = {
      openapi: '3.1.0',
      info: { title: 'Base API', version: '1.0.0' },
      paths: {
        '/templates': { get: { summary: 'List templates' } },
      },
      components: {
        schemas: { Template: { type: 'object' } },
        responses: {},
        securitySchemes: {},
      },
    };

    const extended = extendOpenApiWithSceneBundles(baseSpec);
    assert.ok(extended.paths['/templates']);
    assert.ok(extended.paths['/scene-bundles']);
    assert.ok(extended.components.schemas['SceneBundle']);
    assert.ok(extended.components.schemas['SceneBundleRevision']);
    assert.ok(extended.components.schemas['Template']);
  });
});

describe('P7-02: Feature Still Off & Execution Capability Gate', () => {
  it('confirms feature flag is disabled by default and execution is strictly blocked', () => {
    const registry = new SceneBundleRegistry();
    assert.strictEqual(isCustomCodeFeatureEnabled(registry.config), false);

    registry.createBundle('tenant-alpha', {
      id: 'feature-off-test',
      name: 'Feature Off Test',
    });
    registry.publishRevision('tenant-alpha', 'feature-off-test', 1);

    // Attempt to prepare custom scene execution while feature is off
    assert.throws(
      () =>
        registry.prepareCustomSceneExecution('tenant-alpha', {
          bundle_id: 'feature-off-test',
          revision: 1,
          parameters: { headline: 'Test' },
        }),
      (err) => err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED',
    );
  });

  it('allows scene execution only when feature is enabled and tenant is allowlisted', () => {
    const registry = new SceneBundleRegistry({
      config: {
        CVE_CUSTOM_CODE_ENABLED: true,
        CVE_CUSTOM_RUNTIME: 'microvm-firecracker-v1',
        CVE_CUSTOM_TENANT_ALLOWLIST: ['tenant-pilot'],
      },
    });

    registry.createBundle('tenant-pilot', {
      id: 'pilot-scene',
      name: 'Pilot Scene',
    });
    registry.publishRevision('tenant-pilot', 'pilot-scene', 1);

    // Pilot tenant succeeds
    const exec = registry.prepareCustomSceneExecution('tenant-pilot', {
      bundle_id: 'pilot-scene',
      revision: 1,
      parameters: { headline: 'Hello Pilot' },
    });
    assert.strictEqual(exec.bundle_id, 'pilot-scene');
    assert.strictEqual(exec.validated_parameters.headline, 'Hello Pilot');

    // Non-allowlisted tenant is blocked with UNSUPPORTED_CAPABILITY
    assert.throws(
      () =>
        registry.prepareCustomSceneExecution('tenant-other', {
          bundle_id: 'pilot-scene',
          revision: 1,
          parameters: {},
        }),
      (err) => err instanceof CustomRuntimeError && err.code === 'UNSUPPORTED_CAPABILITY',
    );
  });

  it('runs the full 13-check automated self-test suite via runSceneBundleRegistrySelfTest', async () => {
    const report = await runSceneBundleRegistrySelfTest();
    assert.strictEqual(report.status, 'PASS');
    assert.strictEqual(report.totalChecks, 13);
    assert.strictEqual(report.passedChecks, 13);
    assert.strictEqual(report.failedChecks, 0);
  });
});
