-- ==============================================================================
-- Migration 003: Seed synthetic system catalog with baseline profiles and starter fonts
-- Canonical specification: docs/SCENE-SPEC.md & docs/API.md (lines 58-60)
-- ==============================================================================

INSERT INTO system_catalog (key, category, value, visibility)
VALUES
  ('profile:mp4-720p-v1', 'profile', '{
    "id": "mp4-720p-v1",
    "description": "Standard 720p H.264 MP4 render (1280x720 landscape or 720x1280 portrait at 30fps)",
    "supported": true,
    "dimensions": [
      { "width": 1280, "height": 720 },
      { "width": 720, "height": 1280 }
    ],
    "fps": { "num": 30, "den": 1 },
    "container": "mp4",
    "video_codec": "h264",
    "audio_codec": "aac",
    "max_duration_seconds": 180
  }'::jsonb, 'curated_public'),
  ('profile:preview-360p-v1', 'profile', '{
    "id": "preview-360p-v1",
    "description": "Fast 360p preview (scale 0.5 from 720p canvas; PNG frame or MP4 clip)",
    "supported": true,
    "dimensions": [
      { "width": 640, "height": 360 },
      { "width": 360, "height": 640 }
    ],
    "fps": { "num": 30, "den": 1 },
    "container": "mp4",
    "video_codec": "h264",
    "audio_codec": "aac",
    "max_duration_seconds": 60
  }'::jsonb, 'curated_public'),
  ('engine:html-v1', 'engine', '{"name": "html-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:canvas-v1', 'engine', '{"name": "canvas-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:svg-v1', 'engine', '{"name": "svg-v1", "supported": true}'::jsonb, 'curated_public'),
  ('engine:custom-html-v1', 'engine', '{"name": "custom-html-v1", "supported": false}'::jsonb, 'curated_public')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP;
