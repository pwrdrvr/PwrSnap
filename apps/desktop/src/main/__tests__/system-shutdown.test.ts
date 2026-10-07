import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsShutdown } from "../diagnostics/diagnostics-shutdown";
import { installSystemShutdown } from "../system-shutdown";
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

afterEach(() => vi.useRealTimers());

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
