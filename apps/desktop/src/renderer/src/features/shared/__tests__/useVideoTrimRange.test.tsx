// Hook tests for `useVideoTrimRange` — the local edit state that
// persists on commit (debounced: `video:setDefaultRange` in range mode,
// `video:edit` in segments mode), adopts upstream changes when not
// mid-edit, and keeps an undo history of both.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { VideoRange } from "@pwrsnap/shared";
import { PERSIST_DEBOUNCE_MS, useVideoTrimRange, type UseVideoTrimRange } from "../useVideoTrimRange";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const dispatched: Array<{ name: string; req: unknown }> = [];
(globalThis as unknown as { window: { pwrsnapApi: unknown } }).window.pwrsnapApi = {
  dispatch: (name: string, req: unknown): Promise<unknown> => {
    dispatched.push({ name, req });
    return Promise.resolve({ ok: true, value: undefined });
  },
  on: () => () => undefined
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: UseVideoTrimRange | null = null;

/** Range mode unless the test passes the record's segments. */
function Probe(props: {
  captureId: string | null;
  durationSec: number;
  persistedRange: VideoRange | null;
  persistedSegments?: readonly VideoRange[] | null;
}): null {
  const { persistedSegments, ...rest } = props;
  latest = useVideoTrimRange(
    persistedSegments === undefined
      ? { ...rest, persist: "range" }
      : { ...rest, persist: "edit", persistedSegments }
  );
  return null;
}

function mount(props: Parameters<typeof Probe>[0]): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Probe, props)));
}

function rerender(props: Parameters<typeof Probe>[0]): void {
  act(() => root!.render(createElement(Probe, props)));
}

beforeEach(() => {
  vi.useFakeTimers();
  dispatched.length = 0;
  latest = null;
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("useVideoTrimRange", () => {
  test("seeds from the persisted range (clamped)", () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 3.4, end: 11.2 } });
    expect(latest!.range).toEqual({ start: 3.4, end: 11.2 });
    rerender({ captureId: "cap2", durationSec: 10, persistedRange: { start: -1, end: 99 } });
    expect(latest!.range).toEqual({ start: 0, end: 10 });
  });

  test("uncommitted drags update locally without dispatching", () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 2, end: 16 }, false));
    expect(latest!.range).toEqual({ start: 2, end: 16 });
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 4));
    expect(dispatched).toEqual([]);
  });

  test("commit persists once after the debounce, adopting a valid range verbatim", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 3.4, end: 11.2 }, false));
    act(() => latest!.setRange({ start: 3.444, end: 11.2 }, true));
    expect(latest!.pending).toBe(true);
    expect(dispatched).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    expect(dispatched).toEqual([
      { name: "video:setDefaultRange", req: { captureId: "cap", range: { start: 3.444, end: 11.2 } } }
    ]);
    expect(latest!.pending).toBe(false);
  });

  test("out-of-bounds commits are clamped; a valid persisted seed keeps its exact floats", () => {
    mount({ captureId: "cap", durationSec: 16.0333333, persistedRange: { start: 0, end: 16.0333333 } });
    expect(latest!.range).toEqual({ start: 0, end: 16.0333333 });
    act(() => latest!.setRange({ start: -2, end: 40 }, true));
    expect(latest!.range).toEqual({ start: 0, end: 16.033 });
  });

  test("rapid commits coalesce into the last value", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 1, end: 16 }, true));
    act(() => vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS / 2));
    act(() => latest!.setRange({ start: 2, end: 16 }, true));
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    expect(dispatched.map((d) => (d.req as { range: VideoRange }).range)).toEqual([
      { start: 2, end: 16 }
    ]);
  });

  test("adopts an upstream defaultRange change when idle, not while dragging", () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    rerender({ captureId: "cap", durationSec: 16, persistedRange: { start: 5, end: 9 } });
    expect(latest!.range).toEqual({ start: 5, end: 9 });

    act(() => latest!.setRange({ start: 1, end: 9 }, false));
    rerender({ captureId: "cap", durationSec: 16, persistedRange: { start: 6, end: 9 } });
    expect(latest!.range).toEqual({ start: 1, end: 9 });
  });

  test("a stale echo does not revert a newer pending commit", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 3, end: 12 }, true));
    // Revalidation carrying an OLD value lands before our write acks.
    rerender({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    expect(latest!.range).toEqual({ start: 3, end: 12 });
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
    // Now the echo of OUR write arrives — adopted, and identical.
    rerender({ captureId: "cap", durationSec: 16, persistedRange: { start: 3, end: 12 } });
    expect(latest!.range).toEqual({ start: 3, end: 12 });
  });

  test("switching captures resets local state and flushes the pending persist to its capture", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 3, end: 12 }, true));
    rerender({ captureId: "other", durationSec: 8, persistedRange: { start: 1, end: 7 } });
    expect(latest!.range).toEqual({ start: 1, end: 7 });
    expect(latest!.pending).toBe(false);
    expect(latest!.canUndo).toBe(false);
    // Written immediately, to the capture it was made on — arrowing to
    // the next capture inside the debounce used to drop the edit.
    expect(dispatched).toEqual([
      { name: "video:setDefaultRange", req: { captureId: "cap", range: { start: 3, end: 12 } } }
    ]);
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2);
      await Promise.resolve();
    });
    expect(dispatched).toHaveLength(1);
  });
});

