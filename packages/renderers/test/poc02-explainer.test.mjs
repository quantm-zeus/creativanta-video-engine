import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileComposition,
  compareCompositionRevisions,
  evaluateFrame,
} from '@creativanta/contracts';

import {
  executeRenderPipeline,
  validateVietnameseTypography,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const tplPoc02 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc02-template.json'), 'utf-8')
);
const compPoc02V1 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc02-composition-v1.json'), 'utf-8')
);
const compPoc02V2 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc02-composition-v2.json'), 'utf-8')
);

test('POC-02: Versioned Editable Template & Revision Concurrency', () => {
  // 1. Template validation
  assert.equal(tplPoc02.id, 'tpl_poc02_explainer');
  assert.equal(tplPoc02.revision, 1);
  assert.equal(tplPoc02.variables_schema.type, 'object');
  assert.ok(tplPoc02.variables_schema.required.includes('problem_text'));
  assert.ok(tplPoc02.variables_schema.required.includes('solution_title'));
  assert.ok(tplPoc02.variables_schema.required.includes('summary_headline'));

  // 2. Compilation of Revision 1 (900 frames @ 30fps = 30s)
  const manifestV1 = compileComposition(compPoc02V1, { profile: 'mp4-720p-v1' });
  assert.equal(manifestV1.duration_frames, 900);
  assert.equal(manifestV1.duration_seconds, 30);
  assert.equal(manifestV1.canvas.width, 1280);
  assert.equal(manifestV1.canvas.height, 720);
  assert.equal(manifestV1.scenes.length, 4);

  // 3. Compilation of Revision 2 (Edited Variables)
  const manifestV2 = compileComposition(compPoc02V2, { profile: 'mp4-720p-v1' });
  assert.equal(manifestV2.duration_frames, 900);
  assert.equal(manifestV2.scenes.length, 4);

  // 4. Compare revisions concurrency and diffs
  const diff = compareCompositionRevisions(compPoc02V1, compPoc02V2, 1, 2);
  assert.equal(diff.valid, true);
  assert.equal(diff.is_render_affecting, true);
  assert.equal(diff.errors.length, 0);

  const modifiedScenes = diff.scene_diffs.filter((s) => s.status === 'modified');
  assert.ok(modifiedScenes.length >= 3);
  for (const s of modifiedScenes) {
    assert.equal(s.base_revision, 1);
    assert.equal(s.new_revision, 2);
  }
});

test('POC-02: Fade to Background Transition & Scene Alpha Decay', () => {
  const manifestV1 = compileComposition(compPoc02V1, { profile: 'mp4-720p-v1' });

  // Scene 4 (summary) runs from 690 to 900, with fade_to_background of duration 30 (frames 870..899)
  const sceneSummary = manifestV1.scenes[3];
  assert.equal(sceneSummary.id, 'scene_summary');
  assert.equal(sceneSummary.transition_out.type, 'fade_to_background');
  assert.equal(sceneSummary.transition_out.duration_frames, 30);

  // Frame 869: before fade start -> scene_alpha = 1.0, transitionActive = false
  const frameBefore = evaluateFrame(manifestV1, 869);
  assert.equal(frameBefore.scene.scene_alpha, 1.0);
  assert.equal(frameBefore.scene.transition_active, false);

  // Frame 870: first fade frame -> scene_alpha = 1.0, transitionActive = true
  const frameFadeStart = evaluateFrame(manifestV1, 870);
  assert.equal(frameFadeStart.scene.scene_alpha, 1.0);
  assert.equal(frameFadeStart.scene.transition_active, true);

  // Frame 885: midpoint of fade -> scene_alpha ~ 0.48
  const frameFadeMid = evaluateFrame(manifestV1, 885);
  assert.ok(frameFadeMid.scene.scene_alpha > 0.4 && frameFadeMid.scene.scene_alpha < 0.6);
  assert.equal(frameFadeMid.scene.transition_active, true);

  // Frame 899: final frame -> scene_alpha = 0.0 (completely faded to background)
  const frameFadeEnd = evaluateFrame(manifestV1, 899);
  assert.equal(frameFadeEnd.scene.scene_alpha, 0.0);
  assert.equal(frameFadeEnd.scene.transition_active, true);
});

