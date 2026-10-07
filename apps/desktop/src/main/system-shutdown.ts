import { app, powerMonitor } from "electron";
import { getMainLogger } from "./log";
import { quitWithExitFailSafe } from "./quit-retry";

/** Register after app-ready, before asynchronous startup work. */
export function installSystemShutdown(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") return;

  const log = getMainLogger("pwrsnap:system-shutdown");
  let shuttingDown = false;
  // Electron's generated callback type omits the event documented by the API.
  powerMonitor.on("shutdown", (event?: Electron.Event) => {
    // Hold Electron's OS shutdown delay before cleanup starts. Otherwise logind
    // can kill Chromium helpers while the browser is alive, causing fatal GPU
    // relaunch failures. Repeated notifications must also retain the delay.
    event?.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("system shutdown requested; quitting app");
    // Keep the existing save/diagnostics/recording teardown, but bound stalled
    // cleanup below logind's usual five-second delay-inhibitor deadline.
    quitWithExitFailSafe(app, {
      afterMs: 3_000,
      warn: (message) => log.warn("system shutdown:", message)
    });
  });
}
