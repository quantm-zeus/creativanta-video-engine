/**
 * Deterministic Frame Capture and Lossless PNG Rasterizer.
 * Uses standard Node.js zlib and crypto with zero external dependencies.
 * Canonical specification: docs/TESTING.md (visual goldens & deterministic frames)
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  FrameEvaluationResult,
  CanonicalCompilerManifest,
  ShapeLayerContent,
  TextLayerContent,
} from '@creativanta/contracts';
import { CapturedFrameBuffer } from '../types.js';

/**
 * Standard CRC32 table for PNG chunk checksums
 */
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function hexToRgba(hex: string): [number, number, number, number] {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map((ch) => ch + ch).join('');
  }
  if (clean.length === 6) {
    clean += 'ff';
  }
  if (clean.length !== 8) {
    return [0, 0, 0, 255]; // fallback black
  }
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  const a = parseInt(clean.slice(6, 8), 16) || 0;
  return [r, g, b, a];
}

/**
 * Encodes raw RGBA buffer into a valid, lossless PNG binary buffer.
 */
export function encodePng(
  rgbaBuffer: Buffer,
  width: number,
  height: number
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // 1. IHDR Chunk (13 bytes payload)
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // Bit depth: 8 bits per channel
  ihdrData[9] = 6; // Color type: 6 = RGBA
  ihdrData[10] = 0; // Compression: 0 = deflate
  ihdrData[11] = 0; // Filter: 0 = standard
  ihdrData[12] = 0; // Interlace: 0 = none

  const ihdrChunk = createPngChunk('IHDR', ihdrData);

  // 2. IDAT Chunk: Each scanline begins with a filter byte (0 = None) followed by width * 4 bytes
  const scanlineLength = 1 + width * 4;
  const rawIdat = Buffer.alloc(height * scanlineLength);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    rawIdat[rowOffset] = 0; // Filter byte 0 (None)
    const srcRowOffset = y * width * 4;
    rgbaBuffer.copy(rawIdat, rowOffset + 1, srcRowOffset, srcRowOffset + width * 4);
  }

  const compressedIdat = deflateSync(rawIdat, { level: 6 });
  const idatChunk = createPngChunk('IDAT', compressedIdat);

  // 3. IEND Chunk
  const iendChunk = createPngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const length = data.length;
  const typeBuf = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(4 + 4 + length + 4);

  chunk.writeUInt32BE(length, 0);
  typeBuf.copy(chunk, 4);
  data.copy(chunk, 8);

  const crcData = Buffer.concat([typeBuf, data]);
  const crcVal = crc32(crcData);
  chunk.writeUInt32BE(crcVal, 8 + length);

  return chunk;
}

/**
 * Deterministically rasterizes a frame from evaluated state into RGBA and PNG buffers.
 */
