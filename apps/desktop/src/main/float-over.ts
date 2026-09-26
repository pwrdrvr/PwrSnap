// Float-over toast — singleton renderer with IPC-driven state machine.
//
// Lifecycle:
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
import {
  EVENT_CHANNELS,
  FLOAT_OVER_ANCHOR_MARGIN_DIP,
  FLOAT_OVER_HEIGHT_MIN_DIP,
  floatOverMaxContentHeightDip,
  IMAGE_PRESET_COPY_VERB,
  type FloatOverEvent,
  type RenderPreset
} from "@pwrsnap/shared";
import { bus } from "./command-bus";
import { hotkeyRecorderSuspension } from "./hotkeys/hotkey-recorder-suspension-instance";
import { windowPlacementIsOurs } from "./linux-window-placement";
import { getMainLogger } from "./log";
import { createFloatOverWindow } from "./window";

const log = getMainLogger("pwrsnap:float-over");

const FLOAT_OVER_RESIZE_CHANNEL = "float-over:resize";
const FLOAT_OVER_STATE_REQUEST_CHANNEL = "float-over:request-state";
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
/**
 * Display the float-over is currently anchored on, captured at
 * show-idle / show-loaded time. Subsequent content-driven resizes
 * re-anchor against THIS display rather than recomputing from the
 * cursor position — otherwise, if the user moves the cursor to a
 * different monitor between the initial show and an enrichment-
 * triggered resize (which is common: AI takes 1-6s, plenty of time
 * for a cursor wander), the toast would jump to that monitor mid-
 * flight. See bug vi.
 *
 * Recomputed only on explicit state transitions (show-idle / show-
 * loaded). Resize handlers MUST read this — never call
 * `screen.getCursorScreenPoint()` from a resize path.
 */
let anchoredDisplayId: number | null = null;
/** The latest state event. `floatOverState` is a state broadcast, not a
 *  one-shot intent: the renderer's whole state is a function of the
 *  latest event, so this one value is everything a late subscriber
 *  needs. Main replies with it when the renderer asks (see
 *  `wireFloatOverStateRequestChannel`). */
let lastEvent: FloatOverEvent | null = null;
/** True once the renderer has subscribed to `floatOverState` and asked for
 *  the current state. Until then nothing is sent live: the reply to the
 *  request carries `lastEvent`, so the first event is delivered exactly
 *  once, whenever the renderer's first render ends. */
let rendererSubscribed = false;
/** True after the first `showInactive()` call on the singleton.
 *  GATES ANYTHING ONLY ON macOS: there the window is never `hide()`-n, so
 *  later show transitions skip `showInactive()`. On the `hide` model
 *  (Windows, Linux) every restore shows for real and this is just a record
 *  that the toast has been up at least once. Reset when the singleton is
 *  recreated. See parkOffScreen() / restoreOnScreen(). */
let everShown = false;
/** One bounded Windows topmost retry chain. Disposal cancels it so no
 *  float-over-owned timer survives app teardown. */
let topmostRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Where we park the float-over between uses. Far enough off-screen that
 *  no real display layout includes it, even on a 16K virtual workspace. */
const PARK_X = -20_000;
const PARK_Y = -20_000;

function clearTopmostRetryTimer(): void {
  if (topmostRetryTimer === null) return;
  clearTimeout(topmostRetryTimer);
  topmostRetryTimer = null;
}

function resetFloatOverRuntimeState(): void {
  clearTopmostRetryTimer();
  singleton = null;
  state = { kind: "hidden" };
  anchoredDisplayId = null;
  lastEvent = null;
  rendererSubscribed = false;
  everShown = false;
}

/**
 * How this platform makes the toast go away.
 *
 * `opacity-park` — macOS only, and only because a real `hide()` there is
 * actively harmful (see the comment on `parkOffScreen`).
 *
 * `hide` — everyone else, including an unknown platform. This is the honest
 * default: `hide()` has no `@platform` annotation and works on every backend.
 * macOS is the exception that has to earn its way out, rather than the park
 * being the rule that every other platform has to survive.
 *
 * Pure and exported so the split is testable from any CI host.
 */
export type FloatOverHideModel = "opacity-park" | "hide";

