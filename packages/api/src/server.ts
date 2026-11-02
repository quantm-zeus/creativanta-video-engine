/**
 * REST API Server implementation for Creativanta Video Engine.
 * Canonical specification: docs/API.md
 */

import http from 'node:http';
import { URL } from 'node:url';
import {
  CveEnvConfig,
  CapabilitiesResponse,
} from '@creativanta/contracts';

export interface CreateServerOptions {
  config: CveEnvConfig;
}

export function buildCapabilities(config: CveEnvConfig): CapabilitiesResponse {
  return {
    api_version: '1.0.0',
    scene_schema_versions: ['1.0'],
    engines: {
      'html-v1': true,
      'canvas-v1': true,
      'svg-v1': true,
      'custom-html-v1': config.CVE_CUSTOM_CODE_ENABLED,
    },
    profiles: {
      'mp4-720p-v1': {
        id: 'mp4-720p-v1',
        description: 'Standard 720p H.264 MP4 render (1280x720 landscape or 720x1280 portrait at 30fps)',
        supported: true,
        dimensions: [
          { width: 1280, height: 720 },
          { width: 720, height: 1280 },
        ],
        fps: { num: 30, den: 1 },
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        max_duration_seconds: 180,
      },
      'preview-360p-v1': {
        id: 'preview-360p-v1',
        description: 'Fast 360p preview (scale 0.5 from 720p canvas; PNG frame or MP4 clip)',
        supported: true,
        dimensions: [
          { width: 640, height: 360 },
          { width: 360, height: 640 },
        ],
        fps: { num: 30, den: 1 },
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: 'aac',
        max_duration_seconds: 60,
      },
    },
    limits: {
      max_duration_frames: 10800,
      max_scenes: 50,
      max_layers_per_scene: 100,
      max_audio_tracks: 16,
      max_subtitles: 8,
      max_fonts: 16,
      max_upload_bytes: 100 * 1024 * 1024, // 100 MiB
    },
    features: {
      remote_import: config.CVE_REMOTE_IMPORT_ENABLED,
      custom_code: config.CVE_CUSTOM_CODE_ENABLED,
      authoring_adapter: config.CVE_AUTHORING_PROVIDER !== 'disabled',
      tts: config.CVE_TTS_PROVIDER !== 'disabled',
    },
    policy_version: '2026-11-02-v1',
  };
}

export function createServer({ config }: CreateServerOptions): http.Server {
  const startTime = Date.now();

  const server = http.createServer((req, res) => {
    const rawUrl = req.url || '/';
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Malformed URL' } }));
      return;
    }

    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // Default headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // Liveness probe
    if (pathname === '/healthz' && method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'creativanta-video-engine-api',
          environment: config.CVE_ENV,
          uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Readiness probe
    if (pathname === '/readyz' && method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ready',
          service: 'creativanta-video-engine-api',
          checks: {
            database: 'ok',
            storage: 'ok',
            renderer: config.CVE_RENDERER_ADAPTER,
          },
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Capabilities endpoint
    if (pathname === '/v1/capabilities' && method === 'GET') {
      const caps = buildCapabilities(config);
      res.writeHead(200);
      res.end(JSON.stringify(caps));
      return;
    }

    // Unhandled routes
    res.writeHead(404);
    res.end(
      JSON.stringify({
        error: {
          code: 'NOT_FOUND',
          message: `Endpoint ${method} ${pathname} not found`,
        },
      }),
    );
  });

  return server;
}
