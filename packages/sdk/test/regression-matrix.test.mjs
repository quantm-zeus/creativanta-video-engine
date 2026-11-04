import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runRegressionMatrix,
  runLocaleRegressionSuite,
  runFontRegressionSuite,
  runAudioRegressionSuite,
  CANONICAL_VIETNAMESE_TEST_PHRASE,
  ALL_VIETNAMESE_DIACRITICS,
  PINNED_FONTS,
  CANONICAL_SAMPLE_RATE,
  MAX_TRUE_PEAK_DBTP,
} from '../dist/regression/index.js';

test('Regression Matrix: Full Suite Execution Passes 100% Invariants', () => {
  const report = runRegressionMatrix();

  assert.equal(report.passed, true);
  assert.equal(report.failedTests, 0);
  assert.ok(report.totalTests >= 17);
  assert.equal(report.passedTests, report.totalTests);
  assert.ok(report.durationMs >= 0);

  // Check categories exist and have zero failures
  const expectedCategories = ['locale', 'font', 'layout', 'audio', 'sync'];
  for (const cat of expectedCategories) {
    const summary = report.categories[cat];
    assert.ok(summary, `Category ${cat} must exist in report`);
    assert.ok(summary.total > 0, `Category ${cat} must have tests`);
    assert.equal(summary.failed, 0, `Category ${cat} must have 0 failures`);
    assert.equal(summary.passed, summary.total);
  }
});

test('Regression Matrix: Locale Suite Covers All Vietnamese Diacritics & Tones', () => {
  const results = runLocaleRegressionSuite();
  assert.ok(results.length >= 7);

  for (const res of results) {
    assert.equal(res.passed, true, `Test ${res.id} should pass: ${res.error || ''}`);
  }

  // Check specific test findings
  const diacriticsTest = results.find((r) => r.id === 'reg_locale_01_diacritics_coverage');
  assert.ok(diacriticsTest);
  assert.equal(diacriticsTest.details.totalCharacters, 148);

  const nfdTest = results.find((r) => r.id === 'reg_locale_02_nfd_to_nfc_normalization');
  assert.ok(nfdTest);
  assert.equal(nfdTest.details.recomposedMatchesOriginal, true);

  const phraseTest = results.find((r) => r.id === 'reg_locale_03_canonical_phrase');
  assert.ok(phraseTest);
  assert.equal(phraseTest.details.phrase, CANONICAL_VIETNAMESE_TEST_PHRASE);

  const currencyTest = results.find((r) => r.id === 'reg_locale_04_currency_formatting');
  assert.ok(currencyTest);
  assert.equal(currencyTest.details.unicodeCodepoint, 'U+20AB');
});

test('Regression Matrix: Font Suite Validates Pinned Fonts & Fallback Disabled Guard', () => {
  const results = runFontRegressionSuite();
  assert.ok(results.length >= 4);

  for (const res of results) {
    assert.equal(res.passed, true, `Test ${res.id} should pass: ${res.error || ''}`);
  }

  const pinnedRegistryTest = results.find((r) => r.id === 'reg_font_01_pinned_registry_integrity');
  assert.ok(pinnedRegistryTest);
  assert.equal(pinnedRegistryTest.details.totalFontsPinned, PINNED_FONTS.length);

  const fallbackTest = results.find((r) => r.id === 'reg_font_02_fallback_disabled_gate');
  assert.ok(fallbackTest);

  const safeMarginTest = results.find((r) => r.id === 'reg_font_03_safe_margin_bounds');
  assert.ok(safeMarginTest);
  assert.equal(safeMarginTest.details.vertical9x16UsableWidth, 624);
  assert.equal(safeMarginTest.details.horizontal16x9UsableWidth, 1184);
});

test('Regression Matrix: Audio Suite Validates 48kHz Stereo & Rational Sync Anchors', () => {
  const results = runAudioRegressionSuite();
  assert.ok(results.length >= 6);

  for (const res of results) {
    assert.equal(res.passed, true, `Test ${res.id} should pass: ${res.error || ''}`);
  }

  const formatTest = results.find((r) => r.id === 'reg_audio_01_canonical_format');
  assert.ok(formatTest);
  assert.equal(formatTest.details.sampleRate, CANONICAL_SAMPLE_RATE);
  assert.equal(formatTest.details.channels, 2);

  const mappingTest = results.find((r) => r.id === 'reg_audio_02_frame_to_sample_mapping');
  assert.ok(mappingTest);
  assert.equal(mappingTest.details.samplesPerFrame30fps, 1600);

  const syncTest = results.find((r) => r.id === 'reg_audio_03_sync_anchor_tolerance');
  assert.ok(syncTest);
  assert.equal(syncTest.details.toleranceLimitFrames, 1);

  const peakTest = results.find((r) => r.id === 'reg_audio_04_peak_headroom_compliance');
  assert.ok(peakTest);
  assert.equal(peakTest.details.maxTruePeakDbtpLimit, MAX_TRUE_PEAK_DBTP);

  const duckingTest = results.find((r) => r.id === 'reg_audio_05_ducking_envelope_integrity');
  assert.ok(duckingTest);
  assert.equal(duckingTest.details.strictlyMonotonicFrames, true);

  const silenceTest = results.find((r) => r.id === 'reg_audio_06_silence_preservation');
  assert.ok(silenceTest);
  assert.equal(silenceTest.details.absoluteSilencePreserved, true);
});
