import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChromiumBaselineRenderer,
  calculateCropGeometry,
  mapGlobalFrameToSource,
  validateCfrTimeline,
  buildFfmpegFootageFilter,
  generateSrt,
  generateVtt,
  getActiveSubtitleCue,
  validateSubtitleSync,
  mixAudioTracks,
  dbToLinear,
  linearToDb,
} from '../dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const poc03Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-poc03.json'), 'utf-8')
);

const poc03Rev2Manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../fixtures/manifest-poc03-revision2.json'), 'utf-8')
);

const rightsManifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../evidence/P0-03/rights-manifest.json'), 'utf-8')
);

// -----------------------------------------------------------------------------
// Test 1: POC-03 45s Manifest & Ingest Structural Validation
// -----------------------------------------------------------------------------
test('POC-03: 45s Manifest Structure & Timing Constants', () => {
  assert.equal(poc03Manifest.duration_frames, 1350, 'Duration must be 1350 frames');
  assert.equal(poc03Manifest.duration_seconds, 45, 'Duration must be 45 seconds');
  assert.equal(poc03Manifest.canvas.width, 720, 'Portrait width 720');
  assert.equal(poc03Manifest.canvas.height, 1280, 'Portrait height 1280');
  assert.equal(poc03Manifest.fps.num, 30, 'Numerator 30');
  assert.equal(poc03Manifest.fps.den, 1, 'Denominator 1');
  assert.equal(poc03Manifest.profile, 'mp4-720p-v1');
  assert.equal(poc03Manifest.locale, 'vi-VN');

  // Verify scenes count and contiguity
  assert.equal(poc03Manifest.scenes.length, 2, 'Exactly 2 video scenes');
  assert.equal(poc03Manifest.scenes[0].start_frame, 0);
  assert.equal(poc03Manifest.scenes[0].duration_frames, 675);
  assert.equal(poc03Manifest.scenes[0].end_frame, 675);

  assert.equal(poc03Manifest.scenes[1].start_frame, 675);
  assert.equal(poc03Manifest.scenes[1].duration_frames, 675);
  assert.equal(poc03Manifest.scenes[1].end_frame, 1350);

  // Verify each scene has a video layer
  assert.equal(poc03Manifest.scenes[0].layers[0].type, 'video');
  assert.equal(poc03Manifest.scenes[1].layers[0].type, 'video');

  // Verify 2 explicit audio tracks
  assert.equal(poc03Manifest.audio_tracks.length, 2);
  const musicTrack = poc03Manifest.audio_tracks.find((t) => t.role === 'music');
  const voiceTrack = poc03Manifest.audio_tracks.find((t) => t.role === 'voice');
  assert.ok(musicTrack, 'Music track must exist');
  assert.ok(voiceTrack, 'Voice track must exist');

  // Verify subtitles
  assert.equal(poc03Manifest.subtitles.length, 1);
  assert.equal(poc03Manifest.subtitles[0].burn_in, true);
  assert.equal(poc03Manifest.subtitles[0].cues.length, 4);
});

