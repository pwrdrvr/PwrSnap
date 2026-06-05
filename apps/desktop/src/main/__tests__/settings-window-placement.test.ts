import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  id: number;
  getBounds: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: {
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };
};

const electronMock = vi.hoisted(() => ({
  constructedOptions: [] as Array<Record<string, unknown>>,
  fromId: vi.fn(),
  getFocusedWindow: vi.fn(),
  getDisplayMatching: vi.fn(),
  getPrimaryDisplay: vi.fn(),
  windows: [] as WindowSpy[]
}));

function makeWindowSpy(options?: Record<string, unknown>): WindowSpy {
  const spy: WindowSpy = {
    id: electronMock.windows.length + 1,
    getBounds: vi.fn(() => ({
      x: Number(options?.x ?? 0),
      y: Number(options?.y ?? 0),
      width: Number(options?.width ?? 1040),
      height: Number(options?.height ?? 720)
    })),
    isDestroyed: vi.fn(() => false),
    show: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    webContents: {
      on: vi.fn(),
      once: vi.fn()
    }
  };
  electronMock.windows.push(spy);
  return spy;
}

vi.mock("electron", () => {
  class BrowserWindow {
    static fromId = electronMock.fromId;
    static getFocusedWindow = electronMock.getFocusedWindow;

    constructor(options: Record<string, unknown>) {
      electronMock.constructedOptions.push(options);
      return makeWindowSpy(options) as unknown as BrowserWindow;
    }
  }

  return {
    app: {
      getAppPath: () => "/fake/appPath",
      isPackaged: false
    },
    screen: {
      getDisplayMatching: electronMock.getDisplayMatching,
      getPrimaryDisplay: electronMock.getPrimaryDisplay
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
  getStartupBackgroundColor: () => "#000000"
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}));

describe("settings window placement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    electronMock.constructedOptions.length = 0;
    electronMock.windows.length = 0;
    electronMock.fromId.mockReset();
    electronMock.getFocusedWindow.mockReset();
    electronMock.getDisplayMatching.mockReset();
    electronMock.getPrimaryDisplay.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("centers a new Settings window on the source window display", async () => {
    const sourceWindow = makeWindowSpy({
      x: 2200,
      y: 100,
      width: 900,
      height: 700
    });
    electronMock.fromId.mockReturnValue(sourceWindow);
    electronMock.getDisplayMatching.mockReturnValue({
      workArea: { x: 1920, y: 0, width: 1920, height: 1080 }
    });

    const { createSettingsWindow } = await import("../window");
    createSettingsWindow(undefined, { sourceWindowId: 42 });

    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith({
      x: 2200,
      y: 100,
      width: 900,
      height: 700
    });
    expect(electronMock.constructedOptions[0]).toMatchObject({
      x: 2360,
      y: 180,
      width: 1040,
      height: 720,
      show: false,
      title: "PwrSnap Settings"
    });
  });
});
