-- 0034_video_segments — cuts inside a video's trim.
--
-- A video's edit used to be one range (`default_range_*`). It is now a
-- list of KEPT spans in source time: gaps between them are cuts, and
-- touching spans are a split the user placed with both sides kept. See
-- packages/shared/src/video-segments.ts.
--
-- `segments_json` holds that list as a JSON array of {start, end}.
-- NULL means "one span equal to default_range" — every row written
-- before this migration, and every edit that never had a cut or split.
-- `default_range_*` stays authoritative for the OUTER range (first start
-- → last end) and is kept in step on every write, so readers that only
-- know about one range (the sizzle scene seed) keep working.
ALTER TABLE video_captures ADD COLUMN segments_json TEXT;

-- The export cache key gains the spans. `segments_key` is '' for a
-- single contiguous span — exactly what every existing row is, so they
-- are copied across rather than dropped (unlike 0016, nothing about
-- their meaning changed) and a split-only edit keeps hitting them. A
-- multi-span export stores its canonical span list (`videoSpansKey`).
--
-- SQLite cannot add a column to a PRIMARY KEY in place; recreate.
CREATE TABLE video_export_cache__new (
  capture_id            TEXT NOT NULL,
  range_start_sec       REAL NOT NULL,
  range_end_sec         REAL NOT NULL,
  segments_key          TEXT NOT NULL DEFAULT '',
  format                TEXT NOT NULL CHECK (format IN ('gif', 'mp4')),
  preset                TEXT NOT NULL CHECK (preset IN ('low', 'med', 'high')),
  include_system_audio  INTEGER NOT NULL DEFAULT 0 CHECK (include_system_audio IN (0, 1)),
  include_microphone    INTEGER NOT NULL DEFAULT 0 CHECK (include_microphone IN (0, 1)),
  path                  TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (
    capture_id, range_start_sec, range_end_sec, segments_key, format, preset,
    include_system_audio, include_microphone
  ),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

INSERT INTO video_export_cache__new (
  capture_id, range_start_sec, range_end_sec, segments_key, format, preset,
  include_system_audio, include_microphone, path, byte_size, created_at
)
SELECT
  capture_id, range_start_sec, range_end_sec, '', format, preset,
  include_system_audio, include_microphone, path, byte_size, created_at
FROM video_export_cache;

DROP TABLE video_export_cache;

ALTER TABLE video_export_cache__new RENAME TO video_export_cache;

CREATE INDEX IF NOT EXISTS idx_video_export_cache_capture
  ON video_export_cache (capture_id);
