/**
 * SSRF Guard & URL Security Validator (Task P3-04).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("URL allowlists và SSRF", lines 25-33)
 *   - docs/API.md ("Asset intake", lines 35, 87-92)
 *   - docs/IMPLEMENTATION_PLAN.md (Task P3-04)
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';

export class SsrSecurityError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly pointer: string;

  constructor(
    message: string,
    code = 'SSRF_BLOCKED',
    httpStatus = 422,
    pointer = '/url',
  ) {
    super(message);
    this.name = 'SsrSecurityError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.pointer = pointer;
  }
}

/**
 * Parsed representation of an IPv4 CIDR range [baseIpInt, maskInt].
 */
interface Ipv4Cidr {
  base: number;
  mask: number;
  description: string;
}

/**
 * Parsed representation of an IPv6 prefix [16 bytes buffer, prefixLength].
 */
interface Ipv6Cidr {
  base: Uint8Array;
  prefixLength: number;
  description: string;
}

/**
 * Converts standard IPv4 dotted-decimal string to a 32-bit unsigned integer.
 */
export function ipv4ToUint32(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new SsrSecurityError(`Malformed IPv4 address: "${ip}"`, 'INVALID_IP_ADDRESS');
  }
  return (((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0);
}

function parseIpv4Cidr(cidr: string, description: string): Ipv4Cidr {
  const [ipStr, prefixStr] = cidr.split('/');
  const prefix = prefixStr !== undefined ? Number(prefixStr) : 32;
  const mask = prefix === 0 ? 0 : ((~0 << (32 - prefix)) >>> 0);
  const base = (ipv4ToUint32(ipStr!) & mask) >>> 0;
  return { base, mask, description };
}

/**
 * Parses an IPv6 string into a 16-byte Uint8Array.
 */
export function ipv6ToUint8Array(ip: string): Uint8Array {
  // Handle IPv4-mapped IPv6 embedded notation e.g. ::ffff:192.168.1.1
  let cleanIp = ip.toLowerCase();
  const lastColon = cleanIp.lastIndexOf(':');
  if (lastColon !== -1) {
    const potentialIpv4 = cleanIp.slice(lastColon + 1);
    if (net.isIPv4(potentialIpv4)) {
      const v4Parts = potentialIpv4.split('.').map(Number);
      const hexHigh = ((v4Parts[0]! << 8) | v4Parts[1]!).toString(16);
      const hexLow = ((v4Parts[2]! << 8) | v4Parts[3]!).toString(16);
      cleanIp = `${cleanIp.slice(0, lastColon)}:${hexHigh}:${hexLow}`;
    }
  }

  const bytes = new Uint8Array(16);
  const parts = cleanIp.split('::');

  if (parts.length > 2) {
    throw new SsrSecurityError(`Malformed IPv6 address: "${ip}"`, 'INVALID_IP_ADDRESS');
  }

  const headParts = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const tailParts = parts.length === 2 && parts[1] ? parts[1].split(':').filter(Boolean) : [];

  const totalSpecified = headParts.length + tailParts.length;
  if (parts.length === 1 && totalSpecified !== 8) {
    throw new SsrSecurityError(`Malformed IPv6 address: "${ip}"`, 'INVALID_IP_ADDRESS');
  }
  if (parts.length === 2 && totalSpecified > 7) {
    throw new SsrSecurityError(`Malformed IPv6 address: "${ip}"`, 'INVALID_IP_ADDRESS');
  }

  const omittedZeros = 8 - totalSpecified;
  const full16BitGroups: number[] = [];

  for (const part of headParts) {
    full16BitGroups.push(parseInt(part, 16));
  }
  for (let i = 0; i < omittedZeros; i++) {
    full16BitGroups.push(0);
  }
  for (const part of tailParts) {
    full16BitGroups.push(parseInt(part, 16));
  }

  for (let i = 0; i < 8; i++) {
    const val = full16BitGroups[i]!;
    bytes[i * 2] = (val >> 8) & 0xff;
    bytes[i * 2 + 1] = val & 0xff;
  }

  return bytes;
}

function parseIpv6Cidr(cidr: string, description: string): Ipv6Cidr {
  const [ipStr, prefixStr] = cidr.split('/');
  const prefixLength = prefixStr !== undefined ? Number(prefixStr) : 128;
  const base = ipv6ToUint8Array(ipStr!);
  return { base, prefixLength, description };
}

function matchIpv6Cidr(ipBytes: Uint8Array, cidr: Ipv6Cidr): boolean {
  let bitsLeft = cidr.prefixLength;
  for (let i = 0; i < 16; i++) {
    if (bitsLeft >= 8) {
      if (ipBytes[i] !== cidr.base[i]) return false;
      bitsLeft -= 8;
    } else if (bitsLeft > 0) {
      const mask = ((~0 << (8 - bitsLeft)) & 0xff);
      if ((ipBytes[i]! & mask) !== (cidr.base[i]! & mask)) return false;
      bitsLeft = 0;
    } else {
      break;
    }
  }
  return true;
}

/**
 * Normative IPv4 Prohibited Address Ranges per docs/SECURITY.md:
 * - Loopback (127.0.0.0/8)
 * - Link-local / Cloud metadata (169.254.0.0/16)
 * - RFC 1918 Private (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Carrier-grade NAT (100.64.0.0/10)
 * - "This" host / Current network (0.0.0.0/8)
 * - Multicast (224.0.0.0/4)
 * - Reserved (240.0.0.0/4)
 * - Broadcast (255.255.255.255/32)
 * - Documentation / Test-nets (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 198.18.0.0/15)
 * - Alibaba Cloud Metadata (100.100.100.200/32)
 */
const PROHIBITED_IPV4_RANGES: Ipv4Cidr[] = [
  parseIpv4Cidr('0.0.0.0/8', 'Current network / "this" host (RFC 1122)'),
  parseIpv4Cidr('10.0.0.0/8', 'Private-use network (RFC 1918)'),
  parseIpv4Cidr('100.64.0.0/10', 'Shared Address Space / CGNAT (RFC 6598)'),
  parseIpv4Cidr('100.100.100.200/32', 'Alibaba Cloud Metadata Server'),
  parseIpv4Cidr('127.0.0.0/8', 'Loopback address space (RFC 1122)'),
  parseIpv4Cidr('169.254.0.0/16', 'Link-local & Cloud Metadata 169.254.169.254 (RFC 3927)'),
  parseIpv4Cidr('172.16.0.0/12', 'Private-use network (RFC 1918)'),
  parseIpv4Cidr('192.0.0.0/24', 'IETF Protocol Assignments (RFC 6890)'),
  parseIpv4Cidr('192.0.2.0/24', 'TEST-NET-1 documentation (RFC 5737)'),
  parseIpv4Cidr('192.88.99.0/24', '6to4 Relay Anycast (RFC 7526)'),
  parseIpv4Cidr('192.168.0.0/16', 'Private-use network (RFC 1918)'),
  parseIpv4Cidr('198.18.0.0/15', 'Benchmarking tests (RFC 2544)'),
  parseIpv4Cidr('198.51.100.0/24', 'TEST-NET-2 documentation (RFC 5737)'),
  parseIpv4Cidr('203.0.113.0/24', 'TEST-NET-3 documentation (RFC 5737)'),
  parseIpv4Cidr('224.0.0.0/4', 'Multicast address space (RFC 5771)'),
  parseIpv4Cidr('240.0.0.0/4', 'Reserved for future use (RFC 1112)'),
  parseIpv4Cidr('255.255.255.255/32', 'Limited broadcast destination'),
];

/**
 * Normative IPv6 Prohibited Address Ranges per docs/SECURITY.md:
 * - Unspecified (::/128)
 * - Loopback (::1/128)
 * - IPv4-mapped IPv6 (::ffff:0:0/96)
 * - IPv4-translated (::ffff:0:0:0/96)
 * - IPv4/IPv6 translation (64:ff9b::/96)
 * - Discard-only (100::/64)
 * - Documentation (2001:db8::/32)
 * - 6to4 (2002::/16)
 * - Unique Local Address / ULA (fc00::/7)
 * - Link-local unicast (fe80::/10)
 * - Multicast (ff00::/8)
 * - AWS IPv6 Metadata (fd00:ec2::254/128)
 */
const PROHIBITED_IPV6_RANGES: Ipv6Cidr[] = [
  parseIpv6Cidr('::/128', 'IPv6 Unspecified address (RFC 4291)'),
  parseIpv6Cidr('::1/128', 'IPv6 Loopback address (RFC 4291)'),
  parseIpv6Cidr('::ffff:0:0/96', 'IPv4-mapped IPv6 range (RFC 4291)'),
  parseIpv6Cidr('64:ff9b::/96', 'IPv4/IPv6 translation range (RFC 6052)'),
  parseIpv6Cidr('100::/64', 'Discard-only address block (RFC 6666)'),
  parseIpv6Cidr('2001::/23', 'IETF Protocol Assignments (RFC 2928)'),
  parseIpv6Cidr('2001:db8::/32', 'IPv6 Documentation prefix (RFC 3849)'),
  parseIpv6Cidr('2002::/16', '6to4 address block (RFC 3056)'),
  parseIpv6Cidr('fc00::/7', 'Unique Local Address / ULA (RFC 4193)'),
  parseIpv6Cidr('fe80::/10', 'Link-local unicast range (RFC 4291)'),
  parseIpv6Cidr('ff00::/8', 'IPv6 Multicast range (RFC 4291)'),
  parseIpv6Cidr('fd00:ec2::254/128', 'AWS IPv6 Instance Metadata Service'),
];

/**
 * Checks whether an IP address falls into any prohibited, private, or metadata range.
 */
export function isProhibitedIp(
  ip: string,
  options?: { allowLoopbackForTesting?: boolean },
): { prohibited: boolean; reason?: string } {
  const version = net.isIP(ip);
  if (version === 4) {
    const uint32 = ipv4ToUint32(ip);
    for (const range of PROHIBITED_IPV4_RANGES) {
      if (options?.allowLoopbackForTesting && range.description.includes('Loopback')) {
        continue;
      }
      if (((uint32 & range.mask) >>> 0) === range.base) {
        return { prohibited: true, reason: range.description };
      }
    }
    return { prohibited: false };
  }

  if (version === 6) {
    const bytes = ipv6ToUint8Array(ip);

    // Check if it is an IPv4-mapped IPv6 address (::ffff:x.x.x.x)
    const isMapped =
      bytes[0] === 0 &&
      bytes[1] === 0 &&
      bytes[2] === 0 &&
      bytes[3] === 0 &&
      bytes[4] === 0 &&
      bytes[5] === 0 &&
      bytes[6] === 0 &&
      bytes[7] === 0 &&
      bytes[8] === 0 &&
      bytes[9] === 0 &&
      bytes[10] === 0xff &&
      bytes[11] === 0xff;

    if (isMapped) {
      const mappedIpv4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
      const v4Check = isProhibitedIp(mappedIpv4, options);
      return {
        prohibited: true,
        reason: `IPv4-mapped IPv6 wrapping ${v4Check.reason ?? mappedIpv4}`,
      };
    }

    for (const range of PROHIBITED_IPV6_RANGES) {
      if (options?.allowLoopbackForTesting && range.description.includes('Loopback')) {
        continue;
      }
      if (matchIpv6Cidr(bytes, range)) {
        return { prohibited: true, reason: range.description };
      }
    }
    return { prohibited: false };
  }

  return { prohibited: true, reason: 'Invalid or unparseable IP address' };
}

/**
 * Detects whether a string is an IP literal or numeric alternate encoding
 * (e.g. 127.0.0.1, [::1], 0x7f000001, 2130706433, 0177.0.0.1, 127.1).
 */
export function isIpLiteralOrNumericHost(host: string): boolean {
  const cleanHost = host.trim().toLowerCase();

  // IPv6 bracketed literal
  if (cleanHost.startsWith('[') && cleanHost.endsWith(']')) {
    return true;
  }

  // Node native IP check
  if (net.isIP(cleanHost) !== 0) {
    return true;
  }

  // Pure integer DWORD encoding (e.g. 2130706433)
  if (/^\d+$/.test(cleanHost)) {
    return true;
  }

  // Hexadecimal representation (e.g. 0x7f000001 or 0x7f.0.0.1)
  if (/^0x[0-9a-f]+$/i.test(cleanHost)) {
    return true;
  }

  // Dotted numeric / hex / octal combinations (e.g. 127.0x0.1, 0177.0.0.1, 127.1)
  const dottedParts = cleanHost.split('.');
  if (dottedParts.length >= 2 && dottedParts.length <= 4) {
    const allNumericLike = dottedParts.every((p) =>
      /^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(p),
    );
    if (allNumericLike) {
      return true;
    }
  }

  return false;
}

export interface ValidatedImportUrlResult {
  url: URL;
  cleanHostname: string;
}

/**
 * Validates and normalizes import URLs against parser differential and SSRF evasion vectors.
 * Follows strict rules from docs/SECURITY.md:
 * - Reject non-HTTPS schemes (HTTPS only)
 * - Reject ports other than 443
 * - Reject userinfo (credentials in URL)
 * - Reject fragments (#)
 * - Reject IP literals and alternate numeric encodings
 * - Reject backslashes (\)
 * - Reject control characters, NULL bytes, and double-encoding path traversal
 */
export function validateAndNormalizeImportUrl(
  rawUrl: unknown,
  options?: { allowCustomPortForTesting?: boolean },
): ValidatedImportUrlResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new SsrSecurityError('Import URL must be a non-empty string', 'INVALID_URL', 422, '/url');
  }

  const trimmed = rawUrl.trim();

  // 1. Reject backslashes anywhere in raw URL (prevents parser differential attacks)
  if (trimmed.includes('\\')) {
    throw new SsrSecurityError(
      'Backslashes are strictly prohibited in import URLs to prevent parser differential attacks',
      'INVALID_URL_SYNTAX',
      422,
      '/url',
    );
  }

  // 2. Reject control characters, newlines, and null bytes
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new SsrSecurityError(
      'Control characters and NULL bytes are strictly prohibited in import URLs',
      'INVALID_URL_SYNTAX',
      422,
      '/url',
    );
  }

  // 3. Reject fragments (#)
  if (trimmed.includes('#')) {
    throw new SsrSecurityError(
      'URL fragments (#) are strictly prohibited in remote asset imports',
      'URL_FRAGMENT_PROHIBITED',
      422,
      '/url',
    );
  }

  // 3b. Reject path traversal sequences before URL parser normalizes them away
  if (/(?:^|\/)\.\.(?:\/|$)/.test(trimmed) || /%2e%2e/i.test(trimmed)) {
    throw new SsrSecurityError(
      'Path traversal sequence (..) detected in import URL pathname',
      'PATH_TRAVERSAL_DETECTED',
      422,
      '/url',
    );
  }

  // 4. Parse with WHATWG URL parser
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SsrSecurityError('Failed to parse URL as valid WHATWG URI', 'INVALID_URL', 422, '/url');
  }

  // 5. Enforce strictly HTTPS scheme
  if (parsed.protocol !== 'https:') {
    throw new SsrSecurityError(
      `Unsupported scheme "${parsed.protocol}". Remote imports require https: scheme only`,
      'UNSUPPORTED_SCHEME',
      422,
      '/url',
    );
  }

  // 6. Enforce port 443 only (empty or '443')
  if (parsed.port !== '' && parsed.port !== '443' && !options?.allowCustomPortForTesting) {
    throw new SsrSecurityError(
      `Unsupported port "${parsed.port}". Remote imports require port 443 only`,
      'UNSUPPORTED_PORT',
      422,
      '/url',
    );
  }

  // 7. Enforce absence of userinfo / credentials
  if (parsed.username !== '' || parsed.password !== '' || trimmed.includes('@')) {
    throw new SsrSecurityError(
      'Credentials or userinfo (@) are strictly prohibited in import URLs',
      'USERINFO_PROHIBITED',
      422,
      '/url',
    );
  }

  // 8. Enforce hostname presence
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname || hostname.length === 0) {
    throw new SsrSecurityError('Import URL hostname is missing or empty', 'INVALID_HOSTNAME', 422, '/url');
  }

  // 9. Reject IP literals and numeric alternate encodings
  if (isIpLiteralOrNumericHost(hostname)) {
    throw new SsrSecurityError(
      `IP literal or numeric host representation "${hostname}" is prohibited; import targets must use approved FQDN hostnames`,
      'IP_LITERAL_PROHIBITED',
      422,
      '/url',
    );
  }

  // 10. Check for path traversal sequences
  const decodedPath = decodeURIComponent(parsed.pathname);
  const segments = decodedPath.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    throw new SsrSecurityError(
      'Path traversal sequence (..) detected in import URL pathname',
      'PATH_TRAVERSAL_DETECTED',
      422,
      '/url',
    );
  }

  return {
    url: parsed,
    cleanHostname: hostname,
  };
}

