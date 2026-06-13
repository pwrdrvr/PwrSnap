import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const {
  getCapturesAccessHealth,
  isPermissionDenial,
  onCapturesAccessHealthChanged,
  reportCapturesAccessFailure,
  reportCapturesAccessSuccess,
  resetCapturesAccessHealthForTests
} = await import("../captures-access-health");

function eperm(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `EPERM: operation not permitted, open '${path}'`
  );
  error.code = "EPERM";
  error.path = path;
  return error;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCapturesAccessHealthForTests();
});

afterEach(() => {
  resetCapturesAccessHealthForTests();
  vi.useRealTimers();
});

describe("isPermissionDenial", () => {
  test("matches EPERM and EACCES errno errors", () => {
    expect(isPermissionDenial(eperm("/x"))).toBe(true);
    const eacces: NodeJS.ErrnoException = new Error("EACCES");
    eacces.code = "EACCES";
    expect(isPermissionDenial(eacces)).toBe(true);
  });

  test("rejects other errors and non-errors", () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT");
    enoent.code = "ENOENT";
    expect(isPermissionDenial(enoent)).toBe(false);
    expect(isPermissionDenial(new Error("plain"))).toBe(false);
    expect(isPermissionDenial(null)).toBe(false);
    expect(isPermissionDenial("EPERM")).toBe(false);
  });
});

describe("captures access health accounting", () => {
  test("starts healthy", () => {
    expect(getCapturesAccessHealth()).toEqual({
      denied: false,
      deniedPathCount: 0,
      samplePath: null,
      firstDeniedAt: null,
      lastDeniedAt: null
    });
  });

  test("records denials per distinct path, not per failure", () => {
    expect(reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"))).toBe(true);
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessFailure("/c/b.pwrsnap", eperm("/c/b.pwrsnap"));

    const health = getCapturesAccessHealth();
    expect(health.denied).toBe(true);
    expect(health.deniedPathCount).toBe(2);
    expect(health.samplePath).toBe("/c/b.pwrsnap");
    expect(health.firstDeniedAt).not.toBeNull();
  });

  test("ignores non-permission errors", () => {
    const enoent: NodeJS.ErrnoException = new Error("ENOENT");
    enoent.code = "ENOENT";
    expect(reportCapturesAccessFailure("/c/a.pwrsnap", enoent)).toBe(false);
    expect(getCapturesAccessHealth().denied).toBe(false);
  });

  test("success on a denied path clears it; full recovery flips denied off", () => {
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessFailure("/c/b.pwrsnap", eperm("/c/b.pwrsnap"));

    reportCapturesAccessSuccess("/c/a.pwrsnap");
    expect(getCapturesAccessHealth().deniedPathCount).toBe(1);
    expect(getCapturesAccessHealth().denied).toBe(true);

    reportCapturesAccessSuccess("/c/b.pwrsnap");
    const health = getCapturesAccessHealth();
    expect(health.denied).toBe(false);
    expect(health.deniedPathCount).toBe(0);
    expect(health.samplePath).toBeNull();
  });

  test("success on never-denied paths is a no-op", () => {
    reportCapturesAccessSuccess("/c/never-denied.pwrsnap");
    expect(getCapturesAccessHealth().denied).toBe(false);

    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessSuccess("/c/other.pwrsnap");
    expect(getCapturesAccessHealth().deniedPathCount).toBe(1);
  });

  test("full recovery resets the snapshot to the healthy baseline", () => {
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessFailure("/c/b.pwrsnap", eperm("/c/b.pwrsnap"));
    expect(getCapturesAccessHealth().firstDeniedAt).not.toBeNull();

    reportCapturesAccessSuccess("/c/a.pwrsnap");
    reportCapturesAccessSuccess("/c/b.pwrsnap");

    // No stale episode metadata may survive once denied flips false —
    // the snapshot must equal the initial healthy baseline exactly.
    expect(getCapturesAccessHealth()).toEqual({
      denied: false,
      deniedPathCount: 0,
      samplePath: null,
      firstDeniedAt: null,
      lastDeniedAt: null
    });
  });

  test("a fresh denial episode re-arms firstDeniedAt", () => {
    vi.setSystemTime(new Date("2026-06-13T00:00:00.000Z"));
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    expect(getCapturesAccessHealth().firstDeniedAt).toBe("2026-06-13T00:00:00.000Z");

    // Full recovery clears the episode...
    reportCapturesAccessSuccess("/c/a.pwrsnap");
    expect(getCapturesAccessHealth().firstDeniedAt).toBeNull();

    // ...so the NEXT denial stamps a new firstDeniedAt rather than
    // keeping the first-ever one.
    vi.setSystemTime(new Date("2026-06-13T01:00:00.000Z"));
    reportCapturesAccessFailure("/c/b.pwrsnap", eperm("/c/b.pwrsnap"));
    expect(getCapturesAccessHealth().firstDeniedAt).toBe("2026-06-13T01:00:00.000Z");
  });

  test("notifies listeners with a debounced snapshot", () => {
    const seen: Array<{ denied: boolean; deniedPathCount: number }> = [];
    const unsubscribe = onCapturesAccessHealthChanged((health) => {
      seen.push({ denied: health.denied, deniedPathCount: health.deniedPathCount });
    });

    // A burst of denials coalesces into one dispatch with the final
    // count — the boot maintenance scan can report hundreds in a row.
    reportCapturesAccessFailure("/c/a.pwrsnap", eperm("/c/a.pwrsnap"));
    reportCapturesAccessFailure("/c/b.pwrsnap", eperm("/c/b.pwrsnap"));
    reportCapturesAccessFailure("/c/c.pwrsnap", eperm("/c/c.pwrsnap"));
    expect(seen).toEqual([]);
    vi.runAllTimers();
    expect(seen).toEqual([{ denied: true, deniedPathCount: 3 }]);

    reportCapturesAccessSuccess("/c/a.pwrsnap");
    reportCapturesAccessSuccess("/c/b.pwrsnap");
    reportCapturesAccessSuccess("/c/c.pwrsnap");
    vi.runAllTimers();
    expect(seen).toEqual([
      { denied: true, deniedPathCount: 3 },
      { denied: false, deniedPathCount: 0 }
    ]);

    unsubscribe();
    reportCapturesAccessFailure("/c/d.pwrsnap", eperm("/c/d.pwrsnap"));
    vi.runAllTimers();
    expect(seen).toHaveLength(2);
  });
});
