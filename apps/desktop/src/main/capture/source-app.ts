// Shared source-app resolution helpers. The image capture handler and
// the interactive recording entry point both attribute a capture/
// recording to whatever app owns the window the user pointed at; this
// module is their single source of truth so the two paths can't drift
// (image → "Claude", video → "Unknown App" was the symptom of an
// earlier drift).
//
// Also home to the pure decision helper that the video-recording entry
// uses to gate "raise our window vs. yield focus to the previous app"
// — same input shape (selection + snapshot + our pids), kept here
// alongside the resolver so both decisions stay aligned.

import type { Rect } from "@pwrsnap/shared";
import { findWindowAt, type WindowInfo } from "./window-list";

/**
 * Resolve the source app by hit-testing the rect's center against the
 * window-list snapshot. Returns the topmost window under the center
 * point, or null if no window covers it.
 */
export function resolveSourceAppByRect(
  rect: Rect,
  windows: readonly WindowInfo[]
): WindowInfo | null {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return findWindowAt(windows, cx, cy);
}

/**
 * Find a window in the snapshot by its CGWindowList id. Used after a
 * snap-to-window commit to recover full app metadata (bundle id, app
 * name) for the source.
 */
export function findWindowById(
  windows: readonly WindowInfo[],
  windowId: number
): WindowInfo | null {
  return windows.find((w) => w.windowId === windowId) ?? null;
}

/**
 * Three-tier resolution for the source-app of a selector commit:
 *
 *   1. If the user snapped to a window, look it up by id.
 *   2. If that fails (the window closed between selection + capture,
 *      moved to another display, etc.), fall back to a rect-center hit
 *      test against the same snapshot.
 *   3. If the user drew a free region (no snap), only the hit test.
 *
 * Shared by `capture:interactive` and the video-recording entry point
 * so the same selection attributes the same source app regardless of
 * which one the user kicked off.
 */
export function resolveSelectionSourceApp(
  rect: Rect,
  snappedWindowId: number | undefined,
  windows: readonly WindowInfo[]
): WindowInfo | null {
  if (snappedWindowId !== undefined) {
    return findWindowById(windows, snappedWindowId) ?? resolveSourceAppByRect(rect, windows);
  }
  return resolveSourceAppByRect(rect, windows);
}

/**
 * Decide whether the video-recording flow should consider raising our
 * own windows after the user commits a selection. The actual raise
 * looks up live `BrowserWindow` instances by intersecting the rect
 * with their bounds — this helper just gates whether that step should
 * run at all.
 *
 * Rules:
 *   - User snapped to one of OUR windows → consider raising. The user
 *     explicitly pointed at PwrSnap; we want it on top.
 *   - User snapped to ANOTHER app's window → leave focus alone. They
 *     picked Claude / Finder / etc.; raising the Library would obscure
 *     the very window they wanted to record (e.g. when the Library is
 *     sitting partially behind Claude on screen).
 *   - No snap (free-region drag) → consider raising. If the rect
 *     happens to overlap our window, the user clearly meant to include
 *     it in the recording, so it should be visible during capture.
 *
 * `ourPids` is the result of `selfPidSet()`. Pid-matching for the
 * snapped window is sufficient for the user-facing snap target case
 * (Library / Settings / Sizzle / edit). DevTools windows share our
 * pid but the user explicitly opened them and is unlikely to mind
 * either branch's behavior — pragmatic over perfect.
 */
export function shouldConsiderRaisingOurWindows(
  snappedWindowId: number | undefined,
  snapshot: readonly WindowInfo[],
  ourPids: ReadonlySet<number>
): boolean {
  if (snappedWindowId === undefined) return true;
  const snapped = findWindowById(snapshot, snappedWindowId);
  if (snapped === null) return true; // unknown snap target → fall back to overlap check
  return ourPids.has(snapped.pid);
}
