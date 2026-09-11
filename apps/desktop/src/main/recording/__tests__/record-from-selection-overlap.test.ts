// Pins the ONE thing the rect-overlap unit tests cannot: that this
// call site hands `selection.rect` to the GLOBAL overlap entry point.
//
// The double-add defect was never in the helper — the arithmetic there
// was always right. It was a call site passing a global
// `SelectorResult.rect` into a display-local parameter, and it shipped
// that way twice. Both entry points take a bare `Rect`, so swapping
// them back still typechecks and still passes every test in
// app-windows-overlapping-rect.test.ts. Only an assertion at the call
// site catches it.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

/** A display with a non-zero origin on both axes — the real config the
 *  double-add was measured on. At (0,0) this test cannot fail. */
const SKEWED = { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 } };

const globalCalls: { x: number; y: number; w: number; h: number }[] = [];
const displayLocalCalls: unknown[] = [];

vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingGlobalRect: (rect: { x: number; y: number; w: number; h: number }) => {
    globalCalls.push(rect);
    return [];
  },
  appWindowsOverlappingRect: (...args: unknown[]) => {
    displayLocalCalls.push(args);
    return [];
  }
}));

const showMessageBox = vi.fn(async () => ({ response: 1 }));
const notificationSupported = vi.fn(() => false);
const hideSelector = vi.fn();
const releaseSnapshot = vi.fn();

vi.mock("electron", () => ({
  dialog: { showMessageBox },
  app: { dock: { isVisible: () => true } },
  // A supported notification may accept show() without displaying a banner.
  Notification: Object.assign(function () { return { show: () => undefined }; }, { isSupported: notificationSupported }),
  screen: { getAllDisplays: () => [SKEWED] }
}));

const dispatch = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: { sessionId: "started-session" } }));
const attachIdentity = vi.fn();
vi.mock("../recording-service", () => ({ attachTrustedRecordingWindowIdentity: attachIdentity }));
vi.mock("../../command-bus", () => ({ bus: { dispatch } }));
vi.mock("../../float-over", () => ({ setFloatOverState: () => undefined }));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined })
}));
vi.mock("../../capture/region-selector", () => ({
  getLastWindowListSnapshot: () => [],
  hideSelector
}));
vi.mock("../../capture/screen-snapshot", () => ({ releaseSnapshot }));
vi.mock("../../capture/source-app", () => ({
  findWindowById: (_windows: unknown, id: number) => id === 42 ? { windowId: 42, pid: 123 } : null,
  resolveSelectionSourceApp: () => null,
  // True for every free-hand drag — the common path, and the one the
  // defect sat on.
  shouldConsiderRaisingOurWindows: () => true
}));
vi.mock("../../capture/window-list", () => ({
  activateApp: async () => undefined,
  selfPidSet: () => new Set<number>()
}));
vi.mock("../../window", () => ({
  findMainLibraryWindow: () => null,
  reclaimDockIconIfLibraryAlive: () => undefined,
  scheduleDockReclaim: () => undefined
}));
let recordingState: RecordingState = { phase: "idle" };
vi.mock("../recording-state", () => ({ getRecordingState: () => recordingState }));

beforeEach(() => {
  globalCalls.length = 0;
  displayLocalCalls.length = 0;
  dispatch.mockClear();
  showMessageBox.mockReset();
  showMessageBox.mockResolvedValue({ response: 1 });
  notificationSupported.mockReturnValue(false);
  hideSelector.mockClear();
  releaseSnapshot.mockClear();
  attachIdentity.mockClear();
  recordingState = { phase: "idle" };
});

