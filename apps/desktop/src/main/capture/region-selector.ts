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

import { BrowserWindow, globalShortcut, ipcMain, screen, type Display } from "electron";
import { join } from "node:path";
import { getMainLogger } from "../log";
import { getPreloadPath } from "../window";
import {
  activateApp,
  boundsApproxEqual,
  listWindows,
  selfPidSet,
  selfWindowBoundsList,
  type WindowInfo
} from "./window-list";
import { captureAndRegister, releaseSnapshot, type ScreenSnapshot } from "./screen-snapshot";

const MIN_AREA_PX = 400; // 20×20 — anything smaller isn't a meaningful snap target.

const log = getMainLogger("pwrsnap:region-selector");

const selectorWindows = new Map<number, BrowserWindow>();
let pendingResolver: ((result: SelectorResult) => void) | null = null;
let resultListenerAttached = false;
let displayListenersAttached = false;

// Window list snapshot taken at the moment pickRegion fires. Snap-to-
// window in the renderer hit-tests against this same snapshot; the
// capture handler reuses it after commit to backfill source_app_*.
let lastSnapshot: WindowInfo[] = [];

// Active screen snapshot for the in-flight pickRegion. The selector
// shows this PNG as a full-window background image; the user drags
// against the snapshot, and commit crops the snapshot rather than
// re-shooting the live screen. Released on hide.
let activeScreenSnapshot: ScreenSnapshot | null = null;

// Process id of the app that was frontmost at pickRegion time —
// captured BEFORE we steal focus to show the selector. After the
// selector hides on cancel or commit, we re-activate this pid so
// the user lands back where they were instead of looking at our
// library window.
let previousAppPid: number | null = null;

export type SelectorResult =
  | {
      ok: true;
      rect: { x: number; y: number; w: number; h: number };
      displayId: number;
      /** Path to the frozen-at-show screen snapshot. The capture
       *  handler crops this file at `rect * scaleFactor` rather than
       *  re-shooting the live screen. */
      screenSnapshotPath: string;
      /** Registry id matching the path. Capture-handlers MUST call
       *  `releaseSnapshot(id)` from screen-snapshot.ts after
       *  cropping — ownership transfers from the selector module to
       *  the consumer when this result is produced, so
       *  `hideAllSelectors` skips the cleanup on this code path. */
      screenSnapshotId: string;
      /** Set when the user committed straight from a window snap (no
       *  drag, no resize). Used for source-app metadata even when
       *  not in full-window mode. */
      snappedWindowId?: number;
      /** True when the user held ⇧ at commit time to opt into the
       *  full-window capture path (`screencapture -l`). Without this
       *  flag main crops the screen snapshot at the rect, which
       *  captures whatever's visible — overlapping windows included,
       *  just like the user sees on screen. */
      fullWindow?: boolean;
    }
  | { ok: false; reason: "cancelled" | "destroyed" };

const SELECTOR_RESULT_CHANNEL = "region-selector:result";
const SELECTOR_WINDOW_LIST_CHANNEL = "region-selector:window-list";
const SELECTOR_DIAGNOSTICS_CHANNEL = "region-selector:diagnostics";
// Main → renderer: forwarded keystrokes from globalShortcut. The
// renderer's window keydown listener handles them as if the user
// had pressed the key directly — covers the case where macOS
// withholds keyboard events from a newly-shown window.
const SELECTOR_KEY_CHANNEL = "region-selector:key";
// Main → renderer: per-show mode signal. The selector windows are
// pre-warmed at boot (one per display, all loaded with mode=auto in
// the URL hash); we can't reload them on every show without
// destroying the warm-up. Instead we send the desired mode just
// before show() and the renderer flips its UI accordingly. Possible
// values: 'auto' | 'region' | 'window'.
const SELECTOR_MODE_CHANNEL = "region-selector:mode";

