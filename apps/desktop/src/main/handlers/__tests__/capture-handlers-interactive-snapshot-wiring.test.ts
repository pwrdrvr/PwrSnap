import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CaptureRecord } from "@pwrsnap/shared";

const captureRecord = {
  id: "cap_1",
  kind: "image",
  width_px: 640,
  height_px: 480,
  byte_size: 4096,
  bundle_format_version: 2,
  source_app_bundle_id: null,
  source_app_name: null,
  deleted_at: null
} as unknown as CaptureRecord;

const mocks = vi.hoisted(() => ({
  pickRegion: vi.fn(),
  hideSelector: vi.fn(),
  captureWindow: vi.fn(),
  getSnapshot: vi.fn(),
  cropRegisteredSnapshot: vi.fn(),
  releaseSnapshot: vi.fn(async () => undefined),
  sharp: vi.fn(),
  persistCaptureFromTempV2: vi.fn(),
  setFloatOverState: vi.fn(),
  ensureCapturesDirReady: vi.fn(async () => null),
  guardScreenCapture: vi.fn(async () => null),
  findMainLibraryWindow: vi.fn()
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
        id: 9,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      }
    ],
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ id: 9 })
  },
  BrowserWindow: {
    fromId: () => null,
    getAllWindows: () => [],
    getFocusedWindow: () => null
  },
  dialog: { showSaveDialog: vi.fn() }
}));

vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async () => "/tmp/pwrsnap-test"),
  readFile: vi.fn(async () => Buffer.alloc(0)),
  unlink: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined)
}));

vi.mock("sharp", () => ({ default: mocks.sharp }));

vi.mock("../../capture/region-selector", () => ({
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: () => [],
  hideSelector: mocks.hideSelector
}));

vi.mock("../../capture/screencapture", () => ({
  captureRegion: vi.fn(),
  captureScreen: vi.fn(),
  captureWindow: mocks.captureWindow
}));

vi.mock("../../capture/screen-snapshot", () => ({
  getSnapshot: mocks.getSnapshot,
  cropRegisteredSnapshot: mocks.cropRegisteredSnapshot,
  releaseSnapshot: mocks.releaseSnapshot
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: mocks.guardScreenCapture
}));

vi.mock("../../capture/capture-storage-gate", () => {
  class CapturesLocationFallbackError extends Error {
    pwrSnapError = { kind: "capture", code: "storage", message: "storage" };
  }
  return {
    CapturesLocationFallbackError,
    ensureCapturesDirReady: mocks.ensureCapturesDirReady,
    runWithCapturesDirFallback: async (fn: (dir: string) => unknown) => fn("/captures")
  };
});

vi.mock("../../capture/window-list", () => ({
  findWindowAt: () => null,
  resolveWindowListHelperPath: () => null
}));

vi.mock("../../capture/source-app", () => ({
  resolveSelectionSourceApp: () => null,
  resolveSourceAppByRect: () => null
}));

vi.mock("../../capture/cursor-sample", () => ({
  resolveCursorLayerForRect: vi.fn(async () => undefined),
  sampleCursor: vi.fn(async () => null)
}));

vi.mock("../../events", () => ({ broadcastCapturesChanged: vi.fn() }));
vi.mock("../../float-over", () => ({ setFloatOverState: mocks.setFloatOverState }));
vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: vi.fn(),
  setTrayCountdown: vi.fn()
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: mocks.findMainLibraryWindow,
  scheduleDockReclaim: vi.fn()
}));
vi.mock("../codex-handlers", () => ({ maybeEnqueueCaptureEnrichment: vi.fn() }));
vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null,
  insertCapture: vi.fn()
}));
vi.mock("../../persistence/source-store", () => ({
  ensureEffectiveSrcPath: vi.fn(),
  putCaptureSource: vi.fn()
}));
vi.mock("../../persistence/bundle-store", () => ({
  persistCaptureFromTempV2: mocks.persistCaptureFromTempV2
}));
vi.mock("../../persistence/enrichment-repo", () => ({ getCaptureEnrichment: () => null }));
vi.mock("../../render/coordinator", () => ({ renderViaCoordinator: vi.fn() }));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: vi.fn() }));
vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: vi.fn(),
  targetWidthForImagePreset: () => 1200
}));
vi.mock("../settings-handlers", () => ({
  getActiveExportStrategy: async () => "balanced",
  readDesktopSettings: vi.fn(async () => ({
    recording: { imageCaptureCursor: false }
  }))
}));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");
registerCaptureHandlers();

