// Pins the first-run Screen Recording gate. The gate is the chokepoint
// every capture/record entrypoint funnels through, so its three branches
// (proceed / first-prompt / route-to-settings) are the contract that
// keeps a fresh install from dead-ending at "Open System Settings" for an
// app that macOS hasn't listed yet.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  // What getMediaAccessStatus('screen') returns. macOS only ever gives
  // 'granted' | 'denied' here (CGPreflightScreenCaptureAccess is boolean).
  screenStatus: "denied" as string,
  getSourcesCalls: 0,
  // When true, a getSources() call flips screenStatus to "granted" to
  // simulate the macOS configs that grant in-session straight off the
  // prompt ("continue if possible").
  grantOnPrompt: false
}));

vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: (perm: string): string =>
      perm === "screen" ? electronMock.screenStatus : "granted"
  },
  desktopCapturer: {
    getSources: vi.fn(async () => {
      electronMock.getSourcesCalls += 1;
      if (electronMock.grantOnPrompt) electronMock.screenStatus = "granted";
      return [];
    })
  },
  shell: { openExternal: vi.fn(async () => undefined) }
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

const busMock = vi.hoisted(() => ({
  attempted: false,
  failSettingsRead: false,
  dispatched: [] as Array<{ name: string; req: unknown }>
}));

vi.mock("../../command-bus", () => ({
  bus: {
    dispatch: vi.fn(async (name: string, req: unknown) => {
      busMock.dispatched.push({ name, req });
      if (name === "settings:read") {
        if (busMock.failSettingsRead) {
          return { ok: false, error: { kind: "settings", code: "x", message: "x" } };
        }
        return {
          ok: true,
          value: { recording: { screenCapturePrompted: busMock.attempted } }
        };
      }
      if (name === "settings:write") {
        busMock.attempted = true;
        return { ok: true, value: {} };
      }
      if (name === "settings:open") {
        return { ok: true, value: undefined };
      }
      return { ok: false, error: { kind: "validation", code: "unknown_command", message: "x" } };
    })
  }
}));

const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  electronMock.screenStatus = "denied";
  electronMock.getSourcesCalls = 0;
  electronMock.grantOnPrompt = false;
  busMock.attempted = false;
  busMock.failSettingsRead = false;
  busMock.dispatched = [];
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
});

function dispatchedNames(): string[] {
  return busMock.dispatched.map((d) => d.name);
}

describe("guardScreenCapture", () => {
  test("granted → proceeds (null) with no prompt, write, or routing", async () => {
    electronMock.screenStatus = "granted";
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    expect(result).toBeNull();
    expect(electronMock.getSourcesCalls).toBe(0);
    expect(dispatchedNames()).not.toContain("settings:write");
    expect(dispatchedNames()).not.toContain("settings:open");
  });

  test("non-darwin → always proceeds without touching the OS or bus", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    expect(result).toBeNull();
    expect(electronMock.getSourcesCalls).toBe(0);
    expect(busMock.dispatched).toHaveLength(0);
  });

  test("not granted + never asked → fires the OS prompt, records it, returns pending", async () => {
    electronMock.screenStatus = "denied";
    busMock.attempted = false;
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    // Prompt fired exactly once; we recorded that we asked.
    expect(electronMock.getSourcesCalls).toBe(1);
    expect(dispatchedNames()).toContain("settings:write");
    // We do NOT open our own Settings on top of the OS dialog.
    expect(dispatchedNames()).not.toContain("settings:open");
    expect(result).not.toBeNull();
    if (result === null) throw new Error("expected blocked");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("screen_permission_pending");
    expect(result.error.kind).toBe("permission");
  });

  test("not granted + never asked + macOS grants in-session → proceeds (continue if possible)", async () => {
    electronMock.screenStatus = "denied";
    electronMock.grantOnPrompt = true; // prompt flips status to granted
    busMock.attempted = false;
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    expect(electronMock.getSourcesCalls).toBe(1);
    expect(dispatchedNames()).toContain("settings:write");
    expect(result).toBeNull(); // proceeded straight into the capture
  });

  test("not granted + already asked → routes to Settings, no re-prompt", async () => {
    electronMock.screenStatus = "denied";
    busMock.attempted = true;
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    // macOS won't prompt twice — we don't issue another getSources.
    expect(electronMock.getSourcesCalls).toBe(0);
    expect(dispatchedNames()).toContain("settings:open");
    expect(dispatchedNames()).not.toContain("settings:write");
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("screen_not_granted");
  });

  test("settings read failure defaults to never-asked (fires prompt, doesn't dead-end)", async () => {
    electronMock.screenStatus = "denied";
    busMock.failSettingsRead = true;
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    // Treated as never-asked: prompt fires rather than routing to a
    // Settings pane that might not list us.
    expect(electronMock.getSourcesCalls).toBe(1);
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("screen_permission_pending");
  });

  test("routeToSettings:false (headless) still errors but does NOT open Settings", async () => {
    electronMock.screenStatus = "denied";
    busMock.attempted = true; // asked before → denied branch
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture({ routeToSettings: false });
    // No window popped at the programmatic caller…
    expect(dispatchedNames()).not.toContain("settings:open");
    // …but it still short-circuits with the denied error.
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("screen_not_granted");
  });
});