// -----------------------------------------------------------------------------
// Test 2: Source Asset Integrity & Rights Hash Verification
// -----------------------------------------------------------------------------
test('POC-03: Source Hashes & Rights Manifest Verification', () => {
  const poc03Rights = rightsManifest.fixtures['POC-03'];
  assert.ok(poc03Rights, 'POC-03 must be registered in rights manifest');

  // Map asset IDs in rights manifest
  const rightsAssetMap = new Map();
  for (const asset of rightsManifest.assets) {
    rightsAssetMap.set(asset.asset_id, asset);
  }

  // 1. Clip 1: ast_video_footage_a
  const clip1 = rightsAssetMap.get('ast_poc03_clip1_daklak');
  assert.ok(clip1, 'Clip 1 registered in rights manifest');
  assert.equal(clip1.sha256.length, 64);
  assert.match(clip1.sha256, /^[0-9a-f]{64}$/);
  assert.equal(clip1.category, 'video');
  assert.equal(clip1.video_profile.audio_demuxed_state, 'Video-only bitstream (audio stream removed to prevent unmanaged audio bleed)');

  // 2. Clip 2: ast_video_footage_b
  const clip2 = rightsAssetMap.get('ast_poc03_clip2_workshop');
  assert.ok(clip2, 'Clip 2 registered in rights manifest');
  assert.equal(clip2.sha256.length, 64);
  assert.match(clip2.sha256, /^[0-9a-f]{64}$/);
  assert.equal(clip2.category, 'video');

  // 3. Audio Narration: ast_audio_speech_guide
  const voice = rightsAssetMap.get('ast_poc03_narration_vi');
  assert.ok(voice, 'Voice narration registered');
  assert.equal(voice.sha256.length, 64);
  assert.equal(voice.sample_rate, 48000);
  assert.equal(voice.duration_samples, 2160000);

  // 4. Audio Music: ast_audio_music_ambient
  const music = rightsAssetMap.get('ast_poc03_music_track');
  assert.ok(music, 'Music track registered');
  assert.equal(music.sha256.length, 64);
  assert.equal(music.sample_rate, 48000);
  assert.equal(music.duration_samples, 2160000);

  // 5. Fonts
  const fontBold = rightsAssetMap.get('ast_font_roboto_bold');
  const fontRegular = rightsAssetMap.get('ast_font_roboto_regular');
  assert.ok(fontBold);
  assert.ok(fontRegular);
  assert.equal(fontBold.sha256.length, 64);
  assert.equal(fontRegular.sha256.length, 64);
});

// -----------------------------------------------------------------------------
// Test 3: CFR Video Trim, Crop, & Frame Mapping
// -----------------------------------------------------------------------------
test('POC-03: CFR Video Trim, Crop, & Rational Frame Mapping', () => {
  const canvasWidth = 720;
  const canvasHeight = 1280;

  // 1. Crop geometry calculation for 16:9 source (1920x1080) to 9:16 canvas (720x1280)
  const cropLandscape = calculateCropGeometry(canvasWidth, canvasHeight, 1920, 1080, 'cover', 0.5, 0.5);
  assert.equal(cropLandscape.canvasWidth, 720);
  assert.equal(cropLandscape.canvasHeight, 1280);
  assert.equal(cropLandscape.sourceCropHeight, 1080);
  assert.equal(cropLandscape.sourceCropWidth, Math.round(1080 * (720 / 1280))); // 608
  assert.ok(cropLandscape.sourceCropX > 0, 'Centered crop on landscape footage');

  // 2. Crop geometry for native portrait source (720x1280)
  const cropPortrait = calculateCropGeometry(canvasWidth, canvasHeight, 720, 1280, 'cover', 0.5, 0.5);
  assert.equal(cropPortrait.sourceCropWidth, 720);
  assert.equal(cropPortrait.sourceCropHeight, 1280);
  assert.equal(cropPortrait.sourceCropX, 0);
  assert.equal(cropPortrait.sourceCropY, 0);

  // 3. Mapping global frames to source frames
  const sceneA = poc03Manifest.scenes[0];
  const videoLayerA = sceneA.layers[0];

  // Clip A has source_in_frame: 30
  const mapStartA = mapGlobalFrameToSource(0, sceneA, videoLayerA, poc03Manifest.fps);
  assert.equal(mapStartA.globalFrame, 0);
  assert.equal(mapStartA.sceneLocalFrame, 0);
  assert.equal(mapStartA.sourceFrame, 30);
  assert.equal(mapStartA.sourceTimestampSeconds, 1.0);
  assert.equal(mapStartA.sourceTimestampMs, 1000);
  assert.equal(mapStartA.isWithinBounds, true);

  const mapEndA = mapGlobalFrameToSource(674, sceneA, videoLayerA, poc03Manifest.fps);
  assert.equal(mapEndA.globalFrame, 674);
  assert.equal(mapEndA.sceneLocalFrame, 674);
  assert.equal(mapEndA.sourceFrame, 704);
  assert.equal(mapEndA.isWithinBounds, true);

  // Scene B has source_in_frame: 0
  const sceneB = poc03Manifest.scenes[1];
  const videoLayerB = sceneB.layers[0];

  const mapStartB = mapGlobalFrameToSource(675, sceneB, videoLayerB, poc03Manifest.fps);
  assert.equal(mapStartB.globalFrame, 675);
  assert.equal(mapStartB.sceneLocalFrame, 0);
  assert.equal(mapStartB.sourceFrame, 0);
  assert.equal(mapStartB.sourceTimestampSeconds, 0.0);
  assert.equal(mapStartB.isWithinBounds, true);

  // 4. Validate CFR timeline
  const cfrVal = validateCfrTimeline(poc03Manifest.duration_frames, poc03Manifest.fps);
  assert.equal(cfrVal.valid, true);
  assert.equal(cfrVal.isStrictCfr, true);
  assert.equal(cfrVal.totalDurationFrames, 1350);
  assert.equal(cfrVal.totalDurationSeconds, 45);
  assert.ok(Math.abs(cfrVal.maxFrameDeltaMs - 33.3333) < 0.01);
});

