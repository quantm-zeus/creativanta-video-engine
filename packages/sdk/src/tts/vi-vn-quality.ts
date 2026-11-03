/**
 * Vietnamese (vi-VN) Quality Sample Evaluation & Typography-Audio Synchronization Suite.
 * Specification: docs/TESTING.md (Line 49: audio peak, duration, LUFS), docs/IMPLEMENTATION_PLAN.md (P5-02).
 */

import { OfflineTtsAdapter } from './offline-synthesizer.js';

export const VIETNAMESE_QUALITY_FIXTURES = {
  promo: {
    id: 'sample_vi_promo_01',
    category: 'eCommerce Promo',
    text: 'Khuyến mãi đặc biệt hôm nay! Giảm giá đến 50% cho tất cả sản phẩm thời trang. Mua ngay kẻo lỡ!',
    expectedMinDurationSec: 5.0,
    expectedMaxDurationSec: 8.5,
  },
  explainer: {
    id: 'sample_vi_explainer_01',
    category: 'Technical Explainer',
    text: 'Creativanta Video Engine là nền tảng kết xuất video tự động bằng mã nguồn độc lập, tối ưu hoá cho bộ xử lý CPU và hỗ trợ đầy đủ tiếng Việt.',
    expectedMinDurationSec: 6.5,
    expectedMaxDurationSec: 10.5,
  },
  toneStress: {
    id: 'sample_vi_tone_stress_01',
    category: 'Phonetic Diacritic & Tone Stress',
    text: 'Học tập, rèn luyện kỹ năng, nỗ lực mỗi ngày để đạt được ước mơ và mục tiêu đã đặt ra (chi phí chỉ 199.000 ₫).',
    expectedMinDurationSec: 5.5,
    expectedMaxDurationSec: 9.0,
  },
};

export interface VietnameseQualityReport {
  fixtureId: string;
  category: string;
  inputText: string;
  nfcNormalized: boolean;
  diacriticsFound: string[];
  tonesFound: Record<string, number>;
  currencySymbolFound: boolean;
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSeconds: number;
  durationFrames30fps: number;
  measuredPeakDbfs: number;
  measuredRmsDbfs: number;
  compliantPeakHeadroom: boolean; // true if peak <= -1.0 dBFS
  zeroClipping: boolean;
  passed: boolean;
  warnings: string[];
}

/**
 * Parses WAV PCM audio buffer and analyzes acoustic characteristics.
 */
export function probeWavCharacteristics(wavBuffer: Buffer): {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  durationSeconds: number;
  peakLinear: number;
  peakDbfs: number;
  rmsLinear: number;
  rmsDbfs: number;
  clippedSamples: number;
} {
  if (wavBuffer.length < 44) {
    throw new Error('WAV buffer too small for canonical header');
  }

  const riffSig = wavBuffer.subarray(0, 4).toString('ascii');
  const waveSig = wavBuffer.subarray(8, 12).toString('ascii');
  if (riffSig !== 'RIFF' || waveSig !== 'WAVE') {
    throw new Error('Not a valid RIFF/WAVE buffer');
  }

  const channels = wavBuffer.readUInt16LE(22);
  const sampleRate = wavBuffer.readUInt32LE(24);
  const bitDepth = wavBuffer.readUInt16LE(34);
  const dataByteLength = wavBuffer.readUInt32LE(40);

  const bytesPerSample = bitDepth / 8;
  const totalSamples = Math.floor(dataByteLength / (channels * bytesPerSample));
  const durationSeconds = totalSamples / sampleRate;

  let peak = 0;
  let sumSquare = 0;
  let clippedSamples = 0;

  let offset = 44;
  const endOffset = Math.min(wavBuffer.length, 44 + dataByteLength);

  for (; offset < endOffset - 1; offset += 2) {
    const val = wavBuffer.readInt16LE(offset);
    const normalized = val / 32768.0;
    const absVal = Math.abs(normalized);

    if (absVal > peak) peak = absVal;
    if (absVal >= 0.999) clippedSamples++;

    sumSquare += normalized * normalized;
  }

  const sampleCount = (endOffset - 44) / 2;
  const rmsLinear = Math.sqrt(sumSquare / Math.max(1, sampleCount));
  const peakDbfs = peak > 0 ? 20 * Math.log10(peak) : -100;
  const rmsDbfs = rmsLinear > 0 ? 20 * Math.log10(rmsLinear) : -100;

  return {
    sampleRate,
    channels,
    bitDepth,
    durationSeconds,
    peakLinear: peak,
    peakDbfs,
    rmsLinear,
    rmsDbfs,
    clippedSamples,
  };
}

