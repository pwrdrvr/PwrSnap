-- 0012_legacy_composite_v2_attempts — bookkeeping for Pass C of the
-- legacy-bundle migration: rewriting bundles that still ship
-- `composite.png` byte-identical to `source.png` so the inner
-- composite drops out and a small `composite_thumbnail.jpg` takes
-- its place.
--
-- PR #90 introduced `composite_thumbnail.jpg` as the rendered
-- preview the Thumbnail Extension prefers (1024px JPEG q80, ~5% of
-- composite.png byte size). New captures pack this; old bundles
-- still carry a full-resolution composite.png that's just a copy of
-- source.png — wasted bytes, slower decode, ugly in Finder until the
-- Thumbnail Extension renders. Pass C of `runLegacyBundleMigration`
-- rewrites them in place.
--
-- Mirrors the 0009 pattern for the same reasons:
--   • `legacy_composite_v2_attempts` — count of attempts. Pass C
--     parks rows that hit MAX_ATTEMPTS (5).
--   • `legacy_composite_v2_last_failed_at` — ISO-8601 timestamp of
--     last failure; runner enforces ≥ 1h backoff between attempts.
--
-- Once Pass C succeeds for a row, attempts stays at 0 — the row's
-- bundle no longer matches the Pass C selection predicate (because
-- composite.png is gone), so it doesn't re-enter the queue.

ALTER TABLE captures ADD COLUMN legacy_composite_v2_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN legacy_composite_v2_last_failed_at TEXT;
