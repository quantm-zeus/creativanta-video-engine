import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoFlowAdapter } from '../dist/adapters/videoflow-adapter.js';

// Sample valid fixtures based on canonical SceneSpec v1
const SAMPLE_PROMO_COMPOSITION = {
  schema_version: '1.0',
  canvas: { width: 720, height: 1280, background: '#111827' },
  fps: { num: 30, den: 1 },
  duration_frames: 450,
  seed: 42,
  locale: 'vi-VN',
  fonts: [
    {
      id: 'inter-latin-400',
      asset_id: 'font-inter-regular',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      family: 'Inter',
      weight: 400,
      style: 'normal'
    }
  ],
  scenes: [
    {
      id: 'scene-promo-intro',
      revision: 1,
      start_frame: 0,
      duration_frames: 225,
      engine: 'html-v1',
      background: '#1F2937',
      transition_out: { type: 'cut', duration_frames: 0 },
      layers: [
        {
          id: 'layer-title-text',
          type: 'text',
          start_frame: 0,
          duration_frames: 225,
          z_index: 2,
          box: { x: 60, y: 200, width: 600, height: 180 },
          opacity: 1.0,
          transform: { scale_x: 1.0, scale_y: 1.0, rotate_deg: 0 },
          animations: [
            {
              property: 'opacity',
              easing: 'ease_out_quad',
              keyframes: [
                { frame: 0, value: 0.0 },
                { frame: 15, value: 1.0 }
              ]
            },
            {
              property: 'translate_y',
              easing: 'ease_out_quad',
              keyframes: [
                { frame: 0, value: 30 },
                { frame: 30, value: 0 }
              ]
            }
          ],
          content: {
            text: 'Khuyến mãi đặc biệt 50%',
            font_id: 'inter-latin-400',
            font_size: 44,
            color: '#F9FAFB',
            align: 'center'
          }
        },
        {
          id: 'layer-badge-shape',
          type: 'shape',
          start_frame: 15,
          duration_frames: 210,
          z_index: 1,
          box: { x: 160, y: 450, width: 400, height: 120 },
          content: {
            shape: 'rect',
            fill: '#EF4444',
            radius: 16
          }
        }
      ]
    },
    {
      id: 'scene-promo-cta',
      revision: 1,
      start_frame: 225,
      duration_frames: 225,
      engine: 'canvas-v1',
      background: '#111827',
      layers: [
        {
          id: 'layer-cta-text',
          type: 'text',
          start_frame: 0,
          duration_frames: 225,
          z_index: 2,
          box: { x: 80, y: 500, width: 560, height: 100 },
          content: {
            text: 'Mua ngay hôm nay tại Creativanta',
            font_id: 'inter-latin-400',
            font_size: 36,
            color: '#10B981',
            align: 'center'
          }
        }
      ]
    }
  ],
  audio_tracks: [
    {
      id: 'audio-bgm-master',
      asset_id: 'asset-bgm-upbeat',
      start_frame: 0,
      duration_frames: 450,
      source_in_samples: 0,
      gain_db: -12.0,
      role: 'music',
      fade_in_frames: 15,
      fade_out_frames: 30
    }
  ],
  subtitles: [
    {
      id: 'sub-track-vi',
      locale: 'vi-VN',
      cues: [
        {
          id: 'cue-01',
          start_frame: 10,
          end_frame: 120,
          text: 'Khuyến mãi đặc biệt mừng ra mắt dịch vụ!'
        },
        {
          id: 'cue-02',
          start_frame: 130,
          end_frame: 240,
          text: 'Áp dụng cho mọi sản phẩm trực tuyến.'
        }
      ]
    }
  ]
};

