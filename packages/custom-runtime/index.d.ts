/**
 * TypeScript Declarations for `@creativanta/custom-runtime` (Tasks P7-01 & P7-02).
 */

import { SandboxError, SandboxErrorCode } from '../controller/dist/index.js';
import { CveEnvConfig } from '../contracts/dist/index.js';

/* =========================================================================
 * Task P7-01 Declarations (ADR-0002, microVM, Bounds, Isolation Guards)
 * ========================================================================= */

export const CUSTOM_RUNTIME_ADR_ID: 'ADR-0002';
export const APPROVED_MICROVM_RUNTIMES: readonly ['microvm-firecracker-v1', 'microvm-kata-v1'];
export const CONDITIONAL_ALTERNATIVE_RUNTIMES: readonly ['gvisor-runsc-v1'];
export const FORBIDDEN_DOWNGRADE_RUNTIMES: readonly string[];
export const REQUIRED_C1_TO_C6_GATES: readonly string[];
export const CUSTOM_RUNTIME_ADR_0002: Readonly<Record<string, unknown>>;
export const DEFAULT_PINNED_ROOTFS_DIGEST: string;
export const DEFAULT_PINNED_KERNEL_DIGEST: string;

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
  files: readonly { path?: string; relativePath?: string; content: Buffer | string }[],
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

/* =========================================================================
 * Task P7-02 Declarations (Parameter Schema, Digests, Provenance, Registry, OpenAPI)
 * ========================================================================= */

export const MAX_BUNDLE_PARAMETERS: number;
export const MAX_PARAMETER_STRING_LENGTH: number;
export const MAX_PARAMETER_ARRAY_ITEMS: number;
export const SUPPORTED_PARAMETER_TYPES: readonly string[];
export const PERMITTED_UI_COMPONENTS: readonly string[];

export function hasCatastrophicBacktrackingRisk(pattern: string): boolean;

export function validateParameterSchemaDefinition(
  schema: unknown,
  options?: { strict?: boolean },
): { valid: boolean; errors: string[] };

export function validateBundleParameters(
  schema: Record<string, unknown>,
  rawParameters?: Record<string, unknown> | null,
  options?: { allowAdditionalProperties?: boolean },
): {
  valid: boolean;
  errors: Array<{ pointer: string; message: string; code: string }>;
  validatedParameters: Record<string, unknown>;
};

export function extractParameterSchemaDefaults(
  schema: Record<string, unknown>,
): Record<string, unknown>;

export const PROVENANCE_AUTHORING_TYPES: readonly ['human', 'ai', 'fork', 'import'];
export const ALLOWED_BUNDLE_CAPABILITIES: readonly string[];
export const FORBIDDEN_BUNDLE_CAPABILITIES: readonly string[];

export function normalizeSourceFilePath(rawPath: string): string;
export function normalizeSourceFileEntry(file: { path: string; content: Buffer | string }): {
  path: string;
  content: Buffer;
  size: number;
  sha256: string;
};
export function guessMimeType(filePath: string): string;

export function computeDeterministicSourceDigest(
  rawFiles: readonly { path: string; content: Buffer | string }[],
): {
  sourceSha256: string;
  totalFiles: number;
  totalBytes: number;
  manifest: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
};

export function computeDeterministicBuildDigest(
  rawArtifacts: readonly { path: string; content: Buffer | string }[],
): {
  buildSha256: string;
  totalFiles: number;
  totalBytes: number;
  manifest: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
};

export function verifySourceIntegrity(
  files: readonly { path: string; content: Buffer | string }[],
  expectedSha256: string,
): boolean;

export function verifyBuildIntegrity(
  artifacts: readonly { path: string; content: Buffer | string }[],
  expectedSha256: string,
): boolean;

export function packFilesToTarArchive(
  rawFiles: readonly { path: string; content: Buffer | string }[],
): Buffer;

export function unpackFilesFromTarArchive(
  tarBuffer: Buffer,
): Array<{ path: string; content: Buffer }>;

export interface SceneBundleProvenance {
  provenance_id: string;
  authoring_type: 'human' | 'ai' | 'fork' | 'import';
  author: string;
  created_at: string;
  base_revision: number | null;
  source_bundle: { bundle_id: string; revision: number } | null;
  ai_metadata: {
    provider?: string;
    model?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_usd?: number;
    job_id?: string;
    brief_hash?: string;
    generation_params?: Record<string, unknown>;
  } | null;
  rights_and_license: {
    license: string;
    copyright_holder?: string;
    rights_provenance: string;
    commercial_use_allowed: boolean;
  };
  declared_capabilities: string[];
  source_sha256: string;
  build_sha256: string;
  provenance_digest: string;
}

export function calculateProvenanceDigest(
  record: Omit<SceneBundleProvenance, 'provenance_digest'>,
): string;

export function createSceneBundleProvenance(input: {
  authoring_type: 'human' | 'ai' | 'fork' | 'import';
  author: string;
  base_revision?: number | null;
  source_bundle?: { bundle_id: string; revision: number } | null;
  ai_metadata?: {
    provider?: string;
    model?: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    cost_usd?: number;
    job_id?: string;
    brief_hash?: string;
    generation_params?: Record<string, unknown>;
  } | null;
  rights_and_license: {
    license: string;
    copyright_holder?: string;
    rights_provenance: string;
    commercial_use_allowed?: boolean;
  };
  declared_capabilities?: readonly string[];
  source_sha256: string;
  build_sha256: string;
  createdAt?: string;
}): SceneBundleProvenance;

