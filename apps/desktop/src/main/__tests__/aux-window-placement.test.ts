import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type WindowSpy = {
  id: number;
  getBounds: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  isMinimized: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
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
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    restore: vi.fn(),
    focus: vi.fn(),
    show: vi.fn(),
    setPosition: vi.fn(),
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

  test("centers a new Settings window on explicit source bounds", async () => {
    const sourceBounds = { x: 3840, y: 0, width: 24, height: 24 };
    electronMock.getDisplayMatching.mockReturnValue({
      workArea: { x: 3840, y: 0, width: 1920, height: 1080 }
    });

    const { createSettingsWindow } = await import("../window");
    createSettingsWindow(undefined, { sourceBounds });

    expect(electronMock.fromId).not.toHaveBeenCalled();
    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith(sourceBounds);
    expect(electronMock.constructedOptions[0]).toMatchObject({
      x: 4280,
      y: 180,
      width: 1040,
      height: 720,
      show: false,
      title: "PwrSnap Settings"
    });
  });

  test("centers a new Sizzle window on the source window display", async () => {
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

    const { createSizzleWindow } = await import("../window");
    createSizzleWindow(undefined, { sourceWindowId: 42 });

    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith({
      x: 2200,
      y: 100,
      width: 900,
      height: 700
    });
    expect(electronMock.constructedOptions[0]).toMatchObject({
      x: 2240,
      y: 130,
      width: 1280,
      height: 820,
      show: false,
      title: "PwrSnap Sizzle Reels"
    });
  });

  test("centers a new document window on the source window display", async () => {
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

    const { showAppDocumentWindow } = await import("../window");
    showAppDocumentWindow("third-party-licenses", { sourceWindowId: 42 });

    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith({
      x: 2200,
      y: 100,
      width: 900,
      height: 700
    });
    expect(electronMock.constructedOptions[0]).toMatchObject({
      x: 2420,
      y: 160,
      width: 920,
      height: 760,
      show: false,
      title: "PwrSnap Third-party Licenses"
    });
  });

  test("moves an existing document window to the source window display", async () => {
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

    const { showAppDocumentWindow } = await import("../window");
    const documentWindow = showAppDocumentWindow("changelog", {
      sourceWindowId: 42
    }) as unknown as WindowSpy;
    electronMock.getDisplayMatching.mockClear();
    documentWindow.setPosition.mockClear();

    showAppDocumentWindow("changelog", { sourceWindowId: 42 });

    expect(electronMock.getDisplayMatching).toHaveBeenCalledWith({
      x: 2200,
      y: 100,
      width: 900,
      height: 700
    });
    expect(documentWindow.setPosition).toHaveBeenCalledWith(2420, 160, false);
    expect(documentWindow.focus).toHaveBeenCalledTimes(1);
  });
});
