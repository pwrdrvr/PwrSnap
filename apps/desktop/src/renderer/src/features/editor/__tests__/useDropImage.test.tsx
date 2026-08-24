// Tests for useDropImage — Phase 5 Finder drag-drop handler.
//
// Asserts:
//   • onDragOver sets dropEffect + isDragOver when dataTransfer has Files
//   • onDragOver no-ops when no files (text drag)
//   • onDrop ignores non-image files (drop_not_image error)
//   • Windows MIME-empty HEIC/AVIF-style files reach main's decoder
//   • onDrop ignores missing file paths (drop_path_unavailable error)
//   • v1 capture refuses without dispatching (v1_capture_use_v2)
//   • v2 capture: dispatches editor:dropImageAsLayer with normalized
//     position computed from clientX/Y vs the canvas getBoundingClientRect
//   • handler error surfaces via onError

import {
  act,
  createElement,
  forwardRef,
  useImperativeHandle,
  useRef
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dispatchMock = vi.fn();

vi.mock("../../../lib/pwrsnap", () => ({
  dispatch: (...args: unknown[]) => dispatchMock(...args)
}));

const { DROP_IMAGE_MAX_FILES, cascadedDropPosition, useDropImage } = await import(
  "../useDropImage"
);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const filePaths = new WeakMap<File, string>();
const getPathForFileMock = vi.fn((file: File) => filePaths.get(file) ?? "");

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  dispatchMock.mockReset();
  getPathForFileMock.mockClear();
  mountedHandle = null;
  window.pwrsnapApi = {
    getPathForFile: getPathForFileMock
  } as unknown as NonNullable<Window["pwrsnapApi"]>;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  mountedHandle = null;
  delete window.pwrsnapApi;
});

interface HookHandle {
  onDragOver: (e: React.DragEvent<HTMLElement>) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLElement>) => Promise<void>;
  isDragOver: boolean;
  isImporting: boolean;
  progress: {
    requestedCount: number;
    attemptedCount: number;
    processedCount: number;
    importedCount: number;
    failedCount: number;
    truncatedCount: number;
  } | null;
}

const HookHost = forwardRef<
  HookHandle,
  {
    captureId: string;
    bundleFormatVersion: number;
    canvasEl?: HTMLElement | null;
    onError?: (e: { kind: string; code: string; message: string }) => void;
    onDropped?: (id: string) => void;
    onCompleted?: (summary: {
      requestedCount: number;
      attemptedCount: number;
      importedLayerIds: string[];
      failures: Array<{
        fileIndex: number;
        fileName: string;
        error: { kind: string; code: string; message: string };
      }>;
      truncatedCount: number;
    }) => void;
  }
>(function HookHost(props, ref) {
  const hook = useDropImage(props);
  const liveHookRef = useRef(hook);
  liveHookRef.current = hook;
  useImperativeHandle(ref, () => ({
    onDragOver: (event) => liveHookRef.current.onDragOver(event),
    onDragLeave: () => liveHookRef.current.onDragLeave(),
    onDrop: async (event) => await liveHookRef.current.onDrop(event),
    get isDragOver() {
      return liveHookRef.current.isDragOver;
    },
    get isImporting() {
      return liveHookRef.current.isImporting;
    },
    get progress() {
      return liveHookRef.current.progress;
    }
  }), []);
  return null;
});

let mountedHandle: HookHandle | null = null;

async function renderHook(
  props: React.ComponentProps<typeof HookHost>
): Promise<HookHandle> {
  await act(async () => {
    root!.render(
      createElement(HookHost, {
        ...props,
        ref: (handle: HookHandle | null) => {
          mountedHandle = handle;
        }
      })
    );
  });
  if (mountedHandle === null) throw new Error("hook handle never set");
  return mountedHandle;
}

async function mountHook(
  props: React.ComponentProps<typeof HookHost>
): Promise<HookHandle> {
  return await renderHook(props);
}

