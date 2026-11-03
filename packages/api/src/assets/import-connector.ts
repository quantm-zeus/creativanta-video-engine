/**
 * Remote Asset Import Connector with Multi-Tier SSRF & Media Defenses (Task P3-04).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("URL allowlists và SSRF", lines 25-33)
 *   - docs/API.md ("Asset intake", lines 35, 87-92)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P3-04)
 */

import crypto from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { URL } from 'node:url';
import {
  DnsLookupFunction,
  checkTenantImportAllowlist,
  resolveAndAuditHostDns,
  validateAndNormalizeImportUrl,
  SsrSecurityError,
} from './ssrf-guard.js';
import { QuarantineStore } from './quarantine-store.js';
import { executeSandboxMediaProbe, ALLOWED_MIME_TYPES } from './media-guard.js';

export const MAX_IMPORT_BYTES = 100 * 1024 * 1024; // 100 MiB per docs/SECURITY.md line 31
export const DEFAULT_CONNECT_TIMEOUT_MS = 3000; // 3s per docs/SECURITY.md line 31
export const DEFAULT_TOTAL_TIMEOUT_MS = 30000; // 30s per docs/SECURITY.md line 31
export const MAX_REDIRECT_HOPS = 3; // max 3 per docs/SECURITY.md line 29

export interface ImportRightsPayload {
  basis: 'owned' | 'licensed' | 'public_domain';
  source: string;
  attribution: string;
  expires_at?: string;
}

export interface ImportAssetRequest {
  url: string;
  expected_sha256: string;
  rights: ImportRightsPayload;
}

export interface ImportConnectorOptions {
  quarantineStore: QuarantineStore;
  dnsResolver?: DnsLookupFunction;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxStreamingBytes?: number;
  maxRedirects?: number;
  allowInsecureTlsForTesting?: boolean;
  allowCustomPortForTesting?: boolean;
  allowLoopbackForTesting?: boolean;
  caCert?: Buffer | string;
}

export interface ImportExecutionResult {
  success: boolean;
  assetId: string;
  filename: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  sanitizedSourceUrl: string;
  sanitizedRights: Record<string, unknown>;
  probeMetadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Array<{ pointer: string; code: string; message: string }>;
  };
}

/**
 * Validates rights metadata for import requests.
 */
export function validateImportRights(
  rights: unknown,
  now = new Date(),
): { valid: true; sanitized: ImportRightsPayload } | { valid: false; code: string; message: string; pointer: string } {
  if (!rights || typeof rights !== 'object') {
    return { valid: false, code: 'MISSING_RIGHTS', message: 'Rights metadata is required', pointer: '/rights' };
  }

  const r = rights as Record<string, unknown>;

  if (!['owned', 'licensed', 'public_domain'].includes(String(r['basis']))) {
    return {
      valid: false,
      code: 'INVALID_RIGHTS_BASIS',
      message: "Rights basis must be 'owned', 'licensed', or 'public_domain'",
      pointer: '/rights/basis',
    };
  }

  if (typeof r['source'] !== 'string' || r['source'].trim().length === 0 || r['source'].length > 500) {
    return {
      valid: false,
      code: 'INVALID_RIGHTS_SOURCE',
      message: 'Rights source must be a non-empty string <= 500 characters',
      pointer: '/rights/source',
    };
  }

  if (typeof r['attribution'] !== 'string' || r['attribution'].trim().length === 0 || r['attribution'].length > 500) {
    return {
      valid: false,
      code: 'INVALID_RIGHTS_ATTRIBUTION',
      message: 'Rights attribution must be a non-empty string <= 500 characters',
      pointer: '/rights/attribution',
    };
  }

  if (r['expires_at'] !== undefined && r['expires_at'] !== null) {
    const expTime = Date.parse(String(r['expires_at']));
    if (Number.isNaN(expTime)) {
      return {
        valid: false,
        code: 'INVALID_DATE_FORMAT',
        message: 'Rights expires_at must be an RFC3339 / ISO-8601 date-time string',
        pointer: '/rights/expires_at',
      };
    }
    if (expTime <= now.getTime()) {
      return {
        valid: false,
        code: 'RIGHTS_EXPIRED',
        message: 'Rights license has already expired',
        pointer: '/rights/expires_at',
      };
    }
  }

  return {
    valid: true,
    sanitized: {
      basis: r['basis'] as 'owned' | 'licensed' | 'public_domain',
      source: r['source'] as string,
      attribution: r['attribution'] as string,
      ...(r['expires_at'] ? { expires_at: String(r['expires_at']) } : {}),
    },
  };
}

