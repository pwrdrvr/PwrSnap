// The recording-controller HUD is a non-activating panel, so its
// renderer cannot reliably receive plain keydown events. Esc during
// the video lead-in is bridged through Electron's globalShortcut and
// then routed through the normal recording:cancel command.

import { beforeEach, describe, expect, test, vi } from "vitest";

type ShortcutCallback = () => void;

const mocks = vi.hoisted(() => ({
  shortcutCallbacks: new Map<string, ShortcutCallback>(),
  registerShortcut: vi.fn((accelerator: string, callback: ShortcutCallback) => {
    mocks.shortcutCallbacks.set(accelerator, callback);
    return true;
  }),
  unregisterShortcut: vi.fn((accelerator: string) => {
    mocks.shortcutCallbacks.delete(accelerator);
  }),
  dispatch: vi.fn(async () => ({ ok: true, value: undefined })),
  showMessageBox: vi.fn(async () => ({ response: 1 })),
  ipcListeners: new Map<string, (...args: unknown[]) => void>(),
  overlappingWindows: [] as WindowSpy[],
  createdWindows: [] as WindowSpy[],
  currentState: { phase: "idle" } as Record<string, unknown>
}));
const originalPlatform = process.platform;

type WindowSpy = {
  isDestroyed: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setFocusable: ReturnType<typeof vi.fn>;
  setMinimumSize: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  getContentSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  listeners: Map<string, (...args: unknown[]) => void>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    listeners: Map<string, (...args: unknown[]) => void>;
    zoomFactor: number;
    getOSProcessId: ReturnType<typeof vi.fn>;
  };
};

function makeWindowSpy(): WindowSpy {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  return {
    isDestroyed: vi.fn(() => false),
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    setMinimumSize: vi.fn(),
    setContentSize: vi.fn(),
    getContentSize: vi.fn(() => [420, 80]),
    setPosition: vi.fn(),
    getSize: vi.fn(() => [420, 80]),
    isVisible: vi.fn(() => false),
    showInactive: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    moveTop: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    listeners,
    webContents: {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.set(event, listener);
      }),
      listeners: webContentsListeners,
      zoomFactor: 1,
      getOSProcessId: vi.fn(() => 4242)
    }
  };
}

vi.mock("electron", () => ({
  BrowserWindow: {},
  dialog: {
    showMessageBox: mocks.showMessageBox
  },
  globalShortcut: {
    register: mocks.registerShortcut,
    unregister: mocks.unregisterShortcut
  },
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      mocks.ipcListeners.set(channel, listener);
    }),
    removeListener: vi.fn((channel: string) => {
      mocks.ipcListeners.delete(channel);
    })
  },
  screen: {
    getAllDisplays: () => [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 875 }
      }
    ],
    getPrimaryDisplay: () => ({
      id: 1,
      bounds: { x: 0, y: 0, width: 1440, height: 900 },
      workArea: { x: 0, y: 0, width: 1440, height: 875 }
    })
  }
}));

vi.mock("../../command-bus", () => ({
  bus: {
    dispatch: mocks.dispatch
  }
}));

vi.mock("../../capture/rect-overlap", () => ({
  appWindowsOverlappingRect: () => mocks.overlappingWindows
}));

vi.mock("../../window", () => ({
  createRecordingControllerWindow: () => {
    const win = makeWindowSpy();
    mocks.createdWindows.push(win);
    return win;
  }
}));

vi.mock("../recording-state", () => ({
  getRecordingState: () => mocks.currentState,
  subscribeToRecordingState: vi.fn(() => vi.fn())
}));

vi.mock("../../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  vi.resetModules();
  mocks.shortcutCallbacks.clear();
  mocks.registerShortcut.mockClear();
  mocks.unregisterShortcut.mockClear();
  mocks.dispatch.mockClear();
  mocks.showMessageBox.mockReset();
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.ipcListeners.clear();
  mocks.overlappingWindows.length = 0;
  mocks.createdWindows.length = 0;
  mocks.currentState = { phase: "idle" };
});

