-- 0007_ai_enrichment_title — add Title to AI enrichment.
--
-- Until this migration, every AI-described capture lived in one freeform
-- "description" field. The Library sidebar and float-over rendered that
-- as a card headline and as a paragraph at the same time, which is
-- legible at 1–2 sentences and breaks at 3+. Title is the short
-- headline; description is the prose body. Both fields feed the future
-- Sizzle-Reel composer as separate inputs to the script-generation
-- prompt, so they need to be persisted independently.
--
-- Columns mirror the existing description pair: a `suggested_*` slot
-- for Codex's draft and an `accepted_*` slot for what the user agreed
-- to (or typed themselves). NULL on both means the field is empty.

ALTER TABLE capture_enrichments ADD COLUMN suggested_title       TEXT;
ALTER TABLE capture_enrichments ADD COLUMN accepted_title        TEXT;
ALTER TABLE capture_enrichments ADD COLUMN title_accepted_at     TEXT;
