// Back the caption buttons the renderer paints on Linux.
//
// macOS insets its traffic lights into our title bar and Windows fills the
// `titleBarOverlay` strip it reserves at the right edge, so on both of those
// the OS owns minimize / maximize / close. A frameless Linux window has
// neither API: without this bridge the window has no buttons at all, and no
// way to be minimized, maximized or closed from inside the app. The renderer
// owns the pixels (`WindowControls.tsx`); everything that touches the window
// itself stays here.
//
// Off the command bus, alongside `app-menu-bridge.ts` and for the same reason:
// this is chrome plumbing for a title bar we paint ourselves, not a
// `<domain>:<verb>` command with a Result envelope and a capability check.

import { BrowserWindow, ipcMain } from "electron";
import {
  EVENT_CHANNELS,
  WINDOW_CONTROL_CHANNEL,
  WINDOW_FRAME_STATE_CHANNEL,
  type WindowFrameState
} from "@pwrsnap/shared";

/** The slice of BrowserWindow that can answer what the button should draw. */
export type ReadableWindow = Pick<BrowserWindow, "isDestroyed" | "isMaximized">;

/** The slice a control action needs. */
export type ControllableWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMaximized" | "minimize" | "maximize" | "unmaximize" | "close"
>;

/** The slice that reports its own maximize changes. */
export type ObservableWindow = Pick<
  BrowserWindow,
  "on" | "isDestroyed" | "isMaximized" | "webContents"
>;

export function windowFrameState(window: ReadableWindow): WindowFrameState | null {
  return window.isDestroyed() ? null : { maximized: window.isMaximized() };
}

/**
 * Run one control action.
 *
 * It answers nothing: the button redraws from the window's own `maximize` /
 * `unmaximize` events (`trackWindowFrameState`), which is the only account
 * that stays honest when the window manager declines a `maximize()` or
 * maximizes from somewhere else entirely.
 *
 * An unrecognized action is ignored rather than trusted. This arrives over
 * IPC, and `close()` is not something to reach by falling through a switch.
 */
export function applyWindowControl(window: ControllableWindow, action: unknown): void {
  if (window.isDestroyed()) return;
  switch (action) {
    case "minimize":
      window.minimize();
      return;
    case "toggle-maximize":
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return;
    case "close":
      window.close();
      return;
    default:
      return;
  }
}

/**
 * Push this window's maximize changes to its own renderer.
 *
 * The window manager maximizes windows without going through our buttons — a
 * double-click on the drag region, Super+Up, a tiling keybind — so the glyph
 * and the hairline follow the window, not the last click. Sent to the one
 * window's `webContents`, never broadcast: two windows can disagree.
 */
export function trackWindowFrameState(window: ObservableWindow): void {
  const push = (): void => {
    if (window.isDestroyed()) return;
    window.webContents.send(EVENT_CHANNELS.windowFrameState, {
      maximized: window.isMaximized()
    } satisfies WindowFrameState);
  };
  window.on("maximize", push);
  window.on("unmaximize", push);
}

let wired = false;

/** Register once; every window's renderer shares these two channels. */
export function wireWindowControlsBridge(): void {
  if (wired) return;
  wired = true;

  ipcMain.handle(WINDOW_CONTROL_CHANNEL, (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window !== null) applyWindowControl(window, action);
  });

  ipcMain.handle(WINDOW_FRAME_STATE_CHANNEL, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return null;
    return windowFrameState(window);
  });
}

/** Test seam: `wireWindowControlsBridge` is idempotent for the life of the
 *  process, which one test file would otherwise get exactly one use of. */
export function __resetWindowControlsBridgeForTests(): void {
  wired = false;
}
