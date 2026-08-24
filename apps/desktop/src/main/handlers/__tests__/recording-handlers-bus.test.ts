// Unit coverage for the `recording:*` and `permissions:*` IPC-envelope
// sanity surface — formerly five tests in
// `apps/desktop/e2e/recording-flow.spec.ts` ("recording flow — command
// bus" describe block).
//
// The original E2E suite was the most repeatable victim of the Linux
// xvfb launch-budget flake class: a 30s test timeout in
// `launchPwrSnap()` plus a 30s worker teardown, both of which produced
// the "1 flaky, 1 error not part of any test" CI exit-1 pattern. Each
// test here finishes in ~10ms; the bus call itself is the entire
// surface, no DOM, no window state observation.
//
// What's covered:
//   • recording:state idle on a fresh launch (default RecordingState)
//   • recording:cancel always succeeds (unconditional reset contract)
//   • recording:restart from idle returns validation/not_recording
//   • recording:retry validates session identity, guards stale failures,
//     and never returns raw process detail
//   • recording:dismissFailure validates + guards stale failure cards
//   • permissions:readiness shape (status strings + explicit evidence + fingerprint)
//   • permission actions reject unknown permission names
//
// Strategy mirrors editor-handlers.test.ts: vi.mock electron's
// systemPreferences + the recording service so we don't touch macOS TCC
// or spawn the Swift recorder binary.

import type { PwrSnapError, Result } from "@pwrsnap/shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Full RecordingService surface. `start`, `stop`, and `isActive` remain
// intentionally unimplemented `vi.fn()` stubs: present so the mock satisfies
// the interface shape, but an accidental invocation surfaces as a clean test
// failure rather than a TypeError.
const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => undefined),
  restart: vi.fn(async () => {
    throw new Error("not_recording");
  }),
  retry: vi.fn(async (sessionId: string) => ({ sessionId: `retry-${sessionId}` })),
  claimRetry: vi.fn(() => ({
    subject: { kind: "display" as const, displayId: 1 },
    capabilities: { microphone: false, systemAudio: false },
    countdownSeconds: 0
  })),
  releaseRetry: vi.fn(),
  dismissFailure: vi.fn(async (_sessionId: string) => undefined),
  start: vi.fn(),
  stop: vi.fn(),
  isActive: vi.fn(() => false),
  logError: vi.fn()
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  // `recording-permissions.ts` calls systemPreferences.getMediaAccessStatus
  // on darwin only; on Linux the helpers short-circuit to "granted".
  // We default the test runtime to Linux behavior so the readiness shape
  // is deterministic regardless of the host. Tests that need to assert
  // a specific status can override process.platform locally.
  systemPreferences: {
    getMediaAccessStatus: () => "granted"
  } as unknown as typeof import("electron").systemPreferences,
  shell: {
    openExternal: async () => undefined
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
}));

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: vi.fn(async () => null),
  markScreenCapturePrompted: vi.fn(async () => undefined),
  readScreenCapturePrompted: vi.fn(async () => false)
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  ensureCapturesDirReady: vi.fn(async () => null)
}));

// Stub the persistence layer + video repo + export coordinator so
// `video:*` registrations don't pull in better-sqlite3 / ffmpeg. We
// never exercise those verbs in this file, but bus.register runs at
// import time and the module-load chain has to resolve.
vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: () => null
}));

vi.mock("../../persistence/video-repo", () => ({
  getVideoMetadata: () => null,
  normalizeRange: (range: unknown) => range,
  setDefaultRange: () => undefined
}));

vi.mock("../../recording/recording-exporter", () => ({
  exportVideoRange: async () => undefined
}));

// Stub the recording service factory before recording-handlers imports
// it. We do NOT use `__setRecordingServiceForTests` because the
// production path (`getRecordingService()`) spawns a NativeRecorderService
// on first call, which on a non-macOS test box still resolves a
// `null` binary and is safe, but on macOS would try to spawn the real
// recorder. Mocking the module keeps the test platform-agnostic.
vi.mock("../../recording/recording-service", () => ({
  getRecordingService: () => mocks
}));

vi.mock("../../recording/recording-foreground", () => ({
  snapshotRecordingForeground: vi.fn(async () => ({
    restore: vi.fn(async () => undefined)
  }))
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mocks.logError
  })
}));

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");
const screenGate = await import("../../capture/screen-permission-gate");
const storageGate = await import("../../capture/capture-storage-gate");
const { setRecordingState } = await import("../../recording/recording-state");
const originalPlatform = process.platform;

registerRecordingHandlers();

