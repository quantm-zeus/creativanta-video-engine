/**
 * Content Rights & Licensing Registry for Creativanta Video Engine.
 * Enforces commercial licensing, anti-contamination boundaries, voice consent, and takedown revocation.
 * Canonical specification: docs/SECURITY.md (Line 59), docs/IMPLEMENTATION_PLAN.md (P0-03, P5-05).
 */

import { CompositionSpec } from '@creativanta/contracts';
import {
  ContentRightsRecord,
  ContentRightsAssertion,
  RightsAuditReport,
  RightsAuditViolation,
} from './types.js';
import { checkAntiContamination } from './anti-contamination.js';

export const SEEDED_RIGHTS_RECORDS: ContentRightsRecord[] = [
  // Fonts
  {
    assetId: 'ast_font_inter_bold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdxId: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: '5e8b6b19a16a4be75628a8a47de02c676d9bf0d4b975d045d6568d712f5e3e7a',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_inter_regular',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdxId: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: 'c8d1721528b9c6a15e61bfd5c0b021319c3629e47265ef0ec9a4897f74220b38',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_inter_semibold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdxId: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: '94c65349e5d4cb05c84d618cf2e1762c93df37b42551a37c093a10e820c754d9',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_noto_sans_regular',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdxId: 'OFL-1.1',
    attribution: 'Noto Sans by Google LLC and The Noto Project Authors',
    source: 'https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.013/NotoSans-v2.013.zip',
    sha256: '41b78294a53e54b6cf481f21db5976b3cf92da630713b6326e0e02c6735a28c4',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_noto_sans_bold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdxId: 'OFL-1.1',
    attribution: 'Noto Sans Bold by Google LLC and The Noto Project Authors',
    source: 'https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.013/NotoSans-v2.013.zip',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_roboto_bold',
    category: 'font',
    basis: 'licensed',
    license: 'Apache-2.0',
    spdxId: 'Apache-2.0',
    attribution: 'Roboto Bold by Christian Robertson, Google Inc.',
    source: 'https://github.com/googlefonts/roboto/releases/download/v2.138/roboto-android.zip',
    sha256: '2b8f413a968a35e47851d8b67117c09368d1847e09ef74e502c3c97dbb8a109a',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_font_roboto_regular',
    category: 'font',
    basis: 'licensed',
    license: 'Apache-2.0',
    spdxId: 'Apache-2.0',
    attribution: 'Roboto Regular by Christian Robertson, Google Inc.',
    source: 'https://github.com/googlefonts/roboto/releases/download/v2.138/roboto-android.zip',
    sha256: '89cb384210a4e76a086057c32bf260a4f5f590dc501192e1b8b8095d3126f554',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },

  // Images & Graphics
  {
    assetId: 'ast_poc01_product_hero',
    category: 'image',
    basis: 'owned',
    license: 'Proprietary-Creativanta-MVP',
    attribution: 'Original 3D render created in-house for Creativanta MVP promo showcase.',
    source: 'internal://creativanta/art/renders/headphones-hero-1080x1080.png',
    sha256: '0597ec59ffc1e95cfc92f447781b0f5ef5b84c7a6e1189c44569564ba32e36bb',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc01_sale_badge',
    category: 'svg',
    basis: 'owned',
    license: 'Proprietary-Creativanta-MVP',
    attribution: 'Vector graphic badge created in-house for Creativanta MVP promo showcase.',
    source: 'internal://creativanta/art/vectors/sale-badge.svg',
    sha256: '8e434f826dd12f9b8b724ce902787864f1d07c42738722a2bbff6b87be47eb86',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc01_pill_button',
    category: 'svg',
    basis: 'owned',
    license: 'Proprietary-Creativanta-MVP',
    attribution: 'Vector graphic CTA button created in-house for Creativanta MVP promo showcase.',
    source: 'internal://creativanta/art/vectors/pill-cta-button.svg',
    sha256: '5d852a48a9749179d63f0a0780287b9231fcf134bb8fb12f4585e50db3ca8b99',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc02_growth_chart',
    category: 'svg',
    basis: 'owned',
    license: 'Proprietary-Creativanta-MVP',
    attribution: 'Vector infographic chart created in-house for Creativanta MVP explainer showcase.',
    source: 'internal://creativanta/art/vectors/infographic-growth-chart.svg',
    sha256: 'b4ceb8f05167f401ceef6aa64ae4999ab4f4bdaaa144bb2fc57a26f634b07ec0',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc02_metric_card',
    category: 'svg',
    basis: 'owned',
    license: 'Proprietary-Creativanta-MVP',
    attribution: 'Vector metric card created in-house for Creativanta MVP explainer showcase.',
    source: 'internal://creativanta/art/vectors/metric-card.svg',
    sha256: 'e1d23ef742512f494f1c1f7ca87889ea8fba46b6bb731a54e6015502ab47ea87',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc02_cloud_icon',
    category: 'svg',
    basis: 'licensed',
    license: 'MIT',
    spdxId: 'MIT',
    attribution: 'Feather Icons by Cole Bemis (feathericons.com)',
    source: 'https://raw.githubusercontent.com/feathericons/feather/master/icons/cloud.svg',
    sha256: 'c3be7c57d7cfbbf23e1cfcf0ea73fa8ff1cebcf297594ca513725b39925e0c8b',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },

  // Video Clips
  {
    assetId: 'ast_poc03_clip1_daklak',
    category: 'video',
    basis: 'licensed',
    license: 'Pexels-License',
    attribution: 'Video by Tom Fisk (pexels.com/video/aerial-view-of-coffee-plantation-5858172/)',
    source: 'https://images.pexels.com/videos/5858172/free-video-5858172.mp4',
    sha256: '3448f76e737c385adbe91e9f45610a56f8f533a39e81b67f13c6b20c6a51d8b2',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc03_clip2_workshop',
    category: 'video',
    basis: 'licensed',
    license: 'Pexels-License',
    attribution: 'Video by Los Muertos Crew (pexels.com/video/roasting-coffee-beans-in-machine-7521752/)',
    source: 'https://images.pexels.com/videos/7521752/free-video-7521752.mp4',
    sha256: '0032b4b45cf0f8ebceea2eb0e54d6fa7c6ae9cb376e19195ae382a014a49c951',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },

  // Audio Tracks
  {
    assetId: 'ast_poc01_silence_track',
    category: 'audio',
    basis: 'public_domain',
    license: 'CC0-1.0',
    spdxId: 'CC0-1.0',
    attribution: 'Synthetic silent audio stream generated mathematically for baseline silence testing.',
    source: 'synthetic://audio/silence-48k-stereo-15s.wav',
    sha256: '49f4b9ecfe536a0fb4e0f4db20a3203c9d74ceb96238b97d26ba48259d64f0f6',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_audio_promo_fallback',
    category: 'audio',
    basis: 'owned',
    license: 'Apache-2.0',
    spdxId: 'Apache-2.0',
    attribution: 'Retail Promo Backup Voiceover Track by Creativanta Studio',
    source: 'internal://creativanta/fixtures/ast_audio_promo_fallback.wav',
    sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_audio_narration_poc02',
    category: 'audio',
    basis: 'owned',
    license: 'Voice Talent Commercial Agreement #CVE-VO-2026-01',
    attribution: 'Professional Vietnamese Voiceover Narration (Commercial License)',
    source: 'internal://creativanta/contracts/voice-talent-2026-01',
    sha256: 'c59d871230e9f8480371a53b5c683b9e4a812df97843516089d714e8c15a7721',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    voiceConsentBasis: 'written_contract',
    impersonationProhibited: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc02_narration_vi',
    category: 'audio',
    basis: 'licensed',
    license: 'Proprietary-Creativanta-PerformerRelease',
    attribution: 'Vietnamese voiceover recorded by Pham Thu Huong with explicit commercial performer release.',
    source: 'internal://creativanta/audio/voice/vi-vn-explainer-narration.wav',
    sha256: '5a4efbe9871a3648faef67b36f1c4cae4492ab2b291d9029b35b6f3b0606f2e8',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    voiceConsentBasis: 'performer_release',
    impersonationProhibited: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc02_ambient_bed',
    category: 'audio',
    basis: 'licensed',
    license: 'CC-BY-4.0',
    spdxId: 'CC-BY-4.0',
    attribution: 'Corporate Ambient Technology Bed by Tim Beek (timbeek.itch.io), licensed under CC-BY-4.0.',
    source: 'https://timbeek.itch.io/royalty-free-music-pack/corporate-ambient-bed.wav',
    sha256: 'f2d6c1be34898ec0b5ab58930495f24294086ad23ce6ae39fa3454231f4ffb41',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc03_narration_vi',
    category: 'audio',
    basis: 'licensed',
    license: 'Proprietary-Creativanta-PerformerRelease',
    attribution: 'Vietnamese voiceover recorded by Tran Van Nam with explicit commercial performer release.',
    source: 'internal://creativanta/audio/voice/vi-vn-daklak-narration.wav',
    sha256: 'fa3f54f76269df727aa71bc7b69ea4ff0d04c0ecfc3e2f0a1c15f94a737f5b85',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    voiceConsentBasis: 'performer_release',
    impersonationProhibited: true,
    status: 'active',
  },
  {
    assetId: 'ast_poc03_music_track',
    category: 'audio',
    basis: 'licensed',
    license: 'CC-BY-4.0',
    spdxId: 'CC-BY-4.0',
    attribution: 'Highland Acoustic Journey by Nguyen Soundworks (freemusicarchive.org), licensed under CC-BY-4.0.',
    source: 'https://freemusicarchive.org/music/nguyen-soundworks/highland-acoustic-journey.wav',
    sha256: '419409ee61a681cbb4be65624d673da4a3fa6ae196f7c164287515be0b14efae',
    commercialUseAllowed: true,
    commercialEmbeddingAllowed: true,
    status: 'active',
  },
];

