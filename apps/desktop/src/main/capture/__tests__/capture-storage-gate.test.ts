// Pins the pre-capture storage gate. It must confirm the captures folder
// is WRITABLE via a real write probe (not just mkdir — that's a no-op on
// an existing dir and never trips the macOS Documents TCC prompt), and
// short-circuit with an actionable, denial-classified error otherwise.
// This is what pulls the Documents consent prompt onto a clean screen
// instead of under the screen-saver-level region selector.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mirror the impl's path construction so assertions are separator-correct
// on every platform (path.join uses "\" on Windows).
const ROOT = "/Users/test/Documents/PwrSnap";
const PROBE = join(ROOT, ".pwrsnap-access-probe");

const fsMock = vi.hoisted(() => ({
  mkdir: async (_p: string, _o: unknown): Promise<void> => undefined,
  writeFile: async (_p: string, _d: unknown): Promise<void> => undefined,
  rm: async (_p: string, _o: unknown): Promise<void> => undefined,
  calls: [] as string[]
}));

vi.mock("node:fs/promises", () => ({
  mkdir: (p: string, o: unknown) => {
    fsMock.calls.push(`mkdir:${p}`);
    return fsMock.mkdir(p, o);
  },
  writeFile: (p: string, d: unknown) => {
    fsMock.calls.push(`writeFile:${p}`);
    return fsMock.writeFile(p, d);
  },
  rm: (p: string, o: unknown) => {
    fsMock.calls.push(`rm:${p}`);
    return fsMock.rm(p, o);
  }
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

// Real isPermissionDenial (pure errno check) — exercise EPERM→denied.

beforeEach(() => {
  vi.resetModules();
  fsMock.mkdir = async () => undefined;
  fsMock.writeFile = async () => undefined;
  fsMock.rm = async () => undefined;
  fsMock.calls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ensureCapturesDirReady", () => {
  test("writable: mkdir + write probe + cleanup, then proceeds (null)", async () => {
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    expect(result).toBeNull();
    // A REAL write is what forces the Documents prompt — mkdir alone is a
    // no-op on an existing dir.
    expect(fsMock.calls).toContain(`writeFile:${PROBE}`);
    expect(fsMock.calls).toContain(`mkdir:${ROOT}`);
    // Probe is cleaned up.
    expect(fsMock.calls).toContain(`rm:${PROBE}`);
  });

  test("session cache: a second call does NOT re-probe", async () => {
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    await ensureCapturesDirReady();
    fsMock.calls = [];
    const second = await ensureCapturesDirReady();
    expect(second).toBeNull();
    expect(fsMock.calls).toHaveLength(0); // no mkdir/write/rm on the hot path
  });

  test("EPERM on the write probe (TCC denial) → actionable Documents error", async () => {
    fsMock.writeFile = async () => {
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

  test("denial is NOT cached — a later granted retry proceeds", async () => {
    fsMock.writeFile = async () => {
      const e = new Error("denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      throw e;
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const denied = await ensureCapturesDirReady();
    expect(denied?.ok).toBe(false);
    // User grants in System Settings; next attempt's write succeeds.
    fsMock.writeFile = async () => undefined;
    const ok = await ensureCapturesDirReady();
    expect(ok).toBeNull();
  });

  test("non-permission failure → generic unwritable error", async () => {
    fsMock.writeFile = async () => {
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
