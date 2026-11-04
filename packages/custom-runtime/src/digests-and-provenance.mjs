// @ts-check
/**
 * Deterministic Source & Build Digests, Quotas, and Tamper-Evident Provenance (Task P7-02).
 * Enforces docs/SECURITY.md limits: <= 100 files, <= 5 MiB source, <= 20 MiB built assets,
 * max nesting depth <= 8, path traversal defenses, UStar POSIX tarball packaging,
 * and canonical provenance integrity verification.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { CustomRuntimeError } from './adr-policy.mjs';
import { CUSTOM_BUNDLE_QUOTAS } from './microvm-bounds.mjs';

/**
 * Valid authoring types for scene bundle provenance.
 */
export const PROVENANCE_AUTHORING_TYPES = Object.freeze([
  'human',
  'ai',
  'fork',
  'import',
]);

/**
 * Declared capabilities allowlist.
 * Explicitly excludes dangerous host/os capabilities ('network', 'shell', 'fs', 'eval', 'exec').
 */
export const ALLOWED_BUNDLE_CAPABILITIES = Object.freeze([
  'canvas-2d',
  'webgl',
  'webgl2',
  'custom-fonts',
  'svg-filter',
  'audio-synthesis',
  'procedural-animation',
  'lottie-vector',
]);

export const FORBIDDEN_BUNDLE_CAPABILITIES = Object.freeze([
  'network',
  'egress',
  'host-fs',
  'filesystem',
  'shell',
  'process',
  'eval',
  'native-binding',
  'ipc',
  'docker',
]);

/**
 * Forbidden path tokens and file names.
 */
const FORBIDDEN_PATH_TOKENS = Object.freeze([
  '..',
  '.git',
  '.env',
  'node_modules',
  '.agy',
  '.worktrees',
  '.local',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/root',
  '/var',
]);

/**
 * Normalize and validate a relative file path for a scene bundle source file.
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeSourceFilePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Source file path must be a non-empty string',
      false,
      { rawPath },
    );
  }

  // Reject null bytes
  if (rawPath.includes('\0')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Null bytes in source file path are forbidden',
      false,
      { rawPath },
    );
  }

  // Convert backslashes to forward slashes
  const normalizedSlashes = rawPath.replace(/\\/g, '/');

  // Must not be an absolute path
  if (normalizedSlashes.startsWith('/') || /^[a-zA-Z]:/.test(normalizedSlashes)) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Absolute paths are forbidden in scene bundles: "${rawPath}"`,
      false,
      { rawPath },
    );
  }

  // Resolve path segments
  const segments = normalizedSlashes.split('/').filter((s) => s.length > 0 && s !== '.');

  if (segments.length === 0) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Source file path cannot resolve to an empty path',
      false,
      { rawPath },
    );
  }

  // Check nesting depth
  if (segments.length > CUSTOM_BUNDLE_QUOTAS.maxNestingDepth) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Source file path nesting depth (${segments.length}) exceeds maximum limit of ${CUSTOM_BUNDLE_QUOTAS.maxNestingDepth}: "${rawPath}"`,
      false,
      { rawPath, depth: segments.length, maxDepth: CUSTOM_BUNDLE_QUOTAS.maxNestingDepth },
    );
  }

  // Check traversal and forbidden tokens
  for (const seg of segments) {
    if (seg === '..') {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Path traversal ("..") is strictly forbidden in scene bundles: "${rawPath}"`,
        false,
        { rawPath },
      );
    }
    if (FORBIDDEN_PATH_TOKENS.includes(seg)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Forbidden file or directory token "${seg}" in path: "${rawPath}"`,
        false,
        { rawPath, segment: seg },
      );
    }
  }

  return segments.join('/');
}

/**
 * Standardize input file into `{ path, content: Buffer, size: number, sha256: string }`.
 * @param {{ path: string; content: Buffer | string }} file
 * @returns {{ path: string; content: Buffer; size: number; sha256: string }}
 */
export function normalizeSourceFileEntry(file) {
  const normPath = normalizeSourceFilePath(file.path);
  const buf = Buffer.isBuffer(file.content)
    ? file.content
    : Buffer.from(file.content ?? '', 'utf-8');

  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    path: normPath,
    content: buf,
    size: buf.length,
    sha256,
  };
}

/**
 * Guess MIME type from file extension.
 * @param {string} filePath
 * @returns {string}
 */
export function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.txt':
    case '.md':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Deterministically compute the canonical source digest and manifest for a bundle.
 * Enforces file count, byte bounds, path normalization, and stable ordering.
 *
 * @param {readonly { path: string; content: Buffer | string }[]} rawFiles
 * @returns {{
 *   sourceSha256: string;
 *   totalFiles: number;
 *   totalBytes: number;
 *   manifest: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
 * }}
 */
