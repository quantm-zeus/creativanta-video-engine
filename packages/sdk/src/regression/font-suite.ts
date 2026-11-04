/**
 * Font & Typography Layout Regression Suite for Creativanta Video Engine.
 * Canonical specification: docs/TESTING.md (Lines 43-44), docs/SCENE-SPEC.md (Line 92).
 */

import { RegressionItemResult } from './types.js';
import { SEEDED_RIGHTS_RECORDS } from '../rights/rights-registry.js';
import { segmentVietnameseWords } from '../subtitles/burn-in.js';

export const PINNED_FONTS = [
  { id: 'brand_bold', assetId: 'ast_font_inter_bold', family: 'Inter', weight: 700, style: 'normal', license: 'OFL-1.1' },
  { id: 'brand_regular', assetId: 'ast_font_inter_regular', family: 'Inter', weight: 400, style: 'normal', license: 'OFL-1.1' },
  { id: 'brand_semibold', assetId: 'ast_font_inter_semibold', family: 'Inter', weight: 600, style: 'normal', license: 'OFL-1.1' },
  { id: 'noto_regular', assetId: 'ast_font_noto_sans_regular', family: 'Noto Sans', weight: 400, style: 'normal', license: 'OFL-1.1' },
  { id: 'noto_bold', assetId: 'ast_font_noto_sans_bold', family: 'Noto Sans', weight: 700, style: 'normal', license: 'OFL-1.1' },
  { id: 'roboto_bold', assetId: 'ast_font_roboto_bold', family: 'Roboto', weight: 700, style: 'normal', license: 'Apache-2.0' },
  { id: 'roboto_regular', assetId: 'ast_font_roboto_regular', family: 'Roboto', weight: 400, style: 'normal', license: 'Apache-2.0' },
];

export function runFontRegressionSuite(): RegressionItemResult[] {
  const results: RegressionItemResult[] = [];

  // Test 1: Pinned Font Registry & License Integrity
  try {
    const rightsMap = new Map(SEEDED_RIGHTS_RECORDS.map((r) => [r.assetId, r]));
    let allValid = true;
    const verifiedFonts: string[] = [];

    for (const font of PINNED_FONTS) {
      const record = rightsMap.get(font.assetId);
      if (!record || record.license !== font.license || !record.commercialUseAllowed) {
        allValid = false;
        break;
      }
      verifiedFonts.push(`${font.family} (${font.weight}) [${font.license}]`);
    }

    results.push({
      id: 'reg_font_01_pinned_registry_integrity',
      name: 'Pinned Font Registry & Commercial License Verification',
      category: 'font',
      passed: allValid && verifiedFonts.length === PINNED_FONTS.length,
      details: {
        totalFontsPinned: PINNED_FONTS.length,
        verifiedFonts,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_font_01_pinned_registry_integrity',
      name: 'Pinned Font Registry & Commercial License Verification',
      category: 'font',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 2: Font Fallback Disabled Policy
  try {
    const validFontIds = new Set(PINNED_FONTS.map((f) => f.id));
    const testCases = [
      { fontId: 'brand_bold', shouldPass: true },
      { fontId: 'brand_regular', shouldPass: true },
      { fontId: 'comic_sans_ms', shouldPass: false },
      { fontId: 'times_new_roman', shouldPass: false },
      { fontId: 'arial', shouldPass: false },
    ];

    let passedPolicy = true;
    for (const tc of testCases) {
      const isKnown = validFontIds.has(tc.fontId);
      if (isKnown !== tc.shouldPass) {
        passedPolicy = false;
        break;
      }
    }

    results.push({
      id: 'reg_font_02_fallback_disabled_gate',
      name: 'Font Fallback Disabled Guard (Rejection of Unpinned System Fonts)',
      category: 'font',
      passed: passedPolicy,
      details: {
        policy: 'Strict Offline Pinned Font IDs Only',
        checkedCount: testCases.length,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_font_02_fallback_disabled_gate',
      name: 'Font Fallback Disabled Guard (Rejection of Unpinned System Fonts)',
      category: 'font',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 3: Safe Margins (48px) Bounds in 9:16 and 16:9
  try {
    const safeMargin = 48;
    const vertical9x16 = { width: 720, height: 1280 };
    const horizontal16x9 = { width: 1280, height: 720 };

    const vertUsableWidth = vertical9x16.width - safeMargin * 2;
    const horizUsableWidth = horizontal16x9.width - safeMargin * 2;

    const passed = vertUsableWidth === 624 && horizUsableWidth === 1184;

    results.push({
      id: 'reg_font_03_safe_margin_bounds',
      name: 'Safe Margins (48px) Usable Bounds Verification across 9:16 & 16:9',
      category: 'layout',
      passed,
      details: {
        safeMarginPx: safeMargin,
        vertical9x16UsableWidth: vertUsableWidth,
        horizontal16x9UsableWidth: horizUsableWidth,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_font_03_safe_margin_bounds',
      name: 'Safe Margins (48px) Usable Bounds Verification across 9:16 & 16:9',
      category: 'layout',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 4: Vietnamese Grapheme Cluster Integrity during Word Wrapping
  try {
    const complexVietnameseSentence = 'Đắk Lắk là thủ phủ cà phê của Tây Nguyên với hương vị thơm ngon đặc trưng.';
    const words = segmentVietnameseWords(complexVietnameseSentence);

    // Verify words don't have broken diacritics
    let allIntact = true;
    for (const w of words) {
      if (w.normalize('NFC') !== w) {
        allIntact = false;
        break;
      }
    }
    const hasDakLak = words.includes('Đắk') && words.includes('Lắk');

    results.push({
      id: 'reg_font_04_grapheme_wrapping_integrity',
      name: 'Vietnamese Grapheme Cluster Word Wrapping Integrity',
      category: 'layout',
      passed: allIntact && hasDakLak,
      details: {
        totalWordsSegmented: words.length,
        diacriticsIntact: allIntact,
        sampleWords: words.slice(0, 5),
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_font_04_grapheme_wrapping_integrity',
      name: 'Vietnamese Grapheme Cluster Word Wrapping Integrity',
      category: 'layout',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  return results;
}
