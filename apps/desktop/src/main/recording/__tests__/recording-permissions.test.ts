// Pins the readiness-fingerprint algorithm and the needsAttention
// predicate. These two power startup routing: a stale fingerprint
// re-nags the user, and a wrong needsAttention either spams them
// every launch or hides recoverable problems.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  status: { screen: "granted", microphone: "granted" } as Record<string, string>,
  askResolved: true as boolean,
  systemVersion: "14.0.0",
  desktopCapturerCalls: 0,
  shellOpenCalls: 0
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
  shell: {
    openExternal: vi.fn().mockImplementation(async () => {
      electronMock.shellOpenCalls += 1;
    })
  },
  systemPreferences: {
    getMediaAccessStatus: (perm: string): string => electronMock.status[perm] ?? "unknown",
    askForMediaAccess: vi.fn().mockImplementation(async () => electronMock.askResolved)
  },
  desktopCapturer: {
    getSources: vi.fn().mockImplementation(async () => {
      electronMock.desktopCapturerCalls += 1;
      return [];
    })
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

const originalGetSystemVersion = process.getSystemVersion;
const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  electronMock.status = { screen: "granted", microphone: "granted" };
  electronMock.askResolved = true;
  electronMock.desktopCapturerCalls = 0;
  electronMock.shellOpenCalls = 0;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  (process as { getSystemVersion?: () => string }).getSystemVersion = () => electronMock.systemVersion;
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  if (originalGetSystemVersion !== undefined) {
    (process as { getSystemVersion?: () => string }).getSystemVersion = originalGetSystemVersion;
  } else {
    delete (process as { getSystemVersion?: () => string }).getSystemVersion;
  }
});

describe("readRecordingReadiness", () => {
  test("happy path: everything granted produces no attention-needed state", async () => {
    electronMock.status = { screen: "granted", microphone: "granted" };
    electronMock.systemVersion = "14.0.0";
    const { readRecordingReadiness, needsAttention } = await import(
      "../recording-permissions"
    );
    const r = readRecordingReadiness();
    expect(r.screenRecording).toBe("granted");
    expect(r.microphone).toBe("granted");
    expect(r.systemAudio).toBe("granted");
    expect(needsAttention(r)).toBe(false);
    expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test("missing microphone triggers attention", async () => {
    electronMock.status = { screen: "granted", microphone: "denied" };
    electronMock.systemVersion = "14.0.0";
    const { readRecordingReadiness, needsAttention } = await import(
      "../recording-permissions"
    );
    const r = readRecordingReadiness();
    expect(r.microphone).toBe("denied");
    expect(needsAttention(r)).toBe(true);
  });

  test("system audio reports unavailable below macOS 13", async () => {
    electronMock.status = { screen: "granted", microphone: "granted" };
    electronMock.systemVersion = "12.7.4";
    const { readRecordingReadiness, needsAttention } = await import(
      "../recording-permissions"
    );
    const r = readRecordingReadiness();
    expect(r.systemAudio).toBe("unavailable");
    // unavailable doesn't trigger attention — there's no recovery
    // action to route the user to.
    expect(needsAttention(r)).toBe(false);
  });

  test("fingerprint changes when any input changes", async () => {
    electronMock.status = { screen: "granted", microphone: "granted" };
    electronMock.systemVersion = "14.0.0";
    const mod1 = await import("../recording-permissions");
    const a = mod1.readRecordingReadiness();

    vi.resetModules();
    electronMock.status = { screen: "denied", microphone: "granted" };
    const mod2 = await import("../recording-permissions");
    const b = mod2.readRecordingReadiness();

    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  test("non-darwin returns granted for everything", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { readRecordingReadiness, needsAttention } = await import(
      "../recording-permissions"
    );
    const r = readRecordingReadiness();
    expect(r.screenRecording).toBe("granted");
    expect(r.microphone).toBe("granted");
    expect(r.systemAudio).toBe("granted");
    expect(needsAttention(r)).toBe(false);
  });
});

describe("requestPermission", () => {
  test("microphone routes through askForMediaAccess", async () => {
    electronMock.askResolved = true;
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("microphone");
    expect(res.status).toBe("granted");
    expect(res.openedSettings).toBe(false);
  });

  test("microphone denied path reads back current status", async () => {
    electronMock.askResolved = false;
    electronMock.status = { screen: "granted", microphone: "denied" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("microphone");
    expect(res.status).toBe("denied");
    expect(res.openedSettings).toBe(false);
  });

  test("screen denied routes through System Settings (TCC won't re-prompt)", async () => {
    electronMock.status = { screen: "denied", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("screen");
    expect(res.openedSettings).toBe(true);
    expect(electronMock.shellOpenCalls).toBe(1);
    expect(electronMock.desktopCapturerCalls).toBe(0);
    // status is read back after opening Settings; user hasn't acted
    // yet so it remains denied.
    expect(res.status).toBe("denied");
  });

  test("screen not-determined triggers the TCC prompt via desktopCapturer", async () => {
    // Fresh install: bundle has never been seen by TCC, so the
    // Screen Recording pane will not list us yet. The prompt path
    // (desktopCapturer.getSources) shows the OS dialog and registers
    // the bundle in the pane.
    electronMock.status = { screen: "not-determined", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("screen");
    expect(electronMock.desktopCapturerCalls).toBe(1);
    expect(electronMock.shellOpenCalls).toBe(0);
    expect(res.openedSettings).toBe(false);
    // User hasn't clicked Allow yet — status still not-determined.
    expect(res.status).toBe("not-determined");
  });

  test("systemAudio not-determined mirrors the screen prompt path", async () => {
    electronMock.status = { screen: "not-determined", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("systemAudio");
    expect(electronMock.desktopCapturerCalls).toBe(1);
    expect(electronMock.shellOpenCalls).toBe(0);
    expect(res.openedSettings).toBe(false);
  });

  test("systemAudio denied falls back to System Settings", async () => {
    electronMock.status = { screen: "denied", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("systemAudio");
    expect(res.openedSettings).toBe(true);
    expect(electronMock.shellOpenCalls).toBe(1);
    expect(electronMock.desktopCapturerCalls).toBe(0);
  });
});
