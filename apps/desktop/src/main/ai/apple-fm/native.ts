import { app } from "electron";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { AppleFmStatus } from "@pwrsnap/shared";
import { AppleFmError } from "./enrichment";
import {
  AppleFmOutputLimitError,
  AppleFmTimeoutError,
  createAppleCaptionProcessRunner,
  type FmRunner
} from "./fm-cli";
import { APPLE_FM_PROBE_TIMEOUT_MS } from "./status";

const PACKAGED_HELPER = "PwrSnapAppleCaption";
const DEVELOPER_HELPER = "apple-caption";

function assertNativeCaptionArgs(args: readonly string[]): void {
  if (args.length !== 1 || !["status", "test", "caption"].includes(args[0] ?? "")) {
    throw new Error("Invalid native Apple caption command");
  }
}

/** Electron's product version ("27.2") on macOS, or null under plain Node. */
export function readMacosVersion(): string | null {
  if (process.platform !== "darwin") return null;
  const read = (process as { getSystemVersion?: () => string }).getSystemVersion;
  return typeof read === "function" ? read.call(process) : null;
}

function needsNewerMacos(version: string | null): boolean {
  return version !== null && Number.parseInt(version, 10) < 27;
}

export function createNativeCaptionRunner(binary: string, macosVersion = readMacosVersion()): FmRunner {
  const run = createAppleCaptionProcessRunner(binary, assertNativeCaptionArgs);
  return async (args, options) => {
    // The helper can fail at dynamic linking on older macOS, before Swift can
    // check availability. Let the process runner handle an existing abort.
    if (!options.signal?.aborted && needsNewerMacos(macosVersion)) {
      throw new AppleFmError("not-ready", "the bundled Apple captions helper requires macOS 27 or later.");
    }
    try {
      return await run(args, options);
    } catch (error) {
      if (
        error instanceof AppleFmTimeoutError ||
        error instanceof AppleFmOutputLimitError ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      // Node's launch errors include the executable's absolute path.
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        throw new AppleFmError("not-ready", "the bundled Apple captions helper couldn't be found.");
      }
      throw new AppleFmError("failed", "the bundled Apple captions helper couldn't be started.");
    }
  };
}

/** An installed app always expects its signed helper. A dev checkout with an
 * older SDK can still exercise the legacy fm path. */
export async function resolveNativeCaptionRunner(): Promise<FmRunner | null> {
  if (process.platform !== "darwin") return null;
  if (app?.isPackaged) {
    return createNativeCaptionRunner(join(process.resourcesPath, PACKAGED_HELPER));
  }
  const desktop = app?.getAppPath?.();
  if (desktop === undefined) return null;
  const binary = join(desktop, "build", "native", DEVELOPER_HELPER);
  try {
    await access(binary, constants.X_OK);
    return createNativeCaptionRunner(binary);
  } catch {
    return null;
  }
}

export async function probeNativeCaptionStatus(
  run: FmRunner,
  macosVersion: string | null
): Promise<AppleFmStatus> {
  const status: AppleFmStatus = {
    state: "probe-failed", transport: "native", macosVersion,
    modelLabel: null, detail: null, checkedAt: Date.now()
  };
  if (needsNewerMacos(macosVersion)) {
    return { ...status, state: "needs-macos" };
  }
  try {
    const result = await run(["status"], { timeoutMs: APPLE_FM_PROBE_TIMEOUT_MS });
    if (result.code !== 0) return status;
    switch (result.stdout.trim()) {
      case "ready":
        return { ...status, state: "ready" };
      case "needs-macos":
        return { ...status, state: "needs-macos" };
      case "device-not-eligible":
        return { ...status, state: "device-not-eligible" };
      case "apple-intelligence-off":
        return { ...status, state: "apple-intelligence-off" };
      case "model-not-ready":
        return { ...status, state: "model-not-ready" };
      case "unavailable":
        return { ...status, state: "unavailable" };
      default:
        return status;
    }
  } catch {
    return status;
  }
}
