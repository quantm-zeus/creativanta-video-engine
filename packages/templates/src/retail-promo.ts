/**
 * Retail Promo Template with Vietnamese Typography and Audio Fallback.
 * 9:16 Portrait (720x1280) 15s @ 30fps = 450 frames.
 */

import { CuratedTemplate } from './types.js';

export const RETAIL_PROMO_TEMPLATE: CuratedTemplate = {
  id: 'tpl_retail_promo_v1',
  revision: 1,
  name: 'Bản mẫu Khuyến mãi Bán lẻ Dọc 15s',
  description: 'Video quảng cáo dọc 720x1280 15s gồm 3 phân cảnh, định dạng tiền tệ Việt Nam (₫), hỗ trợ lồng tiếng TTS và upload audio fallback.',
  variables_schema: {
    type: 'object',
    required: ['headline', 'discount_text', 'price_text', 'cta_text'],
    additionalProperties: false,
    properties: {
      headline: {
        type: 'string',
        maxLength: 100,
        description: 'Tiêu đề khuyến mãi',
      },
      discount_text: {
        type: 'string',
        maxLength: 50,
        description: 'Mức giảm giá',
      },
      price_text: {
        type: 'string',
        maxLength: 50,
        description: 'Giá khuyến mãi hiển thị',
      },
      cta_text: {
        type: 'string',
        maxLength: 50,
        description: 'Lời kêu gọi hành động',
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
  },
  defaults: {
    headline: 'Khuyến mãi đặc biệt hôm nay!',
    discount_text: 'Giảm giá 50%',
    price_text: '199.000 ₫',
    cta_text: 'Mua ngay kẻo lỡ!',
    narration_tts_text: 'Khuyến mãi đặc biệt hôm nay! Giảm giá đến 50% cho tất cả sản phẩm thời trang. Mua ngay kẻo lỡ!',
    upload_fallback_asset_id: 'ast_audio_promo_fallback',
  },
  supported_locales: ['vi-VN'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: {
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
  },
};
