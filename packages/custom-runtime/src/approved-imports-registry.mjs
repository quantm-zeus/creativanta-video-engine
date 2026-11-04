// @ts-check
/**
 * Approved Pre-installed Scene Import Registry & Module Dependency Verifier (Task P7-04).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (lines 15, 47-51: "Generated source -> build: Hard isolation, allowlisted
 *     preinstalled deps, no install lifecycle scripts/network. ... Không npm install từ model output;
 *     imports chỉ package/version registry đã review, khóa dynamic import/network. Browser code
 *     không có Node bridge.")
 *   - docs/IMPLEMENTATION_PLAN.md (line 116: "P7-04 / C+B | Isolated build with approved imports,
 *     static scan + preview + malicious payload suite, no trusted API execution; source injection
 *     không đọc canary secrets")
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { CustomRuntimeError } from './adr-policy.mjs';
import { APPROVED_PREINSTALLED_SCENE_IMPORTS } from './isolation-guards.mjs';

/**
 * Offline reviewed ESM source for `@creativanta/scene-math` v1.0.0.
 */
const SCENE_MATH_SOURCE = `/**
 * @creativanta/scene-math v1.0.0 — Pre-installed Offline Math Utilities
 * Pure deterministic numeric and vector helpers (zero network, zero eval, zero host access).
 */
export const SCENE_MATH_VERSION = '1.0.0';

export function clamp(value, min, max) {
  const n = Number(value);
  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(n) || !Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

export function lerp(start, end, t) {
  const a = Number(start) || 0;
  const b = Number(end) || 0;
  const alpha = clamp(t, 0, 1);
  return a + (b - a) * alpha;
}

export function inverseLerp(start, end, value) {
  const a = Number(start) || 0;
  const b = Number(end) || 0;
  if (Math.abs(b - a) < 1e-9) return 0;
  return clamp((Number(value) - a) / (b - a), 0, 1);
}

export function remap(inMin, inMax, outMin, outMax, value) {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, value));
}

export function smoothstep(edge0, edge1, x) {
  const t = inverseLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
}

export function degToRad(degrees) {
  return ((Number(degrees) || 0) * Math.PI) / 180;
}

export function radToDeg(radians) {
  return ((Number(radians) || 0) * 180) / Math.PI;
}

export function vec2(x = 0, y = 0) {
  return Object.freeze({ x: Number(x) || 0, y: Number(y) || 0 });
}

export function mat2d(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
  return Object.freeze([
    Number(a) || 0,
    Number(b) || 0,
    Number(c) || 0,
    Number(d) || 0,
    Number(tx) || 0,
    Number(ty) || 0,
  ]);
}
`;

/**
 * Offline reviewed ESM source for `@creativanta/scene-easing` v1.0.0.
 */
const SCENE_EASING_SOURCE = `/**
 * @creativanta/scene-easing v1.0.0 — Pre-installed Offline Easing Functions
 * Deterministic keyframe interpolation curves matching Scene Spec 1.0.
 */
export const SCENE_EASING_VERSION = '1.0.0';

function clampUnit(t) {
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function linear(t) {
  return clampUnit(t);
}

export function easeInQuad(t) {
  const x = clampUnit(t);
  return x * x;
}

export function easeOutQuad(t) {
  const x = clampUnit(t);
  return 1 - (1 - x) * (1 - x);
}

export function easeInOutQuad(t) {
  const x = clampUnit(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

export function easeInCubic(t) {
  const x = clampUnit(t);
  return x * x * x;
}

export function easeOutCubic(t) {
  const x = clampUnit(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeInOutCubic(t) {
  const x = clampUnit(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function spring(t, damping = 0.75, frequency = 6) {
  const x = clampUnit(t);
  if (x === 0 || x === 1) return x;
  const d = Math.max(0.1, Math.min(2, Number(damping) || 0.75));
  const f = Math.max(1, Math.min(20, Number(frequency) || 6));
  return 1 - Math.exp(-d * f * x) * Math.cos(f * x * Math.PI);
}
`;

/**
 * Offline reviewed ESM source for `@creativanta/scene-runtime` v1.0.0.
 */
