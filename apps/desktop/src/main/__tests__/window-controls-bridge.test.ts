// The Linux caption buttons are the only way to minimize, maximize or close a
// frameless Linux window from inside the app, so the two things that can go
// wrong silently are worth pinning: an action arriving over IPC that is not
// one of ours, and a glyph that stops following the window.

import { describe, expect, test, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() }
}));

import {
  applyWindowControl,
  trackWindowFrameState,
  windowFrameState,
  type ControllableWindow,
  type ObservableWindow
} from "../window-controls-bridge";

function controllable(overrides: Partial<ControllableWindow> = {}): {
  window: ControllableWindow;
  calls: string[];
} {
  const calls: string[] = [];
  const window: ControllableWindow = {
    isDestroyed: () => false,
    isMaximized: () => false,
    minimize: () => void calls.push("minimize"),
    maximize: () => void calls.push("maximize"),
    unmaximize: () => void calls.push("unmaximize"),
    close: () => void calls.push("close"),
    ...overrides
  } as ControllableWindow;
  return { window, calls };
}

describe("applyWindowControl", () => {
  test("runs the three actions the buttons send", () => {
    const min = controllable();
    applyWindowControl(min.window, "minimize");
    expect(min.calls).toEqual(["minimize"]);

    const close = controllable();
    applyWindowControl(close.window, "close");
    expect(close.calls).toEqual(["close"]);
  });

  test("toggle-maximize reads the window, not the last click", () => {
    const restored = controllable({ isMaximized: () => false });
    applyWindowControl(restored.window, "toggle-maximize");
    expect(restored.calls).toEqual(["maximize"]);

    const maximized = controllable({ isMaximized: () => true });
    applyWindowControl(maximized.window, "toggle-maximize");
    expect(maximized.calls).toEqual(["unmaximize"]);
  });

  test("an unrecognized action does nothing at all", () => {
    // This arrives over IPC. `close()` must not be reachable by falling
    // through a switch, so the default arm is a return, not the last case.
    for (const action of [undefined, null, "quit", "CLOSE", 0, {}, ["close"]]) {
      const { window, calls } = controllable();
      applyWindowControl(window, action);
      expect(calls, JSON.stringify(action)).toEqual([]);
    }
  });

  test("a destroyed window is never touched", () => {
    const { window, calls } = controllable({ isDestroyed: () => true });
    applyWindowControl(window, "close");
    expect(calls).toEqual([]);
  });
});

describe("windowFrameState", () => {
  test("reports the window's own maximize state", () => {
    expect(windowFrameState({ isDestroyed: () => false, isMaximized: () => true })).toEqual({
      maximized: true
    });
  });

  test("answers null for a destroyed window rather than guessing", () => {
    expect(windowFrameState({ isDestroyed: () => true, isMaximized: () => true })).toBeNull();
  });
});

describe("trackWindowFrameState", () => {
  function observable(maximized: () => boolean, destroyed = (): boolean => false) {
    const handlers = new Map<string, () => void>();
    const sent: Array<[string, unknown]> = [];
    const window = {
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
        return window;
      },
      isDestroyed: destroyed,
      isMaximized: maximized,
      webContents: { send: (channel: string, payload: unknown) => void sent.push([channel, payload]) }
    } as unknown as ObservableWindow;
    return { window, handlers, sent };
  }

  test("pushes on the window's own maximize and unmaximize", () => {
    // The WM maximizes windows without going through our buttons — a
    // double-click on the drag region, Super+Up, a tiling keybind — so these
    // two events are the only honest account of what the glyph should draw.
    let maximized = false;
    const { window, handlers, sent } = observable(() => maximized);
    trackWindowFrameState(window);
    expect([...handlers.keys()].sort()).toEqual(["maximize", "unmaximize"]);

    maximized = true;
    handlers.get("maximize")?.();
    maximized = false;
    handlers.get("unmaximize")?.();

    expect(sent.map(([, payload]) => payload)).toEqual([{ maximized: true }, { maximized: false }]);
    // Per-window, never a broadcast: two windows can disagree about this.
    expect(new Set(sent.map(([channel]) => channel))).toEqual(
      new Set(["events:window:frame-state"])
    );
  });

  test("does not send into a destroyed window", () => {
    const { window, handlers, sent } = observable(() => true, () => true);
    trackWindowFrameState(window);
    handlers.get("maximize")?.();
    expect(sent).toEqual([]);
  });
});
