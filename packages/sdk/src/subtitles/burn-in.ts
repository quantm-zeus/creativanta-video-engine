/**
 * Subtitle Burn-In & Layout Engine for Creativanta Video Engine.
 * Handles Vietnamese grapheme-aware text layout, safe-margin bounds, and composition integration.
 * Canonical specification: docs/SCENE-SPEC.md (Line 90-93), docs/TESTING.md.
 */

import {
  SubtitleCue,
  SubtitleStyleSpec,
  SubtitleTrackSpec,
  CompositionSpec,
} from '@creativanta/contracts';
import { SubtitleLayoutResult, SubtitleLayoutLine, SubtitleBurnInOptions } from './types.js';

export const DEFAULT_SAFE_MARGIN_PX = 48;
export const DEFAULT_SUBTITLE_MAX_LINES = 2;
export const DEFAULT_SUBTITLE_FONT_SIZE = 36;

/**
 * Approximates single character rendered advance width for proportional fonts (Inter / Noto Sans / Roboto).
 * Vietnamese diacritic combining marks (U+0300 - U+036F) have 0 advance width.
 */
function getCharAdvance(char: string, fontSize: number): number {
  const code = char.codePointAt(0) || 0;

  // Zero-width combining diacritics
  if (code >= 0x0300 && code <= 0x036F) {
    return 0;
  }

  // Narrow glyphs
  if ('ijl1I!|:;.,\'"()[]-'.includes(char)) {
    return fontSize * 0.28;
  }

  // Wide glyphs
  if ('WM%@#&₫'.includes(char)) {
    return fontSize * 0.88;
  }

  // Capital letters and numbers
  if ((code >= 65 && code <= 90) || (code >= 48 && code <= 57)) {
    return fontSize * 0.62;
  }

  // Standard lowercase latin / Vietnamese base glyphs
  return fontSize * 0.52;
}

/**
 * Measures the rendered width of a word or grapheme cluster in pixels.
 */
export function measureWordWidth(word: string, fontSize: number): number {
  let width = 0;
  for (const ch of word) {
    width += getCharAdvance(ch, fontSize);
  }
  return width;
}

/**
 * Splits text into words while strictly preserving Vietnamese grapheme clusters.
 * Uses Intl.Segmenter with word and grapheme granularity.
 */
export function segmentVietnameseWords(text: string): string[] {
  const normalized = text.normalize('NFC').trim();
  if (!normalized) return [];

  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter('vi-VN', { granularity: 'word' });
    const words: string[] = [];
    let currentWord = '';

    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike) {
        if (currentWord) {
          words.push(currentWord);
          currentWord = '';
        }
        words.push(segment.segment);
      } else {
        // Space or punctuation
        const nonWord = segment.segment;
        if (nonWord.trim() === '') {
          // Whitespace ends current word
          if (currentWord) {
            words.push(currentWord);
            currentWord = '';
          }
        } else {
          // Punctuation attached to preceding word
          if (words.length > 0) {
            words[words.length - 1] += nonWord;
          } else {
            currentWord += nonWord;
          }
        }
      }
    }
    if (currentWord) {
      words.push(currentWord);
    }
    return words.length > 0 ? words : normalized.split(/\s+/);
  }

  // Fallback if Intl.Segmenter unavailable
  return normalized.split(/\s+/);
}

/**
 * Calculates subtitle layout, word-wrapping, and bounding dimensions.
 */
