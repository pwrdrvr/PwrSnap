// Hook tests for `useVideoExportPresets`. Verifies the per-(format,
// preset) state machine: idle → running on trigger, running → done
// / error on dispatch resolution, reset-to-idle on captureId change,
// and no-op when captureId is null.
//
// The hook owns six independent cells (2 formats × 3 presets). Click
// timing is mocked via a deterministic dispatch stub so we can drive
// the resolution order from the test.

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  useVideoExportPresets,
  type ExportButtonState,
  type VideoExportPresetsState
} from "../useVideoExportPresets";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

beforeEach(() => {
  // Reset the fake dispatch and IPC sink between tests so resolutions
  // from a prior test can't leak into the current one.
  pendingResolvers.length = 0;
  videoDragSink.length = 0;
});

// ── Fake renderer-side bridge ─────────────────────────────────────────

type PendingResolver = {
  name: string;
  req: unknown;
  resolve: (value: unknown) => void;
};
const pendingResolvers: PendingResolver[] = [];
const videoDragSink: Array<{ captureId: string; format: string; preset: string }> = [];

(globalThis as unknown as { window: Window }).window =
  (globalThis as unknown as { window?: Window }).window ?? ({} as Window);
(globalThis as unknown as { window: Window & { pwrsnapApi?: unknown } }).window.pwrsnapApi = {
  dispatch: (name: string, req: unknown) =>
    new Promise((resolve) => {
      pendingResolvers.push({ name, req, resolve });
    }),
  on: () => () => undefined,
  startCaptureDrag: () => undefined,
  startVideoDrag: (payload: { captureId: string; format: string; preset: string }) => {
    videoDragSink.push(payload);
  }
};

async function resolveNext(value: unknown): Promise<void> {
  const pending = pendingResolvers.shift();
  if (pending === undefined) throw new Error("no pending resolver to resolve");
  // The hook's `.then` callback is queued as a microtask when the
  // promise resolves. `act(async () => …)` with an awaited
  // `Promise.resolve()` inside flushes that microtask AND lets
  // React commit the resulting state update before we read the
  // snapshot — without this, the test reads a stale "running"
  // state because the microtask hasn't run yet.
  await act(async () => {
    pending.resolve(value);
    await Promise.resolve();
  });
}

// ── Probe component ───────────────────────────────────────────────────

type Snapshot = {
  states: VideoExportPresetsState;
  triggerCopy: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
  triggerCopyPath: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
  triggerDrag: (format: "gif" | "mp4", preset: "low" | "med" | "high") => void;
};

type ProbeProps = {
  captureId: string | null;
  onSnapshot: (snapshot: Snapshot) => void;
};

function Probe({ captureId, onSnapshot }: ProbeProps): null {
  const input = captureId === null ? null : { captureId };
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

function mount(initialCaptureId: string | null = "cap_1"): {
  snapshot: () => Snapshot;
  setCaptureId: (next: string | null) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  let last: Snapshot | null = null;
  let captureId = initialCaptureId;

  const render = (): void => {
    act(() => {
      root!.render(
        createElement(Probe, {
          captureId,
          onSnapshot: (snap) => {
            last = snap;
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
    }
  };
}

describe("useVideoExportPresets", () => {
  test("idle on first mount; no entries until a trigger fires", () => {
    const harness = mount("cap_1");
    expect(harness.snapshot().states).toEqual({});
  });

  test("triggerCopy moves the matching cell to running, then done on ok", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "med");
    });
    expect(harness.snapshot().states["mp4-med"]).toEqual({ kind: "running" });
    // Other cells stay unset.
    expect(harness.snapshot().states["mp4-low"]).toBeUndefined();
    expect(harness.snapshot().states["gif-med"]).toBeUndefined();

    await resolveNext({ ok: true, value: { path: "/cache/mp4-med.mp4" } });
    expect(harness.snapshot().states["mp4-med"]).toEqual({
      kind: "done",
      path: "/cache/mp4-med.mp4"
    });
  });

  test("triggerCopyPath uses the same state cell; dispatches the path verb", () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopyPath("gif", "low");
    });
    expect(harness.snapshot().states["gif-low"]).toEqual({ kind: "running" });
    expect(pendingResolvers[0]?.name).toBe("clipboard:copyVideoPath");
    expect(pendingResolvers[0]?.req).toEqual({
      captureId: "cap_1",
      format: "gif",
      preset: "low"
    });
  });

  test("error result transitions to error state with the message", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("gif", "high");
    });
    await resolveNext({
      ok: false,
      error: { kind: "render", code: "video_export_failed", message: "ffmpeg exited 1" }
    });
    expect(harness.snapshot().states["gif-high"]).toEqual({
      kind: "error",
      message: "ffmpeg exited 1"
    });
  });

  test("captureId change resets all cells to idle (empty map)", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "low");
    });
    await resolveNext({ ok: true, value: { path: "/cache/a.mp4" } });
    expect(harness.snapshot().states["mp4-low"]).toEqual({
      kind: "done",
      path: "/cache/a.mp4"
    });

    harness.setCaptureId("cap_2");
    expect(harness.snapshot().states).toEqual({});
  });

  test("null captureId makes triggers no-op (no dispatch, no state change)", () => {
    const harness = mount(null);
    act(() => {
      harness.snapshot().triggerCopy("mp4", "med");
      harness.snapshot().triggerCopyPath("gif", "low");
      harness.snapshot().triggerDrag("mp4", "high");
    });
    expect(harness.snapshot().states).toEqual({});
    expect(pendingResolvers).toHaveLength(0);
    expect(videoDragSink).toHaveLength(0);
  });

  test("triggerDrag fires startVideoDrag with the (captureId, format, preset) tuple", () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerDrag("mp4", "high");
    });
    expect(videoDragSink).toEqual([
      { captureId: "cap_1", format: "mp4", preset: "high" }
    ]);
    // Drag is fire-and-forget — no state transition.
    expect(harness.snapshot().states["mp4-high"]).toBeUndefined();
  });

  test("concurrent triggers on different cells track independently", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "low");
      harness.snapshot().triggerCopy("gif", "high");
    });
    expect(harness.snapshot().states["mp4-low"]).toEqual({ kind: "running" });
    expect(harness.snapshot().states["gif-high"]).toEqual({ kind: "running" });

    // Resolve in FIFO order — the first pending is mp4-low (it was
    // triggered first). The test resolver returns its value to
    // whichever cell registered next.
    await resolveNext({ ok: true, value: { path: "/cache/mp4-low.mp4" } });
    expect(harness.snapshot().states["mp4-low"]).toEqual({
      kind: "done",
      path: "/cache/mp4-low.mp4"
    });
    expect(harness.snapshot().states["gif-high"]).toEqual({ kind: "running" });

    await resolveNext({ ok: true, value: { path: "/cache/gif-high.gif" } });
    expect(harness.snapshot().states["gif-high"]).toEqual({
      kind: "done",
      path: "/cache/gif-high.gif"
    });
  });
});

// Stub: vi import keeps the linter happy when we add `vi.useFakeTimers`
// in future expansions of this suite.
void vi;
