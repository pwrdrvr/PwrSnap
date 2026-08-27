-- Bounded forward-compatible portable_* fields captured from the verified
-- v2 manifest/document snapshot. The JSON descriptor is validated on every
-- read/write and follows layer/AI identities rather than archive paths.
ALTER TABLE capture_bundle_carriers
  ADD COLUMN portable_metadata_json TEXT NOT NULL
  DEFAULT '{"version":1,"manifest":{},"document":{},"layers":{},"aiRuns":{}}';
