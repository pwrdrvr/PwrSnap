// Pre-warmed per-display region-selector windows. Cold BrowserWindow
// creation is 150–400ms; the ⌘⇧P → first-paint budget is 120ms. So
// we create one window per display at boot (`show: false`), rebuild
// on display-config change, and `show()` only the window for the
// display containing the cursor when the shortcut fires. After
// capture, `hide()` rather than destroy.
//
// Per-display windows give selectors that already fit each display's
// coordinate space — no virtual-coord remap needed when the user drags.
// The renderer reports rect coordinates in window-local pixels along
// with the displayId; main converts to global virtual coords on commit.
//
// The windows themselves are frameless, transparent, alwaysOnTop at
// level 'screen-saver', hasShadow:false (window shadow would be
// captured), CSS-only — pure positioning + a 1.5px accent border. NO
// `backdrop-filter` — single biggest cause of jank over Splashtop.

import { BrowserWindow, ipcMain, screen, type Display } from "electron";
import { join } from "node:path";
import { getMainLogger } from "../log";
import { getPreloadPath } from "../window";
import { listWindows, type WindowInfo } from "./window-list";

const log = getMainLogger("pwrsnap:region-selector");

const selectorWindows = new Map<number, BrowserWindow>();
let pendingResolver: ((result: SelectorResult) => void) | null = null;
let resultListenerAttached = false;
let displayListenersAttached = false;

// Window list snapshot taken at the moment pickRegion fires. Snap-to-
// window in the renderer hit-tests against this same snapshot; the
// capture handler reuses it after commit to backfill source_app_*.
let lastSnapshot: WindowInfo[] = [];

export type SelectorResult =
  | {
      ok: true;
      rect: { x: number; y: number; w: number; h: number };
      displayId: number;
      /** Set when the user committed via snap-to-window (⇧ hover). */
      snappedWindowId?: number;
    }
  | { ok: false; reason: "cancelled" | "destroyed" };

const SELECTOR_RESULT_CHANNEL = "region-selector:result";
const SELECTOR_WINDOW_LIST_CHANNEL = "region-selector:window-list";

/**
 * Create the pre-warmed windows — one per display. Idempotent. Call
 * once at boot; safe to call again to refresh after display changes.
 */
export function preWarmRegionSelector(): void {
  // Build one window per display we don't already have.
  const displays = screen.getAllDisplays();
  const liveIds = new Set<number>();
  for (const display of displays) {
    liveIds.add(display.id);
    const existing = selectorWindows.get(display.id);
    if (existing !== undefined && !existing.isDestroyed()) continue;
    const win = createSelectorWindow(display);
    selectorWindows.set(display.id, win);
  }
  // Tear down windows for displays that have been removed.
  for (const [id, win] of selectorWindows) {
    if (!liveIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      selectorWindows.delete(id);
    }
  }

  if (!resultListenerAttached) {
    ipcMain.on(SELECTOR_RESULT_CHANNEL, (_event, payload: unknown) => {
      if (pendingResolver === null) return;
      const resolver = pendingResolver;
      pendingResolver = null;
      if (isSelectorPayload(payload) && payload.ok) {
        const result: SelectorResult = {
          ok: true,
          rect: payload.rect,
          displayId: payload.displayId
        };
        if (typeof payload.snappedWindowId === "number") {
          result.snappedWindowId = payload.snappedWindowId;
        }
        resolver(result);
      } else {
        resolver({ ok: false, reason: "cancelled" });
      }
      hideAllSelectors();
    });
    resultListenerAttached = true;
  }

  if (!displayListenersAttached) {
    // Resize-in-place when a display's metrics change rather than
    // destroying + recreating the selector. The destroy-and-recreate
    // approach was racy: macOS fires `display-metrics-changed` whenever
    // a window enters simple-fullscreen (the menu bar showing/hiding
    // counts as a metric change), and rebuilding the selector mid-show
    // killed the very window we were trying to put on screen. setBounds
    // is cheap, idempotent, and doesn't disturb the show/hide state.
    screen.on("display-metrics-changed", (_event, display) => {
      resizeSelectorToDisplay(display);
    });
    screen.on("display-added", () => preWarmRegionSelector());
    screen.on("display-removed", () => preWarmRegionSelector());
    displayListenersAttached = true;
  }
}

