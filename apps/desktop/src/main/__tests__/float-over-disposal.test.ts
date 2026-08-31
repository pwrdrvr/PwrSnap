import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ClosedListener = () => void;

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];

  function createWindow(id: number) {
    let destroyed = false;
    let closedListener: ClosedListener | null = null;
    return {
      id,
      destroy: vi.fn(() => {
        if (destroyed) return;
        destroyed = true;
        closedListener?.();
      }),
      getContentSize: vi.fn(() => [392, 200] as [number, number]),
      getSize: vi.fn(() => [392, 200] as [number, number]),
      hide: vi.fn(),
      isAlwaysOnTop: vi.fn(() => true),
      isDestroyed: vi.fn(() => destroyed),
      moveTop: vi.fn(),
      on: vi.fn((event: string, listener: ClosedListener) => {
        if (event === "closed") closedListener = listener;
      }),
      setAlwaysOnTop: vi.fn(),
      setContentSize: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      setPosition: vi.fn(),
      showInactive: vi.fn(),
      webContents: {
        getURL: vi.fn(() => "file:///renderer/index.html"),
        invalidate: vi.fn(),
        isDestroyed: vi.fn(() => destroyed),
        isLoadingMainFrame: vi.fn(() => false),
        once: vi.fn(),
        send: vi.fn(),
        zoomFactor: 1
      }
    };
  }

  return {
    createFloatOverWindow: vi.fn(() => {
      const window = createWindow(windows.length + 1);
      windows.push(window);
      return window;
    }),
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn()
    },
    ipcMain: {
      on: vi.fn(),
      removeAllListeners: vi.fn()
    },
    windows,
    recorderParticipant: null as {
      suspend(): void;
      restore(): void;
    } | null
  };
});

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  globalShortcut: mocks.globalShortcut,
  ipcMain: mocks.ipcMain,
  screen: {
    getAllDisplays: vi.fn(() => []),
    getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    }))
  }
}));

vi.mock("../window", () => ({
  createFloatOverWindow: mocks.createFloatOverWindow
}));

vi.mock("../command-bus", () => ({
  bus: { dispatch: vi.fn() }
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn() })
}));

vi.mock("../hotkeys/hotkey-recorder-suspension-instance", () => ({
  hotkeyRecorderSuspension: {
    registerParticipant: vi.fn((participant: {
      suspend(): void;
      restore(): void;
    }) => {
      mocks.recorderParticipant = participant;
      return vi.fn();
    })
  }
}));

import {
  disposeFloatOver,
  getFloatOverWindowIdForE2E,
  getFloatOverState,
  setFloatOverState
} from "../float-over";

describe("disposeFloatOver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disposeFloatOver();
    mocks.createFloatOverWindow.mockClear();
    mocks.globalShortcut.register.mockClear();
    mocks.globalShortcut.unregister.mockClear();
    mocks.ipcMain.on.mockClear();
    mocks.ipcMain.removeAllListeners.mockClear();
    mocks.windows.length = 0;
  });

  afterEach(() => {
    disposeFloatOver();
    vi.useRealTimers();
  });

  it("disarms shortcuts, destroys the singleton, clears delayed work, and resets state", () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_1" });
    const window = mocks.windows[0]!;

    expect(getFloatOverState()).toEqual({ kind: "loaded", captureId: "cap_1" });
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    disposeFloatOver();

    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.globalShortcut.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+1",
      "CommandOrControl+2",
      "CommandOrControl+3"
    ]);
    expect(mocks.ipcMain.removeAllListeners).toHaveBeenCalledWith("float-over:resize");
    expect(getFloatOverState()).toEqual({ kind: "hidden" });
    expect(vi.getTimerCount()).toBe(0);

    disposeFloatOver();
    expect(window.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledTimes(3);
    expect(mocks.ipcMain.removeAllListeners).toHaveBeenCalledTimes(1);
  });

  it("can create and wire a fresh singleton after disposal", () => {
    setFloatOverState({ kind: "show-idle" });
    const first = mocks.windows[0]!;
    expect(getFloatOverWindowIdForE2E()).toBe(1);
    disposeFloatOver();
    expect(getFloatOverWindowIdForE2E()).toBeNull();
    setFloatOverState({ kind: "show-idle" });

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.createFloatOverWindow).toHaveBeenCalledTimes(2);
    expect(mocks.ipcMain.on).toHaveBeenCalledTimes(2);
    expect(getFloatOverState()).toEqual({ kind: "idle" });
    expect(getFloatOverWindowIdForE2E()).toBe(2);
  });

  it("releases Float-Over copy ownership for recording and restores the loaded toast", () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_lease" });
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(3);

    mocks.recorderParticipant?.suspend();
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledTimes(3);

    mocks.recorderParticipant?.restore();
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(6);
  });
});
