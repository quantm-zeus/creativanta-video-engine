import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TextOverflowError,
  BrandTokenError,
} from '@creativanta/sdk';

import {
  RETAIL_PROMO_TEMPLATE_V1,
  NARRATED_EXPLAINER_TEMPLATE_V1,
  CAPTIONED_STORY_TEMPLATE_V1,
  instantiateCuratedTemplate,
  regenerateTemplate,
} from '../dist/index.js';

test('User Edits: Instantiates Retail Promo with Custom Variables & Safe Brand Tokens', () => {
  const customVariables = {
    headline: 'Flash Sale Giày Thể Thao',
    discount_text: 'Giảm 60%',
    price_text: '299.000 ₫',
    cta_text: 'Đặt Hàng Liền Tay',
  };

  const customBrandTokens = {
    backgroundColor: '#0F172A',
    primaryColor: '#F59E0B',
    accentColor: '#EF4444',
    secondaryColor: '#10B981',
    headingFontId: 'font_promo_bold',
  };

  const result = instantiateCuratedTemplate(RETAIL_PROMO_TEMPLATE_V1, {
    variables: customVariables,
    brandTokens: customBrandTokens,
    locale: 'vi-VN',
  });

  assert.ok(result.compositionSpec);
  assert.ok(result.manifest);
  assert.equal(result.compositionSpec.canvas.background, '#0F172A');

  // Verify headline replaced
  const headlineLayer = result.compositionSpec.scenes[0].layers[0];
  assert.equal(headlineLayer.content.text, 'Flash Sale Giày Thể Thao');
  assert.equal(headlineLayer.content.color, '#F59E0B');

  // Verify price replaced
  const priceLayer = result.compositionSpec.scenes[1].layers[0];
  assert.equal(priceLayer.content.text, '299.000 ₫');
  assert.equal(priceLayer.content.color, '#EF4444');

  // Verify CTA replaced
  const ctaLayer = result.compositionSpec.scenes[2].layers[0];
  assert.equal(ctaLayer.content.text, 'Đặt Hàng Liền Tay');
  assert.equal(ctaLayer.content.color, '#10B981');

  // Verify compiled manifest matches exact durations
  assert.equal(result.manifest.duration_frames, 450);
  assert.equal(result.manifest.duration_seconds, 15);
});

test('User Edits: Instantiates Captioned Story with Real Footage and Multi-Track Audio', () => {
  const customVariables = {
    title_text: 'CÀ PHÊ NGUYÊN BẢN 2026',
    location_tag: 'Đắk Lắk • Việt Nam',
    story_quote: 'Chắt chiu từng giọt đậm đà bản sắc vùng cao',
    cta_text: 'Thưởng thức tại coffee.creativanta.vn',
  };

  const result = instantiateCuratedTemplate(CAPTIONED_STORY_TEMPLATE_V1, {
    variables: customVariables,
    locale: 'vi-VN',
  });

  assert.equal(result.manifest.duration_frames, 1350);
  assert.equal(result.manifest.duration_seconds, 45);
  assert.equal(result.manifest.scenes.length, 3);
  assert.equal(result.manifest.audio_tracks.length, 2);

  // Check scene 1 title
  const s0Title = result.compositionSpec.scenes[0].layers[1];
  assert.equal(s0Title.content.text, 'CÀ PHÊ NGUYÊN BẢN 2026');

  // Check scene 2 quote
  const s1Quote = result.compositionSpec.scenes[1].layers[1];
  assert.equal(s1Quote.content.text, 'Chắt chiu từng giọt đậm đà bản sắc vùng cao');
});

