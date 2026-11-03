/**
 * Canonical Compiler Manifest and Evaluation types for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md, docs/API.md, and docs/ARCHITECTURE.md
 */

import {
  RationalFps,
  BoxSpec,
  TransformSpec,
  AnimationSpec,
  LayerContent,
  FontReference,
  GainKeyframeSpec,
  SubtitleStyleSpec,
} from './scene.js';

export interface SceneManifest {
  id: string;
  revision: number;
  scene_hash: string;
  start_frame: number;
  duration_frames: number;
  end_frame: number;
  engine: 'html-v1' | 'canvas-v1' | 'svg-v1' | 'custom-html-v1';
  background: string;
  transition_out: {
    type: 'cut' | 'fade_to_background';
    duration_frames: number;
    fade_start_frame?: number;
    fade_end_frame?: number;
  };
  layers: LayerManifest[];
}

export interface LayerManifest {
  id: string;
  type: 'text' | 'image' | 'video' | 'shape' | 'svg';
  z_index: number;
  global_start_frame: number;
  global_end_frame: number;
  local_start_frame: number;
  local_duration_frames: number;
  box: BoxSpec;
  opacity: number;
  transform: Required<TransformSpec>;
  animations: AnimationSpec[];
  content: LayerContent;
}

export interface AudioTrackManifest {
  id: string;
  asset_id: string;
  start_frame: number;
  duration_frames: number;
  end_frame: number;
  sample_start: number;
  sample_count: number;
  source_in_samples: number;
  gain_db: number;
  role: 'voice' | 'music' | 'effect';
  fade_in_frames: number;
  fade_out_frames: number;
  gain_keyframes: GainKeyframeSpec[];
}

export interface SubtitleCueManifest {
  id: string;
  start_frame: number;
  end_frame: number;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface SubtitleTrackManifest {
  id: string;
  locale: 'vi-VN' | 'en-US';
  burn_in: boolean;
  style: SubtitleStyleSpec;
  cues: SubtitleCueManifest[];
}

export interface AssetManifestEntry {
  asset_id: string;
  kind?: string;
  sha256?: string;
  rights_basis?: 'owned' | 'licensed' | 'public_domain';
}

export interface CanonicalCompilerManifest {
  manifest_version: '1.0';
  compiler_version: string;
  composition_id: string;
  revision: number;
  profile: string;
  canvas: {
    width: number;
    height: number;
    background: string;
  };
  fps: RationalFps;
  duration_frames: number;
  duration_seconds: number;
  seed: number;
  locale: 'vi-VN' | 'en-US';
  direction: 'ltr' | 'rtl';
  spec_hash: string;
  render_hash: string;
  scenes: SceneManifest[];
  audio_tracks: AudioTrackManifest[];
  subtitles: SubtitleTrackManifest[];
  fonts: FontReference[];
  assets: Record<string, AssetManifestEntry>;
  required_capabilities: string[];
  compiled_at: string;
}

export interface EvaluatedLayerState {
  layer_id: string;
  type: 'text' | 'image' | 'video' | 'shape' | 'svg';
  z_index: number;
  opacity: number;
  transform: Required<TransformSpec>;
  box: BoxSpec;
  content: LayerContent;
}

export interface EvaluatedSceneState {
  id: string;
  revision: number;
  engine: string;
  background: string;
  local_frame: number;
  scene_alpha: number;
  transition_active: boolean;
}

export interface FrameEvaluationResult {
  frame_index: number;
  timestamp_seconds: number;
  audio_sample_offset: number;
  scene: EvaluatedSceneState;
  layers: EvaluatedLayerState[];
}
