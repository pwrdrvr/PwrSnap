// The float-over's screen-edge dock: a snap whose enrichment is still
// running when its toast's countdown ends tucks to tabs on the screen
// edge. The same window draws the toast and the dock, so every rule here
// is about which shape is on screen, when, and whether it may be
// captured:
//
//   - a shape change parks the window until the renderer has drawn the
//     new shape (otherwise the old one flashes at the new size);
//   - the dock is excluded from screen capture, and hidden outright for
//     a recording and for the chrome hide before a snapshot;
//   - a capture session that ends without a toast brings the dock back,
//     unless it handed the screen to a recording.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const STATE_CHANNEL = "events:float-over:state";
const RESIZE_CHANNEL = "float-over:resize";
const REQUEST_CHANNEL = "float-over:request-state";
const DRAG_CHANNEL = "float-over:dock-drag";

const WORK_AREA = { x: 0, y: 25, width: 1440, height: 875 };

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];
  const ipcHandlers = new Map<string, (event: { sender: unknown }, payload?: unknown) => void>();
  const cursor = { x: 1400, y: 400 };

  function createWindow(id: number) {
    let destroyed = false;
    let closedListener: (() => void) | null = null;
    let bounds = { x: 0, y: 0, width: 392, height: 200 };
    const webContents = {
      invalidate: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      on: vi.fn(),
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
      getBounds: vi.fn(() => ({ ...bounds })),
      getContentSize: vi.fn(() => [bounds.width, bounds.height] as [number, number]),
      getSize: vi.fn(() => [bounds.width, bounds.height] as [number, number]),
      hide: vi.fn(),
      isAlwaysOnTop: vi.fn(() => true),
      isDestroyed: vi.fn(() => destroyed),
      moveTop: vi.fn(),
      on: vi.fn((event: string, listener: () => void) => {
        if (event === "closed") closedListener = listener;
      }),
      setAlwaysOnTop: vi.fn(),
      setBounds: vi.fn((next: typeof bounds) => {
        bounds = { ...next };
      }),
      setContentProtection: vi.fn(),
      setHasShadow: vi.fn(),
      setContentSize: vi.fn((width: number, height: number) => {
        bounds = { ...bounds, width, height };
      }),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn(),
      setPosition: vi.fn((x: number, y: number) => {
        bounds = { ...bounds, x, y };
      }),
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
    cursor,
    ipcHandlers,
    ipcMain: {
      on: vi.fn((channel: string, handler: (event: { sender: unknown }) => void) => {
        ipcHandlers.set(channel, handler);
      }),
      removeAllListeners: vi.fn((channel: string) => {
        ipcHandlers.delete(channel);
      })
    },
    menuTemplates: [] as unknown[],
    placementIsOurs: { value: true },
    windows
  };
});

vi.mock("electron", () => {
  const display = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
  return {
    app: { on: vi.fn(), removeListener: vi.fn() },
    BrowserWindow: Object.assign(vi.fn(), {
      getAllWindows: vi.fn(() => []),
      getFocusedWindow: vi.fn(() => null)
    }),
    globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
    ipcMain: mocks.ipcMain,
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => {
        mocks.menuTemplates.push(template);
        return { popup: vi.fn() };
      })
    },
    screen: {
      getAllDisplays: vi.fn(() => [display]),
      getCursorScreenPoint: vi.fn(() => ({ ...mocks.cursor })),
      getDisplayNearestPoint: vi.fn(() => display)
    }
  };
});

vi.mock("../window", () => ({
  createFloatOverWindow: mocks.createFloatOverWindow
}));

vi.mock("../linux-window-placement", () => ({
  windowPlacementIsOurs: () => mocks.placementIsOurs.value
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
  getMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() })
}));

import {
  disposeFloatOver,
  floatOverCapabilities,
  floatOverDockBounds,
  getFloatOverState,
  releaseFloatOverDock,
  setFloatOverState,
  tuckFloatOver
} from "../float-over";
import { setRecordingState } from "../recording/recording-state";

type MockWindow = (typeof mocks.windows)[number];

function win(): MockWindow {
  const window = mocks.windows.at(-1);
  if (window === undefined) throw new Error("no float-over window");
  return window;
}

/** Logical visibility: every park ignores the mouse, every restore takes
 *  it back — on every platform's hide model. */
function onScreen(window: MockWindow): boolean {
  return window.setIgnoreMouseEvents.mock.calls.at(-1)?.[0] === false;
}

function stateSends(window: MockWindow): unknown[] {
  return window.webContents.send.mock.calls
    .filter(([channel]) => channel === STATE_CHANNEL)
    .map(([, payload]) => payload);
}

function postLayout(payload: { width: number; height: number; mode?: "toast" | "dock" }): void {
  const handler = mocks.ipcHandlers.get(RESIZE_CHANNEL);
  if (handler === undefined) throw new Error("resize channel is not wired");
  handler({ sender: win().webContents }, payload);
}

function drag(phase: "start" | "move" | "end"): void {
  const handler = mocks.ipcHandlers.get(DRAG_CHANNEL);
  if (handler === undefined) throw new Error("dock drag channel is not wired");
  handler({ sender: win().webContents }, { phase });
}

