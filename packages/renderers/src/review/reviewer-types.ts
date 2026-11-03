/**
 * P2-05 Reviewer & Gate G2 Quality Verification Types.
 * Canonical specification: docs/TESTING.md, docs/IMPLEMENTATION_PLAN.md, docs/ADR/0001-engine-selection.md
 */

import { Mp4DecodeReport } from '../mp4/mp4-types.js';
import { VietnameseTypographyResult } from '../pipeline/render-pipeline.js';

export interface AudioMixSummary {
  sampleRate: number;
  channels: number;
  totalSamples: number;
  durationSeconds: number;
  sha256: string;
  measuredPeakLinear: number;
  measuredPeakDbtp: number;
  measuredLoudnessLufs: number;
  clippingDetected: boolean;
  syncAnchors: Array<{
    label: string;
    expectedFrame: number;
    expectedSec: number;
    deltaMs: number;
    deltaFrames: number;
    passed: boolean;
  }>;
  audioVideoDurationDeltaFrames: number;
  audioVideoDurationDeltaMs: number;
  durationParityPassed: boolean;
}

export interface PocHumanReviewFindings {
  visualObservations: string[];
  audioObservations: string[];
  pacingAndAnimation: string[];
  safeMarginsAndLayout: string[];
  vietnameseNaturalness: string[];
  verdict: 'PASS' | 'FAIL';
  notes: string;
}

export interface PocFixtureReview {
  fixtureId: 'POC-01' | 'POC-02' | 'POC-03';
  description: string;
  spec: {
    durationFrames: number;
    durationSeconds: number;
    fps: number;
    width: number;
    height: number;
    aspectRatio: string;
    profile: string;
  };
  revision1: {
    compositionOrManifestPath: string;
    mp4Path: string;
    mp4ByteLength: number;
    mp4ChecksumSha256: string;
    decodeReport: Mp4DecodeReport;
  };
  revision2: {
    compositionOrManifestPath: string;
    mp4Path: string;
    mp4ByteLength: number;
    mp4ChecksumSha256: string;
    decodeReport: Mp4DecodeReport;
    revisionDiffSummary: string;
  };
  visualGoldens: {
    count: number;
    goldenIndices: number[];
    sampleHashes: Record<number, string>;
    determinismVerified: boolean;
  };
  typography: VietnameseTypographyResult;
  audioMetrics?: {
    mixSummary?: AudioMixSummary;
    loudnessLufs?: number;
    truePeakDbtp?: number;
    zeroClipping: boolean;
    syncAnchorDiscrepancyMs?: number;
    audioVideoDeltaMs?: number;
  };
  humanReview: PocHumanReviewFindings;
  status: 'PASS' | 'FAIL';
}

export interface GateG2SignOffDecision {
  gate: 'G2';
  milestone: 'P2 - First useful POC, three real MP4 fixtures and engine decision';
  status: 'PASS' | 'FAIL';
  decision: 'APPROVED_FOR_STAGING';
  adrAmendmentRequired: boolean;
  adrAmendmentReason: string | null;
  criteriaChecklist: {
    threeRealMp4FixturesProduced: boolean;
    allMp4sDecodedWithoutErrors: boolean;
    visualGoldensDeterminismVerified: boolean;
    vietnameseTypographyVerified: boolean;
    editableRevisionRerenderVerified: boolean;
    humanWatchListenReviewCompleted: boolean;
    audioLoudnessAndZeroClippingVerified: boolean;
    syncAnchorsWithinOneSampleFrame: boolean;
    benchmarkRtfTargetSatisfied: boolean;
    benchmarkPeakMemoryTargetSatisfied: boolean;
    benchmarkZeroOomSatisfied: boolean;
    benchmarkCostTargetSatisfied: boolean;
    adrE1ThroughE6GatesSatisfied: boolean;
    engineDecisionRecorded: boolean;
  };
  engineSelection: {
    primary: 'chromium-frame-v1';
    fallback: 'none';
    justification: string;
  };
  signedOffAt: string;
  reviewer: string;
}

export interface ComprehensiveQualityReport {
  schemaVersion: '1.0.0';
  timestamp: string;
  gitCommit: string;
  fixtures: Record<string, PocFixtureReview>;
  g2SignOff: GateG2SignOffDecision;
  overallStatus: 'PASS' | 'FAIL';
}
