// On Linux the tray IS the native menu, and `setContextMenu` is the call
// that makes it exist.
//
// PwrSnap shipped with no Linux tray at all: the indicator was created, and
// then every affordance attached to it was wired to an API Electron declares
// `@platform darwin,win32`. `popUpContextMenu()` and the `right-click` event
// are both macOS/Windows-only, so the context menu could never be raised;
// `getBounds()` is macOS/Windows-only, so `positionTrayWindow` had no
// rectangle to anchor the popover to; and under Wayland `setPosition` is
// inert regardless. `setContextMenu` — the one menu API with no platform
// annotation — was never called, which is also the shape in which some SNI
// hosts decline to draw an item whose `Menu` property they cannot resolve.
//
// So this file pins the split rather than the symptom:
//   • Linux publishes a real menu, and re-publishes it on every input that
//     can change a label (Electron's docs: "in order for changes made to
//     individual MenuItems to take effect, you have to call setContextMenu
//     again").
//   • Linux never builds the popover BrowserWindow.
//   • macOS and Windows never call `setContextMenu` — on an NSStatusItem
//     that would hand left-click to the menu and suppress the `click` event
//     the popover is toggled from, silently deleting the popover UI on the
//     two platforms where it works.
//
// The show/hide pairing invariant for the popover lives in
// tray-instant-hide.test.ts; nothing here touches the popover platforms'
// visibility transitions.

import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { RecordingBackendCapabilities, RecordingState } from "@pwrsnap/shared";
import { DEFAULT_HOTKEYS, type HotkeyRegistrationStatusSnapshot } from "@pwrsnap/shared";

type TrayStub = {
  calls: string[];
  contextMenus: unknown[];
  templates: unknown[][];
  titles: string[];
  tooltips: string[];
  iconArg: unknown;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  setContextMenu: (menu: unknown) => void;
  setToolTip: (text: string) => void;
  setTitle: (text: string) => void;
  setIgnoreDoubleClickEvents: (ignore: boolean) => void;
  getBounds: () => { x: number; y: number; width: number; height: number };
  popUpContextMenu: (menu?: unknown) => void;
  destroy: () => void;
};

const mocks = vi.hoisted(() => ({
  trays: [] as unknown[],
  trayHandlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  createTrayWindow: vi.fn(),
  positionTrayWindow: vi.fn(),
  templateNumber: 0,
  recordingState: { phase: "idle" } as RecordingState,
  recordingSubscribers: [] as Array<(state: RecordingState) => void>,
  capabilitiesFor: null as
    | ((platform: NodeJS.Platform) => RecordingBackendCapabilities)
    | null,
  logDiagnostics: vi.fn(async () => undefined),
  setTemplateImage: vi.fn(),
  /** Paths handed to `nativeImage.createFromPath`, in call order. */
  iconPaths: [] as string[],
  /** Make the loaded image report itself as empty, as a missing file would. */
  iconIsEmpty: false,
  /** Simulate a platform that refuses the menu — e.g. no session bus. */
  buildThrows: false,
  dispatch: vi.fn(async () => ({ ok: true, value: undefined }))
}));

function latestTray(): TrayStub {
  const tray = mocks.trays.at(-1) as TrayStub | undefined;
  if (tray === undefined) throw new Error("no Tray was constructed");
  return tray;
}