export function rasterizeFrame(
  manifest: CanonicalCompilerManifest,
  frameEval: FrameEvaluationResult,
  format: 'png' | 'raw_rgba' = 'png'
): CapturedFrameBuffer {
  const width = manifest.canvas.width;
  const height = manifest.canvas.height;
  const pixelCount = width * height;
  const rgbaBuffer = Buffer.alloc(pixelCount * 4);

  // 1. Fill Canvas / Scene Background
  const bgHex = frameEval.scene.background || manifest.canvas.background || '#000000';
  const [bgR, bgG, bgB, bgA] = hexToRgba(bgHex);
  const sceneAlpha = frameEval.scene.scene_alpha;

  const effBgR = Math.round(bgR * sceneAlpha);
  const effBgG = Math.round(bgG * sceneAlpha);
  const effBgB = Math.round(bgB * sceneAlpha);
  const effBgA = Math.round(bgA * sceneAlpha);

  for (let i = 0; i < pixelCount; i++) {
    const offset = i * 4;
    rgbaBuffer[offset] = effBgR;
    rgbaBuffer[offset + 1] = effBgG;
    rgbaBuffer[offset + 2] = effBgB;
    rgbaBuffer[offset + 3] = effBgA;
  }

  // 2. Composite Evaluated Layers in Z-Index Order
  for (const layer of frameEval.layers) {
    if (layer.opacity <= 0) continue;

    const box = layer.box;
    const effOpacity = layer.opacity;

    // Determine representative layer color
    let layerR = 255;
    let layerG = 255;
    let layerB = 255;
    let layerA = Math.round(effOpacity * 255);

    if (layer.type === 'shape') {
      const shapeContent = layer.content as ShapeLayerContent;
      if (shapeContent.fill) {
        const [r, g, b, a] = hexToRgba(shapeContent.fill);
        layerR = r;
        layerG = g;
        layerB = b;
        layerA = Math.round(a * effOpacity);
      }
    } else if (layer.type === 'text') {
      const textContent = layer.content as TextLayerContent;
      const [r, g, b, a] = hexToRgba(textContent.color || '#FFFFFF');
      layerR = r;
      layerG = g;
      layerB = b;
      layerA = Math.round(a * effOpacity);
    } else if (layer.type === 'video') {
      // Deterministic video frame placeholder (deep slate with frame tint)
      layerR = 24;
      layerG = 32;
      layerB = 48;
      layerA = Math.round(effOpacity * 255);
    }

    // Apply transform translation & bounding box clip
    const transformedX = Math.round(box.x + layer.transform.translate_x);
    const transformedY = Math.round(box.y + layer.transform.translate_y);
    const scaledWidth = Math.round(box.width * layer.transform.scale_x);
    const scaledHeight = Math.round(box.height * layer.transform.scale_y);

    const startX = Math.max(0, transformedX);
    const endX = Math.min(width, transformedX + scaledWidth);
    const startY = Math.max(0, transformedY);
    const endY = Math.min(height, transformedY + scaledHeight);

    const normA = layerA / 255;
    const invA = 1 - normA;

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4;
        const srcR = rgbaBuffer[idx]!;
        const srcG = rgbaBuffer[idx + 1]!;
        const srcB = rgbaBuffer[idx + 2]!;

        // Porter-Duff source-over blending
        rgbaBuffer[idx] = Math.round(layerR * normA + srcR * invA);
        rgbaBuffer[idx + 1] = Math.round(layerG * normA + srcG * invA);
        rgbaBuffer[idx + 2] = Math.round(layerB * normA + srcB * invA);
        rgbaBuffer[idx + 3] = 255; // Opaque export
      }
    }
  }

  // 3. Composite Burn-In Subtitles (if enabled on track and active cue exists)
  if (manifest.subtitles && manifest.subtitles.length > 0) {
    for (const track of manifest.subtitles) {
      if (!track.burn_in) continue;
      const cues = track.cues || [];
      const activeCue = cues.find(
        (c) => frameEval.frame_index >= c.start_frame && frameEval.frame_index < c.end_frame
      );
      if (activeCue) {
        const style = track.style;
        const safeMargin = style?.safe_margin_px ?? 56;
        const bgHex = style?.background ?? '#000000B3';
        const [subBgR, subBgG, subBgB, subBgA] = hexToRgba(bgHex);
        const [subTextR, subTextG, subTextB] = hexToRgba(style?.color ?? '#FFFFFF');

        // Bounding box for subtitle container (centered horizontally at bottom safe margin)
        const subHeight = 64;
        const subY = height - safeMargin - subHeight;
        const subX = safeMargin;
        const subW = width - safeMargin * 2;

        const subNormA = subBgA / 255;
        const subInvA = 1 - subNormA;

        // Composite background box
        for (let y = Math.max(0, subY); y < Math.min(height, subY + subHeight); y++) {
          for (let x = Math.max(0, subX); x < Math.min(width, subX + subW); x++) {
            const idx = (y * width + x) * 4;
            const srcR = rgbaBuffer[idx]!;
            const srcG = rgbaBuffer[idx + 1]!;
            const srcB = rgbaBuffer[idx + 2]!;

            rgbaBuffer[idx] = Math.round(subBgR * subNormA + srcR * subInvA);
            rgbaBuffer[idx + 1] = Math.round(subBgG * subNormA + srcG * subInvA);
            rgbaBuffer[idx + 2] = Math.round(subBgB * subNormA + srcB * subInvA);
            rgbaBuffer[idx + 3] = 255;
          }
        }

        // Composite text bar placeholder
        const textBarY = subY + 24;
        const textBarH = 16;
        const textBarW = Math.round(subW * 0.7);
        const textBarX = subX + Math.round((subW - textBarW) / 2);

        for (let y = Math.max(0, textBarY); y < Math.min(height, textBarY + textBarH); y++) {
          for (let x = Math.max(0, textBarX); x < Math.min(width, textBarX + textBarW); x++) {
            const idx = (y * width + x) * 4;
            rgbaBuffer[idx] = subTextR;
            rgbaBuffer[idx + 1] = subTextG;
            rgbaBuffer[idx + 2] = subTextB;
            rgbaBuffer[idx + 3] = 255;
          }
        }
        break;
      }
    }
  }

  // 4. Format Output
  const outputBuffer =
    format === 'png' ? encodePng(rgbaBuffer, width, height) : rgbaBuffer;
  const checksum = createHash('sha256').update(outputBuffer).digest('hex');

  return {
    frameIndex: frameEval.frame_index,
    format,
    width,
    height,
    buffer: outputBuffer,
    checksumSha256: checksum,
    byteLength: outputBuffer.length,
  };
}
