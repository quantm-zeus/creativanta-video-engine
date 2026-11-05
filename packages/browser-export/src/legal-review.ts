import type {
  PackageReviewEntry,
  BrowserExportGateConfig,
} from './types.js';

/**
 * P8-01 Exact Package & Artifact Review Catalog.
 * Contains verified cryptographic integrity hashes, licenses, distribution obligations,
 * and security verdicts for client-side browser export candidate packages.
 */
export const REVIEWED_BROWSER_PACKAGES: readonly PackageReviewEntry[] = [
  {
    name: 'mediabunny',
    version: '1.65.2',
    gitHead: '173f6b70765fa3a6ffc1c82737514416fa559ef5',
    integritySha512:
      'sha512-goZpibvo/5hkc/56WVNm93Ini+o7K4y8aXA20c/BN1B+m3L5aHQa8MTvO+S1APg/YI8kMILtrX6QCqUtxLW7bA==',
    shasum: 'ef1db034a70f11702dba2fbe65e8342d268dfd38',
    tarballUrl: 'https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.2.tgz',
    licenseSpdx: 'MPL-2.0',
    distributionObligations:
      'MPL-2.0 Section 3.2 & 3.3. When distributing executable/minified JavaScript in a browser application, recipients must be informed how to access the Source Code of Mediabunny (e.g. public repository link https://github.com/Vanilagy/mediabunny), and original copyright notices must be preserved. Modifications to Mediabunny files must remain MPL-2.0, but bundling as an unmodified external dependency in a Larger Work does not infect proprietary application code.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: true,
    patentGrantClause:
      'MPL-2.0 Section 5 provides an express patent license from each Contributor for its Contributions covering patent claims inevitably infringed by the Covered Software.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy:
      'Conditionally allowed for P8-02 browser export spike as an unmodified external module dependency. Do NOT vendor or modify Mediabunny source files directly inside proprietary packages. Ensure legal notice and public source link are included in client bundle credits.',
    findings: [
      'Pure TypeScript implementation with zero runtime dependencies (only @types/dom-webcodecs and @types/dom-mediacapture-transform dev/type dependencies).',
      'No postinstall or lifecycle scripts (reproducible zero-network install).',
      'Provides pure demuxing, muxing, WebCodecs integration, and fragmented MP4 container writing directly in browser environments.',
      'Weak copyleft requires preserving file-level boundaries.',
    ],
  },
  {
    name: '@webav/av-cliper',
    version: '1.2.8',
    integritySha512:
      'sha512-lxCXgP5AJsl+6xRo1puU5lTv7rAsxX9StQVK8xYdbg02p9FswCt76iTPqNxmlJ0ZfV1g+lmyNufLXu/qBAnJnA==',
    shasum: 'd1ad2e65f8baa0f37dca91c070d582ff4f5d5daa',
    tarballUrl: 'https://registry.npmjs.org/@webav/av-cliper/-/av-cliper-1.2.8.tgz',
    licenseSpdx: 'MIT',
    distributionObligations:
      'MIT notice and copyright attribution must be preserved in client distribution. Root repository WebAV-Tech/WebAV declares MIT license, though sub-package package.json omits license field.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT; no express patent grant clause.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy:
      'Allowed for P8-02 browser export evaluation only with explicit MIT attribution. Ensure no closed-source WebAV Pro features are referenced. Upstream demo assets (Big Buck Bunny, Tears of Steel) strictly blocked.',
    findings: [
      'WebCodecs-based timeline synthesis combining video, audio, image, and canvas layers.',
      'Package.json published to npm registry omits explicit "license" field; root repo contains standard MIT license text (1059 bytes).',
      'Depends on @webav/mp4box.js@^0.5.7, opfs-tools@^0.7.2, wave-resampler@^1.0.0, and @webav/internal-utils@1.2.8.',
      'No lifecycle scripts or network postinstall hooks.',
      'Upstream maintains commercial/closed-source "WebAV Pro" extensions (timeline UI, pro transition effects) under separate non-free terms; only open-source core is audited.',
    ],
  },
  {
    name: '@webav/av-canvas',
    version: '1.2.8',
    integritySha512:
      'sha512-j7wvlmdQcwSeMDPiOjfnw2LR/+F/yqYScs9dzwh8SHQre6nnnxS/eOPBghhgVx/RlqFk6VR4UYtnXlhfgnhWtA==',
    shasum: '87a059ef51b6b61e331f06e183fdb1fccd0bf0a5',
    tarballUrl: 'https://registry.npmjs.org/@webav/av-canvas/-/av-canvas-1.2.8.tgz',
    licenseSpdx: 'MIT',
    distributionObligations: 'MIT notice and copyright attribution required in client bundle.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT; no express patent grant clause.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy: 'Allowed for DOM/Canvas frame synthesis in P8-02 spike under strict MIT notice preservation.',
    findings: [
      'Canvas and MediaStream compositor for combining text, image, and video layers.',
      'Package.json omits license field; covered by root repo MIT license.',
      'Zero lifecycle scripts.',
    ],
  },
  {
    name: '@webav/av-recorder',
    version: '1.2.8',
    integritySha512:
      'sha512-Ju7/BOTU7p/BPXh98oZHzBGF2B849lmEI1j0G76y4Aiv8S3MoX1l5FTIj0J2gFZudw0p0/NS41AGqsT4PhY6ng==',
    shasum: 'f55ac27806c370c1c2e6d03fd5701620a683192e',
    tarballUrl: 'https://registry.npmjs.org/@webav/av-recorder/-/av-recorder-1.2.8.tgz',
    licenseSpdx: 'MIT',
    distributionObligations: 'MIT notice required.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT; no express patent grant clause.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy: 'Alternative WebCodecs stream recorder candidate.',
    findings: [
      'Encodes MediaStream to MP4 via WebCodecs API and mp4box.js muxer.',
      'Package.json omits license field; covered by root repo MIT license.',
      'Zero lifecycle scripts.',
    ],
  },
  {
    name: '@webav/internal-utils',
    version: '1.2.8',
    integritySha512:
      'sha512-ZiEXl4U6PRqotkux0eTUdVn5zxbzXYm4Xfjt+HvH5bowwGSJVho/mmbPrdPf3ZRtfIu0aWCWa04LUDBQuY5ltA==',
    shasum: 'dd16608363eb1bedbbb6e592bfdd0bdcba26d353',
    tarballUrl: 'https://registry.npmjs.org/@webav/internal-utils/-/internal-utils-1.2.8.tgz',
    licenseSpdx: 'MIT',
    distributionObligations: 'Internal utility package; not for direct public API integration.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy: 'Transitive dependency of @webav/av-cliper. Do not import directly in application code.',
    findings: [
      'Marked as private internal utilities with volatile APIs.',
      'Package.json omits license field; covered by root repo MIT license.',
    ],
  },
  {
    name: '@webav/mp4box.js',
    version: '0.5.7',
    integritySha512:
      'sha512-KgScEtDpiLnWvj1Rj8Ri9fDWxTjfdNr7cmY/PT88EmttHh6cLxMAeyD/W8Vydes4z7qV/c5VDAaP4cTlaO0E9g==',
    shasum: 'fa100d724c3ddd4cd24fb1243f8a274823c49d38',
    tarballUrl: 'https://registry.npmjs.org/@webav/mp4box.js/-/mp4box.js-0.5.7.tgz',
    licenseSpdx: 'BSD-3-Clause',
    distributionObligations:
      'BSD-3-Clause notice, conditions, and disclaimer must be preserved in client distribution.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard BSD-3-Clause; no express patent grant clause.',
    verdict: 'CONDITIONALLY_ALLOWED_FOR_SPIKE',
    usagePolicy: 'Transitive MP4 muxer used by WebAV. BSD-3-Clause terms must be retained in client bundle notices.',
    findings: [
      'JavaScript port of GPAC MP4Box for ISO BMFF stream parsing and packaging.',
      'Explicitly licensed under BSD-3-Clause in package.json.',
    ],
  },
  {
    name: 'opfs-tools',
    version: '0.7.2',
    integritySha512:
      'sha512-ITMh4BnRCh/wFDFFaTsZOFLGUCoXbtn4KH1qh4S2LLF31+afqhXxz0NK74wqyRB5tbgnDD2SDcn7J4HeEVuvgg==',
    shasum: '3d1be1260fe1efd43f61de981ec57cd133effd60',
    tarballUrl: 'https://registry.npmjs.org/opfs-tools/-/opfs-tools-0.7.2.tgz',
    licenseSpdx: 'MIT',
    distributionObligations: 'MIT notice required.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT.',
    verdict: 'AUDITED_CLIENT_DEPENDENCY',
    usagePolicy: 'Origin Private File System helper for high-throughput browser frame staging.',
    findings: ['Simplifies high-performance disk-backed chunk writing in browser Web Workers.'],
  },
  {
    name: 'wave-resampler',
    version: '1.0.0',
    integritySha512:
      'sha512-bE3rbpZXuKAV52Cd8/BeJvy82ZqEHK8pPWHrZ9JioaVVTBlmWbDC+u4p9blhFcf0Skepb4hlOAHc25XfqLC48g==',
    shasum: '127502338d28e6d5315be1abb06665c04bbb4fc6',
    tarballUrl: 'https://registry.npmjs.org/wave-resampler/-/wave-resampler-1.0.0.tgz',
    licenseSpdx: 'MIT',
    distributionObligations: 'MIT notice required.',
    hasLifecycleScripts: false,
    noticeRequired: true,
    sourceOfferRequired: false,
    patentGrantClause: 'Standard MIT.',
    verdict: 'AUDITED_CLIENT_DEPENDENCY',
    usagePolicy: 'Audio sample rate conversion utility (e.g. 44.1kHz to standard 48kHz).',
    findings: ['Pure JavaScript sinc/linear audio resampler for WebCodecs input normalization.'],
  },
];