test('User Edits: Regenerates Composition into Revision 2 with Incrementing Revisions', () => {
  // 1. Initial instantiation (Revision 1)
  const baseResult = instantiateCuratedTemplate(NARRATED_EXPLAINER_TEMPLATE_V1);
  const baseSpec = baseResult.compositionSpec;
  assert.equal(baseSpec.scenes[0].revision, 1);
  assert.equal(baseSpec.scenes[1].revision, 1);

  // 2. User edits scene 1 headline
  const edits = {
    problem_text: 'Bạn đang tốn quá nhiều thời gian dựng video marketing?',
  };

  const regenResult = regenerateTemplate(NARRATED_EXPLAINER_TEMPLATE_V1, baseSpec, {
    edits,
    changeNote: 'Cập nhật câu hỏi mở đầu phân cảnh 1',
  });

  const newSpec = regenResult.compositionSpec;
  const comparison = regenResult.revisionComparison;

  // Scene IDs remain stable
  assert.equal(newSpec.scenes[0].id, baseSpec.scenes[0].id);
  assert.equal(newSpec.scenes[1].id, baseSpec.scenes[1].id);
  assert.equal(newSpec.scenes[2].id, baseSpec.scenes[2].id);
  assert.equal(newSpec.scenes[3].id, baseSpec.scenes[3].id);

  // Scene 1 revision incremented from 1 to 2
  assert.equal(newSpec.scenes[0].revision, 2);
  // Unchanged scene remains revision 1
  assert.equal(newSpec.scenes[1].revision, 1);

  // Comparison confirms modified scene
  assert.equal(comparison.valid, true);
  assert.equal(comparison.is_render_affecting, true);
  const modified = comparison.scene_diffs.filter((s) => s.status === 'modified');
  assert.equal(modified.length, 1);
  assert.equal(modified[0].scene_id, 'scene_problem');
  assert.equal(modified[0].base_revision, 1);
  assert.equal(modified[0].new_revision, 2);

  // Manifest compiles cleanly
  assert.equal(regenResult.manifest.duration_frames, 900);
});

test('User Edits: Rejects Dangerous Brand Tokens Injection Traps', () => {
  const maliciousTokens = [
    { primaryColor: 'red; background: url(https://evil.com/xss)' },
    { primaryColor: '<script>document.location="http://evil.com"</script>' },
    { primaryColor: '#XYZ123' }, // Invalid hex
    { headingFontId: 'font_untrusted_external' }, // Unpinned font
  ];

  for (const tokens of maliciousTokens) {
    assert.throws(
      () =>
        instantiateCuratedTemplate(RETAIL_PROMO_TEMPLATE_V1, {
          brandTokens: tokens,
        }),
      BrandTokenError,
    );
  }
});

test('User Edits: Preflight Layout Rejects Overflowing Text in Error Mode', () => {
  // 92 characters: within maxLength: 100, but wraps to 4 lines at 48px in 624px box (exceeding max_lines: 3)
  const overflowingVariables = {
    headline:
      'Ưu đãi đặc biệt cực sốc nhân dịp khai trương chi nhánh mới giảm giá toàn bộ sản phẩm cao cấp',
  };

  assert.throws(
    () =>
      instantiateCuratedTemplate(RETAIL_PROMO_TEMPLATE_V1, {
        variables: overflowingVariables,
        checkOverflow: true,
      }),
    (err) => {
      assert.ok(err instanceof TextOverflowError);
      assert.equal(err.details[0].code, 'TEXT_OVERFLOW');
      assert.ok(err.details[0].message.includes('exceeding max_lines'));
      return true;
    },
  );
});

test('User Edits: Rejects Unsupported Locales with Clear Error', () => {
  assert.throws(
    () =>
      instantiateCuratedTemplate(RETAIL_PROMO_TEMPLATE_V1, {
        locale: 'fr-FR', // Not in ['vi-VN', 'en-US']
      }),
    /Locale 'fr-FR' is not supported/,
  );
});

test('User Edits: Vietnamese Diacritics NFC Normalization Preservation', () => {
  // Test with decomposed NFD characters
  const nfdHeadline = 'Ưu đãi đặc biệt hôm nay'.normalize('NFD');
  assert.notEqual(nfdHeadline, 'Ưu đãi đặc biệt hôm nay'.normalize('NFC'));

  const result = instantiateCuratedTemplate(RETAIL_PROMO_TEMPLATE_V1, {
    variables: {
      headline: nfdHeadline,
    },
  });

  const materializedText = result.compositionSpec.scenes[0].layers[0].content.text;
  // Materialized text must be strictly normalized to NFC
  assert.equal(materializedText, 'Ưu đãi đặc biệt hôm nay'.normalize('NFC'));
});