export function computeDeterministicSourceDigest(rawFiles) {
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Scene bundle must contain at least one source file',
      false,
      { fileCount: rawFiles ? rawFiles.length : 0 },
    );
  }

  if (rawFiles.length > CUSTOM_BUNDLE_QUOTAS.maxFiles) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Scene bundle source files count (${rawFiles.length}) exceeds maximum limit of ${CUSTOM_BUNDLE_QUOTAS.maxFiles}`,
      false,
      { count: rawFiles.length, max: CUSTOM_BUNDLE_QUOTAS.maxFiles },
    );
  }

  // Normalize entries
  const normalizedEntries = rawFiles.map(normalizeSourceFileEntry);

  // Check duplicate paths
  const pathSet = new Set();
  let totalBytes = 0;

  for (const entry of normalizedEntries) {
    if (pathSet.has(entry.path)) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Duplicate file path in source bundle: "${entry.path}"`,
        false,
        { duplicatePath: entry.path },
      );
    }
    pathSet.add(entry.path);
    totalBytes += entry.size;
  }

  if (totalBytes > CUSTOM_BUNDLE_QUOTAS.maxSourceBytes) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Scene bundle cumulative source size (${totalBytes} bytes) exceeds maximum limit of ${CUSTOM_BUNDLE_QUOTAS.maxSourceBytes} bytes (5 MiB)`,
      false,
      { totalBytes, maxSourceBytes: CUSTOM_BUNDLE_QUOTAS.maxSourceBytes },
    );
  }

  // Deterministically sort by path ascending using code point order
  normalizedEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Compute canonical sourceSha256
  const hasher = crypto.createHash('sha256');
  for (const entry of normalizedEntries) {
    hasher.update(`path:${entry.path}\0size:${entry.size}\0sha256:${entry.sha256}\0`);
    hasher.update(entry.content);
  }
  const sourceSha256 = hasher.digest('hex');

  const manifest = normalizedEntries.map((e) => ({
    path: e.path,
    size: e.size,
    sha256: e.sha256,
    mime_type: guessMimeType(e.path),
  }));

  return {
    sourceSha256,
    totalFiles: normalizedEntries.length,
    totalBytes,
    manifest,
  };
}

/**
 * Deterministically compute the canonical build digest and manifest for compiled artifacts.
 * Enforces compiled asset byte limits (<= 20 MiB).
 *
 * @param {readonly { path: string; content: Buffer | string }[]} rawArtifacts
 * @returns {{
 *   buildSha256: string;
 *   totalFiles: number;
 *   totalBytes: number;
 *   manifest: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
 * }}
 */
export function computeDeterministicBuildDigest(rawArtifacts) {
  if (!Array.isArray(rawArtifacts) || rawArtifacts.length === 0) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Scene bundle build artifacts must contain at least one output artifact',
      false,
      { count: rawArtifacts ? rawArtifacts.length : 0 },
    );
  }

  const normalizedEntries = rawArtifacts.map(normalizeSourceFileEntry);
  const pathSet = new Set();
  let totalBytes = 0;

  for (const entry of normalizedEntries) {
    if (pathSet.has(entry.path)) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Duplicate artifact path in build output: "${entry.path}"`,
        false,
        { duplicatePath: entry.path },
      );
    }
    pathSet.add(entry.path);
    totalBytes += entry.size;
  }

  if (totalBytes > CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Scene bundle cumulative build size (${totalBytes} bytes) exceeds maximum limit of ${CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes} bytes (20 MiB)`,
      false,
      { totalBytes, maxBuiltAssetBytes: CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes },
    );
  }

  // Sort deterministically
  normalizedEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const hasher = crypto.createHash('sha256');
  for (const entry of normalizedEntries) {
    hasher.update(`artifact:${entry.path}\0size:${entry.size}\0sha256:${entry.sha256}\0`);
    hasher.update(entry.content);
  }
  const buildSha256 = hasher.digest('hex');

  const manifest = normalizedEntries.map((e) => ({
    path: e.path,
    size: e.size,
    sha256: e.sha256,
    mime_type: guessMimeType(e.path),
  }));

  return {
    buildSha256,
    totalFiles: normalizedEntries.length,
    totalBytes,
    manifest,
  };
}

/**
 * Verify source files integrity against expected source_sha256.
 * @param {readonly { path: string; content: Buffer | string }[]} files
 * @param {string} expectedSha256
 * @returns {boolean}
 */
export function verifySourceIntegrity(files, expectedSha256) {
  if (!expectedSha256 || typeof expectedSha256 !== 'string' || expectedSha256.length !== 64) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Invalid expected source_sha256 format: "${expectedSha256}"`,
      false,
      { expectedSha256 },
    );
  }
  const { sourceSha256 } = computeDeterministicSourceDigest(files);
  if (sourceSha256 !== expectedSha256.toLowerCase()) {
    throw new CustomRuntimeError(
      'DIGEST_MISMATCH',
      `Source files integrity verification failed: expected ${expectedSha256}, got ${sourceSha256}`,
      false,
      { expected: expectedSha256, actual: sourceSha256 },
    );
  }
  return true;
}

