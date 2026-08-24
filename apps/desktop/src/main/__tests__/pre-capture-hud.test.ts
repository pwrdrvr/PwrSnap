import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  EVENT_CHANNELS,
  IPC_PRE_CAPTURE_HUD_READY,
  IPC_PRE_CAPTURE_HUD_RESIZE
} from "@pwrsnap/shared";

type FakeWindow = {
  webContents: {
    send: ReturnType<typeof vi.fn>;
    invalidate: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    zoomFactor: number;
    on: ReturnType<typeof vi.fn>;
  };
  destroyed: boolean;
  contentSize: [number, number];
  on: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getSize: ReturnType<typeof vi.fn>;
  getContentSize: ReturnType<typeof vi.fn>;
  setContentSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setOpacity: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  emitWindow: (event: string) => void;
  emitWebContents: (event: string) => void;
};
const windows: FakeWindow[] = [];
const ipcListeners = new Map<string, (...args: any[]) => void>();

function makeWindow(): FakeWindow {
  const windowListeners = new Map<string, () => void>();
  const webContentsListeners = new Map<string, () => void>();
  const webContents = {
    send: vi.fn(),
    invalidate: vi.fn(),
    isDestroyed: vi.fn(() => false),
    zoomFactor: 1,
    on: vi.fn((event: string, listener: () => void) => {
      webContentsListeners.set(event, listener);
    })
  };
  const fake = {
    webContents,
    destroyed: false,
    contentSize: [400, 88] as [number, number],
    on: vi.fn((event: string, listener: () => void) => {
      windowListeners.set(event, listener);
    }),
    isDestroyed: vi.fn(() => fake.destroyed),
    getSize: vi.fn(() => fake.contentSize),
    getContentSize: vi.fn(() => fake.contentSize),
    setContentSize: vi.fn((width: number, height: number) => {
      fake.contentSize = [width, height];
    }),
    setPosition: vi.fn(),
    setIgnoreMouseEvents: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setOpacity: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(() => {
      if (fake.destroyed) return;
      fake.destroyed = true;
      windowListeners.get("closed")?.();
    }),
    emitWindow: (event: string) => windowListeners.get(event)?.(),
    emitWebContents: (event: string) => webContentsListeners.get(event)?.()
  };
  windows.push(fake);
  return fake;
}

vi.mock("electron", () => ({
  BrowserWindow: class BrowserWindow {},
  ipcMain: {
    on: vi.fn((channel: string, listener: (...args: any[]) => void) => {
      ipcListeners.set(channel, listener);
    }),
    removeListener: vi.fn((channel: string) => ipcListeners.delete(channel))
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({
      id: 7,
      workArea: { x: 0, y: 0, width: 1200, height: 800 }
    }),
    getAllDisplays: () => [
      { id: 7, workArea: { x: 0, y: 0, width: 1200, height: 800 } }
    ]
  }
}));

vi.mock("../window", () => ({
  createPreCaptureHudWindow: vi.fn(() => makeWindow())
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

async function loadHud() {
  return import("../pre-capture-hud");
}

function ready(window: FakeWindow): void {
  ipcListeners.get(IPC_PRE_CAPTURE_HUD_READY)?.({ sender: window.webContents });
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  windows.length = 0;
  ipcListeners.clear();
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
});

describe("pre-capture HUD lifecycle", () => {
  test("buffers preparing until renderer readiness, then shows inactive and click-through", async () => {
    const { beginPreCaptureHud } = await loadHud();
    const session = beginPreCaptureHud("snap");
    expect(session).not.toBeNull();
    const window = windows[0]!;
    expect(window.webContents.send).not.toHaveBeenCalled();

    ready(window);

    expect(window.webContents.send).toHaveBeenCalledWith(
      EVENT_CHANNELS.preCaptureHudState,
      expect.objectContaining({ phase: "preparing", intent: "snap" })
    );
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect(window.showInactive).toHaveBeenCalledTimes(1);
  });

  test("keeps handoff visible until the matching selector presentation and rejects overlap", async () => {
    const { beginPreCaptureHud, getPreCaptureHudSnapshot } = await loadHud();
    const session = beginPreCaptureHud("video")!;
    const window = windows[0]!;
    ready(window);
    session.showPermission();
    session.showStorage();
    session.showCountdown(5);

    session.showSelectorHandoff();
    expect(beginPreCaptureHud("snap")).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(window.hide).not.toHaveBeenCalled();

    session.selectorPresented();

    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(window.hide).toHaveBeenCalled();
    expect(getPreCaptureHudSnapshot()).toEqual({
      runId: session.runId,
      terminal: false,
      phase: "selector-handoff"
    });
    // Generation-bound callback: a stale session cannot hide the next run.
    session.finish();
    const next = beginPreCaptureHud("snap")!;
    next.selectorPresented();
    expect(window.hide).toHaveBeenCalledTimes(2);
    session.selectorPresented();
    expect(window.hide).toHaveBeenCalledTimes(2);
  });

  test("keeps a blocked explanation visible, ignores finish, then tears topmost down", async () => {
    const { beginPreCaptureHud, getPreCaptureHudSnapshot } = await loadHud();
    const session = beginPreCaptureHud("snap")!;
    const window = windows[0]!;
    ready(window);

    session.block("permission");
    session.finish();
    expect(getPreCaptureHudSnapshot().terminal).toBe(true);
    expect(window.hide).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_600);
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(getPreCaptureHudSnapshot()).toEqual({
      runId: null,
      terminal: false,
      phase: null
    });
  });

  test("accepts resize only from its sandboxed renderer and stays on the trigger display", async () => {
    const { beginPreCaptureHud } = await loadHud();
    beginPreCaptureHud("snap");
    const window = windows[0]!;
    ready(window);
    const resize = ipcListeners.get(IPC_PRE_CAPTURE_HUD_RESIZE)!;

    resize({ sender: {} }, { width: 1, height: 140 });
    expect(window.setContentSize).not.toHaveBeenCalled();
    resize({ sender: window.webContents }, { width: 1, height: 140 });
    expect(window.setContentSize).toHaveBeenCalledWith(400, 140, false);
    expect(window.setPosition).toHaveBeenLastCalledWith(400, 16, false);
  });

  test("recreates a lost renderer during an active run and disposal is final", async () => {
    const { beginPreCaptureHud, disposePreCaptureHud } = await loadHud();
    beginPreCaptureHud("snap");
    const first = windows[0]!;
    ready(first);
    first.emitWebContents("render-process-gone");
    await Promise.resolve();
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(windows).toHaveLength(2);

    disposePreCaptureHud();
    expect(windows[1]!.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    expect(windows[1]!.destroy).toHaveBeenCalledTimes(1);
  });
});
