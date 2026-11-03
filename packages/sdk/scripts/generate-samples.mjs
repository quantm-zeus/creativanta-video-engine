import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  OfflineTtsAdapter,
  VIETNAMESE_QUALITY_FIXTURES,
  evaluateVietnameseQualitySample,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const samplesDir = resolve(repoRoot, 'evidence/P5-02/samples');

async function main() {
  const adapter = new OfflineTtsAdapter();
  const summary = [];

  const fixtures = [
    { key: 'promo', fixture: VIETNAMESE_QUALITY_FIXTURES.promo, voiceId: 'vi-VN-HoaiMy-Neural', filename: 'vi-vn-promo.wav' },
    { key: 'explainer', fixture: VIETNAMESE_QUALITY_FIXTURES.explainer, voiceId: 'vi-VN-NamMinh-Neural', filename: 'vi-vn-explainer.wav' },
    { key: 'tone_stress', fixture: VIETNAMESE_QUALITY_FIXTURES.toneStress, voiceId: 'vi-VN-HoaiMy-Neural', filename: 'vi-vn-tone-stress.wav' },
  ];

  for (const item of fixtures) {
    const report = await evaluateVietnameseQualitySample(adapter, item.fixture, item.voiceId);
    const synth = await adapter.synthesize({
      text: item.fixture.text,
      locale: 'vi-VN',
      voiceId: item.voiceId,
      speechRate: 1.0,
      targetFps: 30,
    });

    const wavPath = resolve(samplesDir, item.filename);
    writeFileSync(wavPath, synth.audioBuffer);

    const sha256 = createHash('sha256').update(synth.audioBuffer).digest('hex');

    summary.push({
      fixture_id: report.fixtureId,
      category: report.category,
      voice_id: item.voiceId,
      filename: item.filename,
      sha256,
      bytes: synth.audioBuffer.length,
      sample_rate: report.sampleRate,
      channels: report.channels,
      bit_depth: report.bitDepth,
      duration_seconds: report.durationSeconds,
      duration_frames_30fps: report.durationFrames30fps,
      peak_dbfs: report.measuredPeakDbfs,
      rms_dbfs: report.measuredRmsDbfs,
      diacritics_count: report.diacriticsFound.length,
      zero_clipping: report.zeroClipping,
      compliant_peak: report.compliantPeakHeadroom,
      passed: report.passed,
    });
  }

  const summaryPath = resolve(repoRoot, 'evidence/P5-02/samples/samples-manifest.json');
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
