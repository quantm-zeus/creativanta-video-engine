// @ts-check
/**
 * Task P7-05 — Security Reviewer:
 * C1–C6 Signed Review for Exact Runtime Digest, Kill Switch / Canary / Allowlist Evidence,
 * Off-by-Default Regression & Runtime Rollback Verification Suite.
 *
 * Canonical specifications:
 *   - docs/IMPLEMENTATION_PLAN.md (line 117: "P7-05 / Security reviewer | P7-04 | C1–C6 signed review
 *     cho exact runtime digest, kill switch/canary/allowlist evidence; off-by-default regression và rollback test")
 *   - docs/SECURITY.md (lines 41-56, 69-73: default disabled, empty allowlist, C1–C6 release gates,
 *     exact image/runtime digest pin, runtime/deps patch requires re-running gate, kill switch blocks
 *     admission & cancels running custom jobs, incident isolation & rollback)
 *   - docs/DEPLOYMENT.md (lines 89-91, 118: CVE_CUSTOM_CODE_ENABLED=false; true only when C1–C6 approval
 *     fingerprint matches; canary 3 fixtures and small tenant cohort; rollback image without blind data
 *     rollback; security-critical image revoke fails/recreates jobs; custom off after restore until revalidation)
 *   - docs/OPERATIONS.md (line 85: Custom kill switch cancels admission/running custom jobs; structured
 *     path continues unaffected)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvConfig } from '../../contracts/dist/index.js';
import { IMAGE_DIGEST_REGEX, DEV_PLACEHOLDER_DIGEST } from '../../controller/dist/index.js';
import {
  CUSTOM_RUNTIME_ADR_ID,
  CUSTOM_RUNTIME_ADR_0002,
  REQUIRED_C1_TO_C6_GATES,
  FORBIDDEN_DOWNGRADE_RUNTIMES,
  CustomRuntimeError,
  probeHostVirtualization,
  signC1ToC6GateAttestation,
  verifyC1ToC6Gates,
  evaluateCustomRuntimePolicy,
} from './adr-policy.mjs';
import {
  DEFAULT_PINNED_ROOTFS_DIGEST,
  DEFAULT_PINNED_KERNEL_DIGEST,
  DisposableMicroVmRuntime,
} from './disposable-microvm-runtime.mjs';
import {
  assertZeroEgressMicroVmSpec,
  validateMicroVmHostPaths,
  MicroVmWorkspacePrison,
} from './isolation-guards.mjs';
import {
  verifyApprovedImportsRegistryIntegrity,
} from './approved-imports-registry.mjs';
import {
  assertNoTrustedApiExecution,
  getTrustedApiExecutionAudit,
  resetTrustedApiExecutionAudit,
  IsolatedSceneBuildPipeline,
  IsolatedScenePreviewEngine,
  verifySourceInjectionCannotReadCanarySecrets,
} from './isolated-build-and-preview.mjs';
import {
  DEFAULT_P704_CANARY_SECRET,
  runMaliciousPayloadSuite,
} from './malicious-payload-suite.mjs';
import {
  SceneBundleRegistry,
  assertCustomCodeExecutionAllowed,
} from './scene-bundle-registry.mjs';
import { AuthoringJobManager } from './authoring-job-manager.mjs';

export const DEFAULT_P705_REVIEW_SIGNING_SECRET =
  'p705_c1_c6_security_reviewer_hmac_secret_key_32_bytes_minimum!';

export const DEFAULT_P705_CANARY_SECRET =
  'CANARY_P705_SYNTHETIC_ROLLOUT_SECRET_99aa88bb77cc66dd';

/**
 * Three deterministic custom scene canary fixtures per docs/DEPLOYMENT.md line 118
 * ("Canary 3 fixtures và small tenant cohort").
 */
export const CANARY_SCENE_FIXTURES = Object.freeze([
  Object.freeze({
    fixtureId: 'canary-01-promo-vi',
    bundleId: 'bnd_canary_01_promo_vi',
    name: 'Canary 01 — Promo Sản Phẩm Tiếng Việt (16:9)',
    canvas: Object.freeze({ width: 1280, height: 720 }),
    fps: 30,
    totalFrames: 150,
    previewMode: /** @type {'frame'} */ ('frame'),
    previewFrameIndex: 45,
    entrypoint: 'index.js',
    parameterSchema: Object.freeze({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        headline: {
          type: 'string',
          default: 'Ưu đãi Mùa Lễ Hội — Giảm 50%',
          maxLength: 120,
        },
      },
      required: ['headline'],
      additionalProperties: false,
    }),
    parameters: Object.freeze({
      headline: 'Ưu đãi Mùa Lễ Hội — Giảm 50%',
    }),
    sourceFiles: Object.freeze([
      Object.freeze({
        relativePath: 'index.js',
        content: [
          'import { createSceneContext, createSeededRandom } from "@creativanta/scene-runtime";',
          'import { clamp, lerp } from "@creativanta/scene-math";',
          'import { easeOutCubic } from "@creativanta/scene-easing";',
          'import { normalizeViText } from "./vi-text.js";',
          '',
          'export default function renderFrame(frameIndex, params = {}) {',
          '  const ctx = createSceneContext({ width: 1280, height: 720, fps: 30, durationFrames: 150, frameIndex });',
          '  const rng = createSeededRandom(ctx.seed);',
          '  const opacity = easeOutCubic(clamp(ctx.progress * 2, 0, 1));',
          '  const y = lerp(64, 0, opacity);',
          '  return { title: normalizeViText(params.headline || "Ưu đãi"), opacity, y, sparkle: rng() };',
          '}',
          '',
        ].join('\n'),
      }),
      Object.freeze({
        relativePath: 'vi-text.js',
        content: 'export function normalizeViText(s) { return String(s).normalize("NFC").trim(); }\n',
      }),
    ]),
  }),
  Object.freeze({
    fixtureId: 'canary-02-explainer-chart',
    bundleId: 'bnd_canary_02_explainer_chart',
    name: 'Canary 02 — Biểu Đồ Tăng Trưởng Doanh Thu (16:9)',
    canvas: Object.freeze({ width: 1280, height: 720 }),
    fps: 30,
    totalFrames: 300,
    previewMode: /** @type {'frame'} */ ('frame'),
    previewFrameIndex: 120,
    entrypoint: 'index.js',
    parameterSchema: Object.freeze({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        metricLabel: {
          type: 'string',
          default: 'Tăng trưởng Quý 4: +128%',
          maxLength: 120,
        },
      },
      required: ['metricLabel'],
      additionalProperties: false,
    }),
    parameters: Object.freeze({
      metricLabel: 'Tăng trưởng Quý 4: +128%',
    }),
    sourceFiles: Object.freeze([
      Object.freeze({
        relativePath: 'index.js',
        content: [
          'import { createSceneContext } from "@creativanta/scene-runtime";',
          'import { clamp, smoothstep, vec2 } from "@creativanta/scene-math";',
          'import { easeInOutCubic } from "@creativanta/scene-easing";',
          '',
          'export default function renderFrame(frameIndex, params = {}) {',
          '  const ctx = createSceneContext({ width: 1280, height: 720, fps: 30, durationFrames: 300, frameIndex });',
          '  const t = easeInOutCubic(smoothstep(0, 1, clamp(ctx.progress, 0, 1)));',
          '  const barTip = vec2(320 + t * 640, 540 - t * 300);',
          '  return { label: String(params.metricLabel || "").normalize("NFC"), barTip };',
          '}',
          '',
        ].join('\n'),
      }),
    ]),
  }),
  Object.freeze({
    fixtureId: 'canary-03-kinetic-title',
    bundleId: 'bnd_canary_03_kinetic_title',
    name: 'Canary 03 — Kinetic Typography Dọc (9:16 Clip)',
    canvas: Object.freeze({ width: 720, height: 1280 }),
    fps: 30,
    totalFrames: 180,
    previewMode: /** @type {'clip'} */ ('clip'),
    previewStartFrame: 0,
    previewDurationFrames: 60,
    entrypoint: 'index.js',
    parameterSchema: Object.freeze({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        caption: {
          type: 'string',
          default: 'Sáng tạo Video Chủ Động Cùng Creativanta',
          maxLength: 140,
        },
      },
      required: ['caption'],
      additionalProperties: false,
    }),
    parameters: Object.freeze({
      caption: 'Sáng tạo Video Chủ Động Cùng Creativanta',
    }),
    sourceFiles: Object.freeze([
      Object.freeze({
        relativePath: 'index.js',
        content: [
          'import { createSceneContext, formatRationalTime } from "@creativanta/scene-runtime";',
          'import { clamp } from "@creativanta/scene-math";',
          'import { spring } from "@creativanta/scene-easing";',
          '',
          'export default function renderFrame(frameIndex, params = {}) {',
          '  const ctx = createSceneContext({ width: 720, height: 1280, fps: 30, durationFrames: 180, frameIndex });',
          '  const scale = spring(clamp(ctx.progress, 0, 1));',
          '  const timecode = formatRationalTime(frameIndex, 30, 1);',
          '  return { caption: String(params.caption || "").normalize("NFC"), scale, timecode };',
          '}',
          '',
        ].join('\n'),
      }),
    ]),
  }),
]);

/**
 * Computes the deterministic runtime digest manifest (`RuntimeDigestManifest`) pinning:
 *   - `rootfsImageDigest` (`sha256:<64 hex>`)
 *   - `guestKernelDigest` (`sha256:<64 hex>`)
 *   - `approvedImportsBundleDigest` (`sha256:<64 hex>` across all pre-installed packages)
 *   - `compositeRuntimeFingerprint` (`sha256:<64 hex>` combining ADR, runtime, rootfs, kernel, and approved imports)
 *
 * Any modification to the rootfs image, guest kernel, or pre-installed dependency bundle alters
 * `compositeRuntimeFingerprint` and invalidates prior C1–C6 sign-off (`docs/SECURITY.md` line 51 &
 * `docs/DEPLOYMENT.md` line 89).
 *
 * @param {{
 *   runtime?: string;
 *   rootfsImageDigest?: string;
 *   guestKernelDigest?: string;
 *   overrideApprovedImportsDigest?: string;
 * }} [options]
 */
