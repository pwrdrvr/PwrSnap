import { beforeEach, describe, expect, it, vi } from "vitest";
import { installTerminalSignalShutdown } from "../terminal-signal-shutdown";

type Listener = () => void;

function createSignalProcess() {
  const listeners = new Map<string, Listener[]>();

  return {
    on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: Listener) => {
      listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
    }),
    off: vi.fn((signal: "SIGINT" | "SIGTERM", listener: Listener) => {
      listeners.set(
        signal,
        (listeners.get(signal) ?? []).filter((candidate) => candidate !== listener)
      );
    }),
    emit(signal: "SIGINT" | "SIGTERM") {
      for (const listener of listeners.get(signal) ?? []) {
        listener();
      }
    },
    listenerCount(signal: "SIGINT" | "SIGTERM") {
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

describe("installTerminalSignalShutdown", () => {
  beforeEach(() => {
    app.exit.mockClear();
    app.quit.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
  });

  it("routes Ctrl+C SIGINT through Electron quit so will-quit cleanup runs", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess });
    signalProcess.emit("SIGINT");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("terminal shutdown signal received; quitting app", {
      signal: "SIGINT"
    });
  });

  it("also handles SIGTERM from terminal and process managers", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess });
    signalProcess.emit("SIGTERM");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("forces exit on a repeated shutdown signal if graceful quit is wedged", () => {
    const signalProcess = createSignalProcess();

    installTerminalSignalShutdown({ app, logger, process: signalProcess });
    signalProcess.emit("SIGINT");
    signalProcess.emit("SIGINT");

    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(app.exit).toHaveBeenCalledWith(130);
    expect(logger.warn).toHaveBeenCalledWith(
      "forcing app exit after repeated terminal shutdown signal",
      { signal: "SIGINT" }
    );
  });

  it("returns a dispose function that unregisters installed listeners", () => {
    const signalProcess = createSignalProcess();

    const dispose = installTerminalSignalShutdown({ app, logger, process: signalProcess });
    expect(signalProcess.listenerCount("SIGINT")).toBe(1);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(1);

    dispose();

    expect(signalProcess.listenerCount("SIGINT")).toBe(0);
    expect(signalProcess.listenerCount("SIGTERM")).toBe(0);
  });
});
