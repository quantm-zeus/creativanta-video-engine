import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_CAPABILITY_PROFILES,
  evaluateExportFeasibility,
  REVIEWED_BROWSER_PACKAGES,
  CODEC_LEGAL_EVALUATION,
  DEFAULT_P8_01_GATE,
  assertBrowserExportGateApproved,
  BrowserExportGatePendingError,
} from '../dist/index.js';

describe('P8-01: Browser Export Capability Matrix & Codec Parity', () => {
  it('1.1 Verifies desktop browser capability profiles and codec support', () => {
    const chrome = BROWSER_CAPABILITY_PROFILES['chrome-desktop'];
    assert.equal(chrome.engine, 'blink');
    assert.equal(chrome.hasWebCodecs, true);
    assert.equal(chrome.hasVideoEncoder, true);
    assert.equal(chrome.hasAudioEncoder, true);
    assert.equal(chrome.hasOffscreenCanvas, true);
    assert.equal(chrome.hasDedicatedWorker, true);
    assert.equal(chrome.hasOpfs, true);
    assert.ok(chrome.supportedVideoCodecs.includes('avc1.42E01E'));
    assert.ok(chrome.supportedVideoCodecs.includes('vp09.00.10.08'));
    assert.ok(chrome.supportedVideoCodecs.includes('av01.0.04M.08'));
    assert.ok(chrome.supportedAudioCodecs.includes('mp4a.40.2'));
    assert.ok(chrome.supportedAudioCodecs.includes('opus'));
    assert.ok(chrome.supportedContainers.includes('mp4'));
    assert.ok(chrome.supportedContainers.includes('webm'));

    const safari = BROWSER_CAPABILITY_PROFILES['safari-desktop'];
    assert.equal(safari.engine, 'webkit');
    assert.equal(safari.hasWebCodecs, true);
    assert.equal(safari.hasVideoEncoder, true);
    assert.ok(safari.supportedVideoCodecs.includes('avc1.42E01E'));
    assert.ok(safari.supportedVideoCodecs.includes('hvc1.1.6.L93.B0'));
    // Safari does not support VP9 or AV1 VideoEncoder
    assert.equal(safari.supportedVideoCodecs.includes('vp09.00.10.08'), false);
    assert.equal(safari.supportedVideoCodecs.includes('av01.0.04M.08'), false);

    const firefox = BROWSER_CAPABILITY_PROFILES['firefox-desktop'];
    assert.equal(firefox.engine, 'gecko');
    assert.equal(firefox.hasVideoEncoder, false);
    assert.equal(firefox.hasAudioEncoder, false);
    assert.equal(firefox.supportedVideoCodecs.length, 0);
  });

  it('1.2 Verifies mobile browser memory limits and jetsam protection', () => {
    const ios = BROWSER_CAPABILITY_PROFILES['ios-safari'];
    assert.equal(ios.family, 'mobile');
    assert.equal(ios.memoryBudgetMib, 1024);
    assert.deepEqual(ios.maxDimensions, { width: 1280, height: 1280 });
    assert.equal(ios.thermalThrottlingRisk, 'high');
    assert.ok(ios.supportedVideoCodecs.includes('avc1.42E01E'));
    assert.equal(ios.supportedVideoCodecs.includes('vp09.00.10.08'), false);

    const android = BROWSER_CAPABILITY_PROFILES['android-chrome'];
    assert.equal(android.family, 'mobile');
    assert.equal(android.memoryBudgetMib, 2048);
    assert.ok(android.supportedVideoCodecs.includes('avc1.42E01E'));
    assert.ok(android.supportedVideoCodecs.includes('vp09.00.10.08'));
  });

  it('1.3 Evaluates feasibility: Chrome Desktop renders standard 720p promo locally', () => {
    const spec = {
      canvas: { width: 720, height: 1280, background: '#000000' },
      fps: { num: 30, den: 1 },
      duration_frames: 450,
      scenes: [
        { id: 'scene_01', engine: 'canvas-v1', duration_frames: 150 },
        { id: 'scene_02', engine: 'html-v1', duration_frames: 150 },
        { id: 'scene_03', engine: 'canvas-v1', duration_frames: 150 },
      ],
      audio_tracks: [{ id: 'audio_bg', asset_id: 'ast_music' }],
    };

    const result = evaluateExportFeasibility('chrome-desktop', spec, 'mp4-720p-v1');
    assert.equal(result.feasible, true);
    assert.equal(result.recommendedAction, 'export_locally');
    assert.equal(result.fallbackJob, undefined);
  });

  it('1.4 Evaluates feasibility: Firefox Desktop falls back to server render job', () => {
    const spec = {
      canvas: { width: 720, height: 1280 },
      fps: { num: 30, den: 1 },
      duration_frames: 450,
      scenes: [{ id: 'scene_01', engine: 'html-v1', duration_frames: 450 }],
    };

    const result = evaluateExportFeasibility('firefox-desktop', spec, 'mp4-720p-v1');
    assert.equal(result.feasible, false);
    assert.equal(result.recommendedAction, 'fallback_to_server_job');
    assert.equal(result.reasonCode, 'MISSING_VIDEO_ENCODER');
    assert.ok(result.fallbackJob);
    assert.equal(result.fallbackJob.mode, 'render');
    assert.equal(result.fallbackJob.profile, 'mp4-720p-v1');
  });

  it('1.5 Evaluates feasibility: iOS Safari accepts 720p but rejects 1080p and 4K to prevent jetsam crash', () => {
    const spec720p = {
      canvas: { width: 720, height: 1280 },
      fps: { num: 30, den: 1 },
      duration_frames: 450,
      scenes: [{ id: 'scene_01', engine: 'html-v1', duration_frames: 450 }],
    };

    const result720p = evaluateExportFeasibility('ios-safari', spec720p, 'mp4-720p-v1');
    assert.equal(result720p.feasible, true);
    assert.equal(result720p.recommendedAction, 'export_locally');

    const spec1080p = {
      canvas: { width: 1080, height: 1920 },
      fps: { num: 30, den: 1 },
      duration_frames: 450,
      scenes: [{ id: 'scene_01', engine: 'html-v1', duration_frames: 450 }],
    };

    const result1080p = evaluateExportFeasibility('ios-safari', spec1080p, 'mp4-1080p-v1');
    assert.equal(result1080p.feasible, false);
    assert.equal(result1080p.recommendedAction, 'fallback_to_server_job');
    assert.equal(result1080p.reasonCode, 'DIMENSIONS_EXCEED_PLATFORM_CAP');
    assert.ok(result1080p.fallbackJob);
    assert.equal(result1080p.fallbackJob.mode, 'render');
  });

  it('1.6 Evaluates feasibility: custom-html-v1 scenes always trigger server fallback', () => {
    const specCustom = {
      canvas: { width: 720, height: 1280 },
      fps: { num: 30, den: 1 },
      duration_frames: 450,
      scenes: [
        {
          id: 'scene_custom',
          engine: 'custom-html-v1',
          bundle: { id: 'bnd_custom' },
          duration_frames: 450,
        },
      ],
    };

    const result = evaluateExportFeasibility('chrome-desktop', specCustom, 'mp4-720p-v1');
    assert.equal(result.feasible, false);
    assert.equal(result.recommendedAction, 'fallback_to_server_job');
    assert.equal(result.reasonCode, 'CUSTOM_CODE_ENGINE_UNSUPPORTED');
    assert.ok(result.fallbackJob);
  });
});

