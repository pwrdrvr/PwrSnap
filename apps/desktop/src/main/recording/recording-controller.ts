// Owns the lifecycle of the floating recording-controller HUD
// window. Listens to recording-state transitions and:
//
//   • Creates + shows the window when state leaves `idle`.
//   • Anchors it at the top-center of the active display.
//   • Hides + destroys when state returns to `idle` / `ready` / `failed`.
//
// The window itself is wired in `window.ts`; the React side lives in
// `apps/desktop/src/renderer/src/features/recording/RecordingController.tsx`
// and binds to `events:recording:state` directly for its visuals.
// This module is the BrowserWindow-side glue.

import { BrowserWindow, globalShortcut, screen } from "electron";
import type { RecordingState } from "@pwrsnap/shared";
import { appWindowsOverlappingRect } from "../capture/rect-overlap";
import { bus } from "../command-bus";
import { getMainLogger } from "../log";
import { createRecordingControllerWindow } from "../window";
import { subscribeToRecordingState } from "./recording-state";

const log = getMainLogger("pwrsnap:recording-controller");

let window: BrowserWindow | null = null;
let installed = false;
let escapeShortcutArmed = false;

function ensureWindow(): BrowserWindow {
  if (window !== null && !window.isDestroyed()) return window;
  window = createRecordingControllerWindow();
  window.on("closed", () => {
    window = null;
  });
  return window;
}

/**
 * The HUD's renderer PID, if the window currently exists and its
 * renderer has loaded. Returns null otherwise (window not created
 * yet, destroyed, or renderer still booting with PID 0).
 *
 * Used by `recording-service.collectOurPids()` to build a TARGETED
 * SCContentFilter exclusion — just the HUD, not every PwrSnap
 * BrowserWindow. Excluding the Library / Settings / tray PIDs broke
 * the obvious use case of "record my own app window": SCContentFilter
 * with `excludingApplications` hides that PID's pixels and shows
 * whatever sits behind the window, which is never what the user wants
 * when they explicitly picked one of our windows as the subject.
 */
