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
  windows: [] as WindowSpy[],
  appListeners: {} as Record<string, Array<(...args: unknown[]) => void>>
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
      isPackaged: false,
      on: (event: string, listener: (...args: unknown[]) => void) => {
        (electronMock.appListeners[event] ??= []).push(listener);
      }
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

function emitAppEvent(event: string, ...args: unknown[]): void {
  for (const listener of electronMock.appListeners[event] ?? []) listener({}, ...args);
}

/**
 * Production wiring for the Dock-click rule in app-window-focus-order.ts:
 * the activate path raises the destination window the user focused last,
 * not the Library. The pre-fix handler in index.ts always focused the
 * Library, so a Settings window in front came back behind it.
 */
describe("Dock click (app activate) raises the last focused window", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    electronMock.constructedOptions.length = 0;
    electronMock.windows.length = 0;
    for (const key of Object.keys(electronMock.appListeners)) delete electronMock.appListeners[key];
    electronMock.getPrimaryDisplay.mockReturnValue({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("brings back whichever destination window was focused most recently", async () => {
    const { createSettingsWindow, installAppWindowFocusTracking, raiseWindowForAppActivate, showAppDocumentWindow } =
      await import("../window");
    installAppWindowFocusTracking();
    const settings = createSettingsWindow() as unknown as WindowSpy;
    const doc = showAppDocumentWindow("changelog") as unknown as WindowSpy;

    emitAppEvent("browser-window-focus", doc);
    emitAppEvent("browser-window-focus", settings);
    settings.focus.mockClear();
    doc.focus.mockClear();

    expect(raiseWindowForAppActivate()).toBe(settings);
    expect(settings.focus).toHaveBeenCalledTimes(1);
    expect(doc.focus).not.toHaveBeenCalled();
  });

  test("chrome taking focus (focus sink, tray, float-over) is never what comes back", async () => {
    const electron = await import("electron");
    const { createSettingsWindow, installAppWindowFocusTracking, raiseWindowForAppActivate } =
      await import("../window");
    installAppWindowFocusTracking();
    const settings = createSettingsWindow() as unknown as WindowSpy;
    const sink = new electron.BrowserWindow({}) as unknown as WindowSpy;

    emitAppEvent("browser-window-focus", settings);
    emitAppEvent("browser-window-focus", sink);

    expect(raiseWindowForAppActivate()).toBe(settings);
    expect(sink.focus).not.toHaveBeenCalled();
  });

  test("a window another app covers still comes back (macOS isVisible() is false when occluded)", async () => {
    const { createSettingsWindow, installAppWindowFocusTracking, raiseWindowForAppActivate, showAppDocumentWindow } =
      await import("../window");
    installAppWindowFocusTracking();
    const doc = showAppDocumentWindow("changelog") as unknown as WindowSpy;
    const settings = createSettingsWindow() as unknown as WindowSpy;
    emitAppEvent("browser-window-focus", doc);
    emitAppEvent("browser-window-focus", settings);
    // The app the user switched to fully covers Settings.
    settings.isVisible.mockReturnValue(false);
    doc.focus.mockClear();

    expect(raiseWindowForAppActivate()).toBe(settings);
    expect(doc.focus).not.toHaveBeenCalled();
  });

  test("a closed window is forgotten as soon as it closes", async () => {
    const { createSettingsWindow, installAppWindowFocusTracking } = await import("../window");
    installAppWindowFocusTracking();
    const settings = createSettingsWindow() as unknown as WindowSpy;
    emitAppEvent("browser-window-focus", settings);
    expect(settings.once).toHaveBeenCalledWith("closed", expect.any(Function));
  });

  test("a minimized last window is restored when nothing else is on screen", async () => {
    const { createSettingsWindow, installAppWindowFocusTracking, raiseWindowForAppActivate } =
      await import("../window");
    installAppWindowFocusTracking();
    const settings = createSettingsWindow() as unknown as WindowSpy;
    emitAppEvent("browser-window-focus", settings);
    settings.isMinimized.mockReturnValue(true);

    expect(raiseWindowForAppActivate()).toBe(settings);
    expect(settings.restore).toHaveBeenCalledTimes(1);
  });

  test("index.ts routes the activate event through raiseWindowForAppActivate", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const start = source.indexOf('app.on("activate"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf("});", start));
    expect(handler).toContain("raiseWindowForAppActivate()");
    expect(handler).not.toContain("findMainLibraryWindow");
    expect(source).toContain("installAppWindowFocusTracking()");
  });

  test("index.ts routes a relaunch (second-instance) through the same rule", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const source = await readFile(fileURLToPath(new URL("../index.ts", import.meta.url)), "utf8");
    const start = source.indexOf('app.on("second-instance"');
    expect(start).toBeGreaterThan(-1);
    // The handler's own raise sits right after its split-mode early return.
    const handler = source.slice(start, source.indexOf("// If the second instance", start));
    expect(handler).toContain("raiseWindowForAppActivate()");
    expect(handler).not.toMatch(/findMainLibraryWindow\(\) \?\? createMainWindow\(\)/);
  });
});
