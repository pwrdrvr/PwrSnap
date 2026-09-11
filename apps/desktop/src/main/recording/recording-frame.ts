// Lifecycle for the recording-frame overlay — the tangerine rectangle
// drawn around the recorded rect while a video capture runs.
//
// Why it is not part of recording-controller.ts: the HUD is one window
// that changes shape per phase (leader → pill → failure card), is
// interactive during `recording`, and deliberately anchors AWAY from the
// rect on Windows. The frame is the opposite of all three — one shape,
// never interactive, and pinned TO the rect. Sharing a window would mean
// one of them losing the property that makes it work.
//
// Both windows are content-protected, so neither appears in the file.

import { BrowserWindow, screen } from "electron";
import { EVENT_CHANNELS, type RecordingFrameLayout, type RecordingState } from "@pwrsnap/shared";
import { getMainLogger } from "../log";
import { getDesktopSettingsStore } from "../settings/desktop-settings-store";
import { createRecordingFrameWindow } from "../window";
import {
  planRecordingFrame,
  recordingFramePhaseFor,
  type RecordingFramePlan
} from "./recording-frame-geometry";
import { subscribeToRecordingState } from "./recording-state";

const log = getMainLogger("pwrsnap:recording-frame");

let installed = false;
let unsubscribe: (() => void) | null = null;

let window: BrowserWindow | null = null;
/** Set once the renderer has loaded; until then sends would be dropped. */
let rendererReady = false;
/** Last layout we computed, replayed on renderer load. */
let layout: RecordingFrameLayout | null = null;
/** Bounds the window currently sits at, so a no-op transition is free. */
let placedAt: string | null = null;

/** Session the `enabled` verdict and `sessionPlan` below belong to. */
let verdictSessionId: string | null = null;
/** `false` once the user's `recording.showRegionFrame` says no. */
let enabled = true;
/**
 * The plan computed from this session's rect.
 *
 * `stopping` and `processing` carry NO rect — by then the recorder is
 * exiting and there is nothing left to describe. Without this the frame
 * would vanish the instant the user hit Stop, which reads as "it already
 * ended" while the encoder is still writing. The rect cannot change
 * inside a session, so replaying the stored plan is exact, not a guess.
 */
let sessionPlan: RecordingFramePlan | null = null;

/**
 * Transitions arrive synchronously from the recording-state broadcaster,
 * but the settings read is async. Serializing through one chain keeps a
 * slow read from letting `recording` overtake `preflight` — the failure
 * that would leave a frame on screen after the session ended.
 */
let queue: Promise<void> = Promise.resolve();

function destroyWindow(): void {
  if (window !== null && !window.isDestroyed()) {
    window.destroy();
  }
  window = null;
  rendererReady = false;
  layout = null;
  placedAt = null;
}

function sendLayout(): void {
  if (window === null || window.isDestroyed()) return;
  if (!rendererReady || layout === null) return;
  window.webContents.send(EVENT_CHANNELS.recordingFrame, layout);
}

function ensureWindow(plan: RecordingFramePlan): BrowserWindow {
  const key = `${plan.bounds.x},${plan.bounds.y},${plan.bounds.width},${plan.bounds.height}`;
  if (window === null || window.isDestroyed()) {
    window = createRecordingFrameWindow(plan.bounds);
    rendererReady = false;
    // Constructed AT these bounds, so record them as placed. Calling
    // setBounds here as well would be a redundant window-server round
    // trip on every session, and on macOS a setBounds during window
    // construction is exactly the kind of thing that fights the
    // implicit-minimum-size clamp documented in AGENTS.md.
    placedAt = key;
    const created = window;
    created.webContents.once("did-finish-load", () => {
      if (created.isDestroyed()) return;
      rendererReady = true;
      sendLayout();
    });
  } else if (placedAt !== key) {
    // Only reached when the recorded display changed resolution
    // mid-session and the plan moved with it.
    window.setBounds(plan.bounds, false);
    placedAt = key;
  }
  return window;
}

/**
 * Read `recording.showRegionFrame` once per session. A settings flip
 * mid-recording deliberately does not take effect: the overlay appearing
 * or vanishing part-way through a take is more startling than either
 * steady state, and the next capture picks up the new value.
 */
async function resolveEnabled(sessionId: string): Promise<boolean> {
  if (verdictSessionId === sessionId) return enabled;
  verdictSessionId = sessionId;
  // A new session invalidates the previous session's geometry — never
  // let a stale plan outlive the rect it described.
  sessionPlan = null;
  try {
    enabled = (await getDesktopSettingsStore().readDomain("recording")).showRegionFrame;
  } catch (cause) {
    // A settings read that fails must not cost the user the one thing
    // on screen that says a recording is running.
    enabled = true;
    log.warn("recording-frame settings read failed; showing the frame", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
  }
  return enabled;
}

function planForRect(
  rect: { x: number; y: number; w: number; h: number },
  displayId: number
): RecordingFramePlan | null {
  const display = screen.getAllDisplays().find((candidate) => candidate.id === displayId);
  if (display === undefined) {
    // The recorded display was unplugged mid-session. The recorder deals
    // with that on its own; we just stop drawing.
    return null;
  }
  return planRecordingFrame({ rect, display, platform: process.platform });
}

async function apply(state: RecordingState): Promise<void> {
  const phase = recordingFramePhaseFor(state.phase);
  if (phase === null || !("sessionId" in state)) {
    // idle / ready / failed. `failed` included on purpose: the HUD turns
    // into an actionable failure card, and a frame still hugging a rect
    // nothing is being written to would be a lie.
    destroyWindow();
    sessionPlan = null;
    return;
  }

  if (!(await resolveEnabled(state.sessionId))) {
    destroyWindow();
    return;
  }

  const plan =
    "rect" in state && "displayId" in state
      ? planForRect(state.rect, state.displayId)
      : // `stopping` / `processing` — no rect in the payload. Replay this
        // session's plan so the frame fades in place instead of blinking
        // out while the encoder is still writing.
        sessionPlan;

  if (plan === null) {
    // No legal place to draw — a full-display recording on Windows or
    // Linux, a rect too small to frame, or a display that went away.
    // Logged at debug because every one of those is an expected outcome,
    // not a failure.
    log.debug("recording-frame suppressed", { phase: state.phase, platform: process.platform });
    destroyWindow();
    return;
  }
  sessionPlan = plan;

  const win = ensureWindow(plan);
  layout = { inset: plan.inset, mode: plan.mode, phase };
  sendLayout();
  if (!win.isVisible()) {
    win.showInactive();
  } else {
    // Keep the frame above app windows the user raises mid-recording.
    // Same per-level moveTop the HUD does; it does not fight the
    // floating level, it just keeps us at the top of it.
    win.moveTop();
  }
}

/**
 * Install a subscriber so every recording transition also drives the
 * frame. Called from `main/index.ts` beside `installRecordingController`.
 */
export function installRecordingFrame(): void {
  if (installed) return;
  installed = true;
  unsubscribe = subscribeToRecordingState((next) => {
    queue = queue.catch(() => undefined).then(() => apply(next));
  });
}

export function disposeRecordingFrame(): void {
  unsubscribe?.();
  unsubscribe = null;
  installed = false;
  verdictSessionId = null;
  enabled = true;
  sessionPlan = null;
  queue = Promise.resolve();
  destroyWindow();
}

/** Test seam — the window id currently showing the frame, or null. */
export function getRecordingFrameWindowId(): number | null {
  return window !== null && !window.isDestroyed() ? window.id : null;
}