export function verifyProvenanceIntegrity(
  provenance: SceneBundleProvenance | null | undefined,
): boolean;

export const BUNDLE_REVISION_STATUSES: readonly ['draft', 'validating', 'published', 'archived', 'rejected'];
export const DEFAULT_BUNDLE_PARAMETER_SCHEMA: Readonly<Record<string, unknown>>;
export const DEFAULT_ENTRYPOINT_SOURCE: string;

export function isCustomCodeFeatureEnabled(config: Record<string, unknown> | null | undefined): boolean;
export function assertCustomCodeExecutionAllowed(
  config: Record<string, unknown> | null | undefined,
  tenantId?: string,
): void;
export function validateBundleId(bundleId: string): void;

export interface SceneBundleRecord {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  is_global: boolean;
  tags: string[];
  latest_revision: number;
  max_revision: number;
  created_at: string;
  updated_at: string;
  is_archived: boolean;
  created_by: string;
}

export interface SceneBundleRevisionRecord {
  bundle_id: string;
  revision: number;
  base_revision: number | null;
  status: 'draft' | 'validating' | 'published' | 'archived' | 'rejected';
  entrypoint: string;
  source_sha256: string;
  build_sha256: string;
  parameter_schema: Record<string, unknown>;
  provenance: SceneBundleProvenance;
  declared_capabilities: string[];
  change_summary: string;
  source_files: Map<string, { path: string; content: Buffer; size: number; sha256: string; mime_type: string }>;
  build_artifacts: Map<string, { path: string; content: Buffer; size: number; sha256: string; mime_type: string }>;
  csp_script_hash: string;
  validation_report: {
    passed: boolean;
    scanned_files_count: number;
    violations: unknown[];
    parameter_schema_valid: boolean;
    evaluated_at: string;
  } | null;
  created_at: string;
  created_by: string;
  sealed_at: string | null;
}

export class SceneBundleRegistry {
  config: Record<string, unknown>;
  constructor(options?: {
    config?: Record<string, unknown>;
    globalCuratedBundleIds?: string[];
  });

  createBundle(
    tenantId: string,
    input: {
      id: string;
      name: string;
      description?: string;
      tags?: string[];
      entrypoint?: string;
      parameter_schema?: Record<string, unknown>;
      source_files?: Array<{ path: string; content: Buffer | string }>;
      declared_capabilities?: string[];
      provenance?: {
        authoring_type?: 'human' | 'ai' | 'fork' | 'import';
        author?: string;
        source_bundle?: { bundle_id: string; revision: number } | null;
        ai_metadata?: Record<string, unknown>;
        rights_and_license?: {
          license: string;
          copyright_holder?: string;
          rights_provenance?: string;
          commercial_use_allowed?: boolean;
        };
      };
      change_summary?: string;
      created_by?: string;
    },
  ): { bundle: SceneBundleRecord; revision: SceneBundleRevisionRecord };

  listBundles(
    tenantId: string,
    options?: {
      tag?: string;
      include_global?: boolean;
      limit?: number;
      offset?: number;
    },
  ): {
    items: SceneBundleRecord[];
    total: number;
    limit: number;
    offset: number;
  };

  getBundle(tenantId: string, bundleId: string): SceneBundleRecord;

  updateBundle(
    tenantId: string,
    bundleId: string,
    updates: {
      name?: string;
      description?: string;
      tags?: string[];
    },
  ): SceneBundleRecord;

  deleteBundle(tenantId: string, bundleId: string): boolean;

  createRevision(
    tenantId: string,
    bundleId: string,
    input: {
      base_revision: number;
      entrypoint?: string;
      parameter_schema?: Record<string, unknown>;
      source_files?: Array<{ path: string; content: Buffer | string }>;
      change_summary?: string;
      declared_capabilities?: string[];
      created_by?: string;
      provenance?: {
        authoring_type?: 'human' | 'ai' | 'fork' | 'import';
        author?: string;
        ai_metadata?: Record<string, unknown>;
        rights_and_license?: {
          license: string;
          copyright_holder?: string;
          rights_provenance?: string;
          commercial_use_allowed?: boolean;
        };
      };
    },
  ): SceneBundleRevisionRecord;

  updateDraftRevision(
    tenantId: string,
    bundleId: string,
    revision: number,
    updates: {
      entrypoint?: string;
      parameter_schema?: Record<string, unknown>;
      add_or_update_files?: Array<{ path: string; content: Buffer | string }>;
      remove_files?: string[];
      change_summary?: string;
      declared_capabilities?: string[];
    },
  ): SceneBundleRevisionRecord;

  validateRevision(
    tenantId: string,
    bundleId: string,
    revision: number,
  ): {
    passed: boolean;
    scanned_files_count: number;
    violations: unknown[];
    parameter_schema_valid: boolean;
    evaluated_at: string;
  };

  publishRevision(
    tenantId: string,
    bundleId: string,
    revision: number,
    options?: { skipScan?: boolean },
  ): SceneBundleRevisionRecord;

  listRevisions(tenantId: string, bundleId: string): SceneBundleRevisionRecord[];

