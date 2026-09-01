import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from "electron";
import {
  EVENT_CHANNELS,
  IPC_PRE_CAPTURE_HUD_READY,
  IPC_PRE_CAPTURE_HUD_RESIZE,
  type PreCaptureHudIntent,
  type PreCaptureHudState
} from "@pwrsnap/shared";
import { getMainLogger } from "./log";
import { createPreCaptureHudWindow } from "./window";

const log = getMainLogger("pwrsnap:pre-capture-hud");
const HUD_WIDTH = 400;
const HUD_HEIGHT_MIN = 64;
const HUD_HEIGHT_MAX = 180;
const BLOCKED_VISIBLE_MS = 2_600;
const PARK_COORDINATE = -20_000;

type ActiveRun = {
  runId: number;
  displayId: number;
  presenting: boolean;
  terminal: boolean;
};

export type PreCaptureHudSession = Readonly<{
  runId: number;
  showPreparing: () => void;
  showPermission: () => void;
  showStorage: () => void;
  showCountdown: (secondsRemaining: number) => void;
  showSelectorHandoff: () => void;
  selectorPresented: () => void;
  block: (reason: "permission" | "storage" | "unexpected") => void;
  finish: () => void;
}>;

let singleton: BrowserWindow | null = null;
let active: ActiveRun | null = null;
let latestState: PreCaptureHudState | null = null;
let nextRunId = 1;
let rendererReady = false;
let everShown = false;
let ipcWired = false;
let disposing = false;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let terminalTimer: ReturnType<typeof setTimeout> | null = null;

function clearShowTimer(): void {
  if (showTimer === null) return;
  clearTimeout(showTimer);
  showTimer = null;
}

function clearTerminalTimer(): void {
  if (terminalTimer === null) return;
  clearTimeout(terminalTimer);
  terminalTimer = null;
}

function activeWindowForEvent(event: IpcMainEvent): BrowserWindow | null {
  if (singleton === null || singleton.isDestroyed()) return null;
  return event.sender === singleton.webContents ? singleton : null;
}

function anchorTopCenter(window: BrowserWindow): void {
  const display =
    active === null
      ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      : screen.getAllDisplays().find((candidate) => candidate.id === active?.displayId) ??
        screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const [width] = window.getSize();
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + 16);
  window.setPosition(x, y, false);
}

function hideWindow(): void {
  clearShowTimer();
  if (singleton === null || singleton.isDestroyed()) return;
  singleton.setIgnoreMouseEvents(true);
  // Never leave a hidden/parked topmost window behind. On Windows a real
  // hide is required for transparent-window compositing; on macOS parking
  // avoids an inactive-panel focus cascade while still dropping topmost.
  singleton.setAlwaysOnTop(false);
  if (process.platform === "darwin" && everShown) {
    singleton.setOpacity(0);
    singleton.setPosition(PARK_COORDINATE, PARK_COORDINATE, false);
  } else {
    singleton.hide();
  }
}

function showWindowFor(runId: number): void {
  if (
    active?.runId !== runId ||
    !active.presenting ||
    latestState?.runId !== runId
  ) return;
  const window = getOrCreateWindow();
  if (!rendererReady || window.isDestroyed()) return;
  window.setIgnoreMouseEvents(true);
  anchorTopCenter(window);
  if (process.platform === "darwin") {
    window.setAlwaysOnTop(true, "floating");
    if (everShown) {
      window.setOpacity(1);
    } else {
      window.showInactive();
      everShown = true;
    }
  } else {
    // Real show/hide and plain always-on-top preserve per-pixel alpha on
    // Windows. showInactive is explicitly non-activating.
    window.setAlwaysOnTop(true);
    window.showInactive();
    everShown = true;
  }
  if (!window.webContents.isDestroyed()) window.webContents.invalidate();
}

function scheduleShow(runId: number): void {
  clearShowTimer();
  showTimer = setTimeout(() => {
    showTimer = null;
    showWindowFor(runId);
  }, 0);
}

function publish(state: PreCaptureHudState): void {
  latestState = state;
  const window = getOrCreateWindow();
  if (rendererReady && !window.webContents.isDestroyed()) {
    window.webContents.send(EVENT_CHANNELS.preCaptureHudState, state);
    scheduleShow(state.runId);
  }
  log.debug("pre-capture HUD state", {
    runId: state.runId,
    intent: state.intent,
    phase: state.phase
  });
}

function onRendererReady(event: IpcMainEvent): void {
  const window = activeWindowForEvent(event);
  if (window === null) return;
  rendererReady = true;
  if (latestState !== null && !window.webContents.isDestroyed()) {
    window.webContents.send(EVENT_CHANNELS.preCaptureHudState, latestState);
    scheduleShow(latestState.runId);
  }
}

function onRendererResize(event: IpcMainEvent, payload: unknown): void {
  const window = activeWindowForEvent(event);
  if (window === null || payload === null || typeof payload !== "object") return;
  const heightCss = (payload as { height?: unknown }).height;
  if (typeof heightCss !== "number" || !Number.isFinite(heightCss)) return;
  const heightDip = Math.ceil(heightCss * window.webContents.zoomFactor);
  const height = Math.max(HUD_HEIGHT_MIN, Math.min(HUD_HEIGHT_MAX, heightDip));
  if (window.getContentSize()[1] === height) return;
  window.setContentSize(HUD_WIDTH, height, false);
  if (active?.presenting && latestState !== null) anchorTopCenter(window);
}

