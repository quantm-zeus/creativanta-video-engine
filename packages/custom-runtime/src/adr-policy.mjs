/**
 * Custom Scene Runtime ADR 0002 Policy, Host Virtualization Probe,
 * Anti-Downgrade Lock, gVisor Explicit Review Gate & C1-C6 Attestation Verifier (Task P7-01).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (lines 41-56: Arbitrary agent/user code default disabled, disposable microVM,
 *     gVisor explicit review without downgrade, C1-C6 security release gates)
 *   - docs/DEPLOYMENT.md (lines 14, 89-91: CVE_CUSTOM_CODE_ENABLED, CVE_CUSTOM_RUNTIME, CVE_CUSTOM_TENANT_ALLOWLIST)
 *   - docs/IMPLEMENTATION_PLAN.md (line 113: Task P7-01 deliverable & acceptance)
 *   - packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SandboxError, IMAGE_DIGEST_REGEX, DEV_PLACEHOLDER_DIGEST } from '../../controller/dist/index.js';

export const CUSTOM_RUNTIME_ADR_ID = 'ADR-0002';

export const APPROVED_MICROVM_RUNTIMES = Object.freeze([
  'microvm-firecracker-v1',
  'microvm-kata-v1',
]);

export const CONDITIONAL_ALTERNATIVE_RUNTIMES = Object.freeze([
  'gvisor-runsc-v1',
]);

export const FORBIDDEN_DOWNGRADE_RUNTIMES = Object.freeze([
  'docker',
  'runc',
  'crun',
  'containerd',
  'podman',
  'lxc',
  'node-vm',
  'vm',
  'iframe',
  'host',
  'process',
  'trusted-template-v1',
  'standard-container',
  'simulated-microvm-prison',
]);

export const REQUIRED_C1_TO_C6_GATES = Object.freeze([
  'C1_threat_model_and_runtime_pin',
  'C2_isolated_build_and_no_egress',
  'C3_escape_and_secret_canary_suite',
  'C4_resource_bombs_cancel_and_lease_fencing',
  'C5_tenant_preview_and_artifact_origin_auth',
  'C6_security_reviewer_signed_attestation',
]);

export const CUSTOM_RUNTIME_ADR_0002 = Object.freeze({
  adrId: CUSTOM_RUNTIME_ADR_ID,
  taskId: 'P7-01',
  title: 'Disposable MicroVM Isolation for Untrusted Custom Scene Build & Render',
  status: 'ACCEPTED_FOR_P7_ISOLATION_GATE',
  date: '2026-11-04',
  defaultState: Object.freeze({
    CVE_CUSTOM_CODE_ENABLED: false,
    CVE_CUSTOM_RUNTIME: 'disabled',
    CVE_CUSTOM_TENANT_ALLOWLIST: Object.freeze([]),
  }),
  preferredRuntimes: Object.freeze([
    Object.freeze({
      id: 'microvm-firecracker-v1',
      isolationClass: 'hardware-virtualized-microvm',
      vmm: 'firecracker+jailer',
      requiresKvm: true,
      disposablePerBuild: true,
      disposablePerRenderAttempt: true,
      innerNonRootUid: 10001,
      innerNonRootGid: 10001,
      innerChromiumSandboxRequired: true,
      networkInterfacesCount: 0,
      status: 'APPROVED_PRIMARY',
    }),
    Object.freeze({
      id: 'microvm-kata-v1',
      isolationClass: 'hardware-virtualized-microvm',
      vmm: 'kata-runtime-qemu-or-cloud-hypervisor',
      requiresKvm: true,
      disposablePerBuild: true,
      disposablePerRenderAttempt: true,
      innerNonRootUid: 10001,
      innerNonRootGid: 10001,
      innerChromiumSandboxRequired: true,
      networkInterfacesCount: 0,
      status: 'APPROVED_SECONDARY',
    }),
  ]),
  alternativeRuntimes: Object.freeze([
    Object.freeze({
      id: 'gvisor-runsc-v1',
      isolationClass: 'application-kernel-sandbox',
      vmm: 'runsc-sentry-gofer',
      requiresExplicitAdrAmendment: true,
      requiresSignedSecurityReview: true,
      requiresEscapeAndCompatibilityBenchmarks: true,
      tradeoffs: Object.freeze([
        'User-space Sentry kernel intercepts Linux syscalls via systrap/kvm platform, adding CPU/IPC overhead for Chromium multi-process rendering.',
        'Gofer file proxy adds I/O latency for frame capture and FFmpeg muxing; RTF <= 6 target not yet benchmarked on gVisor.',
        'Certain advanced Linux syscalls (io_uring, specialized clone3/shm flags) are emulated or restricted in Sentry.',
      ]),
      status: 'REQUIRES_EXPLICIT_SECURITY_REVIEW',
    }),
  ]),
  antiDowngradePolicy: Object.freeze({
    allowFallbackToStandardContainer: false,
    allowFallbackToNodeVmOrIframe: false,
    allowFallbackToHostProcess: false,
    onMissingVirtualization: 'KEEP_CUSTOM_CODE_DISABLED',
    forbiddenRuntimes: FORBIDDEN_DOWNGRADE_RUNTIMES,
  }),
  requiredReleaseGates: REQUIRED_C1_TO_C6_GATES,
});

export class CustomRuntimeError extends SandboxError {
  /**
   * @param {'SANDBOX_SECURITY_VIOLATION'|'SANDBOX_RESOURCE_LIMIT'|'CAPABILITY_DISABLED'|'RENDER_TIMEOUT'|'FRAME_READINESS_TIMEOUT'|'ENCODE_VERIFICATION_FAILED'} code
   * @param {string} message
   * @param {boolean} [retryable=false]
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, retryable = false, details = undefined) {
    super(code, message, retryable, details);
    this.name = 'CustomRuntimeError';
  }
}

/**
 * Probes host virtualization capabilities (/dev/kvm, firecracker, kata-runtime, runsc)
 * without mutating host state or requiring root privileges.
 *
 * @param {{
 *   devKvmPath?: string;
 *   searchPaths?: readonly string[];
 *   overrideKvmAvailable?: boolean;
 *   overrideBinaries?: Partial<Record<'firecracker'|'jailer'|'kata-runtime'|'runsc', boolean>>;
 * }} [options]
 */
