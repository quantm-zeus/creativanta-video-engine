import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemanticValidator } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Semantic Validator (Tier 2 Timeline, References & Conflicts)', () => {
  const validator = new SemanticValidator();

  describe('Normative Valid Fixtures', () => {
    it('validates minimal-valid fixture without errors', () => {
      const spec = loadFixture('minimal-valid.json');
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
    });

    it('validates POC-01 promo fixture without errors', () => {
      const spec = loadFixture('poc01-promo.json');
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
    });

    it('validates POC-02 explainer fixture without errors', () => {
      const spec = loadFixture('poc02-explainer.json');
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
    });

    it('validates POC-03 footage fixture without errors', () => {
      const spec = loadFixture('poc03-footage.json');
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
    });
  });

  describe('Scene Timeline Continuity & Boundary Checks', () => {
    it('rejects scene 0 not starting at frame 0', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].start_frame = 10;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/start_frame');
      assert.ok(err, 'Expected error at /scenes/0/start_frame');
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects timeline gap between consecutive scenes', () => {
      const spec = loadFixture('poc01-promo.json');
      // scene_intro is 0..150. Make scene_features start at 160 instead of 150
      spec.scenes[1].start_frame = 160;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/1/start_frame');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects timeline overlap between consecutive scenes', () => {
      const spec = loadFixture('poc01-promo.json');
      // scene_intro is 0..150. Make scene_features start at 140 instead of 150
      spec.scenes[1].start_frame = 140;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/1/start_frame');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects final scene not ending at composition duration_frames', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.duration_frames = 200; // scene ends at 150
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer.startsWith('/scenes/0'));
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects scene with duration_frames <= 0', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].duration_frames = 0;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      assert.ok(res.errors.some((e) => e.code === 'TIMELINE_BOUNDS'));
    });
  });

  describe('Layer Bounds & Animations', () => {
    it('rejects layer start_frame < 0', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].layers[0].start_frame = -5;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/layers/0/start_frame');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects layer interval exceeding scene duration', () => {
      const spec = loadFixture('minimal-valid.json');
      // scene duration is 150. layer start 100, duration 60 -> end 160 > 150
      spec.scenes[0].layers[0].start_frame = 100;
      spec.scenes[0].layers[0].duration_frames = 60;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/layers/0/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects duplicate animations on the same property (ANIMATION_CONFLICT)', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].layers[0].animations = [
        {
          property: 'opacity',
          easing: 'linear',
          keyframes: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }],
        },
        {
          property: 'opacity',
          easing: 'ease_in_quad',
          keyframes: [{ frame: 15, value: 1 }, { frame: 30, value: 0.5 }],
        },
      ];
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.code === 'ANIMATION_CONFLICT');
      assert.ok(err);
      assert.strictEqual(err.pointer, '/scenes/0/layers/0/animations/1/property');
    });

    it('rejects animation keyframes not strictly increasing', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].layers[0].animations[0].keyframes = [
        { frame: 10, value: 0 },
        { frame: 5, value: 1 },
      ];
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer.includes('keyframes/1/frame'));
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects animation keyframe exceeding layer duration', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].layers[0].duration_frames = 50;
      spec.scenes[0].layers[0].animations[0].keyframes = [
        { frame: 0, value: 0 },
        { frame: 55, value: 1 },
      ];
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer.includes('keyframes/1/frame'));
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });
  });

  describe('Transitions Out Bounds', () => {
    it('rejects cut transition with duration_frames != 0', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].transition_out = { type: 'cut', duration_frames: 5 };
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/transition_out/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects fade_to_background with F < 2', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].transition_out = { type: 'fade_to_background', duration_frames: 1 };
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/transition_out/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects fade_to_background with F > 300', () => {
      const spec = loadFixture('poc03-footage.json');
      spec.scenes[0].transition_out = { type: 'fade_to_background', duration_frames: 350 };
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/transition_out/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects fade_to_background with F > scene.duration_frames', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].duration_frames = 20;
      spec.duration_frames = 20;
      spec.scenes[0].layers[0].duration_frames = 20;
      spec.scenes[0].layers[0].animations[0].keyframes[1].frame = 15;
      spec.scenes[0].transition_out = { type: 'fade_to_background', duration_frames: 25 };
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/transition_out/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });
  });

  describe('ID Uniqueness & Font References', () => {
    it('rejects duplicate scene IDs', () => {
      const spec = loadFixture('poc01-promo.json');
      spec.scenes[1].id = spec.scenes[0].id;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/1/id');
      assert.ok(err);
      assert.strictEqual(err.code, 'DUPLICATE_ID');
    });

    it('rejects duplicate layer IDs within the same scene', () => {
      const spec = loadFixture('poc01-promo.json');
      spec.scenes[0].layers[1].id = spec.scenes[0].layers[0].id;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/layers/1/id');
      assert.ok(err);
      assert.strictEqual(err.code, 'DUPLICATE_ID');
    });

    it('rejects unknown font_id in text layer', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].layers[0].content.font_id = 'nonexistent_font';
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/layers/0/content/font_id');
      assert.ok(err);
      assert.strictEqual(err.code, 'UNKNOWN_FONT');
    });

    it('rejects unknown font_id in subtitle style', () => {
      const spec = loadFixture('poc02-explainer.json');
      spec.subtitles[0].style.font_id = 'missing_font';
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/subtitles/0/style/font_id');
      assert.ok(err);
      assert.strictEqual(err.code, 'UNKNOWN_FONT');
    });
  });

  describe('Audio Tracks and Subtitle Cues Timeline', () => {
    it('rejects audio track extending past composition duration', () => {
      const spec = loadFixture('poc02-explainer.json');
      spec.audio_tracks[0].start_frame = 100;
      spec.audio_tracks[0].duration_frames = 850; // 100 + 850 = 950 > 900
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/audio_tracks/0/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects audio track gain_db out of bounds', () => {
      const spec = loadFixture('poc02-explainer.json');
      spec.audio_tracks[0].gain_db = 15; // max is 12
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/audio_tracks/0/gain_db');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });

    it('rejects overlapping subtitle cues within the same track (TIMELINE_OVERLAP)', () => {
      const spec = loadFixture('poc02-explainer.json');
      // cue_1 ends at 195. Make cue_2 start at 180 (overlap!)
      spec.subtitles[0].cues[1].start_frame = 180;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.code === 'TIMELINE_OVERLAP');
      assert.ok(err);
      assert.strictEqual(err.pointer, '/subtitles/0/cues/1/start_frame');
    });

    it('rejects subtitle cue with start_frame >= end_frame', () => {
      const spec = loadFixture('poc02-explainer.json');
      spec.subtitles[0].cues[0].start_frame = 100;
      spec.subtitles[0].cues[0].end_frame = 100;
      const res = validator.validate(spec);
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/subtitles/0/cues/0/end_frame');
      assert.ok(err);
      assert.strictEqual(err.code, 'TIMELINE_BOUNDS');
    });
  });
});