export function calculateSubtitleLayout(
  cue: SubtitleCue,
  style: SubtitleStyleSpec,
  canvasWidth: number,
  canvasHeight: number
): SubtitleLayoutResult {
  const fontSize = style.font_size || DEFAULT_SUBTITLE_FONT_SIZE;
  const safeMarginPx = style.safe_margin_px ?? DEFAULT_SAFE_MARGIN_PX;
  const maxLines = style.max_lines ?? DEFAULT_SUBTITLE_MAX_LINES;

  const availableWidth = Math.max(100, canvasWidth - safeMarginPx * 2);
  const spaceWidth = fontSize * 0.28;
  const lineHeight = Math.round(fontSize * 1.35);

  const words = segmentVietnameseWords(cue.text);
  const lines: SubtitleLayoutLine[] = [];

  let currentLineWords: string[] = [];
  let currentLineWidth = 0;

  for (const word of words) {
    const wordWidth = measureWordWidth(word, fontSize);

    if (currentLineWords.length === 0) {
      currentLineWords.push(word);
      currentLineWidth = wordWidth;
    } else {
      const candidateWidth = currentLineWidth + spaceWidth + wordWidth;
      if (candidateWidth <= availableWidth) {
        currentLineWords.push(word);
        currentLineWidth = candidateWidth;
      } else {
        // Push current line and start new one
        lines.push({
          text: currentLineWords.join(' '),
          width: currentLineWidth,
        });
        currentLineWords = [word];
        currentLineWidth = wordWidth;
      }
    }
  }

  if (currentLineWords.length > 0) {
    lines.push({
      text: currentLineWords.join(' '),
      width: currentLineWidth,
    });
  }

  const lineCount = lines.length;
  const totalHeight = lineCount * lineHeight;
  const maxLineWidth = lines.reduce((max, l) => Math.max(max, l.width), 0);

  const fitsMaxLines = lineCount <= maxLines;
  const fitsSafeMargin = maxLineWidth <= availableWidth && totalHeight <= (canvasHeight - safeMarginPx * 2);
  const overflowDetected = !fitsMaxLines || !fitsSafeMargin;

  return {
    cueId: cue.id,
    lines,
    lineCount,
    totalHeight,
    fitsMaxLines,
    fitsSafeMargin,
    overflowDetected,
    maxLineWidth: Math.round(maxLineWidth * 10) / 10,
    availableWidth,
  };
}

/**
 * Finds the active subtitle cue for a given global frame index, if any.
 */
export function getActiveSubtitleCue(
  subtitles: SubtitleTrackSpec[] | undefined,
  globalFrame: number
): { track: SubtitleTrackSpec; cue: SubtitleCue } | null {
  if (!subtitles || subtitles.length === 0) return null;

  for (const track of subtitles) {
    const cues = track.cues || [];
    for (const cue of cues) {
      if (globalFrame >= cue.start_frame && globalFrame < cue.end_frame) {
        return { track, cue };
      }
    }
  }

  return null;
}

/**
 * Integrates or updates a subtitle track into a CompositionSpec with burn-in configuration.
 */
export function applySubtitlesToComposition(
  spec: CompositionSpec,
  track: SubtitleTrackSpec,
  options: SubtitleBurnInOptions
): CompositionSpec {
  const safeMarginPx = options.safeMarginPx ?? DEFAULT_SAFE_MARGIN_PX;
  const maxLines = options.maxLines ?? DEFAULT_SUBTITLE_MAX_LINES;
  const fontSize = options.defaultFontSize ?? DEFAULT_SUBTITLE_FONT_SIZE;
  const fontId = options.defaultFontId || (spec.fonts.length > 0 ? spec.fonts[0]!.id : 'brand_regular');
  const color = options.defaultColor || '#FFFFFF';

  // Ensure style is defined
  const style: SubtitleStyleSpec = {
    font_id: track.style?.font_id || fontId,
    font_size: track.style?.font_size || fontSize,
    color: track.style?.color || color,
    background: track.style?.background || '#000000B3',
    align: track.style?.align || 'center',
    max_lines: track.style?.max_lines || maxLines,
    safe_margin_px: track.style?.safe_margin_px || safeMarginPx,
  };

  // Verify cues are within duration
  for (const cue of track.cues) {
    if (cue.end_frame > spec.duration_frames) {
      throw new Error(
        `Subtitle cue '${cue.id}' end_frame (${cue.end_frame}) exceeds composition duration (${spec.duration_frames})`
      );
    }
  }

  const updatedTrack: SubtitleTrackSpec = {
    ...track,
    burn_in: true,
    style,
  };

  const existingIndex = spec.subtitles.findIndex((t) => t.id === track.id);
  const updatedSubtitles = [...spec.subtitles];

  if (existingIndex >= 0) {
    updatedSubtitles[existingIndex] = updatedTrack;
  } else if (options.replaceExisting) {
    updatedSubtitles.length = 0;
    updatedSubtitles.push(updatedTrack);
  } else {
    updatedSubtitles.push(updatedTrack);
  }

  return {
    ...spec,
    subtitles: updatedSubtitles,
  };
}