export function probeHostVirtualization(options = {}) {
  const devKvmPath = options.devKvmPath ?? '/dev/kvm';
  const searchPaths =
    options.searchPaths ??
    (process.env.PATH ? process.env.PATH.split(path.delimiter).filter(Boolean) : ['/usr/bin', '/usr/local/bin', '/bin']);

  let kvmDeviceExists = false;
  let kvmReadableWritable = false;

  if (typeof options.overrideKvmAvailable === 'boolean') {
    kvmDeviceExists = options.overrideKvmAvailable;
    kvmReadableWritable = options.overrideKvmAvailable;
  } else {
    try {
      const st = fs.statSync(devKvmPath);
      kvmDeviceExists = st.isCharacterDevice() || st.isFile();
      try {
        fs.accessSync(devKvmPath, fs.constants.R_OK | fs.constants.W_OK);
        kvmReadableWritable = true;
      } catch {
        kvmReadableWritable = false;
      }
    } catch {
      kvmDeviceExists = false;
      kvmReadableWritable = false;
    }
  }

  const findBinary = (binName) => {
    if (options.overrideBinaries && typeof options.overrideBinaries[binName] === 'boolean') {
      return options.overrideBinaries[binName] ? `/usr/bin/${binName}` : null;
    }
    for (const dir of searchPaths) {
      const candidate = path.join(dir, binName);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch {
        // continue
      }
    }
    return null;
  };

  const firecrackerPath = findBinary('firecracker');
  const jailerPath = findBinary('jailer');
  const kataRuntimePath = findBinary('kata-runtime');
  const runscPath = findBinary('runsc');

  const firecrackerReady = Boolean(kvmDeviceExists && kvmReadableWritable && firecrackerPath && jailerPath);
  const kataReady = Boolean(kvmDeviceExists && kvmReadableWritable && kataRuntimePath);
  const microVmHardwareReady = firecrackerReady || kataReady;

  return {
    probedAt: new Date().toISOString(),
    devKvmPath,
    kvmDeviceExists,
    kvmReadableWritable,
    binaries: {
      firecracker: firecrackerPath,
      jailer: jailerPath,
      kataRuntime: kataRuntimePath,
      runsc: runscPath,
    },
    firecrackerReady,
    kataReady,
    gvisorBinaryPresent: Boolean(runscPath),
    microVmHardwareReady,
    recommendedActionWhenUnavailable:
      'Keep CVE_CUSTOM_CODE_ENABLED=false and CVE_CUSTOM_RUNTIME=disabled; never downgrade to standard containers.',
  };
}

