// Pins the Screen Recording gate, the chokepoint every capture/record
// entrypoint funnels through. Granted proceeds; anything else shows the
// permission guide and NEVER touches a capture API — a capture call is what
// raises macOS's own alert, which outlives a relaunch and stacks.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  // What getMediaAccessStatus('screen') returns. macOS only ever gives
  // 'granted' | 'denied' here (CGPreflightScreenCaptureAccess is boolean).
  screenStatus: "denied" as string,
  getSourcesCalls: 0
}));

vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: (perm: string): string =>
      perm === "screen" ? electronMock.screenStatus : "granted"
  },
  desktopCapturer: {
    getSources: vi.fn(async () => {
      electronMock.getSourcesCalls += 1;
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
      if (name === "permissions:showGuide") {
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
    expect(dispatchedNames()).not.toContain("permissions:showGuide");
  });

  test("non-darwin → always proceeds without touching the OS or bus", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture();
    expect(result).toBeNull();
    expect(electronMock.getSourcesCalls).toBe(0);
    expect(busMock.dispatched).toHaveLength(0);
  });

  for (const asked of [false, true]) {
    test(`not granted (${asked ? "asked before" : "never asked"}) → shows the guide, records the ask, and never calls a capture API`, async () => {
      electronMock.screenStatus = "denied";
      busMock.attempted = asked;
      const { guardScreenCapture } = await import("../screen-permission-gate");
      const result = await guardScreenCapture();
      // The cardinal rule: no probe, so macOS raises no alert of its own.
      expect(electronMock.getSourcesCalls).toBe(0);
      expect(dispatchedNames()).toContain("permissions:showGuide");
      expect(dispatchedNames()).toContain("settings:write");
      if (result === null) throw new Error("expected blocked");
      if (result.ok) throw new Error("expected error");
      expect(result.error.kind).toBe("permission");
      expect(result.error.code).toBe("screen_not_granted");
    });
  }

  test("repeated blocked captures never stack a probe either", async () => {
    electronMock.screenStatus = "denied";
    const { guardScreenCapture } = await import("../screen-permission-gate");
    await guardScreenCapture();
    await guardScreenCapture();
    await guardScreenCapture();
    expect(electronMock.getSourcesCalls).toBe(0);
  });

  test("routeToSettings:false (headless) errors without opening the guide or probing", async () => {
    electronMock.screenStatus = "denied";
    const { guardScreenCapture } = await import("../screen-permission-gate");
    const result = await guardScreenCapture({ routeToSettings: false });
    expect(electronMock.getSourcesCalls).toBe(0);
    expect(dispatchedNames()).not.toContain("permissions:showGuide");
    if (result === null) throw new Error("expected blocked");
    if (result.ok) throw new Error("expected error");
    expect(result.error.code).toBe("screen_not_granted");
  });
});