/**
 * Patent and Software Licensing Evaluation for Browser Video Codecs.
 */
export const CODEC_LEGAL_EVALUATION = {
  h264_avc: {
    patentPool: 'MPEG-LA / Via LA AVC Patent Portfolio',
    browserNativeWebCodecs: {
      status: 'ALLOWED_NO_ROYALTY_FOR_WEBAPP',
      legalBasis:
        'Browser-native WebCodecs VideoEncoder delegates to OS-level hardware/platform codecs (e.g. Apple VideoToolbox on iOS/macOS, Microsoft Media Foundation on Windows, Android MediaCodec on Android). The platform vendor (Apple, Microsoft, Google) holds the relevant MPEG-LA device/OS licenses. The client-side web application does not distribute software codec binaries and incurs no direct patent royalty obligations.',
    },
    clientSoftwareWasm: {
      status: 'STRICTLY_BLOCKED',
      legalBasis:
        'Bundling a custom client-side software H.264 encoder (such as GPL libx264 compiled to WebAssembly) is STRICTLY BLOCKED. It creates severe GPL license contamination risks, violates Creativanta commercial boundaries, and triggers unmitigated MPEG-LA patent pool licensing obligations without royalty indemnity. Always use native WebCodecs or fallback to server jobs.',
    },
  },
  aac_audio: {
    patentPool: 'Via LA AAC Patent Licensing Agreement',
    browserNativeWebCodecs: {
      status: 'ALLOWED_NO_ROYALTY_FOR_WEBAPP',
      legalBasis:
        'Browser-native WebCodecs AudioEncoder with mp4a.40.2 (AAC-LC) is covered by host platform licensing agreements. When unavailable (e.g. Firefox on Linux), client falls back to server jobs.',
    },
  },
  vp9_av1_opus: {
    patentPool: 'Royalty-free open standards (Alliance for Open Media / Google / IETF RFC 6716)',
    status: 'ALLOWED_ROYALTY_FREE',
    legalBasis:
      'VP9, AV1, and Opus are open, royalty-free codecs suitable for WebM and MP4 packaging where platform decoders are universally deployed.',
  },
} as const;