vi.mock("electron", () => ({
  app: { getAppPath: () => "/fake/app", quit: vi.fn() },
  ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() },
  Menu: {
    // Tag each built menu so a re-publish is distinguishable from the
    // original — the whole point of the refresh assertions is that a NEW
    // menu object reaches setContextMenu, not the same one twice.
    buildFromTemplate: vi.fn((template: unknown) => {
      if (mocks.buildThrows) throw new Error("no session bus");
      mocks.templateNumber += 1;
      return { id: mocks.templateNumber, template };
    })
  },
  nativeImage: {
    createFromPath: vi.fn((iconPath: string) => {
      mocks.iconPaths.push(iconPath);
      return {
        __nativeImage: true,
        isEmpty: () => mocks.iconIsEmpty,
        setTemplateImage: mocks.setTemplateImage
      };
    })
  },
  screen: {
    getDisplayMatching: vi.fn(),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 }))
  },
  Tray: vi.fn(function TrayMock(icon: unknown) {
    const stub: TrayStub = {
      calls: [],
      contextMenus: [],
      templates: [],
      titles: [],
      tooltips: [],
      iconArg: icon,
      on: (event, cb) => {
        const list = mocks.trayHandlers.get(event) ?? [];
        list.push(cb);
        mocks.trayHandlers.set(event, list);
      },
      setContextMenu: (menu) => {
        stub.calls.push("setContextMenu");
        stub.contextMenus.push(menu);
        stub.templates.push((menu as { template: unknown[] }).template);
      },
      setToolTip: (text) => {
        stub.calls.push("setToolTip");
        stub.tooltips.push(text);
      },
      setTitle: (text) => {
        stub.calls.push("setTitle");
        stub.titles.push(text);
      },
      setIgnoreDoubleClickEvents: () => {
        stub.calls.push("setIgnoreDoubleClickEvents");
      },
      getBounds: () => ({ x: 100, y: 0, width: 24, height: 24 }),
      popUpContextMenu: () => {
        stub.calls.push("popUpContextMenu");
      },
      destroy: () => {
        stub.calls.push("destroy");
      }
    };
    mocks.trays.push(stub);
    return stub;
  })
}));

vi.mock("../window", () => ({
  createTrayWindow: mocks.createTrayWindow,
  positionTrayWindow: mocks.positionTrayWindow
}));

