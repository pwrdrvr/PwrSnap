// Owns the lifecycle of the floating recording-controller HUD
// window. Listens to recording-state transitions and:
//
//   • Creates + shows the window when state leaves `idle`.
//   • Anchors it at the top-center of the active display.
//   • Keeps failures visible until Retry or Dismiss, and destroys on
//     `idle` / `ready` or app shutdown.
//
// The window itself is wired in `window.ts`; the React side lives in
// `apps/desktop/src/renderer/src/features/recording/RecordingController.tsx`
// and binds to `events:recording:state` directly for its visuals.
// This module is the BrowserWindow-side glue.

import {
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  type IpcMainEvent
} from "electron";
import {
  EVENT_CHANNELS,
  recordingFailureSummary,
  type RecordingControllerArmEvent,
  type RecordingState
} from "@pwrsnap/shared";
import {
  appWindowsOverlappingRect,
  displayLocalRectToGlobal
} from "../capture/rect-overlap";
import { bus } from "../command-bus";
import { hotkeyRecorderSuspension } from "../hotkeys/hotkey-recorder-suspension-instance";
import { getMainLogger } from "../log";
import { createRecordingControllerWindow } from "../window";
import { getRecordingState, subscribeToRecordingState } from "./recording-state";

const log = getMainLogger("pwrsnap:recording-controller");
const RECORDING_CONTROLLER_RESIZE_CHANNEL = "recording-controller:resize";
const FAILED_WIDTH_DIP = 480;
const FAILED_INITIAL_HEIGHT_CSS = 176;
const FAILED_RECREATE_DELAYS_MS = [100, 500] as const;
const RECORDING_CONTROLLER_WIDTH_MIN_CSS_PX = 320;
const RECORDING_CONTROLLER_WIDTH_MAX_CSS_PX = 560;
const RECORDING_CONTROLLER_HEIGHT_MIN_CSS_PX = 64;
const RECORDING_CONTROLLER_HEIGHT_MAX_CSS_PX = 260;

let window: BrowserWindow | null = null;
let installed = false;
let escapeShortcutArmed = false;
let escapeShortcutDesired = false;
let escapeShortcutSuspended = false;
let unsubscribe: (() => void) | null = null;
let disposing = false;
let replacingFailedWindow = false;
let failedWindowRecreateTimer: ReturnType<typeof setTimeout> | null = null;
let failedSessionId: string | null = null;
let failedWindowCrashCount = 0;
let failedRendererDisabledSessionId: string | null = null;
let failedFallbackInFlight = false;
let resizeChannelWired = false;
let closeCancelPending = false;
let normalWindowRecreateTimer: ReturnType<typeof setTimeout> | null = null;
let lastRecordingDisplayId: number | null = null;

function clearFailedWindowRecreateTimer(): void {
  if (failedWindowRecreateTimer === null) return;
  clearTimeout(failedWindowRecreateTimer);
  failedWindowRecreateTimer = null;
}

function clearNormalWindowRecreateTimer(): void {
  if (normalWindowRecreateTimer === null) return;
  clearTimeout(normalWindowRecreateTimer);
  normalWindowRecreateTimer = null;
}

function resetFailedWindowRecovery(): void {
  failedSessionId = null;
  failedWindowCrashCount = 0;
  failedRendererDisabledSessionId = null;
}

function trackFailedSession(sessionId: string): void {
  if (failedSessionId === sessionId) return;
  failedSessionId = sessionId;
  failedWindowCrashCount = 0;
  failedRendererDisabledSessionId = null;
  clearFailedWindowRecreateTimer();
}

function destroyFailedWindow(crashedWindow: BrowserWindow): void {
  replacingFailedWindow = true;
  try {
    if (window === crashedWindow) window = null;
    if (!crashedWindow.isDestroyed()) crashedWindow.destroy();
  } finally {
    replacingFailedWindow = false;
  }
}