export class BrowserExportGatePendingError extends Error {
  public readonly code = 'SHIPPING_GATE_PENDING_REVIEW';
  constructor(message: string) {
    super(message);
    this.name = 'BrowserExportGatePendingError';
  }
}

/**
 * Default External Gate Configuration for P8-01 / P8-02.
 * Initial state is pending_external_review.
 */
export const DEFAULT_P8_01_GATE: BrowserExportGateConfig = {
  gateId: 'EXT-P8-01',
  status: 'pending_external_review',
  notes:
    'WebAV/Mediabunny legal, browser-distribution, and capability matrix review completed locally. Production code shipping is blocked pending formal independent reviewer sign-off.',
};

/**
 * Enforces the strict rule: "No code shipping trước review".
 * Prevents initializing or executing any browser export video rendering pipeline
 * unless the external gate EXT-P8-01 has been formally approved by an authorized reviewer.
 *
 * @throws {BrowserExportGatePendingError} if gate is not approved
 */
export function assertBrowserExportGateApproved(
  config: BrowserExportGateConfig = DEFAULT_P8_01_GATE,
): void {
  if (config.status !== 'approved_by_reviewer') {
    throw new BrowserExportGatePendingError(
      `[SECURITY_GATE_BLOCKED] Browser export runtime code execution is prohibited before formal reviewer sign-off on gate ${config.gateId}. Current status: ${config.status}. Requirement: "No code shipping trước review".`,
    );
  }
}
