import { describe, expect, it, vi } from "vitest";

import { createDiagnosticsShutdown } from "../diagnostics/diagnostics-shutdown";
import { retryQuitAfterDispatch } from "../quit-retry";
import { installQuitStallRecovery } from "../quit-stall-recovery";
import { ElectronQuitModel } from "./electron-quit-model";

/** Defer the first quit at `stage`, then retry it the way `retry` says. */
function deferOnce(
  model: ElectronQuitModel,
  stage: "before-quit" | "will-quit",
  retry: "microtask" | "after-dispatch"
): void {
  let deferred = false;
  model.on(stage, (event) => {
    if (deferred) return;
    deferred = true;
    event.preventDefault();
    if (retry === "microtask") void Promise.resolve().then(model.quit);
    else void Promise.resolve().then(() => retryQuitAfterDispatch(model.quit));
  });
}

describe("Electron quit model (matches scripts/electron-quit-reentry-probe.mjs)", () => {
  it("loses a before-quit retry that settles in microtasks inside a native quit", async () => {
    const model = new ElectronQuitModel(["library"]);
    deferOnce(model, "before-quit", "microtask");
    await model.quitFromNativeTask();
    await model.settle();
    // The measured field signature: two passes, the Library closes, and
    // Electron reports window-all-closed instead of will-quit.
    expect(model.emitted).toEqual([
      "before-quit",
      "before-quit",
      "close:library",
      "closed:library",
      "window-all-closed"
    ]);
    expect(model.hasQuit).toBe(false);
  });

  it("does not lose the same retry when app.quit() came from JavaScript", async () => {
    const model = new ElectronQuitModel(["library"]);
    deferOnce(model, "before-quit", "microtask");
    model.quit();
    await model.settle();
    expect(model.hasQuit).toBe(true);
  });

  it("loses a will-quit retry that settles in microtasks, however the quit started", async () => {
    for (const start of ["native", "js"] as const) {
      const model = new ElectronQuitModel(["library"]);
      deferOnce(model, "will-quit", "microtask");
      if (start === "native") await model.quitFromNativeTask();
      else model.quit();
      await model.settle();
      expect(model.emitted.at(-1)).toBe("will-quit");
      expect(model.hasQuit).toBe(false);
    }
  });
});

describe("retryQuitAfterDispatch", () => {
  it.each(["before-quit", "will-quit"] as const)(
    "completes a native quit deferred at %s",
    async (stage) => {
      const model = new ElectronQuitModel(["library"]);
      deferOnce(model, stage, "after-dispatch");
      await model.quitFromNativeTask();
      await model.settle();
      expect(model.hasQuit).toBe(true);
      expect(model.emitted).not.toContain("window-all-closed");
    }
  );
});

describe("diagnostics shutdown under a native ⌘Q", () => {
  it("resumes a deferred quit that Electron then completes", async () => {
    const model = new ElectronQuitModel(["region selector", "library", "focus-sink", "tray"]);
    // Production wiring: resumeQuit is app.quit, and with no profiler
    // recording, stop() settles without touching I/O.
    const shutdown = createDiagnosticsShutdown({
      stop: async () => undefined,
      resumeQuit: model.quit,
      warn: vi.fn(),
      hasPendingWork: () => true
    });
    model.on("before-quit", (event) => {
      shutdown.beforeQuit(event);
    });

    await model.quitFromNativeTask();
    await model.settle();

    expect(model.emitted.filter((name) => name === "before-quit")).toHaveLength(2);
    expect(model.emitted).not.toContain("window-all-closed");
    expect(model.emitted.slice(-2)).toEqual(["will-quit", "quit"]);
  });

  it("does not defer at all when nothing is recording", async () => {
    const model = new ElectronQuitModel(["library"]);
    const stop = vi.fn(async () => undefined);
    const shutdown = createDiagnosticsShutdown({
      stop,
      resumeQuit: model.quit,
      warn: vi.fn(),
      hasPendingWork: () => false
    });
    model.on("before-quit", (event) => {
      expect(shutdown.beforeQuit(event)).toBe(false);
    });

    await model.quitFromNativeTask();
    await model.settle();

    expect(model.emitted).toEqual([
      "before-quit",
      "close:library",
      "closed:library",
      "will-quit",
      "quit"
    ]);
    // The targets still latch their shutting-down state.
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("installQuitStallRecovery", () => {
  function install(
    model: ElectronQuitModel,
    options: { exitAfterMs?: number; isFinalPass?: () => boolean } = {}
  ) {
    const warn = vi.fn();
    installQuitStallRecovery(model, {
      isFinalPass: options.isFinalPass ?? (() => true),
      hasWindows: () => model.windowCount > 0,
      log: { warn },
      ...(options.exitAfterMs !== undefined ? { exitAfterMs: options.exitAfterMs } : {})
    });
    return { warn };
  }

  it("re-asks when Electron drops the quit at window-all-closed", async () => {
    const model = new ElectronQuitModel(["library"]);
    // A regression of the root fix: the retry runs nested again. As in
    // index.ts, the deferring listener is registered before the recovery.
    let deferred = false;
    let deferredThisPass = false;
    model.on("before-quit", (event) => {
      deferredThisPass = !deferred;
      if (deferred) return;
      deferred = true;
      event.preventDefault();
      void Promise.resolve().then(model.quit);
    });
    const recovery = install(model, { isFinalPass: () => !deferredThisPass });

    await model.quitFromNativeTask();
    await model.settle();

    expect(model.emitted).toContain("window-all-closed");
    expect(model.hasQuit).toBe(true);
    expect(model.exitCode).toBeNull();
    expect(recovery.warn).toHaveBeenCalledOnce();
  });

  it("exits when a quit stalls with no window left and no event to react to", async () => {
    const model = new ElectronQuitModel(["library"]);
    const recovery = install(model, { exitAfterMs: 20 });
    deferOnce(model, "will-quit", "microtask");

    await model.quitFromNativeTask();
    await model.settle();
    expect(model.hasQuit).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(model.exitCode).toBe(0);
    expect(recovery.warn).toHaveBeenCalledWith(
      "quit stalled with no windows left; exiting",
      { waitedMs: 20 }
    );
  });

  it("stands down when a window refused to close and the user kept working", () => {
    vi.useFakeTimers();
    try {
      const listeners = new Map<string, () => void>();
      const app = {
        on: (event: string, listener: () => void) => listeners.set(event, listener),
        quit: vi.fn(),
        exit: vi.fn()
      };
      installQuitStallRecovery(app, {
        isFinalPass: () => true,
        hasWindows: () => true,
        log: { warn: vi.fn() },
        exitAfterMs: 1_000
      });
      listeners.get("before-quit")!();
      vi.advanceTimersByTime(1_000);
      // Later, the user closes the last window themselves.
      listeners.get("window-all-closed")!();
      vi.runAllTimers();
      expect(app.exit).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays out of a quit that completes", async () => {
    const model = new ElectronQuitModel(["library"]);
    const recovery = install(model, { exitAfterMs: 20 });
    await model.quitFromNativeTask();
    await model.settle();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(model.hasQuit).toBe(true);
    expect(model.exitCode).toBeNull();
    expect(recovery.warn).not.toHaveBeenCalled();
  });
});