vi.mock("../log", () => ({
  getMainLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

vi.mock("../linux-status-notifier-host", () => ({
  logLinuxTrayHostDiagnostics: mocks.logDiagnostics
}));

vi.mock("../recording/recording-state", () => ({
  getRecordingState: () => mocks.recordingState,
  isRecordingActive: () => mocks.recordingState.phase !== "idle",
  subscribeToRecordingState: (handler: (state: RecordingState) => void) => {
    mocks.recordingSubscribers.push(handler);
    handler(mocks.recordingState);
    return () => undefined;
  }
}));

vi.mock("../recording/recording-capabilities", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../recording/recording-capabilities")
  >();
  return {
    ...actual,
    recordingBackendCapabilities: (platform: NodeJS.Platform = process.platform) =>
      mocks.capabilitiesFor?.(platform) ?? actual.recordingBackendCapabilities(platform)
  };
});

vi.mock("../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));

import { ipcMain as electronIpcMain } from "electron";
import {
  buildTrayContextMenuTemplate,
  disposeTray,
  installTray,
  setExtraTrayMenuItems,
  setTrayHotkeys,
  traySurfaceForPlatform
} from "../tray";

const realPlatform = process.platform;
const realResourcesPath = process.resourcesPath;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", { value, configurable: true });
}

/** Drive the main-side recording-state fan-out `installTray` subscribes to. */
function emitRecordingState(state: RecordingState): void {
  mocks.recordingState = state;
  for (const handler of mocks.recordingSubscribers) handler(state);
}

function labelsOf(template: unknown[]): Array<string | undefined> {
  return (template as Array<{ label?: string }>).map((item) => item.label);
}

/**
 * A COMPLETE registration snapshot reporting every hotkey as owned by
 * PwrSnap. Complete on purpose: `activeTrayAccelerator` indexes the snapshot
 * by key, and a partial object typed through `as` would crash menu
 * construction in a way production cannot — the real resolver always returns
 * every key.
 */
function activeStatusFor(
  hotkeys: typeof DEFAULT_HOTKEYS
): () => HotkeyRegistrationStatusSnapshot {
  const snapshot = Object.fromEntries(
    Object.entries(hotkeys).map(([key, accelerator]) => [
      key,
      { state: "active", accelerator }
    ])
  ) as HotkeyRegistrationStatusSnapshot;
  return () => snapshot;
}

beforeEach(() => {
  disposeTray();
  // `/fake/resources` does not exist, so resolveTrayIconPath falls through to
  // the workspace `build/` dir — deterministic on every host.
  setResourcesPath("/fake/resources");
  mocks.trays.length = 0;
  mocks.trayHandlers.clear();
  mocks.recordingSubscribers.length = 0;
  mocks.recordingState = { phase: "idle" };
  mocks.capabilitiesFor = null;
  mocks.templateNumber = 0;
  mocks.buildThrows = false;
  mocks.iconPaths.length = 0;
  mocks.iconIsEmpty = false;
  mocks.setTemplateImage.mockReset();
  mocks.createTrayWindow.mockReset();
  mocks.positionTrayWindow.mockReset();
  mocks.logDiagnostics.mockClear();
  mocks.dispatch.mockClear();
});

afterEach(() => {
  disposeTray();
  setPlatform(realPlatform);
  setResourcesPath(realResourcesPath);
});

describe("traySurfaceForPlatform", () => {
  test("only Linux gets the native menu", () => {
    expect(traySurfaceForPlatform("darwin")).toBe("popover");
    expect(traySurfaceForPlatform("win32")).toBe("popover");
    expect(traySurfaceForPlatform("linux")).toBe("native-menu");
  });
});

describe("installTray on Linux", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  test("publishes a context menu — the call that makes the indicator usable", () => {
    installTray();

    const tray = latestTray();
    expect(tray.calls).toContain("setContextMenu");
    // A real menu with real items, not a placeholder. These are the actions
    // that are otherwise unreachable on Linux: `popUpContextMenu` and
    // `right-click` are both @platform darwin,win32.
    expect(labelsOf(tray.templates[0]!)).toEqual(
      expect.arrayContaining([
        "Quick Capture…",
        "Record Video…",
        "Open Library",
        "Settings…",
        "Quit PwrSnap"
      ])
    );
  });

  test("never builds the popover BrowserWindow", () => {
    installTray();

    // No anchor rectangle, no way to open it, and no positioning under
    // Wayland — so the renderer is not spawned at all.
    expect(mocks.createTrayWindow).not.toHaveBeenCalled();
    expect(mocks.positionTrayWindow).not.toHaveBeenCalled();
    // And no resize channel either: `tray:resize` only ever arrives from the
    // popover renderer, so registering a listener for it on Linux would be a
    // handler for a message that cannot be sent.
    expect(vi.mocked(electronIpcMain.on)).not.toHaveBeenCalled();
  });

  test("wires no popover-only tray events", () => {
    installTray();

    // `right-click` and `double-click` are @platform darwin,win32 and would
    // never fire; `click` fires on an SNI activation whose gesture is
    // host-defined, and with a published menu the host shows the menu
    // instead. Registering any of them would imply a Linux affordance that
    // does not exist.
    expect([...mocks.trayHandlers.keys()]).toEqual([]);
    expect(latestTray().calls).not.toContain("setIgnoreDoubleClickEvents");
  });

  test("loads the bare 48px Linux icon file, not the @Nx set", () => {
    installTray();

    // StatusIconLinuxDbus publishes the image's scale-1 bitmap into the SNI
    // IconPixmap property. For `tray-icon.png` that is the 16×16 base — the
    // @2x/@3x siblings are representations of one 16pt image and are never
    // the one published — so a HiDPI panel upscales 16px.
    // `tray-icon-linux.png` is 48px with no siblings.
    //
    // Joined, not a literal: `resolveTrayIconPath` builds the path with
    // `node:path`, which picks its separator from the REAL platform at import
    // and ignores the `process.platform` this suite fakes. A hardcoded "/"
    // passes locally and on the macOS runner, then fails on the Windows one
    // with backslashes — which is exactly what it did.
    expect(mocks.iconPaths).toEqual([join("/fake/app", "build", "tray-icon-linux.png")]);
    // Template images are a macOS concept; marking a colored icon as one
    // blanks it out.
    expect(mocks.setTemplateImage).not.toHaveBeenCalled();
  });

  test("hands Tray the NativeImage, never the path", () => {
    installTray();

    // Measured on Electron 41.10.7 under Linux: `new Tray(<missing path>)`
    // THROWS ("Failed to load image from path") where
    // `new Tray(<empty NativeImage>)` returns normally — and the NativeImage
    // form publishes an identical pixmap. Since `installTray` runs un-awaited
    // inside `app.whenReady().then(...)`, the path form turns a missing icon
    // resource into an aborted boot.
    expect(latestTray().iconArg).toMatchObject({ __nativeImage: true });
    expect(typeof latestTray().iconArg).not.toBe("string");
  });

  test("a missing icon file warns and still installs a working tray", () => {
    mocks.iconIsEmpty = true;

    // The whole reason the NativeImage form is used: a blank icon is
    // recoverable and diagnosable, an aborted boot is neither. The menu must
    // still publish so the user can reach Quit and Settings.
    expect(() => installTray()).not.toThrow();
    expect(latestTray().calls).toContain("setContextMenu");
  });

  test("logs the StatusNotifierItem host diagnostic without gating the tray", () => {
    const tray = installTray();

    expect(mocks.logDiagnostics).toHaveBeenCalledTimes(1);
    // An SNI host that starts after us is picked up by Chromium's own
    // NameOwnerChanged handling, so a missing host at boot must not stop the
    // Tray from being created.
    expect(tray).toBe(latestTray());
    expect(latestTray().calls).toContain("setContextMenu");
  });

  test("never calls setTitle — it is @platform darwin", () => {
    installTray();
    emitRecordingState({
      phase: "countdown",
      sessionId: "rec-1",
      secondsRemaining: 2,
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1
    });

    expect(latestTray().calls).not.toContain("setTitle");
    // The tooltip is what carries the signal instead.
    expect(latestTray().tooltips.at(-1)).toBe("PwrSnap — recording starts in 2…");
  });
});

describe("the Linux menu is re-published on every input that can change it", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  /** Count of distinct menus handed to setContextMenu. */
  function publishCount(): number {
    return latestTray().contextMenus.length;
  }

  test("a recording-phase change replaces the published menu", () => {
    installTray();
    const before = publishCount();
    expect(labelsOf(latestTray().templates.at(-1)!)[0]).toBe("Quick Capture…");

    // `stopping` is the one recording row that is NOT capability-gated, so it
    // renders under the REAL `recordingBackendCapabilities("linux")`
    // (`backend: "unsupported"`) — no mocked backend needed to observe the
    // republish. The Stop/Restart/Cancel rows are gated and correctly absent
    // on Linux, which is why they are not the probe here.
    emitRecordingState({ phase: "stopping", sessionId: "rec-1" });

    // Electron's docs are explicit: "in order for changes made to individual
    // MenuItems to take effect, you have to call setContextMenu again."
    // Without this the top rows stay frozen at whatever was published first.
    expect(publishCount()).toBe(before + 1);
    expect(labelsOf(latestTray().templates.at(-1)!)[0]).toBe("Finalizing recording…");
  });

  test("a hotkey change replaces the published menu", () => {
    installTray();
    const before = publishCount();

    const hotkeys = { ...DEFAULT_HOTKEYS, quickCapture: "Control+Shift+C" };
    setTrayHotkeys(hotkeys, activeStatusFor(hotkeys));

    expect(publishCount()).toBe(before + 1);
    // The labels advertise the accelerators PwrSnap currently owns.
    expect(latestTray().templates.at(-1)![0]).toMatchObject({
      label: "Quick Capture…",
      accelerator: "Control+Shift+C",
      registerAccelerator: false
    });
  });

  test("the dev seeder's extra items republish on both set and restore", () => {
    installTray();
    const before = publishCount();

    const restore = setExtraTrayMenuItems([{ label: "Seed perf dataset" }]);
    expect(publishCount()).toBe(before + 1);
    expect(labelsOf(latestTray().templates.at(-1)!)).toContain("Seed perf dataset");

    restore();
    expect(publishCount()).toBe(before + 2);
    expect(labelsOf(latestTray().templates.at(-1)!)).not.toContain("Seed perf dataset");
  });

  test("refreshing before installTray is a no-op, not a crash", () => {
    // `setTrayHotkeys` runs during boot on some paths before the tray exists.
    expect(() => setTrayHotkeys(DEFAULT_HOTKEYS, activeStatusFor(DEFAULT_HOTKEYS))).not.toThrow();
    expect(mocks.trays).toHaveLength(0);
  });
});

