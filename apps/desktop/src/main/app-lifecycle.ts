import { app, BrowserWindow } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:lifecycle");

type SignalTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
};

let installed = false;
let signalQuitInFlight = false;
let forceExitTimer: NodeJS.Timeout | null = null;

/**
 * Electron's graceful quit path closes windows before `will-quit`.
 * If a secondary renderer is wedged, that handshake can leave the
 * process alive with a stray window. On process teardown we do not
 * need renderer cleanup; destroy every BrowserWindow synchronously
 * and let the existing `will-quit` handler release native resources.
 */
export function destroyAllBrowserWindowsForAppQuit(reason: string): number {
  let destroyed = 0;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.destroy();
      destroyed += 1;
    } catch (cause) {
      log.warn("failed to destroy BrowserWindow during app quit", {
        reason,
        id: win.id,
        message: cause instanceof Error ? cause.message : String(cause)
      });
    }
  }
  if (destroyed > 0) {
    log.info("destroyed BrowserWindows for app quit", { reason, count: destroyed });
  }
  return destroyed;
}

function forceExitSoon(): void {
  if (forceExitTimer !== null) return;
  forceExitTimer = setTimeout(() => {
    log.warn("app quit signal did not complete promptly; forcing process exit");
    app.exit(0);
  }, 5_000);
  forceExitTimer.unref();
}

export function installAppQuitTeardownHandlers(signalTarget: SignalTarget = process): void {
  if (installed) return;
  installed = true;

  app.on("before-quit", () => {
    destroyAllBrowserWindowsForAppQuit("before-quit");
  });

  const requestQuitFromSignal = (signal: NodeJS.Signals): void => {
    if (signalQuitInFlight) {
      log.warn("received repeated quit signal; forcing process exit", { signal });
      app.exit(0);
      return;
    }
    signalQuitInFlight = true;
    log.info("received quit signal", { signal });
    destroyAllBrowserWindowsForAppQuit(signal);
    forceExitSoon();
    app.quit();
  };

  signalTarget.on("SIGTERM", () => requestQuitFromSignal("SIGTERM"));
  signalTarget.on("SIGINT", () => requestQuitFromSignal("SIGINT"));
}
