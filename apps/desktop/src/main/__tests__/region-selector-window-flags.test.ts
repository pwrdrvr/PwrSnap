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

import { beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  setTitle: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  options: Record<string, unknown>;
};

const constructed: WindowSpy[] = [];

function makeWindowSpy(options: Record<string, unknown>): WindowSpy {
  return {
    setTitle: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents: {
      on: vi.fn(),
      send: vi.fn()
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
      on: vi.fn(),
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
  selfPidSet: () => new Set<number>()
}));

vi.mock("../capture/screen-snapshot", () => ({
  captureAndRegister: vi.fn(),
  releaseSnapshot: vi.fn()
}));

vi.mock("../tray", () => ({
  hideTrayPopoverIfVisible: vi.fn()
}));

vi.mock("../float-over", () => ({
  setFloatOverState: vi.fn()
}));

beforeEach(() => {
  constructed.length = 0;
  vi.resetModules();
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
});
