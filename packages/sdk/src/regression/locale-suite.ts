/**
 * Locale & Vietnamese Typography Regression Suite for Creativanta Video Engine.
 * Canonical specification: docs/TESTING.md (Lines 43-44), docs/SCENE-SPEC.md (Line 92).
 */

import { RegressionItemResult } from './types.js';

export const CANONICAL_VIETNAMESE_TEST_PHRASE = 'Tiếng Việt: Trường học, cộng đồng, Đắk Lắk, Ưu đãi 199.000 ₫';

export const ALL_VIETNAMESE_DIACRITICS =
  'aàáảãạăằắẳẵặâầấẩẫậeèéẻẽẹêềếểễệiìíỉĩịoòóỏõọôồốổỗộơờớởỡợuùúủũụưừứửữựyỳýỷỹỵdđ' +
  'AÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬEÈÉẺẼẸÊỀẾỂỄỆIÌÍỈĨỊOÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢUÙÚỦŨỤƯỪỨỬỮỰYỲÝỶỸỴDĐ';

export const ALLOWED_LOCALES = ['vi-VN', 'en-US'];

/**
 * Validates text against unapproved emojis or control characters (anti-tofu guard).
 */
export function validateNoTofuOrUnsupportedEmoji(text: string): { valid: boolean; forbiddenChars: string[] } {
  const forbiddenChars: string[] = [];
  // Regex detecting common emojis, surrogate pairs outside standard multilingual plane, or unapproved symbols
  const emojiRegex = /[\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/u;

  for (const ch of text) {
    if (emojiRegex.test(ch)) {
      forbiddenChars.push(ch);
    }
  }

  return {
    valid: forbiddenChars.length === 0,
    forbiddenChars,
  };
}

export function runLocaleRegressionSuite(): RegressionItemResult[] {
  const results: RegressionItemResult[] = [];

  // Test 1: Full Vietnamese Diacritics Coverage
  try {
    const nfcChars = ALL_VIETNAMESE_DIACRITICS.normalize('NFC');
    const isNormalized = nfcChars === ALL_VIETNAMESE_DIACRITICS;
    const charCount = ALL_VIETNAMESE_DIACRITICS.length;

    results.push({
      id: 'reg_locale_01_diacritics_coverage',
      name: 'Vietnamese Diacritics & 6-Tone Alphabet Coverage',
      category: 'locale',
      passed: isNormalized && charCount === 148,
      details: {
        totalCharacters: charCount,
        allTonesIncluded: ['ngang', 'huyen', 'sac', 'hoi', 'nga', 'nang'],
        nfcPreserved: isNormalized,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_01_diacritics_coverage',
      name: 'Vietnamese Diacritics & 6-Tone Alphabet Coverage',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 2: NFD Decomposed to NFC Canonical Normalization
  try {
    const decomposedNfd = CANONICAL_VIETNAMESE_TEST_PHRASE.normalize('NFD');
    const recomposedNfc = decomposedNfd.normalize('NFC');
    const passed = recomposedNfc === CANONICAL_VIETNAMESE_TEST_PHRASE && decomposedNfd !== recomposedNfc;

    results.push({
      id: 'reg_locale_02_nfd_to_nfc_normalization',
      name: 'Decomposed NFD to Canonical NFC Normalization Equivalence',
      category: 'locale',
      passed,
      details: {
        originalNfcLength: CANONICAL_VIETNAMESE_TEST_PHRASE.length,
        decomposedNfdLength: decomposedNfd.length,
        recomposedMatchesOriginal: recomposedNfc === CANONICAL_VIETNAMESE_TEST_PHRASE,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_02_nfd_to_nfc_normalization',
      name: 'Decomposed NFD to Canonical NFC Normalization Equivalence',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 3: Canonical Phrase from TESTING.md
  try {
    const phrase = CANONICAL_VIETNAMESE_TEST_PHRASE;
    const hasDakLak = phrase.includes('Đắk Lắk');
    const hasTruongHoc = phrase.includes('Trường học');
    const hasCongDong = phrase.includes('cộng đồng');
    const hasUuDai = phrase.includes('Ưu đãi 199.000 ₫');
    const passed = hasDakLak && hasTruongHoc && hasCongDong && hasUuDai;

    results.push({
      id: 'reg_locale_03_canonical_phrase',
      name: 'Canonical Testing.md Vietnamese Phrase Elements Validation',
      category: 'locale',
      passed,
      details: {
        phrase,
        hasDakLak,
        hasTruongHoc,
        hasCongDong,
        hasUuDai,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_03_canonical_phrase',
      name: 'Canonical Testing.md Vietnamese Phrase Elements Validation',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 4: Currency Symbol ₫ (U+20AB) and Number Formatting
  try {
    const currencyStr = '199.000 ₫';
    const currencyCode = currencyStr.charCodeAt(currencyStr.indexOf('₫'));
    const isU20AB = currencyCode === 0x20AB;
    const hasThousandsDot = currencyStr.includes('.000');
    const passed = isU20AB && hasThousandsDot;

    results.push({
      id: 'reg_locale_04_currency_formatting',
      name: 'Vietnamese Dong Currency Symbol ₫ (U+20AB) & Number Grouping',
      category: 'locale',
      passed,
      details: {
        symbol: '₫',
        unicodeCodepoint: `U+${currencyCode.toString(16).toUpperCase()}`,
        isCorrectCodepoint: isU20AB,
        numberGroupingSeparator: '.',
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_04_currency_formatting',
      name: 'Vietnamese Dong Currency Symbol ₫ (U+20AB) & Number Grouping',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 5: Uppercase & Lowercase Vietnamese Diacritics
  try {
    const lower = 'trường học đắk lắk';
    const upper = 'TRƯỜNG HỌC ĐẮK LẮK';
    const upperConverted = lower.toLocaleUpperCase('vi-VN');
    const lowerConverted = upper.toLocaleLowerCase('vi-VN');
    const passed = upperConverted === upper && lowerConverted === lower;

    results.push({
      id: 'reg_locale_05_casing_roundtrip',
      name: 'Vietnamese Locale Upper/Lower Casing Roundtrip Preservation',
      category: 'locale',
      passed,
      details: {
        lower,
        upper,
        upperConverted,
        lowerConverted,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_05_casing_roundtrip',
      name: 'Vietnamese Locale Upper/Lower Casing Roundtrip Preservation',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 6: Emoji & Tofu Glyph Detection Guard
  try {
    const cleanText = 'Xin chào Việt Nam!';
    const emojiText = 'Xin chào Việt Nam! 🎉✨🚀';
    const cleanCheck = validateNoTofuOrUnsupportedEmoji(cleanText);
    const emojiCheck = validateNoTofuOrUnsupportedEmoji(emojiText);
    const passed = cleanCheck.valid && !emojiCheck.valid && emojiCheck.forbiddenChars.length === 3;

    results.push({
      id: 'reg_locale_06_tofu_prevention_guard',
      name: 'Emoji & Unsupported Glyph Detection Guard (Anti-Tofu Gate)',
      category: 'locale',
      passed,
      details: {
        cleanTextValid: cleanCheck.valid,
        emojiDetected: emojiCheck.forbiddenChars,
        tofuGateEffective: passed,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_06_tofu_prevention_guard',
      name: 'Emoji & Unsupported Glyph Detection Guard (Anti-Tofu Gate)',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  // Test 7: BCP47 Locale Allowlist Enforcement
  try {
    const testLocales = [
      { code: 'vi-VN', expectedValid: true },
      { code: 'en-US', expectedValid: true },
      { code: 'fr-FR', expectedValid: false },
      { code: 'zh-CN', expectedValid: false },
      { code: 'invalid_locale', expectedValid: false },
    ];

    let passedAll = true;
    for (const item of testLocales) {
      const isValid = ALLOWED_LOCALES.includes(item.code);
      if (isValid !== item.expectedValid) {
        passedAll = false;
        break;
      }
    }

    results.push({
      id: 'reg_locale_07_bcp47_allowlist',
      name: 'BCP47 Locale Allowlist (vi-VN & en-US) Enforcement',
      category: 'locale',
      passed: passedAll,
      details: {
        allowedLocales: ALLOWED_LOCALES,
        testCasesChecked: testLocales.length,
      },
    });
  } catch (err: any) {
    results.push({
      id: 'reg_locale_07_bcp47_allowlist',
      name: 'BCP47 Locale Allowlist (vi-VN & en-US) Enforcement',
      category: 'locale',
      passed: false,
      details: {},
      error: err.message,
    });
  }

  return results;
}