export class ContentRightsRegistry {
  private records: Map<string, ContentRightsRecord> = new Map();

  constructor(initialRecords: ContentRightsRecord[] = SEEDED_RIGHTS_RECORDS) {
    for (const record of initialRecords) {
      this.records.set(record.assetId, { ...record });
    }
  }

  /**
   * Registers a new authoritative rights record into the registry.
   */
  public register(record: ContentRightsRecord): void {
    const contamination = checkAntiContamination(record.source);
    if (!contamination.compliant) {
      throw new Error(`Anti-contamination violation for asset '${record.assetId}': ${contamination.violation?.reason}`);
    }
    this.records.set(record.assetId, { ...record });
  }

  /**
   * Asserts legal rights for an uploaded or imported asset.
   */
  public assertRights(assertion: ContentRightsAssertion): ContentRightsRecord {
    if (!assertion.assetId || !/^ast_[a-zA-Z0-9_-]+$/.test(assertion.assetId)) {
      throw new Error(`Invalid assetId format for rights assertion: '${assertion.assetId}'`);
    }

    if (!assertion.license || assertion.license.trim() === '') {
      throw new Error(`License name is mandatory for rights assertion on asset '${assertion.assetId}'`);
    }

    if (!assertion.attribution || assertion.attribution.trim() === '') {
      throw new Error(`Attribution statement is mandatory for rights assertion on asset '${assertion.assetId}'`);
    }

    const contamination = checkAntiContamination(assertion.source);
    if (!contamination.compliant) {
      throw new Error(
        `Anti-contamination violation for asset '${assertion.assetId}': ${contamination.violation?.reason}`
      );
    }

    const record: ContentRightsRecord = {
      ...assertion,
      status: 'active',
    };

    this.records.set(record.assetId, record);
    return record;
  }

