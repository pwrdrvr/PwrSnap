// Command-bus registration for `capture:videoInteractive` — the
// renderer-dispatchable entry into the interactive video-record flow
// (selector → recording:start) used by the tray's Record button and the
// Library's Video chip. The `videoCapture` global hotkey drives the same
// `runInteractiveRecord()` directly.
//
// Why its own module instead of an inline `bus.register` in index.ts:
// the dependencies live in index.ts (`runInteractiveRecord`, with all
// its region-selector focus-policy helpers) and in capture-handlers
// (`librarySourceWindowIds`), but `index.ts`'s `bootstrapApp()` can't be
// invoked in isolation, so an inline registration is untestable. Taking
// both as injected parameters keeps this module's imports light (no
// electron / persistence chain) and lets a unit test exercise the wiring
// — registration, protect-id resolution, and the fire-and-forget ack —
// with plain spies.

import { ok } from "@pwrsnap/shared";
import { bus, type CommandContext } from "../command-bus";
import { getMainLogger } from "../log";

/** Opens the selector and records what the user picks. Returns once the
 *  recording lifecycle is handed off; rejection is logged, not thrown. */
export type RunInteractiveRecord = (
  protectWindowIds: readonly number[]
) => Promise<void>;

/** Resolves which windows to content-protect out of the frozen snapshot
 *  for THIS dispatch (the Library when the record was triggered from its
 *  own button; empty for tray / hotkey triggers). */
export type ResolveProtectWindowIds = (ctx: CommandContext) => readonly number[];

export function registerCaptureVideoHandler(
  runInteractiveRecord: RunInteractiveRecord,
  resolveProtectWindowIds: ResolveProtectWindowIds
): void {
  bus.register("capture:videoInteractive", async (_req, ctx) => {
    // Fire-and-forget: the selector, countdown, and recording lifecycle
    // surface on the `events:recording:*` broadcasts, so we ack
    // immediately rather than awaiting the whole pick→countdown→record
    // chain. A rejection (e.g. the permission gate throwing) is logged
    // here so it never becomes an unhandled rejection.
    void runInteractiveRecord(resolveProtectWindowIds(ctx)).catch((cause) => {
      getMainLogger("pwrsnap:capture").warn("capture:videoInteractive failed", {
        message: cause instanceof Error ? cause.message : String(cause)
      });
    });
    return ok(undefined);
  });
}
