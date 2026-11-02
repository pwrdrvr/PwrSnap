import { app, powerMonitor } from "electron";
import { getMainLogger } from "./log";
import { quitWithExitFailSafe } from "./quit-retry";
import { onSizzleQuitCancelled } from "./sizzle/sizzle-close-barrier";

/** Register after app-ready, before asynchronous startup work. */
export function installSystemShutdown(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "linux" && platform !== "darwin") return;

  const log = getMainLogger("pwrsnap:system-shutdown");
  let shuttingDown = false;
  if (platform === "darwin") {
    const unsubscribe = onSizzleQuitCancelled(() => {
      // Cancel keeps the unsaved project open. A later shutdown notification
      // must be able to start a fresh quit/save attempt.
      shuttingDown = false;
    });
    app.on("quit", unsubscribe);
  }
  // Electron's generated callback type omits the event documented by the API.
  powerMonitor.on("shutdown", (event?: Electron.Event) => {
    // Hold Electron's OS shutdown delay before cleanup starts. Otherwise logind
    // can kill Chromium helpers while the browser is alive, causing fatal GPU
    // relaunch failures. Repeated notifications must also retain the delay.
    event?.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("system shutdown requested; quitting app");
    if (platform === "linux") {
      // Bound cleanup below logind's usual five-second inhibitor deadline.
      quitWithExitFailSafe(app, {
        afterMs: 3_000,
        warn: (message) => log.warn("system shutdown:", message)
      });
    } else {
      // macOS has no logind deadline. Let Sizzle save or ask the user whether
      // to discard unsaved work, and honor Cancel. The existing diagnostics,
      // recording and windowless quit recovery paths bound stalled cleanup.
      app.quit();
    }
  });
}
