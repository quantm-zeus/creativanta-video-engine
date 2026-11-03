import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TtsServiceImpl,
  MemoryTtsCache,
  computeTtsCacheKey,
} from '../dist/index.js';

test('Cache: Deterministic Content-Addressable Key Computation', () => {
  const req1 = {
    text: 'Creativanta Video Engine',
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
    speechRate: 1.0,
    pitch: 0.0,
    volumeDb: 0.0,
    targetFps: 30,
  };

  const req2 = {
    text: 'Creativanta Video Engine'.normalize('NFD'), // Decomposed Unicode
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
    speechRate: 1.0,
    pitch: 0.0,
    volumeDb: 0.0,
    targetFps: 30,
  };

  const key1 = computeTtsCacheKey('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural', req1);
  const key2 = computeTtsCacheKey('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural', req2);

  assert.equal(key1.length, 64, 'Key must be 64 lowercase hex characters');
  assert.equal(key1, key2, 'NFC normalized equivalent text must produce identical cache keys');
});

test('Cache: Cache Hit Returns Cached Buffer and Provenance (fromCache: true)', async () => {
  const cache = new MemoryTtsCache();
  const service = new TtsServiceImpl({ cache });

  const text = 'Kiểm tra cơ chế lưu đệm bộ nhớ đệm cache.';

  // 1. Initial synthesis -> cache miss
  const res1 = await service.synthesize({
    text,
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
  });
  assert.equal(res1.fromCache, false);

  const stats1 = cache.getStats();
  assert.equal(stats1.misses, 1);
  assert.equal(stats1.hits, 0);
  assert.equal(stats1.entriesCount, 1);

  // 2. Second synthesis with identical parameters -> cache hit
  const res2 = await service.synthesize({
    text,
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
  });
  assert.equal(res2.fromCache, true);
  assert.equal(res2.assetId, res1.assetId);
  assert.equal(res2.audioSha256, res1.audioSha256);
  assert.deepEqual(res2.audioBuffer, res1.audioBuffer);

  const stats2 = cache.getStats();
  assert.equal(stats2.hits, 1);
  assert.equal(stats2.misses, 1);
});

test('Provenance: Complete and Auditable Metadata Generation', async () => {
  const service = new TtsServiceImpl();
  const text = 'Bản ghi nguồn gốc xuất xứ âm thanh (provenance metadata).';

  const res = await service.synthesize({
    text,
    locale: 'vi-VN',
    voiceId: 'vi-VN-HoaiMy-Neural',
    tenantId: 'tenant_audit_test',
  });

  const p = res.provenance;
  assert.ok(p);
  assert.equal(p.assetId, res.assetId);
  assert.equal(p.provider, 'cve-offline-tts');
  assert.equal(p.model, 'cve-vi-phoneme-v1');
  assert.equal(p.modelVersion, '1.0.0');
  assert.equal(p.voiceId, 'vi-VN-HoaiMy-Neural');
  assert.equal(p.voiceName, 'Hoài My (Vietnamese Standard Female)');
  assert.equal(p.locale, 'vi-VN');
  assert.equal(p.inputTextSha256.length, 64);
  assert.equal(p.characterCount, text.length);
  assert.ok(p.wordCount > 5);
  assert.equal(p.audioSha256, res.audioSha256);
  assert.equal(p.audioByteLength, res.byteLength);
  assert.ok(p.durationSeconds > 0);
  assert.ok(p.durationFrames > 0);
  assert.equal(p.sampleRate, 48000);
  assert.equal(p.channels, 2);
  assert.equal(p.termsReviewStatus, 'reviewed_approved');
  assert.equal(p.termsReviewId, 'rev_vi_hoaimy_001');
  assert.equal(p.termsReviewedBy, 'legal-compliance-role');
  assert.equal(p.voiceConsentBasis, 'open_weights_permissive');
  assert.equal(p.impersonationProhibited, true);
  assert.ok(p.synthesizedAt);
  assert.ok(p.estimatedCostUsd >= 0);
});
