-- 0013_legacy_composite_v2_migrated_at — durable completion marker
-- for Pass C of the legacy-bundle migration.
--
-- 0012 added retry/backoff fields for the composite.png ->
-- composite_thumbnail.jpg rewrite, but the runner over-selected every
-- bundled image row and used "composite.png is absent from the ZIP" as
-- the migrated predicate. SQLite cannot see inside the ZIP, so bundles
-- that were already composite.png-free were selected again on every
-- startup. This marker records that Pass C has inspected the bundle and
-- either rewrote it or confirmed it needs no rewrite.

ALTER TABLE captures ADD COLUMN legacy_composite_v2_migrated_at TEXT;

CREATE INDEX idx_captures_legacy_composite_v2_pending
  ON captures (legacy_composite_v2_migrated_at)
  WHERE bundle_path IS NOT NULL
    AND deleted_at IS NULL
    AND kind = 'image'
    AND legacy_composite_v2_migrated_at IS NULL;
