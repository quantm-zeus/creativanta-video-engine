/**
 * Subtitle Sidecar Generator (SRT & WebVTT) for Creativanta Video Engine.
 * Converts canonical rational frame times to single-pass rounded millisecond timestamps.
 * Canonical specification: docs/SCENE-SPEC.md (Line 90).
 */

import { RationalFps, SubtitleTrackSpec } from '@creativanta/contracts';
import { SubtitleSidecarResult } from './types.js';

const DEFAULT_FPS: RationalFps = { num: 30, den: 1 };

/**
 * Formats milliseconds into standard SubRip timestamp (HH:MM:SS,mmm).
 */
export function formatTimestampSrt(ms: number): string {
  const boundedMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(boundedMs / 1000);
  const milliseconds = Math.floor(boundedMs % 1000);
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
  const boundedMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(boundedMs / 1000);
  const milliseconds = Math.floor(boundedMs % 1000);
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
 * Converts frame number to milliseconds using rational frame rate (single round_half_up).
 */
export function frameToMs(frame: number, fps: RationalFps = DEFAULT_FPS): number {
  if (frame <= 0) return 0;
  return Math.round((frame * 1000 * fps.den) / fps.num);
}

/**
 * Converts milliseconds to frame number using rational frame rate (single round_half_up).
 */
export function msToFrame(ms: number, fps: RationalFps = DEFAULT_FPS): number {
  if (ms <= 0) return 0;
  return Math.round((ms * fps.num) / (1000 * fps.den));
}

/**
 * Generates SubRip (.srt) formatted content from a canonical SubtitleTrackSpec.
 */
export function generateSrtSidecar(
  track: SubtitleTrackSpec,
  fps: RationalFps = DEFAULT_FPS
): string {
  const cues = track.cues || [];
  const blocks: string[] = [];

  for (let idx = 0; idx < cues.length; idx++) {
    const cue = cues[idx]!;
    const startMs = frameToMs(cue.start_frame, fps);
    const endMs = frameToMs(cue.end_frame, fps);
    const normalizedText = cue.text.normalize('NFC');

    blocks.push(
      `${idx + 1}\n` +
      `${formatTimestampSrt(startMs)} --> ${formatTimestampSrt(endMs)}\n` +
      `${normalizedText}\n`
    );
  }

  return blocks.join('\n');
}

/**
 * Generates WebVTT (.vtt) formatted content from a canonical SubtitleTrackSpec.
 */
export function generateVttSidecar(
  track: SubtitleTrackSpec,
  fps: RationalFps = DEFAULT_FPS
): string {
  const cues = track.cues || [];
  const blocks: string[] = [
    'WEBVTT - Creativanta Video Engine Subtitles',
    `NOTE Language: ${track.locale || 'vi-VN'}`,
    '',
  ];

  for (const cue of cues) {
    const startMs = frameToMs(cue.start_frame, fps);
    const endMs = frameToMs(cue.end_frame, fps);
    const normalizedText = cue.text.normalize('NFC');

    blocks.push(
      `${cue.id}\n` +
      `${formatTimestampVtt(startMs)} --> ${formatTimestampVtt(endMs)}\n` +
      `${normalizedText}\n`
    );
  }

  return blocks.join('\n');
}

/**
 * Exports both SRT and WebVTT sidecars along with metadata.
 */
export function exportSubtitleSidecars(
  track: SubtitleTrackSpec,
  fps: RationalFps = DEFAULT_FPS
): SubtitleSidecarResult {
  const srt = generateSrtSidecar(track, fps);
  const vtt = generateVttSidecar(track, fps);
  const cues = track.cues || [];
  const lastCue = cues.length > 0 ? cues[cues.length - 1] : undefined;
  const durationMs = lastCue ? frameToMs(lastCue.end_frame, fps) : 0;

  return {
    srt,
    vtt,
    cuesCount: cues.length,
    durationMs,
    locale: track.locale,
  };
}
