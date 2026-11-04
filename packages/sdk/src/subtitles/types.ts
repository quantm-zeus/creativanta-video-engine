/**
 * Subtitle Workflow Types & Interfaces for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md (Line 90-93), docs/TESTING.md.
 */

import { RationalFps } from '@creativanta/contracts';

export type SubtitleFormat = 'srt' | 'vtt';

export interface ImportSubtitleOptions {
  fps?: RationalFps;
  durationFrames?: number;
  maxCues?: number;
  maxCharsPerCue?: number;
  targetLocale?: 'vi-VN' | 'en-US';
  stripHtml?: boolean;
  validateOverlap?: boolean;
  idPrefix?: string;
}

export interface SubtitleSidecarResult {
  srt: string;
  vtt: string;
  cuesCount: number;
  durationMs: number;
  locale: string;
}

export interface SubtitleLayoutLine {
  text: string;
  width: number;
}

export interface SubtitleLayoutResult {
  cueId: string;
  lines: SubtitleLayoutLine[];
  lineCount: number;
  totalHeight: number;
  fitsMaxLines: boolean;
  fitsSafeMargin: boolean;
  overflowDetected: boolean;
  maxLineWidth: number;
  availableWidth: number;
}

export interface SubtitleBurnInOptions {
  canvasWidth: number;
  canvasHeight: number;
  safeMarginPx?: number;
  maxLines?: number;
  defaultFontId?: string;
  defaultFontSize?: number;
  defaultColor?: string;
  replaceExisting?: boolean;
}

export interface SubtitleValidationResult {
  valid: boolean;
  cuesCount: number;
  errors: string[];
  warnings: string[];
}
