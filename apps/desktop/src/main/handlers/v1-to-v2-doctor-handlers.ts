// Command-bus handlers for the `v1ToV2:*` namespace — the per-capture
// v1 → v2 bundle doctor (Phase 3 of docs/plans/2026-05-23-001-feat-v2-
// editor-plan.md).
//
// Three verbs:
//   • `v1ToV2:upgrade`  — fired by the renderer on first edit-open of
//                         a v1 capture. Doctor migrates in place; the
//                         editor reads v2 thereafter.
//   • `v1ToV2:status`   — late-mount race recovery for the doctor
//                         banner. Renderer dispatches on mount to pick
//                         up the cached progress snapshot, then
//                         subscribes to `events:v1-to-v2-doctor:progress`
//                         for live updates. Same pattern as
//                         `migration:status` for the legacy-bundle
//                         banner (see library-handlers.ts:421 +
//                         legacy-bundle-migration.ts cachedProgress).
//   • `v1ToV2:retry`    — clears parked state for a capture that hit
//                         the MAX_ATTEMPTS=5 retry budget; bound to
//                         the Retry button on the editor's "Couldn't
//                         upgrade — read-only view" banner.

import { ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";
import { getDb } from "../persistence/db";
import {
  clearParkedState,
  getLastDoctorProgressSnapshot,
  migrateBundleV1ToV2
} from "../persistence/v1-to-v2-doctor";

export function registerV1ToV2DoctorHandlers(): void {
  // Per-capture lazy upgrade. The doctor function already returns
  // `Result<{ migrated, reason }, PwrSnapError>` with the same
  // envelope shape the bus expects, so this is a straight pass-through.
  bus.register("v1ToV2:upgrade", async (req) => {
    return migrateBundleV1ToV2(req.captureId);
  });

  // Cached-snapshot reader. Same race-safe pattern as
  // `migration:status`: the renderer's banner dispatches this on
  // mount because `webContents.send` is fire-and-forget — any progress
  // events broadcast before the renderer's IPC listener attached are
  // lost. The doctor maintains the snapshot inside its module-level
  // cache (`getLastDoctorProgressSnapshot`).
  bus.register("v1ToV2:status", async () => {
    return ok(getLastDoctorProgressSnapshot());
  });

  // Unpark a capture so the next `v1ToV2:upgrade` resets the retry
  // budget. Bound to the editor's Retry button after the doctor
  // exhausted MAX_ATTEMPTS=5 on a malformed v1 bundle.
  bus.register("v1ToV2:retry", async (req) => {
    clearParkedState(getDb(), req.captureId);
    return ok(undefined);
  });
}
