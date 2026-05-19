-- 0009_legacy_bundle_migration_attempts — bookkeeping for the
-- legacy-bundle migration's retry policy.
--
-- The migration walks `bundle_path IS NULL AND legacy_src_path IS NOT NULL`
-- rows on every boot. Without backoff a permanently-broken row (corrupt
-- PNG, missing file, bytes that fail to decode) keeps re-attempting
-- forever, producing a log entry per row per boot.
--
-- Two columns:
--   • `legacy_bundle_attempts` — count of attempts so far. The runner
--     skips rows whose count has hit MAX_ATTEMPTS (defined in
--     legacy-bundle-migration.ts; currently 5). At that point the row
--     is parked — visible via legacy_src_path, never re-attempted.
--     A doctor pass can reset this to 0 to retry after a fix.
--   • `legacy_bundle_last_failed_at` — ISO-8601 timestamp of the last
--     failure. Lets the runner add per-attempt backoff (e.g., skip if
--     the last attempt was within the last hour) without spamming the
--     log on every quick relaunch.
--
-- Both columns default to clean state (0 / NULL). Existing rows pick
-- up the defaults; no INSERTs needed.

ALTER TABLE captures ADD COLUMN legacy_bundle_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN legacy_bundle_last_failed_at TEXT;
