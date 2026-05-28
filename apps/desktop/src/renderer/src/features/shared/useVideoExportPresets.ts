// Per-(format, preset) state machine for the video 6-card grid.
// Each card owns its own ExportButtonState so clicking MED MP4
// doesn't disable LOW MP4 (concurrent encodes are allowed; the
// main-side ffmpeg pipeline handles them on separate processes,
// with an in-flight de-dup so duplicate (capture, format, preset)
// requests share one run).
//
// Three actions per card:
//   • triggerCopy     — encode + clipboard.writeBuffer(public.file-url)
//                       so paste drops the file in Slack/Mail/Finder
//   • triggerCopyPath — encode + clipboard.writeText(path) for
//                       terminal/editor paste
//   • triggerDrag     — start native drag AND kick a parallel
//                       `video:export` so the card surfaces
//                       `Encoding…` visible state during the
//                       (potentially long) ffmpeg run. The drag
//                       prepare and the visible-state encode share
//                       one ffmpeg run via the main-side in-flight
//                       de-dup, so it's not double work.
//
// The hook resets all 6 entries to idle when the captureId changes
// — a new video selection shouldn't inherit the prior capture's
// "Saved" / "Failed" badges. In-flight dispatches against the prior
// captureId are bailed via a captureId ref check at resolution time
// so a slow encode resolving after a navigation doesn't paint stale
// state onto the new capture's cards.

import { useCallback, useEffect, useReducer, useRef } from "react";
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
  /** Drag the FILE chip: starts native drag + surfaces
   *  `Encoding…` on the card via a parallel `video:export` so the
   *  user sees progress during the encode. The drag and the
   *  visible-state encode share one ffmpeg run via main-side
   *  in-flight de-dup. */
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

  // Track the current captureId in a ref so a `.then` callback fired
  // from a stale in-flight dispatch can bail before painting state
  // onto the new capture's cards. Plain closure-captured `captureId`
  // isn't enough because the *current* captureId at resolution time
  // may differ from what the dispatch was issued against — without
  // this guard, a slow encode for capture A resolving after the user
  // has navigated to capture B would mark B's GIF LOW card as
  // "Saved" with A's file path.
  const currentCaptureIdRef = useRef<string | null>(captureId);
  useEffect(() => {
    currentCaptureIdRef.current = captureId;
  }, [captureId]);

  const triggerCopy = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      dispatchAction({ kind: "set", key, state: { kind: "running" } });
      void dispatch("clipboard:copyVideoFile", {
        captureId: issuedFor,
        format,
        preset
      }).then((res) => {
        // Bail if the user navigated to a different capture mid-encode.
        if (currentCaptureIdRef.current !== issuedFor) return;
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
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      dispatchAction({ kind: "set", key, state: { kind: "running" } });
      void dispatch("clipboard:copyVideoPath", {
        captureId: issuedFor,
        format,
        preset
      }).then((res) => {
        if (currentCaptureIdRef.current !== issuedFor) return;
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
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      // Kick the native drag. Main does its own encode inside
      // `video:prepareDrag` (idempotent via main-side in-flight
      // de-dup with the `video:export` call below).
      startVideoDrag(issuedFor, format, preset);
      // Parallel `video:export` dispatch so the card surfaces an
      // `Encoding…` state while the encode runs. Without this the
      // drag handle "dies" silently during a slow encode with no
      // visible feedback. Both calls share one ffmpeg run on the
      // main side, so this is not double work.
      dispatchAction({ kind: "set", key, state: { kind: "running" } });
      void dispatch("video:export", {
        captureId: issuedFor,
        format,
        preset
      }).then((res) => {
        if (currentCaptureIdRef.current !== issuedFor) return;
        if (res.ok) {
          dispatchAction({ kind: "set", key, state: { kind: "done", path: res.value.path } });
        } else {
          dispatchAction({ kind: "set", key, state: { kind: "error", message: res.error.message } });
        }
      });
    },
    [captureId]
  );

  return { states, triggerCopy, triggerCopyPath, triggerDrag };
}
