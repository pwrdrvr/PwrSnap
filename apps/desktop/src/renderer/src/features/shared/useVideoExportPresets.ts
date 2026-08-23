// Run-scoped state for the shared GIF / MP4 preset grid. Float-Over,
// Tray, Library, and Detail Rail all mount this hook, so progress behavior
// stays consistent across every video export surface.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { EVENT_CHANNELS } from "@pwrsnap/shared";
import type {
  VideoExportProgressEvent,
  VideoExportProgressPhase,
  VideoPreset,
  VideoRange
} from "@pwrsnap/shared";
import { dispatch, startVideoDrag, subscribe } from "../../lib/pwrsnap";
import { videoPresetKey, type VideoPresetKey } from "./useVideoPresetMetrics";

export type ExportButtonState =
  | { kind: "idle" }
  | {
      kind: "running";
      runId: string;
      phase: VideoExportProgressPhase;
      ratio: number | null;
    }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string };

export type VideoExportPresetsState = Partial<Record<VideoPresetKey, ExportButtonState>>;

export type VideoExportPresetsInput = {
  readonly captureId: string;
  readonly range?: VideoRange | undefined;
};

export type UseVideoExportPresetsResult = {
  readonly states: VideoExportPresetsState;
  readonly triggerCopy: (format: "gif" | "mp4", preset: VideoPreset) => void;
  readonly triggerCopyPath: (format: "gif" | "mp4", preset: VideoPreset) => void;
  readonly triggerDrag: (format: "gif" | "mp4", preset: VideoPreset) => void;
};

type Action =
  | { kind: "reset" }
  | { kind: "clear"; key: VideoPresetKey }
  | { kind: "set"; key: VideoPresetKey; state: ExportButtonState };

type ActiveRun = {
  runId: string;
  captureId: string;
  format: "gif" | "mp4";
  preset: VideoPreset;
};

function reducer(state: VideoExportPresetsState, action: Action): VideoExportPresetsState {
  if (action.kind === "reset") return {};
  if (action.kind === "clear") {
    const next = { ...state };
    delete next[action.key];
    return next;
  }
  return { ...state, [action.key]: action.state };
}

function progressEvent(payload: unknown): VideoExportProgressEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const event = payload as Partial<VideoExportProgressEvent>;
  if (
    typeof event.runId !== "string" ||
    typeof event.captureId !== "string" ||
    (event.format !== "gif" && event.format !== "mp4") ||
    (event.preset !== "low" && event.preset !== "med" && event.preset !== "high") ||
    (event.phase !== "queued" &&
      event.phase !== "palette" &&
      event.phase !== "encoding" &&
      event.phase !== "finalizing" &&
      event.phase !== "done") ||
    (event.ratio !== null &&
      (typeof event.ratio !== "number" || !Number.isFinite(event.ratio)))
  ) {
    return null;
  }
  if (event.phase === "done") {
    const terminal = payload as Record<string, unknown>;
    if (
      (terminal["outcome"] !== "succeeded" &&
        terminal["outcome"] !== "failed" &&
        terminal["outcome"] !== "cancelled") ||
      (terminal["outcome"] === "succeeded" && terminal["ratio"] !== 1) ||
      (terminal["outcome"] !== "succeeded" && terminal["ratio"] !== null)
    ) {
      return null;
    }
    if (terminal["outcome"] === "failed") {
      const error = terminal["error"];
      if (
        typeof error !== "object" ||
        error === null ||
        typeof (error as Record<string, unknown>)["code"] !== "string" ||
        typeof (error as Record<string, unknown>)["message"] !== "string"
      ) {
        return null;
      }
    }
  }
  return event as VideoExportProgressEvent;
}

function newRunId(): string {
  return globalThis.crypto.randomUUID();
}

function rejectedDispatchMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Export command failed";
}