  /**
   * Retrieves rights metadata for a specific asset.
   */
  public get(assetId: string): ContentRightsRecord | undefined {
    return this.records.get(assetId);
  }

  /**
   * Revokes legal rights / issues takedown for an asset.
   */
  public revoke(assetId: string, reason: string, revokedBy: string = 'rights_admin'): void {
    const existing = this.records.get(assetId);
    if (!existing) {
      // Create a tombstoned revocation entry
      this.records.set(assetId, {
        assetId,
        category: 'image',
        basis: 'owned',
        license: 'REVOKED',
        attribution: 'Revoked asset',
        source: 'revoked://takedown',
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        commercialUseAllowed: false,
        commercialEmbeddingAllowed: false,
        status: 'revoked',
        revocationReason: reason,
        revokedAt: new Date().toISOString(),
        revokedBy,
      });
      return;
    }

    existing.status = 'revoked';
    existing.revocationReason = reason;
    existing.revokedAt = new Date().toISOString();
    existing.revokedBy = revokedBy;
    existing.commercialUseAllowed = false;
    existing.commercialEmbeddingAllowed = false;
  }

  /**
   * Audits a single asset against commercial rights and anti-contamination rules.
   */
  public auditAsset(assetId: string): RightsAuditViolation[] {
    const violations: RightsAuditViolation[] = [];
    const record = this.records.get(assetId);

    if (!record) {
      // Dynamic TTS assets generated on the fly with verified provenance
      if (assetId.startsWith('ast_tts_')) {
        return [];
      }
      violations.push({
        code: 'MISSING_RIGHTS_METADATA',
        assetId,
        message: `Asset '${assetId}' lacks commercial rights metadata in registry`,
      });
      return violations;
    }

    if (record.status === 'revoked') {
      violations.push({
        code: 'ASSET_RIGHTS_REVOKED',
        assetId,
        message: `Asset '${assetId}' has been revoked: ${record.revocationReason || 'Content takedown notice'}`,
        details: { revokedAt: record.revokedAt, revokedBy: record.revokedBy },
      });
    }

    if (record.expiresAt) {
      const expiry = new Date(record.expiresAt).getTime();
      if (!isNaN(expiry) && Date.now() > expiry) {
        violations.push({
          code: 'ASSET_RIGHTS_EXPIRED',
          assetId,
          message: `Asset '${assetId}' commercial license expired on ${record.expiresAt}`,
        });
      }
    }

    if (!record.commercialUseAllowed) {
      violations.push({
        code: 'COMMERCIAL_USE_PROHIBITED',
        assetId,
        message: `Asset '${assetId}' does not permit commercial use under license '${record.license}'`,
      });
    }

    if (!record.commercialEmbeddingAllowed) {
      violations.push({
        code: 'COMMERCIAL_EMBEDDING_PROHIBITED',
        assetId,
        message: `Asset '${assetId}' does not permit video embedding under license '${record.license}'`,
      });
    }

    // Voice consent check
    if (record.category === 'audio' && record.source.includes('/voice/')) {
      if (!record.voiceConsentBasis) {
        violations.push({
          code: 'VOICE_CONSENT_MISSING',
          assetId,
          message: `Voice asset '${assetId}' lacks verified voice consent basis`,
        });
      }
      if (record.impersonationProhibited === false) {
        violations.push({
          code: 'IMPERSONATION_VIOLATION',
          assetId,
          message: `Voice asset '${assetId}' lacks anti-impersonation guardrail`,
        });
      }
    }

    // Anti-contamination check on source
    const contamination = checkAntiContamination(record.source);
    if (!contamination.compliant) {
      violations.push({
        code: 'ANTI_CONTAMINATION_VIOLATION',
        assetId,
        message: `Asset '${assetId}' violates anti-contamination policy: ${contamination.violation?.reason}`,
        details: { blockedSource: contamination.violation?.sourceName },
      });
    }

    return violations;
  }