export function getRecordingControllerPid(): number | null {
  if (window === null || window.isDestroyed()) return null;
  try {
    const pid = window.webContents.getOSProcessId();
    return pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Anchor the HUD at top-center of the recorded display (or the
 * primary if we don't know which one). The HUD's PID is in the
 * recorder's `excludePids` list, so it won't show up in the
 * captured pixels even when it sits inside the recorded area.
 * Keeping the pill on the same monitor matches user expectation —
 * a HUD that lives on a different display feels disconnected.
 */
function anchorTopCenter(win: BrowserWindow, recordedDisplayId?: number): void {
  const displays = screen.getAllDisplays();
  const [w] = win.getSize();
  const target =
    (recordedDisplayId !== undefined
      ? displays.find((d) => d.id === recordedDisplayId)
      : undefined) ?? screen.getPrimaryDisplay();
  const wa = target.workArea;
  const x = Math.round(wa.x + (wa.width - w) / 2);
  const y = Math.round(wa.y + 16);
  win.setPosition(x, y, false);
}


type ScreenRect = { x: number; y: number; width: number; height: number };

type Point = { x: number; y: number };

function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function pointFitsWorkArea(point: Point, width: number, height: number, workArea: ScreenRect): boolean {
  return point.x >= workArea.x &&
    point.y >= workArea.y &&
    point.x + width <= workArea.x + workArea.width &&
    point.y + height <= workArea.y + workArea.height;
}

function clampPointToWorkArea(point: Point, width: number, height: number, workArea: ScreenRect): Point {
  return {
    x: Math.min(Math.max(point.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(point.y, workArea.y), workArea.y + workArea.height - height)
  };
}

/**
 * FFmpeg/gdigrab cannot exclude the HUD the way ScreenCaptureKit can on
 * macOS. During Windows recording, keep the compact controller outside the
 * recorded rect whenever the work area has room. Full-display recordings have
 * no safe in-display placement, so they fall back to the normal top-center
 * anchor and can still be stopped from the tray context menu.
 */
function anchorAwayFromRecordedRect(
  win: BrowserWindow,
  rect: { x: number; y: number; w: number; h: number },
  displayId: number
): void {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const [w, h] = win.getSize();
  const workArea = display.workArea;
  const recorded = {
    x: display.bounds.x + rect.x,
    y: display.bounds.y + rect.y,
    width: rect.w,
    height: rect.h
  };
  const centerX = recorded.x + (recorded.width - w) / 2;
  const centerY = recorded.y + (recorded.height - h) / 2;
  const candidates: Point[] = [
    { x: recorded.x + recorded.width + 12, y: centerY },
    { x: recorded.x - w - 12, y: centerY },
    { x: centerX, y: recorded.y + recorded.height + 12 },
    { x: centerX, y: recorded.y - h - 12 },
    { x: workArea.x + (workArea.width - w) / 2, y: workArea.y + 16 },
    { x: workArea.x + (workArea.width - w) / 2, y: workArea.y + workArea.height - h - 16 }
  ].map((point) => clampPointToWorkArea(point, w, h, workArea));

  for (const point of candidates) {
    if (!pointFitsWorkArea(point, w, h, workArea)) continue;
    const hud = { x: point.x, y: point.y, width: w, height: h };
    if (!rectsIntersect(hud, recorded)) {
      win.setPosition(Math.round(point.x), Math.round(point.y), false);
      return;
    }
  }

  anchorTopCenter(win, displayId);
}
/**
 * Position + size the HUD so it BECOMES the recorded rect. The
 * window's content area covers the user's selected area exactly;
 * the SVG film-leader fills 100% of that area via its viewBox.
 * The user sees the countdown drawn inside their actual recording
 * surface — no offset, no spillover.
 *
 * `rect` is in display-local logical pixels (selector convention);
 * `setPosition` + `setContentSize` both take logical px in the
 * global virtual coord space, so we add `display.bounds.{x,y}` to
 * translate.
 */
function fillRect(
  win: BrowserWindow,
  rect: { x: number; y: number; w: number; h: number },
  displayId: number
): void {
  const display = screen.getAllDisplays().find((d) => d.id === displayId);
  if (display === undefined) {
    anchorTopCenter(win);
    return;
  }
  // Floor to integer pixels; rect dimensions are usually integer
  // already (selector emits Math.round'd values) but defensive
  // anyway.
  const w = Math.max(120, Math.floor(rect.w));
  const h = Math.max(120, Math.floor(rect.h));
  // Order matters: setContentSize first so the subsequent position
  // computation reads the already-grown size. setPosition then
  // anchors the top-left of the window to the top-left of the rect.
  win.setContentSize(w, h, false);
  const x = Math.round(display.bounds.x + rect.x);
  const y = Math.round(display.bounds.y + rect.y);
  win.setPosition(x, y, false);
}

function armLeadInEscapeShortcut(): void {
  if (escapeShortcutArmed) return;
  // The lead-in HUD is focusable:false and shown inactive, so a
  // renderer keydown listener would miss Esc in the common case.
  const registered = globalShortcut.register("Escape", () => {
    void bus.dispatch("recording:cancel", {}, { principal: "ipc" });
  });
  if (!registered) {
    log.warn("recording lead-in Escape shortcut unavailable");
    return;
  }
  escapeShortcutArmed = true;
}

function disarmLeadInEscapeShortcut(): void {
  if (!escapeShortcutArmed) return;
  globalShortcut.unregister("Escape");
  escapeShortcutArmed = false;
}

/**
 * React to a recording-state transition. Idempotent — called from
 * the broadcast pipeline on every transition, branches on phase.
 */
export function applyRecordingStateToController(state: RecordingState): void {
  switch (state.phase) {
    case "preflight":
    case "countdown":
    case "starting": {
      const win = ensureWindow();
      armLeadInEscapeShortcut();
      // Countdown overlay sits over the user's content; clicks
      // should fall through to the recorded surface so they don't
      // accidentally hit our window. setIgnoreMouseEvents enables
      // click-through; recording phase flips it back off so the
      // Stop button is interactive.
      win.setIgnoreMouseEvents(true);
      // HUD becomes the recorded rect — the SVG leader paints
      // inside it, so the user sees the countdown exactly on the
      // surface that's about to be captured. The orange wedge
      // sweep is kept very light (≈0.12 alpha at full fill) so
      // a PwrSnap-window subject (Library / edit / Sizzle /
      // Settings) stays readable through the overlay; non-PwrSnap
      // subjects still get a clearly-visible "this area is the
      // recording target" cue.
      fillRect(win, state.rect, state.displayId);
      if (!win.isVisible()) {
        win.showInactive();
      } else {
        win.moveTop();
      }
      // Re-assert the user's PwrSnap window on TOP of the
      // normal-level z-order on every pre-roll tick. The
      // showInactive() above adds the HUD to the window list at
      // floating level (above Library at normal level) — that's
      // fine, the HUD IS supposed to overlay the recording rect.
      // What's NOT fine: between ticks, Cocoa can let another
      // app's normal-level window (e.g. Claude, Terminal) float
      // back above the Library at normal level. Empirically the
      // user sees this as "the Library got pushed under during
      // the lead-in." moveTop here is per-window-level — it
      // doesn't fight the HUD's higher floating level, it just
      // keeps the Library top of normal-level windows for the
      // duration of the countdown.
      //
      // Pass `win` (the HUD) as `excludeWindow`: it just
      // `fillRect`-ed itself to the recording rect, so its bounds
      // match by design — we don't want to moveTop ourselves.
      const ourOverlapping = appWindowsOverlappingRect(
        state.rect,
        state.displayId,
        win
      );
      for (const otherWin of ourOverlapping) {
        otherWin.moveTop();
      }
      break;
    }
    case "recording":
    case "stopping":
    case "processing": {
      const win = ensureWindow();
      disarmLeadInEscapeShortcut();
      // Recording-phase pill is compact; tuck it top-center of the
      // recorded display. PID exclusion keeps it out of the captured
      // pixels. Width fits the three-button row (Stop / Restart /
      // Cancel); height accommodates the "not visible in recording"
      // reassurance caption underneath.
      win.setIgnoreMouseEvents(false);
      win.setContentSize(420, 80, false);
      // Only the `recording` phase carries `displayId`; stopping/
      // processing arms fall back to the primary display via
      // anchorTopCenter. In practice these phases are very brief and
      // the pill stays anchored from the recording transition.
      const recordedDisplayId =
        state.phase === "recording" ? state.displayId : undefined;
      if (process.platform === "win32" && state.phase === "recording") {
        anchorAwayFromRecordedRect(win, state.rect, state.displayId);
      } else {
        anchorTopCenter(win, recordedDisplayId);
      }
      if (!win.isVisible()) {
        win.showInactive();
      } else {
        win.moveTop();
      }
      break;
    }
    case "idle":
    case "ready":
    case "failed": {
      disarmLeadInEscapeShortcut();
      if (window !== null && !window.isDestroyed()) {
        window.hide();
        // Destroying releases the renderer process; the next session
        // gets a fresh React tree with a clean state machine.
        window.destroy();
        window = null;
      }
      break;
    }
  }
  log.debug("recording controller transition", { phase: state.phase });
}

/**
 * Install a one-time hook so every `setRecordingState` call also
 * drives the HUD. Called from `main/index.ts` during boot — the
 * tray + library windows do not have to know the HUD exists.
 */
export function installRecordingController(): void {
  if (installed) return;
  installed = true;
  subscribeToRecordingState(applyRecordingStateToController);
}
