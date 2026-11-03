import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiagnosticsShutdown } from "../diagnostics/diagnostics-shutdown";
import { retryQuitAfterDispatch } from "../quit-retry";
import { ElectronQuitModel } from "./electron-quit-model";

type State = { phase: string };

/**
 * Execute the production will-quit wiring with controlled recording effects.
 * Importing index.ts would bootstrap Electron and every capture subsystem.
 * Transpile its final registration block instead; no copy of the barrier or
 * its state machine lives in this test. Missing/moved wiring fails explicitly.
 */
function installProductionTeardown(dependencies: Record<string, unknown>): void {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const start = source.indexOf("  // Track whether we've already initiated the recording-cancel");
  const end = source.lastIndexOf("\n}\n\nbootstrapApp();");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const { outputText } = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None }
  });
  new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies));
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(phase: string, options: {
  model?: ElectronQuitModel;
  remainingMs?: number;
  subscribePhase?: string;
  diagnostics?: ReturnType<typeof createDiagnosticsShutdown>;
} = {}) {
  let state = { phase };
  const listeners = new Set<(next: State) => void>();
  const cancel = deferred();
  const cancelRecording = vi.fn(() => cancel.promise);
  const unsubscribe = vi.fn();
  const warn = vi.fn();
  let listener!: (event: { preventDefault(): void }) => void;
  const quit = vi.fn(options.model?.quit);
  const closeDatabase = vi.fn();
  const app = {
    quit,
    on: (event: string, callback: typeof listener) => {
      expect(event).toBe("will-quit");
      listener = callback;
      options.model?.on(event, callback);
    }
  };
  installProductionTeardown({
    app,
    isRecordingActive: () => !["idle", "ready", "failed"].includes(state.phase),
    getRecordingState: () => state,
    getRecordingService: () => ({ cancel: cancelRecording }),
    subscribeToRecordingState: (callback: (next: State) => void) => {
      listeners.add(callback);
      if (options.subscribePhase !== undefined) state = { phase: options.subscribePhase };
      callback(state);
      return () => { unsubscribe(); listeners.delete(callback); };
    },
    diagnosticsShutdown: options.diagnostics ?? { remainingQuitTime: () => options.remainingMs ?? 15_000 },
    retryQuitAfterDispatch,
    getMainLogger: () => ({ warn }),
    globalShortcut: { unregisterAll: vi.fn() },
    stopLibraryProcess: vi.fn(),
    disposeCodexProfileHandlers: vi.fn(),
    disposeTransientWindows: vi.fn(),
    disposeIpcDispatcher: vi.fn(),
    getToolRpcServer: () => ({ stop: async () => undefined }),
    closeAcpAgentPool: async () => undefined,
    closeCodexAgentPool: async () => undefined,
    disposeLocalAgentMcpSettingsListener: null,
    localAgentMcpLifecycle: null,
    localAgentConsentBroker: null,
    shutdownCompositeThumbnailWorker: vi.fn(),
    cancelScheduledRepacks: vi.fn(),
    closeDatabase
  });
  return {
    cancel, cancelRecording, quit, closeDatabase, warn, unsubscribe, listeners,
    willQuit() {
      const event = { preventDefault: vi.fn() };
      listener(event);
      return event;
    },
    setPhase(next: string) {
      state = { phase: next };
      for (const callback of listeners) callback(state);
    }
  };
}

afterEach(() => vi.useRealTimers());

