// Focused plumbing coverage for selected-window titles on
// `capture:interactive`. Heavy Electron/native/persistence dependencies are
// mocked; the real handler and source-app resolver decide what crosses the
// `persistCaptureFromTempV2` boundary.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";
import type { WindowInfo } from "../../capture/window-list";

const mocks = vi.hoisted(() => ({
  pickRegion: vi.fn(),
  getLastWindowListSnapshot: vi.fn(),
  hideSelector: vi.fn(),
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
  hideSelector: mocks.hideSelector
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
  setFloatOverState: mocks.setFloatOverState
}));

vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: () => undefined,
  setTrayCountdown: () => undefined
}));

vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  scheduleDockReclaim: () => undefined
}));

vi.mock("../codex-handlers", () => ({
  maybeEnqueueCaptureEnrichment: () => undefined
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertCapture: () => undefined
}));

vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: async () => "",
  putCaptureSource: async () => ({})
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
      { mode: "window" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.captureWindow).toHaveBeenCalledWith(42);
    expect(mocks.listWindows).toHaveBeenCalledTimes(1);
    expect(mocks.persistCaptureFromTempV2).toHaveBeenCalledTimes(1);
    const persistArgs = mocks.persistCaptureFromTempV2.mock.calls[0]?.[0];
    expect(persistArgs).toEqual(
      expect.objectContaining({
        tempPath: "/tmp/captured-window.png",
        outputDir: "/captures",
        sourceApp: {
          bundleId: "com.example.editor",
          appName: "Example Editor"
        }
      })
    );
    expect(persistArgs?.sourceWindowTitle).toBe(liveTitle);
  });

  test("passes null when the selected id vanished before the live lookup", async () => {
    mocks.listWindows.mockResolvedValue([]);

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.listWindows).toHaveBeenCalledTimes(1);
    expect(
      mocks.persistCaptureFromTempV2.mock.calls[0]?.[0]?.sourceWindowTitle
    ).toBeNull();
  });
});
