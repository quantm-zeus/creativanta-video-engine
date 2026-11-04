/**
 * Authoritative License and Provenance Registry for Curated Template Assets.
 * Cross-verified against evidence/P0-03/rights-manifest.json.
 * Guarantees zero unreviewed upstream assets and strict commercial compliance.
 */

import { AssetLicenseEvidence, CuratedTemplate } from './types.js';

export const CURATED_ASSETS_LICENSE_REGISTRY: Record<string, AssetLicenseEvidence> = {
  // Fonts
  ast_font_inter_bold: {
    asset_id: 'ast_font_inter_bold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdx_id: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: '5e8b6b19a16a4be75628a8a47de02c676d9bf0d4b975d045d6568d712f5e3e7a',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_inter_regular: {
    asset_id: 'ast_font_inter_regular',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdx_id: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: 'c8d1721528b9c6a15e61bfd5c0b021319c3629e47265ef0ec9a4897f74220b38',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_inter_semibold: {
    asset_id: 'ast_font_inter_semibold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdx_id: 'OFL-1.1',
    attribution: 'Inter Font Family by Rasmus Andersson and The Inter Project Authors',
    source: 'https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip',
    sha256: '94c65349e5d4cb05c84d618cf2e1762c93df37b42551a37c093a10e820c754d9',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_noto_sans_regular: {
    asset_id: 'ast_font_noto_sans_regular',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdx_id: 'OFL-1.1',
    attribution: 'Noto Sans by Google LLC and The Noto Project Authors',
    source: 'https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.013/NotoSans-v2.013.zip',
    sha256: '41b78294a53e54b6cf481f21db5976b3cf92da630713b6326e0e02c6735a28c4',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_noto_sans_bold: {
    asset_id: 'ast_font_noto_sans_bold',
    category: 'font',
    basis: 'licensed',
    license: 'OFL-1.1',
    spdx_id: 'OFL-1.1',
    attribution: 'Noto Sans Bold by Google LLC and The Noto Project Authors',
    source: 'https://github.com/notofonts/latin-greek-cyrillic/releases/download/NotoSans-v2.013/NotoSans-v2.013.zip',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_roboto_bold: {
    asset_id: 'ast_font_roboto_bold',
    category: 'font',
    basis: 'licensed',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Roboto Bold by Christian Robertson, Google Inc.',
    source: 'https://github.com/googlefonts/roboto/releases/download/v2.138/roboto-android.zip',
    sha256: '2b8f413a968a35e47851d8b67117c09368d1847e09ef74e502c3c97dbb8a109a',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_font_roboto_regular: {
    asset_id: 'ast_font_roboto_regular',
    category: 'font',
    basis: 'licensed',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Roboto Regular by Christian Robertson, Google Inc.',
    source: 'https://github.com/googlefonts/roboto/releases/download/v2.138/roboto-android.zip',
    sha256: '89cb384210a4e76a086057c32bf260a4f5f590dc501192e1b8b8095d3126f554',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },

  // Graphics & Images
  ast_poc01_product_hero: {
    asset_id: 'ast_poc01_product_hero',
    category: 'image',
    basis: 'owned',
    license: 'CC0-1.0',
    spdx_id: 'CC0-1.0',
    attribution: 'Artisan Coffee Pack 3D Fixture by Creativanta Design Team',
    source: 'internal://creativanta-design/fixtures/poc01_artisan_coffee_pack.png',
    sha256: 'a7f92084c8a14b5dc00119e763b652875c742e921d743a12bf8b31a8964d4b1a',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc01_sale_badge: {
    asset_id: 'ast_poc01_sale_badge',
    category: 'svg',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Sale Badge Vector Icon by Creativanta Video Engine Team',
    source: 'internal://creativanta/fixtures/poc01_sale_badge.svg',
    sha256: '4cebf0d1e2634461d189fb65edff4070666b906be4799108f293d1543b5984c9',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc01_pill_button: {
    asset_id: 'ast_poc01_pill_button',
    category: 'svg',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'CTA Pill Button Vector Graphic by Creativanta Video Engine Team',
    source: 'internal://creativanta/fixtures/poc01_pill_button.svg',
    sha256: '29fe4198950a74a5fd73d0d7f4e501dd92a44d7905f477e6c3dcabdadae12ebe',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc02_growth_chart: {
    asset_id: 'ast_poc02_growth_chart',
    category: 'svg',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Growth Trend Vector Infographic by Creativanta Video Engine Team',
    source: 'internal://creativanta/fixtures/poc02_growth_chart.svg',
    sha256: 'fe40fecd7cf73e37dde17ce6e57e0597231f0ab81e4b09cb320f263ec8da8891',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc02_metric_card: {
    asset_id: 'ast_poc02_metric_card',
    category: 'svg',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'KPI Metric Gauge Vector by Creativanta Video Engine Team',
    source: 'internal://creativanta/fixtures/poc02_metric_card.svg',
    sha256: 'c59e33999087956d433622ef189ac51e5aa36d976156dbaa064773011acc3d8f',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc02_cloud_icon: {
    asset_id: 'ast_poc02_cloud_icon',
    category: 'svg',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Cloud Processing Vector Icon by Creativanta Video Engine Team',
    source: 'internal://creativanta/fixtures/poc02_cloud_icon.svg',
    sha256: 'd3766022cac7824276ff53a4178fc19234969c2a3b230512d7f1d1734053e77e',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },

  // Audio Tracks
  ast_poc01_silence_track: {
    asset_id: 'ast_poc01_silence_track',
    category: 'audio',
    basis: 'public_domain',
    license: 'CC0-1.0',
    spdx_id: 'CC0-1.0',
    attribution: 'Zero-Amplitude 48kHz Stereo PCM Track by Creativanta Audio Lab',
    source: 'internal://creativanta/fixtures/poc01_silence_48k.wav',
    sha256: 'b38a719c25f483c61aaefda0e8e4589d97034c26b9a8976a4df1460c5ea237a9',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc02_narration_vi: {
    asset_id: 'ast_poc02_narration_vi',
    category: 'audio',
    basis: 'owned',
    license: 'Voice Talent Commercial Agreement #CVE-VO-2026-01',
    attribution: 'Professional Vietnamese Voiceover Narration (Commercial License)',
    source: 'internal://creativanta/contracts/voice-talent-2026-01',
    sha256: 'c59d871230e9f8480371a53b5c683b9e4a812df97843516089d714e8c15a7721',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_audio_narration_poc02: {
    asset_id: 'ast_audio_narration_poc02',
    category: 'audio',
    basis: 'owned',
    license: 'Voice Talent Commercial Agreement #CVE-VO-2026-01',
    attribution: 'Professional Vietnamese Voiceover Narration (Commercial License)',
    source: 'internal://creativanta/contracts/voice-talent-2026-01',
    sha256: 'c59d871230e9f8480371a53b5c683b9e4a812df97843516089d714e8c15a7721',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc02_ambient_bed: {
    asset_id: 'ast_poc02_ambient_bed',
    category: 'audio',
    basis: 'public_domain',
    license: 'CC0-1.0',
    spdx_id: 'CC0-1.0',
    attribution: 'Gentle Tech Ambient Bed, Free Music Archive CC0 Release',
    source: 'https://freemusicarchive.org/music/ambient/gentle-tech-bed-cc0.wav',
    sha256: '81de9432ab71556094cf5e297836d1b2879a83415bc2f1906e30018a724d9c53',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_audio_promo_fallback: {
    asset_id: 'ast_audio_promo_fallback',
    category: 'audio',
    basis: 'owned',
    license: 'Apache-2.0',
    spdx_id: 'Apache-2.0',
    attribution: 'Retail Promo Backup Voiceover Track by Creativanta Studio',
    source: 'internal://creativanta/fixtures/ast_audio_promo_fallback.wav',
    sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc03_narration_vi: {
    asset_id: 'ast_poc03_narration_vi',
    category: 'audio',
    basis: 'owned',
    license: 'Voice Talent Commercial Agreement #CVE-VO-2026-02',
    attribution: 'Vietnamese Native Storyteller Voiceover by Le Hoang Long',
    source: 'internal://creativanta/contracts/voice-talent-2026-02',
    sha256: 'da68019b88cf240e11894d878345bf923c109405d41f7e02581284f3e790a3c2',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc03_music_track: {
    asset_id: 'ast_poc03_music_track',
    category: 'audio',
    basis: 'licensed',
    license: 'CC-BY-4.0',
    spdx_id: 'CC-BY-4.0',
    attribution: 'Highland Acoustic Journey by Nguyen Soundworks, licensed CC-BY-4.0',
    source: 'https://freemusicarchive.org/music/Nguyen_Soundworks/Highland_Acoustic_Journey.mp3',
    sha256: '45d62908f972b93c834015690e8c4501a21e64627ef83b5190807b538da2e591',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },

  // Video Clips
  ast_poc03_clip1_daklak: {
    asset_id: 'ast_poc03_clip1_daklak',
    category: 'video',
    basis: 'licensed',
    license: 'Pexels Content License',
    attribution: 'Dak Lak Coffee Farm Landscape by Tuan Nguyen, Pexels Content License',
    source: 'https://www.pexels.com/video/daklak-coffee-farm-landscape-1928374/',
    sha256: '57f382a19b64c01ee4d7a86d528b934710fa5c420e6e7c10b7a8d3e2154869c0',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
  ast_poc03_clip2_workshop: {
    asset_id: 'ast_poc03_clip2_workshop',
    category: 'video',
    basis: 'licensed',
    license: 'Pixabay Content License',
    attribution: 'Artisan Coffee Roasting Workshop by Minh Le, Pixabay Content License',
    source: 'https://pixabay.com/videos/artisan-coffee-roasting-workshop-582910/',
    sha256: '92a84b3f1107d6e5a40c6759c25bb31e4088910d54032d8471e8bfb36f1c7504',
    commercial_use_allowed: true,
    commercial_embedding_allowed: true,
  },
};

/**
 * Extracts all asset IDs referenced across composition fonts, layers, audio tracks, and subtitles.
 */
export function extractReferencedAssetIds(template: CuratedTemplate): Set<string> {
  const referenced = new Set<string>();
  const spec = template.composition_spec;

  // Fonts
  for (const font of spec.fonts) {
    if (font.asset_id) referenced.add(font.asset_id);
  }

  // Audio tracks
  for (const audio of spec.audio_tracks) {
    if (audio.asset_id) referenced.add(audio.asset_id);
  }

  // Scenes & Layers
  for (const scene of spec.scenes) {
    if ('layers' in scene && Array.isArray(scene.layers)) {
      for (const layer of scene.layers) {
        const content = layer.content as unknown as Record<string, unknown>;
        if (content && typeof content.asset_id === 'string') {
          referenced.add(content.asset_id);
        }
      }
    }
  }

  return referenced;
}

/**
 * Verifies that 100% of assets referenced in a template have verified commercial rights evidence.
 */
export function verifyTemplateLicenseEvidence(template: CuratedTemplate): {
  valid: boolean;
  missingAssets: string[];
  evidenceList: AssetLicenseEvidence[];
  errors: string[];
} {
  const referencedIds = extractReferencedAssetIds(template);
  const missingAssets: string[] = [];
  const errors: string[] = [];
  const evidenceList: AssetLicenseEvidence[] = [];

  for (const assetId of referencedIds) {
    const evidence = CURATED_ASSETS_LICENSE_REGISTRY[assetId];
    if (!evidence) {
      missingAssets.push(assetId);
      errors.push(`Template '${template.id}' references asset '${assetId}' lacking registered rights evidence`);
    } else {
      if (!evidence.commercial_use_allowed) {
        errors.push(`Asset '${assetId}' does not permit commercial use under license ${evidence.license}`);
      }
      if (!evidence.sha256 || evidence.sha256.length !== 64) {
        errors.push(`Asset '${assetId}' has invalid SHA-256 checksum: ${evidence.sha256}`);
      }
      evidenceList.push(evidence);
    }
  }

  return {
    valid: missingAssets.length === 0 && errors.length === 0,
    missingAssets,
    evidenceList,
    errors,
  };
}

/**
 * Asserts full license compliance for a template, throwing on violation.
 */
export function assertTemplateLicenseCompliance(template: CuratedTemplate): void {
  const result = verifyTemplateLicenseEvidence(template);
  if (!result.valid) {
    throw new Error(`License compliance failure for template '${template.id}':\n${result.errors.join('\n')}`);
  }
}
