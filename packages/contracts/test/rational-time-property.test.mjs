import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gcd,
  simplifyRational,
  roundHalfUpRational,
  roundHalfUp,
  frameToSeconds,
  frameToMilliseconds,
  frameToAudioSamples,
  audioSegmentSamples,
  canonicalizeJson,
  computeSpecHash,
  computeRenderHash,
  applyEasing,
  calculateTransitionAlpha,
} from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Boundary & Property-Based Tests (Rational Time, Transitions, Easing & Hashes)', () => {
  describe('Rational Arithmetic & Simplification', () => {
    it('simplifies rational FPS correctly using GCD', () => {
      assert.deepStrictEqual(simplifyRational({ num: 30, den: 1 }), { num: 30, den: 1 });
      assert.deepStrictEqual(simplifyRational({ num: 60, den: 2 }), { num: 30, den: 1 });
      assert.deepStrictEqual(simplifyRational({ num: 30000, den: 1001 }), { num: 30000, den: 1001 });
      assert.strictEqual(gcd(30, 45), 15);
      assert.strictEqual(gcd(100, 25), 25);
      assert.strictEqual(gcd(7, 13), 1);
    });

    it('implements exact round-half-up rational integer math', () => {
      // 5 / 2 = 2.5 -> rounds to 3
      assert.strictEqual(roundHalfUpRational(5, 2), 3);
      // 4 / 2 = 2.0 -> 2
      assert.strictEqual(roundHalfUpRational(4, 2), 2);
      // 3 / 2 = 1.5 -> 2
      assert.strictEqual(roundHalfUpRational(3, 2), 2);
      // 1 / 4 = 0.25 -> 0
      assert.strictEqual(roundHalfUpRational(1, 4), 0);
      // 3 / 4 = 0.75 -> 1
      assert.strictEqual(roundHalfUpRational(3, 4), 1);
    });

    it('matches floating roundHalfUp with integer roundHalfUpRational', () => {
      for (let n = 0; n < 1000; n += 7) {
        const floatVal = n / 30;
        const intRounded = roundHalfUpRational(n, 30);
        const floatRounded = roundHalfUp(floatVal);
        assert.strictEqual(intRounded, floatRounded, `Mismatch at n=${n}`);
      }
    });
  });

  describe('Audio Segment Concatenation Zero-Drift Invariant (Property Test)', () => {
    it('guarantees sum of consecutive segment samples equals total duration samples with 0 cumulative drift', () => {
      const fpsVariants = [
        { num: 30, den: 1 },
        { num: 25, den: 1 },
        { num: 24, den: 1 },
        { num: 30000, den: 1001 },
      ];

      for (const fps of fpsVariants) {
        const totalFrames = 1800; // 60s at 30fps
        const totalExpectedSamples = frameToAudioSamples(totalFrames, fps, 48000);

        // Partition totalFrames into arbitrary random/variable slices
        const sliceSizes = [15, 33, 47, 85, 120, 200, 500, 300, 500];
        let currentFrame = 0;
        let accumulatedSegmentSamples = 0;

        for (const size of sliceSizes) {
          const nextFrame = Math.min(totalFrames, currentFrame + size);
          const segSamples = audioSegmentSamples(currentFrame, nextFrame, fps, 48000);
          accumulatedSegmentSamples += segSamples;
          currentFrame = nextFrame;
        }

        // Remaining tail slice
        if (currentFrame < totalFrames) {
          accumulatedSegmentSamples += audioSegmentSamples(currentFrame, totalFrames, fps, 48000);
        }

        assert.strictEqual(
          accumulatedSegmentSamples,
          totalExpectedSamples,
          `Zero-drift property violated for FPS ${fps.num}/${fps.den}: expected ${totalExpectedSamples}, got ${accumulatedSegmentSamples}`
        );
      }
    });
  });

  describe('Transition Alpha Monotonicity & Boundary Invariants', () => {
    it('fade_to_background strictly starts at 1.0, ends at 0.0, and decreases monotonically', () => {
      const sceneStart = 100;
      const sceneDuration = 60;
      const sceneEnd = sceneStart + sceneDuration; // 160
      const fadeDuration = 20; // F = 20

      const transition = {
        type: 'fade_to_background',
        duration_frames: fadeDuration,
      };

      const fadeStart = sceneEnd - fadeDuration; // 140

      // Before fade
      assert.strictEqual(
        calculateTransitionAlpha(transition, sceneStart, sceneDuration, fadeStart - 1).sceneAlpha,
        1.0
      );

      // At fade start (globalFrame = 140)
      const atStart = calculateTransitionAlpha(transition, sceneStart, sceneDuration, fadeStart);
      assert.strictEqual(atStart.sceneAlpha, 1.0);
      assert.strictEqual(atStart.transitionActive, true);

      // At fade end (globalFrame = 159, which is sceneEnd - 1)
      const atEnd = calculateTransitionAlpha(transition, sceneStart, sceneDuration, sceneEnd - 1);
      assert.strictEqual(atEnd.sceneAlpha, 0.0);
      assert.strictEqual(atEnd.transitionActive, true);

      // Verify strictly decreasing monotonic progression
      let prevAlpha = 1.0;
      for (let k = fadeStart; k < sceneEnd; k++) {
        const curr = calculateTransitionAlpha(transition, sceneStart, sceneDuration, k);
        assert.ok(
          curr.sceneAlpha <= prevAlpha,
          `Monotonicity violated at frame ${k}: prev=${prevAlpha}, curr=${curr.sceneAlpha}`
        );
        assert.ok(curr.sceneAlpha >= 0.0 && curr.sceneAlpha <= 1.0);
        prevAlpha = curr.sceneAlpha;
      }
    });
  });

  describe('Easing Functions Monotonicity & Clamping Invariants', () => {
    const easings = ['linear', 'ease_in_quad', 'ease_out_quad', 'ease_in_out_quad'];

    it('all standard easing curves satisfy f(0) === 0 and f(1) === 1', () => {
      for (const easing of easings) {
        assert.strictEqual(applyEasing(0, easing), 0, `${easing} at 0 must be 0`);
        assert.strictEqual(applyEasing(1, easing), 1, `${easing} at 1 must be 1`);
      }
    });

    it('all standard easing curves are monotonically non-decreasing in [0, 1]', () => {
      for (const easing of easings) {
        let prev = 0;
        for (let step = 0; step <= 100; step++) {
          const t = step / 100;
          const val = applyEasing(t, easing);
          assert.ok(
            val >= prev - 1e-9,
            `${easing} violated monotonicity at t=${t}: prev=${prev}, curr=${val}`
          );
          assert.ok(val >= 0 && val <= 1, `${easing} out of [0, 1] range: ${val}`);
          prev = val;
        }
      }
    });

    it('clamps t outside [0, 1]', () => {
      for (const easing of easings) {
        assert.strictEqual(applyEasing(-0.5, easing), 0);
        assert.strictEqual(applyEasing(1.5, easing), 1);
      }
    });
  });

  describe('RFC 8785 Canonical JSON & Hash Identity Property', () => {
    it('canonicalizeJson is invariant under object key reordering', () => {
      const objA = {
        z_index: 1,
        alpha: 'test',
        nested: { b: 2, a: 1 },
        list: [1, 2, 3],
      };
      const objB = {
        nested: { a: 1, b: 2 },
        list: [1, 2, 3],
        alpha: 'test',
        z_index: 1,
      };

      const canonA = canonicalizeJson(objA);
      const canonB = canonicalizeJson(objB);
      assert.strictEqual(canonA, canonB);
    });

    it('metadata-only change does NOT change spec_hash or render_hash', () => {
      const specA = loadFixture('poc01-promo.json');
      specA.metadata = { campaign: 'spring_2026', author: 'agent_b' };

      const specB = loadFixture('poc01-promo.json');
      specB.metadata = { campaign: 'autumn_2026', notes: 'revised marketing brief' };

      const hashA = computeSpecHash(specA);
      const hashB = computeSpecHash(specB);
      assert.strictEqual(hashA, hashB, 'spec_hash must be identical when only metadata changes');

      const renderHashA = computeRenderHash(specA, 'mp4-720p-v1');
      const renderHashB = computeRenderHash(specB, 'mp4-720p-v1');
      assert.strictEqual(renderHashA, renderHashB, 'render_hash must be identical when only metadata changes');
    });

    it('render-affecting change DOES change spec_hash and render_hash', () => {
      const specA = loadFixture('poc01-promo.json');
      const specB = loadFixture('poc01-promo.json');

      // Change headline text in scene_intro
      specB.scenes[0].layers[2].content.text = 'Bộ sưu tập Mùa Đông 2026';

      const hashA = computeSpecHash(specA);
      const hashB = computeSpecHash(specB);
      assert.notStrictEqual(hashA, hashB, 'spec_hash must change when content text changes');

      const renderHashA = computeRenderHash(specA, 'mp4-720p-v1');
      const renderHashB = computeRenderHash(specB, 'mp4-720p-v1');
      assert.notStrictEqual(renderHashA, renderHashB, 'render_hash must change when content text changes');
    });
  });
});
