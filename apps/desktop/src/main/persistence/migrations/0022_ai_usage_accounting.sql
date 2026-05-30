-- 0022_ai_usage_accounting — per-run Codex token, cost, and media accounting.
--
-- Stores only metadata needed to explain PwrSnap-originated AI usage.
-- Image bytes, prompts, OCR output, and secrets do not belong here.

ALTER TABLE ai_runs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE ai_runs ADD COLUMN task TEXT NOT NULL DEFAULT 'enrich';
ALTER TABLE ai_runs ADD COLUMN selected_model TEXT;

CREATE TABLE IF NOT EXISTS ai_run_usage (
  ai_run_id                              TEXT NOT NULL PRIMARY KEY,
  thread_id                              TEXT,
  turn_id                                TEXT,
  model                                  TEXT,
  model_provider                         TEXT,
  service_tier                           TEXT,
  usage_status                           TEXT NOT NULL CHECK (usage_status IN ('available', 'unavailable')),
  usage_unavailable_reason               TEXT,
  total_tokens                           INTEGER,
  input_tokens                           INTEGER,
  cached_input_tokens                    INTEGER,
  output_tokens                          INTEGER,
  reasoning_output_tokens                INTEGER,
  model_context_window                   INTEGER,
  price_status                           TEXT NOT NULL CHECK (price_status IN ('available', 'unavailable')),
  price_unavailable_reason               TEXT,
  currency                               TEXT,
  catalog_version                        TEXT,
  pricing_source_url                     TEXT,
  priced_at                              TEXT,
  rate_snapshot_json                     TEXT,
  uncached_input_tokens                  INTEGER,
  estimated_uncached_input_cost_micros   INTEGER,
  estimated_cached_input_cost_micros     INTEGER,
  estimated_output_cost_micros           INTEGER,
  estimated_total_cost_micros            INTEGER,
  created_at                             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_run_usage_model
  ON ai_run_usage (model, updated_at);

CREATE INDEX IF NOT EXISTS idx_ai_run_usage_price_status
  ON ai_run_usage (price_status, updated_at);

CREATE TABLE IF NOT EXISTS ai_run_media_inputs (
  id                    TEXT NOT NULL PRIMARY KEY,
  ai_run_id             TEXT NOT NULL,
  ordinal               INTEGER NOT NULL,
  role                  TEXT NOT NULL,
  transform             TEXT NOT NULL,
  source_mime_type      TEXT,
  sent_mime_type        TEXT NOT NULL,
  format                TEXT NOT NULL,
  encoder               TEXT,
  quality               INTEGER,
  source_width_px       INTEGER,
  source_height_px      INTEGER,
  sent_width_px         INTEGER NOT NULL,
  sent_height_px        INTEGER NOT NULL,
  sent_byte_size        INTEGER NOT NULL,
  max_edge_px           INTEGER,
  max_bytes             INTEGER,
  scale_ratio           REAL,
  video_position_pct    INTEGER,
  video_timestamp_sec   REAL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id) ON DELETE CASCADE,
  UNIQUE (ai_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_ai_run_media_inputs_run
  ON ai_run_media_inputs (ai_run_id, ordinal);