describe("the menu is published only when it would look different", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  function publishCount(): number {
    return latestTray().contextMenus.length;
  }

  test("boot publishes exactly once", () => {
    installTray();

    // `subscribeToRecordingState` invokes its handler synchronously on
    // subscribe, which reaches `refreshNativeTrayMenu` before the native-menu
    // arm's own call does — so without change detection boot exported two
    // identical menus.
    expect(publishCount()).toBe(1);
  });

  test("a settings write that changes no label publishes nothing", () => {
    installTray();
    const hotkeys = { ...DEFAULT_HOTKEYS, quickCapture: "Control+Shift+C" };
    setTrayHotkeys(hotkeys, activeStatusFor(hotkeys));
    const afterRealChange = publishCount();

    // `setTrayHotkeys` is wired to `onSettingsChanged`, which broadcasts on
    // EVERY settings and secret write — a theme toggle, an AI provider
    // change, anything. Re-exporting the menu for those is not just waste:
    // `setContextMenu` replaces the exported object, and some SNI hosts close
    // an open menu when it is replaced.
    setTrayHotkeys(hotkeys, activeStatusFor(hotkeys));
    setTrayHotkeys(hotkeys, activeStatusFor(hotkeys));

    expect(publishCount()).toBe(afterRealChange);
  });

  test("a phase change that does alter a label still publishes", () => {
    installTray();
    const before = publishCount();

    emitRecordingState({ phase: "stopping", sessionId: "rec-1" });

    // Change detection must not suppress a real change — the whole point of
    // the refresh is that a persistent D-Bus menu cannot go stale.
    expect(publishCount()).toBe(before + 1);
    expect(labelsOf(latestTray().templates.at(-1)!)[0]).toBe("Finalizing recording…");
  });

  test("a submenu label change is not mistaken for no change", () => {
    installTray();
    const restore = setExtraTrayMenuItems([
      { label: "Seed perf dataset", submenu: [{ label: "profile-a" }] }
    ]);
    const afterFirst = publishCount();

    // The dev seeder's items are submenus, so a signature that stopped at the
    // top level would see "Seed perf dataset" both times and skip the export.
    setExtraTrayMenuItems([
      { label: "Seed perf dataset", submenu: [{ label: "profile-b" }] }
    ]);

    expect(publishCount()).toBe(afterFirst + 1);
    restore();
  });

  test("a failed publish is not remembered, so the next refresh retries", () => {
    installTray();
    const before = publishCount();
    mocks.buildThrows = true;
    emitRecordingState({ phase: "stopping", sessionId: "rec-1" });
    expect(publishCount()).toBe(before);

    // Recording the signature of a menu that never reached the host would
    // make every later refresh a no-op — the tray would stay frozen at the
    // last menu that DID publish, with no way back.
    mocks.buildThrows = false;
    emitRecordingState({ phase: "processing", sessionId: "rec-1" });

    expect(publishCount()).toBe(before + 1);
    expect(labelsOf(latestTray().templates.at(-1)!)[0]).toBe("Processing recording…");
  });
});