async function showFailedWindowFallback(
  failure: Extract<RecordingState, { phase: "failed" }>
): Promise<void> {
  if (disposing || failedFallbackInFlight) return;
  failedFallbackInFlight = true;
  let fallbackDialogFailed = false;
  try {
    while (!disposing) {
      const live = getRecordingState();
      if (live.phase !== "failed" || live.sessionId !== failure.sessionId) return;
      const { response } = await dialog.showMessageBox({
        type: "error",
        title: "Recording failed",
        message: recordingFailureSummary(live.code),
        detail:
          "The recording controls could not be displayed. Reveal the log file for details or dismiss this failure.",
        buttons: ["Reveal Log File", "Dismiss"],
        defaultId: 1,
        cancelId: 1,
        noLink: true
      });
      if (disposing) return;
      const stillLive = getRecordingState();
      if (stillLive.phase !== "failed" || stillLive.sessionId !== failure.sessionId) return;
      if (response === 0) {
        await bus.dispatch("renderer:revealLogFile", {}, { principal: "ipc" });
        continue;
      }
      const dismissed = await bus.dispatch(
        "recording:dismissFailure",
        { sessionId: failure.sessionId },
        { principal: "ipc" }
      );
      if (dismissed.ok) {
        failedRendererDisabledSessionId = null;
        return;
      }
    }
  } catch (cause) {
    fallbackDialogFailed = true;
    log.error("recording failure native fallback failed", {
      sessionId: failure.sessionId,
      message: cause instanceof Error ? cause.message : String(cause)
    });
  } finally {
    failedFallbackInFlight = false;
    const live = getRecordingState();
    if (
      !fallbackDialogFailed &&
      !disposing &&
      live.phase === "failed" &&
      live.sessionId !== failure.sessionId &&
      failedRendererDisabledSessionId === live.sessionId
    ) {
      void showFailedWindowFallback(live);
    }
  }
}

function scheduleFailedWindowRecreate(crashedWindow: BrowserWindow): void {
  const liveState = getRecordingState();
  if (disposing || window !== crashedWindow || liveState.phase !== "failed") return;
  trackFailedSession(liveState.sessionId);
  failedWindowCrashCount += 1;
  destroyFailedWindow(crashedWindow);
  clearFailedWindowRecreateTimer();
  const delay = FAILED_RECREATE_DELAYS_MS[failedWindowCrashCount - 1];
  if (delay === undefined) {
    failedRendererDisabledSessionId = liveState.sessionId;
    log.error("recording failure HUD renderer repeatedly crashed", {
      sessionId: liveState.sessionId,
      crashCount: failedWindowCrashCount
    });
    void showFailedWindowFallback(liveState);
    return;
  }
  failedWindowRecreateTimer = setTimeout(() => {
    failedWindowRecreateTimer = null;
    if (disposing) return;
    const current = getRecordingState();
    if (
      current.phase === "failed" &&
      current.sessionId === liveState.sessionId &&
      failedRendererDisabledSessionId !== current.sessionId
    ) {
      applyRecordingStateToController(current);
    }
  }, delay);
}

/** Retry budget for a crashing non-failure HUD renderer, per session. */
const NORMAL_RECREATE_MAX_ATTEMPTS = 3;
let normalRecreateAttempts = 0;
let normalRecreateSessionId: string | null = null;

function ensureWindow(): BrowserWindow {
  if (window !== null && !window.isDestroyed()) return window;
  window = createRecordingControllerWindow();
  const createdWindow = window;
  window.on("close", (event) => {
    if (disposing || replacingFailedWindow) return;
    const state = getRecordingState();
    if (state.phase === "idle" || state.phase === "ready") return;
    event.preventDefault();
    if (state.phase === "failed") {
      window?.show();
      window?.focus();
      return;
    }
    if (
      state.phase === "preflight" ||
      state.phase === "countdown" ||
      state.phase === "starting"
    ) {
      if (closeCancelPending) return;
      closeCancelPending = true;
      void bus
        .dispatch("recording:cancel", {}, { principal: "ipc" })
        .finally(() => {
          closeCancelPending = false;
        });
    }
    // Recording close cannot bypass the renderer's two-click destructive
    // Cancel confirmation. Stopping/processing must finish persistence.
  });
  window.on("closed", () => {
    if (window === createdWindow) window = null;
  });
  window.webContents.on("render-process-gone", () => {
    const state = getRecordingState();
    if (state.phase === "failed") {
      scheduleFailedWindowRecreate(createdWindow);
      return;
    }
    if (disposing || window !== createdWindow || !isControllerPhase(state)) return;
    if (window === createdWindow) window = null;
    if (!createdWindow.isDestroyed()) createdWindow.destroy();
    clearNormalWindowRecreateTimer();
    // Cap the retries, the way the `failed` path does. A deterministic
    // crash — GPU process loss, OOM, a throw during module init — made this
    // an unbounded loop: destroy, wait 100 ms, respawn, crash, repeat, at
    // roughly ten renderer launches a second for the whole take, competing
    // for CPU with the recorder the HUD is annotating, and logging nothing.
    // The recording itself is owned by the recorder process and survives a
    // missing HUD, so giving up on the overlay is the safe end state.
    const sessionId = "sessionId" in state ? state.sessionId : null;
    if (sessionId !== normalRecreateSessionId) {
      normalRecreateSessionId = sessionId;
      normalRecreateAttempts = 0;
    }
    normalRecreateAttempts += 1;
    if (normalRecreateAttempts > NORMAL_RECREATE_MAX_ATTEMPTS) {
      log.error("recording controller renderer crashed repeatedly; leaving it down", {
        attempts: normalRecreateAttempts,
        phase: state.phase
      });
      return;
    }
    normalWindowRecreateTimer = setTimeout(() => {
      normalWindowRecreateTimer = null;
      if (disposing) return;
      const live = getRecordingState();
      if (isControllerPhase(live)) applyRecordingStateToController(live);
    }, 100);
  });
  return window;
}

