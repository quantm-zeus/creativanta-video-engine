import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Mp4Muxer,
  Mp4Decoder,
  makeBox,
  makeFullBox,
} from '../dist/index.js';

test('MP4 Codec: Box Construction & Byte Encoding', () => {
  // 1. Basic Box
  const payload = Buffer.from('hello-world');
  const box = makeBox('test', payload);
  assert.equal(box.readUInt32BE(0), 8 + 11);
  assert.equal(box.subarray(4, 8).toString('ascii'), 'test');
  assert.equal(box.subarray(8).toString('utf-8'), 'hello-world');

  // 2. Full Box with Version and Flags
  const fullBox = makeFullBox('full', 1, 0x000007, payload);
  assert.equal(fullBox.readUInt32BE(0), 8 + 4 + 11);
  assert.equal(fullBox.subarray(4, 8).toString('ascii'), 'full');
  assert.equal(fullBox[8], 1); // version
  assert.equal(fullBox[9], 0); // flags >> 16
  assert.equal(fullBox[10], 0); // flags >> 8
  assert.equal(fullBox[11], 7); // flags & 0xff
  assert.equal(fullBox.subarray(12).toString('utf-8'), 'hello-world');
});

test('MP4 Codec: Muxer Faststart & Box Layout', () => {
  const muxer = new Mp4Muxer({
    width: 720,
    height: 1280,
    fpsNum: 30,
    fpsDen: 1,
    faststart: true,
  });

  // Add 10 dummy video samples
  for (let i = 0; i < 10; i++) {
    const isKeyframe = i === 0;
    const nalData = Buffer.from([isKeyframe ? 0x65 : 0x41, i, 0x00, 0xff]);
    muxer.addVideoSample({
      frameIndex: i,
      isKeyframe,
      durationInTimescaleUnits: 1,
      nalData,
    });
  }

  assert.equal(muxer.getVideoSampleCount(), 10);
  const mp4Buffer = muxer.finalize();

  // Validate magic bytes: offset 4..8 === 'ftyp'
  assert.equal(mp4Buffer.subarray(4, 8).toString('ascii'), 'ftyp');

  // Decode with Mp4Decoder
  const report = Mp4Decoder.decode(mp4Buffer, 10);
  assert.equal(report.valid, true);
  assert.equal(report.majorBrand, 'isom');
  assert.ok(report.compatibleBrands.includes('avc1'));
  assert.equal(report.faststartMoovBeforeMdat, true);
  assert.ok(report.moovOffset < report.mdatOffset, 'moov must precede mdat for faststart');
  assert.equal(report.videoFrameCount, 10);
  assert.equal(report.frameCountMatches, true);
  assert.equal(report.timestampsMonotonic, true);
  assert.equal(report.errors.length, 0);

  // Validate keyframes: frame 0 must be keyframe
  assert.equal(report.frames[0].isKeyframe, true);
  assert.equal(report.frames[0].nalUnitType, 5); // IDR slice
  assert.equal(report.frames[1].isKeyframe, false);
  assert.equal(report.frames[1].nalUnitType, 1); // non-IDR slice
});

test('MP4 Codec: Audio Track Muxing and Synchronization', () => {
  const muxer = new Mp4Muxer({
    width: 1280,
    height: 720,
    fpsNum: 30,
    fpsDen: 1,
    audioTimescale: 48000,
    audioChannelCount: 2,
    audioSampleRate: 48000,
    faststart: true,
  });

  // 30 video frames (1.0s)
  for (let i = 0; i < 30; i++) {
    muxer.addVideoSample({
      frameIndex: i,
      isKeyframe: i % 15 === 0,
      durationInTimescaleUnits: 1,
      nalData: Buffer.from([i === 0 ? 0x65 : 0x41, 0x10, 0x20]),
    });
  }

  // Audio: 48000 samples in packets of 1024 (approx 47 packets)
  let remainingAudioSamples = 48000;
  let audioIndex = 0;
  while (remainingAudioSamples > 0) {
    const pktSamples = Math.min(1024, remainingAudioSamples);
    muxer.addAudioSample({
      sampleIndex: audioIndex++,
      data: Buffer.alloc(pktSamples * 4), // 16-bit stereo PCM = 4 bytes per sample
      durationInTimescaleUnits: pktSamples,
    });
    remainingAudioSamples -= pktSamples;
  }

  const mp4Buffer = muxer.finalize();
  const report = Mp4Decoder.decode(mp4Buffer, 30);

  assert.equal(report.valid, true);
  assert.equal(report.tracks.length, 2);

  const videoTrack = report.tracks.find((t) => t.type === 'video');
  const audioTrack = report.tracks.find((t) => t.type === 'audio');

  assert.ok(videoTrack);
  assert.ok(audioTrack);
  assert.equal(videoTrack.sampleCount, 30);
  assert.equal(videoTrack.fps, 30);
  assert.equal(audioTrack.sampleRate, 48000);
  assert.equal(audioTrack.channelCount, 2);

  // Sync delta ≤ 1 frame (33.3ms)
  assert.ok(report.audioVideoDurationDeltaSeconds !== undefined);
  assert.ok(
    report.audioVideoDurationDeltaSeconds <= 0.034,
    `A/V duration delta ${report.audioVideoDurationDeltaSeconds}s exceeds allowable 1 frame`
  );
});

test('MP4 Codec: Decoder Malformed Input Detection', () => {
  // 1. Buffer too small
  const tinyBuf = Buffer.from([0, 0, 0, 4]);
  const r1 = Mp4Decoder.decode(tinyBuf);
  assert.equal(r1.valid, false);
  assert.ok(r1.errors.some((e) => e.includes('too small')));

  // 2. Missing ftyp
  const notMp4 = Buffer.alloc(64);
  notMp4.writeUInt32BE(64, 0);
  notMp4.write('xxxx', 4, 4, 'ascii');
  const r2 = Mp4Decoder.decode(notMp4);
  assert.equal(r2.valid, false);
  assert.ok(r2.errors.some((e) => e.includes('Invalid MP4 signature')));

  // 3. Expected frame count mismatch
  const muxer = new Mp4Muxer({ width: 720, height: 1280, fpsNum: 30, fpsDen: 1 });
  for (let i = 0; i < 5; i++) {
    muxer.addVideoSample({
      frameIndex: i,
      isKeyframe: i === 0,
      durationInTimescaleUnits: 1,
      nalData: Buffer.from([0x65, i]),
    });
  }
  const r3 = Mp4Decoder.decode(muxer.finalize(), 10); // expected 10, actual 5
  assert.equal(r3.valid, false);
  assert.equal(r3.frameCountMatches, false);
  assert.ok(r3.errors.some((e) => e.includes('Frame count mismatch')));
});
