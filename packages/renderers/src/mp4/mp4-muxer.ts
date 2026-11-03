/**
 * Pure TypeScript ISO Base Media File Format (MP4) Muxer.
 * Constructs ISO/IEC 14496-12 / 14496-14 compliant MP4 containers with faststart moov.
 * Canonical specification: docs/TESTING.md, docs/SCENE-SPEC.md, docs/SECURITY.md
 */

import {
  Mp4MuxerOptions,
  VideoSampleInput,
  AudioSampleInput,
} from './mp4-types.js';

export function makeBox(type: string, payload: Buffer): Buffer {
  const size = 8 + payload.length;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, 4, 'ascii');
  payload.copy(buf, 8);
  return buf;
}

export function makeFullBox(
  type: string,
  version: number,
  flags: number,
  payload: Buffer
): Buffer {
  const header = Buffer.alloc(4);
  header[0] = version & 0xff;
  header[1] = (flags >> 16) & 0xff;
  header[2] = (flags >> 8) & 0xff;
  header[3] = flags & 0xff;
  return makeBox(type, Buffer.concat([header, payload]));
}

const IDENTITY_MATRIX = Buffer.from([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
]);

export class Mp4Muxer {
  private readonly options: Required<Mp4MuxerOptions>;
  private videoSamples: VideoSampleInput[] = [];
  private audioSamples: AudioSampleInput[] = [];

  constructor(options: Mp4MuxerOptions) {
    this.options = {
      width: options.width,
      height: options.height,
      fpsNum: options.fpsNum,
      fpsDen: options.fpsDen || 1,
      videoTimescale: options.videoTimescale || options.fpsNum,
      audioTimescale: options.audioTimescale || 48000,
      audioChannelCount: options.audioChannelCount || 2,
      audioSampleRate: options.audioSampleRate || 48000,
      faststart: options.faststart ?? true,
    };
  }

  public addVideoSample(sample: VideoSampleInput): void {
    this.videoSamples.push(sample);
  }

  public addAudioSample(sample: AudioSampleInput): void {
    this.audioSamples.push(sample);
  }

  public getVideoSampleCount(): number {
    return this.videoSamples.length;
  }

  public getAudioSampleCount(): number {
    return this.audioSamples.length;
  }