function isControllerPhase(
  state: RecordingState
): state is Exclude<RecordingState, { phase: "idle" | "ready" | "failed" }> {
  return state.phase !== "idle" && state.phase !== "ready" && state.phase !== "failed";
}

function resizeFailedWindow(
  win: BrowserWindow,
  heightCss: number,
  displayId: number
): void {
  const zoom = Number.isFinite(win.webContents.zoomFactor) && win.webContents.zoomFactor > 0
    ? win.webContents.zoomFactor
    : 1;
  const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId) ??
    screen.getPrimaryDisplay();
  const maxWidth = Math.max(320, display.workArea.width - 32);
  const maxHeight = Math.max(120, display.workArea.height - 32);
  const widthDip = Math.min(maxWidth, FAILED_WIDTH_DIP);
  const heightDip = Math.min(maxHeight, Math.max(120, Math.ceil(heightCss * zoom)));
  const [currentWidth, currentHeight] = win.getContentSize();
  if (currentWidth !== widthDip || currentHeight !== heightDip) {
    win.setMinimumSize(0, 0);
    win.setContentSize(widthDip, heightDip, false);
  }
  anchorTopCenter(win, displayId);
}

function onRecordingControllerResize(event: IpcMainEvent, payload: unknown): void {
  if (window === null || window.isDestroyed() || event.sender !== window.webContents) return;
  const state = getRecordingState();
  if (payload === null || typeof payload !== "object") return;
  const { width, height } = payload as { width?: unknown; height?: unknown };
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) {
    return;
  }
  if (state.phase === "failed") {
    resizeFailedWindow(window, height, state.displayId);
    return;
  }
  if (
    (state.phase !== "recording" && state.phase !== "stopping" && state.phase !== "processing") ||
    typeof width !== "number" ||
    !Number.isFinite(width) ||
    width <= 0
  ) {
    return;
  }
  const [contentWidth, contentHeight] = normalControllerContentSize(
    window,
    width,
    height,
    state.phase === "recording" ? state.displayId : lastRecordingDisplayId ?? undefined
  );
  window.setMinimumSize(0, 0);
  window.setContentSize(contentWidth, contentHeight, false);
  if (state.phase === "recording") {
    if (process.platform === "win32") {
      anchorAwayFromRecordedRect(window, state.rect, state.displayId);
    } else {
      anchorTopCenter(window, state.displayId);
    }
  }
}

function wireRecordingControllerResizeChannel(): void {
  if (resizeChannelWired) return;
  resizeChannelWired = true;
  ipcMain.on(RECORDING_CONTROLLER_RESIZE_CHANNEL, onRecordingControllerResize);
}

