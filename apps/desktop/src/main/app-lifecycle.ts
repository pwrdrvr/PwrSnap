import { app, BrowserWindow } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwrsnap:lifecycle");

type SignalTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
};

let installed = false;
let signalQuitInFlight = false;
let forceDestroyTimer: NodeJS.Timeout | null = null;
let forceExitTimer: NodeJS.Timeout | null = null;
const FORCE_DESTROY_WINDOWS_AFTER_MS = 2_000;
const FORCE_EXIT_AFTER_SIGNAL_MS = 5_000;

/**
 * Forceful fallback for Electron's graceful quit path. Normal quit
 * must first let Electron close windows so renderer `beforeunload`
 * cleanup can flush pending state. If a renderer is wedged and a
 * BrowserWindow survives that path, this fallback destroys what is
 * left so the process does not hang around with a stray window.
 */
export function forceDestroyAllBrowserWindowsForAppQuit(reason: string): number {
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

function scheduleForceDestroyAllBrowserWindows(reason: string): void {
  if (forceDestroyTimer !== null) return;
  forceDestroyTimer = setTimeout(() => {
    forceDestroyTimer = null;
    forceDestroyAllBrowserWindowsForAppQuit(reason);
  }, FORCE_DESTROY_WINDOWS_AFTER_MS);
  forceDestroyTimer.unref();
}

function forceExitSoon(): void {
  if (forceExitTimer !== null) return;
  forceExitTimer = setTimeout(() => {
    log.warn("app quit signal did not complete promptly; forcing process exit");
    app.exit(0);
  }, FORCE_EXIT_AFTER_SIGNAL_MS);
  forceExitTimer.unref();
}

export function installAppQuitTeardownHandlers(signalTarget: SignalTarget = process): void {
  if (installed) return;
  installed = true;

  app.on("before-quit", () => {
    scheduleForceDestroyAllBrowserWindows("before-quit-timeout");
  });

  const requestQuitFromSignal = (signal: NodeJS.Signals): void => {
    if (signalQuitInFlight) {
      log.warn("received repeated quit signal; forcing process exit", { signal });
      app.exit(0);
      return;
    }
    signalQuitInFlight = true;
    log.info("received quit signal", { signal });
    scheduleForceDestroyAllBrowserWindows(`${signal}-timeout`);
    forceExitSoon();
    app.quit();
  };

  signalTarget.on("SIGTERM", () => requestQuitFromSignal("SIGTERM"));
  signalTarget.on("SIGINT", () => requestQuitFromSignal("SIGINT"));
}
