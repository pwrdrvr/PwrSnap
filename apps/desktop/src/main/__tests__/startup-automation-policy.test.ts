import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveStartupAutomationPolicy } from "../startup-automation-policy";

describe("startup automation policy", () => {
  test("leaves every startup surface enabled for a normal production launch", () => {
    expect(
      resolveStartupAutomationPolicy({ isE2E: false, isPackagedWindowsSmoke: false })
    ).toEqual({
      acquireSingleInstanceLock: true,
      installTray: true,
      runStartupCodexProbe: true,
      registerGlobalHotkeys: true,
      syncLaunchAtLogin: true,
      initializeAppUpdater: true,
      startLocalAgentLifecycle: true
    });
  });

  test("keeps ordinary parallel E2E launches fully host-isolated", () => {
    expect(
      resolveStartupAutomationPolicy({ isE2E: true, isPackagedWindowsSmoke: false })
    ).toEqual({
      acquireSingleInstanceLock: false,
      installTray: false,
      runStartupCodexProbe: false,
      registerGlobalHotkeys: false,
      syncLaunchAtLogin: false,
      initializeAppUpdater: false,
      startLocalAgentLifecycle: false
    });
  });

  test("runs the packaged lock and tray while suppressing unsafe smoke side effects", () => {
    expect(
      resolveStartupAutomationPolicy({ isE2E: true, isPackagedWindowsSmoke: true })
    ).toEqual({
      acquireSingleInstanceLock: true,
      installTray: true,
      runStartupCodexProbe: false,
      registerGlobalHotkeys: false,
      syncLaunchAtLogin: false,
      initializeAppUpdater: false,
      startLocalAgentLifecycle: false
    });
  });

  test("fails safe for a malformed smoke request before preflight rejects it", () => {
    const policy = resolveStartupAutomationPolicy({
      isE2E: false,
      isPackagedWindowsSmoke: true
    });
    expect(policy.acquireSingleInstanceLock).toBe(true);
    expect(policy.installTray).toBe(true);
    expect(policy.runStartupCodexProbe).toBe(false);
    expect(policy.registerGlobalHotkeys).toBe(false);
    expect(policy.syncLaunchAtLogin).toBe(false);
    expect(policy.initializeAppUpdater).toBe(false);
    expect(policy.startLocalAgentLifecycle).toBe(false);
  });

  test("pins the policy to the real bootstrap and causal tray evidence", async () => {
    const mainRoot = join(import.meta.dirname, "..");
    const [bootstrap, tray] = await Promise.all([
      readFile(join(mainRoot, "index.ts"), "utf8"),
      readFile(join(mainRoot, "tray.ts"), "utf8")
    ]);

    for (const token of [
      "startupAutomationPolicy.acquireSingleInstanceLock && role",
      "packagedSmokeSingleInstanceLockAcquired = true",
      "startupAutomationPolicy.installTray && role",
      "startupAutomationPolicy.runStartupCodexProbe",
      "startupAutomationPolicy.registerGlobalHotkeys",
      "startupAutomationPolicy.syncLaunchAtLogin",
      "startupAutomationPolicy.initializeAppUpdater",
      "startupAutomationPolicy.startLocalAgentLifecycle",
      "getTrayInstallationEvidence()"
    ]) {
      expect(bootstrap).toContain(token);
    }
    expect(tray).toContain("iconLoaded: !icon.isEmpty()");
    expect(tray).toContain("popoverPrewarmed: !prewarmedWindow.isDestroyed()");
  });
});
