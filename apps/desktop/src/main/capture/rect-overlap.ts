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
//
// ---------------------------------------------------------------
// COORDINATE SPACES — read this before passing a rect to anything
// here. Getting it wrong is silent, and a no-op on the primary
// display, so it ships and is only ever reported from a
// multi-monitor desk.
//
// There are two logical-pixel spaces in play, and the ONLY thing
// separating them is `display.bounds.{x,y}`:
//
//   GLOBAL (virtual-screen)  — what `BrowserWindow.getBounds()`,
//     `setPosition`, `screen.getCursorScreenPoint()`, and
//     `SelectorResult.rect` are in. Origin is the virtual desktop's,
//     so a secondary display can sit at e.g. {x:1496, y:-473}.
//   DISPLAY-LOCAL — relative to one display's own top-left. What
//     the selector RENDERER reports (its window is display-sized),
//     what ScreenCaptureKit's `sourceRect` wants, and what
//     `appWindowsOverlappingRect` + the HUD's `fillRect` want.
//
// The trap: **the region selector's PUBLIC result is GLOBAL**, even
// though its renderer speaks display-local. `region-selector.ts`
// adds `display.bounds.{x,y}` when it builds `SelectorResult`, so
// anything downstream holding a `SelectorResult.rect` — or a
// `RecordingSubject.rect`, which is seeded from one — has a GLOBAL
// rect. Handing that to a display-local parameter adds the display
// origin a second time and points the test at empty desktop.
//
// So: if what you are holding came from the selector, either
// subtract the origin first (`subjectToPhysicalRect` in
// recording-service.ts is the recording flow's converter) or use
// `appWindowsOverlappingGlobalRect`, which takes the global rect
// directly and has no origin arithmetic to get wrong. Prefer the
// latter — it is the variant that cannot be misused.
// ---------------------------------------------------------------

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
 * recording rect expressed in GLOBAL virtual-screen logical pixels —
 * the same space `BrowserWindow.getBounds()` reports in, which is
 * why this variant needs no display and does no arithmetic.
 *
 * **This is the variant to reach for when you are holding a
 * `SelectorResult.rect` / `RecordingSubject.rect`** — those are
 * already global (see the coordinate-space note at the top of this
 * file), and passing one to `appWindowsOverlappingRect` instead
 * double-applies the display origin.
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
export function appWindowsOverlappingGlobalRect(
  globalRect: Rect,
  excludeWindow?: BrowserWindow
): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((win) => {
    if (win.isDestroyed()) return false;
    if (!win.isVisible()) return false;
    if (excludeWindow !== undefined && win === excludeWindow) return false;
    return rectIntersectsBounds(globalRect, win.getBounds());
  });
}

/**
 * `appWindowsOverlappingGlobalRect` for a rect in DISPLAY-LOCAL
 * logical pixels — relative to `displayId`'s own top-left, NOT to
 * the virtual desktop. This function adds `display.bounds.{x,y}`
 * itself, so the caller must not have added it already.
 *
 * The selector does NOT hand you one of these. Its renderer reports
 * display-local, but `region-selector.ts` translates to global
 * before resolving, so `SelectorResult.rect` (and therefore
 * `RecordingSubject.rect`) is GLOBAL — use
 * `appWindowsOverlappingGlobalRect` for those. What legitimately
 * arrives here is a rect that has already been converted back down,
 * e.g. `RecordingState.rect`, which recording-service.ts built via
 * `subjectToPhysicalRect`.
 *
 * Returns `[]` for an unknown `displayId`: without the display's
 * origin a display-local rect cannot be placed on the virtual
 * desktop at all, and guessing (0,0) would silently mis-aim the
 * test on every non-primary display.
 */
export function appWindowsOverlappingRect(
  displayLocalRect: Rect,
  displayId: number,
  excludeWindow?: BrowserWindow
): BrowserWindow[] {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return [];
  return appWindowsOverlappingGlobalRect(
    {
      x: displayLocalRect.x + display.bounds.x,
      y: displayLocalRect.y + display.bounds.y,
      w: displayLocalRect.w,
      h: displayLocalRect.h
    },
    excludeWindow
  );
}
