// Process-wide owner of the on-device model's status answer.

import { AppleFmStatusService, defaultAppleFmProbeDeps, probeAppleFmStatus } from "./status";
import { probeNativeCaptionStatus, readMacosVersion, resolveNativeCaptionRunner } from "./native";

let singleton: AppleFmStatusService | undefined;

export function getAppleFmStatusService(): AppleFmStatusService {
  singleton ??= new AppleFmStatusService(async () => {
    const run = await resolveNativeCaptionRunner();
    return run === null
      ? probeAppleFmStatus(defaultAppleFmProbeDeps(readMacosVersion))
      : probeNativeCaptionStatus(run, readMacosVersion());
  });
  return singleton;
}