// -----------------------------------------------------------------------------
// Test 4: Subtitle Sidecar Generation (SRT & WebVTT)
// -----------------------------------------------------------------------------
test('POC-03: Subtitle Sidecar Generation (SRT & WebVTT) with Vietnamese NFC', () => {
  const subTrack = poc03Manifest.subtitles[0];

  // 1. Generate SRT
  const srtOutput = generateSrt(subTrack, poc03Manifest.fps);
  assert.ok(srtOutput.includes('1\n00:00:01,500 --> 00:00:11,000'));
  assert.ok(srtOutput.includes('Khám phá vẻ đẹp kỳ vĩ của thiên nhiên Việt Nam.'));
  assert.ok(srtOutput.includes('2\n00:00:11,500 --> 00:00:22,000'));
  assert.ok(srtOutput.includes('Những cánh rừng bạt ngàn tại vùng cao nguyên Đắk Lắk.'));
  assert.ok(srtOutput.includes('3\n00:00:23,000 --> 00:00:33,000'));
  assert.ok(srtOutput.includes('Hành trình trải nghiệm kết nối con người và cộng đồng.'));
  assert.ok(srtOutput.includes('4\n00:00:33,500 --> 00:00:44,000'));
  assert.ok(srtOutput.includes('Lưu giữ từng khoảnh khắc đáng nhớ qua những thước phim sống động.'));

  // 2. Generate WebVTT
  const vttOutput = generateVtt(subTrack, poc03Manifest.fps);
  assert.ok(vttOutput.startsWith('WEBVTT'));
  assert.ok(vttOutput.includes('cue_1\n00:00:01.500 --> 00:00:11.000'));
  assert.ok(vttOutput.includes('cue_2\n00:00:11.500 --> 00:00:22.000'));
  assert.ok(vttOutput.includes('Đắk Lắk'));

  // 3. Verify Vietnamese Unicode NFC normalization
  for (const cue of subTrack.cues) {
    const isNfc = cue.text === cue.text.normalize('NFC');
    assert.equal(isNfc, true, `Cue "${cue.id}" must be strictly normalized to Unicode NFC`);
  }

  // 4. Verify sidecar files on disk
  const srtPath = resolve(__dirname, '../../../fixtures/poc03-subtitles.srt');
  const vttPath = resolve(__dirname, '../../../fixtures/poc03-subtitles.vtt');
  assert.ok(existsSync(srtPath), 'poc03-subtitles.srt must exist');
  assert.ok(existsSync(vttPath), 'poc03-subtitles.vtt must exist');
});

