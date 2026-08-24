import type { Settings } from "@pwrsnap/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

import type { CommittedSelectorResult } from "../record-selection";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  setFloatOverState: vi.fn(),
  hideSelector: vi.fn(),
  releaseSnapshot: vi.fn(),
  getLastWindowListSnapshot: vi.fn(),
  resolveSelectionSourceApp: vi.fn(),
  shouldConsiderRaisingOurWindows: vi.fn(),
  appWindowsOverlappingRect: vi.fn(),
  selfPidSet: vi.fn(),
  activateApp: vi.fn(),
  findMainLibraryWindow: vi.fn(),
  reclaimDockIconIfLibraryAlive: vi.fn(),
  scheduleDockReclaim: vi.fn(),
  notificationIsSupported: vi.fn(),
  notificationShow: vi.fn(),
  logWarn: vi.fn()
}));

vi.mock("electron", () => {
  class BrowserWindow {}
  class Notification {
    static isSupported(): boolean {
      return mocks.notificationIsSupported();
    }

    show(): void {
      mocks.notificationShow();
    }
  }

  return {
    app: { dock: { isVisible: vi.fn().mockReturnValue(true) } },
    BrowserWindow,
    Notification
  };
});

vi.mock("../../command-bus", () => ({
  bus: { dispatch: mocks.dispatch }
}));

vi.mock("../../float-over", () => ({
  setFloatOverState: mocks.setFloatOverState
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mocks.logWarn,
    error: vi.fn()
  })
}));

vi.mock("../../window", () => ({
  findMainLibraryWindow: mocks.findMainLibraryWindow,
  reclaimDockIconIfLibraryAlive: mocks.reclaimDockIconIfLibraryAlive,
  scheduleDockReclaim: mocks.scheduleDockReclaim
}));

vi.mock("../rect-overlap", () => ({
  appWindowsOverlappingRect: mocks.appWindowsOverlappingRect
}));

vi.mock("../region-selector", () => ({
  getLastWindowListSnapshot: mocks.getLastWindowListSnapshot,
  hideSelector: mocks.hideSelector
}));

vi.mock("../screen-snapshot", () => ({
  releaseSnapshot: mocks.releaseSnapshot
}));

vi.mock("../source-app", () => ({
  resolveSelectionSourceApp: mocks.resolveSelectionSourceApp,
  shouldConsiderRaisingOurWindows: mocks.shouldConsiderRaisingOurWindows
}));

vi.mock("../window-list", () => ({
  activateApp: mocks.activateApp,
  selfPidSet: mocks.selfPidSet
}));

import { startRecordingFromSelection } from "../record-selection";

const cachedWindowSnapshot = [{ windowId: 73, pid: 901 }];

function recordingSettings(overrides: {
  includeSystemAudio?: boolean;
  includeMicrophone?: boolean;
  videoCaptureCursor?: boolean;
} = {}): Settings {
  return {
    recording: {
      includeSystemAudio: overrides.includeSystemAudio ?? false,
      includeMicrophone: overrides.includeMicrophone ?? false,
      videoCaptureCursor: overrides.videoCaptureCursor ?? true,
      imageCaptureCursor: true,
      quickCaptureAction: "ask",
      lastRoutedPermissionFingerprint: "",
      screenCapturePrompted: false
    }
  } as Settings;
}

function committedSelection(
  overrides: Partial<CommittedSelectorResult> = {}
): CommittedSelectorResult {
  return {
    ok: true,
    rect: { x: 101, y: 202, w: 303, h: 404 },
    displayId: 8,
    screenSnapshotPath: "/tmp/frozen-screen.png",
    screenSnapshotId: "frozen-snapshot-1",
    previousAppPid: null,
    action: "record",
    ...overrides
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getLastWindowListSnapshot.mockReturnValue(cachedWindowSnapshot);
  mocks.resolveSelectionSourceApp.mockReturnValue({
    appName: "Target App",
    bundleId: "com.example.target"
  });
  mocks.shouldConsiderRaisingOurWindows.mockReturnValue(false);
  mocks.appWindowsOverlappingRect.mockReturnValue([]);
  mocks.selfPidSet.mockReturnValue(new Set([process.pid]));
  mocks.findMainLibraryWindow.mockReturnValue(null);
  mocks.notificationIsSupported.mockReturnValue(false);
});

