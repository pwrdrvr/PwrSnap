// Float-over toast — singleton, hidden-not-destroyed lifecycle. Each
// new capture reloads the renderer with `?capture=<id>` and shows.
// State machine: IDLE → SHOWING → COPYING → DISMISSED → IDLE.
// Show-while-COPYING queues the next capture; we never destroy the
// window mid-render.
//
// For Phase 1 the state machine is implicit (just hide/show + a
// single in-flight capture id). Phase 2+ formalizes when the editor
// surface lands and races become more interesting.

import { BrowserWindow, screen } from "electron";
import { getMainLogger } from "./log";
import { createFloatOverWindow } from "./window";

const log = getMainLogger("pwrsnap:float-over");

let singleton: BrowserWindow | null = null;
let currentCaptureId: string | null = null;

function getOrCreate(): BrowserWindow {
  if (singleton !== null && !singleton.isDestroyed()) return singleton;
  singleton = createFloatOverWindow();
  singleton.on("closed", () => {
    singleton = null;
    currentCaptureId = null;
  });
  return singleton;
}

/**
 * Anchor the float-over in the bottom-right of the display the cursor
 * is currently on. We re-compute this on every show because (a) the
 * user may have moved the dock, plugged/unplugged a display, changed
 * scaled mode, or dragged the window between captures; (b) the
 * `ready-to-show` listener inside createFloatOverWindow only fires on
 * the FIRST load — subsequent `loadURL` calls don't re-fire it, so
 * relying on it for positioning means the second+ capture inherits a
 * stale position.
 */
function anchorBottomRight(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  const margin = 24;
  const [w, h] = window.getSize();
  const x = Math.round(wa.x + wa.width - w - margin);
  const y = Math.round(wa.y + wa.height - h - margin);
  window.setPosition(x, y, false);
}

/**
 * Show the float-over for a specific capture. The window reloads its
 * URL with `?capture=<id>` so the renderer reads `STAGE` + `?capture`
 * and fetches the real preview. If a different capture is currently
 * displayed and the user hasn't dismissed yet, the new capture
 * replaces it. Same captureId (sha256 dedup hit) is also re-shown —
 * the previous "already showing for this id, return" early-out hid
 * legitimate re-shows when the user repeated a capture.
 *
 * Phase 1.4-1.5: ⌘⇧P → capture:interactive → showFloatOverForCapture.
 */
export function showFloatOverForCapture(captureId: string): BrowserWindow {
  const window = getOrCreate();
  const isSameCapture = currentCaptureId === captureId;
  currentCaptureId = captureId;
  // Reload only when the capture actually changed. Same-capture
  // (sha256 dedup) re-shows skip the reload but still re-anchor and
  // re-raise.
  if (!isSameCapture) {
    reloadForCapture(window, captureId);
  }
  // Always re-anchor before showing — handles workArea shifts (dock
  // toggle, display added/removed) and stale ready-to-show position.
  anchorBottomRight(window);
  // showInactive() instead of show() — we don't want to steal focus
  // from whatever app the user was in. capture-handlers activates the
  // user's previous app on commit; the float-over appears over the
  // top of that app's windows without grabbing focus. moveTop() then
  // raises the window inside its alwaysOnTop level (pop-up-menu) so
  // we don't get stuck behind another window of ours.
  window.showInactive();
  window.moveTop();
  log.info("float-over shown", {
    captureId,
    isVisible: window.isVisible(),
    bounds: window.getBounds(),
    sameCapture: isSameCapture
  });
  return window;
}

/**
 * Backwards-compat shim for callers that don't yet pass a captureId.
 * Phase 1.5 in-progress callsites use this; once Phase 1.4's
 * capture:interactive everywhere passes an id, this can be removed.
 */
export function showFloatOver(captureId?: string): BrowserWindow {
  if (captureId !== undefined) return showFloatOverForCapture(captureId);
  const window = getOrCreate();
  if (!window.isVisible()) window.show();
  return window;
}

export function dismissFloatOver(): void {
  if (singleton === null || singleton.isDestroyed()) return;
  singleton.hide();
  currentCaptureId = null;
}

function reloadForCapture(window: BrowserWindow, captureId: string): void {
  // The window was loaded with #stage=float-over at creation time. To
  // re-target it for a new capture, append &capture=<id> to the hash
  // and reload. webContents.loadURL with the new fragment is the
  // simplest path; since we own the renderer, the App.tsx stage router
  // re-runs from scratch.
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}#stage=float-over&capture=${captureId}`
    );
    return;
  }
  // file:// path: setHash via a fresh loadFile call.
  // The renderer entry resolves under window.ts; rebuild the path here
  // to match. (out/renderer/index.html in production.)
  // We can't import circularly from window.ts, so rely on the URL we
  // already have — webContents.send a custom event the renderer listens
  // to, but that requires extra wiring. For Phase 1 we keep it simple:
  // construct the file path from the current URL.
  const currentUrl = window.webContents.getURL();
  const base = currentUrl.split("#")[0];
  void window.loadURL(`${base}#stage=float-over&capture=${captureId}`);
}
