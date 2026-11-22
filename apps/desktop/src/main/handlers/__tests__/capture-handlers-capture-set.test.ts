// `capture:interactive` with a capture SET (the selector's "Separate"
// output shape): one ordinary capture per pick. Electron, sharp, the
// snapshot store and persistence are faked; the real handler, set
// planner and source-app resolver decide what crosses the
// `persistCaptureFromTempV2` boundary and in what order.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";
import { createCaptureInvocation } from "@pwrsnap/shared";
import type { WindowInfo } from "../../capture/window-list";

const mocks = vi.hoisted(() => ({
  pickRegion: vi.fn(),
  getLastWindowListSnapshot: vi.fn(),
  hideSelector: vi.fn(),
  isSelectorInvocationCurrent: vi.fn(),
  findMainLibraryWindow: vi.fn(),
  scheduleDockReclaim: vi.fn(),
  listWindows: vi.fn(),
  captureWindow: vi.fn(),
  releaseSnapshot: vi.fn(async () => undefined),
  guardScreenCapture: vi.fn(async () => null),
  ensureCapturesDirReady: vi.fn(async () => null),
  runWithCapturesDirFallback: vi.fn(),
  persistCaptureFromTempV2: vi.fn(),
  setFloatOverState: vi.fn(),
  broadcastCapturesChanged: vi.fn(),
  acquireSnapshotRaster: vi.fn(),
  /** Every crop the fake sharp wrote: which snapshot, which box. */
  crops: [] as { snapshot: string; box: unknown; path: string }[],
  tempDirs: 0
}));

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    availableFormats: () => [],
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readText: () => "",
    writeText: () => undefined
  },
  screen: {
    // A 2× laptop panel and a 1× external to its right. Invented desk.
    getAllDisplays: () => [
      { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 2 },
      { id: 2, bounds: { x: 1440, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
    ]
  },
  BrowserWindow: {
    fromId: () => null,
    getAllWindows: () => [],
    getFocusedWindow: () => null
  },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}));

vi.mock("sharp", () => ({
  default: (input: Buffer) => {
    const state: { box?: unknown } = {};
    const chain = {
      extract(box: unknown) {
        state.box = box;
        return chain;
      },
      png() {
        return chain;
      },
      async toFile(path: string) {
        mocks.crops.push({ snapshot: input.toString(), box: state.box, path });
        return {};
      }
    };
    return chain;
  }
}));

vi.mock("node:fs/promises", () => ({
  copyFile: async () => undefined,
  mkdtemp: async () => `/tmp/pwrsnap-set-test-${(mocks.tempDirs += 1)}`,
  readFile: async () => Buffer.alloc(0),
  unlink: async () => undefined,
  writeFile: async () => undefined
}));

vi.mock("../../capture/region-selector", () => ({
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: mocks.getLastWindowListSnapshot,
  hideSelector: mocks.hideSelector,
  isSelectorInvocationCurrent: mocks.isSelectorInvocationCurrent
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureScreen: async () => ({ ok: false, reason: "validation", message: "stub" }),
  captureWindow: mocks.captureWindow
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: mocks.guardScreenCapture
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  CapturesLocationFallbackError: class CapturesLocationFallbackError extends Error {
    readonly pwrSnapError = {
      kind: "capture",
      code: "captures_dir_unavailable",
      message: "stub"
    };
  },
  ensureCapturesDirReady: mocks.ensureCapturesDirReady,
  runWithCapturesDirFallback: mocks.runWithCapturesDirFallback
}));

vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: mocks.releaseSnapshot,
  acquireSnapshotRaster: mocks.acquireSnapshotRaster
}));

vi.mock("../../capture/window-list", () => ({
  listWindows: mocks.listWindows,
  // Topmost window whose bounds hold the point — enough of the real
  // hit test for a rect-center lookup.
  findWindowAt: (windows: readonly WindowInfo[], x: number, y: number) =>
    windows.find(
      (w) =>
        x >= w.bounds.x &&
        x < w.bounds.x + w.bounds.width &&
        y >= w.bounds.y &&
        y < w.bounds.y + w.bounds.height
    ) ?? null,
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../capture/cursor-sample", () => ({
  resolveCursorLayerForRect: async () => undefined,
  sampleCursor: async () => null
}));

vi.mock("../../clipboard-image-buffer", () => ({
  clipboardImageBufferFormats: () => [],
  ingestImageBufferToTempPng: async () => ({
    tempPath: "/tmp/clipboard.png",
    devicePixelRatio: 1
  }),
  writeFirstDecodableClipboardBufferToPng: async () => ({
    ok: false,
    failures: []
  })
}));

vi.mock("../../events", () => ({
  broadcastCapturesChanged: mocks.broadcastCapturesChanged
}));

