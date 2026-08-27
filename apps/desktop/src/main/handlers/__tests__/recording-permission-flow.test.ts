import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  PermissionReadinessReport,
  RecordingState
} from "@pwrsnap/shared";

const mocks = vi.hoisted(() => ({
  report: {
    screenRecording: "granted",
    microphone: "granted",
    systemAudio: "granted",
    fingerprint: "0123456789abcdef",
    screenCapturePrompted: true,
    permissionEvidence: {
      platform: "other",
      screen: { kind: "not-inspectable" },
      microphone: { kind: "not-inspectable" },
      systemAudio: { kind: "unsupported" }
    }
  } as PermissionReadinessReport,
  start: vi.fn(async () => ({ sessionId: "session-1" })),
  cancel: vi.fn(async () => undefined),
  restart: vi.fn(async () => {
    throw new Error("not_recording");
  }),
  stop: vi.fn(async () => ({ captureId: "capture-1" })),
  guard: vi.fn(async () => null),
  storageGate: vi.fn(async () => null),
  resizePermissionController: vi.fn(() => true),
  foregroundEvents: [] as string[],
  snapshotForeground: vi.fn(async () => {
    let restored = false;
    return {
      pid: 8181,
      restore: vi.fn(async () => {
        if (restored) return;
        restored = true;
        mocks.foregroundEvents.push("restore-foreground");
      })
    };
  })
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  systemPreferences: {
    getMediaAccessStatus: () => "granted"
  } as unknown as typeof import("electron").systemPreferences,
  desktopCapturer: {
    getSources: async () => []
  } as unknown as typeof import("electron").desktopCapturer,
  shell: {
    openExternal: async () => undefined
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: mocks.guard,
  markScreenCapturePrompted: async () => undefined,
  readScreenCapturePrompted: async () => mocks.report.screenCapturePrompted
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  ensureCapturesDirReady: mocks.storageGate
}));

vi.mock("../../recording/recording-permissions", () => ({
  openSystemSettingsFor: async () => undefined,
  readRecordingReadiness: () => ({
    screenRecording: mocks.report.screenRecording,
    microphone: mocks.report.microphone,
    systemAudio: mocks.report.systemAudio,
    fingerprint: mocks.report.fingerprint
  }),
  requestPermission: async () => ({ status: "granted" })
}));

vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => ({
    start: mocks.start,
    cancel: mocks.cancel,
    restart: mocks.restart,
    stop: mocks.stop,
    isActive: () => false
  })
}));

vi.mock("../../recording/recording-controller", () => ({
  resizeRecordingPermissionController: mocks.resizePermissionController
}));

vi.mock("../../recording/recording-foreground", () => ({
  snapshotRecordingForeground: mocks.snapshotForeground
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => null,
  lookupExport: () => null,
  normalizeRange: (range: unknown) => range,
  setDefaultRange: () => undefined
}));

vi.mock("../../recording/recording-exporter", () => ({
  exportVideoRange: async () => undefined
}));

const { bus } = await import("../../command-bus");
const {
  RecordingPermissionPreflightCoordinator,
  __setRecordingPermissionPreflightCoordinatorForTests,
  setRecordingPermissionControllerWindowId
} = await import("../../recording/recording-permission-preflight");
const { getRecordingState, setRecordingState } = await import(
  "../../recording/recording-state"
);
const { registerRecordingHandlers } = await import("../recording-handlers");

registerRecordingHandlers();

const subject = {
  kind: "region" as const,
  rect: { x: 10, y: 20, w: 640, h: 360 },
  displayId: 7
};

function installCoordinator(states: RecordingState[] = []): void {
  __setRecordingPermissionPreflightCoordinatorForTests(
    new RecordingPermissionPreflightCoordinator({
      platform: "linux",
      makeRequestId: () => "request-1",
      defaultDisplayId: () => 7,
      readReport: async () => ({ ...mocks.report }),
      request: async () => ({ status: "granted" }),
      openSettings: async () => undefined,
      markScreenPrompted: async () => undefined,
      setState: (state) => {
        states.push(state);
        setRecordingState(state);
      }
    })
  );
  setRecordingPermissionControllerWindowId(91);
}

async function waitForPermission(): Promise<Extract<
  RecordingState,
  { phase: "permission" }
>> {
  await vi.waitFor(() => expect(getRecordingState().phase).toBe("permission"));
  const state = getRecordingState();
  if (state.phase !== "permission") throw new Error("permission state missing");
  return state;
}