  getRevision(tenantId: string, bundleId: string, revision: number): SceneBundleRevisionRecord;

  forkBundle(
    sourceBundleId: string,
    targetTenantId: string,
    options: {
      new_bundle_id: string;
      name?: string;
      description?: string;
      source_revision?: number;
      created_by?: string;
    },
  ): { bundle: SceneBundleRecord; revision: SceneBundleRevisionRecord };

  downloadSource(
    tenantId: string,
    bundleId: string,
    revision: number,
    options?: { format?: 'manifest' | 'tar' | 'files' },
  ): {
    format: 'manifest' | 'tar' | 'files';
    sourceSha256: string;
    totalFiles: number;
    totalBytes: number;
    data: Buffer | Array<{ path: string; size: number; sha256: string; mime_type?: string; content?: string }>;
  };

  downloadSourceFile(
    tenantId: string,
    bundleId: string,
    revision: number,
    relativePath: string,
  ): {
    path: string;
    content: Buffer;
    size: number;
    sha256: string;
    mime_type: string;
  };

  downloadBuild(
    tenantId: string,
    bundleId: string,
    revision: number,
  ): {
    buildSha256: string;
    entrypoint: string;
    artifacts: Array<{ path: string; size: number; sha256: string; mime_type: string }>;
  };

  prepareCustomSceneExecution(
    tenantId: string,
    input: {
      bundle_id: string;
      revision: number;
      parameters: Record<string, unknown>;
    },
  ): {
    bundle_id: string;
    revision: number;
    entrypoint: string;
    source_sha256: string;
    build_sha256: string;
    csp_script_hash: string;
    validated_parameters: Record<string, unknown>;
  };
}

export const SCENE_BUNDLE_OPENAPI_SPEC: Record<string, unknown>;
export function getSceneBundleOpenApiSpec(): Record<string, unknown>;
export function validateOpenApiSpecification(spec: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
};
export function extendOpenApiWithSceneBundles(baseSpec: Record<string, unknown>): Record<string, unknown>;
export function runSceneBundleRegistrySelfTest(): Promise<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Task P7-03: Provider-Neutral Authoring Adapter Contract & Non-Premium Routes
// ---------------------------------------------------------------------------

export type AuthoringProviderType = 'mock' | 'local' | 'remote';

export interface AuthoringBudgets {
  max_tokens: number;
  max_completion_tokens: number;
  timeout_ms: number;
  max_cost_usd: number;
}

export interface AuthoringTarget {
  bundle_type?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration_seconds?: number;
}

export interface AuthoringRequest {
  brief: string;
  locale?: string;
  approved_asset_ids?: string[];
  provider_preference?: string;
  model?: string;
  budgets?: Partial<AuthoringBudgets>;
  target?: Partial<AuthoringTarget>;
  seed?: string | number;
  options?: Record<string, unknown>;
}

export interface AuthoringModelInfo {
  id: string;
  name: string;
  contextTokens: number;
  requiresSubscription: boolean;
  promptCostPer1k: number;
  completionCostPer1k: number;
}

export interface AuthoringProviderInfo {
  id: string;
  name: string;
  displayName: string;
  providerType: AuthoringProviderType;
  isSubscriptionRequired: boolean;
  defaultModel: string;
  supportedModels: AuthoringModelInfo[];
  capabilities: readonly string[];
}

export interface AuthoringJobOutput {
  files: Array<{ path: string; content: Buffer; size: number }>;
  entrypoint: string;
  parameter_schema: Record<string, unknown>;
  declared_capabilities: string[];
  source_sha256: string;
  build_sha256: string;
  csp_script_hash: string;
  provenance: SceneBundleProvenance;
  metadata: {
    provider: string;
    model: string;
    job_id: string;
    brief_hash: string;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    duration_ms?: number;
    cost_usd?: number;
    seed?: string | number;
    finish_reason?: string;
    total_files?: number;
    total_bytes?: number;
  };
}

export interface AuthoringMetering {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  cost_usd: number;
  cost_micros: number;
}

export interface AuthoringJob {
  id: string;
  tenant_id: string;
  state: 'queued' | 'authoring' | 'succeeded' | 'failed' | 'canceled';
  request: AuthoringRequest;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  output: AuthoringJobOutput | null;
  error: { code: string; message: string; elapsedMs?: number } | null;
  cancellation_reason: string | null;
  metering: AuthoringMetering | null;
}

export const AUTHORING_DEFAULT_BUDGETS: Readonly<{
  maxPromptTokens: number;
  maxCompletionTokens: number;
  maxTotalTokens: number;
  timeoutMs: number;
  maxCostUsd: number;
}>;

export const AUTHORING_SYSTEM_LIMITS: Readonly<{
  maxBriefLength: number;
  maxApprovedAssetsCount: number;
  maxTimeoutMs: number;
  maxTokensUpperCap: number;
  maxCompletionTokensUpperCap: number;
  maxCostUsdUpperCap: number;
  minTimeoutMs: number;
}>;

export const AUTHORING_PRICING_TABLE: Record<string, {
  provider: string;
  promptCostPer1k: number;
  completionCostPer1k: number;
  requiresSubscription: boolean;
  contextWindow: number;
}>;

export const AUTHORING_CAPABILITIES: readonly string[];

