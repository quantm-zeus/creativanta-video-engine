import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTextLayout,
  validateCompositionTextOverflow,
  TextOverflowError,
  estimateStringWidth,
} from '../dist/index.js';

test('Text Overflow: Normal Text Fits Within Bounding Box', () => {
  const layout = calculateTextLayout({
    text: 'Khuyến mãi đặc biệt!',
    fontSize: 48,
    lineHeight: 1.2,
    box: { width: 600, height: 150 },
    maxLines: 2,
    overflow: 'error',
  });

  assert.equal(layout.fits, true);
  assert.equal(layout.overflowDetected, false);
  assert.ok(layout.lineCount <= 2);
  assert.ok(layout.requiredHeight <= 150);
});

test('Text Overflow: Detects Overflow when Text Exceeds Max Lines (Error Mode)', () => {
  const longText =
    'Đây là đoạn văn bản tiếng Việt cực kỳ dài nhằm mục đích kiểm tra khả năng tự động phát hiện tràn chữ (overflow error) của hệ thống render video tự động khi số dòng vượt quá giới hạn tối đa cho phép trên giao diện người dùng.';

  const layout = calculateTextLayout({
    text: longText,
    fontSize: 40,
    lineHeight: 1.2,
    box: { width: 400, height: 100 },
    maxLines: 2,
    overflow: 'error',
  });

  assert.equal(layout.fits, false);
  assert.equal(layout.overflowDetected, true);
  assert.ok(layout.lineCount > 2);
  assert.ok(layout.overflowReason.includes('exceeding max_lines'));
});

test('Text Overflow: Shrink Mode Dynamically Scales Down Font Size', () => {
  const text = 'Creativanta Video Engine';

  const layout = calculateTextLayout({
    text,
    fontSize: 50,
    lineHeight: 1.2,
    box: { width: 500, height: 80 },
    maxLines: 1,
    minFontSize: 24,
    overflow: 'shrink',
  });

  assert.equal(layout.fits, true);
  assert.equal(layout.overflowDetected, false);
  assert.ok(layout.computedFontSize < 50);
  assert.ok(layout.computedFontSize >= 24);
  assert.equal(layout.lineCount, 1);
});

test('Text Overflow: Ellipsis Mode Truncates Long Text Gracefully', () => {
  const longText =
    'Đoạn văn bản sẽ bị cắt ngắn bằng dấu chấm lửng ở cuối dòng tối đa để bảo đảm không vỡ bố cục thiết kế đồ họa.';

  const layout = calculateTextLayout({
    text: longText,
    fontSize: 36,
    lineHeight: 1.2,
    box: { width: 350, height: 100 },
    maxLines: 2,
    overflow: 'ellipsis',
  });

  assert.equal(layout.fits, true);
  assert.equal(layout.overflowDetected, true);
  assert.equal(layout.lineCount, 2);
  assert.ok(layout.truncatedText.endsWith('…'));
});

test('Text Overflow: Vietnamese NFC / Tone Marks and Diacritics Width Calculation', () => {
  const str = 'Trường học Đắk Lắk 199.000 ₫';
  const width = estimateStringWidth(str, 30);
  assert.ok(width > 0);
  // Ensure non-zero and finite width
  assert.ok(Number.isFinite(width));
});

test('Text Overflow: Validates Entire Composition and Throws TextOverflowError', () => {
  const validSpec = {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#000000' },
    fps: { num: 30, den: 1 },
    duration_frames: 300,
    seed: 1,
    locale: 'vi-VN',
    direction: 'ltr',
    fonts: [{ id: 'f1', asset_id: 'a1', sha256: 'aa', family: 'Inter', weight: 400, style: 'normal' }],
    scenes: [
      {
        id: 's1',
        revision: 1,
        start_frame: 0,
        duration_frames: 300,
        engine: 'html-v1',
        transition_out: { type: 'cut', duration_frames: 0 },
        layers: [
          {
            id: 'l_fit',
            type: 'text',
            start_frame: 0,
            duration_frames: 300,
            z_index: 1,
            box: { x: 50, y: 50, width: 600, height: 150 },
            content: {
              text: 'Vừa vặn',
              font_id: 'f1',
              font_size: 32,
              color: '#FFF',
              overflow: 'error',
              max_lines: 3,
            },
          },
        ],
      },
    ],
    audio_tracks: [],
    subtitles: [],
  };

  // Should pass cleanly
  assert.doesNotThrow(() => validateCompositionTextOverflow(validSpec));

  // Now inject overflowing text
  const overflowingSpec = JSON.parse(JSON.stringify(validSpec));
  overflowingSpec.scenes[0].layers[0].content.text =
    'Đây là đoạn văn bản bị cố tình kéo dài rất nhiều lần để chắc chắn gây ra lỗi TEXT_OVERFLOW trong quá trình preflight layout check của hệ thống render video Creativanta, bảo vệ an toàn thương hiệu.';
  overflowingSpec.scenes[0].layers[0].box.height = 40; // Tiny box height
  overflowingSpec.scenes[0].layers[0].content.max_lines = 1;

  assert.throws(
    () => validateCompositionTextOverflow(overflowingSpec),
    (err) => {
      assert.ok(err instanceof TextOverflowError);
      assert.equal(err.details[0].code, 'TEXT_OVERFLOW');
      assert.equal(err.details[0].layerId, 'l_fit');
      assert.equal(err.details[0].sceneId, 's1');
      return true;
    },
  );
});
