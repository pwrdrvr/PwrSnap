-- Exact portable values and document order that do not fit the operational
-- enrichment/layer projections. NULL marks a carrier written by 0029 before
-- this follow-up; repack recovers those values once from the already-validated
-- installed bundle and fills them on its next successful write.
ALTER TABLE capture_bundle_carriers
  ADD COLUMN full_tags_json TEXT;

ALTER TABLE capture_bundle_carriers
  ADD COLUMN layer_order_json TEXT;