export function estimatePromptTokens(text: string): number;

export function calculateAuthoringCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
  customPricing?: Record<string, { promptCostPer1k: number; completionCostPer1k: number }>,
): number;

export function validateAuthoringRequest(request: Record<string, unknown>): AuthoringRequest & {
  brief_hash: string;
  budgets: AuthoringBudgets;
  target: AuthoringTarget;
};

export class AuthoringAdapter {
  id: string;
  name: string;
  displayName: string;
  providerType: AuthoringProviderType;
  isSubscriptionRequired: boolean;
  supportedModels: readonly AuthoringModelInfo[];
  defaultModel: string;
  capabilities: readonly string[];

  constructor(options: {
    id: string;
    name: string;
    providerType: AuthoringProviderType;
    displayName?: string;
    isSubscriptionRequired?: boolean;
    supportedModels?: AuthoringModelInfo[];
    defaultModel?: string;
    capabilities?: string[];
  });

  listModels(): readonly AuthoringModelInfo[];
  estimateBudget(request: Record<string, unknown>): {
    estimatedPromptTokens: number;
    estimatedCompletionTokens: number;
    estimatedCostUsd: number;
    estimatedDurationMs: number;
  };
  generateSceneSource(
    request: Record<string, unknown>,
    context: {
      signal?: AbortSignal;
      tenantId: string;
      jobId: string;
      logger?: Record<string, unknown>;
    },
  ): Promise<{
    status: 'succeeded' | 'failed' | 'canceled';
    files: Array<{ path: string; content: string | Buffer }>;
    entrypoint: string;
    parameter_schema: Record<string, unknown>;
    declared_capabilities: string[];
    metadata: {
      provider: string;
      model: string;
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      duration_ms: number;
      cost_usd: number;
      brief_hash: string;
      seed?: string | number;
      finish_reason: string;
    };
  }>;
}

export class AuthoringBudgetEnforcer {
  static checkPreflightBudget(
    budgets: AuthoringBudgets,
    estimation: {
      estimatedPromptTokens: number;
      estimatedCompletionTokens: number;
      estimatedCostUsd: number;
    },
  ): void;

  static checkPostflightBudget(
    budgets: AuthoringBudgets,
    actual: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      duration_ms: number;
      cost_usd: number;
    },
  ): void;

  static createTimeoutController(
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): {
    controller: AbortController;
    signal: AbortSignal;
    isTimedOut: () => boolean;
    cleanup: () => void;
  };

  static calculateMetering(
    modelId: string,
    promptTokens: number,
    completionTokens: number,
    durationMs: number,
    customPricing?: Record<string, { promptCostPer1k: number; completionCostPer1k: number }>,
  ): AuthoringMetering;
}

export function scanSourceFilesForSecurityViolations(
  files: Array<{ path: string; content: string | Buffer }>,
  canarySecrets?: string[],
): void;

export function validateAndSanitizeAuthoringOutput(
  rawOutput: {
    files: Array<{ path: string; content: string | Buffer }>;
    entrypoint?: string;
    parameter_schema?: Record<string, unknown>;
    declared_capabilities?: string[];
    metadata?: Record<string, unknown>;
  },
  options: {
    tenantId: string;
    jobId: string;
    brief: string;
    briefHash: string;
    provider: string;
    model: string;
    approvedAssetIds?: string[];
    canarySecrets?: string[];
  },
): AuthoringJobOutput;

export class DeterministicMockAuthoringAdapter extends AuthoringAdapter {
  constructor(options?: Record<string, unknown>);
}

export class OpenCodeAuthoringAdapter extends AuthoringAdapter {
  baseUrl: string;
  allowOfflineSimulation: boolean;
  constructor(options?: {
    baseUrl?: string;
    allowOfflineSimulation?: boolean;
    defaultModel?: string;
  });
}

export class DeepSeekAuthoringAdapter extends AuthoringAdapter {
  constructor(options?: Record<string, unknown>);
}

export class AgyGeminiAuthoringAdapter extends AuthoringAdapter {
  constructor(options?: Record<string, unknown>);
}

export class CodexAuthoringAdapter extends AuthoringAdapter {
  constructor(options?: Record<string, unknown>);
}

export class AuthoringAdapterRegistry {
  adapters: Map<string, AuthoringAdapter>;
  constructor();
  registerAdapter(adapter: AuthoringAdapter): void;
  getAdapter(id: string): AuthoringAdapter | undefined;
  getDefaultAdapter(): AuthoringAdapter;
  listProviders(): AuthoringProviderInfo[];
}

export class AuthoringJobManager {
  registry: AuthoringAdapterRegistry;
  canarySecrets: string[];
  jobs: Map<string, AuthoringJob>;

  constructor(options?: {
    registry?: AuthoringAdapterRegistry;
    canarySecrets?: string[];
  });

