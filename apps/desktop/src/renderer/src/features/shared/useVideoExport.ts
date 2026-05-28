// Shared state + dispatch logic for the GIF / MP4 export buttons that
// the float-over toast, the tray popover, and the library DetailRail
// all render against a video capture. Before this hook the three
// surfaces each owned an identical copy of:
//
//   • the `VideoExportState` discriminated union
//   • a `useState({ kind: "idle" })` + reset-on-capture-id `useEffect`
//   • the `dispatch("video:export", …)` call with the format/audio
//     payload + the running → done/error transition handling
//
// Keeping one source of truth means a fix to the export pipeline (a
// new payload field, a different audio default, an extra "queued"
// state) lands in one place instead of three. The presentational JSX
// is extracted separately to [VideoExportButtons.tsx] so a surface
// that needs a non-standard layout (custom labels, extra controls)
// can still reuse the state machine without taking the markup.

import { useCallback, useEffect, useState } from "react";
import { dispatch } from "../../lib/pwrsnap";

/** Discriminated-union state for a per-capture GIF / MP4 export. Same
 *  shape that lived in `FloatOver.tsx` as `FloatOverExportState` and
 *  in `TrayMenu.tsx` + `DetailRail.tsx` as a local `VideoExportState`
 *  — promoted here so all three import the same type. */
export type VideoExportState =
  | { kind: "idle" }
  | { kind: "running"; format: "gif" | "mp4" }
  | { kind: "done"; format: "gif" | "mp4"; path: string }
  | { kind: "error"; format: "gif" | "mp4"; message: string };

export type VideoExportInput = {
  readonly captureId: string;
  readonly hasSystemAudio: boolean;
  readonly hasMicrophoneAudio: boolean;
};

export type UseVideoExportResult = {
  readonly exportState: VideoExportState;
  /** Reset the state to idle. The hook also auto-resets when the
   *  input's `captureId` changes; callers with additional reset
   *  triggers (e.g. the float-over host's `show-idle` / `dismiss`
   *  event handlers) call this directly. */
  readonly reset: () => void;
  /** Kick off an export. Sets state to `running`, dispatches
   *  `video:export`, then transitions to `done` or `error` based on
   *  the Result envelope. A no-op when `input` is null (no record
   *  selected). */
  readonly triggerExport: (format: "gif" | "mp4") => void;
};

/**
 * Owns the video-export state machine for a single capture. Pass
 * `null` when no video record is active — the hook still runs (must
 * be called unconditionally per Rules of Hooks) but `triggerExport`
 * becomes a no-op and `exportState` stays idle.
 */
export function useVideoExport(input: VideoExportInput | null): UseVideoExportResult {
  const [exportState, setExportState] = useState<VideoExportState>({ kind: "idle" });

  // Auto-reset when the active capture changes. A new selection /
  // recording shouldn't inherit the previous capture's "Saved" or
  // "Failed" badge.
  const captureId = input?.captureId ?? null;
  useEffect(() => {
    setExportState({ kind: "idle" });
  }, [captureId]);

  const reset = useCallback(() => {
    setExportState({ kind: "idle" });
  }, []);

  const hasSystemAudio = input?.hasSystemAudio ?? false;
  const hasMicrophoneAudio = input?.hasMicrophoneAudio ?? false;
  const triggerExport = useCallback(
    (format: "gif" | "mp4") => {
      if (captureId === null) return;
      setExportState({ kind: "running", format });
      void dispatch("video:export", {
        captureId,
        format,
        audio:
          format === "gif"
            ? { includeSystemAudio: false, includeMicrophone: false }
            : {
                includeSystemAudio: hasSystemAudio,
                includeMicrophone: hasMicrophoneAudio
              }
      }).then((res) => {
        if (res.ok) {
          setExportState({ kind: "done", format, path: res.value.path });
        } else {
          setExportState({ kind: "error", format, message: res.error.message });
        }
      });
    },
    [captureId, hasSystemAudio, hasMicrophoneAudio]
  );

  return { exportState, reset, triggerExport };
}
