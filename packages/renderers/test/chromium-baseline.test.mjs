import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChromiumBaselineRenderer } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-minimal.json'), 'utf-8')
);
const poc01Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-poc01.json'), 'utf-8')
);

test('Chromium Baseline: Frame Seek & State Evaluation', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(minimalManifest);

  // Seek start, middle, and end frames
  const frame0 = await session.seek(0);
  assert.equal(frame0.frameIndex, 0);
  assert.equal(frame0.sceneId, 'intro');
  assert.equal(frame0.sceneRevision, 1);
  assert.equal(frame0.sceneAlpha, 1);
  assert.equal(frame0.transitionActive, false);
  assert.equal(frame0.activeLayerCount, 1);
  assert.equal(frame0.evaluatedLayers[0].layerId, 'headline');

  const frame75 = await session.seek(75);
  assert.equal(frame75.frameIndex, 75);
  assert.equal(frame75.timestampSeconds, 2.5);
  assert.equal(frame75.audioSampleOffset, 75 * (48000 / 30));

  const frameLast = await session.seek(minimalManifest.duration_frames - 1);
  assert.equal(frameLast.frameIndex, 149);

  await session.dispose();
});

test('Chromium Baseline: Random Seek Invariance & Zero State Leaks', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc01Manifest);

  // 1. Run automated random seek verification
  const verification = await session.verifyRandomSeek([0, 30, 90, 200, 449]);
  assert.equal(verification.passed, true);
  assert.equal(verification.reproducible, true);
  assert.equal(verification.checksumMatches, true);
  assert.equal(verification.mismatches.length, 0);

  // 2. Perform explicit back-and-forth non-linear seeking
  const frameOrder = [0, 449, 150, 449, 0, 150, 225, 0];
  const checksumsByFrame = new Map();

  for (const f of frameOrder) {
    const res = await session.seek(f);
    if (!checksumsByFrame.has(f)) {
      checksumsByFrame.set(f, res.checksumSha256);
    } else {
      assert.equal(
        res.checksumSha256,
        checksumsByFrame.get(f),
        `Random seek to frame ${f} produced divergent checksum!`
      );
    }
  }

  await session.dispose();
});

test('Chromium Baseline: Deterministic Frame Capture (PNG & RGBA)', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(minimalManifest);

  // 1. Lossless PNG capture
  const pngCapture = await session.captureFrame(0, 'png');
  assert.equal(pngCapture.format, 'png');
  assert.equal(pngCapture.width, 720);
  assert.equal(pngCapture.height, 1280);
  assert.ok(pngCapture.buffer.length > 100);

  // Validate standard PNG binary signature: \x89PNG\r\n\x1a\n
  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(pngCapture.buffer.subarray(0, 8), pngSig);

  // Validate PNG IHDR chunk
  assert.equal(pngCapture.buffer.toString('ascii', 12, 16), 'IHDR');
  assert.equal(pngCapture.buffer.readUInt32BE(16), 720); // Width
  assert.equal(pngCapture.buffer.readUInt32BE(20), 1280); // Height

  // 2. Raw RGBA capture
  const rgbaCapture = await session.captureFrame(0, 'raw_rgba');
  assert.equal(rgbaCapture.format, 'raw_rgba');
  assert.equal(rgbaCapture.byteLength, 720 * 1280 * 4);
  assert.equal(rgbaCapture.buffer.length, 720 * 1280 * 4);

  // Checksum reproducibility
  const pngCapture2 = await session.captureFrame(0, 'png');
  assert.equal(pngCapture.checksumSha256, pngCapture2.checksumSha256);

  await session.dispose();
});

test('Chromium Baseline: Vietnamese Typography & Strict Zero-Egress DOM', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(minimalManifest);

  const res = await session.seek(0);
  assert.ok(res.domSnapshot, 'DOM snapshot must be present');
  const dom = res.domSnapshot;

  // Strict CSP
  assert.ok(dom.includes('connect-src \'none\''), 'CSP must enforce connect-src none');
  assert.ok(dom.includes('default-src \'none\''), 'CSP must enforce default-src none');

  // Safe margins
  assert.ok(dom.includes('.cve-safe-zone'), 'DOM must define safe zone margins');
  assert.ok(dom.includes('left: 48px'), 'Safe zone must enforce 48px margins');

  // Vietnamese typography support
  assert.ok(dom.includes('font-family: \'Inter\', \'Noto Sans\''), 'Typography must include Inter and Noto Sans');
  assert.ok(dom.includes('Sáng tạo mỗi ngày'), 'Vietnamese text must be rendered accurately');

  await session.dispose();
});

test('Chromium Baseline: Sandbox Flags & Prohibited Args Rejection', async () => {
  const renderer = new ChromiumBaselineRenderer();

  // Standard safe session
  const safeSession = await renderer.prepare(minimalManifest, {
    extraChromiumFlags: ['--window-size=720,1280'],
  });
  const flags = safeSession.getChromiumSandboxArgs();
  assert.ok(flags.includes('--headless=new'));
  assert.ok(flags.includes('--disable-gpu'));
  assert.ok(flags.includes('--remote-debugging-port=0'));
  assert.ok(flags.includes('--window-size=720,1280'));
  assert.ok(!flags.includes('--no-sandbox'));
  await safeSession.dispose();

  // Prohibited --no-sandbox flag must be rejected
  await assert.rejects(
    async () =>
      renderer.prepare(minimalManifest, {
        extraChromiumFlags: ['--no-sandbox'],
      }),
    /Security violation: "--no-sandbox" is strictly prohibited/
  );

  // Prohibited --disable-setuid-sandbox must be rejected
  await assert.rejects(
    async () =>
      renderer.prepare(minimalManifest, {
        extraChromiumFlags: ['--disable-setuid-sandbox'],
      }),
    /Security violation: "--disable-setuid-sandbox" is strictly prohibited/
  );
});

test('Chromium Baseline: FFmpeg Command Assembly & Protocol Safety', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc01Manifest);

  const ffmpegCmd = session.generateFfmpegCommand({
    outputPath: '/tmp/output.mp4',
    crf: 22,
    preset: 'medium',
  });

  // Security whitelist
  assert.ok(ffmpegCmd.argv.includes('-nostdin'));
  assert.ok(ffmpegCmd.argv.includes('-protocol_whitelist'));
  assert.ok(ffmpegCmd.argv.includes('file,pipe'));

  // Codecs and format
  assert.ok(ffmpegCmd.argv.includes('libx264'));
  assert.ok(ffmpegCmd.argv.includes('yuv420p'));
  assert.ok(ffmpegCmd.argv.includes('aac'));
  assert.ok(ffmpegCmd.argv.includes('+faststart'));
  assert.ok(ffmpegCmd.argv.includes('/tmp/output.mp4'));

  // Protocol rejection
  assert.throws(
    () =>
      session.generateFfmpegCommand({
        outputPath: 'http://169.254.169.254/evil.mp4',
      }),
    /Disallowed path or URL detected/
  );

  assert.throws(
    () =>
      session.generateFfmpegCommand({
        outputPath: '/tmp/test.mp4',
        inputPatternOrPipe: 'concat:file1|file2',
      }),
    /Disallowed path or URL detected/
  );

  await session.dispose();
});