  createJob(tenantId: string, request: Record<string, unknown>): AuthoringJob;
  getJob(jobId: string, tenantId: string): AuthoringJob;
  listJobs(
    tenantId: string,
    options?: { state?: string; limit?: number; cursor?: number },
  ): {
    jobs: AuthoringJob[];
    total: number;
    cursor: number;
    limit: number;
    has_more: boolean;
  };
  cancelJob(jobId: string, tenantId: string, reason?: string): AuthoringJob;
  startJob(jobId: string, tenantId: string, options?: { signal?: AbortSignal }): Promise<AuthoringJob>;
  importJobOutputToRegistry(
    jobId: string,
    tenantId: string,
    bundleRegistry: SceneBundleRegistry,
    options?: {
      bundleId?: string;
      title?: string;
      description?: string;
      tags?: string[];
      category?: string;
    },
  ): Promise<{ action: 'bundle_created' | 'revision_created'; bundle?: any; revision?: any }>;
}

export function runAuthoringAdapterSelfTest(): Promise<Record<string, unknown>>;

export const AUTHORING_OPENAPI_SPEC: Record<string, unknown>;
export function getAuthoringOpenApiSpec(): Record<string, unknown>;
export function validateAuthoringOpenApiSpecification(spec: Record<string, unknown>): {
  valid: boolean;
  errors: string[];
};
export function extendOpenApiWithAuthoring(baseSpec: Record<string, unknown>): Record<string, unknown>;

/* =========================================================================
 * Task P7-04 Declarations (Approved Imports, Isolated Build & Preview, Malicious Payload Suite)
 * ========================================================================= */

export interface ApprovedImportPackageEntry {
  packageName: string;
  version: string;
  license: string;
  reviewedInTask: string;
  virtualPath: string;
  exports: readonly string[];
  sourceCode: string;
  sha256: string;
}

export const APPROVED_IMPORT_PACKAGES_REGISTRY: Readonly<Record<string, ApprovedImportPackageEntry>>;

export function getApprovedImportPackage(packageName: string): ApprovedImportPackageEntry | null;
export function listApprovedImportPackages(): Array<Omit<ApprovedImportPackageEntry, 'sourceCode'>>;
export function verifyApprovedImportsRegistryIntegrity(): {
  verified: boolean;
  packageCount: number;
  packages: Array<Omit<ApprovedImportPackageEntry, 'sourceCode'>>;
};
export function parseStaticModuleImports(sourceText: string): Array<{
  statement: string;
  specifier: string;
  namedImports: string[];
  defaultImport: string | null;
  namespaceImport: string | null;
}>;
export function validateSceneModuleImports(
  files: readonly { path?: string; relativePath?: string; content: Buffer | string }[],
  allowedPackageImports?: readonly string[],
): {
  valid: boolean;
  resolvedImports: Array<{
    fromFile: string;
    specifier: string;
    kind: 'preinstalled-package' | 'relative-module';
    resolvedTarget: string;
    version?: string;
    sha256?: string;
    importedSymbols: string[];
  }>;
  violations: Array<{ file: string; ruleId: string; message: string; specifier?: string }>;
};

export function assertNoTrustedApiExecution(
  operationContext?: string,
  attemptedPayload?: unknown,
): boolean;
export function recordIsolatedMicroVmExecution(phase: 'build' | 'render'): void;
export function getTrustedApiExecutionAudit(): Readonly<{
  trustedApiExecutionsCount: number;
  blockedTrustedApiAttemptsCount: number;
  isolatedBuildVmExecutionsCount: number;
  isolatedRenderVmExecutionsCount: number;
}>;
export function resetTrustedApiExecutionAudit(): void;

export function runDeepStaticSecurityScan(
  rawFiles: readonly { path?: string; relativePath?: string; content: Buffer | string }[],
  options?: {
    allowedPackageImports?: readonly string[];
    canarySecrets?: readonly string[];
    throwOnViolation?: boolean;
  },
): {
  passed: boolean;
  scannedFilesCount: number;
  totalSourceBytes: number;
  resolvedImports: Array<Record<string, unknown>>;
  violations: Array<{ file: string; ruleId: string; message: string; specifier?: string }>;
  evaluatedAt: string;
};

export class IsolatedSceneBuildPipeline {
  runtime: DisposableMicroVmRuntime;
  canaries: string[];
  allowedPackageImports: readonly string[];

  constructor(options?: {
    runtime?: DisposableMicroVmRuntime;
    canaries?: string[];
    allowedPackageImports?: readonly string[];
  });

  buildSceneBundle(buildInput: {
    bundleId?: string;
    revision?: number;
    entrypoint?: string;
    sourceFiles: ReadonlyArray<{ path?: string; relativePath?: string; content: Buffer | string }>;
    parameterSchema?: Record<string, unknown>;
    tenantId?: string;
    jobId?: string;
    attemptId?: string;
    leaseEpoch?: number;
    bounds?: Record<string, unknown>;
    canaries?: readonly string[];
    policyInput?: Record<string, unknown>;
    securitySelfTestMode?: boolean;
    isLeaseValid?: () => boolean;
    isCancelRequested?: () => boolean;
  }): Promise<Record<string, any>>;

  buildRegistryRevision(
    registry: SceneBundleRegistry,
    tenantId: string,
    bundleId: string,
    revision: number,
    options?: {
      canaries?: readonly string[];
      securitySelfTestMode?: boolean;
      policyInput?: Record<string, unknown>;
    },
  ): Promise<Record<string, any>>;
}

export class IsolatedScenePreviewEngine {
  runtime: DisposableMicroVmRuntime;
  canaries: string[];
  grantSigningSecret: string;
  previews: Map<string, Record<string, any>>;