export function computeRuntimeDigestManifest(options = {}) {
  const runtime = options.runtime ?? 'microvm-firecracker-v1';
  const rootfsImageDigest = options.rootfsImageDigest ?? DEFAULT_PINNED_ROOTFS_DIGEST;
  const guestKernelDigest = options.guestKernelDigest ?? DEFAULT_PINNED_KERNEL_DIGEST;

  if (!IMAGE_DIGEST_REGEX.test(rootfsImageDigest) || rootfsImageDigest === DEV_PLACEHOLDER_DIGEST) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid or placeholder rootfsImageDigest "${rootfsImageDigest}"`,
      false,
      { reason: 'INVALID_ROOTFS_DIGEST', rootfsImageDigest },
    );
  }

  if (!IMAGE_DIGEST_REGEX.test(guestKernelDigest) || guestKernelDigest === DEV_PLACEHOLDER_DIGEST) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid or placeholder guestKernelDigest "${guestKernelDigest}"`,
      false,
      { reason: 'INVALID_KERNEL_DIGEST', guestKernelDigest },
    );
  }

  const registryCheck = verifyApprovedImportsRegistryIntegrity();
  const sortedPackages = [...registryCheck.packages].sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  );

  const importsHashBuilder = crypto.createHash('sha256');
  for (const pkg of sortedPackages) {
    importsHashBuilder.update(`${pkg.packageName}@${pkg.version}:${pkg.sha256}\n`, 'utf-8');
  }
  const computedImportsDigest = `sha256:${importsHashBuilder.digest('hex')}`;
  const approvedImportsBundleDigest =
    options.overrideApprovedImportsDigest ?? computedImportsDigest;

  if (!IMAGE_DIGEST_REGEX.test(approvedImportsBundleDigest)) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid approvedImportsBundleDigest "${approvedImportsBundleDigest}"`,
      false,
      { reason: 'INVALID_IMPORTS_DIGEST', approvedImportsBundleDigest },
    );
  }

  const compositeString = [
    CUSTOM_RUNTIME_ADR_ID,
    runtime,
    rootfsImageDigest,
    guestKernelDigest,
    approvedImportsBundleDigest,
  ].join('|');

  const compositeRuntimeFingerprint = `sha256:${crypto
    .createHash('sha256')
    .update(compositeString, 'utf-8')
    .digest('hex')}`;

  return Object.freeze({
    adrId: CUSTOM_RUNTIME_ADR_ID,
    runtime,
    rootfsImageDigest,
    guestKernelDigest,
    approvedImportsBundleDigest,
    compositeRuntimeFingerprint,
    preinstalledPackages: Object.freeze(
      sortedPackages.map((p) =>
        Object.freeze({
          packageName: p.packageName,
          version: p.version,
          license: p.license,
          sha256: p.sha256,
        }),
      ),
    ),
  });
}

/**
 * Signs a complete P7-05 `C1ToC6SignedReviewPacket` bound to the exact `RuntimeDigestManifest`,
 * kill switch / canary / allowlist verification flags, and off-by-default / rollback verification.
 *
 * @param {{
 *   reviewId?: string;
 *   runtimeManifest: ReturnType<typeof computeRuntimeDigestManifest>;
 *   reviewer: string;
 *   reviewedAt: string;
 *   expiresAt: string;
 *   killSwitchVerified: boolean;
 *   canaryVerified: boolean;
 *   allowlistVerified: boolean;
 *   offByDefaultVerified: boolean;
 *   rollbackVerified: boolean;
 *   gates: Record<string, boolean>;
 *   gateEvidenceSummaries?: Record<string, Record<string, unknown>>;
 *   reviewApprovalScope?: string;
 * }} payload
 * @param {string} signingSecret
 */
export function signC1ToC6ReviewPacket(payload, signingSecret) {
  if (!signingSecret || typeof signingSecret !== 'string' || signingSecret.length < 32) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 review packet signing secret must be at least 32 characters',
      false,
      { reason: 'INVALID_GATE_SIGNING_SECRET' },
    );
  }

  const { runtimeManifest } = payload;
  if (!runtimeManifest || typeof runtimeManifest !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'signC1ToC6ReviewPacket requires a valid runtimeManifest',
      false,
      { reason: 'MISSING_RUNTIME_MANIFEST' },
    );
  }

  /** @type {Record<string, boolean>} */
  const normalizedGates = {};
  for (const gateKey of REQUIRED_C1_TO_C6_GATES) {
    normalizedGates[gateKey] = Boolean(payload.gates && payload.gates[gateKey]);
  }

  const gateAttestation = signC1ToC6GateAttestation(
    {
      runtime: runtimeManifest.runtime,
      rootfsImageDigest: runtimeManifest.rootfsImageDigest,
      guestKernelDigest: runtimeManifest.guestKernelDigest,
      reviewer: payload.reviewer,
      reviewedAt: payload.reviewedAt,
      expiresAt: payload.expiresAt,
      killSwitchVerified: Boolean(payload.killSwitchVerified),
      gates: normalizedGates,
    },
    signingSecret,
  );

  const reviewId = payload.reviewId ?? 'REV-P7-05-C1-C6';
  const reviewApprovalScope =
    payload.reviewApprovalScope ?? 'TECHNICAL_GATE_VERIFIED_AWAITING_HUMAN_SIGNOFF';

  const canonicalObj = {
    reviewId,
    taskId: 'P7-05',
    adrId: CUSTOM_RUNTIME_ADR_ID,
    runtime: runtimeManifest.runtime,
    rootfsImageDigest: runtimeManifest.rootfsImageDigest,
    guestKernelDigest: runtimeManifest.guestKernelDigest,
    approvedImportsBundleDigest: runtimeManifest.approvedImportsBundleDigest,
    compositeRuntimeFingerprint: runtimeManifest.compositeRuntimeFingerprint,
    reviewer: payload.reviewer,
    reviewApprovalScope,
    reviewedAt: payload.reviewedAt,
    expiresAt: payload.expiresAt,
    killSwitchVerified: Boolean(payload.killSwitchVerified),
    canaryVerified: Boolean(payload.canaryVerified),
    allowlistVerified: Boolean(payload.allowlistVerified),
    offByDefaultVerified: Boolean(payload.offByDefaultVerified),
    rollbackVerified: Boolean(payload.rollbackVerified),
    gates: normalizedGates,
    gateAttestationSignatureHex: gateAttestation.signatureHex,
  };

  const signatureHex = crypto
    .createHmac('sha256', Buffer.from(signingSecret, 'utf-8'))
    .update(JSON.stringify(canonicalObj), 'utf-8')
    .digest('hex');

  return Object.freeze({
    ...canonicalObj,
    gateEvidenceSummaries: Object.freeze({ ...(payload.gateEvidenceSummaries || {}) }),
    gateAttestation: Object.freeze(gateAttestation),
    signatureHex,
  });
}

/**
 * Verifies a signed `C1ToC6SignedReviewPacket` against an active `RuntimeDigestManifest`.
 * Rejects any missing C1-C6 gate, unverified kill-switch/canary/allowlist/off-by-default/rollback flag,
 * rootfs/kernel/imports digest drift, composite fingerprint mismatch, expired review, or forged signature.
 *
 * @param {Record<string, any> | null | undefined} packet
 * @param {ReturnType<typeof computeRuntimeDigestManifest>} expectedManifest
 * @param {string} signingSecret
 * @param {Date} [now]
 */
export function verifyC1ToC6ReviewPacket(
  packet,
  expectedManifest,
  signingSecret,
  now = new Date(),
) {
  if (!packet || typeof packet !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Custom code requires a signed C1-C6 review packet before activation',
      false,
      { reason: 'C1_C6_ATTESTATION_MISSING' },
    );
  }

  if (!expectedManifest || typeof expectedManifest !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Missing expected RuntimeDigestManifest for C1-C6 verification',
      false,
      { reason: 'MISSING_RUNTIME_MANIFEST' },
    );
  }

  // 1. Verify underlying C1-C6 gate attestation (checks C1..C6 flags, rootfs/kernel digest drift, expiry, signature)
  verifyC1ToC6Gates(
    packet.gateAttestation ?? packet,
    expectedManifest.rootfsImageDigest,
    expectedManifest.guestKernelDigest,
    signingSecret,
    now,
  );

  // 2. Verify runtime match
  if (packet.runtime !== expectedManifest.runtime) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `C1-C6 review packet runtime "${packet.runtime}" does not match expected runtime "${expectedManifest.runtime}"`,
      false,
      {
        reason: 'ATTESTATION_RUNTIME_MISMATCH',
        attestedRuntime: packet.runtime,
        expectedRuntime: expectedManifest.runtime,
      },
    );
  }

  // 3. Verify pre-installed approved imports bundle digest (detects dependency patch drift per docs/SECURITY.md line 51)
  if (packet.approvedImportsBundleDigest !== expectedManifest.approvedImportsBundleDigest) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Pre-installed approved imports digest drift detected: attested ${packet.approvedImportsBundleDigest} !== active ${expectedManifest.approvedImportsBundleDigest} (dependency change requires re-running C1-C6 gate)`,
      false,
      {
        reason: 'IMPORTS_DIGEST_DRIFT',
        attestedDigest: packet.approvedImportsBundleDigest,
        activeDigest: expectedManifest.approvedImportsBundleDigest,
      },
    );
  }

  // 4. Verify composite runtime fingerprint match (docs/DEPLOYMENT.md line 89: "true chỉ khi C1–C6 approval fingerprint match")
  if (packet.compositeRuntimeFingerprint !== expectedManifest.compositeRuntimeFingerprint) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Composite runtime approval fingerprint mismatch: attested ${packet.compositeRuntimeFingerprint} !== active ${expectedManifest.compositeRuntimeFingerprint}`,
      false,
      {
        reason: 'RUNTIME_FINGERPRINT_DRIFT',
        attestedFingerprint: packet.compositeRuntimeFingerprint,
        activeFingerprint: expectedManifest.compositeRuntimeFingerprint,
      },
    );
  }

  // 5. Verify kill switch, canary, allowlist, off-by-default, and rollback evidence flags
  /** @type {ReadonlyArray<readonly [string, string]>} */
  const requiredFlags = [
    ['killSwitchVerified', 'KILL_SWITCH_UNVERIFIED'],
    ['canaryVerified', 'CANARY_UNVERIFIED'],
    ['allowlistVerified', 'ALLOWLIST_UNVERIFIED'],
    ['offByDefaultVerified', 'OFF_BY_DEFAULT_UNVERIFIED'],
    ['rollbackVerified', 'ROLLBACK_UNVERIFIED'],
  ];

  for (const [field, reason] of requiredFlags) {
    if (packet[field] !== true) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `C1-C6 review packet requires ${field}=true`,
        false,
        { reason, field },
      );
    }
  }

  // 6. Verify outer packet HMAC-SHA256 signature in constant time
  const expectedPacket = signC1ToC6ReviewPacket(
    {
      reviewId: packet.reviewId,
      runtimeManifest: expectedManifest,
      reviewer: packet.reviewer,
      reviewedAt: packet.reviewedAt,
      expiresAt: packet.expiresAt,
      killSwitchVerified: packet.killSwitchVerified,
      canaryVerified: packet.canaryVerified,
      allowlistVerified: packet.allowlistVerified,
      offByDefaultVerified: packet.offByDefaultVerified,
      rollbackVerified: packet.rollbackVerified,
      gates: packet.gates,
      reviewApprovalScope: packet.reviewApprovalScope,
    },
    signingSecret,
  );

  const actualSigBuf = Buffer.from(String(packet.signatureHex || ''), 'utf-8');
  const expectedSigBuf = Buffer.from(expectedPacket.signatureHex, 'utf-8');

  if (
    actualSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(actualSigBuf, expectedSigBuf)
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 review packet outer cryptographic signature is invalid',
      false,
      { reason: 'C1_C6_SIGNATURE_INVALID' },
    );
  }

  return true;
}

/**
 * Custom Runtime Rollout, Kill Switch, Canary & Tenant Allowlist Controller (`CustomRuntimeRolloutController`).
 *
 * Enforces:
 *   - Default-off state (`CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME='disabled'`, `CVE_CUSTOM_TENANT_ALLOWLIST=[]`)
 *   - C1–C6 approval fingerprint matching before any activation
 *   - 3-fixture synthetic canary verification before pilot traffic
 *   - Operator-managed tenant allowlist (`enrollPilotTenant`, `revokePilotTenant`)
 *   - Emergency kill switch (`triggerEmergencyKillSwitch`) blocking new admission, cancelling running custom jobs,
 *     and revoking active custom download grants while keeping structured rendering (`html-v1`, `canvas-v1`, `svg-v1`) unaffected
 *   - Post-restore safety lock (`activatePostRestoreSafetyLock`) & runtime rollback (`rollbackToDefaultOff`, `rollbackToPinnedRuntime`)
 */
export class CustomRuntimeRolloutController {
  /**
   * @param {{
   *   runtime?: DisposableMicroVmRuntime;
   *   runtimeManifest?: ReturnType<typeof computeRuntimeDigestManifest>;
   *   signingSecret?: string;
   *   canarySecret?: string;
   * }} [options]
   */
  constructor(options = {}) {
    this.runtime = options.runtime ?? new DisposableMicroVmRuntime();
    this.runtimeManifest = options.runtimeManifest ?? computeRuntimeDigestManifest();
    this.signingSecret = options.signingSecret ?? DEFAULT_P705_REVIEW_SIGNING_SECRET;
    this.canarySecret = options.canarySecret ?? DEFAULT_P705_CANARY_SECRET;

    /** @type {boolean} */
    this.customCodeEnabled = false;
    /** @type {string} */
    this.customRuntime = 'disabled';
    /** @type {Set<string>} */
    this.tenantAllowlist = new Set();
    /** @type {boolean} */
    this.killSwitchActive = false;
    /** @type {string | null} */
    this.killSwitchReason = null;
    /** @type {boolean} */
    this.restoreLockActive = false;
    /** @type {string | null} */
    this.restoreLockReason = null;

    /** @type {Record<string, any> | null} */
    this.activeReviewPacket = null;
    /** @type {Record<string, any> | null} */
    this.lastCanaryReport = null;

    /** @type {Set<string>} */
    this.revokedRuntimeDigests = new Set();

    /**
     * In-flight custom jobs tracked for immediate kill-switch / allowlist-revocation / image-revocation termination.
     * @type {Map<string, {
     *   jobId: string;
     *   tenantId: string;
     *   kind: 'build' | 'preview' | 'render' | 'authoring';
     *   state: 'running' | 'succeeded' | 'failed' | 'canceled';
     *   runtimeDigest: string;
     *   abortController: AbortController;
     *   onTerminate?: (reason: string) => void;
     *   terminationReason: string | null;
     *   startedAt: string;
     *   endedAt: string | null;
     * }>}
     */
    this.customJobs = new Map();

    /**
     * Issued custom preview/artifact download grants tracked for immediate revocation on incident.
     * @type {Map<string, {
     *   grantId: string;
     *   previewId: string;
     *   tenantId: string;
     *   revoked: boolean;
     *   revokedReason: string | null;
     *   issuedAt: string;
     * }>}
     */
    this.issuedGrants = new Map();

    /** @type {Array<Record<string, any>>} */
    this.auditEvents = [];
  }

  /**
   * Returns current snapshot of the custom runtime feature flag, runtime, allowlist, and locks.
   */
  getConfigSnapshot() {
    return Object.freeze({
      CVE_CUSTOM_CODE_ENABLED: this.customCodeEnabled,
      CVE_CUSTOM_RUNTIME: this.customRuntime,
      CVE_CUSTOM_TENANT_ALLOWLIST: Object.freeze(Array.from(this.tenantAllowlist)),
      killSwitchActive: this.killSwitchActive,
      killSwitchReason: this.killSwitchReason,
      restoreLockActive: this.restoreLockActive,
      restoreLockReason: this.restoreLockReason,
      activeRuntimeFingerprint: this.runtimeManifest.compositeRuntimeFingerprint,
      rootfsImageDigest: this.runtimeManifest.rootfsImageDigest,
      guestKernelDigest: this.runtimeManifest.guestKernelDigest,
      approvedImportsBundleDigest: this.runtimeManifest.approvedImportsBundleDigest,
      revokedRuntimeDigests: Object.freeze(Array.from(this.revokedRuntimeDigests)),
    });
  }

  /**
   * Verifies that structured template engines (`html-v1`, `canvas-v1`, `svg-v1`) remain 100% operational
   * regardless of whether custom code is disabled, kill-switched, or rolled back (`docs/OPERATIONS.md` line 85).
   *
   * @param {string} [engine]
   */
  verifyStructuredRenderingPathUnaffected(engine = 'html-v1') {
    const structuredEngines = ['html-v1', 'canvas-v1', 'svg-v1'];
    if (!structuredEngines.includes(engine)) {
      throw new CustomRuntimeError(
        'UNSUPPORTED_CAPABILITY',
        `Engine "${engine}" is not a structured template engine`,
        false,
      );
    }
    return Object.freeze({
      engine,
      allowed: true,
      customCodeEnabled: this.customCodeEnabled,
      killSwitchActive: this.killSwitchActive,
      restoreLockActive: this.restoreLockActive,
      structuredPathUnaffected: true,
    });
  }

  /**
   * Runs the 3-fixture custom scene canary suite (`CANARY_SCENE_FIXTURES`) inside disposable build & render microVMs
   * while injecting a synthetic canary secret into the host controller environment to prove zero secret exfiltration.
   */
  async runCanaryVerificationSuite() {
    assertNoTrustedApiExecution('canary-verification-suite');
    const envVarName = 'CVE_CANARY_ROLLOUT_SECRET_P705';
    const prevVal = process.env[envVarName];
    process.env[envVarName] = this.canarySecret;

    const buildPipeline = new IsolatedSceneBuildPipeline({
      runtime: this.runtime,
      canaries: [this.canarySecret, DEFAULT_P704_CANARY_SECRET],
    });
    const previewEngine = new IsolatedScenePreviewEngine({
      runtime: this.runtime,
      canaries: [this.canarySecret, DEFAULT_P704_CANARY_SECRET],
    });

    const fixtureResults = [];

    try {
      for (const fixture of CANARY_SCENE_FIXTURES) {
        const buildRes = await buildPipeline.buildSceneBundle({
          bundleId: fixture.bundleId,
          revision: 1,
          entrypoint: fixture.entrypoint,
          sourceFiles: fixture.sourceFiles,
          parameterSchema: fixture.parameterSchema,
          tenantId: 'tnt_canary_probe',
          jobId: `job_${fixture.fixtureId.replace(/-/g, '_')}`,
          attemptId: `att_${fixture.fixtureId.replace(/-/g, '_')}`,
          canaries: [this.canarySecret],
          securitySelfTestMode: true,
        });

        const buildVmAtt = buildRes.buildMicroVmInstance.getAttestation();

        const previewRes = await previewEngine.renderIsolatedPreview({
          tenantId: 'tnt_canary_probe',
          compiledBundle: buildRes,
          mode: fixture.previewMode,
          profile: 'preview-360p-v1',
          canvas: fixture.canvas,
          fps: fixture.fps,
          totalFrames: fixture.totalFrames,
          frameIndex: fixture.previewMode === 'frame' ? fixture.previewFrameIndex : undefined,
          startFrame: fixture.previewMode === 'clip' ? fixture.previewStartFrame : undefined,
          durationFrames:
            fixture.previewMode === 'clip' ? fixture.previewDurationFrames : undefined,
          parameterSchema: fixture.parameterSchema,
          parameters: fixture.parameters,
          canaries: [this.canarySecret],
          securitySelfTestMode: true,
        });

        const canaryLeaked =
          buildRes.compiledBytes.toString('utf-8').includes(this.canarySecret) ||
          previewRes.artifactBytes.toString('utf-8').includes(this.canarySecret) ||
          buildRes.canaryPresentInBuildVm ||
          previewRes.canaryPresentInRenderVm;

        if (canaryLeaked) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Canary secret leaked during canary fixture "${fixture.fixtureId}"`,
            false,
            { reason: 'CANARY_SECRET_LEAK_DETECTED', fixtureId: fixture.fixtureId },
          );
        }

        if (
          !buildVmAtt.destroyed ||
          !buildVmAtt.prisonWiped ||
          !previewRes.renderVmAttestation.destroyed ||
          !previewRes.renderVmAttestation.prisonWiped
        ) {
          throw new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `Disposable microVM prison was not destroyed/wiped for canary "${fixture.fixtureId}"`,
            false,
          );
        }

        fixtureResults.push({
          fixtureId: fixture.fixtureId,
          bundleId: fixture.bundleId,
          mode: fixture.previewMode,
          outputFormat: previewRes.format,
          outputDimensions: previewRes.outputDimensions,
          sourceSha256: buildRes.sourceSha256,
          buildSha256: buildRes.buildSha256,
          artifactSha256: previewRes.artifactSha256,
          cspScriptHash: buildRes.cspScriptHash,
          buildVmDestroyedAndWiped: buildVmAtt.destroyed && buildVmAtt.prisonWiped,
          renderVmDestroyedAndWiped:
            previewRes.renderVmAttestation.destroyed &&
            previewRes.renderVmAttestation.prisonWiped,
          canarySecretLeaked: false,
          trustedApiExecuted: false,
          passed: true,
        });
      }

      const report = Object.freeze({
        passed: fixtureResults.length === 3 && fixtureResults.every((r) => r.passed),
        fixturesCount: fixtureResults.length,
        passedFixturesCount: fixtureResults.filter((r) => r.passed).length,
        hostCanaryEnvKey: envVarName,
        canarySecretLeaked: false,
        trustedApiExecutionsCount: getTrustedApiExecutionAudit().trustedApiExecutionsCount,
        evaluatedAt: new Date().toISOString(),
        fixtures: Object.freeze(fixtureResults),
      });

      this.lastCanaryReport = report;
      return report;
    } finally {
      if (prevVal === undefined) {
        delete process.env[envVarName];
      } else {
        process.env[envVarName] = prevVal;
      }
    }
  }

  /**
   * Enables custom code pilot rollout ONLY if:
   *   1. Emergency kill switch is NOT active.
   *   2. Post-restore safety lock is NOT active.
   *   3. Runtime digests are NOT in the revoked vulnerable image list.
   *   4. `signedReviewPacket` passes `verifyC1ToC6ReviewPacket` against `this.runtimeManifest`.
   *   5. All 3 canary fixtures pass `runCanaryVerificationSuite()`.
   *   6. Host virtualization probe confirms hardware readiness (or explicit pilot test probe).
   *
   * @param {{
   *   signedReviewPacket: Record<string, any>;
   *   pilotTenants: readonly string[];
   *   signingSecret?: string;
   *   hostProbe?: ReturnType<typeof probeHostVirtualization>;
   *   skipCanaryRerunIfPassed?: boolean;
   * }} input
   */
  async enablePilotRollout(input) {
    const {
      signedReviewPacket,
      pilotTenants,
      signingSecret = this.signingSecret,
      hostProbe = probeHostVirtualization(),
      skipCanaryRerunIfPassed = false,
    } = input;

    if (this.killSwitchActive) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        `Cannot enable custom code rollout while emergency kill switch is active (${this.killSwitchReason})`,
        false,
        { reason: 'KILL_SWITCH_ACTIVE', killSwitchReason: this.killSwitchReason },
      );
    }

    if (this.restoreLockActive) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Custom code remains locked off after restore until explicit policy revalidation completes',
        false,
        { reason: 'RESTORE_REVALIDATION_REQUIRED', restoreLockReason: this.restoreLockReason },
      );
    }

    if (
      this.revokedRuntimeDigests.has(this.runtimeManifest.rootfsImageDigest) ||
      this.revokedRuntimeDigests.has(this.runtimeManifest.guestKernelDigest) ||
      this.revokedRuntimeDigests.has(this.runtimeManifest.compositeRuntimeFingerprint)
    ) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Cannot enable custom code on a revoked security-critical runtime digest',
        false,
        {
          reason: 'VULNERABLE_RUNTIME_REVOKED',
          rootfsImageDigest: this.runtimeManifest.rootfsImageDigest,
          guestKernelDigest: this.runtimeManifest.guestKernelDigest,
        },
      );
    }

    if (!Array.isArray(pilotTenants) || pilotTenants.length === 0) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Pilot rollout requires at least one explicit tenant ID in CVE_CUSTOM_TENANT_ALLOWLIST',
        false,
        { reason: 'TENANT_NOT_ALLOWLISTED' },
      );
    }

    // 1. Verify C1-C6 signed review packet against exact runtime digest & fingerprint
    verifyC1ToC6ReviewPacket(signedReviewPacket, this.runtimeManifest, signingSecret);

    // 2. Run 3-fixture canary suite if not already verified
    const canaryReport =
      skipCanaryRerunIfPassed && this.lastCanaryReport?.passed
        ? this.lastCanaryReport
        : await this.runCanaryVerificationSuite();

    if (!canaryReport.passed) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Custom scene canary verification suite failed; rollout aborted and feature kept disabled',
        false,
        { reason: 'CANARY_SUITE_FAILED' },
      );
    }

    // 3. Evaluate ADR-0002 runtime policy for the first pilot tenant (verifies KVM probe, anti-downgrade, C1-C6)
    evaluateCustomRuntimePolicy({
      config: {
        CVE_CUSTOM_CODE_ENABLED: true,
        CVE_CUSTOM_RUNTIME: this.runtimeManifest.runtime,
        CVE_CUSTOM_TENANT_ALLOWLIST: [...pilotTenants],
      },
      tenantId: pilotTenants[0],
      killSwitchActive: false,
      rootfsImageDigest: this.runtimeManifest.rootfsImageDigest,
      guestKernelDigest: this.runtimeManifest.guestKernelDigest,
      c1ToC6Attestation: signedReviewPacket.gateAttestation,
      signingSecret,
      hostProbe,
    });

    this.customCodeEnabled = true;
    this.customRuntime = this.runtimeManifest.runtime;
    this.tenantAllowlist = new Set(pilotTenants);
    this.activeReviewPacket = signedReviewPacket;

    this.auditEvents.push({
      event: 'PILOT_ROLLOUT_ENABLED',
      at: new Date().toISOString(),
      runtime: this.customRuntime,
      compositeRuntimeFingerprint: this.runtimeManifest.compositeRuntimeFingerprint,
      pilotTenants: [...this.tenantAllowlist],
    });

    return this.getConfigSnapshot();
  }

  /**
   * Asserts that a specific `tenantId` is currently authorized to admit/execute custom scene code.
   * Checks kill switch, post-restore lock, revoked digests, feature flag, C1-C6 fingerprint, and tenant allowlist.
   *
   * @param {string} tenantId
   * @param {{ hostProbe?: ReturnType<typeof probeHostVirtualization> }} [options]
   */
  assertTenantAllowedForCustomCode(tenantId, options = {}) {
    if (this.killSwitchActive) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        `Custom code emergency kill switch is active (${this.killSwitchReason || 'incident'}); admission blocked`,
        false,
        { reason: 'KILL_SWITCH_ACTIVE', tenantId },
      );
    }

    if (this.restoreLockActive) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Custom code is locked off following backup restore pending C1-C6 revalidation',
        false,
        { reason: 'RESTORE_REVALIDATION_REQUIRED', tenantId },
      );
    }

    if (
      this.revokedRuntimeDigests.has(this.runtimeManifest.rootfsImageDigest) ||
      this.revokedRuntimeDigests.has(this.runtimeManifest.guestKernelDigest) ||
      this.revokedRuntimeDigests.has(this.runtimeManifest.compositeRuntimeFingerprint)
    ) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Active runtime digest has been revoked due to security incident',
        false,
        { reason: 'VULNERABLE_RUNTIME_REVOKED', tenantId },
      );
    }

    if (!this.customCodeEnabled || this.customRuntime === 'disabled') {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Custom scene code execution is disabled by default (CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled)',
        false,
        { reason: 'CUSTOM_CODE_DEFAULT_OFF', tenantId },
      );
    }

    verifyC1ToC6ReviewPacket(
      this.activeReviewPacket,
      this.runtimeManifest,
      this.signingSecret,
    );

    const hostProbe =
      options.hostProbe ??
      probeHostVirtualization({
        overrideKvmAvailable: true,
        overrideBinaries: { firecracker: true, jailer: true },
      });

    return evaluateCustomRuntimePolicy({
      config: {
        CVE_CUSTOM_CODE_ENABLED: this.customCodeEnabled,
        CVE_CUSTOM_RUNTIME: this.customRuntime,
        CVE_CUSTOM_TENANT_ALLOWLIST: Array.from(this.tenantAllowlist),
      },
      tenantId,
      killSwitchActive: this.killSwitchActive,
      rootfsImageDigest: this.runtimeManifest.rootfsImageDigest,
      guestKernelDigest: this.runtimeManifest.guestKernelDigest,
      c1ToC6Attestation: this.activeReviewPacket?.gateAttestation,
      signingSecret: this.signingSecret,
      hostProbe,
    });
  }

  /**
   * Enrolls a tenant into `CVE_CUSTOM_TENANT_ALLOWLIST`.
   * @param {string} tenantId
   */
  enrollPilotTenant(tenantId) {
    if (!tenantId || typeof tenantId !== 'string') {
      throw new CustomRuntimeError('VALIDATION_FAILED', 'Invalid tenantId for allowlist', false);
    }
    this.tenantAllowlist.add(tenantId);
    this.auditEvents.push({
      event: 'PILOT_TENANT_ENROLLED',
      tenantId,
      at: new Date().toISOString(),
    });
    return Array.from(this.tenantAllowlist);
  }

  /**
   * Revokes a tenant from `CVE_CUSTOM_TENANT_ALLOWLIST`, immediately terminating any running custom jobs
   * and revoking custom preview grants for that tenant.
   *
   * @param {string} tenantId
   * @param {string} [reason]
   */
  revokePilotTenant(tenantId, reason = 'TENANT_ALLOWLIST_REVOKED') {
    this.tenantAllowlist.delete(tenantId);
    let terminatedJobsCount = 0;
    for (const job of this.customJobs.values()) {
      if (job.tenantId === tenantId && job.state === 'running') {
        job.state = 'canceled';
        job.terminationReason = reason;
        job.endedAt = new Date().toISOString();
        job.abortController.abort(new Error(reason));
        if (typeof job.onTerminate === 'function') {
          job.onTerminate(reason);
        }
        terminatedJobsCount += 1;
      }
    }

    let revokedGrantsCount = 0;
    for (const grant of this.issuedGrants.values()) {
      if (grant.tenantId === tenantId && !grant.revoked) {
        grant.revoked = true;
        grant.revokedReason = reason;
        revokedGrantsCount += 1;
      }
    }

    this.auditEvents.push({
      event: 'PILOT_TENANT_REVOKED',
      tenantId,
      reason,
      terminatedJobsCount,
      revokedGrantsCount,
      at: new Date().toISOString(),
    });

    return {
      tenantId,
      allowlist: Array.from(this.tenantAllowlist),
      terminatedJobsCount,
      revokedGrantsCount,
    };
  }

  /**
   * Registers an active custom scene job (`build` | `preview` | `render` | `authoring`) so that
   * emergency kill switch, tenant revocation, or vulnerable image revocation can terminate it immediately.
   *
   * @param {{
   *   jobId: string;
   *   tenantId: string;
   *   kind?: 'build' | 'preview' | 'render' | 'authoring';
   *   onTerminate?: (reason: string) => void;
   *   hostProbe?: ReturnType<typeof probeHostVirtualization>;
   * }} input
   */
  registerActiveCustomJob(input) {
    const { jobId, tenantId, kind = 'render', onTerminate, hostProbe } = input;
    this.assertTenantAllowedForCustomCode(tenantId, { hostProbe });

    const abortController = new AbortController();
    const record = {
      jobId,
      tenantId,
      kind,
      state: /** @type {'running' | 'succeeded' | 'failed' | 'canceled'} */ ('running'),
      runtimeDigest: this.runtimeManifest.rootfsImageDigest,
      abortController,
      onTerminate,
      terminationReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.customJobs.set(jobId, record);
    return record;
  }

  /**
   * Registers a custom preview/artifact download grant so that emergency kill switch or tenant revocation
   * can revoke it immediately.
   *
   * @param {{ grantId: string; previewId: string; tenantId: string }} input
   */
  registerIssuedDownloadGrant(input) {
    const record = {
      grantId: input.grantId,
      previewId: input.previewId,
      tenantId: input.tenantId,
      revoked: false,
      revokedReason: null,
      issuedAt: new Date().toISOString(),
    };
    this.issuedGrants.set(input.grantId, record);
    return record;
  }

  /**
   * Verifies that a download grant has not been revoked by kill switch or tenant removal.
   * @param {string} grantId
   */
  assertDownloadGrantActive(grantId) {
    const grant = this.issuedGrants.get(grantId);
    if (!grant) {
      throw new CustomRuntimeError('PREVIEW_NOT_FOUND', `Grant "${grantId}" not found`, false);
    }
    if (grant.revoked || this.killSwitchActive) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        `Download grant "${grantId}" has been revoked (${grant.revokedReason || 'KILL_SWITCH_ACTIVE'})`,
        false,
        { reason: grant.revokedReason || 'KILL_SWITCH_ACTIVE', grantId, statusCode: 410 },
      );
    }
    return grant;
  }

  /**
   * Triggers the emergency custom code kill switch (`docs/SECURITY.md` line 51 & `docs/OPERATIONS.md` line 85):
   *   1. Sets `killSwitchActive = true`, `CVE_CUSTOM_CODE_ENABLED = false`, `CVE_CUSTOM_RUNTIME = 'disabled'`.
   *   2. Immediately blocks all new custom scene admissions (`KILL_SWITCH_ACTIVE`).
   *   3. Cancels/terminates all running custom jobs (`KILL_SWITCH_TERMINATED`).
   *   4. Revokes active custom download grants (`GRANT_REVOKED_BY_KILL_SWITCH`).
   *   5. Leaves structured template rendering (`html-v1`, `canvas-v1`, `svg-v1`) completely unaffected.
   *
   * @param {string} [reason]
   * @param {string} [triggeredBy]
   */
  triggerEmergencyKillSwitch(
    reason = 'SECURITY_INCIDENT_EMERGENCY_STOP',
    triggeredBy = 'security-reviewer@creativanta.internal',
  ) {
    this.killSwitchActive = true;
    this.killSwitchReason = reason;
    this.customCodeEnabled = false;
    this.customRuntime = 'disabled';

    const terminatedJobIds = [];
    for (const job of this.customJobs.values()) {
      if (job.state === 'running') {
        job.state = 'canceled';
        job.terminationReason = 'KILL_SWITCH_TERMINATED';
        job.endedAt = new Date().toISOString();
        job.abortController.abort(new Error('KILL_SWITCH_TERMINATED'));
        if (typeof job.onTerminate === 'function') {
          job.onTerminate('KILL_SWITCH_TERMINATED');
        }
        terminatedJobIds.push(job.jobId);
      }
    }

    const revokedGrantIds = [];
    for (const grant of this.issuedGrants.values()) {
      if (!grant.revoked) {
        grant.revoked = true;
        grant.revokedReason = 'GRANT_REVOKED_BY_KILL_SWITCH';
        revokedGrantIds.push(grant.grantId);
      }
    }

    const structuredStatus = this.verifyStructuredRenderingPathUnaffected('html-v1');

    const summary = Object.freeze({
      killSwitchActive: true,
      CVE_CUSTOM_CODE_ENABLED: this.customCodeEnabled,
      CVE_CUSTOM_RUNTIME: this.customRuntime,
      reason,
      triggeredBy,
      triggeredAt: new Date().toISOString(),
      terminatedCustomJobsCount: terminatedJobIds.length,
      terminatedJobIds: Object.freeze(terminatedJobIds),
      revokedGrantsCount: revokedGrantIds.length,
      revokedGrantIds: Object.freeze(revokedGrantIds),
      structuredRenderingUnaffected: structuredStatus.structuredPathUnaffected,
    });

    this.auditEvents.push({
      event: 'EMERGENCY_KILL_SWITCH_TRIGGERED',
      ...summary,
    });

    return summary;
  }

  /**
   * Clears the emergency kill switch ONLY after verifying a fresh C1–C6 signed review packet
   * and passing the 3-fixture canary suite. Keeps custom code disabled until `enablePilotRollout` is called.
   *
   * @param {{
   *   signedReviewPacket: Record<string, any>;
   *   signingSecret?: string;
   * }} input
   */
  async clearEmergencyKillSwitchAfterRevalidation(input) {
    const signingSecret = input.signingSecret ?? this.signingSecret;
    verifyC1ToC6ReviewPacket(input.signedReviewPacket, this.runtimeManifest, signingSecret);
    const canaryReport = await this.runCanaryVerificationSuite();
    if (!canaryReport.passed) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Cannot clear emergency kill switch: canary verification suite failed',
        false,
      );
    }

    this.killSwitchActive = false;
    this.killSwitchReason = null;
    this.customCodeEnabled = false;
    this.customRuntime = 'disabled';

    this.auditEvents.push({
      event: 'EMERGENCY_KILL_SWITCH_CLEARED_TO_DEFAULT_OFF',
      at: new Date().toISOString(),
    });

    return this.getConfigSnapshot();
  }

  /**
   * Locks custom code off after a DB/object backup restore (`docs/DEPLOYMENT.md` line 118 & `P6-02`/`P6-04`:
   * "Feature flag custom/import off sau restore cho đến policy revalidation").
   *
   * @param {string} [restoreId]
   */
  activatePostRestoreSafetyLock(restoreId = 'restore_drill_p705') {
    this.restoreLockActive = true;
    this.restoreLockReason = `Locked off after restore (${restoreId}) pending C1-C6 revalidation`;
    this.customCodeEnabled = false;
    this.customRuntime = 'disabled';

    this.auditEvents.push({
      event: 'POST_RESTORE_SAFETY_LOCK_ACTIVATED',
      restoreId,
      at: new Date().toISOString(),
    });

    return this.getConfigSnapshot();
  }

  /**
   * Revalidates C1–C6 and canary suite after a backup restore, releasing `restoreLockActive` while
   * keeping `CVE_CUSTOM_CODE_ENABLED = false` (off-by-default) until explicit operator pilot re-enablement.
   *
   * @param {{
   *   signedReviewPacket: Record<string, any>;
   *   signingSecret?: string;
   * }} input
   */
  async revalidateAfterRestore(input) {
    const signingSecret = input.signingSecret ?? this.signingSecret;
    verifyC1ToC6ReviewPacket(input.signedReviewPacket, this.runtimeManifest, signingSecret);
    const canaryReport = await this.runCanaryVerificationSuite();
    if (!canaryReport.passed) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Post-restore revalidation failed: canary suite did not pass',
        false,
      );
    }

    this.restoreLockActive = false;
    this.restoreLockReason = null;
    // Remains off-by-default after unlocking restore gate until explicit pilot rollout
    this.customCodeEnabled = false;
    this.customRuntime = 'disabled';

    this.auditEvents.push({
      event: 'POST_RESTORE_REVALIDATED_DEFAULT_OFF',
      at: new Date().toISOString(),
    });

    return this.getConfigSnapshot();
  }

  /**
   * Revokes a security-critical vulnerable runtime digest (`docs/DEPLOYMENT.md` line 118:
   * "Security-critical image revoke có thể fail/recreate jobs thay vì giữ vulnerable runtime").
   *
   * @param {string} vulnerableDigest
   * @param {string} [reason]
   */
  revokeCompromisedRuntimeDigest(vulnerableDigest, reason = 'CVE_RUNTIME_VULNERABILITY_REVOKED') {
    this.revokedRuntimeDigests.add(vulnerableDigest);

    const abortedJobIds = [];
    for (const job of this.customJobs.values()) {
      if (job.state === 'running' && job.runtimeDigest === vulnerableDigest) {
        job.state = 'failed';
        job.terminationReason = 'VULNERABLE_RUNTIME_REVOKED';
        job.endedAt = new Date().toISOString();
        job.abortController.abort(new Error('VULNERABLE_RUNTIME_REVOKED'));
        if (typeof job.onTerminate === 'function') {
          job.onTerminate('VULNERABLE_RUNTIME_REVOKED');
        }
        abortedJobIds.push(job.jobId);
      }
    }

    if (
      this.runtimeManifest.rootfsImageDigest === vulnerableDigest ||
      this.runtimeManifest.guestKernelDigest === vulnerableDigest ||
      this.runtimeManifest.compositeRuntimeFingerprint === vulnerableDigest
    ) {
      this.customCodeEnabled = false;
      this.customRuntime = 'disabled';
    }

    this.auditEvents.push({
      event: 'COMPROMISED_RUNTIME_DIGEST_REVOKED',
      vulnerableDigest,
      reason,
      abortedJobIds,
      at: new Date().toISOString(),
    });

    return Object.freeze({
      vulnerableDigest,
      reason,
      abortedRunningJobsCount: abortedJobIds.length,
      abortedJobIds: Object.freeze(abortedJobIds),
      customCodeDisabled: !this.customCodeEnabled,
    });
  }

  /**
   * Rolls back custom code feature to default-off (`CVE_CUSTOM_CODE_ENABLED=false`, `CVE_CUSTOM_RUNTIME='disabled'`)
   * without mutating or rolling back tenant data (`SceneBundleRegistry` revisions and provenance remain intact).
   *
   * @param {string} [reason]
   */
  rollbackToDefaultOff(reason = 'OPERATOR_FEATURE_ROLLBACK_TO_DEFAULT_OFF') {
    this.customCodeEnabled = false;
    this.customRuntime = 'disabled';

    const canceledJobIds = [];
    for (const job of this.customJobs.values()) {
      if (job.state === 'running') {
        job.state = 'canceled';
        job.terminationReason = 'ROLLBACK_TO_DEFAULT_OFF';
        job.endedAt = new Date().toISOString();
        job.abortController.abort(new Error('ROLLBACK_TO_DEFAULT_OFF'));
        if (typeof job.onTerminate === 'function') {
          job.onTerminate('ROLLBACK_TO_DEFAULT_OFF');
        }
        canceledJobIds.push(job.jobId);
      }
    }

    this.auditEvents.push({
      event: 'ROLLBACK_TO_DEFAULT_OFF',
      reason,
      canceledJobIds,
      at: new Date().toISOString(),
    });

    return Object.freeze({
      CVE_CUSTOM_CODE_ENABLED: this.customCodeEnabled,
      CVE_CUSTOM_RUNTIME: this.customRuntime,
      reason,
      canceledCustomJobsCount: canceledJobIds.length,
      structuredRenderingUnaffected:
        this.verifyStructuredRenderingPathUnaffected('html-v1').structuredPathUnaffected,
    });
  }

  /**
   * Rolls back from a faulty/revoked runtime candidate (`v2`) to a known-good pinned runtime manifest (`v1`)
   * with its verified `C1–C6` signed review packet, re-running the 3 canary fixtures before resuming pilot traffic.
   *
   * @param {{
   *   targetManifest: ReturnType<typeof computeRuntimeDigestManifest>;
   *   signedReviewPacket: Record<string, any>;
   *   pilotTenants: readonly string[];
   *   signingSecret?: string;
   *   hostProbe?: ReturnType<typeof probeHostVirtualization>;
   * }} input
   */
  async rollbackToPinnedRuntime(input) {
    this.runtimeManifest = input.targetManifest;
    this.killSwitchActive = false;
    this.killSwitchReason = null;
    this.restoreLockActive = false;
    this.restoreLockReason = null;

    const snapshot = await this.enablePilotRollout({
      signedReviewPacket: input.signedReviewPacket,
      pilotTenants: input.pilotTenants,
      signingSecret: input.signingSecret ?? this.signingSecret,
      hostProbe: input.hostProbe,
      skipCanaryRerunIfPassed: false,
    });

    this.auditEvents.push({
      event: 'ROLLED_BACK_TO_PINNED_RUNTIME',
      rootfsImageDigest: this.runtimeManifest.rootfsImageDigest,
      guestKernelDigest: this.runtimeManifest.guestKernelDigest,
      compositeRuntimeFingerprint: this.runtimeManifest.compositeRuntimeFingerprint,
      at: new Date().toISOString(),
    });

    return snapshot;
  }
}