describe("a failed publish does not take the app down", () => {
  beforeEach(() => {
    setPlatform("linux");
  });

  test("installTray survives a throwing menu build", () => {
    // `installTray` runs un-awaited inside `app.whenReady().then(...)`, so a
    // throw here aborts the rest of the boot — the focus sink, the selector
    // pre-warm, everything after it. A tray that does nothing is the failure
    // this change exists to fix; it is not a reason to lose the app too.
    mocks.buildThrows = true;

    expect(() => installTray()).not.toThrow();
    expect(mocks.trays).toHaveLength(1);
  });

  test("a hotkey update survives a throwing menu build", () => {
    installTray();
    mocks.buildThrows = true;

    // `setTrayHotkeys` runs on every settings write. A throw would surface to
    // the user as a failed settings patch — a menu that could not be
    // published must not cost the user their preference change.
    expect(() =>
      setTrayHotkeys(DEFAULT_HOTKEYS, activeStatusFor(DEFAULT_HOTKEYS))
    ).not.toThrow();
  });

  test("a recording transition survives a throwing menu build", () => {
    installTray();
    mocks.buildThrows = true;

    expect(() =>
      emitRecordingState({ phase: "stopping", sessionId: "rec-1" })
    ).not.toThrow();
    // The tooltip still lands — the failure is contained to the menu.
    expect(latestTray().tooltips.at(-1)).toBe("PwrSnap — finalizing recording");
  });
});