beforeEach(() => {
  setRecordingState({ phase: "idle" });
  mocks.start.mockReset();
  mocks.stop.mockReset();
  mocks.cancel.mockReset();
  mocks.cancel.mockImplementation(async () => undefined);
  mocks.restart.mockReset();
  mocks.restart.mockImplementation(async () => {
    throw new Error("not_recording");
  });
  mocks.retry.mockReset();
  mocks.retry.mockImplementation(async (sessionId: string) => ({
    sessionId: `retry-${sessionId}`
  }));
  mocks.claimRetry.mockClear();
  mocks.releaseRetry.mockClear();
  mocks.dismissFailure.mockReset();
  mocks.dismissFailure.mockImplementation(async (_sessionId: string) => undefined);
  mocks.logError.mockReset();
  vi.mocked(screenGate.guardScreenCapture).mockClear();
  vi.mocked(screenGate.guardScreenCapture).mockResolvedValue(null);
  vi.mocked(storageGate.ensureCapturesDirReady).mockClear();
  vi.mocked(storageGate.ensureCapturesDirReady).mockResolvedValue(null);
});

const RAW_PROCESS_FAILURE =
  "spawn C:\\Users\\alice\\Secret Project\\recorder.exe --token top-secret";

function expectSafeRecordingFailure(
  result: Result<unknown, PwrSnapError>,
  expectedCode: string,
  expectedMessage: string
): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected error");
  expect(result.error).toEqual({
    kind: "capture",
    code: expectedCode,
    message: expectedMessage
  });
  expect(JSON.stringify(result.error)).not.toContain(RAW_PROCESS_FAILURE);
  expect(result.error.cause).toBeUndefined();
}

