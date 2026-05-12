// Float-over toast — singleton renderer with IPC-driven state machine.
//
// Phase 1.5 lifecycle (per docs/plans/2026-05-04-001):
//
//   HIDDEN → IDLE (pre-show under selector)
//          ↘ LOADED (post-commit, populated)
//   IDLE   → LOADED (commit) | HIDDEN (cancel)
//   LOADED → HIDDEN (dismiss / auto-dismiss / cancel-during-loaded)
//
// Why a state machine instead of `loadURL` per capture: every reload
// re-mounts React, re-establishes IPC subscriptions, AND leaves any
// in-flight `setTimeout`s on the page event loop. The 220ms exit-
// animation timer in FloatOver.tsx was firing AFTER the new capture's
// renderer mounted — explaining the "almost never see it" symptom.
// Persistent renderer + IPC events kills the race.
//
// Why pre-show under the selector: the selector is at screen-saver
// level (1000); the float-over is at floating level (3). The selector
// covers the float-over visually. When the user commits, hideSelector
// reveals the already-painted toast — no post-hoc show race with
// previous-app activation.

import { BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { EVENT_CHANNELS, type FloatOverEvent } from "@pwrsnap/shared";
import { bus } from "./command-bus";
import { getMainLogger } from "./log";
import { createFloatOverWindow } from "./window";

const log = getMainLogger("pwrsnap:float-over");

const FLOAT_OVER_RESIZE_CHANNEL = "float-over:resize";
/** Hard floor + ceiling so a renderer bug can't shrink the toast to
 *  nothing or grow it taller than any reasonable display. */
const FLOAT_OVER_HEIGHT_MIN = 160;
const FLOAT_OVER_HEIGHT_MAX = 800;
/** Window width is fixed by the design — must match `width` in
 *  `createFloatOverWindow`. The toast's `.fo` element is forced to
 *  `width: 100%` of the body via `body[data-stage="float-over"] .fo`,
 *  so all variants render at exactly this width. */
const FLOAT_OVER_WIDTH = 392;

type FloatOverState =
  | { kind: "hidden" }
  | { kind: "idle" }
  | { kind: "loaded"; captureId: string };

let singleton: BrowserWindow | null = null;
let state: FloatOverState = { kind: "hidden" };
/** Last event we sent to the renderer. Re-emitted on `did-finish-load`
 *  so the first capture-of-session doesn't miss the IPC if the renderer
 *  hadn't subscribed yet at send time. */
let lastEvent: FloatOverEvent | null = null;
/** True once the renderer has finished loading at least once. Until
 *  then, IPC events are buffered in `lastEvent` and re-sent on dom-ready. */
let rendererReady = false;
/** True after the first `showInactive()` call on the singleton. Subsequent
 *  show transitions skip `showInactive()` because we never `hide()` the
 *  window — see parkOffScreen() / restoreOnScreen() for the off-screen
 *  pseudo-hide model. Reset when the singleton is recreated. */
let everShown = false;

/** Where we park the float-over between uses. Far enough off-screen that
 *  no real display layout includes it, even on a 16K virtual workspace. */
const PARK_X = -20_000;
const PARK_Y = -20_000;

/**
 * Park the float-over off-screen with opacity 0 and mouse events
 * disabled — our pseudo-hide. The reason we don't call `BrowserWindow.hide()`
 * (which is `[NSWindow orderOut:]` under the hood):
 *
 * `orderOut:` removes the window from AppKit's on-screen list, which
 * triggers a key-window cascade for our app (PwrSnap). The cascade
 * lands on the [focus-sink](./focus-sink.ts) — also a floating-level
 * non-activating panel with `visibleOnAllWorkspaces` — and the act of
 * shuffling key state across two floating panels of an inactive app
 * appears to ripple back into whichever app the user is currently
 * typing in, yanking their `firstResponder` out from under them.
 *
 * Symptom: user takes a snap, clicks Terminal/Claude, starts typing —
 * when the toast auto-dismisses, the active app silently loses
 * keyboard focus.
 *
 * Park-off-screen sidesteps this entirely: the window stays in
 * AppKit's list, no cascade, no ripple. The transparent panel at
 * opacity 0 has effectively zero compositor cost (AppKit special-
 * cases windows offscreen + opacity 0).
 */
function parkOffScreen(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true);
  window.setOpacity(0);
  window.setPosition(PARK_X, PARK_Y, false);
}

/**
 * Restore the float-over to its anchored position with full opacity
 * and mouse events re-enabled. On the very first show of the session
 * we additionally call `showInactive()` to add the window to AppKit's
 * window list; subsequent shows skip that because the window is
 * already in the list (just parked off-screen).
 *
 * Caller is responsible for setting position via anchorBottomRight
 * BEFORE calling this — order matters because parkOffScreen left the
 * window at PARK_X/PARK_Y and we don't want a one-frame flash.
 */
function restoreOnScreen(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(false);
  window.setOpacity(1);
  if (!everShown) {
    window.showInactive();
    everShown = true;
  }
  // moveTop within the floating level — beats other floating windows
  // that may have come up since our last show.
  window.moveTop();
}

