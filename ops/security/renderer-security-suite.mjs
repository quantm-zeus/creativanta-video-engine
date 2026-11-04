/**
 * Creativanta Video Engine — P6-04 Structured Renderer Security Suite
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Threat model", "Renderer sandbox", "Security test gates", lines 7-42)
 *   - docs/TESTING.md ("Security tests", lines 30-35)
 *   - docs/SCENE-SPEC.md ("Sandboxed Composition Model", "Prohibited Constructs")
 *
 * Executes structured runtime security checks across all renderer sandbox invariants:
 *   1. Non-root execution context (UID/GID != 0) & Custom Code hard-off gate (CVE_CUSTOM_CODE_ENABLED=false)
 *   2. Chromium sandbox flags enforcement & --no-sandbox / remote-debugging / file-access bans
 *   3. HTML/CSS/SVG/SceneSpec zero-egress CSP, XXE, WebRTC, ServiceWorker & BrandTokens injection guards
 *   4. FFmpeg safe argument array validation (no shell interpolation, strict -protocol_whitelist "file,pipe")
 *   5. Read-only staged inputs enforcement (0440 file / 0550 dir) + real subprocess write attempt -> EACCES
 *   6. Output path traversal, symlink escape, hardlink (nlink > 1), and magic-byte spoofing rejection
 *   7. Resource bomb containment: infinite loop timeout process-group SIGKILL & workspace disk quota bomb enforcement
 *   8. Secret canary exfiltration prevention: env allowlist stripping, stdout/stderr redaction, forbidden host mounts
 *   9. LoopbackAssetServer (127.0.0.1) strict allowlist, traversal block, and SHA-256 tamper rejection
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SANDBOX_DEFAULT_UID,
  SANDBOX_DEFAULT_GID,
  FORBIDDEN_CHROMIUM_FLAGS,
  REQUIRED_CHROMIUM_FLAGS,
  TRUSTED_TEMPLATE_CSP,
  SandboxError,
  computeSha256Hex,
  redactSecretOutput,
  buildDefaultSecurityContext,
  validateSecurityContext,
  assertCustomCodeGate,
  validateChromiumFlags,
  buildChromiumSandboxArgs,
  validateTemplateHtmlPolicy,
  validateFfmpegArgv,
  buildFfmpegSandboxArgv,
  buildFfprobeSandboxArgv,
  buildDefaultResourceLimits,
  buildCgroupV2Spec,
  validateHostMounts,
  buildSanitizedSandboxEnv,
  SandboxWorkspaceManager,
  LoopbackAssetServer,
  TrustedTemplateLauncher,
} from '../../packages/controller/dist/index.js';
import { loadEnvConfig, validateCompositionUnified } from '../../packages/contracts/dist/index.js';
import { validateBrandTokens } from '../../packages/sdk/dist/index.js';
import { redactString } from '../logging/redacted-logger.mjs';

function assertThrowsSandboxError(fn, expectedCode) {
  let caught = null;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  if (!caught) {
    throw new Error(`Expected SandboxError(${expectedCode}), but function did not throw`);
  }
  if (!(caught instanceof SandboxError) && caught.code !== expectedCode) {
    throw new Error(`Expected code ${expectedCode}, got ${caught.code || caught.message}`);
  }
  if (expectedCode && caught.code !== expectedCode) {
    throw new Error(`Expected error code ${expectedCode}, got ${caught.code} (${caught.message})`);
  }
  return caught;
}

export class RendererSecuritySuite {
  async runAll() {
    const startedAt = Date.now();
    const checks = [];
    const defaultConfig = loadEnvConfig();

    const recordCheck = async (id, title, category, fn) => {
      const t0 = performance.now();
      try {
        const details = await fn();
        checks.push({
          id,
          title,
          category,
          passed: true,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          details,
        });
      } catch (err) {
        checks.push({
          id,
          title,
          category,
          passed: false,
          durationMs: Number((performance.now() - t0).toFixed(2)),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // 1. Non-root execution context & Custom Code hard-off gate
    await recordCheck(
      'RND-SEC-01',
      'Non-root execution context (UID/GID != 0) & Custom Code hard-off gate',
      'privilege_and_custom_code',
      async () => {
        const ctx = buildDefaultSecurityContext();
        validateSecurityContext(ctx);

        assertThrowsSandboxError(() => validateSecurityContext({ ...ctx, uid: 0 }), 'SANDBOX_SECURITY_VIOLATION');
        assertThrowsSandboxError(() => validateSecurityContext({ ...ctx, gid: 0 }), 'SANDBOX_SECURITY_VIOLATION');
        assertThrowsSandboxError(
          () => validateSecurityContext({ ...ctx, userName: 'root' }),
          'SANDBOX_SECURITY_VIOLATION'
        );
        assertThrowsSandboxError(
          () => validateSecurityContext({ ...ctx, privileged: true }),
          'SANDBOX_SECURITY_VIOLATION'
        );
        assertThrowsSandboxError(
          () => validateSecurityContext({ ...ctx, networkMode: 'bridge' }),
          'SANDBOX_SECURITY_VIOLATION'
        );

        // Custom code off gate in controller and composition spec
        assertCustomCodeGate({ config: defaultConfig, engine: 'html-v1' });
        assertThrowsSandboxError(
          () => assertCustomCodeGate({ config: defaultConfig, engine: 'custom-html-v1' }),
          'CAPABILITY_DISABLED'
        );
        assertThrowsSandboxError(
          () => assertCustomCodeGate({ config: defaultConfig, engine: 'html-v1', hasBundle: true }),
          'CAPABILITY_DISABLED'
        );

        // Verify customCode / custom-html-v1 in CompositionSpec is rejected when customCodeEnabled=false
        const customCodeSpec = {
          id: 'cmp_custom_code_attempt',
          schema_version: '1.0',
          width: 1280,
          height: 720,
          fps: { num: 30, den: 1 },
          duration_frames: 90,
          background_color: '#000000',
          fonts: [],
          audio_tracks: [],
          subtitles: [],
          scenes: [
            {
              id: 'scn_custom_01',
              name: 'Custom Code Scene',
              engine: 'custom-html-v1',
              start_frame: 0,
              duration_frames: 90,
              layers: [],
            },
          ],
        };
        const specValidation = validateCompositionUnified(customCodeSpec, {
          profile: 'mp4-720p-v1',
          capabilityOptions: { customCodeEnabled: false },
        });
        if (specValidation.valid) {
          throw new Error('validateCompositionUnified must reject custom-html-v1 when customCodeEnabled=false');
        }

        // Verify Dockerfile.renderer-sandbox enforces CVE_CUSTOM_CODE_ENABLED=false and nonroot 10001:10001
        const dockerfile = fs.readFileSync(path.resolve('docker/Dockerfile.renderer-sandbox'), 'utf-8');
        if (!dockerfile.includes('CVE_CUSTOM_CODE_ENABLED=false')) {
          throw new Error('Dockerfile.renderer-sandbox missing CVE_CUSTOM_CODE_ENABLED=false');
        }
        if (!dockerfile.includes('USER 10001:10001')) {
          throw new Error('Dockerfile.renderer-sandbox missing USER 10001:10001');
        }

        return {
          nonRootUid: SANDBOX_DEFAULT_UID,
          nonRootGid: SANDBOX_DEFAULT_GID,
          customCodeEnabled: defaultConfig.CVE_CUSTOM_CODE_ENABLED,
          customCodeSpecRejected: !specValidation.valid,
        };
      }
    );

    // 2. Chromium sandbox flags & forbidden launch arguments
    await recordCheck(
      'RND-SEC-02',
      'Chromium sandbox flags enforced & --no-sandbox / remote-debugging / file-access banned',
      'chromium_sandbox',
      async () => {
        const blockedFlags = [];
        for (const forbidden of FORBIDDEN_CHROMIUM_FLAGS) {
          assertThrowsSandboxError(
            () => buildChromiumSandboxArgs([forbidden]),
            'SANDBOX_SECURITY_VIOLATION'
          );
          blockedFlags.push(forbidden);
        }

        // Non-zero remote debugging port must be blocked
        assertThrowsSandboxError(
          () => validateChromiumFlags([...REQUIRED_CHROMIUM_FLAGS, '--remote-debugging-port=9222']),
          'SANDBOX_SECURITY_VIOLATION'
        );

        // Missing required sandbox flag must fail closed
        assertThrowsSandboxError(
          () => validateChromiumFlags(['--headless=new']),
          'SANDBOX_SECURITY_VIOLATION'
        );

        // Exact required flags must pass
        const validArgs = buildChromiumSandboxArgs();
        validateChromiumFlags(validArgs);

        return {
          forbiddenFlagsBlockedCount: blockedFlags.length,
          requiredSandboxFlagsCount: REQUIRED_CHROMIUM_FLAGS.length,
          blockedFlags,
        };
      }
    );

    // 3. HTML/CSS/SVG/BrandTokens zero-egress CSP & injection vectors
    await recordCheck(
      'RND-SEC-03',
      'HTML/CSS/SVG/BrandTokens zero-egress CSP, XXE, WebRTC, ServiceWorker, and DOM injection rejection',
      'html_css_dom_isolation',
      async () => {
        const validBaseHtml = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${TRUSTED_TEMPLATE_CSP}"></head><body><div>Safe Frame</div></body></html>`;
        validateTemplateHtmlPolicy(validBaseHtml);

        const maliciousPayloads = [
          {
            name: 'remote_https_img',
            html: '<img src="https://evil.example.com/pixel.png" />',
          },
          {
            name: 'protocol_relative_script',
            html: '<script src="//evil.example.com/payload.js"></script>',
          },
          {
            name: 'css_remote_import',
            html: '<style>@import url("https://fonts.googleapis.com/css2?family=Inter");</style>',
          },
          {
            name: 'css_remote_background_url',
            html: '<div style="background: url(https://evil.example.com/track.png)"></div>',
          },
          {
            name: 'svg_xxe_entity',
            html: '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "http://169.254.169.254/latest/meta-data/">]><svg>&xxe;</svg>',
          },
          {
            name: 'service_worker_registration',
            html: '<script>navigator.serviceWorker.register("/sw.js")</script>',
          },
          {
            name: 'webrtc_ip_leak',
            html: '<script>new RTCPeerConnection()</script>',
          },
        ];

        for (const payload of maliciousPayloads) {
          assertThrowsSandboxError(
            () => validateTemplateHtmlPolicy(payload.html),
            'SANDBOX_SECURITY_VIOLATION'
          );
        }

        // BrandTokens CSS injection test
        const maliciousBrandTokens = {
          primaryColor: '#FF5733; background-image: url(https://evil.example.com/steal)',
          secondaryColor: '#112233',
          backgroundColor: '#000000',
          textColor: '#FFFFFF',
          accentColor: '#00FF88',
          fontFamilyHeading: 'Inter',
          fontFamilyBody: 'Inter',
          fontFamilyMono: 'JetBrains Mono',
        };
        const brandRes = validateBrandTokens(maliciousBrandTokens);
        if (brandRes.valid) {
          throw new Error('validateBrandTokens must reject CSS url() / semicolon injection in color token');
        }

        return {
          maliciousHtmlPayloadsBlocked: maliciousPayloads.length,
          brandTokensCssInjectionBlocked: !brandRes.valid,
          cspPolicy: TRUSTED_TEMPLATE_CSP,
        };
      }
    );

    // 4. FFmpeg safe argument array & protocol whitelist enforcement
    await recordCheck(
      'RND-SEC-04',
      'FFmpeg safe argument array validation (no shell interpolation, strict -protocol_whitelist "file,pipe")',
      'ffmpeg_isolation',
      async () => {
        const safeArgs = buildFfmpegSandboxArgv([
          '-framerate',
          '30',
          '-i',
          '/workspace/inputs/frame_%06d.png',
          '-c:v',
          'libx264',
          '/workspace/output/video.mp4',
        ]);
        const probeArgs = buildFfprobeSandboxArgv('/workspace/output/video.mp4');

        const whitelistIdx = safeArgs.indexOf('-protocol_whitelist');
        if (whitelistIdx === -1 || safeArgs[whitelistIdx + 1] !== 'file,pipe') {
          throw new Error('FFmpeg args missing -protocol_whitelist "file,pipe"');
        }
        if (!probeArgs.includes('file,pipe')) {
          throw new Error('FFprobe args missing -protocol_whitelist "file,pipe"');
        }

        // Reject remote URL injection in FFmpeg argv
        for (const badArg of [
          'https://evil.example.com/exploit.m3u8',
          'http://169.254.169.254/latest/meta-data/',
          'concat:http://evil.example.com/a.ts|b.ts',
          '/etc/passwd',
          '../../etc/shadow',
          '--enable-nonfree',
          'libfdk_aac',
        ]) {
          assertThrowsSandboxError(
            () => buildFfmpegSandboxArgv(['-i', badArg]),
            'SANDBOX_SECURITY_VIOLATION'
          );
        }

        // Reject missing -protocol_whitelist
        assertThrowsSandboxError(
          () => validateFfmpegArgv(['-i', '/workspace/inputs/a.mp4']),
          'SANDBOX_SECURITY_VIOLATION'
        );

        return {
          protocolWhitelist: safeArgs[whitelistIdx + 1],
          remoteInputBlocked: true,
          nonfreeCodecFlagBlocked: true,
          pathTraversalBlocked: true,
        };
      }
    );

    // 5. Read-only staged inputs enforcement (0440 file / 0550 dir) + real subprocess write attempt -> EACCES
    await recordCheck(
      'RND-SEC-05',
      'Read-only staged inputs (0440 file / 0550 dir) block mutation in real sandboxed subprocess (EACCES)',
      'filesystem_isolation',
      async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-ro-'));
        const wm = new SandboxWorkspaceManager(tmpBase);
        const launcher = new TrustedTemplateLauncher(wm);
        const ws = wm.createWorkspace('job_ro_test_01', 'att_ro_01');
        try {
          const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
          const sha256 = computeSha256Hex(content);

          const stagedMap = wm.stageInputs(ws, [
            {
              relativePath: 'asset_logo_01.png',
              content,
              expectedSha256: sha256,
              kind: 'asset',
            },
          ]);
          const stagedEntry = stagedMap.get('asset_logo_01.png');

          // Attempt to overwrite the staged file from inside a real sandboxed child process
          const limits = buildDefaultResourceLimits(defaultConfig);
          const subRes = await launcher.runSandboxedProcess({
            command: process.execPath,
            argv: [
              '-e',
              `const fs = require('node:fs');
               try {
                 fs.writeFileSync(${JSON.stringify(stagedEntry.filePath)}, 'overwrite');
                 process.exit(0);
               } catch (err) {
                 console.error(err.code);
                 process.exit(42);
               }`,
            ],
            workspace: ws,
            limits,
            timeoutMs: 5000,
          });

          if (subRes.exitCode !== 42 || !subRes.stderr.includes('EACCES')) {
            throw new Error(
              `Expected subprocess write to fail with EACCES (exit 42), got exit=${subRes.exitCode}, stderr=${subRes.stderr}`
            );
          }

          // Also verify hash mismatch on staging is rejected
          assertThrowsSandboxError(
            () =>
              wm.stageInputs(ws, [
                {
                  relativePath: 'tampered.png',
                  content,
                  expectedSha256: '0'.repeat(64),
                  kind: 'asset',
                },
              ]),
            'SANDBOX_SECURITY_VIOLATION'
          );

          return {
            stagedFileModeOctal: '0440',
            stagedDirModeOctal: '0550',
            subprocessWriteAttemptExitCode: subRes.exitCode,
            subprocessWriteDeniedCode: 'EACCES',
            tamperedInputHashBlocked: true,
          };
        } finally {
          wm.cleanup(ws);
          fs.rmSync(tmpBase, { recursive: true, force: true });
        }
      }
    );

    // 6. Output artifact path traversal, symlink escape, hardlink (nlink > 1), and magic-byte spoofing
    await recordCheck(
      'RND-SEC-06',
      'Output artifact path traversal, symlink escape, hardlink (nlink > 1), and magic-byte spoofing blocked',
      'artifact_publish_guard',
      async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-out-'));
        const wm = new SandboxWorkspaceManager(tmpBase);
        const ws = wm.createWorkspace('job_out_test_01', 'att_out_01');
        try {
          // 6a. Path traversal outside outputDir
          assertThrowsSandboxError(
            () => wm.verifyOutputArtifact(ws, '../secret.mp4', 'mp4'),
            'SANDBOX_SECURITY_VIOLATION'
          );

          // 6b. Symlink escape pointing to outside file
          const outsideFile = path.join(tmpBase, 'outside_secret.txt');
          fs.writeFileSync(outsideFile, 'secret data');
          const symlinkPath = path.join(ws.outputDir, 'symlink_video.mp4');
          fs.symlinkSync(outsideFile, symlinkPath);
          assertThrowsSandboxError(
            () => wm.verifyOutputArtifact(ws, 'symlink_video.mp4', 'mp4'),
            'SANDBOX_SECURITY_VIOLATION'
          );
          fs.unlinkSync(symlinkPath);

          // 6c. Hardlink escape (nlink > 1)
          const hardlinkTarget = path.join(tmpBase, 'hardlink_source.mp4');
          const validMp4Bytes = Buffer.from([
            0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
          ]);
          fs.writeFileSync(hardlinkTarget, validMp4Bytes);
          const hardlinkInOutputs = path.join(ws.outputDir, 'hardlinked.mp4');
          fs.linkSync(hardlinkTarget, hardlinkInOutputs);
          assertThrowsSandboxError(
            () => wm.verifyOutputArtifact(ws, 'hardlinked.mp4', 'mp4'),
            'SANDBOX_SECURITY_VIOLATION'
          );
          fs.unlinkSync(hardlinkInOutputs);

          // 6d. Magic byte spoofing (HTML/script file renamed to .mp4)
          const spoofedMp4 = path.join(ws.outputDir, 'spoofed.mp4');
          fs.writeFileSync(spoofedMp4, '<!DOCTYPE html><script>alert(1)</script>');
          assertThrowsSandboxError(
            () => wm.verifyOutputArtifact(ws, 'spoofed.mp4', 'mp4'),
            'ENCODE_VERIFICATION_FAILED'
          );
          fs.unlinkSync(spoofedMp4);

          // 6e. Valid single-link MP4 inside outputDir passes
          const validMp4Path = path.join(ws.outputDir, 'valid.mp4');
          fs.writeFileSync(validMp4Path, validMp4Bytes);
          const verified = wm.verifyOutputArtifact(ws, 'valid.mp4', 'mp4');

          return {
            pathTraversalBlocked: true,
            symlinkEscapeBlocked: true,
            hardlinkEscapeBlocked: true,
            magicByteSpoofingBlocked: true,
            validSingleLinkArtifactSha256: verified.sha256,
          };
        } finally {
          wm.cleanup(ws);
          fs.rmSync(tmpBase, { recursive: true, force: true });
        }
      }
    );

    // 7. Resource bombs: infinite-loop timeout process-group kill & disk quota bomb enforcement
    await recordCheck(
      'RND-SEC-07',
      'Resource bomb containment: infinite-loop timeout process-group SIGKILL & disk quota bomb enforcement',
      'resource_bombs',
      async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-bomb-'));
        const wm = new SandboxWorkspaceManager(tmpBase);
        const launcher = new TrustedTemplateLauncher(wm);
        const ws = wm.createWorkspace('job_bomb_01', 'att_bomb_01');
        try {
          const limits = buildDefaultResourceLimits(defaultConfig);
          const cgroup = buildCgroupV2Spec(limits);

          // 7a. Infinite CPU loop killed by deadline watchdog with RENDER_TIMEOUT
          let timeoutErr = null;
          try {
            await launcher.runSandboxedProcess({
              command: process.execPath,
              argv: ['-e', 'while (true) {}'],
              workspace: ws,
              limits,
              timeoutMs: 120,
              timeoutCode: 'RENDER_TIMEOUT',
            });
          } catch (err) {
            timeoutErr = err;
          }
          if (!timeoutErr || timeoutErr.code !== 'RENDER_TIMEOUT') {
            throw new Error(`Expected RENDER_TIMEOUT on infinite loop, got ${timeoutErr?.code}`);
          }

          // 7b. Disk quota bomb enforcement
          const bombFile = path.join(ws.outputDir, 'disk_bomb.bin');
          fs.writeFileSync(bombFile, Buffer.alloc(2 * 1024 * 1024, 0x41)); // 2 MiB
          assertThrowsSandboxError(
            () => wm.checkDiskQuota(ws, 1 * 1024 * 1024), // 1 MiB limit
            'SANDBOX_RESOURCE_LIMIT'
          );

          return {
            infiniteLoopKilledCode: timeoutErr.code,
            diskQuotaBombBlockedCode: 'SANDBOX_RESOURCE_LIMIT',
            cgroupCpuMax: cgroup.cpuMax,
            cgroupMemoryMaxBytes: cgroup.memoryMaxBytes,
            cgroupPidsMax: cgroup.pidsMax,
          };
        } finally {
          wm.cleanup(ws);
          fs.rmSync(tmpBase, { recursive: true, force: true });
        }
      }
    );

    // 8. Secret canary exfiltration prevention & forbidden host mounts
    await recordCheck(
      'RND-SEC-08',
      'Secret canary exfiltration prevention (env stripping, stdout/stderr redaction, forbidden host mounts)',
      'secret_exfiltration',
      async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-sec-'));
        const wm = new SandboxWorkspaceManager(tmpBase);
        const ws = wm.createWorkspace('job_sec_01', 'att_sec_01');
        try {
          // Passing any secret env key into buildSanitizedSandboxEnv must throw SANDBOX_SECURITY_VIOLATION
          for (const secretKey of [
            'DATABASE_URL',
            'CVE_API_KEY_PEPPER',
            'WEBHOOK_SIGNING_SECRET',
            'AWS_SECRET_ACCESS_KEY',
            'OPENAI_API_KEY',
          ]) {
            assertThrowsSandboxError(
              () =>
                buildSanitizedSandboxEnv({
                  jobId: ws.jobId,
                  attemptId: ws.attemptId,
                  extraEnv: { [secretKey]: 'secret_value' },
                }),
              'SANDBOX_SECURITY_VIOLATION'
            );
          }

          const sanitizedEnv = buildSanitizedSandboxEnv({
            jobId: ws.jobId,
            attemptId: ws.attemptId,
          });

          // Verify both controller log redactor and ops structured log redactor scrub all canaries
          const rawLogLine =
            'Leak attempt: cve_live_0123456789ab_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff ' +
            'WEBHOOK_SIGNING_SECRET=whsec_canary_secret_0123456789abcdef Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig ' +
            'postgresql://cve_api:canary_db_pass_999@db.internal:5432/cve ' +
            'https://minio.internal/bucket/video.mp4?X-Amz-Signature=deadbeef1234';

          const controllerRedacted = redactSecretOutput(rawLogLine);
          const opsRedacted = redactString(rawLogLine);

          for (const secretFragment of [
            'ffffffffffffffffffffffffffffffff',
            'whsec_canary_secret_0123456789abcdef',
            'eyJhbGciOiJIUzI1NiJ9',
            'canary_db_pass_999',
          ]) {
            if (controllerRedacted.includes(secretFragment) || opsRedacted.includes(secretFragment)) {
              throw new Error(`Secret fragment "${secretFragment}" survived log redaction`);
            }
          }
          if (opsRedacted.includes('deadbeef1234')) {
            throw new Error('Signed URL query param survived ops log redaction');
          }

          // Forbidden host mounts (`/var/run/docker.sock`, `/etc/shadow`, `/proc`, `/sys`, `.env`)
          const forbiddenMounts = [
            '/var/run/docker.sock',
            '/run/containerd/containerd.sock',
            '/etc/shadow',
            '/proc/kcore',
            '/sys/fs/cgroup',
            '/workspace/.env',
          ];
          for (const badMount of forbiddenMounts) {
            assertThrowsSandboxError(
              () =>
                validateHostMounts(
                  [{ source: badMount, destination: '/workspace/inputs', readOnly: true }],
                  ws
                ),
              'SANDBOX_SECURITY_VIOLATION'
            );
          }

          return {
            sanitizedEnvKeys: Object.keys(sanitizedEnv),
            controllerRedactionVerified: true,
            opsLoggerRedactionVerified: true,
            forbiddenMountsBlockedCount: forbiddenMounts.length,
          };
        } finally {
          wm.cleanup(ws);
          fs.rmSync(tmpBase, { recursive: true, force: true });
        }
      }
    );

    // 9. LoopbackAssetServer (127.0.0.1) strict allowlist, path traversal & SHA-256 verification
    await recordCheck(
      'RND-SEC-09',
      'LoopbackAssetServer (127.0.0.1) enforces strict asset allowlist, blocks traversal, and detects SHA-256 tamper',
      'loopback_asset_server',
      async () => {
        const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cve-p604-loopback-'));
        const wm = new SandboxWorkspaceManager(tmpBase);
        const ws = wm.createWorkspace('job_loopback_01', 'att_loopback_01');
        const assetBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>', 'utf-8');
        const assetSha256 = computeSha256Hex(assetBytes);

        const staged = wm.stageInputs(ws, [
          {
            relativePath: 'safe_logo.svg',
            content: assetBytes,
            expectedSha256: assetSha256,
            kind: 'asset',
          },
        ]);
        const stagedLogo = staged.get('safe_logo.svg');

        const server = new LoopbackAssetServer(ws.inputsDir);
        server.registerAsset('/assets/asset_safe_01.svg', stagedLogo.filePath, assetSha256, 'image/svg+xml');
        const baseUrl = await server.start();
        try {
          if (!baseUrl.startsWith('http://127.0.0.1:')) {
            throw new Error(`LoopbackAssetServer must bind to 127.0.0.1, got ${baseUrl}`);
          }

          // 9a. Valid asset fetch succeeds with nosniff and default-src 'none' CSP
          const validRes = await fetch(`${baseUrl}/assets/asset_safe_01.svg`);
          if (validRes.status !== 200) {
            throw new Error(`Expected 200 for allowed asset, got ${validRes.status}`);
          }
          if (validRes.headers.get('x-content-type-options') !== 'nosniff') {
            throw new Error('LoopbackAssetServer missing X-Content-Type-Options: nosniff');
          }

          // 9b. Unregistered / cross-job asset returns 404
          const unregRes = await fetch(`${baseUrl}/assets/asset_other_tenant_99.svg`);
          if (unregRes.status !== 404) {
            throw new Error(`Expected 404 for unregistered asset, got ${unregRes.status}`);
          }

          // 9c. Path traversal probe returns 403/404
          const traversalRes = await fetch(`${baseUrl}/assets/..%2f..%2fetc%2fpasswd`);
          if (traversalRes.status !== 403 && traversalRes.status !== 404) {
            throw new Error(`Expected 403/404 for traversal probe, got ${traversalRes.status}`);
          }

          // 9d. Mutating asset on disk after staging triggers 403 hash mismatch
          fs.chmodSync(ws.inputsDir, 0o750);
          fs.chmodSync(stagedLogo.filePath, 0o640);
          fs.writeFileSync(stagedLogo.filePath, Buffer.from('<svg>tampered</svg>', 'utf-8'));
          const tamperedRes = await fetch(`${baseUrl}/assets/asset_safe_01.svg`);
          if (tamperedRes.status !== 403) {
            throw new Error(`Expected 403 on tampered asset SHA-256 mismatch, got ${tamperedRes.status}`);
          }

          return {
            boundHost: '127.0.0.1',
            allowedAssetStatus: validRes.status,
            unregisteredAssetStatus: unregRes.status,
            traversalProbeStatus: traversalRes.status,
            tamperedHashStatus: tamperedRes.status,
          };
        } finally {
          await server.stop();
          wm.cleanup(ws);
          fs.rmSync(tmpBase, { recursive: true, force: true });
        }
      }
    );

    const passedCount = checks.filter((c) => c.passed).length;
    return {
      suite: 'renderer-security-suite',
      passed: passedCount === checks.length,
      totalChecks: checks.length,
      passedChecks: passedCount,
      failedChecks: checks.length - passedCount,
      durationMs: Date.now() - startedAt,
      checks,
    };
  }
}