  /**
   * Compiles and outputs complete binary MP4 buffer with faststart moov.
   */
  public finalize(): Buffer {
    if (this.videoSamples.length === 0) {
      throw new Error('Mp4Muxer error: Cannot finalize MP4 with 0 video samples.');
    }

    // 1. Build FTYP box (32 bytes)
    const ftypPayload = Buffer.alloc(24);
    ftypPayload.write('isom', 0, 4, 'ascii'); // major_brand
    ftypPayload.writeUInt32BE(0x00000200, 4); // minor_version
    ftypPayload.write('isom', 8, 4, 'ascii'); // compatible_brand 1
    ftypPayload.write('iso2', 12, 4, 'ascii'); // compatible_brand 2
    ftypPayload.write('avc1', 16, 4, 'ascii'); // compatible_brand 3
    ftypPayload.write('mp41', 20, 4, 'ascii'); // compatible_brand 4
    const ftypBox = makeBox('ftyp', ftypPayload);

    // 2. Prepare MDAT sample buffers and calculate sample sizes
    const videoChunks: Buffer[] = [];
    const videoSampleSizes: number[] = [];

    for (const s of this.videoSamples) {
      // In avc1 format: 4-byte length prefix followed by NAL unit payload
      const nalLen = s.nalData.length;
      const chunk = Buffer.alloc(4 + nalLen);
      chunk.writeUInt32BE(nalLen, 0);
      s.nalData.copy(chunk, 4);
      videoChunks.push(chunk);
      videoSampleSizes.push(chunk.length);
    }

    const audioChunks: Buffer[] = [];
    const audioSampleSizes: number[] = [];
    for (const a of this.audioSamples) {
      audioChunks.push(a.data);
      audioSampleSizes.push(a.data.length);
    }

    const totalVideoMdatBytes = videoSampleSizes.reduce((sum, sz) => sum + sz, 0);
    const totalAudioMdatBytes = audioSampleSizes.reduce((sum, sz) => sum + sz, 0);
    void (totalVideoMdatBytes + totalAudioMdatBytes);

    // 3. Compute Moov box size using dummy offsets to get exact size
    const dummyOffsets = new Array(this.videoSamples.length).fill(0);
    const dummyAudioOffsets = new Array(this.audioSamples.length).fill(0);

    const dummyMoov = this.buildMoovBox(dummyOffsets, dummyAudioOffsets, videoSampleSizes, audioSampleSizes);
    const moovSize = dummyMoov.length;

    // 4. Calculate actual absolute file offsets for MDAT samples
    const mdatHeaderSize = 8;
    const mdatFileOffset = ftypBox.length + moovSize;
    let currentSampleOffset = mdatFileOffset + mdatHeaderSize;

    const actualVideoOffsets: number[] = [];
    for (const sz of videoSampleSizes) {
      actualVideoOffsets.push(currentSampleOffset);
      currentSampleOffset += sz;
    }

    const actualAudioOffsets: number[] = [];
    for (const sz of audioSampleSizes) {
      actualAudioOffsets.push(currentSampleOffset);
      currentSampleOffset += sz;
    }

    // 5. Build final Moov box with correct absolute chunk offsets
    const finalMoov = this.buildMoovBox(
      actualVideoOffsets,
      actualAudioOffsets,
      videoSampleSizes,
      audioSampleSizes
    );

    if (finalMoov.length !== moovSize) {
      throw new Error(
        `Mp4Muxer layout error: Moov box size mismatch (predicted ${moovSize}, actual ${finalMoov.length})`
      );
    }

    // 6. Build MDAT box
    const mdatPayload = Buffer.concat([...videoChunks, ...audioChunks]);
    const mdatBox = makeBox('mdat', mdatPayload);

    // 7. Concatenate: ftyp -> moov (faststart) -> mdat
    return Buffer.concat([ftypBox, finalMoov, mdatBox]);
  }

  private buildMoovBox(
    videoOffsets: number[],
    audioOffsets: number[],
    videoSizes: number[],
    audioSizes: number[]
  ): Buffer {
    const movieTimescale = this.options.videoTimescale;
    const totalVideoDuration = this.videoSamples.reduce(
      (sum, s) => sum + s.durationInTimescaleUnits,
      0
    );
    const numTracks = this.audioSamples.length > 0 ? 2 : 1;

    // 1. mvhd
    const mvhdPayload = Buffer.alloc(96);
    mvhdPayload.writeUInt32BE(0, 0); // creation_time
    mvhdPayload.writeUInt32BE(0, 4); // modification_time
    mvhdPayload.writeUInt32BE(movieTimescale, 8); // timescale
    mvhdPayload.writeUInt32BE(totalVideoDuration, 12); // duration
    mvhdPayload.writeInt32BE(0x00010000, 16); // rate 1.0
    mvhdPayload.writeInt16BE(0x0100, 20); // volume 1.0
    // reserved 10 bytes: offset 22..31 = 0
    IDENTITY_MATRIX.copy(mvhdPayload, 32); // 32..67 (36 bytes matrix)
    // pre_defined 24 bytes: offset 68..91 = 0
    mvhdPayload.writeUInt32BE(numTracks + 1, 92); // next_track_id
    const mvhdBox = makeFullBox('mvhd', 0, 0, mvhdPayload);

    // 2. Video trak
    const videoTrak = this.buildVideoTrak(videoOffsets, videoSizes, totalVideoDuration);

    const trakBoxes = [mvhdBox, videoTrak];

    // 3. Audio trak (optional)
    if (this.audioSamples.length > 0) {
      const audioTrak = this.buildAudioTrak(audioOffsets, audioSizes);
      trakBoxes.push(audioTrak);
    }

    return makeBox('moov', Buffer.concat(trakBoxes));
  }

