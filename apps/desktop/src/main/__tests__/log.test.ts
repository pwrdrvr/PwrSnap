import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type ErrorListener = (error: Error) => void;

const mocks = vi.hoisted(() => {
  const consoleWriteFn = vi.fn();
  const consoleTransport = Object.assign(vi.fn(), {
    format: "",
    level: "silly" as string | false,
    transforms: [],
    writeFn: consoleWriteFn
  });

  const fileTransport = Object.assign(vi.fn(), {
    format: "",
    level: "silly" as string | false,
    transforms: []
  });

  return {
    consoleTransport,
    consoleWriteFn,
    electronLog: {
      initialize: vi.fn(),
      scope: vi.fn(),
      transports: {
        console: consoleTransport,
        file: fileTransport
      }
    },
    fileTransport
  };
});

vi.mock("electron-log/main.js", () => ({
  default: mocks.electronLog
}));

function makeBrokenPipeError(): Error & { code: string } {
  return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

function makeMessage() {
  return {
    message: {
      data: ["hello"],
      date: new Date("2026-06-10T00:00:00.000Z"),
      level: "info"
    }
  };
}

describe("initializeMainLogger", () => {
  let stdoutErrorListeners: ErrorListener[];
  let stderrErrorListeners: ErrorListener[];

  beforeEach(() => {
    stdoutErrorListeners = process.stdout.listeners("error") as ErrorListener[];
    stderrErrorListeners = process.stderr.listeners("error") as ErrorListener[];
    vi.resetModules();
    mocks.electronLog.initialize.mockClear();
    mocks.consoleWriteFn.mockReset();
    mocks.consoleTransport.format = "";
    mocks.consoleTransport.level = "silly";
    mocks.consoleTransport.transforms = [];
    mocks.consoleTransport.writeFn = mocks.consoleWriteFn;
    mocks.fileTransport.format = "";
    mocks.fileTransport.level = "silly";
    mocks.fileTransport.transforms = [];
  });

  afterEach(() => {
    for (const listener of process.stdout.listeners("error") as ErrorListener[]) {
      if (!stdoutErrorListeners.includes(listener)) {
        process.stdout.off("error", listener);
      }
    }

    for (const listener of process.stderr.listeners("error") as ErrorListener[]) {
      if (!stderrErrorListeners.includes(listener)) {
        process.stderr.off("error", listener);
      }
    }
  });

  test("disables console logging when the console transport hits a broken stdout pipe", async () => {
    mocks.consoleWriteFn.mockImplementation(() => {
      throw makeBrokenPipeError();
    });

    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    expect(() => mocks.consoleTransport.writeFn(makeMessage())).not.toThrow();
    expect(mocks.consoleWriteFn).toHaveBeenCalledTimes(1);
    expect(mocks.consoleTransport.level).toBe(false);

    mocks.consoleTransport.writeFn(makeMessage());
    expect(mocks.consoleWriteFn).toHaveBeenCalledTimes(1);
  });

  test("disables console logging when stdout emits an asynchronous broken-pipe error", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    expect(() => process.stdout.emit("error", makeBrokenPipeError())).not.toThrow();
    expect(mocks.consoleTransport.level).toBe(false);
  });

  test("keeps file logging configured when console logging is disabled", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    process.stderr.emit("error", makeBrokenPipeError());

    expect(mocks.consoleTransport.level).toBe(false);
    expect(mocks.fileTransport.level).toBe("silly");
    expect(typeof mocks.fileTransport.format).toBe("function");
  });
});