/**
 * Signs an explicit security review approval record for the gVisor (`gvisor-runsc-v1`) alternative.
 */
export function signGvisorExplicitReviewApproval(payload, signingSecret) {
  if (!signingSecret || typeof signingSecret !== 'string' || signingSecret.length < 32) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit review signing secret must be at least 32 characters',
      false,
      { reason: 'INVALID_REVIEW_SIGNING_SECRET' },
    );
  }
  const canonicalPayload = JSON.stringify({
    adrId: payload.adrId,
    adrAmendmentId: payload.adrAmendmentId,
    runtime: 'gvisor-runsc-v1',
    reviewedRuntimeDigest: payload.reviewedRuntimeDigest,
    reviewer: payload.reviewer,
    reviewedAt: payload.reviewedAt,
    expiresAt: payload.expiresAt,
    escapeSuitePassed: Boolean(payload.escapeSuitePassed),
    compatibilitySuitePassed: Boolean(payload.compatibilitySuitePassed),
    resourceBoundsSuitePassed: Boolean(payload.resourceBoundsSuitePassed),
    noDowngradeVerified: Boolean(payload.noDowngradeVerified),
  });
  const signatureHex = crypto
    .createHmac('sha256', Buffer.from(signingSecret, 'utf-8'))
    .update(canonicalPayload, 'utf-8')
    .digest('hex');

  return {
    ...payload,
    runtime: 'gvisor-runsc-v1',
    signatureHex,
  };
}

/**
 * Verifies an explicit gVisor security review approval record.
 * Rejects missing fields, failed test suites, digest mismatches, expired reviews, or forged signatures.
 */
