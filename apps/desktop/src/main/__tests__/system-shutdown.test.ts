import { readFileSync } from "node:fs";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsShutdown } from "../diagnostics/diagnostics-shutdown";
import { installSystemShutdown } from "../system-shutdown";
import {
  completeSizzleCloseRequest,
  installSizzleQuitBarrier,
  markSizzleCloseRendererReady,
  wireSizzleCloseBarrier
} from "../sizzle/sizzle-close-barrier";
import { ElectronQuitModel } from "./electron-quit-model";

const electron = vi.hoisted(() => ({
  shutdown: undefined as ((event?: { preventDefault(): void }) => void) | undefined,
  didQuit: undefined as (() => void) | undefined,
  app: { quit: vi.fn(), exit: vi.fn(), on: vi.fn() },
  powerMonitor: { on: vi.fn() }
}));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("electron", () => ({ app: electron.app, powerMonitor: electron.powerMonitor }));
vi.mock("../log", () => ({ getMainLogger: () => logger }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.resetAllMocks();
  electron.shutdown = undefined;
  electron.didQuit = undefined;
  electron.powerMonitor.on.mockImplementation((_event, handler) => {
    electron.shutdown = handler;
  });
  electron.app.on.mockImplementation((event, handler) => {
    expect(event).toBe("quit");
    electron.didQuit = handler;
  });
});

afterEach(() => {
  electron.didQuit?.();
  vi.useRealTimers();
});

/** Wire the actual Sizzle barrier to the same quit model used by cleanup tests. */
function setupSizzleQuit(id: number) {
  const model = new ElectronQuitModel(["sizzle"]);
  let destroyed = false;
  const listeners = new Map<string, () => void>();
  const send = vi.fn();
  const window = {
    id,
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, on: vi.fn(), send },
    on: (event: string, listener: () => void) => listeners.set(event, listener)
  };
  wireSizzleCloseBarrier(window as unknown as BrowserWindow);
  markSizzleCloseRendererReady(id);
  installSizzleQuitBarrier(model as unknown as Parameters<typeof installSizzleQuitBarrier>[0]);
  electron.app.quit.mockImplementation(model.quit);
  electron.app.on.mockImplementation((event, listener) => model.on(event, listener));
  return {
    model,
    send,
    async dispose() {
      destroyed = true;
      listeners.get("closed")?.();
      model.quit();
      await model.settle();
    }
  };
}

describe("system shutdown", () => {
  it.each(["linux", "darwin"] as const)(
    "holds %s shutdown before normal cleanup and cancels the fallback on quit",
    (platform) => {
      installSystemShutdown(platform);
      expect(electron.powerMonitor.on).toHaveBeenCalledWith("shutdown", expect.any(Function));
      const preventDefault = vi.fn();
      electron.app.quit.mockImplementation(() => {
        expect(preventDefault).toHaveBeenCalledOnce();
        electron.didQuit?.();
      });

      electron.shutdown?.({ preventDefault });

      expect(electron.app.quit).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(electron.app.exit).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("system shutdown requested; quitting app");
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );

  it("exits after three seconds when a cleanup barrier stalls", () => {
    installSystemShutdown("linux");
    electron.shutdown?.({ preventDefault: vi.fn() });

    vi.advanceTimersByTime(2_999);
    expect(electron.app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(electron.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.warn).toHaveBeenCalledWith("system shutdown:", expect.stringContaining("3000 ms"));
  });

  it("retains the delay on repeated notifications without restarting quit or its deadline", () => {
    installSystemShutdown("linux");
    const preventDefault = vi.fn();
    electron.shutdown?.({ preventDefault });
    vi.advanceTimersByTime(2_000);
    electron.shutdown?.({ preventDefault });
    vi.advanceTimersByTime(1_000);

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it("cancels the fallback when an asynchronous cleanup completes before the deadline", () => {
    installSystemShutdown("linux");
    electron.shutdown?.({ preventDefault: vi.fn() });
    vi.advanceTimersByTime(2_999);
    electron.didQuit?.();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(electron.app.exit).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts Electron versions or synthetic notifications that omit the event", () => {
    installSystemShutdown("linux");
    electron.shutdown?.();
    expect(electron.app.quit).toHaveBeenCalledOnce();
    electron.didQuit?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not register the Linux/macOS notification on Windows", () => {
    installSystemShutdown("win32");
    expect(electron.powerMonitor.on).not.toHaveBeenCalled();
    expect(electron.app.on).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors macOS Sizzle cancellation after waiting for the user, and permits a later shutdown", async () => {
    const { model, send, dispose } = setupSizzleQuit(101);
    try {
      installSystemShutdown("darwin");
      const preventDefault = vi.fn();
      electron.shutdown?.({ preventDefault });
      expect(send).toHaveBeenLastCalledWith(expect.any(String), { requestId: 1 });

      // Saving and the discard confirmation can legitimately take over 3 s.
      vi.advanceTimersByTime(10_000);
      expect(electron.app.exit).not.toHaveBeenCalled();
      expect(model.hasQuit).toBe(false);

      expect(completeSizzleCloseRequest(101, 1, "cancel")).toBe(true);
      vi.advanceTimersByTime(30_000);
      expect(electron.app.exit).not.toHaveBeenCalled();
      expect(model.hasQuit).toBe(false);
      expect(logger.warn).not.toHaveBeenCalled();

      electron.shutdown?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(electron.app.quit).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith(expect.any(String), { requestId: 2 });
      expect(completeSizzleCloseRequest(101, 2, "close")).toBe(true);
      await model.settle();
      expect(model.hasQuit).toBe(true);
      expect(electron.app.exit).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("ignores stale cancellations and repeated macOS notifications while Sizzle saves", async () => {
    const { model, send, dispose } = setupSizzleQuit(102);
    try {
      installSystemShutdown("darwin");
      const preventDefault = vi.fn();
      electron.shutdown?.({ preventDefault });
      expect(completeSizzleCloseRequest(102, 999, "cancel")).toBe(false);
      electron.shutdown?.({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(2);
      expect(electron.app.quit).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(10_000);
      expect(electron.app.exit).not.toHaveBeenCalled();
      expect(completeSizzleCloseRequest(102, 1, "close")).toBe(true);
      await model.settle();
      expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
      expect(electron.app.exit).not.toHaveBeenCalled();
    } finally {
      await dispose();
    }
  });

  it("lets the existing diagnostics barrier flush and retry through Electron's quit sequence", async () => {
    const model = new ElectronQuitModel(["library"]);
    const stop = vi.fn(async () => undefined);
    const shutdown = createDiagnosticsShutdown({
      stop,
      resumeQuit: model.quit,
      warn: logger.warn,
      hasPendingWork: () => true
    });
    model.on("before-quit", (event) => shutdown.beforeQuit(event));
    electron.app.quit.mockImplementation(model.quit);
    electron.app.on.mockImplementation((event, listener) => model.on(event, listener));
    installSystemShutdown("linux");

    electron.shutdown?.({ preventDefault: vi.fn() });
    await model.settle();

    expect(stop).toHaveBeenCalledOnce();
    expect(model.emitted.filter((event) => event === "before-quit")).toHaveLength(2);
    expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
    expect(model.hasQuit).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(electron.app.exit).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("arms the production shutdown listener immediately after app-ready", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(source).toMatch(/app\.whenReady\(\)\.then\(async \(\) => \{\s*installSystemShutdown\(\);/);
  });
});
