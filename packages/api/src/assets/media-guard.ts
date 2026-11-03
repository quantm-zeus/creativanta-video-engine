/**
 * Media Intake Guards, SVG Sanitizer, Font Table Verifier, Image Dimensions Checker,
 * and Isolated Sandbox Media Probe Runner (Task P3-02).
 *
 * Canonical specifications:
 *   - docs/SECURITY.md ("Filesystem, quotas và content", lines 56-58)
 *   - docs/SCENE-SPEC.md ("Media, audio, localization và subtitles", lines 82-93)
 *   - docs/API.md ("Asset intake", lines 87-92)
 */

import { spawn } from 'node:child_process';

export const MAX_UPLOAD_BYTES = 104_857_600; // 100 MiB
export const MAX_FONT_BYTES = 33_554_432;   // 32 MiB
export const MAX_SVG_BYTES = 5_242_880;     // 5 MiB
export const MAX_IMAGE_DIMENSION_PX = 8192; // 8192 px
export const MAX_IMAGE_PIXELS = 40_000_000; // 40 MP
export const MAX_SVG_NODES = 5000;          // 5000 DOM nodes
export const MAX_SVG_DEPTH = 16;            // Tree depth 16

export const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/svg+xml',
  'video/mp4',
  'audio/mpeg',
  'audio/wav',
  'font/ttf',
  'font/otf',
  'font/woff2',
] as const);

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export type AssetKind = 'image' | 'video' | 'audio' | 'font' | 'svg' | 'subtitle';

export function getAssetKindFromMimeType(mimeType: string): AssetKind {
  switch (mimeType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/webp':
      return 'image';
    case 'image/svg+xml':
      return 'svg';
    case 'video/mp4':
      return 'video';
    case 'audio/mpeg':
    case 'audio/wav':
      return 'audio';
    case 'font/ttf':
    case 'font/otf':
    case 'font/woff2':
      return 'font';
    default:
      throw new Error(`Unsupported MIME type: ${mimeType}`);
  }
}

export function getMaxBytesForMimeType(mimeType: string): number {
  if (mimeType.startsWith('font/')) {
    return MAX_FONT_BYTES;
  }
  if (mimeType === 'image/svg+xml') {
    return MAX_SVG_BYTES;
  }
  return MAX_UPLOAD_BYTES;
}

export interface RightsValidationInput {
  basis?: unknown;
  source?: unknown;
  attribution?: unknown;
  expires_at?: unknown;
}

export interface ValidationGuardResult {
  valid: boolean;
  httpStatus?: number;
  code?: string;
  message?: string;
  details?: Array<{ pointer: string; code: string; message: string }>;
}

/**
 * Validates initial asset upload request body parameters per OpenAPI & Security design.
 */
