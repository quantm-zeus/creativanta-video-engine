import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileComposition, evaluateFrame } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Canonical Compiler Manifest and Frame Evaluator', () => {
  describe('Normative Fixtures Compilation', () => {
    it('compiles minimal-valid into complete CanonicalCompilerManifest', () => {
      const spec = loadFixture('minimal-valid.json');
      const manifest = compileComposition(spec, {
        compositionId: 'cmp_minimal',
        revision: 1,
        profile: 'mp4-720p-v1',
      });

      assert.strictEqual(manifest.manifest_version, '1.0');
      assert.strictEqual(manifest.composition_id, 'cmp_minimal');
      assert.strictEqual(manifest.revision, 1);
      assert.strictEqual(manifest.profile, 'mp4-720p-v1');
      assert.strictEqual(manifest.duration_frames, 150);
      assert.strictEqual(manifest.duration_seconds, 5.0);
      assert.match(manifest.spec_hash, /^[0-9a-f]{64}$/);
      assert.match(manifest.render_hash, /^[0-9a-f]{64}$/);
      assert.strictEqual(manifest.scenes.length, 1);
      assert.match(manifest.scenes[0].scene_hash, /^[0-9a-f]{64}$/);
      assert.strictEqual(manifest.scenes[0].start_frame, 0);
      assert.strictEqual(manifest.scenes[0].end_frame, 150);
      assert.strictEqual(manifest.scenes[0].layers.length, 1);
      assert.deepStrictEqual(manifest.scenes[0].layers[0].transform, {
        translate_x: 0,
        translate_y: 0,
        scale_x: 1,
        scale_y: 1,
        rotate_deg: 0,
        origin_x: 0.5,
        origin_y: 0.5,
      });
    });

    it('compiles POC-01 promo (15s, 450 frames) into CanonicalCompilerManifest', () => {
      const spec = loadFixture('poc01-promo.json');
      const manifest = compileComposition(spec, {
        compositionId: 'cmp_poc01',
        revision: 1,
        profile: 'mp4-720p-v1',
      });

      assert.strictEqual(manifest.duration_frames, 450);
      assert.strictEqual(manifest.duration_seconds, 15.0);
      assert.strictEqual(manifest.scenes.length, 3);
      assert.strictEqual(manifest.scenes[0].start_frame, 0);
      assert.strictEqual(manifest.scenes[0].end_frame, 150);
      assert.strictEqual(manifest.scenes[1].start_frame, 150);
      assert.strictEqual(manifest.scenes[1].end_frame, 330);
      assert.strictEqual(manifest.scenes[2].start_frame, 330);
      assert.strictEqual(manifest.scenes[2].end_frame, 450);
    });

    it('compiles POC-02 explainer (30s, 900 frames) with audio and subtitles', () => {
      const spec = loadFixture('poc02-explainer.json');
      const manifest = compileComposition(spec, {
        compositionId: 'cmp_poc02',
        revision: 1,
        profile: 'mp4-720p-v1',
      });

      assert.strictEqual(manifest.duration_frames, 900);
      assert.strictEqual(manifest.duration_seconds, 30.0);
      assert.strictEqual(manifest.canvas.width, 1280);
      assert.strictEqual(manifest.canvas.height, 720);

      // Audio verification
      assert.strictEqual(manifest.audio_tracks.length, 1);
      const audio = manifest.audio_tracks[0];
      assert.strictEqual(audio.sample_start, 0);
      assert.strictEqual(audio.sample_count, 900 * 48000 / 30); // 1,440,000 samples
      assert.strictEqual(audio.role, 'voice');

      // Subtitles verification
      assert.strictEqual(manifest.subtitles.length, 1);
      const sub = manifest.subtitles[0];
      assert.strictEqual(sub.cues.length, 4);
      assert.strictEqual(sub.cues[0].start_frame, 15);
      assert.strictEqual(sub.cues[0].start_ms, 500); // 15 frames * 1000 / 30 = 500ms
      assert.strictEqual(sub.cues[0].end_frame, 195);
      assert.strictEqual(sub.cues[0].end_ms, 6500); // 195 frames * 1000 / 30 = 6500ms
    });

    it('compiles POC-03 footage (45s, 1350 frames) with multiple audio tracks', () => {
      const spec = loadFixture('poc03-footage.json');
      const manifest = compileComposition(spec, {
        compositionId: 'cmp_poc03',
        revision: 1,
        profile: 'mp4-720p-v1',
      });

      assert.strictEqual(manifest.duration_frames, 1350);
      assert.strictEqual(manifest.duration_seconds, 45.0);
      assert.strictEqual(manifest.scenes.length, 2);
      assert.strictEqual(manifest.audio_tracks.length, 2);

      // Verify audio sample continuity
      const bgMusic = manifest.audio_tracks[0];
      assert.strictEqual(bgMusic.sample_count, 1350 * 48000 / 30); // 2,160,000 samples
    });
  });

  describe('Frame Evaluator (Pure Frame Function)', () => {
    it('evaluates frame 0 with proper animation interpolation', () => {
      const spec = loadFixture('minimal-valid.json');
      const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

      const state0 = evaluateFrame(manifest, 0);
      assert.strictEqual(state0.frame_index, 0);
      assert.strictEqual(state0.timestamp_seconds, 0);
      assert.strictEqual(state0.audio_sample_offset, 0);
      assert.strictEqual(state0.scene.id, 'intro');
      assert.strictEqual(state0.scene.local_frame, 0);
      assert.strictEqual(state0.scene.scene_alpha, 1.0);
      assert.strictEqual(state0.layers.length, 1);

      // Headline layer opacity animation: 0 at frame 0, 1 at frame 15
      assert.strictEqual(state0.layers[0].opacity, 0);
    });

    it('evaluates midway frame and interpolates animation linearly', () => {
      const spec = loadFixture('minimal-valid.json');
      const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

      // Frame 15 is keyframe 1 (opacity=1)
      const state15 = evaluateFrame(manifest, 15);
      assert.strictEqual(state15.layers[0].opacity, 1);

      // Frame 30 holds last keyframe value (opacity=1)
      const state30 = evaluateFrame(manifest, 30);
      assert.strictEqual(state30.layers[0].opacity, 1);
    });

    it('evaluates fade_to_background transition alpha correctly', () => {
      const spec = loadFixture('poc01-promo.json');
      // Add a fade_to_background transition on scene_intro (150 frames, fade 30 frames: [120, 149])
      spec.scenes[0].transition_out = {
        type: 'fade_to_background',
        duration_frames: 30,
      };

      const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

      // Frame 100: before fade -> scene_alpha = 1.0
      const s100 = evaluateFrame(manifest, 100);
      assert.strictEqual(s100.scene.scene_alpha, 1.0);
      assert.strictEqual(s100.scene.transition_active, false);

      // Frame 120: start of fade (end=150, F=30, k=120)
      // formula: (150 - 1 - 120) / (30 - 1) = 29 / 29 = 1.0
      const s120 = evaluateFrame(manifest, 120);
      assert.strictEqual(s120.scene.scene_alpha, 1.0);
      assert.strictEqual(s120.scene.transition_active, true);

      // Frame 149: last frame of scene (k=149)
      // formula: (150 - 1 - 149) / 29 = 0 / 29 = 0.0
      const s149 = evaluateFrame(manifest, 149);
      assert.strictEqual(s149.scene.scene_alpha, 0.0);
      assert.strictEqual(s149.scene.transition_active, true);

      // Frame 150: first frame of next scene (scene_showcase) -> scene_alpha resets to 1.0!
      const s150 = evaluateFrame(manifest, 150);
      assert.strictEqual(s150.scene.id, 'scene_showcase');
      assert.strictEqual(s150.scene.scene_alpha, 1.0);
      assert.strictEqual(s150.scene.transition_active, false);
    });

    it('sorts active layers by z_index ascending', () => {
      const spec = loadFixture('poc01-promo.json');
      const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

      // Frame 20 in scene_intro has badge (z=1), badge_text (z=2), headline (z=3)
      const state20 = evaluateFrame(manifest, 20);
      assert.ok(state20.layers.length >= 3);
      for (let i = 0; i < state20.layers.length - 1; i++) {
        assert.ok(state20.layers[i].z_index <= state20.layers[i + 1].z_index);
      }
    });

    it('throws RangeError for out-of-bounds frame index', () => {
      const spec = loadFixture('minimal-valid.json');
      const manifest = compileComposition(spec, { profile: 'mp4-720p-v1' });

      assert.throws(() => evaluateFrame(manifest, -1), RangeError);
      assert.throws(() => evaluateFrame(manifest, 150), RangeError);
    });
  });
});