  constructor(options?: {
    runtime?: DisposableMicroVmRuntime;
    canaries?: string[];
    grantSigningSecret?: string;
  });

  renderIsolatedPreview(previewInput: {
    tenantId: string;
    compiledBundle: Record<string, any>;
    mode: 'frame' | 'clip';
    profile?: string;
    canvas?: { width: number; height: number };
    fps?: number;
    totalFrames?: number;
    frameIndex?: number;
    startFrame?: number;
    durationFrames?: number;
    parameterSchema?: Record<string, unknown>;
    parameters?: Record<string, unknown>;
    stagedAssets?: ReadonlyArray<Record<string, any>>;
    outputOrigin?: string;
    format?: string;
    canaries?: readonly string[];
    policyInput?: Record<string, unknown>;
    securitySelfTestMode?: boolean;
    isLeaseValid?: () => boolean;
    isCancelRequested?: () => boolean;
  }): Promise<Record<string, any>>;

  getPreview(tenantId: string, previewId: string): Record<string, any>;

  createPreviewDownloadGrant(
    tenantId: string,
    previewId: string,
    options?: { ttlSeconds?: number; now?: Date },
  ): Readonly<{
    previewId: string;
    tenantId: string;
    format: string;
    mimeType: string;
    sha256: string;
    bytes: number;
    ttlSeconds: number;
    expiresAt: string;
    url: string;
    securityHeaders: Readonly<Record<string, string>>;
    rawCustomHtmlOrigin: boolean;
  }>;
}

export function verifySourceInjectionCannotReadCanarySecrets(options?: {
  canarySecret?: string;
}): Promise<{
  verified: boolean;
  vectorsTestedCount: number;
  directInjectionVectorsBlocked: number;
  hostEnvCanaryKey: string;
  canaryPresentInBuildVm: boolean;
  canaryPresentInRenderVm: boolean;
  canaryLeakedInArtifactsOrLogs: boolean;
  trustedApiExecutionsCount: number;
}>;

export const DEFAULT_P704_CANARY_SECRET: string;
export const MALICIOUS_PAYLOAD_CORPUS: ReadonlyArray<Record<string, any>>;

export function runMaliciousPayloadSuite(options?: {
  canarySecret?: string;
}): Promise<{
  passed: boolean;
  totalPayloads: number;
  blockedPayloads: number;
  categoriesSummary: Record<string, number>;
  trustedApiExecutionsCount: number;
  results: Array<Record<string, any>>;
}>;

export function runP704IsolatedBuildAndSecuritySelfTest(): Promise<Record<string, any>>;

/* =========================================================================
 * Task P7-05 Declarations (C1–C6 Signed Security Review, Kill Switch, Canary,
 * Allowlist, Off-by-Default Regression & Runtime Rollback Suite)
 * ========================================================================= */

export const DEFAULT_P705_REVIEW_SIGNING_SECRET: string;
export const DEFAULT_P705_CANARY_SECRET: string;
export const CANARY_SCENE_FIXTURES: ReadonlyArray<Record<string, any>>;

export interface RuntimeDigestManifest {
  adrId: string;
  runtime: string;
  rootfsImageDigest: string;
  guestKernelDigest: string;
  approvedImportsBundleDigest: string;
  compositeRuntimeFingerprint: string;
  preinstalledPackages: ReadonlyArray<{
    packageName: string;
    version: string;
    license: string;
    sha256: string;
  }>;
}

export function computeRuntimeDigestManifest(options?: {
  runtime?: string;
  rootfsImageDigest?: string;
  guestKernelDigest?: string;
  overrideApprovedImportsDigest?: string;
}): RuntimeDigestManifest;

export interface C1ToC6SignedReviewPacket {
  reviewId: string;
  taskId: string;
  adrId: string;
  runtime: string;
  rootfsImageDigest: string;
  guestKernelDigest: string;
  approvedImportsBundleDigest: string;
  compositeRuntimeFingerprint: string;
  reviewer: string;
  reviewApprovalScope: string;
  reviewedAt: string;
  expiresAt: string;
  killSwitchVerified: boolean;
  canaryVerified: boolean;
  allowlistVerified: boolean;
  offByDefaultVerified: boolean;
  rollbackVerified: boolean;
  gates: Record<string, boolean>;
  gateAttestationSignatureHex: string;
  gateEvidenceSummaries: Readonly<Record<string, Record<string, unknown>>>;
  gateAttestation: C1ToC6GateAttestation;
  signatureHex: string;
}

export function signC1ToC6ReviewPacket(
  payload: {
    reviewId?: string;
    runtimeManifest: RuntimeDigestManifest;
    reviewer: string;
    reviewedAt: string;
    expiresAt: string;
    killSwitchVerified: boolean;
    canaryVerified: boolean;
    allowlistVerified: boolean;
    offByDefaultVerified: boolean;
    rollbackVerified: boolean;
    gates: Record<string, boolean>;
    gateEvidenceSummaries?: Record<string, Record<string, unknown>>;
    reviewApprovalScope?: string;
  },
  signingSecret: string,
): C1ToC6SignedReviewPacket;

export function verifyC1ToC6ReviewPacket(
  packet: Record<string, any> | null | undefined,
  expectedManifest: RuntimeDigestManifest,
  signingSecret: string,
  now?: Date,
): boolean;

