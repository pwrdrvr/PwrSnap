-- 0002_overlays — Phase 2 starter.
--
-- Adds the `overlays` table. Schema mirrors the plan: every overlay
-- carries enough metadata for the AI-suggestion lifecycle (Phase 4)
-- even though only `kind=arrow` lands in this commit. Future tools
-- (rect, text, highlight, blur, crop, step) write the same row
-- shape with a different `data` blob.
--
-- Keep the row narrow; `data` is a JSON blob validated against the
-- discriminated union in packages/shared/src/overlay-schemas.ts at
-- every read AND every write. Schema version sits on the row so
-- future migrations can backfill old shapes without a separate
-- versioning table.

CREATE TABLE overlays (
  id              TEXT NOT NULL PRIMARY KEY,
  capture_id      TEXT NOT NULL,
  -- Validated zod blob: ArrowOverlay | RectOverlay | TextOverlay |
  -- HighlightOverlay | BlurOverlay | CropOverlay | StepOverlay.
  -- Coords are normalized [0,1]^2 fractions of source W×H.
  data            TEXT NOT NULL,
  -- Bumped on schema-shape changes. Phase 2 starts at 1; future
  -- migrations bump and may rewrite blobs in place.
  schema_version  INTEGER NOT NULL DEFAULT 1,
  -- Authorship.
  --   user   — drawn in the Edit-mode UI (current commit)
  --   codex  — Phase 4 AI suggestion (initially applied_at = null
  --            except for sensitive-data blurs which auto-apply)
  --   draft  — partial overlay persisted on app close mid-drag for
  --            "resume draft" recovery
  source          TEXT NOT NULL CHECK (source IN ('user', 'codex', 'draft')),
  -- AI run that produced this overlay (Phase 4). Always NULL for
  -- source='user'. Used by "regenerate" — the sweep deletes by
  -- ai_run_id, NEVER by (capture_id, source), so user-edited copies
  -- of AI suggestions survive.
  ai_run_id       TEXT,
  -- Application lifecycle:
  --   applied_at != NULL → render bake includes this overlay
  --   rejected_at != NULL → user explicitly rejected; suppressed
  --   superseded_by != NULL → another overlay supersedes this one
  --     (regenerate flow: old row gets superseded_by = new id, kept
  --     for undo)
  applied_at      TEXT,
  rejected_at     TEXT,
  superseded_by   TEXT,
  -- Render order within a capture (lower draws under higher). Each
  -- tool category occupies a band so blurs always sit under arrows
  -- regardless of insertion order.
  z_index         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (superseded_by) REFERENCES overlays(id) ON DELETE SET NULL
);

-- Hot path: editor reads all live overlays for a capture in one shot.
-- "Live" = applied AND not rejected AND not superseded.
CREATE INDEX idx_overlays_capture_live
  ON overlays (capture_id, z_index, created_at)
  WHERE applied_at IS NOT NULL
    AND rejected_at IS NULL
    AND superseded_by IS NULL;

-- AI-suggestion staging — Phase 4 read path.
CREATE INDEX idx_overlays_capture_pending
  ON overlays (capture_id, ai_run_id)
  WHERE applied_at IS NULL
    AND rejected_at IS NULL
    AND superseded_by IS NULL;
