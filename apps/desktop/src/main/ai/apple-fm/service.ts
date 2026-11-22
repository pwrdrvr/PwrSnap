// Process-wide owner of the on-device model's status answer.

import { AppleFmStatusService, defaultAppleFmProbeDeps, probeAppleFmStatus } from "./status";
import { probeNativeCaptionStatus, resolveNativeCaptionRunner } from "./native";

/** Electron's product version ("27.2") on macOS; null elsewhere and under
 *  plain Node, where `process.getSystemVersion` does not exist. */
function macosVersion(): string | null {
  if (process.platform !== "darwin") return null;
  const read = (process as { getSystemVersion?: () => string }).getSystemVersion;
  return typeof read === "function" ? read.call(process) : null;
}

let singleton: AppleFmStatusService | undefined;

export function getAppleFmStatusService(): AppleFmStatusService {
  singleton ??= new AppleFmStatusService(async () => {
    const run = await resolveNativeCaptionRunner();
    return run === null
      ? probeAppleFmStatus(defaultAppleFmProbeDeps(macosVersion))
      : probeNativeCaptionStatus(run, macosVersion());
  });
  return singleton;
}
