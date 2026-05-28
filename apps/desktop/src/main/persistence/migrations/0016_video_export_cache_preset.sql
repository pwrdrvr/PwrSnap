-- 0016_video_export_cache_preset — adds a `preset` column to
-- video_export_cache so each (format, preset) combination keys
-- independently. Before this migration, the cache key was
-- (captureId, range, format, audio) and the encoder used hardcoded
-- params (GIF: 720p15fps; MP4: stream-copy at source resolution).
-- After this migration, the cache key gains `preset` (low / med /
-- high) and the encoder reads per-preset specs from
-- `recording-exporter.ts::GIF_PRESETS / MP4_PRESETS`.
--
-- Existing rows are dropped, not backfilled. Two reasons:
--   1. We can't accurately tag legacy rows — the old GIF encoder's
--      720p/15fps maps loosely to MED, but the old MP4 encoder's
--      source-resolution stream-copy maps to HIGH. Tagging
--      everything as MED would lie about MP4 rows; tagging
--      everything as HIGH would lie about GIF rows; tagging per-
--      format requires a row-by-row update with format-specific
--      logic. None of this is worth it for a cache: the worst case
--      is a one-time re-encode the next time the user clicks.
--   2. The legacy on-disk filename layout doesn't include the
--      preset token — those files live at
--      `r<range>.<audio-tag>.<ext>`. Even if we backfilled the row,
--      the exporter looks for a file at the new layout
--      `r<range>.<preset>.<audio-tag>.<ext>` and would re-encode on
--      cache miss anyway. The DROP avoids dangling cache rows that
--      point at a path the new exporter doesn't write.
--
-- Orphaned files on disk are left in place; the render-cache
-- maintenance pass evicts them based on access time. The size hit
-- of leaving them around is bounded by the existing eviction policy.

-- SQLite can't ALTER TABLE to add a column to a PRIMARY KEY tuple,
-- so we recreate the table. The new schema's PRIMARY KEY now
-- includes `preset`.

CREATE TABLE video_export_cache__new (
  capture_id            TEXT NOT NULL,
  range_start_sec       REAL NOT NULL,
  range_end_sec         REAL NOT NULL,
  format                TEXT NOT NULL CHECK (format IN ('gif', 'mp4')),
  preset                TEXT NOT NULL CHECK (preset IN ('low', 'med', 'high')),
  include_system_audio  INTEGER NOT NULL DEFAULT 0 CHECK (include_system_audio IN (0, 1)),
  include_microphone    INTEGER NOT NULL DEFAULT 0 CHECK (include_microphone IN (0, 1)),
  path                  TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (
    capture_id, range_start_sec, range_end_sec, format, preset,
    include_system_audio, include_microphone
  ),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

-- DROP the old table — existing rows do NOT get backfilled into the
-- new shape (per the comment above). Users pay a one-time re-encode
-- on first click of each preset; the cache then warms naturally.
DROP TABLE video_export_cache;

ALTER TABLE video_export_cache__new RENAME TO video_export_cache;

CREATE INDEX IF NOT EXISTS idx_video_export_cache_capture
  ON video_export_cache (capture_id);
