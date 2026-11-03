import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioFallbackResolver,
  TtsServiceImpl,
  TermsReviewRegistry,
  TtsBudgetLimiter,
  AudioResolutionError,
} from '../dist/index.js';

test('Audio Fallback: Direct Upload Pass-Through', async () => {
  const resolver = new AudioFallbackResolver({ ttsEnabled: false });

  // Direct upload track (no TTS spec)
  const track = await resolver.resolveAudioTrack(
    {
      trackId: 'track_bgm',
      role: 'music',
      uploadFallbackAssetId: 'ast_uploaded_bgm_01',
      gainDb: -6,
    },
    { durationSeconds: 15.0, durationFrames: 450 }
  );

  assert.equal(track.trackId, 'track_bgm');
  assert.equal(track.assetId, 'ast_uploaded_bgm_01');
  assert.equal(track.source, 'direct_upload');
  assert.equal(track.fallbackEngaged, false);
  assert.equal(track.durationSeconds, 15.0);
  assert.equal(track.durationFrames, 450);
  assert.equal(track.gainDb, -6);
});

test('Audio Fallback: TTS Disabled Engages Upload Audio Baseline', async () => {
  const resolver = new AudioFallbackResolver({ ttsEnabled: false });

  const track = await resolver.resolveAudioTrack(
    {
      trackId: 'track_narration_01',
      role: 'voice',
      ttsSpec: {
        text: 'Nội dung thuyết minh tự động khi TTS bị vô hiệu hóa',
        locale: 'vi-VN',
      },
      uploadFallbackAssetId: 'ast_uploaded_fallback_voice',
    },
    { durationSeconds: 5.0, durationFrames: 150 }
  );

  assert.equal(track.assetId, 'ast_uploaded_fallback_voice');
  assert.equal(track.source, 'upload_fallback');
  assert.equal(track.fallbackEngaged, true);
  assert.equal(track.fallbackReason, 'TTS_DISABLED');
});

test('Audio Fallback: TTS Disabled Rejects when No Upload Fallback Provided', async () => {
  const resolver = new AudioFallbackResolver({ ttsEnabled: false });

  await assert.rejects(
    async () => {
      await resolver.resolveAudioTrack({
        trackId: 'track_narration_fail',
        role: 'voice',
        ttsSpec: {
          text: 'Không có tệp âm thanh tải lên dự phòng',
          locale: 'vi-VN',
        },
        // uploadFallbackAssetId omitted!
      });
    },
    (err) => {
      assert.ok(err instanceof AudioResolutionError);
      assert.equal(err.code, 'AUDIO_ASSET_UNRESOLVABLE');
      return true;
    }
  );
});

test('Audio Fallback: TTS Enabled Synthesizes Successfully', async () => {
  const service = new TtsServiceImpl();
  const resolver = new AudioFallbackResolver({
    ttsService: service,
    ttsEnabled: true,
  });

  const track = await resolver.resolveAudioTrack({
    trackId: 'track_voice_success',
    role: 'voice',
    ttsSpec: {
      text: 'Thuyết minh tự động thành công với đầy đủ xuất xứ',
      locale: 'vi-VN',
    },
    uploadFallbackAssetId: 'ast_uploaded_not_used',
  });

  assert.ok(track.assetId.startsWith('ast_tts_'));
  assert.equal(track.source, 'tts');
  assert.equal(track.fallbackEngaged, false);
  assert.equal(track.fallbackReason, undefined);
  assert.ok(track.provenance);
  assert.ok(track.audioBuffer);
  assert.ok(track.durationSeconds > 0);
});

test('Audio Fallback: Terms Unreviewed Falls Back Gracefully to Uploaded Audio', async () => {
  const emptyRegistry = new TermsReviewRegistry(false); // No reviewed voices
  const service = new TtsServiceImpl({ termsRegistry: emptyRegistry });

  const resolver = new AudioFallbackResolver({
    ttsService: service,
    ttsEnabled: true,
  });

  const track = await resolver.resolveAudioTrack(
    {
      trackId: 'track_unreviewed_voice',
      role: 'voice',
      ttsSpec: {
        text: 'Thử nghiệm giọng đọc chưa được pháp lý duyệt',
        locale: 'vi-VN',
      },
      uploadFallbackAssetId: 'ast_legal_safe_upload_asset',
    },
    { durationSeconds: 6.0, durationFrames: 180 }
  );

  assert.equal(track.assetId, 'ast_legal_safe_upload_asset');
  assert.equal(track.source, 'upload_fallback');
  assert.equal(track.fallbackEngaged, true);
  assert.equal(track.fallbackReason, 'UNREVIEWED_TERMS');
});

test('Audio Fallback: Budget Exceeded Falls Back Gracefully to Uploaded Audio', async () => {
  const limiter = new TtsBudgetLimiter({
    maxCharactersPerRequest: 20, // Tiny request limit
  });
  const service = new TtsServiceImpl({ budgetLimiter: limiter });

  const resolver = new AudioFallbackResolver({
    ttsService: service,
    ttsEnabled: true,
  });

  const track = await resolver.resolveAudioTrack(
    {
      trackId: 'track_budget_exceeded',
      role: 'voice',
      ttsSpec: {
        text: 'Đoạn văn bản thuyết minh này chắc chắn dài hơn hai mươi ký tự giới hạn',
        locale: 'vi-VN',
      },
      uploadFallbackAssetId: 'ast_budget_fallback_audio',
    },
    { durationSeconds: 4.0, durationFrames: 120 }
  );

  assert.equal(track.assetId, 'ast_budget_fallback_audio');
  assert.equal(track.source, 'upload_fallback');
  assert.equal(track.fallbackEngaged, true);
  assert.equal(track.fallbackReason, 'BUDGET_EXCEEDED');
});
