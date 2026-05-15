-- @no-foreign-keys
-- 0005_bundle_storage — durable edit storage moves the system of record
-- out of <userData>/captures/ into Snagit-style ZIP bundles
-- (`.pwrsnap`) plus paired flat composite PNGs in ~/Documents/PwrSnap/.
-- See docs/plans/2026-05-07-001-feat-pwrsnap-bundle-storage-plan.md.
--
-- src_path is renamed to legacy_src_path and made nullable. Any reader
-- that still expects the old <userData>/captures/<yyyy>/<mm>/<id>.png
-- shape breaks loudly at typecheck and runtime — the column's meaning
-- shifts at migration time, and "shifts meaning" silently is exactly
-- the failure mode this rename prevents. Nullable because new
-- bundle-only captures don't have a legacy path to remember.
--
-- bundle_overlays_version mirrors the value written into the bundle's
-- overlays.json. The convergence checkpoint between DB and bundle:
-- if captures.overlays_version > captures.bundle_overlays_version on
-- boot, a re-pack is owed (probably from a crash mid-debounce).
--
-- SQLite ALTER TABLE can't drop NOT NULL in place, so we recreate the
-- table. foreign_keys is OFF during the transaction (set by the
-- migration runner via PRAGMA foreign_keys=OFF only outside the txn?).
-- Per better-sqlite3 + SQLite docs, the table-recreate pattern is safe
-- inside a transaction as long as we DROP the old table before RENAME.

CREATE TABLE captures_new (
  id                       TEXT NOT NULL PRIMARY KEY,
  kind                     TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  captured_at              TEXT NOT NULL,
  source_app_bundle_id     TEXT,
  source_app_name          TEXT,
  -- Pre-migration src_path. NULL for bundle-only captures created after
  -- this migration ships. Historical record only; never read by the
  -- bundle read path.
  legacy_src_path          TEXT,
  -- Path to the .pwrsnap bundle under ~/Documents/PwrSnap/. The system
  -- of record post-migration. NULL until the legacy migration walks
  -- this row.
  bundle_path              TEXT,
  -- Paired flat composite PNG sibling — what users see in Finder.
  -- Regenerable from bundle's composite.png; doctor recreates if
  -- missing.
  flat_png_path            TEXT,
  -- ISO-8601 timestamp of the most recent bundle re-pack.
  bundle_modified_at       TEXT,
  -- Convergence checkpoint with bundle's overlays.json. Re-pack is
  -- owed when captures.overlays_version > this value.
  bundle_overlays_version  INTEGER NOT NULL DEFAULT 0,
  width_px                 INTEGER NOT NULL,
  height_px                INTEGER NOT NULL,
  device_pixel_ratio       REAL NOT NULL DEFAULT 1.0,
  byte_size                INTEGER NOT NULL,
  sha256                   TEXT NOT NULL UNIQUE,
  overlays_version         INTEGER NOT NULL DEFAULT 0,
  deleted_at               TEXT
);

INSERT INTO captures_new (
  id, kind, captured_at,
  source_app_bundle_id, source_app_name,
  legacy_src_path,
  bundle_path, flat_png_path, bundle_modified_at, bundle_overlays_version,
  width_px, height_px, device_pixel_ratio,
  byte_size, sha256,
  overlays_version, deleted_at
)
SELECT
  id, kind, captured_at,
  source_app_bundle_id, source_app_name,
  src_path,
  NULL, NULL, NULL, 0,
  width_px, height_px, device_pixel_ratio,
  byte_size, sha256,
  overlays_version, deleted_at
FROM captures;

-- Drop the old table + its indexes. The render_cache / overlays FKs
-- pointing at captures(id) are preserved through the swap because
-- SQLite resolves FK references by table name, and we rename
-- captures_new → captures below.
DROP INDEX IF EXISTS idx_captures_timeline;
DROP INDEX IF EXISTS idx_captures_deleted_at;
DROP TABLE captures;

ALTER TABLE captures_new RENAME TO captures;

-- Recreate the original indexes against the new table.
CREATE INDEX idx_captures_timeline
  ON captures (source_app_bundle_id, captured_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_captures_deleted_at
  ON captures (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- New: doctor reconcile + bundle-path lookup hot path.
CREATE INDEX idx_captures_bundle_path
  ON captures (bundle_path)
  WHERE bundle_path IS NOT NULL;
