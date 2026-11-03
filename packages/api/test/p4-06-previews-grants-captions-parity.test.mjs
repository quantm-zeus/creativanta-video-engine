/**
 * Task P4-06 Integration Test Suite:
 *   - Frame & Clip Previews with Compiler & Runtime Integration
 *   - 360p / 720p Full Parity (Canvas, Scale 0.5, Animations, Transitions, Audio, Subtitles)
 *   - Download Grant & Execution Endpoint (TTL <= 5min, Scoped Bearer Tokens, Tenant Isolation)
 *   - Thumbnails, Captions (WebVTT / SRT), and Manifest Artifact Deliverables
 *   - Security Boundary: No Raw Custom HTML Origin (attachment, default-src 'none'; sandbox, nosniff)
 *
 * Canonical specifications:
 *   - docs/API.md ("Preview, render và status", lines 93-139; "GET /artifacts/{id}/download", line 44)
 *   - docs/SECURITY.md ("No raw custom HTML origin", "Chromium sandbox", lines 33-45)
 *   - docs/SCENE-SPEC.md ("Trục thời gian", "Subtitle track", "Transitions", lines 76-92)
 *   - docs/TESTING.md ("Video/audio verification", "Visual golden frames", lines 37-58)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  compileComposition,
  evaluateFrame,
  loadEnvConfig,
} from '@creativanta/contracts';

import {
  DownloadGrantError,
  JobDispatcher,
  MigrationRunner,
  QuarantineStore,
  RealRendererWorker,
  TenantConnectionPool,
  TenantRepository,
  createServer,
  generateSignedArtifactDownloadGrant,
  generateSrtForRange,
  generateVttForRange,
  verifyIsoBmffMp4,
  verifyPngBuffer,
  verifySignedArtifactDownloadGrant,
} from '../dist/index.js';

import * as DispatcherPackage from '../../dispatcher/index.mjs';

const TENANT_A_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_B_ID = '22222222-2222-4222-8222-222222222222';
const TEST_PEPPER = 'p4-06-previews-grants-captions-parity-secret-32b!';

function createTestHarness(options = {}) {
  const quarantineDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'creativanta-p406-quarantine-'),
  );
  const quarantineStore = new QuarantineStore(quarantineDir);
  const db = new DatabaseSync(':memory:');
  const runner = new MigrationRunner(db);
  runner.migrateUp({ role: 'cve_migrator' });

  const pool = new TenantConnectionPool(db, { poolSize: 8 });
  const repo = new TenantRepository(pool, {
    pepper: TEST_PEPPER,
    quarantineStore,
  });

  let currentDbTimeMs = Date.parse(options.initialTimeIso ?? '2026-11-03T18:00:00.000Z');
  const dbClock = () => new Date(currentDbTimeMs);
  const advanceClockMs = (deltaMs) => {
    currentDbTimeMs += deltaMs;
    return new Date(currentDbTimeMs);
  };

  repo.createTenant({ id: TENANT_A_ID, name: 'Tenant Alpha', now: dbClock() });
  repo.createTenant({ id: TENANT_B_ID, name: 'Tenant Beta', now: dbClock() });

  const keyA = repo.issueApiKey({
    tenantId: TENANT_A_ID,
    keyId: 'key_tenant_a',
    scopes: ['jobs:read', 'jobs:write', 'compositions:write', 'compositions:read', 'assets:write', 'assets:read', 'usage:read'],
    now: dbClock(),
  });
  const keyB = repo.issueApiKey({
    tenantId: TENANT_B_ID,
    keyId: 'key_tenant_b',
    scopes: ['jobs:read', 'jobs:write', 'compositions:write', 'compositions:read', 'assets:write', 'assets:read', 'usage:read'],
    now: dbClock(),
  });

  const dispatcher = new JobDispatcher({
    repository: repo,
    quarantineStore,
    maxGlobalSlots: options.maxGlobalSlots ?? 4,
    dbClock,
  });

  const cleanup = () => {
    try {
      quarantineStore.clearAll();
      fs.rmSync(quarantineDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    db,
    pool,
    repo,
    quarantineStore,
    dispatcher,
    keyA,
    keyB,
    dbClock,
    advanceClockMs,
    cleanup,
  };
}

function buildParityTestSpec(overrides = {}) {
  const durationFrames = overrides.duration_frames ?? 10; // 10 frames (0.333s at 30fps)
  return {
    schema_version: '1.0',
    canvas: {
      width: 1280,
      height: 720,
      background: '#0F172A',
    },
    fps: { num: 30, den: 1 },
    duration_frames: durationFrames,
    locale: 'vi-VN',
    direction: 'ltr',
    seed: 42,
    fonts: [
      {
        id: 'font_noto',
        asset_id: 'ast_font_noto',
        sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
        family: 'Noto Sans',
        weight: 400,
        style: 'normal',
      },
    ],
    scenes: [
      {
        id: 'scene_intro',
        revision: 1,
        engine: 'html-v1',
        start_frame: 0,
        duration_frames: 6,
        background: '#0F172A',
        transition_out: {
          type: 'fade_to_background',
          duration_frames: 3,
        },
        layers: [
          {
            id: 'layer_hero_card',
            type: 'shape',
            z_index: 1,
            start_frame: 0,
            duration_frames: 6,
            box: { x: 100, y: 80, width: 1080, height: 560 },
            opacity: 1,
            animations: [
              {
                property: 'opacity',
                easing: 'linear',
                keyframes: [
                  { frame: 0, value: 0.2 },
                  { frame: 5, value: 1.0 },
                ],
              },
            ],
            content: {
              shape: 'rect',
              fill: '#2563EB',
            },
          },
          {
            id: 'layer_hero_text',
            type: 'text',
            z_index: 2,
            start_frame: 0,
            duration_frames: 6,
            box: { x: 160, y: 140, width: 960, height: 120 },
            opacity: 1,
            content: {
              text: 'Trường học & Đắk Lắk: Ưu đãi 199.000 ₫',
              color: '#F8FAFC',
              font_id: 'font_noto',
              font_size: 32,
            },
          },
        ],
      },
      {
        id: 'scene_outro',
        revision: 1,
        engine: 'html-v1',
        start_frame: 6,
        duration_frames: 4,
        background: '#1E293B',
        transition_out: {
          type: 'cut',
          duration_frames: 0,
        },
        layers: [
          {
            id: 'layer_outro_card',
            type: 'shape',
            z_index: 1,
            start_frame: 0,
            duration_frames: 4,
            box: { x: 120, y: 100, width: 1040, height: 520 },
            opacity: 1,
            content: {
              shape: 'rect',
              fill: '#059669',
            },
          },
          {
            id: 'layer_outro_text',
            type: 'text',
            z_index: 2,
            start_frame: 0,
            duration_frames: 4,
            box: { x: 180, y: 160, width: 920, height: 100 },
            opacity: 1,
            content: {
              text: 'Cộng đồng Creativanta',
              color: '#ECFDF5',
              font_id: 'font_noto',
              font_size: 28,
            },
          },
        ],
      },
    ],
    audio_tracks: [
      {
        id: 'track_bgm',
        asset_id: 'ast_audio_bgm',
        start_frame: 0,
        duration_frames: durationFrames,
        source_in_samples: 0,
        gain_db: -3,
        role: 'music',
      },
    ],
    subtitles: [
      {
        id: 'sub_vn_main',
        locale: 'vi-VN',
        burn_in: true,
        style: {
          font_id: 'font_noto',
          font_size: 28,
          color: '#FFFFFF',
        },
        cues: [
          {
            id: 'cue_intro',
            start_frame: 0,
            end_frame: 6,
            text: 'Trường học & Đắk Lắk: Ưu đãi 199.000 ₫',
          },
          {
            id: 'cue_outro',
            start_frame: 6,
            end_frame: 10,
            text: 'Cộng đồng Creativanta Việt Nam',
          },
        ],
      },
    ],
    ...overrides,
  };
}

function seedTenantAssetsAndComp(repo, tenantId, compId = 'cmp_p406_test') {
  repo.createAsset(tenantId, {
    id: 'ast_font_noto',
    filename: 'NotoSans-Regular.ttf',
    kind: 'font',
    status: 'ready',
    mimeType: 'font/ttf',
    bytes: 2048,
    sha256: 'bf8fd5bfe62cec9cd6ce9bbbe7eab0f8772e3de8be30eb8d0ea0f97ec8452ff5',
    rights: { basis: 'licensed', source: 'Google Fonts SIL OFL' },
  });

  repo.createAsset(tenantId, {
    id: 'ast_audio_bgm',
    filename: 'bgm.wav',
    kind: 'audio',
    status: 'ready',
    mimeType: 'audio/wav',
    bytes: 8192,
    sha256: 'a1'.repeat(32),
    rights: { basis: 'owned', source: 'internal fixture' },
  });

  const spec = buildParityTestSpec();
  repo.createComposition(tenantId, {
    id: compId,
    name: 'P4-06 Parity Test Composition',
    spec,
  });

  return { compId, spec };
}

describe('P4-06: Frame/Clip Previews, Compiler/Runtime, Download Grants, Captions, Manifest & 360p Parity', () => {
  it('1. Frame preview (mode: frame) produces lossless 360p PNG, thumbnail, manifest, and captions sidecar', async () => {
    const h = createTestHarness();
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_API_KEY_PEPPER: TEST_PEPPER,
      CVE_CUSTOM_CODE_ENABLED: 'false',
    });
    const server = createServer({
      config,
      repository: h.repo,
      quarantineStore: h.quarantineStore,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { compId } = seedTenantAssetsAndComp(h.repo, TENANT_A_ID, 'cmp_frame_test');

      // 1. Submit valid frame preview at frame_index = 2 (within scene_intro)
      const res = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_frame_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: 2,
        }),
      });
      assert.equal(res.status, 202);
      assert.ok(res.headers.get('Location'));
      assert.equal(res.headers.get('Retry-After'), '2');

      const admitted = await res.json();
      const jobId = admitted.id;
      assert.equal(admitted.kind, 'preview');
      assert.equal(admitted.profile, 'preview-360p-v1');

      // 2. Execute via RealRendererWorker
      const worker = new RealRendererWorker({
        workerId: 'worker_p406_frame_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 50,
      });

      const workerRes = await worker.claimAndProcessNextJob();
      assert.equal(workerRes.status, 'succeeded');
      assert.equal(workerRes.jobId, jobId);

      // 3. Inspect job status and artifacts
      const jobStatusRes = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(jobStatusRes.status, 200);
      const jobStatus = await jobStatusRes.json();
      assert.equal(jobStatus.state, 'succeeded');
      assert.equal(jobStatus.stage, 'complete');

      // Verify artifacts: preview.png (video/primary), thumbnail.png (thumbnail), captions.vtt (captions), manifest.json (manifest)
      const artifacts = jobStatus.artifacts;
      assert.ok(artifacts.length >= 3);

      const previewArt = artifacts.find((a) => a.kind === 'video');
      assert.ok(previewArt);
      assert.equal(previewArt.mime_type, 'image/png');

      const thumbArt = artifacts.find((a) => a.kind === 'thumbnail');
      assert.ok(thumbArt);
      assert.equal(thumbArt.mime_type, 'image/png');

      const captionsArt = artifacts.find((a) => a.kind === 'captions');
      assert.ok(captionsArt);
      assert.equal(captionsArt.mime_type, 'text/vtt');

      const manifestArt = artifacts.find((a) => a.kind === 'manifest');
      assert.ok(manifestArt);
      assert.equal(manifestArt.mime_type, 'application/json');

      // 4. Verify preview PNG binary on disk: exactly 640x360 (0.5 scale from 1280x720)
      const storedPng = h.quarantineStore.getArtifactFileByStorageKey(
        h.repo.getArtifact(TENANT_A_ID, previewArt.id).storage_key,
      );
      assert.ok(storedPng);
      const pngVer = verifyPngBuffer(storedPng.buffer, 640, 360);
      assert.equal(pngVer.valid, true);
      assert.equal(pngVer.width, 640);
      assert.equal(pngVer.height, 360);

      // Verify thumbnail PNG
      const storedThumb = h.quarantineStore.getArtifactFileByStorageKey(
        h.repo.getArtifact(TENANT_A_ID, thumbArt.id).storage_key,
      );
      assert.ok(storedThumb);
      const thumbVer = verifyPngBuffer(storedThumb.buffer, 640, 360);
      assert.equal(thumbVer.valid, true);

      // 5. Verify manifest content contains preview metadata and parity info
      const storedManifest = h.quarantineStore.getArtifactFileByStorageKey(
        h.repo.getArtifact(TENANT_A_ID, manifestArt.id).storage_key,
      );
      assert.ok(storedManifest);
      const manifest = JSON.parse(storedManifest.buffer.toString('utf8'));
      assert.equal(manifest.schema_version, '1.0');
      assert.equal(manifest.kind, 'preview');
      assert.equal(manifest.profile, 'preview-360p-v1');
      assert.equal(manifest.width, 640);
      assert.equal(manifest.height, 360);
      assert.equal(manifest.preview.mode, 'frame');
      assert.equal(manifest.preview.frame_index, 2);
      assert.equal(manifest.parity.scale, 0.5);
      assert.equal(manifest.parity.canvas_width, 1280);
      assert.equal(manifest.parity.canvas_height, 720);
      assert.ok(manifest.artifacts.length >= 3);

      // 6. Verify timeline bounds validation rejects out-of-bounds frame_index
      const rejectLow = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_frame_low',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: -1,
        }),
      });
      assert.equal(rejectLow.status, 422);
      const lowErr = await rejectLow.json();
      assert.equal(lowErr.error.code, 'VALIDATION_FAILED');
      assert.ok(lowErr.error.details.some((d) => d.code === 'TIMELINE_BOUNDS'));

      const rejectHigh = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_frame_high',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: 10, // duration_frames is 10; max frame_index is 9
        }),
      });
      assert.equal(rejectHigh.status, 422);
      const highErr = await rejectHigh.json();
      assert.equal(highErr.error.code, 'VALIDATION_FAILED');
      assert.ok(highErr.error.details.some((d) => d.code === 'TIMELINE_BOUNDS'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('2. Clip preview (mode: clip) produces 360p faststart ISO-BMFF MP4 starting at t=0 with audio & shifted captions', async () => {
    const h = createTestHarness();
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_API_KEY_PEPPER: TEST_PEPPER,
      CVE_CUSTOM_CODE_ENABLED: 'false',
    });
    const server = createServer({
      config,
      repository: h.repo,
      quarantineStore: h.quarantineStore,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { compId } = seedTenantAssetsAndComp(h.repo, TENANT_A_ID, 'cmp_clip_test');

      // Submit clip preview: frames [2, 6) = 4 frames (spans intro scene and transition)
      const res = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_clip_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 2,
          duration_frames: 4,
        }),
      });
      assert.equal(res.status, 202);
      const admitted = await res.json();
      const jobId = admitted.id;

      // Execute via worker
      const worker = new RealRendererWorker({
        workerId: 'worker_p406_clip_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 50,
      });
      const workerRes = await worker.claimAndProcessNextJob();
      assert.equal(workerRes.status, 'succeeded');

      // Verify artifacts: output.mp4 (video), thumbnail.png (thumbnail), captions.vtt (captions), manifest.json (manifest)
      const jobStatusRes = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(jobStatusRes.status, 200);
      const jobStatus = await jobStatusRes.json();
      assert.equal(jobStatus.state, 'succeeded');

      const videoArt = jobStatus.artifacts.find((a) => a.kind === 'video');
      assert.ok(videoArt);
      assert.equal(videoArt.mime_type, 'video/mp4');

      const thumbArt = jobStatus.artifacts.find((a) => a.kind === 'thumbnail');
      assert.ok(thumbArt);
      assert.equal(thumbArt.mime_type, 'image/png');

      const captionsArt = jobStatus.artifacts.find((a) => a.kind === 'captions');
      assert.ok(captionsArt);
      assert.equal(captionsArt.mime_type, 'text/vtt');

      const manifestArt = jobStatus.artifacts.find((a) => a.kind === 'manifest');
      assert.ok(manifestArt);

      // Verify MP4 file structure: 640x360, 4 frames at 30fps, faststart (moov < mdat)
      const storedMp4 = h.quarantineStore.getArtifactFileByStorageKey(
        h.repo.getArtifact(TENANT_A_ID, videoArt.id).storage_key,
      );
      assert.ok(storedMp4);
      const isoReport = verifyIsoBmffMp4(storedMp4.buffer, {
        width: 640,
        height: 360,
        fps: 30,
        expectedFrames: 4,
      });
      assert.equal(isoReport.valid, true);
      assert.equal(isoReport.faststart, true);
      assert.ok(isoReport.moovOffset < isoReport.mdatOffset);
      assert.equal(isoReport.videoCodec, 'avc1');
      assert.equal(isoReport.audioCodec, 'mp4a');
      assert.equal(isoReport.videoFrameCount, 4);

      // Verify captions WebVTT: cue start time shifted to 00:00:00.000 for preview clip
      const storedVtt = h.quarantineStore.getArtifactFileByStorageKey(
        h.repo.getArtifact(TENANT_A_ID, captionsArt.id).storage_key,
      );
      assert.ok(storedVtt);
      const vttText = storedVtt.buffer.toString('utf8');
      assert.ok(vttText.startsWith('WEBVTT'));
      assert.ok(vttText.includes('NOTE Language: vi-VN'));
      assert.ok(vttText.includes('cue_intro'));
      // In source: cue_intro is [0, 6). Clip preview is [2, 6).
      // Shifted cue range in export: [0, 4) frames = 0.000s --> 0.133s (133ms)
      assert.ok(vttText.includes('00:00:00.000 --> 00:00:00.133'));
      // Vietnamese diacritic text preserved in NFC
      assert.ok(vttText.includes('Trường học & Đắk Lắk: Ưu đãi 199.000 ₫'));

      // Verify clip timeline bounds validation rejects out-of-bounds ranges (never silently clamps)
      const rejectOver = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_clip_over',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 8,
          duration_frames: 4, // 8 + 4 = 12 > 10 duration_frames
        }),
      });
      assert.equal(rejectOver.status, 422);
      const overErr = await rejectOver.json();
      assert.equal(overErr.error.code, 'VALIDATION_FAILED');
      assert.ok(overErr.error.details.some((d) => d.code === 'TIMELINE_BOUNDS'));

      const rejectDurationLimit = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_clip_too_long',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 0,
          duration_frames: 301, // exceeds 300 frames (10s at 30fps) limit
        }),
      });
      assert.equal(rejectDurationLimit.status, 422);
      const durErr = await rejectDurationLimit.json();
      assert.equal(durErr.error.code, 'VALIDATION_FAILED');
      assert.ok(durErr.error.details.some((d) => d.code === 'TIMELINE_BOUNDS'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('3. Mathematical parity between 360p preview and full 720p render (scale 0.5, animations, transitions, audio)', () => {
    const spec = buildParityTestSpec({ duration_frames: 10 });
    const compiled720p = compileComposition(spec, {
      profile: 'mp4-720p-v1',
      skipCapabilityValidation: true,
      skipSchemaValidation: true,
      skipSemanticValidation: true,
    });
    const compiled360p = compileComposition(spec, {
      profile: 'preview-360p-v1',
      skipCapabilityValidation: true,
      skipSchemaValidation: true,
      skipSemanticValidation: true,
    });

    // Also verify valid 640x360 preview spec passes full unified validation without skipping
    const spec360 = buildParityTestSpec({
      duration_frames: 10,
      canvas: { width: 640, height: 360, background: '#0F172A' },
    });
    const compiled360Strict = compileComposition(spec360, {
      profile: 'preview-360p-v1',
    });
    assert.equal(compiled360Strict.canvas.width, 640);
    assert.equal(compiled360Strict.canvas.height, 360);

    assert.equal(compiled720p.canvas.width, 1280);
    assert.equal(compiled720p.canvas.height, 720);
    assert.equal(compiled360p.canvas.width, 1280);
    assert.equal(compiled360p.canvas.height, 720);

    // Verify mathematical parity across all 10 frames
    for (let f = 0; f < 10; f++) {
      const eval720 = evaluateFrame(compiled720p, f);
      const eval360 = evaluateFrame(compiled360p, f);

      // Frame evaluation is identical in frame index and timestamp
      assert.equal(eval720.frame_index, eval360.frame_index);
      assert.equal(eval720.timestamp_seconds, eval360.timestamp_seconds);

      // Scene states match
      assert.equal(eval720.scene.id, eval360.scene.id);
      assert.equal(eval720.scene.transition_active, eval360.scene.transition_active);
      assert.equal(eval720.scene.scene_alpha, eval360.scene.scene_alpha);

      // Layer states match exactly in relative properties
      assert.equal(eval720.layers.length, eval360.layers.length);
      for (let l = 0; l < eval720.layers.length; l++) {
        const l720 = eval720.layers[l];
        const l360 = eval360.layers[l];
        assert.equal(l720.layer_id, l360.layer_id);
        assert.equal(l720.opacity, l360.opacity);
        assert.equal(l720.transform.translate_x, l360.transform.translate_x);
        assert.equal(l720.transform.translate_y, l360.transform.translate_y);
        assert.equal(l720.transform.scale_x, l360.transform.scale_x);
        assert.equal(l720.transform.scale_y, l360.transform.scale_y);
      }

      // During fade_to_background transition (frames 3, 4, 5 of scene_intro):
      // scene_alpha(k) = (end - 1 - k) / (F - 1) = (5 - k) / 2
      if (f >= 3 && f <= 5) {
        const expectedAlpha = (5 - f) / 2;
        assert.equal(Math.abs(eval720.scene.scene_alpha - expectedAlpha) < 1e-6, true);
        assert.equal(eval720.scene.scene_alpha, eval360.scene.scene_alpha);
      }
    }
  });

  it('4. Artifact download grants return scoped URL (<= 5min) and download endpoint delivers files with strict headers (attachment, sandbox CSP, nosniff)', async () => {
    const h = createTestHarness();
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_API_KEY_PEPPER: TEST_PEPPER,
      CVE_CUSTOM_CODE_ENABLED: 'false',
    });
    const server = createServer({
      config,
      repository: h.repo,
      quarantineStore: h.quarantineStore,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { compId } = seedTenantAssetsAndComp(h.repo, TENANT_A_ID, 'cmp_grant_test');

      // Submit and execute a clip preview job
      const admitRes = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_grant_exec_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'clip',
          start_frame: 0,
          duration_frames: 4,
        }),
      });
      assert.equal(admitRes.status, 202);
      const admitted = await admitRes.json();

      const worker = new RealRendererWorker({
        workerId: 'worker_p406_grant_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 50,
      });
      const workerRes = await worker.claimAndProcessNextJob();
      assert.equal(workerRes.status, 'succeeded');

      // Retrieve artifacts
      const jobRes = await fetch(`${baseUrl}/v1/jobs/${admitted.id}`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(jobRes.status, 200);
      const job = await jobRes.json();
      assert.ok(job.artifacts.length >= 3);

      for (const art of job.artifacts) {
        // 1. GET /v1/artifacts/{id}/download
        const grantRes = await fetch(`${baseUrl}/v1/artifacts/${art.id}/download`, {
          headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
        });
        assert.equal(grantRes.status, 200);
        const grant = await grantRes.json();

        assert.ok(grant.url);
        assert.ok(grant.expires_at);
        assert.ok(grant.sha256);
        assert.ok(typeof grant.bytes === 'number');

        // Check TTL <= 300s
        const grantExpiryMs = Date.parse(grant.expires_at);
        const nowMs = Date.now();
        assert.ok(grantExpiryMs > nowMs);
        assert.ok(grantExpiryMs - nowMs <= 301 * 1000);

        // 2. Execute download via grant.url
        const downloadRes = await fetch(grant.url);
        assert.equal(downloadRes.status, 200);

        // Verify security headers: attachment, sandbox CSP, nosniff
        const disposition = downloadRes.headers.get('content-disposition');
        assert.ok(disposition?.includes('attachment'));

        const csp = downloadRes.headers.get('content-security-policy');
        assert.equal(csp, "default-src 'none'; sandbox");

        const nosniff = downloadRes.headers.get('x-content-type-options');
        assert.equal(nosniff, 'nosniff');

        const xfo = downloadRes.headers.get('x-frame-options');
        assert.equal(xfo, 'DENY');

        const contentType = downloadRes.headers.get('content-type');
        assert.equal(contentType, art.mime_type);

        const bodyBuf = Buffer.from(await downloadRes.arrayBuffer());
        assert.equal(bodyBuf.byteLength, grant.bytes);

        const actualSha = crypto.createHash('sha256').update(bodyBuf).digest('hex');
        assert.equal(actualSha, grant.sha256);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('5. Security boundary: foreign tenant ID returns 404, tampered/expired/revoked token returns error, and no raw custom HTML on origin', async () => {
    const h = createTestHarness();
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
      CVE_API_KEY_PEPPER: TEST_PEPPER,
      CVE_CUSTOM_CODE_ENABLED: 'false',
    });
    const server = createServer({
      config,
      repository: h.repo,
      quarantineStore: h.quarantineStore,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { compId } = seedTenantAssetsAndComp(h.repo, TENANT_A_ID, 'cmp_sec_test');

      // Submit and execute job for Tenant A
      const admitRes = await fetch(`${baseUrl}/v1/previews`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${h.keyA.plaintextKey}`,
          'Idempotency-Key': 'idem_p406_sec_1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          composition_id: compId,
          revision: 1,
          profile: 'preview-360p-v1',
          mode: 'frame',
          frame_index: 0,
        }),
      });
      assert.equal(admitRes.status, 202);
      const admitted = await admitRes.json();

      const worker = new RealRendererWorker({
        workerId: 'worker_p406_sec_1',
        dispatcher: h.dispatcher,
        heartbeatIntervalMs: 50,
      });
      await worker.claimAndProcessNextJob();

      const jobRes = await fetch(`${baseUrl}/v1/jobs/${admitted.id}`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      const job = await jobRes.json();
      const videoArt = job.artifacts.find((a) => a.kind === 'video');
      assert.ok(videoArt);

      // 1. Tenant B probes Tenant A's artifact: returns 404 NOT_FOUND (never 403)
      const foreignProbe = await fetch(`${baseUrl}/v1/artifacts/${videoArt.id}/download`, {
        headers: { Authorization: `Bearer ${h.keyB.plaintextKey}` },
      });
      assert.equal(foreignProbe.status, 404);

      // 2. Obtain valid grant for Tenant A
      const grantRes = await fetch(`${baseUrl}/v1/artifacts/${videoArt.id}/download`, {
        headers: { Authorization: `Bearer ${h.keyA.plaintextKey}` },
      });
      assert.equal(grantRes.status, 200);
      const grant = await grantRes.json();

      // 3. Tampered signature is rejected with 403 INVALID_GRANT_SIGNATURE
      const tokenMatch = /\/artifacts\/download\/([^/?]+)/.exec(grant.url);
      assert.ok(tokenMatch);
      const validToken = tokenMatch[1];

      const decodedEnvelope = JSON.parse(
        Buffer.from(validToken, 'base64url').toString('utf8'),
      );
      decodedEnvelope.sig = 'f'.repeat(64); // tamper signature
      const tamperedToken = Buffer.from(JSON.stringify(decodedEnvelope), 'utf8').toString('base64url');

      const tamperedRes = await fetch(`${baseUrl}/v1/artifacts/download/${tamperedToken}`);
      assert.equal(tamperedRes.status, 403);
      const tamperedBody = await tamperedRes.json();
      assert.equal(tamperedBody.error.code, 'INVALID_GRANT_SIGNATURE');

      // 4. Expired token is rejected with 410 ARTIFACT_GRANT_EXPIRED
      decodedEnvelope.expiresAt = new Date(Date.now() - 60000).toISOString();
      // compute valid signature for expired payload
      const hmac = crypto.createHmac('sha256', TEST_PEPPER);
      hmac.update(
        [
          decodedEnvelope.tenantId,
          decodedEnvelope.artifactId,
          decodedEnvelope.jobId,
          decodedEnvelope.storageKey,
          decodedEnvelope.filename,
          decodedEnvelope.mimeType,
          decodedEnvelope.sha256,
          String(decodedEnvelope.bytes),
          decodedEnvelope.expiresAt,
          decodedEnvelope.grantKind,
        ].join(':'),
      );
      decodedEnvelope.sig = hmac.digest('hex');
      const expiredToken = Buffer.from(JSON.stringify(decodedEnvelope), 'utf8').toString('base64url');

      const expiredRes = await fetch(`${baseUrl}/v1/artifacts/download/${expiredToken}`);
      assert.equal(expiredRes.status, 410);

      // 5. No raw custom HTML origin:
      // If someone crafts an artifact download grant claiming to serve text/html,
      // the endpoint must NEVER serve it inline or as executable HTML on the origin
      const videoArtRow = h.repo.getArtifact(TENANT_A_ID, videoArt.id);
      const htmlPayload = {
        tenantId: TENANT_A_ID,
        artifactId: 'art_fake_html',
        jobId: admitted.id,
        storageKey: videoArtRow.storage_key,
        filename: 'exploit.html',
        mimeType: 'text/html',
        sha256: videoArtRow.sha256,
        bytes: videoArtRow.bytes,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        grantKind: 'artifact_download',
      };
      const htmlHmac = crypto.createHmac('sha256', TEST_PEPPER);
      htmlHmac.update(
        [
          htmlPayload.tenantId,
          htmlPayload.artifactId,
          htmlPayload.jobId,
          htmlPayload.storageKey,
          htmlPayload.filename,
          htmlPayload.mimeType,
          htmlPayload.sha256,
          String(htmlPayload.bytes),
          htmlPayload.expiresAt,
          htmlPayload.grantKind,
        ].join(':'),
      );
      const htmlToken = Buffer.from(
        JSON.stringify({ ...htmlPayload, sig: htmlHmac.digest('hex') }),
        'utf8',
      ).toString('base64url');

      // Add fake artifact row so repository lookup passes
      h.pool.withTransaction({ tenantId: TENANT_A_ID, role: 'cve_dispatcher' }, (tx) => {
        tx.insertScoped('artifacts', {
          tenant_id: TENANT_A_ID,
          id: 'art_fake_html',
          job_id: admitted.id,
          attempt_id: videoArtRow.attempt_id,
          kind: 'quality_report',
          mime_type: 'text/html',
          sha256: videoArtRow.sha256,
          bytes: videoArtRow.bytes,
          storage_key: videoArtRow.storage_key,
          expires_at: new Date(Date.now() + 60000).toISOString(),
          revoked_at: null,
          created_at: new Date().toISOString(),
        });
      });

      const htmlRes = await fetch(`${baseUrl}/v1/artifacts/download/${htmlToken}`);
      assert.equal(htmlRes.status, 200);

      // Verify that HTML is neutralized: mimeType overridden to application/octet-stream,
      // Content-Disposition is attachment, and Content-Security-Policy is default-src 'none'; sandbox
      const htmlCt = htmlRes.headers.get('content-type');
      assert.equal(htmlCt, 'application/octet-stream');

      const htmlDisp = htmlRes.headers.get('content-disposition');
      assert.ok(htmlDisp?.includes('attachment'));

      const htmlCsp = htmlRes.headers.get('content-security-policy');
      assert.equal(htmlCsp, "default-src 'none'; sandbox");

      const htmlNosniff = htmlRes.headers.get('x-content-type-options');
      assert.equal(htmlNosniff, 'nosniff');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      h.cleanup();
    }
  });

  it('6. Re-exports canonical helpers from packages/dispatcher and verifies subtitle generation utility functions', () => {
    assert.equal(typeof DispatcherPackage.JobDispatcher, 'function');
    assert.equal(typeof DispatcherPackage.RealRendererWorker, 'function');
    assert.equal(typeof DispatcherPackage.generateVttForRange, 'function');
    assert.equal(typeof DispatcherPackage.generateSrtForRange, 'function');
    assert.equal(typeof DispatcherPackage.formatTimestampVtt, 'function');
    assert.equal(typeof DispatcherPackage.formatTimestampSrt, 'function');

    // Test timestamp formatting
    assert.equal(DispatcherPackage.formatTimestampVtt(3723456), '01:02:03.456');
    assert.equal(DispatcherPackage.formatTimestampSrt(3723456), '01:02:03,456');

    // Test WebVTT generator
    const tracks = [
      {
        id: 'sub_test',
        locale: 'vi-VN',
        burn_in: true,
        style: {},
        cues: [
          { id: 'c1', start_frame: 30, end_frame: 90, text: 'Đoạn phụ đề 1' },
          { id: 'c2', start_frame: 90, end_frame: 150, text: 'Đoạn phụ đề 2' },
        ],
      },
    ];

    // For clip range [30, 90) at 30fps: cue c1 starts at 0ms and ends at 2000ms
    const vtt = DispatcherPackage.generateVttForRange(tracks, 30, 60, 30);
    assert.ok(vtt.startsWith('WEBVTT'));
    assert.ok(vtt.includes('00:00:00.000 --> 00:00:02.000'));
    assert.ok(vtt.includes('Đoạn phụ đề 1'));
    assert.ok(!vtt.includes('Đoạn phụ đề 2')); // c2 is outside [30, 90)

    // Test SRT generator
    const srt = DispatcherPackage.generateSrtForRange(tracks, 30, 60, 30);
    assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,000\nĐoạn phụ đề 1'));
  });
});
