// Unit tests for launch-at-login: argv detection, the pure per-platform
// registration planner, the XDG desktop-entry shape, and the OS-status
// mappers. The planner/mapper functions are pure on purpose — every
// platform's behavior is pinned here without an Electron app instance
// or a real fs (applyLaunchAtLoginPlan's fs writes are exercised
// against a tmpdir below).

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: (): string => "/tmp/pwrsnap-test-launch-at-login",
    getLoginItemSettings: (): Record<string, never> => ({}),
    setLoginItemSettings: (): void => undefined
  },
  BrowserWindow: { getAllWindows: () => [] }
}));

import {
  LAUNCHED_AT_LOGIN_ARG,
  applyLaunchAtLoginPlan,
  parseLaunchedAtLoginArgv,
  planLaunchAtLoginSync,
  statusFromDarwinLoginItemSettings,
  statusFromWindowsLoginItemSettings,
  statusFromXdgDesktopFile,
  type LaunchAtLoginEnvironment
} from "../launch-at-login";

function env(overrides: Partial<LaunchAtLoginEnvironment> = {}): LaunchAtLoginEnvironment {
  return {
    platform: "darwin",
    packaged: true,
    e2e: false,
    execPath: "/Applications/PwrSnap.app/Contents/MacOS/PwrSnap",
    appImagePath: null,
    xdgConfigHome: null,
    homeDir: "/home/user",
    ...overrides
  };
}

describe("parseLaunchedAtLoginArgv", () => {
  test("detects the flag anywhere in argv", () => {
    expect(parseLaunchedAtLoginArgv(["/bin/app", LAUNCHED_AT_LOGIN_ARG])).toBe(true);
    expect(parseLaunchedAtLoginArgv([LAUNCHED_AT_LOGIN_ARG])).toBe(true);
  });

  test("does not match prefixes or absent flags", () => {
    expect(parseLaunchedAtLoginArgv(["/bin/app"])).toBe(false);
    expect(parseLaunchedAtLoginArgv(["/bin/app", "--launched-at-login-x"])).toBe(false);
  });
});

describe("planLaunchAtLoginSync", () => {
  test("E2E always skips, even when packaged — the harness must never touch host startup items", () => {
    expect(planLaunchAtLoginSync(true, env({ e2e: true, packaged: true }))).toEqual({
      kind: "skip",
      reason: "e2e"
    });
  });

  test("dev builds skip — registering the bare Electron binary would be wrong", () => {
    expect(planLaunchAtLoginSync(true, env({ packaged: false }))).toEqual({
      kind: "skip",
      reason: "dev-build"
    });
  });

  test("macOS uses the Electron login-item API with no argv (SMAppService carries none)", () => {
    expect(planLaunchAtLoginSync(true, env({ platform: "darwin" }))).toEqual({
      kind: "electron-login-item",
      settings: { openAtLogin: true }
    });
    expect(planLaunchAtLoginSync(false, env({ platform: "darwin" }))).toEqual({
      kind: "electron-login-item",
      settings: { openAtLogin: false }
    });
  });

  test("Windows registers the login flag in args — and mirrors it on disable so the Run-key entry matches", () => {
    for (const enabled of [true, false]) {
      expect(planLaunchAtLoginSync(enabled, env({ platform: "win32" }))).toEqual({
        kind: "electron-login-item",
        settings: { openAtLogin: enabled, args: [LAUNCHED_AT_LOGIN_ARG] }
      });
    }
  });

  test("unsupported platforms skip", () => {
    expect(planLaunchAtLoginSync(true, env({ platform: "freebsd" }))).toEqual({
      kind: "skip",
      reason: "platform-unsupported"
    });
  });

  describe("Linux XDG autostart", () => {
    test("writes a complete desktop entry under ~/.config/autostart with the login flag", () => {
      const plan = planLaunchAtLoginSync(
        true,
        env({ platform: "linux", execPath: "/opt/pwrsnap/pwrsnap" })
      );
      if (plan.kind !== "xdg-autostart") throw new Error(`expected xdg plan, got ${plan.kind}`);
      expect(plan.enabled).toBe(true);
      expect(plan.desktopFilePath).toBe("/home/user/.config/autostart/pwrsnap.desktop");
      expect(plan.content).toContain("[Desktop Entry]");
      expect(plan.content).toContain("Type=Application");
      expect(plan.content).toContain("Name=PwrSnap");
      expect(plan.content).toContain(`Exec="/opt/pwrsnap/pwrsnap" ${LAUNCHED_AT_LOGIN_ARG}`);
      expect(plan.content).toContain("X-GNOME-Autostart-enabled=true");
    });

    test("honors XDG_CONFIG_HOME", () => {
      const plan = planLaunchAtLoginSync(
        true,
        env({ platform: "linux", xdgConfigHome: "/custom/config" })
      );
      if (plan.kind !== "xdg-autostart") throw new Error("expected xdg plan");
      expect(plan.desktopFilePath).toBe("/custom/config/autostart/pwrsnap.desktop");
    });

    test("AppImage runs register the AppImage path, not the temp-mounted binary", () => {
      const plan = planLaunchAtLoginSync(
        true,
        env({
          platform: "linux",
          execPath: "/tmp/.mount_pwrsnXYZ/pwrsnap",
          appImagePath: "/home/user/Apps/PwrSnap.AppImage"
        })
      );
      if (plan.kind !== "xdg-autostart") throw new Error("expected xdg plan");
      expect(plan.content).toContain(
        `Exec="/home/user/Apps/PwrSnap.AppImage" ${LAUNCHED_AT_LOGIN_ARG}`
      );
    });

    test("quotes + escapes Exec per the desktop-entry spec (spaces, $, `, \\, \")", () => {
      const plan = planLaunchAtLoginSync(
        true,
        env({ platform: "linux", execPath: '/opt/my apps/$weird/pwr"snap' })
      );
      if (plan.kind !== "xdg-autostart") throw new Error("expected xdg plan");
      expect(plan.content).toContain(`Exec="/opt/my apps/\\$weird/pwr\\"snap"`);
    });

    test("disable plan carries no content (the entry is removed)", () => {
      const plan = planLaunchAtLoginSync(false, env({ platform: "linux" }));
      if (plan.kind !== "xdg-autostart") throw new Error("expected xdg plan");
      expect(plan.enabled).toBe(false);
    });
  });
});

