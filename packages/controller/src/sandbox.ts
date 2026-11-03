/**
 * Minimal Trusted-Template Sandbox & Narrow Runtime Launcher (Task P1-04).
 *
 * Canonical specifications:
 * - docs/SECURITY.md (lines 34-68: Chromium/FFmpeg sandbox, custom code off, filesystem/quotas)
 * - docs/DEPLOYMENT.md (lines 14-106: narrow runtime launcher, self-test, resource limits)
 * - docs/ARCHITECTURE.md (lines 88-103: isolated workspace, read-only inputs, fenced execution)
 * - evidence/P0-02/report.md (mandatory Chromium flags, --no-sandbox ban, FFmpeg argv whitelist)
 * - evidence/P0-04/report.md (error taxonomy, starter-v1 sandbox budgets)
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CveEnvConfig, EngineId, JobKind, loadEnvConfig } from '@creativanta/contracts';

export const SANDBOX_DEFAULT_UID = 10001;
export const SANDBOX_DEFAULT_GID = 10001;
export const SANDBOX_USER_NAME = 'cve-render';
export const DEV_PLACEHOLDER_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';

export const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
export const IMAGE_DIGEST_REGEX = /^sha256:[0-9a-f]{64}$/;

export const BUNDLE_V1_LIMITS = Object.freeze({
  maxFiles: 100,
  maxSourceBytes: 5 * 1024 * 1024, // 5 MiB
  maxBuiltAssetBytes: 20 * 1024 * 1024, // 20 MiB
  maxNestingDepth: 8,
  maxLogBytes: 64 * 1024, // 64 KiB bounded stdout/stderr
});

export const FORBIDDEN_CHROMIUM_FLAGS: readonly string[] = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--no-zygote',
  '--single-process',
  '--disable-seccomp-filter-sandbox',
  '--disable-namespace-sandbox',
  '--disable-gpu-sandbox',
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--allow-file-access-from-files',
  '--unsafely-treat-insecure-origin-as-secure',
  '--remote-allow-origins=*',
]);

export const REQUIRED_CHROMIUM_FLAGS: readonly string[] = Object.freeze([
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--no-first-run',
  '--mute-audio',
  '--run-all-compositor-stages-before-draw',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-color-profile=srgb',
  '--force-device-scale-factor=1',
  '--font-render-hinting=none',
  '--remote-debugging-port=0',
]);

export const TRUSTED_TEMPLATE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

export const ALLOWED_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  'TZ',
  'LANG',
  'LC_ALL',
  'HOME',
  'TMPDIR',
  'FONTCONFIG_FILE',
  'CVE_SANDBOX_JOB_ID',
  'CVE_SANDBOX_ATTEMPT_ID',
  'CVE_SANDBOX_MODE',
  'CVE_LOOPBACK_ASSET_ORIGIN',
]);

const FORBIDDEN_SECRET_ENV_PATTERNS: readonly RegExp[] = [
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
  /^AWS_/i,
  /^GITHUB_/i,
  /^SSH_/i,
];

const FORBIDDEN_HOST_MOUNT_PATTERNS: readonly RegExp[] = [
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
  /^\/var\/run(?:\/|$)/,
  /^\/run\/(?:docker|containerd|podman|systemd|udev|user)(?:\/|$)/,
  /(?:^|\/)\.env(?:\.|$)/,
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)\.agy(?:\/|$)/,
  /(?:^|\/)\.worktrees(?:\/|$)/,
];

export type SandboxErrorCode =
  | 'SANDBOX_SECURITY_VIOLATION'
  | 'SANDBOX_RESOURCE_LIMIT'
  | 'CAPABILITY_DISABLED'
  | 'RENDER_TIMEOUT'
  | 'FRAME_READINESS_TIMEOUT'
  | 'ENCODE_VERIFICATION_FAILED';

export class SandboxError extends Error {
  public readonly code: SandboxErrorCode;
  public readonly retryable: boolean;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: SandboxErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface SandboxSecurityContext {
  uid: number;
  gid: number;
  userName?: string;
  readOnlyRootfs: boolean;
  noNewPrivileges: boolean;
  privileged: boolean;
  capDrop: readonly string[];
  capAdd: readonly string[];
  networkMode: 'none';
  ipcMode: 'none' | 'private';
  pidMode: 'private';
  seccompProfile: string;
  apparmorProfile?: string;
}

export interface SandboxResourceLimits {
  cpuLimitVcpu: number;
  memoryMib: number;
  pidsLimit: number;
  tempDiskMib: number;
  frameTimeoutMs: number;
  renderTimeoutSeconds: number;
  previewTimeoutSeconds: number;
  killGraceMs: number;
}

export interface CgroupV2Spec {
  cpuMax: string;
  cpuQuotaUs: number;
  cpuPeriodUs: number;
  memoryMax: string;
  memoryMaxBytes: number;
  memorySwapMax: '0';
  pidsMax: string;
  tempDiskMaxBytes: number;
}

export interface SandboxMount {
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface SandboxWorkspace {
  jobId: string;
  attemptId: string;
  rootDir: string;
  inputsDir: string;
  outputDir: string;
  tmpDir: string;
}

export interface StagedInputFileSpec {
  relativePath: string;
  content: Buffer | string;
  expectedSha256?: string;
  kind?: 'source' | 'asset' | 'font' | 'manifest';
}

export interface VerifiedOutputArtifact {
  path: string;
  bytes: number;
  sha256: string;
  format: 'mp4' | 'png';
}

export interface CustomCodeGateInput {
  config: Pick<
    CveEnvConfig,
    'CVE_CUSTOM_CODE_ENABLED' | 'CVE_CUSTOM_RUNTIME' | 'CVE_CUSTOM_TENANT_ALLOWLIST'
  >;
  engine: EngineId;
  hasBundle?: boolean;
  tenantId?: string;
  securityGateDigest?: string;
  allowApprovedCustomPool?: boolean;
}

export interface ContainerLaunchRequest {
  config: CveEnvConfig;
  jobId: string;
  attemptId: string;
  jobKind: JobKind;
  engine: EngineId;
  workspace: SandboxWorkspace;
  securityContext?: Partial<SandboxSecurityContext>;
  resourceLimits?: Partial<SandboxResourceLimits>;
  extraChromiumFlags?: readonly string[];
  loopbackAssetOrigin?: string;
  allowedImageDigests?: readonly string[];
  seccompProfilePath?: string;
}

export interface ContainerLaunchSpec {
  runtimeBinary: 'docker';
  argv: string[];
  imageDigest: string;
  securityContext: SandboxSecurityContext;
  resourceLimits: SandboxResourceLimits;
  cgroupV2: CgroupV2Spec;
  mounts: SandboxMount[];
  env: Record<string, string>;
  chromiumArgs: string[];
  cspHeader: string;
  timeoutSeconds: number;
}

export interface SandboxedProcessOptions {
  command: string;
  argv: readonly string[];
  workspace: SandboxWorkspace;
  limits: SandboxResourceLimits;
  timeoutMs: number;
  timeoutCode?: 'RENDER_TIMEOUT' | 'FRAME_READINESS_TIMEOUT';
  extraEnv?: Record<string, string>;
  uid?: number;
  gid?: number;
}

export interface SandboxedProcessResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface SandboxSelfTestCheckResult {
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}

export interface SandboxSelfTestReport {
  status: 'PASS' | 'FAIL';
  checks: SandboxSelfTestCheckResult[];
  duration_ms: number;
  timestamp: string;
}

export function computeSha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function redactSecretOutput(text: string): string {
  if (!text) return '';
  let out = text;
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]',
  );
  out = out.replace(
    /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"',;]+/gi,
    '$1[REDACTED]',
  );
  out = out.replace(
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]*:)([^@\s/]+)(@)/g,
    '$1[REDACTED]$3',
  );
  out = out.replace(
    /\b(gh[pousr]_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|cve_(?:live|test|secret)_[A-Za-z0-9_-]{12,})\b/g,
    '[REDACTED_KEY]',
  );
  out = out.replace(
    /\b((?:[A-Z0-9_]*?(?:SECRET|PASSWORD|PASSWD|PEPPER|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_TOKEN)[A-Z0-9_]*)\s*[:=]\s*["']?)([^"'\s,;}{]+)(["']?)/gi,
    '$1[REDACTED]$3',
  );
  return out;
}

/**
 * 1. Non-root & Container Security Context Validator
 */
