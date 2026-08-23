import { beforeEach, describe, expect, test, vi } from "vitest";
import { err, ok, type QuickCaptureAction } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  quickCaptureAction: "ask" as QuickCaptureAction,
  pickRegion: vi.fn(),
  startRecording: vi.fn(),
  hideSelector: vi.fn(),
  releaseSnapshot: vi.fn(),
  captureRegion: vi.fn(),
  captureWindow: vi.fn(),
  setFloatOverState: vi.fn()
}));

const selection = {
  ok: true as const,
  action: "record" as const,
  rect: { x: 10, y: 20, w: 300, h: 200 },
  displayId: 7,
  screenSnapshotPath: "/tmp/frozen.png",
  screenSnapshotId: "snapshot-7",
  previousAppPid: 42
};

vi.mock("electron", () => ({
  clipboard: {
    readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    availableFormats: () => [],
    readBookmark: () => ({ title: "", url: "" }),
    readBuffer: () => Buffer.alloc(0),
    readText: () => "",
    writeText: () => undefined
  },
  screen: { getAllDisplays: () => [] },
  BrowserWindow: { getAllWindows: () => [] }
}));

vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("../../capture/region-selector", () => ({
  pickRegion: mocks.pickRegion,
  getLastWindowListSnapshot: () => [],
  hideSelector: mocks.hideSelector
}));
vi.mock("../../capture/screencapture", () => ({
  captureRegion: mocks.captureRegion,
  captureScreen: vi.fn(),
  captureWindow: mocks.captureWindow
}));
vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: vi.fn().mockResolvedValue(null)
}));
vi.mock("../../capture/capture-storage-gate", () => {
  class CapturesLocationFallbackError extends Error {
    pwrSnapError = { kind: "capture", code: "fallback", message: "fallback" };
  }
  return {
    CapturesLocationFallbackError,
    ensureCapturesDirReady: vi.fn().mockResolvedValue(null),
    runWithCapturesDirFallback: vi.fn()
  };
});
vi.mock("../../capture/screen-snapshot", () => ({
  releaseSnapshot: mocks.releaseSnapshot
}));
vi.mock("../../capture/window-list", () => ({
  findWindowAt: () => null,
  resolveWindowListHelperPath: () => null
}));
vi.mock("../../capture/source-app", () => ({
  resolveSelectionSourceApp: () => null,
  resolveSourceAppByRect: () => null
}));
vi.mock("../../capture/cursor-sample", () => ({
  resolveCursorLayerForRect: vi.fn().mockResolvedValue(undefined),
  sampleCursor: vi.fn().mockResolvedValue(null)
}));
vi.mock("../../clipboard-image-buffer", () => ({
  clipboardImageBufferFormats: () => [],
  ingestImageBufferToTempPng: vi.fn(),
  writeFirstDecodableClipboardBufferToPng: vi.fn()
}));
vi.mock("../../events", () => ({ broadcastCapturesChanged: vi.fn() }));
vi.mock("../../float-over", () => ({ setFloatOverState: mocks.setFloatOverState }));
vi.mock("../../tray", () => ({
  hideTrayPopoverIfVisible: vi.fn(),
  setTrayCountdown: vi.fn()
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
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
vi.mock("../../persistence/bundle-store", () => ({ persistCaptureFromTempV2: vi.fn() }));
vi.mock("../../render/coordinator", () => ({ renderViaCoordinator: vi.fn() }));
vi.mock("../../render/file-alias", () => ({ prepareRenderedFileAlias: vi.fn() }));
vi.mock("../../render/export-filename", () => ({ buildPresetExportDisplayName: vi.fn() }));
vi.mock("../../render/image-presets", () => ({
  resolveImagePresetFile: vi.fn(),
  targetWidthForImagePreset: vi.fn()
}));
vi.mock("../settings-handlers", () => ({
  getActiveExportStrategy: vi.fn(),
  readDesktopSettings: vi.fn(async () => ({
    recording: {
      quickCaptureAction: mocks.quickCaptureAction,
      imageCaptureCursor: false,
      videoCaptureCursor: true,
      includeSystemAudio: false,
      includeMicrophone: false
    }
  }))
}));
vi.mock("../../persistence/enrichment-repo", () => ({ getCaptureEnrichment: vi.fn() }));

const { bus } = await import("../../command-bus");
const { registerCaptureHandlers } = await import("../capture-handlers");

registerCaptureHandlers({ startRecordingFromSelection: mocks.startRecording });

beforeEach(() => {
  mocks.quickCaptureAction = "ask";
  mocks.pickRegion.mockReset().mockResolvedValue(selection);
  mocks.startRecording.mockReset().mockResolvedValue(ok({ sessionId: "recording-1" }));
  mocks.hideSelector.mockReset();
  mocks.releaseSnapshot.mockReset();
  mocks.captureRegion.mockReset();
  mocks.captureWindow.mockReset();
  mocks.setFloatOverState.mockReset();
});

describe("capture:interactive Quick Capture recording route", () => {
  test("ask + Record reuses the committed selection exactly once", async () => {
    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );

    expect(result).toEqual(ok({ kind: "record", sessionId: "recording-1" }));
    expect(mocks.pickRegion).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "auto",
        quickCaptureAction: "ask",
        intent: "snap",
        cursorDefault: true
      })
    );
    expect(mocks.startRecording).toHaveBeenCalledTimes(1);
    expect(mocks.startRecording).toHaveBeenCalledWith(
      selection,
      expect.objectContaining({
        recording: expect.objectContaining({ quickCaptureAction: "ask" })
      })
    );
    expect(mocks.captureRegion).not.toHaveBeenCalled();
    expect(mocks.captureWindow).not.toHaveBeenCalled();
  });

  test("Always Record is enforced even if a stale renderer echoes Snap", async () => {
    mocks.quickCaptureAction = "record";
    mocks.pickRegion.mockResolvedValueOnce({ ...selection, action: "snap" });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );

    expect(result).toEqual(ok({ kind: "record", sessionId: "recording-1" }));
    expect(mocks.pickRegion).toHaveBeenCalledWith(
      expect.objectContaining({ quickCaptureAction: "record", intent: "video" })
    );
    expect(mocks.startRecording).toHaveBeenCalledTimes(1);
  });

  test("Always Snap is enforced even if a stale renderer echoes Record", async () => {
    mocks.quickCaptureAction = "snap";
    mocks.pickRegion.mockResolvedValueOnce({
      ...selection,
      action: "record",
      snappedWindowId: 91,
      fullWindow: true
    });
    mocks.captureWindow.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      message: "still pipeline reached"
    });

    const result = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );

    expect(result).toEqual(
      err({
        kind: "capture",
        code: "error",
        message: "still pipeline reached"
      })
    );
    expect(mocks.pickRegion).toHaveBeenCalledWith(
      expect.objectContaining({ quickCaptureAction: "snap", intent: "snap" })
    );
    expect(mocks.captureWindow).toHaveBeenCalledWith(91);
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });

  test("a duplicate dispatch is rejected without tearing down the active selector", async () => {
    let resolveRecording!: (value: ReturnType<typeof ok<{ sessionId: string }>>) => void;
    mocks.startRecording.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRecording = resolve;
      })
    );

    const first = bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(mocks.startRecording).toHaveBeenCalledTimes(1));

    const duplicate = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );
    expect(duplicate).toEqual(
      err({
        kind: "capture",
        code: "selector_busy",
        message: "another capture selector is already active"
      })
    );
    expect(mocks.hideSelector).not.toHaveBeenCalled();
    expect(mocks.releaseSnapshot).not.toHaveBeenCalled();

    resolveRecording(ok({ sessionId: "recording-1" }));
    await expect(first).resolves.toEqual(
      ok({ kind: "record", sessionId: "recording-1" })
    );
  });

  test("recording errors release the lease for the next Quick Capture", async () => {
    mocks.startRecording.mockResolvedValueOnce(
      err({ kind: "recording", code: "start_failed", message: "no recorder" })
    );
    const failed = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );
    expect(failed).toEqual(
      err({ kind: "recording", code: "start_failed", message: "no recorder" })
    );

    const retried = await bus.dispatch(
      "capture:interactive",
      { mode: "auto" },
      { principal: "ipc" }
    );
    expect(retried).toEqual(ok({ kind: "record", sessionId: "recording-1" }));
    expect(mocks.startRecording).toHaveBeenCalledTimes(2);
  });
});