test('POC-02: Vietnamese Subtitle Cues & Typography Validation', () => {
  const manifestV1 = compileComposition(compPoc02V1, { profile: 'mp4-720p-v1' });
  const typoResult = validateVietnameseTypography(manifestV1);

  assert.equal(typoResult.valid, true);
  assert.ok(typoResult.diacriticsFound.length >= 8);
  assert.equal(typoResult.safeMarginCompliant, true);
  assert.equal(typoResult.errors.length, 0);

  // Verify subtitle cues
  assert.equal(manifestV1.subtitles.length, 1);
  const subTrack = manifestV1.subtitles[0];
  assert.equal(subTrack.locale, 'vi-VN');
  assert.equal(subTrack.burn_in, true);
  assert.equal(subTrack.style.safe_margin_px, 48);
  assert.equal(subTrack.cues.length, 4);

  // Verify cue timings are ordered and within composition bounds
  for (let i = 0; i < subTrack.cues.length; i++) {
    const cue = subTrack.cues[i];
    assert.ok(cue.start_frame >= 0);
    assert.ok(cue.end_frame <= 900);
    assert.ok(cue.start_frame < cue.end_frame);
    if (i > 0) {
      assert.ok(cue.start_frame >= subTrack.cues[i - 1].end_frame);
    }
  }
});

test('POC-02: Deterministic Render Pipeline, Visual Goldens & MP4 Decode', async () => {
  const manifestV1 = compileComposition(compPoc02V1, { profile: 'mp4-720p-v1' });

  // 1. Run full pipeline on Revision 1 (900 frames @ 30fps)
  const resultV1 = await executeRenderPipeline(manifestV1);

  assert.equal(resultV1.durationFrames, 900);
  assert.equal(resultV1.durationSeconds, 30);
  assert.equal(resultV1.width, 1280);
  assert.equal(resultV1.height, 720);
  assert.equal(resultV1.frameCount, 900);
  assert.equal(resultV1.allFrameChecksums.length, 900);

  // 2. Visual golden frames (≥20 frames)
  assert.ok(
    resultV1.goldenFrames.length >= 20,
    `Golden frames count (${resultV1.goldenFrames.length}) must be >= 20`
  );

  const pngSig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const golden of resultV1.goldenFrames) {
    assert.deepEqual(golden.pngBuffer.subarray(0, 8), pngSig);
    assert.ok(golden.checksumSha256.length === 64);
    assert.ok(golden.byteLength > 100);
  }

  // 3. MP4 binary and decoding verification
  assert.ok(resultV1.mp4ByteLength > 1000);
  assert.equal(resultV1.mp4ChecksumSha256.length, 64);

  const decodeReport = resultV1.decodeReport;
  assert.equal(decodeReport.valid, true, `MP4 decode errors: ${decodeReport.errors.join(', ')}`);
  assert.equal(decodeReport.majorBrand, 'isom');
  assert.equal(decodeReport.faststartMoovBeforeMdat, true);
  assert.ok(decodeReport.moovOffset < decodeReport.mdatOffset);
  assert.equal(decodeReport.videoFrameCount, 900);
  assert.equal(decodeReport.frameCountMatches, true);
  assert.equal(decodeReport.timestampsMonotonic, true);
  assert.equal(decodeReport.errors.length, 0);

  // Validate Audio stream
  assert.ok(decodeReport.audioSummary);
  assert.equal(decodeReport.audioSummary.sampleRate, 48000);
  assert.equal(decodeReport.audioSummary.channelCount, 2);
  assert.ok(
    decodeReport.audioVideoDurationDeltaSeconds <= 0.034,
    `Audio drift (${decodeReport.audioVideoDurationDeltaSeconds}s) must be <= 1 frame`
  );

  // Validate decoded frames: monotonic 0..899
  for (let i = 0; i < decodeReport.frames.length; i++) {
    const frame = decodeReport.frames[i];
    assert.equal(frame.frameIndex, i);
    assert.equal(frame.pts, i);
    assert.equal(frame.ptsSeconds, i / 30);
  }

  // 4. Test rendering of Revision 2 to prove editability
  const manifestV2 = compileComposition(compPoc02V2, { profile: 'mp4-720p-v1' });
  const resultV2 = await executeRenderPipeline(manifestV2);
  assert.equal(resultV2.frameCount, 900);
  assert.equal(resultV2.decodeReport.valid, true);
  assert.equal(resultV2.decodeReport.videoFrameCount, 900);
  assert.notEqual(
    resultV1.mp4ChecksumSha256,
    resultV2.mp4ChecksumSha256,
    'Revision 2 with edited text must produce distinct video checksum'
  );

  // 5. Save artifacts to evidence/P2-02/
  const outDir = resolve(repoRoot, 'evidence/P2-02');
  const goldensDir = resolve(outDir, 'goldens/poc02');
  mkdirSync(goldensDir, { recursive: true });

  writeFileSync(resolve(outDir, 'poc02.mp4'), resultV1.mp4Buffer);
  writeFileSync(resolve(outDir, 'poc02-v2.mp4'), resultV2.mp4Buffer);

  // Save selected golden PNGs
  for (const golden of resultV1.goldenFrames.slice(0, 10)) {
    const filename = `frame_${String(golden.frameIndex).padStart(4, '0')}.png`;
    writeFileSync(resolve(goldensDir, filename), golden.pngBuffer);
  }
});