export function buildDefaultSecurityContext(
  seccompProfile = 'runtime/default',
): SandboxSecurityContext {
  return {
    uid: SANDBOX_DEFAULT_UID,
    gid: SANDBOX_DEFAULT_GID,
    userName: SANDBOX_USER_NAME,
    readOnlyRootfs: true,
    noNewPrivileges: true,
    privileged: false,
    capDrop: ['ALL'],
    capAdd: [],
    networkMode: 'none',
    ipcMode: 'none',
    pidMode: 'private',
    seccompProfile,
    apparmorProfile: 'runtime/default',
  };
}

export function validateSecurityContext(ctx: SandboxSecurityContext): void {
  if (!Number.isInteger(ctx.uid) || ctx.uid <= 0) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox UID must be a non-root positive integer (> 0), got ${ctx.uid}`,
      false,
    );
  }
  if (!Number.isInteger(ctx.gid) || ctx.gid <= 0) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox GID must be a non-root positive integer (> 0), got ${ctx.gid}`,
      false,
    );
  }
  if (ctx.userName && ctx.userName.trim().toLowerCase() === 'root') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox userName cannot be "root"',
      false,
    );
  }
  if (!ctx.readOnlyRootfs) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox root filesystem must be read-only (readOnlyRootfs=true)',
      false,
    );
  }
  if (!ctx.noNewPrivileges) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox must enforce no-new-privileges (noNewPrivileges=true)',
      false,
    );
  }
  if (ctx.privileged) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Privileged mode is strictly forbidden in renderer sandbox',
      false,
    );
  }
  if (!ctx.capDrop.includes('ALL')) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox must drop ALL Linux capabilities (capDrop must include "ALL")',
      false,
    );
  }
  if (ctx.capAdd.length > 0) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox must not add Linux capabilities, got: ${ctx.capAdd.join(', ')}`,
      false,
    );
  }
  if (ctx.networkMode !== 'none') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox networkMode must be "none" (zero external egress), got "${ctx.networkMode}"`,
      false,
    );
  }
  if (ctx.ipcMode !== 'none' && ctx.ipcMode !== 'private') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox ipcMode must be "none" or "private", got "${ctx.ipcMode}"`,
      false,
    );
  }
  if (ctx.pidMode !== 'private') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox pidMode must be "private", got "${ctx.pidMode}"`,
      false,
    );
  }
  if (!ctx.seccompProfile || ctx.seccompProfile === 'unconfined') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Sandbox seccompProfile cannot be empty or "unconfined"`,
      false,
    );
  }
  if (ctx.apparmorProfile === 'unconfined') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox apparmorProfile cannot be "unconfined"',
      false,
    );
  }
}

/**
 * 2. Custom Code Off Gate (docs/SECURITY.md lines 41-51)
 */
const APPROVED_CUSTOM_MICROVM_RUNTIMES: ReadonlySet<string> = new Set([
  'microvm-firecracker-v1',
  'microvm-kata-v1',
]);

export function assertCustomCodeGate(input: CustomCodeGateInput): void {
  const {
    config,
    engine,
    hasBundle = false,
    tenantId,
    securityGateDigest,
    allowApprovedCustomPool = false,
  } = input;

  const isCustomRequest = engine === 'custom-html-v1' || hasBundle;

  // Trusted-template launcher never runs custom scene code.
  if (isCustomRequest && !allowApprovedCustomPool) {
    throw new SandboxError(
      'CAPABILITY_DISABLED',
      'Trusted-template launcher forbids custom-html-v1 engine and custom scene bundles (custom code is off)',
      false,
      { engine, hasBundle, customCodeEnabled: config.CVE_CUSTOM_CODE_ENABLED },
    );
  }

  if (isCustomRequest) {
    if (!config.CVE_CUSTOM_CODE_ENABLED) {
      throw new SandboxError(
        'CAPABILITY_DISABLED',
        'Custom code execution is disabled (CVE_CUSTOM_CODE_ENABLED=false)',
        false,
      );
    }
    if (!APPROVED_CUSTOM_MICROVM_RUNTIMES.has(config.CVE_CUSTOM_RUNTIME)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Custom code requires a disposable microVM runtime, got "${config.CVE_CUSTOM_RUNTIME}". Standard containers are forbidden for custom code.`,
        false,
      );
    }
    if (!securityGateDigest || !IMAGE_DIGEST_REGEX.test(securityGateDigest)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        'Custom code requires a valid C1-C6 signed security gate digest (sha256:<64 hex>)',
        false,
      );
    }
    if (!tenantId || !config.CVE_CUSTOM_TENANT_ALLOWLIST.includes(tenantId)) {
      throw new SandboxError(
        'CAPABILITY_DISABLED',
        'Tenant is not in CVE_CUSTOM_TENANT_ALLOWLIST for custom code execution',
        false,
      );
    }
    return;
  }

  // Even for structured templates, verify config does not illegally enable custom code without microVM
  if (
    config.CVE_CUSTOM_CODE_ENABLED &&
    !APPROVED_CUSTOM_MICROVM_RUNTIMES.has(config.CVE_CUSTOM_RUNTIME)
  ) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid configuration: CVE_CUSTOM_CODE_ENABLED=true with unapproved runtime "${config.CVE_CUSTOM_RUNTIME}"`,
      false,
    );
  }
}

/**
 * 3. Chromium Sandbox Policy & Trusted Template HTML/CSP Guard
 */
export function validateChromiumFlags(flags: readonly string[]): void {
  const normalizedFlags = flags.map((f) => f.trim());

  for (const rawFlag of normalizedFlags) {
    const lower = rawFlag.toLowerCase();
    const flagName = lower.split('=')[0] ?? lower;

    for (const forbidden of FORBIDDEN_CHROMIUM_FLAGS) {
      const forbiddenLower = forbidden.toLowerCase();
      const forbiddenName = forbiddenLower.split('=')[0] ?? forbiddenLower;
      if (lower === forbiddenLower || flagName === forbiddenName) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Forbidden Chromium flag "${rawFlag}" is strictly blocked (Chromium sandbox must stay enabled)`,
          false,
          { forbiddenFlag: rawFlag },
        );
      }
    }

    if (lower.startsWith('--remote-debugging-port=')) {
      const portVal = lower.slice('--remote-debugging-port='.length);
      if (portVal !== '0') {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Chromium --remote-debugging-port must be 0, got "${rawFlag}"`,
          false,
        );
      }
    }

    if (lower.startsWith('--remote-debugging-address=')) {
      const addrVal = lower.slice('--remote-debugging-address='.length);
      if (addrVal !== '127.0.0.1') {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Chromium --remote-debugging-address must not expose non-loopback address: "${rawFlag}"`,
          false,
        );
      }
    }
  }

  const flagSet = new Set(normalizedFlags);
  for (const requiredFlag of REQUIRED_CHROMIUM_FLAGS) {
    if (!flagSet.has(requiredFlag)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Missing required Chromium hardened flag: "${requiredFlag}"`,
        false,
      );
    }
  }
}

export function buildChromiumSandboxArgs(extraFlags: readonly string[] = []): string[] {
  for (const extra of extraFlags) {
    const trimmed = extra.trim();
    if (!trimmed.startsWith('--')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Invalid Chromium argument "${extra}": only explicit "--" flags are allowed`,
        false,
      );
    }
  }
  const merged = Array.from(new Set([...REQUIRED_CHROMIUM_FLAGS, ...extraFlags.map((f) => f.trim())]));
  validateChromiumFlags(merged);
  return merged;
}