const SCENE_RUNTIME_SOURCE = `/**
 * @creativanta/scene-runtime v1.0.0 — Pre-installed Deterministic Scene Runtime
 * Provides seeded PRNG, rational frame timing, and internal loopback asset resolution.
 */
export const SCENE_RUNTIME_VERSION = '1.0.0';

export function createSeededRandom(seed = 42) {
  let state = (Number(seed) >>> 0) || 0x12345678;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatRationalTime(frameIndex, fpsNum = 30, fpsDen = 1) {
  const f = Math.max(0, Math.floor(Number(frameIndex) || 0));
  const num = Math.max(1, Math.floor(Number(fpsNum) || 30));
  const den = Math.max(1, Math.floor(Number(fpsDen) || 1));
  const seconds = (f * den) / num;
  return Object.freeze({
    frame: f,
    fpsNum: num,
    fpsDen: den,
    seconds: Number(seconds.toFixed(6)),
    timestampMs: Math.round((f * den * 1000) / num),
  });
}

export function resolveStagedAssetUrl(assetId, loopbackOrigin = 'http://127.0.0.1:0') {
  const safeId = String(assetId || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeId) {
    throw new Error('Invalid staged asset identifier');
  }
  const base = String(loopbackOrigin || 'http://127.0.0.1:0').replace(/\\/+$/, '');
  return base + '/assets/' + safeId;
}

export function createSceneContext(options = {}) {
  const width = Math.max(2, Math.floor(Number(options.width) || 1280));
  const height = Math.max(2, Math.floor(Number(options.height) || 720));
  const fps = Math.max(1, Math.floor(Number(options.fps) || 30));
  const durationFrames = Math.max(1, Math.floor(Number(options.durationFrames) || 150));
  const frameIndex = Math.max(0, Math.min(durationFrames - 1, Math.floor(Number(options.frameIndex) || 0)));
  const seed = (Number(options.seed) >>> 0) || 42;
  const progress = durationFrames > 1 ? frameIndex / (durationFrames - 1) : 0;

  return Object.freeze({
    width,
    height,
    fps,
    durationFrames,
    frameIndex,
    progress,
    seed,
    random: createSeededRandom(seed + frameIndex),
    timing: formatRationalTime(frameIndex, fps, 1),
  });
}
`;

/**
 * @param {string} text
 */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Immutable registry of source-reviewed, pre-installed packages allowed in custom scene builds.
 */
export const APPROVED_IMPORT_PACKAGES_REGISTRY = Object.freeze({
  '@creativanta/scene-runtime': Object.freeze({
    packageName: '@creativanta/scene-runtime',
    version: '1.0.0',
    license: 'Proprietary-Creativanta-Reviewed',
    reviewedInTask: 'P7-04',
    virtualPath: '__preinstalled_modules/@creativanta/scene-runtime/index.mjs',
    exports: Object.freeze([
      'SCENE_RUNTIME_VERSION',
      'createSeededRandom',
      'formatRationalTime',
      'resolveStagedAssetUrl',
      'createSceneContext',
    ]),
    sourceCode: SCENE_RUNTIME_SOURCE,
    sha256: sha256Hex(SCENE_RUNTIME_SOURCE),
  }),
  '@creativanta/scene-math': Object.freeze({
    packageName: '@creativanta/scene-math',
    version: '1.0.0',
    license: 'Proprietary-Creativanta-Reviewed',
    reviewedInTask: 'P7-04',
    virtualPath: '__preinstalled_modules/@creativanta/scene-math/index.mjs',
    exports: Object.freeze([
      'SCENE_MATH_VERSION',
      'clamp',
      'lerp',
      'inverseLerp',
      'remap',
      'smoothstep',
      'degToRad',
      'radToDeg',
      'vec2',
      'mat2d',
    ]),
    sourceCode: SCENE_MATH_SOURCE,
    sha256: sha256Hex(SCENE_MATH_SOURCE),
  }),
  '@creativanta/scene-easing': Object.freeze({
    packageName: '@creativanta/scene-easing',
    version: '1.0.0',
    license: 'Proprietary-Creativanta-Reviewed',
    reviewedInTask: 'P7-04',
    virtualPath: '__preinstalled_modules/@creativanta/scene-easing/index.mjs',
    exports: Object.freeze([
      'SCENE_EASING_VERSION',
      'linear',
      'easeInQuad',
      'easeOutQuad',
      'easeInOutQuad',
      'easeInCubic',
      'easeOutCubic',
      'easeInOutCubic',
      'spring',
    ]),
    sourceCode: SCENE_EASING_SOURCE,
    sha256: sha256Hex(SCENE_EASING_SOURCE),
  }),
});

