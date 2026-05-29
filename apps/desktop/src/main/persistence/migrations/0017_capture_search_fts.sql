-- 0017_capture_search_fts — Full-text search index over capture
-- metadata. Feeds `library:search`, which in turn feeds the Sizzle
-- Composer chat agent's `library_search` tool so the user can drive
-- a big-prompt video brief ("show me Telegram onboarding, then the
-- pairing code, then…") and the agent picks captures from the
-- whole library by description / OCR / source app match.
--
-- Architecture: a normal FTS5 virtual table (NOT external content).
-- FTS5 owns + duplicates the searchable text. For our scale
-- (typically a few thousand captures, kilobytes of OCR each) the
-- storage overhead is trivial and we avoid the external-content
-- mode footgun where DELETE ops require passing the OLD column
-- values to FTS5 or the index gets stale tokens.
--
-- `capture_id` is a UNINDEXED column — stored in the row but not
-- tokenized, so it can be used in WHERE clauses for UPDATE / DELETE
-- targeting the matching capture without scanning the index.
--
-- `tokenize = "unicode61 remove_diacritics 2"` gives diacritic-
-- insensitive matching (so "résumé" matches "resume"), which matches
-- user expectations for both OCR and AI-generated text.

CREATE VIRTUAL TABLE IF NOT EXISTS capture_search_fts USING fts5(
  capture_id UNINDEXED,
  title,
  description,
  ocr_text,
  source_app_name,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ────────────────────────────────────────────────────────────────────
-- Triggers — keep the FTS5 index in sync with edits to the source
-- tables. Both `capture_enrichments` (title / description / OCR) and
-- `captures` (source_app_name + lifecycle) can change the searchable
-- fields, so we have triggers on both. They run inside the same
-- transaction as the source write — a crash mid-update leaves the
-- index consistent with the row.
--
-- Pattern: every change DELETEs the row(s) for the affected capture
-- and re-INSERTs. This is the safest way to avoid stale-token bugs
-- in FTS5; the storage cost is the same as an UPDATE because FTS5
-- internally rewrites UPDATEs as DELETE+INSERT anyway.

-- 1. captures.INSERT: seed an FTS5 row with whatever metadata exists
--    at capture-creation time (just source_app_name; the rest comes
--    later when AI enrichment runs).
CREATE TRIGGER IF NOT EXISTS captures_ai_fts AFTER INSERT ON captures
BEGIN
  -- DELETE first in case a partial-rerun left a stale row.
  DELETE FROM capture_search_fts WHERE capture_id = NEW.id;
  INSERT INTO capture_search_fts (
    capture_id, title, description, ocr_text, source_app_name
  ) VALUES (
    NEW.id, NULL, NULL, NULL, NEW.source_app_name
  );
END;

-- 2. captures.UPDATE of source_app_name: re-sync only that field
--    while preserving any AI-derived columns the enrichment triggers
--    populated.
--
-- FUTURE: if another searchable column gets added to the captures
-- table (not capture_enrichments), this trigger needs updating:
--   • add the column to the `OF …` list so the trigger fires on it
--   • add the column to the `UPDATE … SET …` body so it propagates
--   • add the column to captures_ai_fts (INSERT trigger above)
--   • add it to the backfill SELECT at the bottom of the file
--   • add it as a column on capture_search_fts (top of file)
-- Doing only some of these is a silent search-drift bug.
CREATE TRIGGER IF NOT EXISTS captures_au_fts
AFTER UPDATE OF source_app_name ON captures
BEGIN
  UPDATE capture_search_fts
     SET source_app_name = NEW.source_app_name
   WHERE capture_id = NEW.id;
END;

-- 3. captures.DELETE: cascade. The capture is gone, so the index
--    entry should be gone too. (Doesn't fire from `library:delete`,
--    which only soft-deletes — `deleted_at` is set but the row
--    stays. Soft-deleted rows are filtered out by `library:search`
--    at query time, not removed from the index.)
CREATE TRIGGER IF NOT EXISTS captures_ad_fts AFTER DELETE ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = OLD.id;
END;

-- 4. capture_enrichments.INSERT: fill in title / description / ocr_text
--    on the existing FTS5 row (which was seeded by `captures_ai_fts`).
--    `accepted_*` wins over `suggested_*` so the user's chosen text
--    is what's searchable.
CREATE TRIGGER IF NOT EXISTS capture_enrichments_ai_fts
AFTER INSERT ON capture_enrichments
BEGIN
  UPDATE capture_search_fts
     SET title       = COALESCE(NEW.accepted_title, NEW.suggested_title),
         description = COALESCE(NEW.accepted_description, NEW.suggested_description),
         ocr_text    = NEW.ocr_text
   WHERE capture_id = NEW.capture_id;
END;

-- 5. capture_enrichments.UPDATE of any searchable field: re-sync.
--    The OF clause restricts firing to only the field changes that
--    matter — `latest_ai_run_id` updates (very frequent) don't
--    rebuild the index entry.
CREATE TRIGGER IF NOT EXISTS capture_enrichments_au_fts
AFTER UPDATE OF
  accepted_title, suggested_title,
  accepted_description, suggested_description,
  ocr_text
ON capture_enrichments
BEGIN
  UPDATE capture_search_fts
     SET title       = COALESCE(NEW.accepted_title, NEW.suggested_title),
         description = COALESCE(NEW.accepted_description, NEW.suggested_description),
         ocr_text    = NEW.ocr_text
   WHERE capture_id = NEW.capture_id;
END;

-- 6. capture_enrichments.DELETE: clear title / description / ocr_text
--    but keep the FTS5 row (source_app_name still searchable).
CREATE TRIGGER IF NOT EXISTS capture_enrichments_ad_fts
AFTER DELETE ON capture_enrichments
BEGIN
  UPDATE capture_search_fts
     SET title = NULL, description = NULL, ocr_text = NULL
   WHERE capture_id = OLD.capture_id;
END;

-- ────────────────────────────────────────────────────────────────────
-- Backfill — populate the FTS5 index from existing rows. Migrations
-- run on first open after upgrade, so this is the one chance to
-- catch users who have an existing library.
--
-- Done as a single INSERT…SELECT so it's atomic with the trigger
-- creation. Rows that already have a `capture_search_fts` entry
-- (only possible on a partial-rerun in a development build) are
-- skipped via the WHERE NOT EXISTS guard.
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
WHERE NOT EXISTS (
  SELECT 1 FROM capture_search_fts WHERE capture_id = captures.id
);