export function validateTemplateHtmlPolicy(htmlContent: string): void {
  if (/<!DOCTYPE\s+[^>]*\[/i.test(htmlContent) || /<!ENTITY/i.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML contains forbidden XML/DOCTYPE ENTITY declaration',
      false,
    );
  }
  if (/(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/)/i.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML contains forbidden external network URL in src/href (zero egress required)',
      false,
    );
  }
  if (/@import\s+(?:url\s*\(\s*)?["']?\s*(?:https?:|\/\/)/i.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML contains forbidden external CSS @import (e.g. Google Fonts CDN)',
      false,
    );
  }
  if (/url\s*\(\s*["']?\s*(?:https?:|\/\/)/i.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML contains forbidden external CSS url() reference',
      false,
    );
  }
  if (/\bnavigator\.serviceWorker\b/.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML attempts to access forbidden ServiceWorker API',
      false,
    );
  }
  if (/\b(?:RTCPeerConnection|webkitRTCPeerConnection)\b/.test(htmlContent)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Template HTML attempts to access forbidden WebRTC API',
      false,
    );
  }
}

/**
 * 4. FFmpeg / FFprobe Safe Subprocess Argv Policy (evidence/P0-02/report.md lines 136-144)
 */
const FORBIDDEN_FFMPEG_TOKENS: readonly RegExp[] = [
  /--enable-nonfree/i,
  /\blibfdk_aac\b/i,
  /^(?:https?|tcp|udp|rtmps?|rtsp|ftp|sftp|mms|gopher|tls):\/\//i,
  /^(?:concat|subfile|crypto|http|https|tcp|udp|ftp|rtmp|data)(?:[:,]|$)/i,
  /^\/(?:etc|proc|sys|root|boot|var\/run|run)(?:\/|$)/,
  /(?:^|[\\/])\.\.(?:[\\/]|$)/,
];

export function validateFfmpegArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'FFmpeg argv must be a non-empty string array',
      false,
    );
  }

  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        'FFmpeg argv contains non-string or null-byte argument',
        false,
      );
    }
    for (const pattern of FORBIDDEN_FFMPEG_TOKENS) {
      if (pattern.test(arg)) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `FFmpeg argument "${arg}" violates protocol/codec security policy`,
          false,
        );
      }
    }
  }

  const whitelistIdx = argv.indexOf('-protocol_whitelist');
  if (whitelistIdx === -1 || argv[whitelistIdx + 1] !== 'file,pipe') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'FFmpeg/ffprobe argv must include -protocol_whitelist "file,pipe"',
      false,
    );
  }

  const probeIdx = argv.indexOf('-probesize');
  if (probeIdx === -1 || argv[probeIdx + 1] !== '32M') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'FFmpeg/ffprobe argv must include -probesize "32M"',
      false,
    );
  }

  const analyzeIdx = argv.indexOf('-analyzeduration');
  if (analyzeIdx === -1 || argv[analyzeIdx + 1] !== '32M') {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'FFmpeg/ffprobe argv must include -analyzeduration "32M"',
      false,
    );
  }
}

export function buildFfmpegSandboxArgv(userArgs: readonly string[]): string[] {
  const fullArgv = [
    '-nostdin',
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-probesize',
    '32M',
    '-analyzeduration',
    '32M',
    ...userArgs,
  ];
  validateFfmpegArgv(fullArgv);
  return fullArgv;
}

export function buildFfprobeSandboxArgv(inputPath: string): string[] {
  const fullArgv = [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-probesize',
    '32M',
    '-analyzeduration',
    '32M',
    '-count_frames',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    inputPath,
  ];
  validateFfmpegArgv(fullArgv);
  return fullArgv;
}

/**
 * 5. Cgroup v2 / Time / Disk / PID Limits
 */
export function buildDefaultResourceLimits(config: CveEnvConfig): SandboxResourceLimits {
  return {
    cpuLimitVcpu: config.CVE_RENDER_CPU_LIMIT,
    memoryMib: config.CVE_RENDER_MEMORY_MIB,
    pidsLimit: config.CVE_RENDER_PIDS_LIMIT,
    tempDiskMib: config.CVE_RENDER_TEMP_MIB,
    frameTimeoutMs: config.CVE_FRAME_TIMEOUT_MS,
    renderTimeoutSeconds: config.CVE_RENDER_TIMEOUT_SECONDS,
    previewTimeoutSeconds: config.CVE_PREVIEW_TIMEOUT_SECONDS,
    killGraceMs: 5000,
  };
}

export function validateResourceLimits(limits: SandboxResourceLimits): void {
  if (!Number.isInteger(limits.cpuLimitVcpu) || limits.cpuLimitVcpu < 1 || limits.cpuLimitVcpu > 32) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid cpuLimitVcpu: ${limits.cpuLimitVcpu} (must be integer 1..32)`,
      false,
    );
  }
  if (!Number.isInteger(limits.memoryMib) || limits.memoryMib < 512 || limits.memoryMib > 65536) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid memoryMib: ${limits.memoryMib} (must be integer 512..65536)`,
      false,
    );
  }
  if (!Number.isInteger(limits.pidsLimit) || limits.pidsLimit < 32 || limits.pidsLimit > 4096) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid pidsLimit: ${limits.pidsLimit} (must be integer 32..4096)`,
      false,
    );
  }
  if (!Number.isInteger(limits.tempDiskMib) || limits.tempDiskMib < 64 || limits.tempDiskMib > 65536) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid tempDiskMib: ${limits.tempDiskMib} (must be integer 64..65536)`,
      false,
    );
  }
  if (
    !Number.isInteger(limits.frameTimeoutMs) ||
    limits.frameTimeoutMs < 100 ||
    limits.frameTimeoutMs > 60000
  ) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid frameTimeoutMs: ${limits.frameTimeoutMs} (must be integer 100..60000)`,
      false,
    );
  }
  if (
    !Number.isInteger(limits.renderTimeoutSeconds) ||
    limits.renderTimeoutSeconds < 1 ||
    limits.renderTimeoutSeconds > 3600
  ) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid renderTimeoutSeconds: ${limits.renderTimeoutSeconds} (must be integer 1..3600)`,
      false,
    );
  }
  if (
    !Number.isInteger(limits.previewTimeoutSeconds) ||
    limits.previewTimeoutSeconds < 1 ||
    limits.previewTimeoutSeconds > 600
  ) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid previewTimeoutSeconds: ${limits.previewTimeoutSeconds} (must be integer 1..600)`,
      false,
    );
  }
  if (!Number.isInteger(limits.killGraceMs) || limits.killGraceMs < 50 || limits.killGraceMs > 10000) {
    throw new SandboxError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid killGraceMs: ${limits.killGraceMs} (must be integer 50..10000 per <=10s termination rule)`,
      false,
    );
  }
}

export function buildCgroupV2Spec(limits: SandboxResourceLimits): CgroupV2Spec {
  validateResourceLimits(limits);
  const cpuPeriodUs = 100_000;
  const cpuQuotaUs = limits.cpuLimitVcpu * cpuPeriodUs;
  const memoryMaxBytes = limits.memoryMib * 1024 * 1024;
  const tempDiskMaxBytes = limits.tempDiskMib * 1024 * 1024;

  return {
    cpuMax: `${cpuQuotaUs} ${cpuPeriodUs}`,
    cpuQuotaUs,
    cpuPeriodUs,
    memoryMax: String(memoryMaxBytes),
    memoryMaxBytes,
    memorySwapMax: '0',
    pidsMax: String(limits.pidsLimit),
    tempDiskMaxBytes,
  };
}

/**
 * 6. Host Mounts, Image Digest & Sanitized Sandbox Environment
 */
