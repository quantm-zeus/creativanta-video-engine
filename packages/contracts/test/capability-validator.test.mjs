import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CapabilityValidator } from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Capability & Policy Validator (Tier 3 Profile & Engine Gates)', () => {
  const validator = new CapabilityValidator();

  describe('Profile mp4-720p-v1 Constraints', () => {
    it('accepts valid 720x1280 portrait canvas at 30fps within 1800 frames', () => {
      const spec = loadFixture('poc01-promo.json'); // 720x1280, 450 frames
      const res = validator.validate(spec, { profile: 'mp4-720p-v1' });
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
      assert.ok(res.required_capabilities.includes('profile:mp4-720p-v1'));
    });

    it('accepts valid 1280x720 landscape canvas at 30fps within 1800 frames', () => {
      const spec = loadFixture('poc02-explainer.json'); // 1280x720, 900 frames
      const res = validator.validate(spec, { profile: 'mp4-720p-v1' });
      assert.strictEqual(res.valid, true);
      assert.strictEqual(res.errors.length, 0);
    });

    it('rejects canvas dimension not matching 720p profile (e.g. 1920x1080 1080p)', () => {
      const spec = loadFixture('poc02-explainer.json');
      spec.canvas.width = 1920;
      spec.canvas.height = 1080;
      const res = validator.validate(spec, { profile: 'mp4-720p-v1' });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/canvas');
      assert.ok(err);
      assert.strictEqual(err.code, 'PROFILE_CONSTRAINT_VIOLATED');
    });

    it('rejects duration exceeding 1800 frames (60s) on mp4-720p-v1 profile', () => {
      const spec = loadFixture('poc03-footage.json');
      // POC-03 is 1350 frames (45s). Increase to 1850 frames
      spec.duration_frames = 1850;
      spec.scenes[1].duration_frames = 1175;
      const res = validator.validate(spec, { profile: 'mp4-720p-v1' });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'PROFILE_CONSTRAINT_VIOLATED');
    });

    it('rejects FPS other than 30/1 on starter profile', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.fps = { num: 24, den: 1 };
      const res = validator.validate(spec, { profile: 'mp4-720p-v1' });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/fps');
      assert.ok(err);
      assert.strictEqual(err.code, 'PROFILE_CONSTRAINT_VIOLATED');
    });
  });

  describe('Profile preview-360p-v1 Constraints', () => {
    it('accepts 360x640 preview canvas within 300 frames (10s)', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.canvas.width = 360;
      spec.canvas.height = 640;
      spec.duration_frames = 150;
      const res = validator.validate(spec, { profile: 'preview-360p-v1' });
      assert.strictEqual(res.valid, true);
    });

    it('rejects preview exceeding 300 frames (10s)', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.canvas.width = 360;
      spec.canvas.height = 640;
      spec.duration_frames = 350;
      const res = validator.validate(spec, { profile: 'preview-360p-v1' });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/duration_frames');
      assert.ok(err);
      assert.strictEqual(err.code, 'PROFILE_CONSTRAINT_VIOLATED');
    });
  });

  describe('Engine & Feature Capability Flags', () => {
    it('rejects custom-html-v1 engine when custom code capability is disabled', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].engine = 'custom-html-v1';
      delete spec.scenes[0].layers;
      spec.scenes[0].bundle = {
        id: 'bnd_test',
        revision: 1,
        source_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        build_sha256: '1111111111111111111111111111111111111111111111111111111111111111',
        entrypoint: 'index.html',
        parameters: {},
      };
      const res = validator.validate(spec, { customCodeEnabled: false });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/scenes/0/engine');
      assert.ok(err);
      assert.strictEqual(err.code, 'CAPABILITY_DISABLED');
    });

    it('allows custom-html-v1 engine when custom code capability is explicitly enabled', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.scenes[0].engine = 'custom-html-v1';
      delete spec.scenes[0].layers;
      spec.scenes[0].bundle = {
        id: 'bnd_test',
        revision: 1,
        source_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        build_sha256: '1111111111111111111111111111111111111111111111111111111111111111',
        entrypoint: 'index.html',
        parameters: {},
      };
      const res = validator.validate(spec, { customCodeEnabled: true });
      assert.strictEqual(res.valid, true);
      assert.ok(res.required_capabilities.includes('engine:custom-html-v1'));
    });

    it('rejects rtl direction when RTL feature is disabled', () => {
      const spec = loadFixture('minimal-valid.json');
      spec.direction = 'rtl';
      const res = validator.validate(spec, { rtlEnabled: false });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.pointer === '/direction');
      assert.ok(err);
      assert.strictEqual(err.code, 'CAPABILITY_DISABLED');
    });
  });

  describe('Quota & System Limits', () => {
    it('rejects total layers exceeding system limit of 500', () => {
      const spec = loadFixture('minimal-valid.json');
      const baseLayer = spec.scenes[0].layers[0];
      spec.scenes[0].layers = [];
      for (let i = 0; i < 505; i++) {
        spec.scenes[0].layers.push({
          ...baseLayer,
          id: `layer_${i}`,
        });
      }
      const res = validator.validate(spec, { maxLayersTotal: 500, maxLayersPerScene: 600 });
      assert.strictEqual(res.valid, false);
      const err = res.errors.find((e) => e.code === 'PROFILE_CONSTRAINT_VIOLATED' && e.message.includes('500'));
      assert.ok(err);
    });
  });
});