/** A toast on screen, whose renderer has drawn it. */
function showToast(captureId = "cap_1"): MockWindow {
  setFloatOverState({ kind: "show-loaded", captureId });
  const window = win();
  mocks.ipcHandlers.get(REQUEST_CHANNEL)?.({ sender: window.webContents });
  postLayout({ width: 392, height: 480, mode: "toast" });
  return window;
}

/** The toast tucked, and the renderer has drawn the tabs. */
function showDock(): MockWindow {
  showToast();
  expect(tuckFloatOver()).toEqual({ docked: true });
  postLayout({ width: 18, height: 174, mode: "dock" });
  return win();
}

const originalPlatform = process.platform;

describe("float-over dock", () => {
  beforeAll(() => {
    // Content protection is a darwin/win32 call; pin the host so the
    // assertions below hold on the Linux CI lane too.
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    disposeFloatOver();
    setRecordingState({ phase: "idle" });
    mocks.windows.length = 0;
    mocks.menuTemplates.length = 0;
    mocks.placementIsOurs.value = true;
    mocks.cursor.x = 1400;
    mocks.cursor.y = 400;
  });

  afterEach(() => {
    disposeFloatOver();
    setRecordingState({ phase: "idle" });
    vi.useRealTimers();
  });

  describe("floatOverDockBounds", () => {
    it("sits flush with the right edge of the work area, never past it", () => {
      expect(floatOverDockBounds(WORK_AREA, { side: "right", topFraction: 0.3 }, 18, 174)).toEqual(
        { x: 1422, y: 288, width: 18, height: 174 }
      );
    });

    it("keeps its right edge when the hover widens it", () => {
      const rest = floatOverDockBounds(WORK_AREA, { side: "right", topFraction: 0.3 }, 18, 174);
      const out = floatOverDockBounds(WORK_AREA, { side: "right", topFraction: 0.3 }, 84, 174);
      expect(rest.x + rest.width).toBe(out.x + out.width);
    });

    it("mirrors to the left edge", () => {
      expect(
        floatOverDockBounds(WORK_AREA, { side: "left", topFraction: 0.3 }, 84, 174).x
      ).toBe(WORK_AREA.x);
    });

    it("clamps the top so the whole stack stays inside the work area", () => {
      expect(
        floatOverDockBounds(WORK_AREA, { side: "right", topFraction: 0.99 }, 18, 174).y
      ).toBe(WORK_AREA.y + WORK_AREA.height - 174);
      expect(
        floatOverDockBounds(WORK_AREA, { side: "right", topFraction: -1 }, 18, 174).y
      ).toBe(WORK_AREA.y);
    });
  });

  it("parks the toast on a tuck and shows the dock only once the tabs are drawn", () => {
    const window = showToast();
    expect(onScreen(window)).toBe(true);

    expect(tuckFloatOver()).toEqual({ docked: true });
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
    expect(onScreen(window)).toBe(false);
    expect(stateSends(window).at(-1)).toEqual({ kind: "tucked", side: "right" });

    postLayout({ width: 18, height: 174, mode: "dock" });
    expect(window.setBounds).toHaveBeenLastCalledWith(
      { x: 1422, y: 288, width: 18, height: 174 },
      false
    );
    expect(onScreen(window)).toBe(true);
  });

  it("drops a layout drawn for the shape the window has already left", () => {
    const window = showToast();
    tuckFloatOver();
    window.setContentSize.mockClear();

    postLayout({ width: 392, height: 480, mode: "toast" });
    expect(window.setContentSize).not.toHaveBeenCalled();
    expect(onScreen(window)).toBe(false);
  });

  it("keeps the dock out of screen captures, and the toast in them", () => {
    const window = showDock();
    expect(window.setContentProtection).toHaveBeenLastCalledWith(true);

    setFloatOverState({ kind: "show-loaded", captureId: "cap_2" });
    expect(window.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it("draws no native shadow around the dock, and gives the toast its shadow back", () => {
    const window = showDock();
    expect(window.setHasShadow).toHaveBeenLastCalledWith(false);

    setFloatOverState({ kind: "show-loaded", captureId: "cap_2" });
    postLayout({ width: 392, height: 480, mode: "toast" });
    expect(window.setHasShadow).toHaveBeenLastCalledWith(true);
  });

  it("opens a snap from the dock without flashing the dock's shape in the corner", () => {
    const window = showDock();

    setFloatOverState({ kind: "show-loaded", captureId: "cap_2" });
    expect(onScreen(window)).toBe(false);

    postLayout({ width: 472, height: 480, mode: "toast" });
    expect(window.setContentSize).toHaveBeenLastCalledWith(472, 480, false);
    expect(onScreen(window)).toBe(true);
  });

  it("hides the dock for the chrome hide before a snapshot, without bringing it back", () => {
    const window = showDock();

    setFloatOverState({ kind: "cancel", chromeHide: true });
    expect(getFloatOverState()).toEqual({ kind: "hidden" });
    expect(onScreen(window)).toBe(false);
    expect(stateSends(window).at(-1)).toEqual({ kind: "cancel", chromeHide: true });
  });

  it("a chrome hide never brings the dock back, even from hidden", () => {
    // A second full-screen capture lands between the first one's hide
    // and its toast: the float-over is hidden with snaps waiting.
    showDock();
    setFloatOverState({ kind: "cancel", chromeHide: true });
    setFloatOverState({ kind: "cancel", chromeHide: true });
    expect(getFloatOverState()).toEqual({ kind: "hidden" });
  });

  it("brings the dock back after a chrome-hidden capture that opened no toast", () => {
    // capture:fullScreen hid the dock, then the grab failed.
    showDock();
    setFloatOverState({ kind: "cancel", chromeHide: true });
    releaseFloatOverDock();
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
  });

  it("leaves a toast alone when a capture that opened one releases the dock", () => {
    showDock();
    setFloatOverState({ kind: "cancel", chromeHide: true });
    setFloatOverState({ kind: "show-loaded", captureId: "cap_2" });
    releaseFloatOverDock();
    expect(getFloatOverState()).toEqual({ kind: "loaded", captureId: "cap_2" });
  });

  it("brings the dock back when a capture session ends without a toast", () => {
    const window = showDock();
    setFloatOverState({ kind: "show-idle" });

    // The user pressed Esc in the selector.
    setFloatOverState({ kind: "cancel" });
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
    expect(stateSends(window).at(-1)).toEqual({ kind: "tucked", side: "right" });
    postLayout({ width: 18, height: 174, mode: "dock" });
    expect(onScreen(window)).toBe(true);
  });

  it("holds the dock for a recording, and brings it back when the take ends", () => {
    const window = showDock();
    setFloatOverState({ kind: "show-idle" });

    setFloatOverState({ kind: "cancel", holdDock: true });
    expect(getFloatOverState()).toEqual({ kind: "hidden" });

    setRecordingState({
      phase: "preflight",
      sessionId: "rec_1",
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1
    });
    releaseFloatOverDock();
    expect(getFloatOverState()).toEqual({ kind: "hidden" });

    setRecordingState({ phase: "idle" });
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
    postLayout({ width: 18, height: 174, mode: "dock" });
    expect(onScreen(window)).toBe(true);
  });

  it("brings a held dock back when the take never started", () => {
    showDock();
    setFloatOverState({ kind: "show-idle" });
    setFloatOverState({ kind: "cancel", holdDock: true });

    releaseFloatOverDock();
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
  });

  it("parks a showing dock when a recording starts", () => {
    const window = showDock();

    setRecordingState({
      phase: "preflight",
      sessionId: "rec_2",
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1
    });
    expect(getFloatOverState()).toEqual({ kind: "hidden" });
    expect(onScreen(window)).toBe(false);
  });

  it("a mark-only tuck never collapses the toast that is showing", () => {
    const window = showToast();

    expect(tuckFloatOver({ markOnly: true })).toEqual({ docked: true });
    expect(getFloatOverState()).toEqual({ kind: "loaded", captureId: "cap_1" });
    expect(onScreen(window)).toBe(true);

    // ...but the session's end now knows snaps are waiting.
    setFloatOverState({ kind: "cancel", chromeHide: true });
    setFloatOverState({ kind: "show-idle" });
    setFloatOverState({ kind: "cancel" });
    expect(getFloatOverState()).toEqual({ kind: "tucked" });
  });

  it("forgets the dock on dismiss", () => {
    showDock();
    setFloatOverState({ kind: "dismiss" });
    setFloatOverState({ kind: "show-idle" });
    setFloatOverState({ kind: "cancel" });
    expect(getFloatOverState()).toEqual({ kind: "hidden" });
  });

  it("does not dock where PwrSnap cannot place its windows", () => {
    showToast();
    mocks.placementIsOurs.value = false;
    expect(floatOverCapabilities()).toEqual({ dock: false });
    expect(tuckFloatOver()).toEqual({ docked: false });
    expect(getFloatOverState()).toEqual({ kind: "loaded", captureId: "cap_1" });
  });

  it("moves along the edge while dragged, and flips sides past the middle", () => {
    const window = showDock();
    const startBounds = window.getBounds();
    mocks.cursor.x = startBounds.x + 9;
    mocks.cursor.y = startBounds.y + 20;
    drag("start");

    mocks.cursor.y += 100;
    drag("move");
    expect(window.getBounds().y).toBe(startBounds.y + 100);
    expect(window.getBounds().x).toBe(1422);

    mocks.cursor.x = 200;
    drag("move");
    expect(window.getBounds().x).toBe(WORK_AREA.x);
    expect(stateSends(window).at(-1)).toEqual({ kind: "tucked", side: "left" });

    // A drag message from anywhere but the float-over is ignored.
    const other = mocks.ipcHandlers.get(DRAG_CHANNEL)!;
    mocks.cursor.x = 1400;
    other({ sender: {} }, { phase: "move" });
    expect(window.getBounds().x).toBe(WORK_AREA.x);

    drag("end");
    // Put the session-lifetime placement back for any later suite.
    mocks.cursor.x = 1400;
    drag("start");
    drag("move");
    drag("end");
  });
});
