// The Linux tray popover — reachable ONLY from the native menu, and placed by
// the compositor when the session is Wayland.
//
// The native menu is still the tray's primary surface on Linux (see
// tray-linux-native-menu.test.ts, which pins that split). What this file pins
// is the row that opens the RICH popover — the last-snap preview, the mode
// grid, the export presets — none of which the native menu can carry.
//
// What is NOT possible there, and is asserted as an absence rather than left
// to a comment: mounting the popover next to our own indicator. Three separate
// things would have to be true and on Wayland none of them are.
//
//   1. Know where the indicator is. `Tray.getBounds()` is `@platform
//      darwin,win32`; measured `{0,0,0,0}` on Linux.
//   2. Move a window there. `BrowserWindow.setPosition` is documented "Not
//      supported on Wayland (Linux)".
//   3. Anchor to a parent surface instead. The indicator is drawn by the
//      panel's process, so there is no surface of ours to anchor to, and
//      Electron exposes no xdg_positioner / layer-shell path.
//
// X11 keeps a real anchor: `setPosition` works there, and the pointer is on
// the indicator at the moment the row is clicked.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { MenuItemConstructorOptions } from "electron";

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];
  const ipcHandlers = new Map<string, (event: unknown, payload: unknown) => void>();
  const calls: string[] = [];

  function createWindow() {
    let destroyed = false;
    let visible = false;
    const window = {
      destroy: vi.fn(() => {
        destroyed = true;
      }),
      focus: vi.fn(),
      getSize: vi.fn(() => [440, 620] as [number, number]),
      hide: vi.fn(() => {
        visible = false;
        calls.push("hide");
      }),
      isDestroyed: vi.fn(() => destroyed),
      isVisible: vi.fn(() => visible),
      on: vi.fn(),
      setContentSize: vi.fn(),
      setMinimumSize: vi.fn(),
      setOpacity: vi.fn((value: number) => calls.push(`setOpacity(${value})`)),
      setPosition: vi.fn((x: number, y: number) => calls.push(`setPosition(${x},${y})`)),
      setVibrancy: vi.fn(),
      showInactive: vi.fn(() => {
        visible = true;
        calls.push("showInactive");
      }),
      webContents: { on: vi.fn(), send: vi.fn(), zoomFactor: 1 }
    };
    return window;
  }

  return {
    calls,
    windows,
    ipcHandlers,
    ozoneSwitch: "",
    createTrayWindow: vi.fn(() => {
      const window = createWindow();
      windows.push(window);
      return window;
    }),
    positionTrayWindow: vi.fn(),
    dispatch: vi.fn(async () => ({ ok: true, value: undefined })),
    recordingState: { phase: "idle" } as { phase: string }
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
    quit: vi.fn(),
    commandLine: { getSwitchValue: vi.fn(() => mocks.ozoneSwitch) }
  },
  ipcMain: {
    on: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => void) => {
      mocks.ipcHandlers.set(channel, handler);
    }),
    removeAllListeners: vi.fn((channel: string) => {
      mocks.ipcHandlers.delete(channel);
    })
  },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => ({ template })) },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn()
    }))
  },
  screen: {
    getDisplayMatching: vi.fn(),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })),
    getCursorScreenPoint: vi.fn(() => ({ x: 960, y: 12 })),
    getDisplayNearestPoint: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1920, height: 1080 }
    }))
  },
  Tray: vi.fn(function TrayMock() {
    return {
      on: vi.fn(),
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
      setTitle: vi.fn(),
      setIgnoreDoubleClickEvents: vi.fn(),
      getBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      popUpContextMenu: vi.fn(),
      destroy: vi.fn()
    };
  })
}));

