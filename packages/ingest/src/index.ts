/**
 * Media Ingest service entrypoint & liveness probe
 */

import http from 'node:http';

export * from './media-guard.js';

export function startIngestServer(): http.Server {
  const startTime = Date.now();

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'creativanta-video-engine-ingest',
          uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const port = Number(process.env['PORT']) || 8082;
  const server = startIngestServer();
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`Ingest liveness server listening on port ${port}\n`);
  });
}