/**
 * Listen for float-over-renderer resize requests and `setContentSize`
 * so the toast window hugs its content. Called once on first window
 * creation. Each resize re-anchors to bottom-right because shrinking
 * height upward would otherwise leave the toast floating mid-screen
 * (we anchor by top-left coordinate, so growing/shrinking from a
 * fixed top-left moves the bottom edge).
 *
 * Mirrors `wireTrayResizeChannel` in tray.ts almost verbatim — same
 * pattern, just keyed on a different channel + window singleton.
 */
let resizeChannelWired = false;
function wireFloatOverResizeChannel(): void {
  if (resizeChannelWired) return;
  resizeChannelWired = true;
  ipcMain.on(FLOAT_OVER_RESIZE_CHANNEL, (_event, payload: unknown) => {
    if (
      payload === null ||
      typeof payload !== "object" ||
      typeof (payload as { height: unknown }).height !== "number"
    ) {
      return;
    }
    const heightCss = (payload as { height: number }).height;
    if (!Number.isFinite(heightCss)) return;
    if (singleton === null || singleton.isDestroyed()) return;
    // Renderer measures CSS pixels (post-zoom). `setContentSize`
    // takes DIP. Convert via zoomFactor — see the matching block in
    // tray.ts/wireTrayResizeChannel for the full rationale; same
    // shared-origin zoom story applies to the float-over.
    const zoom = singleton.webContents.zoomFactor;
    const heightDip = Math.ceil(heightCss * zoom);
    const clamped = Math.max(FLOAT_OVER_HEIGHT_MIN, Math.min(FLOAT_OVER_HEIGHT_MAX, heightDip));
    const current = singleton.getContentSize();
    if (current[1] === clamped) return;
    singleton.setContentSize(FLOAT_OVER_WIDTH, clamped, false);
    // Re-anchor only when the toast is logically on-screen. We can't
    // use `singleton.isVisible()` here — with the off-screen pseudo-
    // hide model, the window stays "visible" in AppKit's sense forever
    // after the first show, so isVisible() always returns true.
    // anchorBottomRight while parked would tug the parked window from
    // (-20000, -20000) to the bottom-right of the user's display — a
    // visible flash on the next dismiss when we re-park.
    if (state.kind !== "hidden") {
      anchorBottomRight(singleton);
    }
  });
}

function getOrCreate(): BrowserWindow {
  if (singleton !== null && !singleton.isDestroyed()) return singleton;
  wireFloatOverResizeChannel();
  const window = createFloatOverWindow();
  singleton = window;
  rendererReady = false;
  const markRendererReady = (): void => {
    rendererReady = true;
    if (lastEvent !== null && !window.isDestroyed()) {
      window.webContents.send(EVENT_CHANNELS.floatOverState, lastEvent);
    }
  };
  const markRendererReadyAfterReactMount = (): void => {
    setTimeout(markRendererReady, 100);
  };
  if (window.webContents.getURL() !== "" && !window.webContents.isLoadingMainFrame()) {
    markRendererReadyAfterReactMount();
  } else {
    window.webContents.once("did-finish-load", markRendererReadyAfterReactMount);
  }
  // Re-measure on zoom changes — see the matching block in
  // tray.ts/ensureTrayWindow for why ResizeObserver alone isn't
  // sufficient.
  window.webContents.on("zoom-changed", () => {
    if (window.isDestroyed()) return;
    window.webContents.send(EVENT_CHANNELS.popoverRemeasure, {});
  });
  window.on("closed", () => {
    if (singleton === window) {
      singleton = null;
      state = { kind: "hidden" };
      lastEvent = null;
      rendererReady = false;
      // Reset the everShown flag so the next getOrCreate() goes
      // through the first-show path again (calls showInactive()
      // to add the new window to AppKit's window list).
      everShown = false;
    }
  });
  // Park the freshly-created window off-screen immediately. Construction
  // already sets `show: false`, but parkOffScreen also flips opacity +
  // ignore-mouse-events so the FIRST restoreOnScreen has a clean slate
  // to undo. Without this, the very first show might briefly paint
  // at opacity 1 before anchorBottomRight runs.
  parkOffScreen(window);
  return window;
}

/**
 * Anchor the float-over in the bottom-right of the display the cursor
 * is currently on. Recomputed on every show-idle so the toast lands on
 * the right display even after a cursor move between captures.
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
 * Register the ⌘1 / ⌘2 / ⌘3 globalShortcuts so the user can copy
 * straight from the float-over without giving it keyboard focus.
 *
 * The float-over is a non-activating panel (`type: 'panel'` +
 * `showInactive`) — it never becomes the focused window of an app,
 * so plain `keydown` listeners in the renderer don't fire when the
 * user presses ⌘1 with another app frontmost. globalShortcut
 * bypasses focus entirely; while these are armed, ANY ⌘1 press
 * anywhere on macOS triggers our handler.
 *
 * Tradeoff: we steal the ⌘1/⌘2/⌘3 hotkeys from the user's other
 * apps for the lifetime of the LOADED state (≤ ~6s default
 * countdown, longer if hovering / pinned). Acceptable: the toast
 * is in-flight, and ⌘1 from the user's app is unlikely to be the
 * next deliberate keystroke.
 *
 * On every state-machine transition out of LOADED we unregister so
 * the user gets their hotkeys back.
 */
