import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TtsServiceImpl,
  OfflineTtsAdapter,
  TermsReviewRegistry,
  TtsBudgetLimiter,
  MemoryTtsCache,
} from '../dist/index.js';

test('TTS Interface: Initialization and Voice Discovery', async () => {
  const service = new TtsServiceImpl();
  const voices = await service.listAvailableVoices();

  assert.ok(voices.length >= 3, `Expected at least 3 voices, got ${voices.length}`);

  const viVoices = await service.listAvailableVoices('vi-VN');
  assert.ok(viVoices.length >= 2, 'Expected at least 2 Vietnamese voices');

  const hoaiMy = viVoices.find((v) => v.id === 'vi-VN-HoaiMy-Neural');
  assert.ok(hoaiMy, 'Expected vi-VN-HoaiMy-Neural voice');
  assert.equal(hoaiMy.locale, 'vi-VN');
  assert.equal(hoaiMy.gender, 'female');
  assert.equal(hoaiMy.sampleRate, 48000);
  assert.equal(hoaiMy.channels, 2);

  const namMinh = viVoices.find((v) => v.id === 'vi-VN-NamMinh-Neural');
  assert.ok(namMinh, 'Expected vi-VN-NamMinh-Neural voice');
  assert.equal(namMinh.gender, 'male');

  const enVoices = await service.listAvailableVoices('en-US');
  assert.ok(enVoices.length >= 1, 'Expected at least 1 English voice');
});

test('TTS Interface: Basic 48kHz Stereo WAV Synthesis', async () => {
  const service = new TtsServiceImpl();

  const text = 'Chào mừng bạn đến với Creativanta Video Engine.';
  const result = await service.synthesize({
    text,
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
    speechRate: 1.0,
    targetFps: 30,
    tenantId: 'tenant_test_01',
  });

  // 1. Result Structure
  assert.ok(result.assetId.startsWith('ast_tts_'));
  assert.equal(result.fromCache, false);
  assert.equal(result.sampleRate, 48000);
  assert.equal(result.channels, 2);
  assert.equal(result.bitDepth, 16);
  assert.ok(result.durationSeconds > 1.0);
  assert.ok(result.durationFrames > 30);
  assert.equal(result.durationFrames, Math.ceil(result.durationSeconds * 30));

  // 2. Binary WAV Header Verification
  const buf = result.audioBuffer;
  assert.ok(buf.length > 44, 'Buffer must be larger than 44-byte WAV header');
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'fmt ');
  assert.equal(buf.readUInt16LE(20), 1, 'AudioFormat must be 1 (PCM)');
  assert.equal(buf.readUInt16LE(22), 2, 'Channels must be 2 (stereo)');
  assert.equal(buf.readUInt32LE(24), 48000, 'SampleRate must be 48000');
  assert.equal(buf.readUInt16LE(34), 16, 'BitsPerSample must be 16');
  assert.equal(buf.subarray(36, 40).toString('ascii'), 'data');

  // 3. Audio SHA-256
  assert.equal(result.audioSha256.length, 64);
  assert.equal(result.provenance.audioSha256, result.audioSha256);
});

test('TTS Interface: Empty Text Validation Rejection', async () => {
  const service = new TtsServiceImpl();

  await assert.rejects(
    async () => {
      await service.synthesize({
        text: '   ',
        locale: 'vi-VN',
      });
    },
    {
      code: 'EMPTY_TEXT',
    }
  );
});

test('TTS Interface: Speech Rate and Pitch Adjustments', async () => {
  const service = new TtsServiceImpl();
  const text = 'Kiểm tra tốc độ đọc và cao độ âm thanh.';

  // Standard rate
  const resNormal = await service.synthesize({
    text,
    locale: 'vi-VN',
    speechRate: 1.0,
  });

  // Fast rate (1.5x)
  const resFast = await service.synthesize({
    text,
    locale: 'vi-VN',
    speechRate: 1.5,
  });

  // Fast synthesis must be shorter in duration
  assert.ok(
    resFast.durationSeconds < resNormal.durationSeconds,
    `Fast duration (${resFast.durationSeconds}s) should be less than normal (${resNormal.durationSeconds}s)`
  );
});
