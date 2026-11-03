/**
 * Types and interfaces for ISO Base Media File Format (MP4) Muxer & Decoder.
 * Canonical specification: docs/TESTING.md, docs/SCENE-SPEC.md, ISO/IEC 14496-12 / 14496-14.
 */

export interface Mp4BoxHeader {
  type: string;
  size: number;
  headerSize: number;
  payloadOffset: number;
}

export interface Mp4BoxSummary {
  type: string;
  size: number;
  offset: number;
  children?: Mp4BoxSummary[];
}

export interface VideoSampleInput {
  frameIndex: number;
  isKeyframe: boolean;
  durationInTimescaleUnits: number;
  nalData: Buffer;
  rgbaBuffer?: Buffer;
  pngBuffer?: Buffer;
  checksumSha256?: string;
}

export interface AudioSampleInput {
  sampleIndex: number;
  data: Buffer;
  durationInTimescaleUnits: number;
}

export interface Mp4MuxerOptions {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  videoTimescale?: number;
  audioTimescale?: number;
  audioChannelCount?: number;
  audioSampleRate?: number;
  faststart?: boolean;
}

export interface DecodedVideoFrame {
  frameIndex: number;
  pts: number;
  dts: number;
  ptsSeconds: number;
  duration: number;
  isKeyframe: boolean;
  sampleSize: number;
  fileOffset: number;
  nalUnitType: number;
  nalUnitTypeName: string;
  checksumSha256: string;
}

export interface DecodedAudioTrackSummary {
  trackId: number;
  sampleCount: number;
  sampleRate: number;
  channelCount: number;
  timescale: number;
  durationSeconds: number;
  totalBytes: number;
}

export interface Mp4TrackInfo {
  trackId: number;
  type: 'video' | 'audio';
  codec: string;
  timescale: number;
  duration: number;
  durationSeconds: number;
  sampleCount: number;
  width?: number;
  height?: number;
  fps?: number;
  channelCount?: number;
  sampleRate?: number;
}

export interface Mp4DecodeReport {
  valid: boolean;
  filePath?: string;
  fileSize: number;
  fileChecksumSha256: string;
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
  faststartMoovBeforeMdat: boolean;
  moovOffset: number;
  mdatOffset: number;
  tracks: Mp4TrackInfo[];
  videoFrameCount: number;
  expectedFrameCount?: number;
  frameCountMatches: boolean;
  timestampsMonotonic: boolean;
  audioSummary?: DecodedAudioTrackSummary;
  audioVideoDurationDeltaSeconds?: number;
  boxes: Mp4BoxSummary[];
  frames: DecodedVideoFrame[];
  errors: string[];
}
