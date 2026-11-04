// @ts-check
/**
 * Source-Only Output Verification and Security Guard (Task P7-03).
 *
 * Enforces:
 *   - Strictly source-only output: AI generates files for isolated build in microVM,
 *     NEVER executes in trusted API or supervisor.
 *   - Static security scan against dynamic eval, network egress, and host/process access.
 *   - Secret canary leakage detector: verifies canary tokens are absent from generated code.
 *   - Parameter schema validation with prototype pollution and ReDoS defenses.
 *   - Deterministic digests, CSP script hash calculation, and AI provenance records.
 */

import { CustomRuntimeError } from './adr-policy.mjs';
import { CUSTOM_BUNDLE_QUOTAS } from './microvm-bounds.mjs';
import {
  computeDeterministicSourceDigest,
  computeDeterministicBuildDigest,
  createSceneBundleProvenance,
  normalizeSourceFilePath,
} from './digests-and-provenance.mjs';
import { buildCustomSceneCspHeader } from './isolation-guards.mjs';
import { validateParameterSchemaDefinition } from './parameter-schema.mjs';

/**
 * Forbidden code patterns in AI-generated custom scene source code.
 */
const FORBIDDEN_SOURCE_PATTERNS = Object.freeze([
  {
    regex: /\beval\s*\(/i,
    reason: 'Dynamic code execution (eval) is strictly forbidden',
  },
  {
    regex: /\bFunction\s*\(/i,
    reason: 'Function constructor dynamic code execution is strictly forbidden',
  },
  {
    regex: /\b(setTimeout|setInterval)\s*\(\s*["'`]/i,
    reason: 'String evaluation in timers is strictly forbidden',
  },
  {
    regex: /\b(process\.|globalThis\.process|process\[)/i,
    reason: 'Host process object access is strictly forbidden',
  },
  {
    regex: /\b(child_process|node:child_process)\b/i,
    reason: 'Subprocess execution modules are strictly forbidden',
  },
  {
    regex: /\b(fs\.|node:fs|require\s*\(\s*["']fs)/i,
    reason: 'Filesystem access in custom scene code is strictly forbidden',
  },
  {
    regex: /\b(fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/i,
    reason: 'Network egress and outbound sockets in custom scene code are strictly forbidden',
  },
  {
    regex: /https?:\/\/(?!www\.w3\.org\/2000\/svg|www\.w3\.org\/1999\/xlink|json-schema\.org)/i,
    reason: 'Outbound HTTP/HTTPS URLs are strictly forbidden; use relative approved assets',
  },
]);

/**
 * Standard canary secret token patterns to detect leakage.
 */
const SECRET_CANARY_PATTERNS = Object.freeze([
  /CVE_[A-Z0-9_]*SECRET[A-Z0-9_]*/i,
  /CANARY_[A-Z0-9_]+/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /ghp_[a-zA-Z0-9]{20,}/i,
  /AIza[0-9A-Za-z-_]{35}/i,
  /bearer\s+[a-zA-Z0-9._-]{30,}/i,
]);

/**
 * Static security scanner for generated source files.
 * @param {Array<{ path: string; content: string | Buffer }>} files
 * @param {string[]} [canarySecrets] Optional list of active canary secret tokens to detect
 */
export function scanSourceFilesForSecurityViolations(files, canarySecrets = []) {
  for (const file of files) {
    const text = typeof file.content === 'string'
      ? file.content
      : Buffer.isBuffer(file.content)
      ? file.content.toString('utf-8')
      : '';

    // 1. Check forbidden source patterns
    for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
      if (pattern.regex.test(text)) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Security violation in generated source file "${file.path}": ${pattern.reason}`,
          false,
          { file: file.path, pattern: pattern.regex.toString() },
        );
      }
    }

    // 2. Check general secret canary patterns
    for (const canaryPattern of SECRET_CANARY_PATTERNS) {
      if (canaryPattern.test(text)) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Canary secret leakage detected in generated source file "${file.path}"`,
          false,
          { file: file.path, reason: 'SECRET_CANARY_DETECTED' },
        );
      }
    }

    // 3. Check explicit canary secret tokens if passed
    if (Array.isArray(canarySecrets)) {
      for (const secret of canarySecrets) {
        if (typeof secret === 'string' && secret.trim().length >= 8 && text.includes(secret)) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Specific canary secret token detected in generated file "${file.path}"`,
            false,
            { file: file.path, reason: 'CANARY_TOKEN_MATCH' },
          );
        }
      }
    }
  }
}

/**
 * Validates and sanitizes the output of an AI authoring adapter.
 *
 * @param {{
 *   files: Array<{ path: string; content: string | Buffer }>;
 *   entrypoint?: string;
 *   parameter_schema?: Record<string, unknown>;
 *   declared_capabilities?: string[];
 *   metadata?: Record<string, unknown>;
 * }} rawOutput
 * @param {{
 *   tenantId: string;
 *   jobId: string;
 *   brief: string;
 *   briefHash: string;
 *   provider: string;
 *   model: string;
 *   approvedAssetIds?: string[];
 *   canarySecrets?: string[];
 * }} options
 */
export function validateAndSanitizeAuthoringOutput(rawOutput, options) {
  if (!rawOutput || typeof rawOutput !== 'object') {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Authoring adapter output must be a non-null object',
      false,
    );
  }

  // 1. Validate files array
  if (!Array.isArray(rawOutput.files) || rawOutput.files.length === 0) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Authoring output must contain at least one source file',
      false,
    );
  }

  if (rawOutput.files.length > CUSTOM_BUNDLE_QUOTAS.maxFiles) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Authoring output file count (${rawOutput.files.length}) exceeds quota limit of ${CUSTOM_BUNDLE_QUOTAS.maxFiles}`,
      false,
      { count: rawOutput.files.length, max: CUSTOM_BUNDLE_QUOTAS.maxFiles },
    );
  }

  // 2. Normalize and check file entries
  /** @type {Array<{ path: string; content: Buffer; size: number }>} */
  const normalizedFiles = [];
  let totalBytes = 0;

  for (const f of rawOutput.files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'Each source file in authoring output must have a valid path',
        false,
      );
    }

    const normPath = normalizeSourceFilePath(f.path);
    const buf = Buffer.isBuffer(f.content)
      ? f.content
      : Buffer.from(typeof f.content === 'string' ? f.content : '', 'utf-8');

    totalBytes += buf.length;
    if (totalBytes > CUSTOM_BUNDLE_QUOTAS.maxSourceBytes) {
      throw new CustomRuntimeError(
        'SANDBOX_RESOURCE_LIMIT',
        `Authoring output source size (${totalBytes} bytes) exceeds limit of ${CUSTOM_BUNDLE_QUOTAS.maxSourceBytes} bytes (5 MiB)`,
        false,
        { totalBytes, max: CUSTOM_BUNDLE_QUOTAS.maxSourceBytes },
      );
    }

    normalizedFiles.push({
      path: normPath,
      content: buf,
      size: buf.length,
    });
  }

  // 3. Verify entrypoint
  const entrypoint = rawOutput.entrypoint ? normalizeSourceFilePath(rawOutput.entrypoint) : 'index.html';
  const entrypointExists = normalizedFiles.some((f) => f.path === entrypoint);
  if (!entrypointExists) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Authoring output missing required entrypoint file "${entrypoint}"`,
      false,
      { entrypoint },
    );
  }

  // 4. Run static security scan
  scanSourceFilesForSecurityViolations(normalizedFiles, options.canarySecrets);

  // 5. Validate parameter schema if present
  let parameterSchema = {};
  if (rawOutput.parameter_schema && typeof rawOutput.parameter_schema === 'object') {
    validateParameterSchemaDefinition(rawOutput.parameter_schema, { strict: true });
    parameterSchema = rawOutput.parameter_schema;
  }

  // 6. Compute deterministic source and build digests
  const { sourceSha256 } = computeDeterministicSourceDigest(normalizedFiles);
  const { buildSha256 } = computeDeterministicBuildDigest(normalizedFiles);

  // 7. Calculate CSP script hash
  const entryFile = normalizedFiles.find((f) => f.path === entrypoint);
  const entryContent = entryFile ? entryFile.content.toString('utf-8') : '';
  const { scriptHashToken } = buildCustomSceneCspHeader(entryContent);

  // 8. Declared capabilities
  /** @type {string[]} */
  const declaredCapabilities = Array.isArray(rawOutput.declared_capabilities)
    ? rawOutput.declared_capabilities.filter((c) => typeof c === 'string')
    : ['canvas-2d', 'procedural-animation'];

  // 9. Build AI Provenance record
  const provenance = createSceneBundleProvenance({
    authoring_type: 'ai',
    author: `ai-adapter-${options.provider}`,
    base_revision: null,
    source_sha256: sourceSha256,
    build_sha256: buildSha256,
    declared_capabilities: declaredCapabilities,
    rights_and_license: {
      license: 'Proprietary-Tenant',
      copyright_holder: options.tenantId,
      rights_provenance: 'ai-generated-draft',
      commercial_use_allowed: true,
    },
    ai_metadata: {
      provider: options.provider,
      model: options.model,
      prompt_tokens: typeof rawOutput.metadata?.prompt_tokens === 'number' ? rawOutput.metadata.prompt_tokens : 0,
      completion_tokens: typeof rawOutput.metadata?.completion_tokens === 'number' ? rawOutput.metadata.completion_tokens : 0,
      cost_usd: typeof rawOutput.metadata?.cost_usd === 'number' ? rawOutput.metadata.cost_usd : 0,
      job_id: options.jobId,
      brief_hash: options.briefHash,
      generation_params: {
        brief_preview: options.brief.slice(0, 100),
      },
    },
  });

  return {
    files: normalizedFiles,
    entrypoint,
    parameter_schema: parameterSchema,
    declared_capabilities: declaredCapabilities,
    source_sha256: sourceSha256,
    build_sha256: buildSha256,
    csp_script_hash: scriptHashToken,
    provenance,
    metadata: {
      ...rawOutput.metadata,
      provider: options.provider,
      model: options.model,
      job_id: options.jobId,
      brief_hash: options.briefHash,
      total_files: normalizedFiles.length,
      total_bytes: totalBytes,
    },
  };
}