describe("startRecordingFromSelection", () => {
  test("routes the committed window selection unchanged with audio and cursor overrides", async () => {
    const rect = { x: 11, y: 22, w: 333, h: 444 };
    const selection = committedSelection({
      rect,
      displayId: 17,
      snappedWindowId: 991,
      captureCursor: false
    });
    const settings = recordingSettings({
      includeSystemAudio: true,
      includeMicrophone: false,
      videoCaptureCursor: true
    });
    const dispatched = { ok: true as const, value: { sessionId: "session-window" } };
    mocks.dispatch.mockResolvedValue(dispatched);

    await expect(startRecordingFromSelection(selection, settings)).resolves.toBe(dispatched);

    expect(mocks.getLastWindowListSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSelectionSourceApp).toHaveBeenCalledWith(
      rect,
      selection.snappedWindowId,
      cachedWindowSnapshot
    );
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:start",
      {
        subject: {
          kind: "window",
          windowId: 991,
          rect,
          displayId: 17,
          appName: "Target App",
          appBundleId: "com.example.target"
        },
        capabilities: {
          systemAudio: true,
          microphone: false
        },
        captureCursor: false,
        countdownSeconds: 3
      },
      { principal: "ipc" }
    );
    const request = mocks.dispatch.mock.calls[0]?.[1] as {
      subject: { rect: typeof rect };
    };
    expect(request.subject.rect).toBe(rect);
    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("frozen-snapshot-1");
    expect(mocks.setFloatOverState).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
    expect(mocks.setFloatOverState.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.hideSelector.mock.invocationCallOrder[0]!
    );
    expect(mocks.hideSelector.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.dispatch.mock.invocationCallOrder[0]!
    );
  });

  test("routes a free selection as a region and falls back to the video cursor default", async () => {
    const rect = { x: 5, y: 6, w: 700, h: 450 };
    const selection = committedSelection({ rect, displayId: 4 });
    const settings = recordingSettings({
      includeSystemAudio: false,
      includeMicrophone: true,
      videoCaptureCursor: false
    });
    mocks.dispatch.mockResolvedValue({
      ok: true,
      value: { sessionId: "session-region" }
    });

    await startRecordingFromSelection(selection, settings);

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:start",
      {
        subject: {
          kind: "region",
          rect,
          displayId: 4
        },
        capabilities: {
          systemAudio: false,
          microphone: true
        },
        captureCursor: false,
        countdownSeconds: 3
      },
      { principal: "ipc" }
    );
    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
  });

  test("returns a recording dispatch error while cleaning selector ownership exactly once", async () => {
    const dispatched = {
      ok: false as const,
      error: {
        kind: "recording" as const,
        code: "already_recording",
        message: "A recording is already in progress."
      }
    };
    mocks.dispatch.mockResolvedValue(dispatched);

    await expect(
      startRecordingFromSelection(committedSelection(), recordingSettings())
    ).resolves.toBe(dispatched);

    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  test("parks the idle Float-Over when recording start is cancelled", async () => {
    const cancelled = {
      ok: false as const,
      error: {
        kind: "recording" as const,
        code: "cancelled",
        message: "Recording cancelled."
      }
    };
    mocks.dispatch.mockResolvedValue(cancelled);

    await expect(
      startRecordingFromSelection(committedSelection(), recordingSettings())
    ).resolves.toBe(cancelled);

    expect(mocks.setFloatOverState).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  test("cleans selector ownership exactly once when recording dispatch throws", async () => {
    const failure = new Error("recording bus exploded");
    mocks.dispatch.mockRejectedValue(failure);

    await expect(
      startRecordingFromSelection(committedSelection(), recordingSettings())
    ).rejects.toBe(failure);

    expect(mocks.hideSelector).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.releaseSnapshot).toHaveBeenCalledWith("frozen-snapshot-1");
    expect(mocks.setFloatOverState).toHaveBeenCalledTimes(1);
    expect(mocks.setFloatOverState).toHaveBeenCalledWith({ kind: "cancel" });
  });
});
