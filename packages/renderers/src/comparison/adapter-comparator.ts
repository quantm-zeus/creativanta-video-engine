/**
 * Adapter Comparator: Executes both Chromium Baseline and HyperFrames Spike
 * on the exact same manifest and evaluates parity, lifecycle, and blocker status.
 * Canonical specification: docs/ADR/0001-engine-selection.md, docs/IMPLEMENTATION_PLAN.md (P2-01)
 */

import { CanonicalCompilerManifest } from '@creativanta/contracts';
import { ChromiumBaselineRenderer } from '../chromium/chromium-adapter.js';
import { HyperFramesAdapterSpike } from '../hyperframes/hyperframes-adapter.js';
import { AdapterComparisonResult, RendererPrepareOptions } from '../types.js';

export async function compareAdaptersOnManifest(
  manifest: CanonicalCompilerManifest,
  sampleFrames: number[] = [0, Math.floor(manifest.duration_frames / 2), manifest.duration_frames - 1],
  options: RendererPrepareOptions = {}
): Promise<AdapterComparisonResult> {
  const chromiumRenderer = new ChromiumBaselineRenderer();
  const hyperframesRenderer = new HyperFramesAdapterSpike();

  // 1. Prepare both adapters on the same manifest
  const chromiumSession = await chromiumRenderer.prepare(manifest, options);
  const hyperframesSession = await hyperframesRenderer.prepare(manifest, options);

  const chromiumChecksums: Record<number, string> = {};
  const hyperframesChecksums: Record<number, string> = {};
  const matchingFrames: number[] = [];

  try {
    // 2. Perform seeks on the same sample frames
    for (const frameIdx of sampleFrames) {
      if (frameIdx < 0 || frameIdx >= manifest.duration_frames) continue;

      const chromRes = await chromiumSession.seek(frameIdx);
      const hfRes = await hyperframesSession.seek(frameIdx);

      chromiumChecksums[frameIdx] = chromRes.checksumSha256;
      hyperframesChecksums[frameIdx] = hfRes.checksumSha256;

      // Parity check: scene id, scene revision, active layers, and rendered dimensions
      const scenesMatch =
        chromRes.sceneId === hfRes.sceneId &&
        chromRes.sceneRevision === hfRes.sceneRevision &&
        chromRes.sceneAlpha === hfRes.sceneAlpha;

      const layersMatch =
        chromRes.activeLayerCount === hfRes.activeLayerCount &&
        chromRes.renderedWidth === hfRes.renderedWidth &&
        chromRes.renderedHeight === hfRes.renderedHeight;

      if (scenesMatch && layersMatch && chromRes.checksumSha256 === hfRes.checksumSha256) {
        matchingFrames.push(frameIdx);
      }
    }

    // 3. Test random seek invariance on both
    const chromSeekTest = await chromiumSession.verifyRandomSeek(sampleFrames);
    const hfSeekTest = await hyperframesSession.verifyRandomSeek(sampleFrames);

    // 4. Audit HyperFrames blockers
    const blockerReport = HyperFramesAdapterSpike.auditBlockers();

    const parityPercentage =
      sampleFrames.length > 0
        ? Math.round((matchingFrames.length / sampleFrames.length) * 100)
        : 100;

    return {
      manifestId: manifest.composition_id,
      durationFrames: manifest.duration_frames,
      chromiumBaseline: {
        name: chromiumRenderer.name,
        status: chromiumSession.getStatus(),
        framesRendered: sampleFrames.length,
        sampleChecksums: chromiumChecksums,
        randomSeekPassed: chromSeekTest.passed,
        audioCfrSupported: true,
        zeroEgressCompliant: true,
        commercialLicenseRisk: false,
      },
      hyperframesSpike: {
        name: hyperframesRenderer.name,
        status: hyperframesSession.getStatus(),
        framesRendered: sampleFrames.length,
        sampleChecksums: hyperframesChecksums,
        randomSeekPassed: hfSeekTest.passed,
        audioCfrSupported: false, // Drifts during offline frame stepping
        zeroEgressCompliant: false, // Cloud telemetry & install scripts
        commercialLicenseRisk: true, // Vendored GSAP commercial license
        blockerReport,
      },
      stateParityFrames: matchingFrames,
      parityPercentage,
      recommendation: 'chromium-frame-v1',
    };
  } finally {
    // 5. Dispose both sessions
    await chromiumSession.dispose();
    await hyperframesSession.dispose();
  }
}