export function verifyGvisorExplicitReviewApproval(
  approval,
  expectedRuntimeDigest,
  signingSecret,
  now = new Date(),
) {
  if (!approval || typeof approval !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor runtime (gvisor-runsc-v1) is blocked: explicit ADR amendment and signed security review are required (no silent alternative or downgrade)',
      false,
      { reason: 'GVISOR_EXPLICIT_REVIEW_REQUIRED' },
    );
  }

  if (approval.adrId !== CUSTOM_RUNTIME_ADR_ID || !approval.adrAmendmentId) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit review approval is missing valid adrId (ADR-0002) or adrAmendmentId',
      false,
      { reason: 'GVISOR_EXPLICIT_REVIEW_REQUIRED' },
    );
  }

  if (!approval.reviewer || typeof approval.reviewer !== 'string') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit review approval is missing security reviewer identity',
      false,
      { reason: 'GVISOR_EXPLICIT_REVIEW_REQUIRED' },
    );
  }

  if (!IMAGE_DIGEST_REGEX.test(approval.reviewedRuntimeDigest || '')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit review approval must pin an immutable sha256:<64 hex> runtime digest',
      false,
      { reason: 'GVISOR_EXPLICIT_REVIEW_REQUIRED' },
    );
  }

  if (expectedRuntimeDigest && approval.reviewedRuntimeDigest !== expectedRuntimeDigest) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `gVisor reviewedRuntimeDigest (${approval.reviewedRuntimeDigest}) does not match active runtime digest (${expectedRuntimeDigest})`,
      false,
      { reason: 'GVISOR_DIGEST_MISMATCH' },
    );
  }

  if (
    approval.escapeSuitePassed !== true ||
    approval.compatibilitySuitePassed !== true ||
    approval.resourceBoundsSuitePassed !== true ||
    approval.noDowngradeVerified !== true
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit review requires escapeSuitePassed, compatibilitySuitePassed, resourceBoundsSuitePassed, and noDowngradeVerified to all be true',
      false,
      { reason: 'GVISOR_SUITE_INCOMPLETE' },
    );
  }

  const expiresMs = Date.parse(approval.expiresAt || '');
  if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit security review approval has expired or has an invalid expiresAt timestamp',
      false,
      { reason: 'GVISOR_REVIEW_EXPIRED' },
    );
  }

  if (!signingSecret || typeof signingSecret !== 'string' || signingSecret.length < 32) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Missing valid signingSecret to verify gVisor explicit review signature',
      false,
      { reason: 'INVALID_REVIEW_SIGNING_SECRET' },
    );
  }

  const expectedApproval = signGvisorExplicitReviewApproval(approval, signingSecret);
  const actualSigBuf = Buffer.from(String(approval.signatureHex || ''), 'utf-8');
  const expectedSigBuf = Buffer.from(expectedApproval.signatureHex, 'utf-8');

  if (
    actualSigBuf.length !== expectedSigBuf.length ||
    !crypto.timingSafeEqual(actualSigBuf, expectedSigBuf)
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'gVisor explicit security review signature verification failed',
      false,
      { reason: 'GVISOR_SIGNATURE_INVALID' },
    );
  }

  return true;
}

/**
 * Signs a C1-C6 security gate attestation for exact microVM rootfs + guest kernel digests.
 */
export function signC1ToC6GateAttestation(payload, signingSecret) {
  if (!signingSecret || typeof signingSecret !== 'string' || signingSecret.length < 32) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 gate attestation signing secret must be at least 32 characters',
      false,
      { reason: 'INVALID_GATE_SIGNING_SECRET' },
    );
  }

  const normalizedGates = {};
  for (const gateKey of REQUIRED_C1_TO_C6_GATES) {
    normalizedGates[gateKey] = Boolean(payload.gates && payload.gates[gateKey]);
  }

  const canonical = JSON.stringify({
    adrId: CUSTOM_RUNTIME_ADR_ID,
    runtime: payload.runtime,
    rootfsImageDigest: payload.rootfsImageDigest,
    guestKernelDigest: payload.guestKernelDigest,
    reviewer: payload.reviewer,
    reviewedAt: payload.reviewedAt,
    expiresAt: payload.expiresAt,
    killSwitchVerified: Boolean(payload.killSwitchVerified),
    gates: normalizedGates,
  });

  const signatureHex = crypto
    .createHmac('sha256', Buffer.from(signingSecret, 'utf-8'))
    .update(canonical, 'utf-8')
    .digest('hex');

  return {
    adrId: CUSTOM_RUNTIME_ADR_ID,
    runtime: payload.runtime,
    rootfsImageDigest: payload.rootfsImageDigest,
    guestKernelDigest: payload.guestKernelDigest,
    reviewer: payload.reviewer,
    reviewedAt: payload.reviewedAt,
    expiresAt: payload.expiresAt,
    killSwitchVerified: Boolean(payload.killSwitchVerified),
    gates: normalizedGates,
    signatureHex,
  };
}

/**
 * Verifies that all C1-C6 security gates are passed and cryptographically signed for the exact runtime digests.
 */
