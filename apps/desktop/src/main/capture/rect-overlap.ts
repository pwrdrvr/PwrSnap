// Geometry primitives + BrowserWindow-aware helpers that the
// recording flow uses to decide whether a rect overlaps one of OUR
// windows — so it can raise them rather than activating the previous
// app (post-commit, `startRecordingFromSelection` in
// recording/record-from-selection.ts), and whether to fill the
// recording rect with the countdown leader or tuck the HUD out of the
// way (per-phase, in recording/recording-controller.ts).
//
// ---------------------------------------------------------------
// COORDINATE SPACES — the canonical note for this hazard. Getting it
// wrong is silent and is the IDENTITY on a primary display at (0,0),
// so it ships and is only ever reported from a multi-monitor desk.
// Two logical-pixel spaces, separated only by `display.bounds.{x,y}`:
//
//   GLOBAL (virtual-screen) — `BrowserWindow.getBounds()`,
//     `setPosition`, `screen.getCursorScreenPoint()`, and
//     `SelectorResult.rect`. A display can sit at e.g. {x:1496,y:-473}.
//   DISPLAY-LOCAL — relative to one display's top-left. What the
//     selector RENDERER reports, what ScreenCaptureKit's `sourceRect`
//     wants, and what `RecordingState.rect` carries.
//
// The trap: **the selector's PUBLIC result is GLOBAL** even though its
// renderer speaks display-local — `region-selector.ts` adds the origin
// when it builds `SelectorResult`. So a `SelectorResult.rect`, or a
// `RecordingSubject.rect` seeded from one, is already global; adding
// the origin again points the test at empty desktop.
//
// Convert with `globalRectToDisplayLocal` / `displayLocalRectToGlobal`
// below rather than re-deriving `± display.bounds` by hand, and pick
// the overlap entry point that matches what you hold. Neither entry
// point can detect a rect in the wrong space, so the choice is yours
// to get right — see each one's doc.
//
// History: two call sites shipped the double-add, both invisible on a
// primary display. Full write-up in
// docs/solutions/2026-09-03-display-local-vs-global-rects.md.
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
 * Visible, non-destroyed PwrSnap windows intersecting `globalRect`,
 * which must be in GLOBAL virtual-screen logical pixels — the space
 * `getBounds()` already reports in, so this does no arithmetic.
 *
 * Reach for this when you hold a `SelectorResult.rect` /
 * `RecordingSubject.rect`; those are global. **A display-local rect
 * passed here is silently wrong** (it hit-tests un-offset, matching
 * the wrong windows or none) — there is no display to check it
 * against, so match the space deliberately.
 *
 * `isVisible()` is the practical filter: transient panels (tray
 * popover, float-over toast) are hidden or parked off-screen by the
 * time the recording flow asks, leaving the user-facing Library /
 * Settings / Sizzle / edit windows.
 *
 * `excludeWindow` drops one window from the result — the
 * recording-controller passes its own HUD, which has `fillRect`-ed
 * itself to the recording rect and so matches by construction.
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
 * logical pixels; adds `displayId`'s origin itself, so the caller
 * must not have added it already.
 *
 * The selector does not hand you one of these — see the note at the
 * top of this file. What legitimately arrives here is a rect already
 * converted down, i.e. `RecordingState.rect`.
 *
 * Returns `[]` for an unknown `displayId`: without the origin a
 * display-local rect cannot be placed at all, and guessing (0,0)
 * would silently mis-aim the test on every non-primary display.
 * (`globalRectToDisplayLocal` deliberately differs — see its doc.)
 */
export function appWindowsOverlappingRect(
  displayLocalRect: Rect,
  displayId: number,
  excludeWindow?: BrowserWindow
): BrowserWindow[] {
  const global = displayLocalRectToGlobal(displayLocalRect, displayId);
  if (global === null) return [];
  return appWindowsOverlappingGlobalRect(global, excludeWindow);
}

/**
 * DISPLAY-LOCAL → GLOBAL. `null` when `displayId` is unknown, because
 * without the origin there is no correct answer and every caller so
 * far would rather do nothing than aim at the wrong place.
 */
export function displayLocalRectToGlobal(rect: Rect, displayId: number): Rect | null {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return null;
  return {
    x: rect.x + display.bounds.x,
    y: rect.y + display.bounds.y,
    w: rect.w,
    h: rect.h
  };
}

/**
 * GLOBAL → DISPLAY-LOCAL, the inverse of the translation
 * `region-selector.ts` applies on commit.
 *
 * **Returns the rect UNCHANGED when `displayId` is unknown**, which
 * is a guess — the opposite policy to `displayLocalRectToGlobal`
 * above. It is preserved because the recording path's callers feed
 * the recorder and the HUD, which need *some* rect to proceed with a
 * capture already in flight, and a display that vanished mid-flow is
 * rarer than one that never resolved. A caller that would rather
 * refuse than aim wrong must check the display itself first.
 */
export function globalRectToDisplayLocal(rect: Rect, displayId: number): Rect {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return rect;
  return {
    x: rect.x - display.bounds.x,
    y: rect.y - display.bounds.y,
    w: rect.w,
    h: rect.h
  };
}
