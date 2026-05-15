// Command-bus handlers for the `app:*` namespace.
//
// Currently exposes one verb (`app:version`) used by the Settings →
// About page. Kept in its own module so any future app-level reads
// (build channel, signing info, locale) have an obvious home.

import { app } from "electron";
import { ok } from "@pwrsnap/shared";
import { bus } from "../command-bus";

export function registerAppHandlers(): void {
  bus.register("app:version", async () => {
    return ok({
      version: app.getVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? ""
    });
  });
}
