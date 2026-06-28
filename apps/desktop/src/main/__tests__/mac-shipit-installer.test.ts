import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { launchStagedMacShipItInstaller } from "../mac-shipit-installer";

const fixtureRoots: string[] = [];

function makeFixture(): {
  root: string;
  homeDir: string;
  resourcesPath: string;
  shipItPath: string;
  statePath: string;
  updateBundlePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-shipit-"));
  fixtureRoots.push(root);
  const homeDir = join(root, "home");
  const resourcesPath = join(root, "PwrSnap.app", "Contents", "Resources");
  const shipItPath = join(
    root,
    "PwrSnap.app",
    "Contents",
    "Frameworks",
    "Squirrel.framework",
    "Resources",
    "ShipIt"
  );
  const statePath = join(
    homeDir,
    "Library",
    "Caches",
    "com.pwrdrvr.pwrsnap.ShipIt",
    "ShipItState.plist"
  );
  const updateBundlePath = join(
    homeDir,
    "Library",
    "Caches",
    "com.pwrdrvr.pwrsnap.ShipIt",
    "update.abc123",
    "PwrSnap.app"
  );
  mkdirSync(resourcesPath, { recursive: true });
  mkdirSync(dirname(shipItPath), { recursive: true });
  mkdirSync(updateBundlePath, { recursive: true });
  writeFileSync(shipItPath, "");
  writeFileSync(
    statePath,
    JSON.stringify({
      bundleIdentifier: "com.pwrdrvr.pwrsnap",
      launchAfterInstallation: true,
      targetBundleURL: pathToFileURL("/Applications/PwrSnap.app").href,
      updateBundleURL: pathToFileURL(updateBundlePath).href,
      useUpdateBundleName: true
    })
  );
  return { root, homeDir, resourcesPath, shipItPath, statePath, updateBundlePath };
}

describe("launchStagedMacShipItInstaller", () => {
  afterEach(() => {
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    }
  });

  test("launches the staged Squirrel.Mac helper on macOS", () => {
    const fixture = makeFixture();
    const unref = vi.fn();
    const spawn = vi.fn(() => ({ unref }));

    const result = launchStagedMacShipItInstaller({
      homeDir: fixture.homeDir,
      platform: "darwin",
      resourcesPath: fixture.resourcesPath,
      spawn
    });

    expect(result).toEqual({
      launched: true,
      shipItPath: fixture.shipItPath,
      statePath: fixture.statePath
    });
    expect(spawn).toHaveBeenCalledWith(
      fixture.shipItPath,
      ["com.pwrdrvr.pwrsnap.ShipIt", fixture.statePath],
      { detached: true, stdio: "ignore" }
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("skips non-macOS platforms", () => {
    const fixture = makeFixture();

    expect(
      launchStagedMacShipItInstaller({
        homeDir: fixture.homeDir,
        platform: "linux",
        resourcesPath: fixture.resourcesPath,
        spawn: vi.fn()
      })
    ).toEqual({ launched: false, reason: "not_macos" });
  });

  test("skips when ShipIt has not staged an update bundle", () => {
    const fixture = makeFixture();
    const missingBundlePath = join(fixture.root, "missing.app");
    writeFileSync(
      fixture.statePath,
      JSON.stringify({ updateBundleURL: pathToFileURL(missingBundlePath).href })
    );

    expect(
      launchStagedMacShipItInstaller({
        homeDir: fixture.homeDir,
        platform: "darwin",
        resourcesPath: fixture.resourcesPath,
        spawn: vi.fn()
      })
    ).toEqual({ launched: false, reason: "shipit_update_bundle_missing" });
  });

  test("skips invalid ShipIt state", () => {
    const fixture = makeFixture();
    writeFileSync(fixture.statePath, "not-json");

    expect(
      launchStagedMacShipItInstaller({
        homeDir: fixture.homeDir,
        platform: "darwin",
        resourcesPath: fixture.resourcesPath,
        spawn: vi.fn()
      })
    ).toEqual({ launched: false, reason: "shipit_state_invalid" });
  });
});
