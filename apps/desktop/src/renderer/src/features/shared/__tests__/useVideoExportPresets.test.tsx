import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EVENT_CHANNELS, type VideoExportProgressEvent } from "@pwrsnap/shared";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  useVideoExportPresets,
  type ExportButtonState,
  type VideoExportPresetsState
} from "../useVideoExportPresets";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

type PendingDispatch = {
  name: string;
  req: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type ProgressSubscriber = (payload: unknown) => void;

const pendingDispatches: PendingDispatch[] = [];
const progressSubscribers = new Set<ProgressSubscriber>();
const subscriptionSink: Array<{ channel: string; active: boolean }> = [];
const videoDragSink: Array<{
  captureId: string;
  format: string;
  preset: string;
  range?: unknown;
}> = [];
let videoDragError: Error | null = null;

(globalThis as unknown as { window: Window }).window =
  (globalThis as unknown as { window?: Window }).window ?? ({} as Window);
(globalThis as unknown as { window: { pwrsnapApi: unknown } }).window.pwrsnapApi = {
  dispatch: (name: string, req: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      pendingDispatches.push({ name, req, resolve, reject });
    }),
  on: (channel: string, handler: ProgressSubscriber): (() => void) => {
    const subscription = { channel, active: true };
    subscriptionSink.push(subscription);
    if (channel === EVENT_CHANNELS.renderProgress) progressSubscribers.add(handler);
    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      progressSubscribers.delete(handler);
    };
  },
  startCaptureDrag: () => undefined,
  startVideoDrag: (payload: {
    captureId: string;
    format: string;
    preset: string;
    range?: unknown;
  }) => {
    if (videoDragError !== null) throw videoDragError;
    videoDragSink.push(payload);
  }
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  pendingDispatches.length = 0;
  progressSubscribers.clear();
  subscriptionSink.length = 0;
  videoDragSink.length = 0;
  videoDragError = null;
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

function dispatchesNamed(name: string): PendingDispatch[] {
  return pendingDispatches.filter((pending) => pending.name === name);
}

function pendingNamed(
  name: string,
  predicate: (req: unknown) => boolean = () => true
): PendingDispatch {
  const pending = pendingDispatches.find(
    (candidate) => candidate.name === name && predicate(candidate.req)
  );
  if (pending === undefined) {
    throw new Error(
      `no pending ${name} dispatch; queued: ${pendingDispatches.map((item) => item.name).join(", ")}`
    );
  }
  return pending;
}

function removePending(pending: PendingDispatch): void {
  const index = pendingDispatches.indexOf(pending);
  if (index < 0) throw new Error(`pending ${pending.name} dispatch was already settled`);
  pendingDispatches.splice(index, 1);
}

