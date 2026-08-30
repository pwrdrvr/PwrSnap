import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings } from "@pwrsnap/shared";

type ClosedListener = () => void;

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];
  const appListeners = new Map<string, Set<() => void>>();
  let focusedWindow: object | null = null;

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
      register: vi.fn((_accelerator: string, _callback: () => void) => true),
      unregister: vi.fn()
    },
    dispatch: vi.fn(),
    app: {
      emit(event: string): void {
        for (const listener of appListeners.get(event) ?? []) listener();
      },
      on: vi.fn((event: string, listener: () => void) => {
        const listeners = appListeners.get(event) ?? new Set<() => void>();
        listeners.add(listener);
        appListeners.set(event, listeners);
      }),
      removeListener: vi.fn((event: string, listener: () => void) => {
        appListeners.get(event)?.delete(listener);
      })
    },
    browserWindow: Object.assign(vi.fn(), {
      getFocusedWindow: vi.fn(() => focusedWindow)
    }),
    setFocusedWindow(window: object | null): void {
      focusedWindow = window;
    },
    ipcMain: {
      on: vi.fn(),
      removeAllListeners: vi.fn()
    },
    windows
  };
});

vi.mock("electron", () => ({
  app: mocks.app,
  BrowserWindow: mocks.browserWindow,
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
  bus: { dispatch: mocks.dispatch }
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}));

import {
  disposeFloatOver,
  getFloatOverWindowIdForE2E,
  getFloatOverState,
  setFloatOverState
} from "../float-over";
import { hotkeyRecorderSuspension } from "../hotkeys/hotkey-recorder-suspension-instance";

describe("disposeFloatOver", () => {
  async function flushShortcutLookup(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    disposeFloatOver();
    mocks.createFloatOverWindow.mockClear();
    mocks.globalShortcut.register.mockReset();
    mocks.globalShortcut.register.mockReturnValue(true);
    mocks.globalShortcut.unregister.mockClear();
    mocks.dispatch.mockReset();
    mocks.dispatch.mockImplementation(async (name: string, request: { id?: string }) => {
      if (name === "library:byId") {
        return { ok: true, value: { id: request.id, kind: "image" } };
      }
      return { ok: true, value: undefined };
    });
    await hotkeyRecorderSuspension.dispose();
    hotkeyRecorderSuspension.configureOwnership({
      registrationManager: null,
      withSerializedSettings: async <T,>(operation: (settings: Settings) => T | Promise<T>) =>
        operation({} as Settings)
    });
    mocks.setFocusedWindow(null);
    mocks.ipcMain.on.mockClear();
    mocks.ipcMain.removeAllListeners.mockClear();
    mocks.windows.length = 0;
  });

  afterEach(async () => {
    disposeFloatOver();
    await hotkeyRecorderSuspension.dispose();
    vi.useRealTimers();
  });

  it("disarms shortcuts, destroys the singleton, clears delayed work, and resets state", async () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_1" });
    await flushShortcutLookup();
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

  it("unregisters only copy shortcuts this float-over successfully owns", async () => {
    mocks.globalShortcut.register.mockImplementation((accelerator: string) =>
      accelerator !== "CommandOrControl+1"
    );

    setFloatOverState({ kind: "show-loaded", captureId: "cap_collision" });
    await flushShortcutLookup();
    disposeFloatOver();

    // Ctrl/Cmd+1 may already be a persistent user binding. A failed
    // transient register must never unregister that other owner on dismiss.
    expect(mocks.globalShortcut.unregister.mock.calls.map(([accelerator]) => accelerator)).toEqual([
      "CommandOrControl+2",
      "CommandOrControl+3"
    ]);
  });

  it("releases and restores transient copy shortcuts around recording", async () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_guarded" });
    await flushShortcutLookup();
    const lowCallback = mocks.globalShortcut.register.mock.calls.find(
      ([accelerator]) => accelerator === "CommandOrControl+1"
    )?.[1] as (() => void) | undefined;
    expect(lowCallback).toBeTypeOf("function");
    mocks.dispatch.mockClear();
    mocks.globalShortcut.register.mockClear();
    mocks.globalShortcut.unregister.mockClear();

    await hotkeyRecorderSuspension.begin(
      "settings_recorder",
      1,
      41,
      "documentepoch0001"
    );
    expect(mocks.globalShortcut.unregister).toHaveBeenCalledTimes(3);
    expect(mocks.globalShortcut.register).not.toHaveBeenCalled();
    lowCallback?.();
    expect(mocks.dispatch).not.toHaveBeenCalled();

    await hotkeyRecorderSuspension.end(
      "settings_recorder",
      1,
      41,
      "documentepoch0001"
    );
    await flushShortcutLookup();
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(3);
    const restoredLowCallback = mocks.globalShortcut.register.mock.calls.find(
      ([accelerator]) => accelerator === "CommandOrControl+1"
    )?.[1] as (() => void) | undefined;
    restoredLowCallback?.();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "clipboard:copy",
      { captureId: "cap_guarded", preset: "low" },
      { principal: "ipc" }
    );
  });

  it("routes a video shortcut to the renderer that owns the live trim range", async () => {
    mocks.dispatch.mockImplementation(async (name: string, request: { id?: string }) => {
      if (name === "library:byId") {
        return { ok: true, value: { id: request.id, kind: "video" } };
      }
      return { ok: true, value: undefined };
    });

    setFloatOverState({ kind: "show-loaded", captureId: "cap_video" });
    await flushShortcutLookup();

    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(6);
    const mediumMp4Callback = mocks.globalShortcut.register.mock.calls.find(
      ([accelerator]) => accelerator === "CommandOrControl+5"
    )?.[1] as (() => void) | undefined;
    expect(mediumMp4Callback).toBeTypeOf("function");

    mocks.dispatch.mockClear();
    const window = mocks.windows[0]!;
    window.webContents.send.mockClear();
    mediumMp4Callback?.();

    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledTimes(1);
    expect(window.webContents.send).toHaveBeenCalledWith(
      "events:float-over:video-copy-shortcut",
      { captureId: "cap_video", format: "mp4", preset: "med" }
    );
  });

  it("retains numbered shortcuts while a PwrSnap window is focused", async () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_focus" });
    await flushShortcutLookup();
    expect(mocks.globalShortcut.register).toHaveBeenCalledTimes(3);

    mocks.setFocusedWindow({ id: 99 });
    const lowCallback = mocks.globalShortcut.register.mock.calls.find(
      ([accelerator]) => accelerator === "CommandOrControl+1"
    )?.[1] as (() => void) | undefined;
    mocks.dispatch.mockClear();
    lowCallback?.();

    expect(mocks.globalShortcut.unregister).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "clipboard:copy",
      { captureId: "cap_focus", preset: "low" },
      { principal: "ipc" }
    );
  });

  it("does not register shortcuts when a capture lookup resolves after dismissal", async () => {
    let resolveLookup: ((value: unknown) => void) | undefined;
    mocks.dispatch.mockImplementation((name: string) => {
      if (name !== "library:byId") return Promise.resolve({ ok: true, value: undefined });
      return new Promise((resolve) => {
        resolveLookup = resolve;
      });
    });

    setFloatOverState({ kind: "show-loaded", captureId: "cap_stale" });
    setFloatOverState({ kind: "dismiss" });
    resolveLookup?.({ ok: true, value: { id: "cap_stale", kind: "video" } });
    await flushShortcutLookup();

    expect(mocks.globalShortcut.register).not.toHaveBeenCalled();
  });
});