function wireIpc(): void {
  if (ipcWired) return;
  ipcWired = true;
  ipcMain.on(IPC_PRE_CAPTURE_HUD_READY, onRendererReady);
  ipcMain.on(IPC_PRE_CAPTURE_HUD_RESIZE, onRendererResize);
}

function recreateForActiveRun(): void {
  if (disposing || active === null || !active.presenting || latestState === null) return;
  const state = latestState;
  const window = getOrCreateWindow();
  if (rendererReady && !window.webContents.isDestroyed()) {
    window.webContents.send(EVENT_CHANNELS.preCaptureHudState, state);
    scheduleShow(state.runId);
  }
}

function getOrCreateWindow(): BrowserWindow {
  if (singleton !== null && !singleton.isDestroyed()) return singleton;
  wireIpc();
  const window = createPreCaptureHudWindow();
  singleton = window;
  rendererReady = false;
  everShown = false;
  window.on("closed", () => {
    if (singleton !== window) return;
    singleton = null;
    rendererReady = false;
    everShown = false;
    queueMicrotask(recreateForActiveRun);
  });
  window.on("unresponsive", () => {
    if (singleton !== window || window.isDestroyed() || disposing) return;
    log.warn("pre-capture HUD became unresponsive; recreating active status window");
    window.destroy();
  });
  window.webContents.on("render-process-gone", () => {
    if (singleton !== window || window.isDestroyed() || disposing) return;
    log.warn("pre-capture HUD renderer exited; recreating active status window");
    window.destroy();
  });
  return window;
}

function updateForRun(runId: number, state: PreCaptureHudState): void {
  if (active?.runId !== runId || active.terminal) return;
  publish(state);
}

/** Prewarm the sandboxed renderer without making it visible or topmost. */
export function preWarmPreCaptureHud(): void {
  if (disposing) return;
  getOrCreateWindow();
}

/**
 * Begin one human-initiated pre-capture presentation. The run token stays
 * owned until the selector returns even though the HUD hides once the
 * selector confirms presentation, so
 * a concurrent image/video trigger cannot replace or dismiss the active UI.
 * The shared interactive-capture session remains the authoritative selector
 * owner; this generation-bound token protects only this window.
 */
export function beginPreCaptureHud(intent: PreCaptureHudIntent): PreCaptureHudSession | null {
  if (disposing) return null;
  if (active !== null && !active.terminal) return null;
  if (active?.terminal) {
    clearTerminalTimer();
    hideWindow();
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const runId = nextRunId++;
  active = { runId, displayId: display.id, presenting: true, terminal: false };
  publish({ runId, intent, phase: "preparing" });

  return {
    runId,
    showPreparing: () => updateForRun(runId, { runId, intent, phase: "preparing" }),
    showPermission: () => updateForRun(runId, { runId, intent, phase: "permission" }),
    showStorage: () => updateForRun(runId, { runId, intent, phase: "storage" }),
    showCountdown: (secondsRemaining) => {
      if (!Number.isFinite(secondsRemaining)) return;
      updateForRun(runId, {
        runId,
        intent,
        phase: "countdown",
        secondsRemaining: Math.max(1, Math.floor(secondsRemaining))
      });
    },
    showSelectorHandoff: () => {
      updateForRun(runId, { runId, intent, phase: "selector-handoff" });
    },
    selectorPresented: () => {
      // Called only by pickRegion's generation-validated presentation
      // callback. Keep the run token reserved until finish(), but relinquish
      // the visual/topmost surface exactly when the selector owns it.
      if (active?.runId === runId && !active.terminal) {
        active.presenting = false;
        hideWindow();
      }
    },
    block: (reason) => {
      if (active?.runId !== runId || active.terminal) return;
      active.terminal = true;
      active.presenting = true;
      publish({ runId, intent, phase: "blocked", reason });
      clearTerminalTimer();
      terminalTimer = setTimeout(() => {
        terminalTimer = null;
        if (active?.runId !== runId || !active.terminal) return;
        hideWindow();
        latestState = null;
        active = null;
      }, BLOCKED_VISIBLE_MS);
    },
    finish: () => {
      if (active?.runId !== runId || active.terminal) return;
      if (active.presenting) hideWindow();
      latestState = null;
      active = null;
    }
  };
}

export function disposePreCaptureHud(): void {
  disposing = true;
  clearShowTimer();
  clearTerminalTimer();
  active = null;
  latestState = null;
  if (ipcWired) {
    ipcMain.removeListener(IPC_PRE_CAPTURE_HUD_READY, onRendererReady);
    ipcMain.removeListener(IPC_PRE_CAPTURE_HUD_RESIZE, onRendererResize);
    ipcWired = false;
  }
  if (singleton !== null && !singleton.isDestroyed()) {
    singleton.setAlwaysOnTop(false);
    singleton.destroy();
  }
  singleton = null;
  rendererReady = false;
  everShown = false;
}

/** Test-only lifecycle snapshot; no BrowserWindow escapes this module. */
export function getPreCaptureHudSnapshot(): Readonly<{
  runId: number | null;
  terminal: boolean;
  phase: PreCaptureHudState["phase"] | null;
}> {
  return {
    runId: active?.runId ?? null,
    terminal: active?.terminal ?? false,
    phase: latestState?.phase ?? null
  };
}
