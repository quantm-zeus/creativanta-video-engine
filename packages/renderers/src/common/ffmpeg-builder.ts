/**
 * Deterministic FFmpeg Argv Builder conforming to strict sandbox policies.
 * Canonical specification: docs/SECURITY.md, docs/TESTING.md, packages/controller/src/sandbox.ts
 */

import { CanonicalCompilerManifest } from '@creativanta/contracts';
import { FfmpegCommandOptions, FfmpegArgvResult } from '../types.js';

const DISALLOWED_ARG_PATTERNS = [
  /--enable-nonfree/i,
  /libfdk_aac/i,
  /169\.254\./,
  /metadata\.google\.internal/,
  /localhost/i,
  /127\.0\.0\.1/,
  /https?:\/\//i,
  /file:\/\//i,
  /subfile:/i,
  /crypto:/i,
  /concat:/i,
];

export function validateFfmpegPath(pathStr: string): void {
  for (const pattern of DISALLOWED_ARG_PATTERNS) {
    if (pattern.test(pathStr)) {
      throw new Error(
        `Disallowed path or URL detected in FFmpeg parameter: "${pathStr}"`
      );
    }
  }
}

export function buildFfmpegCommand(
  manifest: CanonicalCompilerManifest,
  options: FfmpegCommandOptions
): FfmpegArgvResult {
  validateFfmpegPath(options.outputPath);
  if (options.inputPatternOrPipe) {
    validateFfmpegPath(options.inputPatternOrPipe);
  }
  if (options.subtitleFilePath) {
    validateFfmpegPath(options.subtitleFilePath);
  }

  const fpsStr = `${manifest.fps.num}/${manifest.fps.den}`;
  const crf = options.crf ?? 23;
  const preset = options.preset ?? 'fast';
  const argv: string[] = [
    '-nostdin',
    '-y',
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
  ];

  // 1. Video Input Configuration
  if (options.inputPatternOrPipe === 'pipe:0' || !options.inputPatternOrPipe) {
    argv.push(
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-r',
      fpsStr,
      '-i',
      'pipe:0'
    );
  } else {
    argv.push(
      '-framerate',
      fpsStr,
      '-i',
      options.inputPatternOrPipe
    );
  }

  // 2. Audio Inputs Configuration
  const audioTracks = manifest.audio_tracks || [];
  const trackFiles = options.audioTrackFiles || {};
  let audioInputsCount = 0;
  const audioFilterParts: string[] = [];

  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i]!;
    const filePath = trackFiles[track.asset_id] || trackFiles[track.id];
    if (filePath) {
      validateFfmpegPath(filePath);
      argv.push('-i', filePath);
      audioInputsCount++;

      // Rational timing: sample offset to millisecond delay
      const delayMs = Math.round((track.sample_start / 48000) * 1000);
      const volumeLinear = Math.pow(10, (track.gain_db || 0) / 20).toFixed(3);
      audioFilterParts.push(
        `[${audioInputsCount}:a]adelay=${delayMs}|${delayMs},volume=${volumeLinear}[a${i}]`
      );
    }
  }

  // 3. Filtergraph Assembly (Video subtitle burn-in & Audio mixing)
  let videoLabel = '0:v';
  const filtergraphClauses: string[] = [];

  if (options.burnInSubtitles && options.subtitleFilePath) {
    filtergraphClauses.push(
      `[${videoLabel}]subtitles=${options.subtitleFilePath}:force_style='FontName=Inter,FontSize=20,PrimaryColour=&H00FFFFFF&'[v_sub]`
    );
    videoLabel = 'v_sub';
  }

  if (audioInputsCount > 0) {
    for (const clause of audioFilterParts) {
      filtergraphClauses.push(clause);
    }
    const mixInputs = Array.from({ length: audioInputsCount }, (_, idx) => `[a${idx}]`).join('');
    filtergraphClauses.push(
      `${mixInputs}amix=inputs=${audioInputsCount}:duration=first:dropout_transition=0[aout]`
    );
  } else {
    // Explicit silence generator for CFR video when no audio tracks present
    argv.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    const silentIndex = audioInputsCount + 1;
    filtergraphClauses.push(`[${silentIndex}:a]atrim=duration=${manifest.duration_seconds}[aout]`);
  }

  if (filtergraphClauses.length > 0) {
    argv.push('-filter_complex', filtergraphClauses.join(';'));
    argv.push('-map', `[${videoLabel}]`);
    argv.push('-map', '[aout]');
  } else {
    argv.push('-map', '0:v');
  }

  // 4. Output Encoding Parameters (Pinned x264 & AAC)
  argv.push(
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-r',
    fpsStr,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    options.outputPath
  );

  return {
    argv,
    commandLine: argv.map((arg) => (arg.includes(' ') || arg.includes(';') ? `"${arg}"` : arg)).join(' '),
    audioTracksIncluded: audioInputsCount,
    subtitlesIncluded: Boolean(options.burnInSubtitles && options.subtitleFilePath),
    protocolWhitelist: 'file,pipe',
  };
}
