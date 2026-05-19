-- 0008_ai_enrichment_filename — persist Codex's suggested export
-- filename stem alongside title/description.
--
-- Codex's enrichment turn already produces a `filenameStem` field
-- (lowercase-kebab-case, ≤120 chars) but until this migration it was
-- parsed and then discarded. The sidebar can't surface a suggested
-- filename without first writing it down, and the future "Save as…"
-- / drag-to-Finder rename flows will read the accepted value.
--
-- Columns mirror the title pair: `suggested_*` for Codex's draft and
-- `accepted_*` for what the user agreed to (or typed themselves).
-- NULL on both means the field is empty.

ALTER TABLE capture_enrichments ADD COLUMN suggested_filename_stem   TEXT;
ALTER TABLE capture_enrichments ADD COLUMN accepted_filename_stem    TEXT;
ALTER TABLE capture_enrichments ADD COLUMN filename_accepted_at      TEXT;