/**
 * Verify build artifacts integrity against expected build_sha256.
 * @param {readonly { path: string; content: Buffer | string }[]} artifacts
 * @param {string} expectedSha256
 * @returns {boolean}
 */
export function verifyBuildIntegrity(artifacts, expectedSha256) {
  if (!expectedSha256 || typeof expectedSha256 !== 'string' || expectedSha256.length !== 64) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Invalid expected build_sha256 format: "${expectedSha256}"`,
      false,
      { expectedSha256 },
    );
  }
  const { buildSha256 } = computeDeterministicBuildDigest(artifacts);
  if (buildSha256 !== expectedSha256.toLowerCase()) {
    throw new CustomRuntimeError(
      'DIGEST_MISMATCH',
      `Build artifacts integrity verification failed: expected ${expectedSha256}, got ${buildSha256}`,
      false,
      { expected: expectedSha256, actual: buildSha256 },
    );
  }
  return true;
}

/**
 * Generate a deterministic UStar POSIX tar archive buffer in memory without dependencies.
 * @param {readonly { path: string; content: Buffer | string }[]} rawFiles
 * @returns {Buffer}
 */
export function packFilesToTarArchive(rawFiles) {
  const { manifest } = computeDeterministicSourceDigest(rawFiles);
  // Sort entries
  const fileMap = new Map();
  for (const f of rawFiles) {
    const entry = normalizeSourceFileEntry(f);
    fileMap.set(entry.path, entry);
  }

  const blocks = [];

  for (const m of manifest) {
    const file = fileMap.get(m.path);
    if (!file) continue;

    // Header 512 bytes
    const header = Buffer.alloc(512, 0);

    // 0..100: name (null-padded)
    const nameBuf = Buffer.from(file.path, 'utf-8');
    nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));

    // 100..108: mode (0o644 in octal)
    header.write('0000644\0', 100, 8, 'ascii');

    // 108..116: uid (10001)
    header.write('0023421\0', 108, 8, 'ascii');

    // 116..124: gid (10001)
    header.write('0023421\0', 116, 8, 'ascii');

    // 124..136: size (octal with trailing space or null, 11 digits + 1 space/null)
    const sizeOctal = file.size.toString(8).padStart(11, '0') + ' ';
    header.write(sizeOctal, 124, 12, 'ascii');

    // 136..148: mtime (0 for deterministic reproducibility)
    header.write('00000000000 ', 136, 12, 'ascii');

    // 148..156: checksum placeholder (spaces)
    header.fill(0x20, 148, 156);

    // 156: typeflag '0' (regular file)
    header.write('0', 156, 1, 'ascii');

    // 257..263: magic "ustar\0"
    header.write('ustar\0', 257, 6, 'ascii');

    // 263..265: version "00"
    header.write('00', 263, 2, 'ascii');

    // 265..297: uname "sandbox"
    header.write('sandbox\0', 265, 8, 'ascii');

    // 297..329: gname "sandbox"
    header.write('sandbox\0', 297, 8, 'ascii');

    // Compute checksum (unsigned sum of all 512 bytes)
    let chksum = 0;
    for (let i = 0; i < 512; i++) {
      chksum += header[i] ?? 0;
    }
    const chksumOctal = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chksumOctal, 148, 8, 'ascii');

    blocks.push(header);

    // Data blocks padded to 512 bytes
    blocks.push(file.content);
    const remainder = file.size % 512;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }

  // End of archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024, 0));

  return Buffer.concat(blocks);
}

/**
 * Parse files from an in-memory UStar tar archive buffer.
 * @param {Buffer} tarBuffer
 * @returns {Array<{ path: string; content: Buffer }>}
 */
export function unpackFilesFromTarArchive(tarBuffer) {
  if (!Buffer.isBuffer(tarBuffer) || tarBuffer.length < 1024) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Invalid tar archive: buffer too small or malformed',
      false,
    );
  }

  const files = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);

    // Check for end-of-archive (two zero blocks)
    let isZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break;

    // Read name
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) nameEnd++;
    const name = header.subarray(0, nameEnd).toString('utf-8');

    // Read size (octal)
    let sizeStr = header.subarray(124, 136).toString('ascii').trim();
    if (sizeStr.endsWith('\0')) sizeStr = sizeStr.slice(0, -1).trim();
    const size = parseInt(sizeStr, 8);

    if (isNaN(size) || size < 0) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Corrupted tar archive header for file "${name}": invalid size`,
        false,
        { offset, name },
      );
    }

    offset += 512;

    if (offset + size > tarBuffer.length) {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        `Corrupted tar archive: truncated file content for "${name}"`,
        false,
        { offset, size, bufferLength: tarBuffer.length },
      );
    }

    const content = Buffer.from(tarBuffer.subarray(offset, offset + size));
    files.push({ path: name, content });

    // Advance offset aligned to 512
    const padding = (512 - (size % 512)) % 512;
    offset += size + padding;
  }

  return files;
}

