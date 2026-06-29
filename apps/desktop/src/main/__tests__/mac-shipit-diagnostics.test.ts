import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { readMacShipItDiagnostics } from "../mac-shipit-diagnostics";

const roots: string[] = [];

function makeFixture(): {
  root: string;
  homeDir: string;
  resourcesPath: string;
  shipItPath: string;
  statePath: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "pwrsnap-shipit-diag-"));
  roots.push(root);
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
  const cachePath = join(homeDir, "Library", "Caches", "com.pwrdrvr.pwrsnap.ShipIt");
  const statePath = join(cachePath, "ShipItState.plist");
  const stdoutPath = join(cachePath, "ShipIt_stdout.log");
  const stderrPath = join(cachePath, "ShipIt_stderr.log");
  mkdirSync(resourcesPath, { recursive: true });
  mkdirSync(dirname(shipItPath), { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  writeFileSync(shipItPath, "");
  writeFileSync(
    statePath,
    JSON.stringify({
      bundleIdentifier: "com.pwrdrvr.pwrsnap",
      launchAfterInstallation: true,
      targetBundleURL: pathToFileURL("/Applications/PwrSnap.app").href,
      updateBundleURL: pathToFileURL(join(cachePath, "update.abc", "PwrSnap.app")).href,
      useUpdateBundleName: true
    }),
    "utf8"
  );
  writeFileSync(stdoutPath, "stdout", "utf8");
  writeFileSync(stderrPath, "stderr", "utf8");
  return { root, homeDir, resourcesPath, shipItPath, statePath, stdoutPath, stderrPath };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("readMacShipItDiagnostics", () => {
  test("captures ShipIt paths, state, and log metadata", () => {
    const fixture = makeFixture();

    const diagnostics = readMacShipItDiagnostics({
      homeDir: fixture.homeDir,
      platform: "darwin",
      resourcesPath: fixture.resourcesPath
    });

    expect(diagnostics.shipItPath).toBe(fixture.shipItPath);
    expect(diagnostics.shipItExists).toBe(true);
    expect(diagnostics.statePath).toBe(fixture.statePath);
    expect(diagnostics.state).toMatchObject({
      exists: true,
      bundleIdentifier: "com.pwrdrvr.pwrsnap",
      launchAfterInstallation: true,
      targetBundleURL: pathToFileURL("/Applications/PwrSnap.app").href,
      useUpdateBundleName: true
    });
    expect(diagnostics.stdout).toMatchObject({ exists: true, size: 6 });
    expect(diagnostics.stderr).toMatchObject({ exists: true, size: 6 });
  });

  test("reports missing state and logs without throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "pwrsnap-shipit-diag-"));
    roots.push(root);

    const diagnostics = readMacShipItDiagnostics({
      homeDir: join(root, "home"),
      platform: "darwin",
      resourcesPath: join(root, "PwrSnap.app", "Contents", "Resources")
    });

    expect(diagnostics.shipItExists).toBe(false);
    expect(diagnostics.state).toEqual({ exists: false });
    expect(diagnostics.stdout).toEqual({ exists: false });
    expect(diagnostics.stderr).toEqual({ exists: false });
  });
});