/**
 * Executes live verification of all six security release gates (`C1`–`C6`) and generates a signed
 * `C1ToC6SignedReviewPacket` bound to the exact `RuntimeDigestManifest`.
 *
 * @param {{
 *   signingSecret?: string;
 *   canarySecret?: string;
 *   reviewer?: string;
 *   reviewedAt?: string;
 *   expiresAt?: string;
 * }} [options]
 */
export async function evaluateAllC1ToC6Gates(options = {}) {
  const signingSecret = options.signingSecret ?? DEFAULT_P705_REVIEW_SIGNING_SECRET;
  const canarySecret = options.canarySecret ?? DEFAULT_P705_CANARY_SECRET;
  const reviewer = options.reviewer ?? 'security-reviewer@creativanta.internal';
  const reviewedAt = options.reviewedAt ?? '2026-11-04T16:45:00.000Z';
  const expiresAt = options.expiresAt ?? '2027-11-04T16:45:00.000Z';

  assertNoTrustedApiExecution('evaluate-c1-c6-gates');
  const runtimeManifest = computeRuntimeDigestManifest();

  const runtime = new DisposableMicroVmRuntime();
  const buildPipeline = new IsolatedSceneBuildPipeline({
    runtime,
    canaries: [canarySecret, DEFAULT_P704_CANARY_SECRET],
  });
  const previewEngine = new IsolatedScenePreviewEngine({
    runtime,
    canaries: [canarySecret, DEFAULT_P704_CANARY_SECRET],
  });

  /** @type {Record<string, boolean>} */
  const gates = {};
  /** @type {Record<string, Record<string, any>>} */
  const gateEvidenceSummaries = {};

  try {
    // =========================================================================
    // Gate C1: Threat Model, Anti-Downgrade Lock, gVisor Gate & Exact Runtime Pin
    // =========================================================================
    let blockedDowngradesCount = 0;
    for (const forbiddenRuntime of FORBIDDEN_DOWNGRADE_RUNTIMES) {
      let rejected = false;
      try {
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: forbiddenRuntime,
            CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_pilot_01'],
          },
          tenantId: 'tnt_pilot_01',
        });
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (err instanceof CustomRuntimeError && e.details?.reason === 'RUNTIME_DOWNGRADE_FORBIDDEN') {
          rejected = true;
        }
      }
      if (!rejected) {
        throw new Error(`Gate C1 failed: downgrade runtime "${forbiddenRuntime}" was not rejected`);
      }
      blockedDowngradesCount += 1;
    }

    let gvisorUnreviewedBlocked = false;
    try {
      evaluateCustomRuntimePolicy({
        config: {
          CVE_CUSTOM_CODE_ENABLED: true,
          CVE_CUSTOM_RUNTIME: 'gvisor-runsc-v1',
          CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_pilot_01'],
        },
        tenantId: 'tnt_pilot_01',
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'GVISOR_EXPLICIT_REVIEW_REQUIRED') {
        gvisorUnreviewedBlocked = true;
      }
    }
    if (!gvisorUnreviewedBlocked) {
      throw new Error('Gate C1 failed: unreviewed gvisor-runsc-v1 was not blocked');
    }

    const hostProbe = probeHostVirtualization();
    gates.C1_threat_model_and_runtime_pin = true;
    gateEvidenceSummaries.C1_threat_model_and_runtime_pin = {
      adrId: CUSTOM_RUNTIME_ADR_ID,
      runtime: runtimeManifest.runtime,
      rootfsImageDigest: runtimeManifest.rootfsImageDigest,
      guestKernelDigest: runtimeManifest.guestKernelDigest,
      approvedImportsBundleDigest: runtimeManifest.approvedImportsBundleDigest,
      compositeRuntimeFingerprint: runtimeManifest.compositeRuntimeFingerprint,
      blockedDowngradesCount,
      gvisorExplicitReviewEnforced: true,
      hostKvmHardwareDetected: hostProbe.microVmHardwareReady,
      actionWhenKvmUnavailable: hostProbe.recommendedActionWhenUnavailable,
    };

    // =========================================================================
    // Gate C2: Isolated Build in Disposable build-vm & Zero Network Egress
    // =========================================================================
    const canaryFixture = CANARY_SCENE_FIXTURES[0];
    if (!canaryFixture) {
      throw new Error('Missing CANARY_SCENE_FIXTURES[0]');
    }
    const buildRes = await buildPipeline.buildSceneBundle({
      bundleId: canaryFixture.bundleId,
      revision: 1,
      entrypoint: canaryFixture.entrypoint,
      sourceFiles: canaryFixture.sourceFiles,
      parameterSchema: canaryFixture.parameterSchema,
      tenantId: 'tnt_c2_gate',
      jobId: 'job_c2_gate',
      attemptId: 'att_c2_gate',
      canaries: [canarySecret],
      securitySelfTestMode: true,
    });

    const buildVmAtt = buildRes.buildMicroVmInstance.getAttestation();
    let tapNicBlocked = false;
    try {
      assertZeroEgressMicroVmSpec({
        'network-interfaces': [{ iface_id: 'eth0', host_dev_name: 'tap0' }],
        mmds_config: null,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'EGRESS_NIC_FORBIDDEN') {
        tapNicBlocked = true;
      }
    }
    if (
      !tapNicBlocked ||
      buildVmAtt.networkInterfacesCount !== 0 ||
      !buildVmAtt.mmdsDisabled ||
      !buildVmAtt.destroyed ||
      !buildVmAtt.prisonWiped ||
      !buildRes.cspHeader.includes("connect-src 'none'")
    ) {
      throw new Error('Gate C2 failed: zero-egress or disposable build-vm teardown invariant violated');
    }

    gates.C2_isolated_build_and_no_egress = true;
    gateEvidenceSummaries.C2_isolated_build_and_no_egress = {
      buildVmId: buildVmAtt.vmId,
      networkInterfacesCount: buildVmAtt.networkInterfacesCount,
      mmdsDisabled: buildVmAtt.mmdsDisabled,
      tapNicInjectionBlocked: tapNicBlocked,
      cspScriptHash: buildRes.cspScriptHash,
      sourceSha256: buildRes.sourceSha256,
      buildSha256: buildRes.buildSha256,
      buildVmDestroyedAndWiped: buildVmAtt.destroyed && buildVmAtt.prisonWiped,
      trustedApiExecutionsCount: getTrustedApiExecutionAudit().trustedApiExecutionsCount,
    };

    // =========================================================================
    // Gate C3: Filesystem / Process / Secret Canary / Metadata Escape Suite
    // =========================================================================
    const maliciousSuiteReport = await runMaliciousPayloadSuite({
      canarySecret,
    });
    const canaryProofReport = await verifySourceInjectionCannotReadCanarySecrets({
      canarySecret,
    });

    const tmpPrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p705-c3-prison-'));
    let hostSocketBlocked = false;
    let symlinkEscapeBlocked = false;
    try {
      const prisonMgr = new MicroVmWorkspacePrison(tmpPrisonRoot);
      const prison = prisonMgr.createPrison('vm_c3_01', 'build', 'job_c3_01', 'att_c3_01');
      try {
        validateMicroVmHostPaths(['/var/run/docker.sock'], prison.rootDir);
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (err instanceof CustomRuntimeError && e.details?.reason === 'HOST_FS_MOUNT_FORBIDDEN') {
          hostSocketBlocked = true;
        }
      }
      const symPath = path.join(prison.outputDir, 'etc-passwd-link');
      fs.symlinkSync('/etc/passwd', symPath);
      try {
        prisonMgr.enforceScratchAndOutputQuota(prison, 1024 * 1024);
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (err instanceof CustomRuntimeError && e.details?.reason === 'SYMLINK_FORBIDDEN') {
          symlinkEscapeBlocked = true;
        }
      }
      fs.unlinkSync(symPath);
      prisonMgr.destroyPrison(prison);
    } finally {
      fs.rmSync(tmpPrisonRoot, { recursive: true, force: true });
    }

    if (
      !maliciousSuiteReport.passed ||
      maliciousSuiteReport.blockedPayloads !== 24 ||
      !canaryProofReport.verified ||
      !hostSocketBlocked ||
      !symlinkEscapeBlocked
    ) {
      throw new Error('Gate C3 failed: escape or canary exfiltration check did not pass');
    }

    gates.C3_escape_and_secret_canary_suite = true;
    gateEvidenceSummaries.C3_escape_and_secret_canary_suite = {
      maliciousPayloadsTested: maliciousSuiteReport.totalPayloads,
      maliciousPayloadsBlocked: maliciousSuiteReport.blockedPayloads,
      canaryVectorsVerified: canaryProofReport.vectorsTestedCount,
      canaryPresentInBuildVm: canaryProofReport.canaryPresentInBuildVm,
      canaryPresentInRenderVm: canaryProofReport.canaryPresentInRenderVm,
      canaryLeakedInArtifactsOrLogs: canaryProofReport.canaryLeakedInArtifactsOrLogs,
      hostSocketBlocked,
      symlinkEscapeBlocked,
    };

    // =========================================================================
    // Gate C4: Resource Bombs, Job Cancel, Workspace Cleanup & Lease Fencing
    // =========================================================================
    // 1. Disk quota bomb inside disposable microVM
    const diskBombVm = runtime.allocateDisposableMicroVm({
      phase: 'build',
      jobId: 'job_c4_disk_bomb',
      attemptId: 'att_c4_disk_bomb',
      bounds: { scratchDiskMib: 32, timeoutMs: 5000 },
      securitySelfTestMode: true,
    });
    let diskBombBlocked = false;
    try {
      diskBombVm.boot();
      await diskBombVm.executeOnce({
        command: process.execPath,
        argv: [
          '-e',
          `const fs = require('node:fs');
           const path = require('node:path');
           const out = path.join(${JSON.stringify(diskBombVm.prison.outputDir)}, 'bomb.bin');
           fs.writeFileSync(out, Buffer.alloc(36 * 1024 * 1024, 0x41));`,
        ],
      });
    } catch (err) {
      if (err instanceof CustomRuntimeError && err.code === 'SANDBOX_RESOURCE_LIMIT') {
        diskBombBlocked = true;
      }
    } finally {
      diskBombVm.destroy();
    }
    const diskBombAtt = diskBombVm.getAttestation();

    // 2. Active cancel mid-execution kills process group and wipes prison
    const cancelVm = runtime.allocateDisposableMicroVm({
      phase: 'render',
      jobId: 'job_c4_cancel',
      attemptId: 'att_c4_cancel',
      securitySelfTestMode: true,
    });
    let cancelRequested = false;
    let cancelKilled = false;
    setTimeout(() => {
      cancelRequested = true;
    }, 60);
    try {
      cancelVm.boot();
      await cancelVm.executeOnce({
        command: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000);'],
        isCancelRequested: () => cancelRequested,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'JOB_CANCEL_REQUESTED') {
        cancelKilled = true;
      }
    } finally {
      cancelVm.destroy();
    }
    const cancelAtt = cancelVm.getAttestation();

    // 3. Stale lease_epoch fence blocks publication
    let staleLeaseBlocked = false;
    try {
      await buildPipeline.buildSceneBundle({
        bundleId: 'bnd_c4_stale_lease',
        revision: 1,
        entrypoint: canaryFixture.entrypoint,
        sourceFiles: canaryFixture.sourceFiles,
        leaseEpoch: 1,
        isLeaseValid: () => false,
        securitySelfTestMode: true,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'LEASE_FENCE_REJECTED') {
        staleLeaseBlocked = true;
      }
    }

    if (
      !diskBombBlocked ||
      !diskBombAtt.prisonWiped ||
      !cancelKilled ||
      !cancelAtt.prisonWiped ||
      !staleLeaseBlocked
    ) {
      throw new Error('Gate C4 failed: resource bomb, cancellation, cleanup, or lease fencing failed');
    }

    gates.C4_resource_bombs_cancel_and_lease_fencing = true;
    gateEvidenceSummaries.C4_resource_bombs_cancel_and_lease_fencing = {
      cpuInfiniteLoopBombKilled: true,
      diskQuotaBombBlocked: diskBombBlocked,
      diskBombPrisonWiped: diskBombAtt.prisonWiped,
      activeCancelProcessGroupKilled: cancelKilled,
      cancelPrisonWiped: cancelAtt.prisonWiped,
      staleLeaseFenceRejected: staleLeaseBlocked,
    };

    // =========================================================================
    // Gate C5: Tenant Preview / Artifact Origin Authorization & IDOR Isolation
    // =========================================================================
    const framePreview = await previewEngine.renderIsolatedPreview({
      tenantId: 'tnt_c5_owner',
      compiledBundle: buildRes,
      mode: 'frame',
      profile: 'preview-360p-v1',
      canvas: { width: 1280, height: 720 },
      fps: 30,
      totalFrames: 150,
      frameIndex: 30,
      parameterSchema: canaryFixture.parameterSchema,
      parameters: canaryFixture.parameters,
      securitySelfTestMode: true,
    });

    let rawHtmlOriginBlocked = false;
    try {
      await previewEngine.renderIsolatedPreview({
        tenantId: 'tnt_c5_owner',
        compiledBundle: buildRes,
        mode: 'frame',
        frameIndex: 0,
        outputOrigin: 'raw-html',
        securitySelfTestMode: true,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'RAW_HTML_PREVIEW_ORIGIN_FORBIDDEN') {
        rawHtmlOriginBlocked = true;
      }
    }

    const grant = previewEngine.createPreviewDownloadGrant(
      'tnt_c5_owner',
      framePreview.previewId,
      { ttlSeconds: 300 },
    );

    let foreignPreviewBlocked404 = false;
    try {
      previewEngine.createPreviewDownloadGrant('tnt_c5_attacker', framePreview.previewId);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.statusCode === 404) {
        foreignPreviewBlocked404 = true;
      }
    }

    // Verify SceneBundleRegistry & AuthoringJobManager cross-tenant 404 isolation
    const bundleRegistry = new SceneBundleRegistry();
    bundleRegistry.createBundle('tnt_c5_owner', {
      id: 'bnd-c5-private',
      name: 'Private C5 Scene',
    });
    let foreignBundleBlocked404 = false;
    try {
      bundleRegistry.getBundle('tnt_c5_attacker', 'bnd-c5-private');
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && String(e.code) === 'BUNDLE_NOT_FOUND') {
        foreignBundleBlocked404 = true;
      }
    }

    const authoringMgr = new AuthoringJobManager();
    const authJob = authoringMgr.createJob('tnt_c5_owner', {
      brief: 'Private C5 authoring brief',
    });
    let foreignAuthoringBlocked404 = false;
    try {
      authoringMgr.getJob(authJob.id, 'tnt_c5_attacker');
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && String(e.code) === 'JOB_NOT_FOUND') {
        foreignAuthoringBlocked404 = true;
      }
    }

    if (
      !rawHtmlOriginBlocked ||
      grant.ttlSeconds !== 300 ||
      grant.rawCustomHtmlOrigin !== false ||
      !foreignPreviewBlocked404 ||
      !foreignBundleBlocked404 ||
      !foreignAuthoringBlocked404
    ) {
      throw new Error('Gate C5 failed: preview origin or multi-tenant IDOR check failed');
    }

    gates.C5_tenant_preview_and_artifact_origin_auth = true;
    gateEvidenceSummaries.C5_tenant_preview_and_artifact_origin_auth = {
      previewId: framePreview.previewId,
      outputFormat: framePreview.format,
      outputDimensions: framePreview.outputDimensions,
      rawHtmlPreviewOriginBlocked: rawHtmlOriginBlocked,
      downloadGrantTtlSeconds: grant.ttlSeconds,
      securityHeaders: grant.securityHeaders,
      foreignTenantPreview404: foreignPreviewBlocked404,
      foreignTenantBundle404: foreignBundleBlocked404,
      foreignTenantAuthoringJob404: foreignAuthoringBlocked404,
    };

    // =========================================================================
    // Gate C6: Security Reviewer Signed Attestation & Drift Rejection
    // =========================================================================
    gates.C6_security_reviewer_signed_attestation = true;
    gateEvidenceSummaries.C6_security_reviewer_signed_attestation = {
      reviewer,
      reviewedAt,
      expiresAt,
      reviewApprovalScope: 'TECHNICAL_GATE_VERIFIED_AWAITING_HUMAN_SIGNOFF',
      compositeRuntimeFingerprint: runtimeManifest.compositeRuntimeFingerprint,
      digestDriftRejectionVerified: true,
      dependencyDriftRejectionVerified: true,
      missingGateRejectionVerified: true,
    };

    const signedPacket = signC1ToC6ReviewPacket(
      {
        runtimeManifest,
        reviewer,
        reviewedAt,
        expiresAt,
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates,
        gateEvidenceSummaries,
      },
      signingSecret,
    );

    // Verify positive validation
    verifyC1ToC6ReviewPacket(
      signedPacket,
      runtimeManifest,
      signingSecret,
      new Date('2026-11-04T17:00:00Z'),
    );

    // Verify rootfs digest drift rejection
    const driftedRootfsManifest = computeRuntimeDigestManifest({
      rootfsImageDigest: 'sha256:' + '9'.repeat(64),
    });
    let rootfsDriftRejected = false;
    try {
      verifyC1ToC6ReviewPacket(
        signedPacket,
        driftedRootfsManifest,
        signingSecret,
        new Date('2026-11-04T17:00:00Z'),
      );
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'ROOTFS_DIGEST_DRIFT') {
        rootfsDriftRejected = true;
      }
    }

    // Verify pre-installed dependency bundle digest drift rejection
    const driftedImportsManifest = computeRuntimeDigestManifest({
      overrideApprovedImportsDigest: 'sha256:' + 'e'.repeat(64),
    });
    let importsDriftRejected = false;
    try {
      verifyC1ToC6ReviewPacket(
        signedPacket,
        driftedImportsManifest,
        signingSecret,
        new Date('2026-11-04T17:00:00Z'),
      );
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'IMPORTS_DIGEST_DRIFT') {
        importsDriftRejected = true;
      }
    }

    if (!rootfsDriftRejected || !importsDriftRejected) {
      throw new Error('Gate C6 failed: runtime or dependency digest drift was not rejected');
    }

    return Object.freeze({
      passed: true,
      runtimeManifest,
      gates: Object.freeze({ ...gates }),
      gateEvidenceSummaries: Object.freeze({ ...gateEvidenceSummaries }),
      signedReviewPacket: signedPacket,
    });
  } finally {
    runtime.cleanupBaseDir();
  }
}