describe("recording-controller lead-in Escape shortcut", () => {
  test("Escape during countdown dispatches recording:cancel through the command bus", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 3,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });

    expect(mocks.registerShortcut).toHaveBeenCalledWith("Escape", expect.any(Function));
    mocks.shortcutCallbacks.get("Escape")?.();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:cancel",
      {},
      { principal: "ipc" }
    );
  });

  test("leaving lead-in unregisters Escape so recording controls do not hijack the key", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 1,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });
    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });

    expect(mocks.unregisterShortcut).toHaveBeenCalledWith("Escape");
    expect(mocks.shortcutCallbacks.has("Escape")).toBe(false);
  });

  test("the Settings recorder lease releases and restores an active lead-in Escape owner", async () => {
    const [{ applyRecordingStateToController }, { hotkeyRecorderSuspension }] =
      await Promise.all([
        import("../recording-controller"),
        import("../../hotkeys/hotkey-recorder-suspension-instance")
      ]);
    hotkeyRecorderSuspension.configureOwnership({
      registrationManager: null,
      withSerializedSettings: async (operation) => operation({} as never)
    });

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 3,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });
    const originalCallback = mocks.shortcutCallbacks.get("Escape");
    expect(originalCallback).toBeTypeOf("function");

    const lease = await hotkeyRecorderSuspension.begin(
      "settings_session_1",
      1,
      41,
      "documentepoch0001"
    );
    expect(lease.accepted).toBe(true);
    expect(mocks.unregisterShortcut).toHaveBeenCalledWith("Escape");
    expect(mocks.shortcutCallbacks.has("Escape")).toBe(false);
    originalCallback?.();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await expect(
      hotkeyRecorderSuspension.end(
        "settings_session_1",
        1,
        41,
        "documentepoch0001"
      )
    ).resolves.toBe(true);
    expect(mocks.shortcutCallbacks.get("Escape")).toBeTypeOf("function");
    mocks.shortcutCallbacks.get("Escape")?.();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:cancel",
      {},
      { principal: "ipc" }
    );
  });

  test("does not unregister Escape when Electron never granted ownership", async () => {
    mocks.registerShortcut.mockReturnValueOnce(false);
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 1,
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });
    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 10, y: 20, w: 800, h: 600 },
      displayId: 1
    });

    expect(mocks.unregisterShortcut).not.toHaveBeenCalled();
  });

  test("full-display Windows recordings keep the HUD at the normal tray-stop position", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { applyRecordingStateToController } = await import("../recording-controller");

    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 0, y: 0, w: 0, h: 0 },
      displayId: 1
    });

    const win = mocks.createdWindows[0];
    expect(win?.setPosition).toHaveBeenCalledWith(510, 16, false);
  });

  test("failed state remains visible, interactive, and cannot be closed without dismissal", async () => {
    const { applyRecordingStateToController } = await import("../recording-controller");
    const failure = {
      phase: "failed" as const,
      sessionId: "failed-1",
      code: "recorder_exited" as const,
      canRetry: true,
      displayId: 1
    };
    mocks.currentState = failure;

    applyRecordingStateToController(failure);

    const win = mocks.createdWindows[0]!;
    expect(win.setContentSize).toHaveBeenCalledWith(480, 176, false);
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(false);
    expect(win.setFocusable).toHaveBeenCalledWith(true);
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();

    const closeEvent = { preventDefault: vi.fn() };
    win.listeners.get("close")?.(closeEvent);
    expect(closeEvent.preventDefault).toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  test("a crashed failed renderer is recreated only while the failure is still live", async () => {
    vi.useFakeTimers();
    const { applyRecordingStateToController } = await import("../recording-controller");
    const failure = {
      phase: "failed" as const,
      sessionId: "failed-1",
      code: "recorder_exited" as const,
      canRetry: true,
      displayId: 1
    };
    mocks.currentState = failure;
    applyRecordingStateToController(failure);

    const crashed = mocks.createdWindows[0]!;
    crashed.webContents.listeners.get("render-process-gone")?.();
    expect(crashed.destroy).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.createdWindows).toHaveLength(2);
    expect(mocks.createdWindows[1]!.show).toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("persistent failed-renderer crashes stop recreating and expose native dismissal", async () => {
    vi.useFakeTimers();
    const { applyRecordingStateToController } = await import("../recording-controller");
    const failure = {
      phase: "failed" as const,
      sessionId: "failed-loop",
      code: "recorder_exited" as const,
      canRetry: true,
      displayId: 1
    };
    mocks.currentState = failure;
    applyRecordingStateToController(failure);

    mocks.createdWindows[0]!.webContents.listeners.get("render-process-gone")?.();
    await vi.advanceTimersByTimeAsync(100);
    mocks.createdWindows[1]!.webContents.listeners.get("render-process-gone")?.();
    await vi.advanceTimersByTimeAsync(500);
    mocks.createdWindows[2]!.webContents.listeners.get("render-process-gone")?.();
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(mocks.createdWindows).toHaveLength(3);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:dismissFailure",
      { sessionId: "failed-loop" },
      { principal: "ipc" }
    );
    vi.useRealTimers();
  });

  test("a failed renderer is not recreated after dismissal wins the crash race", async () => {
    vi.useFakeTimers();
    const { applyRecordingStateToController } = await import("../recording-controller");
    const failure = {
      phase: "failed" as const,
      sessionId: "failed-1",
      code: "recorder_exited" as const,
      canRetry: true,
      displayId: 1
    };
    mocks.currentState = failure;
    applyRecordingStateToController(failure);
    mocks.createdWindows[0]!.webContents.listeners.get("render-process-gone")?.();

    mocks.currentState = { phase: "idle" };
    await vi.advanceTimersByTimeAsync(100);

    expect(mocks.createdWindows).toHaveLength(1);
    vi.useRealTimers();
  });

  test("failed HUD resize requests convert CSS size through page zoom and validate sender", async () => {
    const {
      applyRecordingStateToController,
      installRecordingController
    } = await import("../recording-controller");
    installRecordingController();
    const failure = {
      phase: "failed" as const,
      sessionId: "failed-zoom",
      code: "recorder_exited" as const,
      canRetry: true,
      displayId: 1
    };
    mocks.currentState = failure;
    applyRecordingStateToController(failure);
    const win = mocks.createdWindows[0]!;
    win.webContents.zoomFactor = 2;
    win.setContentSize.mockClear();

    const resize = mocks.ipcListeners.get("recording-controller:resize")!;
    resize({ sender: {} }, { height: 190 });
    expect(win.setContentSize).not.toHaveBeenCalled();

    resize({ sender: win.webContents }, { height: 190 });
    expect(win.setMinimumSize).toHaveBeenCalledWith(0, 0);
    expect(win.setContentSize).toHaveBeenCalledWith(480, 380, false);
  });

  test("stopping and processing preserve the Windows safe HUD position", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { applyRecordingStateToController } = await import("../recording-controller");
    applyRecordingStateToController({
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(0).toISOString(),
      rect: { x: 100, y: 100, w: 400, h: 300 },
      displayId: 1
    });
    const win = mocks.createdWindows[0]!;
    win.setPosition.mockClear();

    applyRecordingStateToController({ phase: "stopping", sessionId: "rec-1" });
    applyRecordingStateToController({ phase: "processing", sessionId: "rec-1" });

    expect(win.setPosition).not.toHaveBeenCalled();
  });
});