/**
 * Infers an asset MIME type from the URL pathname or HTTP response Content-Type.
 */
export function inferAssetMimeType(pathname: string, contentTypeHeader?: string): string {
  if (contentTypeHeader) {
    const cleaned = contentTypeHeader.split(';')[0]?.trim().toLowerCase();
    if (cleaned && (ALLOWED_MIME_TYPES as readonly string[]).includes(cleaned)) {
      return cleaned;
    }
  }

  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case '.mp4':
      return 'video/mp4';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'video/mp4'; // Default media container
  }
}

/**
 * Strips query string and fragment from a source URL to prevent persisting OAuth tokens or signed params.
 */
export function sanitizeSourceUrl(parsedUrl: URL): string {
  return `${parsedUrl.origin}${parsedUrl.pathname}`;
}

export class ImportConnector {
  private readonly quarantineStore: QuarantineStore;
  private readonly dnsResolver?: DnsLookupFunction;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly maxStreamingBytes: number;
  private readonly maxRedirects: number;
  private readonly allowInsecureTlsForTesting: boolean;
  private readonly allowCustomPortForTesting: boolean;
  private readonly allowLoopbackForTesting: boolean;
  private readonly caCert?: Buffer | string;
  private readonly inFlightImports = new Map<string, Promise<ImportExecutionResult>>();

  constructor(options: ImportConnectorOptions) {
    this.quarantineStore = options.quarantineStore;
    this.dnsResolver = options.dnsResolver;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.maxStreamingBytes = options.maxStreamingBytes ?? MAX_IMPORT_BYTES;
    this.maxRedirects = options.maxRedirects ?? MAX_REDIRECT_HOPS;
    this.allowInsecureTlsForTesting = options.allowInsecureTlsForTesting ?? false;
    this.allowCustomPortForTesting = options.allowCustomPortForTesting ?? false;
    this.allowLoopbackForTesting = options.allowLoopbackForTesting ?? false;
    this.caCert = options.caCert;
  }

  public getDnsResolver(): DnsLookupFunction | undefined {
    return this.dnsResolver;
  }

  public getAllowCustomPortForTesting(): boolean {
    return this.allowCustomPortForTesting;
  }

  public getAllowLoopbackForTesting(): boolean {
    return this.allowLoopbackForTesting;
  }

  public getInFlightImport(assetId: string): Promise<ImportExecutionResult> | undefined {
    return this.inFlightImports.get(assetId);
  }

  /**
   * Performs an asynchronous remote media import with full SSRF defenses, connect-time IP pinning,
   * redirect audits, streaming byte caps, SHA-256 verification, and sandbox probing.
   */
  public async executeImport(params: {
    tenantId: string;
    assetId: string;
    url: string;
    expectedSha256: string;
    rights: ImportRightsPayload;
    allowlist: string[];
    now?: Date;
  }): Promise<ImportExecutionResult> {
    const p = this.executeImportInternal(params);
    this.inFlightImports.set(params.assetId, p);
    try {
      return await p;
    } finally {
      this.inFlightImports.delete(params.assetId);
    }
  }