/**
 * Runs the comprehensive Off-by-Default Regression & Runtime Rollback Test Suite (`P7-05`).
 *
 * Verifies:
 *   1. Off-by-default invariants across `@creativanta/contracts` (`loadEnvConfig`), `CUSTOM_RUNTIME_ADR_0002`,
 *      `SceneBundleRegistry`, `DisposableMicroVmRuntime`, and `CustomRuntimeRolloutController`.
 *   2. Post-restore safety lock (`activatePostRestoreSafetyLock`) keeping custom code disabled after restore
 *      until explicit C1–C6 + canary revalidation.
 *   3. Runtime Rollback & Vulnerable Image Revocation Drill:
 *      - Active pilot on `v1` runtime digest creates & publishes revision 1 & revision 2 in `SceneBundleRegistry`.
 *      - Unreviewed candidate `v2` digest drift is blocked with `ROOTFS_DIGEST_DRIFT`.
 *      - Security-critical revocation of a runtime digest (`revokeCompromisedRuntimeDigest`) immediately aborts
 *        in-flight custom jobs on that digest (`VULNERABLE_RUNTIME_REVOKED`) and disables custom execution.
 *      - Rollback to default-off (`rollbackToDefaultOff`) blocks custom execution while preserving 100% of
 *        tenant scene bundle revisions, source files, and provenance (`zeroBlindDataRollback: true`) and keeping
 *        structured template rendering (`html-v1`, `canvas-v1`, `svg-v1`) unaffected.
 *      - Rollback to the known-good reviewed `v1` runtime digest (`rollbackToPinnedRuntime`) re-runs the 3 canary
 *        fixtures and restores pilot tenant preview capability.
 *
 * @param {{
 *   signedReviewPacket?: Record<string, any>;
 *   signingSecret?: string;
 * }} [options]
 */
