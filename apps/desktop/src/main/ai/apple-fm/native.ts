import { app } from "electron";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import type { AppleFmStatus } from "@pwrsnap/shared";
import { createAppleCaptionProcessRunner, type FmRunner } from "./fm-cli";
import { APPLE_FM_PROBE_TIMEOUT_MS } from "./status";

const PACKAGED_HELPER = "PwrSnapAppleCaption";
const DEVELOPER_HELPER = "apple-caption";

function assertNativeCaptionArgs(args: readonly string[]): void {
  if (args.length !== 1 || !["status", "test", "caption"].includes(args[0] ?? "")) {
    throw new Error("Invalid native Apple caption command");
  }
}

export function createNativeCaptionRunner(binary: string): FmRunner {
  return createAppleCaptionProcessRunner(binary, assertNativeCaptionArgs);
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
  if (macosVersion !== null && Number.parseInt(macosVersion, 10) < 27) {
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