  private buildVideoTrak(
    offsets: number[],
    sizes: number[],
    totalDuration: number
  ): Buffer {
    const trackId = 1;
    const width = this.options.width;
    const height = this.options.height;
    const timescale = this.options.videoTimescale;

    // tkhd (track header)
    const tkhdPayload = Buffer.alloc(80);
    tkhdPayload.writeUInt32BE(0, 0); // creation_time
    tkhdPayload.writeUInt32BE(0, 4); // modification_time
    tkhdPayload.writeUInt32BE(trackId, 8); // track_id
    // reserved 4 bytes: 12..15 = 0
    tkhdPayload.writeUInt32BE(totalDuration, 16); // duration
    // reserved 8 bytes: 20..27 = 0
    tkhdPayload.writeInt16BE(0, 28); // layer
    tkhdPayload.writeInt16BE(0, 30); // alternate_group
    tkhdPayload.writeInt16BE(0, 32); // volume 0 for video
    // reserved 2 bytes: 34..35 = 0
    IDENTITY_MATRIX.copy(tkhdPayload, 36); // 36..71 (36 bytes matrix)
    tkhdPayload.writeInt32BE(width << 16, 72); // width 16.16
    tkhdPayload.writeInt32BE(height << 16, 76); // height 16.16
    const tkhdBox = makeFullBox('tkhd', 0, 0x000007, tkhdPayload);

    // mdia -> mdhd
    const mdhdPayload = Buffer.alloc(20);
    mdhdPayload.writeUInt32BE(0, 0); // creation_time
    mdhdPayload.writeUInt32BE(0, 4); // modification_time
    mdhdPayload.writeUInt32BE(timescale, 8); // timescale
    mdhdPayload.writeUInt32BE(totalDuration, 12); // duration
    mdhdPayload.writeUInt16BE(0x55c4, 16); // language 'und'
    mdhdPayload.writeUInt16BE(0, 18); // pre_defined
    const mdhdBox = makeFullBox('mdhd', 0, 0, mdhdPayload);

    // mdia -> hdlr
    const hdlrPayload = Buffer.alloc(21);
    hdlrPayload.writeUInt32BE(0, 0); // pre_defined
    hdlrPayload.write('vide', 4, 4, 'ascii'); // handler_type
    // reserved 12 bytes: 8..19 = 0
    hdlrPayload.write('VideoHandler\0', 20, 'ascii');
    const hdlrBox = makeFullBox('hdlr', 0, 0, hdlrPayload);

    // mdia -> minf -> vmhd
    const vmhdPayload = Buffer.alloc(8);
    vmhdPayload.writeUInt16BE(0, 0); // graphicsmode
    // opcolor 6 bytes = 0
    const vmhdBox = makeFullBox('vmhd', 0, 1, vmhdPayload);

    // dinf -> dref -> url
    const urlBox = makeFullBox('url ', 0, 1, Buffer.alloc(0));
    const drefPayload = Buffer.alloc(4);
    drefPayload.writeUInt32BE(1, 0); // entry_count = 1
    const drefBox = makeFullBox('dref', 0, 0, Buffer.concat([drefPayload, urlBox]));
    const dinfBox = makeBox('dinf', drefBox);

    // stbl tables:
    // 1. stsd -> avc1 -> avcC
    const avcC = this.buildAvcConfigurationBox();
    const avc1Payload = Buffer.alloc(78);
    // reserved 6 bytes: 0..5 = 0
    avc1Payload.writeUInt16BE(1, 6); // data_reference_index = 1
    // pre_defined 16 bytes: 8..23 = 0
    avc1Payload.writeUInt16BE(width, 24); // width
    avc1Payload.writeUInt16BE(height, 26); // height
    avc1Payload.writeUInt32BE(0x00480000, 28); // horizresolution 72 dpi
    avc1Payload.writeUInt32BE(0x00480000, 32); // vertresolution 72 dpi
    // reserved 4 bytes: 36..39 = 0
    avc1Payload.writeUInt16BE(1, 40); // frame_count = 1
    avc1Payload[42] = 10; // compressorname length
    avc1Payload.write('AVC Coding', 43, 10, 'ascii');
    // compressor padding to 32 bytes: 53..73 = 0
    avc1Payload.writeUInt16BE(0x0018, 74); // depth = 24
    avc1Payload.writeInt16BE(-1, 76); // pre_defined = -1
    const avc1Box = makeBox('avc1', Buffer.concat([avc1Payload, avcC]));

    const stsdPayload = Buffer.alloc(4);
    stsdPayload.writeUInt32BE(1, 0); // entry_count = 1
    const stsdBox = makeFullBox('stsd', 0, 0, Buffer.concat([stsdPayload, avc1Box]));

    // 2. stts (Time-to-Sample)
    const sttsPayload = Buffer.alloc(12);
    sttsPayload.writeUInt32BE(1, 0); // entry_count = 1
    sttsPayload.writeUInt32BE(this.videoSamples.length, 4); // sample_count
    sttsPayload.writeUInt32BE(1, 8); // sample_delta = 1
    const sttsBox = makeFullBox('stts', 0, 0, sttsPayload);

    // 3. stss (Sync Samples / Keyframes)
    const keyframeIndices: number[] = [];
    for (let i = 0; i < this.videoSamples.length; i++) {
      if (this.videoSamples[i]!.isKeyframe) {
        keyframeIndices.push(i + 1); // 1-based index in MP4
      }
    }
    const stssPayload = Buffer.alloc(4 + keyframeIndices.length * 4);
    stssPayload.writeUInt32BE(keyframeIndices.length, 0);
    for (let i = 0; i < keyframeIndices.length; i++) {
      stssPayload.writeUInt32BE(keyframeIndices[i]!, 4 + i * 4);
    }
    const stssBox = makeFullBox('stss', 0, 0, stssPayload);

    // 4. stsc (Sample-to-Chunk: 1 sample per chunk)
    const stscPayload = Buffer.alloc(16);
    stscPayload.writeUInt32BE(1, 0); // entry_count = 1
    stscPayload.writeUInt32BE(1, 4); // first_chunk = 1
    stscPayload.writeUInt32BE(1, 8); // samples_per_chunk = 1
    stscPayload.writeUInt32BE(1, 12); // sample_description_index = 1
    const stscBox = makeFullBox('stsc', 0, 0, stscPayload);

    // 5. stsz (Sample Sizes)
    const stszPayload = Buffer.alloc(8 + sizes.length * 4);
    stszPayload.writeUInt32BE(0, 0); // sample_size (0 = variable)
    stszPayload.writeUInt32BE(sizes.length, 4); // sample_count
    for (let i = 0; i < sizes.length; i++) {
      stszPayload.writeUInt32BE(sizes[i]!, 8 + i * 4);
    }
    const stszBox = makeFullBox('stsz', 0, 0, stszPayload);

    // 6. stco (Chunk Offsets)
    const stcoPayload = Buffer.alloc(4 + offsets.length * 4);
    stcoPayload.writeUInt32BE(offsets.length, 0); // entry_count
    for (let i = 0; i < offsets.length; i++) {
      stcoPayload.writeUInt32BE(offsets[i]!, 4 + i * 4);
    }
    const stcoBox = makeFullBox('stco', 0, 0, stcoPayload);

    const stblBox = makeBox(
      'stbl',
      Buffer.concat([stsdBox, sttsBox, stssBox, stscBox, stszBox, stcoBox])
    );
    const minfBox = makeBox('minf', Buffer.concat([vmhdBox, dinfBox, stblBox]));
    const mdiaBox = makeBox('mdia', Buffer.concat([mdhdBox, hdlrBox, minfBox]));

    return makeBox('trak', Buffer.concat([tkhdBox, mdiaBox]));
  }

