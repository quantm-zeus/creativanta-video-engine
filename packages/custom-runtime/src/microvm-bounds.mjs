/**
 * Disposable MicroVM Resource Bounds, Cgroup v2 Limits & VMM Machine Config Builders (Task P7-01).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md (lines 35-60: cgroup CPU/RAM/PID/disk/time limits, bundle v1 quotas)
 *   - docs/DEPLOYMENT.md (lines 75-85: 2 vCPU, 4096 MiB RAM, 256 PIDs, 8192 MiB temp disk,
 *     5000ms frame timeout, 600s render timeout, 120s preview timeout)
 *   - packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md
 */

import path from 'node:path';
import {
  SANDBOX_DEFAULT_UID,
  SANDBOX_DEFAULT_GID,
  IMAGE_DIGEST_REGEX,
  SAFE_ID_REGEX,
} from '../../controller/dist/index.js';
import { CustomRuntimeError } from './adr-policy.mjs';

export const DEFAULT_BUILD_VM_BOUNDS = Object.freeze({
  phase: 'build',
  vcpuCount: 1,
  memoryMib: 1024,
  pidsLimit: 128,
  scratchDiskMib: 512,
  timeoutMs: 30_000,
  killGraceMs: 2_000,
});

export const DEFAULT_RENDER_VM_BOUNDS = Object.freeze({
  phase: 'render',
  vcpuCount: 2,
  memoryMib: 4096,
  pidsLimit: 256,
  tempDiskMib: 8192,
  frameTimeoutMs: 5_000,
  renderTimeoutSeconds: 600,
  previewTimeoutSeconds: 120,
  killGraceMs: 5_000,
});

export const CUSTOM_BUNDLE_QUOTAS = Object.freeze({
  maxFiles: 100,
  maxSourceBytes: 5 * 1024 * 1024, // 5 MiB
  maxBuiltAssetBytes: 20 * 1024 * 1024, // 20 MiB
  maxNestingDepth: 8,
  maxStdioBytes: 64 * 1024, // 64 KiB bounded stdout/stderr
});

export const HARDENED_GUEST_KERNEL_BOOT_ARGS =
  'console=ttyS0 noapic reboot=k panic=1 pci=off nomodules ipv6.disable=1 random.trust_cpu=on';

/**
 * Validates resource bounds for the disposable Build MicroVM (`custom-build-vm`).
 */
export function validateBuildVmBounds(rawBounds = {}) {
  const bounds = {
    ...DEFAULT_BUILD_VM_BOUNDS,
    ...rawBounds,
    phase: 'build',
  };

  if (!Number.isInteger(bounds.vcpuCount) || bounds.vcpuCount < 1 || bounds.vcpuCount > 2) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM vcpuCount: ${bounds.vcpuCount} (must be integer 1..2)`,
      false,
      { field: 'vcpuCount', value: bounds.vcpuCount },
    );
  }
  if (!Number.isInteger(bounds.memoryMib) || bounds.memoryMib < 256 || bounds.memoryMib > 2048) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM memoryMib: ${bounds.memoryMib} (must be integer 256..2048)`,
      false,
      { field: 'memoryMib', value: bounds.memoryMib },
    );
  }
  if (!Number.isInteger(bounds.pidsLimit) || bounds.pidsLimit < 32 || bounds.pidsLimit > 512) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM pidsLimit: ${bounds.pidsLimit} (must be integer 32..512)`,
      false,
      { field: 'pidsLimit', value: bounds.pidsLimit },
    );
  }
  if (
    !Number.isInteger(bounds.scratchDiskMib) ||
    bounds.scratchDiskMib < 32 ||
    bounds.scratchDiskMib > 2048
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM scratchDiskMib: ${bounds.scratchDiskMib} (must be integer 32..2048)`,
      false,
      { field: 'scratchDiskMib', value: bounds.scratchDiskMib },
    );
  }
  if (!Number.isInteger(bounds.timeoutMs) || bounds.timeoutMs < 100 || bounds.timeoutMs > 120_000) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM timeoutMs: ${bounds.timeoutMs} (must be integer 100..120000)`,
      false,
      { field: 'timeoutMs', value: bounds.timeoutMs },
    );
  }
  if (!Number.isInteger(bounds.killGraceMs) || bounds.killGraceMs < 50 || bounds.killGraceMs > 5_000) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid build VM killGraceMs: ${bounds.killGraceMs} (must be integer 50..5000)`,
      false,
      { field: 'killGraceMs', value: bounds.killGraceMs },
    );
  }

  return Object.freeze(bounds);
}

/**
 * Validates resource bounds for the disposable Render MicroVM (`custom-render-vm`).
 */
