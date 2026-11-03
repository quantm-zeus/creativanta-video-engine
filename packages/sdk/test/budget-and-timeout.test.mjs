import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TtsServiceImpl,
  TtsBudgetLimiter,
  TtsBudgetExceededError,
  TtsTimeoutError,
} from '../dist/index.js';

test('Budget & Spend: Character Limit Per Request Guard', async () => {
  const limiter = new TtsBudgetLimiter({
    maxCharactersPerRequest: 100, // Small limit for testing
  });
  const service = new TtsServiceImpl({ budgetLimiter: limiter });

  // 1. Within limit (50 chars)
  const res = await service.synthesize({
    text: 'Đoạn văn bản ngắn trong giới hạn cho phép.',
    locale: 'vi-VN',
  });
  assert.ok(res.assetId);

  // 2. Exceeding limit (150 chars)
  const longText = 'Đây là một đoạn văn bản rất dài cố tình vượt qua giới hạn 100 ký tự được cấu hình cho bài kiểm tra này nhằm đảm bảo hệ thống chặn đứng yêu cầu tốn kém tài nguyên.';
  assert.ok(longText.length > 100);

  await assert.rejects(
    async () => {
      await service.synthesize({
        text: longText,
        locale: 'vi-VN',
      });
    },
    (err) => {
      assert.ok(err instanceof TtsBudgetExceededError);
      assert.equal(err.code, 'TTS_BUDGET_EXCEEDED');
      return true;
    }
  );
});

test('Budget & Spend: Monthly Quota Tracking and Exhaustion', async () => {
  const limiter = new TtsBudgetLimiter({
    maxCharactersPerRequest: 1000,
    maxCharactersPerTenantPerMonth: 80, // Total quota = 80 chars
  });
  const service = new TtsServiceImpl({ budgetLimiter: limiter });
  const tenantId = 'tenant_quota_test';

  // Request 1: 50 characters -> consumes 50, remaining 30
  const text1 = 'Yêu cầu thứ nhất tiêu thụ năm mươi ký tự mẫu.';
  await service.synthesize({
    text: text1,
    locale: 'vi-VN',
    tenantId,
  });

  const usage1 = limiter.getTenantUsage(tenantId);
  assert.ok(usage1);
  assert.equal(usage1.totalCharacters, text1.length);
  assert.equal(usage1.totalSyntheses, 1);

  // Request 2: 40 characters -> total 90 > 80 limit -> REJECTED
  const text2 = 'Yêu cầu thứ hai tiếp tục thêm bốn mươi ký tự.';
  await assert.rejects(
    async () => {
      await service.synthesize({
        text: text2,
        locale: 'vi-VN',
        tenantId,
      });
    },
    (err) => {
      assert.ok(err instanceof TtsBudgetExceededError);
      assert.equal(err.code, 'TTS_BUDGET_EXCEEDED');
      assert.ok(err.message.includes('monthly character budget'));
      return true;
    }
  );
});

test('Timeout Guard: Synthesis Timeout Aborts Hanging Request', async () => {
  const slowAdapter = {
    providerId: 'cve-slow-mock',
    providerName: 'Slow Mock Adapter',
    supportedLocales: ['vi-VN'],
    async getAvailableVoices() {
      return [
        {
          id: 'vi-slow-voice',
          name: 'Slow Voice',
          locale: 'vi-VN',
          gender: 'female',
          providerId: 'cve-slow-mock',
          modelId: 'cve-slow-model',
          sampleRate: 48000,
          channels: 2,
          description: 'Hanging mock',
        },
      ];
    },
    async synthesize(req, signal) {
      // Simulate delay longer than timeout
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve({
            audioBuffer: Buffer.alloc(100),
            durationSeconds: 1.0,
            sampleRate: 48000,
            channels: 2,
            model: 'cve-slow-model',
            modelVersion: '1.0',
            voiceName: 'Slow Voice',
          });
        }, 500);

        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });
    },
    estimateCost(chars) {
      return 0.001;
    },
  };

  const service = new TtsServiceImpl({
    budgetLimiter: new TtsBudgetLimiter({
      defaultTimeoutMs: 50, // 50ms timeout
    }),
    defaultAdapter: slowAdapter,
  });

  // Register terms review for slow adapter
  service.termsRegistry.registerReview({
    reviewId: 'rev_slow_001',
    providerId: 'cve-slow-mock',
    modelId: 'cve-slow-model',
    voiceId: 'vi-slow-voice',
    locale: 'vi-VN',
    commercialTermsReviewed: true,
    commercialTermsAccepted: true,
    voiceConsentVerified: true,
    impersonationProhibited: true,
    dataExfiltrationGuarded: true,
    licenseBasis: 'open_weights_permissive',
    reviewedBy: 'legal-role',
    reviewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 100000).toISOString(),
    status: 'active',
    notes: 'Test slow mock',
  });

  await assert.rejects(
    async () => {
      await service.synthesize(
        {
          text: 'Văn bản kiểm tra thời gian chờ timeout',
          locale: 'vi-VN',
          voiceId: 'vi-slow-voice',
        },
        50 // 50ms timeout
      );
    },
    (err) => {
      assert.ok(err instanceof TtsTimeoutError);
      assert.equal(err.code, 'TTS_TIMEOUT');
      return true;
    }
  );
});