describe("production recording quit barrier", () => {
  it.each(["preflight", "countdown", "starting", "recording"])(
    "cancels %s once and keeps teardown behind cancellation across repeated quits", async (phase) => {
      vi.useFakeTimers();
      const f = fixture(phase);
      expect(f.willQuit().preventDefault).toHaveBeenCalledOnce();
      // A second request must not overtake the first asynchronous cancel.
      expect(f.willQuit().preventDefault).toHaveBeenCalledOnce();
      expect(f.cancelRecording).toHaveBeenCalledOnce();
      expect(f.closeDatabase).not.toHaveBeenCalled();
      f.setPhase("idle");
      expect(f.willQuit().preventDefault).toHaveBeenCalledOnce();
      expect(f.closeDatabase).not.toHaveBeenCalled();
      f.cancel.resolve();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.quit).toHaveBeenCalledOnce();
      expect(f.willQuit().preventDefault).not.toHaveBeenCalled();
      expect(f.closeDatabase).toHaveBeenCalledOnce();
    }
  );

  it.each(["stopping", "processing"])(
    "waits for %s finalization across repeated quits without cancelling the take", async (phase) => {
      vi.useFakeTimers();
      const f = fixture(phase);
      expect(f.willQuit().preventDefault).toHaveBeenCalledOnce();
      expect(f.willQuit().preventDefault).toHaveBeenCalledOnce();
      expect(f.cancelRecording).not.toHaveBeenCalled();
      expect(f.closeDatabase).not.toHaveBeenCalled();
      f.setPhase("processing");
      expect(f.quit).not.toHaveBeenCalled();
      f.setPhase("ready");
      expect(f.listeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.quit).toHaveBeenCalledOnce();
      expect(f.willQuit().preventDefault).not.toHaveBeenCalled();
      expect(f.closeDatabase).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(["ready", "failed", "idle"])("releases finalization on %s", async (phase) => {
    vi.useFakeTimers();
    const f = fixture("processing");
    f.willQuit();
    f.setPhase(phase);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unsubscribes when finalization wins between the snapshot and subscription", async () => {
    vi.useFakeTimers();
    const f = fixture("processing", { subscribePhase: "ready" });
    f.willQuit();
    expect(f.listeners.size).toBe(0);
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.quit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the diagnostics deadline rather than adding fifteen seconds after its timeout", async () => {
    vi.useFakeTimers();
    const diagnostics = createDiagnosticsShutdown({
      stop: () => new Promise(() => {}), resumeQuit: vi.fn(), warn: vi.fn()
    });
    diagnostics.beforeQuit({ preventDefault: vi.fn() });
    await vi.advanceTimersByTimeAsync(10_000);
    const f = fixture("processing", { diagnostics });
    f.willQuit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(f.quit).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 5_000])("spends only the remaining %i ms and ignores late finalization", async (remainingMs) => {
    vi.useFakeTimers();
    const f = fixture("processing", { remainingMs });
    f.willQuit();
    if (remainingMs > 0) {
      await vi.advanceTimersByTimeAsync(remainingMs - 1);
      expect(f.quit).not.toHaveBeenCalled();
    }
    await vi.advanceTimersByTimeAsync(2);
    expect(f.quit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.listeners.size).toBe(0);
    f.setPhase("ready");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.quit).toHaveBeenCalledOnce();
    expect(f.willQuit().preventDefault).not.toHaveBeenCalled();
    expect(f.closeDatabase).toHaveBeenCalledOnce();
  });

  it("retries a rejected cancellation from a macrotask and continues teardown", async () => {
    vi.useFakeTimers();
    const f = fixture("recording");
    f.willQuit();
    f.cancel.reject(new Error("backend failed"));
    // Promise settlement may not reenter Electron's native will-quit emit.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(f.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.quit).toHaveBeenCalledOnce();
    expect(f.warn).toHaveBeenCalledWith("recording quit barrier failed", { message: "backend failed" });
    expect(f.willQuit().preventDefault).not.toHaveBeenCalled();
  });

  it.each(["native", "js"])("completes Electron's %s quit after diagnostics and immediate recording cancellation", async (origin) => {
    const model = new ElectronQuitModel(["library"]);
    const diagnostics = createDiagnosticsShutdown({
      stop: async () => undefined, resumeQuit: model.quit, warn: vi.fn(), hasPendingWork: () => true
    });
    model.on("before-quit", (event) => diagnostics.beforeQuit(event));
    const f = fixture("recording", { model });
    f.cancel.resolve();
    if (origin === "native") await model.quitFromNativeTask();
    else model.quit();
    await model.settle();
    expect(model.hasQuit).toBe(true);
    expect(model.emitted).not.toContain("window-all-closed");
    expect(f.cancelRecording).toHaveBeenCalledOnce();
    expect(f.closeDatabase).toHaveBeenCalledOnce();
  });
});
