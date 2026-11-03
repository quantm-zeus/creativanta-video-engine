import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSceneSchema,
  getExpandedSceneSchema,
  validateCompositionSchema,
} from '../dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  const p = path.resolve(__dirname, 'fixtures', name);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

describe('Scene JSON Schema 2020-12 and $defs Coverage', () => {
  it('loads valid canonical scene schema with draft 2020-12 declaration', () => {
    const schema = getSceneSchema();
    assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.strictEqual(schema.$id, 'https://schemas.example.invalid/cve/composition/1.0');
    assert.strictEqual(schema.type, 'object');
    assert.strictEqual(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
  });

  it('contains all required normative $defs fragments matching SCENE-SPEC.md', () => {
    const schema = getSceneSchema();
    const defs = schema.$defs;
    assert.ok(defs, '$defs must be defined');

    const expectedDefs = [
      'canvas',
      'rationalFps',
      'font',
      'scene',
      'bundle',
      'transitionOut',
      'layer',
      'box',
      'transform',
      'animation',
      'keyframe',
      'layerContent',
      'textContent',
      'imageContent',
      'videoContent',
      'shapeContent',
      'svgContent',
      'audioTrack',
      'gainKeyframe',
      'subtitleTrack',
      'subtitleCue',
      'subtitleStyle',
      'metadata',
      'extensions',
    ];

    for (const defName of expectedDefs) {
      assert.ok(defs[defName], `Missing expected $defs fragment: ${defName}`);
    }
  });

  it('dereferences all $defs fragments into expanded scene schema', () => {
    const expanded = getExpandedSceneSchema();
    assert.strictEqual(expanded.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.ok(expanded.properties.canvas.properties.width);
    assert.ok(expanded.properties.fps.properties.num);
  });
});

describe('Valid Fixtures Validation', () => {
  it('validates minimal-valid fixture (150-frame example from SCENE-SPEC.md)', () => {
    const fixture = loadFixture('minimal-valid.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, true, `Validation failed: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.errors.length, 0);
  });

  it('validates POC-01 promo fixture (15s, 450 frames, 3 scenes, text/shapes/animations)', () => {
    const fixture = loadFixture('poc01-promo.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, true, `Validation failed: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.errors.length, 0);
  });

  it('validates POC-02 explainer fixture (30s, 900 frames, 4 scenes, SVG, audio, subtitles)', () => {
    const fixture = loadFixture('poc02-explainer.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, true, `Validation failed: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.errors.length, 0);
  });

  it('validates POC-03 footage fixture (45s, 1350 frames, 2 video scenes, dual audio, captions)', () => {
    const fixture = loadFixture('poc03-footage.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, true, `Validation failed: ${JSON.stringify(result.errors)}`);
    assert.strictEqual(result.errors.length, 0);
  });
});

describe('Invalid Fixtures Validation (Unknown Fields & Invalid Timing)', () => {
  it('fails with UNKNOWN_FIELD for unknown root fields (closed schema)', () => {
    const fixture = loadFixture('invalid-unknown-root-field.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'UNKNOWN_FIELD');
    assert.ok(err, 'Expected UNKNOWN_FIELD error');
    assert.strictEqual(err.pointer, '/malicious_injected_field');
  });

  it('fails with UNKNOWN_FIELD for unknown layer properties (closed layer schema)', () => {
    const fixture = loadFixture('invalid-unknown-layer-field.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'UNKNOWN_FIELD');
    assert.ok(err, 'Expected UNKNOWN_FIELD error for layer property');
    assert.strictEqual(err.pointer, '/scenes/0/layers/0/custom_script');
  });

  it('fails with OUT_OF_RANGE when duration_frames is 0 (must be >= 1)', () => {
    const fixture = loadFixture('invalid-timing-duration-zero.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'OUT_OF_RANGE' && e.pointer === '/duration_frames');
    assert.ok(err, 'Expected OUT_OF_RANGE error at /duration_frames');
  });

  it('fails with TYPE_MISMATCH when fps is a float instead of rational object', () => {
    const fixture = loadFixture('invalid-timing-fps-float.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'TYPE_MISMATCH' && e.pointer === '/fps');
    assert.ok(err, 'Expected TYPE_MISMATCH error at /fps');
  });

  it('fails when transition cut has duration_frames > 0', () => {
    const fixture = loadFixture('invalid-timing-transition-cut.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('fails when transition fade_to_background has duration_frames < 2', () => {
    const fixture = loadFixture('invalid-timing-transition-fade.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('fails with OUT_OF_RANGE when box width is negative', () => {
    const fixture = loadFixture('invalid-box-negative.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'OUT_OF_RANGE' && e.pointer.includes('/box/width'));
    assert.ok(err, 'Expected OUT_OF_RANGE error at box width');
  });

  it('fails with ENUM_MISMATCH when schema_version is not 1.0', () => {
    const fixture = loadFixture('invalid-schema-version.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'ENUM_MISMATCH' && e.pointer === '/schema_version');
    assert.ok(err, 'Expected ENUM_MISMATCH error at /schema_version');
  });

  it('fails with ENUM_MISMATCH when locale is not in allowlist', () => {
    const fixture = loadFixture('invalid-locale.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'ENUM_MISMATCH' && e.pointer === '/locale');
    assert.ok(err, 'Expected ENUM_MISMATCH error at /locale');
  });

  it('fails with OUT_OF_RANGE when font weight is less than 100', () => {
    const fixture = loadFixture('invalid-font-weight.json');
    const result = validateCompositionSchema(fixture);
    assert.strictEqual(result.valid, false);
    const err = result.errors.find((e) => e.code === 'OUT_OF_RANGE' && e.pointer.includes('/weight'));
    assert.ok(err, 'Expected OUT_OF_RANGE error at font weight');
  });
});
