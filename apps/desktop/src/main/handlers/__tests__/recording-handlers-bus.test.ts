// Unit coverage for the `recording:*` and `permissions:*` IPC-envelope
// sanity surface — formerly five tests in
// `apps/desktop/e2e/recording-flow.spec.ts` ("recording flow — command
// bus" describe block).
//
// The original E2E suite was the most repeatable victim of the Linux
// xvfb launch-budget flake class: a 30s test timeout in
// `launchPwrSnap()` plus a 30s worker teardown, both of which produced
// the "1 flaky, 1 error not part of any test" CI exit-1 pattern on PR
// #125 (runs 26549457564 + 26550169080). Each test here finishes in
// ~10ms; the bus call itself is the entire surface, no DOM, no window
// state observation.
//
// What's covered:
//   • recording:state idle on a fresh launch (default RecordingState)
//   • recording:cancel always succeeds (unconditional reset contract)
//   • recording:restart from idle returns validation/not_recording
//   • permissions:readiness shape (status strings + 16-char hex fingerprint)
//   • permissions:request rejects unknown permission names
//
// Strategy mirrors editor-handlers.test.ts: vi.mock electron's
// systemPreferences + the recording service so we don't touch macOS TCC
// or spawn the Swift recorder binary.

import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(async () => undefined),
  restart: vi.fn(async () => {
    throw new Error("not_recording");
  }),
  start: vi.fn(),
  stop: vi.fn(),
  isActive: vi.fn(() => false)
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

const { bus } = await import("../../command-bus");
const { registerRecordingHandlers } = await import("../recording-handlers");

registerRecordingHandlers();

describe("recording:* command-bus surface", () => {
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
});
