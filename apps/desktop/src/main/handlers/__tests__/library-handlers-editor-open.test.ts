// Unit coverage for the `editor:open` not_found branch — formerly the
// `editor:open returns not_found for a missing capture` E2E spec in
// `apps/desktop/e2e/editor.spec.ts`.
//
// The E2E version was a worst-case IPC-envelope flake: a 30s test budget
// spent entirely inside `launchPwrSnap()`. The handler itself is one
// `getCaptureById` lookup, a null-check, and an `err(...)`. Driving it
// through a unit test takes ~10ms with full deterministic control over
// the repo response, eliminating the launch-budget flake class for this
// surface.
//
// Strategy mirrors layers-handlers-canvas.test.ts: mock the persistence
// layer + electron broadcast surface; let the bus dispatch through.

import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCaptureById: vi.fn<(id: string) => unknown>(),
  createMainWindow: vi.fn(),
  findMainLibraryWindow: vi.fn()
}));

vi.mock("../../persistence/captures-repo", () => ({
  getCaptureById: (id: string) => mocks.getCaptureById(id),
  // Other exports the handler module touches at load time — return safe
  // no-ops so the import doesn't crash.
  listCaptures: () => ({ rows: [], nextCursor: null }),
  getAppStats: () => [],
  getTotalLive: () => 0,
  hardDeleteCapture: () => undefined,
  listSoftDeletedIds: () => [],
  restoreCapture: () => undefined,
  softDeleteCapture: () => undefined
}));

vi.mock("../../persistence/enrichment-repo", () => ({
  addUserTag: () => ({}),
  removeTag: () => ({})
}));

vi.mock("../../persistence/bundle-store", () => ({
  moveBundlePairToTrash: async () => undefined,
  purgeBundlePairFromTrash: async () => undefined,
  restoreBundlePairFromTrash: async () => undefined
}));

vi.mock("../../persistence/source-store", () => ({
  moveSourceToTrash: async () => undefined,
  purgeCacheForCapture: async () => undefined,
  purgeOneFromTrash: async () => undefined,
  restoreSourceFromTrash: async () => undefined
}));

vi.mock("../../window", () => ({
  createMainWindow: mocks.createMainWindow,
  findMainLibraryWindow: mocks.findMainLibraryWindow
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  },
  clipboard: {
    writeText: () => undefined
  }
}));

const { bus } = await import("../../command-bus");
const { registerLibraryHandlers } = await import("../library-handlers");

registerLibraryHandlers();

describe("editor:open", () => {
  test("returns not_found when the capture row does not exist", async () => {
    mocks.getCaptureById.mockReturnValueOnce(null);

    const result = await bus.dispatch(
      "editor:open",
      { captureId: "no-such-capture-xyz" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("not_found");
    expect(result.error.message).toContain("no-such-capture-xyz");
    expect(mocks.createMainWindow).not.toHaveBeenCalled();
  });

  test("returns deleted when the capture is in the trash", async () => {
    mocks.getCaptureById.mockReturnValueOnce({
      id: "cap-trashed",
      deleted_at: "2026-05-27T12:00:00.000Z"
    });

    const result = await bus.dispatch(
      "editor:open",
      { captureId: "cap-trashed" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("validation");
    expect(result.error.code).toBe("deleted");
    expect(mocks.createMainWindow).not.toHaveBeenCalled();
  });

  test("opens a live capture in the Library Focus surface", async () => {
    const send = vi.fn();
    const fakeWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      focus: vi.fn(),
      webContents: {
        isLoading: () => false,
        send
      }
    };
    mocks.getCaptureById.mockReturnValueOnce({
      id: "cap-live",
      deleted_at: null
    });
    mocks.findMainLibraryWindow.mockReturnValueOnce(fakeWindow);

    const result = await bus.dispatch(
      "editor:open",
      { captureId: "cap-live" },
      { principal: "ipc" }
    );

    expect(result.ok).toBe(true);
    expect(fakeWindow.focus).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("events:library:open-capture", {
      captureId: "cap-live"
    });
  });

  // The channel is latched in the preload, so one send after load is the
  // whole contract. The old code resent 100ms later to a loaded window and
  // added a 100ms grace after load. Both were guesses at when React
  // subscribes. Pin that neither comes back.
  test("sends to a loaded Library exactly once, with no timed resend", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      mocks.getCaptureById.mockReturnValueOnce({ id: "cap-once", deleted_at: null });
      mocks.findMainLibraryWindow.mockReturnValueOnce({
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        focus: vi.fn(),
        webContents: { isLoading: () => false, send }
      });

      const result = await bus.dispatch(
        "editor:open",
        { captureId: "cap-once" },
        { principal: "ipc" }
      );
      await vi.advanceTimersByTimeAsync(5_000);

      expect(result.ok).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // `isLoading()` stays true until `did-stop-loading`, which fires AFTER
  // `did-finish-load`. A request in that gap that waited on
  // `did-finish-load` waited for an event that had already happened, and
  // the capture never opened (the editor-v2-capture-open E2E flake). The
  // wait must be on the event that ends the state it checked.
  test("waits for did-stop-loading on a loading Library, then sends once immediately", async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn();
      const listeners = new Map<string, Array<() => void>>();
      mocks.getCaptureById.mockReturnValueOnce({ id: "cap-loading", deleted_at: null });
      mocks.findMainLibraryWindow.mockReturnValueOnce({
        isDestroyed: () => false,
        isMinimized: () => false,
        isVisible: () => true,
        focus: vi.fn(),
        webContents: {
          isLoading: () => true,
          send,
          once: (event: string, listener: () => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          }
        }
      });

      const result = await bus.dispatch(
        "editor:open",
        { captureId: "cap-loading" },
        { principal: "ipc" }
      );

      expect(result.ok).toBe(true);
      expect(send).not.toHaveBeenCalled();
      expect([...listeners.keys()]).toEqual(["did-stop-loading"]);
      for (const listener of listeners.get("did-stop-loading") ?? []) listener();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith("events:library:open-capture", {
        captureId: "cap-loading"
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
