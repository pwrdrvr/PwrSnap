// Tests for usePasteImage — Phase 5 ⌘V handler.
//
// Asserts:
//   • v1 capture → pasteFromClipboard refuses with v1_capture_use_v2
//     error (no dispatch issued)
//   • v2 capture → dispatch called with the right payload, success
//     surfaces the layer id via onPasted, error surfaces via onError
//   • onPastingChange called with the position on start, null on
//     end — both success + failure paths
//
// We mock the `dispatch` helper via vi.mock so the tests don't need
// the preload IPC bridge. The hook is pure — no side effects beyond
// dispatching + invoking the supplied callbacks.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

// Important: import the hook AFTER vi.mock so the mocked dispatch is wired.
const { usePasteImage } = await import("../usePasteImage");

// React's bare-minimum hook test scaffolding: render a host
// component, capture the hook's return via a ref, and drive
// callbacks via act(). Avoids @testing-library/react dependency
// (matching the codebase convention).

import { createRoot, type Root } from "react-dom/client";
import { createElement, useImperativeHandle, forwardRef } from "react";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dispatchMock.mockReset();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
});

interface HookHandle {
  pasteFromClipboard: (position?: {
    xn: number;
    yn: number;
    canvasPx: { x: number; y: number };
  }) => Promise<boolean>;
}

const HookHost = forwardRef<
  HookHandle,
  {
    captureId: string;
    bundleFormatVersion: number;
    onPastingChange?: (
      s: { xn: number; yn: number; canvasPx: { x: number; y: number } } | null
    ) => void;
    onError?: (e: { kind: string; code: string; message: string }) => void;
    onPasted?: (id: string) => void;
  }
>(function HookHost(props, ref) {
  const hook = usePasteImage(props);
  useImperativeHandle(ref, () => ({
    pasteFromClipboard: hook.pasteFromClipboard
  }));
  return null;
});

async function mountHook(
  props: React.ComponentProps<typeof HookHost>
): Promise<HookHandle> {
  let handle: HookHandle | null = null;
  await act(async () => {
    root!.render(
      createElement(HookHost, {
        ...props,
        ref: (h: HookHandle | null) => {
          handle = h;
        }
      })
    );
  });
  if (handle === null) throw new Error("hook handle never set");
  return handle;
}

describe("usePasteImage", () => {
  test("v1 capture refuses without dispatching", async () => {
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v1",
      bundleFormatVersion: 1,
      onError: (e) => errors.push({ code: e.code })
    });
    const result = await hook.pasteFromClipboard();
    expect(result).toBe(false);
    expect(errors).toEqual([{ code: "v1_capture_use_v2" }]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("v2 capture: dispatches editor:pasteImageAsLayer with position", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "new_layer_id" } });
    const pasted: string[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onPasted: (id) => pasted.push(id)
    });
    const result = await hook.pasteFromClipboard({
      xn: 0.25,
      yn: 0.75,
      canvasPx: { x: 100, y: 300 }
    });
    expect(result).toBe(true);
    expect(dispatchMock).toHaveBeenCalledWith("editor:pasteImageAsLayer", {
      captureId: "cap_v2",
      positionXn: 0.25,
      positionYn: 0.75
    });
    expect(pasted).toEqual(["new_layer_id"]);
  });

  test("v2 capture: handler error surfaces via onError", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { kind: "validation", code: "image_too_large", message: "too big" }
    });
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onError: (e) => errors.push({ code: e.code })
    });
    const result = await hook.pasteFromClipboard();
    expect(result).toBe(true); // dispatch ran
    expect(errors).toEqual([{ code: "image_too_large" }]);
  });

  test("onPastingChange fires with position on start, null on end", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "x" } });
    const changes: ({
      xn: number;
      yn: number;
      canvasPx: { x: number; y: number };
    } | null)[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onPastingChange: (s) => changes.push(s)
    });
    await hook.pasteFromClipboard({
      xn: 0.5,
      yn: 0.5,
      canvasPx: { x: 50, y: 50 }
    });
    expect(changes).toEqual([
      { xn: 0.5, yn: 0.5, canvasPx: { x: 50, y: 50 } },
      null
    ]);
  });

  test("onPastingChange clears even on dispatch failure", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: { kind: "validation", code: "image_decode_failed", message: "x" }
    });
    const changes: unknown[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onPastingChange: (s) => changes.push(s)
    });
    await hook.pasteFromClipboard({
      xn: 0.1,
      yn: 0.1,
      canvasPx: { x: 1, y: 1 }
    });
    // Last entry must be null — affordance cleared.
    expect(changes[changes.length - 1]).toBeNull();
  });
});
