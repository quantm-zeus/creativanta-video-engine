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
