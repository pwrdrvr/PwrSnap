-- Durable ownership for cross-device v2 bundle imports.
--
-- The filesystem and SQLite cannot share one atomic transaction. An intent is
-- committed before a validated bundle is published, then deleted in the same
-- transaction that creates the capture row. If the process or machine stops in
-- between, startup reconciliation can adopt the exact intended bundle instead
-- of treating it as an unrelated file and importing a duplicate.
CREATE TABLE IF NOT EXISTS pwrsnap_import_intents (
  id                     TEXT PRIMARY KEY,
  capture_id             TEXT NOT NULL UNIQUE,
  bundle_path            TEXT NOT NULL UNIQUE,
  stage_path             TEXT NOT NULL,
  stage_identity_json    TEXT NOT NULL,
  archive_sha256         TEXT NOT NULL,
  archive_size           INTEGER NOT NULL CHECK (archive_size >= 0),
  content_digest         TEXT NOT NULL,
  capture_id_changed     INTEGER NOT NULL DEFAULT 0 CHECK (capture_id_changed IN (0, 1)),
  remapped_layer_count   INTEGER NOT NULL DEFAULT 0 CHECK (remapped_layer_count >= 0),
  published_identity_json TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Portable document fields that do not fit the operational enrichment ledger.
-- The projected description records what was materialized into the 2,000-char
-- UI schema, allowing repack to distinguish an unchanged projection from a
-- later user edit while preserving the bundle's full 4,096-char carrier.
CREATE TABLE IF NOT EXISTS capture_bundle_carriers (
  capture_id             TEXT PRIMARY KEY,
  full_description       TEXT,
  projected_description  TEXT,
  projected_tags_json    TEXT NOT NULL DEFAULT '[]',
  ai_runs_json           TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (capture_id) REFERENCES captures(id) ON DELETE CASCADE
);
