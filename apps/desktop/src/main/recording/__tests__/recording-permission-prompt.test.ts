import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  RecordingPermission,
  RecordingReadiness,
  RecordingState
} from "@pwrsnap/shared";

const moduleMocks = vi.hoisted(() => ({
  controllerUnavailable: null as (() => void) | null,
  readRecordingReadiness: vi.fn()
}));

vi.mock("electron", () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: {},
  globalShortcut: { register: vi.fn(), unregister: vi.fn() },
  screen: { getAllDisplays: vi.fn(), getPrimaryDisplay: vi.fn() }
}));
vi.mock("../../capture/screen-permission-gate", () => ({
  markScreenCapturePrompted: vi.fn()
}));
vi.mock("../recording-controller", () => ({
  lowerRecordingPermissionController: vi.fn(),
  subscribeToRecordingPermissionControllerUnavailable: vi.fn(
    (handler: () => void) => {
      moduleMocks.controllerUnavailable = handler;
      return () => {
        moduleMocks.controllerUnavailable = null;
      };
    }
  )
}));
vi.mock("../recording-permissions", () => ({
  openSystemSettingsFor: vi.fn(),
  readRecordingReadiness: moduleMocks.readRecordingReadiness,
  requestPermission: vi.fn(),
  triggerScreenCapturePrompt: vi.fn()
}));
vi.mock("../recording-state", () => ({ setRecordingState: vi.fn() }));

const {
  RecordingPermissionPrompter,
  cancelRecordingPermissionPrompt,
  requestRecordingPermissions
} = await import(
  "../recording-permission-prompt"
);

const granted: RecordingReadiness = {
  screenRecording: "granted",
  microphone: "granted",
  systemAudio: "granted",
  fingerprint: "0123456789abcdef"
};

function harness(initial: RecordingReadiness = granted): {
  prompt: InstanceType<typeof RecordingPermissionPrompter>;
  setReadiness: (next: RecordingReadiness) => void;
  states: RecordingState[];
  opened: RecordingPermission[];
  lower: ReturnType<typeof vi.fn>;
  returnToApp: () => void;
  screenRequests: { count: number };
  microphoneRequests: { count: number };
} {
  let readiness = { ...initial };
  let returnHandler: (() => void) | null = null;
  const states: RecordingState[] = [];
  const opened: RecordingPermission[] = [];
  const lower = vi.fn();
  const screenRequests = { count: 0 };
  const microphoneRequests = { count: 0 };
  const prompt = new RecordingPermissionPrompter({
    platform: "darwin",
    makeRequestId: () => "permission-1",
    readReadiness: () => ({ ...readiness }),
    requestScreenAccess: async () => {
      screenRequests.count += 1;
    },
    requestMicrophoneAccess: async () => {
      microphoneRequests.count += 1;
    },
    openSettings: async (permission) => {
      opened.push(permission);
    },
    setState: (state) => states.push(state),
    lowerController: lower,
    onReturnToApp: (handler) => {
      returnHandler = handler;
      return () => {
        returnHandler = null;
      };
    }
  });
  return {
    prompt,
    setReadiness: (next) => {
      readiness = { ...next };
    },
    states,
    opened,
    lower,
    returnToApp: () => returnHandler?.(),
    screenRequests,
    microphoneRequests
  };
}

function activePrompt(states: RecordingState[]): Extract<RecordingState, { phase: "permission" }> {
  const state = states.at(-1);
  if (state?.phase !== "permission") throw new Error("permission prompt missing");
  return state;
}

beforeEach(() => {
  cancelRecordingPermissionPrompt();
  moduleMocks.readRecordingReadiness.mockReset();
  vi.clearAllMocks();
});

