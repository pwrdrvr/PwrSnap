// Pins the readiness-fingerprint algorithm and the needsAttention
// predicate. These two power startup routing: a stale fingerprint
// re-nags the user, and a wrong needsAttention either spams them
// every launch or hides recoverable problems.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  status: { screen: "granted", microphone: "granted" } as Record<string, string>,
  askResolved: true as boolean,
  systemVersion: "14.0.0"
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "1.2.3" },
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  systemPreferences: {
    getMediaAccessStatus: (perm: string): string => electronMock.status[perm] ?? "unknown",
    askForMediaAccess: vi.fn().mockImplementation(async () => electronMock.askResolved)
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

  test("screen routes through System Settings (no prompt API)", async () => {
    electronMock.status = { screen: "denied", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("screen");
    expect(res.openedSettings).toBe(true);
    // status is read back after opening Settings; user hasn't acted
    // yet so it remains denied.
    expect(res.status).toBe("denied");
  });

  test("systemAudio mirrors screen routing", async () => {
    electronMock.status = { screen: "not-determined", microphone: "granted" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("systemAudio");
    expect(res.openedSettings).toBe(true);
  });
});
