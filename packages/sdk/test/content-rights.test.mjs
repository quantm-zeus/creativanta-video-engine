import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentRightsRegistry,
  SEEDED_RIGHTS_RECORDS,
  checkAntiContamination,
} from '../dist/rights/index.js';

test('Content Rights: Seeded P0-03 Curated Assets All Have Active Commercial Rights', () => {
  const registry = new ContentRightsRegistry();
  assert.ok(SEEDED_RIGHTS_RECORDS.length >= 17);

  for (const record of SEEDED_RIGHTS_RECORDS) {
    const fetched = registry.get(record.assetId);
    assert.ok(fetched, `Asset ${record.assetId} should be present in registry`);
    assert.equal(fetched.status, 'active');
    assert.equal(fetched.commercialUseAllowed, true);
    assert.equal(fetched.commercialEmbeddingAllowed, true);
    assert.ok(fetched.license.length > 0);
    assert.ok(fetched.attribution.length > 0);
    assert.ok(fetched.sha256.length === 64);
  }
});

test('Content Rights: Anti-Contamination Rules Block Prohibited Sources', () => {
  // 1. HyperFrames / HeyGen
  const r1 = checkAntiContamination('https://heygen.com/marketing/promo.mp4');
  assert.equal(r1.compliant, false);
  assert.ok(r1.violation?.sourceName.includes('HeyGen'));

  // 2. Remotion stock demo
  const r2 = checkAntiContamination('https://remotion.dev/example/stock-clip.mp4');
  assert.equal(r2.compliant, false);
  assert.ok(r2.violation?.sourceName.includes('Remotion'));

  // 3. VideoFlow / WebAV demo
  const r3 = checkAntiContamination('https://example.com/big_buck_bunny_720p.mp4');
  assert.equal(r3.compliant, false);
  assert.ok(r3.violation?.sourceName.includes('VideoFlow'));

  // 4. Remote CDN Google Fonts
  const r4 = checkAntiContamination('https://fonts.googleapis.com/css2?family=Roboto');
  assert.equal(r4.compliant, false);
  assert.ok(r4.violation?.sourceName.includes('Google Fonts'));

  // 5. Implicit audio extraction
  const r5 = checkAntiContamination('internal://workflow/video-demux-audio.wav');
  assert.equal(r5.compliant, false);
  assert.ok(r5.violation?.sourceName.includes('Implicit'));

  // 6. Compliant local asset
  const r6 = checkAntiContamination('internal://creativanta/art/renders/hero.png');
  assert.equal(r6.compliant, true);
});

test('Content Rights: Tenant Asset Assertion with Legal Metadata Validation', () => {
  const registry = new ContentRightsRegistry();

  // Valid assertion
  const customAsset = registry.assertRights({
    assetId: 'ast_tenant_hero_image',
    category: 'image',
    basis: 'owned',
    license: 'CC-BY-4.0',
    attribution: 'Photo by Acme Brand Studio',
    source: 'https://cdn.acme.com/assets/hero.png',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    tenantId: 'tnt_acme_corp',
  });

  assert.equal(customAsset.status, 'active');
  assert.equal(registry.get('ast_tenant_hero_image')?.tenantId, 'tnt_acme_corp');

  // Invalid assertion: missing license
  assert.throws(
    () => registry.assertRights({
      assetId: 'ast_invalid_1',
      category: 'image',
      basis: 'owned',
      license: '',
      attribution: 'Attribution',
      source: 'https://example.com/asset.png',
      sha256: 'abc',
      commercialUseAllowed: true,
      commercialEmbeddingAllowed: true,
    }),
    /License name is mandatory/
  );

  // Invalid assertion: contaminated source
  assert.throws(
    () => registry.assertRights({
      assetId: 'ast_invalid_2',
      category: 'image',
      basis: 'owned',
      license: 'Proprietary',
      attribution: 'Attribution',
      source: 'https://fonts.googleapis.com/css2?family=Open+Sans',
      sha256: 'abc',
      commercialUseAllowed: true,
      commercialEmbeddingAllowed: true,
    }),
    /Anti-contamination violation/
  );
});

