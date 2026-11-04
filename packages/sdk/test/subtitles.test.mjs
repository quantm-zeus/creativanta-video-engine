import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSrt,
  parseVtt,
  importSubtitles,
  generateSrtSidecar,
  generateVttSidecar,
  exportSubtitleSidecars,
  calculateSubtitleLayout,
  getActiveSubtitleCue,
  applySubtitlesToComposition,
  frameToMs,
  msToFrame,
  sanitizeSubtitleText,
} from '../dist/subtitles/index.js';

test('Subtitles: Frame and Millisecond Rational Conversion', () => {
  const fps30 = { num: 30, den: 1 };

  // Frame 0 -> 0ms
  assert.equal(frameToMs(0, fps30), 0);
  assert.equal(msToFrame(0, fps30), 0);

  // Frame 30 -> 1000ms
  assert.equal(frameToMs(30, fps30), 1000);
  assert.equal(msToFrame(1000, fps30), 30);

  // Frame 1 -> 33ms (round_half_up)
  assert.equal(frameToMs(1, fps30), 33);
  assert.equal(msToFrame(33, fps30), 1);

  // Frame 450 -> 15000ms
  assert.equal(frameToMs(450, fps30), 15000);
  assert.equal(msToFrame(15000, fps30), 450);
});

test('Subtitles: Parses Standard SRT Content with Vietnamese NFC Diacritics', () => {
  const srtInput = `
1
00:00:01,000 --> 00:00:04,500
Chào mừng bạn đến với Đắk Lắk!

2
00:00:05,000 --> 00:00:08,200
Thủ phủ cà phê lớn nhất Việt Nam.
Chi phí tham quan chỉ từ 199.000 ₫.
`;

  const cues = parseSrt(srtInput, { fps: { num: 30, den: 1 } });
  assert.equal(cues.length, 2);

  // Cue 1
  assert.equal(cues[0].id, 'cue_001');
  assert.equal(cues[0].start_frame, 30);
  assert.equal(cues[0].end_frame, 135);
  assert.equal(cues[0].text, 'Chào mừng bạn đến với Đắk Lắk!');

  // Cue 2
  assert.equal(cues[1].id, 'cue_002');
  assert.equal(cues[1].start_frame, 150);
  assert.equal(cues[1].end_frame, 246);
  assert.ok(cues[1].text.includes('199.000 ₫'));
  assert.equal(cues[1].text.normalize('NFC'), cues[1].text);
});

test('Subtitles: Parses Standard WebVTT Content with Header and Comments', () => {
  const vttInput = `WEBVTT - Demo Captions
NOTE Sample WebVTT file for Creativanta Video Engine

cue_intro
00:00:00.500 --> 00:00:03.000
Khám phá công nghệ tự động hoá video.

cue_solution
00:00:03.500 --> 00:00:07.000
Giải pháp tối ưu trên nền tảng CPU.
`;

  const cues = parseVtt(vttInput, { fps: { num: 30, den: 1 } });
  assert.equal(cues.length, 2);

  assert.equal(cues[0].id, 'cue_intro');
  assert.equal(cues[0].start_frame, 15);
  assert.equal(cues[0].end_frame, 90);
  assert.equal(cues[0].text, 'Khám phá công nghệ tự động hoá video.');

  assert.equal(cues[1].id, 'cue_solution');
  assert.equal(cues[1].start_frame, 105);
  assert.equal(cues[1].end_frame, 210);
});

test('Subtitles: Security Guard Blocks Malicious Script / HTML Injection Payloads', () => {
  const maliciousSrt = `
1
00:00:01,000 --> 00:00:03,000
<script>alert('pwned')</script>
`;

  assert.throws(
    () => parseSrt(maliciousSrt),
    /malicious payload detected/
  );

  const iframeVtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<iframe src="javascript:evil()"></iframe>
`;

  assert.throws(
    () => parseVtt(iframeVtt),
    /malicious payload detected/
  );

  // Benign HTML tags (e.g. <b> or <i>) should be stripped safely without error
  const benign = '<b>Đắk Lắk</b> — <i>Hương Sắc Cao Nguyên</i>';
  const sanitized = sanitizeSubtitleText(benign, true);
  assert.equal(sanitized, 'Đắk Lắk — Hương Sắc Cao Nguyên');
});

test('Subtitles: Enforces Monotonic Non-Overlapping Cue Sequence', () => {
  const overlappingSrt = `
1
00:00:01,000 --> 00:00:05,000
Phân cảnh đầu tiên

2
00:00:04,000 --> 00:00:08,000
Phân cảnh thứ hai bị đè thời gian
`;

  assert.throws(
    () => parseSrt(overlappingSrt),
    /Subtitle cue overlap detected/
  );
});

test('Subtitles: Enforces Cue Limits (Max 500 Cues, Max 1000 Chars)', () => {
  // Test max chars per cue
  const hugeText = 'A'.repeat(1001);
  assert.throws(
    () => sanitizeSubtitleText(hugeText),
    /exceeds maximum length of 1000/
  );

  // Test max cues limit
  const manyBlocks = [];
  for (let i = 0; i < 6; i++) {
    manyBlocks.push(`${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\nCue #${i + 1}`);
  }
  const srtData = manyBlocks.join('\n\n');
  assert.throws(
    () => parseSrt(srtData, { maxCues: 5 }),
    /exceeds maximum allowed of 5/
  );
});

