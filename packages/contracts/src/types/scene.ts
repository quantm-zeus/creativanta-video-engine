/**
 * Canonical Scene & Composition specifications for Creativanta Video Engine.
 * Canonical specification: docs/SCENE-SPEC.md and packages/contracts/schemas/scene.schema.json
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

export type AnimationProperty =
  | 'opacity'
  | 'translate_x'
  | 'translate_y'
  | 'scale_x'
  | 'scale_y'
  | 'rotate_deg';

export type AnimationEasing =
  | 'linear'
  | 'ease_in_quad'
  | 'ease_out_quad'
  | 'ease_in_out_quad';

export interface KeyframeSpec {
  frame: number;
  value: number;
}

export interface AnimationSpec {
  property: AnimationProperty;
  easing: AnimationEasing;
  keyframes: KeyframeSpec[];
}

export interface TextLayerContent {
  text: string;
  font_id: string;
  font_size: number;
  color: string;
  align?: 'left' | 'center' | 'right';
  line_height?: number;
  max_lines?: number;
  overflow?: 'error' | 'shrink' | 'ellipsis';
  min_font_size?: number;
  weight?: number;
}

export interface ImageLayerContent {
  asset_id: string;
  fit: 'contain' | 'cover' | 'stretch';
  anchor_x?: number;
  anchor_y?: number;
  alt?: string;
}

export interface VideoLayerContent {
  asset_id: string;
  fit: 'contain' | 'cover' | 'stretch';
  source_in_frame: number;
  playback_rate?: 1;
  loop?: boolean;
  anchor_x?: number;
  anchor_y?: number;
}

export interface ShapeLayerContent {
  shape: 'rect' | 'ellipse';
  fill: string;
  stroke?: string;
  stroke_width?: number;
  radius?: number;
}

export interface SvgLayerContent {
  asset_id: string;
  fit: 'contain' | 'cover' | 'stretch';
  anchor_x?: number;
  anchor_y?: number;
}

export type LayerContent =
  | TextLayerContent
  | ImageLayerContent
  | VideoLayerContent
  | ShapeLayerContent
  | SvgLayerContent;

export interface LayerSpec {
  id: string;
  type: 'text' | 'image' | 'video' | 'shape' | 'svg';
  start_frame: number;
  duration_frames: number;
  z_index: number;
  box: BoxSpec;
  opacity?: number;
  transform?: TransformSpec;
  animations?: AnimationSpec[];
  content: LayerContent;
}

export interface CutTransitionSpec {
  type: 'cut';
  duration_frames: 0;
}

export interface FadeToBackgroundTransitionSpec {
  type: 'fade_to_background';
  duration_frames: number; // 2..300
}

export type TransitionOutSpec = CutTransitionSpec | FadeToBackgroundTransitionSpec;

export interface CustomBundleSpec {
  id: string;
  revision: number;
  source_sha256: string;
  build_sha256: string;
  entrypoint: string;
  parameters: Record<string, unknown>;
}

export interface StandardSceneSpec {
  id: string;
  revision: number;
  start_frame: number;
  duration_frames: number;
  engine: 'html-v1' | 'canvas-v1' | 'svg-v1';
  background?: string;
  transition_out?: TransitionOutSpec;
  layers: LayerSpec[];
}

export interface CustomSceneSpec {
  id: string;
  revision: number;
  start_frame: number;
  duration_frames: number;
  engine: 'custom-html-v1';
  background?: string;
  transition_out?: TransitionOutSpec;
  bundle: CustomBundleSpec;
}

export type SceneSpec = StandardSceneSpec | CustomSceneSpec;

export interface FontReference {
  id: string;
  asset_id: string;
  sha256: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
}

export interface GainKeyframeSpec {
  frame: number;
  gain_db: number;
}

export interface AudioTrackSpec {
  id: string;
  asset_id: string;
  start_frame: number;
  duration_frames: number;
  source_in_samples: number;
  gain_db: number;
  role?: 'voice' | 'music' | 'effect';
  fade_in_frames?: number;
  fade_out_frames?: number;
  gain_keyframes?: GainKeyframeSpec[];
}

export interface SubtitleCue {
  id: string;
  start_frame: number;
  end_frame: number;
  text: string;
}

export interface SubtitleStyleSpec {
  font_id: string;
  font_size: number;
  color: string;
  background?: string;
  align?: 'left' | 'center' | 'right';
  max_lines?: number;
  safe_margin_px?: number;
}

export interface SubtitleTrackSpec {
  id: string;
  locale: 'vi-VN' | 'en-US';
  burn_in?: boolean;
  style?: SubtitleStyleSpec;
  cues: SubtitleCue[];
}

export type MetadataMap = Record<string, string>;
export type ExtensionsMap = Record<string, Record<string, unknown>>;

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
  metadata?: MetadataMap;
  extensions?: ExtensionsMap;
}
