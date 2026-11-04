import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition } from '@creativanta/contracts';
import { generateBetaSamples } from '../dist/beta-samples.js';

test('Beta Samples: Generates Exactly 3 Production-Grade Localized Beta Samples', () => {
  const pack = generateBetaSamples();

  assert.equal(pack.samples.length, 3);
  assert.equal(pack.overallRightsAudit.valid, true);
  assert.equal(pack.overallRightsAudit.violationsCount, 0);

  // Check sample IDs and families
  const promo = pack.samples.find((s) => s.family === 'retail_promo');
  const explainer = pack.samples.find((s) => s.family === 'narrated_explainer');
  const story = pack.samples.find((s) => s.family === 'captioned_story');

  assert.ok(promo, 'retail_promo beta sample must be present');
  assert.ok(explainer, 'narrated_explainer beta sample must be present');
  assert.ok(story, 'captioned_story beta sample must be present');

  // Verify dimensions, durations, and aspect ratios
  assert.equal(promo.aspectRatio, '9:16');
  assert.equal(promo.durationSeconds, 15);
  assert.equal(promo.durationFrames, 450);
  assert.equal(promo.locale, 'vi-VN');

  assert.equal(explainer.aspectRatio, '16:9');
  assert.equal(explainer.durationSeconds, 30);
  assert.equal(explainer.durationFrames, 900);
  assert.equal(explainer.locale, 'vi-VN');

  assert.equal(story.aspectRatio, '9:16');
  assert.equal(story.durationSeconds, 45);
  assert.equal(story.durationFrames, 1350);
  assert.equal(story.locale, 'vi-VN');
});

test('Beta Samples: 100% Commercial Rights Clearance & Zero Anti-Contamination Violations', () => {
  const pack = generateBetaSamples();

  for (const sample of pack.samples) {
    assert.equal(sample.rightsAudit.valid, true, `Sample ${sample.id} rights audit must be valid`);
    assert.equal(sample.rightsAudit.violations.length, 0);
    assert.equal(sample.rightsAudit.antiContaminationStatus, 'PASS');
    assert.equal(sample.rightsAudit.blockedSourcesDetected.length, 0);
    assert.ok(sample.rightsAudit.assetsChecked > 0);
  }
});

test('Beta Samples: Subtitle Sidecars (SRT & WebVTT) Generated Correctly', () => {
  const pack = generateBetaSamples();

  for (const sample of pack.samples) {
    assert.ok(sample.sidecars, `Sample ${sample.id} must have sidecars`);
    assert.ok(sample.sidecars.cuesCount > 0);
    assert.ok(sample.sidecars.srt.length > 50);
    assert.ok(sample.sidecars.vtt.length > 50);

    // Verify SRT format
    assert.ok(sample.sidecars.srt.includes('00:00:'));
    assert.ok(sample.sidecars.srt.includes('-->'));

    // Verify WebVTT format
    assert.ok(sample.sidecars.vtt.startsWith('WEBVTT'));
    assert.ok(sample.sidecars.vtt.includes('NOTE Language: vi-VN'));
  }
});

test('Beta Samples: Burnt-In Subtitles Comply with Safe Margins (48px) and Max Lines (2)', () => {
  const pack = generateBetaSamples();

  for (const sample of pack.samples) {
    assert.ok(sample.subtitleLayoutResults, `Sample ${sample.id} must have layout results`);
    for (const layout of sample.subtitleLayoutResults) {
      assert.equal(layout.fitsMaxLines, true, `Cue ${layout.cueId} in ${sample.id} must fit within max lines`);
      assert.equal(layout.fitsSafeMargin, true, `Cue ${layout.cueId} in ${sample.id} must fit safe margins`);
      assert.equal(layout.overflowDetected, false, `Cue ${layout.cueId} in ${sample.id} must not overflow`);
      assert.ok(layout.linesCount <= 2, `Cue ${layout.cueId} in ${sample.id} must have <= 2 lines`);
    }
  }
});

test('Beta Samples: Compiles Cleanly to Canonical Compiler Manifests', () => {
  const pack = generateBetaSamples();

  for (const sample of pack.samples) {
    const manifest = compileComposition(sample.spec);
    assert.ok(manifest, `Sample ${sample.id} must compile cleanly`);
    assert.equal(manifest.manifest_version, '1.0');
    assert.equal(manifest.duration_frames, sample.durationFrames);
    assert.equal(manifest.subtitles.length > 0, true);
    assert.ok(manifest.canvas.width > 0);
    assert.ok(manifest.canvas.height > 0);
  }
});