describe("startRecordingFromSelection — overlap coordinate space", () => {
  test.each([false, true])("failed start saves provenance only for a new failure (existing=%s)", async (existing) => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    const failed: RecordingState = {
      phase: "failed", sessionId: "failed-session", code: "recorder_spawn_failed",
      canRetry: true, displayId: 3
    };
    if (existing) recordingState = failed;
    dispatch.mockImplementationOnce(async () => {
      recordingState = failed;
      return { ok: false, error: { kind: "capture", code: "recording_start_failed", message: "Failed" } } as never;
    });
    await startRecordingFromSelection(
      { ok: true, snappedWindowId: 42, rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 3,
        screenSnapshotId: "snap-failed", previousAppPid: null },
      { includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false }
    );
    if (existing) expect(attachIdentity).not.toHaveBeenCalled();
    else expect(attachIdentity).toHaveBeenCalledWith("failed-session", { windowId: 42, pid: 123 });
  });

  test("attaches selected native identity only after recording start succeeds", async () => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    dispatch.mockImplementationOnce(async () => {
      expect(attachIdentity).not.toHaveBeenCalled();
      return { ok: true, value: { sessionId: "started-session" } };
    });
    await startRecordingFromSelection(
      {
        ok: true,
        snappedWindowId: 42,
        rect: { x: 0, y: 0, w: 600, h: 400 },
        displayId: SKEWED.id,
        screenSnapshotId: "snap-title",
        previousAppPid: null
      },
      { includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false }
    );
    expect(attachIdentity).toHaveBeenCalledWith("started-session", { windowId: 42, pid: 123 });
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ subject: { kind: "window", windowId: 42 } });
    expect(JSON.stringify(dispatch.mock.calls)).not.toContain("windowTitle");
  });

  test("passes the selector's global rect to the global entry point, unconverted", async () => {
    const { startRecordingFromSelection } = await import("../record-from-selection");

    // What region-selector.ts resolves for a drag on SKEWED: the
    // renderer's display-local (500, 400) already translated to global.
    const selectorRect = { x: SKEWED.bounds.x + 500, y: SKEWED.bounds.y + 400, w: 600, h: 400 };

    await startRecordingFromSelection(
      {
        ok: true,
        rect: selectorRect,
        displayId: SKEWED.id,
        screenSnapshotId: "snap-1",
        previousAppPid: null
      },
      { includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false }
    );

    // The global variant is the one consulted...
    expect(globalCalls).toHaveLength(1);
    // ...with the rect verbatim. Any origin arithmetic on the way in —
    // in either direction — changes these numbers.
    expect(globalCalls[0]).toEqual(selectorRect);
    // ...and the display-local sibling is never reached. Calling it
    // with this rect is exactly the shipped defect.
    expect(displayLocalCalls).toEqual([]);
    expect(attachIdentity).not.toHaveBeenCalled();
  });
});


describe("startRecordingFromSelection — preflight feedback", () => {
  const selection = {
    ok: true as const, snappedWindowId: 42,
    rect: { x: 1496, y: -473, w: 600, h: 400 }, displayId: 3,
    screenSnapshotId: "preflight-snapshot", previousAppPid: null
  };
  const defaults = {
    includeSystemAudio: false, includeMicrophone: true, videoCaptureCursor: false
  };
  const microphoneError = {
    kind: "permission", code: "microphone_not_granted",
    message: "Microphone permission is required for the selected recording options."
  };

  test.each([false, true])("shows actionable microphone failure regardless of notification support (%s)", async (supported) => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    notificationSupported.mockReturnValue(supported);
    dispatch.mockResolvedValueOnce({ ok: false, error: microphoneError } as never);
    showMessageBox.mockImplementationOnce(async () => {
      expect(hideSelector).toHaveBeenCalledOnce();
      expect(releaseSnapshot).toHaveBeenCalledWith("preflight-snapshot");
      return { response: 0 };
    });

    await startRecordingFromSelection(selection, defaults);

    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      type: "error", title: "Recording could not start",
      message: microphoneError.message,
      detail: expect.stringContaining("Open System Permissions to grant access"),
      buttons: ["Open System Permissions", "Dismiss"], cancelId: 1
    }));
    expect(dispatch).toHaveBeenLastCalledWith(
      "settings:open", { page: "system-permissions" }, { principal: "ipc" }
    );
    expect(attachIdentity).not.toHaveBeenCalled();
    expect(recordingState).toEqual({ phase: "idle" });
  });

  test("dismiss leaves permission and audio settings unchanged", async () => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    dispatch.mockResolvedValueOnce({ ok: false, error: microphoneError } as never);
    await startRecordingFromSelection(selection, defaults);
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test("also displays non-permission preflight errors", async () => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    dispatch.mockResolvedValueOnce({ ok: false, error: {
      kind: "capture", code: "already_recording", message: "A recording is already in progress."
    } } as never);
    await startRecordingFromSelection(selection, defaults);
    expect(showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: "A recording is already in progress.", buttons: ["Dismiss"], cancelId: 0
    }));
    expect(dispatch).toHaveBeenCalledOnce();
  });

  test.each(["cancelled", "success", "failed controls"])("does not duplicate feedback for %s", async (outcome) => {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    if (outcome !== "success") {
      dispatch.mockImplementationOnce(async () => {
        if (outcome === "failed controls") recordingState = {
          phase: "failed", sessionId: "failed-session", code: "recorder_spawn_failed",
          canRetry: true, displayId: 3
        };
        return { ok: false, error: { kind: "capture", code: outcome === "cancelled" ? "cancelled" : "recording_start_failed", message: "Failed" } } as never;
      });
    }
    await startRecordingFromSelection(selection, defaults);
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
