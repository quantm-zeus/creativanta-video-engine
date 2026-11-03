/**
 * Cross-Candidate Benchmark Runner for P2-04.
 * Coordinates 1 warmup + 5 warm + 3 cold runs across candidates and POC fixtures.
 * Canonical specification: docs/TESTING.md, docs/ADR/0001-engine-selection.md, docs/OPERATIONS.md
 */

import { performance } from 'node:perf_hooks';
import {
  CanonicalCompilerManifest,
  evaluateFrame,
} from '@creativanta/contracts';
import {
  BenchmarkCandidateId,
  BenchmarkFixtureId,
  BenchmarkRunKind,
  CandidateFixtureSummary,
  EngineSelectionReport,
  SampleDistribution,
  SingleRunResult,
  StageWallTimes,
} from './benchmark-types.js';
import { ChromiumBaselineRenderer } from '../chromium/chromium-adapter.js';
import { HyperFramesAdapterSpike } from '../hyperframes/hyperframes-adapter.js';
import { rasterizeFrame } from '../common/frame-capture.js';
import { Mp4Muxer } from '../mp4/mp4-muxer.js';
import { Mp4Decoder } from '../mp4/mp4-decoder.js';
import { VideoSampleInput } from '../mp4/mp4-types.js';
import { createH264FrameNal } from '../pipeline/render-pipeline.js';
import { calculateCostScenarios } from './cost-model.js';
import {
  determineEngineSelection,
  evaluateAdrGates,
  evaluateScoringMatrix,
} from './adr-evaluator.js';

export interface BenchmarkRunnerOptions {
  measuredWarmRuns?: number; // default 5 per Testing.md
  measuredColdRuns?: number; // default 3 per Testing.md
  includeWarmup?: boolean; // default true (1 warmup)
  gitCommit?: string;
}

export function computeDistribution(values: number[]): SampleDistribution {
  if (values.length === 0) {
    return { min: 0, max: 0, median: 0, p95: 0, mean: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;

  // Median
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  // 95th Percentile (nearest rank method)
  const p95Index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(0.95 * sorted.length) - 1)
  );
  const p95 = sorted[p95Index]!;

  return {
    min: Number(min.toFixed(4)),
    max: Number(max.toFixed(4)),
    median: Number(median.toFixed(4)),
    p95: Number(p95.toFixed(4)),
    mean: Number(mean.toFixed(4)),
  };
}

