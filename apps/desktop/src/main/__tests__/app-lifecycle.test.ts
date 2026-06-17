import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, test, vi } from "vitest";

type MockWindow = {
  id: number;
  destroyed: boolean;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
};

const electronMock = vi.hoisted(() => ({
  appExit: vi.fn(),
  appOn: vi.fn(),
  appQuit: vi.fn(),
  windows: [] as MockWindow[]
}));

vi.mock("electron", () => ({
  app: {
    exit: electronMock.appExit,
    on: electronMock.appOn,
    quit: electronMock.appQuit
  },
  BrowserWindow: {
    getAllWindows: () => electronMock.windows
  }
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  })
}));

function makeWindow(id: number, destroyed = false): MockWindow {
  const win: MockWindow = {
    id,
    destroyed,
    destroy: vi.fn(() => {
      win.destroyed = true;
    }),
    isDestroyed: () => win.destroyed
  };
  return win;
}

async function importLifecycle(): Promise<typeof import("../app-lifecycle")> {
  return import("../app-lifecycle");
}

describe("app lifecycle teardown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    electronMock.appExit.mockClear();
    electronMock.appOn.mockClear();
    electronMock.appQuit.mockClear();
    electronMock.windows = [];
  });

  test("before-quit gives renderers a graceful close window before fallback destroy", async () => {
    const live = makeWindow(1);
    const settings = makeWindow(2);
    const alreadyGone = makeWindow(3, true);
    electronMock.windows = [live, settings, alreadyGone];
    const signalTarget = new EventEmitter();

    const { installAppQuitTeardownHandlers } = await importLifecycle();
    installAppQuitTeardownHandlers(signalTarget as unknown as NodeJS.Process);

    const beforeQuit = electronMock.appOn.mock.calls.find(
      ([event]) => event === "before-quit"
    )?.[1] as (() => void) | undefined;
    expect(beforeQuit).toBeDefined();
    beforeQuit?.();

    expect(live.destroy).not.toHaveBeenCalled();
    expect(settings.destroy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);

    expect(live.destroy).toHaveBeenCalledTimes(1);
    expect(settings.destroy).toHaveBeenCalledTimes(1);
    expect(alreadyGone.destroy).not.toHaveBeenCalled();
  });

  test("SIGTERM enters Electron quit and only force-destroys windows after timeout", async () => {
    const live = makeWindow(11);
    electronMock.windows = [live];
    const signalTarget = new EventEmitter();

    const { installAppQuitTeardownHandlers } = await importLifecycle();
    installAppQuitTeardownHandlers(signalTarget as unknown as NodeJS.Process);

    signalTarget.emit("SIGTERM");

    expect(live.destroy).not.toHaveBeenCalled();
    expect(electronMock.appQuit).toHaveBeenCalledTimes(1);
    expect(electronMock.appExit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);

    expect(live.destroy).toHaveBeenCalledTimes(1);
  });

  test("a repeated quit signal forces process exit", async () => {
    const signalTarget = new EventEmitter();

    const { installAppQuitTeardownHandlers } = await importLifecycle();
    installAppQuitTeardownHandlers(signalTarget as unknown as NodeJS.Process);

    signalTarget.emit("SIGTERM");
    signalTarget.emit("SIGINT");

    expect(electronMock.appQuit).toHaveBeenCalledTimes(1);
    expect(electronMock.appExit).toHaveBeenCalledWith(0);
  });
});
