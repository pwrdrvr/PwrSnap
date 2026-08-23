-- 0029_capture_source_window_title — retain the title of the exact source
-- window selected for a window capture. NULL means the capture did not target
-- a window, the platform did not expose a title, or the selected window could
-- no longer be resolved when capture began.
--
-- The FTS5 table is a normal-content index and SQLite cannot add a virtual-
-- table column in place. Rebuild it atomically, following 0027, so existing
-- enrichment and accepted-tag search data survives while window titles become
-- searchable.

ALTER TABLE captures ADD COLUMN source_window_title TEXT;

DROP TRIGGER IF EXISTS captures_ai_fts;
DROP TRIGGER IF EXISTS captures_au_fts;
DROP TRIGGER IF EXISTS captures_ad_fts;
DROP TRIGGER IF EXISTS capture_enrichments_ai_fts;
DROP TRIGGER IF EXISTS capture_enrichments_au_fts;
DROP TRIGGER IF EXISTS capture_enrichments_ad_fts;
DROP TRIGGER IF EXISTS capture_tags_ai_fts;
DROP TRIGGER IF EXISTS capture_tags_ad_fts;
DROP TRIGGER IF EXISTS capture_tags_au_fts;
DROP TRIGGER IF EXISTS tags_au_fts;

DROP TABLE IF EXISTS capture_search_fts;

CREATE VIRTUAL TABLE capture_search_fts USING fts5(
  capture_id UNINDEXED,
  title,
  description,
  ocr_text,
  source_app_name,
  source_window_title,
  accepted_tags,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Capture lifecycle and source metadata changes.
CREATE TRIGGER captures_ai_fts AFTER INSERT ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = NEW.id;
  INSERT INTO capture_search_fts (
    capture_id, title, description, ocr_text,
    source_app_name, source_window_title, accepted_tags
  ) VALUES (
    NEW.id, NULL, NULL, NULL,
    NEW.source_app_name, NEW.source_window_title, NULL
  );
END;

CREATE TRIGGER captures_au_fts
AFTER UPDATE OF source_app_name, source_window_title ON captures
BEGIN
  UPDATE capture_search_fts
     SET source_app_name = NEW.source_app_name,
         source_window_title = NEW.source_window_title
   WHERE capture_id = NEW.id;
END;

CREATE TRIGGER captures_ad_fts AFTER DELETE ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = OLD.id;
END;

-- Enrichment fields retain their existing title/description/OCR precedence.
CREATE TRIGGER capture_enrichments_ai_fts
AFTER INSERT ON capture_enrichments
BEGIN
  UPDATE capture_search_fts
     SET title       = COALESCE(NEW.accepted_title, NEW.suggested_title),
         description = COALESCE(NEW.accepted_description, NEW.suggested_description),
         ocr_text    = NEW.ocr_text
   WHERE capture_id = NEW.capture_id;
END;

CREATE TRIGGER capture_enrichments_au_fts
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

CREATE TRIGGER capture_enrichments_ad_fts
AFTER DELETE ON capture_enrichments
BEGIN
  UPDATE capture_search_fts
     SET title = NULL, description = NULL, ocr_text = NULL
   WHERE capture_id = OLD.capture_id;
END;

-- Accepted content-tag changes update the dedicated FTS column. App-kind
-- tags are intentionally excluded.
CREATE TRIGGER capture_tags_ai_fts
AFTER INSERT ON capture_tags
BEGIN
  UPDATE capture_search_fts
     SET accepted_tags = (
       SELECT GROUP_CONCAT(tags.label, ' ')
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE capture_tags.capture_id = NEW.capture_id
         AND tags.kind = 'content'
     )
   WHERE capture_id = NEW.capture_id;
END;

CREATE TRIGGER capture_tags_ad_fts
AFTER DELETE ON capture_tags
BEGIN
  UPDATE capture_search_fts
     SET accepted_tags = (
       SELECT GROUP_CONCAT(tags.label, ' ')
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE capture_tags.capture_id = OLD.capture_id
         AND tags.kind = 'content'
     )
   WHERE capture_id = OLD.capture_id;
END;

CREATE TRIGGER capture_tags_au_fts
AFTER UPDATE OF capture_id, tag_id ON capture_tags
BEGIN
  UPDATE capture_search_fts
     SET accepted_tags = (
       SELECT GROUP_CONCAT(tags.label, ' ')
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE capture_tags.capture_id = OLD.capture_id
         AND tags.kind = 'content'
     )
   WHERE capture_id = OLD.capture_id;
  UPDATE capture_search_fts
     SET accepted_tags = (
       SELECT GROUP_CONCAT(tags.label, ' ')
       FROM capture_tags
       JOIN tags ON tags.id = capture_tags.tag_id
       WHERE capture_tags.capture_id = NEW.capture_id
         AND tags.kind = 'content'
     )
   WHERE capture_id = NEW.capture_id;
END;

CREATE TRIGGER tags_au_fts
AFTER UPDATE OF label, kind ON tags
BEGIN
  UPDATE capture_search_fts
     SET accepted_tags = (
       SELECT GROUP_CONCAT(tags_for_capture.label, ' ')
       FROM capture_tags AS capture_tags_for_capture
       JOIN tags AS tags_for_capture ON tags_for_capture.id = capture_tags_for_capture.tag_id
       WHERE capture_tags_for_capture.capture_id = capture_search_fts.capture_id
         AND tags_for_capture.kind = 'content'
     )
   WHERE capture_id IN (
     SELECT capture_id FROM capture_tags WHERE tag_id = NEW.id
   );
END;

-- Backfill every indexed field after creating the new virtual table.
INSERT INTO capture_search_fts (
  capture_id, title, description, ocr_text,
  source_app_name, source_window_title, accepted_tags
)
SELECT
  captures.id,
  COALESCE(capture_enrichments.accepted_title, capture_enrichments.suggested_title),
  COALESCE(capture_enrichments.accepted_description, capture_enrichments.suggested_description),
  capture_enrichments.ocr_text,
  captures.source_app_name,
  captures.source_window_title,
  (
    SELECT GROUP_CONCAT(tags.label, ' ')
    FROM capture_tags
    JOIN tags ON tags.id = capture_tags.tag_id
    WHERE capture_tags.capture_id = captures.id
      AND tags.kind = 'content'
  )
FROM captures
LEFT JOIN capture_enrichments ON capture_enrichments.capture_id = captures.id;

-- Keep the exact source-application facet index from 0027 present even when
-- 0029 repairs a database whose derived search schema drifted.
CREATE INDEX IF NOT EXISTS idx_captures_live_source_app_name
  ON captures (source_app_name, captured_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND source_app_name IS NOT NULL
    AND source_app_name != '';
