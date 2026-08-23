import { describe, expect, test, vi } from "vitest";
import type {
  PermissionReadinessReport,
  RecordingPermission,
  RecordingState
} from "@pwrsnap/shared";

vi.mock("../../capture/screen-permission-gate", () => ({
  markScreenCapturePrompted: async () => undefined,
  readScreenCapturePrompted: async () => false
}));

vi.mock("../recording-permissions", () => ({
  openSystemSettingsFor: async () => undefined,
  readRecordingReadiness: () => ({
    screenRecording: "granted",
    microphone: "granted",
    systemAudio: "granted",
    fingerprint: "0123456789abcdef"
  }),
  requestPermission: async () => ({ status: "granted" })
}));

vi.mock("../recording-state", () => ({
  setRecordingState: () => undefined
}));

const { RecordingPermissionPreflightCoordinator } = await import(
  "../recording-permission-preflight"
);

const grantedReport: PermissionReadinessReport = {
  screenRecording: "granted",
  microphone: "granted",
  systemAudio: "granted",
  fingerprint: "0123456789abcdef",
  screenCapturePrompted: true
};

function harness(
  initial: PermissionReadinessReport,
  options: {
    platform?: NodeJS.Platform;
  } = {}
): {
  coordinator: InstanceType<typeof RecordingPermissionPreflightCoordinator>;
  getReport: () => PermissionReadinessReport;
  setReport: (report: PermissionReadinessReport) => void;
  states: RecordingState[];
  requested: RecordingPermission[];
  opened: RecordingPermission[];
  marked: { count: number };
} {
  let report = { ...initial };
  const states: RecordingState[] = [];
  const requested: RecordingPermission[] = [];
  const opened: RecordingPermission[] = [];
  const marked = { count: 0 };
  const coordinator = new RecordingPermissionPreflightCoordinator({
    platform: options.platform ?? "linux",
    makeRequestId: () => "request-1",
    defaultDisplayId: () => 42,
    readReport: async () => ({ ...report }),
    request: async (permission) => {
      requested.push(permission);
      return {
        status:
          permission === "screen"
            ? report.screenRecording
            : permission === "microphone"
            ? report.microphone
            : report.systemAudio
      };
    },
    openSettings: async (permission) => {
      opened.push(permission);
    },
    markScreenPrompted: async () => {
      marked.count += 1;
      report = { ...report, screenCapturePrompted: true };
    },
    setState: (state) => states.push(state)
  });
  return {
    coordinator,
    getReport: () => report,
    setReport: (next) => {
      report = { ...next };
    },
    states,
    requested,
    opened,
    marked
  };
}

async function waitForPermissionState(states: RecordingState[]): Promise<Extract<
  RecordingState,
  { phase: "permission" }
>> {
  await vi.waitFor(() => {
    expect(states.at(-1)?.phase).toBe("permission");
  });
  const state = states.at(-1);
  if (state?.phase !== "permission") throw new Error("permission state missing");
  return state;
}

