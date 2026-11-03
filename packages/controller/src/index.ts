/**
 * Controller service entrypoint & liveness probe
 */

import http from 'node:http';
import { loadEnvConfig } from '@creativanta/contracts';
import { LeaseManager } from './lease.js';

export * from './lease.js';

export function startControllerServer(): http.Server {
  const config = loadEnvConfig();
  const leaseManager = new LeaseManager();
  const startTime = Date.now();

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'creativanta-video-engine-controller',
          slots: config.CVE_RENDER_SLOTS,
          adapter: config.CVE_RENDERER_ADAPTER,
          active_leases: 0,
          lease_manager_ready: Boolean(leaseManager),
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
  const port = Number(process.env['PORT']) || 8081;
  const server = startControllerServer();
  server.listen(port, '0.0.0.0', () => {
    process.stdout.write(`Controller liveness server listening on port ${port}\n`);
  });
}
