/**
 * Benchmark Types & Data Contracts for P2-04 Cross-Candidate Evaluation.
 * Canonical specification: docs/TESTING.md, docs/ADR/0001-engine-selection.md, docs/OPERATIONS.md
 */

export type BenchmarkCandidateId = 'chromium-frame-v1' | 'hyperframes-v1';
export type BenchmarkRunKind = 'warmup' | 'warm' | 'cold';
export type BenchmarkFixtureId = 'POC-01' | 'POC-02' | 'POC-03';

export interface StageWallTimes {
  prepareMs: number;
  renderMs: number;
  encodeMs: number;
  verifyMs: number;
}

export interface SingleRunResult {
  runIndex: number;
  runKind: BenchmarkRunKind;
  candidateId: BenchmarkCandidateId;
  fixtureId: BenchmarkFixtureId;
  durationFrames: number;
  outputDurationSeconds: number;
  stageWallTimes: StageWallTimes;
  wallSeconds: number;
  cpuUserSeconds: number;
  cpuSystemSeconds: number;
  cpuTotalSeconds: number;
  peakRssBytes: number;
  tempDiskBytes: number;
  outputBytes: number;
  rtf: number;
  exitStatus: 'PASS' | 'FAIL' | 'BLOCKED' | 'UNSUPPORTED';
  errorMessage?: string;
  blockerIds?: string[];
  frameCountDecoded?: number;
  ptsDriftFrames?: number;
  syncAnchorDeltaMs?: number;
  isDeterministic?: boolean;
}

export interface SampleDistribution {
  min: number;
  max: number;
  median: number;
  p95: number;
  mean: number;
}

export interface CandidateFixtureSummary {
  candidateId: BenchmarkCandidateId;
  fixtureId: BenchmarkFixtureId;
  durationFrames: number;
  outputDurationSeconds: number;
  warmupRunsCount: number;
  measuredWarmRunsCount: number;
  measuredColdRunsCount: number;
  warmRtf: SampleDistribution;
  coldRtf: SampleDistribution;
  warmWallSeconds: SampleDistribution;
  coldWallSeconds: SampleDistribution;
  cpuTotalSeconds: SampleDistribution;
  peakRssBytes: number;
  tempDiskBytes: number;
  outputBytes: number;
  targets: {
    targetWarmRtfSatisfied: boolean; // Testing: warm RTF <= 6.0
    targetPeakMemorySatisfied: boolean; // Testing: peak memory <= 4GiB
    targetNoOom: boolean;
    targetComputeCostSatisfied: boolean; // Testing: compute allocation <= 0.05 USD / output-min
  };
  overallStatus: 'PASS' | 'BLOCKED' | 'FAIL';
  blockers: string[];
}

export interface CostScenario {
  utilizationPercent: 10 | 50 | 80;
  hostHourlyCostUsd: number;
  reservedVcpus: number;
  workerHourlyCostUsd: number;
  outputMinutesProducedPerHour: number;
  computeCostPerOutputMinuteUsd: number;
  storageCost7dUsd: number;
  egressCost1DownloadUsd: number;
  totalCostPerOutputMinuteUsd: number;
  meetsBudgetCeiling: boolean;
}

export interface AdrGateResult {
  gate: 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6';
  name: string;
  description: string;
  chromiumStatus: 'PASS' | 'CONDITIONAL' | 'FAIL';
  hyperframesStatus: 'PASS' | 'CONDITIONAL' | 'BLOCKED' | 'FAIL';
  evidenceSummary: string;
  blockersIdentified: string[];
}

export interface ScoringCriterion {
  name: string;
  weight: number;
  chromiumScore: number;
  hyperframesScore: number;
  rationale: string;
}

export interface EngineSelectionReport {
  timestamp: string;
  gitCommitTested: string;
  referenceEnvironment: {
    os: string;
    arch: string;
    vcpus: number;
    ramGiB: number;
    nodeVersion: string;
  };
  fixturesEvaluated: BenchmarkFixtureId[];
  candidatesEvaluated: BenchmarkCandidateId[];
  fixtureSummaries: Record<string, CandidateFixtureSummary>;
  costScenarios: Record<BenchmarkCandidateId, Record<10 | 50 | 80, CostScenario>>;
  adrGates: AdrGateResult[];
  scoringMatrix: {
    criteria: ScoringCriterion[];
    totalChromium: number;
    totalHyperframes: number;
  };
  decision: {
    primaryEngine: BenchmarkCandidateId;
    fallbackEngine: string;
    hyperframesStatus: 'BLOCKED';
    formalBlockers: {
      id: string;
      title: string;
      severity: string;
      description: string;
    }[];
    summary: string;
  };
}