/**
 * Show the selector on the display under the cursor and resolve when
 * the user commits or cancels. If a prior selector invocation is still
 * pending, the prior promise resolves with `cancelled` and the new
 * request takes over.
 */
export async function pickRegion(): Promise<SelectorResult> {
  if (selectorWindows.size === 0) {
    preWarmRegionSelector();
  }
  if (selectorWindows.size === 0) {
    return { ok: false, reason: "destroyed" };
  }

  // Route to whichever display the cursor is on right now.
  const cursor = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursor);
  let targetWindow = selectorWindows.get(targetDisplay.id);
  if (targetWindow === undefined || targetWindow.isDestroyed()) {
    // Stale entry — rebuild lazily and try again.
    rebuildSelectorForDisplay(targetDisplay.id);
    targetWindow = selectorWindows.get(targetDisplay.id);
  }
  if (targetWindow === undefined) {
    return { ok: false, reason: "destroyed" };
  }

  if (pendingResolver !== null) {
    const previous = pendingResolver;
    pendingResolver = null;
    previous({ ok: false, reason: "cancelled" });
  }

  const win = targetWindow;

  // Fetch the on-screen window list in the background — by the time
  // the user reaches for ⇧, the renderer has the list cached and
  // hit-tests locally with no IPC round-trip.
  //
  // Window list is in GLOBAL virtual coords; the renderer needs them
  // re-expressed in window-local coords (the selector window covers
  // the display, so subtract the display's bounds.x/y). We do that
  // translation here so the renderer just compares against
  // event.clientX/Y.
  const displayBounds = targetDisplay.bounds;
  void listWindows().then((snapshot) => {
    lastSnapshot = snapshot;
    const localized = snapshot
      // Drop our own selector + library windows from the snap list —
      // hovering over them shouldn't trigger a snap to PwrSnap itself.
      .filter((w) => w.bundleId !== "com.pwrdrvr.pwrsnap" && w.bundleId !== "com.github.Electron")
      .map((w) => ({
        windowId: w.windowId,
        bundleId: w.bundleId,
        appName: w.appName,
        title: w.title,
        rect: {
          x: w.bounds.x - displayBounds.x,
          y: w.bounds.y - displayBounds.y,
          w: w.bounds.width,
          h: w.bounds.height
        }
      }));
    if (!win.isDestroyed()) {
      win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, { windows: localized });
    }
  });

  const result = await new Promise<SelectorResult>((resolve) => {
    pendingResolver = resolve;
    win.show();
    enterMenuBarOverlayMode(win);
    win.focus();
  });
  return result;
}

/**
 * The window-list snapshot taken at the most recent pickRegion call.
 * Capture handlers query this to backfill source-app metadata on
 * commit (no need to re-shell to the helper — the snapshot from the
 * moment of capture is exactly the right point-in-time).
 */
export function getLastWindowListSnapshot(): readonly WindowInfo[] {
  return lastSnapshot;
}

function hideAllSelectors(): void {
  for (const win of selectorWindows.values()) {
    if (win.isDestroyed()) continue;
    // Order: leave overlay → blur → hide.
    // On macOS a screen-saver-level always-on-top window that just
    // calls `hide()` can leave the OS still routing keyboard input
    // to it — the user ends up unable to click anywhere until the
    // focus is forcibly relinquished. setSimpleFullScreen(false)
    // also has to come before hide() or the next show() inherits
    // a partial-overlay state.
    leaveMenuBarOverlayMode(win);
    win.blur();
    win.hide();
  }
}

