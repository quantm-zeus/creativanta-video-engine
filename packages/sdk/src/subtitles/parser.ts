/**
 * Subtitle Import & Ingest Parser for Creativanta Video Engine.
 * Parses SRT and WebVTT source captions into canonical SubtitleCue and SubtitleTrackSpec structures.
 * Canonical specification: docs/SCENE-SPEC.md (Line 90).
 */

import { RationalFps, SubtitleCue, SubtitleTrackSpec } from '@creativanta/contracts';
import { ImportSubtitleOptions } from './types.js';
import { msToFrame } from './sidecar.js';

export const MAX_CUES_PER_TRACK = 500;
export const MAX_CHARS_PER_CUE = 1000;

const DEFAULT_FPS: RationalFps = { num: 30, den: 1 };

const DANGEROUS_PATTERNS = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*object\b/i,
  /<\s*embed\b/i,
  /<\s*style\b/i,
  /javascript\s*:/i,
  /on\w+\s*=/i,
  /data:\s*text\/html/i,
];

/**
 * Parses timestamp string (HH:MM:SS[,.]mmm or MM:SS[,.]mmm) into total milliseconds.
 */
export function parseTimestampToMs(timestampStr: string): number {
  const trimmed = timestampStr.trim();
  const parts = trimmed.split(':');

  if (parts.length === 3) {
    // HH:MM:SS[,.]mmm
    const hours = parseInt(parts[0]!, 10);
    const minutes = parseInt(parts[1]!, 10);
    const secParts = parts[2]!.replace(',', '.').split('.');
    const seconds = parseInt(secParts[0]!, 10);
    const milliseconds = parseInt((secParts[1] || '0').padEnd(3, '0').slice(0, 3), 10);

    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds)) {
      throw new Error(`Invalid timestamp components: '${timestampStr}'`);
    }

    return hours * 3600000 + minutes * 60000 + seconds * 1000 + milliseconds;
  } else if (parts.length === 2) {
    // MM:SS[,.]mmm (allowed in WebVTT)
    const minutes = parseInt(parts[0]!, 10);
    const secParts = parts[1]!.replace(',', '.').split('.');
    const seconds = parseInt(secParts[0]!, 10);
    const milliseconds = parseInt((secParts[1] || '0').padEnd(3, '0').slice(0, 3), 10);

    if (isNaN(minutes) || isNaN(seconds) || isNaN(milliseconds)) {
      throw new Error(`Invalid timestamp components: '${timestampStr}'`);
    }

    return minutes * 60000 + seconds * 1000 + milliseconds;
  }

  throw new Error(`Unrecognized timestamp format: '${timestampStr}'`);
}

/**
 * Strips HTML formatting tags and validates against malicious injection vectors.
 */
export function sanitizeSubtitleText(rawText: string, stripHtml: boolean = true): string {
  // 1. Check for malicious script/HTML injection
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(rawText)) {
      throw new Error(`Security validation failed: malicious payload detected in subtitle text: ${rawText.slice(0, 50)}`);
    }
  }

  let text = rawText;

  // 2. Strip standard formatting tags if enabled (e.g. <b>, <i>, <u>, <font>, <v Voice>, <c.color>)
  if (stripHtml) {
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  }

  // 3. Strict Unicode NFC normalization for Vietnamese diacritics
  text = text.normalize('NFC').trim();

  if (text.length > MAX_CHARS_PER_CUE) {
    throw new Error(`Subtitle cue text exceeds maximum length of ${MAX_CHARS_PER_CUE} characters (got ${text.length})`);
  }

  return text;
}

/**
 * Parses SubRip (.srt) content into canonical SubtitleCue array.
 */
export function parseSrt(rawContent: string, options: ImportSubtitleOptions = {}): SubtitleCue[] {
  const fps = options.fps || DEFAULT_FPS;
  const maxCues = options.maxCues ?? MAX_CUES_PER_TRACK;
  const stripHtml = options.stripHtml ?? true;
  const idPrefix = options.idPrefix || 'cue';

  // Normalize line endings to LF
  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  // Split by double newline or blank lines
  const rawBlocks = normalized.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
    const block = rawBlocks[bIdx]!.trim();
    if (!block) continue;

    const lines = block.split('\n').map((l) => l.trim());
    if (lines.length < 2) continue;

    let timeLineIndex = 0;
    // Check if line 0 is numeric index or timestamp
    if (/^\d+$/.test(lines[0]!)) {
      timeLineIndex = 1;
    }

    if (timeLineIndex >= lines.length) continue;

    const timeLine = lines[timeLineIndex]!;
    const timeMatch = timeLine.match(/(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})/);
    if (!timeMatch) {
      continue; // Skip unrecognized blocks
    }

    const startMs = parseTimestampToMs(timeMatch[1]!);
    const endMs = parseTimestampToMs(timeMatch[2]!);

    if (startMs >= endMs) {
      throw new Error(`Invalid cue timing in SRT block #${bIdx + 1}: startMs (${startMs}) must be strictly less than endMs (${endMs})`);
    }

    const startFrame = msToFrame(startMs, fps);
    const endFrame = Math.max(startFrame + 1, msToFrame(endMs, fps));

    const textLines = lines.slice(timeLineIndex + 1);
    const rawText = textLines.join('\n');
    const sanitizedText = sanitizeSubtitleText(rawText, stripHtml);

    const cueId = `${idPrefix}_${String(cues.length + 1).padStart(3, '0')}`;

    cues.push({
      id: cueId,
      start_frame: startFrame,
      end_frame: endFrame,
      text: sanitizedText,
    });

    if (cues.length > maxCues) {
      throw new Error(`Imported cues count exceeds maximum allowed of ${maxCues}`);
    }
  }

  // Sort and validate overlap
  validateCueSequence(cues, options);

  return cues;
}

