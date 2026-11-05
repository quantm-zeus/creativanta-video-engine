import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BROWSER_SPECIALIZED_ACCEPTANCE_MATRIX,
  getAcceptanceMatrix,
  getAcceptanceMatrixEntry,
  queryAcceptanceMatrix,
  evaluateCompositionAcceptance,
  validateNoFakeSupport,
  NoFakeSupportError,
} from '../dist/index.js';

describe('P8-04: Browser & Specialized Engine Acceptance Matrix', () => {
  it('1.1 Matrix Completeness: verifies all 9 categories and expected entry counts', () => {
    const matrix = getAcceptanceMatrix();
    assert.ok(Array.isArray(matrix));
    assert.ok(matrix.length >= 25, `Expected at least 25 matrix entries, got ${matrix.length}`);

    const categories = new Set(matrix.map((e) => e.category));
    assert.ok(categories.has('browser_platform'));
    assert.ok(categories.has('specialized_engine'));
    assert.ok(categories.has('video_codec'));
    assert.ok(categories.has('audio_codec'));
    assert.ok(categories.has('container_format'));
    assert.ok(categories.has('scene_layer'));
    assert.ok(categories.has('scene_transition'));
    assert.ok(categories.has('memory_and_resource'));
    assert.ok(categories.has('third_party_package'));
  });

  it('1.2 Verdict Distribution: validates the 4 normative acceptance verdicts', () => {
    const matrix = getAcceptanceMatrix();
    const verdicts = new Set(matrix.map((e) => e.verdict));

    assert.ok(verdicts.has('ACCEPTED_BASELINE_SUPPORT'));
    assert.ok(verdicts.has('ACCEPTED_WITH_FALLBACK'));
    assert.ok(verdicts.has('REFUSED_UNSUPPORTED'));
    assert.ok(verdicts.has('CONCLUDED_NO_ADOPTION'));

    // Check queryAcceptanceMatrix filter helper
    const baseline = queryAcceptanceMatrix({ verdict: 'ACCEPTED_BASELINE_SUPPORT' });
    const fallback = queryAcceptanceMatrix({ verdict: 'ACCEPTED_WITH_FALLBACK' });
    const refused = queryAcceptanceMatrix({ verdict: 'REFUSED_UNSUPPORTED' });
    const noAdoption = queryAcceptanceMatrix({ verdict: 'CONCLUDED_NO_ADOPTION' });

    assert.ok(baseline.length > 5, 'Must have baseline supported entries');
    assert.ok(fallback.length > 3, 'Must have fallback entries (Firefox, Mobile 1080p, Video layer)');
    assert.ok(refused.length > 3, 'Must have refused entries (silent audio drop, raw URL, unpinned font)');
    assert.ok(noAdoption.length > 3, 'Must have empirical no-adoption entries (PixiJS, WASM x264, etc.)');
  });

  it('1.3 Specialized Engines: verifies VideoFlow baseline vs PixiJS/Revideo/Motion Canvas no-adoption', () => {
    // 1. VideoFlow: Accepted as initial optional adapter
    const videoflow = getAcceptanceMatrixEntry('eng-videoflow');
    assert.ok(videoflow);
    assert.equal(videoflow.verdict, 'ACCEPTED_BASELINE_SUPPORT');
    assert.equal(videoflow.defaultAction, 'export_locally');
    assert.ok(videoflow.evidenceReference.includes('ADR-0003'));
    assert.ok(videoflow.benchmarks?.rtf !== undefined && videoflow.benchmarks.rtf < 1.5);
    assert.ok(videoflow.benchmarks?.peakRssMib !== undefined && videoflow.benchmarks.peakRssMib < 150);

    // 2. PixiJS: Concluded NO-ADOPTION with empirical evidence
    const pixijs = getAcceptanceMatrixEntry('eng-pixijs');
    assert.ok(pixijs);
    assert.equal(pixijs.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.equal(pixijs.defaultAction, 'refuse');
    assert.equal(pixijs.refusalCode, 'NO_ADOPTION_CONCLUDED');
    assert.ok(pixijs.rationale.includes('Score 52.5/100'));
    assert.ok(pixijs.benchmarks?.rtf !== undefined && pixijs.benchmarks.rtf > 4.0);
    assert.ok(pixijs.benchmarks?.peakRssMib !== undefined && pixijs.benchmarks.peakRssMib > 500);

    // 3. Revideo: Concluded NO-ADOPTION in browser (requires MicroVM P7)
    const revideo = getAcceptanceMatrixEntry('eng-revideo');
    assert.ok(revideo);
    assert.equal(revideo.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.ok(revideo.rationale.includes('Score 70.5/100'));
    assert.ok(revideo.rationale.includes('MicroVM'));

    // 4. Motion Canvas: Concluded NO-ADOPTION in browser (requires MicroVM P7)
    const motionCanvas = getAcceptanceMatrixEntry('eng-motion-canvas');
    assert.ok(motionCanvas);
    assert.equal(motionCanvas.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.ok(motionCanvas.rationale.includes('Score 62.0/100'));
  });

  it('1.4 Codec Legal Matrix: verifies WebCodecs H.264 baseline vs Software WASM x264 no-adoption', () => {
    const h264WebCodecs = getAcceptanceMatrixEntry('codec-h264-webcodecs');
    assert.ok(h264WebCodecs);
    assert.equal(h264WebCodecs.verdict, 'ACCEPTED_BASELINE_SUPPORT');
    assert.ok(h264WebCodecs.rationale.includes('Royalty-free'));

    const h264Wasm = getAcceptanceMatrixEntry('codec-h264-wasm');
    assert.ok(h264Wasm);
    assert.equal(h264Wasm.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.equal(h264Wasm.defaultAction, 'refuse');
    assert.ok(h264Wasm.rationale.includes('MPEG-LA'));
    assert.ok(h264Wasm.rationale.includes('GPL-2.0'));
  });

  it('1.5 Platform Memory Ceilings: verifies iOS Safari 720p vs 1080p fallback vs 4K no-adoption', () => {
    const ios720p = getAcceptanceMatrixEntry('plat-ios-safari-720p');
    assert.ok(ios720p);
    assert.equal(ios720p.verdict, 'ACCEPTED_BASELINE_SUPPORT');

    const ios1080p = getAcceptanceMatrixEntry('plat-ios-safari-1080p');
    assert.ok(ios1080p);
    assert.equal(ios1080p.verdict, 'ACCEPTED_WITH_FALLBACK');
    assert.equal(ios1080p.refusalCode, 'EXCEEDS_MEMORY_BUDGET');

    const ios4k = getAcceptanceMatrixEntry('plat-ios-safari-4k-local');
    assert.ok(ios4k);
    assert.equal(ios4k.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.equal(ios4k.defaultAction, 'refuse');
    assert.ok(ios4k.rationale.includes('Jetsam'));
  });

  it('1.6 No Fake Support: validates prohibition of unvalidated claims for rejected candidates', () => {
    // Valid candidate VideoFlow passes without error
    assert.doesNotThrow(() => validateNoFakeSupport('videoflow'));

    // Attempting to claim support for PixiJS throws NoFakeSupportError
    assert.throws(
      () => validateNoFakeSupport('pixijs'),
      (err) => {
        assert.ok(err instanceof NoFakeSupportError);
        assert.equal(err.code, 'NO_FAKE_SUPPORT_VIOLATION');
        assert.ok(err.candidate.includes('PixiJS'));
        assert.ok(err.evidenceReference.includes('ADR-0003'));
        assert.ok(err.rationale.includes('52.5/100'));
        return true;
      },
    );

    // Attempting to claim support for software WASM x264 throws NoFakeSupportError
    assert.throws(
      () => validateNoFakeSupport('x264-wasm'),
      (err) => {
        assert.ok(err instanceof NoFakeSupportError);
        assert.ok(err.candidate.includes('H.264 via Software WASM'));
        assert.ok(err.rationale.includes('MPEG-LA'));
        return true;
      },
    );

    // Attempting to claim support for WebAV Pro throws NoFakeSupportError
    assert.throws(
      () => validateNoFakeSupport('webav-pro'),
      (err) => {
        assert.ok(err instanceof NoFakeSupportError);
        assert.ok(err.candidate.includes('WebAV Pro'));
        return true;
      },
    );
  });

  it('1.7 evaluateCompositionAcceptance: correctly evaluates conforming vs non-conforming compositions', () => {
    const validSpec = {
      canvas: { width: 1280, height: 720, background: '#000000' },
      fps: { num: 30, den: 1 },
      duration_frames: 150,
      scenes: [
        {
          id: 'scene_01',
          duration_frames: 150,
          layers: [{ id: 'title', type: 'text' }],
        },
      ],
      audio_tracks: [{ id: 'bg_music' }],
    };

    // Chrome Desktop: baseline support
    const chromeReport = evaluateCompositionAcceptance(validSpec, 'chrome-desktop');
    assert.equal(chromeReport.eligibleForLocalExport, true);
    assert.equal(chromeReport.requiresServerFallback, false);
    assert.equal(chromeReport.strictlyRefused, false);
    assert.equal(chromeReport.verdict, 'ACCEPTED_BASELINE_SUPPORT');
    assert.equal(chromeReport.noSilentDegradationGuaranteed, true);

    // Firefox Desktop: lacks video encoder -> requires fallback
    const firefoxReport = evaluateCompositionAcceptance(validSpec, 'firefox-desktop');
    assert.equal(firefoxReport.eligibleForLocalExport, false);
    assert.equal(firefoxReport.requiresServerFallback, true);
    assert.equal(firefoxReport.verdict, 'ACCEPTED_WITH_FALLBACK');
    assert.equal(firefoxReport.reasonCode, 'MISSING_VIDEO_ENCODER');

    // Composition containing rejected PixiJS engine -> strictly refused
    const pixiSpec = {
      ...validSpec,
      scenes: [
        {
          id: 'scene_pixi',
          engine: 'pixijs',
          duration_frames: 150,
        },
      ],
    };
    const pixiReport = evaluateCompositionAcceptance(pixiSpec, 'chrome-desktop');
    assert.equal(pixiReport.eligibleForLocalExport, false);
    assert.equal(pixiReport.strictlyRefused, true);
    assert.equal(pixiReport.verdict, 'CONCLUDED_NO_ADOPTION');
    assert.ok(pixiReport.noAdoptionViolations.length > 0);
  });
});
