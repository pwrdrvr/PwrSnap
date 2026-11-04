// No native windows: fake timers and deferred dialog/command completions
// exercise ownership across renderer loss, session replacement and disposal.
// Destroy emits closed synchronously, matching Electron's window teardown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingState } from "@pwrsnap/shared";

const mocks = vi.hoisted(() => {
  function createWindow() {
    let destroyed = false;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const rendererListeners = new Map<string, () => void>();
    return {
      listeners,
      isDestroyed: () => destroyed,
      destroy: vi.fn(() => {
        if (destroyed) return;
        destroyed = true;
        listeners.get("closed")?.();
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)),
      setFocusable: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setMinimumSize: vi.fn(),
      setContentSize: vi.fn(),
      setPosition: vi.fn(),
      hide: vi.fn(),
      showInactive: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      moveTop: vi.fn(),
      getContentSize: () => [420, 80],
      getSize: () => [420, 80],
      isVisible: () => false,
      webContents: {
        listeners: rendererListeners,
        on: vi.fn((event: string, listener: () => void) => rendererListeners.set(event, listener)),
        isDestroyed: () => destroyed,
        send: vi.fn(),
        zoomFactor: 1
      }
    };
  }
  return {
    createWindow,
    windows: [] as ReturnType<typeof createWindow>[],
    state: { phase: "idle" } as RecordingState,
    dispatch: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
    showMessageBox: vi.fn(async () => ({ response: 1 })),
    resize: new Map<string, (...args: unknown[]) => void>(),
    subscribe: vi.fn(() => vi.fn()),
    register: vi.fn(() => true),
    unregister: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: { dock: { isVisible: () => true } },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: { showMessageBox: mocks.showMessageBox },
  globalShortcut: { register: mocks.register, unregister: mocks.unregister },
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => mocks.resize.set(channel, listener),
    removeListener: (channel: string) => mocks.resize.delete(channel)
  },
  screen: {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 875 } }],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1440, height: 875 } })
  }
}));
vi.mock("../../window", () => ({
  createRecordingControllerWindow: () => {
    const window = mocks.createWindow();
    mocks.windows.push(window);
    return window;
  }
}));
vi.mock("../recording-state", () => ({
  getRecordingState: () => mocks.state,
  subscribeToRecordingState: mocks.subscribe
}));
vi.mock("../../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));
vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingRect: () => [],
  displayLocalRectToGlobal: (rect: unknown) => rect
}));
vi.mock("../../log", () => ({
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}));
vi.mock("../../hotkeys/hotkey-recorder-suspension-instance", () => ({
  hotkeyRecorderSuspension: { registerParticipant: vi.fn() }
}));

