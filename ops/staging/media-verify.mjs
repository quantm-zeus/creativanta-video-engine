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

const SUPPORTED_ISOBMFF_VIDEO_CODECS = new Set([
  'avc1',
  'avc3',
  'h264',
  'hev1',
  'hvc1',
  'vp09',
  'av01',
  'mp4v',
]);

const SUPPORTED_FFPROBE_VIDEO_CODECS = new Set([
  'h264',
  'hevc',
  'vp9',
  'av1',
  'mpeg4',
]);

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
 * Helper to wrap an ISOBMFF box type and payload.
 * @param {string} type 4-char ASCII type
 * @param {Buffer | Buffer[]} payload
 * @returns {Buffer}
 */
function makeMp4Box(type, payload) {
  const body = Array.isArray(payload) ? Buffer.concat(payload) : payload;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 4, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Builds a structurally complete ISOBMFF MP4 buffer containing:
 *   - `ftyp` (majorBrand: isom, compatible: isom, iso2, avc1, mp41)
 *   - `moov` -> `mvhd` (positive timescale & duration)
 *   - `moov` -> `trak` -> `tkhd` + `mdia` -> `mdhd` + `hdlr` ('vide') + `minf` -> `stbl` -> `stsd` ('avc1') + `stts` + `stsz`
 *   - `mdat` (non-empty video sample payload)
 *
 * @param {object} [options]
 * @param {number} [options.width=720]
 * @param {number} [options.height=1280]
 * @param {number} [options.sampleCount=90]
 * @param {number} [options.timescale=30]
 * @param {number} [options.durationTicks=90]
 * @param {string} [options.codec='avc1']
 * @returns {Buffer}
 */
export function createValidTestMp4Buffer(options = {}) {
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const sampleCount = options.sampleCount ?? 90;
  const timescale = options.timescale ?? 30;
  const durationTicks = options.durationTicks ?? 90;
  const codec = options.codec ?? 'avc1';

  // 1. ftyp box
  const ftypBody = Buffer.alloc(20);
  ftypBody.write('isom', 0, 4, 'ascii');
  ftypBody.writeUInt32BE(512, 4);
  ftypBody.write('isom', 8, 4, 'ascii');
  ftypBody.write('iso2', 12, 4, 'ascii');
  ftypBody.write('avc1', 16, 4, 'ascii');
  const ftypBox = makeMp4Box('ftyp', ftypBody);

  // 2. mvhd box (version 0: 100 bytes payload)
  const mvhdBody = Buffer.alloc(100);
  mvhdBody.writeUInt32BE(0, 0); // version 0 + flags
  mvhdBody.writeUInt32BE(timescale, 12);
  mvhdBody.writeUInt32BE(durationTicks, 16);
  mvhdBody.writeUInt32BE(0x00010000, 20); // rate 1.0
  mvhdBody.writeUInt16BE(0x0100, 24); // volume 1.0
  mvhdBody.writeUInt32BE(2, 96); // next_track_ID
  const mvhdBox = makeMp4Box('mvhd', mvhdBody);

  // 3. tkhd box (version 0: 84 bytes payload)
  const tkhdBody = Buffer.alloc(84);
  tkhdBody.writeUInt32BE(0x00000003, 0); // version 0, track_enabled | track_in_movie
  tkhdBody.writeUInt32BE(1, 12); // track_ID = 1
  tkhdBody.writeUInt32BE(durationTicks, 20);
  tkhdBody.writeUInt32BE(width << 16, 76); // 16.16 fixed-point width
  tkhdBody.writeUInt32BE(height << 16, 80); // 16.16 fixed-point height
  const tkhdBox = makeMp4Box('tkhd', tkhdBody);

  // 4. mdhd box (version 0: 24 bytes payload)
  const mdhdBody = Buffer.alloc(24);
  mdhdBody.writeUInt32BE(0, 0); // version 0
  mdhdBody.writeUInt32BE(timescale, 12);
  mdhdBody.writeUInt32BE(durationTicks, 16);
  const mdhdBox = makeMp4Box('mdhd', mdhdBody);

  // 5. hdlr box (version 0: 4v/f + 4 pre_defined + 4 handler_type + 12 reserved + name)
  const hdlrBody = Buffer.alloc(37);
  hdlrBody.writeUInt32BE(0, 0);
  hdlrBody.writeUInt32BE(0, 4);
  hdlrBody.write('vide', 8, 4, 'ascii');
  hdlrBody.write('VideoHandler\0', 24, 13, 'ascii');
  const hdlrBox = makeMp4Box('hdlr', hdlrBody);

  // 6. stsd box (version 0: 4 v/f + 4 entry_count + VisualSampleEntry)
  // VisualSampleEntry is 86 bytes total (8 header + 78 payload: width at payload+24 (entry+32), height at payload+26 (entry+34))
  const visualEntryPayload = Buffer.alloc(78);
  visualEntryPayload.writeUInt16BE(1, 6); // data_reference_index = 1
  visualEntryPayload.writeUInt16BE(width, 24);
  visualEntryPayload.writeUInt16BE(height, 26);
  visualEntryPayload.writeUInt32BE(0x00480000, 28); // horizresolution 72 dpi
  visualEntryPayload.writeUInt32BE(0x00480000, 32); // vertresolution 72 dpi
  visualEntryPayload.writeUInt16BE(1, 40); // frame_count = 1
  visualEntryPayload.writeUInt16BE(0x0018, 74); // depth = 24
  visualEntryPayload.writeInt16BE(-1, 76); // pre_defined = -1
  const visualEntryBox = makeMp4Box(codec, visualEntryPayload);

  const stsdHeader = Buffer.alloc(8);
  stsdHeader.writeUInt32BE(0, 0); // version 0
  stsdHeader.writeUInt32BE(1, 4); // entry_count = 1
  const stsdBox = makeMp4Box('stsd', [stsdHeader, visualEntryBox]);

  // 7. stts box (version 0: 4 v/f + 4 entry_count + 4 sample_count + 4 sample_delta)
  const sttsBody = Buffer.alloc(16);
  sttsBody.writeUInt32BE(0, 0);
  sttsBody.writeUInt32BE(1, 4);
  sttsBody.writeUInt32BE(sampleCount, 8);
  sttsBody.writeUInt32BE(1, 12);
  const sttsBox = makeMp4Box('stts', sttsBody);

  // 8. stsz box (version 0: 4 v/f + 4 sample_size + 4 sample_count)
  const stszBody = Buffer.alloc(12);
  stszBody.writeUInt32BE(0, 0);
  stszBody.writeUInt32BE(32, 4); // constant sample size = 32 bytes
  stszBody.writeUInt32BE(sampleCount, 8);
  const stszBox = makeMp4Box('stsz', stszBody);

  const stblBox = makeMp4Box('stbl', [stsdBox, sttsBox, stszBox]);
  const minfBox = makeMp4Box('minf', [stblBox]);
  const mdiaBox = makeMp4Box('mdia', [mdhdBox, hdlrBox, minfBox]);
  const trakBox = makeMp4Box('trak', [tkhdBox, mdiaBox]);
  const moovBox = makeMp4Box('moov', [mvhdBox, trakBox]);

  // 9. mdat box with non-empty encoded payload
  const mdatPayload = Buffer.alloc(Math.max(sampleCount, 1) * 4, 0x65);
  const mdatBox = makeMp4Box('mdat', mdatPayload);

  return Buffer.concat([ftypBox, moovBox, mdatBox]);
}

/**
 * Creates a deterministic valid ffprobe output object for unit tests where the host
 * container does not have the `ffprobe` binary installed.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createValidFfprobeResult(options = {}) {
  const width = options.width ?? 720;
  const height = options.height ?? 1280;
  const frames = options.nbReadFrames ?? 90;
  const duration = String(options.duration ?? '3.000000');
  const codecName = options.codecName ?? 'h264';

  return {
    available: true,
    exitCode: 0,
    streams: [
      {
        index: 0,
        codec_type: 'video',
        codec_name: codecName,
        width,
        height,
        nb_read_frames: String(frames),
        nb_frames: String(frames),
        duration,
      },
    ],
    format: {
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      duration,
      size: String(options.bytes ?? 1024),
    },
  };
}

/**
 * Parses child boxes inside a range [start, end) of an ISOBMFF buffer.
 * Returns null with an error if any box is truncated or malformed.
 *
 * @param {Buffer} buffer
 * @param {number} start
 * @param {number} end
 * @returns {{ valid: boolean; boxes?: Array<{ type: string; headerSize: number; payloadStart: number; boxEnd: number }>; error?: string }}
 */
function parseBoxList(buffer, start, end) {
  const boxes = [];
  let offset = start;

  while (offset < end) {
    if (offset + 8 > end) {
      return {
        valid: false,
        error: `Truncated ISOBMFF box header at offset ${offset} (remaining ${end - offset} bytes)`,
      };
    }

    const size32 = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let actualSize = size32;
    let headerSize = 8;

    if (size32 === 1) {
      if (offset + 16 > end) {
        return {
          valid: false,
          error: `Truncated 64-bit ISOBMFF box '${type}' at offset ${offset}`,
        };
      }
      const bigSize = buffer.readBigUInt64BE(offset + 8);
      if (bigSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        return {
          valid: false,
          error: `Oversized 64-bit ISOBMFF box '${type}'`,
        };
      }
      actualSize = Number(bigSize);
      headerSize = 16;
    } else if (size32 === 0) {
      actualSize = end - offset;
    }

    if (actualSize < headerSize || offset + actualSize > end) {
      return {
        valid: false,
        error: `Malformed or truncated ISOBMFF box '${type}' at offset ${offset}: declared size ${actualSize} exceeds available boundary ${end - offset}`,
      };
    }

    boxes.push({
      type,
      headerSize,
      payloadStart: offset + headerSize,
      boxEnd: offset + actualSize,
    });

    offset += actualSize;
  }

  return { valid: true, boxes };
}

/**
 * Checks whether an MP4 binary buffer has valid ISOBMFF structure, including:
 *   - Valid `ftyp` header box
 *   - Complete `moov` metadata box with positive duration (`mvhd` / `mdhd`)
 *   - At least one video track (`trak` -> `mdia` -> `hdlr` with `vide`)
 *   - Valid video codec in `stsd` (`avc1`, `h264`, `hev1`, etc.) with positive dimensions
 *   - Non-zero frame/sample count in `stsz` or `stts`
 *   - Non-empty `mdat` media payload box
 *
 * @param {Buffer} buffer
 * @returns {object}
 */
export function inspectMp4Boxes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { valid: false, error: 'Buffer too small to be a valid MP4' };
  }

  // First box must be 'ftyp'
  const firstBoxSize = buffer.readUInt32BE(0);
  const firstBoxType = buffer.toString('ascii', 4, 8);

  if (firstBoxType !== 'ftyp' || firstBoxSize < 16 || firstBoxSize > buffer.length) {
    return {
      valid: false,
      error: `Invalid MP4 header: expected 'ftyp' box, got '${firstBoxType}'`,
    };
  }

  const majorBrand = buffer.toString('ascii', 8, 12);
  const topBoxesRes = parseBoxList(buffer, 0, buffer.length);
  if (!topBoxesRes.valid) {
    return { valid: false, error: topBoxesRes.error };
  }

  let hasMoov = false;
  let hasMdat = false;
  let mdatPayloadBytes = 0;
  let hasVideoTrack = false;
  let videoCodec = null;
  let width = 0;
  let height = 0;
  let sampleCount = 0;
  let timescale = 0;
  let durationTicks = 0;

  for (const box of topBoxesRes.boxes) {
    if (box.type === 'mdat') {
      hasMdat = true;
      mdatPayloadBytes += box.boxEnd - box.payloadStart;
    } else if (box.type === 'moov') {
      hasMoov = true;
      const moovChildren = parseBoxList(buffer, box.payloadStart, box.boxEnd);
      if (!moovChildren.valid) {
        return { valid: false, error: `Corrupt 'moov' box: ${moovChildren.error}` };
      }

      for (const moovChild of moovChildren.boxes) {
        if (moovChild.type === 'mvhd') {
          const p = moovChild.payloadStart;
          const len = moovChild.boxEnd - p;
          if (len >= 20) {
            const version = buffer.readUInt8(p);
            if (version === 0) {
              timescale = buffer.readUInt32BE(p + 12);
              durationTicks = buffer.readUInt32BE(p + 16);
            } else if (version === 1 && len >= 32) {
              timescale = buffer.readUInt32BE(p + 20);
              durationTicks = Number(buffer.readBigUInt64BE(p + 24));
            }
          }
        } else if (moovChild.type === 'trak') {
          const trakChildren = parseBoxList(buffer, moovChild.payloadStart, moovChild.boxEnd);
          if (!trakChildren.valid) {
            return { valid: false, error: `Corrupt 'trak' box: ${trakChildren.error}` };
          }

          let trackIsVideo = false;
          let trackCodec = null;
          let trackWidth = 0;
          let trackHeight = 0;
          let trackSamples = 0;

          for (const trakChild of trakChildren.boxes) {
            if (trakChild.type === 'tkhd') {
              const p = trakChild.payloadStart;
              const len = trakChild.boxEnd - p;
              if (len >= 84) {
                trackWidth = buffer.readUInt32BE(p + 76) >>> 16;
                trackHeight = buffer.readUInt32BE(p + 80) >>> 16;
              }
            } else if (trakChild.type === 'mdia') {
              const mdiaChildren = parseBoxList(buffer, trakChild.payloadStart, trakChild.boxEnd);
              if (!mdiaChildren.valid) {
                return { valid: false, error: `Corrupt 'mdia' box: ${mdiaChildren.error}` };
              }

              for (const mdiaChild of mdiaChildren.boxes) {
                if (mdiaChild.type === 'mdhd' && (timescale === 0 || durationTicks === 0)) {
                  const p = mdiaChild.payloadStart;
                  const len = mdiaChild.boxEnd - p;
                  if (len >= 20) {
                    const version = buffer.readUInt8(p);
                    if (version === 0) {
                      timescale = buffer.readUInt32BE(p + 12);
                      durationTicks = buffer.readUInt32BE(p + 16);
                    }
                  }
                } else if (mdiaChild.type === 'hdlr') {
                  const p = mdiaChild.payloadStart;
                  const len = mdiaChild.boxEnd - p;
                  if (len >= 12) {
                    const handlerType = buffer.toString('ascii', p + 8, p + 12);
                    if (handlerType === 'vide') {
                      trackIsVideo = true;
                    }
                  }
                } else if (mdiaChild.type === 'minf') {
                  const minfChildren = parseBoxList(buffer, mdiaChild.payloadStart, mdiaChild.boxEnd);
                  if (!minfChildren.valid) {
                    return { valid: false, error: `Corrupt 'minf' box: ${minfChildren.error}` };
                  }

                  for (const minfChild of minfChildren.boxes) {
                    if (minfChild.type === 'stbl') {
                      const stblChildren = parseBoxList(buffer, minfChild.payloadStart, minfChild.boxEnd);
                      if (!stblChildren.valid) {
                        return { valid: false, error: `Corrupt 'stbl' box: ${stblChildren.error}` };
                      }

                      for (const stblChild of stblChildren.boxes) {
                        if (stblChild.type === 'stsd') {
                          const p = stblChild.payloadStart;
                          const len = stblChild.boxEnd - p;
                          if (len >= 16) {
                            const entryCount = buffer.readUInt32BE(p + 4);
                            if (entryCount >= 1) {
                              const entrySize = buffer.readUInt32BE(p + 8);
                              const entryType = buffer.toString('ascii', p + 12, p + 16);
                              if (
                                entrySize >= 16 &&
                                p + 8 + entrySize <= stblChild.boxEnd &&
                                SUPPORTED_ISOBMFF_VIDEO_CODECS.has(entryType)
                              ) {
                                trackCodec = entryType;
                                if (entrySize >= 42) {
                                  const w = buffer.readUInt16BE(p + 8 + 32);
                                  const h = buffer.readUInt16BE(p + 8 + 34);
                                  if (w > 0 && h > 0) {
                                    trackWidth = w;
                                    trackHeight = h;
                                  }
                                }
                              }
                            }
                          }
                        } else if (stblChild.type === 'stsz') {
                          const p = stblChild.payloadStart;
                          const len = stblChild.boxEnd - p;
                          if (len >= 12) {
                            trackSamples = Math.max(trackSamples, buffer.readUInt32BE(p + 8));
                          }
                        } else if (stblChild.type === 'stts' && trackSamples === 0) {
                          const p = stblChild.payloadStart;
                          const len = stblChild.boxEnd - p;
                          if (len >= 16) {
                            const entryCount = buffer.readUInt32BE(p + 4);
                            if (entryCount >= 1) {
                              trackSamples = buffer.readUInt32BE(p + 8);
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          if (trackIsVideo) {
            hasVideoTrack = true;
            videoCodec = trackCodec;
            width = trackWidth;
            height = trackHeight;
            sampleCount = trackSamples;
          }
        }
      }
    }
  }

  if (!hasMoov) {
    return {
      valid: false,
      majorBrand,
      hasMoov: false,
      error: "Missing required 'moov' metadata box in MP4 container",
    };
  }

  if (!hasVideoTrack) {
    return {
      valid: false,
      majorBrand,
      hasMoov: true,
      hasVideoTrack: false,
      error: "MP4 'moov' box does not contain a video ('vide') track",
    };
  }

  if (!videoCodec) {
    return {
      valid: false,
      majorBrand,
      hasMoov: true,
      hasVideoTrack: true,
      error: "MP4 video track is missing a supported video codec sample entry in 'stsd'",
    };
  }

  if (sampleCount <= 0) {
    return {
      valid: false,
      majorBrand,
      hasMoov: true,
      hasVideoTrack: true,
      videoCodec,
      sampleCount: 0,
      error: 'MP4 video track contains zero frames/samples',
    };
  }

  const durationSeconds = timescale > 0 ? durationTicks / timescale : 0;
  if (durationSeconds <= 0) {
    return {
      valid: false,
      majorBrand,
      hasMoov: true,
      hasVideoTrack: true,
      videoCodec,
      sampleCount,
      durationSeconds: 0,
      error: 'MP4 container has non-positive duration',
    };
  }

  if (!hasMdat || mdatPayloadBytes <= 0) {
    return {
      valid: false,
      majorBrand,
      hasMoov: true,
      hasMdat: false,
      error: "MP4 container is missing a non-empty 'mdat' media payload box",
    };
  }

  return {
    valid: true,
    majorBrand,
    hasMoov: true,
    hasMdat: true,
    hasVideoTrack: true,
    videoCodec,
    width,
    height,
    sampleCount,
    durationSeconds,
    mdatPayloadBytes,
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
 * Probes an MP4 buffer using `ffprobe` (or an injected `ffprobeRunner` for unit tests),
 * returning structured stream and container format metadata.
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {(buffer: Buffer) => object} [options.ffprobeRunner]
 * @returns {object}
 */
export function probeMp4WithFfprobe(buffer, options = {}) {
  if (typeof options.ffprobeRunner === 'function') {
    try {
      const customResult = options.ffprobeRunner(buffer);
      if (!customResult || typeof customResult !== 'object') {
        return { available: true, exitCode: 1, error: 'ffprobeRunner returned empty result' };
      }
      return {
        available: customResult.available ?? true,
        exitCode: customResult.exitCode ?? (customResult.error ? 1 : 0),
        ...customResult,
      };
    } catch (err) {
      return {
        available: true,
        exitCode: err.status ?? 1,
        error: err.message,
      };
    }
  }

  if (!isFfprobeAvailable()) {
    return {
      available: false,
      exitCode: 127,
      error: 'ffprobe binary is not installed or not found in PATH',
    };
  }

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
    const parsed = JSON.parse(stdout);
    return {
      available: true,
      exitCode: 0,
      ...parsed,
    };
  } catch (err) {
    const stderrMsg =
      err.stderr && Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf8').trim()
        : typeof err.stderr === 'string'
        ? err.stderr.trim()
        : '';
    return {
      available: true,
      exitCode: err.status ?? 1,
      error: stderrMsg || err.message,
    };
  } finally {
    try {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch {
      // Ignore cleanup error
    }
  }
}

/**
 * Verifies downloaded artifact buffer against expected byte length, SHA-256,
 * ISOBMFF box structure, and `ffprobe` decoded video stream metadata.
 * Fails CLOSED if `ffprobe` is missing, exits non-zero, or finds no decodable video stream/frames.
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {number} [options.expectedBytes]
 * @param {string} [options.expectedSha256]
 * @param {boolean} [options.isMp4=true]
 * @param {boolean} [options.requireFfprobe=true]
 * @param {(buffer: Buffer) => object} [options.ffprobeRunner]
 * @returns {object} Integrity result
 */
export function verifyArtifactIntegrity(buffer, options = {}) {
  const isMp4 = options.isMp4 ?? true;
  const requireFfprobe = options.requireFfprobe ?? true;
  const actualBytes = Buffer.isBuffer(buffer) ? buffer.length : 0;
  const actualSha256 = Buffer.isBuffer(buffer)
    ? crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase()
    : '';

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

  if (!Buffer.isBuffer(buffer) || actualBytes === 0) {
    result.valid = false;
    result.errors.push('Artifact buffer is empty or not a valid Buffer');
    return result;
  }

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

  if (isMp4) {
    const boxInfo = inspectMp4Boxes(buffer);
    result.boxAnalysis = boxInfo;
    if (!boxInfo.valid) {
      result.valid = false;
      result.errors.push(`MP4 container validation error: ${boxInfo.error}`);
    }

    const probe = probeMp4WithFfprobe(buffer, { ffprobeRunner: options.ffprobeRunner });
    result.ffprobeProbe = probe;

    if (!probe || probe.available === false) {
      if (requireFfprobe) {
        result.valid = false;
        result.errors.push(
          `FFPROBE_UNAVAILABLE (fail-closed): ${probe?.error || 'ffprobe binary is required for non-mock MP4 verification'}`
        );
      }
    } else if (probe.error || (probe.exitCode !== undefined && probe.exitCode !== 0)) {
      result.valid = false;
      result.errors.push(
        `ffprobe error (exit ${probe.exitCode ?? 1}): ${probe.error || 'ffprobe exited with non-zero status'}`
      );
    } else {
      // Validate container format and video stream
      const formatName = String(probe.format?.format_name || '').toLowerCase();
      if (!formatName.includes('mp4') && !formatName.includes('mov')) {
        result.valid = false;
        result.errors.push(
          `ffprobe container format mismatch: expected mp4/mov, got "${probe.format?.format_name || 'unknown'}"`
        );
      }

      const streams = Array.isArray(probe.streams) ? probe.streams : [];
      const videoStream = streams.find((s) => s && s.codec_type === 'video');

      if (!videoStream) {
        result.valid = false;
        result.errors.push('ffprobe found no decodable video stream (codec_type="video")');
      } else {
        const codecName = String(videoStream.codec_name || '').toLowerCase();
        if (!SUPPORTED_FFPROBE_VIDEO_CODECS.has(codecName)) {
          result.valid = false;
          result.errors.push(
            `ffprobe video stream has unsupported or invalid codec_name: "${videoStream.codec_name || 'none'}"`
          );
        }

        const streamWidth = Number(videoStream.width ?? 0);
        const streamHeight = Number(videoStream.height ?? 0);
        if (!Number.isFinite(streamWidth) || streamWidth <= 0 || !Number.isFinite(streamHeight) || streamHeight <= 0) {
          result.valid = false;
          result.errors.push(
            `ffprobe video stream has invalid dimensions: ${videoStream.width}x${videoStream.height}`
          );
        }

        const frameCount = Number(videoStream.nb_read_frames ?? videoStream.nb_frames ?? 0);
        if (!Number.isFinite(frameCount) || frameCount <= 0) {
          result.valid = false;
          result.errors.push(
            `ffprobe video stream decoded 0 frames (nb_read_frames=${videoStream.nb_read_frames ?? '0'})`
          );
        }

        const duration = Number(videoStream.duration ?? probe.format?.duration ?? 0);
        if (!Number.isFinite(duration) || duration <= 0) {
          result.valid = false;
          result.errors.push(
            `ffprobe video stream has non-positive duration (${videoStream.duration ?? probe.format?.duration ?? '0'})`
          );
        }
      }
    }
  }

  return result;
}