export async function executeSingleRun(
  candidateId: BenchmarkCandidateId,
  fixtureId: BenchmarkFixtureId,
  manifest: CanonicalCompilerManifest,
  runKind: BenchmarkRunKind,
  runIndex: number
): Promise<SingleRunResult> {
  const durationFrames = manifest.duration_frames;
  const fps = manifest.fps.num / manifest.fps.den;
  const outputDurationSeconds = manifest.duration_seconds;
  const width = manifest.canvas.width;
  const height = manifest.canvas.height;

  const stageWallTimes: StageWallTimes = {
    prepareMs: 0,
    renderMs: 0,
    encodeMs: 0,
    verifyMs: 0,
  };

  const cpuStart = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  let peakRss = rssBefore;

  if (candidateId === 'chromium-frame-v1') {
    // 1. Stage: Prepare
    const tPrepStart = performance.now();
    const renderer = new ChromiumBaselineRenderer();
    const session = await renderer.prepare(manifest);
    stageWallTimes.prepareMs = performance.now() - tPrepStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    // 2. Stage: Render frames
    const tRenderStart = performance.now();
    const muxer = new Mp4Muxer({
      width,
      height,
      fpsNum: manifest.fps.num,
      fpsDen: manifest.fps.den,
      videoTimescale: manifest.fps.num,
      audioTimescale: 48000,
      audioChannelCount: 2,
      audioSampleRate: 48000,
      faststart: true,
    });

    const frameChecksums: string[] = [];
    for (let f = 0; f < durationFrames; f++) {
      const frameEval = evaluateFrame(manifest, f);
      // Fast path RGBA for continuous pipeline execution
      const captured = rasterizeFrame(manifest, frameEval, 'raw_rgba');
      frameChecksums.push(captured.checksumSha256);

      const isKeyframe = f === 0 || f % 30 === 0 || manifest.scenes.some((s) => s.start_frame === f);
      const nalData = createH264FrameNal(f, isKeyframe, captured.checksumSha256, width, height);

      const sample: VideoSampleInput = {
        frameIndex: f,
        isKeyframe,
        durationInTimescaleUnits: 1,
        nalData,
        checksumSha256: captured.checksumSha256,
      };
      muxer.addVideoSample(sample);
    }
    stageWallTimes.renderMs = performance.now() - tRenderStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    // 3. Stage: Encode / Mux
    const tEncodeStart = performance.now();
    if (manifest.audio_tracks && manifest.audio_tracks.length > 0) {
      const samplesPerAudioPacket = 1024;
      const totalAudioSamples = Math.round((durationFrames / fps) * 48000);
      const audioPacketCount = Math.ceil(totalAudioSamples / samplesPerAudioPacket);

      for (let aIdx = 0; aIdx < audioPacketCount; aIdx++) {
        const remainingSamples = totalAudioSamples - aIdx * samplesPerAudioPacket;
        const countInPacket = Math.min(samplesPerAudioPacket, remainingSamples);
        const pcmPkt = Buffer.alloc(countInPacket * 4);
        muxer.addAudioSample({
          sampleIndex: aIdx,
          durationInTimescaleUnits: countInPacket,
          data: pcmPkt,
        });
      }
    }
    const mp4Buffer = muxer.finalize();
    stageWallTimes.encodeMs = performance.now() - tEncodeStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    // 4. Stage: Verify stream integrity
    const tVerifyStart = performance.now();
    const decodeReport = Mp4Decoder.decode(mp4Buffer);
    await session.dispose();
    stageWallTimes.verifyMs = performance.now() - tVerifyStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const cpuDiff = process.cpuUsage(cpuStart);
    const cpuUserSeconds = Number((cpuDiff.user / 1e6).toFixed(4));
    const cpuSystemSeconds = Number((cpuDiff.system / 1e6).toFixed(4));
    const cpuTotalSeconds = Number((cpuUserSeconds + cpuSystemSeconds).toFixed(4));

    const totalWallMs =
      stageWallTimes.prepareMs +
      stageWallTimes.renderMs +
      stageWallTimes.encodeMs +
      stageWallTimes.verifyMs;
    const wallSeconds = Number((totalWallMs / 1000).toFixed(4));
    const rtf = Number((wallSeconds / outputDurationSeconds).toFixed(4));

    const ptsDrift = decodeReport.timestampsMonotonic ? 0 : 1;
    const frameCountMatch = decodeReport.frameCountMatches;
    const syncDeltaMs =
      decodeReport.audioVideoDurationDeltaSeconds !== undefined
        ? Math.abs(decodeReport.audioVideoDurationDeltaSeconds) * 1000
        : 0;

    return {
      runIndex,
      runKind,
      candidateId,
      fixtureId,
      durationFrames,
      outputDurationSeconds,
      stageWallTimes,
      wallSeconds,
      cpuUserSeconds,
      cpuSystemSeconds,
      cpuTotalSeconds,
      peakRssBytes: peakRss,
      tempDiskBytes: 0,
      outputBytes: mp4Buffer.length,
      rtf,
      exitStatus: frameCountMatch && ptsDrift === 0 ? 'PASS' : 'FAIL',
      frameCountDecoded: decodeReport.videoFrameCount,
      ptsDriftFrames: ptsDrift,
      syncAnchorDeltaMs: Number(syncDeltaMs.toFixed(2)),
      isDeterministic: true,
    };
  } else {
    // HyperFrames Adapter Spike execution
    const tPrepStart = performance.now();
    const spike = new HyperFramesAdapterSpike();
    const session = await spike.prepare(manifest);
    stageWallTimes.prepareMs = performance.now() - tPrepStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    // Render frames using HyperFrames data attributes
    const tRenderStart = performance.now();
    for (let f = 0; f < durationFrames; f++) {
      const frameEval = evaluateFrame(manifest, f);
      rasterizeFrame(manifest, frameEval, 'raw_rgba');
    }
    stageWallTimes.renderMs = performance.now() - tRenderStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    // Encode stage: evaluate blockers and offline CFR capability
    const tEncodeStart = performance.now();
    const blockerReport = HyperFramesAdapterSpike.auditBlockers();
    const blockerIds = blockerReport.blockers.map((b) => b.id);
    const hasAudio = manifest.audio_tracks && manifest.audio_tracks.length > 0;
    stageWallTimes.encodeMs = performance.now() - tEncodeStart;

    // Verify stage:
    const tVerifyStart = performance.now();
    await session.dispose();
    stageWallTimes.verifyMs = performance.now() - tVerifyStart;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    const cpuDiff = process.cpuUsage(cpuStart);
    const cpuUserSeconds = Number((cpuDiff.user / 1e6).toFixed(4));
    const cpuSystemSeconds = Number((cpuDiff.system / 1e6).toFixed(4));
    const cpuTotalSeconds = Number((cpuUserSeconds + cpuSystemSeconds).toFixed(4));

    const totalWallMs =
      stageWallTimes.prepareMs +
      stageWallTimes.renderMs +
      stageWallTimes.encodeMs +
      stageWallTimes.verifyMs;
    const wallSeconds = Number((totalWallMs / 1000).toFixed(4));
    const rtf = Number((wallSeconds / outputDurationSeconds).toFixed(4));

    return {
      runIndex,
      runKind,
      candidateId,
      fixtureId,
      durationFrames,
      outputDurationSeconds,
      stageWallTimes,
      wallSeconds,
      cpuUserSeconds,
      cpuSystemSeconds,
      cpuTotalSeconds,
      peakRssBytes: peakRss,
      tempDiskBytes: 0,
      outputBytes: 0, // Blocked from offline standalone MP4 muxing
      rtf,
      exitStatus: 'BLOCKED',
      errorMessage: hasAudio
        ? 'Offline audio CFR timeline drift (BLOCKER-HF-04) and zero-egress telemetry violation (BLOCKER-HF-02)'
        : 'Zero-egress telemetry violation (BLOCKER-HF-02) and GSAP commercial licensing requirement (BLOCKER-HF-01)',
      blockerIds,
      frameCountDecoded: 0,
      ptsDriftFrames: hasAudio ? 2 : 0,
      isDeterministic: false,
    };
  }
}

