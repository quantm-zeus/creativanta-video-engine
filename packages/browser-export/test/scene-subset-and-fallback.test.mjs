import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateSceneSubset,
  APPROVED_BROWSER_EXPORT_SUBSET,
  computeFallbackIdempotencyKey,
  MockServerJobDispatcher,
  executeServerJobFallback,
  exportBrowserVideo,
} from '../dist/index.js';

describe('P8-02: Scene Subset & Server Fallback Suite', () => {
  const baseValidSpec = {
    canvas: { width: 1280, height: 720, background: '#111827' },
    fps: { num: 30, den: 1 },
    duration_frames: 300,
    scenes: [
      {
        id: 'scene_intro',
        duration_frames: 150,
        layers: [
          {
            id: 'layer_bg',
            type: 'shape',
            content: { shape: 'rect', fill: '#1f2937' },
          },
          {
            id: 'layer_heading',
            type: 'text',
            content: { text: 'Khuyến mãi đặc biệt mùa hè', fontSize: 48, color: '#ffffff' },
          },
        ],
      },
      {
        id: 'scene_cta',
        duration_frames: 150,
        layers: [
          {
            id: 'layer_cta_text',
            type: 'text',
            content: { text: 'Mua ngay hôm nay', fontSize: 36, color: '#f59e0b' },
          },
        ],
      },
    ],
  };

  it('1.1 Conforming scene subset: accepts valid 720p composition with text and shape layers', () => {
    const res = validateSceneSubset(baseValidSpec, 'chrome-desktop');
    assert.equal(res.isSupported, true);
    assert.equal(res.unsupportedFeatures.length, 0);
    assert.ok(res.diagnostics.some((d) => d.includes('fully conforms')));
  });

  it('1.2 Custom engine detection: strictly rejects custom-html-v1 and triggers server fallback', () => {
    const customCodeSpec = {
      ...baseValidSpec,
      scenes: [
        {
          id: 'scene_custom',
          engine: 'custom-html-v1',
          bundle: { entry: 'index.html' },
          duration_frames: 150,
          layers: [],
        },
      ],
    };

    const res = validateSceneSubset(customCodeSpec, 'chrome-desktop');
    assert.equal(res.isSupported, false);
    assert.equal(res.reasonCode, 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
    assert.ok(res.unsupportedFeatures.includes('custom_code_engine'));
    assert.ok(res.diagnostics.some((d) => d.includes('custom-html-v1')));
  });

  it('1.3 Mobile memory protection: rejects 1080p and 4K on mobile (iOS Safari) to prevent Jetsam crash', () => {
    const hdSpec = {
      ...baseValidSpec,
      canvas: { width: 1920, height: 1080, background: '#000000' },
    };

    // Chrome desktop accepts 1080p
    const desktopRes = validateSceneSubset(hdSpec, 'chrome-desktop');
    assert.equal(desktopRes.isSupported, true);

    // iOS Safari rejects 1080p to prevent mobile Jetsam crash
    const iosRes = validateSceneSubset(hdSpec, 'ios-safari');
    assert.equal(iosRes.isSupported, false);
    assert.equal(iosRes.reasonCode, 'DIMENSIONS_EXCEED_PLATFORM_CAP');
    assert.ok(iosRes.unsupportedFeatures.some((f) => f.includes('dimensions_exceed_cap')));
  });

  it('1.4 Dimension cap check: rejects resolutions exceeding platform maximum', () => {
    const ultrawideSpec = {
      ...baseValidSpec,
      canvas: { width: 3840, height: 2160 },
    };

    const res = validateSceneSubset(ultrawideSpec, 'chrome-desktop');
    assert.equal(res.isSupported, false);
    assert.equal(res.reasonCode, 'DIMENSIONS_EXCEED_PLATFORM_CAP');
  });

  it('1.5 Duration ceiling check: rejects video durations exceeding platform maximum', () => {
    const longSpec = {
      ...baseValidSpec,
      duration_frames: 7200, // 4 minutes (exceeds 5400 cap)
    };

    const res = validateSceneSubset(longSpec, 'chrome-desktop');
    assert.equal(res.isSupported, false);
    assert.equal(res.reasonCode, 'EXCEEDS_MEMORY_BUDGET');
  });

  it('1.6 Unsupported layer type: rejects video decoder layer in 2D browser export spike', () => {
    const videoLayerSpec = {
      ...baseValidSpec,
      scenes: [
        {
          id: 'scene_video',
          duration_frames: 150,
          layers: [
            {
              id: 'layer_raw_video',
              type: 'video',
              content: { src: 'footage.mp4' },
            },
          ],
        },
      ],
    };

    const res = validateSceneSubset(videoLayerSpec, 'chrome-desktop');
    assert.equal(res.isSupported, false);
    assert.equal(res.reasonCode, 'UNSUPPORTED_BROWSER_PLATFORM');
    assert.ok(res.unsupportedFeatures.some((f) => f.includes('unsupported_layer_type:video')));
  });

  it('1.7 Idempotency key computation: generates deterministic canonical key for fallback', () => {
    const key1 = computeFallbackIdempotencyKey('cmp_promo_01', 2, 'CUSTOM_CODE_ENGINE_UNSUPPORTED', 'chrome-desktop');
    const key2 = computeFallbackIdempotencyKey('cmp_promo_01', 2, 'CUSTOM_CODE_ENGINE_UNSUPPORTED', 'chrome-desktop');
    const keyDiff = computeFallbackIdempotencyKey('cmp_promo_02', 2, 'CUSTOM_CODE_ENGINE_UNSUPPORTED', 'chrome-desktop');

    assert.equal(key1, key2);
    assert.notEqual(key1, keyDiff);
    assert.match(key1, /^idem_fb_cmp_promo_01_r2_[0-9a-f]{32}$/);
  });

  it('1.8 Server fallback execution: dispatches a new server render job with correct metadata', async () => {
    const dispatcher = new MockServerJobDispatcher();

    const fallbackResult = await executeServerJobFallback({
      compositionId: 'cmp_explainer_v1',
      revision: 3,
      profile: 'mp4-720p-v1',
      reasonCode: 'MISSING_VIDEO_ENCODER',
      diagnostics: ['Browser lacks hardware H.264 encoder'],
      platform: 'firefox-desktop',
      dispatcher,
    });

    assert.equal(fallbackResult.action, 'fallback_to_server_job');
    assert.equal(fallbackResult.reasonCode, 'MISSING_VIDEO_ENCODER');
    assert.equal(fallbackResult.admittedJob.state, 'queued');
    assert.equal(fallbackResult.admittedJob.kind, 'render');
    assert.equal(fallbackResult.admittedJob.composition_id, 'cmp_explainer_v1');
    assert.equal(fallbackResult.admittedJob.revision, 3);
    assert.equal(fallbackResult.admittedJob.profile, 'mp4-720p-v1');
    assert.equal(fallbackResult.admittedJob.isReplayed, false);

    assert.equal(dispatcher.dispatchedPayloads.length, 1);
    const recorded = dispatcher.dispatchedPayloads[0];
    assert.equal(recorded.payload.metadata?.['fallback_source'], 'browser_export_spike');
    assert.equal(recorded.payload.metadata?.['fallback_reason_code'], 'MISSING_VIDEO_ENCODER');
    assert.equal(recorded.payload.metadata?.['browser_platform'], 'firefox-desktop');
  });

  it('1.9 End-to-end pipeline fallback: exportBrowserVideo automatically creates server job on unsupported scene', async () => {
    const customCodeSpec = {
      ...baseValidSpec,
      scenes: [
        {
          id: 'scene_custom',
          engine: 'custom-html-v1',
          bundle: { entry: 'index.html' },
          duration_frames: 150,
          layers: [],
        },
      ],
    };

    const dispatcher = new MockServerJobDispatcher();
    const result = await exportBrowserVideo(customCodeSpec, {
      compositionId: 'cmp_unsupported_01',
      revision: 1,
      platform: 'chrome-desktop',
      serverDispatcher: dispatcher,
    });

    assert.equal(result.action, 'fallback_to_server_job');
    if (result.action === 'fallback_to_server_job') {
      assert.equal(result.reasonCode, 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
      assert.equal(result.admittedJob.state, 'queued');
      assert.equal(result.admittedJob.composition_id, 'cmp_unsupported_01');
      assert.equal(dispatcher.admittedJobs.length, 1);
    }
  });
});
