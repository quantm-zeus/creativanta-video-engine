/**
 * Narrated Explainer Template with TTS Narration & Upload Fallback.
 * 16:9 Landscape (1280x720) 30s @ 30fps = 900 frames.
 * Conforms to Scene Spec 1.0 and P5-02 audio fallback architecture.
 */

import { CuratedTemplate } from './types.js';

export const NARRATED_EXPLAINER_TEMPLATE: CuratedTemplate = {
  id: 'tpl_narrated_explainer_v1',
  revision: 1,
  name: 'Bản mẫu Explainer Thuyết minh Tiếng Việt 30s',
  description: 'Video giải thích 30s 1280x720 gồm 4 phân cảnh, phụ đề tiếng Việt, hỗ trợ thuyết minh tự động qua TTS với kênh âm thanh tải lên dự phòng (upload audio fallback).',
  variables_schema: {
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
        description: 'Asset ID tệp âm thanh người dùng tải lên dùng làm dự phòng khi TTS tắt hoặc vượt ngân sách',
      },
    },
  },
  defaults: {
    problem_text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
    solution_title: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn',
    summary_headline: 'Bắt đầu tự động hóa quy trình ngay hôm nay',
    narration_tts_text: 'Creativanta Video Engine là nền tảng kết xuất video tự động bằng mã nguồn độc lập, tối ưu hoá cho bộ xử lý CPU và hỗ trợ đầy đủ tiếng Việt.',
    upload_fallback_asset_id: 'ast_audio_narration_poc02',
  },
  supported_locales: ['vi-VN', 'en-US'],
  required_capabilities: ['engine:html-v1', 'profile:mp4-720p-v1'],
  composition_spec: {
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
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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
          type: 'cut',
          duration_frames: 0,
        },
        layers: [
          {
            id: 'layer_problem_text',
            type: 'text',
            start_frame: 0,
            duration_frames: 210,
            z_index: 1,
            box: {
              x: 100,
              y: 280,
              width: 1080,
              height: 160,
            },
            content: {
              text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
              font_id: 'font_title',
              font_size: 44,
              color: '#FFFFFF',
              align: 'center',
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
          type: 'cut',
          duration_frames: 0,
        },
        layers: [
          {
            id: 'layer_solution_title',
            type: 'text',
            start_frame: 0,
            duration_frames: 240,
            z_index: 1,
            box: {
              x: 100,
              y: 280,
              width: 1080,
              height: 160,
            },
            content: {
              text: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn',
              font_id: 'font_title',
              font_size: 40,
              color: '#4CC9F0',
              align: 'center',
            },
          },
        ],
      },
      {
        id: 'scene_architecture',
        revision: 1,
        start_frame: 450,
        duration_frames: 240,
        engine: 'html-v1',
        transition_out: {
          type: 'cut',
          duration_frames: 0,
        },
        layers: [
          {
            id: 'layer_arch_title',
            type: 'text',
            start_frame: 0,
            duration_frames: 240,
            z_index: 1,
            box: {
              x: 100,
              y: 280,
              width: 1080,
              height: 160,
            },
            content: {
              text: 'Kiến trúc bất biến, tối ưu hoá CPU và hỗ trợ tiếng Việt',
              font_id: 'font_title',
              font_size: 38,
              color: '#F72585',
              align: 'center',
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
              x: 100,
              y: 280,
              width: 1080,
              height: 160,
            },
            content: {
              text: 'Bắt đầu tự động hóa quy trình ngay hôm nay',
              font_id: 'font_title',
              font_size: 42,
              color: '#7209B7',
              align: 'center',
            },
          },
        ],
      },
    ],
    audio_tracks: [
      {
        id: 'track_narration',
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
          font_size: 24,
          color: '#FFFFFF',
          background: '#000000B3',
          align: 'center',
          max_lines: 2,
          safe_margin_px: 48,
        },
        cues: [
          {
            id: 'cue_01',
            start_frame: 15,
            end_frame: 195,
            text: 'Khó khăn trong việc mở rộng quy trình sản xuất video?',
          },
          {
            id: 'cue_02',
            start_frame: 225,
            end_frame: 435,
            text: 'Creativanta Video Engine: Giải pháp render bằng mã nguồn độc lập.',
          },
          {
            id: 'cue_03',
            start_frame: 465,
            end_frame: 675,
            text: 'Kiến trúc bất biến, tối ưu hoá CPU và hỗ trợ đầy đủ tiếng Việt.',
          },
          {
            id: 'cue_04',
            start_frame: 705,
            end_frame: 870,
            text: 'Bắt đầu tự động hóa quy trình sản xuất video ngay hôm nay.',
          },
        ],
      },
    ],
  },
};