/**
 * Retrieve a reviewed pre-installed package definition by package specifier.
 * @param {string} packageName
 */
export function getApprovedImportPackage(packageName) {
  if (!packageName || typeof packageName !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(APPROVED_IMPORT_PACKAGES_REGISTRY, packageName)) {
    return null;
  }
  return APPROVED_IMPORT_PACKAGES_REGISTRY[
    /** @type {keyof typeof APPROVED_IMPORT_PACKAGES_REGISTRY} */ (packageName)
  ];
}

/**
 * List all approved pre-installed scene import packages and their pinned metadata.
 */
export function listApprovedImportPackages() {
  return Object.values(APPROVED_IMPORT_PACKAGES_REGISTRY).map((pkg) => ({
    packageName: pkg.packageName,
    version: pkg.version,
    license: pkg.license,
    reviewedInTask: pkg.reviewedInTask,
    virtualPath: pkg.virtualPath,
    exports: [...pkg.exports],
    sha256: pkg.sha256,
  }));
}

/**
 * Verifies cryptographic SHA-256 integrity of all pre-installed import packages
 * and ensures alignment with `APPROVED_PREINSTALLED_SCENE_IMPORTS`.
 */
export function verifyApprovedImportsRegistryIntegrity() {
  const registeredNames = Object.keys(APPROVED_IMPORT_PACKAGES_REGISTRY);
  for (const expectedName of APPROVED_PREINSTALLED_SCENE_IMPORTS) {
    if (!registeredNames.includes(expectedName)) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Approved preinstalled package "${expectedName}" is missing from APPROVED_IMPORT_PACKAGES_REGISTRY`,
        false,
        { reason: 'PREINSTALLED_REGISTRY_MISMATCH', packageName: expectedName },
      );
    }
  }

  for (const pkg of Object.values(APPROVED_IMPORT_PACKAGES_REGISTRY)) {
    const actualHash = sha256Hex(pkg.sourceCode);
    if (actualHash !== pkg.sha256) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Integrity hash mismatch for preinstalled package "${pkg.packageName}"`,
        false,
        { reason: 'PREINSTALLED_PACKAGE_DIGEST_MISMATCH', packageName: pkg.packageName },
      );
    }
  }

  return {
    verified: true,
    packageCount: registeredNames.length,
    packages: listApprovedImportPackages(),
  };
}

/**
 * Parses static ESM `import` and `export ... from` statements from a JavaScript/MJS source string.
 * @param {string} sourceText
 */
export function parseStaticModuleImports(sourceText) {
  const text = String(sourceText || '');
  /**
   * @type {Array<{
   *   statement: string;
   *   specifier: string;
   *   namedImports: string[];
   *   defaultImport: string | null;
   *   namespaceImport: string | null;
   * }>}
   */
  const parsed = [];

  // Match `import <clause> from "<specifier>"` or `import "<specifier>"` or `export <clause> from "<specifier>"`
  const staticImportRegex =
    /\b(?:import|export)\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["']/g;

  let match;
  while ((match = staticImportRegex.exec(text)) !== null) {
    const rawClause = (match[1] || '').trim();
    const specifier = (match[2] || '').trim();
    /** @type {string[]} */
    const namedImports = [];
    /** @type {string | null} */
    let defaultImport = null;
    /** @type {string | null} */
    let namespaceImport = null;

    if (rawClause) {
      const nsMatch = rawClause.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (nsMatch && nsMatch[1]) {
        namespaceImport = nsMatch[1];
      }

      const namedMatch = rawClause.match(/\{([^}]*)\}/);
      if (namedMatch) {
        const inner = namedMatch[1] || '';
        for (const part of inner.split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const asParts = trimmed.split(/\s+as\s+/);
          const importedSymbol = (asParts[0] || '').trim();
          if (importedSymbol) {
            namedImports.push(importedSymbol);
          }
        }
      }

      const withoutBraces = rawClause
        .replace(/\{[^}]*\}/g, '')
        .replace(/\*\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*/g, '')
        .replace(/,/g, '')
        .trim();
      if (withoutBraces && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(withoutBraces)) {
        defaultImport = withoutBraces;
      }
    }

    parsed.push({
      statement: match[0],
      specifier,
      namedImports,
      defaultImport,
      namespaceImport,
    });
  }

  return parsed;
}

