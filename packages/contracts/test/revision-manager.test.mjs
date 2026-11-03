import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCompositionRevisions } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Composition & Scene Revision Manager', () => {
  it('detects unchanged scenes across revisions', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    const diff = compareCompositionRevisions(baseSpec, newSpec, 1, 2);
    assert.strictEqual(diff.valid, true);
    assert.strictEqual(diff.is_render_affecting, false);
    assert.strictEqual(diff.scene_diffs.length, 3);
    assert.ok(diff.scene_diffs.every((d) => d.status === 'unchanged'));
  });

  it('detects modified scene with properly incremented scene revision', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    // Modify scene_intro and increment its revision from 1 to 2
    newSpec.scenes[0].layers[2].content.text = 'Khuyến mãi đặc biệt';
    newSpec.scenes[0].revision = 2;

    const diff = compareCompositionRevisions(baseSpec, newSpec, 1, 2);
    assert.strictEqual(diff.valid, true);
    assert.strictEqual(diff.is_render_affecting, true);

    const introDiff = diff.scene_diffs.find((d) => d.scene_id === 'scene_intro');
    assert.ok(introDiff);
    assert.strictEqual(introDiff.status, 'modified');
    assert.strictEqual(introDiff.base_revision, 1);
    assert.strictEqual(introDiff.new_revision, 2);

    // Other scenes remain unchanged
    const showcaseDiff = diff.scene_diffs.find((d) => d.scene_id === 'scene_showcase');
    assert.ok(showcaseDiff);
    assert.strictEqual(showcaseDiff.status, 'unchanged');
  });

  it('rejects modified scene when client fails to increment scene revision', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    // Modify scene_intro content but leave revision at 1
    newSpec.scenes[0].layers[2].content.text = 'Khuyến mãi đặc biệt';
    newSpec.scenes[0].revision = 1;

    const diff = compareCompositionRevisions(baseSpec, newSpec, 1, 2);
    assert.strictEqual(diff.valid, false);
    assert.ok(diff.errors.some((e) => e.includes('was not incremented over base revision')));
  });

  it('detects added and removed scenes', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    // Remove scene 2 and add a new scene
    newSpec.scenes.pop(); // remove scene_cta
    newSpec.scenes.push({
      id: 'scene_outro',
      revision: 1,
      start_frame: 300,
      duration_frames: 150,
      engine: 'html-v1',
      layers: [],
      transition_out: { type: 'cut', duration_frames: 0 },
    });

    const diff = compareCompositionRevisions(baseSpec, newSpec, 1, 2);
    const added = diff.scene_diffs.find((d) => d.scene_id === 'scene_outro');
    assert.ok(added);
    assert.strictEqual(added.status, 'added');

    const removed = diff.scene_diffs.find((d) => d.scene_id === 'scene_cta');
    assert.ok(removed);
    assert.strictEqual(removed.status, 'removed');
  });

  it('detects metadata-only change without altering spec_hash', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    newSpec.metadata = { note: 'only metadata updated' };

    const diff = compareCompositionRevisions(baseSpec, newSpec, 1, 2);
    assert.strictEqual(diff.valid, true);
    assert.strictEqual(diff.is_metadata_only, true);
    assert.strictEqual(diff.is_render_affecting, false);
    assert.strictEqual(diff.base_spec_hash, diff.new_spec_hash);
  });

  it('rejects new revision <= base revision', () => {
    const baseSpec = loadFixture('poc01-promo.json');
    const newSpec = JSON.parse(JSON.stringify(baseSpec));

    const diff = compareCompositionRevisions(baseSpec, newSpec, 2, 2);
    assert.strictEqual(diff.valid, false);
    assert.ok(diff.errors.some((e) => e.includes('strictly greater than base revision')));
  });
});
