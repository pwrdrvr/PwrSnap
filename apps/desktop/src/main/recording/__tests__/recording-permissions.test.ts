// Pins the readiness-fingerprint algorithm and the needsAttention
// predicate. These two power startup routing: a stale fingerprint
// re-nags the user, and a wrong needsAttention either spams them
// every launch or hides recoverable problems.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const electronMock = vi.hoisted(() => ({
  status: { screen: "granted", microphone: "granted" } as Record<string, string>,
  askResolved: true as boolean,
  askCalls: 0,
  appVersion: "1.2.3",
  systemVersion: "14.0.0",
  desktopCapturerCalls: 0,
  shellOpenUrls: [] as string[]
}));

vi.mock("electron", () => ({
  app: { getVersion: () => electronMock.appVersion },
  shell: {
    openExternal: vi.fn().mockImplementation(async (url: string) => {
      electronMock.shellOpenUrls.push(url);
    })
  },
  systemPreferences: {
    getMediaAccessStatus: (perm: string): string => electronMock.status[perm] ?? "unknown",
    askForMediaAccess: vi.fn().mockImplementation(async () => {
      electronMock.askCalls += 1;
      return electronMock.askResolved;
    })
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
  electronMock.askCalls = 0;
  electronMock.appVersion = "1.2.3";
  electronMock.desktopCapturerCalls = 0;
  electronMock.shellOpenUrls = [];
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

  test("fingerprint changes when a permission-status input changes", async () => {
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

  test("fingerprint excludes app version", async () => {
    electronMock.status = { screen: "granted", microphone: "granted" };
    electronMock.systemVersion = "14.0.0";
    electronMock.appVersion = "1.2.3";
    const mod1 = await import("../recording-permissions");
    const a = mod1.readRecordingReadiness();

    vi.resetModules();
    electronMock.appVersion = "9.9.9";
    const mod2 = await import("../recording-permissions");
    const b = mod2.readRecordingReadiness();

    expect(a.fingerprint).toBe(b.fingerprint);
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

  test("Windows keeps operational readiness permissive but reports explicit permission evidence", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    electronMock.status = { screen: "granted", microphone: "denied" };
    const { readRecordingPermissionEvidence, readRecordingReadiness } = await import(
      "../recording-permissions"
    );
    const readiness = readRecordingReadiness();

    // Preflight remains unchanged: the Windows recorder owns its current
    // screen-only behavior and this Settings fix must not rewrite that flow.
    expect(readiness).toMatchObject({
      screenRecording: "granted",
      microphone: "granted",
      systemAudio: "granted"
    });
    expect(readRecordingPermissionEvidence(readiness)).toEqual({
      platform: "win32",
      screen: { kind: "not-inspectable" },
      microphone: { kind: "os-status", status: "denied" },
      systemAudio: { kind: "unsupported" }
    });
  });
});

describe("requestPermission", () => {
  test("microphone routes through askForMediaAccess", async () => {
    electronMock.askResolved = true;
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("microphone");
    expect(res.status).toBe("granted");
  });

  test("microphone denied path reads back current status", async () => {
    electronMock.askResolved = false;
    electronMock.status = { screen: "granted", microphone: "denied" };
    const { requestPermission } = await import("../recording-permissions");
    const res = await requestPermission("microphone");
    expect(res.status).toBe("denied");
  });

  // Screen and system audio only report status. The one way to make macOS
  // ask is a real capture call, and the alert it raises outlives a relaunch
  // and stacks, so the permission guide is PwrSnap's prompt instead.
  for (const [permission, screen] of [
    ["screen", "denied"],
    ["screen", "not-determined"],
    ["systemAudio", "denied"]
  ] as const) {
    test(`${permission} (${screen}) reads status back without a capture call or System Settings`, async () => {
      electronMock.status = { screen, microphone: "granted" };
      const { requestPermission } = await import("../recording-permissions");
      const res = await requestPermission(permission);
      expect(electronMock.desktopCapturerCalls).toBe(0);
      expect(electronMock.shellOpenUrls).toEqual([]);
      expect(res.status).toBe(screen);
    });
  }

  test("Windows request reports unknown and never calls a prompt API", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { requestPermission } = await import("../recording-permissions");
    expect(await requestPermission("microphone")).toEqual({ status: "unknown" });
    expect(electronMock.askCalls).toBe(0);
    expect(electronMock.desktopCapturerCalls).toBe(0);
  });
});

describe("openSystemSettingsFor", () => {
  test("retains the macOS privacy anchors", async () => {
    const { openSystemSettingsFor } = await import("../recording-permissions");
    await openSystemSettingsFor("screen");
    await openSystemSettingsFor("microphone");
    await openSystemSettingsFor("systemAudio");

    expect(electronMock.shellOpenUrls).toEqual([
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
    ]);
  });

  test("opens only the Windows microphone privacy page", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { openSystemSettingsFor } = await import("../recording-permissions");
    await openSystemSettingsFor("microphone");

    expect(electronMock.shellOpenUrls).toEqual(["ms-settings:privacy-microphone"]);
  });

  test.each(["screen", "systemAudio"] as const)(
    "rejects the unsupported Windows %s settings action",
    async (permission) => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true
      });
      const { openSystemSettingsFor, UnsupportedPermissionSettingsError } =
        await import("../recording-permissions");

      await expect(openSystemSettingsFor(permission)).rejects.toBeInstanceOf(
        UnsupportedPermissionSettingsError
      );
      expect(electronMock.shellOpenUrls).toEqual([]);
    }
  );
});

describe("openSoundSettings", () => {
  // The microphone picker's "Sound settings" link. The renderer names no
  // URI; main picks one per platform, or refuses.
  test("opens Sound at Input on macOS and Settings › Sound on Windows", async () => {
    const { openSoundSettings } = await import("../recording-permissions");
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    await openSoundSettings();
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    await openSoundSettings();
    expect(electronMock.shellOpenUrls).toEqual([
      "x-apple.systempreferences:com.apple.preference.sound?input",
      "ms-settings:sound"
    ]);
  });

  test("refuses elsewhere instead of opening something unrelated", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { openSoundSettings, UnsupportedSoundSettingsError } = await import("../recording-permissions");
    await expect(openSoundSettings()).rejects.toBeInstanceOf(UnsupportedSoundSettingsError);
    expect(electronMock.shellOpenUrls).toEqual([]);
  });
});