beforeEach(() => {
  mocks.report = {
    screenRecording: "granted",
    microphone: "granted",
    systemAudio: "granted",
    fingerprint: "0123456789abcdef",
    screenCapturePrompted: true,
    permissionEvidence: {
      platform: "other",
      screen: { kind: "not-inspectable" },
      microphone: { kind: "not-inspectable" },
      systemAudio: { kind: "unsupported" }
    }
  };
  mocks.start.mockClear();
  mocks.cancel.mockClear();
  mocks.guard.mockClear();
  mocks.storageGate.mockClear();
  mocks.resizePermissionController.mockClear();
  mocks.foregroundEvents.length = 0;
  mocks.snapshotForeground.mockClear();
  mocks.start.mockImplementation(async () => {
    mocks.foregroundEvents.push("service-start");
    return { sessionId: "session-1" };
  });
  setRecordingState({ phase: "idle" });
  installCoordinator();
});

afterEach(() => {
  __setRecordingPermissionPreflightCoordinatorForTests(null);
  setRecordingPermissionControllerWindowId(null);
  setRecordingState({ phase: "idle" });
});

describe("recording permission command-bus integration", () => {
  test("recording:start owns trusted Continue without and starts with a degraded copy", async () => {
    mocks.report = { ...mocks.report, microphone: "denied" };
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: true, systemAudio: false },
        captureCursor: true,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    const state = await waitForPermission();
    expect(state.preflight.missing).toEqual([
      { permission: "microphone", status: "denied" }
    ]);

    const racedStart = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: false, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "rpc" }
    );
    expect(racedStart).toMatchObject({
      ok: false,
      error: { code: "already_recording" }
    });
    expect(mocks.start).not.toHaveBeenCalled();

    const untrusted = await bus.dispatch(
      "recording:permissionAction",
      {
        requestId: state.preflight.requestId,
        action: "continueWithout",
        permission: "microphone"
      },
      { principal: "ipc", sourceWindowId: 12 }
    );
    expect(untrusted).toMatchObject({
      ok: false,
      error: { code: "untrusted_permission_source" }
    });

    const continued = await bus.dispatch(
      "recording:permissionAction",
      {
        requestId: state.preflight.requestId,
        action: "continueWithout",
        permission: "microphone"
      },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(continued).toEqual({ ok: true, value: undefined });
    const started = await start;
    expect(started).toEqual({ ok: true, value: { sessionId: "session-1" } });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: { microphone: false, systemAudio: false }
      })
    );
    expect(mocks.snapshotForeground).toHaveBeenCalledTimes(1);
    expect(mocks.foregroundEvents).toEqual([
      "restore-foreground",
      "service-start"
    ]);
  });

  test("recording:start recheck keeps requested mic after access becomes granted", async () => {
    mocks.report = { ...mocks.report, microphone: "denied" };
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: true, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    const state = await waitForPermission();
    mocks.report = { ...mocks.report, microphone: "granted" };
    const rechecked = await bus.dispatch(
      "recording:permissionAction",
      { requestId: state.preflight.requestId, action: "recheck" },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(rechecked).toEqual({ ok: true, value: undefined });
    await expect(start).resolves.toEqual({
      ok: true,
      value: { sessionId: "session-1" }
    });
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: { microphone: true, systemAudio: false }
      })
    );
  });

  test("recording:start Cancel returns idle without starting or cancelling a native service", async () => {
    mocks.report = { ...mocks.report, microphone: "denied" };
    const states: RecordingState[] = [];
    installCoordinator(states);
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: true, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    await waitForPermission();

    const cancelled = await bus.dispatch(
      "recording:cancel",
      {},
      { principal: "ipc" }
    );
    expect(cancelled).toEqual({ ok: true, value: undefined });
    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { kind: "validation", code: "cancelled" }
    });
    expect(getRecordingState()).toEqual({ phase: "idle" });
    expect(states.at(-1)).toEqual({ phase: "idle" });
    expect(mocks.foregroundEvents).toEqual(["restore-foreground"]);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  test("required screen denial cannot continue and Cancel leaves no native state", async () => {
    mocks.report = { ...mocks.report, screenRecording: "denied" };
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: false, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    const state = await waitForPermission();
    expect(state.preflight.missing).toEqual([
      { permission: "screen", status: "denied" }
    ]);

    const degraded = await bus.dispatch(
      "recording:permissionAction",
      {
        requestId: state.preflight.requestId,
        action: "continueWithout",
        permission: "screen"
      },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(degraded).toMatchObject({
      ok: false,
      error: { code: "screen_capture_required" }
    });

    const cancelled = await bus.dispatch(
      "recording:permissionAction",
      { requestId: state.preflight.requestId, action: "cancel" },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(cancelled).toEqual({ ok: true, value: undefined });
    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" }
    });
    expect(getRecordingState()).toEqual({ phase: "idle" });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  test("recording:start preserves a typed final permission race check", async () => {
    mocks.report = { ...mocks.report, microphone: "denied" };
    const started = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: true, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "rpc" }
    );
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "permission", code: "microphone_not_granted" }
    });
    expect(mocks.guard).toHaveBeenCalledWith({ routeToSettings: false });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  test("initializing preflight reservation rejects a concurrent native start", async () => {
    const releaseRead: {
      current: ((report: PermissionReadinessReport) => void) | null;
    } = { current: null };
    const coordinator = new RecordingPermissionPreflightCoordinator({
      platform: "linux",
      makeRequestId: () => "request-init",
      readReport: async () =>
        new Promise<PermissionReadinessReport>((resolve) => {
          releaseRead.current = resolve;
        }),
      setState: setRecordingState
    });
    __setRecordingPermissionPreflightCoordinatorForTests(coordinator);

    const preflight = bus.dispatch(
      "recording:preflight",
      { capabilities: { microphone: false, systemAudio: false } },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(coordinator.isInFlight).toBe(true));
    const raced = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: false, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "rpc" }
    );
    expect(raced).toMatchObject({
      ok: false,
      error: { code: "already_recording" }
    });
    expect(mocks.start).not.toHaveBeenCalled();

    expect(coordinator.cancel()).toBe(true);
    const release = releaseRead.current;
    if (release === null) throw new Error("readiness read did not start");
    release({ ...mocks.report });
    await expect(preflight).resolves.toEqual({
      ok: true,
      value: { status: "cancelled" }
    });
  });

  test("recording:start reservation spans storage readiness through service handoff", async () => {
    const releaseStorage: { current: (() => void) | null } = { current: null };
    mocks.storageGate.mockImplementationOnce(
      async () =>
        new Promise<null>((resolve) => {
          releaseStorage.current = () => resolve(null);
        })
    );
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: false, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(mocks.storageGate).toHaveBeenCalledTimes(1));

    const raced = await bus.dispatch(
      "recording:preflight",
      { capabilities: { microphone: false, systemAudio: false } },
      { principal: "ipc" }
    );
    expect(raced).toMatchObject({
      ok: false,
      error: { code: "already_recording" }
    });
    const release = releaseStorage.current;
    if (release === null) throw new Error("storage gate did not start");
    release();
    await expect(start).resolves.toEqual({
      ok: true,
      value: { sessionId: "session-1" }
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });

  test("Cancel during native start never returns a live session", async () => {
    const releaseStart: {
      current: ((session: { sessionId: string }) => void) | null;
    } = { current: null };
    mocks.start.mockImplementationOnce(
      async () =>
        new Promise<{ sessionId: string }>((resolve) => {
          releaseStart.current = resolve;
        })
    );
    const start = bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { microphone: false, systemAudio: false },
        captureCursor: false,
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));

    const cancelled = await bus.dispatch(
      "recording:cancel",
      {},
      { principal: "ipc" }
    );
    expect(cancelled).toEqual({ ok: true, value: undefined });
    const release = releaseStart.current;
    if (release === null) throw new Error("native start did not begin");
    release({ sessionId: "session-raced" });

    await expect(start).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" }
    });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(getRecordingState()).toEqual({ phase: "idle" });
  });

  test("headless callers cannot open an interactive preflight", async () => {
    const result = await bus.dispatch(
      "recording:preflight",
      { capabilities: { microphone: false, systemAudio: false } },
      { principal: "rpc" }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "interactive_preflight_required" }
    });
  });

  test("malformed interactive preflight returns a validation Result", async () => {
    const result = await bus.dispatch(
      "recording:preflight",
      null as never,
      { principal: "ipc" }
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "invalid_recording_preflight" }
    });
  });

  test("permission resize is trusted-window and request validated", async () => {
    const untrusted = await bus.dispatch(
      "recording:resizePermissionController",
      { requestId: "request-1", width: 560, height: 420 },
      { principal: "ipc", sourceWindowId: 12 }
    );
    expect(untrusted).toMatchObject({
      ok: false,
      error: { code: "untrusted_permission_source" }
    });

    const malformed = await bus.dispatch(
      "recording:resizePermissionController",
      { requestId: "request-1", width: Number.NaN, height: 420 },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "invalid_permission_size" }
    });

    const resized = await bus.dispatch(
      "recording:resizePermissionController",
      { requestId: "request-1", width: 560, height: 420 },
      { principal: "ipc", sourceWindowId: 91 }
    );
    expect(resized).toEqual({ ok: true, value: undefined });
    expect(mocks.resizePermissionController).toHaveBeenCalledWith({
      requestId: "request-1",
      width: 560,
      height: 420
    });
  });
});
