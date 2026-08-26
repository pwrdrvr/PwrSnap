import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();
let settingsChanged: (() => void) | null = null;

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args),
  subscribe: (_channel: string, handler: () => void) => {
    settingsChanged = handler;
    return () => {
      settingsChanged = null;
    };
  }
}));

import { usePresetRenderMetrics } from "../usePresetRenderMetrics";

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  settingsChanged = null;
  dispatchMock.mockReset();
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function result(widthPx: number) {
  return {
    ok: true as const,
    value: {
      metrics: [
        {
          preset: "med" as const,
          widthPx,
          heightPx: Math.round(widthPx * 0.625),
          byteSize: widthPx,
          fromCache: true
        }
      ]
    }
  };
}

function Probe() {
  const metrics = usePresetRenderMetrics("capture-1", 0);
  return createElement("div", null, metrics.med?.dim ?? "pending");
}

describe("usePresetRenderMetrics", () => {
  test("ignores an older legacy response after a settings-triggered refetch", async () => {
    const legacy = deferred<ReturnType<typeof result>>();
    const dpiAware = deferred<ReturnType<typeof result>>();
    dispatchMock
      .mockImplementationOnce(() => legacy.promise)
      .mockImplementationOnce(() => dpiAware.promise);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Probe));
      await Promise.resolve();
    });

    await act(async () => {
      settingsChanged?.();
      dpiAware.resolve(result(800));
      await dpiAware.promise;
    });
    expect(container.textContent).toBe("800 × 500");

    await act(async () => {
      legacy.resolve(result(1440));
      await legacy.promise;
    });
    expect(container.textContent).toBe("800 × 500");
  });
});
