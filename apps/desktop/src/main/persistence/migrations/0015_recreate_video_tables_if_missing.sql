-- 0015_recreate_video_tables_if_missing — defensive heal for
-- pre-existing DB corruption where `video_captures` and
-- `video_export_cache` (both created by migration 0005) are missing
-- even though `schema_migrations` claims version 5 is applied.
--
-- The corruption was observed on a real user DB in May 2026: the
-- schema_migrations row for version 5 was dated 2026-05-15 with the
-- captures table containing a row whose kind='video', but the two
-- tables 0005 created were absent. Nothing in any migration drops
-- them. Most likely cause is an ad-hoc DROP TABLE (manual debugging,
-- third-party SQLite tool, etc.) executed outside the migrations
-- pipeline at some point in the past.
--
-- This migration uses CREATE TABLE IF NOT EXISTS so:
--   • Healthy DBs (where 0005 created the tables and they still
--     exist): no-op. The CREATE statements skip silently.
--   • Corrupted DBs (where the tables vanished): tables get
--     re-created with the same shape as 0005 and video features start
--     working again on the next launch.
--
-- The CREATE TABLE body MUST stay byte-identical to 0005 so a healthy
-- DB's existing tables remain compatible with the schema the rest of
-- the codebase queries against. If 0005 ever changes its schema, this
-- migration becomes redundant or needs a counterpart update.
--
-- Note: the corresponding row inserts (video_captures rows for
-- captures.kind='video') aren't backfilled here — that would need a
-- recorder re-discovery pass that the doctor doesn't ship today.
-- Affected video captures will render with NULL metadata in the
-- library (using the captures-row dimensions / app fields as
-- fallback) until the user re-imports or re-records them. Listing
-- captures (`library:list`) no longer crashes — that's the
-- user-facing win.

CREATE TABLE IF NOT EXISTS video_captures (
  capture_id            TEXT NOT NULL PRIMARY KEY,
  duration_sec          REAL NOT NULL,
  container_format      TEXT NOT NULL CHECK (container_format IN ('mp4', 'mov')),
  has_system_audio      INTEGER NOT NULL DEFAULT 0 CHECK (has_system_audio IN (0, 1)),
  has_microphone_audio  INTEGER NOT NULL DEFAULT 0 CHECK (has_microphone_audio IN (0, 1)),
  default_range_start_sec REAL NOT NULL DEFAULT 0,
  default_range_end_sec   REAL NOT NULL,
  preview_path          TEXT,
  preview_status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (preview_status IN ('pending', 'ready', 'failed')),
  subject_kind          TEXT NOT NULL CHECK (subject_kind IN ('region', 'window', 'display')),
  subject_display_id    INTEGER,
  subject_window_id     INTEGER,
  source_rect_x_px      INTEGER,
  source_rect_y_px      INTEGER,
  source_rect_w_px      INTEGER,
  source_rect_h_px      INTEGER,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_export_cache (
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

CREATE INDEX IF NOT EXISTS idx_video_export_cache_capture
  ON video_export_cache (capture_id);
