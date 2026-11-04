/**
 * Captioned Story Template Family with Real Footage Video Clips, Multi-Track Audio,
 * Subtitle Burn-In, and Vietnamese Typography.
 * 9:16 Portrait (720x1280) 45s @ 30fps = 1350 frames.
 * Canonical specification: docs/SCENE-SPEC.md, docs/TESTING.md (POC-03 family).
 */

import { CompositionSpec, StandardSceneSpec } from '@creativanta/contracts';
import { CURATED_ASSETS_LICENSE_REGISTRY } from './license-evidence.js';
import { CuratedTemplate, CuratedTemplateFamily, TemplateRevisionInfo } from './types.js';

const SPEC_V1: CompositionSpec = {
  schema_version: '1.0',
  canvas: {
    width: 720,
    height: 1280,
    background: '#000000',
  },
  fps: {
    num: 30,
    den: 1,
  },
  duration_frames: 1350,
  seed: 3030,
  locale: 'vi-VN',
  direction: 'ltr',
  fonts: [
    {
      id: 'font_story_bold',
      asset_id: 'ast_font_roboto_bold',
      sha256: '2b8f413a968a35e47851d8b67117c09368d1847e09ef74e502c3c97dbb8a109a',
      family: 'Roboto',
      weight: 700,
      style: 'normal',
    },
    {
      id: 'font_story_regular',
      asset_id: 'ast_font_roboto_regular',
      sha256: '89cb384210a4e76a086057c32bf260a4f5f590dc501192e1b8b8095d3126f554',
      family: 'Roboto',
      weight: 400,
      style: 'normal',
    },
  ],
  scenes: [
    {
      id: 'scene_story_landscape',
      revision: 1,
      start_frame: 0,
      duration_frames: 675,
      engine: 'html-v1',
      transition_out: {
        type: 'cut',
        duration_frames: 0,
      },
      layers: [
        {
          id: 'video_clip_daklak',
          type: 'video',
          start_frame: 0,
          duration_frames: 675,
          z_index: 1,
          box: {
            x: 0,
            y: 0,
            width: 720,
            height: 1280,
          },
          content: {
            asset_id: 'ast_poc03_clip1_daklak',
            fit: 'cover',
            source_in_frame: 0,
          },
        },
        {
          id: 'layer_story_title',
          type: 'text',
          start_frame: 0,
          duration_frames: 675,
          z_index: 2,
          box: {
            x: 48,
            y: 120,
            width: 624,
            height: 160,
          },
          content: {
            text: 'ĐẮK LẮK — HƯƠNG SẮC CAO NGUYÊN',
            font_id: 'font_story_bold',
            font_size: 40,
            color: '#FFFFFF',
            align: 'center',
            max_lines: 3,
            overflow: 'error',
          },
        },
        {
          id: 'layer_story_location',
          type: 'text',
          start_frame: 0,
          duration_frames: 675,
          z_index: 2,
          box: {
            x: 48,
            y: 290,
            width: 624,
            height: 60,
          },
          content: {
            text: 'Buôn Ma Thuột • Việt Nam',
            font_id: 'font_story_regular',
            font_size: 26,
            color: '#FBBF24',
            align: 'center',
            max_lines: 1,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_story_workshop',
      revision: 1,
      start_frame: 675,
      duration_frames: 525,
      engine: 'html-v1',
      transition_out: {
        type: 'cut',
        duration_frames: 0,
      },
      layers: [
        {
          id: 'video_clip_workshop',
          type: 'video',
          start_frame: 0,
          duration_frames: 525,
          z_index: 1,
          box: {
            x: 0,
            y: 0,
            width: 720,
            height: 1280,
          },
          content: {
            asset_id: 'ast_poc03_clip2_workshop',
            fit: 'cover',
            source_in_frame: 60,
          },
        },
        {
          id: 'layer_story_quote',
          type: 'text',
          start_frame: 0,
          duration_frames: 525,
          z_index: 2,
          box: {
            x: 48,
            y: 150,
            width: 624,
            height: 180,
          },
          content: {
            text: 'Rang xay thủ công gìn giữ linh hồn của từng hạt cà phê mộc',
            font_id: 'font_story_bold',
            font_size: 36,
            color: '#FFFFFF',
            align: 'center',
            max_lines: 3,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_story_outro',
      revision: 1,
      start_frame: 1200,
      duration_frames: 150,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_outro_bg',
          type: 'shape',
          start_frame: 0,
          duration_frames: 150,
          z_index: 1,
          box: {
            x: 0,
            y: 0,
            width: 720,
            height: 1280,
          },
          content: {
            shape: 'rect',
            fill: '#0F172A',
          },
        },
        {
          id: 'layer_story_cta',
          type: 'text',
          start_frame: 0,
          duration_frames: 150,
          z_index: 2,
          box: {
            x: 48,
            y: 550,
            width: 624,
            height: 180,
          },
          content: {
            text: 'Trải nghiệm hương vị di sản tại creativanta.vn',
            font_id: 'font_story_bold',
            font_size: 42,
            color: '#38BDF8',
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
      id: 'track_narration',
      asset_id: 'ast_poc03_narration_vi',
      start_frame: 0,
      duration_frames: 1350,
      source_in_samples: 0,
      gain_db: 0,
      role: 'voice',
    },
    {
      id: 'track_bgm',
      asset_id: 'ast_poc03_music_track',
      start_frame: 0,
      duration_frames: 1350,
      source_in_samples: 0,
      gain_db: -14,
      role: 'music',
    },
  ],
  subtitles: [
    {
      id: 'sub_vi_story',
      locale: 'vi-VN',
      burn_in: true,
      style: {
        font_id: 'font_story_bold',
        font_size: 26,
        color: '#FFFFFF',
        background: '#000000B3',
        align: 'center',
        max_lines: 2,
        safe_margin_px: 48,
      },
      cues: [
        {
          id: 'cue_story_1',
          start_frame: 30,
          end_frame: 450,
          text: 'Nằm giữa lòng cao nguyên Đắk Lắk bạt ngàn nắng gió...',
        },
        {
          id: 'cue_story_2',
          start_frame: 480,
          end_frame: 960,
          text: 'Từng hạt cà phê chín mọng được nâng niu qua bàn tay nghệ nhân.',
        },
        {
          id: 'cue_story_3',
          start_frame: 990,
          end_frame: 1200,
          text: 'Quy trình rang xay thủ công lưu giữ trọn vẹn hương vị nguyên bản.',
        },
        {
          id: 'cue_story_4',
          start_frame: 1215,
          end_frame: 1335,
          text: 'Creativanta — Đồng hành cùng giá trị nông sản Việt Nam.',
        },
      ],
    },
  ],
};

// Revision 2 Specification: Autumn heritage edition with refined typography
const SPEC_V2: CompositionSpec = JSON.parse(JSON.stringify(SPEC_V1));
const s0 = SPEC_V2.scenes[0] as StandardSceneSpec;
const s1 = SPEC_V2.scenes[1] as StandardSceneSpec;
const s2 = SPEC_V2.scenes[2] as StandardSceneSpec;

s0.layers[1]!.content = {
  text: 'HƯƠNG VỊ DI SẢN — ĐẮK LẮK 2026',
  font_id: 'font_story_bold',
  font_size: 40,
  color: '#FFFFFF',
  align: 'center',
  max_lines: 3,
  overflow: 'error',
};
s1.layers[1]!.content = {
  text: 'Đậm đà hương vị truyền thống kết hợp công nghệ hiện đại',
  font_id: 'font_story_bold',
  font_size: 38,
  color: '#FFFFFF',
  align: 'center',
  max_lines: 3,
  overflow: 'error',
};
s2.layers[1]!.content = {
  text: 'Đặt hàng gói quà tặng di sản ngay hôm nay',
  font_id: 'font_story_bold',
  font_size: 42,
  color: '#FBBF24',
  align: 'center',
  max_lines: 2,
  overflow: 'error',
};

const VARIABLES_SCHEMA = {
  type: 'object',
  required: ['title_text', 'location_tag', 'story_quote', 'cta_text'],
  additionalProperties: false,
  properties: {
    title_text: {
      type: 'string',
      maxLength: 100,
      description: 'Tiêu đề phóng sự cảnh 1',
    },
    location_tag: {
      type: 'string',
      maxLength: 50,
      description: 'Thẻ địa danh hiển thị',
    },
    story_quote: {
      type: 'string',
      maxLength: 200,
      description: 'Trích dẫn câu chuyện cảnh 2',
    },
    cta_text: {
      type: 'string',
      maxLength: 100,
      description: 'Lời kêu gọi hành động cảnh kết thúc',
    },
    narration_asset_id: {
      type: 'string',
      description: 'Asset ID tệp âm thanh thuyết minh tiếng Việt',
    },
    music_asset_id: {
      type: 'string',
      description: 'Asset ID tệp âm thanh nhạc cụ nền',
    },
  },
};

const DEFAULTS_V1 = {
  title_text: 'ĐẮK LẮK — HƯƠNG SẮC CAO NGUYÊN',
  location_tag: 'Buôn Ma Thuột • Việt Nam',
  story_quote: 'Rang xay thủ công gìn giữ linh hồn của từng hạt cà phê mộc',
  cta_text: 'Trải nghiệm hương vị di sản tại creativanta.vn',
  narration_asset_id: 'ast_poc03_narration_vi',
  music_asset_id: 'ast_poc03_music_track',
};

const DEFAULTS_V2 = {
  title_text: 'HƯƠNG VỊ DI SẢN — ĐẮK LẮK 2026',
  location_tag: 'Buôn Ma Thuột • Việt Nam',
  story_quote: 'Đậm đà hương vị truyền thống kết hợp công nghệ hiện đại',
  cta_text: 'Đặt hàng gói quà tặng di sản ngay hôm nay',
  narration_asset_id: 'ast_poc03_narration_vi',
  music_asset_id: 'ast_poc03_music_track',
};

const REVISIONS: TemplateRevisionInfo[] = [
  {
    revision: 1,
    change_note: 'Khởi tạo bản mẫu phóng sự video kèm phụ đề 45s ban đầu (POC-03 family baseline)',
    composition_spec: SPEC_V1,
  },
  {
    revision: 2,
    base_revision: 1,
    change_note: 'Cập nhật phiên bản di sản 2026, tinh chỉnh lời kết và màu sắc nổi bật',
    composition_spec: SPEC_V2,
  },
];

const LICENSE_EVIDENCE = [
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_roboto_bold']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_roboto_regular']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_poc03_clip1_daklak']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_poc03_clip2_workshop']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_poc03_narration_vi']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_poc03_music_track']!,
];

export const CAPTIONED_STORY_TEMPLATE_V1: CuratedTemplate = {
  id: 'tpl_captioned_story_v1',
  family: 'captioned_story',
  revision: 1,
  name: 'Bản mẫu Phóng sự Phụ đề Dọc 45s (Rev 1)',
  description:
    'Video phóng sự dọc 720x1280 45s gồm 3 phân cảnh, tích hợp 2 đoạn phim thực tế, hòa âm giọng nói & nhạc nền ducking, phụ đề tiếng Việt chuẩn.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V1,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V1,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#000000',
    primaryColor: '#FFFFFF',
    secondaryColor: '#38BDF8',
    accentColor: '#FBBF24',
    textColor: '#FFFFFF',
    headingFontId: 'font_story_bold',
    bodyFontId: 'font_story_regular',
  },
};

export const CAPTIONED_STORY_TEMPLATE_V2: CuratedTemplate = {
  id: 'tpl_captioned_story_v1',
  family: 'captioned_story',
  revision: 2,
  name: 'Bản mẫu Phóng sự Phụ đề Dọc 45s (Rev 2)',
  description:
    'Phiên bản nâng cấp di sản 45s gồm 3 phân cảnh, biên tập nội dung thương hiệu và lời kêu gọi quà tặng di sản.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V2,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V2,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#000000',
    primaryColor: '#FFFFFF',
    secondaryColor: '#38BDF8',
    accentColor: '#FBBF24',
    textColor: '#FFFFFF',
    headingFontId: 'font_story_bold',
    bodyFontId: 'font_story_regular',
  },
};

export const CAPTIONED_STORY_FAMILY: CuratedTemplateFamily = {
  family_id: 'captioned_story',
  name: 'Bộ bản mẫu Phóng sự Phụ đề (Captioned Story)',
  description:
    'Dòng bản mẫu video dọc 9:16 (720x1280) chuyên biệt cho phóng sự tài liệu, video tin tức xã hội và câu chuyện thương hiệu.',
  revisions: [CAPTIONED_STORY_TEMPLATE_V1, CAPTIONED_STORY_TEMPLATE_V2],
  latest: CAPTIONED_STORY_TEMPLATE_V2,
};

// Backward-compatibility alias
export const CAPTIONED_STORY_TEMPLATE = CAPTIONED_STORY_TEMPLATE_V1;