describe("recording:* command-bus surface", () => {
  // Note: `recording-state.ts` holds module-level state. None of the
  // tests in this file call setRecordingState, so the default `{ phase:
  // "idle" }` is stable across this describe. If you add a test that
  // mutates the state, add a `beforeEach` that resets it explicitly —
  // within-file test order is NOT a contract.
  test("recording:state returns idle on a fresh launch", async () => {
    const result = await bus.dispatch("recording:state", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value).toEqual({ phase: "idle" });
  });

  test("recording:cancel from idle is an unconditional reset (always succeeds)", async () => {
    // The tray's Cancel menu item relies on this — it lets the user
    // clear a wedged HUD even if main-side state is out of sync. The
    // handler delegates to RecordingService.cancel(); we assert the
    // delegation happens and the Result is ok.
    mocks.cancel.mockClear();

    const result = await bus.dispatch("recording:cancel", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    expect(mocks.cancel).toHaveBeenCalledTimes(1);
  });

  test("failed state rejects generic Start, Restart, and Cancel", async () => {
    setRecordingState({
      phase: "failed",
      sessionId: "failed-owned",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });

    const started = await bus.dispatch(
      "recording:start",
      {
        subject: { kind: "display", displayId: 1 },
        capabilities: { microphone: false, systemAudio: false },
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    const restarted = await bus.dispatch("recording:restart", {}, { principal: "ipc" });
    const cancelled = await bus.dispatch("recording:cancel", {}, { principal: "ipc" });

    expect(started).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "failure_action_required" }
    });
    expect(restarted).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "control_unavailable" }
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { kind: "validation", code: "control_unavailable" }
    });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  test.each(["stopping", "processing"] as const)(
    "rejects normal Restart and Cancel during %s",
    async (phase) => {
      setRecordingState({ phase, sessionId: "finalizing-1" });
      const restarted = await bus.dispatch("recording:restart", {}, { principal: "ipc" });
      const cancelled = await bus.dispatch("recording:cancel", {}, { principal: "ipc" });

      expect(restarted).toMatchObject({
        ok: false,
        error: { kind: "validation", code: "control_unavailable" }
      });
      expect(cancelled).toMatchObject({
        ok: false,
        error: { kind: "validation", code: "control_unavailable" }
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.cancel).not.toHaveBeenCalled();
    }
  );

  test("recording:restart from idle returns validation/not_recording", async () => {
    // RecordingService.restart() throws Error("not_recording") when
    // nothing is active. The handler must translate that into a
    // validation error, NOT propagate it as an unknown handler-threw.
    const result = await bus.dispatch("recording:restart", {}, { principal: "ipc" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("not_recording");
  });

  test("recording lifecycle failures keep raw process detail in the local log only", async () => {
    mocks.start.mockRejectedValueOnce(new Error(RAW_PROCESS_FAILURE));
    const started = await bus.dispatch(
      "recording:start",
      {
        subject: { kind: "display", displayId: 1 },
        capabilities: { microphone: false, systemAudio: false },
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    expectSafeRecordingFailure(
      started,
      "recording_start_failed",
      "PwrSnap couldn't start the recorder."
    );
    expect(mocks.logError).toHaveBeenLastCalledWith("recording:start failed", {
      message: RAW_PROCESS_FAILURE
    });

    mocks.stop.mockRejectedValueOnce(new Error(RAW_PROCESS_FAILURE));
    const stopped = await bus.dispatch("recording:stop", {}, { principal: "ipc" });
    expectSafeRecordingFailure(
      stopped,
      "recording_stop_failed",
      "PwrSnap couldn't finish and save the recording."
    );
    expect(mocks.logError).toHaveBeenLastCalledWith("recording:stop failed", {
      message: RAW_PROCESS_FAILURE
    });

    mocks.restart.mockRejectedValueOnce(new Error(RAW_PROCESS_FAILURE));
    const restarted = await bus.dispatch("recording:restart", {}, { principal: "ipc" });
    expectSafeRecordingFailure(
      restarted,
      "recording_restart_failed",
      "PwrSnap couldn't start the recorder."
    );
    expect(mocks.logError).toHaveBeenLastCalledWith("recording:restart failed", {
      message: RAW_PROCESS_FAILURE
    });

    mocks.cancel.mockRejectedValueOnce(new Error(RAW_PROCESS_FAILURE));
    const cancelled = await bus.dispatch("recording:cancel", {}, { principal: "ipc" });
    expectSafeRecordingFailure(
      cancelled,
      "recording_cancel_failed",
      "PwrSnap couldn't cancel the recording. Open the log file for details."
    );
    expect(mocks.logError).toHaveBeenLastCalledWith("recording:cancel failed", {
      message: RAW_PROCESS_FAILURE
    });

    mocks.dismissFailure.mockRejectedValueOnce(new Error(RAW_PROCESS_FAILURE));
    const dismissed = await bus.dispatch(
      "recording:dismissFailure",
      { sessionId: "failed-1" },
      { principal: "ipc" }
    );
    expectSafeRecordingFailure(
      dismissed,
      "recording_dismiss_failed",
      "PwrSnap couldn't dismiss the failure. Open the log file for details."
    );
    expect(mocks.logError).toHaveBeenLastCalledWith(
      "recording:dismissFailure failed",
      { message: RAW_PROCESS_FAILURE }
    );
  });

  test("recording:retry validates and forwards the failed session id", async () => {
    const invalid = await bus.dispatch(
      "recording:retry",
      { sessionId: "" },
      { principal: "ipc" }
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected error");
    expect(invalid.error.code).toBe("invalid_session");
    expect(mocks.retry).not.toHaveBeenCalled();

    const result = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-1" },
      { principal: "ipc" }
    );
    expect(result).toEqual({ ok: true, value: { sessionId: "retry-failed-1" } });
    expect(mocks.claimRetry).toHaveBeenCalledWith("failed-1");
    expect(mocks.retry).toHaveBeenCalledWith(
      "failed-1",
      expect.objectContaining({
        subject: { kind: "display", displayId: 1 },
        capabilities: { microphone: false, systemAudio: false }
      })
    );
    expect(mocks.releaseRetry).toHaveBeenCalledWith("failed-1");
    expect(screenGate.guardScreenCapture).toHaveBeenCalledWith({
      routeToSettings: false
    });
    expect(storageGate.ensureCapturesDirReady).toHaveBeenCalledTimes(1);
  });

  test("recording:retry releases its claim when authoritative preflight blocks", async () => {
    vi.mocked(screenGate.guardScreenCapture).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "permission",
        code: "screen_recording_not_granted",
        message: "Screen Recording permission is required."
      }
    });

    const result = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-permission" },
      { principal: "rpc" }
    );

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "permission", code: "screen_recording_not_granted" }
    });
    expect(mocks.claimRetry).toHaveBeenCalledWith("failed-permission");
    expect(mocks.retry).not.toHaveBeenCalled();
    expect(mocks.releaseRetry).toHaveBeenCalledWith("failed-permission");
    expect(storageGate.ensureCapturesDirReady).not.toHaveBeenCalled();
  });

  test("recording:retry rejects malformed runtime requests without handler_threw", async () => {
    for (const req of [null, "failed-1", 42, []] as const) {
      const result = await bus.dispatch(
        "recording:retry",
        req as never,
        { principal: "ipc" }
      );
      expect(result).toEqual({
        ok: false,
        error: {
          kind: "validation",
          code: "invalid_session",
          message: "A valid failed recording session is required."
        }
      });
      expect(JSON.stringify(result)).not.toContain("handler_threw");
    }
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  test("recording:retry maps stale failures without exposing backend detail", async () => {
    mocks.claimRetry.mockImplementationOnce(() => {
      throw new Error("stale_failure");
    });

    const result = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-old" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toEqual({
      kind: "validation",
      code: "stale_failure",
      message: "That recording failure is no longer current."
    });
  });

  test("recording:retry replaces a raw process error with allowlisted copy", async () => {
    const raw = "spawn C:\\Users\\alice\\Secret\\ffmpeg.exe --token top-secret";
    mocks.retry.mockRejectedValueOnce(new Error(raw));

    const result = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-1" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("capture");
    expect(result.error.code).toBe("recording_retry_failed");
    expect(result.error.message).toBe("PwrSnap couldn't start the recorder.");
    expect(result.error.message).not.toContain(raw);
    expect(result.error.cause).toBeUndefined();
    expect(JSON.stringify(result.error)).not.toContain(raw);
    expect(mocks.logError).toHaveBeenCalledWith("recording:retry failed", {
      message: raw
    });
  });

  test("recording:dismissFailure validates, forwards, and guards stale cards", async () => {
    const invalid = await bus.dispatch(
      "recording:dismissFailure",
      { sessionId: "" },
      { principal: "ipc" }
    );
    expect(invalid.ok).toBe(false);
    if (invalid.ok) throw new Error("expected error");
    expect(invalid.error.code).toBe("invalid_session");
    expect(mocks.dismissFailure).not.toHaveBeenCalled();

    const dismissed = await bus.dispatch(
      "recording:dismissFailure",
      { sessionId: "failed-1" },
      { principal: "ipc" }
    );
    expect(dismissed).toEqual({ ok: true, value: undefined });
    expect(mocks.dismissFailure).toHaveBeenCalledWith("failed-1");

    mocks.dismissFailure.mockRejectedValueOnce(new Error("stale_failure"));
    const stale = await bus.dispatch(
      "recording:dismissFailure",
      { sessionId: "failed-old" },
      { principal: "ipc" }
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected error");
    expect(stale.error).toEqual({
      kind: "validation",
      code: "stale_failure",
      message: "That recording failure is no longer current."
    });
  });

  test("recording:dismissFailure rejects malformed runtime requests without handler_threw", async () => {
    for (const req of [null, "failed-1", 42, []] as const) {
      const result = await bus.dispatch(
        "recording:dismissFailure",
        req as never,
        { principal: "ipc" }
      );
      expect(result).toEqual({
        ok: false,
        error: {
          kind: "validation",
          code: "invalid_session",
          message: "A valid failed recording session is required."
        }
      });
      expect(JSON.stringify(result)).not.toContain("handler_threw");
    }
    expect(mocks.dismissFailure).not.toHaveBeenCalled();
  });
});