/**
 * Validates a target URL against a tenant's server-managed allowlist.
 * Matches exact host or host + path prefix with strict boundaries (no wildcard suffix).
 */
export function checkTenantImportAllowlist(
  url: URL,
  allowlist: string[],
): { allowed: boolean; matchedRule?: string } {
  if (!allowlist || allowlist.length === 0) {
    return { allowed: false };
  }

  const candidateHost = url.hostname.toLowerCase();
  const candidatePath = url.pathname;

  for (const rule of allowlist) {
    const trimmedRule = rule.trim();
    if (!trimmedRule) continue;

    if (trimmedRule.startsWith('https://')) {
      try {
        const ruleUrl = new URL(trimmedRule);
        const ruleHost = ruleUrl.hostname.toLowerCase();
        // Exact hostname comparison (prevents suffix hijacking like evil-example.com)
        if (candidateHost === ruleHost) {
          const rulePath = ruleUrl.pathname.replace(/\/+$/, '');
          if (!rulePath || rulePath === '' || candidatePath === rulePath || candidatePath.startsWith(`${rulePath}/`)) {
            return { allowed: true, matchedRule: trimmedRule };
          }
        }
      } catch {
        // Ignore unparseable rule
      }
    } else {
      // Rule is hostname or host/path prefix
      const slashIdx = trimmedRule.indexOf('/');
      const ruleHost = (slashIdx === -1 ? trimmedRule : trimmedRule.slice(0, slashIdx)).toLowerCase();
      const rulePathPrefix = slashIdx === -1 ? '' : trimmedRule.slice(slashIdx).replace(/\/+$/, '');

      if (candidateHost === ruleHost) {
        if (!rulePathPrefix || candidatePath === rulePathPrefix || candidatePath.startsWith(`${rulePathPrefix}/`)) {
          return { allowed: true, matchedRule: trimmedRule };
        }
      }
    }
  }

  return { allowed: false };
}

