import type { FilenameTimestampZone } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { getDesktopSettingsStore } from "../settings/desktop-settings-store";

const log = getMainLogger("pwrsnap:bundle-filename-settings");

export async function readBundleFilenameTimestampZone(): Promise<FilenameTimestampZone> {
  try {
    const settings = await getDesktopSettingsStore().read();
    return settings.storage.filenameTimestampZone;
  } catch (cause) {
    log.warn("falling back to local bundle filename timestamps", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return "local";
  }
}