export function verifyC1ToC6Gates(
  attestation,
  expectedRootfsDigest,
  expectedKernelDigest,
  signingSecret,
  now = new Date(),
) {
  if (!attestation || typeof attestation !== 'object') {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'Custom code requires a signed C1-C6 security gate attestation before activation',
      false,
      { reason: 'C1_C6_ATTESTATION_MISSING' },
    );
  }

  for (const gateKey of REQUIRED_C1_TO_C6_GATES) {
    if (!attestation.gates || attestation.gates[gateKey] !== true) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Custom code gate ${gateKey} is not satisfied (missing gate = disabled)`,
        false,
        { reason: 'C1_C6_GATE_UNSATISFIED', missingGate: gateKey },
      );
    }
  }

  if (attestation.killSwitchVerified !== true) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 attestation requires killSwitchVerified=true',
      false,
      { reason: 'KILL_SWITCH_UNVERIFIED' },
    );
  }

  if (
    !IMAGE_DIGEST_REGEX.test(attestation.rootfsImageDigest || '') ||
    attestation.rootfsImageDigest === DEV_PLACEHOLDER_DIGEST
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 attestation must pin a non-placeholder sha256:<64 hex> rootfsImageDigest',
      false,
      { reason: 'INVALID_ROOTFS_DIGEST' },
    );
  }

  if (
    !IMAGE_DIGEST_REGEX.test(attestation.guestKernelDigest || '') ||
    attestation.guestKernelDigest === DEV_PLACEHOLDER_DIGEST
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 attestation must pin a non-placeholder sha256:<64 hex> guestKernelDigest',
      false,
      { reason: 'INVALID_KERNEL_DIGEST' },
    );
  }

  if (expectedRootfsDigest && attestation.rootfsImageDigest !== expectedRootfsDigest) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Rootfs image digest drift detected: attested ${attestation.rootfsImageDigest} !== active ${expectedRootfsDigest} (runtime patch requires re-running C1-C6 gates)`,
      false,
      { reason: 'ROOTFS_DIGEST_DRIFT' },
    );
  }

  if (expectedKernelDigest && attestation.guestKernelDigest !== expectedKernelDigest) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Guest kernel digest drift detected: attested ${attestation.guestKernelDigest} !== active ${expectedKernelDigest}`,
      false,
      { reason: 'KERNEL_DIGEST_DRIFT' },
    );
  }

  const expiresMs = Date.parse(attestation.expiresAt || '');
  if (Number.isNaN(expiresMs) || expiresMs <= now.getTime()) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 security gate attestation has expired',
      false,
      { reason: 'C1_C6_ATTESTATION_EXPIRED' },
    );
  }

  const expected = signC1ToC6GateAttestation(attestation, signingSecret);
  const actualBuf = Buffer.from(String(attestation.signatureHex || ''), 'utf-8');
  const expectedBuf = Buffer.from(expected.signatureHex, 'utf-8');

  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      'C1-C6 security gate attestation signature is invalid',
      false,
      { reason: 'C1_C6_SIGNATURE_INVALID' },
    );
  }

  return true;
}

/**
 * Evaluates custom runtime selection and enforces:
 *   1. Default-off when CVE_CUSTOM_CODE_ENABLED=false or killSwitchActive=true.
 *   2. Zero downgrade: blocks standard containers (docker/runc/crun/podman/host/node-vm/iframe).
 *   3. Explicit review gate for gVisor (gvisor-runsc-v1): blocks unless signed approval is valid.
 *   4. Hardware KVM check for microVM (microvm-firecracker-v1 / microvm-kata-v1): keeps custom off if unavailable.
 *   5. C1-C6 signed attestation and tenant allowlist check.
 */
export function evaluateCustomRuntimePolicy(input) {
  const {
    config,
    tenantId,
    killSwitchActive = false,
    rootfsImageDigest,
    guestKernelDigest,
    c1ToC6Attestation,
    gvisorApproval,
    signingSecret,
    hostProbe = probeHostVirtualization(),
    now = new Date(),
  } = input;

  if (killSwitchActive) {
    throw new CustomRuntimeError(
      'CAPABILITY_DISABLED',
      'Custom code emergency kill switch is active; admission and execution are blocked',
      false,
      { reason: 'KILL_SWITCH_ACTIVE' },
    );
  }

  const runtime = String(config?.CVE_CUSTOM_RUNTIME || 'disabled').trim();

  // Check anti-downgrade BEFORE anything else so illegal runtime values are always caught as security violations
  if (
    FORBIDDEN_DOWNGRADE_RUNTIMES.includes(runtime) ||
    (!APPROVED_MICROVM_RUNTIMES.includes(runtime) &&
      !CONDITIONAL_ALTERNATIVE_RUNTIMES.includes(runtime) &&
      runtime !== 'disabled')
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Runtime downgrade to "${runtime}" is strictly forbidden for custom code. Disposable microVM (or explicitly reviewed gVisor) is required.`,
      false,
      { reason: 'RUNTIME_DOWNGRADE_FORBIDDEN', requestedRuntime: runtime },
    );
  }

  if (!config?.CVE_CUSTOM_CODE_ENABLED || runtime === 'disabled') {
    throw new CustomRuntimeError(
      'CAPABILITY_DISABLED',
      'Custom scene code execution is disabled by default (CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled)',
      false,
      { reason: 'CUSTOM_CODE_DEFAULT_OFF', runtime },
    );
  }

  // If gVisor is requested, enforce explicit review gate before checking anything else
  if (runtime === 'gvisor-runsc-v1') {
    verifyGvisorExplicitReviewApproval(gvisorApproval, rootfsImageDigest, signingSecret, now);
    if (!hostProbe.gvisorBinaryPresent) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Host does not have reviewed gVisor runsc binary installed; keeping custom code disabled (no container downgrade)',
        false,
        { reason: 'VIRTUALIZATION_UNAVAILABLE', runtime },
      );
    }
  } else if (runtime === 'microvm-firecracker-v1') {
    if (!hostProbe.firecrackerReady) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Host lacks /dev/kvm or Firecracker/jailer binaries; keeping custom code disabled per ADR-0002 (never downgrade to standard containers)',
        false,
        {
          reason: 'VIRTUALIZATION_UNAVAILABLE',
          runtime,
          kvmDeviceExists: hostProbe.kvmDeviceExists,
          kvmReadableWritable: hostProbe.kvmReadableWritable,
        },
      );
    }
  } else if (runtime === 'microvm-kata-v1') {
    if (!hostProbe.kataReady) {
      throw new CustomRuntimeError(
        'CAPABILITY_DISABLED',
        'Host lacks /dev/kvm or kata-runtime binary; keeping custom code disabled per ADR-0002 (never downgrade to standard containers)',
        false,
        {
          reason: 'VIRTUALIZATION_UNAVAILABLE',
          runtime,
          kvmDeviceExists: hostProbe.kvmDeviceExists,
        },
      );
    }
  }

  // Verify C1-C6 security gate attestation for exact image/kernel digests
  verifyC1ToC6Gates(c1ToC6Attestation, rootfsImageDigest, guestKernelDigest, signingSecret, now);

  if (c1ToC6Attestation.runtime !== runtime) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `C1-C6 attestation runtime "${c1ToC6Attestation.runtime}" does not match configured runtime "${runtime}"`,
      false,
      { reason: 'ATTESTATION_RUNTIME_MISMATCH' },
    );
  }

  // Verify tenant allowlist
  const allowlist = Array.isArray(config.CVE_CUSTOM_TENANT_ALLOWLIST)
    ? config.CVE_CUSTOM_TENANT_ALLOWLIST
    : [];
  if (!tenantId || !allowlist.includes(tenantId)) {
    throw new CustomRuntimeError(
      'CAPABILITY_DISABLED',
      `Tenant "${tenantId || ''}" is not in CVE_CUSTOM_TENANT_ALLOWLIST for custom code execution`,
      false,
      { reason: 'TENANT_NOT_ALLOWLISTED', tenantId: tenantId ?? null },
    );
  }

  return {
    allowed: true,
    adrId: CUSTOM_RUNTIME_ADR_ID,
    runtime,
    tenantId,
    rootfsImageDigest,
    guestKernelDigest,
    isolationClass:
      runtime === 'gvisor-runsc-v1' ? 'application-kernel-sandbox' : 'hardware-virtualized-microvm',
  };
}