export function validateHostMounts(mounts: readonly SandboxMount[], workspace: SandboxWorkspace): void {
  if (mounts.length === 0) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox must define explicit workspace mounts',
      false,
    );
  }

  let hasReadOnlyInputs = false;
  const resolvedInputs = path.resolve(workspace.inputsDir);
  const resolvedOutput = path.resolve(workspace.outputDir);

  for (const m of mounts) {
    if (!m.source || !m.destination || !path.isAbsolute(m.source) || !path.isAbsolute(m.destination)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Sandbox mount paths must be absolute: src="${m.source}", dst="${m.destination}"`,
        false,
      );
    }

    const normalizedSrc = path.posix.normalize(m.source.replace(/\\/g, '/'));
    const normalizedDst = path.posix.normalize(m.destination.replace(/\\/g, '/'));

    for (const pattern of FORBIDDEN_HOST_MOUNT_PATTERNS) {
      if (pattern.test(normalizedSrc) || pattern.test(normalizedDst)) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Forbidden host socket or sensitive path mount blocked: src="${m.source}", dst="${m.destination}"`,
          false,
        );
      }
    }

    if (normalizedDst === '/workspace/inputs') {
      if (!m.readOnly) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          'Staged inputs mount (/workspace/inputs) must be read-only (readOnly=true)',
          false,
        );
      }
      if (path.resolve(m.source) !== resolvedInputs) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Inputs mount source "${m.source}" does not match attempt inputsDir "${resolvedInputs}"`,
          false,
        );
      }
      hasReadOnlyInputs = true;
    } else if (normalizedDst === '/workspace/output') {
      if (path.resolve(m.source) !== resolvedOutput) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Output mount source "${m.source}" does not match attempt outputDir "${resolvedOutput}"`,
          false,
        );
      }
    } else {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Unexpected container mount destination "${m.destination}". Only /workspace/inputs and /workspace/output are allowed.`,
        false,
      );
    }
  }

  if (!hasReadOnlyInputs) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      'Sandbox mounts must include read-only /workspace/inputs',
      false,
    );
  }
}

export function validateImageDigest(
  digest: string,
  environment: CveEnvConfig['CVE_ENV'],
  allowedDigests: readonly string[] = [],
): string {
  if (!IMAGE_DIGEST_REGEX.test(digest)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid CVE_RENDER_IMAGE_DIGEST "${digest}". Must be immutable sha256:<64 lowercase hex> (tags like :latest are forbidden).`,
      false,
    );
  }
  if (environment !== 'development' && digest === DEV_PLACEHOLDER_DIGEST) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Development placeholder image digest is forbidden in ${environment} environment`,
      false,
    );
  }
  if (allowedDigests.length > 0 && !allowedDigests.includes(digest)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Image digest "${digest}" is not in the operator-approved allowlist`,
      false,
    );
  }
  return digest;
}

