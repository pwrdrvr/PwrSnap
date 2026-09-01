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
//   • permissions:readiness shape (status strings + explicit evidence + fingerprint)
//   • permission actions reject unknown permission names
//
// Strategy mirrors editor-handlers.test.ts: vi.mock electron's
// systemPreferences + the recording service so we don't touch macOS TCC
// or spawn the Swift recorder binary.

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { PwrSnapError, Result } from "@pwrsnap/shared";

// Full RecordingService surface — only `cancel` and `restart` are
// exercised by the 5 tests in this file. `start`, `stop`, `isActive`
// are intentionally unimplemented `vi.fn()` stubs: present so the mock
// satisfies the interface shape, but a test that accidentally invoked
// them would surface as a clean assertion failure rather than a
// TypeError. Add a real implementation only when a new test exercises
// the verb.
const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => undefined),
  restart: vi.fn(async () => {
    throw new Error("not_recording");
  }),
  start: vi.fn(),
  stop: vi.fn(),
  retryCapabilities: vi.fn(() => ({ microphone: false, systemAudio: false })),
  retry: vi.fn(async () => ({ sessionId: "retry-session" })),
  dismissFailure: vi.fn(async () => undefined),
  isActive: vi.fn(() => false),
  guardScreenCapture: vi.fn<() => Promise<Result<never, PwrSnapError> | null>>(
    async () => null
  ),
  ensureCapturesDirReady: vi.fn<() => Promise<Result<never, PwrSnapError> | null>>(
    async () => null
  ),
  mediaAccess: {
    screen: "granted",
    microphone: "granted"
  } as Record<string, string>
}));

