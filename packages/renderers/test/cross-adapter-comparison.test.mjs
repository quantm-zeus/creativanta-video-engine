import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareAdaptersOnManifest } from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-minimal.json'), 'utf-8')
);
const poc01Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-poc01.json'), 'utf-8')
);

test('Cross-Adapter Comparison: Minimal Fixture Parity & Evaluation', async () => {
  const comparison = await compareAdaptersOnManifest(minimalManifest, [0, 75, 149]);

  assert.equal(comparison.manifestId, 'cmp_minimal');
  assert.equal(comparison.durationFrames, 150);

  // Both adapters passed random seek verification
  assert.equal(comparison.chromiumBaseline.randomSeekPassed, true);
  assert.equal(comparison.hyperframesSpike.randomSeekPassed, true);

  // Parity across evaluated frames
  assert.equal(comparison.parityPercentage, 100);
  assert.deepEqual(comparison.stateParityFrames, [0, 75, 149]);

  // Compliance differentiation
  assert.equal(comparison.chromiumBaseline.zeroEgressCompliant, true);
  assert.equal(comparison.chromiumBaseline.commercialLicenseRisk, false);
  assert.equal(comparison.chromiumBaseline.audioCfrSupported, true);

  assert.equal(comparison.hyperframesSpike.zeroEgressCompliant, false);
  assert.equal(comparison.hyperframesSpike.commercialLicenseRisk, true);
  assert.equal(comparison.hyperframesSpike.audioCfrSupported, false);

  // Engine decision
  assert.equal(comparison.recommendation, 'chromium-frame-v1');
});

test('Cross-Adapter Comparison: POC-01 Promo Fixture Multi-Scene Parity', async () => {
  const sampleFrames = [0, 100, 200, 300, 449];
  const comparison = await compareAdaptersOnManifest(poc01Manifest, sampleFrames);

  assert.equal(comparison.manifestId, 'cmp_poc01_promo');
  assert.equal(comparison.durationFrames, 450);

  // Verify sample checksums exist for all tested frames on both engines
  for (const f of sampleFrames) {
    assert.ok(comparison.chromiumBaseline.sampleChecksums[f]);
    assert.ok(comparison.hyperframesSpike.sampleChecksums[f]);
    assert.equal(
      comparison.chromiumBaseline.sampleChecksums[f],
      comparison.hyperframesSpike.sampleChecksums[f],
      `Checksum divergence at frame ${f}`
    );
  }

  assert.equal(comparison.parityPercentage, 100);
  assert.equal(comparison.recommendation, 'chromium-frame-v1');
});
