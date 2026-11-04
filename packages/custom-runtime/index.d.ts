/**
 * TypeScript Declarations for `@creativanta/custom-runtime` (Task P7-01).
 */

import { SandboxError, SandboxErrorCode } from '../controller/dist/index.js';
import { CveEnvConfig } from '../contracts/dist/index.js';

export const CUSTOM_RUNTIME_ADR_ID: 'ADR-0002';
export const APPROVED_MICROVM_RUNTIMES: readonly ['microvm-firecracker-v1', 'microvm-kata-v1'];
export const CONDITIONAL_ALTERNATIVE_RUNTIMES: readonly ['gvisor-runsc-v1'];
export const FORBIDDEN_DOWNGRADE_RUNTIMES: readonly string[];
export const REQUIRED_C1_TO_C6_GATES: readonly string[];
export const CUSTOM_RUNTIME_ADR_0002: Readonly<Record<string, unknown>>;

export class CustomRuntimeError extends SandboxError {
  constructor(
    code: SandboxErrorCode,
    message: string,
    retryable?: boolean,
    details?: Record<string, unknown>,
  );
}

export interface HostVirtualizationProbeResult {
  probedAt: string;
  devKvmPath: string;
  kvmDeviceExists: boolean;
  kvmReadableWritable: boolean;
  binaries: {
    firecracker: string | null;
    jailer: string | null;
    kataRuntime: string | null;
    runsc: string | null;
  };
  firecrackerReady: boolean;
  kataReady: boolean;
  gvisorBinaryPresent: boolean;
  microVmHardwareReady: boolean;
  recommendedActionWhenUnavailable: string;
}

export function probeHostVirtualization(options?: {
  devKvmPath?: string;
  searchPaths?: readonly string[];
  overrideKvmAvailable?: boolean;
  overrideBinaries?: Partial<Record<'firecracker' | 'jailer' | 'kata-runtime' | 'runsc', boolean>>;
}): HostVirtualizationProbeResult;

export interface GvisorExplicitReviewApproval {
  adrId: string;
  adrAmendmentId: string;
  runtime: 'gvisor-runsc-v1';
  reviewedRuntimeDigest: string;
  reviewer: string;
  reviewedAt: string;
  expiresAt: string;
  escapeSuitePassed: boolean;
  compatibilitySuitePassed: boolean;
  resourceBoundsSuitePassed: boolean;
  noDowngradeVerified: boolean;
  signatureHex: string;
}

export function signGvisorExplicitReviewApproval(
  payload: Omit<GvisorExplicitReviewApproval, 'runtime' | 'signatureHex'>,
  signingSecret: string,
): GvisorExplicitReviewApproval;

export function verifyGvisorExplicitReviewApproval(
  approval: GvisorExplicitReviewApproval | null | undefined,
  expectedRuntimeDigest: string | undefined,
  signingSecret: string,
  now?: Date,
): boolean;

export interface C1ToC6GateAttestation {
  adrId: string;
  runtime: string;
  rootfsImageDigest: string;
  guestKernelDigest: string;
  reviewer: string;
  reviewedAt: string;
  expiresAt: string;
  killSwitchVerified: boolean;
  gates: Record<string, boolean>;
  signatureHex: string;
}

export function signC1ToC6GateAttestation(
  payload: Omit<C1ToC6GateAttestation, 'adrId' | 'signatureHex'>,
  signingSecret: string,
): C1ToC6GateAttestation;

export function verifyC1ToC6Gates(
  attestation: C1ToC6GateAttestation | null | undefined,
  expectedRootfsDigest: string | undefined,
  expectedKernelDigest: string | undefined,
  signingSecret: string,
  now?: Date,
): boolean;

