import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { WindowInfo } from "../../capture/window-list";

const mocks = vi.hoisted(() => ({
  currentWindowList: [] as WindowInfo[],
  overlapping: vi.fn(),
  activateApp: vi.fn(),
  attachIdentity: vi.fn(),
  dispatch: vi.fn(),
  hideSelector: vi.fn(),
  releaseSnapshot: vi.fn()
}));

vi.mock("electron", () => ({ app: { dock: { isVisible: () => true } } }));
vi.mock("../../capture/region-selector", () => ({
  getLastWindowListSnapshot: () => mocks.currentWindowList,
  hideSelector: mocks.hideSelector
}));
vi.mock("../../capture/window-list", () => ({
  selfPidSet: () => new Set([process.pid]),
  activateApp: mocks.activateApp,
  findWindowAt: () => null
}));
vi.mock("../../capture/rect-overlap", () => ({ appWindowsOverlappingGlobalRect: mocks.overlapping }));
vi.mock("../../capture/screen-snapshot", () => ({ releaseSnapshot: mocks.releaseSnapshot }));
vi.mock("../../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));
vi.mock("../../float-over", () => ({ setFloatOverState: () => undefined, releaseFloatOverDock: () => undefined }));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  reclaimDockIconIfLibraryAlive: () => undefined,
  scheduleDockReclaim: () => undefined
}));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug: () => undefined, warn: () => undefined }) }));
vi.mock("../recording-state", () => ({ getRecordingState: () => ({ phase: "idle" }) }));
vi.mock("../recording-service", () => ({ attachTrustedRecordingWindowIdentity: mocks.attachIdentity }));

const originalWindow: WindowInfo = {
  windowId: 42, pid: 7001, bundleId: "example.original", appName: "Original App", title: "Original",
  bounds: { x: 100, y: 100, width: 600, height: 400 }, layer: 0, alpha: 1, isFrontmostInApp: true
};
const selection = {
  ok: true as const, selectorInvocationId: 1, snappedWindowId: 42,
  displayId: 1, rect: { x: 100, y: 100, w: 600, h: 400 },
  screenSnapshotId: "committed", previousAppPid: 7001,
  windowListSnapshot: [originalWindow]
};
const library = {
  isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
  getTitle: () => "PwrSnap", moveTop: vi.fn(), focus: vi.fn()
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.currentWindowList = [originalWindow];
  mocks.overlapping.mockReturnValue([library]);
  mocks.activateApp.mockResolvedValue(undefined);
  mocks.dispatch.mockResolvedValue({ ok: true, value: { sessionId: "committed-recording" } });
});
afterEach(() => { vi.useRealTimers(); });

// Keep the real source-app decision helpers: an empty list means "unknown",
// which permits the raise branch and reproduces the focus loss.
test.each(["cleared", "replaced"])("committed recording retains focus policy, attribution and identity when a successor's admission %s the shared list", async (change) => {
  const { startRecordingFromSelection } = await import("../record-from-selection");
  const started = startRecordingFromSelection(selection, {
    includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false
  });
  // This is the 50 ms compositor boundary. A new pick either clears the
  // shared list or enumerates a different owner for a reused native id.
  mocks.currentWindowList = change === "cleared" ? [] : [{
    ...originalWindow, pid: process.pid, appName: "PwrSnap", bundleId: "example.newer"
  }];
  await vi.advanceTimersByTimeAsync(50);
  await started;
  expect(mocks.overlapping).not.toHaveBeenCalled();
  expect(library.focus).not.toHaveBeenCalled();
  expect(mocks.activateApp).not.toHaveBeenCalled();
  expect(mocks.dispatch).toHaveBeenCalledWith("recording:start", expect.objectContaining({
    subject: expect.objectContaining({ kind: "window", windowId: 42, appName: "Original App", appBundleId: "example.original" })
  }), { principal: "ipc" });
  expect(mocks.attachIdentity).toHaveBeenCalledExactlyOnceWith("committed-recording", { windowId: 42, pid: 7001 });
  expect(mocks.hideSelector).toHaveBeenCalledExactlyOnceWith(1);
  expect(mocks.releaseSnapshot).toHaveBeenCalledExactlyOnceWith("committed");
});
