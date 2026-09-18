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

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

/** A display with a non-zero origin on both axes — the real config the
 *  double-add was measured on. At (0,0) this test cannot fail. */
const SKEWED = { id: 3, bounds: { x: 1496, y: -473, width: 2560, height: 1440 } };

const globalCalls: { x: number; y: number; w: number; h: number }[] = [];
const displayLocalCalls: unknown[] = [];

/** Windows the overlap helper reports. Empty for the coordinate-space
 *  tests (which only care WHICH helper was called); populated by the
 *  lead-in re-raise tests, which need the raise branch to actually run. */
type WindowSpy = {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  restore: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  getTitle: () => string;
};
const overlapping: WindowSpy[] = [];
function makeWindowSpy(): WindowSpy {
  return {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    getTitle: () => "PwrSnap"
  };
}

/** What `BrowserWindow.getFocusedWindow()` reports. `null` is macOS's
 *  "this app is not active" — no key window exists. */
let focusedWindow: unknown = null;

/** Case one (snap to one of OUR windows) unless a test says otherwise. */
let shouldRaise = true;

vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingGlobalRect: (rect: { x: number; y: number; w: number; h: number }) => {
    globalCalls.push(rect);
    return overlapping;
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
  BrowserWindow: { getFocusedWindow: () => focusedWindow },
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
  shouldConsiderRaisingOurWindows: () => shouldRaise
}));
const activateApp = vi.fn(async (_pid: number) => undefined);
vi.mock("../../capture/window-list", () => ({
  activateApp,
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
  activateApp.mockClear();
  overlapping.length = 0;
  focusedWindow = null;
  shouldRaise = true;
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

describe("startRecordingFromSelection — which audio sources the take gets", () => {
  const RECT = { x: 0, y: 0, w: 600, h: 400 };

  function capabilitiesOf(call: unknown): unknown {
    return (call as { capabilities: unknown }).capabilities;
  }

  test("the selector's chips win over the persisted defaults", async () => {
    // Settings SEED the chips; the chips decide the take. A user who
    // armed the microphone on the picker must get it even though their
    // saved default says otherwise — and nothing writes back, so the
    // default survives for the next recording.
    const { startRecordingFromSelection } = await import("../record-from-selection");
    await startRecordingFromSelection(
      {
        ok: true,
        rect: RECT,
        displayId: SKEWED.id,
        screenSnapshotId: "snap-sources",
        previousAppPid: null,
        sources: { microphone: true, systemAudio: false }
      },
      { includeSystemAudio: true, includeMicrophone: false, videoCaptureCursor: false }
    );
    expect(capabilitiesOf(dispatch.mock.calls[0]?.[1])).toEqual({
      microphone: true,
      systemAudio: false
    });
  });

  test("both-off from the chips is an answer, not a missing one", async () => {
    // The trap a `??` on the individual fields would fall into: a
    // deliberate silent take would read as "unset" and be overwritten
    // by the persisted defaults, handing the user audio they turned off.
    const { startRecordingFromSelection } = await import("../record-from-selection");
    await startRecordingFromSelection(
      {
        ok: true,
        rect: RECT,
        displayId: SKEWED.id,
        screenSnapshotId: "snap-silent",
        previousAppPid: null,
        sources: { microphone: false, systemAudio: false }
      },
      { includeSystemAudio: true, includeMicrophone: true, videoCaptureCursor: false }
    );
    expect(capabilitiesOf(dispatch.mock.calls[0]?.[1])).toEqual({
      microphone: false,
      systemAudio: false
    });
  });

  test("no chips means the persisted defaults, exactly as before", async () => {
    // Main omits the seed when its settings read failed, and every
    // caller that cannot reach a recording omits it too. The renderer
    // then commits no `sources` and this path is unchanged.
    const { startRecordingFromSelection } = await import("../record-from-selection");
    await startRecordingFromSelection(
      {
        ok: true,
        rect: RECT,
        displayId: SKEWED.id,
        screenSnapshotId: "snap-default",
        previousAppPid: null
      },
      { includeSystemAudio: true, includeMicrophone: true, videoCaptureCursor: false }
    );
    expect(capabilitiesOf(dispatch.mock.calls[0]?.[1])).toEqual({
      microphone: true,
      systemAudio: true
    });
  });
});

// The commit-time raise holds for ~100ms. AppKit's Accessory demotion
// lands after it and takes our activation with it, and the Dock reclaim
// that catches the demotion restores POLICY, not activation — so the
// recording-controller's per-tick `moveTop()` runs for the rest of the
// countdown against an inactive app, which macOS orders only among that
// app's own windows. Measured on a real take: the Library dove under
// Claude at t+125ms and stayed there through all three countdown ticks.
describe("startRecordingFromSelection — holding z-order through the lead-in", () => {
  const RERAISE_WINDOW_MS = 1000;

  async function commitAndSettle(): Promise<void> {
    const { startRecordingFromSelection } = await import("../record-from-selection");
    const running = startRecordingFromSelection(
      {
        ok: true,
        snappedWindowId: 42,
        rect: { x: 0, y: 0, w: 600, h: 400 },
        displayId: SKEWED.id,
        screenSnapshotId: "snap-leadin",
        previousAppPid: null
      },
      { includeSystemAudio: false, includeMicrophone: false, videoCaptureCursor: false }
    );
    // The float-over park flush inside the function under test.
    await vi.advanceTimersByTimeAsync(50);
    await running;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("re-activates when the lead-in demotion takes our activation away", async () => {
    const win = makeWindowSpy();
    overlapping.push(win);
    recordingState = { phase: "countdown", sessionId: "s", secondsRemaining: 2, rect: { x: 0, y: 0, w: 600, h: 400 }, displayId: SKEWED.id } as unknown as RecordingState;

    await commitAndSettle();
    const activationsAtCommit = activateApp.mock.calls.length;
    const moveTopsAtCommit = win.moveTop.mock.calls.length;
    expect(activationsAtCommit).toBe(1);

    // No key window — macOS's "this app is not active".
    focusedWindow = null;
    await vi.advanceTimersByTimeAsync(RERAISE_WINDOW_MS);

    expect(activateApp.mock.calls.length).toBeGreaterThan(activationsAtCommit);
    expect(win.moveTop.mock.calls.length).toBeGreaterThan(moveTopsAtCommit);
    expect(win.focus).toHaveBeenCalled();
  });

  test("stays out of the way while PwrSnap is still frontmost", async () => {
    const win = makeWindowSpy();
    overlapping.push(win);
    recordingState = { phase: "countdown" } as unknown as RecordingState;

    await commitAndSettle();
    const activationsAtCommit = activateApp.mock.calls.length;

    // A key window exists, so the app is active and the commit-time
    // raise is still holding. Re-activating here would spawn a helper
    // process four times for nothing.
    focusedWindow = makeWindowSpy();
    await vi.advanceTimersByTimeAsync(RERAISE_WINDOW_MS);

    expect(activateApp.mock.calls.length).toBe(activationsAtCommit);
  });

  test("never re-activates once the take is live", async () => {
    const win = makeWindowSpy();
    overlapping.push(win);

    await commitAndSettle();
    const activationsAtCommit = activateApp.mock.calls.length;

    // AGENTS.md "Mid-take UI": activating PwrSnap during a take records
    // the recorded app losing focus — menu bar switch, title bar going
    // inactive, caret vanishing — all inside the rect and all in the
    // file. The lead-in is the only window where this recovery is legal.
    recordingState = { phase: "recording" } as unknown as RecordingState;
    focusedWindow = null;
    await vi.advanceTimersByTimeAsync(RERAISE_WINDOW_MS);

    expect(activateApp.mock.calls.length).toBe(activationsAtCommit);
  });

  test("a cancelled lead-in does not get yanked forward afterwards", async () => {
    const win = makeWindowSpy();
    overlapping.push(win);

    await commitAndSettle();
    const activationsAtCommit = activateApp.mock.calls.length;

    // Escape during the countdown returns the state machine to idle.
    recordingState = { phase: "idle" };
    focusedWindow = null;
    await vi.advanceTimersByTimeAsync(RERAISE_WINDOW_MS);

    expect(activateApp.mock.calls.length).toBe(activationsAtCommit);
  });

  test("case two — a snap to another app's window schedules nothing", async () => {
    // The user picked SOMEONE ELSE's window. Their app must stay
    // frontmost; pulling PwrSnap forward would obscure the very window
    // being recorded. Nothing was raised at commit either, so there is
    // nothing to re-raise.
    shouldRaise = false;
    overlapping.push(makeWindowSpy());
    recordingState = { phase: "countdown" } as unknown as RecordingState;

    await commitAndSettle();
    expect(activateApp).not.toHaveBeenCalled();

    focusedWindow = null;
    await vi.advanceTimersByTimeAsync(RERAISE_WINDOW_MS);

    expect(activateApp).not.toHaveBeenCalled();
  });
});