export function evaluateCustomRuntimePolicy(input: {
  config: Pick<
    CveEnvConfig,
    'CVE_CUSTOM_CODE_ENABLED' | 'CVE_CUSTOM_RUNTIME' | 'CVE_CUSTOM_TENANT_ALLOWLIST'
  >;
  tenantId?: string;
  killSwitchActive?: boolean;
  rootfsImageDigest?: string;
  guestKernelDigest?: string;
  c1ToC6Attestation?: C1ToC6GateAttestation;
  gvisorApproval?: GvisorExplicitReviewApproval;
  signingSecret?: string;
  hostProbe?: HostVirtualizationProbeResult;
  now?: Date;
}): {
  allowed: boolean;
  adrId: string;
  runtime: string;
  tenantId: string;
  rootfsImageDigest?: string;
  guestKernelDigest?: string;
  isolationClass: 'hardware-virtualized-microvm' | 'application-kernel-sandbox';
};

export const DEFAULT_BUILD_VM_BOUNDS: Readonly<{
  phase: 'build';
  vcpuCount: number;
  memoryMib: number;
  pidsLimit: number;
  scratchDiskMib: number;
  timeoutMs: number;
  killGraceMs: number;
}>;

export const DEFAULT_RENDER_VM_BOUNDS: Readonly<{
  phase: 'render';
  vcpuCount: number;
  memoryMib: number;
  pidsLimit: number;
  tempDiskMib: number;
  frameTimeoutMs: number;
  renderTimeoutSeconds: number;
  previewTimeoutSeconds: number;
  killGraceMs: number;
}>;

export const CUSTOM_BUNDLE_QUOTAS: Readonly<{
  maxFiles: number;
  maxSourceBytes: number;
  maxBuiltAssetBytes: number;
  maxNestingDepth: number;
  maxStdioBytes: number;
}>;

export function validateBuildVmBounds(rawBounds?: Record<string, unknown>): typeof DEFAULT_BUILD_VM_BOUNDS;
export function validateRenderVmBounds(rawBounds?: Record<string, unknown>): typeof DEFAULT_RENDER_VM_BOUNDS;
export function buildMicroVmCgroupV2Spec(bounds: Record<string, unknown>): Readonly<Record<string, unknown>>;
export function buildFirecrackerMachineConfig(options: Record<string, unknown>): Record<string, unknown>;

export const APPROVED_PREINSTALLED_SCENE_IMPORTS: readonly string[];
export const ALLOWED_MICROVM_GUEST_ENV_KEYS: ReadonlySet<string>;
export const FORBIDDEN_HOST_FS_PATTERNS: readonly RegExp[];

export function buildCustomSceneCspHeader(compiledScriptContent: Buffer | string): {
  scriptHashToken: string;
  sha256Base64: string;
  cspHeader: string;
};
export function assertZeroEgressMicroVmSpec(vmConfig: Record<string, unknown>): boolean;
export function scanCustomSourceForForbiddenCapabilities(
  files: readonly { relativePath: string; content: Buffer | string }[],
  allowedPackageImports?: readonly string[],
): { passed: boolean; scannedFilesCount: number; violations: unknown[] };
export function buildMicroVmGuestEnv(options: Record<string, unknown>): Readonly<Record<string, string>>;
export function sanitizeAndBoundMicroVmLog(
  rawText: Buffer | string,
  canaries?: readonly string[],
): { text: string; truncated: boolean; originalBytes: number };
export function validateMicroVmHostPaths(
  hostPaths: readonly string[],
  allowedPrisonRoot: string,
): boolean;

export class MicroVmWorkspacePrison {
  readonly baseDir: string;
  constructor(baseDir?: string);
}

export class DisposableMicroVmInstance {
  readonly vmId: string;
  readonly phase: 'build' | 'render';
  boot(): void;
  executeOnce(execOptions: Record<string, unknown>): Promise<Record<string, unknown>>;
  destroy(): void;
  getAttestation(): Readonly<Record<string, unknown>>;
}

export class DisposableMicroVmRuntime {
  constructor(options?: { baseDir?: string });
  allocateDisposableMicroVm(request: Record<string, unknown>): DisposableMicroVmInstance;
  runIsolatedBuild(buildRequest: Record<string, unknown>): Promise<Record<string, unknown>>;
  runIsolatedRender(renderRequest: Record<string, unknown>): Promise<Record<string, unknown>>;
  cleanupBaseDir(): void;
}

export function runCustomRuntimeSelfTest(): Promise<Record<string, unknown>>;
