// Pre-warmed per-display region-selector windows. Cold BrowserWindow
// creation is 150–400ms; the ⌘⇧P → first-paint budget is 120ms. So
// we create one window per display at boot (`show: false`), rebuild
// on display-config change, and reveal only the window for the
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

import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Display } from "electron";
import { join } from "node:path";
import { getMainLogger } from "../log";
import { getPreloadPath } from "../window";
import {
  activateApp,
  boundsApproxEqual,
  listWindowsSnapshot,
  selfPidSet,
  type WindowInfo
} from "./window-list";
import { captureAndRegister, releaseSnapshot, type ScreenSnapshot } from "./screen-snapshot";
import { hideTrayPopoverIfVisible } from "../tray";
import { setFloatOverState, ensureFloatOverTopmost } from "../float-over";

const MIN_AREA_PX = 400; // 20×20 — anything smaller isn't a meaningful snap target.
const SELECTOR_WINDOW_TITLE = "PwrSnap Region Selector";

const log = getMainLogger("pwrsnap:region-selector");

const selectorWindows = new Map<number, BrowserWindow>();
const standbySelectorWindows = new Map<number, BrowserWindow>();
const selectorWindowLoads = new WeakMap<BrowserWindow, Promise<boolean>>();
const standbyWarmScheduled = new Set<number>();
const selectorDisplaysNeedingFreshPanel = new Set<number>();
let pendingResolver: ((result: SelectorResult) => void) | null = null;
let resultListenerAttached = false;
let displayListenersAttached = false;

type SelectorPrewarmReason =
  | "startup"
  | "display-change"
  | "lazy"
  | "rebuild"
  | "standby"
  | "swap-fallback";

type SelectorPrewarmTiming = {
  reason: SelectorPrewarmReason;
  startedAt: number;
  loadedAt: number | null;
};

const selectorPrewarmTimings = new Map<number, SelectorPrewarmTiming>();

// Window list snapshot taken at the moment pickRegion fires. Snap-to-
// window in the renderer hit-tests against this same snapshot; the
// capture handler reuses it after commit to backfill source_app_*.
let lastSnapshot: WindowInfo[] = [];

// Active screen snapshot for the in-flight pickRegion. The selector
// shows this PNG as a full-window background image; the user drags
// against the snapshot, and commit crops the snapshot rather than
// re-shooting the live screen. Released on hide.
let activeScreenSnapshot: ScreenSnapshot | null = null;

// Process id of the app that was frontmost at pickRegion time.
// Capture handlers keep this for metadata and for flows that still
// explicitly restore another app, but the image selector must avoid
// activating or hiding our normal windows just to draw the overlay.
let previousAppPid: number | null = null;

