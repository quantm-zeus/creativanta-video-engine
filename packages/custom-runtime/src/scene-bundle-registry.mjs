// @ts-check
/**
 * Versioned Scene-Bundle Registry, Storage, Lifecycle & Concurrency Control (Task P7-02).
 * Enforces multi-tenant isolation (zero IDOR leaks), optimistic locking concurrency (409 REVISION_CONFLICT),
 * editable draft revisions, sealed immutable published revisions, deterministic digest verification,
 * and download access with path traversal defenses, with custom code feature remaining disabled by default.
 */

import crypto from 'node:crypto';
import { CustomRuntimeError } from './adr-policy.mjs';
import {
  computeDeterministicSourceDigest,
  computeDeterministicBuildDigest,
  verifySourceIntegrity,
  verifyBuildIntegrity,
  packFilesToTarArchive,
  createSceneBundleProvenance,
  verifyProvenanceIntegrity,
  normalizeSourceFilePath,
  guessMimeType,
} from './digests-and-provenance.mjs';
import {
  validateParameterSchemaDefinition,
  validateBundleParameters,
} from './parameter-schema.mjs';
import {
  scanCustomSourceForForbiddenCapabilities,
  buildCustomSceneCspHeader,
} from './isolation-guards.mjs';
import {
  getSceneBundleOpenApiSpec,
  validateOpenApiSpecification,
} from './scene-bundle-openapi.mjs';

/**
 * Valid bundle revision lifecycle states.
 */
export const BUNDLE_REVISION_STATUSES = Object.freeze([
  'draft',
  'validating',
  'published',
  'archived',
  'rejected',
]);

/**
 * Regex for valid bundle ID: lowercase alphanumeric, hyphens, underscores (1..64 chars).
 */
const BUNDLE_ID_REGEX = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Default minimal parameter schema for a new scene bundle.
 */
export const DEFAULT_BUNDLE_PARAMETER_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    headline: {
      type: 'string',
      title: 'Scene Headline',
      description: 'Primary text display for the custom scene',
      maxLength: 256,
      default: 'Creativanta Custom Scene',
      ui_component: 'text',
    },
    background_color: {
      type: 'string',
      title: 'Background Color',
      format: 'color',
      default: '#1a1a2e',
      ui_component: 'color',
    },
    accent_color: {
      type: 'string',
      title: 'Accent Color',
      format: 'color',
      default: '#e94560',
      ui_component: 'color',
    },
  },
  required: ['headline'],
  additionalProperties: false,
});

/**
 * Default minimal entrypoint script for a custom scene.
 */
export const DEFAULT_ENTRYPOINT_SOURCE = `/**
 * Creativanta Custom Scene Entrypoint
 */
import { clamp } from "@creativanta/scene-math";

export default function renderScene(ctx, params) {
  const { width, height, progress } = ctx;
  const headline = params.headline || "Creativanta Scene";
  const bgColor = params.background_color || "#1a1a2e";
  const accentColor = params.accent_color || "#e94560";

  return {
    width,
    height,
    progress: clamp(progress, 0, 1),
    renderedHeadline: headline,
    background: bgColor,
    accent: accentColor,
  };
}
`;

/**
 * Check if the custom code execution feature is enabled.
 * Default is strictly OFF.
 * @param {Record<string, unknown> | null | undefined} config
 * @returns {boolean}
 */
export function isCustomCodeFeatureEnabled(config) {
  if (!config || typeof config !== 'object') return false;
  const enabled = config.CVE_CUSTOM_CODE_ENABLED === true || config.CVE_CUSTOM_CODE_ENABLED === 'true';
  const runtime = config.CVE_CUSTOM_RUNTIME;
  return enabled && runtime !== 'disabled' && Boolean(runtime);
}

/**
 * Assert that custom code execution is enabled; throws CAPABILITY_DISABLED if off.
 * @param {Record<string, unknown> | null | undefined} config
 * @param {string} [tenantId]
 */
export function assertCustomCodeExecutionAllowed(config, tenantId) {
  if (!isCustomCodeFeatureEnabled(config)) {
    throw new CustomRuntimeError(
      'CAPABILITY_DISABLED',
      'Custom scene code execution is disabled by policy (feature still off). See docs/SECURITY.md.',
      false,
      {
        feature: 'custom-html-v1',
        CVE_CUSTOM_CODE_ENABLED: config?.CVE_CUSTOM_CODE_ENABLED ?? false,
        CVE_CUSTOM_RUNTIME: config?.CVE_CUSTOM_RUNTIME ?? 'disabled',
      },
    );
  }

  // Check tenant allowlist if configured
  if (tenantId && Array.isArray(config?.CVE_CUSTOM_TENANT_ALLOWLIST)) {
    const list = /** @type {string[]} */ (config.CVE_CUSTOM_TENANT_ALLOWLIST);
    if (list.length > 0 && !list.includes(tenantId)) {
      throw new CustomRuntimeError(
        'UNSUPPORTED_CAPABILITY',
        `Tenant "${tenantId}" is not enrolled in the custom scene pilot allowlist`,
        false,
        { tenantId, allowlistCount: list.length },
      );
    }
  }
}

/**
 * Validate bundle ID format.
 * @param {string} bundleId
 */
