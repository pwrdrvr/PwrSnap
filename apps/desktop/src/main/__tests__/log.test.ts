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
    maxSize: 0,
    sync: true,
    transforms: [],
    getFile: vi.fn(() => ({ path: "/tmp/pwrsnap/main.log" }))
  });
  const scope = Object.assign(vi.fn(), { labelPadding: true });

  return {
    consoleTransport,
    consoleWriteFn,
    electronLog: {
      initialize: vi.fn(),
      hooks: [] as Array<(...args: any[]) => unknown>,
      scope,
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
    mocks.fileTransport.maxSize = 0;
    mocks.fileTransport.sync = true;
    mocks.fileTransport.transforms = [];
    mocks.electronLog.hooks.length = 0;
    mocks.electronLog.scope.labelPadding = true;
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
    const {
      initializeMainLogger,
      MAIN_LOG_FILE_LEVEL,
      MAIN_LOG_FILE_MAX_SIZE_BYTES,
      MAIN_LOG_FILE_SYNC
    } = await import("../log");
    initializeMainLogger();

    process.stderr.emit("error", makeBrokenPipeError());

    expect(mocks.consoleTransport.level).toBe(false);
    expect(mocks.fileTransport.level).toBe(MAIN_LOG_FILE_LEVEL);
    expect(mocks.fileTransport.maxSize).toBe(MAIN_LOG_FILE_MAX_SIZE_BYTES);
    expect(mocks.fileTransport.sync).toBe(MAIN_LOG_FILE_SYNC);
    expect(mocks.fileTransport.sync).toBe(false);
    expect(mocks.electronLog.hooks).toHaveLength(1);
    expect(mocks.electronLog.scope.labelPadding).toBe(false);
  });

  test("formats terminal timestamps in local time", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    const format = mocks.consoleTransport.format as unknown as (params: {
      message: {
        data: unknown[];
        date: Date;
        level: string;
        scope?: string;
      };
    }) => unknown[];
    const localDate = new Date(2026, 7, 4, 9, 8, 7, 6);

    expect(format({
      message: {
        data: ["hello"],
        date: localDate,
        level: "info",
        scope: "pwrsnap:test"
      }
    })).toEqual(["09:08:07.006 (pwrsnap:test)", "hello"]);
  });

  test("compacts structured file messages into the live log tail", async () => {
    const { initializeMainLogger } = await import("../log");
    initializeMainLogger();

    const hook = mocks.electronLog.hooks[0];
    expect(hook).toBeTypeOf("function");
    hook?.(
      {
        data: ["chat tool call failed", { tool: "capture_metadata", error: "not found" }],
        date: new Date("2026-06-10T12:34:56.789Z"),
        level: "warn",
        scope: "pwrsnap:chat-tools"
      },
      mocks.fileTransport,
      "file"
    );

    const { readAppLogSnapshot } = await import("../app-logs");
    const snapshot = readAppLogSnapshot({ debugCollectionEnabled: false });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.line).toContain("[warn ] (pwrsnap:chat-tools)");
    expect(snapshot.entries[0]?.line).toContain("tool=capture_metadata");
    expect(snapshot.entries[0]?.line).toContain('error="not found"');
  });
});