export function floatOverHideModelForPlatform(
  platform: NodeJS.Platform
): FloatOverHideModel {
  return platform === "darwin" ? "opacity-park" : "hide";
}

/**
 * Make the toast go away. Two models — see `floatOverHideModelForPlatform`.
 *
 * On macOS this parks the window off-screen at opacity 0 with mouse events
 * disabled — a pseudo-hide. The reason we don't call `BrowserWindow.hide()`
 * there (which is `[NSWindow orderOut:]` under the hood):
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
 *
 * Every word of that is about AppKit, so NONE of it applies to Windows or
 * Linux — which is why both of those really hide the window.
 */
function parkOffScreen(window: BrowserWindow): void {
  window.setIgnoreMouseEvents(true);
  if (floatOverHideModelForPlatform(process.platform) === "hide") {
    // Windows AND Linux: a REAL hide().
    //
    // Windows, because `setOpacity` there drives whole-window layered alpha
    // (`SetLayeredWindowAttributes`), which is mutually exclusive with the
    // per-pixel alpha (`UpdateLayeredWindow`) a `transparent: true` window
    // composites through — a setOpacity(0)→setOpacity(1) round-trip leaves
    // the toast BLANK (visible + opaque per the API, but nothing painted).
    //
    // Linux, because `setOpacity` is `@platform win32,darwin` and does
    // NOTHING there. Measured on Electron 41.10.7 under both a headless
    // weston and xvfb: `getOpacity()` still reports 1 after `setOpacity(0)`.
    // So on Linux the opacity half of the park never hid anything, and the
    // position half only worked under X11 — leaving the toast permanently on
    // screen under Wayland, where `setPosition` is inert too. Both halves of
    // the macOS park are unavailable on Wayland; `hide()` is available on
    // every backend, so Linux uses the model Windows already proves.
    window.hide();
    return;
  }
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
  if (floatOverHideModelForPlatform(process.platform) === "hide") {
    // `parkOffScreen` really hid this window, so every restore has to really
    // show it — there is no once-only shortcut here. (That shortcut is what
    // broke Linux: `everShown` was burned by the selector's `show-idle`, and
    // the two calls left on the commit path were both no-ops.)
    window.showInactive();
    everShown = true;
    if (process.platform === "win32") {
      // Raise ABOVE the Library / foreground window WITHOUT stealing focus.
      // setAlwaysOnTop(true) → SetWindowPos(HWND_TOPMOST, SWP_NOACTIVATE). We
      // do NOT moveTop(): on Windows that's SetWindowPos(HWND_TOP), which
      // CLEARS WS_EX_TOPMOST and drops the toast back under the Library.
      // (Topmost won't actually stick while the fullscreen selector is up —
      // hideAllSelectors re-asserts it via ensureFloatOverTopmost once the
      // selector hides.)
      window.setAlwaysOnTop(true);
      return;
    }
    // Linux: same raise as macOS below. `moveTop` has no platform annotation
    // and carries none of the WS_EX_TOPMOST baggage.
    window.moveTop();
    return;
  }
  window.setOpacity(1);
  // macOS: once-only showInactive to add the parked panel to AppKit's window
  // list (re-showing it on later captures is unnecessary and can reshuffle key
  // state).
  if (!everShown) {
    window.showInactive();
    everShown = true;
  }
  // moveTop within the floating level beats other floating windows that may
  // have come up since our last show.
  window.moveTop();
}

/**
 * Work-area height (DIP) of the display the toast is anchored to, or
 * `null` before the first anchor / if that display has since gone away.
 *
 * Deliberately does NOT fall back to the cursor's display the way
 * {@link reanchorOnCurrentDisplay} does. This feeds the resize clamp,
 * which has to agree with the cap the RENDERER applies, and the
 * renderer reads `window.screen` — the display the WINDOW sits on. A
 * cursor that wandered to another monitor mid-toast is bug vi; letting
 * it shrink the ceiling here would clip the footer on the monitor the
 * toast is actually on. `null` simply means the constant ceiling
 * applies, which is what the renderer falls back to as well.
 */
