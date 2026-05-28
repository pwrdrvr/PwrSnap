// Geometry primitives + a BrowserWindow-aware helper that the
// recording flow uses to decide:
//
//   1. (post-commit, in main/index.ts) Whether to raise our windows
//      and skip `activateApp(previousAppPid)` — `runInteractiveRecord`.
//   2. (per-phase, in recording-controller.ts) Whether to fill the
//      recording rect with the countdown leader or anchor the HUD at
//      top-center so our own window stays visible during the
//      countdown — the image-capture flow never covers our surface,
//      and the video flow must match for PwrSnap-window subjects.
//
// Co-located so both call sites are guaranteed to agree on "is this
// rect overlapping one of our windows."

import { BrowserWindow, screen } from "electron";
import type { Rect } from "@pwrsnap/shared";

/**
 * Pure rect intersection. `a` follows the `Rect` shape; `b` follows
 * the BrowserWindow `getBounds()` shape. Edge contact is NOT overlap
 * (coords are half-open on the right + bottom, matching how Electron
 * + CGWindow treat window bounds in pixel space).
 */
export function rectIntersectsBounds(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  if (a.w <= 0 || a.h <= 0) return false;
  if (b.width <= 0 || b.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.w > b.x &&
    a.y < b.y + b.height &&
    a.y + a.h > b.y
  );
}

/**
 * Top-level PwrSnap windows visible on screen that intersect a
 * recording rect. `rect` is in display-local logical pixels
 * (selector convention); `displayId` identifies the display.
 *
 * `isVisible()` is the practical filter — by the time the recording
 * flow consults this helper, transient panels (tray popover, float-
 * over toast) are either hidden or off-screen (focus sink lives at
 * -10000,-10000). What's left in the visible set is the user-facing
 * Library / Settings / Sizzle / edit windows.
 *
 * `excludeWindow` opts a specific window out of the result. The
 * recording-controller call site passes its own HUD here — when the
 * HUD has already `fillRect`-ed itself to the recording rect, its
 * own bounds match and it would otherwise show up in the result,
 * which is meaningless for the "raise OUR user windows back to the
 * top" loop. The index.ts call site doesn't pass anything; the HUD
 * doesn't exist yet at that point.
 */
export function appWindowsOverlappingRect(
  rect: Rect,
  displayId: number,
  excludeWindow?: BrowserWindow
): BrowserWindow[] {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return [];
  const globalRect = {
    x: rect.x + display.bounds.x,
    y: rect.y + display.bounds.y,
    w: rect.w,
    h: rect.h
  };
  return BrowserWindow.getAllWindows().filter((win) => {
    if (win.isDestroyed()) return false;
    if (!win.isVisible()) return false;
    if (excludeWindow !== undefined && win === excludeWindow) return false;
    return rectIntersectsBounds(globalRect, win.getBounds());
  });
}
