// Lifecycle pin for the region-selector overlay window construction.
//
// Background — Splashtop Space-shift bug (bug iii):
//   When the user ran PwrSnap alongside Splashtop (the remote-desktop
//   client, which holds its own macOS Space), triggering a capture
//   would shift the user away from their current Space. The cause was
//   that the pre-warmed selector window was a regular NSWindow —
//   show()/focus() on a regular NSWindow can drive AppKit's "find the
//   Space this window belongs to and switch to it" path, even with
//   `setVisibleOnAllWorkspaces(true)` set, because the side-effect of
//   bringing the app frontmost is part of the swap. The non-activating
//   NSPanel skips the app-activation step entirely.
//
// Fix (see createSelectorWindow in capture/region-selector.ts):
//   - `type: 'panel'` — NSPanel + NSWindowStyleMaskNonactivatingPanel
//     so show()/focus() never activates the app.
//   - `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
//     — canJoinAllSpaces so the panel isn't pinned to any single
//     Space, and visibleOnFullScreen so it covers fullscreen apps too.
//   - `setAlwaysOnTop(true, 'screen-saver')` — still required so the
//     selector clears the menu bar and any other overlays.
//
// If a future refactor drops any of these three calls, this test
// catches it.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  setTitle: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setSimpleFullScreen: ReturnType<typeof vi.fn>;
  isSimpleFullScreen: ReturnType<typeof vi.fn>;
  setContentBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  blur: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  moveTop: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
};

const constructed: WindowSpy[] = [];
const ipcListeners = new Map<string, (event: unknown, payload: unknown) => void>();
const deferredLoadResolvers: (() => void)[] = [];
let deferSelectorLoads = false;

function selectorLoadPromise(): Promise<void> {
  if (!deferSelectorLoads) return Promise.resolve();
  return new Promise((resolve) => {
    deferredLoadResolvers.push(resolve);
  });
}

function makeWindowSpy(options: Record<string, unknown>): WindowSpy {
  return {
    setTitle: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setSimpleFullScreen: vi.fn(),
    isSimpleFullScreen: vi.fn().mockReturnValue(false),
    setContentBounds: vi.fn(),
    setBounds: vi.fn(),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1440, height: 900 }),
    show: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    hide: vi.fn(),
    moveTop: vi.fn(),
    loadURL: vi.fn(() => selectorLoadPromise()),
    loadFile: vi.fn(() => selectorLoadPromise()),
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      focus: vi.fn()
    },
    on: vi.fn(),
    once: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: vi.fn().mockReturnValue(false),
    options
  };
}

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(options: Record<string, unknown>) {
      const spy = makeWindowSpy(options);
      constructed.push(spy);
      // Return the spy instead of `this`. Matches the pattern in
      // window-content-protection.test.ts.
      return spy as unknown as BrowserWindow;
    }
  }
  return {
    app: {
      isPackaged: false,
      getAppPath: () => "/fake/appPath"
    },
    screen: {
      getAllDisplays: () => [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1440, height: 900 },
          workArea: { x: 0, y: 25, width: 1440, height: 875 },
          scaleFactor: 2
        }
      ],
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 },
        scaleFactor: 2
      }),
      getDisplayMatching: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 25, width: 1440, height: 875 },
        scaleFactor: 2
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: vi.fn()
    },
    BrowserWindow,
    globalShortcut: {
      register: vi.fn(),
      unregister: vi.fn()
    },
    ipcMain: {
      on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
        ipcListeners.set(channel, listener);
      }),
      removeAllListeners: vi.fn()
    }
  };
});