type Controller = typeof import("../recording-controller");
let controller: Controller;
const recording = (sessionId = "take_1"): RecordingState => ({
  phase: "recording",
  sessionId,
  startedAt: new Date(0).toISOString(),
  rect: { x: 10, y: 20, w: 800, h: 600 },
  displayId: 1,
  capabilities: { systemAudio: false, microphone: false }
});
const failure = (sessionId = "take_1"): RecordingState => ({
  phase: "failed",
  sessionId,
  code: "recorder_exited",
  canRetry: true,
  displayId: 1
});
function transition(state: RecordingState): void {
  mocks.state = state;
  controller.applyRecordingStateToController(state);
}
function currentWindow() {
  return mocks.windows.at(-1)!;
}
function crash(): void {
  currentWindow().webContents.listeners.get("render-process-gone")!();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function exhaustFailure(sessionId = "take_1"): Promise<void> {
  transition(failure(sessionId));
  crash();
  await vi.advanceTimersByTimeAsync(100);
  crash();
  await vi.advanceTimersByTimeAsync(500);
  crash();
}

describe("recording controller lifecycle ownership", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.resize.clear();
    mocks.state = { phase: "idle" };
    mocks.dispatch.mockResolvedValue({ ok: true });
    mocks.showMessageBox.mockReset();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    controller = await import("../recording-controller");
    controller.installRecordingController();
  });
  afterEach(() => {
    controller.disposeRecordingController();
    vi.useRealTimers();
  });

  it("closes the confirmation gate during renderer reload and reopens it after load", () => {
    transition(recording());
    const win = currentWindow();
    win.webContents.listeners.get("did-finish-load")!();
    expect(controller.canRecordingControllerConfirmDiscard()).toBe(true);
    win.webContents.listeners.get("did-start-loading")?.();
    expect(controller.requestRecordingDiscardConfirmation("restart")).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalled();
    win.webContents.listeners.get("did-finish-load")!();
    expect(controller.requestRecordingDiscardConfirmation("restart")).toBe(true);
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.setFocusable).not.toHaveBeenCalledWith(true);
  });

  it("allows three normal crash retries, then leaves the HUD down through state broadcasts", async () => {
    transition(recording());
    for (let attempt = 0; attempt < 3; attempt++) {
      crash();
      expect(controller.canRecordingControllerConfirmDiscard()).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.windows).toHaveLength(attempt + 2);
    }
    crash();
    await vi.advanceTimersByTimeAsync(10_000);
    transition(recording());
    transition({ phase: "stopping", sessionId: "take_1" });
    transition({ phase: "processing", sessionId: "take_1" });
    expect(mocks.windows).toHaveLength(4);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("gives a replacement session its own normal recovery budget", async () => {
    transition(recording());
    for (let attempt = 0; attempt < 4; attempt++) {
      crash();
      await vi.advanceTimersByTimeAsync(100);
    }
    transition(recording("take_2"));
    crash();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.windows).toHaveLength(6);
  });

  it("keeps a normal retry's delay through state broadcasts, but admits a new session", async () => {
    transition(recording());
    crash();
    transition(recording());
    expect(mocks.windows).toHaveLength(1);
    transition(recording("take_2"));
    expect(mocks.windows).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.windows).toHaveLength(2);
    expect(currentWindow().setContentSize).toHaveBeenCalledTimes(1);
  });

  it("cancels normal recreation on a terminal transition and ignores duplicate crash events", async () => {
    transition(recording());
    const old = currentWindow();
    crash();
    old.webContents.listeners.get("render-process-gone")!();
    expect(old.destroy).toHaveBeenCalledTimes(1);
    transition({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.windows).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a retired HUD's resize, close, load and crash callbacks", async () => {
    transition(recording());
    const old = currentWindow();
    crash();
    await vi.advanceTimersByTimeAsync(100);
    const replacement = currentWindow();
    old.webContents.listeners.get("did-finish-load")!();
    old.webContents.listeners.get("render-process-gone")!();
    mocks.resize.get("recording-controller:resize")!({ sender: old.webContents }, { width: 500, height: 120 });
    old.listeners.get("close")!({ preventDefault: vi.fn() });
    expect(controller.canRecordingControllerConfirmDiscard()).toBe(false);
    expect(replacement.setContentSize).toHaveBeenCalledTimes(1);
    expect(replacement.focus).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.windows).toHaveLength(2);
  });

  it("disposes twice without leaving recovery work or touching a replacement window", async () => {
    transition(recording());
    const old = currentWindow();
    crash();
    controller.disposeRecordingController();
    controller.disposeRecordingController();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.subscribe.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    controller.installRecordingController();
    transition(recording("take_2"));
    old.listeners.get("closed")!();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.windows).toHaveLength(2);
    expect(currentWindow().isDestroyed()).toBe(false);
    expect(old.destroy).toHaveBeenCalledTimes(1);
  });

  it("coalesces countdown close cancellation while the command is pending", async () => {
    const cancel = deferred<{ ok: boolean }>();
    mocks.dispatch.mockReturnValueOnce(cancel.promise);
    transition({ phase: "countdown", sessionId: "take_1", secondsRemaining: 3,
      displayId: 1, rect: { x: 10, y: 20, w: 800, h: 600 } });
    const close = currentWindow().listeners.get("close")!;
    close({ preventDefault: vi.fn() });
    close({ preventDefault: vi.fn() });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    cancel.resolve({ ok: true });
    await cancel.promise;
  });

  it("scopes a pending close cancellation to its window across disposal and replacement", async () => {
    const firstCancel = deferred<{ ok: boolean }>();
    const secondCancel = deferred<{ ok: boolean }>();
    mocks.dispatch.mockReturnValueOnce(firstCancel.promise).mockReturnValueOnce(secondCancel.promise);
    const countdown = { phase: "countdown" as const, sessionId: "take_1", secondsRemaining: 3,
      displayId: 1, rect: { x: 10, y: 20, w: 800, h: 600 } };
    transition(countdown);
    currentWindow().listeners.get("close")!({ preventDefault: vi.fn() });
    controller.disposeRecordingController();
    controller.installRecordingController();
    transition({ ...countdown, sessionId: "take_2" });
    const close = currentWindow().listeners.get("close")!;
    close({ preventDefault: vi.fn() });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    firstCancel.resolve({ ok: true });
    await firstCancel.promise;
    close({ preventDefault: vi.fn() });
    expect(mocks.dispatch).toHaveBeenCalledTimes(2);
    secondCancel.resolve({ ok: true });
    await secondCancel.promise;
  });

  it("does not let a disposed fallback's response dismiss a live failure", async () => {
    const response = deferred<{ response: number }>();
    mocks.showMessageBox.mockReturnValueOnce(response.promise);
    await exhaustFailure();
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    controller.disposeRecordingController();
    controller.disposeRecordingController();
    response.resolve({ response: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("hands off native fallback to a replacement failed session after an old dialog %s", async (completion) => {
    const response = deferred<{ response: number }>();
    mocks.showMessageBox.mockReturnValueOnce(response.promise);
    await exhaustFailure();
    await exhaustFailure("take_2");
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    if (completion === "resolve") response.resolve({ response: 1 });
    else response.reject(new Error("old native dialog failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenCalledExactlyOnceWith(
      "recording:dismissFailure", { sessionId: "take_2" }, { principal: "ipc" }
    );
  });

  it("does not clear a replacement failure's fallback when an old dismiss command finishes", async () => {
    const dismissal = deferred<{ ok: boolean }>();
    mocks.dispatch.mockReturnValueOnce(dismissal.promise);
    await exhaustFailure();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    await exhaustFailure("take_2");
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    dismissal.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenLastCalledWith(
      "recording:dismissFailure", { sessionId: "take_2" }, { principal: "ipc" }
    );
  });

  it("reveals logs and keeps the native fallback open until dismissal", async () => {
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    await exhaustFailure();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch.mock.calls).toEqual([
      ["renderer:revealLogFile", {}, { principal: "ipc" }],
      ["recording:dismissFailure", { sessionId: "take_1" }, { principal: "ipc" }]
    ]);
    expect(mocks.windows).toHaveLength(3);
  });

  it("contains native fallback rejection without an unbounded retry loop", async () => {
    mocks.showMessageBox.mockRejectedValueOnce(new Error("native failure"));
    await exhaustFailure();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