export function useVideoExportPresets(
  input: VideoExportPresetsInput | null
): UseVideoExportPresetsResult {
  const [states, dispatchAction] = useReducer(reducer, {});
  const activeRunsRef = useRef(new Map<VideoPresetKey, ActiveRun>());

  const captureId = input?.captureId ?? null;
  const rangeStart = input?.range?.start;
  const rangeEnd = input?.range?.end;
  const rangeKey =
    rangeStart === undefined || rangeEnd === undefined ? null : `${rangeStart}|${rangeEnd}`;
  const range = useMemo<VideoRange | undefined>(
    () =>
      rangeStart === undefined || rangeEnd === undefined
        ? undefined
        : { start: rangeStart, end: rangeEnd },
    [rangeStart, rangeEnd]
  );

  const isActive = useCallback((key: VideoPresetKey, run: ActiveRun): boolean => {
    return activeRunsRef.current.get(key)?.runId === run.runId;
  }, []);

  const cancelRun = useCallback((runId: string): void => {
    void dispatch("video:cancelExport", { runId }).catch(() => undefined);
  }, []);

  const finishWithError = useCallback(
    (key: VideoPresetKey, run: ActiveRun, message: string): void => {
      if (!isActive(key, run)) return;
      activeRunsRef.current.delete(key);
      dispatchAction({ kind: "set", key, state: { kind: "error", message } });
    },
    [isActive]
  );

  const finishWithCommandError = useCallback(
    (
      key: VideoPresetKey,
      run: ActiveRun,
      error: { code: string; message: string }
    ): void => {
      if (!isActive(key, run)) return;
      activeRunsRef.current.delete(key);
      dispatchAction(
        error.code === "video_export_cancelled"
          ? { kind: "clear", key }
          : { kind: "set", key, state: { kind: "error", message: error.message } }
      );
    },
    [isActive]
  );

  const startRun = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset): ActiveRun | null => {
      if (captureId === null) return null;
      const key = videoPresetKey(format, preset);
      const prior = activeRunsRef.current.get(key);
      if (prior !== undefined) cancelRun(prior.runId);
      const run = { runId: newRunId(), captureId, format, preset } satisfies ActiveRun;
      activeRunsRef.current.set(key, run);
      dispatchAction({
        kind: "set",
        key,
        state: { kind: "running", runId: run.runId, phase: "queued", ratio: null }
      });
      return run;
    },
    [cancelRun, captureId]
  );

  useEffect(() => {
    return subscribe(EVENT_CHANNELS.renderProgress, (payload) => {
      const event = progressEvent(payload);
      if (event === null) return;
      const key = videoPresetKey(event.format, event.preset);
      const run = activeRunsRef.current.get(key);
      if (
        run === undefined ||
        run.runId !== event.runId ||
        run.captureId !== event.captureId ||
        run.format !== event.format ||
        run.preset !== event.preset
      ) {
        return;
      }

      if (event.phase !== "done") {
        dispatchAction({
          kind: "set",
          key,
          state: {
            kind: "running",
            runId: run.runId,
            phase: event.phase,
            ratio:
              event.ratio === null ? null : Math.max(0, Math.min(0.99, event.ratio))
          }
        });
        return;
      }

      if (event.outcome === "failed") {
        activeRunsRef.current.delete(key);
        dispatchAction({
          kind: "set",
          key,
          state: { kind: "error", message: event.error.message }
        });
      } else if (event.outcome === "cancelled") {
        activeRunsRef.current.delete(key);
        dispatchAction({ kind: "clear", key });
      } else {
        // The encode is complete, but copy-file/copy-path may still be
        // finalizing. Clear the percentage until that command resolves.
        dispatchAction({
          kind: "set",
          key,
          state: {
            kind: "running",
            runId: run.runId,
            phase: "finalizing",
            ratio: null
          }
        });
      }
    });
  }, []);

  // A trim/capture change or component teardown invalidates every visible
  // attempt. Cancel each run and clear the map before any late result lands.
  useEffect(() => {
    dispatchAction({ kind: "reset" });
    return () => {
      for (const run of activeRunsRef.current.values()) cancelRun(run.runId);
      activeRunsRef.current.clear();
    };
  }, [cancelRun, captureId, rangeKey]);

  const exportThenCopy = useCallback(
    (
      command: "clipboard:copyVideoFile" | "clipboard:copyVideoPath",
      format: "gif" | "mp4",
      preset: VideoPreset
    ): void => {
      const run = startRun(format, preset);
      if (run === null) return;
      const key = videoPresetKey(format, preset);
      void (async () => {
        let exported: Awaited<ReturnType<typeof dispatch<"video:export">>>;
        try {
          exported = await dispatch("video:export", {
            captureId: run.captureId,
            format,
            preset,
            range,
            runId: run.runId
          });
        } catch (cause) {
          finishWithError(key, run, rejectedDispatchMessage(cause));
          return;
        }
        if (!isActive(key, run)) return;
        if (!exported.ok) {
          finishWithCommandError(key, run, exported.error);
          return;
        }

        let copied: Awaited<ReturnType<typeof dispatch<typeof command>>>;
        try {
          copied = await dispatch(command, {
            captureId: run.captureId,
            format,
            preset,
            range
          });
        } catch (cause) {
          finishWithError(key, run, rejectedDispatchMessage(cause));
          return;
        }
        if (!isActive(key, run)) return;
        activeRunsRef.current.delete(key);
        if (copied.ok) {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "done", path: copied.value.path }
          });
        } else {
          dispatchAction({
            kind: "set",
            key,
            state: { kind: "error", message: copied.error.message }
          });
        }
      })();
    },
    [finishWithCommandError, finishWithError, isActive, range, startRun]
  );

  const triggerCopy = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      exportThenCopy("clipboard:copyVideoFile", format, preset);
    },
    [exportThenCopy]
  );

  const triggerCopyPath = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      exportThenCopy("clipboard:copyVideoPath", format, preset);
    },
    [exportThenCopy]
  );

  const triggerDrag = useCallback(
    (format: "gif" | "mp4", preset: VideoPreset) => {
      const run = startRun(format, preset);
      if (run === null) return;
      const key = videoPresetKey(format, preset);
      // Encode through the run-scoped command first. Once it succeeds the
      // native drag preparation is an instant cache hit, so a dismissed or
      // destroyed renderer cannot leave an unowned FFmpeg consumer running.
      void dispatch("video:export", {
        captureId: run.captureId,
        format,
        preset,
        range,
        runId: run.runId
      })
        .then((result) => {
          if (!isActive(key, run)) return;
          if (result.ok) {
            try {
              startVideoDrag(run.captureId, format, preset, range);
            } catch (cause) {
              finishWithError(key, run, rejectedDispatchMessage(cause));
              return;
            }
            activeRunsRef.current.delete(key);
            dispatchAction({
              kind: "set",
              key,
              state: { kind: "done", path: result.value.path }
            });
          } else {
            finishWithCommandError(key, run, result.error);
          }
        })
        .catch((cause: unknown) => {
          finishWithError(key, run, rejectedDispatchMessage(cause));
        });
    },
    [finishWithCommandError, finishWithError, isActive, range, startRun]
  );

  return { states, triggerCopy, triggerCopyPath, triggerDrag };
}
