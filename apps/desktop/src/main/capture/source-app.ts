// Shared source-app resolution helpers. The image capture handler and
// the interactive recording entry point both attribute a capture/
// recording to whatever app owns the window the user pointed at; this
// module is their single source of truth so the two paths can't drift
// (image → "Claude", video → "Unknown App" was the symptom of an
// earlier drift).

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
