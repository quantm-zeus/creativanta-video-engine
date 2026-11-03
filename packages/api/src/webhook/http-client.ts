/**
 * SSRF-Safe Webhook HTTP Client (Task P4-04).
 *
 * Enforces:
 *   - HTTPS only (port 443 baseline)
 *   - Strict DNS resolution & multi-homed IP audit (no RFC1918, loopback, metadata, link-local)
 *   - IP pinning to prevent DNS rebinding attacks while verifying TLS SNI servername
 *   - 0 redirects allowed (redirect: 'manual')
 *   - 2s connect timeout, 5s total timeout
 *   - 8 KiB response body cap
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { URL } from 'node:url';

import {
  SsrSecurityError,
  defaultDnsResolver,
  resolveAndAuditHostDns,
  validateAndNormalizeImportUrl,
} from '../assets/ssrf-guard.js';
import {
  WEBHOOK_CONNECT_TIMEOUT_MS,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TOTAL_TIMEOUT_MS,
} from './types.js';

export interface WebhookHttpRequestOptions {
  url: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  body?: Buffer | string;
  allowLoopbackForTesting?: boolean;
  allowCustomPortForTesting?: boolean;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface WebhookHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  bodyBytes: Buffer;
  pinnedIp: string;
}

export class WebhookHttpError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly retryable: boolean;

  constructor(message: string, code = 'WEBHOOK_HTTP_ERROR', status?: number, retryable = true) {
    super(message);
    this.name = 'WebhookHttpError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Performs an SSRF-safe HTTP POST/GET to a webhook receiver.
 */
export async function sendWebhookHttpRequest(
  options: WebhookHttpRequestOptions,
): Promise<WebhookHttpResponse> {
  const method = options.method ?? 'POST';
  const connectTimeoutMs = options.connectTimeoutMs ?? WEBHOOK_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? WEBHOOK_TOTAL_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? WEBHOOK_MAX_RESPONSE_BYTES;

  // 1. Validate & normalize URL syntax, reject backslashes, userinfo, fragments, etc.
  if (!options.allowLoopbackForTesting || !options.url.startsWith('http://127.0.0.1')) {
    validateAndNormalizeImportUrl(options.url, {
      allowCustomPortForTesting: options.allowCustomPortForTesting,
    });
  }

  const parsedUrl = new URL(options.url);
  const isHttps = parsedUrl.protocol === 'https:';

  if (!isHttps && !options.allowLoopbackForTesting) {
    throw new SsrSecurityError('Webhook endpoint must use https: protocol', 'UNSUPPORTED_SCHEME', 422, '/url');
  }

  // 2. Resolve DNS and audit every resolved IP address
  let pinnedIp: string;
  if (options.allowLoopbackForTesting && (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost')) {
    pinnedIp = '127.0.0.1';
  } else {
    const dnsResult = await resolveAndAuditHostDns(parsedUrl.hostname, defaultDnsResolver, {
      allowLoopbackForTesting: options.allowLoopbackForTesting,
    });
    pinnedIp = dnsResult.pinnedIp;
  }

  const port = parsedUrl.port
    ? parseInt(parsedUrl.port, 10)
    : isHttps
      ? 443
      : 80;

  const bodyBuffer = options.body
    ? Buffer.isBuffer(options.body)
      ? options.body
      : Buffer.from(options.body, 'utf8')
    : Buffer.alloc(0);

  const requestHeaders: Record<string, string> = {
    ...options.headers,
    Host: parsedUrl.host,
    'Content-Length': String(bodyBuffer.length),
  };

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let connectTimer: NodeJS.Timeout | null = null;
    let isSettled = false;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (connectTimer) clearTimeout(connectTimer);
    };

    const fail = (err: WebhookHttpError | Error) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err);
    };

    // Total timeout guard
    timer = setTimeout(() => {
      fail(
        new WebhookHttpError(
          `Webhook delivery timed out after ${totalTimeoutMs}ms (total timeout exceeded)`,
          'TOTAL_TIMEOUT',
          undefined,
          true,
        ),
      );
    }, totalTimeoutMs);

    // Socket create with IP pinning & TLS SNI
    const createConnection = () => {
      if (isHttps) {
        // Connect to pinned IP, verify SNI hostname against parsedUrl.hostname
        const socket = tls.connect({
          host: pinnedIp,
          port,
          servername: parsedUrl.hostname,
          rejectUnauthorized: !options.allowLoopbackForTesting, // Allow self-signed in test if loopback
        });
        return socket;
      } else {
        const socket = net.connect({
          host: pinnedIp,
          port,
        });
        return socket;
      }
    };

    const reqOptions: http.RequestOptions = {
      method,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: requestHeaders,
      createConnection,
    };

    const client = isHttps ? https : http;
    const req = client.request(reqOptions, (res) => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }

      const status = res.statusCode ?? 0;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        }
      }

      // Check for redirects: 3xx is strictly prohibited!
      if (status >= 300 && status < 400) {
        res.resume(); // Discard body
        fail(
          new WebhookHttpError(
            `Webhook receiver returned redirect (${status} ${headers['location'] || ''}). Redirects are strictly prohibited for webhook deliveries`,
            'REDIRECT_PROHIBITED',
            status,
            false, // Non-retryable
          ),
        );
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let limitExceeded = false;

      res.on('data', (chunk: Buffer) => {
        if (limitExceeded) return;
        totalBytes += chunk.length;
        if (totalBytes > maxResponseBytes) {
          limitExceeded = true;
          // Cap at limit and resume stream to discard remaining
          const allowed = chunk.subarray(0, chunk.length - (totalBytes - maxResponseBytes));
          if (allowed.length > 0) chunks.push(allowed);
          res.resume();
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        if (isSettled) return;
        isSettled = true;
        cleanup();

        const bodyBytes = Buffer.concat(chunks);
        const body = bodyBytes.toString('utf8');

        resolve({
          status,
          headers,
          body,
          bodyBytes,
          pinnedIp,
        });
      });

      res.on('error', (err) => {
        fail(new WebhookHttpError(`Response stream error: ${err.message}`, 'NETWORK_ERROR', status, true));
      });
    });

    // Connect timeout guard
    connectTimer = setTimeout(() => {
      req.destroy();
      fail(
        new WebhookHttpError(
          `Webhook connection timed out after ${connectTimeoutMs}ms (connect timeout exceeded)`,
          'CONNECT_TIMEOUT',
          undefined,
          true,
        ),
      );
    }, connectTimeoutMs);

    req.on('socket', (socket) => {
      socket.on('connect', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      });
      socket.on('secureConnect', () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      });
    });

    req.on('error', (err) => {
      fail(new WebhookHttpError(`Request error: ${err.message}`, 'NETWORK_ERROR', undefined, true));
    });

    if (bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}