export type DnsLookupFunction = (
  hostname: string,
) => Promise<{ ipv4?: string[]; ipv6?: string[] }>;

/**
 * Default live DNS resolver resolving all A and AAAA records using node:dns/promises.
 */
export const defaultDnsResolver: DnsLookupFunction = async (hostname: string) => {
  const [v4Result, v6Result] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  const ipv4 = v4Result.status === 'fulfilled' ? v4Result.value : [];
  const ipv6 = v6Result.status === 'fulfilled' ? v6Result.value : [];

  return { ipv4, ipv6 };
};

export interface ResolvedDnsPinning {
  allResolvedIps: string[];
  pinnedIp: string;
}

/**
 * Resolves all DNS A and AAAA records for a hostname, audits each resolved IP
 * against the prohibited range blocklist, and selects a pinned IP address for connection.
 */
export async function resolveAndAuditHostDns(
  hostname: string,
  resolver: DnsLookupFunction = defaultDnsResolver,
  options?: { allowLoopbackForTesting?: boolean },
): Promise<ResolvedDnsPinning> {
  let lookupResult: { ipv4?: string[]; ipv6?: string[] };
  try {
    lookupResult = await resolver(hostname);
  } catch (err) {
    throw new SsrSecurityError(
      `DNS resolution failed for host "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
      'DNS_RESOLUTION_FAILED',
      422,
      '/url',
    );
  }

  const allIps = [
    ...(lookupResult.ipv4 ?? []),
    ...(lookupResult.ipv6 ?? []),
  ].filter(Boolean);

  if (allIps.length === 0) {
    throw new SsrSecurityError(
      `DNS lookup for host "${hostname}" returned zero IP addresses`,
      'DNS_NO_RECORDS',
      422,
      '/url',
    );
  }

  // Audit EVERY resolved IP address. If ANY IP is prohibited (multi-homed DNS attack),
  // reject the host immediately.
  for (const ip of allIps) {
    const audit = isProhibitedIp(ip, options);
    if (audit.prohibited) {
      throw new SsrSecurityError(
        `Host "${hostname}" resolved to prohibited IP address "${ip}" (${audit.reason})`,
        'SSRF_PROHIBITED_IP',
        422,
        '/url',
      );
    }
  }

  return {
    allResolvedIps: allIps,
    pinnedIp: allIps[0]!,
  };
}
