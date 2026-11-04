import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBrandTokens,
  assertValidBrandTokens,
  applyBrandTokens,
  BrandTokenError,
} from '../dist/index.js';

test('Brand Tokens: Validates Compliant Brand Tokens', () => {
  const validTokens = {
    primaryColor: '#FF5733',
    secondaryColor: '#33FF57',
    accentColor: '#3357FF',
    backgroundColor: '#0F172A',
    textColor: '#FFFFFF',
    headingFontId: 'font_heading',
    bodyFontId: 'font_body',
    logoAssetId: 'ast_brand_logo_main',
    borderRadius: 16,
  };

  const allowedFonts = ['font_heading', 'font_body', 'font_mono'];
  const result = validateBrandTokens(validTokens, allowedFonts);

  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.sanitizedTokens);
  assert.equal(result.sanitizedTokens.primaryColor, '#FF5733');
  assert.equal(result.sanitizedTokens.borderRadius, 16);
});

test('Brand Tokens: Rejects Invalid and Malicious Color Formats', () => {
  const attackVectors = [
    { primaryColor: 'red; background: url(evil.com)' },
    { primaryColor: '<script>alert(1)</script>' },
    { primaryColor: 'expression(document.cookie)' },
    { primaryColor: 'javascript:void(0)' },
    { primaryColor: 'not-a-color' },
    { primaryColor: '#12345' }, // 5 hex chars is invalid
    { primaryColor: '#GGGGGG' },
  ];

  for (const tokenSet of attackVectors) {
    const result = validateBrandTokens(tokenSet);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
    assert.throws(() => assertValidBrandTokens(tokenSet), BrandTokenError);
  }
});

test('Brand Tokens: Rejects Unpinned Fonts and Malformed Asset IDs', () => {
  const unpinnedFont = {
    headingFontId: 'font_untrusted_remote',
  };
  const resultFont = validateBrandTokens(unpinnedFont, ['font_noto_sans']);
  assert.equal(resultFont.valid, false);
  assert.equal(resultFont.errors[0].code, 'UNKNOWN_FONT_ID');

  const invalidAsset = {
    logoAssetId: 'https://evil.com/logo.png', // Must match ast_*
  };
  const resultAsset = validateBrandTokens(invalidAsset);
  assert.equal(resultAsset.valid, false);
  assert.equal(resultAsset.errors[0].code, 'INVALID_ASSET_ID');
});

test('Brand Tokens: Rejects Out-of-Bounds Border Radius', () => {
  const negativeRadius = { borderRadius: -5 };
  const excessiveRadius = { borderRadius: 150 };

  assert.equal(validateBrandTokens(negativeRadius).valid, false);
  assert.equal(validateBrandTokens(excessiveRadius).valid, false);
});

test('Brand Tokens: Safely Transforms Composition Spec', () => {
  const dummySpec = {
    schema_version: '1.0',
    canvas: {
      width: 720,
      height: 1280,
      background: '#000000',
    },
    fps: { num: 30, den: 1 },
    duration_frames: 450,
    seed: 1234,
    locale: 'vi-VN',
    direction: 'ltr',
    fonts: [{ id: 'font_custom_bold', asset_id: 'ast_f1', sha256: 'aa', family: 'Inter', weight: 700, style: 'normal' }],
    scenes: [
      {
        id: 'scene_promo',
        revision: 1,
        start_frame: 0,
        duration_frames: 450,
        engine: 'html-v1',
        transition_out: { type: 'cut', duration_frames: 0 },
        layers: [
          {
            id: 'layer_promo_headline',
            type: 'text',
            start_frame: 0,
            duration_frames: 450,
            z_index: 1,
            box: { x: 50, y: 100, width: 620, height: 100 },
            content: {
              text: 'Siêu Giảm Giá',
              font_id: 'font_initial',
              font_size: 48,
              color: '#111111',
            },
          },
          {
            id: 'layer_cta_button_bg',
            type: 'shape',
            start_frame: 0,
            duration_frames: 450,
            z_index: 2,
            box: { x: 50, y: 500, width: 200, height: 60 },
            content: {
              shape: 'rect',
              fill: '#222222',
              radius: 4,
            },
          },
          {
            id: 'layer_brand_logo',
            type: 'image',
            start_frame: 0,
            duration_frames: 450,
            z_index: 3,
            box: { x: 50, y: 50, width: 100, height: 100 },
            content: {
              asset_id: 'ast_default_logo',
              fit: 'contain',
            },
          },
        ],
      },
    ],
    audio_tracks: [],
    subtitles: [],
  };

  const tokens = {
    backgroundColor: '#1E293B',
    primaryColor: '#F59E0B',
    accentColor: '#EF4444',
    headingFontId: 'font_custom_bold',
    logoAssetId: 'ast_brand_logo_verified',
    borderRadius: 20,
  };

  const transformed = applyBrandTokens(dummySpec, tokens);

  // Background updated
  assert.equal(transformed.canvas.background, '#1E293B');

  // Headline text updated with primaryColor and headingFontId
  const headlineLayer = transformed.scenes[0].layers[0];
  assert.equal(headlineLayer.content.color, '#F59E0B');
  assert.equal(headlineLayer.content.font_id, 'font_custom_bold');

  // Shape updated with accentColor and borderRadius
  const shapeLayer = transformed.scenes[0].layers[1];
  assert.equal(shapeLayer.content.fill, '#EF4444');
  assert.equal(shapeLayer.content.radius, 20);

  // Logo asset updated
  const logoLayer = transformed.scenes[0].layers[2];
  assert.equal(logoLayer.content.asset_id, 'ast_brand_logo_verified');

  // Original spec remains unmodified (immutability)
  assert.equal(dummySpec.canvas.background, '#000000');
});
