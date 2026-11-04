/**
 * Disposable MicroVM Isolation Guards: Zero Egress, Zero Secrets & Zero Host FS (Task P7-01).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (lines 22-60: no credentials, env allowlist, CSPscript hash, no unsafe-eval,
 *     no external network, no Node bridge, preinstalled allowlisted imports, filesystem/quotas)
 *   - packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SAFE_ID_REGEX,
  computeSha256Hex,
  redactSecretOutput,
} from '../../controller/dist/index.js';
import { CustomRuntimeError } from './adr-policy.mjs';
import { CUSTOM_BUNDLE_QUOTAS } from './microvm-bounds.mjs';

export const APPROVED_PREINSTALLED_SCENE_IMPORTS = Object.freeze([
  '@creativanta/scene-runtime',
  '@creativanta/scene-math',
  '@creativanta/scene-easing',
]);

export const ALLOWED_MICROVM_GUEST_ENV_KEYS = new Set([
  'TZ',
  'LANG',
  'LC_ALL',
  'HOME',
  'TMPDIR',
  'FONTCONFIG_FILE',
  'CVE_VM_ID',
  'CVE_VM_PHASE',
  'CVE_SANDBOX_JOB_ID',
  'CVE_SANDBOX_ATTEMPT_ID',
  'CVE_SANDBOX_LEASE_EPOCH',
  'CVE_SANDBOX_MODE',
  'CVE_LOOPBACK_ASSET_ORIGIN',
]);

const FORBIDDEN_SECRET_KEY_PATTERNS = [
  /SECRET/i,
  /PASSWORD/i,
  /PASSWD/i,
  /PEPPER/i,
  /TOKEN/i,
  /API_KEY/i,
  /APIKEY/i,
  /PRIVATE_KEY/i,
  /DATABASE_URL/i,
  /ACCESS_KEY/i,
  /ENCRYPTION_KEY/i,
  /CREDENTIAL/i,
  /^AWS_/i,
  /^GITHUB_/i,
  /^SSH_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^DEEPSEEK_/i,
  /^GEMINI_/i,
  /^CVE_AUTHORING_/i,
  /^CVE_TTS_/i,
  /^CVE_STORAGE_/i,
];

export const FORBIDDEN_HOST_FS_PATTERNS = Object.freeze([
  /docker\.sock/i,
  /containerd\.sock/i,
  /podman\.sock/i,
  /crio\.sock/i,
  /ssh-agent/i,
  /^\/proc(?:\/|$)/,
  /^\/sys(?:\/|$)/,
  /^\/dev(?:\/|$)/,
  /^\/etc(?:\/|$)/,
  /^\/root(?:\/|$)/,
  /^\/boot(?:\/|$)/,
  /^\/home(?:\/|$)/,
  /^\/var\/run(?:\/|$)/,
  /^\/run\/(?:docker|containerd|podman|systemd|udev|user)(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)\.agy(?:\/|$)/,
  /(?:^|\/)\.worktrees(?:\/|$)/,
]);

const FORBIDDEN_SOURCE_CAPABILITY_RULES = [
  {
    id: 'NETWORK_FETCH_API',
    pattern: /\b(?:window\.)?fetch\s*\(/,
    message: 'Custom scene code forbids fetch() network API (zero egress enforced)',
  },
  {
    id: 'NETWORK_XHR_API',
    pattern: /\bXMLHttpRequest\b/,
    message: 'Custom scene code forbids XMLHttpRequest network API',
  },
  {
    id: 'NETWORK_WEBSOCKET_API',
    pattern: /\bWebSocket\b/,
    message: 'Custom scene code forbids WebSocket API',
  },
  {
    id: 'NETWORK_EVENTSOURCE_API',
    pattern: /\bEventSource\b/,
    message: 'Custom scene code forbids EventSource API',
  },
  {
    id: 'NETWORK_SENDBEACON_API',
    pattern: /\bnavigator\.sendBeacon\b/,
    message: 'Custom scene code forbids navigator.sendBeacon()',
  },
  {
    id: 'NETWORK_WEBRTC_API',
    pattern: /\b(?:RTCPeerConnection|webkitRTCPeerConnection|mozRTCPeerConnection)\b/,
    message: 'Custom scene code forbids WebRTC APIs',
  },
  {
    id: 'SERVICE_WORKER_API',
    pattern: /\b(?:navigator\.serviceWorker|ServiceWorkerContainer)\b/,
    message: 'Custom scene code forbids ServiceWorker registration/access',
  },
  {
    id: 'WEB_WORKER_API',
    pattern: /\b(?:new\s+Worker|new\s+SharedWorker|importScripts)\s*\(/,
    message: 'Custom scene code forbids spawning Worker/SharedWorker or importScripts()',
  },
  {
    id: 'DYNAMIC_CODE_EVAL',
    pattern: /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/,
    message: 'Custom scene code forbids eval() and Function() constructor (unsafe-eval is banned)',
  },
  {
    id: 'NODE_PROCESS_OR_REQUIRE_BRIDGE',
    pattern:
      /\bprocess\.(?:env|binding|dlopen|exit|kill|mainModule)\b|\brequire\s*\(|\bchild_process\b|\bnode:[a-z0-9_/-]+/i,
    message: 'Custom scene code has no Node.js bridge (process/require/child_process/node:* forbidden)',
  },
  {
    id: 'DYNAMIC_IMPORT_CALL',
    pattern: /\bimport\s*\(/,
    message: 'Custom scene code forbids dynamic import() expressions',
  },
  {
    id: 'REMOTE_URL_LITERAL',
    pattern:
      /(?:src|href|url)\s*(?:=|\()\s*["']?\s*(?:https?:|wss?:|ftp:|file:|\/\/)/i,
    message: 'Custom scene code forbids external URL references in HTML/CSS/JS',
  },
  {
    id: 'CLOUD_METADATA_IMDS_IP',
    pattern: /\b169\.254\.169\.254\b|\[?fe80:/i,
    message: 'Custom scene code forbids cloud metadata IMDS or link-local IP literals',
  },
  {
    id: 'XXE_OR_FOREIGN_OBJECT',
    pattern: /<!DOCTYPE\s+[^>]*\[|<!ENTITY|<foreignObject\b/i,
    message: 'Custom scene code forbids XML ENTITY declarations and SVG <foreignObject>',
  },
];

/**
 * Computes CSP `sha256-<base64>` digest for compiled script content and builds strict zero-egress CSP header.
 * Per docs/SECURITY.md line 37: "Custom scripts cần CSP hash/nonce từ build, không cho unsafe-eval tùy tiện."
 */