  private buildAvcConfigurationBox(): Buffer {
    // Generate valid SPS and PPS NAL units for AVC
    // SPS: Profile Baseline (66 = 0x42), Level 3.1 (31 = 0x1f)
    const spsPayload = Buffer.from([
      0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40, 0x16, 0xe8, 0x06, 0xd0, 0xa1, 0x35,
    ]);
    // PPS
    const ppsPayload = Buffer.from([0x68, 0xce, 0x3c, 0x80]);

    const avccPayload = Buffer.alloc(7 + spsPayload.length + 1 + 2 + ppsPayload.length);
    let offset = 0;
    avccPayload[offset++] = 1; // configurationVersion
    avccPayload[offset++] = 0x42; // AVCProfileIndication (Baseline)
    avccPayload[offset++] = 0xc0; // profile_compatibility
    avccPayload[offset++] = 0x1f; // AVCLevelIndication (3.1)
    avccPayload[offset++] = 0xff; // lengthSizeMinusOne (3 | 0xfc = 4 bytes length)
    avccPayload[offset++] = 0xe1; // numOfSequenceParameterSets (1 | 0xe0)
    avccPayload.writeUInt16BE(spsPayload.length, offset);
    offset += 2;
    spsPayload.copy(avccPayload, offset);
    offset += spsPayload.length;
    avccPayload[offset++] = 1; // numOfPictureParameterSets
    avccPayload.writeUInt16BE(ppsPayload.length, offset);
    offset += 2;
    ppsPayload.copy(avccPayload, offset);

    return makeBox('avcC', avccPayload);
  }

