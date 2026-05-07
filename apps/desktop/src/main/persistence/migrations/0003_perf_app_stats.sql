-- 0003_perf_app_stats — denormalized app counts + recency-leading
-- partial index. Pairs with the perf-seeder work tracked in
-- docs/plans/2026-05-07-001-feat-perf-seeder-and-library-scale-plan.md.
--
-- The captures table can grow into the 100k+ range; the Library's
-- sidebar grouping needs counts per source_app_bundle_id without
-- COUNT(*) on the load path, and the unfiltered timeline read needs
-- a recency-leading partial index (the existing idx_captures_timeline
-- leads with bundle_id, so an unfiltered ORDER BY captured_at DESC
-- query falls back to a temp b-tree).
--
-- Per-app live counts. NULL bundle_id stays NULL; a partial unique
-- index on COALESCE(bundle_id, '') gives us point-lookup + UPSERT
-- without a magic sentinel value leaking into reads. CHECK (count >= 0)
-- catches double-decrement bugs at the DB layer.
CREATE TABLE app_stats (
  source_app_bundle_id  TEXT,
  count                 INTEGER NOT NULL DEFAULT 0,
  CHECK (count >= 0)
);

CREATE UNIQUE INDEX idx_app_stats_bundle
  ON app_stats (COALESCE(source_app_bundle_id, ''));

-- Backfill from any existing rows. GROUP BY honors NULL — every NULL
-- bundle_id row collapses to a single (NULL, COUNT(*)) entry. At 100k
-- rows this is one full scan + hash aggregate; well under 2s on the
-- desktop pragma profile.
INSERT INTO app_stats (source_app_bundle_id, count)
SELECT source_app_bundle_id, COUNT(*)
FROM captures
WHERE deleted_at IS NULL
GROUP BY source_app_bundle_id;

-- Recency-leading partial index for unfiltered Library timeline reads.
-- BOTH columns DESC so the planner satisfies the Library's
-- `ORDER BY captured_at DESC, id DESC` with a single forward index
-- walk — no temp b-tree. The `(captured_at, id) < (?, ?)` keyset
-- predicate is also lowered to a range scan against this index
-- (SQLite ≥3.15 row-value optimization). Pairs with the existing
-- idx_captures_timeline (kept) which serves the filter-by-app path.
CREATE INDEX idx_captures_recency
  ON captures (captured_at DESC, id DESC)
  WHERE deleted_at IS NULL;
