/**
 * API Service Entrypoint & Tenant Foundation Exports (P1-01 / P3-01)
 */

import { loadEnvConfig, redactEnvConfig } from '@creativanta/contracts';
import { createServer } from './server.js';

export * from './server.js';
export * from './auth/api-key.js';
export * from './db/migration-runner.js';
export * from './db/tenant-pool.js';
export * from './db/repository.js';
export * from './templates/template-engine.js';
export * from './assets/upload-grant.js';
export * from './assets/quarantine-store.js';
export * from './assets/media-guard.js';
export * from './assets/ssrf-guard.js';
export * from './assets/import-connector.js';
export * from './storage/sweeper.js';

export function main(): void {
  const config = loadEnvConfig();
  const server = createServer({ config });

  let port = 8080;
  try {
    const url = new URL(config.CVE_PUBLIC_BASE_URL);
    if (url.port) {
      port = Number(url.port);
    }
  } catch {
    // fallback to 8080
  }

  const host = process.env['HOST'] || (config.CVE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0');

  server.listen(port, host, () => {
    // Redacted configuration logging
    const safeConfig = redactEnvConfig(config);
    process.stdout.write(
      JSON.stringify({
        event: 'SERVER_STARTED',
        service: 'creativanta-video-engine-api',
        host,
        port,
        environment: config.CVE_ENV,
        config: safeConfig,
      }) + '\n',
    );
  });

  const shutdown = (signal: string) => {
    process.stdout.write(
      JSON.stringify({
        event: 'SERVER_SHUTDOWN',
        signal,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
    server.close(() => {
      process.exit(0);
    });
    // Force exit after 5s timeout
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  main();
}
