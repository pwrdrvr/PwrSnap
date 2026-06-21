import { app as electronApp } from "electron";
import type { App } from "electron";
import { execFileSync } from "node:child_process";
import { getMainLogger } from "./log";

const TERMINAL_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type TerminalShutdownSignal = (typeof TERMINAL_SHUTDOWN_SIGNALS)[number];

type SignalProcess = {
  pid?: number;
  ppid?: number;
  env?: NodeJS.ProcessEnv;
  on: (signal: TerminalShutdownSignal, listener: () => void) => unknown;
  off: (signal: TerminalShutdownSignal, listener: () => void) => unknown;
};

type ProcessSnapshot = {
  pid?: number;
  ppid?: number;
  pgid?: number;
  sessionId?: number;
  terminalProcessGroupId?: number;
  tty?: string;
  stat?: string;
  command?: string;
  error?: string;
};

type TerminalSignalShutdownOptions = {
  app?: Pick<App, "quit" | "exit">;
  logger?: Pick<ReturnType<typeof getMainLogger>, "info" | "warn">;
  process?: SignalProcess;
  processSnapshot?: (pid: number | undefined) => ProcessSnapshot | undefined;
};

const signalExitCodes: Record<TerminalShutdownSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129
};

function processSnapshot(pid: number | undefined): ProcessSnapshot | undefined {
  if (pid === undefined) return undefined;

  try {
    const line = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "pid=,ppid=,pgid=,sess=,tpgid=,tty=,stat=,command="],
      { encoding: "utf8" }
    ).trim();

    if (line.length === 0) return { pid, error: "process not found" };

    const [
      pidText,
      ppidText,
      pgidText,
      sessionText,
      terminalProcessGroupText,
      tty,
      stat,
      ...command
    ] = line.split(/\s+/);
    return {
      pid: Number(pidText),
      ppid: Number(ppidText),
      pgid: Number(pgidText),
      sessionId: Number(sessionText),
      terminalProcessGroupId: Number(terminalProcessGroupText),
      tty,
      stat,
      command: command.join(" ")
    };
  } catch (error) {
    return {
      pid,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export function installTerminalSignalShutdown(
  options: TerminalSignalShutdownOptions = {}
): () => void {
  const app = options.app ?? electronApp;
  const logger = options.logger ?? getMainLogger("pwrsnap:terminal-shutdown");
  const processTarget = options.process ?? process;
  const snapshot = options.processSnapshot ?? processSnapshot;
  let shutdownRequested = false;

  const handlers = TERMINAL_SHUTDOWN_SIGNALS.map((signal) => {
    const handler = (): void => {
      const context = {
        process: snapshot(processTarget.pid),
        parent: snapshot(processTarget.ppid),
        terminal: processTarget.env?.TERM,
        terminalProgram: processTarget.env?.TERM_PROGRAM
      };

      if (shutdownRequested) {
        logger.warn("forcing app exit after repeated terminal shutdown signal", {
          signal,
          context
        });
        app.exit(signalExitCodes[signal]);
        return;
      }

      shutdownRequested = true;
      logger.info("terminal shutdown signal received; quitting app", { signal, context });
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