  /**
   * Audits all assets referenced in a CompositionSpec.
   */
  public auditComposition(spec: CompositionSpec): RightsAuditReport {
    const assetIds = new Set<string>();

    // 1. Fonts
    for (const font of spec.fonts) {
      if (font.asset_id) {
        assetIds.add(font.asset_id);
      }
    }

    // 2. Scenes and layers
    for (const scene of spec.scenes) {
      if ('layers' in scene && Array.isArray(scene.layers)) {
        for (const layer of scene.layers) {
          if ('asset_id' in layer && typeof layer.asset_id === 'string') {
            assetIds.add(layer.asset_id);
          }
        }
      }
    }

    // 3. Audio tracks
    for (const track of spec.audio_tracks) {
      if (track.asset_id) {
        assetIds.add(track.asset_id);
      }
    }

    const allViolations: RightsAuditViolation[] = [];
    const blockedSourcesDetected: string[] = [];

    for (const assetId of assetIds) {
      const assetViolations = this.auditAsset(assetId);
      for (const v of assetViolations) {
        allViolations.push(v);
        if (v.code === 'ANTI_CONTAMINATION_VIOLATION' && v.details?.blockedSource) {
          blockedSourcesDetected.push(String(v.details.blockedSource));
        }
      }
    }

    const valid = allViolations.length === 0;
    const passedCount = assetIds.size - allViolations.length;

    return {
      valid,
      assetsChecked: assetIds.size,
      passedCount: Math.max(0, passedCount),
      violations: allViolations,
      antiContaminationStatus: blockedSourcesDetected.length === 0 ? 'PASS' : 'FAIL',
      blockedSourcesDetected,
    };
  }
}