vi.mock("../../float-over", () => ({
  releaseFloatOverDock: () => undefined,
  setFloatOverState: mocks.setFloatOverState
}));

vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: () => undefined,
  setTrayCountdown: () => undefined
}));

vi.mock("../../window", () => ({
  findMainLibraryWindow: mocks.findMainLibraryWindow,
  scheduleDockReclaim: mocks.scheduleDockReclaim
}));

vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertCapture: () => undefined
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => ""
}));

vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: mocks.persistCaptureFromTempV2
}));

vi.mock("../../persistence/enrichment-repo", () => ({
  getCaptureEnrichment: () => null
}));

vi.mock("../../render/coordinator", () => ({
  renderViaCoordinator: async () => ({ cachePath: "", byteSize: 0, fromCache: false })
}));

vi.mock("../../render/file-alias", () => ({
  prepareRenderedFileAlias: async () => ""
}));

vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: async () => ({ path: "", byteSize: 0, fromCache: false }),
  targetWidthForImagePreset: () => 1
}));

vi.mock("../settings-handlers", () => ({
  getActiveExportStrategy: async () => "balanced",
  readDesktopSettings: async () => ({
    recording: { imageCaptureCursor: false }
  })
}));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers({ includeSaveAs: false });

const SNAPSHOT_SIZE: Record<string, { width: number; height: number }> = {
  "snap-laptop": { width: 2880, height: 1800 },
  "snap-external": { width: 1920, height: 1080 }
};

const editorWindow: WindowInfo = {
  windowId: 42,
  pid: 7001,
  bundleId: "com.example.editor",
  appName: "Example Editor",
  title: "Granola Recipes — selector snapshot",
  bounds: { x: 100, y: 120, width: 600, height: 400 },
  layer: 0,
  alpha: 1,
  isFrontmostInApp: true
};

const chatWindow: WindowInfo = {
  windowId: 43,
  pid: 7002,
  bundleId: "com.example.chat",
  appName: "Example Chat",
  title: "Cereal Club",
  bounds: { x: 1440, y: 0, width: 1920, height: 1080 },
  layer: 0,
  alpha: 1,
  isFrontmostInApp: true
};

// Pick #1: the editor window on the laptop. Pick #2: the whole external
// display. Committed from the laptop, so the laptop's snapshot is home.
const setSelection = {
  selectorInvocationId: 31,
  ok: true as const,
  rect: { x: 100, y: 0, w: 3260, h: 1080 },
  displayId: 1,
  screenSnapshotId: "snap-laptop",
  extraSnapshots: [{ displayId: 2, screenSnapshotId: "snap-external" }],
  windowListSnapshot: [editorWindow, chatWindow],
  previousAppPid: 7001,
  snappedWindowId: 42,
  extents: [
    { x: 100, y: 120, w: 600, h: 400 },
    { x: 1440, y: 0, w: 1920, h: 1080 }
  ],
  extentWindowIds: [42, null],
  outputMode: "set" as const
};

function record(id: string, args: { devicePixelRatio?: number }): CaptureRecord {
  return {
    id,
    kind: "image",
    captured_at: "2026-11-21T18:00:00.000Z",
    legacy_src_path: null,
    bundle_path: `/captures/${id}.pwrsnap`,
    flat_png_path: `/captures/${id}.png`,
    bundle_modified_at: null,
    bundle_format_version: 2,
    bundle_edits_version: 0,
    width_px: 100,
    height_px: 100,
    device_pixel_ratio: args.devicePixelRatio ?? 1,
    byte_size: 1000,
    sha256: `sha-${id}`,
    source_app_bundle_id: null,
    source_app_name: null,
    source_window_title: null,
    edits_version: 0,
    deleted_at: null,
    has_alpha: false,
    video: null
  };
}

function dispatchQuickCapture() {
  return bus.dispatch(
    "capture:interactive",
    {
      mode: "auto",
      invocation: createCaptureInvocation({
        id: "capture-set",
        origin: "global_hotkey.quick_capture",
        monotonicNow: () => 0
      })
    },
    { principal: "ipc" }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.crops.length = 0;
  mocks.isSelectorInvocationCurrent.mockReturnValue(true);
  mocks.findMainLibraryWindow.mockReturnValue(null);
  mocks.guardScreenCapture.mockResolvedValue(null);
  mocks.ensureCapturesDirReady.mockResolvedValue(null);
  mocks.pickRegion.mockResolvedValue(setSelection);
  mocks.getLastWindowListSnapshot.mockReturnValue([editorWindow, chatWindow]);
  mocks.listWindows.mockResolvedValue([{ ...editorWindow, title: "Granola Recipes — live" }, chatWindow]);
  mocks.acquireSnapshotRaster.mockImplementation(async (id: string) => {
    const size = SNAPSHOT_SIZE[id];
    if (size === undefined) return null;
    return {
      source: { kind: "rgba8", data: Buffer.from(id), ...size, stride: size.width * 4 },
      release: async () => undefined
    };
  });
  mocks.runWithCapturesDirFallback.mockImplementation(
    async (operation: (outputDir: string) => Promise<unknown>) => operation("/captures")
  );
  let n = 0;
  mocks.persistCaptureFromTempV2.mockImplementation(
    async (args: { devicePixelRatio?: number }) => ({
      record: record(`cap_set_${(n += 1)}`, args)
    })
  );
});

