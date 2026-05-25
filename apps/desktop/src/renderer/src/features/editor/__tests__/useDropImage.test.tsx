// Tests for useDropImage — Phase 5 Finder drag-drop handler.
//
// Asserts:
//   • onDragOver sets dropEffect + isDragOver when dataTransfer has Files
//   • onDragOver no-ops when no files (text drag)
//   • onDrop ignores non-image files (drop_not_image error)
//   • onDrop ignores missing file paths (drop_path_unavailable error)
//   • v1 capture refuses without dispatching (v1_capture_use_v2)
//   • v2 capture: dispatches editor:dropImageAsLayer with normalized
//     position computed from clientX/Y vs the canvas getBoundingClientRect
//   • handler error surfaces via onError

import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

const { useDropImage } = await import("../useDropImage");

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
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => Promise<void>;
  isDragOver: boolean;
}

const HookHost = forwardRef<
  HookHandle,
  {
    captureId: string;
    bundleFormatVersion: number;
    canvasEl?: HTMLElement | null;
    onError?: (e: { kind: string; code: string; message: string }) => void;
    onDropped?: (id: string) => void;
  }
>(function HookHost(props, ref) {
  const hook = useDropImage(props);
  useImperativeHandle(ref, () => ({
    onDragOver: hook.onDragOver,
    onDragLeave: hook.onDragLeave,
    onDrop: hook.onDrop,
    isDragOver: hook.isDragOver
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

function makeFile(name: string, type: string, path: string | null): File {
  const f = new File([new Uint8Array([0x89])], name, { type });
  if (path !== null) {
    Object.defineProperty(f, "path", { value: path });
  }
  return f;
}

function makeDragEvent(
  types: string[],
  files: File[],
  clientX = 0,
  clientY = 0
): React.DragEvent<HTMLElement> {
  let dropEffect: DataTransfer["dropEffect"] = "none";
  return {
    preventDefault: vi.fn(),
    dataTransfer: {
      types,
      files,
      get dropEffect() {
        return dropEffect;
      },
      set dropEffect(v: DataTransfer["dropEffect"]) {
        dropEffect = v;
      }
    } as unknown as DataTransfer,
    clientX,
    clientY
  } as unknown as React.DragEvent<HTMLElement>;
}

describe("useDropImage", () => {
  test("onDragOver sets dropEffect + isDragOver for file drags", async () => {
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2
    });
    const event = makeDragEvent(["Files"], [makeFile("x.png", "image/png", "/tmp/x.png")]);
    act(() => {
      hook.onDragOver(event);
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.dataTransfer.dropEffect).toBe("copy");
  });

  test("onDragOver no-ops for non-file drags (text)", async () => {
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2
    });
    const event = makeDragEvent(["text/plain"], []);
    act(() => {
      hook.onDragOver(event);
    });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  test("v1 capture: drop refuses without dispatching", async () => {
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v1",
      bundleFormatVersion: 1,
      onError: (e) => errors.push({ code: e.code })
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("x.png", "image/png", "/tmp/x.png")]
    );
    await hook.onDrop(event);
    expect(errors).toEqual([{ code: "v1_capture_use_v2" }]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("drop rejects non-image files (drop_not_image)", async () => {
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onError: (e) => errors.push({ code: e.code })
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("x.txt", "text/plain", "/tmp/x.txt")]
    );
    await hook.onDrop(event);
    expect(errors).toEqual([{ code: "drop_not_image" }]);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  test("drop rejects missing file path (drop_path_unavailable)", async () => {
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onError: (e) => errors.push({ code: e.code })
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("x.png", "image/png", null)]
    );
    await hook.onDrop(event);
    expect(errors).toEqual([{ code: "drop_path_unavailable" }]);
  });

  test("v2 happy path: dispatches with normalized position from canvas rect", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "dropped_id" } });
    // Canvas at (100, 200) of size 400x300. Drop client at (300, 350)
    // → normalized (0.5, 0.5).
    const canvas = document.createElement("div");
    canvas.getBoundingClientRect = () =>
      ({
        x: 100,
        y: 200,
        width: 400,
        height: 300,
        top: 200,
        left: 100,
        right: 500,
        bottom: 500,
        toJSON: () => ({})
      }) as DOMRect;
    const dropped: string[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      canvasEl: canvas,
      onDropped: (id) => dropped.push(id)
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("x.png", "image/png", "/tmp/x.png")],
      300,
      350
    );
    await hook.onDrop(event);
    expect(dispatchMock).toHaveBeenCalledWith("editor:dropImageAsLayer", {
      captureId: "cap_v2",
      filePath: "/tmp/x.png",
      positionXn: 0.5,
      positionYn: 0.5
    });
    expect(dropped).toEqual(["dropped_id"]);
  });

  test("v2: dispatch error surfaces via onError", async () => {
    dispatchMock.mockResolvedValue({
      ok: false,
      error: {
        kind: "validation",
        code: "unsafe_symlink",
        message: "x"
      }
    });
    const errors: { code: string }[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onError: (e) => errors.push({ code: e.code })
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("x.png", "image/png", "/tmp/x.png")]
    );
    await hook.onDrop(event);
    expect(errors).toEqual([{ code: "unsafe_symlink" }]);
  });
});
