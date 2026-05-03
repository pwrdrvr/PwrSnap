-- 0001_init — Phase 1 schema. Two tables: captures + render_cache.
-- Other tables (overlays, tags, capture_tags, descriptions, ai_runs,
-- destinations, tag_destinations, uploads) defer to the migration that
-- introduces their first reader. Per the plan §"Phase 1 task list".

CREATE TABLE captures (
  id                    TEXT NOT NULL PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  captured_at           TEXT NOT NULL,
  source_app_bundle_id  TEXT,
  source_app_name       TEXT,
  src_path              TEXT NOT NULL,
  width_px              INTEGER NOT NULL,
  height_px             INTEGER NOT NULL,
  device_pixel_ratio    REAL NOT NULL DEFAULT 1.0,
  byte_size             INTEGER NOT NULL,
  sha256                TEXT NOT NULL UNIQUE,
  -- Monotonic version bumped per overlay write — Phase 2 read path uses
  -- this for lazy render_inputs_hash invalidation. Phase 1 keeps it at 0.
  overlays_version      INTEGER NOT NULL DEFAULT 0,
  -- Soft delete: source PNG is moved atomically to <root>/.trash/ when
  -- this column flips non-null; GC sweeps the trash dir after 14d.
  deleted_at            TEXT
);

-- Hot path: timeline queries by source app + recency.
CREATE INDEX idx_captures_timeline
  ON captures (source_app_bundle_id, captured_at DESC)
  WHERE deleted_at IS NULL;

-- Trash sweep target.
CREATE INDEX idx_captures_deleted_at
  ON captures (deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE render_cache (
  capture_id            TEXT NOT NULL,
  -- Snapshot of captures.overlays_version at render time. Cached row
  -- is stale (and safe to ignore on read) when this differs from the
  -- current capture.overlays_version.
  overlays_version      INTEGER NOT NULL,
  -- Canonical hash over (target_width, format, applied_overlays_ordered,
  -- color_profile, crop) — see render/overlay-hash.ts (Phase 2).
  -- For Phase 1, we only render at fixed widths with no overlays, so
  -- the hash is deterministic from (capture_id, target_width, format).
  render_inputs_hash    TEXT NOT NULL,
  target_width          INTEGER NOT NULL,
  format                TEXT NOT NULL CHECK (format IN ('png', 'webp')),
  path                  TEXT NOT NULL,
  byte_size             INTEGER NOT NULL,
  created_at            TEXT NOT NULL,
  PRIMARY KEY (capture_id, render_inputs_hash, format),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE INDEX idx_render_cache_capture
  ON render_cache (capture_id, overlays_version);