export type SelectorMode = "auto" | "region" | "window";

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
    // Diagnostic listener: renderer pushes its viewport dims here on
    // mount. Logged in main so we can correlate with display.bounds
    // + selectorWindow.contentBounds without needing DevTools open.
    ipcMain.on(SELECTOR_DIAGNOSTICS_CHANNEL, (_event, payload: unknown) => {
      log.info("renderer viewport", payload);
    });
    ipcMain.on(SELECTOR_RESULT_CHANNEL, (_event, payload: unknown) => {
      if (pendingResolver === null) return;
      const resolver = pendingResolver;
      pendingResolver = null;
      if (isSelectorPayload(payload) && payload.ok) {
        // Renderer ships rects in WINDOW-LOCAL display logical
        // coords. The selector window covers display.bounds via
        // simple-fullscreen, so window-local (0,0) maps to display
        // global (display.bounds.x, display.bounds.y). Translate
        // back here so capture-handlers + the snapshot crop see a
        // single, consistent global-coord rect.
        const display = screen.getAllDisplays().find((d) => d.id === payload.displayId);
        const offsetX = display?.bounds.x ?? 0;
        const offsetY = display?.bounds.y ?? 0;
        // Snapshot path is REQUIRED for commit. If the snapshot
        // somehow vanished between show and result (e.g. release
        // raced ahead of the result event), fall back to a
        // cancelled outcome — the capture handler can't do its
        // job without it.
        if (activeScreenSnapshot === null) {
          resolver({ ok: false, reason: "cancelled" });
        } else {
          // Ownership transfer: clear the module-scope reference so
          // hideAllSelectors skips the cleanup. The consumer (the
          // capture handler) calls releaseSnapshot(id) after it
          // finishes cropping.
          const snapshot = activeScreenSnapshot;
          activeScreenSnapshot = null;
          const result: SelectorResult = {
            ok: true,
            rect: {
              x: payload.rect.x + offsetX,
              y: payload.rect.y + offsetY,
              w: payload.rect.w,
              h: payload.rect.h
            },
            displayId: payload.displayId,
            screenSnapshotPath: snapshot.filePath,
            screenSnapshotId: snapshot.id
          };
          if (typeof payload.snappedWindowId === "number") {
            result.snappedWindowId = payload.snappedWindowId;
          }
          if (payload.fullWindow === true) {
            result.fullWindow = true;
          }
          resolver(result);
        }
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
 *
 * `mode` controls the selector UI:
 *   - 'auto' (default): snap-to-window is live + drag-region works
 *   - 'region': pure rect drag, snap candidates suppressed
 *   - 'window': window-picker only, drag suppressed, ⇧-not-required
 *     for full-window capture
 */
export async function pickRegion(opts: { mode?: SelectorMode } = {}): Promise<SelectorResult> {
  const mode: SelectorMode = opts.mode ?? "auto";
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

  // Capture the screen NOW, before we show the selector. This is the
  // SnagIt model: freeze the screen, paint the snapshot as a
  // full-window background, drag against it. Apps starting /
  // stopping / popping in during selection no longer bleed into the
  // capture — the renderer is showing pixels that no longer exist.
  // Released on hideAllSelectors (regardless of commit / cancel).
  if (activeScreenSnapshot !== null) {
    const stale = activeScreenSnapshot;
    activeScreenSnapshot = null;
    void releaseSnapshot(stale.id);
  }
  try {
    activeScreenSnapshot = await captureAndRegister(targetDisplay.id);
  } catch (err) {
    log.warn("screen snapshot failed; selector aborted", {
      message: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, reason: "destroyed" };
  }

  // Fetch the on-screen window list in the background — by the time
  // the user reaches for ⇧, the renderer has the list cached and
  // hit-tests locally with no IPC round-trip.
  //
  // The selector window covers the entire display via simple-
  // fullscreen (we paint our own simulation of the menu bar + dock
  // via the snapshot, so we can safely override Cocoa's "no window
  // over the menu bar" rule). Coords are display-bounds-relative.
  const displayBounds = targetDisplay.bounds;
  // Identify our own windows so the renderer can treat them as
  // occluders (hover-over-library returns no snap, not the hidden
  // 1Password underneath). Two-axis match:
  //   - process pid (CGWindow's owner pid is the main app pid)
  //   - bounds matching one of our visible BrowserWindows
  // The bounds match is what makes DevTools and other auxiliary
  // windows snappable — they share our pid but have different
  // bounds, so the user can capture them.
  const ourPids = selfPidSet();
  const ourBounds = selfWindowBoundsList();

  void listWindows().then((rawSnapshot) => {
    lastSnapshot = rawSnapshot;

    // Snapshot the previously-frontmost app's pid. The helper
    // returns windows in z-order, so the first non-ours window
    // belongs to whatever app was frontmost when the user pressed
    // ⌘⇧P (we hadn't activated yet at the moment listWindows
    // ran). Stored at module scope; restored after the selector
    // hides via NSRunningApplication.activate.
    const topNonOurs = rawSnapshot.find((w) => !ourPids.has(w.pid));
    previousAppPid = topNonOurs?.pid ?? null;

    // Step 1: keep windows that overlap the active display. Anything
    // entirely on another monitor is irrelevant to this selector.
    const onThisDisplay = rawSnapshot.filter((w) => {
      const wx2 = w.bounds.x + w.bounds.width;
      const wy2 = w.bounds.y + w.bounds.height;
      const dx2 = displayBounds.x + displayBounds.width;
      const dy2 = displayBounds.y + displayBounds.height;
      return (
        wx2 > displayBounds.x &&
        w.bounds.x < dx2 &&
        wy2 > displayBounds.y &&
        w.bounds.y < dy2
      );
    });

    // Step 2: per-app frontmost collapse. Auxiliary panels of
    // OTHER apps drop out (a Slack inspector panel isn't a snap
    // target when the main Slack window is what the user wants).
    // Windows owned by us are kept so the renderer can de-prioritize
    // them in the hit-test (we don't snap to our own library).
    const meaningful = onThisDisplay.filter(
      (w) => w.isFrontmostInApp || ourPids.has(w.pid)
    );

    // No visibility / occlusion filter. Showing a window's outline
    // even when it's mostly obscured matches what every other
    // capture tool does — the user wants to capture the WINDOW,
    // not the visible-fragment of the window. The screen snapshot
    // already covers the visual; the snap highlight just tags the
    // bounds. Rect math happens in display-bounds-relative window-
    // local coords; the selector covers display.bounds via
    // setSimpleFullScreen.
    const localized = meaningful
      .map((w, idx) => ({ w, idx }))
      .filter(({ w }) => w.bounds.width * w.bounds.height >= MIN_AREA_PX)
      .map(({ w, idx }) => ({
        windowId: w.windowId,
        pid: w.pid,
        bundleId: w.bundleId,
        appName: w.appName,
        title: w.title,
        // ownedByUs requires BOTH same-pid AND bounds matching one
        // of our user-facing BrowserWindows. DevTools shares our
        // pid but its bounds are unique (e.g. detached at 113,386,
        // 800x600) so it lands as snappable.
        ownedByUs:
          ourPids.has(w.pid) &&
          ourBounds.some((b) => boundsApproxEqual(b, w.bounds)),
        // listWindows returns z-order ascending (index 0 = frontmost).
        // After our `meaningful` filter, indices change but z-order
        // is preserved, so the array index continues to work.
        zIndex: idx,
        // Rect = rawRect; we no longer split visible-bbox from raw
        // bounds. Both fields stay so the renderer doesn't need a
        // shape change, but they're identical now.
        rect: {
          x: w.bounds.x - displayBounds.x,
          y: w.bounds.y - displayBounds.y,
          w: w.bounds.width,
          h: w.bounds.height
        },
        rawRect: {
          x: w.bounds.x - displayBounds.x,
          y: w.bounds.y - displayBounds.y,
          w: w.bounds.width,
          h: w.bounds.height
        }
      }));

    log.info("snap candidates", {
      raw: rawSnapshot.length,
      onThisDisplay: onThisDisplay.length,
      meaningful: meaningful.length,
      afterVisibilityFilter: localized.length,
      ourPids: Array.from(ourPids),
      // Display the cursor was on when pickRegion fired. Pair this
      // with the renderer's [viewport] log to see if the renderer's
      // CSS coord space matches display.bounds 1:1.
      display: {
        id: targetDisplay.id,
        bounds: targetDisplay.bounds,
        workArea: targetDisplay.workArea,
        scaleFactor: targetDisplay.scaleFactor
      },
      // The selector window's actual on-screen bounds + content size
      // post-simple-fullscreen. If contentBounds != display.bounds
      // we have a coord-space mismatch — the renderer's CSS pixels
      // are NOT 1:1 with display logical points, which would explain
      // a doubled-size rect.
      selectorWindow: {
        bounds: win.getBounds(),
        contentBounds: win.getContentBounds(),
        contentSize: win.getContentSize(),
        isSimpleFullScreen: win.isSimpleFullScreen()
      },
      candidates: localized.map((c) => ({
        z: c.zIndex,
        id: c.windowId,
        app: c.appName,
        ours: c.ownedByUs,
        rect: c.rect,
        rawRect: c.rawRect
      }))
    });
    if (!win.isDestroyed()) {
      // Ship display.bounds — the selector window covers the entire
      // display via setSimpleFullScreen, so display-bounds is the
      // logical-px rect the renderer's CSS coord space scales into.
      // On macOS scaled-mode displays (fractional devicePixelRatio,
      // e.g. 2.629), the renderer's window.innerWidth is NOT equal
      // to displayBounds.width even though Electron's getContentSize
      // agrees. The renderer computes scale = innerWidth /
      // displayBounds.width.
      win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, {
        windows: localized,
        displayBounds: {
          width: displayBounds.width,
          height: displayBounds.height
        }
      });
    }
  });

  // Arm Esc + Enter via globalShortcut for the duration of the
  // selector. macOS sometimes withholds keyboard events from a
  // newly-shown window until the user clicks to "engage" it — the
  // renderer's keydown listener exists but the event never reaches
  // it. globalShortcut bypasses focus entirely; for the brief
  // duration the selector is up the user has nothing else they'd
  // want Esc / ↵ doing anyway, since the screen-saver-level overlay
  // covers everything.
  installSelectorGlobalShortcuts(win);

  const result = await new Promise<SelectorResult>((resolve) => {
    pendingResolver = resolve;
    // Tell the renderer which mode + snapshot URL to use BEFORE we
    // make the window visible. The renderer applies both
    // synchronously on receipt (mode → body[data-mode]; snapshot →
    // <img> background), so by the first paint we're showing the
    // frozen-in-time pixels and we're already in the right mode.
    if (!win.isDestroyed() && activeScreenSnapshot !== null) {
      const screenUrl = `pwrsnap-screen://r/${activeScreenSnapshot.id}`;
      win.webContents.send(SELECTOR_MODE_CHANNEL, { mode, screenUrl });
    }
    win.show();
    // Re-enter simple-fullscreen. The renderer paints the menu bar
    // / dock area itself via the screen snapshot, so covering the
    // real menu bar is fine — the user sees a 1-frame-old version
    // of it instead of the live one. This matches every native Mac
    // capture tool (Cleanshot, Shottr, SnagIt) and protects the
    // selection from screen changes mid-drag (apps starting,
    // notifications popping, tests running etc.).
    enterMenuBarOverlayMode(win);
    win.focus();
    // webContents.focus() in addition to BrowserWindow.focus() —
    // belt and braces. focus() makes the NSWindow key, but
    // webContents focus is what governs whether keystrokes route
    // to the renderer's document.
    win.webContents.focus();
  });
  uninstallSelectorGlobalShortcuts();
  return result;
}

let shortcutsInstalled = false;

function installSelectorGlobalShortcuts(win: BrowserWindow): void {
  if (shortcutsInstalled) return;
  // Forward to the renderer via the same IPC the renderer's own
  // keydown handlers use, so the cancel/commit code path stays
  // single-sourced. The renderer handler reads the freshest rect
  // and snap state and emits submitRegion accordingly.
  globalShortcut.register("Escape", () => {
    if (!win.isDestroyed()) {
      win.webContents.send(SELECTOR_KEY_CHANNEL, { key: "Escape" });
    }
  });
  globalShortcut.register("Return", () => {
    if (!win.isDestroyed()) {
      win.webContents.send(SELECTOR_KEY_CHANNEL, { key: "Enter" });
    }
  });
  shortcutsInstalled = true;
}

function uninstallSelectorGlobalShortcuts(): void {
  if (!shortcutsInstalled) return;
  globalShortcut.unregister("Escape");
  globalShortcut.unregister("Return");
  shortcutsInstalled = false;
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
  // Release the globalShortcut binding before we lower the window;
  // leaving Esc / ↵ globally bound after the selector is gone would
  // hijack those keys for the rest of the app session.
  uninstallSelectorGlobalShortcuts();
  // Release the screen snapshot UNLESS ownership has already
  // transferred to a consumer (the OK code path clears
  // `activeScreenSnapshot` before calling hideAllSelectors). On
  // cancel / destroyed paths the snapshot is still ours; clean up.
  if (activeScreenSnapshot !== null) {
    const stale = activeScreenSnapshot;
    activeScreenSnapshot = null;
    void releaseSnapshot(stale.id);
  }
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
  // Restore the previously-frontmost app. Without this, Cocoa picks
  // the next-key window in OUR app (the library) as the new key
  // window — popping it on top of whatever the user was actually
  // looking at. activateApp goes via NSRunningApplication.activate,
  // which puts the original app back to front WITHOUT hiding our
  // own windows (so subsequent ⌘⇧P presses don't suffer the
  // app.hide-then-unhide-everything regression).
  if (previousAppPid !== null) {
    const pid = previousAppPid;
    previousAppPid = null;
    void activateApp(pid);
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
  // Defensive re-anchor: setSimpleFullScreen(true) on Cocoa
  // sometimes leaves the window's content area at a size that
  // doesn't match the display's logical bounds — the renderer's
  // CSS coord space ends up scaled relative to display.bounds and
  // every rect we paint comes out 2× too large (or otherwise
  // mis-scaled). Force the content rect to display.bounds so the
  // renderer's pixel space is 1:1 with display logical points.
  // No-op when bounds already match.
  const display = screen.getDisplayMatching(win.getBounds());
  win.setContentBounds(display.bounds);
}

function leaveMenuBarOverlayMode(win: BrowserWindow): void {
  if (process.platform !== "darwin") return;
  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false);
  }
}

function createSelectorWindow(display: Display): BrowserWindow {
  // Anchor to display.bounds. The selector enters simple-fullscreen
  // on show (covering the real menu bar) and paints its own copy of
  // the menu bar via the screen snapshot — so the user sees what
  // they expect AND we get a window-local coord space that matches
  // display logical px 1:1.
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
  // Mirror the createSelectorWindow choice: anchor to display.bounds.
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
  fullWindow?: boolean;
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
  if (v.fullWindow !== undefined && typeof v.fullWindow !== "boolean") {
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
export const REGION_SELECTOR_KEY_CHANNEL = SELECTOR_KEY_CHANNEL;
export const REGION_SELECTOR_MODE_CHANNEL = SELECTOR_MODE_CHANNEL;
