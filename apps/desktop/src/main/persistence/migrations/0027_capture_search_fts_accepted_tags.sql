-- 0027_capture_search_fts_accepted_tags — rebuild the normal-content FTS5
-- index with accepted content tags. The prior table (0017) has no external
-- content dependency, so rebuilding inside this migration transaction is the
-- safest way to add a column and backfill every existing capture atomically.
--
-- Accepted tags live in `capture_tags` joined to content-kind `tags`; AI
-- suggestions are deliberately excluded until accepted. Search still filters
-- Trash at query time, but discovery and FTS both retain the index row so a
-- restored capture is immediately searchable again.

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
  accepted_tags,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Capture lifecycle and source-app changes.
CREATE TRIGGER captures_ai_fts AFTER INSERT ON captures
BEGIN
  DELETE FROM capture_search_fts WHERE capture_id = NEW.id;
  INSERT INTO capture_search_fts (
    capture_id, title, description, ocr_text, source_app_name, accepted_tags
  ) VALUES (
    NEW.id, NULL, NULL, NULL, NEW.source_app_name, NULL
  );
END;

CREATE TRIGGER captures_au_fts
AFTER UPDATE OF source_app_name ON captures
BEGIN
  UPDATE capture_search_fts
     SET source_app_name = NEW.source_app_name
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
-- tags are intentionally excluded: external discovery/search exposes the
-- human source-app name separately and only accepted user/Codex tags here.
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

-- Backfill every indexed field. This runs after the fresh virtual table is in
-- place, so users upgrading from 0017 gain tag search immediately.
INSERT INTO capture_search_fts (
  capture_id, title, description, ocr_text, source_app_name, accepted_tags
)
SELECT
  captures.id,
  COALESCE(capture_enrichments.accepted_title, capture_enrichments.suggested_title),
  COALESCE(capture_enrichments.accepted_description, capture_enrichments.suggested_description),
  capture_enrichments.ocr_text,
  captures.source_app_name,
  (
    SELECT GROUP_CONCAT(tags.label, ' ')
    FROM capture_tags
    JOIN tags ON tags.id = capture_tags.tag_id
    WHERE capture_tags.capture_id = captures.id
      AND tags.kind = 'content'
  )
FROM captures
LEFT JOIN capture_enrichments ON capture_enrichments.capture_id = captures.id;

-- Exact human-app filters and the app discovery facet both use the same live
-- subset. This avoids a table scan as a library grows.
CREATE INDEX IF NOT EXISTS idx_captures_live_source_app_name
  ON captures (source_app_name, captured_at DESC, id DESC)
  WHERE deleted_at IS NULL
    AND source_app_name IS NOT NULL
    AND source_app_name != '';