function unwireRecordingControllerResizeChannel(): void {
  if (!resizeChannelWired) return;
  ipcMain.removeListener(RECORDING_CONTROLLER_RESIZE_CHANNEL, onRecordingControllerResize);
  resizeChannelWired = false;
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
  if (rect.w <= 0 || rect.h <= 0) {
    anchorTopCenter(win, displayId);
    return;
  }

  const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay();
  const [w, h] = win.getSize();
  const workArea = display.workArea;
  const globalRect = displayLocalRectToGlobal(rect, displayId) ?? rect;
  const recorded = {
    x: globalRect.x,
    y: globalRect.y,
    width: globalRect.w,
    height: globalRect.h
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
 * `rect` is in DISPLAY-LOCAL logical pixels — relative to
 * `displayId`'s own top-left. `setPosition` + `setContentSize` both
 * take logical px in the GLOBAL virtual coord space, so we add
 * `display.bounds.{x,y}` to translate.
 *
 * NOT the selector's convention — `SelectorResult.rect` is global, so
 * one handed here would apply the origin twice. What arrives is
 * `state.rect`, already converted down by `subjectToPhysicalRect`.
 * See the coordinate-space note at the head of
 * capture/rect-overlap.ts.
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
  const global = displayLocalRectToGlobal(rect, displayId) ?? rect;
  win.setPosition(Math.round(global.x), Math.round(global.y), false);
}

function registerDesiredLeadInEscapeShortcut(): void {
  if (
    !escapeShortcutDesired ||
    escapeShortcutSuspended ||
    escapeShortcutArmed
  ) {
    return;
  }
  // The lead-in HUD is focusable:false and shown inactive, so a
  // renderer keydown listener would miss Esc in the common case.
  try {
    const registered = globalShortcut.register("Escape", () => {
      if (escapeShortcutSuspended || !escapeShortcutDesired) return;
      void bus.dispatch("recording:cancel", {}, { principal: "ipc" });
    });
    if (!registered) {
      log.warn("recording lead-in Escape shortcut unavailable");
      return;
    }
    escapeShortcutArmed = true;
  } catch (cause) {
    log.warn("recording lead-in Escape shortcut registration threw", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
}

function releaseOwnedLeadInEscapeShortcut(): void {
  if (!escapeShortcutArmed) return;
  try {
    globalShortcut.unregister("Escape");
  } catch (cause) {
    log.warn("recording lead-in Escape shortcut unregister threw", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  escapeShortcutArmed = false;
}

/** Convert measured CSS pixels to BrowserWindow DIPs. Clamp the content
 * measurement in CSS space first so the ceiling scales with page zoom, then
 * cap the converted window against the target display work area. */
function normalControllerContentSize(
  win: BrowserWindow,
  requestedWidthCss: number,
  requestedHeightCss: number,
  displayId?: number
): [number, number] {
  const zoomFactor = win.webContents.zoomFactor;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const target =
    (displayId !== undefined
      ? screen.getAllDisplays().find((display) => display.id === displayId)
      : undefined) ?? screen.getPrimaryDisplay();
  const availableWidth = Math.max(1, target.workArea.width - 32);
  const availableHeight = Math.max(1, target.workArea.height - 32);
  const widthCss = Math.min(
    RECORDING_CONTROLLER_WIDTH_MAX_CSS_PX,
    Math.max(RECORDING_CONTROLLER_WIDTH_MIN_CSS_PX, Math.ceil(requestedWidthCss))
  );
  const heightCss = Math.min(
    RECORDING_CONTROLLER_HEIGHT_MAX_CSS_PX,
    Math.max(RECORDING_CONTROLLER_HEIGHT_MIN_CSS_PX, Math.ceil(requestedHeightCss))
  );
  return [
    Math.min(availableWidth, Math.ceil(widthCss * zoom)),
    Math.min(availableHeight, Math.ceil(heightCss * zoom))
  ];
}

function armLeadInEscapeShortcut(): void {
  escapeShortcutDesired = true;
  registerDesiredLeadInEscapeShortcut();
}

function disarmLeadInEscapeShortcut(): void {
  escapeShortcutDesired = false;
  releaseOwnedLeadInEscapeShortcut();
}

hotkeyRecorderSuspension.registerParticipant({
  id: "recording-controller-escape",
  suspend(): void {
    escapeShortcutSuspended = true;
    releaseOwnedLeadInEscapeShortcut();
  },
  restore(): void {
    escapeShortcutSuspended = false;
    registerDesiredLeadInEscapeShortcut();
  }
});

/**
 * Is there a live HUD renderer that can host a destructive-action
 * confirmation right now?
 *
 * The tray asks before offering "Restart Recording…" / "Cancel
 * Recording…", because the HUD is the only surface allowed to run that
 * confirm (see `RecordingControllerArmEvent`). When the HUD renderer
 * has crashed past its retry budget the answer is no, and the tray
 * simply does not offer the destructive items — "Stop and Save" stays
 * available, so a user with a dead HUD can always end the take and
 * keep the clip. Losing a take needs a confirmation surface; keeping
 * one does not.
 */
export function canRecordingControllerConfirmDiscard(): boolean {
  if (window === null || window.isDestroyed()) return false;
  return getRecordingState().phase === "recording";
}

/**
 * Ask the HUD to arm its own two-press confirm for `action`, exactly
 * as if the user had clicked that button on the HUD. Returns false if
 * there was no HUD to ask, in which case nothing was armed and nothing
 * was dispatched.
 *
 * Deliberately one-way: the HUD owns the armed state and its
 * auto-disarm timeout, and the HUD is what ultimately dispatches
 * `recording:restart` / `recording:cancel`. Main holds no parallel
 * armed state that could disagree with what the user can see.
 */
export function requestRecordingDiscardConfirmation(
  action: RecordingControllerArmEvent["action"]
): boolean {
  if (!canRecordingControllerConfirmDiscard()) {
    log.warn("no recording HUD available to confirm a discard", { action });
    return false;
  }
  const target = window;
  if (target === null) return false;
  target.webContents.send(EVENT_CHANNELS.recordingControllerArm, {
    action
  } satisfies RecordingControllerArmEvent);
  // The HUD is alwaysOnTop + floating, but a take can run for minutes
  // with other floating windows arriving; make sure the surface the
  // user was just sent to is actually the one on top.
  target.moveTop();
  return true;
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
      win.setFocusable(false);
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
    case "recording": {
      const win = ensureWindow();
      lastRecordingDisplayId = state.displayId;
      disarmLeadInEscapeShortcut();
      // Recording-phase pill is compact; tuck it top-center of the
      // recorded display. `setContentProtection(true)` (set once in
      // createRecordingControllerWindow) keeps it out of the captured
      // pixels. Width fits the three-button row (Stop / Restart /
      // Cancel); height accommodates the "not visible in recording"
      // reassurance caption underneath.
      //
      // ⚠️  NEVER setFocusable(true) here. The window is constructed
      // `focusable: false` and shown with showInactive() precisely so
      // that clicking Stop / Restart / Cancel cannot activate PwrSnap
      // mid-take. Only the HUD window is content-protected — the
      // CONSEQUENCES of activating are not. On macOS the menu bar
      // switches to PwrSnap, the recorded app's title bar goes
      // inactive and its text caret disappears, and every one of those
      // is inside the recorded rect and therefore in the file: the
      // first frames after a Restart arm-click become a recording of
      // the user's app losing focus. A focusable HUD shipped briefly
      // in #496 to let a renderer keydown handler see Escape; the
      // lead-in's globalShortcut bridge above exists because that
      // trade is not available to this window.
      win.setFocusable(false);
      win.setIgnoreMouseEvents(false);
      const [width, height] = normalControllerContentSize(win, 420, 80, state.displayId);
      win.setMinimumSize(0, 0);
      win.setContentSize(width, height, false);
      if (process.platform === "win32") {
        anchorAwayFromRecordedRect(win, state.rect, state.displayId);
      } else {
        anchorTopCenter(win, state.displayId);
      }
      if (!win.isVisible()) {
        win.showInactive();
      } else {
        win.moveTop();
      }
      break;
    }
    case "stopping":
    case "processing": {
      const win = ensureWindow();
      disarmLeadInEscapeShortcut();
      win.setFocusable(false);
      win.setIgnoreMouseEvents(false);
      const [width, height] = normalControllerContentSize(
        win,
        420,
        80,
        lastRecordingDisplayId ?? undefined
      );
      win.setMinimumSize(0, 0);
      win.setContentSize(width, height, false);
      // Preserve the recording-phase position. On Windows the HUD may be
      // outside the captured rect; moving it while FFmpeg is still exiting
      // can paint it into the final frames.
      if (!win.isVisible()) win.showInactive();
      else win.moveTop();
      break;
    }
    case "failed": {
      trackFailedSession(state.sessionId);
      if (failedRendererDisabledSessionId === state.sessionId) {
        disarmLeadInEscapeShortcut();
        void showFailedWindowFallback(state);
        break;
      }
      const win = ensureWindow();
      disarmLeadInEscapeShortcut();
      win.setIgnoreMouseEvents(false);
      win.setFocusable(true);
      resizeFailedWindow(win, FAILED_INITIAL_HEIGHT_CSS, state.displayId);
      win.show();
      win.focus();
      win.moveTop();
      break;
    }
    case "idle":
    case "ready": {
      clearFailedWindowRecreateTimer();
      clearNormalWindowRecreateTimer();
      resetFailedWindowRecovery();
      disarmLeadInEscapeShortcut();
      lastRecordingDisplayId = null;
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
  wireRecordingControllerResizeChannel();
  unsubscribe = subscribeToRecordingState(applyRecordingStateToController);
}

export function disposeRecordingController(): void {
  unsubscribe?.();
  unsubscribe = null;
  installed = false;
  unwireRecordingControllerResizeChannel();
  clearFailedWindowRecreateTimer();
  clearNormalWindowRecreateTimer();
  lastRecordingDisplayId = null;
  resetFailedWindowRecovery();
  disarmLeadInEscapeShortcut();
  disposing = true;
  try {
    if (window !== null && !window.isDestroyed()) window.destroy();
    window = null;
  } finally {
    disposing = false;
  }
}