describe("the popover platforms keep their own surface", () => {
  test.each(["darwin", "win32"] as const)(
    "%s never publishes a persistent context menu",
    (platform) => {
      setPlatform(platform);
      mocks.createTrayWindow.mockImplementation(() => {
        throw new Error("popover window not needed for this assertion");
      });

      // The popover pre-warm constructs the window; swallow it so this test
      // stays about the menu and nothing else.
      try {
        installTray();
      } catch {
        /* expected — see above */
      }

      // On an NSStatusItem, setContextMenu hands left-click to the menu and
      // suppresses the `click` event `toggleTrayWindow` is wired to. That
      // would delete the popover UI on the two platforms where it works.
      expect(latestTray().calls).not.toContain("setContextMenu");
      expect(mocks.logDiagnostics).not.toHaveBeenCalled();
    }
  );
});

describe("a persistent menu carries no elapsed clock", () => {
  /**
   * Not reachable in production today: `recordingBackendCapabilities("linux")`
   * reports `backend: "unsupported"` with every control false, so the `stop`
   * guard excludes the recording rows on Linux entirely. Mock a capable Linux
   * backend to reach the branch — the freeze is a property of the PERSISTENT
   * MENU, not of the recorder, and whoever lands a Linux recording backend
   * should inherit the fix rather than rediscover the bug.
   */
  beforeEach(() => {
    mocks.recordingState = {
      phase: "recording",
      sessionId: "rec-1",
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      rect: { x: 0, y: 0, w: 800, h: 600 },
      displayId: 1,
      capabilities: { systemAudio: false, microphone: false }
    };
    mocks.capabilitiesFor = () => ({
      backend: "macos-native",
      controls: { stop: true, cancel: true, restart: true, pauseResume: false },
      sources: {
        screen: true,
        systemAudio: false,
        microphone: false,
        webcam: false,
        liveAudioLevels: false,
        liveDisconnectDetection: false,
        midRecordingToggles: false
      },
      controllerExcludedFromCapture: false
    });
  });

  test("Linux omits it; macOS and Windows keep it", () => {
    // `phase: "recording"` is set exactly once by recording-service.ts, so a
    // persistent menu would hold whatever second it was published on forever.
    expect(labelsOf(buildTrayContextMenuTemplate(undefined, "linux"))[0]).toBe(
      "● Recording — Stop and Save"
    );
    // The popover platforms rebuild the template inside the `right-click`
    // handler, so their clock is always fresh.
    expect(labelsOf(buildTrayContextMenuTemplate(undefined, "darwin"))[0]).toMatch(
      /^● Recording 01:0[45] — Stop and Save$/
    );
    expect(labelsOf(buildTrayContextMenuTemplate(undefined, "win32"))[0]).toMatch(
      /^● Recording 01:0[45] — Stop and Save$/
    );
  });

  test("Stop and Save still works from the Linux menu", () => {
    const stop = (
      buildTrayContextMenuTemplate(undefined, "linux") as Array<{
        label?: string;
        click?: () => void;
      }>
    ).find((item) => item.label === "● Recording — Stop and Save");
    stop?.click?.();

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "recording:stop",
      {},
      { principal: "ipc" }
    );
  });
});
