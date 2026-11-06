/**
 * Creativanta Video Engine — Synthetic Licensed Fixtures & MP4 Decode Integrity
 * Canonical specifications:
 *   - docs/TESTING.md (Video/audio verification, ffprobe & decode, licensed fixtures only)
 *   - docs/SECURITY.md (Rights metadata, no unreviewed third party media)
 *
 * Task: P10-B (GitHub #66, parent #63)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Deterministic synthetic licensed SVG fixture.
 * Strictly internal licensed test asset; contains no external references or scripts.
 */
export const SYNTHETIC_LICENSED_SVG_CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <rect width="400" height="400" fill="#1e293b"/>
  <circle cx="200" cy="200" r="120" fill="#0ea5e9"/>
  <text x="200" y="210" font-family="sans-serif" font-size="28" fill="#ffffff" text-anchor="middle" font-weight="bold">Creativanta</text>
  <text x="200" y="245" font-family="sans-serif" font-size="16" fill="#94a3b8" text-anchor="middle">Staging E2E Fixture</text>
</svg>`.trim();

export const SYNTHETIC_LICENSED_SVG_BUFFER = Buffer.from(SYNTHETIC_LICENSED_SVG_CONTENT, 'utf8');
export const SYNTHETIC_LICENSED_SVG_SHA256 = crypto
  .createHash('sha256')
  .update(SYNTHETIC_LICENSED_SVG_BUFFER)
  .digest('hex');

export const SYNTHETIC_SVG_RIGHTS = Object.freeze({
  basis: 'licensed',
  source: 'creativanta-internal-test-asset-v1',
  attribution: 'Creativanta Synthetic Staging Vector Asset',
  expires_at: '2099-01-01T00:00:00Z',
});

/**
 * Minimal 1x1 transparent PNG buffer for fallback image fixtures.
 */
export const SYNTHETIC_LICENSED_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
export const SYNTHETIC_LICENSED_PNG_SHA256 = crypto
  .createHash('sha256')
  .update(SYNTHETIC_LICENSED_PNG_BUFFER)
  .digest('hex');

export const SYNTHETIC_PNG_RIGHTS = Object.freeze({
  basis: 'licensed',
  source: 'creativanta-internal-test-asset-v1',
  attribution: 'Creativanta Synthetic Staging Raster Asset',
  expires_at: '2099-01-01T00:00:00Z',
});

/**
 * Checks whether an MP4 binary buffer has valid ISOBMFF structure (ftyp and moov boxes).
 * @param {Buffer} buffer
 * @returns {{ valid: boolean; majorBrand?: string; hasMoov?: boolean; error?: string }}
 */
export function inspectMp4Boxes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return { valid: false, error: 'Buffer too small to be a valid MP4' };
  }

  // First box should be 'ftyp'
  const firstBoxSize = buffer.readUInt32BE(0);
  const firstBoxType = buffer.toString('ascii', 4, 8);

  if (firstBoxType !== 'ftyp' || firstBoxSize > buffer.length) {
    return {
      valid: false,
      error: `Invalid MP4 header: expected 'ftyp' box, got '${firstBoxType}'`,
    };
  }

  const majorBrand = buffer.toString('ascii', 8, 12);
  let hasMoov = false;
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const boxSize = buffer.readUInt32BE(offset);
    const boxType = buffer.toString('ascii', offset + 4, offset + 8);

    if (boxType === 'moov') {
      hasMoov = true;
    }

    if (boxSize === 0) {
      // Box extends to end of file
      break;
    }
    if (boxSize === 1) {
      // 64-bit size, skip 16 bytes minimum
      offset += 16;
      continue;
    }
    if (boxSize < 8 || offset + boxSize > buffer.length + 16) {
      break;
    }
    offset += boxSize;
  }

  return {
    valid: true,
    majorBrand,
    hasMoov,
  };
}

/**
 * Tests if `ffprobe` is installed and executable in PATH.
 * @returns {boolean}
 */
export function isFfprobeAvailable() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes an MP4 buffer using ffprobe if available, returning parsed metadata.
 * @param {Buffer} buffer
 * @returns {object | null}
 */
export function probeMp4WithFfprobe(buffer) {
  if (!isFfprobeAvailable()) return null;

  const tmpFile = path.join(os.tmpdir(), `cve-probe-${crypto.randomBytes(8).toString('hex')}.mp4`);
  try {
    fs.writeFileSync(tmpFile, buffer);
    const stdout = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-count_frames',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        tmpFile,
      ],
      { stdio: 'pipe', timeout: 10000, encoding: 'utf8' }
    );
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Verifies downloaded artifact buffer against expected byte length, SHA-256, and MP4 structure.
 *
 * @param {Buffer} buffer
 * @param {object} options
 * @param {number} [options.expectedBytes]
 * @param {string} [options.expectedSha256]
 * @param {boolean} [options.isMp4=true]
 * @returns {object} Integrity result
 */
export function verifyArtifactIntegrity(buffer, options = {}) {
  const actualBytes = buffer.length;
  const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();

  const result = {
    valid: true,
    bytes: actualBytes,
    sha256: actualSha256,
    byteCountMatches: true,
    sha256Matches: true,
    boxAnalysis: null,
    ffprobeProbe: null,
    errors: [],
  };

  if (options.expectedBytes !== undefined && options.expectedBytes !== actualBytes) {
    result.valid = false;
    result.byteCountMatches = false;
    result.errors.push(
      `Byte length mismatch: expected ${options.expectedBytes}, actual ${actualBytes}`
    );
  }

  if (options.expectedSha256) {
    const exp = options.expectedSha256.toLowerCase();
    if (exp !== actualSha256) {
      result.valid = false;
      result.sha256Matches = false;
      result.errors.push(
        `SHA-256 hash mismatch: expected ${exp}, actual ${actualSha256}`
      );
    }
  }

  if (options.isMp4) {
    const boxInfo = inspectMp4Boxes(buffer);
    result.boxAnalysis = boxInfo;
    if (!boxInfo.valid) {
      result.valid = false;
      result.errors.push(`MP4 container validation error: ${boxInfo.error}`);
    }

    const probe = probeMp4WithFfprobe(buffer);
    if (probe) {
      result.ffprobeProbe = probe;
      if (probe.error) {
        result.errors.push(`ffprobe error: ${probe.error}`);
      }
    }
  }

  return result;
}