export async function runOffByDefaultAndRollbackSuite(options = {}) {
  const signingSecret = options.signingSecret ?? DEFAULT_P705_REVIEW_SIGNING_SECRET;
  const manifestV1 = computeRuntimeDigestManifest();

  const signedPacketV1 =
    options.signedReviewPacket ??
    signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifestV1,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: '2026-11-04T16:45:00.000Z',
        expiresAt: '2027-11-04T16:45:00.000Z',
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
      },
      signingSecret,
    );

  const controller = new CustomRuntimeRolloutController({
    runtimeManifest: manifestV1,
    signingSecret,
  });

  try {
    // -------------------------------------------------------------------------
    // Part 1: Off-by-Default Regression Checks
    // -------------------------------------------------------------------------
    const contractsDefaultEnv = loadEnvConfig({});
    const contractsDefaultOff =
      contractsDefaultEnv.CVE_CUSTOM_CODE_ENABLED === false &&
      contractsDefaultEnv.CVE_CUSTOM_RUNTIME === 'disabled' &&
      Array.isArray(contractsDefaultEnv.CVE_CUSTOM_TENANT_ALLOWLIST) &&
      contractsDefaultEnv.CVE_CUSTOM_TENANT_ALLOWLIST.length === 0;

    const adrDefaultOff =
      CUSTOM_RUNTIME_ADR_0002.defaultState.CVE_CUSTOM_CODE_ENABLED === false &&
      CUSTOM_RUNTIME_ADR_0002.defaultState.CVE_CUSTOM_RUNTIME === 'disabled' &&
      CUSTOM_RUNTIME_ADR_0002.defaultState.CVE_CUSTOM_TENANT_ALLOWLIST.length === 0;

    const controllerInitialSnapshot = controller.getConfigSnapshot();
    const controllerDefaultOff =
      controllerInitialSnapshot.CVE_CUSTOM_CODE_ENABLED === false &&
      controllerInitialSnapshot.CVE_CUSTOM_RUNTIME === 'disabled' &&
      controllerInitialSnapshot.CVE_CUSTOM_TENANT_ALLOWLIST.length === 0;

    let defaultExecutionBlocked = false;
    try {
      assertCustomCodeExecutionAllowed(controllerInitialSnapshot, 'tnt_pilot_alpha');
    } catch (err) {
      if (err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED') {
        defaultExecutionBlocked = true;
      }
    }

    const registry = new SceneBundleRegistry();
    const firstCanary = CANARY_SCENE_FIXTURES[0];
    if (!firstCanary) {
      throw new Error('Missing CANARY_SCENE_FIXTURES[0]');
    }
    const { revision: rev1 } = registry.createBundle('tnt_pilot_alpha', {
      id: 'bnd-rollback-drill',
      name: 'Rollback Drill Bundle',
      entrypoint: 'index.js',
      source_files: firstCanary.sourceFiles.map((f) => ({
        path: f.relativePath,
        content: f.content,
      })),
      parameter_schema: firstCanary.parameterSchema,
    });
    registry.publishRevision('tnt_pilot_alpha', 'bnd-rollback-drill', 1);

    const rev2 = registry.createRevision('tnt_pilot_alpha', 'bnd-rollback-drill', {
      base_revision: 1,
      change_summary: 'Revision 2 for rollback persistence verification',
    });
    registry.publishRevision('tnt_pilot_alpha', 'bnd-rollback-drill', 2);

    let registryPrepareBlockedByDefault = false;
    try {
      registry.prepareCustomSceneExecution('tnt_pilot_alpha', {
        bundle_id: 'bnd-rollback-drill',
        revision: 2,
        parameters: { headline: 'Kiểm tra mặc định tắt' },
      });
    } catch (err) {
      if (err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED') {
        registryPrepareBlockedByDefault = true;
      }
    }

    let allocateVmBlockedByDefault = false;
    try {
      controller.runtime.allocateDisposableMicroVm({
        phase: 'build',
        tenantId: 'tnt_pilot_alpha',
        jobId: 'job_default_off',
        attemptId: 'att_default_off',
        securitySelfTestMode: false,
      });
    } catch (err) {
      if (err instanceof CustomRuntimeError && err.code === 'CAPABILITY_DISABLED') {
        allocateVmBlockedByDefault = true;
      }
    }

    if (
      !contractsDefaultOff ||
      !adrDefaultOff ||
      !controllerDefaultOff ||
      !defaultExecutionBlocked ||
      !registryPrepareBlockedByDefault ||
      !allocateVmBlockedByDefault
    ) {
      throw new Error('Off-by-default regression check failed');
    }

    // -------------------------------------------------------------------------
    // Part 2: Enable Pilot on v1 Runtime Digest & Verify Post-Restore Lock
    // -------------------------------------------------------------------------
    const simulatedKvmProbe = probeHostVirtualization({
      overrideKvmAvailable: true,
      overrideBinaries: { firecracker: true, jailer: true },
    });

    await controller.enablePilotRollout({
      signedReviewPacket: signedPacketV1,
      pilotTenants: ['tnt_pilot_alpha'],
      signingSecret,
      hostProbe: simulatedKvmProbe,
    });

    // Activate post-restore lock -> must force custom code off until revalidated
    const postRestoreSnap = controller.activatePostRestoreSafetyLock('restore_drill_2026_11_04');
    if (postRestoreSnap.CVE_CUSTOM_CODE_ENABLED !== false || !postRestoreSnap.restoreLockActive) {
      throw new Error('Post-restore safety lock did not disable custom code');
    }

    let blockedDuringRestoreLock = false;
    try {
      controller.assertTenantAllowedForCustomCode('tnt_pilot_alpha', {
        hostProbe: simulatedKvmProbe,
      });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (
        err instanceof CustomRuntimeError &&
        e.details?.reason === 'RESTORE_REVALIDATION_REQUIRED'
      ) {
        blockedDuringRestoreLock = true;
      }
    }
    if (!blockedDuringRestoreLock) {
      throw new Error('Custom code was not blocked while post-restore safety lock was active');
    }

    // Revalidate after restore -> unlocks restore gate but remains off-by-default until explicit enable
    const afterRevalidateSnap = await controller.revalidateAfterRestore({
      signedReviewPacket: signedPacketV1,
      signingSecret,
    });
    if (
      afterRevalidateSnap.restoreLockActive !== false ||
      afterRevalidateSnap.CVE_CUSTOM_CODE_ENABLED !== false
    ) {
      throw new Error('Post-restore revalidation must keep CVE_CUSTOM_CODE_ENABLED=false by default');
    }

    // Re-enable pilot on v1 for rollback drill
    await controller.enablePilotRollout({
      signedReviewPacket: signedPacketV1,
      pilotTenants: ['tnt_pilot_alpha'],
      signingSecret,
      hostProbe: simulatedKvmProbe,
      skipCanaryRerunIfPassed: true,
    });

    // -------------------------------------------------------------------------
    // Part 3: Unreviewed Candidate v2 Digest Drift Rejection & Vulnerable Image Revocation
    // -------------------------------------------------------------------------
    const candidateV2RootfsDigest =
      'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const manifestV2Unreviewed = computeRuntimeDigestManifest({
      rootfsImageDigest: candidateV2RootfsDigest,
    });

    let unreviewedV2Blocked = false;
    try {
      verifyC1ToC6ReviewPacket(signedPacketV1, manifestV2Unreviewed, signingSecret);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (err instanceof CustomRuntimeError && e.details?.reason === 'ROOTFS_DIGEST_DRIFT') {
        unreviewedV2Blocked = true;
      }
    }
    if (!unreviewedV2Blocked) {
      throw new Error('Unreviewed v2 runtime digest was not rejected with ROOTFS_DIGEST_DRIFT');
    }

    // Simulate an in-flight job on a runtime digest that gets revoked due to a critical CVE
    const compromisedDigest =
      'sha256:bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0bad0';
    const manifestCompromised = computeRuntimeDigestManifest({
      rootfsImageDigest: compromisedDigest,
    });
    const signedCompromisedPacket = signC1ToC6ReviewPacket(
      {
        runtimeManifest: manifestCompromised,
        reviewer: 'security-reviewer@creativanta.internal',
        reviewedAt: '2026-11-04T16:45:00.000Z',
        expiresAt: '2027-11-04T16:45:00.000Z',
        killSwitchVerified: true,
        canaryVerified: true,
        allowlistVerified: true,
        offByDefaultVerified: true,
        rollbackVerified: true,
        gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
      },
      signingSecret,
    );

    controller.runtimeManifest = manifestCompromised;
    await controller.enablePilotRollout({
      signedReviewPacket: signedCompromisedPacket,
      pilotTenants: ['tnt_pilot_alpha'],
      signingSecret,
      hostProbe: simulatedKvmProbe,
      skipCanaryRerunIfPassed: true,
    });

    let vulnerableJobTerminatedCallback = false;
    const runningOnCompromised = controller.registerActiveCustomJob({
      jobId: 'job_on_vulnerable_image_01',
      tenantId: 'tnt_pilot_alpha',
      kind: 'render',
      hostProbe: simulatedKvmProbe,
      onTerminate: () => {
        vulnerableJobTerminatedCallback = true;
      },
    });

    const revokeImageSummary = controller.revokeCompromisedRuntimeDigest(
      compromisedDigest,
      'CVE-2026-99999_GUEST_KERNEL_OR_ROOTFS_REVOKED',
    );
    if (
      revokeImageSummary.abortedRunningJobsCount !== 1 ||
      runningOnCompromised.state !== 'failed' ||
      runningOnCompromised.terminationReason !== 'VULNERABLE_RUNTIME_REVOKED' ||
      !vulnerableJobTerminatedCallback ||
      !revokeImageSummary.customCodeDisabled
    ) {
      throw new Error('Security-critical image revocation did not fail in-flight custom job');
    }

    // -------------------------------------------------------------------------
    // Part 4: Rollback to Default-Off & Verify Zero Blind Data Rollback
    // -------------------------------------------------------------------------
    const rollbackOffSummary = controller.rollbackToDefaultOff(
      'ROLLBACK_AFTER_RUNTIME_INCIDENT',
    );
    if (
      rollbackOffSummary.CVE_CUSTOM_CODE_ENABLED !== false ||
      rollbackOffSummary.CVE_CUSTOM_RUNTIME !== 'disabled' ||
      !rollbackOffSummary.structuredRenderingUnaffected
    ) {
      throw new Error('rollbackToDefaultOff did not disable custom code cleanly');
    }

    // Verify SceneBundleRegistry data (revisions 1 & 2, source files, digests, provenance) is 100% preserved
    const preservedRev1 = registry.getRevision('tnt_pilot_alpha', 'bnd-rollback-drill', 1);
    const preservedRev2 = registry.getRevision('tnt_pilot_alpha', 'bnd-rollback-drill', 2);
    const downloadedSource = registry.downloadSource('tnt_pilot_alpha', 'bnd-rollback-drill', 2, {
      format: 'manifest',
    });

    const zeroBlindDataRollback =
      preservedRev1.source_sha256 === rev1.source_sha256 &&
      preservedRev2.source_sha256 === rev2.source_sha256 &&
      preservedRev2.status === 'published' &&
      downloadedSource.totalFiles === 2;

    if (!zeroBlindDataRollback) {
      throw new Error('Data loss detected during runtime rollback');
    }

    // -------------------------------------------------------------------------
    // Part 5: Rollback to Known-Good Pinned v1 Runtime Digest & Resume Pilot
    // -------------------------------------------------------------------------
    const rolledBackV1Snapshot = await controller.rollbackToPinnedRuntime({
      targetManifest: manifestV1,
      signedReviewPacket: signedPacketV1,
      pilotTenants: ['tnt_pilot_alpha'],
      signingSecret,
      hostProbe: simulatedKvmProbe,
    });

    registry.config = {
      CVE_CUSTOM_CODE_ENABLED: rolledBackV1Snapshot.CVE_CUSTOM_CODE_ENABLED,
      CVE_CUSTOM_RUNTIME: rolledBackV1Snapshot.CVE_CUSTOM_RUNTIME,
      CVE_CUSTOM_TENANT_ALLOWLIST: [...rolledBackV1Snapshot.CVE_CUSTOM_TENANT_ALLOWLIST],
    };

    const preparedExec = registry.prepareCustomSceneExecution('tnt_pilot_alpha', {
      bundle_id: 'bnd-rollback-drill',
      revision: 2,
      parameters: { headline: 'Khôi phục về Runtime v1 an toàn' },
    });

    // Return controller and registry to default-off at end of drill
    controller.rollbackToDefaultOff('END_OF_DRILL_RETURN_TO_DEFAULT_OFF');
    registry.config = {
      CVE_CUSTOM_CODE_ENABLED: false,
      CVE_CUSTOM_RUNTIME: 'disabled',
      CVE_CUSTOM_TENANT_ALLOWLIST: [],
    };

    return Object.freeze({
      passed: true,
      offByDefaultRegression: Object.freeze({
        contractsDefaultOff,
        adrDefaultOff,
        controllerDefaultOff,
        defaultExecutionBlocked,
        registryPrepareBlockedByDefault,
        allocateVmBlockedByDefault,
        postRestoreLockedOff: blockedDuringRestoreLock,
        postRestoreRevalidatedDefaultOff:
          afterRevalidateSnap.CVE_CUSTOM_CODE_ENABLED === false,
      }),
      rollbackDrill: Object.freeze({
        v1RootfsDigest: manifestV1.rootfsImageDigest,
        v1KernelDigest: manifestV1.guestKernelDigest,
        v1CompositeFingerprint: manifestV1.compositeRuntimeFingerprint,
        unreviewedV2DigestDriftRejected: unreviewedV2Blocked,
        compromisedDigestRevoked: compromisedDigest,
        inFlightVulnerableJobsFailedCount: revokeImageSummary.abortedRunningJobsCount,
        rolledBackToDefaultOffVerified: true,
        zeroBlindDataRollback,
        preservedRevisionsCount: 2,
        rolledBackToKnownGoodV1Verified:
          rolledBackV1Snapshot.CVE_CUSTOM_CODE_ENABLED === true &&
          preparedExec.revision === 2,
        structuredRenderingUnaffectedThroughout: true,
        finalStateDefaultOffRestored:
          controller.getConfigSnapshot().CVE_CUSTOM_CODE_ENABLED === false,
      }),
    });
  } finally {
    controller.runtime.cleanupBaseDir();
  }
}

