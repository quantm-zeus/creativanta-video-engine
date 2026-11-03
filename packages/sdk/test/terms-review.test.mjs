import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TermsReviewRegistry,
  TtsServiceImpl,
  TermsNotReviewedError,
} from '../dist/index.js';

test('Terms Review: Default Reviewed Voices Pass', () => {
  const registry = new TermsReviewRegistry(true);

  // 1. HoaiMy Vietnamese female
  assert.equal(
    registry.isVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural'),
    true
  );
  const revHoaiMy = registry.assertVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural');
  assert.equal(revHoaiMy.status, 'active');
  assert.equal(revHoaiMy.commercialTermsAccepted, true);
  assert.equal(revHoaiMy.voiceConsentVerified, true);
  assert.equal(revHoaiMy.impersonationProhibited, true);
  assert.equal(revHoaiMy.licenseBasis, 'open_weights_permissive');

  // 2. NamMinh Vietnamese male
  assert.equal(
    registry.isVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-NamMinh-Neural'),
    true
  );

  // 3. Jenny English female
  assert.equal(
    registry.isVoiceApproved('cve-offline-tts', 'cve-en-phoneme-v1', 'en-US-Jenny-Neural'),
    true
  );
});

test('Terms Review: Unreviewed Provider Rejection (UNREVIEWED_PROVIDER_TERMS)', () => {
  const registry = new TermsReviewRegistry(false); // No pre-seeded reviews

  assert.equal(
    registry.isVoiceApproved('third-party-unreviewed', 'model-x', 'voice-unauthorized'),
    false
  );

  assert.throws(
    () => {
      registry.assertVoiceApproved('third-party-unreviewed', 'model-x', 'voice-unauthorized');
    },
    (err) => {
      assert.ok(err instanceof TermsNotReviewedError);
      assert.equal(err.code, 'UNREVIEWED_PROVIDER_TERMS');
      return true;
    }
  );
});

test('Terms Review: Unreviewed Voice Blocks Synthesis Execution', async () => {
  const registry = new TermsReviewRegistry(false); // Empty registry
  const service = new TtsServiceImpl({ termsRegistry: registry });

  await assert.rejects(
    async () => {
      await service.synthesize({
        text: 'Nội dung kiểm tra bản quyền giọng đọc',
        locale: 'vi-VN',
        voiceId: 'vi-VN-HoaiMy-Neural',
      });
    },
    (err) => {
      assert.ok(err instanceof TermsNotReviewedError);
      assert.equal(err.code, 'UNREVIEWED_PROVIDER_TERMS');
      return true;
    }
  );
});

test('Terms Review: Revoked Review Entry Blocks Voice', () => {
  const registry = new TermsReviewRegistry(true);

  // Assert HoaiMy approved initially
  assert.equal(
    registry.isVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural'),
    true
  );

  // Revoke terms
  const revoked = registry.revokeReview('rev_vi_hoaimy_001', 'License expired or challenged');
  assert.equal(revoked, true);

  // Assert now blocked
  assert.equal(
    registry.isVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural'),
    false
  );

  assert.throws(
    () => {
      registry.assertVoiceApproved('cve-offline-tts', 'cve-vi-phoneme-v1', 'vi-VN-HoaiMy-Neural');
    },
    (err) => {
      assert.ok(err instanceof TermsNotReviewedError);
      assert.equal(err.code, 'UNREVIEWED_PROVIDER_TERMS');
      return true;
    }
  );
});

test('Terms Review: Missing Consent or Commercial Terms Rejected', () => {
  const registry = new TermsReviewRegistry(false);

  // Register review without commercial terms accepted
  registry.registerReview({
    reviewId: 'rev_bad_01',
    providerId: 'provider_test',
    modelId: 'model_test',
    voiceId: 'voice_no_commercial',
    locale: 'vi-VN',
    commercialTermsReviewed: true,
    commercialTermsAccepted: false, // NOT ACCEPTED
    voiceConsentVerified: true,
    impersonationProhibited: true,
    dataExfiltrationGuarded: true,
    licenseBasis: 'commercial_licensed',
    reviewedBy: 'legal-role',
    reviewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000000).toISOString(),
    status: 'active',
    notes: 'Commercial terms rejected by legal team',
  });

  assert.throws(
    () => {
      registry.assertVoiceApproved('provider_test', 'model_test', 'voice_no_commercial');
    },
    (err) => {
      assert.ok(err instanceof TermsNotReviewedError);
      return true;
    }
  );

  // Register review without voice consent verified
  registry.registerReview({
    reviewId: 'rev_bad_02',
    providerId: 'provider_test',
    modelId: 'model_test',
    voiceId: 'voice_no_consent',
    locale: 'vi-VN',
    commercialTermsReviewed: true,
    commercialTermsAccepted: true,
    voiceConsentVerified: false, // NOT VERIFIED (anti-impersonation failure)
    impersonationProhibited: false,
    dataExfiltrationGuarded: true,
    licenseBasis: 'commercial_licensed',
    reviewedBy: 'legal-role',
    reviewedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000000).toISOString(),
    status: 'active',
    notes: 'Voice consent missing',
  });

  assert.throws(
    () => {
      registry.assertVoiceApproved('provider_test', 'model_test', 'voice_no_consent');
    },
    (err) => {
      assert.ok(err instanceof TermsNotReviewedError);
      return true;
    }
  );
});
