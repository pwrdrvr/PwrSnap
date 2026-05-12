-- 0004_settings — narrow durable app settings store.

CREATE TABLE app_settings (
  key         TEXT NOT NULL PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