describe("capture:interactive — Separate (capture set)", () => {
  test("saves one capture per pick, in pick order, each with its own app, title and density", async () => {
    const result = await dispatchQuickCapture();

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "snap") throw new Error("expected a snap");
    expect(result.value.record.id).toBe("cap_set_1");
    expect(result.value.set?.map((r) => r.id)).toEqual(["cap_set_1", "cap_set_2"]);

    // Each item is cut from its own display's snapshot at that display's
    // scale — the window from the 2× laptop, the display from the 1×
    // external — not from one union canvas.
    expect(mocks.crops.map((c) => ({ snapshot: c.snapshot, box: c.box }))).toEqual([
      { snapshot: "snap-laptop", box: { left: 200, top: 240, width: 1200, height: 800 } },
      { snapshot: "snap-external", box: { left: 0, top: 0, width: 1920, height: 1080 } }
    ]);

    const calls = mocks.persistCaptureFromTempV2.mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      tempPath: mocks.crops[0]!.path,
      devicePixelRatio: 2,
      sourceApp: { bundleId: "com.example.editor", appName: "Example Editor" },
      sourceWindowTitle: "Granola Recipes — live"
    });
    // A whole-display pick names no window; its app resolves by rect, the
    // way a lone display pick does.
    expect(calls[1]).toMatchObject({
      tempPath: mocks.crops[1]!.path,
      devicePixelRatio: 1,
      sourceApp: { bundleId: "com.example.chat", appName: "Example Chat" },
      sourceWindowTitle: null
    });

    // The toast opens on pick #1 as soon as it is saved, before pick #2
    // is written; pick #2 is never pushed into the toast.
    const shows = mocks.setFloatOverState.mock.calls.filter((c) => c[0]?.kind === "show-loaded");
    expect(shows).toHaveLength(1);
    expect(shows[0]?.[0]).toMatchObject({ captureId: "cap_set_1" });
    const showOrder = mocks.setFloatOverState.mock.invocationCallOrder[
      mocks.setFloatOverState.mock.calls.findIndex((c) => c[0]?.kind === "show-loaded")
    ]!;
    expect(showOrder).toBeLessThan(mocks.persistCaptureFromTempV2.mock.invocationCallOrder[1]!);

    // Both frozen snapshots are released, and the selector is down
    // before anything is written.
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snap-laptop");
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snap-external");
    expect(mocks.hideSelector).toHaveBeenCalledWith(31);
    expect(mocks.hideSelector.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persistCaptureFromTempV2.mock.invocationCallOrder[0]!
    );
  });

  test("a crop that fails saves nothing — never half a set", async () => {
    mocks.acquireSnapshotRaster.mockImplementation(async (id: string) => {
      if (id === "snap-external") return null; // gone before the crop
      const size = SNAPSHOT_SIZE[id]!;
      return {
        source: { kind: "rgba8", data: Buffer.from(id), ...size, stride: size.width * 4 },
        release: async () => undefined
      };
    });

    const result = await dispatchQuickCapture();

    expect(result.ok).toBe(false);
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snap-laptop");
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snap-external");
  });

  test("a later item that fails to save is skipped; the saved ones stand", async () => {
    let n = 0;
    mocks.persistCaptureFromTempV2.mockImplementation(async (args: { devicePixelRatio?: number }) => {
      n += 1;
      if (n === 2) throw new Error("disk full");
      return { record: record(`cap_set_${n}`, args) };
    });

    const result = await dispatchQuickCapture();

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "snap") throw new Error("expected a snap");
    expect(result.value.set?.map((r) => r.id)).toEqual(["cap_set_1"]);
  });

  test("Windows mode over the same picks never fans out into a set", async () => {
    // Same picks, default shape: the one-image union path, untouched.
    // (This fake sharp cannot compose the union, so that crop fails —
    // what matters is that no per-pick crop or save happened.)
    mocks.pickRegion.mockResolvedValue({ ...setSelection, outputMode: "windows" });
    const result = await dispatchQuickCapture();
    expect(result.ok).toBe(false);
    expect(mocks.crops).toEqual([]);
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
  });
});
