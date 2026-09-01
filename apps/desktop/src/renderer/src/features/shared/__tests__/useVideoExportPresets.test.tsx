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
  reject: (reason?: unknown) => void;
};
const pendingResolvers: PendingResolver[] = [];
const videoDragSink: Array<{ captureId: string; format: string; preset: string; range?: unknown }> = [];

// Cast to `unknown` then to the full Window shape — the test stub
// intentionally implements only the four hook-required surfaces
// (`dispatch`, `on`, `startCaptureDrag`, `startVideoDrag`), not the
// full preload API (`platform`, `versions`, `submitRegion`, etc.).
// `tsc --noEmit` rejects partial assignments to `Window["pwrsnapApi"]`
// at strict mode; this is a unit-test stub, not production code, so
// the cast is the right scope-control here.
(globalThis as unknown as { window: Window }).window =
  (globalThis as unknown as { window?: Window }).window ?? ({} as Window);
(globalThis as unknown as { window: { pwrsnapApi: unknown } }).window.pwrsnapApi = {
  dispatch: (_name: string, _req: unknown): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      pendingResolvers.push({ name: _name, req: _req, resolve, reject });
    }),
  on: () => () => undefined,
  startCaptureDrag: () => undefined,
  startVideoDrag: (payload: { captureId: string; format: string; preset: string; range?: unknown }) => {
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

async function rejectNext(reason: unknown): Promise<void> {
  const pending = pendingResolvers.shift();
  if (pending === undefined) throw new Error("no pending resolver to reject");
  await act(async () => {
    pending.reject(reason);
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

function mount(
  initialCaptureId: string | null = "cap_1",
  range?: { start: number; end: number }
): {
  snapshot: () => Snapshot;
  setCaptureId: (next: string | null) => void;
  setRange: (next: { start: number; end: number } | undefined) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  let last: Snapshot | null = null;
  let captureId = initialCaptureId;
  let currentRange = range;

  const render = (): void => {
    act(() => {
      root!.render(
        createElement(Probe, {
          captureId,
          range: currentRange,
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
    },
    setRange: (next) => {
      currentRange = next;
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
    expect(harness.snapshot().states["mp4-med"]).toEqual({ kind: "running", action: "copy" });
    // Other cells stay unset.
    expect(harness.snapshot().states["mp4-low"]).toBeUndefined();
    expect(harness.snapshot().states["gif-med"]).toBeUndefined();

    await resolveNext({ ok: true, value: { path: "/cache/mp4-med.mp4" } });
    expect(harness.snapshot().states["mp4-med"]).toEqual({
      kind: "done",
      action: "copy",
      path: "/cache/mp4-med.mp4"
    });
  });

  test("triggerCopyPath uses the same state cell; dispatches the path verb", () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopyPath("gif", "low");
    });
    expect(harness.snapshot().states["gif-low"]).toEqual({ kind: "running", action: "path" });
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
      action: "copy",
      message: "ffmpeg exited 1"
    });
  });

  test.each([
    {
      label: "media copy",
      key: "gif-low" as const,
      action: "copy" as const,
      trigger: (snapshot: Snapshot) => snapshot.triggerCopy("gif", "low")
    },
    {
      label: "path copy",
      key: "mp4-med" as const,
      action: "path" as const,
      trigger: (snapshot: Snapshot) => snapshot.triggerCopyPath("mp4", "med")
    },
    {
      label: "drag export",
      key: "mp4-high" as const,
      action: "drag" as const,
      trigger: (snapshot: Snapshot) => snapshot.triggerDrag("mp4", "high")
    }
  ])("$label bridge rejection becomes an action-specific visible error", async ({ key, action, trigger }) => {
    const harness = mount("cap_1");
    act(() => trigger(harness.snapshot()));

    await rejectNext(new Error("agent bridge disconnected"));

    expect(harness.snapshot().states[key]).toEqual({
      kind: "error",
      action,
      message: "agent bridge disconnected"
    });
  });

  test("a non-descriptive bridge rejection gets a useful fallback message", async () => {
    const harness = mount("cap_1");
    act(() => harness.snapshot().triggerCopy("gif", "med"));

    await rejectNext(undefined);

    expect(harness.snapshot().states["gif-med"]).toEqual({
      kind: "error",
      action: "copy",
      message: "The PwrSnap export service did not respond."
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
      action: "copy",
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

  test("triggerDrag fires startVideoDrag AND a parallel video:export for visible state", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerDrag("mp4", "high");
    });
    // Native drag IPC fires immediately (fire-and-forget).
    expect(videoDragSink).toEqual([
      { captureId: "cap_1", format: "mp4", preset: "high" }
    ]);
    // Card transitions to Encoding… so the user gets visible feedback
    // during the (potentially long) ffmpeg run. Without this, the
    // drag handle "dies" silently.
    expect(harness.snapshot().states["mp4-high"]).toEqual({ kind: "running", action: "drag" });
    expect(pendingResolvers[0]?.name).toBe("video:export");
    expect(pendingResolvers[0]?.req).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "high"
    });

    // Encode resolves → card flips to done.
    await resolveNext({ ok: true, value: { path: "/cache/dragged.mp4" } });
    expect(harness.snapshot().states["mp4-high"]).toEqual({
      kind: "done",
      action: "drag",
      path: "/cache/dragged.mp4"
    });
  });

  test("captureId change mid-encode drops the stale resolution onto the floor", async () => {
    // Regression for the cross-capture state leak: a slow encode for
    // capture A that resolves after the user has navigated to capture
    // B must NOT paint a `done` state onto B's cards.
    const harness = mount("cap_a");
    act(() => {
      harness.snapshot().triggerCopy("gif", "low");
    });
    expect(harness.snapshot().states["gif-low"]).toEqual({ kind: "running", action: "copy" });

    // Navigate to a different capture while the dispatch is in flight.
    harness.setCaptureId("cap_b");
    expect(harness.snapshot().states).toEqual({});

    // Old dispatch resolves — should be ignored because the current
    // captureId no longer matches what the dispatch was issued for.
    await resolveNext({ ok: true, value: { path: "/cache/cap_a.gif" } });
    expect(harness.snapshot().states).toEqual({});
  });

  test("trim-range change mid-encode drops the stale resolution onto the floor", async () => {
    const harness = mount("cap_1", { start: 0, end: 10 });
    act(() => {
      harness.snapshot().triggerCopy("gif", "low");
    });
    expect(harness.snapshot().states["gif-low"]).toEqual({ kind: "running", action: "copy" });

    harness.setRange({ start: 2, end: 8 });
    expect(harness.snapshot().states).toEqual({});

    await resolveNext({ ok: true, value: { path: "/cache/old-range.gif" } });
    expect(harness.snapshot().states).toEqual({});
  });

  test("a superseded same-card request cannot overwrite the newer action", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "med");
      harness.snapshot().triggerCopyPath("mp4", "med");
    });
    expect(harness.snapshot().states["mp4-med"]).toEqual({ kind: "running", action: "path" });

    // The older media-copy completion is ignored because path-copy is
    // now the latest action for this exact card.
    await resolveNext({ ok: true, value: { path: "/cache/older-copy.mp4" } });
    expect(harness.snapshot().states["mp4-med"]).toEqual({ kind: "running", action: "path" });

    await resolveNext({ ok: true, value: { path: "/cache/newer-path.mp4" } });
    expect(harness.snapshot().states["mp4-med"]).toEqual({
      kind: "done",
      action: "path",
      path: "/cache/newer-path.mp4"
    });
  });

  test("concurrent triggers on different cells track independently", async () => {
    const harness = mount("cap_1");
    act(() => {
      harness.snapshot().triggerCopy("mp4", "low");
      harness.snapshot().triggerCopy("gif", "high");
    });
    expect(harness.snapshot().states["mp4-low"]).toEqual({ kind: "running", action: "copy" });
    expect(harness.snapshot().states["gif-high"]).toEqual({ kind: "running", action: "copy" });

    // Resolve in FIFO order — the first pending is mp4-low (it was
    // triggered first). The test resolver returns its value to
    // whichever cell registered next.
    await resolveNext({ ok: true, value: { path: "/cache/mp4-low.mp4" } });
    expect(harness.snapshot().states["mp4-low"]).toEqual({
      kind: "done",
      action: "copy",
      path: "/cache/mp4-low.mp4"
    });
    expect(harness.snapshot().states["gif-high"]).toEqual({ kind: "running", action: "copy" });

    await resolveNext({ ok: true, value: { path: "/cache/gif-high.gif" } });
    expect(harness.snapshot().states["gif-high"]).toEqual({
      kind: "done",
      action: "copy",
      path: "/cache/gif-high.gif"
    });
  });

  test("an explicit trim range rides on every copy / copy-path / drag / export request", async () => {
    const range = { start: 3.4, end: 11.2 };
    const harness = mount("cap_1", range);

    act(() => harness.snapshot().triggerCopy("gif", "low"));
    expect(pendingResolvers[0]?.name).toBe("clipboard:copyVideoFile");
    expect(pendingResolvers[0]?.req).toEqual({
      captureId: "cap_1",
      format: "gif",
      preset: "low",
      range
    });
    await resolveNext({ ok: true, value: { path: "/cache/a.gif" } });

    act(() => harness.snapshot().triggerCopyPath("mp4", "med"));
    expect(pendingResolvers[0]?.name).toBe("clipboard:copyVideoPath");
    expect(pendingResolvers[0]?.req).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "med",
      range
    });
    await resolveNext({ ok: true, value: { path: "/cache/b.mp4" } });

    act(() => harness.snapshot().triggerDrag("mp4", "high"));
    expect(videoDragSink.at(-1)).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "high",
      range
    });
    expect(pendingResolvers[0]?.name).toBe("video:export");
    expect(pendingResolvers[0]?.req).toEqual({
      captureId: "cap_1",
      format: "mp4",
      preset: "high",
      range
    });
    await resolveNext({ ok: true, value: { path: "/cache/c.mp4" } });
  });

  test("without a range the requests omit it (main falls back to defaultRange)", () => {
    const harness = mount("cap_1");
    act(() => harness.snapshot().triggerCopy("gif", "low"));
    const req = pendingResolvers[0]?.req as Record<string, unknown>;
    expect(req.range).toBeUndefined();
  });
});

// Stub: vi import keeps the linter happy when we add `vi.useFakeTimers`
// in future expansions of this suite.
void vi;
