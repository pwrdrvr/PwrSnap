// Focused plumbing coverage for selected-window titles on
// `capture:interactive`. Heavy Electron/native/persistence dependencies are
// mocked; the real handler and source-app resolver decide what crosses the
// `persistCaptureFromTempV2` boundary.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  broadcastCapturesChanged: vi.fn()
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
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2
      }
    ]
  },
  BrowserWindow: {
    fromId: () => null,
    getAllWindows: () => [],
    getFocusedWindow: () => null
  },
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}));

vi.mock("sharp", () => ({ default: vi.fn() }));

vi.mock("node:fs/promises", () => ({
  copyFile: async () => undefined,
  mkdtemp: async () => "/tmp/pwrsnap-window-title-test",
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
  releaseSnapshot: mocks.releaseSnapshot
}));

vi.mock("../../capture/window-list", () => ({
  listWindows: mocks.listWindows,
  findWindowAt: () => null,
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

const snapshotWindow: WindowInfo = {
  windowId: 42,
  pid: 7001,
  bundleId: "com.example.editor",
  appName: "Example Editor",
  title: "Roadmap — selector snapshot",
  bounds: { x: 100, y: 120, width: 900, height: 640 },
  layer: 0,
  alpha: 1,
  isFrontmostInApp: true
};

const selection = {
  windowListSnapshot: [snapshotWindow],
  selectorInvocationId: 23,
  ok: true as const,
  rect: { x: 100, y: 120, w: 900, h: 640 },
  displayId: 1,
  screenSnapshotPath: "/tmp/selector-snapshot.png",
  screenSnapshotId: "snapshot-1",
  previousAppPid: 7001,
  snappedWindowId: 42,
  fullWindow: true
};

const persistedRecord: CaptureRecord = {
  id: "cap_window_title",
  kind: "image",
  captured_at: "2026-08-23T18:00:00.000Z",
  legacy_src_path: null,
  bundle_path: "/captures/cap_window_title.pwrsnap",
  flat_png_path: "/captures/cap_window_title.png",
  bundle_modified_at: null,
  bundle_format_version: 2,
  bundle_edits_version: 0,
  width_px: 1800,
  height_px: 1280,
  device_pixel_ratio: 2,
  byte_size: 42_000,
  sha256: "sha-window-title",
  source_app_bundle_id: "com.example.editor",
  source_app_name: "Example Editor",
  source_window_title: null,
  edits_version: 0,
  deleted_at: null,
  has_alpha: false,
  video: null
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSelectorInvocationCurrent.mockReturnValue(true);
  mocks.findMainLibraryWindow.mockReturnValue(null);
  mocks.guardScreenCapture.mockResolvedValue(null);
  mocks.ensureCapturesDirReady.mockResolvedValue(null);
  mocks.pickRegion.mockResolvedValue(selection);
  mocks.getLastWindowListSnapshot.mockReturnValue([snapshotWindow]);
  mocks.captureWindow.mockResolvedValue({
    ok: true,
    tempPath: "/tmp/captured-window.png",
    displayId: 1
  });
  mocks.runWithCapturesDirFallback.mockImplementation(
    async (operation: (outputDir: string) => Promise<unknown>) =>
      operation("/captures")
  );
  mocks.persistCaptureFromTempV2.mockImplementation(
    async (args: { sourceWindowTitle?: string | null }) => ({
      record: {
        ...persistedRecord,
        source_window_title: args.sourceWindowTitle ?? null
      }
    })
  );
});

describe("capture:interactive selected-window title", () => {
  test("passes the exact live title to window-capture persistence", async () => {
    const liveTitle = "Roadmap — 東京 🚀 (live title)";
    mocks.listWindows.mockResolvedValue([
      { ...snapshotWindow, title: liveTitle }
    ]);

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window", invocation: createCaptureInvocation({ id: "title-live", origin: "global_hotkey.quick_capture", monotonicNow: () => 0 }) },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.hideSelector).toHaveBeenCalledExactlyOnceWith(23);
    expect(mocks.captureWindow).toHaveBeenCalledWith(42);
    expect(mocks.listWindows).toHaveBeenCalledTimes(1);
    expect(mocks.persistCaptureFromTempV2).toHaveBeenCalledTimes(1);
    const persistArgs = mocks.persistCaptureFromTempV2.mock.calls[0]?.[0];
    expect(persistArgs).toEqual(
      expect.objectContaining({
        tempPath: "/tmp/captured-window.png",
        sourceApp: {
          bundleId: "com.example.editor",
          appName: "Example Editor"
        }
      })
    );
    expect(persistArgs?.sourceWindowTitle).toBe(liveTitle);
    // Persistence prepares bytes before invoking this root-lock/fallback guard.
    expect(mocks.persistCaptureFromTempV2.mock.calls[0]?.[1]).toBe(mocks.runWithCapturesDirFallback);
  });

  test("passes null when the selected id vanished before the live lookup", async () => {
    mocks.listWindows.mockResolvedValue([]);

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window", invocation: createCaptureInvocation({ id: "title-missing", origin: "global_hotkey.quick_capture", monotonicNow: () => 0 }) },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.hideSelector).toHaveBeenCalledExactlyOnceWith(23);
    expect(mocks.listWindows).toHaveBeenCalledTimes(1);
    expect(
      mocks.persistCaptureFromTempV2.mock.calls[0]?.[0]?.sourceWindowTitle
    ).toBeNull();
  });

  test("a committed image keeps its original source and title provenance after the shared window list changes", async () => {
    mocks.getLastWindowListSnapshot.mockReturnValue([{ ...snapshotWindow, pid: 9999, appName: "Newer App", bundleId: "example.newer" }]);
    mocks.listWindows.mockResolvedValue([{ ...snapshotWindow, title: "Original window — live title" }]);
    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window", invocation: createCaptureInvocation({ id: "image-provenance", origin: "global_hotkey.quick_capture", monotonicNow: () => 0 }) },
      { principal: "ipc" }
    );
    expect(result.ok).toBe(true);
    expect(mocks.persistCaptureFromTempV2.mock.calls[0]?.[0]).toMatchObject({
      sourceApp: { appName: "Example Editor", bundleId: "com.example.editor" },
      sourceWindowTitle: "Original window — live title"
    });
  });

  test("cancellation cleanup carries the selector invocation token after the compositor wait", async () => {
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled", selectorInvocationId: 24 });
    await bus.dispatch(
      "capture:interactive",
      { mode: "window", invocation: createCaptureInvocation({ id: "cancel-token", origin: "global_hotkey.quick_capture", monotonicNow: () => 0 }) },
      { principal: "ipc" }
    );
    expect(mocks.hideSelector).toHaveBeenCalledExactlyOnceWith(24);
  });
});


describe("cancelled selector continuation ownership", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function cancellation() {
    return bus.dispatch(
      "capture:interactive",
      { mode: "window", invocation: createCaptureInvocation({ id: "cancel-ownership", origin: "global_hotkey.quick_capture", monotonicNow: () => 0 }) },
      { principal: "ipc" }
    );
  }

  function library() {
    const win = { isDestroyed: () => false, isMinimized: () => true, isVisible: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
    mocks.findMainLibraryWindow.mockReturnValue(win);
    return win;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  }

  test("a superseded cancellation cannot restore the dock or focus the Library during the successor's snapshot", async () => {
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled", selectorInvocationId: 24 });
    mocks.isSelectorInvocationCurrent.mockReturnValue(false);
    const win = library();
    const result = cancellation();
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(mocks.setFloatOverState).not.toHaveBeenCalled();
    expect(mocks.hideSelector).not.toHaveBeenCalled();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(mocks.scheduleDockReclaim).not.toHaveBeenCalled();
  });

  test("supersession during the compositor wait suppresses every remaining cancellation effect", async () => {
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled", selectorInvocationId: 24 });
    const win = library();
    const result = cancellation();
    await flush();
    expect(mocks.setFloatOverState).toHaveBeenCalledExactlyOnceWith({ kind: "cancel" });
    mocks.isSelectorInvocationCurrent.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(mocks.hideSelector).not.toHaveBeenCalled();
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(mocks.scheduleDockReclaim).not.toHaveBeenCalled();
  });

  test("a current cancellation parks chrome before the wait and restores focus only after hiding its selector", async () => {
    mocks.pickRegion.mockResolvedValue({ ok: false, reason: "cancelled", selectorInvocationId: 24 });
    const win = library();
    const result = cancellation();
    await flush();
    expect(mocks.setFloatOverState).toHaveBeenCalledExactlyOnceWith({ kind: "cancel" });
    expect(mocks.hideSelector).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await result;
    expect(mocks.hideSelector).toHaveBeenCalledExactlyOnceWith(24);
    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.focus.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.hideSelector.mock.invocationCallOrder[0]!);
    expect(mocks.scheduleDockReclaim).toHaveBeenCalledOnce();
  });
});