function anchoredWorkAreaHeightDip(): number | null {
  if (anchoredDisplayId === null) return null;
  const display = screen.getAllDisplays().find((d) => d.id === anchoredDisplayId);
  return display === undefined ? null : display.workArea.height;
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
    // Hard floor + ceiling, so a renderer bug can't shrink the toast to
    // nothing or grow it taller than the display it is anchored to.
    //
    // The ceiling is the SAME number the renderer caps `.fo` at — the
    // policy lives in `@pwrsnap/shared/float-over-sizing` precisely so
    // the two cannot disagree, because this clamp is a backstop, not
    // the mechanism. When it fires, the window is smaller than what the
    // renderer laid out and Chromium simply doesn't paint the rest;
    // the footer is last in the box, so Discard / Dismiss / Edit are
    // what go missing. The renderer scrolls its middle instead, and
    // reads its own `window.screen.availHeight` — which equals this
    // display's `workArea.height` — to land on the same ceiling.
    const maxDip = floatOverMaxContentHeightDip(anchoredWorkAreaHeightDip());
    const clamped = Math.max(FLOAT_OVER_HEIGHT_MIN_DIP, Math.min(maxDip, heightDip));
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
      // Re-anchor on the SAME display we anchored to at show time —
      // never recompute from the cursor here. If the cursor has
      // wandered to a different monitor while the toast was on
      // screen (e.g., AI enrichment in progress), recomputing from
      // cursor would yank the toast to that monitor mid-flight.
      // See bug vi.
      reanchorOnCurrentDisplay(singleton);
    }
  });
}

/**
 * The renderer's half of delivering state: FloatOverHost subscribes to
 * `floatOverState` and then sends this request, and main answers with
 * `lastEvent` on that same channel. From then on every event is sent
 * live, in order, behind the reply.
 *
 * The window is created lazily by the first `setFloatOverState`, so the
 * first event always exists before the renderer that has to show it.
 * Main used to guess when that renderer would be listening: it sent
 * `lastEvent` 100ms after `did-finish-load`. The listener is attached
 * in a React passive effect, after the first render, and nothing bounds
 * how long that render takes. Under CPU load the send landed mid-render
 * and raced the effect flush; when it won, the first toast stayed empty
 * (docs/solutions/2026-09-26-float-over-first-state-lost.md). Only the
 * renderer knows when it is listening, so it says so.
 *
 * Only the float-over's own webContents may ask. A renderer that
 * reloads asks again and gets the latest state.
 */
let stateRequestChannelWired = false;
function wireFloatOverStateRequestChannel(): void {
  if (stateRequestChannelWired) return;
  stateRequestChannelWired = true;
  ipcMain.on(FLOAT_OVER_STATE_REQUEST_CHANNEL, (event) => {
    if (singleton === null || singleton.isDestroyed()) return;
    if (event.sender !== singleton.webContents) return;
    rendererSubscribed = true;
    if (lastEvent !== null) {
      singleton.webContents.send(EVENT_CHANNELS.floatOverState, lastEvent);
    }
  });
}