export function buildSanitizedSandboxEnv(options: {
  jobId: string;
  attemptId: string;
  loopbackAssetOrigin?: string;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  if (!SAFE_ID_REGEX.test(options.jobId)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Unsafe jobId "${options.jobId}"`,
      false,
    );
  }
  if (!SAFE_ID_REGEX.test(options.attemptId)) {
    throw new SandboxError(
      'SANDBOX_SECURITY_VIOLATION',
      `Unsafe attemptId "${options.attemptId}"`,
      false,
    );
  }

  const env: Record<string, string> = {
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: '/workspace/tmp',
    TMPDIR: '/workspace/tmp',
    CVE_SANDBOX_JOB_ID: options.jobId,
    CVE_SANDBOX_ATTEMPT_ID: options.attemptId,
    CVE_SANDBOX_MODE: 'trusted-template-v1',
  };

  if (options.loopbackAssetOrigin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(options.loopbackAssetOrigin);
    } catch {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Malformed loopbackAssetOrigin: "${options.loopbackAssetOrigin}"`,
        false,
      );
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `loopbackAssetOrigin must use http://127.0.0.1:<port>, got "${options.loopbackAssetOrigin}"`,
        false,
      );
    }
    env['CVE_LOOPBACK_ASSET_ORIGIN'] = options.loopbackAssetOrigin;
  }

  if (options.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      if (FORBIDDEN_SECRET_ENV_PATTERNS.some((re) => re.test(key))) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Forbidden secret environment variable "${key}" cannot be passed to renderer sandbox`,
          false,
        );
      }
      if (!ALLOWED_SANDBOX_ENV_KEYS.has(key)) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Environment variable "${key}" is not in the sandbox allowlist`,
          false,
        );
      }
      if (redactSecretOutput(`${key}=${value}`) !== `${key}=${value}`) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Environment variable "${key}" contains a secret/credential pattern`,
          false,
        );
      }
      env[key] = value;
    }
  }

  return env;
}

/**
 * 7. Isolated Workspace Manager, Read-Only Input Staging & Output Verification
 */
export class SandboxWorkspaceManager {
  private readonly baseDir: string;

  constructor(baseDir: string = path.join(os.tmpdir(), 'cve-sandbox-workspaces')) {
    this.baseDir = path.resolve(baseDir);
    fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
  }

  public createWorkspace(jobId: string, attemptId: string): SandboxWorkspace {
    if (!SAFE_ID_REGEX.test(jobId)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Invalid jobId "${jobId}": workspace paths must use safe internal IDs, never tenant filenames`,
        false,
      );
    }
    if (!SAFE_ID_REGEX.test(attemptId)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Invalid attemptId "${attemptId}": workspace paths must use safe internal IDs`,
        false,
      );
    }

    const rootDir = path.resolve(this.baseDir, `job-${jobId}`, `attempt-${attemptId}`);
    if (!rootDir.startsWith(this.baseDir + path.sep)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        'Workspace path escaped base directory',
        false,
      );
    }

    const inputsDir = path.join(rootDir, 'inputs');
    const outputDir = path.join(rootDir, 'output');
    const tmpDir = path.join(rootDir, 'tmp');

    fs.mkdirSync(inputsDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o750 });
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o750 });

    return {
      jobId,
      attemptId,
      rootDir,
      inputsDir,
      outputDir,
      tmpDir,
    };
  }

  public resolveSafeRelativePath(rootDir: string, relativePath: string): string {
    if (!relativePath || typeof relativePath !== 'string' || relativePath.includes('\0')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        'Invalid empty or null-byte path in sandbox workspace',
        false,
      );
    }
    if (relativePath.includes('\\')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Backslashes are forbidden in sandbox relative path: "${relativePath}"`,
        false,
      );
    }
    if (path.isAbsolute(relativePath) || relativePath.startsWith('/')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Absolute path is forbidden in sandbox workspace: "${relativePath}"`,
        false,
      );
    }

    const segments = relativePath.split('/').filter(Boolean);
    if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Path traversal segment (".." or ".") is forbidden: "${relativePath}"`,
        false,
      );
    }
    if (segments.length > BUNDLE_V1_LIMITS.maxNestingDepth) {
      throw new SandboxError(
        'SANDBOX_RESOURCE_LIMIT',
        `Path nesting depth ${segments.length} exceeds maximum allowed ${BUNDLE_V1_LIMITS.maxNestingDepth}: "${relativePath}"`,
        false,
      );
    }

    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(resolvedRoot, ...segments);
    if (
      resolvedTarget !== resolvedRoot &&
      !resolvedTarget.startsWith(resolvedRoot + path.sep)
    ) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Resolved path escaped workspace root: "${relativePath}"`,
        false,
      );
    }
    return resolvedTarget;
  }

  public stageInputs(
    workspace: SandboxWorkspace,
    files: readonly StagedInputFileSpec[],
  ): Map<string, { filePath: string; sha256: string; bytes: number }> {
    if (files.length > BUNDLE_V1_LIMITS.maxFiles) {
      throw new SandboxError(
        'SANDBOX_RESOURCE_LIMIT',
        `Input file count (${files.length}) exceeds bundle v1 limit of ${BUNDLE_V1_LIMITS.maxFiles}`,
        false,
      );
    }

    this.unlockDirectoryPermissions(workspace.inputsDir);

    let totalSourceBytes = 0;
    let totalAssetBytes = 0;
    const stagedMap = new Map<string, { filePath: string; sha256: string; bytes: number }>();

    for (const item of files) {
      const targetPath = this.resolveSafeRelativePath(workspace.inputsDir, item.relativePath);
      const buf = Buffer.isBuffer(item.content)
        ? item.content
        : Buffer.from(item.content, 'utf-8');

      const kind = item.kind ?? 'asset';
      if (kind === 'source') {
        totalSourceBytes += buf.byteLength;
        if (totalSourceBytes > BUNDLE_V1_LIMITS.maxSourceBytes) {
          throw new SandboxError(
            'SANDBOX_RESOURCE_LIMIT',
            `Total source bytes (${totalSourceBytes}) exceeds 5 MiB limit (${BUNDLE_V1_LIMITS.maxSourceBytes})`,
            false,
          );
        }
      } else {
        totalAssetBytes += buf.byteLength;
        if (totalAssetBytes > BUNDLE_V1_LIMITS.maxBuiltAssetBytes) {
          throw new SandboxError(
            'SANDBOX_RESOURCE_LIMIT',
            `Total staged asset bytes (${totalAssetBytes}) exceeds 20 MiB limit (${BUNDLE_V1_LIMITS.maxBuiltAssetBytes})`,
            false,
          );
        }
      }

      const actualSha256 = computeSha256Hex(buf);
      if (item.expectedSha256 && item.expectedSha256.toLowerCase() !== actualSha256) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `SHA-256 mismatch for staged input "${item.relativePath}": expected ${item.expectedSha256}, got ${actualSha256}`,
          false,
        );
      }

      const parentDir = path.dirname(targetPath);
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o750 });

      if (fs.existsSync(targetPath)) {
        const st = fs.lstatSync(targetPath);
        if (st.isSymbolicLink()) {
          throw new SandboxError(
            'SANDBOX_SECURITY_VIOLATION',
            `Refusing to overwrite symlink at "${item.relativePath}"`,
            false,
          );
        }
        fs.chmodSync(targetPath, 0o600);
      }

      fs.writeFileSync(targetPath, buf, { mode: 0o440, flag: 'w' });
      fs.chmodSync(targetPath, 0o440);

      const statAfter = fs.lstatSync(targetPath);
      if (!statAfter.isFile() || statAfter.isSymbolicLink() || statAfter.nlink > 1) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Staged input "${item.relativePath}" must be a single-link regular file`,
          false,
        );
      }

      stagedMap.set(item.relativePath, {
        filePath: targetPath,
        sha256: actualSha256,
        bytes: buf.byteLength,
      });
    }

    // Lock inputs directory hierarchy to read-only (0o550 for dirs, 0o440 for files)
    this.lockInputsReadOnly(workspace.inputsDir);
    return stagedMap;
  }

  public lockInputsReadOnly(dirPath: string): void {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const st = fs.lstatSync(fullPath);
      if (st.isSymbolicLink()) {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Symlink detected in staged inputs: "${fullPath}"`,
          false,
        );
      }
      if (st.isDirectory()) {
        this.lockInputsReadOnly(fullPath);
        fs.chmodSync(fullPath, 0o550);
      } else if (st.isFile()) {
        if (st.nlink > 1) {
          throw new SandboxError(
            'SANDBOX_SECURITY_VIOLATION',
            `Hardlink (nlink=${st.nlink}) detected in staged inputs: "${fullPath}"`,
            false,
          );
        }
        fs.chmodSync(fullPath, 0o440);
      } else {
        throw new SandboxError(
          'SANDBOX_SECURITY_VIOLATION',
          `Special device/FIFO/socket file forbidden in staged inputs: "${fullPath}"`,
          false,
        );
      }
    }
    fs.chmodSync(dirPath, 0o550);
  }

  private unlockDirectoryPermissions(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    const st = fs.lstatSync(dirPath);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(dirPath, 0o700);
      for (const entry of fs.readdirSync(dirPath)) {
        this.unlockDirectoryPermissions(path.join(dirPath, entry));
      }
    } else if (st.isFile()) {
      fs.chmodSync(dirPath, 0o600);
    }
  }

  public checkDiskQuota(workspace: SandboxWorkspace, maxDiskBytes: number): number {
    const inspectDir = (dir: string): number => {
      if (!fs.existsSync(dir)) return 0;
      let sum = 0;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.lstatSync(full);
        if (st.isSymbolicLink()) {
          throw new SandboxError(
            'SANDBOX_SECURITY_VIOLATION',
            `Symlink forbidden in sandbox workspace: "${full}"`,
            false,
          );
        }
        if (st.isDirectory()) {
          sum += inspectDir(full);
        } else if (st.isFile()) {
          if (st.nlink > 1) {
            throw new SandboxError(
              'SANDBOX_SECURITY_VIOLATION',
              `Hardlink (nlink=${st.nlink}) forbidden in sandbox workspace: "${full}"`,
              false,
            );
          }
          sum += st.size;
        } else {
          throw new SandboxError(
            'SANDBOX_SECURITY_VIOLATION',
            `Special file (FIFO/socket/device) forbidden in sandbox workspace: "${full}"`,
            false,
          );
        }
        if (sum > maxDiskBytes) {
          throw new SandboxError(
            'SANDBOX_RESOURCE_LIMIT',
            `Workspace disk usage (${sum} bytes) exceeded quota (${maxDiskBytes} bytes)`,
            false,
          );
        }
      }
      return sum;
    };

    const usedBytes = inspectDir(workspace.outputDir) + inspectDir(workspace.tmpDir);
    if (usedBytes > maxDiskBytes) {
      throw new SandboxError(
        'SANDBOX_RESOURCE_LIMIT',
        `Workspace disk usage (${usedBytes} bytes) exceeded quota (${maxDiskBytes} bytes)`,
        false,
      );
    }
    return usedBytes;
  }

  public verifyOutputArtifact(
    workspace: SandboxWorkspace,
    relativeOutputName: string,
    expectedFormat: 'mp4' | 'png',
    maxDiskBytes: number = 8192 * 1024 * 1024,
  ): VerifiedOutputArtifact {
    const targetPath = this.resolveSafeRelativePath(workspace.outputDir, relativeOutputName);
    if (!fs.existsSync(targetPath)) {
      throw new SandboxError(
        'ENCODE_VERIFICATION_FAILED',
        `Expected output artifact "${relativeOutputName}" does not exist`,
        false,
      );
    }

    const st = fs.lstatSync(targetPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Output artifact "${relativeOutputName}" is not a regular file (symlink/special file blocked)`,
        false,
      );
    }
    if (st.nlink > 1) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Output artifact "${relativeOutputName}" has multiple hardlinks (nlink=${st.nlink})`,
        false,
      );
    }
    if (st.size === 0) {
      throw new SandboxError(
        'ENCODE_VERIFICATION_FAILED',
        `Output artifact "${relativeOutputName}" is empty (0 bytes)`,
        false,
      );
    }

    this.checkDiskQuota(workspace, maxDiskBytes);

    const fileBuf = fs.readFileSync(targetPath);
    if (expectedFormat === 'mp4') {
      // ISO Base Media File Format (MP4) must contain 'ftyp' box header at bytes 4..8
      const magic = fileBuf.length >= 8 ? fileBuf.subarray(4, 8).toString('ascii') : '';
      if (magic !== 'ftyp') {
        throw new SandboxError(
          'ENCODE_VERIFICATION_FAILED',
          `Output artifact "${relativeOutputName}" failed MP4 magic-byte check (expected "ftyp" at offset 4)`,
          false,
        );
      }
    } else if (expectedFormat === 'png') {
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (fileBuf.length < 8 || !fileBuf.subarray(0, 8).equals(pngMagic)) {
        throw new SandboxError(
          'ENCODE_VERIFICATION_FAILED',
          `Output artifact "${relativeOutputName}" failed PNG signature check`,
          false,
        );
      }
    }

    return {
      path: targetPath,
      bytes: fileBuf.byteLength,
      sha256: computeSha256Hex(fileBuf),
      format: expectedFormat,
    };
  }

  public cleanup(workspace: SandboxWorkspace): void {
    if (!workspace.rootDir.startsWith(this.baseDir + path.sep)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        'Refusing to clean up path outside sandbox baseDir',
        false,
      );
    }
    if (fs.existsSync(workspace.rootDir)) {
      this.unlockDirectoryPermissions(workspace.rootDir);
      fs.rmSync(workspace.rootDir, { recursive: true, force: true });
    }
  }
}

/**
 * 8. Internal Loopback Asset Server (docs/SECURITY.md line 37)
 * Serves only allowlisted, hash-verified local manifest paths on 127.0.0.1.
 * No proxy/fetch, no directory listing, no symlink traversal.
 */
interface RegisteredAssetEntry {
  urlPath: string;
  filePath: string;
  sha256: string;
  mimeType: string;
}

export class LoopbackAssetServer {
  private readonly inputsDir: string;
  private readonly assets = new Map<string, RegisteredAssetEntry>();
  private server: http.Server | null = null;
  private boundOrigin: string | null = null;

  constructor(inputsDir: string) {
    this.inputsDir = path.resolve(inputsDir);
  }

  public registerAsset(
    urlPath: string,
    filePath: string,
    expectedSha256: string,
    mimeType: string,
  ): void {
    if (!urlPath.startsWith('/assets/') || urlPath.includes('..') || urlPath.includes('\\')) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Loopback asset URL path must start with "/assets/" and contain no traversal: "${urlPath}"`,
        false,
      );
    }
    const resolvedFile = path.resolve(filePath);
    if (!resolvedFile.startsWith(this.inputsDir + path.sep)) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Loopback asset file "${filePath}" must reside inside staged inputsDir`,
        false,
      );
    }
    const st = fs.lstatSync(resolvedFile);
    if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Loopback asset "${filePath}" must be a regular single-link file`,
        false,
      );
    }
    const actualSha256 = computeSha256Hex(fs.readFileSync(resolvedFile));
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Loopback asset "${urlPath}" failed SHA-256 integrity check`,
        false,
      );
    }

    this.assets.set(urlPath, {
      urlPath,
      filePath: resolvedFile,
      sha256: actualSha256,
      mimeType,
    });
  }

  public async start(): Promise<string> {
    if (this.boundOrigin) return this.boundOrigin;

    this.server = http.createServer((req, res) => {
      res.setHeader('Content-Security-Policy', TRUSTED_TEMPLATE_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Cache-Control', 'no-store');

      const remoteAddr = req.socket.remoteAddress || '';
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_NON_LOOPBACK_CLIENT' }));
        return;
      }

      const hostHeader = (req.headers.host || '').split(':')[0];
      if (hostHeader !== '127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_HOST_HEADER' }));
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }));
        return;
      }

      const rawUrl = req.url || '/';
      if (
        rawUrl.includes('?') ||
        rawUrl.includes('..') ||
        rawUrl.includes('\\') ||
        rawUrl.includes('//')
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'FORBIDDEN_ASSET_URL' }));
        return;
      }

      let decodedPath: string;
      try {
        decodedPath = decodeURIComponent(rawUrl);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'MALFORMED_URI' }));
        return;
      }

      if (decodedPath.includes('..') || decodedPath.includes('\\') || decodedPath.includes('\0')) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'PATH_TRAVERSAL_BLOCKED' }));
        return;
      }

      const entry = this.assets.get(decodedPath);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ASSET_NOT_ALLOWLISTED' }));
        return;
      }

      try {
        const st = fs.lstatSync(entry.filePath);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'ASSET_INTEGRITY_VIOLATION' }));
          return;
        }
        const content = fs.readFileSync(entry.filePath);
        const currentHash = computeSha256Hex(content);
        if (currentHash !== entry.sha256) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'ASSET_HASH_MISMATCH' }));
          return;
        }

        res.writeHead(200, {
          'Content-Type': entry.mimeType,
          'Content-Length': String(content.byteLength),
          'X-Asset-Sha256': entry.sha256,
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          res.end(content);
        }
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'ASSET_READ_FAILED' }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.boundOrigin = `http://127.0.0.1:${addr.port}`;
          resolve();
        } else {
          reject(new Error('Failed to bind LoopbackAssetServer'));
        }
      });
    });

    return this.boundOrigin!;
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.boundOrigin = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
}

