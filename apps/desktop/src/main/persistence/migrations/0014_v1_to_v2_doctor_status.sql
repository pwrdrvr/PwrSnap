-- 0014_v1_to_v2_doctor_status — per-capture v1 → v2 bundle doctor state.
--
-- Adds three columns to `captures` so the per-capture v1 → v2 bundle
-- doctor (apps/desktop/src/main/persistence/v1-to-v2-doctor.ts) can
-- track its own progress independently of the legacy-bundle migration's
-- columns (0009 + 0012 + 0013). The two lifecycles are different:
--
--   • Legacy-bundle migration (`legacy_bundle_*`,
--     `legacy_composite_v2_*`) — one-shot boot-time sweep.
--   • v1 → v2 doctor (this migration) — lazy, per-capture, fired on
--     first edit-open of a bundle_format_version=1 capture. A
--     reconcileV1ToV2OnBoot() pass also runs at boot to heal any
--     mid-crash partial states.
--
-- Per-capture retry budget: 5 attempts. After the 5th failure the row
-- is "parked" — `v1_to_v2_last_error_code` is non-null AND
-- `v1_to_v2_attempts >= 5` — and the editor renders the capture
-- read-only with a "Couldn't upgrade — read-only view" banner + a
-- Retry button. The Retry button clears `v1_to_v2_attempts` (un-parks)
-- so the doctor can re-attempt on next user open.
--
-- See docs/plans/2026-05-23-001-feat-v2-editor-plan.md §"Phase 3" for
-- the full doctor spec.

ALTER TABLE captures ADD COLUMN v1_to_v2_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE captures ADD COLUMN v1_to_v2_last_failed_at TEXT;
ALTER TABLE captures ADD COLUMN v1_to_v2_last_error_code TEXT;

-- Partial index for the boot-time reconcile sweep. Only captures
-- that (a) have a bundle on disk, (b) are not soft-deleted, (c)
-- claim v1 in the DB, and (d) haven't exhausted their retry budget
-- need a doctor pass. Without the WHERE clause the index would
-- include every row in the table; partial keeps it tiny.
CREATE INDEX idx_captures_v1_to_v2_pending
  ON captures (id)
  WHERE bundle_path IS NOT NULL
    AND deleted_at IS NULL
    AND bundle_format_version = 1
    AND v1_to_v2_attempts < 5;