type SelectorWindowListPayload = {
  windows: {
    windowId: number;
    pid: number;
    bundleId: string | null;
    appName: string | null;
    title: string | null;
    ownedByUs: boolean;
    zIndex: number;
    rect: { x: number; y: number; w: number; h: number };
    rawRect: { x: number; y: number; w: number; h: number };
  }[];
  displayBounds: { width: number; height: number };
  cursor: { x: number; y: number };
};

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
      /** Pid of the app that was frontmost when the selector opened.
       *  The capture handler may use this for metadata or for flows
       *  that explicitly restore another app. May be null if the
       *  listWindows snapshot hadn't resolved by commit time. */
      previousAppPid: number | null;
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
  | {
      ok: false;
      reason: "cancelled" | "destroyed";
      /** Same semantics as the OK branch. Null when the listWindows
       *  snapshot hadn't resolved or for a destroyed-state result. */
      previousAppPid?: number | null;
    };

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
export function preWarmRegionSelector(reason: SelectorPrewarmReason = "startup"): void {
  // Build one window per display we don't already have.
  const displays = screen.getAllDisplays();
  const liveIds = new Set<number>();
  for (const display of displays) {
    liveIds.add(display.id);
    const existing = selectorWindows.get(display.id);
    if (existing !== undefined && !existing.isDestroyed()) continue;
    const win = createSelectorWindow(display, reason);
    selectorWindows.set(display.id, win);
  }
  // Tear down windows for displays that have been removed.
  for (const [id, win] of selectorWindows) {
    if (!liveIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      selectorWindows.delete(id);
      selectorDisplaysNeedingFreshPanel.delete(id);
    }
  }
  for (const [id, win] of standbySelectorWindows) {
    if (!liveIds.has(id)) {
      if (!win.isDestroyed()) win.destroy();
      standbySelectorWindows.delete(id);
      standbyWarmScheduled.delete(id);
    }
  }

  if (!resultListenerAttached) {
    // Diagnostic listener: renderer pushes its viewport dims on every
    // window-list snapshot. Compacted to one line + deduped per
    // selector-window so we don't repeat the same dims into the dev
    // terminal on every snapshot delivery.
    const lastViewportByWebContents = new Map<number, string>();
    ipcMain.on(SELECTOR_DIAGNOSTICS_CHANNEL, (event, payload: unknown) => {
      if (payload === null || typeof payload !== "object") return;
      const p = payload as {
        innerWidth?: number;
        innerHeight?: number;
        devicePixelRatio?: number;
      };
      const summary = `${p.innerWidth}×${p.innerHeight} dpr=${p.devicePixelRatio}`;
      const wcId = event.sender.id;
      if (lastViewportByWebContents.get(wcId) === summary) return;
      lastViewportByWebContents.set(wcId, summary);
      log.info(`renderer viewport wc=${wcId} ${summary}`);
    });
    ipcMain.on(SELECTOR_RESULT_CHANNEL, (_event, payload: unknown) => {
      // IMPORTANT: this handler does NOT hide the selector windows.
      // The caller (capture-handlers) hides via `hideSelector()` AFTER
      // it has set the float-over to LOADED, so the selector hide
      // reveals an already-painted toast — no post-hoc show race.
      // See docs/plans/2026-05-04-001 §"Solution 3" for context.
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
          const prevPid = previousAppPid;
          previousAppPid = null;
          resolver({ ok: false, reason: "cancelled", previousAppPid: prevPid });
        } else {
          // Ownership transfer: clear the module-scope reference so
          // hideAllSelectors skips the cleanup. The consumer (the
          // capture handler) calls releaseSnapshot(id) after it
          // finishes cropping.
          const snapshot = activeScreenSnapshot;
          activeScreenSnapshot = null;
          // Snapshot previousAppPid into the result then null the
          // module-scope reference so a follow-up cancel cannot reuse
          // stale focus metadata.
          const prevPid = previousAppPid;
          previousAppPid = null;
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
            screenSnapshotId: snapshot.id,
            previousAppPid: prevPid
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
        const prevPid = previousAppPid;
        previousAppPid = null;
        resolver({ ok: false, reason: "cancelled", previousAppPid: prevPid });
      }
      // (intentionally no hideAllSelectors here — caller owns it)
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
    screen.on("display-added", () => preWarmRegionSelector("display-change"));
    screen.on("display-removed", () => preWarmRegionSelector("display-change"));
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
 *
 * `keepPwrSnapChrome` (default false) — by default the selector hides
 * PwrSnap's own tray popover + float-over right before snapshotting,
 * so they don't sit on top of whatever the user is trying to capture.
 * Timed mode opts IN to leaving them: the whole point of the timer is
 * to let the user stage transient UI (including the PwrSnap tray
 * menu itself) and have it preserved in the snapshot they pick
 * against.
 */
export async function pickRegion(
  opts: {
    mode?: SelectorMode;
    keepPwrSnapChrome?: boolean;
    /** Visual intent telegraphed to the renderer. `"video"` swaps
     *  the "Capture" chip for a "● Recording video" badge and
     *  changes the hint text so the user knows clicking commits a
     *  recording, not a snap. No behavioral effect on selection
     *  itself — both intents return the same rect / window payload. */
    intent?: "snap" | "video";
  } = {}
): Promise<SelectorResult> {
  const mode: SelectorMode = opts.mode ?? "auto";
  const keepPwrSnapChrome = opts.keepPwrSnapChrome ?? false;
  const intent = opts.intent ?? "snap";
  const requestStartedAt = Date.now();
  const elapsedFromRequest = (): number => Date.now() - requestStartedAt;
  log.info("capture selector requested", {
    mode,
    intent,
    keepPwrSnapChrome,
    ...selectorPrewarmAgePayload()
  });
  if (selectorWindows.size === 0) {
    preWarmRegionSelector("lazy");
  }
  if (selectorWindows.size === 0) {
    return { ok: false, reason: "destroyed" };
  }

  // Route to whichever display the cursor is on right now.
  const cursor = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursor);
  log.info("capture selector target display resolved", {
    displayId: targetDisplay.id,
    durationFromUserRequestMs: elapsedFromRequest(),
    ...selectorPrewarmAgePayload(targetDisplay.id)
  });
  let targetWindow = selectorWindows.get(targetDisplay.id);
  if (targetWindow === undefined || targetWindow.isDestroyed()) {
    // Stale entry — rebuild lazily and try again.
    rebuildSelectorForDisplay(targetDisplay.id);
    targetWindow = selectorWindows.get(targetDisplay.id);
  }
  if (targetWindow === undefined) {
    return { ok: false, reason: "destroyed" };
  }
  const targetReady = await waitForSelectorWindowLoad(targetDisplay.id, targetWindow);
  if (!targetReady) {
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
  // Synchronously dismiss PwrSnap capture chrome BEFORE the snapshot
  // and window-list enumeration so our own popovers/toasts neither
  // appear in the frozen background nor become snap candidates. The
  // user's normal PwrSnap windows (Library / Edit) are intentionally
  // left alone: if they're on screen, they're valid capture targets.
  //
  // Timed mode opts out via `keepPwrSnapChrome` — the user may have
  // re-opened the tray during the countdown precisely so it appears
  // in the picker. Skipping the hide also skips the 50 ms compositor
  // wait, which only mattered as a "let the hide reach the window
  // server before snapshotting" guard.
  if (!keepPwrSnapChrome) {
    hideTrayPopoverIfVisible();
    setFloatOverState({ kind: "cancel" });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const displayBounds = targetDisplay.bounds;
  const displayCursor = {
    x: cursor.x - displayBounds.x,
    y: cursor.y - displayBounds.y
  };
  const ourPids = selfPidSet();
  let windowListPayload: SelectorWindowListPayload | null = null;
  let windowListResolver: ((result: SelectorResult) => void) | null = null;
  let acceptingWindowList = true;
  let selectorVisible = false;
  const windowLayoutRequestedAt = Date.now();
  log.info("requesting window layout info", {
    displayId: targetDisplay.id,
    durationFromUserRequestMs: elapsedFromRequest()
  });
  const deliverWindowListPayload = (payload: SelectorWindowListPayload): void => {
    if (
      !acceptingWindowList ||
      !selectorVisible ||
      pendingResolver !== windowListResolver ||
      win.isDestroyed()
    ) {
      return;
    }
    win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, payload);
    setTimeout(() => {
      if (
        !acceptingWindowList ||
        pendingResolver !== windowListResolver ||
        win.isDestroyed()
      ) {
        return;
      }
      win.webContents.send(SELECTOR_WINDOW_LIST_CHANNEL, payload);
    }, 50);
  };
  const windowListPromise = listWindowsSnapshot()
    .then((snapshot) => {
      if (!acceptingWindowList) return;
      if (selectorVisible && pendingResolver !== windowListResolver) return;
      log.info("completed fetching window layout info", {
        displayId: targetDisplay.id,
        durationMs: Date.now() - windowLayoutRequestedAt,
        durationFromUserRequestMs: elapsedFromRequest(),
        rawWindowCount: snapshot.windows.length,
        frontmostPid: snapshot.frontmostPid,
        frontmostBundleId: snapshot.frontmostBundleId
      });
      const prepared = prepareWindowListPayload({
        rawSnapshot: snapshot.windows,
        targetDisplay,
        displayCursor,
        ourPids,
        selectorWindow: win,
        frontmostPid: snapshot.frontmostPid,
        frontmostBundleId: snapshot.frontmostBundleId
      });
      lastSnapshot = prepared.snapshot;
      previousAppPid = prepared.previousAppPid;
      windowListPayload = prepared.payload;
      deliverWindowListPayload(prepared.payload);
    })
    .catch((err) => {
      log.warn("window-list helper failed during selector startup", {
        displayId: targetDisplay.id,
        durationMs: Date.now() - windowLayoutRequestedAt,
        durationFromUserRequestMs: elapsedFromRequest(),
        message: err instanceof Error ? err.message : String(err)
      });
    });

  const screenSnapshotRequestedAt = Date.now();
  log.info("requesting screen snapshot", {
    displayId: targetDisplay.id,
    durationFromUserRequestMs: elapsedFromRequest()
  });
  try {
    const screenSnapshot = await captureAndRegister(targetDisplay.id);
    activeScreenSnapshot = screenSnapshot;
    log.info("completed screen snapshot", {
      displayId: targetDisplay.id,
      durationMs: Date.now() - screenSnapshotRequestedAt,
      durationFromUserRequestMs: elapsedFromRequest(),
      snapshotId: screenSnapshot.id
    });
  } catch (err) {
    log.warn("screen snapshot failed; selector aborted", {
      displayId: targetDisplay.id,
      durationMs: Date.now() - screenSnapshotRequestedAt,
      durationFromUserRequestMs: elapsedFromRequest(),
      message: err instanceof Error ? err.message : String(err)
    });
    acceptingWindowList = false;
    void windowListPromise;
    return { ok: false, reason: "destroyed" };
  }

  // Arm Esc + Enter + Tab via globalShortcut for the duration of the
  // selector. macOS sometimes withholds keyboard events from a
  // newly-shown window until the user clicks to "engage" it — the
  // renderer's keydown listener exists but the event never reaches
  // it. We also intentionally avoid focusing the macOS selector so
  // AppKit does not hide/show our normal windows or churn the Dock
  // icon around a capture. globalShortcut bypasses focus entirely;
  // for the brief duration the selector is up the user has nothing
  // else they'd want these keys doing anyway, since the screen-saver-
  // level overlay covers everything.
  installSelectorGlobalShortcuts(win);

  const result = await new Promise<SelectorResult>((resolve) => {
    pendingResolver = resolve;
    windowListResolver = resolve;
    // Pre-show the float-over UNDER the selector. The float-over is
    // at floating window level (3); the selector below is at
    // screen-saver level (1000), so the selector covers the float-
    // over visually until we hide it. This lets the post-commit
    // reveal be instantaneous (the toast is already painted at the
    // right position) and avoids the post-hoc show race that left
    // the toast hidden behind the previously-frontmost app's window.
    // See docs/plans/2026-05-04-001 §"Solution 3" for the full
    // choreography.
    setFloatOverState({ kind: "show-idle" });

    // Tell the renderer which mode + snapshot URL to use BEFORE we
    // make the window visible. The renderer applies both
    // synchronously on receipt (mode → body[data-mode]; snapshot →
    // <img> background), so by the first paint we're showing the
    // frozen-in-time pixels and we're already in the right mode.
    const modePayload =
      activeScreenSnapshot !== null
        ? { mode, screenUrl: `pwrsnap-screen://r/${activeScreenSnapshot.id}`, intent }
        : null;
    if (!win.isDestroyed() && modePayload !== null) {
      win.webContents.send(SELECTOR_MODE_CHANNEL, modePayload);
    }
    const displayRequestedAt = Date.now();
    log.info("capture selector display requested", {
      displayId: targetDisplay.id,
      durationFromUserRequestMs: elapsedFromRequest()
    });
    // Order matters: setSimpleFullScreen(true) BEFORE show().
    //
    // Without this, `win.show()` paints the renderer's first frame
    // while Cocoa is still clipping content to the work-area (the
    // region below the menu bar) — even though the BrowserWindow
    // bounds cover the full display. The screen snapshot, painted
    // at body coords (0, 0), then sits 25-or-so pixels below where
    // it should, with the LIVE menu bar still visible above. ~150ms
    // later setSimpleFullScreen settles, the menu bar slides out,
    // the window's content area expands, and the snapshot suddenly
    // jumps up by the menu-bar height — visible to the user as the
    // whole screen "lurching."
    //
    // First ⌘⇧P after launch happened to look clean because no prior
    // teardown had toggled setSimpleFullScreen back to false; the
    // pre-warmed window inherited a permissive style mask. Subsequent
    // shows hit the lurch because hideAllSelectors → leaveMenuBarOverlayMode
    // had reset it.
    //
    // Doing the toggle while the window is hidden lets the style-
    // mask change settle off-screen; show() then reveals the window
    // already in its final geometry. Snapshot's menu bar pixels land
    // exactly where the user expects them, no jump.
    //
    // The renderer paints the menu bar / dock area itself via the
    // screen snapshot, so covering the real menu bar is fine — user
    // sees a 1-frame-old version of it instead of the live one.
    // Matches every native Mac capture tool (Cleanshot, Shottr,
    // SnagIt).
    enterMenuBarOverlayMode(win);
    if (process.platform === "darwin") {
      win.showInactive();
    } else {
      win.show();
    }
    selectorDisplaysNeedingFreshPanel.add(targetDisplay.id);
    if (process.platform !== "darwin") {
      win.focus();
      // webContents.focus() in addition to BrowserWindow.focus() —
      // belt and braces. focus() makes the NSWindow key, but
      // webContents focus is what governs whether keystrokes route
      // to the renderer's document.
      win.webContents.focus();
    }
    // Non-activating panels do not always win the final z-order
    // arbitration when another app was frontmost at hotkey time. The
    // selector still receives normal-window hover/mouse events, but
    // the Dock/menu bar can remain live above it. Re-assert ordering
    // after show, matching the float-over and recording HUD
    // pattern without activating PwrSnap or changing Spaces.
    win.moveTop();
    log.info("capture selector displayed", {
      displayId: targetDisplay.id,
      durationFromDisplayRequestedMs: Date.now() - displayRequestedAt,
      durationFromUserRequestMs: elapsedFromRequest()
    });
    scheduleStandbySelectorWarm(targetDisplay);
    selectorVisible = true;
    if (windowListPayload !== null) {
      deliverWindowListPayload(windowListPayload);
    }
    setTimeout(() => {
      if (win.isDestroyed() || pendingResolver !== resolve) return;
      if (modePayload !== null) {
        win.webContents.send(SELECTOR_MODE_CHANNEL, modePayload);
      }
    }, 50);
  });
  acceptingWindowList = false;
  void windowListPromise;
  uninstallSelectorGlobalShortcuts();
  log.info("capture selector selection finished", {
    displayId: targetDisplay.id,
    ok: result.ok,
    reason: result.ok ? "completed" : result.reason,
    durationFromUserRequestMs: elapsedFromRequest()
  });
  return result;
}

/**
 * Decide which app pid (if any) the capture flow should re-activate
 * after a commit or cancel. Pure function, exported for unit testing.
 *
 * Returns `null` when one of OUR pids owns the topmost window in the
 * snapshot — i.e. the user was already inside PwrSnap (Library,
 * Settings, an edit window). Re-activating any other app in that case
 * is wrong for two reasons:
 *
 *   1. It sends the Library to the background even though the user
 *      explicitly had it foreground when they triggered the capture.
 *   2. The activate call deactivates PwrSnap as a side-effect, and
 *      with our persistent floating-level panels in the window list
 *      AppKit periodically demotes our activation policy to Accessory
 *      (NSUIElement). The Dock icon vanishes and the Library window
 *      gets orphaned — alive, but unreachable via Dock or ⌘-Tab
 *      because the app is no longer Regular.
 *
 * Returns the topmost non-PwrSnap pid otherwise — exactly the
 * historical behavior. The "first non-ours, front-to-back" walk
 * matches `listWindows`' z-order-descending output (index 0 =
 * frontmost), so we restore the app the user had ACTIVE before they
 * opened the tray popover or pressed the global hotkey.
 *
 * The snapshot must already have selector-overlay self-windows
 * filtered out (see isSelectorOverlayWindow) — those would otherwise
 * always be at the top and short-circuit the "top is ours" check.
 */
export function decidePreviousAppPid(
  snapshot: readonly WindowInfo[],
  ourPids: ReadonlySet<number>
): number | null {
  if (snapshot.length === 0) return null;
  // Topmost overall window in the filtered snapshot. If it's ours,
  // the user was inside PwrSnap and there's no "previous app" to
  // restore.
  if (ourPids.has(snapshot[0]!.pid)) return null;
  // First (and therefore topmost) non-ours window. Matches the prior
  // behavior for the common case where the user was in Claude /
  // Terminal / Slack / etc. and triggered a capture via global
  // hotkey or tray.
  const topNonOurs = snapshot.find((w) => !ourPids.has(w.pid));
  return topNonOurs?.pid ?? null;
}

function prepareWindowListPayload(args: {
  rawSnapshot: WindowInfo[];
  targetDisplay: Display;
  displayCursor: { x: number; y: number };
  ourPids: Set<number>;
  selectorWindow: BrowserWindow;
  /** pid reported by `NSWorkspace.shared.frontmostApplication` at
   *  snapshot time. `null` on non-darwin platforms or when the
   *  envelope wasn't produced by a frontmost-aware helper build. */
  frontmostPid: number | null;
  /** bundle id companion to `frontmostPid` — included in the
   *  mismatch warning for legibility. */
  frontmostBundleId: string | null;
}): {
  snapshot: WindowInfo[];
  previousAppPid: number | null;
  payload: SelectorWindowListPayload;
} {
  const {
    rawSnapshot,
    targetDisplay,
    displayCursor,
    ourPids,
    selectorWindow,
    frontmostPid,
    frontmostBundleId
  } = args;
  const displayBounds = targetDisplay.bounds;
  const snapshot = rawSnapshot.filter(
    (w) => !isSelectorOverlayWindow(w, displayBounds, ourPids, selectorWindow)
  );

  // Snapshot the previously-frontmost app's pid. See
  // `decidePreviousAppPid` for the full rationale — the short version
  // is: if one of OUR windows (Library, Settings, edit window) was the
  // topmost window in z-order, the user was already in PwrSnap, so we
  // skip the post-capture activateApp call. Activating any other app
  // in that case yanks the Library out from under the user AND, as a
  // side-effect of the deactivation through our floating-level panels,
  // demotes PwrSnap's activation policy to Accessory (NSUIElement),
  // which strips the Dock icon and orphans the Library. See
  // capture-handlers.ts for the matching dock-reclaim guard on the
  // OTHER branch (when previousAppPid IS set legitimately).
  const previousAppPid = decidePreviousAppPid(snapshot, ourPids);

  // Step 1: keep windows that overlap the active display. Anything
  // entirely on another monitor is irrelevant to this selector.
  const onThisDisplay = snapshot.filter((w) => {
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

  // Step 2: previously a per-app frontmost collapse — kept only the
  // first window per pid, on the theory that subsequent same-pid
  // entries were panels / toolbars the user wouldn't mean by "snap
  // to that app." That heuristic was wrong for any app with multiple
  // top-level windows (terminals, browsers, Finder, IDEs). The
  // collapse hid the very window the user was hovering, and the
  // hit-test fell through to whatever was layered behind it.
  //
  // We now keep every window from the prior filter pass. The Swift
  // helper already drops menu-bar / dock / status items by layer,
  // invisible windows by alpha, and known system chrome by bundle
  // id, so what arrives here is broadly legitimate top-level
  // content. The MIN_AREA_PX gate below removes sub-pixel tracking
  // strips. Z-order hit-testing in `findWindowAt` returns whichever
  // window is visually topmost at the cursor; if a panel happens to
  // be there, snapping to it is correct (it's what the user is
  // pointing at). Tab in the selector cycles through candidates at
  // the cursor, which is more useful with all windows present.
  const meaningful = onThisDisplay;

  // No visibility / occlusion filter. Showing a window's outline
  // even when it's mostly obscured matches what every other capture
  // tool does — the user wants to capture the WINDOW, not the
  // visible-fragment of the window. The screen snapshot already
  // covers the visual; the snap highlight just tags the bounds.
  const localized = meaningful
    .map((w, idx) => ({ w, idx }))
    .filter(({ w }) => w.bounds.width * w.bounds.height >= MIN_AREA_PX)
    .map(({ w, idx }) => ({
      windowId: w.windowId,
      pid: w.pid,
      bundleId: w.bundleId,
      appName: w.appName,
      title: w.title,
      // Legacy diagnostic field retained for preload/API shape
      // stability. PwrSnap-owned user windows are now snappable.
      ownedByUs: ourPids.has(w.pid),
      // listWindows returns z-order ascending (index 0 = frontmost).
      // After our `meaningful` filter, indices change but z-order is
      // preserved, so the array index continues to work.
      zIndex: idx,
      // Rect = rawRect; we no longer split visible-bbox from raw
      // bounds. Both fields stay so the renderer doesn't need a shape
      // change, but they're identical now.
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

  // Compact summary — one line at info level. The detailed candidate
  // dump and selector geometry sit at debug level so they're available
  // for diagnosis (turn on with `electron-log` debug) without flooding
  // the dev terminal every pickRegion call.
  const b = targetDisplay.bounds;
  log.info(
    `snap candidates display=${targetDisplay.id} bounds=${b.x},${b.y} ${b.width}×${b.height}` +
      ` raw=${rawSnapshot.length} onDisplay=${onThisDisplay.length}` +
      ` meaningful=${meaningful.length} kept=${localized.length}`
  );

  // Diagnostic: warn when CGWindowList's z=0 disagrees with the
  // system's frontmost-app pid. Background: the snap picker's hit-
  // test trusts CGWindowList's "front-to-back" ordering — `findWindowAt`
  // walks the list and returns the first window containing the
  // cursor. When CGWindowList z=0 doesn't match the actual frontmost
  // app, the picker can snap to a window the user perceives as
  // "behind" the visually-on-top window (e.g. cursor over the Library
  // gets reported as snapping to Claude). This is the smoking gun for
  // that class of bug — see the "window-picker selecting wrong z-order"
  // investigation in the dock-icon fix PR for the full story.
  //
  // Skipped when frontmostPid is null (non-darwin or pre-envelope
  // helper) or the snapshot is empty.
  if (frontmostPid !== null && snapshot.length > 0) {
    const topWindow = snapshot[0]!;
    if (topWindow.pid !== frontmostPid) {
      log.warn(
        `snap candidates: CGWindowList z=0 (pid=${topWindow.pid} app=${topWindow.appName ?? "?"}` +
          ` window=${topWindow.windowId}) disagrees with NSWorkspace.frontmostApplication` +
          ` (pid=${frontmostPid} bundle=${frontmostBundleId ?? "?"}) — the snap picker may` +
          ` choose a window the user perceives as behind the visually-on-top one`
      );
    }
  }

  log.debug("snap candidates detail", {
    display: {
      id: targetDisplay.id,
      bounds: targetDisplay.bounds,
      workArea: targetDisplay.workArea,
      scaleFactor: targetDisplay.scaleFactor
    },
    selectorWindow: {
      bounds: selectorWindow.getBounds(),
      contentBounds: selectorWindow.getContentBounds(),
      isSimpleFullScreen: selectorWindow.isSimpleFullScreen()
    },
    ourPids: Array.from(ourPids),
    frontmost: {
      pid: frontmostPid,
      bundleId: frontmostBundleId
    },
    candidates: localized.map((c) => ({
      z: c.zIndex,
      id: c.windowId,
      app: c.appName,
      ours: c.ownedByUs,
      rect: c.rect
    }))
  });

  return {
    snapshot,
    previousAppPid,
    payload: {
      windows: localized,
      displayBounds: {
        width: displayBounds.width,
        height: displayBounds.height
      },
      cursor: displayCursor
    }
  };
}

function isSelectorOverlayWindow(
  windowInfo: WindowInfo,
  displayBounds: { x: number; y: number; width: number; height: number },
  ourPids: Set<number>,
  selectorWindow: BrowserWindow
): boolean {
  if (!ourPids.has(windowInfo.pid)) return false;
  if (windowInfo.title === SELECTOR_WINDOW_TITLE) return true;
  if (windowInfo.title !== null && windowInfo.title.trim() !== "") return false;
  return (
    boundsApproxEqual(windowInfo.bounds, displayBounds) &&
    boundsApproxEqual(windowInfo.bounds, selectorWindow.getBounds())
  );
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
  globalShortcut.register("Tab", () => {
    if (!win.isDestroyed()) {
      win.webContents.send(SELECTOR_KEY_CHANNEL, { key: "Tab" });
    }
  });
  globalShortcut.register("Shift+Tab", () => {
    if (!win.isDestroyed()) {
      win.webContents.send(SELECTOR_KEY_CHANNEL, { key: "Tab", shiftKey: true });
    }
  });
  shortcutsInstalled = true;
}

function uninstallSelectorGlobalShortcuts(): void {
  if (!shortcutsInstalled) return;
  globalShortcut.unregister("Escape");
  globalShortcut.unregister("Return");
  globalShortcut.unregister("Tab");
  globalShortcut.unregister("Shift+Tab");
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

/**
 * Hide every pre-warmed selector window. Called by the capture handler
 * AFTER it has populated the float-over to LOADED — the selector hide
 * reveals an already-painted toast at the floating level (no flash, no
 * post-hoc show race). Also called on cancel paths after the float-over
 * has been hidden synchronously.
 *
 * Public sibling of the historical `hideAllSelectors`. The internal
 * function name is preserved to keep diffs small.
 */
export function hideSelector(): void {
  hideAllSelectors();
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
  const rebuildAfterHide: { displayId: number; staleWindow: BrowserWindow }[] = [];
  for (const [displayId, win] of selectorWindows) {
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
    // macOS simple-fullscreen + non-activating NSPanel does not fully
    // reset to the fresh pre-warm state after one show/hide cycle. The
    // first selector after launch can cover menu bar + Dock correctly,
    // while the reused panel after Esc/commit can fall back under that
    // system chrome. Destroy and recreate the hidden panel so every
    // subsequent capture starts from the same state as the first one.
    if (
      process.platform === "darwin" &&
      selectorDisplaysNeedingFreshPanel.has(displayId)
    ) {
      rebuildAfterHide.push({ displayId, staleWindow: win });
    }
  }
  for (const { displayId, staleWindow } of rebuildAfterHide) {
    swapFreshSelectorForDisplay(displayId, staleWindow);
  }
  // Windows: while the selector was up (topmost screen-saver level, and on
  // win32 native-fullscreen to cover the taskbar), the post-capture toast
  // could NOT be made topmost — setAlwaysOnTop(true) during show-loaded
  // silently didn't stick (isAlwaysOnTop stayed false, confirmed via the
  // diagnostic log), so the toast rendered behind the Library. show-idle
  // worked because the selector wasn't shown yet. Now that the selector is
  // hidden, re-raise the (already-loaded) toast so it actually appears.
  // ensureFloatOverTopmost polls until isAlwaysOnTop() confirms the raise
  // took — setFullScreen(false) exits asynchronously, so a single assert can
  // land mid-transition; the loop self-terminates the instant it sticks.
  if (process.platform === "win32") {
    ensureFloatOverTopmost();
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
  if (process.platform === "win32") {
    // Windows: the taskbar (Shell_TrayWnd) is itself topmost, so a plain
    // always-on-top overlay renders BELOW it — the real taskbar shows through
    // on top of the frozen screenshot (which already includes a taskbar →
    // "two taskbars"). Native fullscreen spans the whole monitor including the
    // taskbar, so the overlay covers it. (Verified working on Windows; the
    // earlier 0xC0000005 crash was an unrelated tray-right-click bug.)
    //
    // Note: setFullScreen(true) grows the window to the full display (taskbar
    // covered) but isFullScreen() stays false on Windows, and the
    // enter/leave-full-screen events don't reliably fire — so the post-capture
    // toast can't rely on a leave-full-screen event to re-raise itself. The
    // re-raise is driven from hideAllSelectors instead.
    //
    // Call unconditionally — do NOT guard on isFullScreen(): it's unreliable
    // here (stays false even after a successful setFullScreen(true)), so a
    // guard would either no-op when it shouldn't or, on the leave side, leave
    // the window stuck full-screen. setFullScreen(true) on an already-grown
    // window is a harmless no-op, and this stays correct if a future Electron
    // makes isFullScreen() accurate. leaveMenuBarOverlayMode mirrors this.
    win.setFullScreen(true);
    return;
  }
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
  if (process.platform === "win32") {
    // Unconditional, NOT guarded on isFullScreen(): that getter stays false on
    // Windows even while the window is grown full-screen (see
    // enterMenuBarOverlayMode), so `if (win.isFullScreen())` would never fire
    // and the window would stay stuck at full-monitor size — the real taskbar
    // would never come back and the next capture's pre-warmed window would
    // start oversized. setFullScreen(false) on a non-fullscreen window is a
    // no-op, so calling it unconditionally is safe.
    win.setFullScreen(false);
    return;
  }
  if (process.platform !== "darwin") return;
  if (win.isSimpleFullScreen()) {
    win.setSimpleFullScreen(false);
  }
}

function createSelectorWindow(
  display: Display,
  reason: SelectorPrewarmReason = "startup"
): BrowserWindow {
  // Anchor to display.bounds. The selector enters simple-fullscreen
  // on show (covering the real menu bar) and paints its own copy of
  // the menu bar via the screen snapshot — so the user sees what
  // they expect AND we get a window-local coord space that matches
  // display logical px 1:1.
  const { bounds } = display;
  const window = new BrowserWindow({
    // `type: 'panel'` — NSPanel + NSWindowStyleMaskNonactivatingPanel.
    // Same primitive used by createFloatOverWindow / createTrayWindow.
    // The selector must NOT cause macOS to switch
    // Spaces. A regular NSWindow, even with the canJoinAllSpaces flag
    // (setVisibleOnAllWorkspaces below), can still trigger AppKit's
    // "find the Space this window belongs to and switch to it" path
    // when the owning app is brought frontmost —
    // and that path is what Splashtop's separate Space exposes. The
    // non-activating panel skips the app-activation step entirely,
    // so AppKit never has a reason to swap Spaces on the user.
    //
    // (`focusable: true` below is still respected for NSPanel; the
    // float-over uses the same combination to receive clicks/keys
    // without activating the app.)
    //
    // macOS-only — Windows/Linux have no NSPanel; the frameless,
    // transparent, always-on-top window below covers the display directly
    // (setSimpleFullScreen / enterMenuBarOverlayMode are already
    // darwin-gated).
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    title: SELECTOR_WINDOW_TITLE,
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
    // Windows needs native fullscreen (enterMenuBarOverlayMode) to draw OVER
    // the taskbar (a topmost window a plain always-on-top overlay can't cover),
    // so it must be fullscreenable there. macOS uses setSimpleFullScreen and
    // keeps this false.
    fullscreenable: process.platform === "win32",
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
      // On macOS this window is intentionally hidden while it warms.
      // Keep Chromium from throttling that hidden renderer load,
      // otherwise the first shortcut after launch can still wait on
      // the prewarm to finish.
      ...(process.platform === "darwin" ? { backgroundThrottling: false } : {}),
      // The renderer needs the display id baked in so it can post the
      // right value back to main on commit. Pass via a query string.
      additionalArguments: [`--display-id=${display.id}`]
    }
  });
  window.setTitle(SELECTOR_WINDOW_TITLE);

  // Highest-of-windows ordering — clears menu bar / other overlays.
  window.setAlwaysOnTop(true, "screen-saver");
  // visibleOnAllWorkspaces + visibleOnFullScreen — the selector must
  // appear on the user's CURRENT Space, regardless of which Space the
  // pre-warmed window was originally constructed on. Without this,
  // running PwrSnap alongside an app that holds its own Space (notably
  // Splashtop, the remote-desktop client) causes macOS to swap Spaces
  // to wherever the selector window was last associated on show —
  // the bug reported as "workspace shift on capture with Splashtop."
  // Paired with `type: 'panel'` above: the panel keeps show/showInactive
  // from activating the app, and canJoinAllSpaces (set here) keeps
  // the panel from being pinned to any single Space.
  // Spaces are macOS-only; on Windows/Linux this call is unnecessary (and
  // the visibleOnFullScreen option is a macOS concept).
  if (process.platform === "darwin") {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  const loadStartedAt = Date.now();
  selectorPrewarmTimings.set(display.id, {
    reason,
    startedAt: loadStartedAt,
    loadedAt: null
  });
  log.info("pre-warming capture selector", {
    displayId: display.id,
    reason,
    bounds
  });

  const target = rendererTarget(display.id);
  const load =
    target.kind === "url"
      ? window.loadURL(target.url)
      : window.loadFile(target.path, { hash: target.hash });
  selectorWindowLoads.set(
    window,
    load.then(
      () => {
        log.info("region selector renderer loaded", {
          displayId: display.id,
          reason,
          durationMs: Date.now() - loadStartedAt
        });
        const timing = selectorPrewarmTimings.get(display.id);
        if (timing !== undefined && timing.startedAt === loadStartedAt) {
          timing.loadedAt = Date.now();
        }
        return true;
      },
      (err: unknown) => {
        if (!window.isDestroyed()) {
          log.warn("region selector renderer failed to load", {
            displayId: display.id,
            message: err instanceof Error ? err.message : String(err)
          });
        }
        return false;
      }
    )
  );
  return window;
}

function scheduleStandbySelectorWarm(display: Display): void {
  if (process.platform !== "darwin") return;
  const existing = standbySelectorWindows.get(display.id);
  if (existing !== undefined && !existing.isDestroyed()) return;
  if (standbyWarmScheduled.has(display.id)) return;
  standbyWarmScheduled.add(display.id);
  log.info("pre-warming next capture selector scheduled", {
    displayId: display.id
  });
  setTimeout(() => {
    standbyWarmScheduled.delete(display.id);
    warmStandbySelectorForDisplay(display);
  }, 0);
}

function warmStandbySelectorForDisplay(display: Display): void {
  if (process.platform !== "darwin") return;
  const existing = standbySelectorWindows.get(display.id);
  if (existing !== undefined) {
    if (!existing.isDestroyed()) return;
    standbySelectorWindows.delete(display.id);
  }
  const win = createSelectorWindow(display, "standby");
  standbySelectorWindows.set(display.id, win);
}

function selectorPrewarmAgePayload(displayId?: number): {
  sinceLastPrewarmStartedMs?: number;
  sinceLastPrewarmLoadedMs?: number;
  lastPrewarmReason?: SelectorPrewarmReason;
  lastPrewarmDisplayId?: number;
} {
  const now = Date.now();
  let selectedDisplayId: number | undefined = displayId;
  let selected: SelectorPrewarmTiming | undefined =
    displayId === undefined ? undefined : selectorPrewarmTimings.get(displayId);
  if (selected === undefined) {
    for (const [candidateDisplayId, timing] of selectorPrewarmTimings) {
      if (selected === undefined || timing.startedAt > selected.startedAt) {
        selectedDisplayId = candidateDisplayId;
        selected = timing;
      }
    }
  }
  if (selected === undefined) return {};
  const payload: {
    sinceLastPrewarmStartedMs: number;
    sinceLastPrewarmLoadedMs?: number;
    lastPrewarmReason: SelectorPrewarmReason;
    lastPrewarmDisplayId?: number;
  } = {
    lastPrewarmReason: selected.reason,
    sinceLastPrewarmStartedMs: now - selected.startedAt
  };
  if (selectedDisplayId !== undefined) {
    payload.lastPrewarmDisplayId = selectedDisplayId;
  }
  if (selected.loadedAt !== null) {
    payload.sinceLastPrewarmLoadedMs = now - selected.loadedAt;
  }
  return payload;
}

async function waitForSelectorWindowLoad(
  displayId: number,
  win: BrowserWindow
): Promise<boolean> {
  const load = selectorWindowLoads.get(win);
  if (load === undefined) {
    return !win.isDestroyed() && selectorWindows.get(displayId) === win;
  }
  const loaded = await load;
  return loaded && !win.isDestroyed() && selectorWindows.get(displayId) === win;
}

function rebuildSelectorForDisplay(displayId: number): void {
  destroyStandbySelectorForDisplay(displayId);
  const existing = selectorWindows.get(displayId);
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.destroy();
  }
  selectorWindows.delete(displayId);
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return;
  const win = createSelectorWindow(display, "rebuild");
  selectorWindows.set(displayId, win);
}

function swapFreshSelectorForDisplay(displayId: number, staleWindow: BrowserWindow): void {
  selectorDisplaysNeedingFreshPanel.delete(displayId);
  const standby = standbySelectorWindows.get(displayId);
  standbySelectorWindows.delete(displayId);
  selectorWindows.delete(displayId);
  if (!staleWindow.isDestroyed()) {
    staleWindow.destroy();
  }
  if (standby !== undefined && !standby.isDestroyed()) {
    selectorWindows.set(displayId, standby);
    return;
  }
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) return;
  const win = createSelectorWindow(display, "swap-fallback");
  selectorWindows.set(displayId, win);
}

function destroyStandbySelectorForDisplay(displayId: number): void {
  standbyWarmScheduled.delete(displayId);
  const standby = standbySelectorWindows.get(displayId);
  if (standby !== undefined && !standby.isDestroyed()) {
    standby.destroy();
  }
  standbySelectorWindows.delete(displayId);
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
  const standby = standbySelectorWindows.get(display.id);
  if (standby !== undefined && !standby.isDestroyed()) {
    standby.setBounds(bounds);
  }
}

type RendererTarget = { kind: "url"; url: string } | { kind: "file"; path: string; hash: string };

function rendererTarget(displayId: number): RendererTarget {
  const hash = `stage=region&displayId=${displayId}`;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL !== undefined) {
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
  for (const win of standbySelectorWindows.values()) {
    if (!win.isDestroyed()) win.destroy();
  }
  standbySelectorWindows.clear();
  standbyWarmScheduled.clear();
  selectorDisplaysNeedingFreshPanel.clear();
  if (resultListenerAttached) {
    ipcMain.removeAllListeners(SELECTOR_RESULT_CHANNEL);
    resultListenerAttached = false;
  }
}

export const REGION_SELECTOR_RESULT_CHANNEL = SELECTOR_RESULT_CHANNEL;
export const REGION_SELECTOR_WINDOW_LIST_CHANNEL = SELECTOR_WINDOW_LIST_CHANNEL;
export const REGION_SELECTOR_KEY_CHANNEL = SELECTOR_KEY_CHANNEL;
export const REGION_SELECTOR_MODE_CHANNEL = SELECTOR_MODE_CHANNEL;