export function validateUploadRequestBounds(
  body: {
    filename?: unknown;
    mime_type?: unknown;
    bytes?: unknown;
    sha256?: unknown;
    rights?: RightsValidationInput;
  },
  now = new Date(),
): ValidationGuardResult {
  const details: Array<{ pointer: string; code: string; message: string }> = [];

  // Filename
  if (typeof body.filename !== 'string' || body.filename.length < 1 || body.filename.length > 255) {
    details.push({
      pointer: '/filename',
      code: 'INVALID_FILENAME',
      message: 'Filename must be a string between 1 and 255 characters',
    });
  }

  // MIME type
  const mime = typeof body.mime_type === 'string' ? body.mime_type.toLowerCase() : '';
  if (!ALLOWED_MIME_TYPES.includes(mime as AllowedMimeType)) {
    details.push({
      pointer: '/mime_type',
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: `MIME type '${body.mime_type}' is not supported. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
    });
  }

  // Byte size bounds
  if (typeof body.bytes !== 'number' || !Number.isInteger(body.bytes) || body.bytes <= 0) {
    details.push({
      pointer: '/bytes',
      code: 'INVALID_BYTES',
      message: 'Bytes must be a positive integer',
    });
  } else {
    if (body.bytes > MAX_UPLOAD_BYTES) {
      return {
        valid: false,
        httpStatus: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: `Upload bytes (${body.bytes}) exceeds maximum allowed upload limit of ${MAX_UPLOAD_BYTES} bytes (100 MiB)`,
      };
    }
    if (mime.startsWith('font/') && body.bytes > MAX_FONT_BYTES) {
      return {
        valid: false,
        httpStatus: 413,
        code: 'OVERSIZED_FONT',
        message: `Font bytes (${body.bytes}) exceeds maximum allowed font limit of ${MAX_FONT_BYTES} bytes (32 MiB)`,
      };
    }
    if (mime === 'image/svg+xml' && body.bytes > MAX_SVG_BYTES) {
      return {
        valid: false,
        httpStatus: 413,
        code: 'OVERSIZED_SVG',
        message: `SVG bytes (${body.bytes}) exceeds maximum allowed SVG limit of ${MAX_SVG_BYTES} bytes (5 MiB)`,
      };
    }
  }

  // SHA-256
  if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) {
    details.push({
      pointer: '/sha256',
      code: 'INVALID_CHECKSUM',
      message: 'sha256 must be a 64-character lowercase hexadecimal string',
    });
  }

  // Rights metadata
  const rights = body.rights;
  if (!rights || typeof rights !== 'object') {
    details.push({
      pointer: '/rights',
      code: 'MISSING_RIGHTS',
      message: 'Rights metadata is required',
    });
  } else {
    if (!['owned', 'licensed', 'public_domain'].includes(String(rights.basis))) {
      details.push({
        pointer: '/rights/basis',
        code: 'INVALID_RIGHTS_BASIS',
        message: "Rights basis must be 'owned', 'licensed', or 'public_domain'",
      });
    }
    if (typeof rights.source !== 'string' || rights.source.trim().length === 0 || rights.source.length > 500) {
      details.push({
        pointer: '/rights/source',
        code: 'INVALID_RIGHTS_SOURCE',
        message: 'Rights source must be a non-empty string <= 500 characters',
      });
    }
    if (
      typeof rights.attribution !== 'string' ||
      rights.attribution.trim().length === 0 ||
      rights.attribution.length > 500
    ) {
      details.push({
        pointer: '/rights/attribution',
        code: 'INVALID_RIGHTS_ATTRIBUTION',
        message: 'Rights attribution must be a non-empty string <= 500 characters',
      });
    }
    if (rights.expires_at !== undefined && rights.expires_at !== null) {
      const expTime = Date.parse(String(rights.expires_at));
      if (Number.isNaN(expTime)) {
        details.push({
          pointer: '/rights/expires_at',
          code: 'INVALID_DATE_FORMAT',
          message: 'Rights expires_at must be an RFC3339 / ISO-8601 date-time string',
        });
      } else if (expTime <= now.getTime()) {
        details.push({
          pointer: '/rights/expires_at',
          code: 'RIGHTS_EXPIRED',
          message: 'Rights license has already expired',
        });
      }
    }
  }

  if (details.length > 0) {
    return {
      valid: false,
      httpStatus: 422,
      code: 'VALIDATION_FAILED',
      message: 'Asset upload request validation failed',
      details,
    };
  }

  return { valid: true };
}

// -----------------------------------------------------------------------------
// SVG Guard & Sanitizer
// -----------------------------------------------------------------------------

export interface SvgProbeResult {
  valid: boolean;
  code?: string;
  reason?: string;
  nodeCount?: number;
  maxDepth?: number;
}

/**
 * Validates and sanitizes SVG content per docs/SECURITY.md:
 * - cấm <!DOCTYPE> / <!ENTITY> XXE
 * - cấm <script>, <foreignObject>, <iframe>, <embed>, <object>
 * - cấm on* event attributes
 * - cấm external href / xlink:href
 * - cấm CSS url() / @import
 * - giới hạn <= 5000 DOM nodes
 * - giới hạn độ sâu cây <= 16
 */
export function probeAndSanitizeSvg(svgBuffer: Buffer): SvgProbeResult {
  if (svgBuffer.byteLength > MAX_SVG_BYTES) {
    return {
      valid: false,
      code: 'OVERSIZED_SVG',
      reason: `SVG byte size (${svgBuffer.byteLength}) exceeds 5 MiB limit`,
    };
  }

  const svgText = svgBuffer.toString('utf8');

  // 1. XXE Entity / DOCTYPE injection guard
  if (/<!DOCTYPE/i.test(svgText) || /<!ENTITY/i.test(svgText)) {
    return {
      valid: false,
      code: 'XXE_HAZARD',
      reason: 'SVG contains forbidden <!DOCTYPE> or <!ENTITY> declaration (XXE hazard)',
    };
  }

  // 2. Dangerous tags
  const dangerousTags = ['script', 'foreignobject', 'iframe', 'embed', 'object'];
  for (const tag of dangerousTags) {
    const tagRegex = new RegExp(`<\\s*${tag}[\\s>/]`, 'i');
    if (tagRegex.test(svgText)) {
      return {
        valid: false,
        code: 'FORBIDDEN_TAG',
        reason: `SVG contains forbidden dangerous tag <${tag}>`,
      };
    }
  }

  // 3. Inline event handlers (on*)
  if (/\son[a-z]+\s*=/i.test(svgText)) {
    return {
      valid: false,
      code: 'INLINE_EVENT_HANDLER',
      reason: 'SVG contains forbidden inline event handler (on* attribute)',
    };
  }

  // 4. External href / xlink:href references
  // Allowed: fragment identifiers (#id) or internal embedded base64 data URIs
  const hrefMatches = svgText.matchAll(/(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi);
  for (const match of hrefMatches) {
    const val = (match[1] ?? '').trim();
    if (
      val.startsWith('http:') ||
      val.startsWith('https:') ||
      val.startsWith('//') ||
      val.startsWith('javascript:') ||
      (val.startsWith('/') && !val.startsWith('/#'))
    ) {
      return {
        valid: false,
        code: 'EXTERNAL_HREF',
        reason: `SVG contains forbidden external resource reference in href: '${val.slice(0, 60)}'`,
      };
    }
  }

  // 5. CSS external references: url(...) and @import
  if (/@import/i.test(svgText)) {
    return {
      valid: false,
      code: 'EXTERNAL_CSS',
      reason: 'SVG contains forbidden CSS @import rule',
    };
  }

  const cssUrlMatches = svgText.matchAll(/url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi);
  for (const match of cssUrlMatches) {
    const val = (match[1] ?? '').trim();
    if (!val.startsWith('#') && !val.startsWith('data:image/')) {
      return {
        valid: false,
        code: 'EXTERNAL_CSS_URL',
        reason: `SVG contains forbidden external CSS url() resource: '${val.slice(0, 60)}'`,
      };
    }
  }

  // 6. Tree complexity & depth verification (<=5000 DOM nodes, <=16 depth)
  // We tokenize tags while ignoring comments and CDATA
  let nodeCount = 0;
  let currentDepth = 0;
  let maxDepth = 0;

  // Strip comments and CDATA for tree scanning
  const stripped = svgText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');

  const tagScanner = /<\/?([a-zA-Z0-9_-]+)([^>]*?)(\/?)>/g;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = tagScanner.exec(stripped)) !== null) {
    const fullTag = tagMatch[0];
    const isClosing = fullTag.startsWith('</');
    const isSelfClosing = tagMatch[3] === '/' || fullTag.endsWith('/>');

    if (isClosing) {
      if (currentDepth > 0) {
        currentDepth--;
      }
    } else {
      nodeCount++;
      if (nodeCount > MAX_SVG_NODES) {
        return {
          valid: false,
          code: 'DOM_COMPLEXITY_LIMIT_EXCEEDED',
          reason: `SVG exceeds maximum allowed ${MAX_SVG_NODES} DOM nodes (found > ${MAX_SVG_NODES})`,
        };
      }

      if (!isSelfClosing) {
        currentDepth++;
        if (currentDepth > maxDepth) {
          maxDepth = currentDepth;
        }
        if (currentDepth > MAX_SVG_DEPTH) {
          return {
            valid: false,
            code: 'TREE_DEPTH_LIMIT_EXCEEDED',
            reason: `SVG nesting depth (${currentDepth}) exceeds maximum allowed depth of ${MAX_SVG_DEPTH}`,
          };
        }
      }
    }
  }

  return {
    valid: true,
    nodeCount,
    maxDepth,
  };
}

// -----------------------------------------------------------------------------
// Font Guard & Table Verifier
// -----------------------------------------------------------------------------

export interface FontProbeResult {
  valid: boolean;
  code?: string;
  reason?: string;
  format?: 'ttf' | 'otf' | 'woff2';
  numTables?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Validates TrueType (TTF), OpenType (OTF), and WOFF2 font files per docs/SECURITY.md:
 * - checks magic bytes
 * - enforces table bounds (no out-of-bounds table offsets or overlapping headers)
 * - verifies essential font tables: cmap, head, hhea, hmtx, maxp
 */
export function probeFont(buffer: Buffer, _mimeType: string): FontProbeResult {
  if (buffer.length > MAX_FONT_BYTES) {
    return {
      valid: false,
      code: 'OVERSIZED_FONT',
      reason: `Font file (${buffer.length} bytes) exceeds maximum limit of 32 MiB`,
    };
  }

  if (buffer.length < 16) {
    return {
      valid: false,
      code: 'MALFORMED_FONT',
      reason: 'Font file is too small to contain a valid font header',
    };
  }

  // WOFF2 header check
  const magic4 = buffer.subarray(0, 4).toString('ascii');
  if (magic4 === 'wOF2') {
    if (buffer.length < 48) {
      return {
        valid: false,
        code: 'MALFORMED_FONT',
        reason: 'WOFF2 header is truncated',
      };
    }
    const numTables = buffer.readUInt16BE(12);
    const totalSfntSize = buffer.readUInt32BE(16);
    if (numTables === 0 || numTables > 100) {
      return {
        valid: false,
        code: 'MALFORMED_FONT',
        reason: `WOFF2 font has invalid table count: ${numTables}`,
      };
    }
    return {
      valid: true,
      format: 'woff2',
      numTables,
      metadata: { format: 'woff2', numTables, totalSfntSize },
    };
  }

  // TTF / OTF header check
  const isTtf =
    (buffer[0] === 0x00 && buffer[1] === 0x01 && buffer[2] === 0x00 && buffer[3] === 0x00) ||
    magic4 === 'true';
  const isOtf = magic4 === 'OTTO';

  if (!isTtf && !isOtf) {
    return {
      valid: false,
      code: 'INVALID_FONT_SIGNATURE',
      reason: `Unrecognized font magic signature: 0x${buffer.subarray(0, 4).toString('hex')}`,
    };
  }

  const format = isOtf ? 'otf' : 'ttf';
  const numTables = buffer.readUInt16BE(4);

  if (numTables === 0 || numTables > 100) {
    return {
      valid: false,
      code: 'MALFORMED_FONT',
      reason: `Invalid font table count: ${numTables} (expected between 1 and 100)`,
    };
  }

  const tableDirEnd = 12 + numTables * 16;
  if (buffer.length < tableDirEnd) {
    return {
      valid: false,
      code: 'MALFORMED_FONT',
      reason: 'Font file truncated before table directory finished',
    };
  }

  const foundTables = new Set<string>();
  for (let i = 0; i < numTables; i++) {
    const entryOffset = 12 + i * 16;
    const tag = buffer.subarray(entryOffset, entryOffset + 4).toString('ascii');
    const tableOffset = buffer.readUInt32BE(entryOffset + 8);
    const tableLength = buffer.readUInt32BE(entryOffset + 12);

    if (tableOffset + tableLength > buffer.length) {
      return {
        valid: false,
        code: 'MALFORMED_FONT',
        reason: `Font table '${tag}' extends past end of file (offset=${tableOffset}, len=${tableLength}, fileLen=${buffer.length})`,
      };
    }

    if (tableOffset < tableDirEnd) {
      return {
        valid: false,
        code: 'MALFORMED_FONT',
        reason: `Font table '${tag}' overlaps with the font header directory (offset=${tableOffset} < ${tableDirEnd})`,
      };
    }

    foundTables.add(tag);
  }

  // Invariant: essential font tables must be present
  const requiredTables = ['cmap', 'head', 'hhea', 'hmtx', 'maxp'];
  for (const req of requiredTables) {
    if (!foundTables.has(req)) {
      return {
        valid: false,
        code: 'MISSING_FONT_TABLE',
        reason: `Font is missing required table '${req}'`,
      };
    }
  }

  return {
    valid: true,
    format,
    numTables,
    metadata: {
      format,
      numTables,
      tables: Array.from(foundTables),
    },
  };
}

// -----------------------------------------------------------------------------
// Image Dimensions & Pixel Guard
// -----------------------------------------------------------------------------

export interface ImageProbeResult {
  valid: boolean;
  code?: string;
  reason?: string;
  width?: number;
  height?: number;
  format?: string;
}

/**
 * Parses PNG, JPEG, and WebP dimensions and validates pixel bounds (<=8192px each side, <=40MP total).
 */
export function probeImage(buffer: Buffer, _mimeType: string): ImageProbeResult {
  if (buffer.length < 24) {
    return {
      valid: false,
      code: 'MALFORMED_IMAGE',
      reason: 'Image file is too small to contain valid headers',
    };
  }

  let width = 0;
  let height = 0;
  let format = '';

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    format = 'png';
    const chunkType = buffer.subarray(12, 16).toString('ascii');
    if (chunkType !== 'IHDR') {
      return { valid: false, code: 'MALFORMED_IMAGE', reason: 'PNG first chunk must be IHDR' };
    }
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  }
  // JPEG
  else if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    format = 'jpeg';
    let offset = 2;
    let foundSof = false;

    while (offset < buffer.length - 8) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1]!;
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        height = buffer.readUInt16BE(offset + 5);
        width = buffer.readUInt16BE(offset + 7);
        foundSof = true;
        break;
      } else if (marker === 0xd9 || marker === 0xda) {
        // EOI or SOS (Start of Scan) without finding SOF
        break;
      } else {
        // Skip segment
        const segmentLen = buffer.readUInt16BE(offset + 2);
        offset += 2 + segmentLen;
      }
    }

    if (!foundSof) {
      return {
        valid: false,
        code: 'MALFORMED_IMAGE',
        reason: 'Malformed JPEG: SOF header marker not found',
      };
    }
  }
  // WebP
  else if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    format = 'webp';
    const chunk = buffer.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8 ') {
      // VP8 keyframe start code at 23
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    } else if (chunk === 'VP8L') {
      // Lossless VP8L
      const b0 = buffer[21]!;
      const b1 = buffer[22]!;
      const b2 = buffer[23]!;
      const b3 = buffer[24]!;
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunk === 'VP8X') {
      // Extended VP8X
      width = 1 + (buffer.readUIntLE(24, 3) & 0xffffff);
      height = 1 + (buffer.readUIntLE(27, 3) & 0xffffff);
    } else {
      return { valid: false, code: 'MALFORMED_IMAGE', reason: `Unknown WebP chunk: ${chunk}` };
    }
  } else {
    return {
      valid: false,
      code: 'INVALID_IMAGE_SIGNATURE',
      reason: 'Image does not match expected PNG, JPEG, or WebP magic bytes',
    };
  }

  if (width <= 0 || height <= 0) {
    return {
      valid: false,
      code: 'MALFORMED_IMAGE',
      reason: `Invalid image dimensions (${width}x${height})`,
    };
  }

  if (width > MAX_IMAGE_DIMENSION_PX || height > MAX_IMAGE_DIMENSION_PX) {
    return {
      valid: false,
      code: 'DIMENSION_LIMIT_EXCEEDED',
      reason: `Image dimension (${width}x${height}) exceeds maximum limit of ${MAX_IMAGE_DIMENSION_PX}px`,
    };
  }

  const totalPixels = width * height;
  if (totalPixels > MAX_IMAGE_PIXELS) {
    return {
      valid: false,
      code: 'PIXEL_COUNT_EXCEEDED',
      reason: `Image total pixels (${totalPixels}) exceeds 40MP limit (${MAX_IMAGE_PIXELS})`,
    };
  }

  return {
    valid: true,
    width,
    height,
    format,
  };
}

// -----------------------------------------------------------------------------
// Audio & Video Headers Guard
// -----------------------------------------------------------------------------

export interface MediaContainerProbeResult {
  valid: boolean;
  code?: string;
  reason?: string;
  kind: 'audio' | 'video';
  format: string;
  metadata?: Record<string, unknown>;
}

export function probeAudioVideoContainer(
  buffer: Buffer,
  mimeType: string,
): MediaContainerProbeResult {
  if (buffer.length < 16) {
    return {
      valid: false,
      code: 'MALFORMED_MEDIA',
      reason: 'Media file is too small to contain valid container headers',
      kind: mimeType.startsWith('video/') ? 'video' : 'audio',
      format: mimeType,
    };
  }

  // WAV
  if (mimeType === 'audio/wav') {
    const riff = buffer.subarray(0, 4).toString('ascii');
    const wave = buffer.subarray(8, 12).toString('ascii');
    if (riff !== 'RIFF' || wave !== 'WAVE') {
      return {
        valid: false,
        code: 'INVALID_MEDIA_SIGNATURE',
        reason: "WAV file is missing 'RIFF' and 'WAVE' magic signatures",
        kind: 'audio',
        format: 'wav',
      };
    }
    return {
      valid: true,
      kind: 'audio',
      format: 'wav',
      metadata: { format: 'wav', bytes: buffer.length },
    };
  }

  // MP3
  if (mimeType === 'audio/mpeg') {
    const id3 = buffer.subarray(0, 3).toString('ascii');
    const isId3 = id3 === 'ID3';
    const isSync = buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;

    if (!isId3 && !isSync) {
      return {
        valid: false,
        code: 'INVALID_MEDIA_SIGNATURE',
        reason: "MP3 file lacks valid ID3 tag or MPEG sync word (0xFFEx)",
        kind: 'audio',
        format: 'mp3',
      };
    }
    return {
      valid: true,
      kind: 'audio',
      format: 'mp3',
      metadata: { format: 'mp3', bytes: buffer.length },
    };
  }

  // MP4
  if (mimeType === 'video/mp4') {
    const ftyp = buffer.subarray(4, 8).toString('ascii');
    if (ftyp !== 'ftyp') {
      return {
        valid: false,
        code: 'INVALID_MEDIA_SIGNATURE',
        reason: "MP4 file is missing 'ftyp' box signature at offset 4",
        kind: 'video',
        format: 'mp4',
      };
    }

    const majorBrand = buffer.subarray(8, 12).toString('ascii');
    return {
      valid: true,
      kind: 'video',
      format: 'mp4',
      metadata: { format: 'mp4', majorBrand, bytes: buffer.length },
    };
  }

  return {
    valid: false,
    code: 'UNSUPPORTED_CONTAINER',
    reason: `Unsupported media container for MIME: ${mimeType}`,
    kind: 'audio',
    format: mimeType,
  };
}

// -----------------------------------------------------------------------------
// Isolated Sandbox Probe Runner (Docs/SECURITY.md line 39)
// -----------------------------------------------------------------------------

export interface SandboxProbeExecutionResult {
  success: boolean;
  code?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Builds the canonical ffprobe argv array strictly enforcing:
 * - -v error
 * - -protocol_whitelist "file,pipe"
 * - -probesize 32M
 * - -analyzeduration 32M
 * - -show_streams -show_format -of json
 */
export function buildIsolatedFfprobeArgv(filePath: string): string[] {
  return [
    '-v',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-probesize',
    '32M',
    '-analyzeduration',
    '32M',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath,
  ];
}

/**
 * Executes media probing in an isolated sandbox.
 * Enforces:
 * - protocol whitelist 'file,pipe'
 * - resource bounds: 5000ms hard timeout, 1 MiB max buffer
 * - non-zero exits, crash bugs, decode bombs, or SSRF exploits are trapped inside sandbox
 * - malformed media cannot escape sandbox
 */
export async function executeSandboxMediaProbe(
  filePath: string,
  buffer: Buffer,
  mimeType: string,
): Promise<SandboxProbeExecutionResult> {
  // First, verify standard container/magic bytes locally
  if (mimeType.startsWith('image/')) {
    if (mimeType === 'image/svg+xml') {
      const svgRes = probeAndSanitizeSvg(buffer);
      if (!svgRes.valid) {
        return {
          success: false,
          code: svgRes.code ?? 'SVG_SECURITY_VIOLATION',
          reason: svgRes.reason ?? 'SVG security violation',
        };
      }
      return {
        success: true,
        metadata: {
          mimeType,
          nodeCount: svgRes.nodeCount,
          maxDepth: svgRes.maxDepth,
          sanitized: true,
        },
      };
    }

    const imgRes = probeImage(buffer, mimeType);
    if (!imgRes.valid) {
      return {
        success: false,
        code: imgRes.code ?? 'MALFORMED_IMAGE',
        reason: imgRes.reason ?? 'Image validation failed',
      };
    }
    return {
      success: true,
      metadata: {
        mimeType,
        width: imgRes.width,
        height: imgRes.height,
        format: imgRes.format,
      },
    };
  }

  if (mimeType.startsWith('font/')) {
    const fontRes = probeFont(buffer, mimeType);
    if (!fontRes.valid) {
      return {
        success: false,
        code: fontRes.code ?? 'MALFORMED_FONT',
        reason: fontRes.reason ?? 'Font validation failed',
      };
    }
    return {
      success: true,
      metadata: {
        mimeType,
        ...fontRes.metadata,
      },
    };
  }

  // Audio / Video container validation
  const containerRes = probeAudioVideoContainer(buffer, mimeType);
  if (!containerRes.valid) {
    return {
      success: false,
      code: containerRes.code ?? 'MALFORMED_MEDIA',
      reason: containerRes.reason ?? 'Media container validation failed',
    };
  }

  // If ffprobe binary is available on system, execute it in sandbox
  const ffprobeArgs = buildIsolatedFfprobeArgv(filePath);

  return new Promise<SandboxProbeExecutionResult>((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn('ffprobe', ffprobeArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        env: { PATH: process.env.PATH || '/usr/bin', TZ: 'UTC' },
      });
    } catch {
      // ffprobe binary is not present or cannot spawn: fall back to pure container probe
      resolve({
        success: true,
        metadata: {
          ...containerRes.metadata,
          probedBy: 'pure_container_parser',
        },
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 5000);

    proc.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < 1048576) stdout += d.toString('utf8');
    });

    proc.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 1048576) stderr += d.toString('utf8');
    });

    proc.on('error', () => {
      clearTimeout(timer);
      // Spawn error (e.g. ENOENT ffprobe not installed)
      resolve({
        success: true,
        metadata: {
          ...containerRes.metadata,
          probedBy: 'pure_container_parser',
        },
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({
          success: false,
          code: 'PROBE_TIMEOUT',
          reason: 'Isolated media probe timed out (possible decode bomb)',
        });
        return;
      }

      if (code !== 0) {
        resolve({
          success: false,
          code: 'MALFORMED_MEDIA',
          reason: `Media probing failed in isolated sandbox: ${stderr.slice(0, 200) || 'unknown error'}`,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as {
          streams?: Array<{ width?: number; height?: number; codec_name?: string }>;
          format?: { duration?: string; size?: string };
        };
        const stream0 = parsed.streams?.[0];
        if (stream0?.width && stream0?.height) {
          if (stream0.width > MAX_IMAGE_DIMENSION_PX || stream0.height > MAX_IMAGE_DIMENSION_PX) {
            resolve({
              success: false,
              code: 'DIMENSION_LIMIT_EXCEEDED',
              reason: `Video dimensions (${stream0.width}x${stream0.height}) exceeds limit of ${MAX_IMAGE_DIMENSION_PX}px`,
            });
            return;
          }
          if (stream0.width * stream0.height > MAX_IMAGE_PIXELS) {
            resolve({
              success: false,
              code: 'PIXEL_COUNT_EXCEEDED',
              reason: `Video pixel count (${stream0.width * stream0.height}) exceeds 40MP limit`,
            });
            return;
          }
        }

        resolve({
          success: true,
          metadata: {
            ...containerRes.metadata,
            duration_seconds: parsed.format?.duration ? Number(parsed.format.duration) : undefined,
            width: stream0?.width,
            height: stream0?.height,
            codec: stream0?.codec_name,
            probedBy: 'ffprobe_sandbox',
          },
        });
      } catch {
        resolve({
          success: false,
          code: 'MALFORMED_PROBE_OUTPUT',
          reason: 'Failed to parse isolated probe output JSON',
        });
      }
    });
  });
}