describe("RecordingPermissionPrompter", () => {
  test("production checks required screen access before opening the selector", async () => {
    const source = await readFile(new URL("../../index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function runInteractiveRecord(");
    const end = source.indexOf("/**\n * Protocol resolver", start);
    const flow = source.slice(start, end);
    const activeGuard = flow.indexOf("if (isRecordingActive())");
    const prompt = flow.indexOf("requestRecordingPermissions(");
    const guard = flow.indexOf("guardScreenCapture(");
    const picker = flow.indexOf("await pickRegion(");
    expect(activeGuard).toBeGreaterThanOrEqual(0);
    expect(activeGuard).toBeLessThan(prompt);
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeLessThan(guard);
    expect(guard).toBeLessThan(picker);
  });

  test("returns immediately when every requested capability is granted", async () => {
    const h = harness();
    await expect(
      h.prompt.begin({ microphone: true, systemAudio: true }, 7)
    ).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: true, systemAudio: true }
    });
    expect(h.states).toEqual([]);
  });

  test("lists only requested gaps and continues with a per-take copy", async () => {
    const h = harness({ ...granted, microphone: "denied", systemAudio: "denied" });
    const requested = { microphone: true, systemAudio: false };
    const outcome = h.prompt.begin(requested, 7);
    const state = activePrompt(h.states);

    expect(state.prompt.missing).toEqual([
      { permission: "microphone", status: "denied" }
    ]);
    await h.prompt.act({
      requestId: state.prompt.requestId,
      action: "continueWithout",
      permission: "microphone"
    });

    await expect(outcome).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: false, systemAudio: false }
    });
    expect(requested).toEqual({ microphone: true, systemAudio: false });
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
  });

  test("screen remains required and Cancel resolves cleanly", async () => {
    const h = harness({ ...granted, screenRecording: "denied" });
    const outcome = h.prompt.begin({ microphone: false, systemAudio: false }, 7);
    const state = activePrompt(h.states);

    await expect(
      h.prompt.act({
        requestId: state.prompt.requestId,
        action: "continueWithout",
        permission: "screen"
      })
    ).rejects.toMatchObject({
      code: "screen_required"
    });
    await h.prompt.act({ requestId: state.prompt.requestId, action: "cancel" });
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
  });

  test("recheck proceeds after the OS grant changes", async () => {
    const h = harness({ ...granted, microphone: "denied" });
    const outcome = h.prompt.begin({ microphone: true, systemAudio: false }, 7);
    const state = activePrompt(h.states);
    h.setReadiness(granted);

    await h.prompt.act({ requestId: state.prompt.requestId, action: "recheck" });
    await expect(outcome).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: true, systemAudio: false }
    });
  });

  test("opens Settings lowered and does not republish until PwrSnap regains focus", async () => {
    const h = harness({ ...granted, microphone: "denied" });
    const outcome = h.prompt.begin({ microphone: true, systemAudio: false }, 7);
    const state = activePrompt(h.states);
    const stateCount = h.states.length;

    await h.prompt.act({
      requestId: state.prompt.requestId,
      action: "openSettings",
      permission: "microphone"
    });
    expect(h.lower).toHaveBeenCalledTimes(1);
    expect(h.opened).toEqual(["microphone"]);
    expect(h.states).toHaveLength(stateCount);

    h.setReadiness(granted);
    h.returnToApp();
    await expect(outcome).resolves.toMatchObject({ status: "ready" });
  });

  test("probes screen access before opening the privacy pane", async () => {
    const h = harness({ ...granted, screenRecording: "denied" });
    void h.prompt.begin({ microphone: false, systemAudio: false }, 7);
    const state = activePrompt(h.states);

    await h.prompt.act({
      requestId: state.prompt.requestId,
      action: "openSettings",
      permission: "screen"
    });
    expect(h.screenRequests.count).toBe(1);
    expect(h.opened).toEqual(["screen"]);
  });

  test("requests first-use microphone access and proceeds immediately when granted", async () => {
    const h = harness({ ...granted, microphone: "not-determined" });
    const outcome = h.prompt.begin({ microphone: true, systemAudio: false }, 7);
    const state = activePrompt(h.states);

    const action = h.prompt.act({
      requestId: state.prompt.requestId,
      action: "openSettings",
      permission: "microphone"
    });
    h.setReadiness(granted);
    await action;

    expect(h.microphoneRequests.count).toBe(1);
    expect(h.opened).toEqual([]);
    await expect(outcome).resolves.toMatchObject({ status: "ready" });
  });

  test("opens microphone settings only after a first-use request is denied", async () => {
    const h = harness({ ...granted, microphone: "not-determined" });
    const outcome = h.prompt.begin({ microphone: true, systemAudio: false }, 7);
    const state = activePrompt(h.states);

    await h.prompt.act({
      requestId: state.prompt.requestId,
      action: "openSettings",
      permission: "microphone"
    });

    expect(h.microphoneRequests.count).toBe(1);
    expect(h.lower).toHaveBeenCalledTimes(1);
    expect(h.opened).toEqual(["microphone"]);
    h.prompt.cancel();
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });

  test("controller loss cancels the production prompt instead of wedging it", async () => {
    moduleMocks.readRecordingReadiness.mockReturnValue({
      ...granted,
      microphone: "denied"
    });
    const outcome = requestRecordingPermissions(
      { microphone: true, systemAudio: false },
      7
    );

    moduleMocks.controllerUnavailable?.();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });
});
