import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyVideoContainer,
  triggerBrowserDownload,
  evaluateQualityParity,
  computePsnrDb,
  verifyAlphaBlendingInvariant,
  buildDeterministicMp4Container,
} from '../dist/index.js';

describe('P8-02: Download Delivery & Quality Parity Suite', () => {
  it('4.1 Container Integrity: validates fMP4 box headers and major brands', () => {
    const mp4Bytes = buildDeterministicMp4Container({
      width: 1280,
      height: 720,
      durationFrames: 60,
      fps: { num: 30, den: 1 },
    });

    const res = verifyVideoContainer(mp4Bytes);
    assert.equal(res.format, 'mp4');
    assert.equal(res.isValid, true);
    assert.equal(res.brand, 'isom');
    assert.ok(res.sizeBytes > 32);
  });

  it('4.2 Container Integrity: validates WebM EBML signature and rejects corrupted headers', () => {
    // Valid WebM header
    const webmHeader = new Uint8Array([
      0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81,
      0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81,
    ]);
    const webmRes = verifyVideoContainer(webmHeader);
    assert.equal(webmRes.format, 'webm');
    assert.equal(webmRes.isValid, true);

    // Corrupted / unknown buffer
    const badBytes = new Uint8Array([0x00, 0x00, 0x00, 0x10, 0x62, 0x61, 0x64, 0x20]); // 8 bytes
    const badRes = verifyVideoContainer(badBytes);
    assert.equal(badRes.isValid, false);
    assert.ok(badRes.error?.includes('too small'));
  });

  it('4.3 Browser Download: invokes synthetic click and cleans up object URL', () => {
    const mp4Bytes = buildDeterministicMp4Container({
      width: 1280,
      height: 720,
      durationFrames: 30,
      fps: { num: 30, den: 1 },
    });

    let objectUrlCreated = '';
    let objectUrlRevoked = '';
    let anchorClicked = false;
    let downloadedFilename = '';

    const mockDom = {
      document: {
        createElement: (tag) => {
          assert.equal(tag, 'a');
          return {
            href: '',
            download: '',
            style: { display: '' },
            click: () => {
              anchorClicked = true;
            },
          };
        },
        body: {
          appendChild: (el) => {
            downloadedFilename = el.download;
          },
          removeChild: () => {},
        },
      },
      URL: {
        createObjectURL: () => {
          objectUrlCreated = 'blob:http://localhost/test-uuid-blob';
          return objectUrlCreated;
        },
        revokeObjectURL: (url) => {
          objectUrlRevoked = url;
        },
      },
    };

    const downloadRes = triggerBrowserDownload(mp4Bytes, 'summer_promo.mp4', {
      domContext: mockDom,
    });

    assert.equal(downloadRes.success, true);
    assert.equal(downloadRes.filename, 'summer_promo.mp4');
    assert.equal(anchorClicked, true);
    assert.equal(downloadedFilename, 'summer_promo.mp4');
    assert.equal(objectUrlCreated, objectUrlRevoked); // Revocation confirmed
  });

  it('4.4 Quality Parity: verifies CFR timestamps, duration, and visual parity against server reference', () => {
    const fps = { num: 30, den: 1 };
    const frameDurationUs = (1 / 30) * 1_000_000; // 33333.33 us

    const exportedFrames = [];
    const referenceFrames = [];

    // Synthesize 30 test frames (1 second @ 30fps)
    for (let i = 0; i < 30; i++) {
      const pts = Math.round(i * frameDurationUs);
      // RGBA 4 sample pixels: solid color test
      const samplePixels = [31, 41, 55, 255]; // #1f2937

      exportedFrames.push({
        frameIndex: i,
        ptsMicroseconds: pts,
        width: 1280,
        height: 720,
        samplePixels,
      });

      referenceFrames.push({
        frameIndex: i,
        ptsMicroseconds: pts,
        width: 1280,
        height: 720,
        samplePixels, // identical reference
      });
    }

    const report = evaluateQualityParity({
      compositionId: 'cmp_promo_parity',
      expectedFps: fps,
      expectedDurationFrames: 30,
      expectedWidth: 1280,
      expectedHeight: 720,
      exportedFrames,
      referenceFrames,
    });

    assert.equal(report.verdict, 'PASS');
    assert.equal(report.durationParity, true);
    assert.equal(report.dimensionParity, true);
    assert.equal(report.timingParity, true);
    assert.equal(report.visualParity, true);
    assert.equal(report.averagePsnrDb, 100); // Identical pixels = 100 dB
    assert.equal(report.frameChecks.length, 30);
  });

  it('4.5 Quality Parity: detects CFR timestamp drift if browser frame timing is non-monotonic', () => {
    const fps = { num: 30, den: 1 };
    const exportedFramesWithDrift = [
      { frameIndex: 0, ptsMicroseconds: 0, width: 1280, height: 720 },
      { frameIndex: 1, ptsMicroseconds: 33333, width: 1280, height: 720 },
      { frameIndex: 2, ptsMicroseconds: 90000, width: 1280, height: 720 }, // Jitter drift!
    ];

    const report = evaluateQualityParity({
      compositionId: 'cmp_drift_test',
      expectedFps: fps,
      expectedDurationFrames: 3,
      expectedWidth: 1280,
      expectedHeight: 720,
      exportedFrames: exportedFramesWithDrift,
    });

    assert.equal(report.timingParity, false);
    assert.equal(report.verdict, 'FAIL');
    assert.ok(report.frameChecks[2]?.notes?.includes('PTS drift'));
  });

  it('4.6 Visual Fidelity: computes PSNR between reference and lossy frames correctly', () => {
    const orig = [100, 100, 100, 255];
    const identical = [100, 100, 100, 255];
    const slightDiff = [101, 99, 100, 255]; // slight compression delta

    assert.equal(computePsnrDb(orig, identical), 100);
    const psnrSlight = computePsnrDb(orig, slightDiff);
    assert.ok(psnrSlight > 40); // > 40 dB is high fidelity
  });

  it('4.7 Alpha Blending Invariant: confirms layer_alpha * scene_alpha equation conformance', () => {
    assert.equal(verifyAlphaBlendingInvariant(1.0, 1.0, 1.0), true);
    assert.equal(verifyAlphaBlendingInvariant(0.5, 0.8, 0.4), true);
    assert.equal(verifyAlphaBlendingInvariant(0.25, 0.5, 0.125), true);
    assert.equal(verifyAlphaBlendingInvariant(0.5, 0.5, 0.9), false); // Incorrect blending
  });
});