vi.mock("../window", () => ({
  getPreloadPath: () => "/fake/preload.cjs"
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

vi.mock("../capture/window-list", () => ({
  activateApp: vi.fn(),
  boundsApproxEqual: () => false,
  listWindows: vi.fn().mockResolvedValue([]),
  listWindowsSnapshot: vi
    .fn()
    .mockResolvedValue({ windows: [], frontmostPid: null, frontmostBundleId: null }),
  selfPidSet: () => new Set<number>()
}));

vi.mock("../capture/screen-snapshot", () => ({
  captureAndRegister: vi
    .fn()
    .mockResolvedValue({ id: "snapshot-1", filePath: "/tmp/snapshot.png", displayId: 1 }),
  releaseSnapshot: vi.fn()
}));

vi.mock("../tray", () => ({
  hideTrayPopoverIfVisible: vi.fn()
}));

vi.mock("../float-over", () => ({
  setFloatOverState: vi.fn()
}));

const realPlatform = process.platform;

beforeEach(() => {
  constructed.length = 0;
  ipcListeners.clear();
  deferredLoadResolvers.length = 0;
  deferSelectorLoads = false;
  vi.resetModules();
  // createSelectorWindow only sets the NSPanel (`type: 'panel'`) +
  // setVisibleOnAllWorkspaces flags this test guards on darwin — they're
  // macOS-only (Windows/Linux use a plain frameless overlay). Pin the
  // platform so the macOS Splashtop guard is actually exercised.
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

describe("createSelectorWindow — Splashtop Space-shift guard (bug iii)", () => {
  test("uses type: 'panel' so show()/focus() never activates PwrSnap and pulls the user's Space", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    expect(constructed).toHaveLength(1);
    const spy = constructed[0]!;
    // The non-activating NSPanel is the load-bearing knob. Without it,
    // macOS may switch Spaces when the selector shows next to apps
    // that hold their own Space (Splashtop, Citrix, Parallels Coherence).
    expect(spy.options.type).toBe("panel");
  });

  test("calls setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) so the selector appears on the CURRENT Space, not the one it was constructed on", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.setVisibleOnAllWorkspaces).toHaveBeenCalledTimes(1);
    expect(spy.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true
    });
  });

  test("calls setAlwaysOnTop(true, 'screen-saver') so the selector clears the menu bar and other overlays", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    expect(spy.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  test("disables background throttling so hidden prewarm loads before the first shortcut", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    expect(spy.options.webPreferences).toMatchObject({
      backgroundThrottling: false
    });
  });

  test("setVisibleOnAllWorkspaces is called BEFORE the renderer loads — first paint must not flash on the wrong Space", async () => {
    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();

    const spy = constructed[0]!;
    const workspacesOrder = spy.setVisibleOnAllWorkspaces.mock.invocationCallOrder[0];
    const fileOrder = spy.loadFile.mock.invocationCallOrder[0];
    const urlOrder = spy.loadURL.mock.invocationCallOrder[0];
    const loadOrder = fileOrder ?? urlOrder;
    expect(workspacesOrder).toBeDefined();
    if (loadOrder !== undefined && workspacesOrder !== undefined) {
      expect(workspacesOrder).toBeLessThan(loadOrder);
    }
  });

  test("re-raises the visible selector with moveTop after show/focus without activating the app", async () => {
    const { pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion();

    await vi.waitFor(() => {
      expect(constructed[0]?.moveTop).toHaveBeenCalledTimes(1);
    });

    const spy = constructed[0]!;
    const showOrder = spy.show.mock.invocationCallOrder[0];
    const focusOrder = spy.focus.mock.invocationCallOrder[0];
    const webFocusOrder = spy.webContents.focus.mock.invocationCallOrder[0];
    const moveTopOrder = spy.moveTop.mock.invocationCallOrder[0];

    expect(showOrder).toBeDefined();
    expect(focusOrder).toBeDefined();
    expect(webFocusOrder).toBeDefined();
    expect(moveTopOrder).toBeDefined();
    expect(moveTopOrder!).toBeGreaterThan(showOrder!);
    expect(moveTopOrder!).toBeGreaterThan(focusOrder!);
    expect(moveTopOrder!).toBeGreaterThan(webFocusOrder!);

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  test("swaps in a warmed macOS standby selector after hide so the next capture starts fresh", async () => {
    const { hideSelector, pickRegion } = await import("../capture/region-selector");
    const pick = pickRegion({ keepPwrSnapChrome: true });

    expect(constructed).toHaveLength(1);
    const first = constructed[0]!;

    await vi.waitFor(() => {
      expect(first.show).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });

    hideSelector();

    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(standby.destroy).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(2);
    expect(standby.options.type).toBe("panel");
    expect(standby.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
    expect(standby.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true
    });

    const { preWarmRegionSelector } = await import("../capture/region-selector");
    preWarmRegionSelector();
    expect(constructed).toHaveLength(2);
  });

  test("uses the swapped standby selector on the next capture", async () => {
    const { hideSelector, pickRegion } = await import("../capture/region-selector");
    const firstPick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(firstPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    hideSelector();

    const secondPick = pickRegion({ mode: "window", keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(standby.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          mode: "window",
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });
    if (constructed[2] !== undefined) {
      expect(constructed[2].show).not.toHaveBeenCalled();
    }

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(secondPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
  });

  test("waits for a swapped standby selector renderer to load before sending per-show mode", async () => {
    const { hideSelector, pickRegion, preWarmRegionSelector } = await import(
      "../capture/region-selector"
    );
    preWarmRegionSelector();
    deferSelectorLoads = true;
    const firstPick = pickRegion({ keepPwrSnapChrome: true });

    await vi.waitFor(() => {
      expect(constructed[0]?.show).toHaveBeenCalledTimes(1);
    });

    await vi.waitFor(() => {
      expect(constructed).toHaveLength(2);
    });
    expect(deferredLoadResolvers).toHaveLength(1);
    const standby = constructed[1]!;

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(firstPick).resolves.toMatchObject({
      ok: false,
      reason: "cancelled"
    });
    hideSelector();

    const pick = pickRegion({ mode: "window", keepPwrSnapChrome: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(standby.webContents.send).not.toHaveBeenCalledWith(
      "region-selector:mode",
      expect.anything()
    );
    expect(standby.show).not.toHaveBeenCalled();

    deferredLoadResolvers.shift()?.();

    await vi.waitFor(() => {
      expect(standby.webContents.send).toHaveBeenCalledWith(
        "region-selector:mode",
        expect.objectContaining({
          mode: "window",
          screenUrl: "pwrsnap-screen://r/snapshot-1"
        })
      );
      expect(standby.show).toHaveBeenCalledTimes(1);
    });

    ipcListeners.get("region-selector:result")?.({}, { ok: false });
    await expect(pick).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });
});