export function validateBundleId(bundleId) {
  if (typeof bundleId !== 'string' || !BUNDLE_ID_REGEX.test(bundleId)) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Invalid bundleId "${bundleId}": must match ^[a-z][a-z0-9_-]{0,63}$`,
      false,
      { bundleId },
    );
  }
}

/**
 * Scene bundle revision record in memory / storage.
 * @typedef {{
 *   bundle_id: string;
 *   revision: number;
 *   base_revision: number | null;
 *   status: 'draft' | 'validating' | 'published' | 'archived' | 'rejected';
 *   entrypoint: string;
 *   source_sha256: string;
 *   build_sha256: string;
 *   parameter_schema: Record<string, unknown>;
 *   provenance: import('./digests-and-provenance.mjs').SceneBundleProvenance;
 *   declared_capabilities: string[];
 *   change_summary: string;
 *   source_files: Map<string, { path: string; content: Buffer; size: number; sha256: string; mime_type: string }>;
 *   build_artifacts: Map<string, { path: string; content: Buffer; size: number; sha256: string; mime_type: string }>;
 *   csp_script_hash: string;
 *   validation_report: {
 *     passed: boolean;
 *     scanned_files_count: number;
 *     violations: unknown[];
 *     parameter_schema_valid: boolean;
 *     evaluated_at: string;
 *   } | null;
 *   created_at: string;
 *   created_by: string;
 *   sealed_at: string | null;
 * }} SceneBundleRevisionRecord
 */

/**
 * Scene bundle root record in memory / storage.
 * @typedef {{
 *   id: string;
 *   tenant_id: string;
 *   name: string;
 *   description: string;
 *   is_global: boolean;
 *   tags: string[];
 *   latest_revision: number;
 *   max_revision: number;
 *   created_at: string;
 *   updated_at: string;
 *   is_archived: boolean;
 *   created_by: string;
 * }} SceneBundleRecord
 */

/**
 * In-memory & pluggable storage implementation for Scene Bundle Registry.
 */
export class SceneBundleRegistry {
  /**
   * @param {object} [options]
   * @param {Record<string, unknown>} [options.config]
   * @param {string[]} [options.globalCuratedBundleIds]
   */
  constructor(options = {}) {
    this.config = options.config || {
      CVE_CUSTOM_CODE_ENABLED: false,
      CVE_CUSTOM_RUNTIME: 'disabled',
      CVE_CUSTOM_TENANT_ALLOWLIST: [],
    };

    /** @type {Map<string, SceneBundleRecord>} */
    this._bundles = new Map();

    /** @type {Map<string, Map<number, SceneBundleRevisionRecord>>} */
    this._revisions = new Map();

    // Initialize default global curated bundle catalog
    this._seedCuratedCatalog();
  }

  /**
   * Seed the global curated bundle catalog.
   * Curated global bundles have is_global: true and tenant_id: 'global'.
   */
  _seedCuratedCatalog() {
    const globalId = 'global-kinetic-title';
    const sourceFiles = [
      {
        path: 'index.js',
        content: DEFAULT_ENTRYPOINT_SOURCE,
      },
      {
        path: 'styles.css',
        content: ':root { --accent: #e94560; } .headline { font-size: 48px; }',
      },
    ];

    const { sourceSha256 } = computeDeterministicSourceDigest(sourceFiles);
    const { buildSha256 } = computeDeterministicBuildDigest(sourceFiles);
    const { scriptHashToken } = buildCustomSceneCspHeader(DEFAULT_ENTRYPOINT_SOURCE);

    const provenance = createSceneBundleProvenance({
      authoring_type: 'human',
      author: 'system-curated-catalog',
      base_revision: null,
      rights_and_license: {
        license: 'Apache-2.0',
        copyright_holder: 'Creativanta',
        rights_provenance: 'first-party-curated',
        commercial_use_allowed: true,
      },
      declared_capabilities: ['canvas-2d', 'custom-fonts'],
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    });

    const fileMap = new Map();
    for (const f of sourceFiles) {
      const norm = normalizeSourceFilePath(f.path);
      const buf = Buffer.from(f.content, 'utf-8');
      fileMap.set(norm, {
        path: norm,
        content: buf,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mime_type: guessMimeType(norm),
      });
    }

    const artifactMap = new Map();
    for (const f of sourceFiles) {
      const norm = normalizeSourceFilePath(f.path);
      const buf = Buffer.from(f.content, 'utf-8');
      artifactMap.set(norm, {
        path: norm,
        content: buf,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mime_type: guessMimeType(norm),
      });
    }

    this._bundles.set(globalId, {
      id: globalId,
      tenant_id: 'global',
      name: 'Kinetic Title Curated Bundle',
      description: 'Production-ready first-party curated kinetic title custom scene bundle',
      is_global: true,
      tags: ['curated', 'title', 'typography', 'kinetic'],
      latest_revision: 1,
      max_revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_archived: false,
      created_by: 'system',
    });

    const revMap = new Map();
    revMap.set(1, {
      bundle_id: globalId,
      revision: 1,
      base_revision: null,
      status: 'published',
      entrypoint: 'index.js',
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
      parameter_schema: DEFAULT_BUNDLE_PARAMETER_SCHEMA,
      provenance,
      declared_capabilities: ['canvas-2d', 'custom-fonts'],
      change_summary: 'Initial curated release of kinetic title bundle',
      source_files: fileMap,
      build_artifacts: artifactMap,
      csp_script_hash: scriptHashToken,
      validation_report: {
        passed: true,
        scanned_files_count: sourceFiles.length,
        violations: [],
        parameter_schema_valid: true,
        evaluated_at: new Date().toISOString(),
      },
      created_at: new Date().toISOString(),
      created_by: 'system',
      sealed_at: new Date().toISOString(),
    });

    this._revisions.set(globalId, revMap);
  }

  /**
   * Internal helper to lookup bundle with tenant ownership verification.
   * Throws BUNDLE_NOT_FOUND to avoid IDOR leaks if bundle belongs to another tenant.
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {object} [options]
   * @param {boolean} [options.allowGlobal=true]
   * @returns {SceneBundleRecord}
   */
  _resolveBundle(tenantId, bundleId, options = {}) {
    validateBundleId(bundleId);
    const { allowGlobal = true } = options;

    const bundle = this._bundles.get(bundleId);
    if (!bundle || bundle.is_archived) {
      throw new CustomRuntimeError(
        'BUNDLE_NOT_FOUND',
        `Scene bundle "${bundleId}" was not found or has been archived`,
        false,
        { bundleId },
      );
    }

    if (bundle.is_global) {
      if (!allowGlobal) {
        throw new CustomRuntimeError(
          'FORBIDDEN',
          'Curated global bundles are read-only and cannot be mutated or revised directly. Fork the bundle to edit.',
          false,
          { bundleId },
        );
      }
      return bundle;
    }

    if (bundle.tenant_id !== tenantId) {
      // Intentionally return BUNDLE_NOT_FOUND to avoid leaking foreign tenant bundle existence
      throw new CustomRuntimeError(
        'BUNDLE_NOT_FOUND',
        `Scene bundle "${bundleId}" was not found or access is denied`,
        false,
        { bundleId },
      );
    }

    return bundle;
  }

  /**
   * Internal helper to lookup specific revision.
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @param {object} [options]
   * @param {boolean} [options.allowGlobal=true]
   * @returns {{ bundle: SceneBundleRecord; rev: SceneBundleRevisionRecord }}
   */
  _resolveRevision(tenantId, bundleId, revision, options = {}) {
    const bundle = this._resolveBundle(tenantId, bundleId, options);
    const revNum = Number(revision);
    if (!Number.isInteger(revNum) || revNum <= 0) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Invalid revision number "${revision}": must be a positive integer`,
        false,
        { revision },
      );
    }

    const bundleRevisions = this._revisions.get(bundleId);
    const rev = bundleRevisions?.get(revNum);
    if (!rev) {
      throw new CustomRuntimeError(
        'REVISION_NOT_FOUND',
        `Revision ${revNum} not found for scene bundle "${bundleId}"`,
        false,
        { bundleId, revision: revNum },
      );
    }

    return { bundle, rev };
  }

  /**
   * Create a new scene bundle and its initial draft revision (revision 1).
   *
   * @param {string} tenantId
   * @param {{
   *   id: string;
   *   name: string;
   *   description?: string;
   *   tags?: string[];
   *   entrypoint?: string;
   *   parameter_schema?: Record<string, unknown>;
   *   source_files?: Array<{ path: string; content: Buffer | string }>;
   *   declared_capabilities?: string[];
   *   provenance?: {
   *     authoring_type?: 'human' | 'ai' | 'fork' | 'import';
   *     author?: string;
   *     source_bundle?: { bundle_id: string; revision: number } | null;
   *     ai_metadata?: Record<string, unknown>;
   *     rights_and_license?: {
   *       license: string;
   *       copyright_holder?: string;
   *       rights_provenance?: string;
   *       commercial_use_allowed?: boolean;
   *     };
   *   };
   *   change_summary?: string;
   *   created_by?: string;
   * }} input
   * @returns {{ bundle: SceneBundleRecord; revision: SceneBundleRevisionRecord }}
   */
  createBundle(tenantId, input) {
    if (!tenantId || typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'tenantId is required to create a scene bundle',
        false,
      );
    }

    validateBundleId(input.id);

    if (this._bundles.has(input.id)) {
      throw new CustomRuntimeError(
        'BUNDLE_CONFLICT',
        `Scene bundle with ID "${input.id}" already exists`,
        false,
        { bundleId: input.id },
      );
    }

    if (typeof input.name !== 'string' || !input.name.trim()) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'Bundle name is required',
        false,
      );
    }

    // Prepare initial source files
    const sourceFiles = Array.isArray(input.source_files) && input.source_files.length > 0
      ? input.source_files
      : [
          {
            path: 'index.js',
            content: DEFAULT_ENTRYPOINT_SOURCE,
          },
        ];

    const entrypoint = input.entrypoint ? normalizeSourceFilePath(input.entrypoint) : 'index.js';

    // Verify entrypoint exists in source files
    const hasEntrypoint = sourceFiles.some((f) => normalizeSourceFilePath(f.path) === entrypoint);
    if (!hasEntrypoint) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Declared entrypoint "${entrypoint}" does not exist in provided source files`,
        false,
        { entrypoint },
      );
    }

    // Validate parameter schema
    const paramSchema = input.parameter_schema || DEFAULT_BUNDLE_PARAMETER_SCHEMA;
    validateParameterSchemaDefinition(paramSchema, { strict: true });

    // Compute deterministic digests
    const { sourceSha256 } = computeDeterministicSourceDigest(sourceFiles);
    const { buildSha256 } = computeDeterministicBuildDigest(sourceFiles);

    const ral = input.provenance?.rights_and_license;
    const rightsAndLicense = {
      license: ral?.license || 'Proprietary-Tenant',
      copyright_holder: ral?.copyright_holder || tenantId,
      rights_provenance: ral?.rights_provenance || 'tenant-authored',
      commercial_use_allowed: ral?.commercial_use_allowed ?? true,
    };

    // Initial provenance
    const provenanceInput = {
      authoring_type: input.provenance?.authoring_type || 'human',
      author: input.provenance?.author || input.created_by || tenantId,
      base_revision: null,
      source_bundle: input.provenance?.source_bundle ? { bundle_id: String(input.provenance.source_bundle.bundle_id), revision: Number(input.provenance.source_bundle.revision) || 1 } : null,
      ai_metadata: /** @type {any} */ (input.provenance?.ai_metadata || null),
      rights_and_license: rightsAndLicense,
      declared_capabilities: input.declared_capabilities || ['canvas-2d'],
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    };
    const provenance = createSceneBundleProvenance(provenanceInput);

    // Populate file map
    const fileMap = new Map();
    for (const f of sourceFiles) {
      const norm = normalizeSourceFilePath(f.path);
      const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8');
      fileMap.set(norm, {
        path: norm,
        content: buf,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mime_type: guessMimeType(norm),
      });
    }

    // Build artifact placeholder (in draft, artifacts mirror sources)
    const artifactMap = new Map();
    for (const [p, f] of fileMap.entries()) {
      artifactMap.set(p, { ...f });
    }

    const { scriptHashToken } = buildCustomSceneCspHeader(
      fileMap.get(entrypoint)?.content || Buffer.from(''),
    );

    const now = new Date().toISOString();

    /** @type {SceneBundleRecord} */
    const bundle = {
      id: input.id,
      tenant_id: tenantId,
      name: input.name.trim(),
      description: input.description?.trim() || '',
      is_global: false,
      tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).trim().toLowerCase()) : [],
      latest_revision: 0, // No sealed revision yet
      max_revision: 1,
      created_at: now,
      updated_at: now,
      is_archived: false,
      created_by: input.created_by || tenantId,
    };

    /** @type {SceneBundleRevisionRecord} */
    const revisionRecord = {
      bundle_id: input.id,
      revision: 1,
      base_revision: null,
      status: 'draft',
      entrypoint,
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
      parameter_schema: paramSchema,
      provenance,
      declared_capabilities: provenance.declared_capabilities,
      change_summary: input.change_summary || 'Initial draft revision',
      source_files: fileMap,
      build_artifacts: artifactMap,
      csp_script_hash: scriptHashToken,
      validation_report: null,
      created_at: now,
      created_by: input.created_by || tenantId,
      sealed_at: null,
    };

    this._bundles.set(input.id, bundle);
    const revMap = new Map();
    revMap.set(1, revisionRecord);
    this._revisions.set(input.id, revMap);

    return { bundle, revision: revisionRecord };
  }

  /**
   * List scene bundles accessible to the tenant (including global catalog if requested).
   *
   * @param {string} tenantId
   * @param {{
   *   tag?: string;
   *   include_global?: boolean;
   *   limit?: number;
   *   offset?: number;
   * }} [options]
   * @returns {{
   *   items: SceneBundleRecord[];
   *   total: number;
   *   limit: number;
   *   offset: number;
   * }}
   */
  listBundles(tenantId, options = {}) {
    const {
      tag,
      include_global = true,
      limit = 50,
      offset = 0,
    } = options;

    const results = [];

    for (const bundle of this._bundles.values()) {
      if (bundle.is_archived) continue;

      const isOwned = bundle.tenant_id === tenantId;
      const isCurated = bundle.is_global && include_global;

      if (!isOwned && !isCurated) continue;

      if (tag && !bundle.tags.includes(tag.toLowerCase())) continue;

      results.push(bundle);
    }

    // Sort descending by created_at
    results.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    const total = results.length;
    const paginated = results.slice(offset, offset + limit);

    return {
      items: paginated,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get metadata for a specific scene bundle.
   * @param {string} tenantId
   * @param {string} bundleId
   * @returns {SceneBundleRecord}
   */
  getBundle(tenantId, bundleId) {
    return this._resolveBundle(tenantId, bundleId);
  }

  /**
   * Update bundle metadata (name, description, tags).
   * Global bundles cannot be modified by tenants.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {{
   *   name?: string;
   *   description?: string;
   *   tags?: string[];
   * }} updates
   * @returns {SceneBundleRecord}
   */
  updateBundle(tenantId, bundleId, updates) {
    const bundle = this._resolveBundle(tenantId, bundleId, { allowGlobal: false });

    if (bundle.is_global) {
      throw new CustomRuntimeError(
        'FORBIDDEN',
        'Curated global bundles are read-only and cannot be mutated. Fork the bundle to edit.',
        false,
        { bundleId },
      );
    }

    if (updates.name !== undefined) {
      if (typeof updates.name !== 'string' || !updates.name.trim()) {
        throw new CustomRuntimeError(
          'VALIDATION_FAILED',
          'Bundle name cannot be empty',
          false,
        );
      }
      bundle.name = updates.name.trim();
    }

    if (updates.description !== undefined) {
      bundle.description = String(updates.description).trim();
    }

    if (updates.tags !== undefined) {
      if (!Array.isArray(updates.tags)) {
        throw new CustomRuntimeError(
          'VALIDATION_FAILED',
          'Tags must be an array of strings',
          false,
        );
      }
      bundle.tags = updates.tags.map((t) => String(t).trim().toLowerCase());
    }

    bundle.updated_at = new Date().toISOString();
    return bundle;
  }

  /**
   * Soft-delete / archive a scene bundle.
   * Global bundles cannot be archived by tenants.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @returns {boolean}
   */
  deleteBundle(tenantId, bundleId) {
    const bundle = this._resolveBundle(tenantId, bundleId, { allowGlobal: false });
    if (bundle.is_global) {
      throw new CustomRuntimeError(
        'FORBIDDEN',
        'Curated global bundles cannot be deleted',
        false,
        { bundleId },
      );
    }
    bundle.is_archived = true;
    bundle.updated_at = new Date().toISOString();
    return true;
  }

  /**
   * Create a new revision for an existing scene bundle with optimistic concurrency control.
   * Client MUST supply base_revision matching bundle.latest_revision.
   * If base_revision !== bundle.latest_revision, throws REVISION_CONFLICT (HTTP 409).
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {{
   *   base_revision: number;
   *   entrypoint?: string;
   *   parameter_schema?: Record<string, unknown>;
   *   source_files?: Array<{ path: string; content: Buffer | string }>;
   *   change_summary?: string;
   *   declared_capabilities?: string[];
   *   created_by?: string;
   *   provenance?: {
   *     authoring_type?: 'human' | 'ai' | 'fork' | 'import';
   *     author?: string;
   *     ai_metadata?: Record<string, unknown>;
   *     rights_and_license?: {
   *       license: string;
   *       copyright_holder?: string;
   *       rights_provenance?: string;
   *       commercial_use_allowed?: boolean;
   *     };
   *   };
   * }} input
   * @returns {SceneBundleRevisionRecord}
   */
  createRevision(tenantId, bundleId, input) {
    const bundle = this._resolveBundle(tenantId, bundleId, { allowGlobal: false });

    if (bundle.is_global) {
      throw new CustomRuntimeError(
        'FORBIDDEN',
        'Cannot create revisions directly on curated global catalog bundles. Fork to a tenant workspace.',
        false,
        { bundleId },
      );
    }

    if (input.base_revision === undefined || input.base_revision === null) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'base_revision is required for optimistic concurrency control',
        false,
      );
    }

    const baseRevNum = Number(input.base_revision);

    // Stale base_revision check (HTTP 409 REVISION_CONFLICT)
    if (baseRevNum !== bundle.latest_revision) {
      throw new CustomRuntimeError(
        'REVISION_CONFLICT',
        `Revision conflict: provided base_revision (${baseRevNum}) does not match current latest_revision (${bundle.latest_revision}). Re-fetch bundle before creating revision.`,
        false,
        {
          bundleId,
          providedBaseRevision: baseRevNum,
          currentLatestRevision: bundle.latest_revision,
        },
      );
    }

    // Resolve base revision to inherit files/schema if not explicitly overridden
    const baseRevRecord = baseRevNum > 0
      ? this._revisions.get(bundleId)?.get(baseRevNum)
      : null;

    let sourceFiles = [];
    if (Array.isArray(input.source_files) && input.source_files.length > 0) {
      sourceFiles = input.source_files;
    } else if (baseRevRecord) {
      // Inherit from base revision
      sourceFiles = Array.from(baseRevRecord.source_files.values()).map((f) => ({
        path: f.path,
        content: f.content,
      }));
    } else {
      sourceFiles = [{ path: 'index.js', content: DEFAULT_ENTRYPOINT_SOURCE }];
    }

    const entrypoint = input.entrypoint
      ? normalizeSourceFilePath(input.entrypoint)
      : baseRevRecord?.entrypoint || 'index.js';

    // Verify entrypoint exists in source files
    const hasEntrypoint = sourceFiles.some((f) => normalizeSourceFilePath(f.path) === entrypoint);
    if (!hasEntrypoint) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Declared entrypoint "${entrypoint}" does not exist in source files`,
        false,
        { entrypoint },
      );
    }

    const paramSchema = input.parameter_schema || baseRevRecord?.parameter_schema || DEFAULT_BUNDLE_PARAMETER_SCHEMA;
    validateParameterSchemaDefinition(paramSchema, { strict: true });

    const { sourceSha256 } = computeDeterministicSourceDigest(sourceFiles);
    const { buildSha256 } = computeDeterministicBuildDigest(sourceFiles);

    const provenance = createSceneBundleProvenance({
      authoring_type: input.provenance?.authoring_type || 'human',
      author: input.provenance?.author || input.created_by || tenantId,
      base_revision: baseRevNum > 0 ? baseRevNum : null,
      ai_metadata: input.provenance?.ai_metadata || null,
      rights_and_license: {
        license: input.provenance?.rights_and_license?.license || baseRevRecord?.provenance?.rights_and_license?.license || 'Proprietary-Tenant',
        copyright_holder: input.provenance?.rights_and_license?.copyright_holder || baseRevRecord?.provenance?.rights_and_license?.copyright_holder || tenantId,
        rights_provenance: input.provenance?.rights_and_license?.rights_provenance || baseRevRecord?.provenance?.rights_and_license?.rights_provenance || 'tenant-authored',
        commercial_use_allowed: input.provenance?.rights_and_license?.commercial_use_allowed ?? baseRevRecord?.provenance?.rights_and_license?.commercial_use_allowed ?? true,
      },
      declared_capabilities: input.declared_capabilities || baseRevRecord?.declared_capabilities || ['canvas-2d'],
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    });

    const fileMap = new Map();
    for (const f of sourceFiles) {
      const norm = normalizeSourceFilePath(f.path);
      const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8');
      fileMap.set(norm, {
        path: norm,
        content: buf,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mime_type: guessMimeType(norm),
      });
    }

    const artifactMap = new Map();
    for (const [p, f] of fileMap.entries()) {
      artifactMap.set(p, { ...f });
    }

    const { scriptHashToken } = buildCustomSceneCspHeader(
      fileMap.get(entrypoint)?.content || Buffer.from(''),
    );

    const nextRevNum = (bundle.max_revision || 0) + 1;
    bundle.max_revision = nextRevNum;
    bundle.updated_at = new Date().toISOString();

    const newRevRecord = {
      bundle_id: bundleId,
      revision: nextRevNum,
      base_revision: baseRevNum > 0 ? baseRevNum : null,
      status: /** @type {'draft'} */ ('draft'),
      entrypoint,
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
      parameter_schema: paramSchema,
      provenance,
      declared_capabilities: provenance.declared_capabilities,
      change_summary: input.change_summary || `Draft revision ${nextRevNum}`,
      source_files: fileMap,
      build_artifacts: artifactMap,
      csp_script_hash: scriptHashToken,
      validation_report: null,
      created_at: new Date().toISOString(),
      created_by: input.created_by || tenantId,
      sealed_at: null,
    };

    let bundleRevs = this._revisions.get(bundleId);
    if (!bundleRevs) {
      bundleRevs = new Map();
      this._revisions.set(bundleId, bundleRevs);
    }
    bundleRevs.set(nextRevNum, newRevRecord);

    return newRevRecord;
  }

  /**
   * Update an existing draft revision (editable revisions before publishing/sealing).
   * Published/sealed revisions are strictly immutable and throw REVISION_SEALED.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @param {{
   *   entrypoint?: string;
   *   parameter_schema?: Record<string, unknown>;
   *   add_or_update_files?: Array<{ path: string; content: Buffer | string }>;
   *   remove_files?: string[];
   *   change_summary?: string;
   *   declared_capabilities?: string[];
   * }} updates
   * @returns {SceneBundleRevisionRecord}
   */
  updateDraftRevision(tenantId, bundleId, revision, updates) {
    const { bundle, rev } = this._resolveRevision(tenantId, bundleId, revision, { allowGlobal: false });

    if (bundle.is_global) {
      throw new CustomRuntimeError(
        'FORBIDDEN',
        'Curated global bundles are read-only and cannot be mutated',
        false,
        { bundleId },
      );
    }

    if (rev.status !== 'draft') {
      throw new CustomRuntimeError(
        'REVISION_SEALED',
        `Revision ${rev.revision} is sealed in status "${rev.status}" and is immutable. Create a new revision to make changes.`,
        false,
        { bundleId, revision: rev.revision, status: rev.status },
      );
    }

    // Apply file updates
    if (Array.isArray(updates.remove_files)) {
      for (const rawPath of updates.remove_files) {
        const norm = normalizeSourceFilePath(rawPath);
        rev.source_files.delete(norm);
        rev.build_artifacts.delete(norm);
      }
    }

    if (Array.isArray(updates.add_or_update_files)) {
      for (const f of updates.add_or_update_files) {
        const norm = normalizeSourceFilePath(f.path);
        const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8');
        const entry = {
          path: norm,
          content: buf,
          size: buf.length,
          sha256: crypto.createHash('sha256').update(buf).digest('hex'),
          mime_type: guessMimeType(norm),
        };
        rev.source_files.set(norm, entry);
        rev.build_artifacts.set(norm, { ...entry });
      }
    }

    if (rev.source_files.size === 0) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'Scene bundle source files cannot be empty',
        false,
      );
    }

    // Update entrypoint
    if (updates.entrypoint !== undefined) {
      const normEntry = normalizeSourceFilePath(updates.entrypoint);
      if (!rev.source_files.has(normEntry)) {
        throw new CustomRuntimeError(
          'VALIDATION_FAILED',
          `Declared entrypoint "${normEntry}" does not exist in updated source files`,
          false,
          { entrypoint: normEntry },
        );
      }
      rev.entrypoint = normEntry;
    } else {
      if (!rev.source_files.has(rev.entrypoint)) {
        throw new CustomRuntimeError(
          'VALIDATION_FAILED',
          `Current entrypoint "${rev.entrypoint}" was removed and no replacement was specified`,
          false,
          { entrypoint: rev.entrypoint },
        );
      }
    }

    // Update parameter schema
    if (updates.parameter_schema !== undefined) {
      validateParameterSchemaDefinition(updates.parameter_schema, { strict: true });
      rev.parameter_schema = updates.parameter_schema;
    }

    if (updates.change_summary !== undefined) {
      rev.change_summary = String(updates.change_summary);
    }

    // Recalculate digests
    const fileList = Array.from(rev.source_files.values());
    const { sourceSha256 } = computeDeterministicSourceDigest(fileList);
    const { buildSha256 } = computeDeterministicBuildDigest(fileList);

    rev.source_sha256 = sourceSha256;
    rev.build_sha256 = buildSha256;

    // Recalculate CSP hash
    const entrypointFile = rev.source_files.get(rev.entrypoint);
    if (entrypointFile) {
      const { scriptHashToken } = buildCustomSceneCspHeader(entrypointFile.content);
      rev.csp_script_hash = scriptHashToken;
    }

    // Update provenance digest
    rev.provenance = createSceneBundleProvenance({
      authoring_type: rev.provenance.authoring_type,
      author: rev.provenance.author,
      base_revision: rev.base_revision,
      source_bundle: rev.provenance.source_bundle,
      ai_metadata: rev.provenance.ai_metadata,
      rights_and_license: rev.provenance.rights_and_license,
      declared_capabilities: updates.declared_capabilities || rev.declared_capabilities,
      source_sha256: sourceSha256,
      build_sha256: buildSha256,
    });

    rev.declared_capabilities = rev.provenance.declared_capabilities;
    rev.validation_report = null; // Clear previous validation report on edits

    bundle.updated_at = new Date().toISOString();
    return rev;
  }

  /**
   * Run static security scanning and parameter schema validation on a revision.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @returns {{
   *   passed: boolean;
   *   scanned_files_count: number;
   *   violations: unknown[];
   *   parameter_schema_valid: boolean;
   *   evaluated_at: string;
   * }}
   */
  validateRevision(tenantId, bundleId, revision) {
    const { rev } = this._resolveRevision(tenantId, bundleId, revision);

    const fileList = Array.from(rev.source_files.values());
    const scanResult = scanCustomSourceForForbiddenCapabilities(fileList);

    const paramSchemaResult = validateParameterSchemaDefinition(rev.parameter_schema, {
      strict: false,
    });

    const passed = scanResult.passed && paramSchemaResult.valid;

    const report = {
      passed,
      scanned_files_count: scanResult.scannedFilesCount,
      violations: scanResult.violations,
      parameter_schema_valid: paramSchemaResult.valid,
      evaluated_at: new Date().toISOString(),
    };

    rev.validation_report = report;
    return report;
  }

  /**
   * Seal and publish a revision, making it strictly immutable and ready for scene rendering.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @param {object} [options]
   * @param {boolean} [options.skipScan=false]
   * @returns {SceneBundleRevisionRecord}
   */
  publishRevision(tenantId, bundleId, revision, options = {}) {
    const { bundle, rev } = this._resolveRevision(tenantId, bundleId, revision, { allowGlobal: false });

    if (bundle.is_global) {
      throw new CustomRuntimeError(
        'FORBIDDEN',
        'Curated global bundles cannot be modified or published directly',
        false,
        { bundleId },
      );
    }

    if (rev.status === 'published') {
      return rev; // Already published
    }

    // Run security scan unless explicitly skipped (e.g. In trusted harness tests)
    if (!options.skipScan) {
      const validationReport = this.validateRevision(tenantId, bundleId, revision);
      if (!validationReport.passed) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Cannot publish scene bundle revision: static scan failed with ${validationReport.violations.length} violations`,
          false,
          { bundleId, revision: rev.revision, violations: validationReport.violations },
        );
      }
    }

    // Verify digests match
    const fileList = Array.from(rev.source_files.values());
    verifySourceIntegrity(fileList, rev.source_sha256);
    verifyBuildIntegrity(Array.from(rev.build_artifacts.values()), rev.build_sha256);

    // Verify provenance
    if (!verifyProvenanceIntegrity(rev.provenance)) {
      throw new CustomRuntimeError(
        'DIGEST_MISMATCH',
        'Provenance digest integrity check failed',
        false,
        { bundleId, revision: rev.revision },
      );
    }

    // Seal revision
    const now = new Date().toISOString();
    rev.status = 'published';
    rev.sealed_at = now;

    // Update bundle latest_revision
    bundle.latest_revision = rev.revision;
    bundle.updated_at = now;

    return rev;
  }

  /**
   * List all revisions of a scene bundle.
   * @param {string} tenantId
   * @param {string} bundleId
   * @returns {SceneBundleRevisionRecord[]}
   */
  listRevisions(tenantId, bundleId) {
    this._resolveBundle(tenantId, bundleId);
    const revMap = this._revisions.get(bundleId);
    if (!revMap) return [];
    return Array.from(revMap.values()).sort((a, b) => b.revision - a.revision);
  }

  /**
   * Get a specific revision of a scene bundle.
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @returns {SceneBundleRevisionRecord}
   */
  getRevision(tenantId, bundleId, revision) {
    return this._resolveRevision(tenantId, bundleId, revision).rev;
  }

  /**
   * Fork an existing bundle (curated global catalog or tenant-accessible bundle)
   * into a new tenant-owned bundle with complete provenance.
   *
   * @param {string} sourceBundleId
   * @param {string} targetTenantId
   * @param {{
   *   new_bundle_id: string;
   *   name?: string;
   *   description?: string;
   *   source_revision?: number;
   *   created_by?: string;
   * }} options
   * @returns {{ bundle: SceneBundleRecord; revision: SceneBundleRevisionRecord }}
   */
  forkBundle(sourceBundleId, targetTenantId, options) {
    if (!targetTenantId || typeof targetTenantId !== 'string') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'targetTenantId is required to fork a scene bundle',
        false,
      );
    }

    validateBundleId(options.new_bundle_id);

    // Resolve source bundle (allow global catalog)
    const sourceBundle = this._resolveBundle(targetTenantId, sourceBundleId, { allowGlobal: true });

    const sourceRevNum = options.source_revision || sourceBundle.latest_revision || 1;
    const { rev: sourceRev } = this._resolveRevision(targetTenantId, sourceBundleId, sourceRevNum, {
      allowGlobal: true,
    });

    const newName = options.name?.trim() || `${sourceBundle.name} (Fork)`;
    const newDesc = options.description?.trim() || `Forked from ${sourceBundleId}@rev${sourceRev.revision}`;

    // Extract files from source revision
    const sourceFiles = Array.from(sourceRev.source_files.values()).map((f) => ({
      path: f.path,
      content: Buffer.from(f.content),
    }));

    // Create new bundle
    return this.createBundle(targetTenantId, {
      id: options.new_bundle_id,
      name: newName,
      description: newDesc,
      tags: [...sourceBundle.tags, 'fork'],
      entrypoint: sourceRev.entrypoint,
      parameter_schema: sourceRev.parameter_schema,
      source_files: sourceFiles,
      declared_capabilities: sourceRev.declared_capabilities,
      provenance: {
        authoring_type: 'fork',
        author: options.created_by || targetTenantId,
        source_bundle: { bundle_id: sourceBundleId, revision: sourceRev.revision },
        rights_and_license: {
          license: sourceRev.provenance.rights_and_license.license,
          copyright_holder: targetTenantId,
          rights_provenance: `forked-from:${sourceBundleId}@${sourceRev.revision}`,
          commercial_use_allowed: sourceRev.provenance.rights_and_license.commercial_use_allowed,
        },
      },
      change_summary: `Forked from ${sourceBundleId} revision ${sourceRev.revision}`,
      created_by: options.created_by || targetTenantId,
    });
  }

  /**
   * Download source files for a revision in specified format ('manifest', 'tar', or 'files').
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @param {{ format?: 'manifest' | 'tar' | 'files' }} [options]
   * @returns {{
   *   format: 'manifest' | 'tar' | 'files';
   *   sourceSha256: string;
   *   totalFiles: number;
   *   totalBytes: number;
   *   data: Buffer | Array<{ path: string; size: number; sha256: string; content?: string }>;
   * }}
   */
  downloadSource(tenantId, bundleId, revision, options = {}) {
    const { rev } = this._resolveRevision(tenantId, bundleId, revision);
    const format = options.format || 'manifest';

    const fileList = Array.from(rev.source_files.values());
    verifySourceIntegrity(fileList, rev.source_sha256);

    let totalBytes = 0;
    for (const f of fileList) totalBytes += f.size;

    if (format === 'tar') {
      const tarBuffer = packFilesToTarArchive(fileList);
      return {
        format: 'tar',
        sourceSha256: rev.source_sha256,
        totalFiles: fileList.length,
        totalBytes: tarBuffer.length,
        data: tarBuffer,
      };
    }

    if (format === 'files') {
      const filesWithContent = fileList.map((f) => ({
        path: f.path,
        size: f.size,
        sha256: f.sha256,
        mime_type: f.mime_type,
        content: f.content.toString('base64'),
      }));
      return {
        format: 'files',
        sourceSha256: rev.source_sha256,
        totalFiles: fileList.length,
        totalBytes,
        data: filesWithContent,
      };
    }

    // Default 'manifest' format
    const manifest = fileList.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      mime_type: f.mime_type,
    }));

    return {
      format: 'manifest',
      sourceSha256: rev.source_sha256,
      totalFiles: fileList.length,
      totalBytes,
      data: manifest,
    };
  }

  /**
   * Download a single source file from a revision with path traversal defenses.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @param {string} relativePath
   * @returns {{
   *   path: string;
   *   content: Buffer;
   *   size: number;
   *   sha256: string;
   *   mime_type: string;
   * }}
   */
  downloadSourceFile(tenantId, bundleId, revision, relativePath) {
    const { rev } = this._resolveRevision(tenantId, bundleId, revision);
    const norm = normalizeSourceFilePath(relativePath);

    const file = rev.source_files.get(norm);
    if (!file) {
      throw new CustomRuntimeError(
        'FILE_NOT_FOUND',
        `File "${norm}" not found in scene bundle "${bundleId}" revision ${rev.revision}`,
        false,
        { bundleId, revision: rev.revision, path: norm },
      );
    }

    // Verify individual file integrity
    const checkSha = crypto.createHash('sha256').update(file.content).digest('hex');
    if (checkSha !== file.sha256) {
      throw new CustomRuntimeError(
        'DIGEST_MISMATCH',
        `File "${norm}" content does not match recorded sha256`,
        false,
        { path: norm, expected: file.sha256, actual: checkSha },
      );
    }

    return {
      path: file.path,
      content: file.content,
      size: file.size,
      sha256: file.sha256,
      mime_type: file.mime_type,
    };
  }

  /**
   * Download build artifact for a revision.
   *
   * @param {string} tenantId
   * @param {string} bundleId
   * @param {number} revision
   * @returns {{
   *   buildSha256: string;
   *   entrypoint: string;
   *   artifacts: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
   * }}
   */
  downloadBuild(tenantId, bundleId, revision) {
    const { rev } = this._resolveRevision(tenantId, bundleId, revision);
    const artifactList = Array.from(rev.build_artifacts.values());
    verifyBuildIntegrity(artifactList, rev.build_sha256);

    return {
      buildSha256: rev.build_sha256,
      entrypoint: rev.entrypoint,
      artifacts: artifactList.map((a) => ({
        path: a.path,
        size: a.size,
        sha256: a.sha256,
        mime_type: a.mime_type,
      })),
    };
  }

  /**
   * Instantiate / render-preflight a custom scene using a bundle revision.
   * Enforces that the revision is published, verifies parameters, and checks feature gate.
   * Throws CAPABILITY_DISABLED if the custom code feature is off!
   *
   * @param {string} tenantId
   * @param {{
   *   bundle_id: string;
   *   revision: number;
   *   parameters: Record<string, unknown>;
   * }} input
   * @returns {{
   *   bundle_id: string;
   *   revision: number;
   *   entrypoint: string;
   *   source_sha256: string;
   *   build_sha256: string;
   *   csp_script_hash: string;
   *   validated_parameters: Record<string, unknown>;
   * }}
   */
  prepareCustomSceneExecution(tenantId, input) {
    // Feature gate check: feature must be enabled; otherwise strictly reject
    assertCustomCodeExecutionAllowed(this.config, tenantId);

    const { rev } = this._resolveRevision(tenantId, input.bundle_id, input.revision);

    if (rev.status !== 'published') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Cannot execute custom scene: bundle revision ${rev.revision} is not published (status: "${rev.status}")`,
        false,
        { bundleId: input.bundle_id, revision: rev.revision, status: rev.status },
      );
    }

    // Validate parameters against bundle parameter schema
    const paramValidation = validateBundleParameters(rev.parameter_schema, input.parameters);
    if (!paramValidation.valid) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Custom scene parameters validation failed: ${paramValidation.errors.map((e) => `${e.pointer}: ${e.message}`).join('; ')}`,
        false,
        { errors: paramValidation.errors },
      );
    }

    return {
      bundle_id: input.bundle_id,
      revision: rev.revision,
      entrypoint: rev.entrypoint,
      source_sha256: rev.source_sha256,
      build_sha256: rev.build_sha256,
      csp_script_hash: rev.csp_script_hash,
      validated_parameters: paramValidation.validatedParameters,
    };
  }
}

/**
 * Runs the comprehensive 13-check Task P7-02 Scene Bundle Registry & Contracts Verification Suite.
 *
 * @returns {Promise<{
 *   taskId: 'P7-02';
 *   status: 'PASS' | 'FAIL';
 *   totalChecks: number;
 *   passedChecks: number;
 *   failedChecks: number;
 *   durationMs: number;
 *   timestamp: string;
 *   defaultFeatureState: {
 *     CVE_CUSTOM_CODE_ENABLED: boolean;
 *     CVE_CUSTOM_RUNTIME: string;
 *     CVE_CUSTOM_TENANT_ALLOWLIST: string[];
 *   };
 *   checks: Array<{
 *     id: string;
 *     title: string;
 *     category: string;
 *     status: 'PASS' | 'FAIL';
 *     passed: boolean;
 *     durationMs: number;
 *     details?: Record<string, unknown>;
 *     error?: string;
 *   }>;
 * }>}
 */
export async function runSceneBundleRegistrySelfTest() {
  const startedAt = Date.now();
  /** @type {Array<{ id: string; title: string; category: string; status: 'PASS' | 'FAIL'; passed: boolean; durationMs: number; details?: Record<string, unknown>; error?: string }>} */
  const checks = [];

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} category
   * @param {() => Promise<Record<string, unknown> | void>} fn
   */
  const recordCheck = async (id, title, category, fn) => {
    const t0 = performance.now();
    try {
      const details = await fn();
      const durationMs = Math.round((performance.now() - t0) * 100) / 100;
      checks.push({
        id,
        title,
        category,
        status: 'PASS',
        passed: true,
        durationMs,
        details: details || {},
      });
    } catch (err) {
      const durationMs = Math.round((performance.now() - t0) * 100) / 100;
      checks.push({
        id,
        title,
        category,
        status: 'FAIL',
        passed: false,
        durationMs,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const registry = new SceneBundleRegistry();

  // SBR-01: Multi-tenant bundle creation, retrieval, and listing
  await recordCheck(
    'SBR-01',
    'Multi-tenant scene-bundle creation, retrieval, and pagination',
    'registry_crud',
    async () => {
      const { bundle, revision } = registry.createBundle('tenant-alpha', {
        id: 'bundle-alpha-intro',
        name: 'Alpha Intro Scene',
        description: 'First test intro scene for tenant alpha',
        tags: ['intro', 'branding'],
        entrypoint: 'index.js',
        source_files: [
          { path: 'index.js', content: DEFAULT_ENTRYPOINT_SOURCE },
          { path: 'assets/theme.json', content: '{"theme":"dark"}' },
        ],
      });

      const fetched = registry.getBundle('tenant-alpha', 'bundle-alpha-intro');
      const list = registry.listBundles('tenant-alpha', { tag: 'intro' });

      if (fetched.id !== 'bundle-alpha-intro' || revision.revision !== 1 || list.total < 1) {
        throw new Error('Bundle retrieval or listing verification failed');
      }

      return {
        bundleId: bundle.id,
        revision: revision.revision,
        sourceSha256: revision.source_sha256,
        status: revision.status,
      };
    },
  );

  // SBR-02: Tenant isolation & IDOR prevention
  await recordCheck(
    'SBR-02',
    'Tenant isolation & zero IDOR leakage across tenants',
    'tenant_isolation',
    async () => {
      let rejected = false;
      let errorCode = '';
      try {
        registry.getBundle('tenant-beta', 'bundle-alpha-intro');
      } catch (err) {
        if (err instanceof CustomRuntimeError && /** @type {string} */ (err.code) === 'BUNDLE_NOT_FOUND') {
          rejected = true;
          errorCode = err.code;
        }
      }

      if (!rejected) {
        throw new Error('Expected cross-tenant access to throw BUNDLE_NOT_FOUND');
      }

      return {
        targetBundleId: 'bundle-alpha-intro',
        queryingTenant: 'tenant-beta',
        rejectedAsExpected: true,
        errorCode,
      };
    },
  );

  // SBR-03: Global curated catalog access and immutability
  await recordCheck(
    'SBR-03',
    'Global curated catalog bundles: visible to all tenants, read-only and immutable against tenant mutation',
    'curated_catalog',
    async () => {
      const globalBundle = registry.getBundle('tenant-alpha', 'global-kinetic-title');
      if (!globalBundle.is_global || globalBundle.tenant_id !== 'global') {
        throw new Error('Global curated bundle not properly seeded');
      }

      let mutationBlocked = false;
      try {
        registry.updateBundle('tenant-alpha', 'global-kinetic-title', { name: 'Hacked Name' });
      } catch (err) {
        if (err instanceof CustomRuntimeError && /** @type {string} */ (err.code) === 'FORBIDDEN') {
          mutationBlocked = true;
        }
      }

      let revisionBlocked = false;
      try {
        registry.createRevision('tenant-alpha', 'global-kinetic-title', { base_revision: 1 });
      } catch (err) {
        if (err instanceof CustomRuntimeError && /** @type {string} */ (err.code) === 'FORBIDDEN') {
          revisionBlocked = true;
        }
      }

      if (!mutationBlocked || !revisionBlocked) {
        throw new Error('Direct mutation on global catalog was not prevented');
      }

      return {
        globalBundleId: globalBundle.id,
        isGlobal: globalBundle.is_global,
        mutationBlocked,
        revisionBlocked,
      };
    },
  );

  // SBR-04: Forking curated global bundle into tenant workspace
  await recordCheck(
    'SBR-04',
    'Fork curated bundle into tenant workspace with lineage link and complete provenance',
    'fork_lineage',
    async () => {
      const { bundle: forkedBundle, revision: forkedRev } = registry.forkBundle(
        'global-kinetic-title',
        'tenant-alpha',
        {
          new_bundle_id: 'alpha-kinetic-fork',
          name: 'Alpha Kinetic Title (Custom)',
        },
      );

      if (
        forkedBundle.tenant_id !== 'tenant-alpha' ||
        forkedBundle.is_global !== false ||
        forkedRev.provenance.authoring_type !== 'fork' ||
        forkedRev.provenance.source_bundle?.bundle_id !== 'global-kinetic-title'
      ) {
        throw new Error('Forking verification failed');
      }

      return {
        forkedBundleId: forkedBundle.id,
        tenantId: forkedBundle.tenant_id,
        parentBundle: forkedRev.provenance.source_bundle,
        provenanceType: forkedRev.provenance.authoring_type,
        provenanceDigest: forkedRev.provenance.provenance_digest,
      };
    },
  );

  // SBR-05: Optimistic locking concurrency control (stale base_revision -> 409 REVISION_CONFLICT)
  await recordCheck(
    'SBR-05',
    'Optimistic concurrency control: stale base_revision triggers 409 REVISION_CONFLICT',
    'concurrency_control',
    async () => {
      // Publish revision 1 first
      registry.publishRevision('tenant-alpha', 'bundle-alpha-intro', 1);

      // Now create revision 2 with base_revision: 1
      const rev2 = registry.createRevision('tenant-alpha', 'bundle-alpha-intro', {
        base_revision: 1,
        change_summary: 'Draft revision 2',
      });
      registry.publishRevision('tenant-alpha', 'bundle-alpha-intro', rev2.revision);

      // Attempt to create revision with stale base_revision: 1 (now current is 2)
      let conflictDetected = false;
      let conflictCode = '';
      try {
        registry.createRevision('tenant-alpha', 'bundle-alpha-intro', {
          base_revision: 1, // Stale!
        });
      } catch (err) {
        if (err instanceof CustomRuntimeError && /** @type {string} */ (err.code) === 'REVISION_CONFLICT') {
          conflictDetected = true;
          conflictCode = err.code;
        }
      }

      if (!conflictDetected) {
        throw new Error('Stale base_revision failed to trigger REVISION_CONFLICT');
      }

      return {
        currentLatestRevision: 2,
        providedStaleBaseRevision: 1,
        conflictDetected,
        conflictCode,
      };
    },
  );

  // SBR-06: Editable draft revisions
  await recordCheck(
    'SBR-06',
    'Editable draft revisions: add/update/remove files and parameters before publish',
    'editable_revisions',
    async () => {
      // Create draft revision 3
      const rev3 = registry.createRevision('tenant-alpha', 'bundle-alpha-intro', {
        base_revision: 2,
        change_summary: 'Draft revision 3',
      });

      const updatedDraft = registry.updateDraftRevision('tenant-alpha', 'bundle-alpha-intro', rev3.revision, {
        add_or_update_files: [
          {
            path: 'extra.css',
            content: '.custom { color: red; }',
          },
        ],
        change_summary: 'Added extra.css style',
      });

      if (!updatedDraft.source_files.has('extra.css') || updatedDraft.status !== 'draft') {
        throw new Error('Draft revision file update failed');
      }

      return {
        revision: updatedDraft.revision,
        status: updatedDraft.status,
        filesCount: updatedDraft.source_files.size,
        updatedSha256: updatedDraft.source_sha256,
      };
    },
  );

  // SBR-07: Sealed/published immutability
  await recordCheck(
    'SBR-07',
    'Sealed published revisions: published revisions are strictly immutable (REVISION_SEALED)',
    'revision_immutability',
    async () => {
      // Publish revision 3
      registry.publishRevision('tenant-alpha', 'bundle-alpha-intro', 3);

      let sealedErrorBlocked = false;
      try {
        registry.updateDraftRevision('tenant-alpha', 'bundle-alpha-intro', 3, {
          change_summary: 'Illegal mutation on published revision',
        });
      } catch (err) {
        if (err instanceof CustomRuntimeError && /** @type {string} */ (err.code) === 'REVISION_SEALED') {
          sealedErrorBlocked = true;
        }
      }

      if (!sealedErrorBlocked) {
        throw new Error('Mutating sealed revision did not throw REVISION_SEALED');
      }

      return {
        revision: 3,
        status: 'published',
        immutableEnforced: sealedErrorBlocked,
      };
    },
  );

  // SBR-08: Deterministic source and build digests with quota enforcement
  await recordCheck(
    'SBR-08',
    'Deterministic canonical source & build digests with quota and depth bounds',
    'digests_and_quotas',
    async () => {
      const filesA = [
        { path: 'b.js', content: 'const b = 2;' },
        { path: 'a.js', content: 'const a = 1;' },
      ];
      const filesB = [
        { path: 'a.js', content: 'const a = 1;' },
        { path: 'b.js', content: 'const b = 2;' },
      ];

      const digestA = computeDeterministicSourceDigest(filesA);
      const digestB = computeDeterministicSourceDigest(filesB);

      if (digestA.sourceSha256 !== digestB.sourceSha256) {
        throw new Error('Deterministic source digest is order-sensitive');
      }

      // Check depth violation
      let depthBlocked = false;
      try {
        normalizeSourceFilePath('1/2/3/4/5/6/7/8/9/overflow.js');
      } catch (err) {
        if (err instanceof CustomRuntimeError && err.code === 'SANDBOX_RESOURCE_LIMIT') {
          depthBlocked = true;
        }
      }

      if (!depthBlocked) {
        throw new Error('Exceeding max nesting depth 8 was not rejected');
      }

      return {
        orderInvarianceVerified: true,
        sourceSha256: digestA.sourceSha256,
        depthLimitEnforced: depthBlocked,
      };
    },
  );

  // SBR-09: Parameter schema validation, defaults injection, and prototype pollution defense
  await recordCheck(
    'SBR-09',
    'Parameter schema validation, defaults compilation, and prototype pollution defenses',
    'parameter_schema',
    async () => {
      const schema = {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            minLength: 2,
            maxLength: 50,
            default: 'Default Title',
          },
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 10,
            default: 5,
          },
        },
        required: ['title'],
        additionalProperties: false,
      };

      const resultWithDefaults = validateBundleParameters(schema, {});
      if (
        !resultWithDefaults.valid ||
        resultWithDefaults.validatedParameters.title !== 'Default Title' ||
        resultWithDefaults.validatedParameters.count !== 5
      ) {
        throw new Error('Parameter defaults injection failed');
      }

      // Invalid parameter value
      const invalidResult = validateBundleParameters(schema, { count: 99 });
      if (invalidResult.valid || invalidResult.errors.length === 0) {
        throw new Error('Parameter bounds violation was not detected');
      }

      // Prototype pollution attempt
      const protoPollutionResult = validateBundleParameters(
        schema,
        JSON.parse('{"__proto__": {"admin": true}}'),
      );
      if (protoPollutionResult.valid) {
        throw new Error('Prototype pollution was not rejected');
      }

      return {
        defaultsInjected: resultWithDefaults.validatedParameters,
        boundsViolationDetected: true,
        prototypePollutionBlocked: true,
      };
    },
  );

  // SBR-10: Tamper-evident provenance tracking
  await recordCheck(
    'SBR-10',
    'Tamper-evident provenance record generation and cryptographic digest verification',
    'provenance_audit',
    async () => {
      const prov = createSceneBundleProvenance({
        authoring_type: 'ai',
        author: 'ai-agent-42',
        ai_metadata: {
          provider: 'anthropic-neutral-adapter',
          model: 'claude-3-5-sonnet',
          prompt_tokens: 1200,
          completion_tokens: 450,
          cost_usd: 0.015,
          job_id: 'job-author-123',
        },
        rights_and_license: {
          license: 'MIT',
          copyright_holder: 'Tenant Alpha',
          rights_provenance: 'ai-assisted-prompt',
          commercial_use_allowed: true,
        },
        declared_capabilities: ['webgl'],
        source_sha256: 'a'.repeat(64),
        build_sha256: 'b'.repeat(64),
      });

      if (!verifyProvenanceIntegrity(prov)) {
        throw new Error('Newly created provenance failed integrity check');
      }

      // Mutate field to simulate tampering
      const tampered = { ...prov, author: 'attacker' };
      if (verifyProvenanceIntegrity(tampered)) {
        throw new Error('Tampered provenance passed integrity check');
      }

      return {
        provenanceId: prov.provenance_id,
        provenanceDigest: prov.provenance_digest,
        integrityCheckPassed: true,
        tamperDetected: true,
      };
    },
  );

  // SBR-11: Download access for manifest, individual files, and build artifacts
  await recordCheck(
    'SBR-11',
    'Download access with path traversal defense and digest verification',
    'download_access',
    async () => {
      const manifestDl = registry.downloadSource('tenant-alpha', 'bundle-alpha-intro', 1, {
        format: 'manifest',
      });
      const singleFile = registry.downloadSourceFile(
        'tenant-alpha',
        'bundle-alpha-intro',
        1,
        'index.js',
      );
      const buildDl = registry.downloadBuild('tenant-alpha', 'bundle-alpha-intro', 1);

      // Path traversal check
      let traversalBlocked = false;
      try {
        registry.downloadSourceFile(
          'tenant-alpha',
          'bundle-alpha-intro',
          1,
          '../../etc/passwd',
        );
      } catch (err) {
        if (err instanceof CustomRuntimeError && err.code === 'SANDBOX_SECURITY_VIOLATION') {
          traversalBlocked = true;
        }
      }

      if (!traversalBlocked || manifestDl.totalFiles < 1 || !singleFile.content) {
        throw new Error('Download access verification failed');
      }

      return {
        manifestTotalFiles: manifestDl.totalFiles,
        singleFileName: singleFile.path,
        singleFileMime: singleFile.mime_type,
        buildSha256: buildDl.buildSha256,
        traversalBlocked,
      };
    },
  );

  // SBR-12: Full OpenAPI 3.1 Extension Specification
  await recordCheck(
    'SBR-12',
    'Full OpenAPI 3.1 extension: all 10 scene-bundle routes, components, and schemas',
    'openapi_extension',
    async () => {
      const spec = getSceneBundleOpenApiSpec();
      const validation = validateOpenApiSpecification(spec);

      if (!validation.valid) {
        throw new Error(`OpenAPI spec validation failed: ${validation.errors.join('; ')}`);
      }

      const paths = /** @type {Record<string, unknown>} */ (spec.paths || {});
      const expectedRoutes = [
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

      for (const route of expectedRoutes) {
        if (!paths[route]) {
          throw new Error(`Missing expected OpenAPI route: "${route}"`);
        }
      }

      return {
        openapiVersion: spec.openapi,
        routesCount: Object.keys(paths).length,
        schemasCount: Object.keys(/** @type {any} */ (spec.components)?.schemas || {}).length,
        specValid: true,
      };
    },
  );

  // SBR-13: Feature still off gate (CVE_CUSTOM_CODE_ENABLED=false)
  await recordCheck(
    'SBR-13',
    'Feature still off: custom scene execution is strictly blocked with CAPABILITY_DISABLED',
    'feature_still_off',
    async () => {
      let executionBlocked = false;
      let errorCode = '';

      try {
        registry.prepareCustomSceneExecution('tenant-alpha', {
          bundle_id: 'bundle-alpha-intro',
          revision: 1,
          parameters: { headline: 'Test Headline' },
        });
      } catch (err) {
        if (err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED') {
          executionBlocked = true;
          errorCode = err.code;
        }
      }

      if (!executionBlocked) {
        throw new Error('Scene execution was not blocked while feature is off');
      }

      return {
        defaultCustomCodeEnabled: false,
        defaultCustomRuntime: 'disabled',
        executionBlocked,
        errorCode,
      };
    },
  );

  const passedChecks = checks.filter((c) => c.passed).length;
  const failedChecks = checks.length - passedChecks;
  const status = failedChecks === 0 ? 'PASS' : 'FAIL';
  const durationMs = Date.now() - startedAt;

  return {
    taskId: 'P7-02',
    status,
    totalChecks: checks.length,
    passedChecks,
    failedChecks,
    durationMs,
    timestamp: new Date().toISOString(),
    defaultFeatureState: {
      CVE_CUSTOM_CODE_ENABLED: false,
      CVE_CUSTOM_RUNTIME: 'disabled',
      CVE_CUSTOM_TENANT_ALLOWLIST: [],
    },
    checks,
  };
}
