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

import { BrowserWindow, screen } from "electron";
import { EVENT_CHANNELS, type FloatOverEvent } from "@pwrsnap/shared";
import { getMainLogger } from "./log";
import { createFloatOverWindow } from "./window";

const log = getMainLogger("pwrsnap:float-over");

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

function getOrCreate(): BrowserWindow {
  if (singleton !== null && !singleton.isDestroyed()) return singleton;
  const window = createFloatOverWindow();
  singleton = window;
  rendererReady = false;
  window.webContents.once("did-finish-load", () => {
    rendererReady = true;
    if (lastEvent !== null && !window.isDestroyed()) {
      window.webContents.send(EVENT_CHANNELS.floatOverState, lastEvent);
    }
  });
  window.on("closed", () => {
    if (singleton === window) {
      singleton = null;
      state = { kind: "hidden" };
      lastEvent = null;
      rendererReady = false;
    }
  });
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
 * The single entry point for the rest of the main process to drive the
 * float-over. All visibility transitions go through here so the IPC
 * event and the BrowserWindow state stay in lockstep.
 */
export function setFloatOverState(event: FloatOverEvent): void {
  switch (event.kind) {
    case "show-idle": {
      const window = getOrCreate();
      state = { kind: "idle" };
      anchorBottomRight(window);
      // showInactive() — never steal focus. Selector (screen-saver
      // level) covers this window visually; user doesn't see the
      // empty placeholder.
      if (!window.isVisible()) {
        window.showInactive();
      }
      // moveTop within the floating level — beats other floating
      // windows that may have come up since our last show.
      window.moveTop();
      break;
    }
    case "show-loaded": {
      const window = getOrCreate();
      state = { kind: "loaded", captureId: event.captureId };
      // Re-anchor in case the user dragged-display between idle and
      // commit. (Cursor moved → bottom-right of the new display.)
      anchorBottomRight(window);
      if (!window.isVisible()) {
        window.showInactive();
      }
      window.moveTop();
      break;
    }
    case "cancel": {
      // Synchronous hide, no exit animation. The user pressed Esc
      // out of the selector; the float-over was pre-shown UNDER the
      // selector and they should never have seen it. Hide first,
      // selector hides 50ms later, no flash.
      state = { kind: "hidden" };
      if (singleton !== null && !singleton.isDestroyed() && singleton.isVisible()) {
        singleton.hide();
      }
      break;
    }
    case "dismiss": {
      // User explicitly dismissed via the X / Esc on the toast / auto-
      // dismiss timer. The renderer played its exit animation and is
      // telling us to hide. No animation here — the renderer faded.
      state = { kind: "hidden" };
      if (singleton !== null && !singleton.isDestroyed() && singleton.isVisible()) {
        singleton.hide();
      }
      break;
    }
  }

  // Stash + send the event AFTER the window state transitions so the
  // renderer never receives a state event before its window is ready.
  lastEvent = event;
  if (singleton !== null && !singleton.isDestroyed() && rendererReady) {
    singleton.webContents.send(EVENT_CHANNELS.floatOverState, event);
  }

  log.info("float-over state", {
    kind: event.kind,
    visible: singleton?.isVisible() ?? false
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