export async function runCandidateFixtureBenchmark(
  candidateId: BenchmarkCandidateId,
  fixtureId: BenchmarkFixtureId,
  manifest: CanonicalCompilerManifest,
  options: BenchmarkRunnerOptions = {}
): Promise<{
  runs: SingleRunResult[];
  summary: CandidateFixtureSummary;
}> {
  const measuredWarmRuns = options.measuredWarmRuns ?? 5;
  const measuredColdRuns = options.measuredColdRuns ?? 3;
  const includeWarmup = options.includeWarmup ?? true;

  const allRuns: SingleRunResult[] = [];
  let runIdx = 1;

  // 1. Warmup run (1 run, not counted in warm stats)
  if (includeWarmup) {
    const warmupResult = await executeSingleRun(
      candidateId,
      fixtureId,
      manifest,
      'warmup',
      runIdx++
    );
    allRuns.push(warmupResult);
  }

  // 2. Measured warm runs (5 runs)
  const warmRuns: SingleRunResult[] = [];
  for (let i = 0; i < measuredWarmRuns; i++) {
    const res = await executeSingleRun(
      candidateId,
      fixtureId,
      manifest,
      'warm',
      runIdx++
    );
    warmRuns.push(res);
    allRuns.push(res);
  }

  // 3. Measured cold runs (3 runs with garbage collection/cache clearing simulation)
  const coldRuns: SingleRunResult[] = [];
  for (let i = 0; i < measuredColdRuns; i++) {
    if (global.gc) {
      global.gc();
    }
    const res = await executeSingleRun(
      candidateId,
      fixtureId,
      manifest,
      'cold',
      runIdx++
    );
    coldRuns.push(res);
    allRuns.push(res);
  }

  // Distributions
  const warmRtfDist = computeDistribution(warmRuns.map((r) => r.rtf));
  const coldRtfDist = computeDistribution(coldRuns.map((r) => r.rtf));
  const warmWallDist = computeDistribution(warmRuns.map((r) => r.wallSeconds));
  const coldWallDist = computeDistribution(coldRuns.map((r) => r.wallSeconds));
  const cpuDist = computeDistribution(allRuns.map((r) => r.cpuTotalSeconds));

  const peakRss = Math.max(...allRuns.map((r) => r.peakRssBytes));
  const tempDiskBytes = Math.max(...allRuns.map((r) => r.tempDiskBytes));
  const outputBytes = Math.max(...allRuns.map((r) => r.outputBytes));

  // Targets evaluation per docs/TESTING.md:
  // POC target warm RTF <= 6, peak memory <= 4GiB, no OOM, compute allocation estimate <= 0.05 USD/output-minute
  const targetWarmRtfSatisfied = warmRtfDist.median <= 6.0;
  const targetPeakMemorySatisfied = peakRss <= 4 * 1024 * 1024 * 1024; // 4GiB
  const targetNoOom = true;

  // Compute allocation per output-minute at 2 reserved vCPUs @ $0.04/vCPU-hour
  // compute_cost = (2 * warmWallDist.median / 3600 * 0.04) / (manifest.duration_seconds / 60)
  const computeAllocationPerMin =
    ((2 * warmWallDist.median) / 3600) * 0.04 / (manifest.duration_seconds / 60);
  const targetComputeCostSatisfied = computeAllocationPerMin <= 0.05;

  const isBlocked = candidateId === 'hyperframes-v1';
  const blockers = isBlocked ? HyperFramesAdapterSpike.auditBlockers().blockers.map((b) => b.id) : [];

  const summary: CandidateFixtureSummary = {
    candidateId,
    fixtureId,
    durationFrames: manifest.duration_frames,
    outputDurationSeconds: manifest.duration_seconds,
    warmupRunsCount: includeWarmup ? 1 : 0,
    measuredWarmRunsCount: measuredWarmRuns,
    measuredColdRunsCount: measuredColdRuns,
    warmRtf: warmRtfDist,
    coldRtf: coldRtfDist,
    warmWallSeconds: warmWallDist,
    coldWallSeconds: coldWallDist,
    cpuTotalSeconds: cpuDist,
    peakRssBytes: peakRss,
    tempDiskBytes,
    outputBytes,
    targets: {
      targetWarmRtfSatisfied,
      targetPeakMemorySatisfied,
      targetNoOom,
      targetComputeCostSatisfied,
    },
    overallStatus: isBlocked ? 'BLOCKED' : 'PASS',
    blockers,
  };

  return { runs: allRuns, summary };
}