  private buildAudioTrak(offsets: number[], sizes: number[]): Buffer {
    const trackId = 2;
    const timescale = this.options.audioTimescale;
    const totalDuration = this.audioSamples.reduce(
      (sum, a) => sum + a.durationInTimescaleUnits,
      0
    );

    // tkhd (audio track header: volume 1.0, width 0, height 0)
    const tkhdPayload = Buffer.alloc(80);
    tkhdPayload.writeUInt32BE(0, 0); // creation_time
    tkhdPayload.writeUInt32BE(0, 4); // modification_time
    tkhdPayload.writeUInt32BE(trackId, 8); // track_id
    // reserved 4 bytes: 12..15 = 0
    tkhdPayload.writeUInt32BE(
      Math.round((totalDuration / timescale) * this.options.videoTimescale),
      16
    ); // duration in movie timescale
    // reserved 8 bytes: 20..27 = 0
    tkhdPayload.writeInt16BE(0, 28); // layer
    tkhdPayload.writeInt16BE(0, 30); // alternate_group
    tkhdPayload.writeInt16BE(0x0100, 32); // volume 1.0 (8.8 fixed point)
    // reserved 2 bytes: 34..35 = 0
    IDENTITY_MATRIX.copy(tkhdPayload, 36); // matrix
    tkhdPayload.writeInt32BE(0, 72); // width 0
    tkhdPayload.writeInt32BE(0, 76); // height 0
    const tkhdBox = makeFullBox('tkhd', 0, 0x000007, tkhdPayload);

    // mdia -> mdhd
    const mdhdPayload = Buffer.alloc(20);
    mdhdPayload.writeUInt32BE(0, 0);
    mdhdPayload.writeUInt32BE(0, 4);
    mdhdPayload.writeUInt32BE(timescale, 8);
    mdhdPayload.writeUInt32BE(totalDuration, 12);
    mdhdPayload.writeUInt16BE(0x55c4, 16); // 'und'
    mdhdPayload.writeUInt16BE(0, 18);
    const mdhdBox = makeFullBox('mdhd', 0, 0, mdhdPayload);

    // mdia -> hdlr
    const hdlrPayload = Buffer.alloc(21);
    hdlrPayload.writeUInt32BE(0, 0);
    hdlrPayload.write('soun', 4, 4, 'ascii'); // handler_type = soun
    hdlrPayload.write('SoundHandler\0', 20, 'ascii');
    const hdlrBox = makeFullBox('hdlr', 0, 0, hdlrPayload);

    // mdia -> minf -> smhd
    const smhdPayload = Buffer.alloc(4);
    smhdPayload.writeInt16BE(0, 0); // balance 0
    smhdPayload.writeInt16BE(0, 2); // reserved
    const smhdBox = makeFullBox('smhd', 0, 0, smhdPayload);

    // dinf -> dref -> url
    const urlBox = makeFullBox('url ', 0, 1, Buffer.alloc(0));
    const drefPayload = Buffer.alloc(4);
    drefPayload.writeUInt32BE(1, 0);
    const drefBox = makeFullBox('dref', 0, 0, Buffer.concat([drefPayload, urlBox]));
    const dinfBox = makeBox('dinf', drefBox);

    // stbl -> stsd -> mp4a -> esds
    const esdsBox = this.buildEsdsBox();
    const mp4aPayload = Buffer.alloc(28);
    // reserved 6 bytes: 0..5 = 0
    mp4aPayload.writeUInt16BE(1, 6); // data_reference_index = 1
    // reserved 8 bytes: 8..15 = 0
    mp4aPayload.writeUInt16BE(this.options.audioChannelCount, 16); // channelcount = 2
    mp4aPayload.writeUInt16BE(16, 18); // samplesize = 16
    // pre_defined 4 bytes: 20..23 = 0
    mp4aPayload.writeUInt32BE(this.options.audioSampleRate * 65536, 24); // samplerate 48000.0 (16.16)
    const mp4aBox = makeBox('mp4a', Buffer.concat([mp4aPayload, esdsBox]));

    const stsdPayload = Buffer.alloc(4);
    stsdPayload.writeUInt32BE(1, 0);
    const stsdBox = makeFullBox('stsd', 0, 0, Buffer.concat([stsdPayload, mp4aBox]));

    // stts for audio
    const sttsPayload = Buffer.alloc(12);
    sttsPayload.writeUInt32BE(1, 0); // entry_count = 1
    sttsPayload.writeUInt32BE(this.audioSamples.length, 4); // sample_count
    const audioSampleDelta = this.audioSamples[0]?.durationInTimescaleUnits || 1024;
    sttsPayload.writeUInt32BE(audioSampleDelta, 8); // sample_delta
    const sttsBox = makeFullBox('stts', 0, 0, sttsPayload);

    // stsc for audio
    const stscPayload = Buffer.alloc(16);
    stscPayload.writeUInt32BE(1, 0);
    stscPayload.writeUInt32BE(1, 4);
    stscPayload.writeUInt32BE(1, 8);
    stscPayload.writeUInt32BE(1, 12);
    const stscBox = makeFullBox('stsc', 0, 0, stscPayload);

    // stsz for audio
    const stszPayload = Buffer.alloc(8 + sizes.length * 4);
    stszPayload.writeUInt32BE(0, 0);
    stszPayload.writeUInt32BE(sizes.length, 4);
    for (let i = 0; i < sizes.length; i++) {
      stszPayload.writeUInt32BE(sizes[i]!, 8 + i * 4);
    }
    const stszBox = makeFullBox('stsz', 0, 0, stszPayload);

    // stco for audio
    const stcoPayload = Buffer.alloc(4 + offsets.length * 4);
    stcoPayload.writeUInt32BE(offsets.length, 0);
    for (let i = 0; i < offsets.length; i++) {
      stcoPayload.writeUInt32BE(offsets[i]!, 4 + i * 4);
    }
    const stcoBox = makeFullBox('stco', 0, 0, stcoPayload);

    const stblBox = makeBox(
      'stbl',
      Buffer.concat([stsdBox, sttsBox, stscBox, stszBox, stcoBox])
    );
    const minfBox = makeBox('minf', Buffer.concat([smhdBox, dinfBox, stblBox]));
    const mdiaBox = makeBox('mdia', Buffer.concat([mdhdBox, hdlrBox, minfBox]));

    return makeBox('trak', Buffer.concat([tkhdBox, mdiaBox]));
  }

  private buildEsdsBox(): Buffer {
    // MPEG-4 Elementary Stream Descriptor (esds) for AAC LC 48kHz stereo
    const esdsPayload = Buffer.from([
      0x03, 0x19, 0x00, 0x01, 0x00, // ES_Descriptor (tag 0x03)
      0x04, 0x11, 0x40, 0x15, 0x00, 0x06, 0x00, 0x00, 0x01, 0xf4, 0x00, 0x00, 0x01, 0xf4, 0x00, // DecoderConfig (AAC 48kHz)
      0x05, 0x02, 0x11, 0x90, // AudioSpecificConfig: AudioObjectType=2 (AAC LC), SampleFreqIndex=3 (48kHz), ChannelConfig=2 (Stereo)
      0x06, 0x01, 0x02, // SLConfigDescriptor
    ]);
    return makeFullBox('esds', 0, 0, esdsPayload);
  }
}