function makeFile(name: string, type: string, path: string | null): File {
  const f = new File([new Uint8Array([0x89])], name, { type });
  if (path !== null) {
    filePaths.set(f, path);
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useDropImage", () => {
  test("all 16 cascade slots stay clamped and visually distinct at an edge", () => {
    const positions = Array.from({ length: DROP_IMAGE_MAX_FILES }, (_, index) =>
      cascadedDropPosition(1, 1, index)
    );
    expect(
      new Set(positions.map(({ positionXn, positionYn }) => `${positionXn},${positionYn}`))
        .size
    ).toBe(DROP_IMAGE_MAX_FILES);
    for (const position of positions) {
      expect(position.positionXn).toBeGreaterThanOrEqual(0);
      expect(position.positionXn).toBeLessThanOrEqual(1);
      expect(position.positionYn).toBeGreaterThanOrEqual(0);
      expect(position.positionYn).toBeLessThanOrEqual(1);
    }
  });

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

  test("Windows empty-MIME image extension defers to main decoder", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "heic_id" } });
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2
    });
    const event = makeDragEvent(
      ["Files"],
      [makeFile("phone.HEIC", "", "C:\\Users\\tester\\phone.HEIC")]
    );

    await hook.onDrop(event);

    expect(dispatchMock).toHaveBeenCalledWith("editor:dropImageAsLayer", {
      captureId: "cap_v2",
      filePath: "C:\\Users\\tester\\phone.HEIC"
    });
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
    expect(getPathForFileMock).toHaveBeenCalledWith(event.dataTransfer.files[0]);
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

  test("multi-file drop imports sequentially and reports exact completion", async () => {
    let activeDispatches = 0;
    let maxActiveDispatches = 0;
    dispatchMock.mockImplementation(async (_name: string, req: { filePath: string }) => {
      activeDispatches += 1;
      maxActiveDispatches = Math.max(maxActiveDispatches, activeDispatches);
      await Promise.resolve();
      activeDispatches -= 1;
      return { ok: true, value: { layerId: req.filePath.endsWith("a.png") ? "a" : "b" } };
    });
    const completed: unknown[] = [];
    const dropped: string[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onDropped: (id) => dropped.push(id),
      onCompleted: (summary) => completed.push(summary)
    });
    const event = makeDragEvent(
      ["Files"],
      [
        makeFile("a.png", "image/png", "/tmp/a.png"),
        makeFile("b.png", "image/png", "/tmp/b.png")
      ]
    );

    await hook.onDrop(event);

    expect(maxActiveDispatches).toBe(1);
    expect(dropped).toEqual(["a", "b"]);
    expect(completed).toEqual([
      {
        requestedCount: 2,
        attemptedCount: 2,
        importedLayerIds: ["a", "b"],
        failures: [],
        truncatedCount: 0
      }
    ]);
    const requests = dispatchMock.mock.calls.map((call) => call[1]) as Array<{
      positionXn: number;
      positionYn: number;
    }>;
    expect(requests[0]).toMatchObject({ positionXn: 0.5, positionYn: 0.5 });
    expect(requests[1]).toMatchObject({ positionXn: 0.54, positionYn: 0.5 });
  });

  test("blocks a concurrent gesture while the whole first drop is active", async () => {
    const firstResult = deferred<{
      ok: true;
      value: { layerId: string };
    }>();
    dispatchMock
      .mockImplementationOnce(async () => await firstResult.promise)
      .mockResolvedValue({ ok: true, value: { layerId: "second-from-first" } });
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2
    });
    const firstGesture = makeDragEvent(
      ["Files"],
      [
        makeFile("a.png", "image/png", "/tmp/a.png"),
        makeFile("b.png", "image/png", "/tmp/b.png")
      ]
    );
    const blockedGesture = makeDragEvent(
      ["Files"],
      [makeFile("blocked.png", "image/png", "/tmp/blocked.png")]
    );

    let firstDrop!: Promise<void>;
    act(() => {
      firstDrop = hook.onDrop(firstGesture);
    });
    await act(async () => await Promise.resolve());
    expect(hook.isImporting).toBe(true);
    await hook.onDrop(blockedGesture);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    firstResult.resolve({ ok: true, value: { layerId: "first-from-first" } });
    await act(async () => await firstDrop);

    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls.map((call) => call[1].filePath)).toEqual([
      "/tmp/a.png",
      "/tmp/b.png"
    ]);
    expect(hook.isImporting).toBe(false);
  });

  test("publishes exact progress and partial failure counts during a batch", async () => {
    const firstResult = deferred<{
      ok: true;
      value: { layerId: string };
    }>();
    const secondResult = deferred<{
      ok: false;
      error: { kind: "render"; code: string; message: string };
    }>();
    dispatchMock
      .mockImplementationOnce(async () => await firstResult.promise)
      .mockImplementationOnce(async () => await secondResult.promise);
    const completed: unknown[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onCompleted: (summary) => completed.push(summary)
    });
    let dropPromise!: Promise<void>;
    act(() => {
      dropPromise = hook.onDrop(
        makeDragEvent(
          ["Files"],
          [
            makeFile("good.png", "image/png", "/tmp/good.png"),
            makeFile("bad.svg", "image/svg+xml", "/tmp/bad.svg")
          ]
        )
      );
    });
    await act(async () => await Promise.resolve());
    expect(hook.progress).toEqual({
      requestedCount: 2,
      attemptedCount: 2,
      processedCount: 0,
      importedCount: 0,
      failedCount: 0,
      truncatedCount: 0
    });

    firstResult.resolve({ ok: true, value: { layerId: "good" } });
    await act(async () => {
      await firstResult.promise;
      await Promise.resolve();
    });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(hook.progress).toMatchObject({
      processedCount: 1,
      importedCount: 1,
      failedCount: 0
    });

    secondResult.resolve({
      ok: false,
      error: {
        kind: "render",
        code: "image_unsupported_format",
        message: "Unsupported image format"
      }
    });
    await act(async () => await dropPromise);
    expect(hook.isImporting).toBe(false);
    expect(completed).toEqual([
      expect.objectContaining({
        requestedCount: 2,
        importedLayerIds: ["good"],
        failures: [
          expect.objectContaining({
            fileIndex: 1,
            fileName: "bad.svg",
            error: expect.objectContaining({ code: "image_unsupported_format" })
          })
        ]
      })
    ]);
  });

  test("capture switch aborts the old generation before another file dispatch", async () => {
    const oldResult = deferred<{
      ok: true;
      value: { layerId: string };
    }>();
    dispatchMock.mockImplementationOnce(async () => await oldResult.promise);
    const dropped: string[] = [];
    const completed: unknown[] = [];
    const callbacks = {
      onDropped: (id: string) => dropped.push(id),
      onCompleted: (summary: Parameters<NonNullable<React.ComponentProps<typeof HookHost>["onCompleted"]>>[0]) =>
        completed.push(summary)
    };
    const hook = await mountHook({
      captureId: "cap_old",
      bundleFormatVersion: 2,
      ...callbacks
    });
    let oldDrop!: Promise<void>;
    act(() => {
      oldDrop = hook.onDrop(
        makeDragEvent(
          ["Files"],
          [
            makeFile("old-a.png", "image/png", "/tmp/old-a.png"),
            makeFile("old-b.png", "image/png", "/tmp/old-b.png")
          ]
        )
      );
    });
    await act(async () => await Promise.resolve());
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    await renderHook({
      captureId: "cap_new",
      bundleFormatVersion: 2,
      ...callbacks
    });
    expect(hook.isImporting).toBe(true);
    // The replacement record stays blocked until the already-issued command
    // settles; it cannot create a second concurrent loop.
    await hook.onDrop(
      makeDragEvent(
        ["Files"],
        [makeFile("new-blocked.png", "image/png", "/tmp/new-blocked.png")]
      )
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    oldResult.resolve({ ok: true, value: { layerId: "old-result" } });
    await act(async () => await oldDrop);
    expect(hook.isImporting).toBe(false);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
    expect(completed).toEqual([]);

    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "new-result" } });
    await hook.onDrop(
      makeDragEvent(
        ["Files"],
        [makeFile("new.png", "image/png", "/tmp/new.png")]
      )
    );
    expect(dispatchMock).toHaveBeenLastCalledWith("editor:dropImageAsLayer", {
      captureId: "cap_new",
      filePath: "/tmp/new.png"
    });
  });

  test("unmount aborts callbacks and prevents the rest of the batch", async () => {
    const pending = deferred<{ ok: true; value: { layerId: string } }>();
    dispatchMock.mockImplementationOnce(async () => await pending.promise);
    const dropped: string[] = [];
    const completed: unknown[] = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onDropped: (id) => dropped.push(id),
      onCompleted: (summary) => completed.push(summary)
    });
    let dropPromise!: Promise<void>;
    act(() => {
      dropPromise = hook.onDrop(
        makeDragEvent(
          ["Files"],
          [
            makeFile("a.png", "image/png", "/tmp/a.png"),
            makeFile("b.png", "image/png", "/tmp/b.png")
          ]
        )
      );
    });
    await act(async () => await Promise.resolve());
    act(() => root!.unmount());
    root = null;
    pending.resolve({ ok: true, value: { layerId: "late" } });
    await dropPromise;

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dropped).toEqual([]);
    expect(completed).toEqual([]);
  });

  test("multi-file partial result never implies every file landed", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "image" } });
    const errors: string[] = [];
    const completed: Array<{ requestedCount: number; importedLayerIds: string[] }> = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onError: (error) => errors.push(error.code),
      onCompleted: (summary) => completed.push(summary)
    });
    const event = makeDragEvent(
      ["Files"],
      [
        makeFile("notes.txt", "text/plain", "/tmp/notes.txt"),
        makeFile("image.avif", "", "/tmp/image.avif")
      ]
    );

    await hook.onDrop(event);

    expect(errors).toEqual([]);
    expect(completed).toEqual([
      {
        requestedCount: 2,
        attemptedCount: 2,
        importedLayerIds: ["image"],
        failures: [
          {
            fileIndex: 0,
            fileName: "notes.txt",
            error: {
              kind: "validation",
              code: "drop_not_image",
              message: "Only image files supported"
            }
          }
        ],
        truncatedCount: 0
      }
    ]);
  });

  test("multi-file drop caps attempted files and reports truncation", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { layerId: "layer" } });
    const completed: Array<{
      requestedCount: number;
      attemptedCount: number;
      importedLayerIds: string[];
      truncatedCount: number;
    }> = [];
    const hook = await mountHook({
      captureId: "cap_v2",
      bundleFormatVersion: 2,
      onCompleted: (summary) => completed.push(summary)
    });
    const files = Array.from({ length: DROP_IMAGE_MAX_FILES + 3 }, (_, index) =>
      makeFile(`image-${index}.png`, "image/png", `/tmp/image-${index}.png`)
    );

    await hook.onDrop(makeDragEvent(["Files"], files));

    expect(dispatchMock).toHaveBeenCalledTimes(DROP_IMAGE_MAX_FILES);
    expect(completed[0]).toMatchObject({
      requestedCount: DROP_IMAGE_MAX_FILES + 3,
      attemptedCount: DROP_IMAGE_MAX_FILES,
      truncatedCount: 3
    });
    expect(completed[0]?.importedLayerIds).toHaveLength(DROP_IMAGE_MAX_FILES);
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
