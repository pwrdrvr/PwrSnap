import { spawn, type SpawnOptions } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIP_IT_BUNDLE_ID = "com.pwrdrvr.pwrsnap.ShipIt";

type ShipItState = {
  launchAfterInstallation?: unknown;
  updateBundleURL?: unknown;
} & Record<string, unknown>;

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => { unref?: () => void };

export type LaunchStagedMacShipItInstallerOptions = {
  exists?: typeof existsSync;
  homeDir: string;
  platform: NodeJS.Platform;
  readFile?: typeof readFileSync;
  resourcesPath: string;
  spawn?: SpawnLike;
  writeFile?: typeof writeFileSync;
};

export type LaunchStagedMacShipItInstallerResult =
  | { launched: true; shipItPath: string; statePath: string }
  | { launched: false; reason: string };

function shipItStatePath(homeDir: string): string {
  return join(homeDir, "Library", "Caches", SHIP_IT_BUNDLE_ID, "ShipItState.plist");
}

function shipItExecutablePath(resourcesPath: string): string {
  return join(resourcesPath, "..", "Frameworks", "Squirrel.framework", "Resources", "ShipIt");
}

function parseShipItState(raw: string): ShipItState | undefined {
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as ShipItState) : undefined;
  } catch {
    return undefined;
  }
}

export function launchStagedMacShipItInstaller(
  options: LaunchStagedMacShipItInstallerOptions
): LaunchStagedMacShipItInstallerResult {
  if (options.platform !== "darwin") {
    return { launched: false, reason: "not_macos" };
  }

  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? readFileSync;
  const spawnImpl = options.spawn ?? spawn;
  const writeFile = options.writeFile ?? writeFileSync;
  const statePath = shipItStatePath(options.homeDir);
  const shipItPath = shipItExecutablePath(options.resourcesPath);

  if (!exists(shipItPath)) {
    return { launched: false, reason: "shipit_missing" };
  }
  if (!exists(statePath)) {
    return { launched: false, reason: "shipit_state_missing" };
  }

  const state = parseShipItState(readFile(statePath, "utf8"));
  if (typeof state?.updateBundleURL !== "string") {
    return { launched: false, reason: "shipit_state_invalid" };
  }

  let updateBundlePath: string;
  try {
    updateBundlePath = fileURLToPath(state.updateBundleURL);
  } catch {
    return { launched: false, reason: "shipit_update_bundle_url_invalid" };
  }

  if (!exists(updateBundlePath)) {
    return { launched: false, reason: "shipit_update_bundle_missing" };
  }

  try {
    writeFile(statePath, JSON.stringify({ ...state, launchAfterInstallation: true }));
  } catch {
    return { launched: false, reason: "shipit_state_relaunch_prepare_failed" };
  }

  const child = spawnImpl(shipItPath, [SHIP_IT_BUNDLE_ID, statePath], {
    detached: true,
    stdio: "ignore"
  });
  child.unref?.();
  return { launched: true, shipItPath, statePath };
}
