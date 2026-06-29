import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SHIP_IT_BUNDLE_ID = "com.pwrdrvr.pwrsnap.ShipIt";

export type ShipItStateDiagnostics = {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
  bundleIdentifier?: string;
  launchAfterInstallation?: boolean;
  targetBundleURL?: string;
  updateBundleURL?: string;
  useUpdateBundleName?: boolean;
  parseError?: string;
};

export type ShipItLogDiagnostics = {
  exists: boolean;
  mtimeMs?: number;
  size?: number;
};

export type MacShipItDiagnostics = {
  platform: NodeJS.Platform;
  shipItPath: string;
  shipItExists: boolean;
  statePath: string;
  state: ShipItStateDiagnostics;
  stdoutPath: string;
  stdout: ShipItLogDiagnostics;
  stderrPath: string;
  stderr: ShipItLogDiagnostics;
};

type JsonRecord = Record<string, unknown>;

function metadata(path: string): ShipItLogDiagnostics {
  if (!existsSync(path)) return { exists: false };
  const stat = statSync(path);
  return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
}

function stringField(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function booleanField(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readState(path: string): ShipItStateDiagnostics {
  const base = metadata(path);
  if (!base.exists) return { exists: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return { ...base, parseError: "not_object" };
    }
    const record = parsed as JsonRecord;
    const bundleIdentifier = stringField(record, "bundleIdentifier");
    const launchAfterInstallation = booleanField(record, "launchAfterInstallation");
    const targetBundleURL = stringField(record, "targetBundleURL");
    const updateBundleURL = stringField(record, "updateBundleURL");
    const useUpdateBundleName = booleanField(record, "useUpdateBundleName");
    return {
      ...base,
      ...(bundleIdentifier !== undefined ? { bundleIdentifier } : {}),
      ...(launchAfterInstallation !== undefined ? { launchAfterInstallation } : {}),
      ...(targetBundleURL !== undefined ? { targetBundleURL } : {}),
      ...(updateBundleURL !== undefined ? { updateBundleURL } : {}),
      ...(useUpdateBundleName !== undefined ? { useUpdateBundleName } : {})
    };
  } catch (err) {
    return {
      ...base,
      parseError: err instanceof Error ? err.message : String(err)
    };
  }
}

export function readMacShipItDiagnostics(options: {
  homeDir: string;
  platform: NodeJS.Platform;
  resourcesPath: string;
}): MacShipItDiagnostics {
  const cachePath = join(options.homeDir, "Library", "Caches", SHIP_IT_BUNDLE_ID);
  const shipItPath = join(
    options.resourcesPath,
    "..",
    "Frameworks",
    "Squirrel.framework",
    "Resources",
    "ShipIt"
  );
  const statePath = join(cachePath, "ShipItState.plist");
  const stdoutPath = join(cachePath, "ShipIt_stdout.log");
  const stderrPath = join(cachePath, "ShipIt_stderr.log");
  return {
    platform: options.platform,
    shipItPath,
    shipItExists: existsSync(shipItPath),
    statePath,
    state: readState(statePath),
    stdoutPath,
    stdout: metadata(stdoutPath),
    stderrPath,
    stderr: metadata(stderrPath)
  };
}
