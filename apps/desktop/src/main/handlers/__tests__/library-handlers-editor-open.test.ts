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
  createEditWindow: vi.fn(),
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
  createEditWindow: mocks.createEditWindow,
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
    // not_found must short-circuit before window creation — otherwise we
    // would spawn an empty edit window for a deleted/missing capture id.
    expect(mocks.createEditWindow).not.toHaveBeenCalled();
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
    expect(mocks.createEditWindow).not.toHaveBeenCalled();
  });
});
