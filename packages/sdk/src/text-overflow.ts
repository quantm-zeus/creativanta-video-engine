/**
 * Preflight Text Layout and Overflow Calculation Engine.
 * Canonical specification: docs/SCENE-SPEC.md (lines 64, 92) and docs/TESTING.md.
 */

import { CompositionSpec, TextLayerContent } from '@creativanta/contracts';

export type TextOverflowMode = 'error' | 'shrink' | 'ellipsis';

export interface TextLayoutOptions {
  text: string;
  fontSize: number;
  lineHeight?: number;
  box: {
    width: number;
    height: number;
  };
  maxLines?: number;
  minFontSize?: number;
  overflow?: TextOverflowMode;
  locale?: string;
}

export interface TextLayoutResult {
  fits: boolean;
  computedFontSize: number;
  renderedLines: string[];
  lineCount: number;
  maxLines: number;
  requiredWidth: number;
  requiredHeight: number;
  boxWidth: number;
  boxHeight: number;
  overflowDetected: boolean;
  overflowMode: TextOverflowMode;
  overflowReason?: string;
  truncatedText?: string;
}

export interface TextOverflowDetail {
  sceneId: string;
  layerId: string;
  pointer: string;
  code: 'TEXT_OVERFLOW';
  message: string;
  lineCount: number;
  maxLines: number;
  requiredHeight: number;
  boxHeight: number;
  boxWidth: number;
  textSnippet: string;
}

export class TextOverflowError extends Error {
  public readonly details: TextOverflowDetail[];

  constructor(message: string, details: TextOverflowDetail[]) {
    super(message);
    this.name = 'TextOverflowError';
    this.details = details;
  }
}

/**
 * Estimates the width of a single character in pixels given a font size,
 * taking into account typical typography metrics (proportional widths for Latin & Vietnamese).
 */
export function estimateCharAdvance(char: string, fontSize: number): number {
  // Combining diacritical marks have 0 advance width in NFC/NFD
  if (/[\u0300-\u036f]/.test(char)) {
    return 0;
  }

  // Whitespace
  if (char === ' ') return fontSize * 0.28;
  if (char === '\t') return fontSize * 0.56;

  // Narrow characters: i, l, j, I, t, !, :, ;, ., ,, ', |, 1
  if (/[iljIt!:;.,'|1]/.test(char)) {
    return fontSize * 0.32;
  }

  // Wide characters: W, w, M, m, @, %, ₫
  if (/[WwMm@%₫]/.test(char)) {
    return fontSize * 0.85;
  }

  // Standard uppercase & numerals: A-Z, 0, 2-9
  if (/[A-Z02-9]/.test(char)) {
    return fontSize * 0.65;
  }

  // Standard Vietnamese diacritic vowels (ă, â, đ, ê, ô, ơ, ư, etc.) and lowercase Latin
  return fontSize * 0.54;
}

/**
 * Estimates the total rendered width of a string in design pixels.
 */
export function estimateStringWidth(str: string, fontSize: number): number {
  let width = 0;
  for (const char of str) {
    width += estimateCharAdvance(char, fontSize);
  }
  return width;
}

/**
 * Wraps text into lines based on box width and word boundaries.
 */
export function wrapTextToLines(text: string, fontSize: number, boxWidth: number): string[] {
  const normalized = text.normalize('NFC');
  const explicitParagraphs = normalized.split(/\r?\n/);
  const resultLines: string[] = [];

  for (const paragraph of explicitParagraphs) {
    if (paragraph.length === 0) {
      resultLines.push('');
      continue;
    }

    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      resultLines.push('');
      continue;
    }

    let currentLine = '';
    let currentLineWidth = 0;
    const spaceWidth = estimateCharAdvance(' ', fontSize);

    for (const word of words) {
      const wordWidth = estimateStringWidth(word, fontSize);

      if (currentLine.length === 0) {
        currentLine = word;
        currentLineWidth = wordWidth;
      } else {
        const potentialWidth = currentLineWidth + spaceWidth + wordWidth;
        if (potentialWidth <= boxWidth) {
          currentLine += ' ' + word;
          currentLineWidth = potentialWidth;
        } else {
          // Push current line and start a new line with word
          resultLines.push(currentLine);
          currentLine = word;
          currentLineWidth = wordWidth;
        }
      }
    }

    if (currentLine.length > 0) {
      resultLines.push(currentLine);
    }
  }

  return resultLines;
}

/**
 * Calculates text layout against container constraints with support for
 * 'error', 'shrink', and 'ellipsis' overflow strategies.
 */
