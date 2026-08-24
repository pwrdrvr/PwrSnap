// Recording lifecycle broadcaster. Owns the single source of truth for
// "is PwrSnap currently recording, and what phase is it in" and pushes
// every transition over EVENT_CHANNELS.recordingState to every live
// BrowserWindow.
//
// One active session per process. The recording service rejects
// concurrent starts; the tray and float-over both observe phase changes
// without polling.

import { BrowserWindow } from "electron";
import {
  EVENT_CHANNELS,
  type RecordingFailureCode,
  type RecordingState
} from "@pwrsnap/shared";
import { getMainLogger } from "../log";

const log = getMainLogger("pwrsnap:recording-state");

let state: RecordingState = { phase: "idle" };

type Subscriber = (next: RecordingState) => void;
const mainSubscribers = new Set<Subscriber>();

/** Main-only fan-out for modules (recording-controller HUD, tray
 *  Recording row) that need to react to phase changes without
 *  spinning up a renderer subscriber. The `events:recording:state`
 *  broadcast still fires for every BrowserWindow regardless. */
export function subscribeToRecordingState(handler: Subscriber): () => void {
  mainSubscribers.add(handler);
  // Emit the current state on subscribe so late subscribers don't
  // miss an already-in-flight session.
  handler(state);
  return () => {
    mainSubscribers.delete(handler);
  };
}

/** Snapshot read. Renderers that mount mid-flight (Library window
 *  opened after the recording started) call `recording:state` once
 *  to get this before the next broadcast. */
export function getRecordingState(): RecordingState {
  return state;
}

/** Source-of-truth setter + broadcaster. Always pair these — never
 *  mutate `state` directly from outside this module. */
export function setRecordingState(next: RecordingState): void {
  state = next;
  log.info("recording state", { phase: next.phase });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(EVENT_CHANNELS.recordingState, next);
  }
  // Main-side fan-out — tray + recording-controller HUD react here
  // without needing their own BrowserWindow to receive the IPC
  // broadcast.
  for (const subscriber of mainSubscribers) {
    try {
      subscriber(next);
    } catch (cause) {
      log.warn("recording-state subscriber threw", {
        phase: next.phase,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
}

/**
 * Publish a renderer-safe terminal failure. Callers log raw backend detail
 * separately; this event intentionally contains no arbitrary error string.
 */
export function setRecordingFailureState(input: {
  sessionId: string;
  code: RecordingFailureCode;
  displayId: number;
  canRetry: boolean;
}): void {
  setRecordingState({ phase: "failed", ...input });
}

/** Convenience predicate — true when a native recording session is
 * mid-flight. The permission phase is deliberately excluded: no helper,
 * temp directory, or session exists yet, and the tray must not claim
 * "Recording — Stop" while it is only asking the user for a decision. */
export function isRecordingActive(): boolean {
  switch (state.phase) {
    case "preflight":
    case "countdown":
    case "starting":
    case "recording":
    case "stopping":
    case "processing":
      return true;
    case "permission":
    case "idle":
    case "ready":
    case "failed":
      return false;
  }
}
