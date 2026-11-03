/**
 * Controller service entrypoint, liveness/readiness probes & sandbox self-test CLI
 * Canonical specification: docs/DEPLOYMENT.md (line 56) & docs/SECURITY.md
 */

import http from 'node:http';
import { CveEnvConfig, loadEnvConfig } from '@creativanta/contracts';
import { LeaseManager } from './lease.js';
import { runSandboxSelfTest } from './sandbox.js';

export * from './lease.js';
export * from './sandbox.js';

export function startControllerServer(customConfig?: CveEnvConfig): http.Server {
  const config = customConfig ?? loadEnvConfig();
  const leaseManager = new LeaseManager();
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'creativanta-video-engine-controller',
          slots: config.CVE_RENDER_SLOTS,
          adapter: config.CVE_RENDERER_ADAPTER,
          custom_code_enabled: config.CVE_CUSTOM_CODE_ENABLED,
          custom_runtime: config.CVE_CUSTOM_RUNTIME,
          active_leases: 0,
          lease_manager_ready: Boolean(leaseManager),
          uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (req.url === '/readyz' && req.method === 'GET') {
      try {
        const selfTest = await runSandboxSelfTest(config);
        const ready = selfTest.status === 'PASS' && !config.CVE_CUSTOM_CODE_ENABLED;
        res.writeHead(ready ? 200 : 503);
        res.end(
          JSON.stringify({
            status: ready ? 'ready' : 'not_ready',
            service: 'creativanta-video-engine-controller',
            custom_code_enabled: config.CVE_CUSTOM_CODE_ENABLED,
            sandbox_self_test: selfTest,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (err) {
        res.writeHead(503);
        res.end(
          JSON.stringify({
            status: 'not_ready',
            service: 'creativanta-video-engine-controller',
            error: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  if (process.argv.includes('--self-test')) {
    runSandboxSelfTest()
      .then((report) => {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        process.exit(report.status === 'PASS' ? 0 : 1);
      })
      .catch((err) => {
        process.stderr.write(
          JSON.stringify({
            status: 'FAIL',
            error: err instanceof Error ? err.message : String(err),
          }) + '\n',
        );
        process.exit(1);
      });
  } else {
    const port = Number(process.env['PORT']) || 8081;
    const server = startControllerServer();
    server.listen(port, '0.0.0.0', () => {
      process.stdout.write(`Controller liveness server listening on port ${port}\n`);
    });
  }
}
