// Pure decision logic for "where does the view go when a capture is
// soft-deleted." Extracted from Library so it can be unit-tested without
// mounting the (very large) Library component — this is the exact logic that
// fixes the "Delete didn't close the image, so I clicked again and trashed a
// neighbor" trap, so it's worth pinning down directly.

import type { LibraryView } from "./library-view";

export type DeleteNavAction =
  | { readonly type: "NAVIGATE"; readonly recordId: string }
  | { readonly type: "CLOSE_FOCUS" }
  | null;

/**
 * Decide how the view should move when `deletedId` is trashed.
 *
 * - Grid mode, or deleting a capture that ISN'T the one on screen (a reel
 *   filmstrip frame other than the selected one): no view change → `null`.
 * - Deleting the on-screen capture in Focus/Reel: advance to the NEXT
 *   capture; at the end of the visible set, fall back to the PREVIOUS one
 *   (no wrap — jumping back to the top after deleting the last item loses
 *   the user's place).
 * - Deleting the only remaining capture: `CLOSE_FOCUS` in Focus; `null` in
 *   Reel (the reel has no closed state — the stale-selection guard handles
 *   the now-empty set).
 *
 * Callers pass the CURRENT visible id list (before the delete lands); the
 * deleted id is still present in it.
 */
export function nextAfterDelete(args: {
  readonly viewKind: LibraryView["kind"];
  readonly selectedRecordId: string | null;
  readonly deletedId: string;
  readonly visibleIds: readonly string[];
}): DeleteNavAction {
  const { viewKind, selectedRecordId, deletedId, visibleIds } = args;
  // Only the capture currently on screen needs the view to move.
  if (viewKind !== "focus" && viewKind !== "reel") return null;
  if (selectedRecordId !== deletedId) return null;

  const idx = visibleIds.indexOf(deletedId);
  // Unknown id or the last remaining capture: nothing to advance to.
  if (idx < 0 || visibleIds.length <= 1) {
    return viewKind === "focus" ? { type: "CLOSE_FOCUS" } : null;
  }

  // Prefer the next capture; at the end, fall back to the previous.
  const neighborIdx = idx === visibleIds.length - 1 ? idx - 1 : idx + 1;
  const recordId = visibleIds[neighborIdx];
  if (recordId === undefined) {
    return viewKind === "focus" ? { type: "CLOSE_FOCUS" } : null;
  }
  return { type: "NAVIGATE", recordId };
}
