/**
 * Subtitle Generator & Synchronizer for Creativanta Video Engine.
 * Formats canonical subtitles into SRT & WebVTT sidecars and validates sync alignment.
 * Canonical specification: docs/SCENE-SPEC.md, docs/TESTING.md (POC-03)
 */

import {
  RationalFps,
  SubtitleTrackManifest,
  SubtitleCueManifest,
} from '@creativanta/contracts';

export interface FormattedSubtitleCue {
  id: string;
  index: number;
  startFrame: number;
  endFrame: number;
  startMs: number;
  endMs: number;
  timestampSrt: string;
  timestampVtt: string;
  text: string;
}

export interface SubtitleSyncReport {
  trackId: string;
  locale: string;
  cuesCount: number;
  allAnchorsWithinOneSampleFrame: boolean;
  maxDiscrepancyFrames: number;
  maxDiscrepancyMs: number;
  anchorComparisons: Array<{
    cueId: string;
    audioAnchorSeconds: number;
    cueStartSeconds: number;
    deltaMs: number;
    deltaFrames: number;
    passed: boolean;
  }>;
}

/**
 * Formats milliseconds into standard SubRip timestamp (HH:MM:SS,mmm).
 */
export function formatTimestampSrt(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = Math.floor(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(milliseconds).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Formats milliseconds into standard WebVTT timestamp (HH:MM:SS.mmm).
 */
export function formatTimestampVtt(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = Math.floor(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(milliseconds).padStart(3, '0');

  return `${hh}:${mm}:${ss}.${mmm}`;
}

/**
 * Converts frame number to milliseconds using rational frame rate (round_half_up).
 */
export function frameToMs(frame: number, fps: RationalFps): number {
  return Math.round((frame * 1000 * fps.den) / fps.num);
}

/**
 * Prepares formatted cue objects with NFC-normalized Vietnamese text and timestamps.
 */
export function prepareFormattedCues(
  track: SubtitleTrackManifest,
  fps: RationalFps
): FormattedSubtitleCue[] {
  const cues = track.cues || [];
  return cues.map((cue: SubtitleCueManifest, idx: number) => {
    const startMs = cue.start_ms ?? frameToMs(cue.start_frame, fps);
    const endMs = cue.end_ms ?? frameToMs(cue.end_frame, fps);
    // Ensure strict Unicode NFC normalization for Vietnamese diacritics
    const normalizedText = cue.text.normalize('NFC');

    return {
      id: cue.id,
      index: idx + 1,
      startFrame: cue.start_frame,
      endFrame: cue.end_frame,
      startMs,
      endMs,
      timestampSrt: `${formatTimestampSrt(startMs)} --> ${formatTimestampSrt(endMs)}`,
      timestampVtt: `${formatTimestampVtt(startMs)} --> ${formatTimestampVtt(endMs)}`,
      text: normalizedText,
    };
  });
}

/**
 * Generates valid SubRip (.srt) subtitle file content from subtitle track manifest.
 */
export function generateSrt(
  track: SubtitleTrackManifest,
  fps: RationalFps = { num: 30, den: 1 }
): string {
  const formattedCues = prepareFormattedCues(track, fps);
  const blocks: string[] = [];

  for (const cue of formattedCues) {
    blocks.push(`${cue.index}\n${cue.timestampSrt}\n${cue.text}\n`);
  }

  return blocks.join('\n');
}

/**
 * Generates valid WebVTT (.vtt) subtitle file content from subtitle track manifest.
 */
export function generateVtt(
  track: SubtitleTrackManifest,
  fps: RationalFps = { num: 30, den: 1 }
): string {
  const formattedCues = prepareFormattedCues(track, fps);
  const blocks: string[] = [
    'WEBVTT - Creativanta Video Engine Subtitles',
    `NOTE Language: ${track.locale || 'vi-VN'}`,
    '',
  ];

  for (const cue of formattedCues) {
    blocks.push(`${cue.id}\n${cue.timestampVtt}\n${cue.text}\n`);
  }

  return blocks.join('\n');
}

/**
 * Finds the active subtitle cue for a given global frame index, if any.
 */
export function getActiveSubtitleCue(
  subtitles: SubtitleTrackManifest[] | undefined,
  globalFrame: number
): { track: SubtitleTrackManifest; cue: SubtitleCueManifest } | null {
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
 * Validates audio-subtitle synchronization against reference anchors (e.g. speech onsets).
 * Enforces acceptance criterion: sync anchors <= 1 frame (33.33ms at 30fps).
 */
export function validateSubtitleSync(
  track: SubtitleTrackManifest,
  audioAnchors: Array<{ frame: number; timeSec: number; label?: string }>,
  fps: RationalFps = { num: 30, den: 1 }
): SubtitleSyncReport {
  const cues = track.cues || [];
  const comparisons: SubtitleSyncReport['anchorComparisons'] = [];
  let maxDeltaFrames = 0;
  let maxDeltaMs = 0;
  let allPassed = true;

  for (let i = 0; i < Math.min(cues.length, audioAnchors.length); i++) {
    const cue = cues[i]!;
    const anchor = audioAnchors[i]!;

    const cueStartSec = (cue.start_frame * fps.den) / fps.num;
    const deltaSec = Math.abs(cueStartSec - anchor.timeSec);
    const deltaMs = deltaSec * 1000;
    const deltaFrames = Math.abs(cue.start_frame - anchor.frame);

    const passed = deltaFrames <= 1; // <= 1 frame sync threshold

    if (deltaFrames > maxDeltaFrames) maxDeltaFrames = deltaFrames;
    if (deltaMs > maxDeltaMs) maxDeltaMs = deltaMs;
    if (!passed) allPassed = false;

    comparisons.push({
      cueId: cue.id,
      audioAnchorSeconds: anchor.timeSec,
      cueStartSeconds: cueStartSec,
      deltaMs: Math.round(deltaMs * 100) / 100,
      deltaFrames,
      passed,
    });
  }

  return {
    trackId: track.id,
    locale: track.locale,
    cuesCount: cues.length,
    allAnchorsWithinOneSampleFrame: allPassed,
    maxDiscrepancyFrames: maxDeltaFrames,
    maxDiscrepancyMs: Math.round(maxDeltaMs * 100) / 100,
    anchorComparisons: comparisons,
  };
}