describe("useVideoTrimRange — segments mode", () => {
  const whole = [{ start: 0, end: 20 }];
  const cut = [
    { start: 0, end: 4 },
    { start: 9, end: 20 }
  ];

  async function settle(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS + 1);
      await Promise.resolve();
    });
  }

  test("seeds from the record's segments and exposes export spans only when there is a cut", () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: cut });
    expect(latest!.segments).toEqual(cut);
    expect(latest!.range).toEqual({ start: 0, end: 20 });
    expect(latest!.exportSegments).toEqual(cut);

    // A split with both sides kept is not a cut: nothing extra rides the export.
    rerender({
      captureId: "cap2",
      durationSec: 20,
      persistedRange: { start: 0, end: 20 },
      persistedSegments: [
        { start: 0, end: 7 },
        { start: 7, end: 20 }
      ]
    });
    expect(latest!.exportSegments).toBeUndefined();
  });

  test("persists the kept spans with video:edit", async () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: whole });
    act(() => latest!.setSegments(cut, true));
    await settle();
    expect(dispatched).toEqual([{ name: "video:edit", req: { captureId: "cap", keep: cut } }]);
  });

  test("moving a handle clips the committed edit, so dragging back over a cut restores it", () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: cut });
    // Drag the in-point past the cut…
    act(() => latest!.setRange({ start: 10, end: 20 }, false));
    expect(latest!.segments).toEqual([{ start: 10, end: 20 }]);
    // …and back: the cut is still there, because frames clip the snapshot.
    act(() => latest!.setRange({ start: 1, end: 20 }, false));
    expect(latest!.segments).toEqual([
      { start: 1, end: 4 },
      { start: 9, end: 20 }
    ]);
    act(() => latest!.setRange({ start: 1, end: 20 }, true));
    expect(latest!.range).toEqual({ start: 1, end: 20 });
  });

  test("undo and redo walk committed edits and persist each step", async () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: whole });
    expect(latest!.canUndo).toBe(false);
    act(() => latest!.setSegments(cut, true));
    act(() => latest!.setRange({ start: 2, end: 20 }, true));
    expect(latest!.canUndo).toBe(true);

    act(() => latest!.undo());
    expect(latest!.segments).toEqual(cut);
    expect(latest!.canRedo).toBe(true);
    act(() => latest!.undo());
    expect(latest!.segments).toEqual(whole);
    expect(latest!.canUndo).toBe(false);

    act(() => latest!.redo());
    expect(latest!.segments).toEqual(cut);
    await settle();
    // Debounced: only where the walk ended is written.
    expect(dispatched).toEqual([{ name: "video:edit", req: { captureId: "cap", keep: cut } }]);

    // A new edit clears the redo branch.
    act(() => latest!.setSegments(whole, true));
    expect(latest!.canRedo).toBe(false);
  });

  test("a drag that ends where it began records nothing and writes nothing", async () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: cut });
    act(() => latest!.setSegments([{ start: 0, end: 6 }, { start: 9, end: 20 }], false));
    act(() => latest!.setSegments(cut, true));
    expect(latest!.segments).toEqual(cut);
    expect(latest!.canUndo).toBe(false);
    await settle();
    expect(dispatched).toEqual([]);
  });

  test("an agent's edit is adopted and is one undo away from gone", async () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: whole });
    // `events:captures:changed` after an MCP / chat `video:edit`.
    rerender({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: cut });
    expect(latest!.segments).toEqual(cut);
    expect(latest!.canUndo).toBe(true);
    act(() => latest!.undo());
    expect(latest!.segments).toEqual(whole);
    await settle();
    expect(dispatched).toEqual([{ name: "video:edit", req: { captureId: "cap", keep: whole } }]);
  });

  test("the echo of our own write is not an upstream edit", async () => {
    mount({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: whole });
    act(() => latest!.setSegments(cut, true));
    await settle();
    rerender({ captureId: "cap", durationSec: 20, persistedRange: { start: 0, end: 20 }, persistedSegments: cut });
    act(() => latest!.undo());
    // One undo returns to the whole clip — the echo pushed nothing.
    expect(latest!.segments).toEqual(whole);
    expect(latest!.canUndo).toBe(false);
  });
});
