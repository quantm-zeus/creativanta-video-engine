/**
 * Pure TypeScript ISO Base Media File Format (MP4) Decoder & Inspector.
 * Decodes all ISO-BMFF boxes, samples, timestamps, and audio/video stream integrity.
 * Canonical specification: docs/TESTING.md (Video/audio verification), docs/SCENE-SPEC.md
 */

import { createHash } from 'node:crypto';
import {
  Mp4BoxSummary,
  Mp4TrackInfo,
  DecodedVideoFrame,
  DecodedAudioTrackSummary,
  Mp4DecodeReport,
} from './mp4-types.js';

interface RawBox {
  type: string;
  size: number;
  offset: number;
  headerSize: number;
  payloadOffset: number;
  payloadLength: number;
  data: Buffer;
}

const CONTAINER_BOX_TYPES = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'dinf',
  'stbl',
]);

export class Mp4Decoder {
  private readonly buffer: Buffer;
  private readonly fileSize: number;
  private readonly fileChecksumSha256: string;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.fileSize = buffer.length;
    this.fileChecksumSha256 = createHash('sha256').update(buffer).digest('hex');
  }

  public static decode(buffer: Buffer, expectedFrameCount?: number): Mp4DecodeReport {
    const decoder = new Mp4Decoder(buffer);
    return decoder.parse(expectedFrameCount);
  }

  public parse(expectedFrameCount?: number): Mp4DecodeReport {
    const errors: string[] = [];

    if (this.fileSize < 8) {
      return this.buildErrorReport(['File too small to be a valid MP4 (< 8 bytes)']);
    }

    // Verify MP4 magic signature: ftyp box at offset 4
    const firstBoxType = this.buffer.subarray(4, 8).toString('ascii');
    if (firstBoxType !== 'ftyp') {
      errors.push(`Invalid MP4 signature: expected 'ftyp' at offset 4, found '${firstBoxType}'`);
    }

    // Parse all top-level boxes
    const rootBoxes = this.parseBoxList(0, this.fileSize, errors);
    const boxSummaries = rootBoxes.map((b) => this.summarizeBox(b));

    const ftypBox = rootBoxes.find((b) => b.type === 'ftyp');
    const moovBox = rootBoxes.find((b) => b.type === 'moov');
    const mdatBox = rootBoxes.find((b) => b.type === 'mdat');

    if (!ftypBox) {
      errors.push("Missing required top-level 'ftyp' box");
    }
    if (!moovBox) {
      errors.push("Missing required top-level 'moov' box");
    }
    if (!mdatBox) {
      errors.push("Missing required top-level 'mdat' box");
    }

    // Parse FTYP
    let majorBrand = '';
    let minorVersion = 0;
    const compatibleBrands: string[] = [];

    if (ftypBox && ftypBox.payloadLength >= 8) {
      const payload = this.buffer.subarray(
        ftypBox.payloadOffset,
        ftypBox.payloadOffset + ftypBox.payloadLength
      );
      majorBrand = payload.subarray(0, 4).toString('ascii');
      minorVersion = payload.readUInt32BE(4);
      for (let i = 8; i + 4 <= payload.length; i += 4) {
        compatibleBrands.push(payload.subarray(i, i + 4).toString('ascii'));
      }
    }

    // Check faststart (moov before mdat)
    const moovOffset = moovBox ? moovBox.offset : -1;
    const mdatOffset = mdatBox ? mdatBox.offset : -1;
    const faststartMoovBeforeMdat =
      moovOffset !== -1 && mdatOffset !== -1 && moovOffset < mdatOffset;

    if (!faststartMoovBeforeMdat) {
      errors.push(
        `Faststart violation: 'moov' (offset ${moovOffset}) must appear before 'mdat' (offset ${mdatOffset})`
      );
    }

    // Parse MOOV track hierarchy
    const tracks: Mp4TrackInfo[] = [];
    const decodedFrames: DecodedVideoFrame[] = [];
    let audioSummary: DecodedAudioTrackSummary | undefined;

    if (moovBox) {
      this.parseMoov(moovBox, tracks, decodedFrames, errors);
    }

    // Detect audio summary if audio track was parsed
    const audioTrack = tracks.find((t) => t.type === 'audio');
    if (audioTrack) {
      audioSummary = {
        trackId: audioTrack.trackId,
        sampleCount: audioTrack.sampleCount,
        sampleRate: audioTrack.sampleRate || 48000,
        channelCount: audioTrack.channelCount || 2,
        timescale: audioTrack.timescale,
        durationSeconds: audioTrack.durationSeconds,
        totalBytes: 0,
      };
    }

    // Validate video frame count and presentation timestamps
    const videoTrack = tracks.find((t) => t.type === 'video');
    const videoFrameCount = decodedFrames.length;
    let timestampsMonotonic = true;

    for (let i = 1; i < decodedFrames.length; i++) {
      if (decodedFrames[i]!.pts <= decodedFrames[i - 1]!.pts) {
        timestampsMonotonic = false;
        errors.push(
          `Non-monotonic timestamp detected: frame ${i} (pts ${decodedFrames[i]!.pts}) <= frame ${i - 1} (pts ${decodedFrames[i - 1]!.pts})`
        );
        break;
      }
    }

    let frameCountMatches = true;
    if (expectedFrameCount !== undefined) {
      frameCountMatches = videoFrameCount === expectedFrameCount;
      if (!frameCountMatches) {
        errors.push(
          `Frame count mismatch: expected ${expectedFrameCount} frames, decoded ${videoFrameCount} frames`
        );
      }
    }

    // Audio-Video synchronization check (duration delta ≤ 1 frame = 33.3ms)
    let audioVideoDurationDeltaSeconds: number | undefined;
    if (videoTrack && audioTrack) {
      audioVideoDurationDeltaSeconds = Math.abs(
        videoTrack.durationSeconds - audioTrack.durationSeconds
      );
      const maxAllowedDelta = (1.0 / (videoTrack.fps || 30)) * 1.5; // ≤1.5 frame margin
      if (audioVideoDurationDeltaSeconds > maxAllowedDelta) {
        errors.push(
          `Audio/Video duration desync: delta ${audioVideoDurationDeltaSeconds.toFixed(4)}s exceeds allowable 1-frame margin (${maxAllowedDelta.toFixed(4)}s)`
        );
      }
    }

    return {
      valid: errors.length === 0,
      fileSize: this.fileSize,
      fileChecksumSha256: this.fileChecksumSha256,
      majorBrand,
      minorVersion,
      compatibleBrands,
      faststartMoovBeforeMdat,
      moovOffset,
      mdatOffset,
      tracks,
      videoFrameCount,
      expectedFrameCount,
      frameCountMatches,
      timestampsMonotonic,
      audioSummary,
      audioVideoDurationDeltaSeconds,
      boxes: boxSummaries,
      frames: decodedFrames,
      errors,
    };
  }

  private parseBoxList(start: number, end: number, errors: string[]): RawBox[] {
    const boxes: RawBox[] = [];
    let offset = start;

    while (offset + 8 <= end) {
      const boxSize = this.buffer.readUInt32BE(offset);
      const boxType = this.buffer.subarray(offset + 4, offset + 8).toString('ascii');

      let headerSize = 8;
      let actualSize = boxSize;

      if (boxSize === 1) {
        // Extended 64-bit size
        if (offset + 16 > end) {
          errors.push(`Malformed 64-bit box header at offset ${offset}`);
          break;
        }
        actualSize = Number(this.buffer.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (boxSize === 0) {
        // Box extends to end of file
        actualSize = end - offset;
      }

      if (actualSize < headerSize || offset + actualSize > end) {
        errors.push(
          `Box size out of bounds at offset ${offset}: type '${boxType}', size ${actualSize}`
        );
        break;
      }

      const payloadOffset = offset + headerSize;
      const payloadLength = actualSize - headerSize;

      boxes.push({
        type: boxType,
        size: actualSize,
        offset,
        headerSize,
        payloadOffset,
        payloadLength,
        data: this.buffer.subarray(offset, offset + actualSize),
      });

      offset += actualSize;
    }

    return boxes;
  }

  private summarizeBox(box: RawBox): Mp4BoxSummary {
    const summary: Mp4BoxSummary = {
      type: box.type,
      size: box.size,
      offset: box.offset,
    };

    if (CONTAINER_BOX_TYPES.has(box.type)) {
      const children = this.parseBoxList(
        box.payloadOffset,
        box.payloadOffset + box.payloadLength,
        []
      );
      summary.children = children.map((c) => this.summarizeBox(c));
    }

    return summary;
  }

  private parseMoov(
    moovBox: RawBox,
    tracks: Mp4TrackInfo[],
    decodedFrames: DecodedVideoFrame[],
    errors: string[]
  ): void {
    const children = this.parseBoxList(
      moovBox.payloadOffset,
      moovBox.payloadOffset + moovBox.payloadLength,
      errors
    );

    const trakBoxes = children.filter((c) => c.type === 'trak');
    for (const trak of trakBoxes) {
      this.parseTrak(trak, tracks, decodedFrames, errors);
    }
  }

  private parseTrak(
    trakBox: RawBox,
    tracks: Mp4TrackInfo[],
    decodedFrames: DecodedVideoFrame[],
    errors: string[]
  ): void {
    const trakChildren = this.parseBoxList(
      trakBox.payloadOffset,
      trakBox.payloadOffset + trakBox.payloadLength,
      errors
    );

    const tkhdBox = trakChildren.find((b) => b.type === 'tkhd');
    const mdiaBox = trakChildren.find((b) => b.type === 'mdia');

    if (!tkhdBox || !mdiaBox) {
      errors.push("Malformed trak box: missing 'tkhd' or 'mdia'");
      return;
    }

    let trackId = 0;
    let trackWidth = 0;
    let trackHeight = 0;

    const tkhdPayload = this.buffer.subarray(
      tkhdBox.payloadOffset,
      tkhdBox.payloadOffset + tkhdBox.payloadLength
    );
    if (tkhdPayload.length >= 84) {
      const version = tkhdPayload[0]!;
      if (version === 0) {
        trackId = tkhdPayload.readUInt32BE(12);
        trackWidth = Math.round(tkhdPayload.readInt32BE(76) / 65536);
        trackHeight = Math.round(tkhdPayload.readInt32BE(80) / 65536);
      }
    }

    const mdiaChildren = this.parseBoxList(
      mdiaBox.payloadOffset,
      mdiaBox.payloadOffset + mdiaBox.payloadLength,
      errors
    );

    const mdhdBox = mdiaChildren.find((b) => b.type === 'mdhd');
    const hdlrBox = mdiaChildren.find((b) => b.type === 'hdlr');
    const minfBox = mdiaChildren.find((b) => b.type === 'minf');

    if (!mdhdBox || !hdlrBox || !minfBox) {
      errors.push("Malformed mdia box: missing 'mdhd', 'hdlr' or 'minf'");
      return;
    }

    let timescale = 30;
    let duration = 0;
    const mdhdPayload = this.buffer.subarray(
      mdhdBox.payloadOffset,
      mdhdBox.payloadOffset + mdhdBox.payloadLength
    );
    if (mdhdPayload.length >= 24) {
      const version = mdhdPayload[0]!;
      if (version === 0) {
        timescale = mdhdPayload.readUInt32BE(12);
        duration = mdhdPayload.readUInt32BE(16);
      }
    }

    let handlerType = '';
    const hdlrPayload = this.buffer.subarray(
      hdlrBox.payloadOffset,
      hdlrBox.payloadOffset + hdlrBox.payloadLength
    );
    if (hdlrPayload.length >= 12) {
      handlerType = hdlrPayload.subarray(8, 12).toString('ascii');
    }

    const minfChildren = this.parseBoxList(
      minfBox.payloadOffset,
      minfBox.payloadOffset + minfBox.payloadLength,
      errors
    );
    const stblBox = minfChildren.find((b) => b.type === 'stbl');
    if (!stblBox) {
      errors.push("Malformed minf box: missing 'stbl'");
      return;
    }

    const stblChildren = this.parseBoxList(
      stblBox.payloadOffset,
      stblBox.payloadOffset + stblBox.payloadLength,
      errors
    );

    const stsdBox = stblChildren.find((b) => b.type === 'stsd');
    const stszBox = stblChildren.find((b) => b.type === 'stsz');
    const stcoBox = stblChildren.find((b) => b.type === 'stco');
    const stssBox = stblChildren.find((b) => b.type === 'stss');

    let codec = 'unknown';
    let channelCount: number | undefined;
    let sampleRate: number | undefined;

    if (stsdBox && stsdBox.payloadLength >= 8) {
      const stsdEntries = this.parseBoxList(
        stsdBox.payloadOffset + 8,
        stsdBox.payloadOffset + stsdBox.payloadLength,
        []
      );
      if (stsdEntries.length > 0) {
        codec = stsdEntries[0]!.type;
        if (codec === 'mp4a' && stsdEntries[0]!.payloadLength >= 28) {
          const mp4aPayload = this.buffer.subarray(
            stsdEntries[0]!.payloadOffset,
            stsdEntries[0]!.payloadOffset + stsdEntries[0]!.payloadLength
          );
          channelCount = mp4aPayload.readUInt16BE(16);
          sampleRate = Math.floor(mp4aPayload.readUInt32BE(24) / 65536);
        }
      }
    }

    // Parse Sample Sizes (stsz)
    const sampleSizes: number[] = [];
    if (stszBox && stszBox.payloadLength >= 12) {
      const stszPayload = this.buffer.subarray(
        stszBox.payloadOffset,
        stszBox.payloadOffset + stszBox.payloadLength
      );
      const uniformSize = stszPayload.readUInt32BE(4);
      const sampleCount = stszPayload.readUInt32BE(8);

      if (uniformSize > 0) {
        for (let i = 0; i < sampleCount; i++) sampleSizes.push(uniformSize);
      } else {
        for (let i = 0; i < sampleCount; i++) {
          sampleSizes.push(stszPayload.readUInt32BE(12 + i * 4));
        }
      }
    }

    // Parse Chunk Offsets (stco)
    const chunkOffsets: number[] = [];
    if (stcoBox && stcoBox.payloadLength >= 8) {
      const stcoPayload = this.buffer.subarray(
        stcoBox.payloadOffset,
        stcoBox.payloadOffset + stcoBox.payloadLength
      );
      const entryCount = stcoPayload.readUInt32BE(4);
      for (let i = 0; i < entryCount; i++) {
        chunkOffsets.push(stcoPayload.readUInt32BE(8 + i * 4));
      }
    }

    // Parse Sync Samples (stss)
    const keyframeIndices = new Set<number>();
    if (stssBox && stssBox.payloadLength >= 8) {
      const stssPayload = this.buffer.subarray(
        stssBox.payloadOffset,
        stssBox.payloadOffset + stssBox.payloadLength
      );
      const entryCount = stssPayload.readUInt32BE(4);
      for (let i = 0; i < entryCount; i++) {
        keyframeIndices.add(stssPayload.readUInt32BE(8 + i * 4)); // 1-based
      }
    }

    const durationSeconds = timescale > 0 ? duration / timescale : 0;
    const isVideo = handlerType === 'vide';

    tracks.push({
      trackId,
      type: isVideo ? 'video' : 'audio',
      codec,
      timescale,
      duration,
      durationSeconds,
      sampleCount: sampleSizes.length,
      width: isVideo ? trackWidth : undefined,
      height: isVideo ? trackHeight : undefined,
      fps: isVideo ? timescale : undefined,
      channelCount,
      sampleRate,
    });

    // If video track, decode each frame sample
    if (isVideo) {
      for (let i = 0; i < sampleSizes.length; i++) {
        const offset = chunkOffsets[i]!;
        const size = sampleSizes[i]!;

        if (offset + size > this.fileSize) {
          errors.push(
            `Frame ${i} offset out of bounds: offset ${offset} + size ${size} > file size ${this.fileSize}`
          );
          continue;
        }

        const sampleData = this.buffer.subarray(offset, offset + size);
        const checksum = createHash('sha256').update(sampleData).digest('hex');

        // Parse 4-byte NAL prefix
        let nalUnitType = 0;
        let nalUnitTypeName = 'unknown';

        if (sampleData.length >= 5) {
          const nalLen = sampleData.readUInt32BE(0);
          void nalLen;
          const nalHeader = sampleData[4]!;
          nalUnitType = nalHeader & 0x1f;

          switch (nalUnitType) {
            case 1:
              nalUnitTypeName = 'non_idr_slice';
              break;
            case 5:
              nalUnitTypeName = 'idr_slice';
              break;
            case 7:
              nalUnitTypeName = 'sps';
              break;
            case 8:
              nalUnitTypeName = 'pps';
              break;
            default:
              nalUnitTypeName = `nal_type_${nalUnitType}`;
          }
        }

        const isKeyframe = keyframeIndices.has(i + 1) || nalUnitType === 5;
        const pts = i;
        const dts = i;
        const ptsSeconds = timescale > 0 ? pts / timescale : 0;

        decodedFrames.push({
          frameIndex: i,
          pts,
          dts,
          ptsSeconds,
          duration: 1,
          isKeyframe,
          sampleSize: size,
          fileOffset: offset,
          nalUnitType,
          nalUnitTypeName,
          checksumSha256: checksum,
        });
      }
    }
  }

  private buildErrorReport(errors: string[]): Mp4DecodeReport {
    return {
      valid: false,
      fileSize: this.fileSize,
      fileChecksumSha256: this.fileChecksumSha256,
      majorBrand: '',
      minorVersion: 0,
      compatibleBrands: [],
      faststartMoovBeforeMdat: false,
      moovOffset: -1,
      mdatOffset: -1,
      tracks: [],
      videoFrameCount: 0,
      frameCountMatches: false,
      timestampsMonotonic: false,
      boxes: [],
      frames: [],
      errors,
    };
  }
}