export class CustomRuntimeRolloutController {
  runtime: DisposableMicroVmRuntime;
  runtimeManifest: RuntimeDigestManifest;
  signingSecret: string;
  canarySecret: string;
  customCodeEnabled: boolean;
  customRuntime: string;
  tenantAllowlist: Set<string>;
  killSwitchActive: boolean;
  killSwitchReason: string | null;
  restoreLockActive: boolean;
  restoreLockReason: string | null;
  activeReviewPacket: Record<string, any> | null;
  lastCanaryReport: Record<string, any> | null;
  revokedRuntimeDigests: Set<string>;
  customJobs: Map<string, Record<string, any>>;
  issuedGrants: Map<string, Record<string, any>>;
  auditEvents: Array<Record<string, any>>;

  constructor(options?: {
    runtime?: DisposableMicroVmRuntime;
    runtimeManifest?: RuntimeDigestManifest;
    signingSecret?: string;
    canarySecret?: string;
  });

  getConfigSnapshot(): Readonly<{
    CVE_CUSTOM_CODE_ENABLED: boolean;
    CVE_CUSTOM_RUNTIME: string;
    CVE_CUSTOM_TENANT_ALLOWLIST: readonly string[];
    killSwitchActive: boolean;
    killSwitchReason: string | null;
    restoreLockActive: boolean;
    restoreLockReason: string | null;
    activeRuntimeFingerprint: string;
    rootfsImageDigest: string;
    guestKernelDigest: string;
    approvedImportsBundleDigest: string;
    revokedRuntimeDigests: readonly string[];
  }>;

  verifyStructuredRenderingPathUnaffected(engine?: string): Readonly<{
    engine: string;
    allowed: boolean;
    customCodeEnabled: boolean;
    killSwitchActive: boolean;
    restoreLockActive: boolean;
    structuredPathUnaffected: boolean;
  }>;

  runCanaryVerificationSuite(): Promise<Readonly<{
    passed: boolean;
    fixturesCount: number;
    passedFixturesCount: number;
    hostCanaryEnvKey: string;
    canarySecretLeaked: boolean;
    trustedApiExecutionsCount: number;
    evaluatedAt: string;
    fixtures: ReadonlyArray<Record<string, any>>;
  }>>;

  enablePilotRollout(input: {
    signedReviewPacket: Record<string, any>;
    pilotTenants: readonly string[];
    signingSecret?: string;
    hostProbe?: HostVirtualizationProbeResult;
    skipCanaryRerunIfPassed?: boolean;
  }): Promise<ReturnType<CustomRuntimeRolloutController['getConfigSnapshot']>>;

  assertTenantAllowedForCustomCode(
    tenantId: string,
    options?: { hostProbe?: HostVirtualizationProbeResult },
  ): ReturnType<typeof evaluateCustomRuntimePolicy>;

  enrollPilotTenant(tenantId: string): string[];

  revokePilotTenant(
    tenantId: string,
    reason?: string,
  ): {
    tenantId: string;
    allowlist: string[];
    terminatedJobsCount: number;
    revokedGrantsCount: number;
  };

  registerActiveCustomJob(input: {
    jobId: string;
    tenantId: string;
    kind?: 'build' | 'preview' | 'render' | 'authoring';
    onTerminate?: (reason: string) => void;
    hostProbe?: HostVirtualizationProbeResult;
  }): Record<string, any>;

  registerIssuedDownloadGrant(input: {
    grantId: string;
    previewId: string;
    tenantId: string;
  }): Record<string, any>;

  assertDownloadGrantActive(grantId: string): Record<string, any>;

  triggerEmergencyKillSwitch(
    reason?: string,
    triggeredBy?: string,
  ): Readonly<{
    killSwitchActive: boolean;
    CVE_CUSTOM_CODE_ENABLED: boolean;
    CVE_CUSTOM_RUNTIME: string;
    reason: string;
    triggeredBy: string;
    triggeredAt: string;
    terminatedCustomJobsCount: number;
    terminatedJobIds: readonly string[];
    revokedGrantsCount: number;
    revokedGrantIds: readonly string[];
    structuredRenderingUnaffected: boolean;
  }>;

  clearEmergencyKillSwitchAfterRevalidation(input: {
    signedReviewPacket: Record<string, any>;
    signingSecret?: string;
  }): Promise<ReturnType<CustomRuntimeRolloutController['getConfigSnapshot']>>;

  activatePostRestoreSafetyLock(
    restoreId?: string,
  ): ReturnType<CustomRuntimeRolloutController['getConfigSnapshot']>;

  revalidateAfterRestore(input: {
    signedReviewPacket: Record<string, any>;
    signingSecret?: string;
  }): Promise<ReturnType<CustomRuntimeRolloutController['getConfigSnapshot']>>;

  revokeCompromisedRuntimeDigest(
    vulnerableDigest: string,
    reason?: string,
  ): Readonly<{
    vulnerableDigest: string;
    reason: string;
    abortedRunningJobsCount: number;
    abortedJobIds: readonly string[];
    customCodeDisabled: boolean;
  }>;

  rollbackToDefaultOff(reason?: string): Readonly<{
    CVE_CUSTOM_CODE_ENABLED: boolean;
    CVE_CUSTOM_RUNTIME: string;
    reason: string;
    canceledCustomJobsCount: number;
    structuredRenderingUnaffected: boolean;
  }>;

