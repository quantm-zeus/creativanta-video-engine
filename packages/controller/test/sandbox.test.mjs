import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvConfig } from '@creativanta/contracts';
import {
  SANDBOX_DEFAULT_UID,
  SANDBOX_DEFAULT_GID,
  DEV_PLACEHOLDER_DIGEST,
  TRUSTED_TEMPLATE_CSP,
  SandboxError,
  buildDefaultSecurityContext,
  validateSecurityContext,
  assertCustomCodeGate,
  buildChromiumSandboxArgs,
  validateChromiumFlags,
  validateTemplateHtmlPolicy,
  buildFfmpegSandboxArgv,
  buildFfprobeSandboxArgv,
  validateFfmpegArgv,
  buildDefaultResourceLimits,
  validateResourceLimits,
  buildCgroupV2Spec,
  validateHostMounts,
  validateImageDigest,
  buildSanitizedSandboxEnv,
  computeSha256Hex,
  SandboxWorkspaceManager,
  LoopbackAssetServer,
  TrustedTemplateLauncher,
  runSandboxSelfTest,
  startControllerServer,
} from '../dist/index.js';

describe('P1-04 Trusted-Template Sandbox & Narrow Runtime Launcher', () => {
  const defaultConfig = loadEnvConfig({
    CVE_ENV: 'development',
    CVE_CUSTOM_CODE_ENABLED: 'false',
    CVE_CUSTOM_RUNTIME: 'disabled',
  });

  describe('1. Non-root Security Context', () => {
    it('builds valid non-root default security context (UID/GID 10001)', () => {
      const ctx = buildDefaultSecurityContext();
      assert.strictEqual(ctx.uid, SANDBOX_DEFAULT_UID);
      assert.strictEqual(ctx.gid, SANDBOX_DEFAULT_GID);
      assert.strictEqual(ctx.readOnlyRootfs, true);
      assert.strictEqual(ctx.noNewPrivileges, true);
      assert.strictEqual(ctx.privileged, false);
      assert.deepStrictEqual(ctx.capDrop, ['ALL']);
      assert.deepStrictEqual(ctx.capAdd, []);
      assert.strictEqual(ctx.networkMode, 'none');
      assert.doesNotThrow(() => validateSecurityContext(ctx));
    });

    it('rejects root UID/GID (0), privileged mode, writable rootfs, capabilities, or network egress', () => {
      const base = buildDefaultSecurityContext();
      assert.throws(() => validateSecurityContext({ ...base, uid: 0 }), /non-root positive integer/);
      assert.throws(() => validateSecurityContext({ ...base, gid: 0 }), /non-root positive integer/);
      assert.throws(() => validateSecurityContext({ ...base, userName: 'root' }), /cannot be "root"/);
      assert.throws(() => validateSecurityContext({ ...base, readOnlyRootfs: false }), /read-only/);
      assert.throws(() => validateSecurityContext({ ...base, noNewPrivileges: false }), /no-new-privileges/);
      assert.throws(() => validateSecurityContext({ ...base, privileged: true }), /Privileged mode is strictly forbidden/);
      assert.throws(() => validateSecurityContext({ ...base, capDrop: [] }), /drop ALL Linux capabilities/);
      assert.throws(() => validateSecurityContext({ ...base, capAdd: ['NET_ADMIN'] }), /must not add Linux capabilities/);
      assert.throws(
        () => validateSecurityContext({ ...base, networkMode: 'bridge' }),
        /networkMode must be "none"/,
      );
      assert.throws(
        () => validateSecurityContext({ ...base, seccompProfile: 'unconfined' }),
        /seccompProfile cannot be empty or "unconfined"/,
      );
      assert.throws(
        () => validateSecurityContext({ ...base, apparmorProfile: 'unconfined' }),
        /apparmorProfile cannot be "unconfined"/,
      );
    });
  });

  describe('2. Custom Code Off Gate', () => {
    it('allows structured engines (html-v1, canvas-v1, svg-v1) when custom code is off', () => {
      assert.doesNotThrow(() =>
        assertCustomCodeGate({ config: defaultConfig, engine: 'html-v1' }),
      );
      assert.doesNotThrow(() =>
        assertCustomCodeGate({ config: defaultConfig, engine: 'canvas-v1' }),
      );
      assert.doesNotThrow(() =>
        assertCustomCodeGate({ config: defaultConfig, engine: 'svg-v1' }),
      );
    });

    it('blocks custom-html-v1 engine and custom scene bundles in trusted-template launcher', () => {
      assert.throws(
        () => assertCustomCodeGate({ config: defaultConfig, engine: 'custom-html-v1' }),
        (err) => err instanceof SandboxError && err.code === 'CAPABILITY_DISABLED' && !err.retryable,
      );
      assert.throws(
        () => assertCustomCodeGate({ config: defaultConfig, engine: 'html-v1', hasBundle: true }),
        (err) => err instanceof SandboxError && err.code === 'CAPABILITY_DISABLED',
      );
    });

    it('forbids custom code on standard container runtimes even if flag is toggled in test config', () => {
      assert.throws(
        () =>
          assertCustomCodeGate({
            config: {
              CVE_CUSTOM_CODE_ENABLED: true,
              CVE_CUSTOM_RUNTIME: 'docker',
              CVE_CUSTOM_TENANT_ALLOWLIST: ['tenant-1'],
            },
            engine: 'custom-html-v1',
            tenantId: 'tenant-1',
            securityGateDigest:
              'sha256:1111111111111111111111111111111111111111111111111111111111111111',
            allowApprovedCustomPool: true,
          }),
        (err) =>
          err instanceof SandboxError &&
          err.code === 'SANDBOX_SECURITY_VIOLATION' &&
          /disposable microVM runtime/.test(err.message),
      );
    });
  });

  describe('3. Chromium Sandbox Flags, Template HTML & FFmpeg Safe Argv', () => {
    it('builds hardened Chromium args with sandbox active and rejects --no-sandbox', () => {
      const args = buildChromiumSandboxArgs();
      assert.ok(args.includes('--headless=new'));
      assert.ok(args.includes('--disable-background-networking'));
      assert.ok(args.includes('--run-all-compositor-stages-before-draw'));
      assert.ok(args.includes('--remote-debugging-port=0'));
      assert.ok(!args.includes('--no-sandbox'));

      for (const badFlag of [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--no-zygote',
        '--single-process',
        '--disable-seccomp-filter-sandbox',
        '--disable-namespace-sandbox',
        '--disable-web-security',
        '--remote-debugging-port=9222',
        '--remote-debugging-address=0.0.0.0',
      ]) {
        assert.throws(
          () => buildChromiumSandboxArgs([badFlag]),
          (err) => err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION',
          `Expected flag ${badFlag} to be rejected`,
        );
      }
    });

    it('enforces zero-egress template HTML policy (rejects remote URLs, Google Fonts, ServiceWorker, WebRTC)', () => {
      assert.doesNotThrow(() =>
        validateTemplateHtmlPolicy(
          '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/style.css"></head><body><h1>Xin chào</h1></body></html>',
        ),
      );
      assert.throws(
        () => validateTemplateHtmlPolicy('<script src="https://cdn.example.com/app.js"></script>'),
        /forbidden external network URL/,
      );
      assert.throws(
        () =>
          validateTemplateHtmlPolicy(
            '<style>@import url("https://fonts.googleapis.com/css2?family=Noto+Sans");</style>',
          ),
        /forbidden external CSS @import/,
      );
      assert.throws(
        () => validateTemplateHtmlPolicy('<script>navigator.serviceWorker.register("/sw.js")</script>'),
        /forbidden ServiceWorker API/,
      );
      assert.throws(
        () => validateTemplateHtmlPolicy('<script>new RTCPeerConnection()</script>'),
        /forbidden WebRTC API/,
      );
    });

    it('builds safe FFmpeg/ffprobe argv arrays with -protocol_whitelist file,pipe and blocks SSRF/nonfree', () => {
      const ffmpegArgs = buildFfmpegSandboxArgv([
        '-i',
        '/workspace/inputs/clip.mp4',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '/workspace/output/out.mp4',
      ]);
      assert.ok(ffmpegArgs.includes('-nostdin'));
      assert.strictEqual(
        ffmpegArgs[ffmpegArgs.indexOf('-protocol_whitelist') + 1],
        'file,pipe',
      );

      const ffprobeArgs = buildFfprobeSandboxArgv('/workspace/output/out.mp4');
      assert.strictEqual(
        ffprobeArgs[ffprobeArgs.indexOf('-protocol_whitelist') + 1],
        'file,pipe',
      );

      for (const badArg of [
        '--enable-nonfree',
        'libfdk_aac',
        'http://169.254.169.254/latest/meta-data/',
        'https://evil.example.com/playlist.m3u8',
        'concat:/workspace/inputs/a.mp4|/etc/passwd',
        'subfile,,start,0,end,100,,:/etc/shadow',
        '../secret.mp4',
      ]) {
        assert.throws(
          () => buildFfmpegSandboxArgv([badArg]),
          (err) => err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION',
          `Expected FFmpeg arg "${badArg}" to be rejected`,
        );
      }

      assert.throws(
        () => validateFfmpegArgv(['-i', 'input.mp4']),
        /must include -protocol_whitelist "file,pipe"/,
      );
    });
  });

  describe('4. Cgroup v2 / Time / Disk / PID Limits', () => {
    it('computes exact cgroup v2 specifications from starter-v1 limits', () => {
      const limits = buildDefaultResourceLimits(defaultConfig);
      assert.strictEqual(limits.cpuLimitVcpu, 2);
      assert.strictEqual(limits.memoryMib, 4096);
      assert.strictEqual(limits.pidsLimit, 256);
      assert.strictEqual(limits.tempDiskMib, 8192);
      assert.strictEqual(limits.frameTimeoutMs, 5000);
      assert.strictEqual(limits.renderTimeoutSeconds, 600);
      assert.strictEqual(limits.previewTimeoutSeconds, 120);

      const cg = buildCgroupV2Spec(limits);
      assert.strictEqual(cg.cpuMax, '200000 100000');
      assert.strictEqual(cg.memoryMax, String(4096 * 1024 * 1024));
      assert.strictEqual(cg.memorySwapMax, '0');
      assert.strictEqual(cg.pidsMax, '256');
      assert.strictEqual(cg.tempDiskMaxBytes, 8192 * 1024 * 1024);
    });

    it('rejects out-of-range resource limits and killGraceMs > 10s', () => {
      const base = buildDefaultResourceLimits(defaultConfig);
      assert.throws(() => validateResourceLimits({ ...base, cpuLimitVcpu: 0 }), /cpuLimitVcpu/);
      assert.throws(() => validateResourceLimits({ ...base, memoryMib: 128 }), /memoryMib/);
      assert.throws(() => validateResourceLimits({ ...base, pidsLimit: 8 }), /pidsLimit/);
      assert.throws(() => validateResourceLimits({ ...base, killGraceMs: 15000 }), /killGraceMs/);
    });
  });

  describe('5. No Host Socket, Mount Guard & Sanitized Environment', () => {
    it('rejects Docker socket, containerd socket, SSH agent, /proc, and writable inputs mount', () => {
      const wm = new SandboxWorkspaceManager();
      const ws = wm.createWorkspace('job-mounts', 'att-1');
      try {
        for (const badMount of [
          { source: '/var/run/docker.sock', destination: '/var/run/docker.sock', readOnly: false },
          { source: '/run/docker.sock', destination: '/workspace/docker.sock', readOnly: true },
          { source: '/run/containerd/containerd.sock', destination: '/workspace/c.sock', readOnly: true },
          { source: '/tmp/ssh-agent.sock', destination: '/workspace/ssh.sock', readOnly: true },
          { source: '/proc', destination: '/workspace/proc', readOnly: true },
          { source: '/etc/shadow', destination: '/workspace/inputs', readOnly: true },
          { source: ws.inputsDir, destination: '/workspace/inputs', readOnly: false },
        ]) {
          assert.throws(
            () => validateHostMounts([badMount], ws),
            (err) => err instanceof SandboxError && err.code === 'SANDBOX_SECURITY_VIOLATION',
            `Expected mount ${badMount.source} -> ${badMount.destination} to be rejected`,
          );
        }
      } finally {
        wm.cleanup(ws);
      }
    });

    it('validates immutable image digests and rejects :latest or dev placeholder in staging/production', () => {
      assert.strictEqual(
        validateImageDigest(DEV_PLACEHOLDER_DIGEST, 'development'),
        DEV_PLACEHOLDER_DIGEST,
      );
      assert.throws(
        () => validateImageDigest('creativanta-renderer:latest', 'development'),
        /Must be immutable sha256:<64 lowercase hex>/,
      );
      assert.throws(
        () => validateImageDigest(DEV_PLACEHOLDER_DIGEST, 'staging'),
        /Development placeholder image digest is forbidden in staging/,
      );
      assert.throws(
        () => validateImageDigest(DEV_PLACEHOLDER_DIGEST, 'production'),
        /Development placeholder image digest is forbidden in production/,
      );
    });

    it('strips controller secrets from sandbox environment and blocks secret injection', () => {
      const env = buildSanitizedSandboxEnv({
        jobId: 'job-env-1',
        attemptId: 'att-1',
        loopbackAssetOrigin: 'http://127.0.0.1:45678',
      });
      assert.strictEqual(env.TZ, 'UTC');
      assert.strictEqual(env.CVE_SANDBOX_MODE, 'trusted-template-v1');
      assert.strictEqual(env.CVE_LOOPBACK_ASSET_ORIGIN, 'http://127.0.0.1:45678');
      assert.strictEqual('CVE_DATABASE_URL' in env, false);
      assert.strictEqual('CVE_STORAGE_SECRET_ACCESS_KEY' in env, false);
      assert.strictEqual('CVE_API_KEY_PEPPER' in env, false);

      assert.throws(
        () =>
          buildSanitizedSandboxEnv({
            jobId: 'job-env-1',
            attemptId: 'att-1',
            extraEnv: { CVE_API_KEY_PEPPER: 'secret' },
          }),
        /Forbidden secret environment variable/,
      );

      assert.throws(
        () =>
          buildSanitizedSandboxEnv({
            jobId: 'job-env-1',
            attemptId: 'att-1',
            loopbackAssetOrigin: 'http://example.com:8080',
          }),
        /loopbackAssetOrigin must use http:\/\/127\.0\.0\.1/,
      );
    });
  });

  describe('6. Read-Only Inputs, Workspace Isolation, Symlink/Quota Guard & Output Verification', () => {
    it('enforces read-only staged inputs, blocks path traversal/symlinks, and verifies MP4/PNG outputs', () => {
      const wm = new SandboxWorkspaceManager();
      assert.throws(() => wm.createWorkspace('../escape', 'att-1'), /Invalid jobId/);

      const ws = wm.createWorkspace('job-iso-1', 'att-1');
      try {
        assert.throws(
          () => wm.resolveSafeRelativePath(ws.inputsDir, '../outside.txt'),
          /Path traversal segment/,
        );
        assert.throws(
          () => wm.resolveSafeRelativePath(ws.inputsDir, '/etc/passwd'),
          /Absolute path is forbidden/,
        );
        assert.throws(
          () => wm.resolveSafeRelativePath(ws.inputsDir, 'a/b/c/d/e/f/g/h/i/too-deep.txt'),
          /exceeds maximum allowed 8/,
        );

        const content = Buffer.from('{"hello":"world"}', 'utf-8');
        const sha = computeSha256Hex(content);

        // Wrong SHA-256 rejected
        assert.throws(
          () =>
            wm.stageInputs(ws, [
              {
                relativePath: 'spec.json',
                content,
                expectedSha256: '0'.repeat(64),
              },
            ]),
          /SHA-256 mismatch/,
        );

        // Valid staging locks inputs read-only
        const staged = wm.stageInputs(ws, [
          {
            relativePath: 'spec.json',
            content,
            expectedSha256: sha,
            kind: 'manifest',
          },
        ]);
        const specEntry = staged.get('spec.json');
        assert.ok(specEntry);
        assert.strictEqual(specEntry.sha256, sha);

        // Attempting to write to staged file throws EACCES/EPERM
        assert.throws(
          () => fs.writeFileSync(specEntry.filePath, 'modified'),
          (err) => err.code === 'EACCES' || err.code === 'EPERM',
        );

        // Symlink inside outputDir is rejected by verifyOutputArtifact
        const badFile = path.join(ws.outputDir, 'bad.mp4');
        fs.writeFileSync(badFile, 'not-an-mp4-header-at-all');
        assert.throws(
          () => wm.verifyOutputArtifact(ws, 'bad.mp4', 'mp4'),
          /failed MP4 magic-byte check/,
        );

        const symlinkPath = path.join(ws.outputDir, 'link.mp4');
        fs.symlinkSync(badFile, symlinkPath);
        assert.throws(
          () => wm.verifyOutputArtifact(ws, 'link.mp4', 'mp4'),
          /not a regular file/,
        );
        fs.unlinkSync(symlinkPath);

        // Valid PNG signature passes verification
        const validPng = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
        ]);
        fs.writeFileSync(path.join(ws.outputDir, 'frame-0.png'), validPng);
        const verifiedPng = wm.verifyOutputArtifact(ws, 'frame-0.png', 'png');
        assert.strictEqual(verifiedPng.format, 'png');
        assert.strictEqual(verifiedPng.bytes, validPng.byteLength);

        // Disk quota exceeded throws SANDBOX_RESOURCE_LIMIT
        assert.throws(
          () => wm.checkDiskQuota(ws, 10),
          (err) => err instanceof SandboxError && err.code === 'SANDBOX_RESOURCE_LIMIT',
        );
      } finally {
        wm.cleanup(ws);
      }
      assert.strictEqual(fs.existsSync(ws.rootDir), false);
    });
  });

  describe('7. Loopback Asset Server & Container Launch Spec', () => {
    it('serves only allowlisted manifest assets on 127.0.0.1 and generates full isolated docker spec', async () => {
      const launcher = new TrustedTemplateLauncher();
      const wm = launcher.getWorkspaceManager();
      const ws = wm.createWorkspace('job-loopback', 'att-1');
      const assetServer = new LoopbackAssetServer(ws.inputsDir);

      try {
        const fontBytes = Buffer.from('WOFF2_FAKE_HEADER_BYTES');
        const fontSha = computeSha256Hex(fontBytes);
        const staged = wm.stageInputs(ws, [
          {
            relativePath: 'fonts/inter.woff2',
            content: fontBytes,
            expectedSha256: fontSha,
            kind: 'font',
          },
        ]);
        const fontFile = staged.get('fonts/inter.woff2').filePath;
        assetServer.registerAsset('/assets/fonts/inter.woff2', fontFile, fontSha, 'font/woff2');

        const origin = await assetServer.start();
        assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);

        // Allowed asset returns 200 + CSP header + hash header
        const okRes = await fetch(`${origin}/assets/fonts/inter.woff2`);
        assert.strictEqual(okRes.status, 200);
        assert.strictEqual(okRes.headers.get('x-asset-sha256'), fontSha);
        assert.strictEqual(okRes.headers.get('content-security-policy'), TRUSTED_TEMPLATE_CSP);

        // Unlisted asset returns 404
        const notFoundRes = await fetch(`${origin}/assets/fonts/other.woff2`);
        assert.strictEqual(notFoundRes.status, 404);

        // Query string or path traversal returns 403
        const queryRes = await fetch(`${origin}/assets/fonts/inter.woff2?token=abc`);
        assert.strictEqual(queryRes.status, 403);

        // POST method returns 405
        const postRes = await fetch(`${origin}/assets/fonts/inter.woff2`, { method: 'POST' });
        assert.strictEqual(postRes.status, 405);

        // Build container launch spec
        const spec = launcher.buildContainerLaunchSpec({
          config: defaultConfig,
          jobId: ws.jobId,
          attemptId: ws.attemptId,
          jobKind: 'render',
          engine: 'html-v1',
          workspace: ws,
          loopbackAssetOrigin: origin,
        });

        assert.strictEqual(spec.runtimeBinary, 'docker');
        assert.ok(spec.argv.includes('--read-only'));
        assert.strictEqual(spec.argv[spec.argv.indexOf('--user') + 1], '10001:10001');
        assert.strictEqual(spec.argv[spec.argv.indexOf('--network') + 1], 'none');
        assert.strictEqual(spec.argv[spec.argv.indexOf('--cap-drop') + 1], 'ALL');
        assert.ok(spec.argv.includes('no-new-privileges:true'));
        assert.strictEqual(spec.argv[spec.argv.indexOf('--cpus') + 1], '2');
        assert.strictEqual(spec.argv[spec.argv.indexOf('--memory') + 1], '4096m');
        assert.strictEqual(spec.argv[spec.argv.indexOf('--memory-swap') + 1], '4096m');
        assert.strictEqual(spec.argv[spec.argv.indexOf('--pids-limit') + 1], '256');
        assert.ok(
          spec.argv.some((a) => a.includes('dst=/workspace/inputs,readonly')),
          'Inputs mount must be readonly',
        );
        assert.ok(
          !spec.argv.some((a) => a.includes('docker.sock')),
          'Docker socket must never be mounted',
        );
      } finally {
        await assetServer.stop();
        wm.cleanup(ws);
      }
    });
  });

  describe('8. End-to-End Sandbox Capability Self-Test & Controller Readiness Probe', () => {
    it('passes all 8 checks in runSandboxSelfTest()', async () => {
      const report = await runSandboxSelfTest(defaultConfig);
      assert.strictEqual(report.status, 'PASS');
      assert.strictEqual(report.checks.length, 8);
      for (const check of report.checks) {
        assert.strictEqual(check.status, 'PASS', `Self-test check ${check.name} failed: ${check.detail}`);
      }
    });

    it('exposes /healthz and /readyz on Controller server gated by sandbox self-test', async () => {
      const server = startControllerServer(defaultConfig);
      const port = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(addr.port);
        });
      });

      try {
        const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.strictEqual(healthRes.status, 200);
        const healthBody = await healthRes.json();
        assert.strictEqual(healthBody.status, 'ok');
        assert.strictEqual(healthBody.custom_code_enabled, false);
        assert.strictEqual(healthBody.custom_runtime, 'disabled');

        const readyRes = await fetch(`http://127.0.0.1:${port}/readyz`);
        assert.strictEqual(readyRes.status, 200);
        const readyBody = await readyRes.json();
        assert.strictEqual(readyBody.status, 'ready');
        assert.strictEqual(readyBody.sandbox_self_test.status, 'PASS');
      } finally {
        await new Promise((resolve) => server.close(() => resolve()));
      }
    });
  });
});
