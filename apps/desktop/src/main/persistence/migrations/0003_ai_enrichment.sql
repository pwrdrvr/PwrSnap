-- 0003_ai_enrichment — Codex OCR / description / tag suggestions.
--
-- Stores AI run status separately from accepted user metadata. OCR and
-- descriptions are sensitive local data: they stay in SQLite, are removed
-- by capture cascade, and should never be logged in full.

CREATE TABLE ai_runs (
  id                       TEXT NOT NULL PRIMARY KEY,
  capture_id               TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('enrich')),
  status                   TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  codex_command            TEXT,
  codex_version            TEXT,
  codex_protocol_version   TEXT,
  prompt_version           INTEGER NOT NULL DEFAULT 1,
  request_json             TEXT,
  response_json            TEXT,
  error                    TEXT,
  latency_ms               INTEGER,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  started_at               TEXT,
  completed_at             TEXT,
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);

CREATE INDEX idx_ai_runs_capture_kind
  ON ai_runs (capture_id, kind, created_at DESC);

CREATE INDEX idx_ai_runs_status
  ON ai_runs (status, created_at);

CREATE TABLE capture_enrichments (
  capture_id                TEXT NOT NULL PRIMARY KEY,
  latest_ai_run_id          TEXT,
  ocr_text                  TEXT,
  suggested_description     TEXT,
  accepted_description      TEXT,
  description_accepted_at   TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (latest_ai_run_id) REFERENCES ai_runs(id) ON DELETE SET NULL
);

CREATE TABLE enrichment_tag_suggestions (
  id                 TEXT NOT NULL PRIMARY KEY,
  capture_id         TEXT NOT NULL,
  ai_run_id          TEXT NOT NULL,
  label              TEXT NOT NULL,
  normalized_label   TEXT NOT NULL,
  confidence         REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  accepted_at        TEXT,
  rejected_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE CASCADE,
  UNIQUE (capture_id, ai_run_id, normalized_label)
);

CREATE INDEX idx_enrichment_tag_suggestions_capture
  ON enrichment_tag_suggestions (capture_id, created_at);

CREATE TABLE tags (
  id                 TEXT NOT NULL PRIMARY KEY,
  label              TEXT NOT NULL,
  normalized_label   TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'content' CHECK (kind IN ('content', 'app')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (kind, normalized_label)
);

CREATE TABLE capture_tags (
  capture_id      TEXT NOT NULL,
  tag_id          TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('user', 'codex', 'app')),
  ai_run_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (capture_id, tag_id),
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
  FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_capture_tags_tag
  ON capture_tags (tag_id, created_at);
