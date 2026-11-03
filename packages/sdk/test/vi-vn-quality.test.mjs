import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OfflineTtsAdapter,
  VIETNAMESE_QUALITY_FIXTURES,
  evaluateVietnameseQualitySample,
  probeWavCharacteristics,
} from '../dist/index.js';

test('vi-VN Quality: eCommerce Promo Sample Evaluation', async () => {
  const adapter = new OfflineTtsAdapter();
  const report = await evaluateVietnameseQualitySample(
    adapter,
    VIETNAMESE_QUALITY_FIXTURES.promo,
    'vi-VN-HoaiMy-Neural'
  );

  assert.equal(report.fixtureId, 'sample_vi_promo_01');
  assert.equal(report.passed, true, `Quality evaluation failed with warnings: ${report.warnings.join(', ')}`);
  assert.equal(report.sampleRate, 48000);
  assert.equal(report.channels, 2);
  assert.equal(report.bitDepth, 16);
  assert.equal(report.zeroClipping, true);
  assert.equal(report.compliantPeakHeadroom, true);
  assert.ok(report.measuredPeakDbfs <= -0.9);
  assert.ok(report.diacriticsFound.length >= 5);
  assert.ok(report.durationSeconds >= 5.0 && report.durationSeconds <= 8.5);
  assert.equal(report.durationFrames30fps, Math.ceil(report.durationSeconds * 30));
});

test('vi-VN Quality: Technical Explainer Sample Evaluation', async () => {
  const adapter = new OfflineTtsAdapter();
  const report = await evaluateVietnameseQualitySample(
    adapter,
    VIETNAMESE_QUALITY_FIXTURES.explainer,
    'vi-VN-NamMinh-Neural'
  );

  assert.equal(report.fixtureId, 'sample_vi_explainer_01');
  assert.equal(report.passed, true);
  assert.equal(report.sampleRate, 48000);
  assert.equal(report.channels, 2);
  assert.equal(report.bitDepth, 16);
  assert.equal(report.zeroClipping, true);
  assert.equal(report.compliantPeakHeadroom, true);
  assert.ok(report.durationSeconds >= 6.5 && report.durationSeconds <= 10.5);
});

test('vi-VN Quality: Phonetic Diacritic & Tone Stress Sample Evaluation', async () => {
  const adapter = new OfflineTtsAdapter();
  const report = await evaluateVietnameseQualitySample(
    adapter,
    VIETNAMESE_QUALITY_FIXTURES.toneStress,
    'vi-VN-HoaiMy-Neural'
  );

  assert.equal(report.fixtureId, 'sample_vi_tone_stress_01');
  assert.equal(report.passed, true);
  assert.equal(report.currencySymbolFound, true, 'Expected Vietnamese currency symbol (₫) detected');
  assert.ok(report.tonesFound.huyen > 0, 'Huyền tone must be detected');
  assert.ok(report.tonesFound.sac > 0, 'Sắc tone must be detected');
  assert.ok(report.tonesFound.hoi > 0, 'Hỏi tone must be detected');
  assert.ok(report.tonesFound.nga > 0, 'Ngã tone must be detected');
  assert.ok(report.tonesFound.nang > 0, 'Nặng tone must be detected');
});

test('vi-VN Quality: Acoustic Probe Detects Corrupted Audio', () => {
  // 1. Buffer too short
  assert.throws(
    () => {
      probeWavCharacteristics(Buffer.alloc(20));
    },
    /too small/
  );

  // 2. Corrupted signature
  const badSig = Buffer.alloc(50);
  badSig.write('NOPE', 0);
  assert.throws(
    () => {
      probeWavCharacteristics(badSig);
    },
    /Not a valid RIFF\/WAVE/
  );
});