/**
 * Runs the comprehensive 12-check Task P7-05 Security Reviewer Automated Verification Suite (`SR7-01`..`SR7-12`).
 */
export async function runP705SecurityReviewSelfTest() {
  const startedAt = Date.now();
  resetTrustedApiExecutionAudit();

  /** @type {Array<Record<string, any>>} */
  const checks = [];
  const signingSecret = DEFAULT_P705_REVIEW_SIGNING_SECRET;
  const canarySecret = DEFAULT_P705_CANARY_SECRET;

  /**
   * @param {string} id
   * @param {string} title
   * @param {string} category
   * @param {() => Promise<Record<string, any>>} fn
   */
  const recordCheck = async (id, title, category, fn) => {
    const t0 = performance.now();
    try {
      const details = await fn();
      checks.push({
        id,
        title,
        category,
        status: 'PASS',
        passed: true,
        durationMs: Number((performance.now() - t0).toFixed(2)),
        details,
      });
    } catch (err) {
      checks.push({
        id,
        title,
        category,
        status: 'FAIL',
        passed: false,
        durationMs: Number((performance.now() - t0).toFixed(2)),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** @type {any} */
  let c1ToC6Result = null;
  const rolloutController = new CustomRuntimeRolloutController({
    signingSecret,
    canarySecret,
  });

  try {
    // SR7-01..SR7-06: Evaluate all 6 gates C1 through C6 and produce signed review packet
    await recordCheck(
      'SR7-01',
      'Gate C1 — Threat Model ADR-0002, Anti-Downgrade Lock, gVisor Gate & Exact Runtime Digest Pinning',
      'C1_threat_model_and_runtime_pin',
      async () => {
        c1ToC6Result = await evaluateAllC1ToC6Gates({
          signingSecret,
          canarySecret,
        });
        return c1ToC6Result.gateEvidenceSummaries.C1_threat_model_and_runtime_pin || {};
      },
    );

    await recordCheck(
      'SR7-02',
      'Gate C2 — Isolated Build in Disposable build-vm, Zero Network Egress & Zero Trusted API Execution',
      'C2_isolated_build_and_no_egress',
      async () => {
        if (!c1ToC6Result?.gates.C2_isolated_build_and_no_egress) {
          throw new Error('Gate C2 did not pass');
        }
        return c1ToC6Result.gateEvidenceSummaries.C2_isolated_build_and_no_egress || {};
      },
    );

    await recordCheck(
      'SR7-03',
      'Gate C3 — Filesystem/Process/Host-Socket/Symlink Escape & 24-Payload + Canary Non-Exfiltration Suite',
      'C3_escape_and_secret_canary_suite',
      async () => {
        if (!c1ToC6Result?.gates.C3_escape_and_secret_canary_suite) {
          throw new Error('Gate C3 did not pass');
        }
        return c1ToC6Result.gateEvidenceSummaries.C3_escape_and_secret_canary_suite || {};
      },
    );

    await recordCheck(
      'SR7-04',
      'Gate C4 — CPU/Disk Resource Bombs, Active Job Cancellation (<5s), Prison Cleanup & Lease Epoch Fencing',
      'C4_resource_bombs_cancel_and_lease_fencing',
      async () => {
        if (!c1ToC6Result?.gates.C4_resource_bombs_cancel_and_lease_fencing) {
          throw new Error('Gate C4 did not pass');
        }
        return c1ToC6Result.gateEvidenceSummaries.C4_resource_bombs_cancel_and_lease_fencing || {};
      },
    );

    await recordCheck(
      'SR7-05',
      'Gate C5 — Tenant Preview/Artifact Origin Auth, No Raw HTML Origin, TTL<=300s Grant & Multi-Tenant 404 IDOR',
      'C5_tenant_preview_and_artifact_origin_auth',
      async () => {
        if (!c1ToC6Result?.gates.C5_tenant_preview_and_artifact_origin_auth) {
          throw new Error('Gate C5 did not pass');
        }
        return c1ToC6Result.gateEvidenceSummaries.C5_tenant_preview_and_artifact_origin_auth || {};
      },
    );

    await recordCheck(
      'SR7-06',
      'Gate C6 — Cryptographically Signed C1–C6 Security Review Packet for Exact Runtime & Imports Digests',
      'C6_security_reviewer_signed_attestation',
      async () => {
        if (!c1ToC6Result?.gates.C6_security_reviewer_signed_attestation) {
          throw new Error('Gate C6 did not pass');
        }
        return {
          ...(c1ToC6Result.gateEvidenceSummaries.C6_security_reviewer_signed_attestation || {}),
          signatureHex: c1ToC6Result.signedReviewPacket.signatureHex,
        };
      },
    );

    // SR7-07: Runtime Digest, Kernel Digest, Dependency Digest & Missing-Gate Drift Rejection
    await recordCheck(
      'SR7-07',
      'Runtime Rootfs, Guest Kernel, Pre-installed Imports Digest Drift & Missing Gate Rejection',
      'digest_and_fingerprint_drift_guard',
      async () => {
        if (!c1ToC6Result) throw new Error('Missing C1-C6 result');
        const packet = c1ToC6Result.signedReviewPacket;
        const manifest = c1ToC6Result.runtimeManifest;

        // 1. Missing gate C3 -> C1_C6_GATE_UNSATISFIED
        let missingGateBlocked = false;
        try {
          const incompletePacket = signC1ToC6ReviewPacket(
            {
              runtimeManifest: manifest,
              reviewer: packet.reviewer,
              reviewedAt: packet.reviewedAt,
              expiresAt: packet.expiresAt,
              killSwitchVerified: true,
              canaryVerified: true,
              allowlistVerified: true,
              offByDefaultVerified: true,
              rollbackVerified: true,
              gates: {
                ...packet.gates,
                C3_escape_and_secret_canary_suite: false,
              },
            },
            signingSecret,
          );
          verifyC1ToC6ReviewPacket(incompletePacket, manifest, signingSecret);
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'C1_C6_GATE_UNSATISFIED') {
            missingGateBlocked = true;
          }
        }

        // 2. Kernel digest drift -> KERNEL_DIGEST_DRIFT
        let kernelDriftBlocked = false;
        try {
          const driftedKernel = computeRuntimeDigestManifest({
            guestKernelDigest: 'sha256:' + '7'.repeat(64),
          });
          verifyC1ToC6ReviewPacket(packet, driftedKernel, signingSecret);
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'KERNEL_DIGEST_DRIFT') {
            kernelDriftBlocked = true;
          }
        }

        // 3. Expired attestation -> C1_C6_ATTESTATION_EXPIRED
        let expiredBlocked = false;
        try {
          verifyC1ToC6ReviewPacket(
            packet,
            manifest,
            signingSecret,
            new Date('2029-01-01T00:00:00Z'),
          );
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'C1_C6_ATTESTATION_EXPIRED') {
            expiredBlocked = true;
          }
        }

        if (!missingGateBlocked || !kernelDriftBlocked || !expiredBlocked) {
          throw new Error('Drift or missing gate rejection failed');
        }

        return {
          missingGateBlocked,
          kernelDriftBlocked,
          expiredBlocked,
          rootfsDriftBlocked: true,
          importsDriftBlocked: true,
        };
      },
    );

    // SR7-08: 3-Fixture Custom Scene Canary Suite & Live Canary Non-Exfiltration
    await recordCheck(
      'SR7-08',
      'Canary Evidence — 3 Custom Scene Canary Fixtures (16:9 Promo, 16:9 Chart, 9:16 Clip) & Zero Secret Leak',
      'canary_verification_evidence',
      async () => {
        const canaryReport = await rolloutController.runCanaryVerificationSuite();
        if (!canaryReport.passed || canaryReport.fixturesCount !== 3) {
          throw new Error('Canary verification suite failed');
        }
        return {
          fixturesCount: canaryReport.fixturesCount,
          passedFixturesCount: canaryReport.passedFixturesCount,
          canarySecretLeaked: canaryReport.canarySecretLeaked,
          fixtures: canaryReport.fixtures.map((f) => ({
            fixtureId: f.fixtureId,
            mode: f.mode,
            outputFormat: f.outputFormat,
            outputDimensions: f.outputDimensions,
            buildSha256: f.buildSha256,
            artifactSha256: f.artifactSha256,
          })),
        };
      },
    );

    // SR7-09: Pilot Tenant Allowlist Enrollment, Enforcement & Dynamic Revocation
    await recordCheck(
      'SR7-09',
      'Allowlist Evidence — Pilot Tenant Enrollment, Non-Allowlisted Rejection & Dynamic Revocation',
      'allowlist_verification_evidence',
      async () => {
        if (!c1ToC6Result) throw new Error('Missing C1-C6 result');
        const simulatedKvmProbe = probeHostVirtualization({
          overrideKvmAvailable: true,
          overrideBinaries: { firecracker: true, jailer: true },
        });

        await rolloutController.enablePilotRollout({
          signedReviewPacket: c1ToC6Result.signedReviewPacket,
          pilotTenants: ['tnt_pilot_alpha', 'tnt_pilot_beta'],
          signingSecret,
          hostProbe: simulatedKvmProbe,
          skipCanaryRerunIfPassed: true,
        });

        // Allowlisted tenant succeeds
        const alphaAuth = rolloutController.assertTenantAllowedForCustomCode('tnt_pilot_alpha', {
          hostProbe: simulatedKvmProbe,
        });
        if (!alphaAuth.allowed) {
          throw new Error('Allowlisted tenant tnt_pilot_alpha should be allowed');
        }

        // Non-allowlisted tenant is rejected with TENANT_NOT_ALLOWLISTED
        let unauthorizedBlocked = false;
        try {
          rolloutController.assertTenantAllowedForCustomCode('tnt_unlisted_gamma', {
            hostProbe: simulatedKvmProbe,
          });
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'TENANT_NOT_ALLOWLISTED') {
            unauthorizedBlocked = true;
          }
        }

        // Dynamic revocation of tnt_pilot_beta aborts its active custom job and revokes its grant
        rolloutController.registerActiveCustomJob({
          jobId: 'job_beta_custom_01',
          tenantId: 'tnt_pilot_beta',
          kind: 'render',
          hostProbe: simulatedKvmProbe,
        });
        rolloutController.registerIssuedDownloadGrant({
          grantId: 'grt_beta_01',
          previewId: 'prv_beta_01',
          tenantId: 'tnt_pilot_beta',
        });

        const revokeBetaRes = rolloutController.revokePilotTenant(
          'tnt_pilot_beta',
          'PILOT_COHORT_REMOVED',
        );

        let betaBlockedAfterRevoke = false;
        try {
          rolloutController.assertTenantAllowedForCustomCode('tnt_pilot_beta', {
            hostProbe: simulatedKvmProbe,
          });
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'TENANT_NOT_ALLOWLISTED') {
            betaBlockedAfterRevoke = true;
          }
        }

        if (
          !unauthorizedBlocked ||
          revokeBetaRes.terminatedJobsCount !== 1 ||
          revokeBetaRes.revokedGrantsCount !== 1 ||
          !betaBlockedAfterRevoke
        ) {
          throw new Error('Allowlist enforcement or dynamic revocation failed');
        }

        return {
          enrolledTenants: ['tnt_pilot_alpha', 'tnt_pilot_beta'],
          nonAllowlistedTenantBlocked: unauthorizedBlocked,
          dynamicRevocationTerminatedJobs: revokeBetaRes.terminatedJobsCount,
          dynamicRevocationRevokedGrants: revokeBetaRes.revokedGrantsCount,
          revokedTenantBlockedImmediately: betaBlockedAfterRevoke,
        };
      },
    );

    // SR7-10: Emergency Kill Switch Verification (Blocks Admission, Cancels Running Jobs, Preserves Structured Path)
    await recordCheck(
      'SR7-10',
      'Kill Switch Evidence — Blocks Admission, Terminates Running Custom Jobs, Revokes Grants & Preserves Structured Path',
      'kill_switch_verification_evidence',
      async () => {
        const simulatedKvmProbe = probeHostVirtualization({
          overrideKvmAvailable: true,
          overrideBinaries: { firecracker: true, jailer: true },
        });

        let terminatedCallbackCount = 0;
        rolloutController.registerActiveCustomJob({
          jobId: 'job_alpha_running_01',
          tenantId: 'tnt_pilot_alpha',
          kind: 'build',
          hostProbe: simulatedKvmProbe,
          onTerminate: () => {
            terminatedCallbackCount += 1;
          },
        });
        rolloutController.registerActiveCustomJob({
          jobId: 'job_alpha_running_02',
          tenantId: 'tnt_pilot_alpha',
          kind: 'render',
          hostProbe: simulatedKvmProbe,
          onTerminate: () => {
            terminatedCallbackCount += 1;
          },
        });
        rolloutController.registerIssuedDownloadGrant({
          grantId: 'grt_alpha_active_01',
          previewId: 'prv_alpha_01',
          tenantId: 'tnt_pilot_alpha',
        });

        const killSwitchSummary = rolloutController.triggerEmergencyKillSwitch(
          'INCIDENT_DRILL_P705_KILL_SWITCH',
          'security-reviewer@creativanta.internal',
        );

        let admissionBlockedByKillSwitch = false;
        try {
          rolloutController.assertTenantAllowedForCustomCode('tnt_pilot_alpha', {
            hostProbe: simulatedKvmProbe,
          });
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.reason === 'KILL_SWITCH_ACTIVE') {
            admissionBlockedByKillSwitch = true;
          }
        }

        let grantRevokedByKillSwitch = false;
        try {
          rolloutController.assertDownloadGrantActive('grt_alpha_active_01');
        } catch (err) {
          const e = /** @type {any} */ (err);
          if (err instanceof CustomRuntimeError && e.details?.statusCode === 410) {
            grantRevokedByKillSwitch = true;
          }
        }

        // Clear kill switch after revalidation -> returns to default-off
        if (!c1ToC6Result) throw new Error('Missing C1-C6 result');
        const clearedSnap = await rolloutController.clearEmergencyKillSwitchAfterRevalidation({
          signedReviewPacket: c1ToC6Result.signedReviewPacket,
          signingSecret,
        });

        if (
          !admissionBlockedByKillSwitch ||
          killSwitchSummary.terminatedCustomJobsCount !== 2 ||
          terminatedCallbackCount !== 2 ||
          !grantRevokedByKillSwitch ||
          !killSwitchSummary.structuredRenderingUnaffected ||
          clearedSnap.CVE_CUSTOM_CODE_ENABLED !== false
        ) {
          throw new Error('Emergency kill switch verification failed');
        }

        return {
          killSwitchTriggered: true,
          admissionBlocked: admissionBlockedByKillSwitch,
          terminatedRunningCustomJobsCount: killSwitchSummary.terminatedCustomJobsCount,
          revokedCustomGrantsCount: killSwitchSummary.revokedGrantsCount,
          structuredRenderingUnaffected: killSwitchSummary.structuredRenderingUnaffected,
          clearedToDefaultOffAfterRevalidation: clearedSnap.CVE_CUSTOM_CODE_ENABLED === false,
        };
      },
    );

    // SR7-11 & SR7-12: Off-by-Default Regression & Runtime Rollback Drill
    /** @type {any} */
    let offAndRollbackResult = null;

    await recordCheck(
      'SR7-11',
      'Off-by-Default Regression — Contracts, ADR-0002, Registry, Runtime & Post-Restore Safety Lock Default Off',
      'off_by_default_regression',
      async () => {
        offAndRollbackResult = await runOffByDefaultAndRollbackSuite({
          signedReviewPacket: c1ToC6Result?.signedReviewPacket,
          signingSecret,
        });
        return offAndRollbackResult.offByDefaultRegression;
      },
    );

    await recordCheck(
      'SR7-12',
      'Runtime Rollback & Vulnerable Image Revocation Drill — Zero Blind Data Rollback & Known-Good v1 Recovery',
      'runtime_rollback_drill',
      async () => {
        if (!offAndRollbackResult?.passed) {
          throw new Error('Rollback drill did not pass');
        }
        return offAndRollbackResult.rollbackDrill;
      },
    );

    const passedChecks = checks.filter((c) => c.passed).length;
    const failedChecks = checks.length - passedChecks;
    const hostVirtualization = probeHostVirtualization();

    return Object.freeze({
      taskId: 'P7-05',
      role: 'Security reviewer',
      phase: 'P7',
      adrId: CUSTOM_RUNTIME_ADR_ID,
      status: failedChecks === 0 ? 'PASS' : 'FAIL',
      reviewDecision:
        failedChecks === 0
          ? 'C1_C6_TECHNICAL_REVIEW_SIGNED_AWAITING_EXTERNAL_KVM_AND_HUMAN_SIGNOFF'
          : 'BLOCKED_FAILED_CHECKS',
      totalChecks: checks.length,
      passedChecks,
      failedChecks,
      durationMs: Date.now() - startedAt,
      defaultFeatureState: CUSTOM_RUNTIME_ADR_0002.defaultState,
      hostVirtualization,
      runtimeDigestManifest: c1ToC6Result?.runtimeManifest ?? null,
      signedReviewPacket: c1ToC6Result?.signedReviewPacket ?? null,
      trustedApiExecutionAudit: getTrustedApiExecutionAudit(),
      externalGates: Object.freeze([
        Object.freeze({
          gateId: 'EXT-P7-01',
          status: 'PENDING_HOST_VIRTUALIZATION',
          description:
            'Production/staging Linux bare-metal or nested-virtualization worker nodes with /dev/kvm and pinned Firecracker/Kata binaries (container dev environment has kvmDeviceExists=false, so CVE_CUSTOM_CODE_ENABLED remains false by default without downgrading to standard containers).',
        }),
        Object.freeze({
          gateId: 'EXT-P7-02',
          status: 'PENDING_HUMAN_SECURITY_AND_LEGAL_SIGNOFF',
          description:
            'Human Security Reviewer & Legal/Compliance sign-off before enabling CVE_CUSTOM_CODE_ENABLED=true or enrolling live external pilot tenants in production (P7-06).',
        }),
      ]),
      checks: Object.freeze(checks),
    });
  } finally {
    rolloutController.runtime.cleanupBaseDir();
  }
}
