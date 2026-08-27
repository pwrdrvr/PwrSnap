import { act, createElement, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { PwrSnapError } from "@pwrsnap/shared";
import type { UseLibraryResult } from "../useLibrary";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const emptyHead = {
  rows: [],
  nextCursor: null,
  appStats: [],
  totalLive: 0,
  kindStats: [],
  trashTotal: 0
};

const listError: PwrSnapError = {
  kind: "library",
  code: "list_failed",
  message: "database read failed"
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetModules();
});

describe("useLibrary refresh contract", () => {
  test("reports Result failure and makes a caller during an in-flight read await the queued read", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const first = deferred<{ ok: true; value: typeof emptyHead }>();
    const second = deferred<{ ok: false; error: PwrSnapError }>();
    const dispatch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    window.pwrsnapApi = {
      dispatch,
      on: vi.fn(() => () => undefined)
    } as unknown as NonNullable<Window["pwrsnapApi"]>;

    const { useLibrary } = await import("../useLibrary");
    let latest: UseLibraryResult | null = null;
    const Probe: ComponentType = () => {
      latest = useLibrary();
      return null;
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const requestedRefresh = latest!.refresh();
    let refreshSettled = false;
    void requestedRefresh.then(() => {
      refreshSettled = true;
    });

    await act(async () => {
      first.resolve({ ok: true, value: emptyHead });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(refreshSettled).toBe(false);

    let refreshResult!: Awaited<typeof requestedRefresh>;
    await act(async () => {
      second.resolve({ ok: false, error: listError });
      refreshResult = await requestedRefresh;
      await Promise.resolve();
    });

    expect(refreshResult).toEqual({ ok: false, error: listError });
    expect(latest!.error).toBe("database read failed");

    dispatch.mockResolvedValueOnce({
      ok: true,
      value: { ...emptyHead, totalLive: 3, trashTotal: 2 }
    });
    let successfulRefresh!: Awaited<ReturnType<UseLibraryResult["refresh"]>>;
    await act(async () => {
      successfulRefresh = await latest!.refresh();
      await Promise.resolve();
    });
    expect(successfulRefresh).toEqual({
      ok: true,
      value: { totalLive: 3, trashTotal: 2 }
    });
    expect(latest!.totalLive).toBe(3);
    expect(latest!.trashTotal).toBe(2);
  });
});
