-- 0023_ai_thread_usage — aggregate Codex usage for long-lived chat threads.
--
-- Capture enrichment records one row per run in ai_runs/ai_run_usage. Library
-- and Sizzle chats are long-lived threads, so they get one rolling row per
-- thread with per-turn token/cost deltas accumulated as the user interacts.

CREATE TABLE IF NOT EXISTS ai_thread_usage (
  thread_id                              TEXT NOT NULL PRIMARY KEY,
  surface                                TEXT NOT NULL CHECK (surface IN ('library-chat', 'sizzle-chat')),
  anchor_id                              TEXT,
  name                                   TEXT NOT NULL,
  task                                   TEXT NOT NULL,
  trigger_source                         TEXT NOT NULL,
  turn_count                             INTEGER NOT NULL DEFAULT 0,
  usage_unavailable_count                INTEGER NOT NULL DEFAULT 0,
  price_unavailable_count                INTEGER NOT NULL DEFAULT 0,
  last_turn_id                           TEXT,
  model                                  TEXT,
  model_provider                         TEXT,
  service_tier                           TEXT,
  total_tokens                           INTEGER NOT NULL DEFAULT 0,
  input_tokens                           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens                    INTEGER NOT NULL DEFAULT 0,
  output_tokens                          INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens                INTEGER NOT NULL DEFAULT 0,
  model_context_window                   INTEGER,
  currency                               TEXT,
  catalog_version                        TEXT,
  pricing_source_url                     TEXT,
  priced_at                              TEXT,
  rate_snapshot_json                     TEXT,
  uncached_input_tokens                  INTEGER NOT NULL DEFAULT 0,
  estimated_uncached_input_cost_micros   INTEGER NOT NULL DEFAULT 0,
  estimated_cached_input_cost_micros     INTEGER NOT NULL DEFAULT 0,
  estimated_output_cost_micros           INTEGER NOT NULL DEFAULT 0,
  estimated_total_cost_micros            INTEGER NOT NULL DEFAULT 0,
  created_at                             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                             TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES chat_threads(thread_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_thread_usage_updated
  ON ai_thread_usage (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_thread_usage_model
  ON ai_thread_usage (model, updated_at);