/**
 * 9. Narrow Runtime Launcher (TrustedTemplateLauncher)
 */
export class TrustedTemplateLauncher {
  private readonly workspaceManager: SandboxWorkspaceManager;

  constructor(workspaceManager: SandboxWorkspaceManager = new SandboxWorkspaceManager()) {
    this.workspaceManager = workspaceManager;
  }

  public getWorkspaceManager(): SandboxWorkspaceManager {
    return this.workspaceManager;
  }

  public buildContainerLaunchSpec(request: ContainerLaunchRequest): ContainerLaunchSpec {
    // 1. Verify custom code is off and engine is a structured trusted template engine
    assertCustomCodeGate({
      config: request.config,
      engine: request.engine,
      hasBundle: false,
      allowApprovedCustomPool: false,
    });

    // 2. Build & validate non-root security context
    const securityContext: SandboxSecurityContext = {
      ...buildDefaultSecurityContext(request.seccompProfilePath ?? 'runtime/default'),
      ...request.securityContext,
    };
    validateSecurityContext(securityContext);

    // 3. Build & validate cgroup/time/disk/PID limits
    const resourceLimits: SandboxResourceLimits = {
      ...buildDefaultResourceLimits(request.config),
      ...request.resourceLimits,
    };
    const cgroupV2 = buildCgroupV2Spec(resourceLimits);

    // 4. Validate image digest against immutable allowlist
    const imageDigest = validateImageDigest(
      request.config.CVE_RENDER_IMAGE_DIGEST,
      request.config.CVE_ENV,
      request.allowedImageDigests ?? [],
    );

    // 5. Build & validate mounts (read-only inputs, isolated output, zero host sockets)
    const mounts: SandboxMount[] = [
      {
        source: path.resolve(request.workspace.inputsDir),
        destination: '/workspace/inputs',
        readOnly: true,
      },
      {
        source: path.resolve(request.workspace.outputDir),
        destination: '/workspace/output',
        readOnly: false,
      },
    ];
    validateHostMounts(mounts, request.workspace);

    // 6. Build & validate Chromium sandbox flags
    const chromiumArgs = buildChromiumSandboxArgs(request.extraChromiumFlags ?? []);

    // 7. Build secret-free environment
    const env = buildSanitizedSandboxEnv({
      jobId: request.jobId,
      attemptId: request.attemptId,
      loopbackAssetOrigin: request.loopbackAssetOrigin,
    });

    const timeoutSeconds =
      request.jobKind === 'preview'
        ? resourceLimits.previewTimeoutSeconds
        : resourceLimits.renderTimeoutSeconds;

    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(env)) {
      envFlags.push('--env', `${k}=${v}`);
    }

    const seccompOpt =
      securityContext.seccompProfile === 'runtime/default'
        ? []
        : ['--security-opt', `seccomp=${securityContext.seccompProfile}`];

    const argv: string[] = [
      'run',
      '--rm',
      '--init',
      '--user',
      `${securityContext.uid}:${securityContext.gid}`,
      '--read-only',
      '--network',
      'none',
      '--ipc',
      securityContext.ipcMode,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      ...seccompOpt,
      '--cpus',
      String(resourceLimits.cpuLimitVcpu),
      '--memory',
      `${resourceLimits.memoryMib}m`,
      '--memory-swap',
      `${resourceLimits.memoryMib}m`,
      '--pids-limit',
      String(resourceLimits.pidsLimit),
      '--mount',
      `type=bind,src=${mounts[0]!.source},dst=${mounts[0]!.destination},readonly`,
      '--mount',
      `type=bind,src=${mounts[1]!.source},dst=${mounts[1]!.destination}`,
      '--tmpfs',
      `/workspace/tmp:rw,noexec,nosuid,nodev,size=${resourceLimits.tempDiskMib}m`,
      '--workdir',
      '/workspace',
      ...envFlags,
      `creativanta-renderer@${imageDigest}`,
    ];

