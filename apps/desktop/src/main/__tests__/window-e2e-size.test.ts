import type { BrowserWindowConstructorOptions } from "electron";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  isPackaged: false,
  options: undefined as BrowserWindowConstructorOptions | undefined,
  stop: new Error("stop after recording BrowserWindow options")
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/appPath",
    getPath: () => "/fake/userData",
    get isPackaged() { return state.isPackaged; }
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1024, height: 768 } })
  },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) {
      state.options = options;
      // Exercise the real factory's constructor options without starting its
      // renderer, profiling monitors or window-show timers.
      throw state.stop;
    }
  }
}));
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
  getMainLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()
  })
}));

import { createMainWindow } from "../window";

beforeEach(() => {
  state.options = undefined;
  state.isPackaged = false;
  vi.stubEnv("PWRSNAP_E2E", "1");
  vi.stubEnv("PWRSNAP_E2E_LARGER_THAN_SCREEN", "1");
});

afterEach(() => vi.unstubAllEnvs());

describe("Library E2E sizing on small hosted displays", () => {
  test("unpackaged E2E can preserve a viewport larger than the display", () => {
    expect(createMainWindow).toThrow(state.stop);
    expect(state.options?.enableLargerThanScreen).toBe(true);
    if (process.platform !== "win32") {
      expect(state.options).toMatchObject({ width: 1440, height: 960 });
    }
  });

  test("a spec can opt out to check normal work-area fitting", () => {
    vi.stubEnv("PWRSNAP_E2E_LARGER_THAN_SCREEN", undefined);
    expect(createMainWindow).toThrow(state.stop);
    expect(state.options?.enableLargerThanScreen).toBe(false);
  });

  test("ordinary launches cannot enable the E2E setting", () => {
    vi.stubEnv("PWRSNAP_E2E", undefined);
    expect(createMainWindow).toThrow(state.stop);
    expect(state.options?.enableLargerThanScreen).toBe(false);
  });

  test("packaged builds cannot enable the E2E setting", () => {
    state.isPackaged = true;
    expect(createMainWindow).toThrow(state.stop);
    expect(state.options?.enableLargerThanScreen).toBe(false);
  });
});
