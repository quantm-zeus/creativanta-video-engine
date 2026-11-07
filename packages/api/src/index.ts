/**
 * API Service Entrypoint & Tenant Foundation Exports (P1-01 / P3-01 / P10-A)
 */

import http from 'node:http';
import { CveEnvConfig, loadEnvConfig, redactEnvConfig } from '@creativanta/contracts';
import { CreateServerOptions, createServer } from './server.js';
import {
  BackendBootstrapError,
  BootstrapApiBackendOptions,
  BootstrappedApiBackend,
  bootstrapApiBackend,
} from './db/backend-bootstrap.js';

export * from './server.js';
export * from './auth/api-key.js';
export * from './db/migration-runner.js';
export * from './db/tenant-pool.js';
export * from './db/repository.js';
export * from './db/backend-bootstrap.js';
export * from './templates/template-engine.js';
export * from './assets/upload-grant.js';
export * from './assets/quarantine-store.js';
export * from './assets/media-guard.js';
export * from './assets/ssrf-guard.js';
export * from './assets/import-connector.js';
export * from './storage/sweeper.js';
export * from './admission/rate-limiter.js';
export * from './admission/job-admission.js';
export * from './dispatcher/index.js';
export * from './webhook/index.js';

export interface StartedApiServerHandle {
  server: http.Server;
  backend: BootstrappedApiBackend;
  config: CveEnvConfig;
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts the HTTP API server wired with the bootstrapped backend layer and
 * returns a deterministic lifecycle handle that closes both the HTTP listener
 * and any underlying backend resources.
 */
export async function startApiServer(
  options: Partial<BootstrapApiBackendOptions> & {
    rawEnv?: Record<string, string | undefined>;
    host?: string;
    port?: number;
    allowLoopbackForTesting?: boolean;
    allowCustomPortForTesting?: boolean;
  } = {},
): Promise<StartedApiServerHandle> {
  const rawEnv = options.rawEnv ?? process.env;
  const config = options.config ?? loadEnvConfig(rawEnv);
  const backend = bootstrapApiBackend({
    ...options,
    config,
    rawEnv,
  });

  let targetPort = options.port;
  if (targetPort === undefined) {
    targetPort = 8080;
    try {
      const url = new URL(config.CVE_PUBLIC_BASE_URL);
      if (url.port !== '') {
        targetPort = Number(url.port);
      }
    } catch {
      targetPort = 8080;
    }
  }

  const host =
    options.host ||
    rawEnv['HOST'] ||
    (config.CVE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0');

  const serverOptions: CreateServerOptions = {
    config,
    repository: backend.repository,
    quarantineStore: backend.quarantineStore,
    allowLoopbackForTesting: options.allowLoopbackForTesting,
    allowCustomPortForTesting: options.allowCustomPortForTesting,
    readinessProbe: backend.readinessProbe,
  };

  const server = createServer(serverOptions);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(targetPort, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (err) {
    await backend.close();
    throw err;
  }

  const address = server.address();
  const actualPort =
    address && typeof address === 'object' ? address.port : targetPort;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await backend.close();
  };

  return {
    server,
    backend,
    config,
    host,
    port: actualPort,
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    close,
  };
}

export function main(rawEnv: Record<string, string | undefined> = process.env): void {
  let config: CveEnvConfig;
  let backend: BootstrappedApiBackend;

  try {
    config = loadEnvConfig(rawEnv);
    backend = bootstrapApiBackend({ config, rawEnv });
  } catch (err) {
    const isBootstrapErr = err instanceof BackendBootstrapError;
    process.stderr.write(
      JSON.stringify({
        event: 'SERVER_STARTUP_REJECTED',
        service: 'creativanta-video-engine-api',
        error_code: isBootstrapErr ? err.code : 'INVALID_ENV_CONFIG',
        message: err instanceof Error ? err.message : String(err),
        details: isBootstrapErr ? err.details : [],
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
    process.exit(1);
    return;
  }

  const serverOptions: CreateServerOptions = {
    config,
    repository: backend.repository,
    quarantineStore: backend.quarantineStore,
    readinessProbe: backend.readinessProbe,
  };

  const server = createServer(serverOptions);

  let port = 8080;
  try {
    const url = new URL(config.CVE_PUBLIC_BASE_URL);
    if (url.port !== '') {
      port = Number(url.port);
    }
  } catch {
    // fallback to 8080
  }

  const host = rawEnv['HOST'] || (config.CVE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0');

  server.listen(port, host, () => {
    const safeConfig = redactEnvConfig(config);
    process.stdout.write(
      JSON.stringify({
        event: 'SERVER_STARTED',
        service: 'creativanta-video-engine-api',
        host,
        port,
        environment: config.CVE_ENV,
        backend_mode: backend.mode,
        non_production_test_only: backend.nonProductionTestOnly,
        repository_configured: Boolean(backend.repository),
        postgres_driver_compatible: backend.driverEvaluation.canServePostgresTraffic,
        seeded_test_tenants_count: backend.seededTenants.length,
        config: safeConfig,
      }) + '\n',
    );
  });

  const shutdown = (signal: string) => {
    process.stdout.write(
      JSON.stringify({
        event: 'SERVER_SHUTDOWN',
        signal,
        backend_mode: backend.mode,
        timestamp: new Date().toISOString(),
      }) + '\n',
    );
    server.close(() => {
      void backend.close().finally(() => {
        process.exit(0);
      });
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