export function validateRenderVmBounds(rawBounds = {}) {
  const bounds = {
    ...DEFAULT_RENDER_VM_BOUNDS,
    ...rawBounds,
    phase: 'render',
  };

  if (!Number.isInteger(bounds.vcpuCount) || bounds.vcpuCount < 1 || bounds.vcpuCount > 4) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM vcpuCount: ${bounds.vcpuCount} (must be integer 1..4)`,
      false,
      { field: 'vcpuCount', value: bounds.vcpuCount },
    );
  }
  if (!Number.isInteger(bounds.memoryMib) || bounds.memoryMib < 512 || bounds.memoryMib > 8192) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM memoryMib: ${bounds.memoryMib} (must be integer 512..8192)`,
      false,
      { field: 'memoryMib', value: bounds.memoryMib },
    );
  }
  if (!Number.isInteger(bounds.pidsLimit) || bounds.pidsLimit < 32 || bounds.pidsLimit > 1024) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM pidsLimit: ${bounds.pidsLimit} (must be integer 32..1024)`,
      false,
      { field: 'pidsLimit', value: bounds.pidsLimit },
    );
  }
  if (!Number.isInteger(bounds.tempDiskMib) || bounds.tempDiskMib < 64 || bounds.tempDiskMib > 16384) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM tempDiskMib: ${bounds.tempDiskMib} (must be integer 64..16384)`,
      false,
      { field: 'tempDiskMib', value: bounds.tempDiskMib },
    );
  }
  if (
    !Number.isInteger(bounds.frameTimeoutMs) ||
    bounds.frameTimeoutMs < 50 ||
    bounds.frameTimeoutMs > 30_000
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM frameTimeoutMs: ${bounds.frameTimeoutMs} (must be integer 50..30000)`,
      false,
      { field: 'frameTimeoutMs', value: bounds.frameTimeoutMs },
    );
  }
  if (
    !Number.isInteger(bounds.renderTimeoutSeconds) ||
    bounds.renderTimeoutSeconds < 1 ||
    bounds.renderTimeoutSeconds > 1800
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM renderTimeoutSeconds: ${bounds.renderTimeoutSeconds} (must be integer 1..1800)`,
      false,
      { field: 'renderTimeoutSeconds', value: bounds.renderTimeoutSeconds },
    );
  }
  if (
    !Number.isInteger(bounds.previewTimeoutSeconds) ||
    bounds.previewTimeoutSeconds < 1 ||
    bounds.previewTimeoutSeconds > 300
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM previewTimeoutSeconds: ${bounds.previewTimeoutSeconds} (must be integer 1..300)`,
      false,
      { field: 'previewTimeoutSeconds', value: bounds.previewTimeoutSeconds },
    );
  }
  if (
    !Number.isInteger(bounds.killGraceMs) ||
    bounds.killGraceMs < 50 ||
    bounds.killGraceMs > 10_000
  ) {
    throw new CustomRuntimeError(
      'SANDBOX_RESOURCE_LIMIT',
      `Invalid render VM killGraceMs: ${bounds.killGraceMs} (must be integer 50..10000 per <=10s cancel rule)`,
      false,
      { field: 'killGraceMs', value: bounds.killGraceMs },
    );
  }

  return Object.freeze(bounds);
}

/**
 * Builds deterministic cgroup v2 resource constraint spec for outer microVM jailer/hypervisor process.
 */
export function buildMicroVmCgroupV2Spec(bounds) {
  const validated =
    bounds?.phase === 'build' ? validateBuildVmBounds(bounds) : validateRenderVmBounds(bounds);

  const cpuPeriodUs = 100_000;
  const cpuQuotaUs = validated.vcpuCount * cpuPeriodUs;
  const memoryMaxBytes = validated.memoryMib * 1024 * 1024;
  const diskMib =
    validated.phase === 'build' ? validated.scratchDiskMib : validated.tempDiskMib;
  const diskMaxBytes = diskMib * 1024 * 1024;

  return Object.freeze({
    cgroupVersion: 2,
    cpuMax: `${cpuQuotaUs} ${cpuPeriodUs}`,
    cpuQuotaUs,
    cpuPeriodUs,
    memoryMax: String(memoryMaxBytes),
    memoryMaxBytes,
    memorySwapMax: '0',
    pidsMax: String(validated.pidsLimit),
    diskMaxBytes,
    ioMaxReadBps: 524_288_000, // 500 MiB/s cap
    ioMaxWriteBps: 262_144_000, // 250 MiB/s cap
  });
}

/**
 * Builds a deterministic Firecracker microVM configuration and outer `jailer` argv.
 * Strictly enforces:
 *   - `smt: false` (mitigates hyperthreading side-channel leaks across tenants)
 *   - `network-interfaces: []` (0 NICs -> hardware-level zero external network egress)
 *   - `rootfs` drive `is_read_only: true`
 *   - `inputs` drive `is_read_only: true`
 *   - `scratch_output` drive `is_read_only: false` with bounded quota
 *   - Non-root jailer execution (`--uid 10001 --gid 10001 --cgroup-version 2`)
 */
export function buildFirecrackerMachineConfig(options) {
  const {
    vmId,
    phase,
    bounds,
    kernelImagePath,
    guestKernelDigest,
    rootfsImagePath,
    rootfsImageDigest,
    inputsDrivePath,
    scratchOutputDrivePath,
    chrootBaseDir = '/srv/jailer',
    vsockCid = 3,
    networkInterfaces = [],
  } = options;

  if (!SAFE_ID_REGEX.test(vmId || '')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid microVM ID "${vmId || ''}"`,
      false,
    );
  }
  if (!IMAGE_DIGEST_REGEX.test(guestKernelDigest || '')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid guestKernelDigest "${guestKernelDigest || ''}": must be sha256:<64 hex>`,
      false,
    );
  }
  if (!IMAGE_DIGEST_REGEX.test(rootfsImageDigest || '')) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid rootfsImageDigest "${rootfsImageDigest || ''}": must be sha256:<64 hex>`,
      false,
    );
  }
  if (Array.isArray(networkInterfaces) && networkInterfaces.length > 0) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Firecracker microVM forbids network interfaces (expected 0 NICs, got ${networkInterfaces.length})`,
      false,
      { reason: 'EGRESS_NIC_FORBIDDEN' },
    );
  }
  if (!Number.isInteger(vsockCid) || vsockCid < 3 || vsockCid > 65535) {
    throw new CustomRuntimeError(
      'SANDBOX_SECURITY_VIOLATION',
      `Invalid vsock guest CID ${vsockCid} (must be integer 3..65535; CID 0/1/2 are reserved)`,
      false,
    );
  }

  const validatedBounds =
    phase === 'build' ? validateBuildVmBounds(bounds) : validateRenderVmBounds(bounds);
  const cgroupSpec = buildMicroVmCgroupV2Spec(validatedBounds);

  const machineConfig = {
    'boot-source': {
      kernel_image_path: path.posix.normalize(kernelImagePath || '/vm/kernel/vmlinux.bin'),
      boot_args: `${HARDENED_GUEST_KERNEL_BOOT_ARGS} cve.phase=${validatedBounds.phase} cve.uid=${SANDBOX_DEFAULT_UID} cve.gid=${SANDBOX_DEFAULT_GID}`,
    },
    'machine-config': {
      vcpu_count: validatedBounds.vcpuCount,
      mem_size_mib: validatedBounds.memoryMib,
      smt: false,
      track_dirty_pages: false,
    },
    drives: [
      {
        drive_id: 'rootfs',
        path_on_host: path.resolve(rootfsImagePath || '/var/lib/cve/images/rootfs.ext4'),
        is_root_device: true,
        is_read_only: true,
        rate_limiter: {
          bandwidth: { size: cgroupSpec.ioMaxReadBps, refill_time: 1000 },
        },
      },
      {
        drive_id: 'inputs',
        path_on_host: path.resolve(inputsDrivePath),
        is_root_device: false,
        is_read_only: true,
      },
      {
        drive_id: 'scratch_output',
        path_on_host: path.resolve(scratchOutputDrivePath),
        is_root_device: false,
        is_read_only: false,
        rate_limiter: {
          bandwidth: { size: cgroupSpec.ioMaxWriteBps, refill_time: 1000 },
        },
      },
    ],
    'network-interfaces': [],
    vsock: {
      vsock_id: 'vsock0',
      guest_cid: vsockCid,
      uds_path: `/run/cve-vsock-${vmId}.sock`,
    },
    mmds_config: null,
  };

  const jailerArgv = [
    '--id',
    vmId,
    '--exec-file',
    '/usr/bin/firecracker',
    '--uid',
    String(SANDBOX_DEFAULT_UID),
    '--gid',
    String(SANDBOX_DEFAULT_GID),
    '--chroot-base-dir',
    path.resolve(chrootBaseDir),
    '--cgroup-version',
    '2',
    '--cgroup',
    `cpu.max=${cgroupSpec.cpuMax}`,
    '--cgroup',
    `memory.max=${cgroupSpec.memoryMax}`,
    '--cgroup',
    `memory.swap.max=${cgroupSpec.memorySwapMax}`,
    '--cgroup',
    `pids.max=${cgroupSpec.pidsMax}`,
    '--new-pid-ns',
  ];

  return {
    runtime: 'microvm-firecracker-v1',
    vmId,
    phase: validatedBounds.phase,
    guestKernelDigest,
    rootfsImageDigest,
    bounds: validatedBounds,
    cgroupV2: cgroupSpec,
    machineConfig,
    jailerBinary: 'jailer',
    jailerArgv,
  };
}