// -----------------------------------------------------------------------------
// Test 5: Subtitle Burn-In DOM & Visual Composite
// -----------------------------------------------------------------------------
test('POC-03: Subtitle Burn-In DOM Overlay & RGBA Visual Composite', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc03Manifest);

  // 1. Check cue activity across timeline
  const cueAt0 = getActiveSubtitleCue(poc03Manifest.subtitles, 0);
  assert.equal(cueAt0, null, 'No subtitle active at frame 0');

  const cueAt100 = getActiveSubtitleCue(poc03Manifest.subtitles, 100);
  assert.ok(cueAt100, 'Cue 1 active at frame 100');
  assert.equal(cueAt100.cue.id, 'cue_1');

  const cueAt335 = getActiveSubtitleCue(poc03Manifest.subtitles, 335);
  assert.equal(cueAt335, null, 'Gap between cue 1 and 2 at frame 335');

  const cueAt500 = getActiveSubtitleCue(poc03Manifest.subtitles, 500);
  assert.ok(cueAt500, 'Cue 2 active at frame 500');
  assert.equal(cueAt500.cue.id, 'cue_2');

  // 2. Verify DOM output contains subtitle overlay when active
  const frame100 = await session.seek(100);
  assert.ok(frame100.domSnapshot);
  assert.ok(frame100.domSnapshot.includes('id="cve-subtitle-overlay"'));
  assert.ok(frame100.domSnapshot.includes('Khám phá vẻ đẹp kỳ vĩ của thiên nhiên Việt Nam.'));
  assert.ok(frame100.domSnapshot.includes('bottom: 56px')); // Safe margin

  // Frame 0 has no subtitle
  const frame0 = await session.seek(0);
  assert.ok(!frame0.domSnapshot.includes('id="cve-subtitle-overlay"'));

  // 3. Verify visual capture buffer differences (burned-in subtitle affects pixels)
  const cap0 = await session.captureFrame(0, 'png');
  const cap100 = await session.captureFrame(100, 'png');
  assert.notEqual(cap0.checksumSha256, cap100.checksumSha256);

  await session.dispose();
});