describe("applyLaunchAtLoginPlan (xdg fs behavior)", () => {
  let workDir = "";
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pwrsnap-autostart-"));
  });

  test("enable creates the autostart dir and writes the entry; disable removes it", () => {
    const desktopFilePath = join(workDir, "autostart", "pwrsnap.desktop");
    applyLaunchAtLoginPlan({
      kind: "xdg-autostart",
      enabled: true,
      desktopFilePath,
      content: "[Desktop Entry]\nName=PwrSnap\n"
    });
    expect(readFileSync(desktopFilePath, "utf8")).toContain("Name=PwrSnap");
    // No stray tmp file left behind by the atomic write.
    expect(existsSync(`${desktopFilePath}.tmp`)).toBe(false);

    applyLaunchAtLoginPlan({
      kind: "xdg-autostart",
      enabled: false,
      desktopFilePath,
      content: ""
    });
    expect(existsSync(desktopFilePath)).toBe(false);
  });

  test("disable of a never-registered entry is a no-op, not an error", () => {
    expect(() =>
      applyLaunchAtLoginPlan({
        kind: "xdg-autostart",
        enabled: false,
        desktopFilePath: join(workDir, "autostart", "pwrsnap.desktop"),
        content: ""
      })
    ).not.toThrow();
  });

  test("enable overwrites an existing (stale-path) entry", () => {
    const desktopFilePath = join(workDir, "pwrsnap.desktop");
    writeFileSync(desktopFilePath, "[Desktop Entry]\nExec=/old/path\n", "utf8");
    applyLaunchAtLoginPlan({
      kind: "xdg-autostart",
      enabled: true,
      desktopFilePath,
      content: "[Desktop Entry]\nExec=/new/path\n"
    });
    expect(readFileSync(desktopFilePath, "utf8")).toContain("/new/path");
  });
});

describe("statusFromDarwinLoginItemSettings", () => {
  test("SMAppService enabled → registered", () => {
    expect(statusFromDarwinLoginItemSettings({ status: "enabled" })).toEqual({
      registered: true,
      blockedByOs: false
    });
  });

  test("requires-approval → registered but blocked (user flipped it off in System Settings)", () => {
    expect(statusFromDarwinLoginItemSettings({ status: "requires-approval" })).toEqual({
      registered: true,
      blockedByOs: true
    });
  });

  test("not-registered / missing status falls back to openAtLogin", () => {
    expect(
      statusFromDarwinLoginItemSettings({ status: "not-registered", openAtLogin: false })
    ).toEqual({ registered: false, blockedByOs: false });
    expect(statusFromDarwinLoginItemSettings({ openAtLogin: true })).toEqual({
      registered: true,
      blockedByOs: false
    });
  });
});

describe("statusFromWindowsLoginItemSettings", () => {
  const execPath = "C:\\Users\\u\\AppData\\Local\\Programs\\PwrSnap\\PwrSnap.exe";

  test("registered + startup-approved", () => {
    expect(
      statusFromWindowsLoginItemSettings(
        { openAtLogin: true, launchItems: [{ path: execPath, enabled: true }] },
        execPath
      )
    ).toEqual({ registered: true, blockedByOs: false });
  });

  test("registered but disabled in Task Manager → blocked", () => {
    expect(
      statusFromWindowsLoginItemSettings(
        { openAtLogin: true, launchItems: [{ path: execPath, enabled: false }] },
        execPath
      )
    ).toEqual({ registered: true, blockedByOs: true });
  });

  test("path match is case-insensitive (registry casing varies)", () => {
    expect(
      statusFromWindowsLoginItemSettings(
        { openAtLogin: false, launchItems: [{ path: execPath.toUpperCase(), enabled: false }] },
        execPath
      )
    ).toEqual({ registered: true, blockedByOs: true });
  });

  test("not registered", () => {
    expect(statusFromWindowsLoginItemSettings({ openAtLogin: false }, execPath)).toEqual({
      registered: false,
      blockedByOs: false
    });
  });

  test("other apps' launch items don't count as ours", () => {
    expect(
      statusFromWindowsLoginItemSettings(
        { openAtLogin: false, launchItems: [{ path: "C:\\Other\\App.exe", enabled: false }] },
        execPath
      )
    ).toEqual({ registered: false, blockedByOs: false });
  });
});

describe("statusFromXdgDesktopFile", () => {
  test("missing file → not registered", () => {
    expect(statusFromXdgDesktopFile(null)).toEqual({ registered: false, blockedByOs: false });
  });

  test("present entry → registered", () => {
    expect(statusFromXdgDesktopFile("[Desktop Entry]\nName=PwrSnap\n")).toEqual({
      registered: true,
      blockedByOs: false
    });
  });

  test("GNOME-style in-place disable keys → blocked", () => {
    expect(statusFromXdgDesktopFile("[Desktop Entry]\nHidden=true\n").blockedByOs).toBe(true);
    expect(
      statusFromXdgDesktopFile("[Desktop Entry]\nX-GNOME-Autostart-enabled=false\n").blockedByOs
    ).toBe(true);
  });
});