test('P8-03: VideoFlow Adapter Suite', async (t) => {
  const adapter = new VideoFlowAdapter();

  await t.test('1. canAdapt: accepts valid structured multi-scene composition', () => {
    const check = adapter.canAdapt(SAMPLE_PROMO_COMPOSITION);
    assert.equal(check.feasible, true);
    assert.equal(check.unsupportedFeatures.length, 0);
  });

  await t.test('2. canAdapt: strictly rejects custom-html-v1 scene engine (requires MicroVM P7)', () => {
    const invalidComp = {
      ...SAMPLE_PROMO_COMPOSITION,
      scenes: [
        {
          id: 'custom-scene-01',
          revision: 1,
          start_frame: 0,
          duration_frames: 150,
          engine: 'custom-html-v1',
          bundle: {
            id: 'bnd-01',
            revision: 1,
            source_sha256: 'a'.repeat(64),
            build_sha256: 'b'.repeat(64),
            entrypoint: 'index.html',
            parameters: {}
          }
        }
      ]
    };

    const check = adapter.canAdapt(invalidComp);
    assert.equal(check.feasible, false);
    assert.equal(check.reasonCode, 'CUSTOM_CODE_SCENE_UNSUPPORTED');
    assert.match(check.unsupportedFeatures[0], /custom-html-v1/);
  });

  await t.test('3. canAdapt: strictly rejects out-of-bounds dimensions, invalid fps, and excessive duration', () => {
    // Dimension too small
    const tooSmall = adapter.canAdapt({
      ...SAMPLE_PROMO_COMPOSITION,
      canvas: { width: 64, height: 64 }
    });
    assert.equal(tooSmall.feasible, false);
    assert.equal(tooSmall.reasonCode, 'INVALID_DIMENSIONS');

    // Dimension too large (>4K)
    const tooLarge = adapter.canAdapt({
      ...SAMPLE_PROMO_COMPOSITION,
      canvas: { width: 7680, height: 4320 }
    });
    assert.equal(tooLarge.feasible, false);
    assert.equal(tooLarge.reasonCode, 'DIMENSIONS_EXCEED_BOUNDS');

    // Negative FPS
    const badFps = adapter.canAdapt({
      ...SAMPLE_PROMO_COMPOSITION,
      fps: { num: -30, den: 1 }
    });
    assert.equal(badFps.feasible, false);
    assert.equal(badFps.reasonCode, 'INVALID_FPS');

    // Exceeds 3600 frames limit
    const tooLong = adapter.canAdapt({
      ...SAMPLE_PROMO_COMPOSITION,
      duration_frames: 4000
    });
    assert.equal(tooLong.feasible, false);
    assert.equal(tooLong.reasonCode, 'DURATION_EXCEEDS_BOUNDS');
  });

  await t.test('4. canAdapt: strictly rejects unpinned fonts without valid SHA-256', () => {
    const unpinnedFontComp = {
      ...SAMPLE_PROMO_COMPOSITION,
      fonts: [
        {
          id: 'unpinned-font',
          asset_id: 'font-untrusted',
          sha256: 'invalid-sha-token',
          family: 'BadFont',
          weight: 400,
          style: 'normal'
        }
      ]
    };

    const check = adapter.canAdapt(unpinnedFontComp);
    assert.equal(check.feasible, false);
    assert.equal(check.reasonCode, 'UNPINNED_FONT');
  });

  await t.test('5. adapt: successfully converts CompositionSpec to VideoFlow declarative format', () => {
    const result = adapter.adapt(SAMPLE_PROMO_COMPOSITION);
    assert.equal(result.success, true);
    assert.equal(result.convertedScenesCount, 2);
    assert.equal(result.convertedLayersCount, 3);
    assert.equal(result.convertedAudioTracksCount, 1);
    assert.equal(result.convertedSubtitlesCount, 2);
    assert.equal(typeof result.deterministicChecksumSha256, 'string');
    assert.equal(result.deterministicChecksumSha256.length, 64);

    const comp = result.composition;
    assert.equal(comp.version, '1.0.0');
    assert.equal(comp.width, 720);
    assert.equal(comp.height, 1280);
    assert.equal(comp.durationFrames, 450);
    assert.equal(comp.tracks.length, 3); // visual, overlay, audio

    // Check visual track
    const visualTrack = comp.tracks.find((t) => t.id === 'vf-track-visual-primary');
    assert.ok(visualTrack);
    assert.equal(visualTrack.clips.length, 3);

    // Check transition
    assert.equal(comp.transitions.length, 1);
    assert.equal(comp.transitions[0].type, 'cut');
    assert.equal(comp.transitions[0].fromSceneId, 'scene-promo-intro');
    assert.equal(comp.transitions[0].toSceneId, 'scene-promo-cta');
  });

  await t.test('6. adapt: throws clear descriptive error when adapting an unfeasible composition', () => {
    assert.throws(
      () =>
        adapter.adapt({
          ...SAMPLE_PROMO_COMPOSITION,
          duration_frames: -10
        }),
      /VideoFlowAdapter cannot adapt composition due to unsupported features/
    );
  });

  await t.test('7. evaluateFrame: computes deterministic active layers and animation values', () => {
    const result = adapter.adapt(SAMPLE_PROMO_COMPOSITION);
    const vfComp = result.composition;

    // Frame 0: title layer opacity should be 0.0 (from keyframe 0: 0.0), translateY should be 30
    const frame0 = adapter.evaluateFrame(vfComp, 0);
    assert.equal(frame0.frameIndex, 0);
    assert.equal(frame0.timestampSeconds, 0);
    assert.equal(frame0.activeLayers.length, 1); // shape badge starts at frame 15
    const titleClipF0 = frame0.activeLayers.find((l) => l.layerId === 'layer-title-text');
    assert.ok(titleClipF0);
    assert.equal(titleClipF0.opacity, 0.0);
    assert.equal(titleClipF0.y, 230); // 200 + translateY 30

    // Frame 15: opacity reached 1.0, shape badge is now active, plus subtitle cue-01
    const frame15 = adapter.evaluateFrame(vfComp, 15);
    assert.equal(frame15.activeLayers.length, 3);
    const titleClipF15 = frame15.activeLayers.find((l) => l.layerId === 'layer-title-text');
    assert.ok(titleClipF15);
    assert.equal(titleClipF15.opacity, 1.0);

    // Frame 300 (Scene 2): CTA text active, intro scene finished
    const frame300 = adapter.evaluateFrame(vfComp, 300);
    assert.equal(frame300.activeLayers.length, 1);
    assert.equal(frame300.activeLayers[0].layerId, 'layer-cta-text');
  });

  await t.test('8. verifyRandomSeek: validates 100% binary parity between sequential and random seek', () => {
    const result = adapter.adapt(SAMPLE_PROMO_COMPOSITION);
    const testFrames = [0, 5, 15, 30, 60, 120, 224, 225, 250, 300, 400, 449];

    const seekTest = adapter.verifyRandomSeek(result.composition, testFrames);
    assert.equal(seekTest.passed, true);
    assert.equal(seekTest.mismatches.length, 0);
  });
});