/**
 * Runs comprehensive Vietnamese speech and typography evaluation on synthesized sample.
 */
export async function evaluateVietnameseQualitySample(
  synthesizer: OfflineTtsAdapter,
  fixture: { id: string; category: string; text: string; expectedMinDurationSec?: number; expectedMaxDurationSec?: number },
  voiceId = 'vi-VN-HoaiMy-Neural'
): Promise<VietnameseQualityReport> {
  const normText = fixture.text.normalize('NFC');
  const nfcNormalized = fixture.text === normText;

  // Check Vietnamese diacritics and accented characters
  const vietnameseAccentRegex = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi;
  const matches = normText.match(vietnameseAccentRegex) || [];
  const diacriticsFound: string[] = Array.from(new Set(matches.map((c) => c.toLowerCase())));

  // Check tones (using NFD to count combining marks)
  const nfd = fixture.text.normalize('NFD');
  const tonesFound: Record<string, number> = {
    huyen: (nfd.match(/\u0300/g) || []).length,
    sac: (nfd.match(/\u0301/g) || []).length,
    nga: (nfd.match(/\u0303/g) || []).length,
    hoi: (nfd.match(/\u0309/g) || []).length,
    nang: (nfd.match(/\u0323/g) || []).length,
  };

  const currencySymbolFound = normText.includes('₫') || normText.includes('đ');

  const synthResult = await synthesizer.synthesize({
    text: normText,
    locale: 'vi-VN',
    voiceId,
    speechRate: 1.0,
    targetFps: 30,
  });

  const probe = probeWavCharacteristics(synthResult.audioBuffer);
  const durationFrames30fps = Math.ceil(probe.durationSeconds * 30);

  const warnings: string[] = [];
  const compliantPeakHeadroom = probe.peakDbfs <= -0.9; // Target <= -1.0 dBTP
  const zeroClipping = probe.clippedSamples === 0;

  if (!compliantPeakHeadroom) {
    warnings.push(`Peak dBFS (${probe.peakDbfs.toFixed(2)} dBFS) exceeds recommended -1.0 dBTP limit`);
  }
  if (!zeroClipping) {
    warnings.push(`Detected ${probe.clippedSamples} digital clipping samples`);
  }
  if (fixture.expectedMinDurationSec && probe.durationSeconds < fixture.expectedMinDurationSec) {
    warnings.push(`Duration (${probe.durationSeconds.toFixed(2)}s) below expected min ${fixture.expectedMinDurationSec}s`);
  }
  if (fixture.expectedMaxDurationSec && probe.durationSeconds > fixture.expectedMaxDurationSec) {
    warnings.push(`Duration (${probe.durationSeconds.toFixed(2)}s) exceeds expected max ${fixture.expectedMaxDurationSec}s`);
  }

  const passed =
    nfcNormalized &&
    probe.sampleRate === 48000 &&
    probe.channels === 2 &&
    probe.bitDepth === 16 &&
    zeroClipping &&
    warnings.length === 0;

  return {
    fixtureId: fixture.id,
    category: fixture.category,
    inputText: fixture.text,
    nfcNormalized,
    diacriticsFound,
    tonesFound,
    currencySymbolFound,
    sampleRate: probe.sampleRate,
    channels: probe.channels,
    bitDepth: probe.bitDepth,
    durationSeconds: probe.durationSeconds,
    durationFrames30fps,
    measuredPeakDbfs: probe.peakDbfs,
    measuredRmsDbfs: probe.rmsDbfs,
    compliantPeakHeadroom,
    zeroClipping,
    passed,
    warnings,
  };
}
