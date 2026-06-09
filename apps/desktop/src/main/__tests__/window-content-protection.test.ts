// Pins setContentProtection(true) on the recording-controller HUD
// window. This is the load-bearing way we hide the HUD overlay
// (countdown leader, "Starting recorder…", Stop/Restart/Cancel
// pill) from EVERY screen capture — ours, macOS screencapture,
// QuickTime, third-party recorders.
//
// We previously relied on SCContentFilter.excludingApplications
// with our own PID list, which broke twice:
//   - Electron sometimes shares renderer processes across
//     BrowserWindows, so excluding the HUD's PID also erased
//     other PwrSnap windows from the captured frame (e.g. the
//     Library you were trying to record).
//   - getOSProcessId() returned 0 mid-construction so we sent an
//     empty exclude list and the HUD painted into the recording.
//
// setContentProtection is per-window, set BEFORE first show, and
// the OS-level switch. If a future refactor removes the call or
// moves the HUD to a different factory, THIS TEST catches it.

import { beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  setMinimumSize: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setMenuBarVisibility: ReturnType<typeof vi.fn>;
  setContentProtection: ReturnType<typeof vi.fn>;
  excludedFromShownWindowsMenu: boolean;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  webContents: {
    setVisualZoomLevelLimits: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  on: ReturnType<typeof vi.fn>;
};

const constructed: WindowSpy[] = [];

function makeWindowSpy(): WindowSpy {
  return {
    setMinimumSize: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setMenuBarVisibility: vi.fn(),
    setContentProtection: vi.fn(),
    excludedFromShownWindowsMenu: false,
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents: {
      setVisualZoomLevelLimits: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn()
    },
    on: vi.fn()
  };
}

vi.mock("electron", () => {
  class BrowserWindow {
    constructor() {
      const spy = makeWindowSpy();
      constructed.push(spy);
      // Return the spy instead of `this`. JS supports this — the
      // constructor's explicit object return supersedes the
      // default `this`. Lets us hand the production code a plain
      // object with vi.fn methods without bothering to type the
      // class to BrowserWindow's full surface.
      return spy as unknown as BrowserWindow;
    }
  }
  return {
    app: {
      getAppPath: () => "/fake/appPath",
      isPackaged: false
    },
    screen: {
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1000, height: 800 }
      })
    },
    BrowserWindow
  };
});

vi.mock("../development-dock-icon", () => ({
  installDevelopmentDockIcon: vi.fn(),
  showDockWithDevelopmentIcon: vi.fn()
}));

vi.mock("../settings/startup-appearance", () => ({
  getStartupAppearanceArgs: () => [],
  getStartupBackgroundColor: () => "#000000",
  // window.ts reads STARTUP_BG_DARK for the Windows title-bar overlay color
  // (the win32 branch of platformWindowChrome runs on the Windows CI runner).
  STARTUP_BG_DARK: "#000000",
  STARTUP_BG_LIGHT: "#ffffff"
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  })
}));

beforeEach(() => {
  constructed.length = 0;
  vi.resetModules();
});

describe("createRecordingControllerWindow content protection", () => {
  test("calls setContentProtection(true) so the HUD is invisible to every screen capture", async () => {
    const { createRecordingControllerWindow } = await import("../window");
    createRecordingControllerWindow();

    expect(constructed).toHaveLength(1);
    const spy = constructed[0]!;
    expect(spy.setContentProtection).toHaveBeenCalledTimes(1);
    expect(spy.setContentProtection).toHaveBeenCalledWith(true);
  });

  test("setContentProtection is called BEFORE the renderer loads (no painted-but-visible window)", async () => {
    const { createRecordingControllerWindow } = await import("../window");
    createRecordingControllerWindow();

    const spy = constructed[0]!;
    // Both loadFile and loadURL are valid paths depending on dev vs
    // packaged. Whichever was used, setContentProtection must have
    // fired first so there's no race where the HUD shows in a
    // capture between window construction and the protection call.
    const protectOrder = spy.setContentProtection.mock.invocationCallOrder[0]!;
    const fileOrder = spy.loadFile.mock.invocationCallOrder[0];
    const urlOrder = spy.loadURL.mock.invocationCallOrder[0];
    const loadOrder = fileOrder ?? urlOrder;
    if (loadOrder !== undefined) {
      expect(protectOrder).toBeLessThan(loadOrder);
    }
  });
});
