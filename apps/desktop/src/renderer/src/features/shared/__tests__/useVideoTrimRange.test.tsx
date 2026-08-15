// Hook tests for `useVideoTrimRange` — the local trim state that
// persists to `video:setDefaultRange` on commit (debounced) and adopts
// upstream `defaultRange` changes when not mid-edit.

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

function Probe(props: {
  captureId: string | null;
  durationSec: number;
  persistedRange: VideoRange | null;
}): null {
  latest = useVideoTrimRange(props);
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

  test("commit persists once after the debounce, with the ms-rounded range", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 3.4, end: 11.2 }, false));
    act(() => latest!.setRange({ start: 3.44444, end: 11.2 }, true));
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

  test("switching captures resets local state and drops a pending persist", async () => {
    mount({ captureId: "cap", durationSec: 16, persistedRange: { start: 0, end: 16 } });
    act(() => latest!.setRange({ start: 3, end: 12 }, true));
    rerender({ captureId: "other", durationSec: 8, persistedRange: { start: 1, end: 7 } });
    expect(latest!.range).toEqual({ start: 1, end: 7 });
    expect(latest!.pending).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(PERSIST_DEBOUNCE_MS * 2);
      await Promise.resolve();
    });
    expect(dispatched).toEqual([]);
  });
});