const successCrop = {
  ok: true as const,
  tempPath: "/tmp/cropped.png",
  displayId: 9,
  timings: {
    cropMs: 1,
    pngEncodeMs: 2,
    writeMs: 3,
    totalMs: 6,
    outputByteSize: 4096,
    physicalRect: { x: 10, y: 20, width: 300, height: 200 }
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guardScreenCapture.mockResolvedValue(null);
  mocks.ensureCapturesDirReady.mockResolvedValue(null);
  mocks.findMainLibraryWindow.mockReturnValue(null);
  mocks.sharp.mockReturnValue({
    metadata: vi.fn(async () => ({ width: 1920, height: 1080 })),
    extract: vi.fn(() => ({
      png: vi.fn(() => ({ toFile: vi.fn(async () => undefined) }))
    }))
  });
  mocks.getSnapshot.mockReturnValue({
    kind: "memory",
    id: "snapshot-memory",
    displayId: 9,
    mode: "region",
    timing: {}
  });
  mocks.cropRegisteredSnapshot.mockResolvedValue(successCrop);
  mocks.captureWindow.mockResolvedValue({
    ok: true,
    tempPath: "/tmp/window.png",
    displayId: 9
  });
  mocks.persistCaptureFromTempV2.mockResolvedValue({ record: captureRecord });
});

describe("capture:interactive snapshot production wiring", () => {
  test("consumes a Windows memory snapshot and releases it exactly once", async () => {
    mocks.pickRegion.mockResolvedValue({
      ok: true,
      rect: { x: 10, y: 20, w: 300, h: 200 },
      displayId: 9,
      screenSnapshotId: "snapshot-memory",
      previousAppPid: null
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "region" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.getSnapshot).toHaveBeenCalledWith("snapshot-memory");
    expect(mocks.cropRegisteredSnapshot).toHaveBeenCalledWith(
      "snapshot-memory",
      { x: 10, y: 20, w: 300, h: 200 },
      9
    );
    expect(mocks.persistCaptureFromTempV2).toHaveBeenCalledWith(
      expect.objectContaining({ tempPath: "/tmp/cropped.png" })
    );
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snapshot-memory");
  });

  test("routes a registered file snapshot through the legacy sharp crop", async () => {
    mocks.getSnapshot.mockReturnValue({
      kind: "file",
      id: "snapshot-file",
      filePath: "/tmp/frozen.png",
      displayId: 9,
      timing: null
    });
    mocks.pickRegion.mockResolvedValue({
      ok: true,
      rect: { x: 10, y: 20, w: 300, h: 200 },
      displayId: 9,
      screenSnapshotId: "snapshot-file",
      previousAppPid: null
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "region" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.sharp).toHaveBeenCalledWith("/tmp/frozen.png");
    expect(mocks.cropRegisteredSnapshot).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("snapshot-file");
  });

  test("releases a full-window preview without trying to crop it", async () => {
    mocks.pickRegion.mockResolvedValue({
      ok: true,
      rect: { x: 100, y: 100, w: 800, h: 600 },
      displayId: 9,
      snappedWindowId: 4242,
      fullWindow: true,
      screenSnapshotId: "window-preview",
      previousAppPid: null
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(mocks.captureWindow).toHaveBeenCalledWith(4242);
    expect(mocks.getSnapshot).not.toHaveBeenCalled();
    expect(mocks.cropRegisteredSnapshot).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("window-preview");
  });

  test("releases a transferred memory snapshot once when crop fails", async () => {
    mocks.pickRegion.mockResolvedValue({
      ok: true,
      rect: { x: 10, y: 20, w: 300, h: 200 },
      displayId: 9,
      screenSnapshotId: "snapshot-memory",
      previousAppPid: null
    });
    mocks.cropRegisteredSnapshot.mockResolvedValue({
      ok: false,
      reason: "error",
      message: "encode failed"
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "region" },
      { principal: "ipc" }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "error" } });
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.persistCaptureFromTempV2).not.toHaveBeenCalled();
  });

  test("leaves snapshot ownership with the selector on cancel", async () => {
    mocks.pickRegion.mockResolvedValue({
      ok: false,
      reason: "cancelled",
      previousAppPid: 5555
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "window" },
      { principal: "ipc" }
    );

    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(mocks.releaseSnapshot).not.toHaveBeenCalled();
    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
  });
});
