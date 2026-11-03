import test from 'node:test';
import assert from 'node:assert/strict';
import { compileComposition } from '@creativanta/contracts';
import {
  TtsServiceImpl,
  AudioFallbackResolver,
} from '@creativanta/sdk';

import {
  NARRATED_EXPLAINER_TEMPLATE,
  RETAIL_PROMO_TEMPLATE,
} from '../dist/index.js';

test('Templates: Narrated Explainer Template Compiles Cleanly', () => {
  assert.equal(NARRATED_EXPLAINER_TEMPLATE.id, 'tpl_narrated_explainer_v1');
  assert.equal(NARRATED_EXPLAINER_TEMPLATE.revision, 1);
  assert.equal(NARRATED_EXPLAINER_TEMPLATE.composition_spec.duration_frames, 900);
  assert.equal(NARRATED_EXPLAINER_TEMPLATE.composition_spec.canvas.width, 1280);
  assert.equal(NARRATED_EXPLAINER_TEMPLATE.composition_spec.canvas.height, 720);

  const manifest = compileComposition(NARRATED_EXPLAINER_TEMPLATE.composition_spec, {
    profile: 'mp4-720p-v1',
  });

  assert.equal(manifest.duration_frames, 900);
  assert.equal(manifest.duration_seconds, 30);
  assert.equal(manifest.scenes.length, 4);
  assert.equal(manifest.audio_tracks.length, 1);
  assert.equal(manifest.subtitles.length, 1);
});

test('Templates: Retail Promo Template Compiles Cleanly', () => {
  assert.equal(RETAIL_PROMO_TEMPLATE.id, 'tpl_retail_promo_v1');
  assert.equal(RETAIL_PROMO_TEMPLATE.revision, 1);
  assert.equal(RETAIL_PROMO_TEMPLATE.composition_spec.duration_frames, 450);
  assert.equal(RETAIL_PROMO_TEMPLATE.composition_spec.canvas.width, 720);
  assert.equal(RETAIL_PROMO_TEMPLATE.composition_spec.canvas.height, 1280);

  const manifest = compileComposition(RETAIL_PROMO_TEMPLATE.composition_spec, {
    profile: 'mp4-720p-v1',
  });

  assert.equal(manifest.duration_frames, 450);
  assert.equal(manifest.duration_seconds, 15);
  assert.equal(manifest.scenes.length, 3);
  assert.equal(manifest.audio_tracks.length, 1);
});

test('Templates: Audio Track Resolution with TTS and Upload Fallback Integration', async () => {
  const service = new TtsServiceImpl();
  const resolver = new AudioFallbackResolver({
    ttsService: service,
    ttsEnabled: true,
  });

  // 1. Template default narration with TTS enabled
  const trackResolvedTts = await resolver.resolveAudioTrack({
    trackId: 'track_explainer_narration',
    role: 'voice',
    ttsSpec: {
      text: NARRATED_EXPLAINER_TEMPLATE.defaults.narration_tts_text,
      locale: 'vi-VN',
    },
    uploadFallbackAssetId: NARRATED_EXPLAINER_TEMPLATE.defaults.upload_fallback_asset_id,
  });

  assert.equal(trackResolvedTts.source, 'tts');
  assert.equal(trackResolvedTts.fallbackEngaged, false);
  assert.ok(trackResolvedTts.assetId.startsWith('ast_tts_'));
  assert.ok(trackResolvedTts.provenance);
  assert.equal(trackResolvedTts.provenance.termsReviewStatus, 'reviewed_approved');

  // 2. Template narration with TTS disabled -> engages upload fallback
  resolver.setTtsEnabled(false);
  const trackResolvedFallback = await resolver.resolveAudioTrack(
    {
      trackId: 'track_explainer_narration',
      role: 'voice',
      ttsSpec: {
        text: NARRATED_EXPLAINER_TEMPLATE.defaults.narration_tts_text,
        locale: 'vi-VN',
      },
      uploadFallbackAssetId: NARRATED_EXPLAINER_TEMPLATE.defaults.upload_fallback_asset_id,
    },
    { durationSeconds: 30.0, durationFrames: 900 }
  );

  assert.equal(trackResolvedFallback.source, 'upload_fallback');
  assert.equal(trackResolvedFallback.fallbackEngaged, true);
  assert.equal(trackResolvedFallback.fallbackReason, 'TTS_DISABLED');
  assert.equal(
    trackResolvedFallback.assetId,
    NARRATED_EXPLAINER_TEMPLATE.defaults.upload_fallback_asset_id
  );
  assert.equal(trackResolvedFallback.durationFrames, 900);
});