/**
 * Parses WebVTT (.vtt) content into canonical SubtitleCue array.
 */
export function parseVtt(rawContent: string, options: ImportSubtitleOptions = {}): SubtitleCue[] {
  const fps = options.fps || DEFAULT_FPS;
  const maxCues = options.maxCues ?? MAX_CUES_PER_TRACK;
  const stripHtml = options.stripHtml ?? true;
  const idPrefix = options.idPrefix || 'cue';

  const normalized = rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    return [];
  }

  if (!normalized.startsWith('WEBVTT')) {
    throw new Error('Invalid WebVTT file: header must start with WEBVTT');
  }

  const rawBlocks = normalized.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
    const block = rawBlocks[bIdx]!.trim();
    if (!block || block.startsWith('WEBVTT') || block.startsWith('NOTE') || block.startsWith('STYLE')) {
      continue;
    }

    const lines = block.split('\n').map((l) => l.trim());
    if (lines.length < 1) continue;

    let timeLineIndex = 0;
    let explicitId: string | null = null;

    // Check if line 0 is a cue identifier (does not contain '-->')
    if (!lines[0]!.includes('-->')) {
      explicitId = lines[0]!;
      timeLineIndex = 1;
    }

    if (timeLineIndex >= lines.length) continue;

    const timeLine = lines[timeLineIndex]!;
    const timeMatch = timeLine.match(/((?:\d{1,2}:)?\d{2}:\d{2}[\.]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[\.]\d{1,3})/);
    if (!timeMatch) {
      continue;
    }

    const startMs = parseTimestampToMs(timeMatch[1]!);
    const endMs = parseTimestampToMs(timeMatch[2]!);

    if (startMs >= endMs) {
      throw new Error(`Invalid cue timing in VTT block #${bIdx + 1}: startMs (${startMs}) must be strictly less than endMs (${endMs})`);
    }

    const startFrame = msToFrame(startMs, fps);
    const endFrame = Math.max(startFrame + 1, msToFrame(endMs, fps));

    const textLines = lines.slice(timeLineIndex + 1);
    const rawText = textLines.join('\n');
    const sanitizedText = sanitizeSubtitleText(rawText, stripHtml);

    const cueId = explicitId && /^[a-zA-Z0-9_-]+$/.test(explicitId)
      ? explicitId
      : `${idPrefix}_${String(cues.length + 1).padStart(3, '0')}`;

    cues.push({
      id: cueId,
      start_frame: startFrame,
      end_frame: endFrame,
      text: sanitizedText,
    });

    if (cues.length > maxCues) {
      throw new Error(`Imported cues count exceeds maximum allowed of ${maxCues}`);
    }
  }

  // Sort and validate overlap
  validateCueSequence(cues, options);

  return cues;
}

/**
 * Validates cue chronological monotonicity, non-overlapping constraints, and duration boundaries.
 */
function validateCueSequence(cues: SubtitleCue[], options: ImportSubtitleOptions): void {
  const validateOverlap = options.validateOverlap ?? true;
  const durationFrames = options.durationFrames;

  // Sort by start_frame
  cues.sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame);

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;

    if (cue.start_frame < 0) {
      throw new Error(`Subtitle cue start_frame must be >= 0, got ${cue.start_frame}`);
    }

    if (cue.start_frame >= cue.end_frame) {
      throw new Error(`Subtitle cue '${cue.id}' start_frame (${cue.start_frame}) must be < end_frame (${cue.end_frame})`);
    }

    if (durationFrames !== undefined && cue.end_frame > durationFrames) {
      throw new Error(
        `Subtitle cue '${cue.id}' end_frame (${cue.end_frame}) exceeds composition duration (${durationFrames})`
      );
    }

    if (validateOverlap && i > 0) {
      const prev = cues[i - 1]!;
      if (cue.start_frame < prev.end_frame) {
        throw new Error(
          `Subtitle cue overlap detected between '${prev.id}' (ends at frame ${prev.end_frame}) and '${cue.id}' (starts at frame ${cue.start_frame})`
        );
      }
    }
  }
}

/**
 * High-level import function supporting both SRT and WebVTT.
 */
export function importSubtitles(
  content: string,
  format: 'srt' | 'vtt',
  options: ImportSubtitleOptions = {}
): SubtitleTrackSpec {
  const cues = format === 'srt' ? parseSrt(content, options) : parseVtt(content, options);
  const locale = options.targetLocale || 'vi-VN';

  return {
    id: `sub_${locale.toLowerCase().replace('-', '_')}`,
    locale,
    burn_in: false,
    cues,
  };
}