export function buildCustomSceneCspHeader(compiledScriptContent) {
  const scriptBuf = Buffer.isBuffer(compiledScriptContent)
    ? compiledScriptContent
    : Buffer.from(String(compiledScriptContent || ''), 'utf-8');

  const sha256Base64 = crypto.createHash('sha256').update(scriptBuf).digest('base64');
  const scriptHashToken = `'sha256-${sha256Base64}'`;

  const cspHeader = [
    "default-src 'none'",
    `script-src 'self' ${scriptHashToken}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return {
    scriptHashToken,
    sha256Base64,
    cspHeader,
  };
}

/**
 * Verifies that a microVM specification enforces hardware/hypervisor zero network egress.
 */
export function assertZeroEgressMicroVmSpec(vmConfig) {
  if (!vmConfig || typeof vmConfig !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Missing microVM configuration object for zero-egress verification',
      false,
    );
  }

  const machineCfg = vmConfig.machineConfig || vmConfig;
  const nics = machineCfg['network-interfaces'] ?? machineCfg.networkInterfaces;
  if (!Array.isArray(nics) || nics.length !== 0) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `MicroVM must have zero network interfaces (network-interfaces: []), got ${JSON.stringify(nics)}`,
      false,
      { reason: 'EGRESS_NIC_FORBIDDEN' },
    );
  }

  if (machineCfg.mmds_config !== null && machineCfg.mmds_config !== undefined) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Firecracker MMDS metadata service (169.254.169.254) must be explicitly disabled (mmds_config: null)',
      false,
      { reason: 'MMDS_METADATA_FORBIDDEN' },
    );
  }

  return true;
}

/**
 * Static & import allowlist scanner for custom scene source files before and during isolated build.
 * Verifies:
 *   1. No forbidden network/eval/Node/worker capabilities.
 *   2. Static ESM imports only reference relative bundle paths (`./...`, `../...` staying within root)
 *      or pre-installed allowlisted packages (`APPROVED_PREINSTALLED_SCENE_IMPORTS`).
 *   3. No `package.json` lifecycle install hooks (`preinstall`, `install`, `postinstall`).
 */
export function scanCustomSourceForForbiddenCapabilities(
  files,
  allowedPackageImports = APPROVED_PREINSTALLED_SCENE_IMPORTS,
) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Custom scene build requires at least one source file',
      false,
    );
  }

  const allowedSet = new Set(allowedPackageImports);
  const violations = [];

  for (const file of files) {
    const relPath = String(file.relativePath || '');
    const text = Buffer.isBuffer(file.content)
      ? file.content.toString('utf-8')
      : String(file.content || '');

    // Check package.json if present for lifecycle scripts or unapproved dependencies
    if (path.posix.basename(relPath) === 'package.json') {
      let parsedPkg;
      try {
        parsedPkg = JSON.parse(text);
      } catch {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Invalid JSON in custom bundle ${relPath}`,
          false,
        );
      }
      const scripts = parsedPkg.scripts || {};
      for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
        if (scripts[hook]) {
          violations.push({
            file: relPath,
            ruleId: 'FORBIDDEN_LIFECYCLE_SCRIPT',
            message: `Custom scene bundle forbids npm lifecycle script "${hook}"`,
          });
        }
      }
    }

    for (const rule of FORBIDDEN_SOURCE_CAPABILITY_RULES) {
      if (rule.pattern.test(text)) {
        violations.push({
          file: relPath,
          ruleId: rule.id,
          message: rule.message,
        });
      }
    }

    // Inspect all static ESM import / export-from specifiers
    const importRegex =
      /\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    let match;
    while ((match = importRegex.exec(text)) !== null) {
      const specifier = match[1].trim();
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const fileDir = path.posix.dirname(relPath === '' ? '.' : relPath);
        const normalized = path.posix.normalize(path.posix.join(fileDir, specifier));
        if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
          violations.push({
            file: relPath,
            ruleId: 'IMPORT_PATH_TRAVERSAL',
            message: `Relative import "${specifier}" escapes bundle root`,
          });
        }
      } else if (!allowedSet.has(specifier)) {
        violations.push({
          file: relPath,
          ruleId: 'UNAPPROVED_IMPORT_SPECIFIER',
          message: `Package import "${specifier}" is not in the pre-installed allowlist (${Array.from(allowedSet).join(', ')})`,
        });
      }
    }
  }

  if (violations.length > 0) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Custom scene source policy scan blocked ${violations.length} violation(s): ${violations[0].ruleId} in ${violations[0].file} (${violations[0].message})`,
      false,
      {
        reason: 'FORBIDDEN_CAPABILITY_DETECTED',
        violations,
      },
    );
  }

  return {
    passed: true,
    scannedFilesCount: files.length,
    violations: [],
  };
}

/**
 * Builds the strictly sanitized guest environment for a disposable build or render microVM.
 * Never inherits controller/host process.env; blocks any secret key or secret value pattern.
 */
export function buildMicroVmGuestEnv(options) {
  const {
    vmId,
    phase,
    jobId,
    attemptId,
    leaseEpoch = 1,
    loopbackAssetOrigin,
    extraEnv,
  } = options;

  if (!SAFE_ID_REGEX.test(vmId || '')) {
    throw new CustomRuntimeError('SANDBOX_SECURITY_VIOLATION', `Unsafe vmId "${vmId}"`, false);
  }
  if (phase !== 'build' && phase !== 'render') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid microVM phase "${phase}" (must be "build" or "render")`,
      false,
    );
  }
  if (!SAFE_ID_REGEX.test(jobId || '')) {
    throw new CustomRuntimeError('SANDBOX_SECURITY_VIOLATION', `Unsafe jobId "${jobId}"`, false);
  }
  if (!SAFE_ID_REGEX.test(attemptId || '')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Unsafe attemptId "${attemptId}"`,
      false,
    );
  }
  if (!Number.isInteger(leaseEpoch) || leaseEpoch < 1) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid leaseEpoch "${leaseEpoch}" (must be positive integer >= 1)`,
      false,
    );
  }

  const env = {
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: '/vm/tmp',
    TMPDIR: '/vm/tmp',
    CVE_VM_ID: vmId,
    CVE_VM_PHASE: phase,
    CVE_SANDBOX_JOB_ID: jobId,
    CVE_SANDBOX_ATTEMPT_ID: attemptId,
    CVE_SANDBOX_LEASE_EPOCH: String(leaseEpoch),
    CVE_SANDBOX_MODE: 'custom-microvm-v1',
  };

  if (loopbackAssetOrigin !== undefined) {
    if (phase === 'build') {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Build microVM forbids loopbackAssetOrigin (build phase is pure offline compilation)',
        false,
      );
    }
    let parsed;
    try {
      parsed = new URL(loopbackAssetOrigin);
    } catch {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Malformed loopbackAssetOrigin "${loopbackAssetOrigin}"`,
        false,
      );
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `loopbackAssetOrigin must bind strictly to http://127.0.0.1:<port>, got "${loopbackAssetOrigin}"`,
        false,
      );
    }
    env.CVE_LOOPBACK_ASSET_ORIGIN = loopbackAssetOrigin;
  }

  if (extraEnv && typeof extraEnv === 'object') {
    for (const [key, val] of Object.entries(extraEnv)) {
      if (FORBIDDEN_SECRET_KEY_PATTERNS.some((re) => re.test(key))) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Forbidden secret environment variable "${key}" cannot enter microVM`,
          false,
          { reason: 'SECRET_ENV_FORBIDDEN', key },
        );
      }
      if (!ALLOWED_MICROVM_GUEST_ENV_KEYS.has(key)) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Environment variable "${key}" is not in ALLOWED_MICROVM_GUEST_ENV_KEYS`,
          false,
          { reason: 'ENV_KEY_NOT_ALLOWLISTED', key },
        );
      }
      const strVal = String(val ?? '');
      if (redactSecretOutput(`${key}=${strVal}`) !== `${key}=${strVal}`) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Environment variable "${key}" value matched a forbidden credential pattern`,
          false,
          { reason: 'SECRET_VALUE_FORBIDDEN', key },
        );
      }
      env[key] = strVal;
    }
  }

  return Object.freeze(env);
}

/**
 * Redacts secrets and bounds microVM stdout/stderr logs to 64 KiB (`CUSTOM_BUNDLE_QUOTAS.maxStdioBytes`).
 */
export function sanitizeAndBoundMicroVmLog(rawText, canaries = []) {
  const rawBuf = Buffer.isBuffer(rawText)
    ? rawText
    : Buffer.from(String(rawText || ''), 'utf-8');
  const truncated = rawBuf.byteLength > CUSTOM_BUNDLE_QUOTAS.maxStdioBytes;
  const boundedStr = truncated
    ? rawBuf.subarray(0, CUSTOM_BUNDLE_QUOTAS.maxStdioBytes).toString('utf-8')
    : rawBuf.toString('utf-8');

  let redacted = redactSecretOutput(boundedStr);
  redacted = redacted.replace(
    /\b(whsec_[A-Za-z0-9_-]{12,}|cve_(?:live|test|secret)_[A-Za-z0-9_-]{12,128})\b/g,
    '[REDACTED_KEY]',
  );
  redacted = redacted.replace(
    /([?&](?:X-Amz-Signature|X-Amz-Credential|Signature|sig|token|access_token)=)[^&\s"']+/gi,
    '$1[REDACTED]',
  );

  for (const canary of canaries) {
    if (canary && typeof canary === 'string' && canary.length >= 6) {
      redacted = redacted.split(canary).join('[REDACTED_CANARY]');
    }
  }

  return {
    text: redacted,
    truncated,
    originalBytes: rawBuf.byteLength,
  };
}

/**
 * Validates that microVM drives/mounts never reference forbidden host paths or sockets.
 */
export function validateMicroVmHostPaths(hostPaths, allowedPrisonRoot) {
  const resolvedPrisonRoot = path.resolve(allowedPrisonRoot);

  for (const rawPath of hostPaths) {
    if (!rawPath || typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `MicroVM backing path must be an absolute path: "${rawPath}"`,
        false,
        { reason: 'HOST_FS_MOUNT_FORBIDDEN', path: rawPath },
      );
    }

    const normalized = path.posix.normalize(rawPath.replace(/\\/g, '/'));
    for (const pattern of FORBIDDEN_HOST_FS_PATTERNS) {
      if (pattern.test(normalized)) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Forbidden host filesystem or socket path blocked from microVM: "${rawPath}"`,
          false,
          { reason: 'HOST_FS_MOUNT_FORBIDDEN', path: rawPath },
        );
      }
    }

    const resolved = path.resolve(rawPath);
    if (
      resolved !== resolvedPrisonRoot &&
      !resolved.startsWith(resolvedPrisonRoot + path.sep)
    ) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `MicroVM drive path "${rawPath}" escaped disposable prison root "${resolvedPrisonRoot}"`,
        false,
        { reason: 'HOST_FS_ESCAPE_BLOCKED', path: rawPath },
      );
    }
  }

  return true;
}