  rollbackToPinnedRuntime(input: {
    targetManifest: RuntimeDigestManifest;
    signedReviewPacket: Record<string, any>;
    pilotTenants: readonly string[];
    signingSecret?: string;
    hostProbe?: HostVirtualizationProbeResult;
  }): Promise<ReturnType<CustomRuntimeRolloutController['getConfigSnapshot']>>;
}

export function evaluateAllC1ToC6Gates(options?: {
  signingSecret?: string;
  canarySecret?: string;
  reviewer?: string;
  reviewedAt?: string;
  expiresAt?: string;
}): Promise<Readonly<{
  passed: boolean;
  runtimeManifest: RuntimeDigestManifest;
  gates: Readonly<Record<string, boolean>>;
  gateEvidenceSummaries: Readonly<Record<string, Record<string, any>>>;
  signedReviewPacket: C1ToC6SignedReviewPacket;
}>>;

export function runOffByDefaultAndRollbackSuite(options?: {
  signedReviewPacket?: Record<string, any>;
  signingSecret?: string;
}): Promise<Readonly<{
  passed: boolean;
  offByDefaultRegression: Readonly<Record<string, boolean>>;
  rollbackDrill: Readonly<Record<string, any>>;
}>>;

export function runP705SecurityReviewSelfTest(): Promise<Record<string, any>>;

// =============================================================================
// Task P7-06: Three Custom Scene Variants, Measured Cost & Approval Workflow
// =============================================================================

export const PILOT_CREATIVE_BRIEF: string;
export const DEFAULT_PILOT_TENANT_ID: string;

export const COST_MODEL_RATES: Readonly<{
  mockPromptPer1kTokens: number;
  mockCompletionPer1kTokens: number;
  standardPromptPer1kTokens: number;
  standardCompletionPer1kTokens: number;
  vcpuPerHourUsd: number;
  vcpuPerSecondUsd: number;
}>;

export function computeSha256(input: string | Buffer): string;

export function createKineticPromoVariant(
  options?: Record<string, unknown>,
): Readonly<Record<string, any>>;

export function createMetricCounterVariant(
  options?: Record<string, unknown>,
): Readonly<Record<string, any>>;

export function createAmbientVisualizerVariant(
  options?: Record<string, unknown>,
): Readonly<Record<string, any>>;

export function generateThreeCustomSceneVariants(
  options?: Record<string, unknown>,
): ReadonlyArray<Readonly<Record<string, any>>>;

export function measureAuthoringCost(params: {
  brief: string;
  sourceFiles: readonly { relativePath: string; content: string }[];
  durationMs: number;
  modelId?: string;
}): Readonly<{
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
  durationSeconds: number;
  mockCostUsd: number;
  standardTierCostUsd: number;
  currency: string;
  isNonPremiumRoute: boolean;
}>;

export function measureRenderCost(params: {
  buildResult: {
    buildDurationMs?: number;
    compiledBytes?: Buffer | Uint8Array;
    sourceBytes?: number;
  };
  previewResult?: {
    renderDurationMs?: number;
    artifactBytes?: Buffer | Uint8Array;
    mode?: string;
    format?: string;
    outputDimensions?: { width: number; height: number };
  };
  totalFrames?: number;
  fps?: number;
}): Readonly<Record<string, any>>;

export function buildSceneBundleManifest(
  input: Record<string, any>,
): Readonly<Record<string, any>>;

export function materializeCustomSceneComposition(
  input: Record<string, any>,
): Readonly<Record<string, any>>;

export class CustomSceneApprovalWorkflow {
  constructor(options?: {
    rolloutController?: CustomRuntimeRolloutController;
    registry?: SceneBundleRegistry;
    runtime?: DisposableMicroVmRuntime;
    pilotTenants?: string[];
    signingSecret?: string;
    canarySecret?: string;
  });

  assertPilotAuthorization(tenantId: string): void;

  generateVariantsFromBrief(input: {
    tenantId: string;
    brief?: string;
    modelId?: string;
  }): Promise<ReadonlyArray<Record<string, any>>>;

  buildVariantRevision(input: {
    tenantId: string;
    variantId: string;
    revision?: number;
  }): Promise<Readonly<Record<string, any>>>;

  renderVariantPreview(input: {
    tenantId: string;
    variantId: string;
    revision?: number;
    mode?: 'frame' | 'clip';
    frameIndex?: number;
    startFrame?: number;
    durationFrames?: number;
    overrideParameters?: Record<string, unknown>;
  }): Promise<Readonly<Record<string, any>>>;

  applyUserRevision(input: {
    tenantId: string;
    variantId: string;
    baseRevision: number;
    customParameters?: Record<string, unknown>;
    updatedFiles?: Array<{ path: string; content: string }>;
    changeNote?: string;
  }): Promise<Readonly<Record<string, any>>>;

  approveVariantRevision(input: {
    tenantId: string;
    selectedVariantId: string;
    selectedRevision?: number;
    approvedBy: string;
    approvalNotes?: string;
  }): Promise<Readonly<Record<string, any>>>;

  getWorkflowSummary(): ReadonlyArray<Record<string, any>>;
}

export function runP706CustomSceneVariantsSelfTest(): Promise<Record<string, any>>;
