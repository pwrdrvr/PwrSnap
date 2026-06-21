import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTerminalSignalShutdown } from "../terminal-signal-shutdown";

type Listener = () => void;
type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

function createSignalProcess() {
  const listeners = new Map<string, Listener[]>();

  return {
    pid: 2001,
    ppid: 2000,
    env: {
      TERM: "xterm-256color",
      TERM_PROGRAM: "Ghostty"
    },
    on: vi.fn((signal: ShutdownSignal, listener: Listener) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    }),
    off: vi.fn((signal: ShutdownSignal, listener: Listener) => {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((candidate) => candidate !== listener)
      );
    }),
    emit(signal: ShutdownSignal) {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    },
    listenerCount(signal: ShutdownSignal) {
      return listeners.get(signal)?.length ?? 0;
    }
  };
}

const app = {
  exit: vi.fn(),
  quit: vi.fn()
};

const logger = {
  info: vi.fn(),
  warn: vi.fn()
};

const signalContext = {
  process: { pid: 2001, command: "Electron ." },
  parent: { pid: 2000, command: "node electron-vite dev" },
  terminal: "xterm-256color",
  terminalProgram: "Ghostty"
};

function processSnapshot(pid: number | undefined) {
  if (pid === 2001) return signalContext.process;
  if (pid === 2000) return signalContext.parent;
  return undefined;
}

describe("installTerminalSignalShutdown", () => {
  beforeEach(() => {
    app.exit.mockClear();
    app.quit.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("routes Ctrl+C SIGINT through Electron quit so will-quit cleanup runs", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess, processSnapshot });
    signalProcess.emit("SIGINT");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("terminal shutdown signal received; quitting app", {
      signal: "SIGINT",
      context: signalContext
    });
  });

  it("also handles SIGTERM from terminal and process managers", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess, processSnapshot });
    signalProcess.emit("SIGTERM");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("handles terminal hangup as a graceful app quit", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess, processSnapshot });
    signalProcess.emit("SIGHUP");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("forces exit on a repeated shutdown signal if graceful quit is wedged", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess, processSnapshot });
    signalProcess.emit("SIGINT");
    signalProcess.emit("SIGINT");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(130);
    expect(logger.warn).toHaveBeenCalledWith(
      "forcing app exit after repeated terminal shutdown signal",
      { signal: "SIGINT", context: signalContext }
    );
  });

  it("returns a dispose function that unregisters installed listeners", () => {
    const signalProcess = createSignalProcess();

    const dispose = installTerminalSignalShutdown({ app, logger, process: signalProcess });
    expect(signalProcess.listenerCount("SIGINT")).toBe(1);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(1);
    expect(signalProcess.listenerCount("SIGHUP")).toBe(1);

    dispose();

    expect(signalProcess.listenerCount("SIGINT")).toBe(0);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(0);
    expect(signalProcess.listenerCount("SIGHUP")).toBe(0);
  });
});