/**
 * Scene bundle provenance record structure.
 * @typedef {{
 *   provenance_id: string;
 *   authoring_type: 'human' | 'ai' | 'fork' | 'import';
 *   author: string;
 *   created_at: string;
 *   base_revision: number | null;
 *   source_bundle: { bundle_id: string; revision: number } | null;
 *   ai_metadata: {
 *     provider?: string;
 *     model?: string;
 *     prompt_tokens?: number;
 *     completion_tokens?: number;
 *     cost_usd?: number;
 *     job_id?: string;
 *     brief_hash?: string;
 *     generation_params?: Record<string, unknown>;
 *   } | null;
 *   rights_and_license: {
 *     license: string;
 *     copyright_holder?: string;
 *     rights_provenance: string;
 *     commercial_use_allowed: boolean;
 *   };
 *   declared_capabilities: string[];
 *   source_sha256: string;
 *   build_sha256: string;
 *   provenance_digest: string;
 * }} SceneBundleProvenance
 */

/**
 * Calculate canonical SHA-256 digest of a provenance record (RFC 8785 canonical representation).
 * @param {Omit<SceneBundleProvenance, 'provenance_digest'>} record
 * @returns {string}
 */
export function calculateProvenanceDigest(record) {
  // Canonical sort keys
  const rec = /** @type {Record<string, unknown>} */ (record);
  const keys = Object.keys(rec).sort();
  const canonicalObj = /** @type {Record<string, unknown>} */ ({});
  for (const k of keys) {
    if (k !== 'provenance_digest') {
      canonicalObj[k] = rec[k];
    }
  }
  const jsonString = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(jsonString, 'utf-8').digest('hex');
}

/**
 * Create a validated, tamper-evident scene bundle provenance record.
 *
 * @param {{
 *   authoring_type: 'human' | 'ai' | 'fork' | 'import';
 *   author: string;
 *   base_revision?: number | null;
 *   source_bundle?: { bundle_id: string; revision: number } | null;
 *   ai_metadata?: {
 *     provider?: string;
 *     model?: string;
 *     prompt_tokens?: number;
 *     completion_tokens?: number;
 *     cost_usd?: number;
 *     job_id?: string;
 *     brief_hash?: string;
 *     generation_params?: Record<string, unknown>;
 *   } | null;
 *   rights_and_license: {
 *     license: string;
 *     copyright_holder?: string;
 *     rights_provenance: string;
 *     commercial_use_allowed?: boolean;
 *   };
 *   declared_capabilities?: readonly string[];
 *   source_sha256: string;
 *   build_sha256: string;
 *   createdAt?: string;
 * }} input
 * @returns {SceneBundleProvenance}
 */
