import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  exportBrowserVideo,
  assertNoSilentDegradation,
  refuseUnsupportedFeature,
  UnsupportedFeatureRefusalError,
  SilentDegradationPreventedError,
  MockServerJobDispatcher,
  DEFAULT_P8_01_GATE,
} from '../dist/index.js';

describe('P8-04: Strict Refusal & Anti-Silent Degradation Policy', () => {
  const approvedGate = {
    ...DEFAULT_P8_01_GATE,
    status: 'approved_by_reviewer',
    reviewer: 'independent-verifier@creativanta.test',
  };

  const conformingSpec = {
    canvas: { width: 1280, height: 720, background: '#101828' },
    fps: { num: 30, den: 1 },
    duration_frames: 60,
    scenes: [
      {
        id: 'scene_promo',
        duration_frames: 60,
        layers: [
          {
            id: 'headline',
            type: 'text',
            content: { text: 'Khuyến mãi đặc biệt' },
          },
          {
            id: 'badge',
            type: 'shape',
            content: { shape: 'rect' },
          },
        ],
      },
    ],
  };

  it('2.1 assertNoSilentDegradation: prevents silent audio omission when AudioEncoder is absent', () => {
    const specWithAudio = {
      ...conformingSpec,
      audio_tracks: [{ id: 'voice_narration' }],
    };

    // On Firefox (hasAudioEncoder = false): must prevent silent audio drop
    assert.throws(
      () => assertNoSilentDegradation(specWithAudio, 'firefox-desktop'),
      (err) => {
        assert.ok(err instanceof SilentDegradationPreventedError);
        assert.equal(err.code, 'SILENT_DEGRADATION_PREVENTED');
        assert.ok(err.violation.includes('Silently dropping audio is prohibited'));
        return true;
      },
    );

    // On Chrome (hasAudioEncoder = true): passes without error
    assert.doesNotThrow(() => assertNoSilentDegradation(specWithAudio, 'chrome-desktop'));
  });

  it('2.2 assertNoSilentDegradation: prevents silent layer omission for unsupported layers', () => {
    const specWithUnsupportedLayer = {
      ...conformingSpec,
      scenes: [
        {
          id: 'scene_bad_layer',
          duration_frames: 60,
          layers: [
            { id: 'l1', type: 'text' },
            { id: 'l2', type: 'unsupported_3d_mesh' }, // unsupported
          ],
        },
      ],
    };

    assert.throws(
      () => assertNoSilentDegradation(specWithUnsupportedLayer, 'chrome-desktop'),
      (err) => {
        assert.ok(err instanceof SilentDegradationPreventedError);
        assert.ok(err.violation.includes('unsupported_3d_mesh'));
        assert.ok(err.violation.includes('Silently omitting this layer during export is prohibited'));
        return true;
      },
    );
  });

  it('2.3 assertNoSilentDegradation: prevents silent custom code bundle omission', () => {
    const specWithCustomBundle = {
      ...conformingSpec,
      scenes: [
        {
          id: 'scene_custom',
          engine: 'custom-html-v1',
          duration_frames: 60,
        },
      ],
    };

    assert.throws(
      () => assertNoSilentDegradation(specWithCustomBundle, 'chrome-desktop'),
      (err) => {
        assert.ok(err instanceof SilentDegradationPreventedError);
        assert.ok(err.violation.includes('custom-html-v1'));
        assert.ok(err.violation.includes('Silently stripping custom code'));
        return true;
      },
    );
  });

  it('2.4 exportBrowserVideo (strict_local_only): strictly refuses unsupported platform instead of degrading', async () => {
    // Calling export on Firefox in strict_local_only mode throws UnsupportedFeatureRefusalError
    await assert.rejects(
      async () => {
        await exportBrowserVideo(conformingSpec, {
          platform: 'firefox-desktop',
          gateConfig: approvedGate,
          exportMode: 'strict_local_only',
        });
      },
      (err) => {
        assert.ok(err instanceof UnsupportedFeatureRefusalError);
        assert.equal(err.code, 'UNSUPPORTED_FEATURE_REFUSED');
        assert.equal(err.reasonCode, 'MISSING_VIDEO_ENCODER');
        assert.ok(err.message.includes('strictly refuses unsupported features instead of silently degrading'));
        return true;
      },
    );
  });

  it('2.5 exportBrowserVideo (strict_local_only): strictly refuses unsupported scene features', async () => {
    const customSpec = {
      ...conformingSpec,
      scenes: [
        {
          id: 'scene_custom',
          engine: 'custom-html-v1',
          duration_frames: 60,
        },
      ],
    };

    await assert.rejects(
      async () => {
        await exportBrowserVideo(customSpec, {
          platform: 'chrome-desktop',
          gateConfig: approvedGate,
          exportMode: 'strict_local_only',
        });
      },
      (err) => {
        assert.ok(err instanceof UnsupportedFeatureRefusalError);
        assert.equal(err.code, 'UNSUPPORTED_FEATURE_REFUSED');
        assert.equal(err.reasonCode, 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
        return true;
      },
    );
  });

  it('2.6 exportBrowserVideo (strict_local_only): successfully renders fully conforming scene subset', async () => {
    const result = await exportBrowserVideo(conformingSpec, {
      platform: 'chrome-desktop',
      gateConfig: approvedGate,
      exportMode: 'strict_local_only',
    });

    assert.equal(result.action, 'export_locally');
    assert.equal(result.width, 1280);
    assert.equal(result.height, 720);
    assert.equal(result.durationFrames, 60);
    assert.ok(result.buffer.byteLength > 0);
    assert.ok(result.memoryMetrics.peakFramesCount <= 4);
  });

  it('2.7 refuseUnsupportedFeature: helper function throws explicit refusal error with evidence metadata', () => {
    assert.throws(
      () =>
        refuseUnsupportedFeature(
          'unsupported_canvas_filter_blur',
          'UNSUPPORTED_BROWSER_PLATFORM',
          ['Filter blur is not supported in 2D browser export spike'],
        ),
      (err) => {
        assert.ok(err instanceof UnsupportedFeatureRefusalError);
        assert.equal(err.feature, 'unsupported_canvas_filter_blur');
        assert.equal(err.reasonCode, 'UNSUPPORTED_BROWSER_PLATFORM');
        assert.ok(err.evidenceReference.includes('P8-04'));
        return true;
      },
    );
  });
});
