// Per-(format, preset) state machine for the video 6-card grid.
// Each card owns its own ExportButtonState so clicking MED MP4
// doesn't disable LOW MP4 (concurrent encodes are allowed; the
// main-side ffmpeg pipeline handles them on separate processes,
// with an in-flight de-dup so duplicate (capture, format, preset)
// requests share one run).
//
// Three actions per card:
//   • triggerCopy     — encode + place the exported media file on
//                       the platform clipboard
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
// captureId / range (and superseded requests for the same card) are
// bailed at resolution time so a slow encode resolving after a
// navigation or trim change doesn't paint stale state onto the cards.

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { VideoPreset, VideoRange } from "@pwrsnap/shared";
import { dispatch, startVideoDrag } from "../../lib/pwrsnap";
import { videoPresetKey, type VideoPresetKey } from "./useVideoPresetMetrics";

export type VideoExportAction = "copy" | "path" | "drag";

/** Per-button state, keyed by (format, preset). The action tag is
 *  intentionally retained through completion: the card uses it to
 *  distinguish a successful clipboard-media copy from a path copy or
 *  drag preparation, all of which share one state cell. */
export type ExportButtonState =
  | { kind: "idle" }
  | { kind: "running"; action: VideoExportAction }
  | { kind: "done"; action: VideoExportAction; path: string }
  | { kind: "error"; action: VideoExportAction; message: string };

export type VideoExportPresetsState = Partial<Record<VideoPresetKey, ExportButtonState>>;

export type VideoExportPresetsInput = {
  readonly captureId: string;
  /** Trim range to export. Callers pass the persisted `defaultRange`
   *  they are displaying (DetailRail eyebrow / float-over mini-trim)
   *  so what the user sees is what encodes. Omitted → main falls back
   *  to the record's `defaultRange` (same value; explicit is clearer). */
  readonly range?: VideoRange | undefined;
};

export type UseVideoExportPresetsResult = {
  /** Map of `(format, preset)` → current button state. Missing
   *  entries are implicitly `{ kind: "idle" }`; the renderer
   *  treats them identically. */
  readonly states: VideoExportPresetsState;
  /** Click-the-card: encode + copy file to clipboard. */
  readonly triggerCopy: (format: "gif" | "mp4", preset: VideoPreset) => void;
  /** Click the FILE chip: encode + copy the platform-native path. */
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

function bridgeRejectionMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  if (typeof cause === "string" && cause.trim().length > 0) return cause;
  return "The PwrSnap export service did not respond.";
}

export function useVideoExportPresets(
  input: VideoExportPresetsInput | null
): UseVideoExportPresetsResult {
  const [states, dispatchAction] = useReducer(reducer, {});

  // Reset when capture changes — a new selection shouldn't inherit
  // the prior capture's per-cell "Saved" / "Failed" badges.
  const captureId = input?.captureId ?? null;
  const rangeStart = input?.range?.start;
  const rangeEnd = input?.range?.end;
  const rangeKey =
    rangeStart === undefined || rangeEnd === undefined ? null : `${rangeStart}|${rangeEnd}`;
  const requestScopeKey = `${captureId ?? "<none>"}\0${rangeKey ?? "<default>"}`;
  useEffect(() => {
    dispatchAction({ kind: "reset" });
  }, [captureId, rangeKey]);
  // Stable range object keyed on its values so the callbacks below
  // don't churn on every parent render.
  const range = useMemo<VideoRange | undefined>(
    () =>
      rangeStart === undefined || rangeEnd === undefined
        ? undefined
        : { start: rangeStart, end: rangeEnd },
    [rangeStart, rangeEnd]
  );

  // Track both the visible capture/range scope and the latest request
  // issued for each card. The scope ref updates in a layout effect so
  // even a completion racing the trim commit is rejected, without
  // mutating committed refs during a speculative render. The per-card
  // sequence prevents an older action from overwriting a newer
  // copy/path/drag action on the same cell.
  const currentRequestScopeRef = useRef(requestScopeKey);
  useLayoutEffect(() => {
    currentRequestScopeRef.current = requestScopeKey;
  }, [requestScopeKey]);
  const nextRequestIdRef = useRef(0);
  const latestRequestByKeyRef = useRef<Partial<Record<VideoPresetKey, number>>>({});

  const triggerCopy = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      const action = "copy" as const;
      const issuedScope = requestScopeKey;
      const requestId = ++nextRequestIdRef.current;
      latestRequestByKeyRef.current[key] = requestId;
      dispatchAction({ kind: "set", key, state: { kind: "running", action } });
      void dispatch("clipboard:copyVideoFile", {
        captureId: issuedFor,
        format,
        preset,
        range
      }).then((res) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        if (res.ok) {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "done", action, path: res.value.path }
          });
        } else {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "error", action, message: res.error.message }
          });
        }
      }).catch((cause: unknown) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        dispatchAction({
          kind: "set",
          key,
          state: { kind: "error", action, message: bridgeRejectionMessage(cause) }
        });
      });
    },
    [captureId, range, requestScopeKey]
  );

  const triggerCopyPath = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      const action = "path" as const;
      const issuedScope = requestScopeKey;
      const requestId = ++nextRequestIdRef.current;
      latestRequestByKeyRef.current[key] = requestId;
      dispatchAction({ kind: "set", key, state: { kind: "running", action } });
      void dispatch("clipboard:copyVideoPath", {
        captureId: issuedFor,
        format,
        preset,
        range
      }).then((res) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        if (res.ok) {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "done", action, path: res.value.path }
          });
        } else {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "error", action, message: res.error.message }
          });
        }
      }).catch((cause: unknown) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        dispatchAction({
          kind: "set",
          key,
          state: { kind: "error", action, message: bridgeRejectionMessage(cause) }
        });
      });
    },
    [captureId, range, requestScopeKey]
  );

  const triggerDrag = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      if (captureId === null) return;
      const issuedFor = captureId;
      const key = videoPresetKey(format, preset);
      const action = "drag" as const;
      const issuedScope = requestScopeKey;
      const requestId = ++nextRequestIdRef.current;
      latestRequestByKeyRef.current[key] = requestId;
      // Kick the native drag. Main does its own encode inside
      // `video:prepareDrag` (idempotent via main-side in-flight
      // de-dup with the `video:export` call below).
      startVideoDrag(issuedFor, format, preset, range);
      // Parallel `video:export` dispatch so the card surfaces an
      // `Encoding…` state while the encode runs. Without this the
      // drag handle "dies" silently during a slow encode with no
      // visible feedback. Both calls share one ffmpeg run on the
      // main side, so this is not double work.
      dispatchAction({ kind: "set", key, state: { kind: "running", action } });
      void dispatch("video:export", {
        captureId: issuedFor,
        format,
        preset,
        range
      }).then((res) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        if (res.ok) {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "done", action, path: res.value.path }
          });
        } else {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "error", action, message: res.error.message }
          });
        }
      }).catch((cause: unknown) => {
        if (
          currentRequestScopeRef.current !== issuedScope ||
          latestRequestByKeyRef.current[key] !== requestId
        ) return;
        dispatchAction({
          kind: "set",
          key,
          state: { kind: "error", action, message: bridgeRejectionMessage(cause) }
        });
      });
    },
    [captureId, range, requestScopeKey]
  );

  return { states, triggerCopy, triggerCopyPath, triggerDrag };
}
