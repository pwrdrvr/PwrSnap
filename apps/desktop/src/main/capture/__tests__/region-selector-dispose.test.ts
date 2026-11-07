// Once the region selector is disposed — which the quit teardown does —
// nothing may build a selector window again. A disposed selector used to
// keep its display listeners, so the display-metrics change that closing
// the Library causes rebuilt a hidden selector window in the middle of
// quitting. Electron then waited for that window before emitting
// will-quit, and ignored every later quit because it believed one was
// already under way: the app could not be quit at all (Nov 2026, log
// lines "window created during quit" / "quit stalled").

import { beforeEach, describe, expect, test, vi } from "vitest";

const h = vi.hoisted(() => ({
  windows: [] as Array<{ destroyed: boolean }>,
  screenListeners: new Map<string, Set<(...args: unknown[]) => void>>()
}));

const bounds = { x: 0, y: 0, width: 1440, height: 900 };
const display = { id: 1, bounds, workArea: bounds, scaleFactor: 2 };

class FakeWindow {
  destroyed = false;
  readonly webContents = {
    id: 0,
    on: () => undefined,
    once: () => undefined,
    send: () => undefined,
    setBackgroundThrottling: () => undefined,
    isDestroyed: () => this.destroyed
  };
  constructor() {
    h.windows.push(this);
  }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
  on() {}
  once() {}
  setTitle() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setSimpleFullScreen() {}
  setFullScreen() {}
  isSimpleFullScreen() { return false; }
  setBounds() {}
  getBounds() { return bounds; }
  setContentBounds() {}
  setMinimumSize() {}
  setHiddenInMissionControl() {}
  setFocusable() {}
  setIgnoreMouseEvents() {}
  setOpacity() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
  isVisible() { return false; }
  hide() {}
}

vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/selector-dispose" },
  BrowserWindow: Object.assign(function () { return new FakeWindow(); }, {
    fromId: () => null,
    getAllWindows: () => []
  }),
  screen: {
    getAllDisplays: () => [display],
    getDisplayNearestPoint: () => display,
    getDisplayMatching: () => display,
    getCursorScreenPoint: () => ({ x: 20, y: 20 }),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = h.screenListeners.get(event) ?? new Set();
      set.add(listener);
      h.screenListeners.set(event, set);
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      h.screenListeners.get(event)?.delete(listener);
    }
  },
  globalShortcut: { register: () => true, unregister: () => undefined },
  ipcMain: {
    on: () => undefined,
    handle: () => undefined,
    removeHandler: () => undefined,
    removeAllListeners: () => undefined
  }
}));
vi.mock("../../window", () => ({ getPreloadPath: () => "/selector-dispose/preload.cjs" }));
vi.mock("../../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../../tray", () => ({ hideTrayPopoverIfVisible() {} }));
vi.mock("../../float-over", () => ({ setFloatOverState() {}, ensureFloatOverTopmost() {} }));
vi.mock("../../hotkeys/hotkey-recorder-suspension-instance", () => ({
  hotkeyRecorderSuspension: { registerParticipant() {} }
}));
vi.mock("../window-list", () => ({
  selfPidSet: () => new Set<number>(),
  boundsApproxEqual: () => false,
  listWindowsSnapshot: async () => ({ windows: [], frontmostPid: 1, frontmostBundleId: "example.fixture" })
}));
vi.mock("../screen-snapshot", () => ({
  captureAndRegister: () => new Promise(() => undefined),
  releaseSnapshot: () => Promise.resolve(),
  releaseAllSnapshots: () => Promise.resolve(),
  readSnapshotForRenderer() {},
  recordSnapshotCanvasUpload() {}
}));

function emitScreen(event: string, ...args: unknown[]): void {
  for (const listener of h.screenListeners.get(event) ?? []) listener({}, ...args);
}

function liveWindows(): number {
  return h.windows.filter((window) => !window.destroyed).length;
}

describe("a disposed region selector stays disposed", () => {
  beforeEach(() => {
    h.windows.length = 0;
  });

  test("a display change after dispose builds no selector window", async () => {
    const selector = await import("../region-selector");
    // Pre-warming builds the selector and attaches its display listeners.
    selector.preWarmRegionSelector("startup");
    expect(h.windows.length).toBeGreaterThan(0);

    selector.disposeRegionSelector();
    expect(liveWindows()).toBe(0);
    const built = h.windows.length;

    // Closing the Library during quit changes display metrics.
    emitScreen("display-metrics-changed", display);
    emitScreen("display-added", display);
    emitScreen("display-removed", display);

    expect(h.windows.length).toBe(built);
    expect(liveWindows()).toBe(0);
  });
});
