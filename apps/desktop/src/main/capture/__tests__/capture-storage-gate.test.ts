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
const HOME_ROOT = "/Users/test/PwrSnap";
const PROBE = join(ROOT, ".pwrsnap-access-probe");

const fsMock = vi.hoisted(() => ({
  mkdir: async (_p: string, _o: unknown): Promise<void> => undefined,
  writeFile: async (_p: string, _d: unknown): Promise<void> => undefined,
  rm: async (_p: string, _o: unknown): Promise<void> => undefined,
  calls: [] as string[]
}));

const pathMock = vi.hoisted(() => ({
  location: "documents" as "documents" | "home",
  overridden: false
}));

const busMock = vi.hoisted(() => ({
  calls: [] as unknown[],
  result: { ok: true, value: undefined } as
    | { ok: true; value: unknown }
    | { ok: false; error: { kind: "settings"; code: string; message: string } }
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
  getCapturesLocation: () => pathMock.location,
  setCapturesLocation: (location: "documents" | "home") => {
    pathMock.location = location;
  },
  getCapturesRoot: () => (pathMock.location === "home" ? HOME_ROOT : ROOT),
  getCapturesRootForLocation: (location: "documents" | "home") =>
    location === "home" ? HOME_ROOT : ROOT,
  isOverriddenDataRoot: () => pathMock.overridden
}));

vi.mock("../../command-bus", () => ({
  bus: {
    dispatch: async (...args: unknown[]) => {
      busMock.calls.push(args);
      return busMock.result;
    }
  }
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
  pathMock.location = "documents";
  pathMock.overridden = false;
  busMock.calls = [];
  busMock.result = { ok: true, value: undefined };
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

  test("EPERM on Documents automatically persists home and retries there", async () => {
    fsMock.writeFile = async (path) => {
      if (path === join(HOME_ROOT, ".pwrsnap-access-probe")) return;
      const e = new Error("operation not permitted") as NodeJS.ErrnoException;
      e.code = "EPERM";
      e.path = path as string;
      throw e;
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    expect(result).toBeNull();
    expect(pathMock.location).toBe("home");
    expect(busMock.calls).toHaveLength(1);
    expect(fsMock.calls).toContain(
      `writeFile:${join(HOME_ROOT, ".pwrsnap-access-probe")}`
    );
  });

  test("verification-only Documents denial does not trigger fallback", async () => {
    fsMock.writeFile = async (path) => {
      const e = new Error("denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      e.path = path as string;
      throw e;
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const denied = await ensureCapturesDirReady({
      force: true,
      location: "documents",
      fallbackOnDenial: false
    });
    expect(denied?.ok).toBe(false);
    expect(pathMock.location).toBe("documents");
    expect(busMock.calls).toHaveLength(0);
    // User grants in System Settings; next attempt's write succeeds.
    fsMock.writeFile = async () => undefined;
    const ok = await ensureCapturesDirReady({
      force: true,
      location: "documents",
      fallbackOnDenial: false
    });
    expect(ok).toBeNull();
  });

  test("fallback setting failure refuses to split the library", async () => {
    fsMock.writeFile = async (path) => {
      const e = new Error("denied") as NodeJS.ErrnoException;
      e.code = "EPERM";
      e.path = path as string;
      throw e;
    };
    busMock.result = {
      ok: false,
      error: { kind: "settings", code: "write_failed", message: "read-only" }
    };
    const { ensureCapturesDirReady } = await import("../capture-storage-gate");
    const result = await ensureCapturesDirReady();
    if (result === null || result.ok) throw new Error("expected fallback failure");
    expect(result.error.code).toBe("captures_fallback_failed");
    expect(pathMock.location).toBe("documents");
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

  test("real persistence denial retries exactly once at the home root", async () => {
    const { runWithCapturesDirFallback } = await import("../capture-storage-gate");
    const seen: string[] = [];
    const value = await runWithCapturesDirFallback(async (root) => {
      seen.push(root);
      if (root === ROOT) {
        const e = new Error("denied") as NodeJS.ErrnoException;
        e.code = "EACCES";
        e.path = join(root, ".capture.tmp");
        throw e;
      }
      return "saved";
    });
    expect(value).toBe("saved");
    expect(seen).toEqual([ROOT, HOME_ROOT]);
    expect(pathMock.location).toBe("home");
  });

  test("capture persistence cannot enter while a root switch holds the queue", async () => {
    pathMock.location = "home";
    const {
      runExclusiveCapturesRootOperation,
      runWithCapturesDirFallback
    } = await import("../capture-storage-gate");
    let releaseSwitch: () => void = () => undefined;
    let markSwitchStarted: () => void = () => undefined;
    const switchStarted = new Promise<void>((resolve) => {
      markSwitchStarted = resolve;
    });
    const switchGate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    const order: string[] = [];

    const switching = runExclusiveCapturesRootOperation(async () => {
      order.push("switch-start");
      markSwitchStarted();
      await switchGate;
      pathMock.location = "documents";
      order.push("switch-end");
    });
    await switchStarted;
    const persistence = runWithCapturesDirFallback(async (root) => {
      order.push(`persist:${root}`);
      return root;
    });

    await Promise.resolve();
    expect(order).toEqual(["switch-start"]);
    releaseSwitch();
    const [, persistedRoot] = await Promise.all([switching, persistence]);
    expect(persistedRoot).toBe(ROOT);
    expect(order).toEqual(["switch-start", "switch-end", `persist:${ROOT}`]);
  });

  test("uses truthful Windows and macOS denial remediation", async () => {
    const { capturesDirectoryDeniedMessage } = await import(
      "../capture-storage-gate"
    );
    const windows = capturesDirectoryDeniedMessage("documents", "win32");
    expect(windows).toContain("Controlled Folder Access");
    expect(windows).toContain("OneDrive");
    expect(windows).not.toContain("System Settings");
    expect(windows).not.toContain("TCC");

    const darwin = capturesDirectoryDeniedMessage("documents", "darwin");
    expect(darwin).toContain("System Settings");
    expect(darwin).toContain("Privacy & Security");
    expect(
      capturesDirectoryDeniedMessage("home", "win32")
    ).toContain(String.raw`%USERPROFILE%\PwrSnap`);
  });
});
