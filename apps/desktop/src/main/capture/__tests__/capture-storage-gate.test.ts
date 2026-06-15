// Pins the pre-capture storage gate: it must succeed silently when the
// captures dir is writable, and short-circuit with an actionable error
// (distinguishing a macOS TCC denial from any other failure) otherwise.
// This is what pulls the Documents-folder consent prompt onto a clean
// screen instead of under the screen-saver-level region selector.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mkdirMock = vi.hoisted(() => ({
  impl: async (_path: string, _opts: unknown): Promise<void> => undefined
}));

vi.mock("node:fs/promises", () => ({
  mkdir: (path: string, opts: unknown) => mkdirMock.impl(path, opts)
}));

vi.mock("../../persistence/paths", () => ({
  getCapturesRoot: () => "/Users/test/Documents/PwrSnap"
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

// Use the real isPermissionDenial (pure errno check) — don't mock it, so
// the EPERM→denied classification is exercised end to end.

beforeEach(() => {
  vi.resetModules();
  mkdirMock.impl = async () => undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureCapturesDirReady", () => {
  test("writable captures dir → proceeds (null)", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    mkdirMock.impl = async (path: string, opts: unknown) => {
      calls.push({ path, opts });
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    expect(result).toBeNull();
    // Recursive mkdir of the captures root — idempotent + triggers the
    // Documents TCC prompt on first access.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe("/Users/test/Documents/PwrSnap");
    expect(calls[0]?.opts).toEqual({ recursive: true });
  });

  test("EPERM (TCC denial) → actionable Documents-access error", async () => {
    mkdirMock.impl = async () => {
      const e = new Error("operation not permitted") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("capture");
    expect(result.error.code).toBe("captures_dir_denied");
    expect(result.error.message).toContain("Documents");
  });

  test("non-permission failure → generic unwritable error", async () => {
    mkdirMock.impl = async () => {
      const e = new Error("disk full") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("captures_dir_unwritable");
  });
});