let copyShortcutsRegistered = false;
function armCopyShortcuts(captureId: string): void {
  if (copyShortcutsRegistered) {
    disarmCopyShortcuts();
  }
  globalShortcut.register("CommandOrControl+1", () => {
    void bus.dispatch("clipboard:copy", { captureId, preset: "low" }, { principal: "ipc" });
  });
  globalShortcut.register("CommandOrControl+2", () => {
    void bus.dispatch("clipboard:copy", { captureId, preset: "med" }, { principal: "ipc" });
  });
  globalShortcut.register("CommandOrControl+3", () => {
    void bus.dispatch("clipboard:copy", { captureId, preset: "high" }, { principal: "ipc" });
  });
  copyShortcutsRegistered = true;
}
function disarmCopyShortcuts(): void {
  if (!copyShortcutsRegistered) return;
  globalShortcut.unregister("CommandOrControl+1");
  globalShortcut.unregister("CommandOrControl+2");
  globalShortcut.unregister("CommandOrControl+3");
  copyShortcutsRegistered = false;
}

/**
 * The single entry point for the rest of the main process to drive the
 * float-over. All visibility transitions go through here so the IPC
 * event and the BrowserWindow state stay in lockstep.
 */
export function setFloatOverState(event: FloatOverEvent): void {
  switch (event.kind) {
    case "show-idle": {
      const window = getOrCreate();
      state = { kind: "idle" };
      // Anchor BEFORE restoring opacity — the window may currently be
      // parked at (PARK_X, PARK_Y) from a previous dismiss; moving it
      // first while still at opacity 0 avoids a one-frame flash.
      anchorBottomRight(window);
      // Selector (screen-saver level) covers this window visually
      // through the IDLE phase; user doesn't see the empty placeholder.
      restoreOnScreen(window);
      break;
    }
    case "show-loaded": {
      const window = getOrCreate();
      state = { kind: "loaded", captureId: event.captureId };
      // Re-anchor in case the user dragged-display between idle and
      // commit. (Cursor moved → bottom-right of the new display.)
      anchorBottomRight(window);
      restoreOnScreen(window);
      armCopyShortcuts(event.captureId);
      break;
    }
    case "cancel": {
      // Synchronous park, no exit animation. The user pressed Esc
      // out of the selector; the float-over was pre-shown UNDER the
      // selector and they should never have seen it. Park first,
      // selector hides 50ms later, no flash.
      state = { kind: "hidden" };
      if (singleton !== null && !singleton.isDestroyed()) {
        parkOffScreen(singleton);
      }
      disarmCopyShortcuts();
      break;
    }
    case "dismiss": {
      // User explicitly dismissed via the X / Esc on the toast / auto-
      // dismiss timer. The renderer played its exit animation and is
      // telling us to park. No animation here — the renderer faded.
      // See parkOffScreen() for why we don't call hide().
      state = { kind: "hidden" };
      if (singleton !== null && !singleton.isDestroyed()) {
        parkOffScreen(singleton);
      }
      disarmCopyShortcuts();
      break;
    }
  }

  // Stash + send the event AFTER the window state transitions so the
  // renderer never receives a state event before its window is ready.
  lastEvent = event;
  if (singleton !== null && !singleton.isDestroyed() && rendererReady) {
    singleton.webContents.send(EVENT_CHANNELS.floatOverState, event);
  }

  // `state.kind` is the source of truth for logical visibility — see
  // the comment on parkOffScreen / the resize handler. `isVisible()` is
  // not useful here: it stays true forever once the window is shown.
  log.info("float-over state", {
    kind: event.kind,
    logicalState: state.kind
  });
}

/** Snapshot of the current state. Used by tests + the cancel path. */
export function getFloatOverState(): FloatOverState {
  return state;
}

/**
 * Renderer-initiated dismiss — the user clicked X, hit Esc on the toast,
 * or the auto-dismiss countdown finished. Routed via the
 * `float-over:dismiss` command-bus handler (float-over-handlers.ts).
 *
 * Kept as a separate export rather than folding into setFloatOverState
 * so the bus handler reads naturally — it's the simple "hide it" verb.
 */
export function dismissFloatOver(): void {
  setFloatOverState({ kind: "dismiss" });
}

/**
 * Backwards-compat shim used by the headless `capture:region` path
 * before the lifecycle reorder lands. Callers passing a captureId go
 * straight to LOADED. Without an id, this is the historical "show
 * something" path used by an older test fixture; routes to IDLE so
 * the renderer mounts but doesn't try to fetch nothing.
 */
export function showFloatOverForCapture(captureId: string): void {
  setFloatOverState({ kind: "show-loaded", captureId });
}