/**
 * Ephemeral per-VM filesystem prison (`MicroVmWorkspacePrison`).
 * Isolates staged read-only inputs (`0o440` files / `0o550` dirs), bounded scratch/output,
 * blocks symlinks/hardlinks/special files/traversal, and wipes the entire directory tree on teardown.
 */
export class MicroVmWorkspacePrison {
  /**
   * @param {string} [baseDir]
   */
  constructor(baseDir = path.join(os.tmpdir(), 'cve-microvm-prisons')) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  createPrison(vmId, phase, jobId, attemptId) {
    for (const [label, id] of [
      ['vmId', vmId],
      ['jobId', jobId],
      ['attemptId', attemptId],
    ]) {
      if (!SAFE_ID_REGEX.test(id || '')) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Unsafe ${label} "${id}": microVM prison paths must use internal opaque IDs`,
          false,
        );
      }
    }
    if (phase !== 'build' && phase !== 'render') {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Invalid microVM phase "${phase}"`,
        false,
      );
    }

    const rootDir = path.resolve(
      this.baseDir,
      `vm-${vmId}-${phase}-${jobId}-${attemptId}`,
    );
    if (!rootDir.startsWith(this.baseDir + path.sep)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'MicroVM prison path escaped baseDir',
        false,
      );
    }
    if (fs.existsSync(rootDir)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Disposable microVM prison directory already exists for vmId "${vmId}" (reuse is forbidden)`,
        false,
        { reason: 'MICROVM_REUSE_FORBIDDEN', vmId },
      );
    }

    const rootfsImageFile = path.join(rootDir, 'rootfs.ext4.ro');
    const inputsDir = path.join(rootDir, 'inputs');
    const outputDir = path.join(rootDir, 'output');
    const tmpDir = path.join(rootDir, 'tmp');

    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(inputsDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o750 });
    fs.writeFileSync(rootfsImageFile, 'CVE_IMMUTABLE_MICROVM_ROOTFS_STUB\n', { mode: 0o400 });

    validateMicroVmHostPaths([rootfsImageFile, inputsDir, outputDir, tmpDir], rootDir);

    return {
      vmId,
      phase,
      jobId,
      attemptId,
      rootDir,
      rootfsImageFile,
      inputsDir,
      outputDir,
      tmpDir,
    };
  }

  resolveSafeRelativePath(baseDir, relativePath) {
    if (!relativePath || typeof relativePath !== 'string' || relativePath.includes('\0')) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Empty or null-byte path is forbidden in microVM workspace',
        false,
        { reason: 'PATH_TRAVERSAL_BLOCKED' },
      );
    }
    if (relativePath.includes('\\')) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Backslashes are forbidden in microVM relative path: "${relativePath}"`,
        false,
        { reason: 'PATH_TRAVERSAL_BLOCKED' },
      );
    }
    if (path.isAbsolute(relativePath) || relativePath.startsWith('/')) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Absolute path is forbidden in microVM workspace: "${relativePath}"`,
        false,
        { reason: 'PATH_TRAVERSAL_BLOCKED' },
      );
    }

    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Path traversal segment ("." or "..") is forbidden in microVM workspace: "${relativePath}"`,
        false,
        { reason: 'PATH_TRAVERSAL_BLOCKED' },
      );
    }
    if (segments.length > CUSTOM_BUNDLE_QUOTAS.maxNestingDepth) {
      throw new CustomRuntimeError(
        'SANDBOX_RESOURCE_LIMIT',
        `Path nesting depth ${segments.length} exceeds limit of ${CUSTOM_BUNDLE_QUOTAS.maxNestingDepth}: "${relativePath}"`,
        false,
        { reason: 'NESTING_DEPTH_EXCEEDED' },
      );
    }

    const resolvedBase = path.resolve(baseDir);
    const resolvedTarget = path.resolve(resolvedBase, ...segments);
    if (
      resolvedTarget !== resolvedBase &&
      !resolvedTarget.startsWith(resolvedBase + path.sep)
    ) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Path escaped microVM workspace root: "${relativePath}"`,
        false,
        { reason: 'PATH_TRAVERSAL_BLOCKED' },
      );
    }

    return resolvedTarget;
  }

  stageReadOnlyInputs(prison, files) {
    if (!Array.isArray(files) || files.length > CUSTOM_BUNDLE_QUOTAS.maxFiles) {
      throw new CustomRuntimeError(
        'SANDBOX_RESOURCE_LIMIT',
        `Input file count (${files?.length ?? 0}) exceeds bundle v1 limit of ${CUSTOM_BUNDLE_QUOTAS.maxFiles}`,
        false,
        { reason: 'MAX_FILES_EXCEEDED' },
      );
    }

    this._unlockPermissions(prison.inputsDir);

    let totalSourceBytes = 0;
    let totalAssetBytes = 0;
    const stagedFiles = new Map();

    for (const item of files) {
      const targetPath = this.resolveSafeRelativePath(prison.inputsDir, item.relativePath);
      const buf = Buffer.isBuffer(item.content)
        ? item.content
        : Buffer.from(String(item.content ?? ''), 'utf-8');

      const kind = item.kind ?? 'source';
      if (kind === 'source') {
        totalSourceBytes += buf.byteLength;
        if (totalSourceBytes > CUSTOM_BUNDLE_QUOTAS.maxSourceBytes) {
          throw new CustomRuntimeError(
            'SANDBOX_RESOURCE_LIMIT',
            `Total source bytes (${totalSourceBytes}) exceeds 5 MiB limit (${CUSTOM_BUNDLE_QUOTAS.maxSourceBytes})`,
            false,
            { reason: 'MAX_SOURCE_BYTES_EXCEEDED' },
          );
        }
      } else {
        totalAssetBytes += buf.byteLength;
        if (totalAssetBytes > CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes) {
          throw new CustomRuntimeError(
            'SANDBOX_RESOURCE_LIMIT',
            `Total built/asset bytes (${totalAssetBytes}) exceeds 20 MiB limit (${CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes})`,
            false,
            { reason: 'MAX_ASSET_BYTES_EXCEEDED' },
          );
        }
      }

      const actualSha256 = computeSha256Hex(buf);
      if (item.expectedSha256 && item.expectedSha256.toLowerCase() !== actualSha256) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `SHA-256 mismatch for staged microVM input "${item.relativePath}": expected ${item.expectedSha256}, got ${actualSha256}`,
          false,
          { reason: 'INPUT_HASH_MISMATCH', file: item.relativePath },
        );
      }

      // Walk intermediate directories to ensure no symlink traversal exists
      const parentDir = path.dirname(targetPath);
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o750 });

      if (fs.existsSync(targetPath)) {
        const existingStat = fs.lstatSync(targetPath);
        if (existingStat.isSymbolicLink()) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Refusing to overwrite symlink at "${item.relativePath}"`,
            false,
            { reason: 'SYMLINK_FORBIDDEN' },
          );
        }
        fs.chmodSync(targetPath, 0o600);
      }

      fs.writeFileSync(targetPath, buf, { mode: 0o440, flag: 'w' });
      fs.chmodSync(targetPath, 0o440);

      const st = fs.lstatSync(targetPath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Staged input "${item.relativePath}" must be a regular single-link file (nlink=${st.nlink})`,
          false,
          { reason: 'HARDLINK_OR_SPECIAL_FILE_FORBIDDEN' },
        );
      }

      stagedFiles.set(item.relativePath, {
        relativePath: item.relativePath,
        filePath: targetPath,
        sha256: actualSha256,
        bytes: buf.byteLength,
        kind,
      });
    }

    this._lockReadOnlyRecursive(prison.inputsDir);
    return stagedFiles;
  }

  enforceScratchAndOutputQuota(prison, maxBytes) {
    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      let total = 0;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Symlink forbidden inside microVM workspace: "${full}"`,
            false,
            { reason: 'SYMLINK_FORBIDDEN' },
          );
        }
        if (st.isDirectory()) {
          total += scanDir(full);
        } else if (st.isFile()) {
          if (st.nlink > 1) {
            throw new CustomRuntimeError(
              'SANDBOX_SECURITY_VIOLATION',
              `Hardlink (nlink=${st.nlink}) forbidden inside microVM workspace: "${full}"`,
              false,
              { reason: 'HARDLINK_FORBIDDEN' },
            );
          }
          total += st.size;
        } else {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Special device/FIFO/socket file forbidden inside microVM workspace: "${full}"`,
            false,
            { reason: 'SPECIAL_FILE_FORBIDDEN' },
          );
        }
        if (total > maxBytes) {
          throw new CustomRuntimeError(
            'SANDBOX_RESOURCE_LIMIT',
            `MicroVM scratch/output disk usage (${total} bytes) exceeded quota (${maxBytes} bytes)`,
            false,
            { reason: 'DISK_QUOTA_EXCEEDED', usedBytes: total, maxBytes },
          );
        }
      }
      return total;
    };

    const usedBytes = scanDir(prison.outputDir) + scanDir(prison.tmpDir);
    if (usedBytes > maxBytes) {
      throw new CustomRuntimeError(
        'SANDBOX_RESOURCE_LIMIT',
        `MicroVM scratch/output disk usage (${usedBytes} bytes) exceeded quota (${maxBytes} bytes)`,
        false,
        { reason: 'DISK_QUOTA_EXCEEDED', usedBytes, maxBytes },
      );
    }
    return usedBytes;
  }

  destroyPrison(prison) {
    if (!prison || !prison.rootDir) return;
    const resolved = path.resolve(prison.rootDir);
    if (!resolved.startsWith(this.baseDir + path.sep)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Refusing to destroy path outside MicroVmWorkspacePrison baseDir',
        false,
      );
    }
    if (fs.existsSync(resolved)) {
      this._unlockPermissions(resolved);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  _lockReadOnlyRecursive(dirPath) {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Symlink detected in staged inputs: "${full}"`,
          false,
          { reason: 'SYMLINK_FORBIDDEN' },
        );
      }
      if (st.isDirectory()) {
        this._lockReadOnlyRecursive(full);
        fs.chmodSync(full, 0o550);
      } else if (st.isFile()) {
        if (st.nlink > 1) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Hardlink (nlink=${st.nlink}) detected in staged inputs: "${full}"`,
            false,
            { reason: 'HARDLINK_FORBIDDEN' },
          );
        }
        fs.chmodSync(full, 0o440);
      } else {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Special file forbidden in staged inputs: "${full}"`,
          false,
          { reason: 'SPECIAL_FILE_FORBIDDEN' },
        );
      }
    }
    fs.chmodSync(dirPath, 0o550);
  }

  _unlockPermissions(targetPath) {
    if (!fs.existsSync(targetPath)) return;
    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(targetPath, 0o700);
      for (const name of fs.readdirSync(targetPath)) {
        this._unlockPermissions(path.join(targetPath, name));
      }
    } else if (st.isFile()) {
      fs.chmodSync(targetPath, 0o600);
    }
  }
}