vi.mock("electron", (): Partial<typeof import("electron")> => ({
  // `recording-permissions.ts` calls systemPreferences.getMediaAccessStatus
  // on darwin only; on Linux the helpers short-circuit to "granted".
  // We default the test runtime to Linux behavior so the readiness shape
  // is deterministic regardless of the host. Tests that need to assert
  // a specific status can override process.platform locally.
  systemPreferences: {
    getMediaAccessStatus: (permission: string) => mocks.mediaAccess[permission] ?? "granted"
  } as unknown as typeof import("electron").systemPreferences,
  shell: {
    openExternal: async () => undefined
  } as unknown as typeof import("electron").shell,
  BrowserWindow: {
    getAllWindows: () => []
  } as unknown as typeof import("electron").BrowserWindow
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

vi.mock("../../capture/screen-permission-gate", () => ({
  guardScreenCapture: () => mocks.guardScreenCapture(),
  markScreenCapturePrompted: vi.fn(async () => undefined),
  readScreenCapturePrompted: vi.fn(async () => false)
}));

vi.mock("../../capture/capture-storage-gate", () => ({
  ensureCapturesDirReady: () => mocks.ensureCapturesDirReady()
}));

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");
const { setRecordingState } = await import("../../recording/recording-state");
const originalPlatform = process.platform;

registerRecordingHandlers();

beforeEach(() => {
  setRecordingState({ phase: "idle" });
  mocks.cancel.mockClear();
  mocks.restart.mockClear();
  mocks.start.mockClear();
  mocks.retryCapabilities.mockReset();
  mocks.retryCapabilities.mockReturnValue({ microphone: false, systemAudio: false });
  mocks.retry.mockClear();
  mocks.dismissFailure.mockClear();
  mocks.guardScreenCapture.mockReset();
  mocks.guardScreenCapture.mockResolvedValue(null);
  mocks.ensureCapturesDirReady.mockReset();
  mocks.ensureCapturesDirReady.mockResolvedValue(null);
  mocks.mediaAccess.screen = "granted";
  mocks.mediaAccess.microphone = "granted";
});

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

  test("failed state blocks generic start/cancel/restart and allows only session recovery", async () => {
    setRecordingState({
      phase: "failed",
      sessionId: "failed-session",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });

    const start = await bus.dispatch(
      "recording:start",
      {
        subject: { kind: "display", displayId: 1 },
        capabilities: { microphone: false, systemAudio: false },
        countdownSeconds: 0
      },
      { principal: "ipc" }
    );
    const cancel = await bus.dispatch("recording:cancel", {}, { principal: "ipc" });
    const restart = await bus.dispatch("recording:restart", {}, { principal: "ipc" });

    expect(start.ok).toBe(false);
    expect(cancel.ok).toBe(false);
    expect(restart.ok).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();

    const retry = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-session" },
      { principal: "ipc" }
    );
    expect(retry).toEqual({ ok: true, value: { sessionId: "retry-session" } });
    expect(mocks.retryCapabilities).toHaveBeenCalledWith("failed-session");
    expect(mocks.guardScreenCapture).toHaveBeenCalledTimes(1);
    expect(mocks.ensureCapturesDirReady).toHaveBeenCalledTimes(1);
    expect(mocks.retry).toHaveBeenCalledWith("failed-session");

    const dismiss = await bus.dispatch(
      "recording:dismissFailure",
      { sessionId: "failed-session" },
      { principal: "ipc" }
    );
    expect(dismiss).toEqual({ ok: true, value: undefined });
    expect(mocks.dismissFailure).toHaveBeenCalledWith("failed-session");
  });

  test("retry stops at the shared screen and storage preflight gates", async () => {
    setRecordingState({
      phase: "failed",
      sessionId: "failed-session",
      code: "recorder_exited",
      canRetry: true,
      displayId: 1
    });
    mocks.guardScreenCapture.mockResolvedValueOnce({
      ok: false,
      error: { kind: "permission", code: "screen_not_granted", message: "Grant screen access." }
    });

    const screenBlocked = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-session" },
      { principal: "ipc" }
    );
    expect(screenBlocked).toMatchObject({
      ok: false,
      error: { code: "screen_not_granted" }
    });
    expect(mocks.ensureCapturesDirReady).not.toHaveBeenCalled();
    expect(mocks.retry).not.toHaveBeenCalled();

    mocks.ensureCapturesDirReady.mockResolvedValueOnce({
      ok: false,
      error: { kind: "persistence", code: "captures_not_writable", message: "Choose storage." }
    });
    const storageBlocked = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-session" },
      { principal: "ipc" }
    );
    expect(storageBlocked).toMatchObject({
      ok: false,
      error: { code: "captures_not_writable" }
    });
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  test("retry rechecks revoked audio permission from the original capability snapshot", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      setRecordingState({
        phase: "failed",
        sessionId: "failed-session",
        code: "recorder_exited",
        canRetry: true,
        displayId: 1
      });
      mocks.retryCapabilities.mockReturnValueOnce({
        microphone: true,
        systemAudio: false
      });
      mocks.mediaAccess.microphone = "denied";

      const result = await bus.dispatch(
        "recording:retry",
        { sessionId: "failed-session" },
        { principal: "ipc" }
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "microphone_not_granted" }
      });
      expect(mocks.retry).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", {
        value: originalPlatform,
        configurable: true
      });
    }
  });

  test("retry failures return fixed safe copy instead of raw process detail", async () => {
    setRecordingState({
      phase: "failed",
      sessionId: "failed-session",
      code: "recorder_spawn_failed",
      canRetry: true,
      displayId: 1
    });
    mocks.retry.mockRejectedValueOnce(
      new Error("C:\\Users\\private\\PwrSnapFFmpeg.exe --token secret")
    );

    const result = await bus.dispatch(
      "recording:retry",
      { sessionId: "failed-session" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.message).toBe("The video recorder couldn't start.");
    expect(JSON.stringify(result)).not.toContain("PwrSnapFFmpeg.exe");
    expect(JSON.stringify(result)).not.toContain("--token");
  });

  test.each([
    ["spoofed title", "Untrusted renderer title"],
    ["non-string title", { nested: "value" }]
  ])("recording:start rejects %s before touching the recorder", async (_name, windowTitle) => {
    const result = await bus.dispatch(
      "recording:start",
      {
        subject: {
          kind: "window",
          windowId: 77,
          rect: { x: 0, y: 0, w: 100, h: 100 },
          displayId: 1,
          windowTitle
        },
        capabilities: { systemAudio: false, microphone: false },
        countdownSeconds: 0
      } as never,
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("invalid_recording_start");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  test.each([
    ["rect", { x: 0, y: 0, w: 0, h: 100 }],
    ["displayId", 1.5],
    ["windowId", -1],
    ["appName", 42],
    ["appBundleId", { path: "spoof" }]
  ])("recording:start validates window subject field %s", async (field, invalidValue) => {
    const subject: Record<string, unknown> = {
      kind: "window",
      windowId: 77,
      rect: { x: 0, y: 0, w: 100, h: 100 },
      displayId: 1,
      appName: "Example",
      appBundleId: "com.example"
    };
    subject[field] = invalidValue;
    const result = await bus.dispatch(
      "recording:start",
      {
        subject,
        capabilities: { systemAudio: false, microphone: false },
        countdownSeconds: 0
      } as never,
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  test.each([
    ["capabilities", { systemAudio: "yes", microphone: false }],
    ["countdownSeconds", 31],
    ["captureCursor", "yes"],
    ["unknown", true]
  ])("recording:start validates top-level field %s", async (field, invalidValue) => {
    const request: Record<string, unknown> = {
      subject: {
        kind: "region",
        rect: { x: 0, y: 0, w: 100, h: 100 },
        displayId: 1
      },
      capabilities: { systemAudio: false, microphone: false },
      countdownSeconds: 0
    };
    request[field] = invalidValue;
    const result = await bus.dispatch(
      "recording:start",
      request as never,
      { principal: "ipc" }
    );
    expect(result.ok).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
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

  test.each(["screen", "systemAudio"] as const)(
    "permissions:openSystemSettings rejects unsupported Windows %s settings",
    async (permission) => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true
      });
      try {
        const result = await bus.dispatch(
          "permissions:openSystemSettings",
          { permission },
          { principal: "ipc" }
        );

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected error");
        expect(result.error.kind).toBe("permission");
        expect(result.error.code).toBe("permission_settings_unsupported");
      } finally {
        Object.defineProperty(process, "platform", {
          value: originalPlatform,
          configurable: true
        });
      }
    }
  );
});
