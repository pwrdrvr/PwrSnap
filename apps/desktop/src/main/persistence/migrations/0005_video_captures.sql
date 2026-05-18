-- 0005_video_captures — Per-video metadata table for the Fast Video
-- Capture feature (issue #64). The base `captures` table already
-- accepts `kind = 'video'` (see 0001_init.sql) and stores the source
-- clip the same way it stores PNG sources: a single `src_path` plus
-- byte_size, sha256, dimensions, and source-app metadata. The columns
-- below carry the video-specific fields the float-over and Library
-- need without bloating the base row for image captures.
--
-- 1:1 with captures via FK + ON DELETE CASCADE so soft-delete /
-- hard-delete don't leak metadata. We don't index by capture_id
-- because the PK already enforces uniqueness; lookups are always by
-- exact id from a captures-row-in-hand.

CREATE TABLE video_captures (
  -- One row per video capture. FK to captures.id; cascade on
  -- hard-delete so the row disappears with its parent.
  capture_id            TEXT NOT NULL PRIMARY KEY,
  duration_sec          REAL NOT NULL,
  -- Container the source clip is written in. ScreenCaptureKit writes
  -- .mp4 in the default config (H.264 + AAC); leaving room for .mov
  -- in case we need to switch encoders for compatibility later.
  container_format      TEXT NOT NULL CHECK (container_format IN ('mp4', 'mov')),
  -- Whether the source clip actually contains the audio track. The
  -- user's capability request is intent; these flags are reality
  -- (the recorder might have dropped a track if a permission flipped
  -- mid-session). MP4 export reads these to disable/enable toggles.
  has_system_audio      INTEGER NOT NULL DEFAULT 0 CHECK (has_system_audio IN (0, 1)),
  has_microphone_audio  INTEGER NOT NULL DEFAULT 0 CHECK (has_microphone_audio IN (0, 1)),
  -- User's last-picked subrange. Defaults to the full clip on insert;
  -- the float-over scrubber writes back when the user picks a
  -- different range. Editor can recover the original by reading
  -- duration_sec + setting range to [0, duration_sec].
  default_range_start_sec REAL NOT NULL DEFAULT 0,
  default_range_end_sec   REAL NOT NULL,
  -- Relative path under captures/ for the silent hover-preview
  -- proxy generated post-recording. NULL while pending or failed —
  -- Library shows a poster frame fallback.
  preview_path          TEXT,
  preview_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (preview_status IN ('pending', 'ready', 'failed')),
  -- Subject metadata: what the user pointed at. Useful for the
  -- future editor's "recapture with same source" affordance and for
  -- analytics on which mode (region vs window vs display) people
  -- use most. NULL on display-wide recordings.
  subject_kind          TEXT NOT NULL CHECK (subject_kind IN ('region', 'window', 'display')),
  subject_display_id    INTEGER,
  subject_window_id     INTEGER,
  -- Recorded-at-start rect in physical pixels for the editor to
  -- reproduce the recording surface. Logical px would lose precision
  -- across DPI changes between recording and edit time.
  source_rect_x_px      INTEGER,
  source_rect_y_px      INTEGER,
  source_rect_w_px      INTEGER,
  source_rect_h_px      INTEGER,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

-- Quick-output cache. Keyed by (capture_id, range, format, audio
-- choices). One row per derived artifact; the file lives in the
-- render cache directory and is sweep-eligible on capture deletion.
-- Cache hits avoid re-running ffmpeg for repeated exports with the
-- same parameters.
CREATE TABLE video_export_cache (
  capture_id            TEXT NOT NULL,
  range_start_sec       REAL NOT NULL,
  range_end_sec         REAL NOT NULL,
  format                TEXT NOT NULL CHECK (format IN ('gif', 'mp4')),
  include_system_audio  INTEGER NOT NULL DEFAULT 0 CHECK (include_system_audio IN (0, 1)),
  include_microphone    INTEGER NOT NULL DEFAULT 0 CHECK (include_microphone IN (0, 1)),
  path                  TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (
    capture_id, range_start_sec, range_end_sec, format,
    include_system_audio, include_microphone
  ),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE INDEX idx_video_export_cache_capture
  ON video_export_cache (capture_id);