// -----------------------------------------------------------------------------
// Test 6: Explicit Multi-Track Audio Mixing & Ducking
// -----------------------------------------------------------------------------
test('POC-03: Explicit Multi-Track Audio Mixing & Dynamic Ducking', () => {
  const mix = mixAudioTracks(poc03Manifest);

  assert.equal(mix.sampleRate, 48000);
  assert.equal(mix.channels, 2);
  assert.equal(mix.totalSamples, 2160000, '45s * 48000 = 2,160,000 samples');
  assert.equal(mix.durationSeconds, 45.0);

  // PCM buffer validity
  assert.ok(mix.pcmBuffer.length > 44, 'WAV header present');
  assert.equal(mix.pcmBuffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(mix.pcmBuffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(mix.pcmBuffer.readUInt16LE(22), 2); // 2 channels
  assert.equal(mix.pcmBuffer.readUInt32LE(24), 48000); // 48kHz
  assert.equal(mix.pcmBuffer.readUInt16LE(34), 16); // 16-bit PCM

  // Check SHA-256
  assert.equal(mix.sha256.length, 64);
  assert.match(mix.sha256, /^[0-9a-f]{64}$/);
});

// -----------------------------------------------------------------------------
// Test 7: Master Audio Limiting & Zero Clipping
// -----------------------------------------------------------------------------
test('POC-03: Audio Limiting, Loudness Target, & Zero Clipping Verification', () => {
  const mix = mixAudioTracks(poc03Manifest, undefined, {
    targetLoudnessLufs: -16.0,
    maxTruePeakDbtp: -1.0,
    enableLimiter: true,
  });

  // Acceptance: True peak <= -1.0 dBTP
  assert.ok(
    mix.measuredPeakDbtp <= -1.0,
    `Measured peak ${mix.measuredPeakDbtp} dBTP exceeds ceiling -1.0 dBTP`
  );

  // Acceptance: No clipping (peak amplitude < 1.0 linear)
  assert.equal(mix.clippingDetected, false, 'Strictly zero digital clipping');
  assert.ok(mix.measuredPeakLinear <= 0.8913, `Peak linear ${mix.measuredPeakLinear} <= 0.8913`);

  // Acceptance: Loudness target -16 LUFS +- 1.0
  assert.ok(
    mix.measuredLoudnessLufs >= -18.0 && mix.measuredLoudnessLufs <= -14.0,
    `Loudness ${mix.measuredLoudnessLufs} LUFS within acceptable window [-18, -14]`
  );
});

// -----------------------------------------------------------------------------
// Test 8: Audio-Visual Sync Anchors (<= 1 Frame)
// -----------------------------------------------------------------------------
test('POC-03: Audio-Visual Sync Anchors & Subtitle Alignment (<= 1 Frame)', () => {
  const mix = mixAudioTracks(poc03Manifest);

  // Verify all sync anchors are within <= 1 frame budget
  for (const anchor of mix.syncAnchors) {
    assert.equal(
      anchor.passed,
      true,
      `Sync anchor ${anchor.label} exceeded 1 frame budget: delta=${anchor.deltaFrames} frames`
    );
    assert.ok(
      anchor.deltaFrames <= 1.0,
      `Sync delta ${anchor.deltaFrames} <= 1.0 frame`
    );
    assert.ok(
      anchor.deltaMs <= 33.34,
      `Sync delta ${anchor.deltaMs}ms <= 33.34ms (1 frame at 30fps)`
    );
  }

  // Verify subtitle alignment against known speech cue timing (Testing.md: Caption cue anchors so với known speech timing <= 1 frame)
  const subTrack = poc03Manifest.subtitles[0];
  const speechCueAnchors = [
    { frame: 45, timeSec: 1.5, label: 'speech_cue_1' },
    { frame: 345, timeSec: 11.5, label: 'speech_cue_2' },
    { frame: 690, timeSec: 23.0, label: 'speech_cue_3' },
    { frame: 1005, timeSec: 33.5, label: 'speech_cue_4' },
  ];

  const syncReport = validateSubtitleSync(subTrack, speechCueAnchors, poc03Manifest.fps);
  assert.equal(syncReport.cuesCount, 4);
  assert.equal(syncReport.allAnchorsWithinOneSampleFrame, true);
  assert.ok(syncReport.maxDiscrepancyFrames <= 1.0);
  assert.ok(syncReport.maxDiscrepancyMs <= 33.34);
});

// -----------------------------------------------------------------------------
// Test 9: Audio vs Video Duration Parity (<= 1 Frame)
// -----------------------------------------------------------------------------
test('POC-03: Decoded Audio vs Video Duration Parity (<= 1 Frame)', () => {
  const mix = mixAudioTracks(poc03Manifest);

  assert.equal(mix.durationParityPassed, true);
  assert.ok(
    mix.audioVideoDurationDeltaFrames <= 1.0,
    `Audio vs video duration delta ${mix.audioVideoDurationDeltaFrames} frames <= 1.0 frame`
  );
  assert.ok(
    mix.audioVideoDurationDeltaMs <= 33.34,
    `Duration delta ${mix.audioVideoDurationDeltaMs}ms <= 33.34ms`
  );
});

// -----------------------------------------------------------------------------
// Test 10: Editable Revision 2 Parity & Re-render
// -----------------------------------------------------------------------------
test('POC-03: Editable Revision 2 Parity & Provenance Re-render', async () => {
  assert.equal(poc03Rev2Manifest.revision, 2);
  assert.equal(poc03Rev2Manifest.composition_id, 'cmp_poc03_footage');
  assert.equal(poc03Rev2Manifest.duration_frames, 1350);

  // Scene durations were edited in revision 2
  assert.equal(poc03Rev2Manifest.scenes[0].duration_frames, 600);
  assert.equal(poc03Rev2Manifest.scenes[1].duration_frames, 750);

  // Spec hash and render hash must be distinct from revision 1
  assert.notEqual(poc03Rev2Manifest.spec_hash, poc03Manifest.spec_hash);
  assert.notEqual(poc03Rev2Manifest.render_hash, poc03Manifest.render_hash);

  // Render revision 2 through baseline renderer
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc03Rev2Manifest);

  const frame0 = await session.seek(0);
  const frame600 = await session.seek(600); // Scene 2 start in revision 2
  assert.equal(frame600.sceneId, 'scene_clip_b');
  assert.equal(frame600.sceneRevision, 2);

  await session.dispose();
});

// -----------------------------------------------------------------------------
// Test 11: FFmpeg Argv Command Generation for POC-03
// -----------------------------------------------------------------------------
test('POC-03: FFmpeg Command Assembly with Multi-Track Audio & Subtitle Burn-In', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc03Manifest);

  const cmd = session.generateFfmpegCommand({
    outputPath: '/tmp/poc03_output.mp4',
    crf: 20,
    preset: 'medium',
    burnInSubtitles: true,
    subtitleFilePath: '/tmp/poc03_captions.srt',
    forceStyle: 'FontName=Inter,FontSize=26,MarginV=56',
    audioTrackFiles: {
      ast_audio_music_ambient: '/tmp/music.wav',
      ast_audio_speech_guide: '/tmp/voice.wav',
    },
  });

  // Security whitelist
  assert.ok(cmd.argv.includes('-nostdin'));
  assert.ok(cmd.argv.includes('-protocol_whitelist'));
  assert.ok(cmd.argv.includes('file,pipe'));

  // Video codec
  assert.ok(cmd.argv.includes('libx264'));
  assert.ok(cmd.argv.includes('yuv420p'));
  assert.ok(cmd.argv.includes('+faststart'));

  // Audio multi-track
  assert.equal(cmd.audioTracksIncluded, 2);
  assert.ok(cmd.argv.includes('/tmp/music.wav'));
  assert.ok(cmd.argv.includes('/tmp/voice.wav'));

  // Subtitle burn-in
  assert.equal(cmd.subtitlesIncluded, true);
  assert.ok(cmd.commandLine.includes('subtitles='));
  assert.ok(cmd.commandLine.includes('FontName=Inter'));

  await session.dispose();
});