  private async executeImportInternal(params: {
    tenantId: string;
    assetId: string;
    url: string;
    expectedSha256: string;
    rights: ImportRightsPayload;
    allowlist: string[];
    now?: Date;
  }): Promise<ImportExecutionResult> {
    const { tenantId, assetId, url: rawUrl, expectedSha256, rights, allowlist, now = new Date() } = params;

    // 1. Validate rights metadata
    const rightsCheck = validateImportRights(rights, now);
    if (!rightsCheck.valid) {
      return {
        success: false,
        assetId,
        filename: 'import.bin',
        mimeType: 'application/octet-stream',
        bytes: 0,
        sha256: expectedSha256,
        sanitizedSourceUrl: rawUrl,
        sanitizedRights: {},
        error: {
          code: rightsCheck.code,
          message: rightsCheck.message,
          details: [{ pointer: rightsCheck.pointer, code: rightsCheck.code, message: rightsCheck.message }],
        },
      };
    }

    // 2. Validate expected SHA-256 format
    const cleanExpectedSha = String(expectedSha256).toLowerCase().trim();
    if (!/^[0-9a-f]{64}$/.test(cleanExpectedSha)) {
      return {
        success: false,
        assetId,
        filename: 'import.bin',
        mimeType: 'application/octet-stream',
        bytes: 0,
        sha256: expectedSha256,
        sanitizedSourceUrl: rawUrl,
        sanitizedRights: rightsCheck.sanitized as unknown as Record<string, unknown>,
        error: {
          code: 'INVALID_CHECKSUM',
          message: 'expected_sha256 must be a 64-character lowercase hexadecimal string',
          details: [{ pointer: '/expected_sha256', code: 'INVALID_CHECKSUM', message: 'Invalid hex SHA-256' }],
        },
      };
    }

    // 3. Syntactic URL validation & normalization
    let currentUrl: URL;
    try {
      const validated = validateAndNormalizeImportUrl(rawUrl, {
        allowCustomPortForTesting: this.allowCustomPortForTesting,
      });
      currentUrl = validated.url;
    } catch (err) {
      const isSsrErr = err instanceof SsrSecurityError;
      return {
        success: false,
        assetId,
        filename: 'import.bin',
        mimeType: 'application/octet-stream',
        bytes: 0,
        sha256: cleanExpectedSha,
        sanitizedSourceUrl: rawUrl,
        sanitizedRights: rightsCheck.sanitized as unknown as Record<string, unknown>,
        error: {
          code: isSsrErr ? err.code : 'INVALID_URL',
          message: isSsrErr ? err.message : String(err),
          details: [{ pointer: isSsrErr ? err.pointer : '/url', code: isSsrErr ? err.code : 'INVALID_URL', message: String(err) }],
        },
      };
    }

    // 4. Initial tenant allowlist validation
    const allowCheck = checkTenantImportAllowlist(currentUrl, allowlist);
    if (!allowCheck.allowed) {
      return {
        success: false,
        assetId,
        filename: path.basename(currentUrl.pathname) || 'asset.mp4',
        mimeType: inferAssetMimeType(currentUrl.pathname),
        bytes: 0,
        sha256: cleanExpectedSha,
        sanitizedSourceUrl: sanitizeSourceUrl(currentUrl),
        sanitizedRights: rightsCheck.sanitized as unknown as Record<string, unknown>,
        error: {
          code: 'URL_NOT_ALLOWLISTED',
          message: `Import URL "${sanitizeSourceUrl(currentUrl)}" does not match any server-managed allowlist prefix for tenant`,
          details: [{ pointer: '/url', code: 'URL_NOT_ALLOWLISTED', message: 'Target host or path is not allowlisted' }],
        },
      };
    }

    // Strip sensitive query parameters from stored source provenance
    const sanitizedSourceUrl = sanitizeSourceUrl(currentUrl);
    const sanitizedRights: Record<string, unknown> = {
      ...rightsCheck.sanitized,
      source: sanitizedSourceUrl,
    };

    // 5. Multi-hop fetch with connect-time IP pinning and redirect defenses
    let redirectCount = 0;
    const startTime = Date.now();

    while (true) {
      // Check total timeout
      if (Date.now() - startTime > this.totalTimeoutMs) {
        return {
          success: false,
          assetId,
          filename: path.basename(currentUrl.pathname) || 'asset.mp4',
          mimeType: inferAssetMimeType(currentUrl.pathname),
          bytes: 0,
          sha256: cleanExpectedSha,
          sanitizedSourceUrl,
          sanitizedRights,
          error: {
            code: 'IMPORT_TIMEOUT',
            message: `Remote import fetch exceeded total timeout of ${this.totalTimeoutMs}ms`,
          },
        };
      }

      // DNS Resolution & IP Range Auditing
      let pinnedIp: string;
      try {
        const dnsResult = await resolveAndAuditHostDns(currentUrl.hostname, this.dnsResolver, {
          allowLoopbackForTesting: this.allowLoopbackForTesting,
        });
        pinnedIp = dnsResult.pinnedIp;
      } catch (err) {
        const isSsrErr = err instanceof SsrSecurityError;
        return {
          success: false,
          assetId,
          filename: path.basename(currentUrl.pathname) || 'asset.mp4',
          mimeType: inferAssetMimeType(currentUrl.pathname),
          bytes: 0,
          sha256: cleanExpectedSha,
          sanitizedSourceUrl,
          sanitizedRights,
          error: {
            code: isSsrErr ? err.code : 'DNS_ERROR',
            message: isSsrErr ? err.message : String(err),
            details: [{ pointer: '/url', code: isSsrErr ? err.code : 'DNS_ERROR', message: String(err) }],
          },
        };
      }

      // Connect-time IP Pinning + TLS Hostname Verification
      const fetchResult = await this.performPinnedFetch({
        targetUrl: currentUrl,
        pinnedIp,
        remainingTimeMs: Math.max(1000, this.totalTimeoutMs - (Date.now() - startTime)),
      });

      // Handle Redirects
      if (fetchResult.isRedirect) {
        redirectCount++;
        if (redirectCount > this.maxRedirects) {
          return {
            success: false,
            assetId,
            filename: path.basename(currentUrl.pathname) || 'asset.mp4',
            mimeType: inferAssetMimeType(currentUrl.pathname),
            bytes: 0,
            sha256: cleanExpectedSha,
            sanitizedSourceUrl,
            sanitizedRights,
            error: {
              code: 'MAX_REDIRECTS_EXCEEDED',
              message: `Import exceeded maximum allowed redirect hops (${this.maxRedirects})`,
            },
          };
        }

        const locationHeader = fetchResult.redirectLocation;
        if (!locationHeader) {
          return {
            success: false,
            assetId,
            filename: path.basename(currentUrl.pathname) || 'asset.mp4',
            mimeType: inferAssetMimeType(currentUrl.pathname),
            bytes: 0,
            sha256: cleanExpectedSha,
            sanitizedSourceUrl,
            sanitizedRights,
            error: {
              code: 'INVALID_REDIRECT',
              message: 'Redirect response missing Location header',
            },
          };
        }

        // Parse and revalidate redirect target URL
        let nextUrl: URL;
        try {
          const resolvedTarget = new URL(locationHeader, currentUrl);
          const nextValidated = validateAndNormalizeImportUrl(resolvedTarget.toString(), {
            allowCustomPortForTesting: this.allowCustomPortForTesting,
          });
          nextUrl = nextValidated.url;
        } catch (err) {
          const isSsrErr = err instanceof SsrSecurityError;
          return {
            success: false,
            assetId,
            filename: path.basename(currentUrl.pathname) || 'asset.mp4',
            mimeType: inferAssetMimeType(currentUrl.pathname),
            bytes: 0,
            sha256: cleanExpectedSha,
            sanitizedSourceUrl,
            sanitizedRights,
            error: {
              code: isSsrErr ? err.code : 'INVALID_REDIRECT_TARGET',
              message: `Redirect target URL is invalid: ${isSsrErr ? err.message : String(err)}`,
            },
          };
        }

        // Revalidate redirect target against tenant allowlist
        const redirectAllowCheck = checkTenantImportAllowlist(nextUrl, allowlist);
        if (!redirectAllowCheck.allowed) {
          return {
            success: false,
            assetId,
            filename: path.basename(nextUrl.pathname) || 'asset.mp4',
            mimeType: inferAssetMimeType(nextUrl.pathname),
            bytes: 0,
            sha256: cleanExpectedSha,
            sanitizedSourceUrl,
            sanitizedRights,
            error: {
              code: 'REDIRECT_NOT_ALLOWLISTED',
              message: `Redirect target "${sanitizeSourceUrl(nextUrl)}" is not in tenant allowlist`,
            },
          };
        }

        // Proceed to next hop (sensitive credentials/cookies are NOT forwarded)
        currentUrl = nextUrl;
        continue;
      }

      // Check HTTP Status
      if (!fetchResult.ok) {
        return {
          success: false,
          assetId,
          filename: path.basename(currentUrl.pathname) || 'asset.mp4',
          mimeType: inferAssetMimeType(currentUrl.pathname),
          bytes: 0,
          sha256: cleanExpectedSha,
          sanitizedSourceUrl,
          sanitizedRights,
          error: {
            code: fetchResult.errorCode || 'REMOTE_FETCH_FAILED',
            message: fetchResult.errorMessage || `Remote server returned HTTP ${fetchResult.statusCode}`,
          },
        };
      }

      // 6. Check downloaded payload
      const downloadedData = fetchResult.data!;
      const filename = path.basename(currentUrl.pathname) || 'imported_asset.mp4';
      const inferredMime = inferAssetMimeType(currentUrl.pathname, fetchResult.contentType);

      // Verify SHA-256 against expected_sha256
      const computedSha256 = crypto.createHash('sha256').update(downloadedData).digest('hex');
      if (computedSha256 !== cleanExpectedSha) {
        return {
          success: false,
          assetId,
          filename,
          mimeType: inferredMime,
          bytes: downloadedData.byteLength,
          sha256: computedSha256,
          sanitizedSourceUrl,
          sanitizedRights,
          error: {
            code: 'CHECKSUM_MISMATCH',
            message: `Downloaded data SHA-256 (${computedSha256}) does not match expected_sha256 (${cleanExpectedSha})`,
          },
        };
      }

      // 7. Save to quarantine store for isolated probing
      const quarantined = this.quarantineStore.saveQuarantined(tenantId, assetId, downloadedData);

      // 8. Execute isolated media probe
      const probeRes = await executeSandboxMediaProbe(
        quarantined.filePath,
        quarantined.buffer,
        inferredMime,
      );

      if (!probeRes.success) {
        this.quarantineStore.removeQuarantined(tenantId, assetId);
        return {
          success: false,
          assetId,
          filename,
          mimeType: inferredMime,
          bytes: downloadedData.byteLength,
          sha256: computedSha256,
          sanitizedSourceUrl,
          sanitizedRights,
          error: {
            code: probeRes.code ?? 'PROBE_FAILED',
            message: probeRes.reason ?? 'Media probe rejected downloaded content in isolated sandbox',
          },
        };
      }

      // 9. Successfully verified! Promote to ready storage
      this.quarantineStore.promoteToReady(tenantId, assetId, 1, filename);

      return {
        success: true,
        assetId,
        filename,
        mimeType: inferredMime,
        bytes: downloadedData.byteLength,
        sha256: computedSha256,
        sanitizedSourceUrl,
        sanitizedRights,
        probeMetadata: probeRes.metadata,
      };
    }
  }