test('Subtitles: Generates Standard SRT and WebVTT Sidecars', () => {
  const track = {
    id: 'sub_vi',
    locale: 'vi-VN',
    cues: [
      { id: 'cue_01', start_frame: 30, end_frame: 90, text: 'Học tập mỗi ngày.' },
      { id: 'cue_02', start_frame: 120, end_frame: 180, text: 'Rèn luyện kỹ năng.' },
    ],
  };

  const srt = generateSrtSidecar(track, { num: 30, den: 1 });
  assert.ok(srt.includes('1\n00:00:01,000 --> 00:00:03,000\nHọc tập mỗi ngày.'));
  assert.ok(srt.includes('2\n00:00:04,000 --> 00:00:06,000\nRèn luyện kỹ năng.'));

  const vtt = generateVttSidecar(track, { num: 30, den: 1 });
  assert.ok(vtt.startsWith('WEBVTT'));
  assert.ok(vtt.includes('NOTE Language: vi-VN'));
  assert.ok(vtt.includes('cue_01\n00:00:01.000 --> 00:00:03.000\nHọc tập mỗi ngày.'));

  const sidecars = exportSubtitleSidecars(track, { num: 30, den: 1 });
  assert.equal(sidecars.cuesCount, 2);
  assert.equal(sidecars.durationMs, 6000);
});

test('Subtitles: Burn-In Text Layout & Vietnamese Grapheme Wrapping', () => {
  const style = {
    font_id: 'brand_bold',
    font_size: 36,
    color: '#FFFFFF',
    safe_margin_px: 48,
    max_lines: 2,
  };

  const cue = {
    id: 'cue_test',
    start_frame: 0,
    end_frame: 150,
    text: 'Đắk Lắk — Hương sắc cao nguyên và tinh hoa cà phê.',
  };

  // Canvas 720x1280 (available width = 720 - 96 = 624)
  const layout = calculateSubtitleLayout(cue, style, 720, 1280);
  assert.ok(layout.lineCount <= 2, 'Must wrap into at most 2 lines');
  assert.ok(layout.fitsMaxLines);
  assert.ok(layout.fitsSafeMargin);
  assert.equal(layout.overflowDetected, false);

  // Verify diacritics in lines remain normalized
  for (const line of layout.lines) {
    assert.equal(line.text.normalize('NFC'), line.text);
  }
});

test('Subtitles: Active Cue Query by Frame and Composition Integration', () => {
  const track = {
    id: 'sub_vi',
    locale: 'vi-VN',
    cues: [
      { id: 'cue_01', start_frame: 30, end_frame: 90, text: 'Phần mở đầu' },
      { id: 'cue_02', start_frame: 100, end_frame: 200, text: 'Phần giải pháp' },
    ],
  };

  assert.equal(getActiveSubtitleCue([track], 10), null);
  const active30 = getActiveSubtitleCue([track], 30);
  assert.ok(active30);
  assert.equal(active30.cue.id, 'cue_01');

  const active150 = getActiveSubtitleCue([track], 150);
  assert.ok(active150);
  assert.equal(active150.cue.id, 'cue_02');

  const active250 = getActiveSubtitleCue([track], 250);
  assert.equal(active250, null);

  // Integrate into composition
  const spec = {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#000000' },
    fps: { num: 30, den: 1 },
    duration_frames: 450,
    seed: 123,
    locale: 'vi-VN',
    fonts: [{ id: 'brand_bold', asset_id: 'ast_font_inter_bold', sha256: 'abc', family: 'Inter', weight: 700, style: 'normal' }],
    scenes: [],
    audio_tracks: [],
    subtitles: [],
  };

  const updated = applySubtitlesToComposition(spec, track, {
    canvasWidth: 720,
    canvasHeight: 1280,
    safeMarginPx: 48,
    maxLines: 2,
  });

  assert.equal(updated.subtitles.length, 1);
  assert.equal(updated.subtitles[0].burn_in, true);
  assert.equal(updated.subtitles[0].style?.safe_margin_px, 48);
});
