/**
 * Retail Promo Template Family with Vietnamese Typography, Safe Brand Tokens, and Audio Fallback.
 * 9:16 Portrait (720x1280) 15s @ 30fps = 450 frames.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, docs/TESTING.md.
 */

import { CompositionSpec, StandardSceneSpec } from '@creativanta/contracts';
import { CURATED_ASSETS_LICENSE_REGISTRY } from './license-evidence.js';
import { CuratedTemplate, CuratedTemplateFamily, TemplateRevisionInfo } from './types.js';

const SPEC_V1: CompositionSpec = {
  schema_version: '1.0',
  canvas: {
    width: 720,
    height: 1280,
    background: '#1A1A2E',
  },
  fps: {
    num: 30,
    den: 1,
  },
  duration_frames: 450,
  seed: 2026,
  locale: 'vi-VN',
  direction: 'ltr',
  fonts: [
    {
      id: 'font_promo_bold',
      asset_id: 'ast_font_noto_sans_bold',
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      family: 'Noto Sans',
      weight: 700,
      style: 'normal',
    },
    {
      id: 'font_promo_regular',
      asset_id: 'ast_font_noto_sans_regular',
      sha256: '41b78294a53e54b6cf481f21db5976b3cf92da630713b6326e0e02c6735a28c4',
      family: 'Noto Sans',
      weight: 400,
      style: 'normal',
    },
  ],
  scenes: [
    {
      id: 'scene_promo_intro',
      revision: 1,
      start_frame: 0,
      duration_frames: 150,
      engine: 'html-v1',
      transition_out: {
        type: 'cut',
        duration_frames: 0,
      },
      layers: [
        {
          id: 'layer_promo_headline',
          type: 'text',
          start_frame: 0,
          duration_frames: 150,
          z_index: 1,
          box: {
            x: 48,
            y: 500,
            width: 624,
            height: 200,
          },
          content: {
            text: 'Khuyến mãi đặc biệt hôm nay!',
            font_id: 'font_promo_bold',
            font_size: 48,
            color: '#FFD700',
            align: 'center',
            max_lines: 3,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_promo_deal',
      revision: 1,
      start_frame: 150,
      duration_frames: 150,
      engine: 'html-v1',
      transition_out: {
        type: 'cut',
        duration_frames: 0,
      },
      layers: [
        {
          id: 'layer_promo_price',
          type: 'text',
          start_frame: 0,
          duration_frames: 150,
          z_index: 1,
          box: {
            x: 48,
            y: 500,
            width: 624,
            height: 200,
          },
          content: {
            text: 'Chỉ từ 199.000 ₫',
            font_id: 'font_promo_bold',
            font_size: 52,
            color: '#FF4D4D',
            align: 'center',
            max_lines: 2,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_promo_cta',
      revision: 1,
      start_frame: 300,
      duration_frames: 150,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_promo_cta',
          type: 'text',
          start_frame: 0,
          duration_frames: 150,
          z_index: 1,
          box: {
            x: 48,
            y: 500,
            width: 624,
            height: 200,
          },
          content: {
            text: 'Mua ngay kẻo lỡ!',
            font_id: 'font_promo_bold',
            font_size: 50,
            color: '#00F0FF',
            align: 'center',
            max_lines: 2,
            overflow: 'error',
          },
        },
      ],
    },
  ],
  audio_tracks: [
    {
      id: 'track_voiceover',
      asset_id: 'ast_audio_promo_fallback',
      start_frame: 0,
      duration_frames: 450,
      source_in_samples: 0,
      gain_db: 0,
      role: 'voice',
    },
  ],
  subtitles: [],
};

// Revision 2 Specification: Refined copy, updated summer sale deal, accent badge
const SPEC_V2: CompositionSpec = JSON.parse(JSON.stringify(SPEC_V1));
const s0 = SPEC_V2.scenes[0] as StandardSceneSpec;
const s1 = SPEC_V2.scenes[1] as StandardSceneSpec;
const s2 = SPEC_V2.scenes[2] as StandardSceneSpec;

s0.layers[0]!.content = {
  text: 'Xả kho mùa hè — Giảm tới 70%!',
  font_id: 'font_promo_bold',
  font_size: 50,
  color: '#FFD700',
  align: 'center',
  max_lines: 3,
  overflow: 'error',
};
s1.layers[0]!.content = {
  text: 'Đồng giá chỉ 149.000 ₫',
  font_id: 'font_promo_bold',
  font_size: 54,
  color: '#FF3366',
  align: 'center',
  max_lines: 2,
  overflow: 'error',
};
s2.layers[0]!.content = {
  text: 'Chớp cơ hội ngay hôm nay!',
  font_id: 'font_promo_bold',
  font_size: 50,
  color: '#00F0FF',
  align: 'center',
  max_lines: 2,
  overflow: 'error',
};

const VARIABLES_SCHEMA = {
  type: 'object',
  required: ['headline', 'discount_text', 'price_text', 'cta_text'],
  additionalProperties: false,
  properties: {
    headline: {
      type: 'string',
      maxLength: 100,
      description: 'Tiêu đề khuyến mãi phân cảnh 1',
    },
    discount_text: {
      type: 'string',
      maxLength: 50,
      description: 'Mức giảm giá hiển thị',
    },
    price_text: {
      type: 'string',
      maxLength: 50,
      description: 'Giá khuyến mãi hiển thị',
    },
    cta_text: {
      type: 'string',
      maxLength: 50,
      description: 'Lời kêu gọi hành động phân cảnh 3',
    },
    narration_tts_text: {
      type: 'string',
      maxLength: 500,
      description: 'Văn bản đọc thuyết minh khuyến mãi',
    },
    upload_fallback_asset_id: {
      type: 'string',
      description: 'Tệp âm thanh tải lên dự phòng',
    },
  },
};

const DEFAULTS_V1 = {
  headline: 'Khuyến mãi đặc biệt hôm nay!',
  discount_text: 'Giảm giá 50%',
  price_text: '199.000 ₫',
  cta_text: 'Mua ngay kẻo lỡ!',
  narration_tts_text:
    'Khuyến mãi đặc biệt hôm nay! Giảm giá đến 50% cho tất cả sản phẩm thời trang. Mua ngay kẻo lỡ!',
  upload_fallback_asset_id: 'ast_audio_promo_fallback',
};

const DEFAULTS_V2 = {
  headline: 'Xả kho mùa hè — Giảm tới 70%!',
  discount_text: 'Giảm sốc 70%',
  price_text: '149.000 ₫',
  cta_text: 'Chớp cơ hội ngay hôm nay!',
  narration_tts_text:
    'Xả kho mùa hè cực sốc! Giảm giá tới 70% toàn bộ bộ sưu tập mới. Chớp cơ hội ngay hôm nay!',
  upload_fallback_asset_id: 'ast_audio_promo_fallback',
};

const REVISIONS: TemplateRevisionInfo[] = [
  {
    revision: 1,
    change_note: 'Khởi tạo bản mẫu khuyến mãi bán lẻ dọc 15s ban đầu (POC-01 family baseline)',
    composition_spec: SPEC_V1,
  },
  {
    revision: 2,
    base_revision: 1,
    change_note: 'Cập nhật tiêu đề xả kho mùa hè, điều chỉnh mức giá 149.000 ₫ và nâng cao độ tương phản màu sắc',
    composition_spec: SPEC_V2,
  },
];

const LICENSE_EVIDENCE = [
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_noto_sans_bold']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_noto_sans_regular']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_audio_promo_fallback']!,
];

export const RETAIL_PROMO_TEMPLATE_V1: CuratedTemplate = {
  id: 'tpl_retail_promo_v1',
  family: 'retail_promo',
  revision: 1,
  name: 'Bản mẫu Khuyến mãi Bán lẻ Dọc 15s (Rev 1)',
  description:
    'Video quảng cáo dọc 720x1280 15s gồm 3 phân cảnh, định dạng tiền tệ Việt Nam (₫), hỗ trợ lồng tiếng TTS và upload audio fallback.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V1,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V1,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#1A1A2E',
    primaryColor: '#FFD700',
    accentColor: '#FF4D4D',
    secondaryColor: '#00F0FF',
    textColor: '#FFFFFF',
    headingFontId: 'font_promo_bold',
    bodyFontId: 'font_promo_regular',
  },
};

export const RETAIL_PROMO_TEMPLATE_V2: CuratedTemplate = {
  id: 'tpl_retail_promo_v1',
  family: 'retail_promo',
  revision: 2,
  name: 'Bản mẫu Khuyến mãi Bán lẻ Dọc 15s (Rev 2)',
  description:
    'Phiên bản nâng cấp khuyến mãi mùa hè 15s gồm 3 phân cảnh, định dạng tiền tệ Việt Nam (₫), tương phản màu sắc tối ưu.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V2,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V2,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#1A1A2E',
    primaryColor: '#FFD700',
    accentColor: '#FF3366',
    secondaryColor: '#00F0FF',
    textColor: '#FFFFFF',
    headingFontId: 'font_promo_bold',
    bodyFontId: 'font_promo_regular',
  },
};

export const RETAIL_PROMO_FAMILY: CuratedTemplateFamily = {
  family_id: 'retail_promo',
  name: 'Bộ bản mẫu Khuyến mãi Bán lẻ (Retail Promo)',
  description:
    'Dòng bản mẫu video dọc 9:16 (720x1280) chuyên biệt cho thương mại điện tử, quảng cáo sản phẩm và flash sale.',
  revisions: [RETAIL_PROMO_TEMPLATE_V1, RETAIL_PROMO_TEMPLATE_V2],
  latest: RETAIL_PROMO_TEMPLATE_V2,
};

// Backward-compatibility alias
export const RETAIL_PROMO_TEMPLATE = RETAIL_PROMO_TEMPLATE_V1;
