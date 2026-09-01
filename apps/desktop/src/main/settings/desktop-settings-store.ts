// One DesktopSettingsService per Electron main-process lifetime. The agent /
// combined process owns writes; the split library gets its own read-only
// snapshot because it is a separate OS process. Construction stays lazy:
// app.getPath("userData") is not safe at module evaluation time.

import { app } from "electron";
import { join } from "node:path";

import { DesktopSettingsService } from "./desktop-settings-service";

let processStore: DesktopSettingsService | null = null;

export function getDesktopSettingsStore(): DesktopSettingsService {
  processStore ??= new DesktopSettingsService({
    filePath: join(app.getPath("userData"), "pwrsnap-settings.json"),
    resolveAppVersion: () => {
      try {
        return typeof app.getVersion === "function" ? app.getVersion() : "";
      } catch {
        return "";
      }
    }
  });
  return processStore;
}

/** Test seam for production-wiring specs. Secrets deliberately do not live
 *  in this store and retain their existing encrypted, on-demand substrate. */
export function __setDesktopSettingsStoreForTests(
  service: DesktopSettingsService | null
): void {
  processStore = service;
}
