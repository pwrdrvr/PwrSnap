-- 0036_capture_duplicate_intents — crash recovery for video duplicates.
--
-- A video duplicate copies the recording into `<staging_path>` (the copy's
-- final name + `.partial`), renames it to `<dest_path>`, and only then
-- inserts the capture row. The filesystem and SQLite cannot share a
-- transaction, so an intent is committed before the first byte is written
-- and deleted in the same transaction that inserts `capture_id`.
--
-- A row still here at startup is a copy that never committed: the process
-- died mid-copy, or between the rename and the insert. Recovery removes
-- both paths and the row. It never lists a directory — the paths are
-- exactly the two this copy could have written.
--
-- No foreign key: `capture_id` does not exist in `captures` until the
-- intent is gone.
CREATE TABLE IF NOT EXISTS capture_duplicate_intents (
  capture_id    TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL,
  staging_path  TEXT NOT NULL UNIQUE,
  dest_path     TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