  /**
   * Connects to a target host pinning the pre-approved IP address to defeat DNS rebinding,
   * while keeping TLS SNI and certificate verification bound to the target hostname.
   */
  private performPinnedFetch(options: {
    targetUrl: URL;
    pinnedIp: string;
    remainingTimeMs: number;
  }): Promise<{
    ok: boolean;
    statusCode?: number;
    contentType?: string;
    isRedirect: boolean;
    redirectLocation?: string;
    data?: Buffer;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const { targetUrl, pinnedIp, remainingTimeMs } = options;

    return new Promise((resolve) => {
      let isResolved = false;
      const safeResolve = (val: {
        ok: boolean;
        statusCode?: number;
        contentType?: string;
        isRedirect: boolean;
        redirectLocation?: string;
        data?: Buffer;
        errorCode?: string;
        errorMessage?: string;
      }) => {
        if (!isResolved) {
          isResolved = true;
          resolve(val);
        }
      };

      // Custom Agent pinning lookup to the approved IP address
      const customAgent = new https.Agent({
        lookup: (_host, lookupOpts, callback) => {
          const family = net.isIPv6(pinnedIp) ? 6 : 4;
          const cb = typeof lookupOpts === 'function' ? lookupOpts : callback;
          if (lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all) {
            return cb(null, [{ address: pinnedIp, family }] as unknown as any);
          }
          return cb(null, pinnedIp, family);
        },
        keepAlive: false,
        timeout: Math.min(this.connectTimeoutMs, remainingTimeMs),
        rejectUnauthorized: !this.allowInsecureTlsForTesting,
        ca: this.caCert,
      });

      const reqOptions: https.RequestOptions = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: 'GET',
        headers: {
          Host: targetUrl.host,
          'User-Agent': 'CreativantaVideoEngine/1.0 (AssetIngest; SSRF-Defended)',
          Accept: '*/*',
        },
        agent: customAgent,
        servername: targetUrl.hostname, // Preserves TLS certificate CN/SAN verification against target hostname
        timeout: Math.min(this.connectTimeoutMs, remainingTimeMs),
      };

      const req = https.request(reqOptions, (res) => {
        const statusCode = res.statusCode ?? 500;

        // Check for redirects
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          const location = res.headers.location;
          res.resume(); // drain response
          safeResolve({
            ok: false,
            statusCode,
            isRedirect: true,
            redirectLocation: location,
          });
          return;
        }

        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          safeResolve({
            ok: false,
            statusCode,
            isRedirect: false,
            errorCode: 'REMOTE_SERVER_ERROR',
            errorMessage: `Remote origin returned HTTP status ${statusCode}`,
          });
          return;
        }

        // Check Content-Length header if present
        const clHeader = res.headers['content-length'];
        if (clHeader) {
          const cl = Number(clHeader);
          if (!Number.isNaN(cl) && cl > this.maxStreamingBytes) {
            req.destroy();
            safeResolve({
              ok: false,
              statusCode: 413,
              isRedirect: false,
              errorCode: 'PAYLOAD_TOO_LARGE',
              errorMessage: `Content-Length (${cl} bytes) exceeds maximum streaming limit of ${this.maxStreamingBytes} bytes`,
            });
            return;
          }
        }

        const chunks: Buffer[] = [];
        let totalReceived = 0;

        res.on('data', (chunk: Buffer) => {
          totalReceived += chunk.length;
          if (totalReceived > this.maxStreamingBytes) {
            req.destroy();
            safeResolve({
              ok: false,
              statusCode: 413,
              isRedirect: false,
              errorCode: 'PAYLOAD_TOO_LARGE',
              errorMessage: `Received stream bytes (${totalReceived}) exceeded maximum limit of ${this.maxStreamingBytes} bytes`,
            });
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          const fullBuffer = Buffer.concat(chunks);
          safeResolve({
            ok: true,
            statusCode,
            contentType: res.headers['content-type'],
            isRedirect: false,
            data: fullBuffer,
          });
        });

        res.on('error', (err) => {
          safeResolve({
            ok: false,
            isRedirect: false,
            errorCode: 'STREAM_ERROR',
            errorMessage: `Error streaming response: ${err.message}`,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        safeResolve({
          ok: false,
          isRedirect: false,
          errorCode: 'CONNECT_TIMEOUT',
          errorMessage: `Connection or socket read timed out after ${this.connectTimeoutMs}ms`,
        });
      });

      req.on('error', (err) => {
        safeResolve({
          ok: false,
          isRedirect: false,
          errorCode: 'CONNECTION_ERROR',
          errorMessage: `Network error connecting to ${targetUrl.hostname}: ${err.message}`,
        });
      });

      req.end();
    });
  }
}