export function calculateTextLayout(options: TextLayoutOptions): TextLayoutResult {
  const {
    text,
    fontSize: initialFontSize,
    lineHeight = 1.2,
    box,
    maxLines = 5,
    minFontSize = initialFontSize,
    overflow = 'error',
  } = options;

  let currentFontSize = initialFontSize;
  const effectiveMinFontSize = Math.min(minFontSize, initialFontSize);

  // If shrink mode, iteratively reduce font size until it fits or reaches minFontSize
  if (overflow === 'shrink') {
    while (currentFontSize >= effectiveMinFontSize) {
      const lines = wrapTextToLines(text, currentFontSize, box.width);
      const effectiveLineHeight = currentFontSize * lineHeight;
      const totalHeight = lines.length * effectiveLineHeight;

      const fitsLines = lines.length <= maxLines;
      const fitsHeight = totalHeight <= box.height + 0.5; // slight floating tolerance

      if (fitsLines && fitsHeight) {
        let maxLineWidth = 0;
        for (const l of lines) {
          const w = estimateStringWidth(l, currentFontSize);
          if (w > maxLineWidth) maxLineWidth = w;
        }

        return {
          fits: true,
          computedFontSize: currentFontSize,
          renderedLines: lines,
          lineCount: lines.length,
          maxLines,
          requiredWidth: maxLineWidth,
          requiredHeight: totalHeight,
          boxWidth: box.width,
          boxHeight: box.height,
          overflowDetected: false,
          overflowMode: 'shrink',
        };
      }

      currentFontSize -= 1; // shrink step
    }

    // Still overflows at minFontSize
    currentFontSize = effectiveMinFontSize;
  }

  // Base evaluation at currentFontSize
  const lines = wrapTextToLines(text, currentFontSize, box.width);
  const effectiveLineHeight = currentFontSize * lineHeight;
  const totalHeight = lines.length * effectiveLineHeight;

  let maxLineWidth = 0;
  for (const l of lines) {
    const w = estimateStringWidth(l, currentFontSize);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  const exceedsLines = lines.length > maxLines;
  const exceedsHeight = totalHeight > box.height + 0.5;
  const overflowDetected = exceedsLines || exceedsHeight;

  if (!overflowDetected) {
    return {
      fits: true,
      computedFontSize: currentFontSize,
      renderedLines: lines,
      lineCount: lines.length,
      maxLines,
      requiredWidth: maxLineWidth,
      requiredHeight: totalHeight,
      boxWidth: box.width,
      boxHeight: box.height,
      overflowDetected: false,
      overflowMode: overflow,
    };
  }

  // Handle Ellipsis truncation
  if (overflow === 'ellipsis') {
    const truncatedLines = lines.slice(0, maxLines);
    if (truncatedLines.length > 0) {
      const lastIndex = truncatedLines.length - 1;
      let lastLine = truncatedLines[lastIndex] ?? '';
      const ellipsis = '…';
      const ellipsisWidth = estimateStringWidth(ellipsis, currentFontSize);

      while (
        lastLine.length > 0 &&
        estimateStringWidth(lastLine, currentFontSize) + ellipsisWidth > box.width
      ) {
        lastLine = lastLine.slice(0, -1);
      }
      truncatedLines[lastIndex] = lastLine.trimEnd() + ellipsis;
    }

    return {
      fits: true,
      computedFontSize: currentFontSize,
      renderedLines: truncatedLines,
      lineCount: truncatedLines.length,
      maxLines,
      requiredWidth: box.width,
      requiredHeight: truncatedLines.length * effectiveLineHeight,
      boxWidth: box.width,
      boxHeight: box.height,
      overflowDetected: true,
      overflowMode: 'ellipsis',
      truncatedText: truncatedLines.join('\n'),
    };
  }

  // Mode is 'error' or 'shrink' that failed
  const reason = exceedsLines
    ? `Text requires ${lines.length} lines, exceeding max_lines limit of ${maxLines}`
    : `Total text height ${Math.round(totalHeight)}px exceeds box height of ${box.height}px`;

  return {
    fits: false,
    computedFontSize: currentFontSize,
    renderedLines: lines,
    lineCount: lines.length,
    maxLines,
    requiredWidth: maxLineWidth,
    requiredHeight: totalHeight,
    boxWidth: box.width,
    boxHeight: box.height,
    overflowDetected: true,
    overflowMode: overflow,
    overflowReason: reason,
  };
}

/**
 * Validates all text layers across all scenes of a composition specification.
 * Throws TextOverflowError with pointer and exact metrics if any layer set to overflow: 'error'
 * exceeds bounding limits.
 */
export function validateCompositionTextOverflow(spec: CompositionSpec): void {
  const errors: TextOverflowDetail[] = [];

  for (let sIdx = 0; sIdx < spec.scenes.length; sIdx++) {
    const scene = spec.scenes[sIdx];
    if (!scene || !('layers' in scene) || !Array.isArray(scene.layers)) {
      continue;
    }

    for (let lIdx = 0; lIdx < scene.layers.length; lIdx++) {
      const layer = scene.layers[lIdx];
      if (!layer || layer.type !== 'text' || !layer.content || typeof layer.content !== 'object') {
        continue;
      }

      const content = layer.content as TextLayerContent;
      const overflowMode: TextOverflowMode = content.overflow ?? 'error';
      const maxLines = content.max_lines ?? 5;
      const lineHeight = content.line_height ?? 1.2;
      const minFontSize = content.min_font_size ?? content.font_size;

      const layout = calculateTextLayout({
        text: content.text,
        fontSize: content.font_size,
        lineHeight,
        box: layer.box,
        maxLines,
        minFontSize,
        overflow: overflowMode,
      });

      if (!layout.fits && overflowMode === 'error') {
        errors.push({
          sceneId: scene.id,
          layerId: layer.id,
          pointer: `/scenes/${sIdx}/layers/${lIdx}/content/text`,
          code: 'TEXT_OVERFLOW',
          message:
            layout.overflowReason ??
            `Text layer '${layer.id}' in scene '${scene.id}' overflows bounding box (${layer.box.width}x${layer.box.height}px)`,
          lineCount: layout.lineCount,
          maxLines: layout.maxLines,
          requiredHeight: Math.round(layout.requiredHeight),
          boxHeight: layer.box.height,
          boxWidth: layer.box.width,
          textSnippet:
            content.text.length > 50 ? `${content.text.slice(0, 47)}...` : content.text,
        });
      }
    }
  }

  if (errors.length > 0) {
    const summary = errors.map((e) => `[${e.pointer}]: ${e.message}`).join('\n');
    throw new TextOverflowError(
      `Text overflow preflight detected ${errors.length} violation(s):\n${summary}`,
      errors,
    );
  }
}
