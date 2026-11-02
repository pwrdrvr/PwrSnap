// The float-over renderer is created by the first capture of the session,
// so the first state event always exists before anything is listening for
// it. Main used to send it on a timer, 100ms after did-finish-load, and a
// send that landed mid-render could beat the subscribing effect: measured
// in the Linux E2E harness under CPU load, 2 of 30 first toasts stayed
// empty at 6x and 3 of 10 at 12x. The renderer now asks once it has
// subscribed, and main answers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STATE_CHANNEL = "events:float-over:state";
const REQUEST_CHANNEL = "float-over:request-state";

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];
  const ipcHandlers = new Map<string, (event: { sender: unknown }, payload?: unknown) => void>();

  function createWindow(id: number) {
    let destroyed = false;
    let closedListener: (() => void) | null = null;
    const webContentsListeners = new Map<string, () => void>();
    const webContents = {
      emit: (event: string) => webContentsListeners.get(event)?.(),
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn((event: string, listener: () => void) => {
        webContentsListeners.set(event, listener);
      }),
      send: vi.fn(),
      zoomFactor: 1
    };
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
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "closed") closedListener = listener;
      }),
      setAlwaysOnTop: vi.fn(),
      setContentSize: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      setPosition: vi.fn(),
      showInactive: vi.fn(),
      webContents
    };
  }

  return {
    createFloatOverWindow: vi.fn(() => {
      const window = createWindow(windows.length + 1);
      windows.push(window);
      return window;
    }),
    ipcHandlers,
    ipcMain: {
      on: vi.fn((channel: string, handler: (event: { sender: unknown }) => void) => {
        ipcHandlers.set(channel, handler);
      }),
      removeAllListeners: vi.fn((channel: string) => {
        ipcHandlers.delete(channel);
      })
    },
    windows
  };
});

vi.mock("electron", () => ({
  app: { on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getFocusedWindow: vi.fn(() => null) }),
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
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
  bus: {
    dispatch: vi.fn(async (_name: string, request: { id?: string }) => ({
      ok: true,
      value: { id: request.id, kind: "image" }
    }))
  }
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn() })
}));

import { disposeFloatOver, setFloatOverState } from "../float-over";

function stateSends(window: (typeof mocks.windows)[number]): unknown[] {
  return window.webContents.send.mock.calls
    .filter(([channel]) => channel === STATE_CHANNEL)
    .map(([, payload]) => payload);
}

function requestStateFrom(sender: unknown): void {
  const handler = mocks.ipcHandlers.get(REQUEST_CHANNEL);
  if (handler === undefined) throw new Error("state request channel is not wired");
  handler({ sender });
}

describe("float-over state delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    disposeFloatOver();
    mocks.windows.length = 0;
    mocks.createFloatOverWindow.mockClear();
  });

  afterEach(() => {
    disposeFloatOver();
    vi.useRealTimers();
  });

  it("holds the first event until the renderer asks, however long its first render takes", () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_first" });
    const window = mocks.windows[0]!;

    // Nothing may be sent on a guess. The old code sent 100ms after
    // did-finish-load, to a renderer that could still be rendering.
    vi.advanceTimersByTime(10_000);
    expect(stateSends(window)).toEqual([]);

    requestStateFrom(window.webContents);
    expect(stateSends(window)).toEqual([{ kind: "show-loaded", captureId: "cap_first" }]);
  });

  it("replies with the latest state, not every state raised before the renderer listened", () => {
    setFloatOverState({ kind: "show-idle" });
    setFloatOverState({ kind: "show-loaded", captureId: "cap_latest" });
    const window = mocks.windows[0]!;

    requestStateFrom(window.webContents);

    expect(stateSends(window)).toEqual([{ kind: "show-loaded", captureId: "cap_latest" }]);
  });

  it("sends every later event live, once each", () => {
    setFloatOverState({ kind: "show-idle" });
    const window = mocks.windows[0]!;
    requestStateFrom(window.webContents);

    setFloatOverState({ kind: "show-loaded", captureId: "cap_live" });
    setFloatOverState({ kind: "dismiss" });

    expect(stateSends(window)).toEqual([
      { kind: "show-idle" },
      { kind: "show-loaded", captureId: "cap_live" },
      { kind: "dismiss" }
    ]);
  });

  it("answers a reloaded renderer with the current state", () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_reload" });
    const window = mocks.windows[0]!;
    requestStateFrom(window.webContents);
    setFloatOverState({ kind: "dismiss" });
    window.webContents.send.mockClear();

    requestStateFrom(window.webContents);

    expect(stateSends(window)).toEqual([{ kind: "dismiss" }]);
  });

  it("holds live sends while a reloading renderer has not asked again", () => {
    setFloatOverState({ kind: "show-idle" });
    const window = mocks.windows[0]!;
    requestStateFrom(window.webContents);
    window.webContents.send.mockClear();

    window.webContents.emit("did-start-loading");
    setFloatOverState({ kind: "show-loaded", captureId: "cap_during_reload" });
    expect(stateSends(window)).toEqual([]);

    requestStateFrom(window.webContents);
    expect(stateSends(window)).toEqual([
      { kind: "show-loaded", captureId: "cap_during_reload" }
    ]);
  });

  it("ignores a request from any other webContents", () => {
    setFloatOverState({ kind: "show-loaded", captureId: "cap_owned" });
    const window = mocks.windows[0]!;

    requestStateFrom({ id: 999 });
    setFloatOverState({ kind: "show-loaded", captureId: "cap_still_held" });

    expect(stateSends(window)).toEqual([]);
  });

  it("starts a recreated window's renderer unsubscribed", () => {
    setFloatOverState({ kind: "show-idle" });
    const first = mocks.windows[0]!;
    requestStateFrom(first.webContents);
    disposeFloatOver();

    setFloatOverState({ kind: "show-loaded", captureId: "cap_second_window" });
    const second = mocks.windows[1]!;
    expect(stateSends(second)).toEqual([]);

    // The first window's renderer is gone; its request must not open
    // the new window's gate.
    requestStateFrom(first.webContents);
    expect(stateSends(second)).toEqual([]);

    requestStateFrom(second.webContents);
    expect(stateSends(second)).toEqual([{ kind: "show-loaded", captureId: "cap_second_window" }]);
  });
});