async function resolvePending(pending: PendingDispatch, value: unknown): Promise<void> {
  removePending(pending);
  await act(async () => {
    pending.resolve(value);
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function rejectPending(pending: PendingDispatch, reason: unknown): Promise<void> {
  removePending(pending);
  await act(async () => {
    pending.reject(reason);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function emitProgress(event: VideoExportProgressEvent): void {
  act(() => {
    for (const subscriber of progressSubscribers) subscriber(event);
  });
}

function exportOk(path: string): unknown {
  return {
    ok: true,
    value: {
      path,
      byteSize: 1,
      durationSec: 1,
      widthPx: 640,
      heightPx: 360,
      fromCache: false
    }
  };
}

function commandError(
  message: string,
  code = "video_export_failed"
): unknown {
  return {
    ok: false,
    error: { kind: "render", code, message }
  };
}

type Snapshot = {
  states: VideoExportPresetsState;
  triggerCopy: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
  triggerCopyPath: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
  triggerDrag: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
};

type ProbeProps = {
  captureId: string | null;
  range?: { start: number; end: number } | undefined;
  onSnapshot: (snapshot: Snapshot) => void;
};

function Probe({ captureId, range, onSnapshot }: ProbeProps): null {
  const input = captureId === null ? null : { captureId, range };
  const result = useVideoExportPresets(input);
  useEffect(() => {
    onSnapshot({
      states: result.states,
      triggerCopy: result.triggerCopy,
      triggerCopyPath: result.triggerCopyPath,
      triggerDrag: result.triggerDrag
    });
  });
  return null;
}

type Harness = {
  snapshot: () => Snapshot;
  setCaptureId: (captureId: string | null) => void;
  setRange: (range: { start: number; end: number } | undefined) => void;
  unmount: () => void;
};

function mount(
  initialCaptureId: string | null = "cap_1",
  initialRange?: { start: number; end: number }
): Harness {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  let last: Snapshot | null = null;
  let captureId = initialCaptureId;
  let range = initialRange;

  const render = (): void => {
    act(() => {
      root!.render(
        createElement(Probe, {
          captureId,
          range,
          onSnapshot: (snapshot) => {
            last = snapshot;
          }
        })
      );
    });
  };

  render();

  return {
    snapshot: () => {
      if (last === null) throw new Error("snapshot before initial render");
      return last;
    },
    setCaptureId: (next) => {
      captureId = next;
      render();
    },
    setRange: (next) => {
      range = next;
      render();
    },
    unmount: () => {
      if (root === null) return;
      act(() => root!.unmount());
      root = null;
    }
  };
}

function runningState(
  snapshot: Snapshot,
  key: keyof VideoExportPresetsState
): Extract<ExportButtonState, { kind: "running" }> {
  const state = snapshot.states[key];
  if (state?.kind !== "running") {
    throw new Error(`expected ${key} to be running, got ${JSON.stringify(state)}`);
  }
  return state;
}

function runIdFromExport(format: "gif" | "mp4", preset: "low" | "med" | "high"): string {
  const pending = pendingNamed("video:export", (req) => {
    const request = req as { format?: unknown; preset?: unknown };
    return request.format === format && request.preset === preset;
  });
  const runId = (pending.req as { runId?: unknown }).runId;
  if (typeof runId !== "string") throw new Error("video:export request did not carry a runId");
  return runId;
}

describe("useVideoExportPresets", () => {
  test("subscribes to render progress and stays idle until triggered", () => {
    const harness = mount();

    expect(harness.snapshot().states).toEqual({});
    expect(subscriptionSink).toEqual([
      { channel: EVENT_CHANNELS.renderProgress, active: true }
    ]);
    expect(progressSubscribers.size).toBe(1);
  });

  test("copy preflights video:export with a runId before invoking the clipboard command", async () => {
    const range = { start: 3.4, end: 11.2 };
    const harness = mount("cap_1", range);

    act(() => harness.snapshot().triggerCopy("mp4", "med"));

    const runId = runIdFromExport("mp4", "med");
    expect(runningState(harness.snapshot(), "mp4-med")).toEqual({
      kind: "running",
      runId,
      phase: "queued",
      ratio: null
    });
    expect(pendingNamed("video:export").req).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "med",
      range,
      runId
    });
    expect(dispatchesNamed("clipboard:copyVideoFile")).toHaveLength(0);

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/export.mp4"));

    expect(pendingNamed("clipboard:copyVideoFile").req).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "med",
      range
    });
    await resolvePending(pendingNamed("clipboard:copyVideoFile"), {
      ok: true,
      value: { path: "/friendly/export.mp4" }
    });
    expect(harness.snapshot().states["mp4-med"]).toEqual({
      kind: "done",
      path: "/friendly/export.mp4"
    });
  });

  test("copy-path also waits for its run-scoped export preflight", async () => {
    const harness = mount("cap_1");

    act(() => harness.snapshot().triggerCopyPath("gif", "low"));
    const runId = runIdFromExport("gif", "low");
    expect((pendingNamed("video:export").req as { runId: string }).runId).toBe(runId);
    expect(dispatchesNamed("clipboard:copyVideoPath")).toHaveLength(0);

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/export.gif"));
    expect(pendingNamed("clipboard:copyVideoPath").req).toMatchObject({
      captureId: "cap_1",
      format: "gif",
      preset: "low"
    });
  });

  test("drag preflights its run-scoped export before starting the native gesture", async () => {
    const range = { start: 2, end: 8 };
    const harness = mount("cap_drag", range);

    act(() => harness.snapshot().triggerDrag("mp4", "high"));

    const runId = runIdFromExport("mp4", "high");
    expect(videoDragSink).toHaveLength(0);
    expect(pendingNamed("video:export").req).toEqual({
      captureId: "cap_drag",
      format: "mp4",
      preset: "high",
      range,
      runId
    });

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/drag.mp4"));
    expect(videoDragSink).toEqual([
      { captureId: "cap_drag", format: "mp4", preset: "high", range }
    ]);
    expect(harness.snapshot().states["mp4-high"]).toEqual({
      kind: "done",
      path: "/cache/drag.mp4"
    });
  });

  test("matching indeterminate and determinate events update only that active run", () => {
    const harness = mount("cap_progress");
    act(() => harness.snapshot().triggerCopy("gif", "high"));
    const runId = runIdFromExport("gif", "high");

    emitProgress({
      runId,
      captureId: "cap_progress",
      format: "gif",
      preset: "high",
      phase: "palette",
      ratio: null
    });
    expect(runningState(harness.snapshot(), "gif-high")).toEqual({
      kind: "running",
      runId,
      phase: "palette",
      ratio: null
    });

    emitProgress({
      runId,
      captureId: "cap_progress",
      format: "gif",
      preset: "high",
      phase: "encoding",
      ratio: 0.426
    });
    expect(runningState(harness.snapshot(), "gif-high")).toEqual({
      kind: "running",
      runId,
      phase: "encoding",
      ratio: 0.426
    });
  });

  test("events with a wrong run, capture, format, or preset are ignored", () => {
    const harness = mount("cap_expected");
    act(() => harness.snapshot().triggerCopy("mp4", "med"));
    const runId = runIdFromExport("mp4", "med");
    const expected = runningState(harness.snapshot(), "mp4-med");

    const wrongEvents: VideoExportProgressEvent[] = [
      {
        runId: "run_wrong",
        captureId: "cap_expected",
        format: "mp4",
        preset: "med",
        phase: "encoding",
        ratio: 0.1
      },
      {
        runId,
        captureId: "cap_wrong",
        format: "mp4",
        preset: "med",
        phase: "encoding",
        ratio: 0.2
      },
      {
        runId,
        captureId: "cap_expected",
        format: "gif",
        preset: "med",
        phase: "encoding",
        ratio: 0.3
      },
      {
        runId,
        captureId: "cap_expected",
        format: "mp4",
        preset: "high",
        phase: "encoding",
        ratio: 0.4
      }
    ];
    for (const event of wrongEvents) emitProgress(event);

    expect(runningState(harness.snapshot(), "mp4-med")).toEqual(expected);
    expect(harness.snapshot().states["gif-med"]).toBeUndefined();
    expect(harness.snapshot().states["mp4-high"]).toBeUndefined();
  });

  test("retrying the same cell cancels and rejects progress or resolution from the old run", async () => {
    const harness = mount("cap_retry");
    act(() => harness.snapshot().triggerCopy("mp4", "low"));
    const oldRunId = runIdFromExport("mp4", "low");

    act(() => harness.snapshot().triggerCopy("mp4", "low"));
    const newExport = dispatchesNamed("video:export").find(
      (pending) => (pending.req as { runId?: string }).runId !== oldRunId
    );
    if (newExport === undefined) throw new Error("new retry export was not dispatched");
    const newRunId = (newExport.req as { runId: string }).runId;
    expect(pendingNamed("video:cancelExport").req).toEqual({ runId: oldRunId });

    const oldExport = pendingNamed(
      "video:export",
      (req) => (req as { runId?: string }).runId === oldRunId
    );
    await resolvePending(oldExport, exportOk("/cache/old.mp4"));
    emitProgress({
      runId: oldRunId,
      captureId: "cap_retry",
      format: "mp4",
      preset: "low",
      phase: "done",
      ratio: null,
      outcome: "failed",
      error: { code: "old_failed", message: "old run failed" }
    });
    expect(runningState(harness.snapshot(), "mp4-low").runId).toBe(newRunId);
    expect(dispatchesNamed("clipboard:copyVideoFile")).toHaveLength(0);

    emitProgress({
      runId: newRunId,
      captureId: "cap_retry",
      format: "mp4",
      preset: "low",
      phase: "encoding",
      ratio: 0.61
    });
    expect(runningState(harness.snapshot(), "mp4-low")).toEqual({
      kind: "running",
      runId: newRunId,
      phase: "encoding",
      ratio: 0.61
    });
  });

  test("failed terminal events surface the error and ignore later command completion", async () => {
    const harness = mount("cap_failed");
    act(() => harness.snapshot().triggerDrag("gif", "med"));
    const runId = runIdFromExport("gif", "med");

    emitProgress({
      runId,
      captureId: "cap_failed",
      format: "gif",
      preset: "med",
      phase: "done",
      ratio: null,
      outcome: "failed",
      error: { code: "ffmpeg_failed", message: "Encoder exited 1" }
    });
    expect(harness.snapshot().states["gif-med"]).toEqual({
      kind: "error",
      message: "Encoder exited 1"
    });

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/late.gif"));
    expect(harness.snapshot().states["gif-med"]).toEqual({
      kind: "error",
      message: "Encoder exited 1"
    });
    expect(videoDragSink).toHaveLength(0);
  });

  test("cancelled terminal events clear the cell and ignore later command completion", async () => {
    const harness = mount("cap_cancelled");
    act(() => harness.snapshot().triggerDrag("mp4", "med"));
    const runId = runIdFromExport("mp4", "med");

    emitProgress({
      runId,
      captureId: "cap_cancelled",
      format: "mp4",
      preset: "med",
      phase: "done",
      ratio: null,
      outcome: "cancelled"
    });
    expect(harness.snapshot().states["mp4-med"]).toBeUndefined();

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/late.mp4"));
    expect(harness.snapshot().states["mp4-med"]).toBeUndefined();
    expect(videoDragSink).toHaveLength(0);
  });

  test("cancelled Results clear copy and drag runs when no terminal event arrives", async () => {
    const harness = mount("cap_cancel_result");
    act(() => {
      harness.snapshot().triggerCopy("gif", "low");
      harness.snapshot().triggerDrag("mp4", "high");
    });

    const cancellation = commandError(
      "Video export cancelled",
      "video_export_cancelled"
    );
    await resolvePending(
      pendingNamed(
        "video:export",
        (req) => (req as { format?: string }).format === "gif"
      ),
      cancellation
    );
    await resolvePending(
      pendingNamed(
        "video:export",
        (req) => (req as { format?: string }).format === "mp4"
      ),
      cancellation
    );

    expect(harness.snapshot().states["gif-low"]).toBeUndefined();
    expect(harness.snapshot().states["mp4-high"]).toBeUndefined();
    expect(dispatchesNamed("clipboard:copyVideoFile")).toHaveLength(0);
    expect(videoDragSink).toHaveLength(0);
  });

  test("error Results from export and clipboard dispatches clean up their runs", async () => {
    const harness = mount("cap_errors");

    act(() => harness.snapshot().triggerCopy("gif", "low"));
    await resolvePending(pendingNamed("video:export"), commandError("preflight failed"));
    expect(harness.snapshot().states["gif-low"]).toEqual({
      kind: "error",
      message: "preflight failed"
    });

    act(() => harness.snapshot().triggerCopyPath("mp4", "high"));
    await resolvePending(pendingNamed("video:export"), exportOk("/cache/path.mp4"));
    await resolvePending(
      pendingNamed("clipboard:copyVideoPath"),
      commandError("clipboard unavailable")
    );
    expect(harness.snapshot().states["mp4-high"]).toEqual({
      kind: "error",
      message: "clipboard unavailable"
    });
  });

  test("a rejected dispatch Promise leaves a retryable error instead of a stuck run", async () => {
    const harness = mount("cap_rejected");
    act(() => harness.snapshot().triggerCopy("mp4", "med"));

    await rejectPending(pendingNamed("video:export"), new Error("bridge disconnected"));

    expect(harness.snapshot().states["mp4-med"]).toEqual({
      kind: "error",
      message: "bridge disconnected"
    });
    expect(dispatchesNamed("clipboard:copyVideoFile")).toHaveLength(0);
  });

  test("a synchronous native drag send failure leaves a retryable error", async () => {
    const harness = mount("cap_drag_send");
    act(() => harness.snapshot().triggerDrag("gif", "med"));
    videoDragError = new Error("native drag unavailable");

    await resolvePending(pendingNamed("video:export"), exportOk("/cache/drag.gif"));

    expect(harness.snapshot().states["gif-med"]).toEqual({
      kind: "error",
      message: "native drag unavailable"
    });
    expect(videoDragSink).toHaveLength(0);
  });

  test.each([
    {
      label: "capture",
      change: (harness: Harness) => harness.setCaptureId("cap_b")
    },
    {
      label: "range",
      change: (harness: Harness) => harness.setRange({ start: 2, end: 9 })
    }
  ])("a $label change cancels the active run and ignores its stale resolution", async ({ change }) => {
    const harness = mount("cap_a", { start: 0, end: 10 });
    act(() => harness.snapshot().triggerDrag("gif", "high"));
    const runId = runIdFromExport("gif", "high");
    const oldExport = pendingNamed("video:export");

    change(harness);

    expect(harness.snapshot().states).toEqual({});
    expect(
      pendingNamed(
        "video:cancelExport",
        (req) => (req as { runId?: string }).runId === runId
      ).req
    ).toEqual({ runId });

    await resolvePending(oldExport, exportOk("/cache/stale.gif"));
    expect(harness.snapshot().states).toEqual({});
    expect(videoDragSink).toHaveLength(0);
  });

  test("unmount unsubscribes and dispatches cancellation for every active run", () => {
    const harness = mount("cap_unmount");
    act(() => {
      harness.snapshot().triggerCopy("gif", "low");
      harness.snapshot().triggerDrag("mp4", "high");
    });
    const gifRunId = runIdFromExport("gif", "low");
    const mp4RunId = runIdFromExport("mp4", "high");

    harness.unmount();

    expect(subscriptionSink).toEqual([
      { channel: EVENT_CHANNELS.renderProgress, active: false }
    ]);
    expect(progressSubscribers.size).toBe(0);
    expect(dispatchesNamed("video:cancelExport").map((pending) => pending.req)).toEqual(
      expect.arrayContaining([{ runId: gifRunId }, { runId: mp4RunId }])
    );
  });

  test("concurrent cells keep independent run IDs and progress", async () => {
    const harness = mount("cap_concurrent");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "low");
      harness.snapshot().triggerCopy("gif", "high");
    });
    const mp4RunId = runIdFromExport("mp4", "low");
    const gifRunId = runIdFromExport("gif", "high");
    expect(mp4RunId).not.toBe(gifRunId);

    emitProgress({
      runId: mp4RunId,
      captureId: "cap_concurrent",
      format: "mp4",
      preset: "low",
      phase: "encoding",
      ratio: 0.25
    });
    emitProgress({
      runId: gifRunId,
      captureId: "cap_concurrent",
      format: "gif",
      preset: "high",
      phase: "palette",
      ratio: null
    });
    expect(runningState(harness.snapshot(), "mp4-low").ratio).toBe(0.25);
    expect(runningState(harness.snapshot(), "gif-high").ratio).toBeNull();

    const mp4Export = pendingNamed(
      "video:export",
      (req) => (req as { runId?: string }).runId === mp4RunId
    );
    await resolvePending(mp4Export, exportOk("/cache/mp4-low.mp4"));
    await resolvePending(pendingNamed("clipboard:copyVideoFile"), {
      ok: true,
      value: { path: "/friendly/mp4-low.mp4" }
    });

    expect(harness.snapshot().states["mp4-low"]).toEqual({
      kind: "done",
      path: "/friendly/mp4-low.mp4"
    });
    expect(runningState(harness.snapshot(), "gif-high")).toEqual({
      kind: "running",
      runId: gifRunId,
      phase: "palette",
      ratio: null
    });
  });

  test("null input makes all triggers no-ops", () => {
    const harness = mount(null);
    act(() => {
      harness.snapshot().triggerCopy("mp4", "med");
      harness.snapshot().triggerCopyPath("gif", "low");
      harness.snapshot().triggerDrag("mp4", "high");
    });
    expect(harness.snapshot().states).toEqual({});
    expect(dispatchesNamed("video:export")).toHaveLength(0);
    expect(videoDragSink).toHaveLength(0);
  });
});