function getOrCreate(): BrowserWindow {
  if (singleton !== null && !singleton.isDestroyed()) return singleton;
  wireFloatOverResizeChannel();
  wireFloatOverStateRequestChannel();
  const window = createFloatOverWindow();
  singleton = window;
  rendererSubscribed = false;
  // NOTE: deliberately no `zoom-changed` hook — that event is
  // mouse-wheel-only and never fires for programmatic zoom or
  // HostZoomMap propagation. The renderer detects effective-zoom
  // changes itself via a devicePixelRatio media-query listener
  // (see FloatOverHost.tsx) and re-posts through the resize channel.
  // Matches tray.ts/ensureTrayWindow; see
  // docs/solutions/2026-07-15-popover-zoom-remeasure-dpr.md.
  window.on("closed", () => {
    if (singleton === window) {
      disarmCopyShortcuts();
      resetFloatOverRuntimeState();
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
 * is currently on.
 *
 * Under Wayland `screen.getCursorScreenPoint()` is not a reliable global
 * pointer read (a Wayland client is not told where the pointer is outside its
 * own surfaces), so the chosen display may be wrong on a multi-monitor
 * session — and the corner is not applied there anyway. Harmless on the
 * single-monitor case, which is what the fallback resolves to. Called only on explicit state transitions
 * (show-idle / show-loaded) — NEVER from a content-driven resize
 * path. Records the chosen display id in `anchoredDisplayId` so
 * subsequent resize-triggered re-anchors stick to the same monitor.
 * See bug vi.
 */
function anchorBottomRight(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  anchoredDisplayId = display.id;
  placeBottomRightOn(window, display);
}

/**
 * The one place the toast's corner is computed and applied.
 *
 * ⚠️  Under Wayland this cannot place anything and deliberately does not try.
 * `setPosition` is documented "Not supported on Wayland (Linux)" and a Wayland
 * client cannot position its own toplevel by protocol design — the compositor
 * decides. Stock mutter (GNOME 46, default settings, measured with pixels)
 * puts it by automatic placement near the top-left of the work area, NOT in
 * the bottom-right corner and not centred; it centres only with
 * `org.gnome.mutter center-new-windows`. Calling it anyway would read as a
 * placement that works; skipping it is what makes the limitation greppable.
 *
 * `anchoredDisplayId` is still recorded by the callers, because the toast is
 * still logically ON a display even when we did not choose which.
 *
 * Note this is why `getPosition()`-style verification is not attempted: the
 * getter echoes whatever was last set on BOTH backends (measured — see
 * linux-window-placement.ts), so a readback proves nothing.
 */
function placeBottomRightOn(window: BrowserWindow, display: Electron.Display): void {
  if (!windowPlacementIsOurs()) return;
  const wa = display.workArea;
  const margin = FLOAT_OVER_ANCHOR_MARGIN_DIP;
  const [w, h] = window.getSize();
  const x = Math.round(wa.x + wa.width - w - margin);
  const y = Math.round(wa.y + wa.height - h - margin);
  window.setPosition(x, y, false);
}

/**
 * Re-anchor the float-over on the display it was last anchored to via
 * `anchorBottomRight`. Used by the resize handler so content growth
 * (e.g., AI enrichment populating the toast) doesn't tug the window
 * onto whatever display the cursor happens to be hovering. Falls
 * back to the cursor-display if we somehow ended up resizing before
 * anchoring (no recorded display id) — that path shouldn't trigger
 * in practice but keeps the toast on-screen if it does.
 */
function reanchorOnCurrentDisplay(window: BrowserWindow): void {
  let display = anchoredDisplayId === null
    ? null
    : screen.getAllDisplays().find((d) => d.id === anchoredDisplayId) ?? null;
  if (display === null) {
    // Recorded display vanished (e.g., monitor unplugged) or we
    // never anchored. Fall back to cursor-anchored so the toast
    // stays visible. Update the recorded id so subsequent resizes
    // stay stable.
    const cursor = screen.getCursorScreenPoint();
    display = screen.getDisplayNearestPoint(cursor);
    anchoredDisplayId = display.id;
  }
  placeBottomRightOn(window, display);
}

/**
 * Register the active capture's primary-modifier export shortcuts so the user
 * can copy straight from the float-over without giving it keyboard focus.
 *
 * The float-over is a non-activating panel (`type: 'panel'` +
 * `showInactive`) — it never becomes the focused window of an app,
 * so plain `keydown` listeners in the renderer don't fire when the
 * user presses the advertised chord with another app frontmost. globalShortcut
 * bypasses focus entirely; while these are armed, the matching chord
 * triggers our handler even when another app is frontmost.
 *
 * Tradeoff: we transiently own primary+1…3 from the user's other apps for an
 * image, or primary+1…6 for a video, for the lifetime of the LOADED state
 * (≤ ~6s default countdown, longer if hovering / pinned). Acceptable: the
 * toast is in-flight, and a numbered primary chord in another app is unlikely
 * to be the next deliberate keystroke.
 *
 * On every state-machine transition out of LOADED we unregister so
 * the user gets their hotkeys back.
 */
const ownedCopyShortcuts = new Set<string>();
let copyShortcutGeneration = 0;
let copyShortcutsSuspended = false;
function emitCopyPulse(preset: RenderPreset): void {
  if (singleton === null || singleton.isDestroyed()) return;
  singleton.webContents.send(EVENT_CHANNELS.floatOverCopyPulse, { preset });
}

function emitVideoCopyShortcut(
  captureId: string,
  format: "gif" | "mp4",
  preset: RenderPreset
): void {
  if (singleton === null || singleton.isDestroyed()) return;
  singleton.webContents.send(EVENT_CHANNELS.floatOverVideoCopyShortcut, {
    captureId,
    format,
    preset
  });
}

function armCopyShortcuts(captureId: string): void {
  disarmCopyShortcuts();
  if (copyShortcutsSuspended) return;
  const generation = copyShortcutGeneration;
  void bus.dispatch("library:byId", { id: captureId }, { principal: "ipc" }).then((result) => {
    if (
      generation !== copyShortcutGeneration ||
      state.kind !== "loaded" ||
      state.captureId !== captureId
    ) {
      return;
    }
    if (!result.ok || result.value === null) {
      log.warn("float-over copy shortcuts skipped because capture metadata is unavailable", {
        captureId,
        reason: result.ok ? "not-found" : result.error.code
      });
      return;
    }

    const presets = ["low", "med", "high"] as const;
    const shortcuts = result.value.kind === "video"
      ? ([
          ...presets.map((preset, index) => ({
            accelerator: `CommandOrControl+${index + 1}`,
            format: "gif" as const,
            preset
          })),
          ...presets.map((preset, index) => ({
            accelerator: `CommandOrControl+${index + 4}`,
            format: "mp4" as const,
            preset
          }))
        ] as const)
      : presets.map((preset, index) => ({
          accelerator: `CommandOrControl+${index + 1}`,
          format: "image" as const,
          preset
        }));

    for (const { accelerator, format, preset } of shortcuts) {
      try {
        const registered = globalShortcut.register(
          accelerator,
          () => {
            if (copyShortcutsSuspended) return;
            if (format === "image") {
              emitCopyPulse(preset);
              void bus.dispatch(
                IMAGE_PRESET_COPY_VERB,
                { captureId, preset },
                { principal: "ipc" }
              );
              return;
            }
            emitVideoCopyShortcut(captureId, format, preset);
          }
        );
        if (registered) {
          ownedCopyShortcuts.add(accelerator);
        } else {
          log.warn("float-over copy shortcut unavailable; leaving its owner untouched", {
            accelerator
          });
        }
      } catch (cause) {
        log.warn("float-over copy shortcut registration threw", {
          accelerator,
          message: cause instanceof Error ? cause.message : String(cause)
        });
      }
    }
  }).catch((cause: unknown) => {
    if (generation !== copyShortcutGeneration) return;
    log.warn("float-over copy shortcut metadata lookup threw", {
      captureId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  });
}
function disarmCopyShortcuts(): void {
  copyShortcutGeneration += 1;
  for (const accelerator of ownedCopyShortcuts) {
    globalShortcut.unregister(accelerator);
  }
  ownedCopyShortcuts.clear();
}

hotkeyRecorderSuspension.registerParticipant({
  id: "float-over-copy-shortcuts",
  suspend(): void {
    copyShortcutsSuspended = true;
    disarmCopyShortcuts();
  },
  restore(): void {
    copyShortcutsSuspended = false;
    if (state.kind === "loaded") armCopyShortcuts(state.captureId);
  }
});

/**
 * The single entry point for the rest of the main process to drive the
 * float-over. All visibility transitions go through here so the IPC
 * event and the BrowserWindow state stay in lockstep.
 */
export function setFloatOverState(event: FloatOverEvent): void {
  // A new explicit state transition supersedes any retry chain from the
  // previous loaded toast.
  clearTopmostRetryTimer();
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
  if (singleton !== null && !singleton.isDestroyed() && rendererSubscribed) {
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
 * One attempt to re-raise the toast to topmost (Windows). While the region
 * selector covers the screen (native fullscreen + screen-saver always-on-top),
 * setAlwaysOnTop(true) on the toast during `show-loaded` silently doesn't stick
 * — and crucially `isAlwaysOnTop()` reads back `false` in that state, which
 * gives us a reliable "did it take?" signal to poll on. Returns `true` once the
 * flag actually sticks (or when there's nothing to do — not win32, not loaded,
 * or the singleton is gone), `false` while the assert is still being swallowed.
 *
 * The selector's `leave-full-screen` event does NOT fire on Windows
 * (setFullScreen grows the window but isFullScreen() stays false), so the
 * region selector drives this from `hideAllSelectors` via
 * {@link ensureFloatOverTopmost} — the reliable "selector is now hidden" point.
 */
function reassertFloatOverTopmost(): boolean {
  if (process.platform !== "win32") return true;
  if (state.kind !== "loaded") return true;
  if (singleton === null || singleton.isDestroyed()) return true;
  singleton.setAlwaysOnTop(true);
  singleton.showInactive();
  // Force a full repaint. The toast was first shown while occluded by the
  // fullscreen selector; even with native occlusion calc disabled, nudge
  // Chromium to composite a fresh frame now that nothing covers it.
  if (!singleton.webContents.isDestroyed()) {
    singleton.webContents.invalidate();
  }
  // Did topmost actually take? `isAlwaysOnTop()` stays false while the
  // selector's fullscreen window is still in front, so this is the signal
  // the retry loop converges on.
  return singleton.isAlwaysOnTop();
}

/**
 * Re-raise the toast to topmost (Windows) and keep retrying until it actually
 * sticks. `setFullScreen(false)` on the selector exits asynchronously, so the
 * first assert from `hideAllSelectors` can land mid-transition and be ignored.
 * Rather than firing a couple of fixed-delay timers and hoping one lands after
 * the transition (fragile across slow hardware / RDP), poll on a short interval
 * and stop the instant `isAlwaysOnTop()` confirms it took — self-terminating
 * when it works, resilient when the transition runs long. Bounded so a window
 * that never accepts topmost (state left "loaded", destroyed, etc.) can't spin
 * forever. No-op off win32.
 */
export function ensureFloatOverTopmost(): void {
  if (process.platform !== "win32") return;
  clearTopmostRetryTimer();
  // Usually the selector is already down by the time we're called — try once
  // synchronously and skip the timer churn when it takes immediately.
  if (reassertFloatOverTopmost()) return;
  const INTERVAL_MS = 50;
  const MAX_ATTEMPTS = 40; // up to ~2s of retrying past the first attempt
  let attempts = 0;
  const tick = (): void => {
    topmostRetryTimer = null;
    attempts += 1;
    // reassertFloatOverTopmost() returns true both when topmost sticks AND
    // when there's nothing left to raise (state moved off "loaded", singleton
    // destroyed) — either way we're done.
    if (reassertFloatOverTopmost() || attempts >= MAX_ATTEMPTS) return;
    topmostRetryTimer = setTimeout(tick, INTERVAL_MS);
  };
  topmostRetryTimer = setTimeout(tick, INTERVAL_MS);
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
 * E2E-only identity hook for the persistent float-over singleton. The window's
 * URL is empty while its first navigation is still committing, so locating it
 * by `stage=float-over` makes a synchronous show look nonexistent on a cold
 * Windows renderer. Returning the BrowserWindow id lets the spec inspect the
 * window that setFloatOverState created immediately, without changing the
 * production visibility choreography.
 */
export function getFloatOverWindowIdForE2E(): number | null {
  return singleton !== null && !singleton.isDestroyed() ? singleton.id : null;
}

/**
 * Destroy and fully reset the persistent float-over singleton. Safe to call
 * repeatedly from before-quit and will-quit.
 */
export function disposeFloatOver(): void {
  disarmCopyShortcuts();
  clearTopmostRetryTimer();
  if (resizeChannelWired) {
    ipcMain.removeAllListeners(FLOAT_OVER_RESIZE_CHANNEL);
    resizeChannelWired = false;
  }
  if (stateRequestChannelWired) {
    ipcMain.removeAllListeners(FLOAT_OVER_STATE_REQUEST_CHANNEL);
    stateRequestChannelWired = false;
  }
  if (singleton !== null && !singleton.isDestroyed()) {
    singleton.destroy();
  }
  resetFloatOverRuntimeState();
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