describe('P8-01: Legal Review, Upstream Artifacts & Non-Shipping Review Gate', () => {
  it('2.1 Verifies all 8 candidate package review entries and integrity hashes', () => {
    assert.equal(REVIEWED_BROWSER_PACKAGES.length, 8);

    const names = REVIEWED_BROWSER_PACKAGES.map((p) => p.name);
    assert.ok(names.includes('mediabunny'));
    assert.ok(names.includes('@webav/av-cliper'));
    assert.ok(names.includes('@webav/av-canvas'));
    assert.ok(names.includes('@webav/av-recorder'));
    assert.ok(names.includes('@webav/internal-utils'));
    assert.ok(names.includes('@webav/mp4box.js'));
    assert.ok(names.includes('opfs-tools'));
    assert.ok(names.includes('wave-resampler'));

    for (const pkg of REVIEWED_BROWSER_PACKAGES) {
      assert.ok(pkg.integritySha512.startsWith('sha512-'), `${pkg.name} integrity format`);
      assert.ok(pkg.shasum.length === 40, `${pkg.name} shasum length`);
      assert.equal(pkg.hasLifecycleScripts, false, `${pkg.name} must have zero lifecycle scripts`);
    }

    const mediabunny = REVIEWED_BROWSER_PACKAGES.find((p) => p.name === 'mediabunny');
    assert.ok(mediabunny);
    assert.equal(mediabunny.version, '1.65.2');
    assert.equal(mediabunny.licenseSpdx, 'MPL-2.0');
    assert.equal(mediabunny.noticeRequired, true);
    assert.equal(mediabunny.sourceOfferRequired, true);

    const cliper = REVIEWED_BROWSER_PACKAGES.find((p) => p.name === '@webav/av-cliper');
    assert.ok(cliper);
    assert.equal(cliper.version, '1.2.8');
    assert.equal(cliper.licenseSpdx, 'MIT');
    assert.equal(cliper.noticeRequired, true);
  });

  it('2.2 Enforces "No code shipping trước review" gate (EXT-P8-01)', () => {
    // Calling with default gate (pending_external_review) MUST throw BrowserExportGatePendingError
    assert.throws(
      () => assertBrowserExportGateApproved(DEFAULT_P8_01_GATE),
      (err) => {
        assert.ok(err instanceof BrowserExportGatePendingError);
        assert.equal(err.code, 'SHIPPING_GATE_PENDING_REVIEW');
        assert.ok(err.message.includes('No code shipping trước review'));
        return true;
      },
    );

    // Calling with blocked status also throws
    assert.throws(
      () =>
        assertBrowserExportGateApproved({
          gateId: 'EXT-P8-01',
          status: 'blocked',
          notes: 'Blocked by legal team',
        }),
      (err) => err instanceof BrowserExportGatePendingError,
    );

    // Calling with approved_by_reviewer succeeds without error
    assert.doesNotThrow(() =>
      assertBrowserExportGateApproved({
        gateId: 'EXT-P8-01',
        status: 'approved_by_reviewer',
        reviewer: 'security-and-legal-officer',
        signoffCommit: 'e9046ba',
        notes: 'Approved for P8-02 spike implementation',
      }),
    );
  });

  it('2.3 Verifies H.264, AAC, and open codec legal evaluation policies', () => {
    assert.equal(
      CODEC_LEGAL_EVALUATION.h264_avc.browserNativeWebCodecs.status,
      'ALLOWED_NO_ROYALTY_FOR_WEBAPP',
    );
    assert.equal(
      CODEC_LEGAL_EVALUATION.h264_avc.clientSoftwareWasm.status,
      'STRICTLY_BLOCKED',
    );
    assert.equal(
      CODEC_LEGAL_EVALUATION.aac_audio.browserNativeWebCodecs.status,
      'ALLOWED_NO_ROYALTY_FOR_WEBAPP',
    );
    assert.equal(
      CODEC_LEGAL_EVALUATION.vp9_av1_opus.status,
      'ALLOWED_ROYALTY_FREE',
    );
  });
});