/**
 * Resolves and validates all module imports across a set of bundle files:
 *   - Verifies package imports belong strictly to `allowedPackageImports` and exported symbols exist.
 *   - Verifies relative imports (`./...`, `../...`) stay within bundle root, resolve to an actual staged file,
 *     and contain no circular dependency chains.
 *
 * @param {readonly { path?: string; relativePath?: string; content: Buffer | string }[]} files
 * @param {readonly string[]} [allowedPackageImports]
 */
export function validateSceneModuleImports(
  files,
  allowedPackageImports = APPROVED_PREINSTALLED_SCENE_IMPORTS,
) {
  const allowedSet = new Set(allowedPackageImports);
  const fileMap = new Map();

  for (const f of files) {
    const rawRel = String(f.relativePath ?? f.path ?? '').trim();
    const normRel = rawRel.replace(/^(\.\/)+/, '');
    const contentStr = Buffer.isBuffer(f.content)
      ? f.content.toString('utf-8')
      : String(f.content ?? '');
    fileMap.set(normRel, contentStr);
  }

  /** @type {Array<{ file: string; ruleId: string; message: string; specifier?: string }>} */
  const violations = [];
  /**
   * @type {Array<{
   *   fromFile: string;
   *   specifier: string;
   *   kind: 'preinstalled-package' | 'relative-module';
   *   resolvedTarget: string;
   *   version?: string;
   *   sha256?: string;
   *   importedSymbols: string[];
   * }>}
   */
  const resolvedImports = [];

  /** @type {Map<string, string[]>} */
  const relativeEdges = new Map();

  for (const [filePath, contentStr] of fileMap.entries()) {
    const ext = path.posix.extname(filePath).toLowerCase();
    const isJsModule = ext === '.js' || ext === '.mjs' || ext === '.ts';
    const isHtml = ext === '.html' || ext === '.htm';

    if (!isJsModule && !isHtml) continue;

    // For HTML files, also inspect `<script type="module" src="...">` and inline module blocks
    let jsTextsToInspect = [];
    if (isJsModule) {
      jsTextsToInspect.push(contentStr);
    } else if (isHtml) {
      const scriptTagRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
      let sMatch;
      while ((sMatch = scriptTagRegex.exec(contentStr)) !== null) {
        const attrs = sMatch[1] || '';
        const body = sMatch[2] || '';
        const srcAttrMatch = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
        if (srcAttrMatch && srcAttrMatch[1]) {
          const scriptSrc = srcAttrMatch[1].trim();
          if (/^(?:https?:|wss?:|ftp:|file:|data:|\/\/)/i.test(scriptSrc)) {
            violations.push({
              file: filePath,
              ruleId: 'REMOTE_URL_LITERAL',
              specifier: scriptSrc,
              message: `HTML <script src="${scriptSrc}"> forbids external or data URLs`,
            });
          } else {
            const normScript = path.posix.normalize(
              path.posix.join(path.posix.dirname(filePath || '.'), scriptSrc),
            );
            if (normScript.startsWith('..') || path.posix.isAbsolute(normScript)) {
              violations.push({
                file: filePath,
                ruleId: 'IMPORT_PATH_TRAVERSAL',
                specifier: scriptSrc,
                message: `HTML <script src="${scriptSrc}"> escapes bundle root`,
              });
            }
          }
        }
        if (body.trim()) {
          jsTextsToInspect.push(body);
        }
      }
    }

    for (const jsText of jsTextsToInspect) {
      const imports = parseStaticModuleImports(jsText);
      for (const imp of imports) {
        const { specifier, namedImports } = imp;

        if (
          /^(?:https?:|wss?:|ftp:|file:|data:|blob:|node:|deno:|bun:|\/\/)/i.test(specifier)
        ) {
          violations.push({
            file: filePath,
            ruleId: 'UNAPPROVED_IMPORT_SPECIFIER',
            specifier,
            message: `Protocol/URL import "${specifier}" is strictly forbidden in custom scene code`,
          });
          continue;
        }

        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          if (specifier.includes('\\') || specifier.includes('\0')) {
            violations.push({
              file: filePath,
              ruleId: 'IMPORT_PATH_TRAVERSAL',
              specifier,
              message: `Relative import "${specifier}" contains forbidden backslash or null byte`,
            });
            continue;
          }

          const dir = path.posix.dirname(filePath === '' ? '.' : filePath);
          const joined = path.posix.normalize(path.posix.join(dir, specifier));
          if (joined.startsWith('..') || path.posix.isAbsolute(joined)) {
            violations.push({
              file: filePath,
              ruleId: 'IMPORT_PATH_TRAVERSAL',
              specifier,
              message: `Relative import "${specifier}" in "${filePath}" escapes bundle root`,
            });
            continue;
          }

          // Resolve exact file or `.mjs`/`.js` extension
          const candidates = [joined, `${joined}.mjs`, `${joined}.js`];
          const foundCandidate = candidates.find((c) => fileMap.has(c));
          if (!foundCandidate) {
            violations.push({
              file: filePath,
              ruleId: 'MISSING_RELATIVE_IMPORT_TARGET',
              specifier,
              message: `Relative import "${specifier}" in "${filePath}" does not match any staged bundle file`,
            });
            continue;
          }

          const edges = relativeEdges.get(filePath) || [];
          edges.push(foundCandidate);
          relativeEdges.set(filePath, edges);

          resolvedImports.push({
            fromFile: filePath,
            specifier,
            kind: 'relative-module',
            resolvedTarget: foundCandidate,
            importedSymbols: namedImports,
          });
        } else {
          // Package import
          if (!allowedSet.has(specifier)) {
            violations.push({
              file: filePath,
              ruleId: 'UNAPPROVED_IMPORT_SPECIFIER',
              specifier,
              message: `Package import "${specifier}" is not in the approved pre-installed allowlist (${Array.from(allowedSet).join(', ')})`,
            });
            continue;
          }

          const pkgDef = getApprovedImportPackage(specifier);
          if (pkgDef) {
            for (const sym of namedImports) {
              if (!pkgDef.exports.includes(sym)) {
                violations.push({
                  file: filePath,
                  ruleId: 'UNEXPORTED_PACKAGE_SYMBOL',
                  specifier,
                  message: `Symbol "${sym}" is not exported by approved package "${specifier}@${pkgDef.version}" (available: ${pkgDef.exports.join(', ')})`,
                });
              }
            }

            resolvedImports.push({
              fromFile: filePath,
              specifier,
              kind: 'preinstalled-package',
              resolvedTarget: pkgDef.virtualPath,
              version: pkgDef.version,
              sha256: pkgDef.sha256,
              importedSymbols: namedImports,
            });
          } else {
            resolvedImports.push({
              fromFile: filePath,
              specifier,
              kind: 'preinstalled-package',
              resolvedTarget: `__preinstalled_modules/${specifier}/index.mjs`,
              importedSymbols: namedImports,
            });
          }
        }
      }
    }
  }

  // Detect circular relative imports via DFS
  const visited = new Set();
  const activeStack = new Set();

  /** @param {string} node */
  const detectCycle = (node) => {
    if (activeStack.has(node)) {
      violations.push({
        file: node,
        ruleId: 'CIRCULAR_IMPORT_DETECTED',
        message: `Circular module import cycle detected involving "${node}"`,
      });
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    activeStack.add(node);
    for (const neighbor of relativeEdges.get(node) || []) {
      detectCycle(neighbor);
    }
    activeStack.delete(node);
  };

  for (const fileKey of relativeEdges.keys()) {
    detectCycle(fileKey);
  }

  return {
    valid: violations.length === 0,
    resolvedImports,
    violations,
  };
}
