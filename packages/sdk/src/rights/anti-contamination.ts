/**
 * Anti-Contamination Rules & Source Scanners for Creativanta Video Engine.
 * Cross-verified against evidence/P0-03/rights-manifest.json.
 * Blocks unreviewed third-party, proprietary, or remote-egress asset references.
 */

import { AntiContaminationRule } from './types.js';

export const ANTI_CONTAMINATION_RULES: AntiContaminationRule[] = [
  {
    sourceName: 'HyperFrames Upstream / HeyGen Proprietary Assets',
    pattern: /(?:heygen|hyperframes-marketing|upstream-heygen|heygen\.com|hyperframes\.dev\/demo)/i,
    reason: 'Proprietary marketing media, billing telemetry, or unpinned cloud generator assets from upstream HeyGen/HyperFrames.',
  },
  {
    sourceName: 'Remotion Unreviewed Stock Demos',
    pattern: /(?:remotion\.dev\/example|remotion-sample-assets|remotion-assets\.s3)/i,
    reason: 'Remotion sample stock assets with ambiguous or non-commercial license terms.',
  },
  {
    sourceName: 'VideoFlow / WebAV Unreviewed Upstream Clips',
    pattern: /(?:big_buck_bunny|tears_of_steel|webav-demo|videoflow-sample)/i,
    reason: 'Unlocalized upstream VideoFlow/WebAV demo clips lacking Vietnamese typography, 9:16 vertical formatting, and calibrated 48kHz audio mixes.',
  },
  {
    sourceName: 'Remote Google Fonts / External CDN Links',
    pattern: /(?:fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)/i,
    reason: 'Remote CDN URLs violate Zero-Egress policy and compromise render determinism. Pinned offline WOFF2 fonts required.',
  },
  {
    sourceName: 'Implicit Video Audio Extraction',
    pattern: /(?:video-demux-audio|extract-audio-from-mp4)/i,
    reason: 'Extracting audio implicitly from video containers risks non-deterministic sync and uncalibrated loudness. Explicit 48kHz WAV audio tracks required.',
  },
];

/**
 * Checks a URL, origin, or filename against anti-contamination rules.
 */
export function checkAntiContamination(sourceOrUrl: string): {
  compliant: boolean;
  violation?: { sourceName: string; reason: string };
} {
  if (!sourceOrUrl) return { compliant: true };

  for (const rule of ANTI_CONTAMINATION_RULES) {
    if (rule.pattern.test(sourceOrUrl)) {
      return {
        compliant: false,
        violation: {
          sourceName: rule.sourceName,
          reason: rule.reason,
        },
      };
    }
  }

  return { compliant: true };
}
