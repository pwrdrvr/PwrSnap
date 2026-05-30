import { app } from "electron";
import { join } from "node:path";

import type { FilenameTimestampZone } from "@pwrsnap/shared";

import { getMainLogger } from "../log";
import { DesktopSettingsService } from "../settings/desktop-settings-service";

const log = getMainLogger("pwrsnap:bundle-filename-settings");

export async function readBundleFilenameTimestampZone(): Promise<FilenameTimestampZone> {
  try {
    const settings = await new DesktopSettingsService({
      filePath: join(app.getPath("userData"), "pwrsnap-settings.json")
    }).read();
    return settings.storage.filenameTimestampZone;
  } catch (cause) {
    log.warn("falling back to local bundle filename timestamps", {
      message: cause instanceof Error ? cause.message : String(cause)
    });
    return "local";
  }
}
