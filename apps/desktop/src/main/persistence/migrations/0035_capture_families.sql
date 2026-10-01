-- 0035_capture_families — lineage for duplicated captures.
--
-- Duplicating a capture makes a new capture with its own id, bundle (or
-- video file) and enrichment. Two columns tie the copies back together:
--
--   family_id        the id of the capture the family started from (the
--                    root). Set on the root itself the first time it is
--                    duplicated, so every member of a family — root and
--                    copies alike — shares one value. NULL = no family.
--   duplicated_from  the capture this one was copied from (its direct
--                    parent). A copy of a copy points at the copy, which is
--                    how the Family tab nests lineage. NULL on the root and
--                    on every capture that was never duplicated.
--
-- Deliberately NOT foreign keys: purging an original must not cascade into
-- its copies (they are independent captures), and a dangling reference is
-- expected once the original is purged — the family keeps its id.
--
-- The bundle manifest carries the same two fields so the lineage survives a
-- rebuilt index (see BundleManifestV2).
ALTER TABLE captures ADD COLUMN family_id TEXT;
ALTER TABLE captures ADD COLUMN duplicated_from TEXT;

CREATE INDEX IF NOT EXISTS idx_captures_family
  ON captures (family_id)
  WHERE family_id IS NOT NULL;
