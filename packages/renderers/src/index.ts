/**
 * @creativanta/renderers - Video rendering adapters and evaluation suite.
 * Canonical specification: docs/ADR/0001-engine-selection.md, docs/SCENE-SPEC.md, docs/ARCHITECTURE.md
 */

export * from './types.js';
export * from './common/base-adapter.js';
export * from './common/dom-builder.js';
export * from './common/frame-capture.js';
export * from './common/ffmpeg-builder.js';
export * from './chromium/chromium-adapter.js';
export * from './hyperframes/hyperframes-adapter.js';
export * from './comparison/adapter-comparator.js';
export * from './footage/cfr-trimmer.js';
export * from './subtitles/subtitle-generator.js';
export * from './audio/audio-mixer.js';
export * from './mp4/mp4-types.js';
export * from './mp4/mp4-muxer.js';
export * from './mp4/mp4-decoder.js';
export * from './pipeline/render-pipeline.js';
