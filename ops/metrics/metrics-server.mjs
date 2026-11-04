/**
 * Creativanta Video Engine - Standalone Metrics Scraping Server & Exporter
 * Canonical specification: docs/OPERATIONS.md
 */

import http from 'node:http';
import { defaultRegistry } from './metrics-registry.mjs';

/**
 * Creates an HTTP server serving /metrics in Prometheus text exposition format.
 */
export function createMetricsServer(registry = defaultRegistry, port = 9090) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/metrics' && req.method === 'GET') {
      const output = registry.toPrometheus();
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(output),
      });
      res.end(output);
      return;
    }

    if (url.pathname === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  return {
    server,
    listen: () =>
      new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server));
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
    port,
  };
}
