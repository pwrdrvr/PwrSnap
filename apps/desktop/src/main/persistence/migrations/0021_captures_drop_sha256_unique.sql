-- @no-foreign-keys
-- 0021_captures_drop_sha256_unique — remove the `UNIQUE` constraint
-- from `captures.sha256` so two captures of identical pixels can
-- coexist.
--
-- Why this is intentional: a user can paste the same image into the
-- library five times and edit each copy differently. The dedup-by-
-- source-hash that the old constraint enforced was an optimization
-- borrowed from the screencap flow ("don't store the same screencap
-- twice") that turned into a usability bug for the paste-from-
-- clipboard flow: "New from Clipboard" silently returned the same
-- capture you copied from, because round-tripping a no-visible-
-- overlay capture through bake → toPNG → clipboard → paste produced
-- byte-identical bytes (same sha256) and dedup fired.
--
-- The `sha256` column itself stays — it's the content-addressable
-- key the v2 bundle uses to reference raster sources inside the ZIP
-- (`sources/<sha>.png`). Multiple captures can now share the same
-- sha256 value; that's fine, the column is just metadata at this
-- point. No replacement index either — after the dedup callers are
-- removed (captures-repo.findCaptureBySha256, ON CONFLICT) nothing
-- queries the captures table by sha256.
--
-- SQLite can't ALTER TABLE DROP CONSTRAINT, so this is the standard
-- 12-step table recreate (cf. 0007). Foreign-keys off (via the
-- @no-foreign-keys marker on line 1) so the layers/overlays/
-- render_cache/video_captures/video_export_cache FKs survive the
-- DROP + RENAME — they resolve by table NAME, and we rename
-- captures_new → captures before re-enabling foreign_keys.
--
-- Why we jumped from 0017 → 0021 (skipping 0018-0020): earlier
-- iterations of this branch shipped the same migration at 0017
-- (collided with capture_search_fts) and 0018 (no trigger
-- recreation — silently dropped 0017's captures_*_fts triggers,
-- breaking library:search on every machine that ran the dev build
-- of that intermediate revision). Renumbering to 0021 forces the
-- final, correct version to run on those machines and recreate
-- their FTS5 triggers + replay the backfill. 0019 + 0020 stay
-- reserved so future PRs don't accidentally pick a number a
-- partially-applied dev DB has already recorded.

CREATE TABLE captures_new (
  id                              TEXT NOT NULL PRIMARY KEY,
  kind                            TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  captured_at                     TEXT NOT NULL,
  source_app_bundle_id            TEXT,
  source_app_name                 TEXT,
  legacy_src_path                 TEXT,
  bundle_path                     TEXT,
  flat_png_path                   TEXT,
  bundle_modified_at              TEXT,
  bundle_edits_version            INTEGER NOT NULL DEFAULT 0,
  width_px                        INTEGER NOT NULL,
  height_px                       INTEGER NOT NULL,
  device_pixel_ratio              REAL NOT NULL DEFAULT 1.0,
  byte_size                       INTEGER NOT NULL,
  -- The only thing that changes versus 0007: no `UNIQUE` here.
  sha256                          TEXT NOT NULL,
  edits_version                   INTEGER NOT NULL DEFAULT 0,
  deleted_at                      TEXT,
  bundle_format_version           INTEGER NOT NULL DEFAULT 1,
  legacy_bundle_attempts          INTEGER NOT NULL DEFAULT 0,
  legacy_bundle_last_failed_at    TEXT,
  legacy_composite_v2_attempts    INTEGER NOT NULL DEFAULT 0,
  legacy_composite_v2_last_failed_at TEXT,
  legacy_composite_v2_migrated_at TEXT,
  v1_to_v2_attempts               INTEGER NOT NULL DEFAULT 0,
  v1_to_v2_last_failed_at         TEXT,
  v1_to_v2_last_error_code        TEXT
);

INSERT INTO captures_new (
  id, kind, captured_at,
  source_app_bundle_id, source_app_name,
  legacy_src_path,
  bundle_path, flat_png_path, bundle_modified_at, bundle_edits_version,
  width_px, height_px, device_pixel_ratio,
  byte_size, sha256,
  edits_version, deleted_at,
  bundle_format_version,
  legacy_bundle_attempts, legacy_bundle_last_failed_at,
  legacy_composite_v2_attempts, legacy_composite_v2_last_failed_at,
  legacy_composite_v2_migrated_at,
  v1_to_v2_attempts, v1_to_v2_last_failed_at, v1_to_v2_last_error_code
)
SELECT
  id, kind, captured_at,
  source_app_bundle_id, source_app_name,
  legacy_src_path,
  bundle_path, flat_png_path, bundle_modified_at, bundle_edits_version,
  width_px, height_px, device_pixel_ratio,
  byte_size, sha256,
  edits_version, deleted_at,
  bundle_format_version,
  legacy_bundle_attempts, legacy_bundle_last_failed_at,
  legacy_composite_v2_attempts, legacy_composite_v2_last_failed_at,
  legacy_composite_v2_migrated_at,
  v1_to_v2_attempts, v1_to_v2_last_failed_at, v1_to_v2_last_error_code
FROM captures;

-- Drop the old table + its indexes. FKs on other tables pointing at
-- captures(id) (layers, overlays, render_cache, video_captures,
-- video_export_cache) keep working through the swap because SQLite
-- resolves FK references by table name and we rename below.
DROP INDEX IF EXISTS idx_captures_timeline;
DROP INDEX IF EXISTS idx_captures_deleted_at;
DROP INDEX IF EXISTS idx_captures_bundle_path;
DROP INDEX IF EXISTS idx_captures_legacy_composite_v2_pending;
DROP INDEX IF EXISTS idx_captures_v1_to_v2_pending;
DROP TABLE captures;

ALTER TABLE captures_new RENAME TO captures;

-- Recreate the indexes — same definitions as their original
-- migrations (0007 for timeline / deleted_at / bundle_path,
-- 0013 for legacy_composite_v2_pending, 0014 for v1_to_v2_pending).
CREATE INDEX idx_captures_timeline
  ON captures (source_app_bundle_id, captured_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_captures_deleted_at
  ON captures (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_captures_bundle_path
  ON captures (bundle_path)
  WHERE bundle_path IS NOT NULL;

CREATE INDEX idx_captures_legacy_composite_v2_pending
  ON captures (legacy_composite_v2_migrated_at)
  WHERE bundle_path IS NOT NULL
    AND deleted_at IS NULL
    AND kind = 'image'
    AND legacy_composite_v2_migrated_at IS NULL;

CREATE INDEX idx_captures_v1_to_v2_pending
  ON captures (id)
  WHERE bundle_path IS NOT NULL
    AND deleted_at IS NULL
    AND bundle_format_version = 1
    AND v1_to_v2_attempts < 5;

-- Recreate the FTS5 sync triggers from migration 0017. SQLite
-- silently drops triggers when their owning table is dropped, so
-- the DROP TABLE captures above just took out:
--   • captures_ai_fts  (AFTER INSERT — seeds capture_search_fts row)
--   • captures_au_fts  (AFTER UPDATE OF source_app_name)
--   • captures_ad_fts  (AFTER DELETE — cascades into capture_search_fts)
-- Without recreation, library:search would silently miss every
-- capture inserted after this migration runs. Bodies copied verbatim from
-- 0017_capture_search_fts.sql — keep in sync if 0017 ever changes.
-- (Triggers on capture_enrichments survive because that table isn't
-- recreated by this migration.)

CREATE TRIGGER IF NOT EXISTS captures_ai_fts AFTER INSERT ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = NEW.id;
  INSERT INTO capture_search_fts (
    capture_id, title, description, ocr_text, source_app_name
  ) VALUES (
    NEW.id, NULL, NULL, NULL, NEW.source_app_name
  );
END;

CREATE TRIGGER IF NOT EXISTS captures_au_fts
AFTER UPDATE OF source_app_name ON captures
BEGIN
  UPDATE capture_search_fts
     SET source_app_name = NEW.source_app_name
   WHERE capture_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS captures_ad_fts AFTER DELETE ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = OLD.id;
END;

-- Replay the capture_search_fts backfill for the rows that survived
-- the table swap. INSERT INTO captures_new SELECT FROM captures
-- preserved the row data, but the AFTER INSERT trigger doesn't fire
-- inside a CREATE TABLE … AS-style copy, so the FTS5 rows for
-- existing captures were untouched by 0017's INSERT … SELECT only
-- to be cleared again here by the DELETE FROM capture_search_fts
-- (the table was repopulated by 0017 in the same migration run on
-- fresh installs). For users who already had 0017 applied before
-- this migration ships, their FTS5 rows reference the OLD capture
-- ids — same ids, same content, but we re-seed defensively so a
-- crash mid-rename can't leave the FTS5 index pointing at zero rows.
DELETE FROM capture_search_fts;
INSERT INTO capture_search_fts (
  capture_id, title, description, ocr_text, source_app_name
)
SELECT
  captures.id,
  COALESCE(capture_enrichments.accepted_title, capture_enrichments.suggested_title),
  COALESCE(capture_enrichments.accepted_description, capture_enrichments.suggested_description),
  capture_enrichments.ocr_text,
  captures.source_app_name
FROM captures
LEFT JOIN capture_enrichments ON capture_enrichments.capture_id = captures.id
WHERE captures.deleted_at IS NULL;
