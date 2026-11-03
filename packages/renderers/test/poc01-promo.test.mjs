import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileComposition,
  compareCompositionRevisions,
} from '@creativanta/contracts';

import {
  executeRenderPipeline,
  validateVietnameseTypography,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const tplPoc01 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc01-template.json'), 'utf-8')
);
const compPoc01V1 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc01-composition-v1.json'), 'utf-8')
);
const compPoc01V2 = JSON.parse(
  readFileSync(resolve(repoRoot, 'fixtures/poc01-composition-v2.json'), 'utf-8')
);

test('POC-01: Versioned Editable Template & Revision Concurrency', () => {
  // 1. Template validation
  assert.equal(tplPoc01.id, 'tpl_poc01_promo');
  assert.equal(tplPoc01.revision, 1);
  assert.equal(tplPoc01.variables_schema.type, 'object');
  assert.ok(tplPoc01.variables_schema.required.includes('headline'));
  assert.ok(tplPoc01.variables_schema.required.includes('price'));
  assert.ok(tplPoc01.defaults.headline);
  assert.ok(tplPoc01.defaults.price);

  // 2. Compilation of Revision 1
  const manifestV1 = compileComposition(compPoc01V1, { profile: 'mp4-720p-v1' });
  assert.equal(manifestV1.duration_frames, 450);
  assert.equal(manifestV1.duration_seconds, 15);
  assert.equal(manifestV1.canvas.width, 720);
  assert.equal(manifestV1.canvas.height, 1280);
  assert.equal(manifestV1.scenes.length, 3);

  // 3. Compilation of Revision 2 (Edited Variables)
  const manifestV2 = compileComposition(compPoc01V2, { profile: 'mp4-720p-v1' });
  assert.equal(manifestV2.duration_frames, 450);
  assert.equal(manifestV2.scenes.length, 3);

  // 4. Compare revisions concurrency and diffs
  const diff = compareCompositionRevisions(compPoc01V1, compPoc01V2, 1, 2);
  assert.equal(diff.valid, true);
  assert.equal(diff.is_render_affecting, true);
  assert.equal(diff.errors.length, 0);

  // All 3 scenes modified and incremented to revision 2
  const modifiedScenes = diff.scene_diffs.filter((s) => s.status === 'modified');
  assert.equal(modifiedScenes.length, 3);
  for (const s of modifiedScenes) {
    assert.equal(s.base_revision, 1);
    assert.equal(s.new_revision, 2);
  }
});

test('POC-01: Vietnamese Typography, Currency Symbol & Safe Margins', () => {
  const manifestV1 = compileComposition(compPoc01V1, { profile: 'mp4-720p-v1' });
  const typoResult = validateVietnameseTypography(manifestV1);

  assert.equal(typoResult.valid, true);
  assert.ok(typoResult.currencySymbolFound, 'Must find currency symbol ₫');
  assert.ok(typoResult.diacriticsFound.length >= 5, 'Must contain Vietnamese tone marks');
  assert.equal(typoResult.safeMarginCompliant, true);
  assert.equal(typoResult.errors.length, 0);

  // Validate exact text tokens in layer content
  const texts = typoResult.textsChecked.join(' ');
  assert.ok(texts.includes('SIÊU ƯU ĐÃI'));
  assert.ok(texts.includes('Bộ sưu tập Mùa Thu 2026'));
  assert.ok(texts.includes('199.000 ₫'));
  assert.ok(texts.includes('Mua ngay hôm nay'));
});

test('POC-01: Deterministic Render Pipeline, Visual Goldens & MP4 Decode', async () => {
  const manifestV1 = compileComposition(compPoc01V1, { profile: 'mp4-720p-v1' });

  // 1. Run full pipeline on Revision 1 (450 frames @ 30fps)
  const resultV1 = await executeRenderPipeline(manifestV1);

  assert.equal(resultV1.durationFrames, 450);
  assert.equal(resultV1.durationSeconds, 15);
  assert.equal(resultV1.width, 720);
  assert.equal(resultV1.height, 1280);
  assert.equal(resultV1.frameCount, 450);
  assert.equal(resultV1.allFrameChecksums.length, 450);

  // 2. Visual golden frames (Testing.md: ≥20 frames per fixture)
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
  assert.ok(resultV1.mp4ByteLength > 1000, 'MP4 binary must be substantial');
  assert.equal(resultV1.mp4ChecksumSha256.length, 64);

  const decodeReport = resultV1.decodeReport;
  assert.equal(decodeReport.valid, true, `MP4 decode errors: ${decodeReport.errors.join(', ')}`);
  assert.equal(decodeReport.majorBrand, 'isom');
  assert.equal(decodeReport.faststartMoovBeforeMdat, true);
  assert.ok(decodeReport.moovOffset < decodeReport.mdatOffset);
  assert.equal(decodeReport.videoFrameCount, 450);
  assert.equal(decodeReport.frameCountMatches, true);
  assert.equal(decodeReport.timestampsMonotonic, true);
  assert.equal(decodeReport.errors.length, 0);

  // Validate decoded frames: timestamps strictly monotonic from 0 to 449
  for (let i = 0; i < decodeReport.frames.length; i++) {
    const frame = decodeReport.frames[i];
    assert.equal(frame.frameIndex, i);
    assert.equal(frame.pts, i);
    assert.equal(frame.ptsSeconds, i / 30);
    if (i === 0 || i % 30 === 0) {
      assert.equal(frame.isKeyframe, true);
    }
  }

  // 4. Test rendering of Revision 2 to prove editability
  const manifestV2 = compileComposition(compPoc01V2, { profile: 'mp4-720p-v1' });
  const resultV2 = await executeRenderPipeline(manifestV2);
  assert.equal(resultV2.frameCount, 450);
  assert.equal(resultV2.decodeReport.valid, true);
  assert.equal(resultV2.decodeReport.videoFrameCount, 450);
  assert.notEqual(
    resultV1.mp4ChecksumSha256,
    resultV2.mp4ChecksumSha256,
    'Revision 2 with edited text must produce distinct video checksum'
  );

  // 5. Save artifacts to evidence/P2-02/
  const outDir = resolve(repoRoot, 'evidence/P2-02');
  const goldensDir = resolve(outDir, 'goldens/poc01');
  mkdirSync(goldensDir, { recursive: true });

  writeFileSync(resolve(outDir, 'poc01.mp4'), resultV1.mp4Buffer);
  writeFileSync(resolve(outDir, 'poc01-v2.mp4'), resultV2.mp4Buffer);

  // Save selected golden PNGs
  for (const golden of resultV1.goldenFrames.slice(0, 10)) {
    const filename = `frame_${String(golden.frameIndex).padStart(4, '0')}.png`;
    writeFileSync(resolve(goldensDir, filename), golden.pngBuffer);
  }
});
