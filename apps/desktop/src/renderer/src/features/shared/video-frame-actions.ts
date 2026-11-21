// "Copy Frame" / "Save Frame as Snap" for the Library's video stage.
//
// Two surfaces offer them: the stage's right-click menu and the FRAME row
// of the DetailRail's export panel. Only the stage knows where the playhead
// is, and the rail is a different subtree, so the stage registers a reader
// here and the rail asks it. The reader returns the element's LIVE
// `currentTime` — the head React holds is throttled during playback, and a
// copy should take the frame under the head at the moment of the click.
//
// The result of the last action is published here too, so whichever
// surface did not start it (the stage's status pill when the rail's button
// was clicked, and vice versa) can say what happened. A toast in the
// Library's lower-left stack would not do: Focus mode renders the stage in
// a modal <dialog>, which sits above that stack.

import { useSyncExternalStore } from "react";
import { dispatch } from "../../lib/pwrsnap";

type Listener = () => void;

type FramePositionEntry = {
  /** Discrete head: changes on seek / pause / capture switch. Drives labels. */
  timeSec: number;
  /** The live head, read at the moment of an action. */
  read: () => number;
};

export type VideoFrameActionKind = "copy" | "save" | "copyTime";

export type VideoFrameActionStatus = {
  seq: number;
  captureId: string;
  kind: VideoFrameActionKind;
  phase: "working" | "done" | "failed";
  timeSec: number;
  message: string;
};

const positions = new Map<string, FramePositionEntry>();
let status: VideoFrameActionStatus | null = null;
let statusSeq = 0;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the stage on mount. Returns the unregister. */
export function registerVideoFramePosition(
  captureId: string,
  read: () => number,
  initialSec = 0
): () => void {
  const entry: FramePositionEntry = { timeSec: initialSec, read };
  positions.set(captureId, entry);
  emit();
  return () => {
    if (positions.get(captureId) === entry) {
      positions.delete(captureId);
      emit();
    }
  };
}

/** The stage's discrete head moved. */
export function publishVideoFramePosition(captureId: string, timeSec: number): void {
  const entry = positions.get(captureId);
  if (entry === undefined || entry.timeSec === timeSec) return;
  entry.timeSec = timeSec;
  emit();
}

/** Discrete head of the stage showing `captureId`, or null when no stage is. */
export function useVideoFramePosition(captureId: string | null): number | null {
  return useSyncExternalStore(subscribe, () =>
    captureId === null ? null : positions.get(captureId)?.timeSec ?? null
  );
}

export function useVideoFrameActionStatus(): VideoFrameActionStatus | null {
  return useSyncExternalStore(subscribe, () => status);
}

function setStatus(next: Omit<VideoFrameActionStatus, "seq">, seq: number): void {
  status = { ...next, seq };
  emit();
}

/** `0:02.700` — a frame is a millisecond, so say all three digits. */
export function formatFrameTime(sec: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms - minutes * 60_000) / 1000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/** The head to act on: live when a stage shows this capture, else `fallback`. */
function actionTime(captureId: string, fallback?: number): number | null {
  const entry = positions.get(captureId);
  if (entry !== undefined) return entry.read();
  return fallback ?? null;
}

export async function runVideoFrameAction(
  captureId: string,
  kind: VideoFrameActionKind,
  atSec?: number
): Promise<void> {
  const t = actionTime(captureId, atSec);
  if (t === null) return;
  const seq = ++statusSeq;
  const label = formatFrameTime(t);
  if (kind === "copyTime") {
    const result = await dispatch("clipboard:copyText", { text: label });
    setStatus(
      {
        captureId,
        kind,
        phase: result.ok ? "done" : "failed",
        timeSec: t,
        message: result.ok ? `Copied ${label}` : `Couldn’t copy the time — ${result.error.message}`
      },
      seq
    );
    return;
  }
  setStatus(
    {
      captureId,
      kind,
      phase: "working",
      timeSec: t,
      message: kind === "copy" ? `Copying frame ${label}…` : `Saving frame ${label}…`
    },
    seq
  );
  if (kind === "copy") {
    const result = await dispatch("clipboard:copyVideoFrame", { captureId, timeSec: t });
    if (seq !== statusSeq) return;
    setStatus(
      result.ok
        ? {
            captureId,
            kind,
            phase: "done",
            timeSec: result.value.timeSec,
            message: `Frame ${formatFrameTime(result.value.timeSec)} copied · ${result.value.widthPx} × ${result.value.heightPx}`
          }
        : { captureId, kind, phase: "failed", timeSec: t, message: `Couldn’t copy the frame — ${result.error.message}` },
      seq
    );
    return;
  }
  const result = await dispatch("video:saveFrameAsSnap", { captureId, timeSec: t });
  if (seq !== statusSeq) return;
  setStatus(
    result.ok
      ? {
          captureId,
          kind,
          phase: "done",
          timeSec: result.value.timeSec,
          message: `Frame ${formatFrameTime(result.value.timeSec)} saved as a snap`
        }
      : { captureId, kind, phase: "failed", timeSec: t, message: `Couldn’t save the frame — ${result.error.message}` },
    seq
  );
}

/** Clear a finished status (the pill's timeout). A newer action wins. */
export function clearVideoFrameActionStatus(seq: number): void {
  if (status?.seq !== seq) return;
  status = null;
  emit();
}

/** Observe status changes outside React (tests). */
export function subscribeForTests(onStatus: (s: VideoFrameActionStatus | null) => void): () => void {
  return subscribe(() => onStatus(status));
}

export function __resetVideoFrameActionsForTests(): void {
  positions.clear();
  status = null;
  statusSeq = 0;
  listeners.clear();
}