vi.mock("../window", () => ({
  createTrayWindow: mocks.createTrayWindow,
  positionTrayWindow: mocks.positionTrayWindow
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

vi.mock("../linux-status-notifier-host", () => ({
  logLinuxTrayHostDiagnostics: vi.fn(async () => undefined)
}));

vi.mock("../recording/recording-state", () => ({
  getRecordingState: () => mocks.recordingState,
  isRecordingActive: () => mocks.recordingState.phase !== "idle",
  subscribeToRecordingState: () => () => undefined
}));

vi.mock("../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));

import {
  buildTrayContextMenuTemplate,
  disposeTray,
  LINUX_TRAY_FIRST_MEASURE_WAIT_MS
} from "../tray";
import { resetWindowPlacementLogForTests } from "../linux-window-placement";

const TRAY_RESIZE_CHANNEL = "tray:resize";
const POPOVER_ROW = "Show Last Capture…";

const realPlatform = process.platform;
const realEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setSessionEnv(env: Record<string, string>): void {
  for (const key of [
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "ELECTRON_OZONE_PLATFORM_HINT"
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
}

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
const X11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

function labelsOf(template: MenuItemConstructorOptions[]): Array<string | undefined> {
  return template.map((item) => item.label);
}

function popoverRow(platform: "linux" | "darwin" | "win32"): MenuItemConstructorOptions | undefined {
  return buildTrayContextMenuTemplate(undefined, platform).find(
    (item) => item.label === POPOVER_ROW
  );
}

/** Stand in for the renderer's ResizeObserver posting its measured height. */
function postRendererMeasurement(height: number): void {
  const handler = mocks.ipcHandlers.get(TRAY_RESIZE_CHANNEL);
  if (handler === undefined) throw new Error("tray resize channel was never wired");
  const window = mocks.windows.at(-1);
  handler({ sender: window?.webContents }, { height });
}

/** Click the menu row, let the renderer measure, and settle the open. */
async function openPopoverFromMenu(height = 620): Promise<void> {
  const row = popoverRow("linux");
  if (row?.click === undefined) throw new Error("no popover row in the Linux menu");
  (row.click as () => void)();
  postRendererMeasurement(height);
  await vi.waitFor(() => {
    expect(mocks.windows.at(-1)?.showInactive).toHaveBeenCalled();
  });
}

beforeEach(() => {
  disposeTray();
  resetWindowPlacementLogForTests();
  mocks.calls.length = 0;
  mocks.windows.length = 0;
  mocks.ipcHandlers.clear();
  mocks.ozoneSwitch = "";
  mocks.createTrayWindow.mockClear();
  mocks.positionTrayWindow.mockClear();
  mocks.dispatch.mockClear();
  setPlatform("linux");
  setSessionEnv(WAYLAND);
  mocks.ozoneSwitch = "wayland";
});

afterEach(() => {
  disposeTray();
  setPlatform(realPlatform);
  process.env = { ...realEnv };
});

describe("the menu row exists only where the popover has no other door", () => {
  test("Linux offers it", () => {
    expect(labelsOf(buildTrayContextMenuTemplate(undefined, "linux"))).toContain(
      POPOVER_ROW
    );
  });

  test("macOS and Windows do not — left-click already opens the popover", () => {
    expect(popoverRow("darwin")).toBeUndefined();
    expect(popoverRow("win32")).toBeUndefined();
  });

  test("the label is static, so the persistent D-Bus menu cannot go stale", () => {
    // The Linux menu is a PERSISTENT object republished only by
    // `refreshNativeTrayMenu`. A label naming the last capture, or saying
    // whether one exists, or flipping to "Hide" while open, would need a
    // per-capture republish — and a republish can close the menu under the
    // user's cursor.
    const first = popoverRow("linux")?.label;
    mocks.recordingState = { phase: "idle" };
    expect(popoverRow("linux")?.label).toBe(first);
    expect(first).not.toMatch(/\d/);
  });
});

describe("opening the popover from the menu row", () => {
  test("creates the popover window and shows it", async () => {
    expect(mocks.createTrayWindow).not.toHaveBeenCalled();
    await openPopoverFromMenu();
    expect(mocks.createTrayWindow).toHaveBeenCalledTimes(1);
    expect(mocks.calls).toContain("showInactive");
  });

  test("waits for the renderer's first measurement before showing", async () => {
    const row = popoverRow("linux");
    (row?.click as () => void)();
    // Window exists, renderer has not measured — nothing on screen yet, or the
    // user would watch it jump from the constructor frame to its real height.
    expect(mocks.windows.at(-1)?.showInactive).not.toHaveBeenCalled();
    postRendererMeasurement(620);
    await vi.waitFor(() => {
      expect(mocks.windows.at(-1)?.showInactive).toHaveBeenCalled();
    });
  });

  test("shows anyway if the renderer never measures", async () => {
    vi.useFakeTimers();
    try {
      const row = popoverRow("linux");
      (row?.click as () => void)();
      expect(mocks.windows.at(-1)?.showInactive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LINUX_TRAY_FIRST_MEASURE_WAIT_MS + 1);
      // A renderer that never posts must not cost the user the popover — it
      // opens at the constructor frame, which is why that frame is taller on
      // Linux than the 440 the other platforms construct at.
      expect(mocks.windows.at(-1)?.showInactive).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("the row toggles — the one dismissal that needs no keyboard focus", async () => {
    await openPopoverFromMenu();
    mocks.calls.length = 0;
    const row = popoverRow("linux");
    (row?.click as () => void)();
    // On Wayland the popover may never take focus (a client cannot activate
    // itself), so blur-dismiss and Escape can both be unavailable. Re-picking
    // the row needs neither.
    expect(mocks.calls).toEqual(["hide"]);
  });

  test("hides through hideTrayWindowNow — no bare hide(), no opacity on Linux", async () => {
    await openPopoverFromMenu();
    mocks.calls.length = 0;
    (popoverRow("linux")?.click as () => void)();
    // `setOpacity` is the macOS alpha-0 park and is inert on Linux; the
    // pairing invariant in tray-instant-hide.test.ts owns the general rule.
    expect(mocks.calls.filter((c) => c.startsWith("setOpacity"))).toEqual([]);
  });

  test("Escape is wired on Linux, where a click outside may not dismiss", async () => {
    await openPopoverFromMenu();
    const window = mocks.windows.at(-1);
    const registered = window?.webContents.on.mock.calls.map((c) => c[0]) ?? [];
    expect(registered).toContain("before-input-event");

    mocks.calls.length = 0;
    const handler = window?.webContents.on.mock.calls.find(
      (c) => c[0] === "before-input-event"
    )?.[1] as (event: unknown, input: { type: string; key: string }) => void;
    handler({}, { type: "keyDown", key: "Escape" });
    expect(mocks.calls).toEqual(["hide"]);

    // A key that is not Escape must not close it.
    mocks.calls.length = 0;
    handler({}, { type: "keyDown", key: "a" });
    expect(mocks.calls).toEqual([]);
  });
});

describe("placement — attempted only where it can land", () => {
  test("Wayland: the popover is NOT positioned, because it cannot be", async () => {
    setSessionEnv(WAYLAND);
    mocks.ozoneSwitch = "wayland";
    await openPopoverFromMenu();
    expect(mocks.calls.filter((c) => c.startsWith("setPosition"))).toEqual([]);
    // And never through the macOS/Windows anchor either — `tray.getBounds()`
    // is zeros on Linux, so there is no rectangle to consume.
    expect(mocks.positionTrayWindow).not.toHaveBeenCalled();
  });

  test("X11: anchored under the cursor, which is on the indicator", async () => {
    setSessionEnv(X11);
    mocks.ozoneSwitch = "x11";
    await openPopoverFromMenu();
    // Cursor (960, 12), window 440x620, 1920x1080 work area, 8px margin:
    // x centred on the pointer, y just below it.
    expect(mocks.calls).toContain("setPosition(740,20)");
    expect(mocks.positionTrayWindow).not.toHaveBeenCalled();
  });

  test("X11: clamped into the work area for a bottom panel", async () => {
    setSessionEnv(X11);
    mocks.ozoneSwitch = "x11";
    const { screen } = await import("electron");
    vi.mocked(screen.getCursorScreenPoint).mockReturnValueOnce({ x: 1900, y: 1070 });
    await openPopoverFromMenu();
    // Clamped to the right edge (1920-440-8) and up above the pointer
    // (1080-620-8) — which is what makes this correct for a bottom panel.
    expect(mocks.calls).toContain("setPosition(1472,452)");
  });
});
