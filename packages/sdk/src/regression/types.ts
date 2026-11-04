/**
 * Regression Matrix Types for Creativanta Video Engine.
 * Canonical specification: docs/TESTING.md (Lines 37-51), docs/SCENE-SPEC.md.
 */

export type RegressionCategory = 'locale' | 'font' | 'audio' | 'sync' | 'layout';

export interface RegressionItemResult {
  id: string;
  name: string;
  category: RegressionCategory;
  passed: boolean;
  details: Record<string, unknown>;
  error?: string;
}

export interface CategorySummary {
  total: number;
  passed: number;
  failed: number;
}

export interface RegressionMatrixReport {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
  timestamp: string;
  categories: Record<RegressionCategory, CategorySummary>;
  results: RegressionItemResult[];
}
