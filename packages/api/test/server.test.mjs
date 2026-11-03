import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnvConfig } from '@creativanta/contracts';
import { createServer } from '../dist/server.js';

describe('API Server Health & Capabilities', () => {
  let server;
  let baseUrl;

  before(async () => {
    const config = loadEnvConfig({
      CVE_ENV: 'development',
      CVE_PUBLIC_BASE_URL: 'http://127.0.0.1:0/v1',
    });
    server = createServer({ config });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
  });

  it('responds with 200 OK on /healthz', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.service, 'creativanta-video-engine-api');
    assert.strictEqual(body.environment, 'development');
    assert.ok(typeof body.uptime_seconds === 'number');
  });

  it('responds with 200 OK on /readyz', async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'ready');
    assert.strictEqual(body.checks.database, 'ok');
    assert.strictEqual(body.checks.storage, 'ok');
  });

  it('responds with 200 OK on /v1/capabilities matching API spec', async () => {
    const res = await fetch(`${baseUrl}/v1/capabilities`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.api_version, '1.0.0');
    assert.deepStrictEqual(body.scene_schema_versions, ['1.0']);
    assert.strictEqual(body.engines['html-v1'], true);
    assert.strictEqual(body.engines['canvas-v1'], true);
    assert.strictEqual(body.engines['svg-v1'], true);
    assert.strictEqual(body.engines['custom-html-v1'], false);
    assert.strictEqual(body.profiles['mp4-720p-v1'].supported, true);
    assert.strictEqual(body.features.custom_code, false);
    assert.strictEqual(body.features.remote_import, false);
    assert.strictEqual(body.limits.max_upload_bytes, 104857600);
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error.code, 'NOT_FOUND');
  });

  describe('POST /v1/compositions/validate', () => {
    const validSpec = {
      schema_version: '1.0',
      canvas: { width: 720, height: 1280, background: '#101828' },
      fps: { num: 30, den: 1 },
      duration_frames: 150,
      seed: 42,
      locale: 'vi-VN',
      fonts: [
        {
          id: 'brand_regular',
          asset_id: 'ast_font_regular',
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          family: 'Noto Sans',
          weight: 400,
          style: 'normal',
        },
      ],
      scenes: [
        {
          id: 'intro',
          revision: 1,
          start_frame: 0,
          duration_frames: 150,
          engine: 'html-v1',
          layers: [
            {
              id: 'headline',
              type: 'text',
              start_frame: 0,
              duration_frames: 150,
              z_index: 1,
              box: { x: 48, y: 400, width: 624, height: 240 },
              content: {
                text: 'Sáng tạo mỗi ngày',
                font_id: 'brand_regular',
                font_size: 54,
                color: '#FFFFFF',
              },
            },
          ],
        },
      ],
      audio_tracks: [],
      subtitles: [],
    };

    it('returns 200 OK with normalized spec, render_hash and estimate for valid composition', async () => {
      const res = await fetch(`${baseUrl}/v1/compositions/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: validSpec, profile: 'mp4-720p-v1' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.valid, true);
      assert.match(body.render_hash, /^[0-9a-f]{64}$/);
      assert.strictEqual(body.estimate.output_seconds, 5.0);
      assert.strictEqual(body.estimate.currency, 'USD');
      assert.strictEqual(body.normalized_spec.scenes[0].transition_out.type, 'cut');
    });

    it('returns 422 VALIDATION_FAILED when composition violates semantic timeline bounds', async () => {
      const invalidSpec = JSON.parse(JSON.stringify(validSpec));
      invalidSpec.scenes[0].start_frame = 20; // Violates start_frame=0
      const res = await fetch(`${baseUrl}/v1/compositions/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: invalidSpec, profile: 'mp4-720p-v1' }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'VALIDATION_FAILED');
      assert.ok(Array.isArray(body.error.details));
      assert.ok(body.error.details.some((d) => d.code === 'TIMELINE_BOUNDS'));
    });

    it('returns 422 UNSUPPORTED_CAPABILITY when canvas does not match profile dimensions', async () => {
      const invalidSpec = JSON.parse(JSON.stringify(validSpec));
      invalidSpec.canvas = { width: 1920, height: 1080 }; // 1080p canvas rejected by mp4-720p-v1
      const res = await fetch(`${baseUrl}/v1/compositions/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec: invalidSpec, profile: 'mp4-720p-v1' }),
      });
      assert.strictEqual(res.status, 422);
      const body = await res.json();
      assert.strictEqual(body.error.code, 'UNSUPPORTED_CAPABILITY');
      assert.ok(body.error.details.some((d) => d.code === 'PROFILE_CONSTRAINT_VIOLATED'));
    });
  });
});