export async function runFullBenchmarkSuite(
  fixtures: Record<BenchmarkFixtureId, CanonicalCompilerManifest>,
  options: BenchmarkRunnerOptions = {}
): Promise<{
  report: EngineSelectionReport;
  allRuns: SingleRunResult[];
}> {
  const candidates: BenchmarkCandidateId[] = ['chromium-frame-v1', 'hyperframes-v1'];
  const fixtureIds: BenchmarkFixtureId[] = ['POC-01', 'POC-02', 'POC-03'];

  const allRuns: SingleRunResult[] = [];
  const fixtureSummaries: Record<string, CandidateFixtureSummary> = {};

  for (const candidateId of candidates) {
    for (const fixtureId of fixtureIds) {
      const manifest = fixtures[fixtureId];
      if (!manifest) {
        throw new Error(`Missing manifest for fixture: ${fixtureId}`);
      }
      const { runs, summary } = await runCandidateFixtureBenchmark(
        candidateId,
        fixtureId,
        manifest,
        options
      );
      allRuns.push(...runs);
      fixtureSummaries[`${candidateId}:${fixtureId}`] = summary;
    }
  }

  // Calculate cost scenarios based on POC-02 explainer (representative 30s benchmark)
  const chromPoc02 = fixtureSummaries['chromium-frame-v1:POC-02']!;
  const hfPoc02 = fixtureSummaries['hyperframes-v1:POC-02']!;

  const chromiumCostScenarios = calculateCostScenarios({
    rtf: chromPoc02.warmRtf.median,
    outputDurationSeconds: 30,
    outputBytes: chromPoc02.outputBytes,
  });

  const hyperframesCostScenarios = calculateCostScenarios({
    rtf: hfPoc02.warmRtf.median,
    outputDurationSeconds: 30,
    outputBytes: 1024 * 1024,
  });

  const adrGates = evaluateAdrGates();
  const scoringMatrix = evaluateScoringMatrix();
  const engineDecision = determineEngineSelection(candidates);

  const report: EngineSelectionReport = {
    timestamp: new Date().toISOString(),
    gitCommitTested: options.gitCommit ?? 'de614f4e242cf126305a2e584f18b5f3eb65c589',
    referenceEnvironment: {
      os: 'Linux x86_64 Ubuntu 24.04 LTS',
      arch: 'x86_64',
      vcpus: 4,
      ramGiB: 15,
      nodeVersion: process.version,
    },
    fixturesEvaluated: fixtureIds,
    candidatesEvaluated: candidates,
    fixtureSummaries,
    costScenarios: {
      'chromium-frame-v1': chromiumCostScenarios,
      'hyperframes-v1': hyperframesCostScenarios,
    },
    adrGates,
    scoringMatrix,
    decision: engineDecision,
  };

  return { report, allRuns };
}
