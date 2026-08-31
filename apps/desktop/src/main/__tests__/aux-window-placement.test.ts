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
    id: number;
    isDestroyed: ReturnType<typeof vi.fn>;
    mainFrame: { processId: number; routingId: number };
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
      id: 100 + electronMock.windows.length,
      isDestroyed: vi.fn(() => false),
      mainFrame: { processId: 17, routingId: 29 },
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
  getStartupBackgroundColor: () => "#000000",
  // window.ts reads STARTUP_BG_DARK to pick the Windows title-bar overlay color
  // (the win32 branch of platformWindowChrome runs on the Windows CI runner).
  STARTUP_BG_DARK: "#000000",
  STARTUP_BG_LIGHT: "#ffffff"
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
      x: 2160,
      y: 110,
      width: 1440,
      height: 860,
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
      x: 4080,
      y: 110,
      width: 1440,
      height: 860,
      show: false,
      title: "PwrSnap Settings"
    });
  });

  test("clamps the expanded Settings window to a smaller display", async () => {
    electronMock.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 24, width: 1024, height: 700 }
    });

    const { createSettingsWindow } = await import("../window");
    createSettingsWindow();

    expect(electronMock.constructedOptions[0]).toMatchObject({
      x: 0,
      y: 24,
      width: 1024,
      height: 700,
      show: false,
      title: "PwrSnap Settings"
    });
  });

  test("Settings close fences the exact loaded renderer document", async () => {
    electronMock.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    const [{ createSettingsWindow }, { bus }, recorderDocument] = await Promise.all([
      import("../window"),
      import("../command-bus"),
      import("../hotkeys/hotkey-recorder-document")
    ]);
    const dispatchSpy = vi
      .spyOn(bus, "dispatch")
      .mockResolvedValue({ ok: true, value: { ended: true } } as never);
    const settings = createSettingsWindow() as unknown as WindowSpy;
    const didFinishLoad = settings.webContents.on.mock.calls.find(
      ([event]) => event === "did-finish-load"
    )?.[1] as (() => void) | undefined;
    const close = settings.on.mock.calls.find(([event]) => event === "close")?.[1] as
      | (() => void)
      | undefined;

    didFinishLoad?.();
    recorderDocument.admitHotkeyRecorderDocument(
      settings.webContents.id,
      "documentepoch0001"
    );
    close?.();

    expect(dispatchSpy).toHaveBeenCalledWith(
      "settings:endHotkeyRecording",
      {
        ownerWindowId: settings.id,
        ownerDocumentId: "documentepoch0001",
        reason: "window-closed"
      },
      { principal: "bridge" }
    );
  });

  test("full navigation fences the old document while in-page navigation does not", async () => {
    electronMock.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    const [{ createSettingsWindow }, { bus }, recorderDocument] = await Promise.all([
      import("../window"),
      import("../command-bus"),
      import("../hotkeys/hotkey-recorder-document")
    ]);
    const dispatchSpy = vi
      .spyOn(bus, "dispatch")
      .mockResolvedValue({ ok: true, value: { ended: true } } as never);
    const settings = createSettingsWindow() as unknown as WindowSpy;
    const didFinishLoad = settings.webContents.on.mock.calls.find(
      ([event]) => event === "did-finish-load"
    )?.[1] as (() => void) | undefined;
    const didStartNavigation = settings.webContents.on.mock.calls.find(
      ([event]) => event === "did-start-navigation"
    )?.[1] as
      | ((event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
      | undefined;

    didFinishLoad?.();
    recorderDocument.admitHotkeyRecorderDocument(
      settings.webContents.id,
      "documentepoch0001"
    );
    didStartNavigation?.({}, "app://settings#storage", true, true);
    expect(dispatchSpy).not.toHaveBeenCalled();

    didStartNavigation?.({}, "app://settings", false, true);
    expect(dispatchSpy).toHaveBeenCalledWith(
      "settings:endHotkeyRecording",
      {
        ownerWindowId: settings.id,
        ownerDocumentId: "documentepoch0001",
        reason: "navigation"
      },
      { principal: "bridge" }
    );
  });

  test("an unresponsive Settings renderer is released and re-admitted on recovery", async () => {
    electronMock.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    });
    const [{ createSettingsWindow }, { bus }, recorderDocument] = await Promise.all([
      import("../window"),
      import("../command-bus"),
      import("../hotkeys/hotkey-recorder-document")
    ]);
    const dispatchSpy = vi
      .spyOn(bus, "dispatch")
      .mockResolvedValue({ ok: true, value: { ended: true } } as never);
    const settings = createSettingsWindow() as unknown as WindowSpy;
    const didFinishLoad = settings.webContents.on.mock.calls.find(
      ([event]) => event === "did-finish-load"
    )?.[1] as (() => void) | undefined;
    const unresponsive = settings.webContents.on.mock.calls.find(
      ([event]) => event === "unresponsive"
    )?.[1] as (() => void) | undefined;
    const responsive = settings.webContents.on.mock.calls.find(
      ([event]) => event === "responsive"
    )?.[1] as (() => void) | undefined;

    didFinishLoad?.();
    recorderDocument.admitHotkeyRecorderDocument(
      settings.webContents.id,
      "documentepoch0001"
    );
    unresponsive?.();
    responsive?.();

    expect(dispatchSpy).toHaveBeenNthCalledWith(
      1,
      "settings:endHotkeyRecording",
      {
        ownerWindowId: settings.id,
        ownerDocumentId: "documentepoch0001",
        reason: "unresponsive"
      },
      { principal: "bridge" }
    );
    expect(dispatchSpy).toHaveBeenNthCalledWith(
      2,
      "settings:resumeHotkeyRecordingOwner",
      {
        ownerWindowId: settings.id,
        ownerDocumentId: "documentepoch0001"
      },
      { principal: "bridge" }
    );
    expect(
      recorderDocument.isLiveHotkeyRecorderDocument(
        settings.webContents.id,
        "documentepoch0001"
      )
    ).toBe(true);
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