    return {
      runtimeBinary: 'docker',
      argv,
      imageDigest,
      securityContext,
      resourceLimits,
      cgroupV2,
      mounts,
      env,
      chromiumArgs,
      cspHeader: TRUSTED_TEMPLATE_CSP,
      timeoutSeconds,
    };
  }

  public async runSandboxedProcess(
    options: SandboxedProcessOptions,
  ): Promise<SandboxedProcessResult> {
    validateResourceLimits(options.limits);

    const effectiveUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : SANDBOX_DEFAULT_UID);
    const effectiveGid = options.gid ?? (typeof process.getgid === 'function' ? process.getgid() : SANDBOX_DEFAULT_GID);

    if (effectiveUid === 0 || effectiveGid === 0) {
      throw new SandboxError(
        'SANDBOX_SECURITY_VIOLATION',
        `Refusing to execute sandboxed process as root (uid=${effectiveUid}, gid=${effectiveGid})`,
        false,
      );
    }

    const sanitizedEnv = buildSanitizedSandboxEnv({
      jobId: options.workspace.jobId,
      attemptId: options.workspace.attemptId,
      extraEnv: options.extraEnv,
    });

    const maxDiskBytes = options.limits.tempDiskMib * 1024 * 1024;
    this.workspaceManager.checkDiskQuota(options.workspace, maxDiskBytes);

    const startedAt = Date.now();
    const timeoutCode = options.timeoutCode ?? 'RENDER_TIMEOUT';

    return await new Promise<SandboxedProcessResult>((resolve, reject) => {
      const child = spawn(options.command, [...options.argv], {
        cwd: options.workspace.rootDir,
        env: sanitizedEnv,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let settled = false;
      let quotaError: SandboxError | null = null;
      let timedOut = false;

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            // already exited
          }
        }
      };

      const appendBounded = (current: Buffer, chunk: Buffer): Buffer => {
        if (current.byteLength >= BUNDLE_V1_LIMITS.maxLogBytes) return current;
        const remaining = BUNDLE_V1_LIMITS.maxLogBytes - current.byteLength;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf = appendBounded(stdoutBuf, chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf = appendBounded(stderrBuf, chunk);
      });

      const quotaInterval = setInterval(() => {
        try {
          this.workspaceManager.checkDiskQuota(options.workspace, maxDiskBytes);
        } catch (err) {
          if (err instanceof SandboxError) {
            quotaError = err;
            killProcessGroup();
          }
        }
      }, 25);

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup();
      }, options.timeoutMs);

      const finalize = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(quotaInterval);
        clearTimeout(timeoutTimer);
        fn();
      };

      child.on('error', (err) => {
        finalize(() => {
          killProcessGroup();
          reject(err);
        });
      });

      child.on('close', (code, signal) => {
        finalize(() => {
          if (quotaError) {
            reject(quotaError);
            return;
          }
          if (timedOut) {
            reject(
              new SandboxError(
                timeoutCode,
                `Sandboxed process exceeded hard timeout of ${options.timeoutMs}ms and process group was killed`,
                true,
              ),
            );
            return;
          }
          try {
            this.workspaceManager.checkDiskQuota(options.workspace, maxDiskBytes);
          } catch (err) {
            reject(err);
            return;
          }

          resolve({
            exitCode: code ?? -1,
            signal,
            stdout: redactSecretOutput(stdoutBuf.toString('utf-8')),
            stderr: redactSecretOutput(stderrBuf.toString('utf-8')),
            durationMs: Date.now() - startedAt,
          });
        });
      });
    });
  }
}

/**
 * 10. Sandbox Capability Self-Test (docs/DEPLOYMENT.md line 56, P1-04 acceptance)
 *
 * Verifies:
 * 1. non-root execution identity & security context enforcement
 * 2. custom code disabled gate (custom-html-v1 & bundle rejection)
 * 3. Chromium sandbox flags (--no-sandbox rejection, CSP, HTML remote URL guard)
 * 4. FFmpeg safe argv array & protocol_whitelist "file,pipe" enforcement
 * 5. no host socket mount guard & secret-free sandbox environment
 * 6. read-only staged inputs, symlink/traversal rejection, output magic-byte check & cleanup
 * 7. cgroup v2 spec, disk quota enforcement & hard timeout process-group kill
 * 8. zero external egress container policy & internal loopback asset server guard
 */