/**
 * Cover the entire display, including the macOS menu bar.
 *
 * The bug: even at `screen-saver` always-on-top level, a frameless
 * Electron window will not draw over the macOS menu bar. The dock
 * sits below the user-facing app windows in the z-order, so our
 * screen-saver-level overlay covers it; the menu bar is special-cased
 * by Cocoa and lives at NSMainMenuWindowLevel (24) but with an
 * additional system-level prohibition against ordinary app windows
 * drawing over it.
 *
 * The fix: macOS has a "simple fullscreen" mode (introduced in
 * 10.7-era APIs as the legacy fallback to native space-animation
 * fullscreen). It puts the window into a borderless, menu-bar-
 * covering overlay without animating into a separate Mission Control
 * space — exactly what every screen-capture tool (Cleanshot, Shottr,
 * SnagIt) does. Toggle it on at show, off at hide so the pre-warmed
 * window can return to its normal-bounds state for next time.
 */
function enterMenuBarOverlayMode(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  if (!win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(true);
  }
}

function leaveMenuBarOverlayMode(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false);
  }
}

function createSelectorWindow(display: Display): BrowserWindow {
  const { bounds } = display;
  const window = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
    focusable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: getPreloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The renderer needs the display id baked in so it can post the
      // right value back to main on commit. Pass via a query string.
      additionalArguments: [`--display-id=${display.id}`]
    }
  });

  // Highest-of-windows ordering — clears menu bar / other overlays.
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const target = rendererTarget(display.id);
  if (target.kind === "url") {
    void window.loadURL(target.url);
  } else {
    void window.loadFile(target.path, { hash: target.hash });
  }

  log.info("region selector pre-warmed", { displayId: display.id, bounds });
  return window;
}

function rebuildSelectorForDisplay(displayId: number): void {
  const existing = selectorWindows.get(displayId);
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.destroy();
  }
  selectorWindows.delete(displayId);
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return;
  const win = createSelectorWindow(display);
  selectorWindows.set(displayId, win);
}

/**
 * Update the selector window's bounds in place to match a display's
 * current bounds. Preferred over rebuild when the display still exists
 * — preserves the loaded renderer + the show/hide state, and dodges
 * the destroy-during-show race that hits us when simple-fullscreen
 * fires `display-metrics-changed` mid-overlay.
 */
function resizeSelectorToDisplay(display: Display): void {
  const win = selectorWindows.get(display.id);
  if (win === undefined || win.isDestroyed()) {
    // Display exists but we don't have a selector for it — fall back
    // to creating one. Cheaper than rebuild because there's no
    // window to destroy.
    rebuildSelectorForDisplay(display.id);
    return;
  }
  const { bounds } = display;
  const current = win.getBounds();
  if (
    current.x === bounds.x &&
    current.y === bounds.y &&
    current.width === bounds.width &&
    current.height === bounds.height
  ) {
    return; // already matches — nothing to do
  }
  win.setBounds(bounds);
}

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash: string };

function rendererTarget(displayId: number): RendererTarget {
  const hash = `stage=region&displayId=${displayId}`;
  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    return {
      kind: "url",
      url: `${process.env.ELECTRON_RENDERER_URL}#${hash}`
    };
  }
  return {
    kind: "file",
    path: join(__dirname, "../renderer/index.html"),
    hash
  };
}

function isSelectorPayload(value: unknown): value is {
  ok: true;
  rect: { x: number; y: number; w: number; h: number };
  displayId: number;
  snappedWindowId?: number;
} {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.ok !== true) return false;
  const rect = v.rect as Record<string, unknown> | undefined;
  if (rect === undefined) return false;
  if (
    typeof rect.x !== "number" ||
    typeof rect.y !== "number" ||
    typeof rect.w !== "number" ||
    typeof rect.h !== "number" ||
    typeof v.displayId !== "number"
  ) {
    return false;
  }
  // snappedWindowId is optional but must be a number if present.
  if (v.snappedWindowId !== undefined && typeof v.snappedWindowId !== "number") {
    return false;
  }
  return true;
}

export function disposeRegionSelector(): void {
  for (const win of selectorWindows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  selectorWindows.clear();
  if (resultListenerAttached) {
    ipcMain.removeAllListeners(SELECTOR_RESULT_CHANNEL);
    resultListenerAttached = false;
  }
}

export const REGION_SELECTOR_RESULT_CHANNEL = SELECTOR_RESULT_CHANNEL;
export const REGION_SELECTOR_WINDOW_LIST_CHANNEL = SELECTOR_WINDOW_LIST_CHANNEL;
