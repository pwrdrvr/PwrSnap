// Focus-sink window — absorbs Cocoa's next-key-window cascade so it
// doesn't promote the Library when the tray popover hides.
//
// Why this exists: clicking an NSStatusItem (the tray icon) activates
// the owning app on macOS — `[NSApp activateIgnoringOtherApps:]` is
// implicit in the StatusItem target/action plumbing. By the time the
// tray popover opens, PwrSnap is already frontmost. When the user
// clicks an item and the popover hides, Cocoa fires
// `windowDidResignKey` and walks the app's [NSApp orderedWindows]
// looking for the next valid key-window candidate. Without
// intervention, it picks the Library — even if minimized — and
// raises (un-minimizes) it, leaving the user staring at a window
// they didn't ask to see.
//
// The cheat: keep one always-on, invisible, 1×1 transparent panel
// at `floating` window level (NSWindowLevel 3) in the app's window
// list. Cocoa's cascade walks window-list candidates highest-level
// first, so a floating-level focus-sink is picked BEFORE the level-0
// Library. The sink is a non-activating panel (`type: 'panel'`) so
// being chosen as key doesn't visually do anything — the user sees
// nothing. Library stays exactly where it was.
//
// Trade-offs: one extra BrowserWindow lives for the app's lifetime.
// Empty-document, sandboxed, transparent, 1×1, off-screen. Memory
// cost is negligible (~1MB for the WebContents process). Worth it
// for the UX win.
//
// Other tools' equivalents:
//   - macshot uses `LSUIElement: YES` so the tray click never
//     activates the app — different trade-off (no Dock icon).
//   - SnagIt keeps both Dock + tray and uses an NSPanel-based
//     popover with its own cascade-absorbing helper window — same
//     pattern as this file.
//   - Raycast uses `NSPanel + nonactivatingPanel` for everything
//     including their hotkey window, which itself acts as a sink.
//
// Lifecycle: created at app bootstrap, lives until app quit. No
// public state-machine API; the existence of the window itself is
// the entire feature.

import { BrowserWindow } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:focus-sink");

let sink: BrowserWindow | null = null;

/**
 * Create the focus-sink window if it doesn't already exist. Idempotent;
 * call freely. Must be called AFTER `app.whenReady()` since
 * `BrowserWindow` construction requires the app to be ready.
 */
export function installFocusSink(): void {
  if (sink !== null && !sink.isDestroyed()) return;
  sink = new BrowserWindow({
    // Non-activating panel — showing the sink doesn't activate the
    // app. Combined with the floating window level, the sink
    // absorbs cascades silently.
    type: "panel",
    // Tiny + off-screen. The user never sees this window. It lives
    // in the app's window list purely as a cascade target.
    width: 1,
    height: 1,
    x: -10_000,
    y: -10_000,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    // Must be focusable for Cocoa to consider it a key-window
    // candidate. The whole point is for it to be picked over the
    // Library.
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      // No preload — the sink's renderer never runs anything
      // observable. Sandboxed for hygiene.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  // Floating level (NSWindowLevel 3). Above the Library's level 0;
  // below the selector's screen-saver level. Cocoa's cascade walks
  // high-to-low, so the sink is chosen before the Library.
  sink.setAlwaysOnTop(true, "floating");
  // Survive Spaces transitions and fullscreen apps so the sink is
  // always a candidate, regardless of which Space the user is on.
  sink.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Empty document. We don't need anything inside the window — the
  // window's mere existence in the app's window list is the feature.
  void sink.loadURL("data:text/html,");
  // showInactive — make the window "visible" (in Cocoa's sense, a
  // valid cascade target) without grabbing focus from whatever app
  // was active at app launch. The 1×1 off-screen size + transparency
  // mean nothing draws on the user's display.
  sink.showInactive();

  sink.on("closed", () => {
    if (sink !== null && sink.isDestroyed()) {
      sink = null;
    }
  });

  log.info("focus-sink installed");
}

/**
 * Tear down the focus-sink. Called from app `will-quit` so we don't
 * leak the window across teardown. Safe to call when the sink isn't
 * installed.
 */
export function disposeFocusSink(): void {
  if (sink !== null && !sink.isDestroyed()) {
    sink.destroy();
  }
  sink = null;
}