test('Content Rights: Asset Revocation / Takedown Notice Blocks Composition', () => {
  const registry = new ContentRightsRegistry();

  // Register clean asset
  registry.assertRights({
    assetId: 'ast_disputed_artwork',
    category: 'image',
    basis: 'licensed',
    license: 'CC-BY-4.0',
    attribution: 'Artist X',
    source: 'https://example.com/art.png',
    sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
  });

  const composition = {
    schema_version: '1.0',
    canvas: { width: 720, height: 1280, background: '#000000' },
    fps: { num: 30, den: 1 },
    duration_frames: 300,
    seed: 1,
    locale: 'vi-VN',
    fonts: [{ id: 'font_reg', asset_id: 'ast_font_inter_regular', sha256: 'abc', family: 'Inter', weight: 400, style: 'normal' }],
    scenes: [
      {
        id: 's1',
        revision: 1,
        start_frame: 0,
        duration_frames: 300,
        engine: 'html-v1',
        transition_out: { type: 'cut', duration_frames: 0 },
        layers: [
          {
            id: 'l1',
            type: 'image',
            asset_id: 'ast_disputed_artwork',
            start_frame: 0,
            duration_frames: 300,
            box: { x: 0, y: 0, width: 720, height: 1280 },
          },
        ],
      },
    ],
    audio_tracks: [],
    subtitles: [],
  };

  // Initially compliant
  const audit1 = registry.auditComposition(composition);
  assert.equal(audit1.valid, true);

  // Issue takedown notice / revoke asset
  registry.revoke('ast_disputed_artwork', 'DMCA takedown notice received from copyright owner', 'legal_officer');

  // Now audit should fail with ASSET_RIGHTS_REVOKED
  const audit2 = registry.auditComposition(composition);
  assert.equal(audit2.valid, false);
  const revokedViolation = audit2.violations.find((v) => v.code === 'ASSET_RIGHTS_REVOKED');
  assert.ok(revokedViolation);
  assert.ok(revokedViolation.message.includes('DMCA takedown notice'));
});

test('Content Rights: Detects Expired Licenses & Non-Commercial Prohibitions', () => {
  const registry = new ContentRightsRegistry();

  // Expired license
  registry.assertRights({
    assetId: 'ast_expired_asset',
    category: 'image',
    basis: 'licensed',
    license: 'Time-Limited-2025',
    attribution: 'Licensor Inc.',
    source: 'https://example.com/expired.png',
    sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    expiresAt: '2025-01-01T00:00:00Z',
  });

  const expiredViolations = registry.auditAsset('ast_expired_asset');
  assert.ok(expiredViolations.some((v) => v.code === 'ASSET_RIGHTS_EXPIRED'));

  // Non-commercial license
  registry.assertRights({
    assetId: 'ast_noncommercial_asset',
    category: 'image',
    basis: 'licensed',
    license: 'CC-BY-NC-4.0',
    attribution: 'NonCommercial Creator',
    source: 'https://example.com/nc.png',
    sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    commercialUseAllowed: false,
    commercialEmbeddingAllowed: true,
  });

  const ncViolations = registry.auditAsset('ast_noncommercial_asset');
  assert.ok(ncViolations.some((v) => v.code === 'COMMERCIAL_USE_PROHIBITED'));
});

test('Content Rights: Voice Consent Verification for Voiceover Narration', () => {
  const registry = new ContentRightsRegistry();

  // Voice asset without consent basis
  registry.assertRights({
    assetId: 'ast_voice_unconsented',
    category: 'audio',
    basis: 'licensed',
    license: 'Proprietary',
    attribution: 'Anonymous Speaker',
    source: 'internal://creativanta/audio/voice/voiceover.wav',
    sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
  });

  const voiceViolations = registry.auditAsset('ast_voice_unconsented');
  assert.ok(voiceViolations.some((v) => v.code === 'VOICE_CONSENT_MISSING'));
});