export function createSceneBundleProvenance(input) {
  if (!input || typeof input !== 'object') {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Scene bundle provenance input must be an object',
      false,
    );
  }

  // Validate authoring type
  if (!PROVENANCE_AUTHORING_TYPES.includes(input.authoring_type)) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      `Invalid authoring_type "${input.authoring_type}". Permitted: ${PROVENANCE_AUTHORING_TYPES.join(', ')}`,
      false,
      { authoring_type: input.authoring_type },
    );
  }

  // Validate author
  if (typeof input.author !== 'string' || !input.author.trim()) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Author identifier is required for provenance record',
      false,
    );
  }

  // Validate digests format
  if (typeof input.source_sha256 !== 'string' || input.source_sha256.length !== 64) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Invalid source_sha256 in provenance record: must be 64-character hex string',
      false,
      { source_sha256: input.source_sha256 },
    );
  }

  if (typeof input.build_sha256 !== 'string' || input.build_sha256.length !== 64) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Invalid build_sha256 in provenance record: must be 64-character hex string',
      false,
      { build_sha256: input.build_sha256 },
    );
  }

  // Validate declared capabilities
  /** @type {string[]} */
  const declaredCapabilities = [];
  if (Array.isArray(input.declared_capabilities)) {
    for (const cap of input.declared_capabilities) {
      if (typeof cap !== 'string') continue;
      const lower = cap.toLowerCase();
      if (FORBIDDEN_BUNDLE_CAPABILITIES.includes(lower)) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Declared capability "${cap}" is explicitly forbidden in sandboxed scene bundles`,
          false,
          { forbiddenCapability: cap },
        );
      }
      if (ALLOWED_BUNDLE_CAPABILITIES.includes(lower) && !declaredCapabilities.includes(lower)) {
        declaredCapabilities.push(lower);
      }
    }
  }

  // Validate rights and license
  const ral = input.rights_and_license;
  if (!ral || typeof ral !== 'object' || typeof ral.license !== 'string' || !ral.license.trim()) {
    throw new CustomRuntimeError(
      'VALIDATION_FAILED',
      'Missing or invalid rights_and_license declaration in provenance',
      false,
    );
  }

  const rightsAndLicense = {
    license: ral.license.trim(),
    copyright_holder: ral.copyright_holder ? String(ral.copyright_holder).trim() : undefined,
    rights_provenance: ral.rights_provenance ? String(ral.rights_provenance).trim() : 'tenant-declared',
    commercial_use_allowed: ral.commercial_use_allowed !== false,
  };

  // Validate AI metadata if AI-authored
  let aiMetadata = null;
  if (input.authoring_type === 'ai') {
    if (!input.ai_metadata || typeof input.ai_metadata !== 'object') {
      throw new CustomRuntimeError(
        'VALIDATION_FAILED',
        'AI-authored scene bundles must include ai_metadata with provider and model',
        false,
      );
    }
    aiMetadata = {
      provider: input.ai_metadata.provider ? String(input.ai_metadata.provider) : 'provider-neutral-mock',
      model: input.ai_metadata.model ? String(input.ai_metadata.model) : 'custom-code-authoring-v1',
      prompt_tokens: typeof input.ai_metadata.prompt_tokens === 'number' ? input.ai_metadata.prompt_tokens : 0,
      completion_tokens: typeof input.ai_metadata.completion_tokens === 'number' ? input.ai_metadata.completion_tokens : 0,
      cost_usd: typeof input.ai_metadata.cost_usd === 'number' ? input.ai_metadata.cost_usd : 0,
      job_id: input.ai_metadata.job_id ? String(input.ai_metadata.job_id) : undefined,
      brief_hash: input.ai_metadata.brief_hash ? String(input.ai_metadata.brief_hash) : undefined,
      generation_params: input.ai_metadata.generation_params && typeof input.ai_metadata.generation_params === 'object'
        ? input.ai_metadata.generation_params
        : undefined,
    };
  }

  // Validate source bundle if forked or imported
  let sourceBundle = null;
  if (input.authoring_type === 'fork' || input.authoring_type === 'import') {
    if (input.source_bundle && typeof input.source_bundle === 'object') {
      sourceBundle = {
        bundle_id: String(input.source_bundle.bundle_id),
        revision: Number(input.source_bundle.revision) || 1,
      };
    }
  }

  const provenanceRecord = {
    provenance_id: crypto.randomUUID(),
    authoring_type: input.authoring_type,
    author: input.author.trim(),
    created_at: input.createdAt || new Date().toISOString(),
    base_revision: input.base_revision !== undefined && input.base_revision !== null ? Number(input.base_revision) : null,
    source_bundle: sourceBundle,
    ai_metadata: aiMetadata,
    rights_and_license: rightsAndLicense,
    declared_capabilities: declaredCapabilities,
    source_sha256: input.source_sha256.toLowerCase(),
    build_sha256: input.build_sha256.toLowerCase(),
  };

  const provenance_digest = calculateProvenanceDigest(provenanceRecord);

  return {
    ...provenanceRecord,
    provenance_digest,
  };
}

/**
 * Verify that a provenance record has not been tampered with.
 * @param {SceneBundleProvenance | null | undefined} provenance
 * @returns {boolean}
 */
export function verifyProvenanceIntegrity(provenance) {
  if (!provenance || typeof provenance !== 'object' || !provenance.provenance_digest) {
    return false;
  }
  const expectedDigest = provenance.provenance_digest;
  const recalculated = calculateProvenanceDigest(provenance);
  return recalculated === expectedDigest;
}
