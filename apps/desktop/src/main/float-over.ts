// Float-over toast — singleton, hidden-not-destroyed lifecycle. Each
// new capture reloads the renderer with `?capture=<id>` and shows.
// State machine: IDLE → SHOWING → COPYING → DISMISSED → IDLE.
// Show-while-COPYING queues the next capture; we never destroy the
// window mid-render.
//
// For Phase 1 the state machine is implicit (just hide/show + a
// single in-flight capture id). Phase 2+ formalizes when the editor
// surface lands and races become more interesting.

import { BrowserWindow } from "electron";
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
 * Show the float-over for a specific capture. The window reloads its
 * URL with `?capture=<id>` so the renderer reads `STAGE` + `?capture`
 * and fetches the real preview. If a different capture is currently
 * displayed and the user hasn't dismissed yet, the new capture
 * replaces it.
 *
 * Phase 1.4-1.5: ⌘⇧P → capture:interactive → showFloatOverForCapture.
 */
export function showFloatOverForCapture(captureId: string): BrowserWindow {
  const window = getOrCreate();
  if (currentCaptureId === captureId && window.isVisible()) {
    log.info("float-over already showing for capture", { captureId });
    return window;
  }
  currentCaptureId = captureId;
  // Reload via the window helper that sets the right hash + capture
  // query string. createFloatOverWindow defines the base URL; we just
  // need to nudge it to a new capture id.
  reloadForCapture(window, captureId);
  if (!window.isVisible()) window.show();
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