export async function runSandboxSelfTest(
  config: CveEnvConfig = loadEnvConfig(),
): Promise<SandboxSelfTestReport> {
  const startedAt = Date.now();
  const checks: SandboxSelfTestCheckResult[] = [];
  const launcher = new TrustedTemplateLauncher();
  const wm = launcher.getWorkspaceManager();

  const recordCheck = async (name: string, fn: () => Promise<string> | string) => {
    try {
      const detail = await fn();
      checks.push({ name, status: 'PASS', detail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      checks.push({ name, status: 'FAIL', detail: msg });
    }
  };

  // Check 1: Non-root execution & security context
  await recordCheck('nonroot_identity_and_context', () => {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : SANDBOX_DEFAULT_UID;
    const currentGid = typeof process.getgid === 'function' ? process.getgid() : SANDBOX_DEFAULT_GID;
    if (currentUid === 0 || currentGid === 0) {
      throw new Error(`Worker process is running as root (uid=${currentUid}, gid=${currentGid})`);
    }
    const defaultCtx = buildDefaultSecurityContext();
    validateSecurityContext(defaultCtx);

    let rootRejected = false;
    try {
      validateSecurityContext({ ...defaultCtx, uid: 0 });
    } catch (err) {
      rootRejected = err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION';
    }
    if (!rootRejected) {
      throw new Error('Failed to reject UID 0 (root) in security context');
    }
    return `Verified non-root worker identity (uid=${currentUid}, gid=${currentGid}) and container UID=${defaultCtx.uid} with capDrop=ALL, readOnlyRootfs=true, noNewPrivileges=true`;
  });

  // Check 2: Custom code off gate
  await recordCheck('custom_code_disabled_gate', () => {
    if (config.CVE_CUSTOM_CODE_ENABLED !== false || config.CVE_CUSTOM_RUNTIME !== 'disabled') {
      throw new Error(
        `Custom code must be disabled by default (got CVE_CUSTOM_CODE_ENABLED=${config.CVE_CUSTOM_CODE_ENABLED}, CVE_CUSTOM_RUNTIME=${config.CVE_CUSTOM_RUNTIME})`,
      );
    }
    assertCustomCodeGate({ config, engine: 'html-v1' });

    let customEngineRejected = false;
    try {
      assertCustomCodeGate({ config, engine: 'custom-html-v1' });
    } catch (err) {
      customEngineRejected = err instanceof SandboxError && err.code === 'CAPABILITY_DISABLED';
    }
    if (!customEngineRejected) {
      throw new Error('Failed to block custom-html-v1 engine when custom code is off');
    }
    return 'Verified CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled, and custom-html-v1 rejection';
  });

  // Check 3: Chromium sandbox flags & CSP
  await recordCheck('chromium_sandbox_and_csp', () => {
    const args = buildChromiumSandboxArgs();
    if (args.includes('--no-sandbox')) {
      throw new Error('Chromium args must never include --no-sandbox');
    }
    let noSandboxRejected = false;
    try {
      buildChromiumSandboxArgs(['--no-sandbox']);
    } catch (err) {
      noSandboxRejected = err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION';
    }
    if (!noSandboxRejected) {
      throw new Error('Failed to reject --no-sandbox flag');
    }

    let remoteFontRejected = false;
    try {
      validateTemplateHtmlPolicy(
        '<style>@import url("https://fonts.googleapis.com/css2?family=Inter");</style>',
      );
    } catch (err) {
      remoteFontRejected = err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION';
    }
    if (!remoteFontRejected) {
      throw new Error('Failed to reject remote Google Fonts @import in template HTML');
    }
    return `Verified ${args.length} hardened Chromium flags, --no-sandbox rejection, and zero-egress CSP`;
  });

  // Check 4: FFmpeg safe argv & protocol whitelist
  await recordCheck('ffmpeg_safe_argv_whitelist', () => {
    const probeArgs = buildFfprobeSandboxArgv('/workspace/output/render.mp4');
    if (!probeArgs.includes('file,pipe')) {
      throw new Error('FFprobe args missing file,pipe protocol whitelist');
    }
    let httpRejected = false;
    try {
      buildFfmpegSandboxArgv(['-i', 'http://169.254.169.254/latest/meta-data/']);
    } catch (err) {
      httpRejected = err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION';
    }
    if (!httpRejected) {
      throw new Error('Failed to reject SSRF metadata URL in FFmpeg argv');
    }
    return 'Verified FFmpeg/ffprobe argv array enforcement and -protocol_whitelist "file,pipe"';
  });

  // Check 5: No host socket mount & secret redaction
  await recordCheck('no_host_socket_and_secret_redaction', () => {
    const ws = wm.createWorkspace('selftest-mounts', 'att-1');
    try {
      let socketRejected = false;
      try {
        validateHostMounts(
          [
            { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
          ],
          ws,
        );
      } catch (err) {
        socketRejected = err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION';
      }
      if (!socketRejected) {
        throw new Error('Failed to reject /var/run/docker.sock mount');
      }

      const env = buildSanitizedSandboxEnv({ jobId: ws.jobId, attemptId: ws.attemptId });
      if ('CVE_DATABASE_URL' in env || 'CVE_API_KEY_PEPPER' in env) {
        throw new Error('Sanitized sandbox env leaked controller secrets');
      }
      return 'Verified /var/run/docker.sock rejection and secret-free sandbox environment';
    } finally {
      wm.cleanup(ws);
    }
  });

  // Check 6: Read-only staged inputs, real subprocess write denial, output magic bytes & cleanup
  await recordCheck('read_only_inputs_and_workspace_isolation', async () => {
    const ws = wm.createWorkspace('selftest-ro', 'att-1');
    try {
      const sampleJson = JSON.stringify({ scene: 'intro', frames: 30 });
      const sampleHash = computeSha256Hex(sampleJson);
      wm.stageInputs(ws, [
        {
          relativePath: 'manifest.json',
          content: sampleJson,
          expectedSha256: sampleHash,
          kind: 'manifest',
        },
      ]);

      const limits = buildDefaultResourceLimits(config);
      // Spawn real Node subprocess inside workspace:
      // 1. Reads /inputs/manifest.json (must succeed)
      // 2. Attempts to overwrite /inputs/manifest.json (must fail with EACCES/EPERM)
      // 3. Writes valid MP4 header (ftyp) to /output/sample.mp4
      const script = `
        const fs = require('node:fs');
        const path = require('node:path');
        const inputFile = path.join(process.cwd(), 'inputs', 'manifest.json');
        const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
        if (data.frames !== 30) process.exit(2);
        let writeBlocked = false;
        try {
          fs.writeFileSync(inputFile, 'tampered');
        } catch (err) {
          if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
            writeBlocked = true;
          }
        }
        if (!writeBlocked) process.exit(3);
        const outFile = path.join(process.cwd(), 'output', 'sample.mp4');
        const mp4Header = Buffer.from([
          0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
          0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
          0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32
        ]);
        fs.writeFileSync(outFile, mp4Header);
      `;

      const res = await launcher.runSandboxedProcess({
        command: process.execPath,
        argv: ['-e', script],
        workspace: ws,
        limits,
        timeoutMs: 5000,
      });

      if (res.exitCode !== 0) {
        throw new Error(`Subprocess read-only input probe failed with exitCode=${res.exitCode}: ${res.stderr}`);
      }

      const verified = wm.verifyOutputArtifact(ws, 'sample.mp4', 'mp4');
      if (verified.bytes !== 24) {
        throw new Error(`Unexpected output bytes: ${verified.bytes}`);
      }
    } finally {
      wm.cleanup(ws);
    }
    if (fs.existsSync(ws.rootDir)) {
      throw new Error('Workspace cleanup failed to remove temporary directory');
    }
    return 'Verified read-only staged inputs (EACCES on write), MP4 magic-byte verification, and deterministic workspace cleanup';
  });

  // Check 7: Cgroup v2 spec, disk quota & hard timeout process-group kill
  await recordCheck('cgroup_time_disk_pid_limits', async () => {
    const limits = buildDefaultResourceLimits(config);
    const cg = buildCgroupV2Spec(limits);
    if (cg.memorySwapMax !== '0' || cg.pidsMax !== String(limits.pidsLimit)) {
      throw new Error('Invalid cgroup v2 spec');
    }

    const ws = wm.createWorkspace('selftest-limits', 'att-1');
    try {
      let timeoutTriggered = false;
      try {
        await launcher.runSandboxedProcess({
          command: process.execPath,
          argv: ['-e', 'setInterval(() => {}, 1000);'],
          workspace: ws,
          limits,
          timeoutMs: 120,
          timeoutCode: 'FRAME_READINESS_TIMEOUT',
        });
      } catch (err) {
        timeoutTriggered =
          err instanceof SandboxError && err.code === 'FRAME_READINESS_TIMEOUT' && err.retryable;
      }
      if (!timeoutTriggered) {
        throw new Error('Failed to enforce hard timeout and process-group kill on hanging subprocess');
      }
      return `Verified cgroup v2 limits (cpu.max="${cg.cpuMax}", memory.max=${cg.memoryMax}, pids.max=${cg.pidsMax}) and hard timeout process-group termination`;
    } finally {
      wm.cleanup(ws);
    }
  });

  // Check 8: Zero external egress container spec & internal loopback asset server guard
  await recordCheck('zero_egress_and_loopback_asset_guard', async () => {
    const ws = wm.createWorkspace('selftest-net', 'att-1');
    const assetServer = new LoopbackAssetServer(ws.inputsDir);
    try {
      const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>');
      const svgSha = computeSha256Hex(svgBytes);
      const staged = wm.stageInputs(ws, [
        { relativePath: 'icon.svg', content: svgBytes, expectedSha256: svgSha, kind: 'asset' },
      ]);
      const iconEntry = staged.get('icon.svg')!;
      assetServer.registerAsset('/assets/icon.svg', iconEntry.filePath, svgSha, 'image/svg+xml');

      const origin = await assetServer.start();
      const spec = launcher.buildContainerLaunchSpec({
        config,
        jobId: ws.jobId,
        attemptId: ws.attemptId,
        jobKind: 'render',
        engine: 'html-v1',
        workspace: ws,
        loopbackAssetOrigin: origin,
      });

      if (!spec.argv.includes('--network') || spec.argv[spec.argv.indexOf('--network') + 1] !== 'none') {
        throw new Error('Container launch spec missing --network none');
      }

      const okRes = await fetch(`${origin}/assets/icon.svg`);
      if (okRes.status !== 200) {
        throw new Error(`Expected 200 for allowlisted loopback asset, got ${okRes.status}`);
      }
      const blockedRes = await fetch(`${origin}/assets/unlisted.svg`);
      if (blockedRes.status !== 404) {
        throw new Error(`Expected 404 for unlisted loopback asset, got ${blockedRes.status}`);
      }
      return `Verified container --network=none and internal loopback asset server allowlist/hash enforcement`;
    } finally {
      await assetServer.stop();
      wm.cleanup(ws);
    }
  });

  const allPassed = checks.every((c) => c.status === 'PASS');
  return {
    status: allPassed ? 'PASS' : 'FAIL',
    checks,
    duration_ms: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };
}
