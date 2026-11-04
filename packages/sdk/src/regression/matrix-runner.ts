/**
 * Regression Matrix Runner for Creativanta Video Engine.
 * Executes full Locale, Font, and Audio regression suites and produces structured verification reports.
 * Canonical specification: docs/TESTING.md (Lines 37-51), docs/SCENE-SPEC.md.
 */

import { RegressionMatrixReport, RegressionCategory, CategorySummary, RegressionItemResult } from './types.js';
import { runLocaleRegressionSuite } from './locale-suite.js';
import { runFontRegressionSuite } from './font-suite.js';
import { runAudioRegressionSuite } from './audio-suite.js';

export function runRegressionMatrix(): RegressionMatrixReport {
  const startTime = Date.now();

  const localeResults = runLocaleRegressionSuite();
  const fontResults = runFontRegressionSuite();
  const audioResults = runAudioRegressionSuite();

  const allResults: RegressionItemResult[] = [
    ...localeResults,
    ...fontResults,
    ...audioResults,
  ];

  const categories: Record<RegressionCategory, CategorySummary> = {
    locale: { total: 0, passed: 0, failed: 0 },
    font: { total: 0, passed: 0, failed: 0 },
    layout: { total: 0, passed: 0, failed: 0 },
    audio: { total: 0, passed: 0, failed: 0 },
    sync: { total: 0, passed: 0, failed: 0 },
  };

  let totalPassed = 0;
  let totalFailed = 0;

  for (const item of allResults) {
    const cat = categories[item.category];
    if (cat) {
      cat.total++;
      if (item.passed) {
        cat.passed++;
        totalPassed++;
      } else {
        cat.failed++;
        totalFailed++;
      }
    }
  }

  const durationMs = Date.now() - startTime;

  return {
    passed: totalFailed === 0,
    totalTests: allResults.length,
    passedTests: totalPassed,
    failedTests: totalFailed,
    durationMs,
    timestamp: new Date().toISOString(),
    categories,
    results: allResults,
  };
}
