/**
 * System capabilities and supported profiles.
 * Canonical specification: docs/API.md (line 58)
 */

export type EngineId = 'html-v1' | 'canvas-v1' | 'svg-v1' | 'custom-html-v1';

export type ProfileId = 'mp4-720p-v1' | 'preview-360p-v1';

export interface ProfileDefinition {
  id: ProfileId;
  description: string;
  supported: boolean;
  dimensions: {
    width: number;
    height: number;
  }[];
  fps: {
    num: number;
    den: number;
  };
  container: 'mp4' | 'png';
  video_codec?: string;
  audio_codec?: string;
  max_duration_seconds: number;
}

export interface CapabilitiesResponse {
  api_version: string;
  scene_schema_versions: string[];
  engines: Record<EngineId, boolean>;
  profiles: Record<ProfileId, ProfileDefinition>;
  limits: {
    max_duration_frames: number;
    max_scenes: number;
    max_layers_per_scene: number;
    max_audio_tracks: number;
    max_subtitles: number;
    max_fonts: number;
    max_upload_bytes: number;
  };
  features: {
    remote_import: boolean;
    custom_code: boolean;
    authoring_adapter: boolean;
    tts: boolean;
  };
  policy_version: string;
}