// -----------------------------------------------------------------------------
// Test 12: Visual Golden Frames Determinism
// -----------------------------------------------------------------------------
test('POC-03: Visual Golden Frames Determinism & Binary Integrity', async () => {
  const renderer = new ChromiumBaselineRenderer();
  const session = await renderer.prepare(poc03Manifest);

  const goldenIndices = [0, 30, 45, 330, 480, 674, 675, 990, 1320, 1349];
  const firstPassChecksums = new Map();

  for (const idx of goldenIndices) {
    const cap = await session.captureFrame(idx, 'png');
    assert.equal(cap.width, 720);
    assert.equal(cap.height, 1280);
    assert.equal(cap.format, 'png');

    // PNG signature check
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(cap.buffer.subarray(0, 8), sig);

    firstPassChecksums.set(idx, cap.checksumSha256);
  }

  // Second pass non-linear random seek verification
  const shuffledIndices = [1349, 0, 480, 45, 675, 30, 1320, 330, 674, 990];
  for (const idx of shuffledIndices) {
    const cap = await session.captureFrame(idx, 'png');
    assert.equal(
      cap.checksumSha256,
      firstPassChecksums.get(idx),
      `Checksum divergence at frame ${idx} between linear and non-linear seek`
    );
  }

  await session.dispose();
});
