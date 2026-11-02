// The float-over window reshapes into the 18px screen-edge dock. A
// frameless window's corners are rounded by macOS and Windows 11 unless
// `roundedCorners: false`, and at 18px wide that cut all four corners
// off the dock: the top tab and the bottom ⋮ tab read as one canoe. The
// renderer draws every corner itself, so the window must not.

import { beforeEach, expect, test, vi } from "vitest";

const options: Record<string, unknown>[] = [];

vi.mock("electron", () => {
  class BrowserWindow {
    constructor(opts: Record<string, unknown>) {
      options.push(opts);
      // Any method the factory calls is a no-op spy.
      const spy: Record<string | symbol, unknown> = {
        webContents: new Proxy({}, { get: () => vi.fn() })
      };
      return new Proxy(spy, {
        get: (target, key) => (key in target ? target[key] : vi.fn()),
        set: (target, key, value) => {
          target[key] = value;
          return true;
        }
      }) as unknown as BrowserWindow;
    }
  }
  return {
    app: { getAppPath: () => "/fake/appPath", isPackaged: false },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
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
  STARTUP_BG_DARK: "#000000",
  STARTUP_BG_LIGHT: "#ffffff"
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined })
}));

beforeEach(() => {
  options.length = 0;
  vi.resetModules();
});

test("the float-over window draws no rounded corners of its own", async () => {
  const { createFloatOverWindow } = await import("../window");
  createFloatOverWindow();
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({ frame: false, transparent: true, roundedCorners: false });
});
