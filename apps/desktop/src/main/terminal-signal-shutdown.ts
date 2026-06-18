import { app as electronApp } from "electron";
import type { App } from "electron";
import { getMainLogger } from "./log";

const TERMINAL_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type TerminalShutdownSignal = (typeof TERMINAL_SHUTDOWN_SIGNALS)[number];

type SignalProcess = {
  on: (signal: TerminalShutdownSignal, listener: () => void) => unknown;
  off: (signal: TerminalShutdownSignal, listener: () => void) => unknown;
};

type TerminalSignalShutdownOptions = {
  app?: Pick<App, "quit" | "exit">;
  logger?: Pick<ReturnType<typeof getMainLogger>, "info" | "warn">;
  process?: SignalProcess;
};

const signalExitCodes: Record<TerminalShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129
};

export function installTerminalSignalShutdown(
  options: TerminalSignalShutdownOptions = {}
): () => void {
  const app = options.app ?? electronApp;
  const logger = options.logger ?? getMainLogger("pwrsnap:terminal-shutdown");
  const processTarget = options.process ?? process;
  let shutdownRequested = false;

  const handlers = TERMINAL_SHUTDOWN_SIGNALS.map((signal) => {
    const handler = (): void => {
      if (shutdownRequested) {
        logger.warn("forcing app exit after repeated terminal shutdown signal", { signal });
        app.exit(signalExitCodes[signal]);
        return;
      }

      shutdownRequested = true;
      logger.info("terminal shutdown signal received; quitting app", { signal });
      app.quit();
    };

    processTarget.on(signal, handler);
    return { signal, handler };
  });

  return () => {
    for (const { signal, handler } of handlers) {
      processTarget.off(signal, handler);
    }
  };
}
