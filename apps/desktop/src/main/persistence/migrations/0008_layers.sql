-- 0008_layers — Bundle format v2 + layer tree + unified edits-version
-- columns. See docs/plans/2026-05-07-002-feat-bundle-format-v2-layer-tree-plan.md.
--
-- Schema changes:
--
-- 1. Rename v1 convergence columns to unify v1/v2 semantics. Same
--    columns work for both formats; the TABLE being read (overlays
--    for v1, layers for v2) is already gated by bundle_format_version.
--      captures.overlays_version    → captures.edits_version
--      captures.bundle_overlays_version → captures.bundle_edits_version
--      render_cache.overlays_version → render_cache.edits_version
--
-- 2. Add captures.bundle_format_version. Cached projection; the doctor
--    reconciles it from manifest.bundle_format_version on every read
--    so a rename-vs-UPDATE crash gap doesn't leave the row claiming v1
--    while the bundle is v2. Stored value is a hint, not authoritative.
--
-- 3. Add the layers table — flat list with parent_id + z_index +
--    soft-delete columns mirroring v1's overlays table exactly.
--    AI-staging index (idx_layers_capture_pending) is the actual
--    justification for storing layers as rows vs JSON blob.
--
-- The captures column renames are in-place ALTER TABLE RENAME COLUMN,
-- supported since SQLite 3.25 and better-sqlite3 12.x. No table
-- recreation needed (foreign_keys stays ON).

ALTER TABLE captures RENAME COLUMN overlays_version TO edits_version;
ALTER TABLE captures RENAME COLUMN bundle_overlays_version TO bundle_edits_version;
ALTER TABLE render_cache RENAME COLUMN overlays_version TO edits_version;

ALTER TABLE captures ADD COLUMN bundle_format_version INTEGER NOT NULL DEFAULT 1;

CREATE TABLE layers (
  id              TEXT NOT NULL PRIMARY KEY,    -- nanoid(16), URL-safe
  capture_id      TEXT NOT NULL,
  parent_id       TEXT,                          -- NULL = root group
  kind            TEXT NOT NULL CHECK (kind IN ('group','raster','vector','effect')),
  z_index         INTEGER NOT NULL DEFAULT 0,    -- sibling order; gaps allowed
  name            TEXT NOT NULL DEFAULT '',
  visible         INTEGER NOT NULL DEFAULT 1,    -- 0/1 boolean
  locked          INTEGER NOT NULL DEFAULT 0,
  opacity         REAL NOT NULL DEFAULT 1.0,
  blend_mode      TEXT NOT NULL DEFAULT 'normal',
  transform_json  TEXT NOT NULL DEFAULT '[1,0,0,1,0,0]',
  data            TEXT NOT NULL,                 -- kind-specific JSON; zod-validated at every read/write
  schema_version  INTEGER NOT NULL DEFAULT 1,
  source          TEXT NOT NULL CHECK (source IN ('user','codex','draft')),
  ai_run_id       TEXT,
  applied_at      TEXT,
  rejected_at     TEXT,                          -- cascades transitively from parent group (handled in repo, not FK)
  superseded_by   TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES layers(id) ON DELETE CASCADE,
  FOREIGN KEY (superseded_by) REFERENCES layers(id) ON DELETE SET NULL
);

-- Hot path: editor reads the live tree for a capture in one shot.
-- "Live" filter mirrors the overlays index from 0002.
CREATE INDEX idx_layers_capture_tree
  ON layers (capture_id, parent_id, z_index, created_at)
  WHERE applied_at IS NOT NULL
    AND rejected_at IS NULL
    AND superseded_by IS NULL;

-- AI-suggestion staging — Phase 4+ read path. This is the actual
-- justification for storing layers in rows (not as a JSON blob on
-- captures): AI-suggested layers need to be queryable as a fragment
-- of state independent of the user's accepted tree.
CREATE INDEX idx_layers_capture_pending
  ON layers (capture_id, ai_run_id)
  WHERE applied_at IS NULL
    AND rejected_at IS NULL
    AND superseded_by IS NULL;