describe("permissions:* command-bus surface", () => {
  test("permissions:readiness returns the expected shape", async () => {
    const result = await bus.dispatch("permissions:readiness", {}, { principal: "ipc" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const r = result.value;
    const validStatuses = [
      "granted",
      "denied",
      "not-determined",
      "restricted",
      "unavailable",
      "unknown"
    ];
    expect(validStatuses).toContain(r.screenRecording);
    expect(validStatuses).toContain(r.microphone);
    expect(validStatuses).toContain(r.systemAudio);
    expect(["darwin", "win32", "other"]).toContain(r.permissionEvidence.platform);
    expect(r.permissionEvidence).toHaveProperty("screen.kind");
    expect(r.permissionEvidence).toHaveProperty("microphone.kind");
    expect(r.permissionEvidence).toHaveProperty("systemAudio.kind");
    // Superset field over RecordingReadiness: whether PwrSnap has ever
    // triggered the screen prompt. Settings handlers aren't registered in
    // this file, so the gate's settings:read returns unknown_command and
    // the flag defaults to false — but the field must always be present.
    expect(typeof r.screenCapturePrompted).toBe("boolean");
    // 16-char hex prefix of a sha1 over the permission triple +
    // recorder backend. Stability is the contract — the routing memory
    // compares fingerprints across boots to decide whether to re-prompt.
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("permissions:request rejects unknown permission names", async () => {
    const result = await bus.dispatch(
      "permissions:request",
      // Bypass the type guard — a buggy renderer (or a future MCP / HTTP
      // RPC caller) could ship an arbitrary string. The validator at
      // the bus boundary closes that hole.
      { permission: "bogus" } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("unknown_permission");
  });

  test("permissions:request reports unknown without prompting off Darwin", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    try {
      const result = await bus.dispatch(
        "permissions:request",
        { permission: "microphone" },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toEqual({ status: "unknown" });
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true
      });
    }
  });

  test("permissions:openSystemSettings rejects unknown permission names", async () => {
    const result = await bus.dispatch(
      "permissions:openSystemSettings",
      { permission: "bogus" } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("unknown_permission");
  });

  test("permissions:openSystemSettings returns typed unsupported for Windows system audio", async () => {
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true
    });
    try {
      const result = await bus.dispatch(
        "permissions:openSystemSettings",
        { permission: "systemAudio" },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected error");
      expect(result.error).toMatchObject({
        kind: "permission",
        code: "permission_settings_unsupported"
      });
      expect(result.error.message).toContain("video-only");
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true
      });
    }
  });
});
