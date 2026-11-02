/**
 * Canonical Scene & Composition specifications.
 * Canonical specification: docs/SCENE-SPEC.md
 */

export interface RationalFps {
  num: number;
  den: number;
}

export interface CanvasSpec {
  width: number;
  height: number;
  background?: string;
}

export interface BoxSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TransformSpec {
  translate_x?: number;
  translate_y?: number;
  scale_x?: number;
  scale_y?: number;
  rotate_deg?: number;
  origin_x?: number;
  origin_y?: number;
}

export interface LayerSpec {
  id: string;
  type: string;
  start_frame: number;
  duration_frames: number;
  z_index: number;
  box: BoxSpec;
  opacity?: number;
  transform?: TransformSpec;
  content: Record<string, unknown>;
}

export interface SceneSpec {
  id: string;
  revision: number;
  start_frame: number;
  duration_frames: number;
  engine: 'html-v1' | 'canvas-v1' | 'svg-v1' | 'custom-html-v1';
  background?: string;
  transition_out?: {
    type: 'cut' | 'fade';
    duration_frames: number;
  };
  layers: LayerSpec[];
}

export interface FontReference {
  id: string;
  asset_id: string;
  sha256: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
}

export interface AudioTrackSpec {
  id: string;
  asset_id: string;
  start_frame: number;
  duration_frames: number;
  gain_db?: number;
  trim_start_ms?: number;
}

export interface SubtitleCue {
  start_frame: number;
  end_frame: number;
  text: string;
}

export interface SubtitleTrackSpec {
  id: string;
  locale: string;
  cues: SubtitleCue[];
}

export interface CompositionSpec {
  schema_version: '1.0';
  canvas: CanvasSpec;
  fps: RationalFps;
  duration_frames: number;
  seed: number;
  locale: 'vi-VN' | 'en-US';
  direction?: 'ltr' | 'rtl';
  fonts: FontReference[];
  scenes: SceneSpec[];
  audio_tracks: AudioTrackSpec[];
  subtitles: SubtitleTrackSpec[];
  metadata?: Record<string, string>;
  extensions?: Record<string, unknown>;
}
