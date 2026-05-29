-- 0019_chat_threads — Library Chat thread INDEX (the "overlay").
--
-- NOTE on the version number: this started life as 0018, but three open
-- branches (this one, #157 drop-overlays, #135 captures-sha256) each
-- grabbed 0018. The migration runner keys off the version NUMBER, so on
-- any DB that already ran a sibling's 0018 our table would be silently
-- skipped. Renumbered to 0019 to clear that trio, and made idempotent
-- (IF NOT EXISTS) so a DB that DID run the earlier 0018_chat_threads is a
-- safe no-op. Final number is reconciled at merge per merge order.
--
-- PwrSnap owns chat metadata (name / anchor / focus history / archive +
-- pin); the message log + attachments stay on disk under
-- ~/Documents/PwrSnap/Chats/<dir_name>/ (founder storage decision
-- 2026-05-28 — chats live in the user's Documents, portable + visible).
-- This table is a fast INDEX over those dirs so the thread list + every
-- per-thread lookup is a single indexed query instead of an O(threads)
-- directory readdir + JSON-parse of every sidecar.
--
-- Mirrors PwrAgent's SQLite thread "overlay": index in the DB, content
-- on disk. Replaces the old `pwrsnap-thread.json` sidecar (which was the
-- read target of the now-removed locate()/list() scans). Existing
-- sidecars are imported once on first use by the store (never deleted).
--
-- dir_name is the thread directory's BASENAME relative to the Chats root
-- (NOT absolute — the Chats root moves with the user's home / a test
-- reroot). focus_history is a small JSON array, capped at write time.
-- archived / pinned are 0|1 ints. created_at / modified_at are ISO-8601
-- strings to match the rest of the schema. No FK to captures(id) on
-- anchor_capture_id: a chat may outlive the capture it was anchored to,
-- and a null anchor marks a library-wide thread.

CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id         TEXT NOT NULL PRIMARY KEY,
  dir_name          TEXT NOT NULL,
  name              TEXT NOT NULL,
  anchor_capture_id TEXT,
  archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  pinned            INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  focus_history     TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  modified_at       TEXT NOT NULL,
  schema_version    INTEGER NOT NULL DEFAULT 1
);

-- Hot path: the thread list scoped to a focused capture (chats are
-- glued to assets), newest activity first.
CREATE INDEX IF NOT EXISTS idx_chat_threads_anchor
  ON chat_threads (anchor_capture_id, modified_at DESC);

-- Hot path: the library-wide thread list, newest activity first.
CREATE INDEX IF NOT EXISTS idx_chat_threads_modified
  ON chat_threads (modified_at DESC);
