// Per-(format, preset) state machine for the video 6-card grid.
// Each card owns its own ExportButtonState so clicking MED MP4
// doesn't disable LOW MP4 (concurrent encodes are allowed; the
// main-side ffmpeg pipeline handles them on separate processes).
//
// Three actions per card:
//   • triggerCopy   — encode + clipboard.writeBuffer(public.file-url)
//                     so paste drops the file in Slack/Mail/Finder
//   • triggerCopyPath — encode + clipboard.writeText(path) for
//                       terminal/editor paste
//   • triggerDrag   — fire-and-forget IPC; main encodes, generates
//                     the poster, and calls webContents.startDrag
//
// The hook resets all 6 entries to idle when the captureId changes
// — a new video selection shouldn't inherit the prior capture's
// "Saved" / "Failed" badges.

import { useCallback, useEffect, useReducer } from "react";
import type { VideoPreset } from "@pwrsnap/shared";
import { dispatch, startVideoDrag } from "../../lib/pwrsnap";
import { videoPresetKey, type VideoPresetKey } from "./useVideoPresetMetrics";

/** Per-button state. Distinct from the legacy `VideoExportState`
 *  (which is keyed by format only and used by the tray + float-
 *  over's 2-card UI) because this hook keys by (format, preset). */
export type ExportButtonState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

export type VideoExportPresetsState = Partial<Record<VideoPresetKey, ExportButtonState>>;

export type VideoExportPresetsInput = {
  readonly captureId: string;
};

export type UseVideoExportPresetsResult = {
  /** Map of `(format, preset)` → current button state. Missing
   *  entries are implicitly `{ kind: "idle" }`; the renderer
   *  treats them identically. */
  readonly states: VideoExportPresetsState;
  /** Click-the-card: encode + copy file to clipboard. */
  readonly triggerCopy: (format: "gif" | "mp4", preset: VideoPreset) => void;
  /** Click the FILE chip: encode + copy POSIX path. */
  readonly triggerCopyPath: (format: "gif" | "mp4", preset: VideoPreset) => void;
  /** Drag the FILE chip: fire-and-forget native drag. The hook
   *  doesn't track state for drags — main does the encode + drag
   *  in one IPC round-trip and the renderer never knows if the
   *  drop actually landed. */
  readonly triggerDrag: (format: "gif" | "mp4", preset: VideoPreset) => void;
};

type Action =
  | { kind: "reset" }
  | { kind: "set"; key: VideoPresetKey; state: ExportButtonState };

function reducer(state: VideoExportPresetsState, action: Action): VideoExportPresetsState {
  if (action.kind === "reset") return {};
  return { ...state, [action.key]: action.state };
}

export function useVideoExportPresets(
  input: VideoExportPresetsInput | null
): UseVideoExportPresetsResult {
  const [states, dispatchAction] = useReducer(reducer, {});

  // Reset when capture changes. Same shape as `useVideoExport`'s
  // auto-reset effect.
  const captureId = input?.captureId ?? null;
  useEffect(() => {
    dispatchAction({ kind: "reset" });
  }, [captureId]);

  const triggerCopy = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const key = videoPresetKey(format, preset);
      dispatchAction({ kind: "set", key, state: { kind: "running" } });
      void dispatch("clipboard:copyVideoFile", { captureId, format, preset }).then((res) => {
        if (res.ok) {
          dispatchAction({ kind: "set", key, state: { kind: "done", path: res.value.path } });
        } else {
          dispatchAction({ kind: "set", key, state: { kind: "error", message: res.error.message } });
        }
      });
    },
    [captureId]
  );

  const triggerCopyPath = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const key = videoPresetKey(format, preset);
      dispatchAction({ kind: "set", key, state: { kind: "running" } });
      void dispatch("clipboard:copyVideoPath", { captureId, format, preset }).then((res) => {
        if (res.ok) {
          dispatchAction({ kind: "set", key, state: { kind: "done", path: res.value.path } });
        } else {
          dispatchAction({ kind: "set", key, state: { kind: "error", message: res.error.message } });
        }
      });
    },
    [captureId]
  );

  const triggerDrag = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      // No state transition — `startVideoDrag` is fire-and-forget.
      // If the encode is slow the OS shows the drag affordance
      // immediately; the drop fails silently if main couldn't
      // prepare in time. Same UX as the image equivalent.
      startVideoDrag(captureId, format, preset);
    },
    [captureId]
  );

  return { states, triggerCopy, triggerCopyPath, triggerDrag };
}
