/**
 * Narrated Explainer Template Family with TTS Narration, Subtitles, and Upload Fallback.
 * 16:9 Landscape (1280x720) 30s @ 30fps = 900 frames.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, docs/TESTING.md.
 */

import { CompositionSpec, StandardSceneSpec } from '@creativanta/contracts';
import { CURATED_ASSETS_LICENSE_REGISTRY } from './license-evidence.js';
import { CuratedTemplate, CuratedTemplateFamily, TemplateRevisionInfo } from './types.js';

const SPEC_V1: CompositionSpec = {
  schema_version: '1.0',
  canvas: {
    width: 1280,
    height: 720,
    background: '#0B132B',
  },
  fps: {
    num: 30,
    den: 1,
  },
  duration_frames: 900,
  seed: 2026,
  locale: 'vi-VN',
  direction: 'ltr',
  fonts: [
    {
      id: 'font_title',
      asset_id: 'ast_font_noto_sans_bold',
      sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      family: 'Noto Sans',
      weight: 700,
      style: 'normal',
    },
    {
      id: 'font_body',
      asset_id: 'ast_font_noto_sans_regular',
      sha256: '41b78294a53e54b6cf481f21db5976b3cf92da630713b6326e0e02c6735a28c4',
      family: 'Noto Sans',
      weight: 400,
      style: 'normal',
    },
  ],
  scenes: [
    {
      id: 'scene_problem',
      revision: 1,
      start_frame: 0,
      duration_frames: 210,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_problem_text',
          type: 'text',
          start_frame: 0,
          duration_frames: 210,
          z_index: 1,
          box: {
            x: 80,
            y: 280,
            width: 1120,
            height: 160,
          },
          content: {
            text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
            font_id: 'font_title',
            font_size: 42,
            color: '#E0E1DD',
            align: 'center',
            max_lines: 3,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_solution',
      revision: 1,
      start_frame: 210,
      duration_frames: 240,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_solution_title',
          type: 'text',
          start_frame: 0,
          duration_frames: 240,
          z_index: 1,
          box: {
            x: 80,
            y: 280,
            width: 1120,
            height: 160,
          },
          content: {
            text: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn',
            font_id: 'font_title',
            font_size: 44,
            color: '#4CC9F0',
            align: 'center',
            max_lines: 3,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_features',
      revision: 1,
      start_frame: 450,
      duration_frames: 240,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_feature_item',
          type: 'text',
          start_frame: 0,
          duration_frames: 240,
          z_index: 1,
          box: {
            x: 80,
            y: 280,
            width: 1120,
            height: 160,
          },
          content: {
            text: 'Độc lập CPU • Bản quyền kiểm soát • Tự động hoá tuyệt đối',
            font_id: 'font_body',
            font_size: 38,
            color: '#72EFDD',
            align: 'center',
            max_lines: 2,
            overflow: 'error',
          },
        },
      ],
    },
    {
      id: 'scene_summary',
      revision: 1,
      start_frame: 690,
      duration_frames: 210,
      engine: 'html-v1',
      transition_out: {
        type: 'fade_to_background',
        duration_frames: 30,
      },
      layers: [
        {
          id: 'layer_summary_headline',
          type: 'text',
          start_frame: 0,
          duration_frames: 210,
          z_index: 1,
          box: {
            x: 80,
            y: 280,
            width: 1120,
            height: 160,
          },
          content: {
            text: 'Bắt đầu tự động hóa quy trình ngay hôm nay',
            font_id: 'font_title',
            font_size: 46,
            color: '#F72585',
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
      id: 'track_explainer_narration',
      asset_id: 'ast_audio_narration_poc02',
      start_frame: 0,
      duration_frames: 900,
      source_in_samples: 0,
      gain_db: 0,
      role: 'voice',
    },
  ],
  subtitles: [
    {
      id: 'sub_vi',
      locale: 'vi-VN',
      burn_in: true,
      style: {
        font_id: 'font_body',
        font_size: 28,
        color: '#FFFFFF',
        background: '#000000B3',
        align: 'center',
        max_lines: 2,
        safe_margin_px: 48,
      },
      cues: [
        {
          id: 'cue_1',
          start_frame: 15,
          end_frame: 195,
          text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
        },
        {
          id: 'cue_2',
          start_frame: 225,
          end_frame: 435,
          text: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn độc lập.',
        },
        {
          id: 'cue_3',
          start_frame: 465,
          end_frame: 675,
          text: 'Tối ưu hoá cho vi xử lý CPU, hạ thấp chi phí vận hành và bảo vệ bản quyền.',
        },
        {
          id: 'cue_4',
          start_frame: 705,
          end_frame: 885,
          text: 'Bắt đầu tích hợp quy trình render video tự động ngay hôm nay.',
        },
      ],
    },
  ],
};

// Revision 2 Specification: Refined copy, enterprise focus, enhanced transitions
const SPEC_V2: CompositionSpec = JSON.parse(JSON.stringify(SPEC_V1));
const s0 = SPEC_V2.scenes[0] as StandardSceneSpec;
const s1 = SPEC_V2.scenes[1] as StandardSceneSpec;
const s3 = SPEC_V2.scenes[3] as StandardSceneSpec;

s0.layers[0]!.content = {
  text: 'Chi phí sản xuất video thủ công quá cao và thiếu nhất quán?',
  font_id: 'font_title',
  font_size: 42,
  color: '#E0E1DD',
  align: 'center',
  max_lines: 3,
  overflow: 'error',
};
s1.layers[0]!.content = {
  text: 'Creativanta Video Engine: Nền tảng tự động hóa render cấp doanh nghiệp',
  font_id: 'font_title',
  font_size: 42,
  color: '#4CC9F0',
  align: 'center',
  max_lines: 3,
  overflow: 'error',
};
s3.layers[0]!.content = {
  text: 'Liên hệ trải nghiệm giải pháp doanh nghiệp ngay hôm nay',
  font_id: 'font_title',
  font_size: 44,
  color: '#F72585',
  align: 'center',
  max_lines: 2,
  overflow: 'error',
};

const VARIABLES_SCHEMA = {
  type: 'object',
  required: ['problem_text', 'solution_title', 'summary_headline'],
  additionalProperties: false,
  properties: {
    problem_text: {
      type: 'string',
      maxLength: 200,
      description: 'Văn bản nêu vấn đề phân cảnh 1',
    },
    solution_title: {
      type: 'string',
      maxLength: 200,
      description: 'Tiêu đề giới thiệu giải pháp phân cảnh 2',
    },
    summary_headline: {
      type: 'string',
      maxLength: 200,
      description: 'Thông điệp tóm tắt phân cảnh 4',
    },
    narration_tts_text: {
      type: 'string',
      maxLength: 1000,
      description: 'Nội dung thuyết minh giọng đọc tự động qua TTS',
    },
    upload_fallback_asset_id: {
      type: 'string',
      description: 'Asset ID tệp âm thanh người dùng tải lên dùng làm dự phòng',
    },
  },
};

const DEFAULTS_V1 = {
  problem_text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
  solution_title: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn',
  summary_headline: 'Bắt đầu tự động hóa quy trình ngay hôm nay',
  narration_tts_text:
    'Creativanta Video Engine là nền tảng kết xuất video tự động bằng mã nguồn độc lập, tối ưu hoá cho bộ xử lý CPU và hỗ trợ đầy đủ tiếng Việt.',
  upload_fallback_asset_id: 'ast_audio_narration_poc02',
};

const DEFAULTS_V2 = {
  problem_text: 'Chi phí sản xuất video thủ công quá cao và thiếu nhất quán?',
  solution_title: 'Creativanta Video Engine: Nền tảng tự động hóa render cấp doanh nghiệp',
  summary_headline: 'Liên hệ trải nghiệm giải pháp doanh nghiệp ngay hôm nay',
  narration_tts_text:
    'Creativanta Video Engine cung cấp năng lực dựng video tự động với độ ổn định cao, bảo vệ bản quyền tài sản và kiểm soát chi phí tối đa.',
  upload_fallback_asset_id: 'ast_audio_narration_poc02',
};

const REVISIONS: TemplateRevisionInfo[] = [
  {
    revision: 1,
    change_note: 'Khởi tạo bản mẫu thuyết minh giải thích 30s 16:9 ban đầu (POC-02 family baseline)',
    composition_spec: SPEC_V1,
  },
  {
    revision: 2,
    base_revision: 1,
    change_note: 'Định hình lại thông điệp hướng đến phân khúc doanh nghiệp, bổ sung lời kêu gọi hành động nâng cao',
    composition_spec: SPEC_V2,
  },
];

const LICENSE_EVIDENCE = [
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_noto_sans_bold']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_font_noto_sans_regular']!,
  CURATED_ASSETS_LICENSE_REGISTRY['ast_audio_narration_poc02']!,
];

export const NARRATED_EXPLAINER_TEMPLATE_V1: CuratedTemplate = {
  id: 'tpl_narrated_explainer_v1',
  family: 'narrated_explainer',
  revision: 1,
  name: 'Bản mẫu Explainer Thuyết minh Tiếng Việt 30s (Rev 1)',
  description:
    'Video giải thích 30s 1280x720 gồm 4 phân cảnh, phụ đề tiếng Việt, hỗ trợ thuyết minh tự động qua TTS với kênh âm thanh tải lên dự phòng.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V1,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V1,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#0B132B',
    primaryColor: '#4CC9F0',
    secondaryColor: '#72EFDD',
    accentColor: '#F72585',
    textColor: '#E0E1DD',
    headingFontId: 'font_title',
    bodyFontId: 'font_body',
  },
};

export const NARRATED_EXPLAINER_TEMPLATE_V2: CuratedTemplate = {
  id: 'tpl_narrated_explainer_v1',
  family: 'narrated_explainer',
  revision: 2,
  name: 'Bản mẫu Explainer Thuyết minh Tiếng Việt 30s (Rev 2)',
  description:
    'Phiên bản doanh nghiệp 30s 1280x720 gồm 4 phân cảnh, nhấn mạnh giải pháp tự động hóa quy trình với độ ổn định cao.',
  variables_schema: VARIABLES_SCHEMA,
  defaults: DEFAULTS_V2,
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: SPEC_V2,
  revisions: REVISIONS,
  license_evidence: LICENSE_EVIDENCE,
  brand_tokens_defaults: {
    backgroundColor: '#0B132B',
    primaryColor: '#4CC9F0',
    secondaryColor: '#72EFDD',
    accentColor: '#F72585',
    textColor: '#E0E1DD',
    headingFontId: 'font_title',
    bodyFontId: 'font_body',
  },
};

export const NARRATED_EXPLAINER_FAMILY: CuratedTemplateFamily = {
  family_id: 'narrated_explainer',
  name: 'Bộ bản mẫu Giải thích Thuyết minh (Narrated Explainer)',
  description:
    'Dòng bản mẫu video ngang 16:9 (1280x720) tối ưu cho video giải thích kỹ thuật, demo sản phẩm SaaS và tài liệu hướng dẫn.',
  revisions: [NARRATED_EXPLAINER_TEMPLATE_V1, NARRATED_EXPLAINER_TEMPLATE_V2],
  latest: NARRATED_EXPLAINER_TEMPLATE_V2,
};

// Backward-compatibility alias
export const NARRATED_EXPLAINER_TEMPLATE = NARRATED_EXPLAINER_TEMPLATE_V1;