describe("RecordingPermissionPreflightCoordinator", () => {
  test("required screen denial cannot degrade and Cancel restores idle", async () => {
    const h = harness({ ...grantedReport, screenRecording: "denied" });
    const outcome = h.coordinator.begin({
      capabilities: { microphone: false, systemAudio: false },
      displayId: 7
    });
    const state = await waitForPermissionState(h.states);

    expect(state.preflight.displayId).toBe(7);
    expect(state.preflight.missing).toEqual([
      { permission: "screen", status: "denied" }
    ]);
    const degraded = await h.coordinator.act({
      requestId: "request-1",
      action: "continueWithout",
      permission: "screen"
    });
    expect(degraded).toMatchObject({
      ok: false,
      error: { code: "screen_capture_required" }
    });

    expect(
      await h.coordinator.act({ requestId: "request-1", action: "cancel" })
    ).toEqual({ ok: true, value: undefined });
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
  });

  test("lists only requested missing optional capabilities", async () => {
    const h = harness({
      ...grantedReport,
      microphone: "denied",
      systemAudio: "denied"
    });
    const outcome = h.coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    const state = await waitForPermissionState(h.states);
    expect(state.preflight.missing).toEqual([
      { permission: "microphone", status: "denied" }
    ]);
    h.coordinator.cancel();
    await outcome;
  });

  test("continue degraded removes each optional source only for this outcome", async () => {
    const h = harness({
      ...grantedReport,
      microphone: "denied",
      systemAudio: "unavailable"
    });
    const outcome = h.coordinator.begin({
      capabilities: { microphone: true, systemAudio: true }
    });
    await waitForPermissionState(h.states);

    await h.coordinator.act({
      requestId: "request-1",
      action: "continueWithout",
      permission: "microphone"
    });
    const afterMic = await waitForPermissionState(h.states);
    expect(afterMic.preflight.missing.map((gap) => gap.permission)).toEqual([
      "systemAudio"
    ]);
    await h.coordinator.act({
      requestId: "request-1",
      action: "continueWithout",
      permission: "systemAudio"
    });

    await expect(outcome).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: false, systemAudio: false }
    });
    expect(h.requested).toEqual([]);
    expect(h.opened).toEqual([]);
    expect(h.states.at(-1)).toEqual({ phase: "idle" });
  });

  test("recheck resumes with the originally requested capability after a grant", async () => {
    const h = harness({ ...grantedReport, microphone: "denied" });
    const outcome = h.coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    await waitForPermissionState(h.states);
    h.setReport({ ...h.getReport(), microphone: "granted" });

    expect(
      await h.coordinator.act({ requestId: "request-1", action: "recheck" })
    ).toEqual({ ok: true, value: undefined });
    await expect(outcome).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: true, systemAudio: false }
    });
  });

  test("macOS keeps the first decision raised, then probes before opening Settings", async () => {
    const h = harness(
      {
        ...grantedReport,
        screenRecording: "denied",
        screenCapturePrompted: false
      },
      { platform: "darwin" }
    );
    const outcome = h.coordinator.begin({
      capabilities: { microphone: false, systemAudio: false }
    });
    const state = await waitForPermissionState(h.states);
    // The app-owned Open Settings / Cancel choice is visible first. The
    // real capture probe happens only after that explicit action, so a
    // nonactivating panel is never lowered before its first show.
    expect(h.requested).toEqual([]);
    expect(h.marked.count).toBe(0);
    const statesBeforeOpen = h.states.length;

    await h.coordinator.act({
      requestId: "request-1",
      action: "openSettings",
      permission: "screen"
    });
    expect(h.requested).toEqual(["screen"]);
    expect(h.opened).toEqual(["screen"]);
    expect(h.marked.count).toBe(1);
    // One publish lowers the panel before Settings. openExternal resolving
    // does not trigger a refresh/publish that could focus-steal it back.
    expect(h.states).toHaveLength(statesBeforeOpen + 1);
    const awaiting = h.states.at(-1);
    expect(awaiting?.phase).toBe("permission");
    if (awaiting?.phase === "permission") {
      expect(awaiting.preflight.awaitingSettings).toBe(true);
    }
    h.coordinator.cancel();
    await outcome;
  });

  test("first microphone request does not stack Settings, second denied action does", async () => {
    const h = harness(
      { ...grantedReport, microphone: "not-determined" },
      { platform: "darwin" }
    );
    const outcome = h.coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    await waitForPermissionState(h.states);
    h.setReport({ ...h.getReport(), microphone: "denied" });
    await h.coordinator.act({
      requestId: "request-1",
      action: "openSettings",
      permission: "microphone"
    });
    expect(h.opened).toEqual([]);
    await h.coordinator.act({
      requestId: "request-1",
      action: "openSettings",
      permission: "microphone"
    });
    expect(h.opened).toEqual(["microphone"]);
    h.coordinator.cancel();
    await outcome;
  });

  test("Windows unavailable audio has no Settings action and can continue video-only", async () => {
    const h = harness(
      { ...grantedReport, microphone: "unavailable" },
      { platform: "win32" }
    );
    const outcome = h.coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    await waitForPermissionState(h.states);
    expect(
      await h.coordinator.act({
        requestId: "request-1",
        action: "openSettings",
        permission: "microphone"
      })
    ).toMatchObject({
      ok: false,
      error: { code: "permission_settings_unavailable" }
    });
    await h.coordinator.act({
      requestId: "request-1",
      action: "continueWithout",
      permission: "microphone"
    });
    await expect(outcome).resolves.toEqual({
      status: "ready",
      capabilities: { microphone: false, systemAudio: false }
    });
    expect(h.opened).toEqual([]);
  });

  test.each(["screen", "microphone"] as const)(
    "restricted %s never offers an OS Settings action",
    async (permission) => {
      const h = harness(
        {
          ...grantedReport,
          ...(permission === "screen"
            ? { screenRecording: "restricted" as const }
            : { microphone: "restricted" as const })
        },
        { platform: "darwin" }
      );
      const outcome = h.coordinator.begin({
        capabilities: {
          microphone: permission === "microphone",
          systemAudio: false
        }
      });
      await waitForPermissionState(h.states);
      const opened = await h.coordinator.act({
        requestId: "request-1",
        action: "openSettings",
        permission
      });
      expect(opened).toMatchObject({
        ok: false,
        error: { code: "permission_settings_unavailable" }
      });
      expect(h.opened).toEqual([]);
      h.coordinator.cancel();
      await outcome;
    }
  );

  test("Cancel during an in-flight permission action never opens Settings afterward", async () => {
    let releaseRequest: (value: { status: "denied" }) => void = () => {
      throw new Error("request promise was not initialized");
    };
    let requestStarted = false;
    const opened: RecordingPermission[] = [];
    const states: RecordingState[] = [];
    const coordinator = new RecordingPermissionPreflightCoordinator({
      platform: "darwin",
      makeRequestId: () => "request-1",
      readReport: async () => ({ ...grantedReport, microphone: "denied" }),
      request: async () =>
        new Promise((resolve) => {
          requestStarted = true;
          releaseRequest = resolve;
        }),
      openSettings: async (permission) => {
        opened.push(permission);
      },
      setState: (state) => states.push(state)
    });
    const outcome = coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    await waitForPermissionState(states);
    const action = coordinator.act({
      requestId: "request-1",
      action: "openSettings",
      permission: "microphone"
    });
    await vi.waitFor(() => {
      expect(requestStarted).toBe(true);
    });
    expect(coordinator.cancel()).toBe(true);
    releaseRequest({ status: "denied" });

    await expect(action).resolves.toEqual({ ok: true, value: undefined });
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(opened).toEqual([]);
    expect(states.at(-1)).toEqual({ phase: "idle" });
  });

  test("rejects concurrent and stale requests and can cancel during initialization", async () => {
    let releaseRead: (report: PermissionReadinessReport) => void = () => {
      throw new Error("read promise was not initialized");
    };
    const states: RecordingState[] = [];
    const coordinator = new RecordingPermissionPreflightCoordinator({
      platform: "linux",
      readReport: async () =>
        new Promise((resolve) => {
          releaseRead = resolve;
        }),
      setState: (state) => states.push(state)
    });
    const first = coordinator.begin({
      capabilities: { microphone: false, systemAudio: false }
    });
    await expect(
      coordinator.begin({
        capabilities: { microphone: false, systemAudio: false }
      })
    ).rejects.toThrow("permission_preflight_in_progress");
    expect(coordinator.cancel()).toBe(true);
    releaseRead(grantedReport);
    await expect(first).resolves.toEqual({ status: "cancelled" });
    expect(states).toEqual([]);

    expect(
      await coordinator.act({ requestId: "stale", action: "recheck" })
    ).toMatchObject({
      ok: false,
      error: { code: "stale_permission_preflight" }
    });
  });

  test("a cancelled async recheck cannot finish a newer request", async () => {
    const recheckRead: {
      current: ((report: PermissionReadinessReport) => void) | null;
    } = { current: null };
    let readCount = 0;
    let requestCount = 0;
    const states: RecordingState[] = [];
    const coordinator = new RecordingPermissionPreflightCoordinator({
      platform: "linux",
      makeRequestId: () => `request-${++requestCount}`,
      readReport: async () => {
        readCount += 1;
        if (readCount === 1) {
          return { ...grantedReport, microphone: "denied" };
        }
        if (readCount === 2) {
          return await new Promise<PermissionReadinessReport>((resolve) => {
            recheckRead.current = resolve;
          });
        }
        return { ...grantedReport, systemAudio: "unavailable" };
      },
      setState: (state) => states.push(state)
    });

    const first = coordinator.begin({
      capabilities: { microphone: true, systemAudio: false }
    });
    const firstState = await waitForPermissionState(states);
    expect(firstState.preflight.requestId).toBe("request-1");
    const oldRecheck = coordinator.act({
      requestId: "request-1",
      action: "recheck"
    });
    await vi.waitFor(() => expect(recheckRead.current).not.toBeNull());
    expect(coordinator.cancel()).toBe(true);
    await expect(first).resolves.toEqual({ status: "cancelled" });

    const second = coordinator.begin({
      capabilities: { microphone: false, systemAudio: true }
    });
    const secondState = await waitForPermissionState(states);
    expect(secondState.preflight.requestId).toBe("request-2");
    expect(secondState.preflight.missing).toEqual([
      { permission: "systemAudio", status: "unavailable" }
    ]);

    const release = recheckRead.current;
    if (release === null) throw new Error("recheck read did not start");
    release({ ...grantedReport, microphone: "granted" });
    await expect(oldRecheck).resolves.toEqual({ ok: true, value: undefined });
    expect(states.at(-1)).toEqual(secondState);

    await coordinator.act({ requestId: "request-2", action: "cancel" });
    await expect(second).resolves.toEqual({ status: "cancelled" });
  });
});
