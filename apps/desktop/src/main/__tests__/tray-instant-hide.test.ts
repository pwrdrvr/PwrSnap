// The tray popover must vanish INSTANTLY, never fade.
//
// The popover is a macOS `NSPanel` (`type: 'panel'` in
// createTrayWindow — see window.ts for why). AppKit resolves
// `NSWindowAnimationBehaviorDefault` to
// `NSWindowAnimationBehaviorUtilityWindow` for panels, which means
// `[NSWindow orderOut:]` — what `BrowserWindow.hide()` calls — plays a
// ~0.2s fade-out instead of removing the window from the screen on the
// next frame.
//
// That fade lands inside the user's screenshots. Every capture started
// from a tray button hides the popover and then waits a 50ms compositor
// flush before freezing the screen (`hidePwrSnapChromeAndSettle` in
// capture-handlers.ts, and the pre-snapshot hide in region-selector.ts).
// 50ms into a 200ms fade the popover is still ~70% opaque, and the
// region/auto path CROPS THAT FROZEN SNAPSHOT — so a half-dissolved
// PwrSnap popover is alpha-blended into the saved capture. Captures
// taken with the global hotkey (popover never open) look correct, which
// is what makes this read as a compositor mystery rather than an
// animation.
//
// Electron exposes no `animationBehavior` setter, so the fix is to take
// the window to alpha 0 *before* orderOut:. `setAlphaValue:` applies
// immediately (no implicit animation outside an NSAnimationContext), so
// the fade then runs 0 → 0 and paints nothing. Every show path restores
// alpha to 1 first.
//
// Windows is deliberately excluded: there the tray window is
// `transparent: true`, and `setOpacity` drives whole-window layered
// alpha (SetLayeredWindowAttributes), which is mutually exclusive with
// per-pixel alpha (UpdateLayeredWindow) — the same trap documented on
// `parkOffScreen` in float-over.ts. Windows has no NSPanel fade to fix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type FakeWindow = {
  calls: string[];
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  visible: boolean;
  destroyed: boolean;
  devToolsOpen: boolean;
  focused: boolean;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  once: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string) => void;
  setOpacity: (value: number) => void;
  hide: () => void;
  showInactive: () => void;
  focus: () => void;
  isVisible: () => boolean;
  isDestroyed: () => boolean;
  destroy: () => void;
  isFocused: () => boolean;
  setPosition: (x: number, y: number, animate?: boolean) => void;
  setVibrancy: (value: string) => void;
  setMinimumSize: (w: number, h: number) => void;
  setContentSize: (w: number, h: number, animate?: boolean) => void;
  getBounds: () => { x: number; y: number; width: number; height: number };
  webContents: { isDevToolsOpened: () => boolean; zoomFactor: number };
};

function createFakeWindow(): FakeWindow {
  const calls: string[] = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const win: FakeWindow = {
    calls,
    handlers,
    visible: false,
    destroyed: false,
    devToolsOpen: false,
    focused: false,
    on: (event, cb) => {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    once: (event, cb) => {
      win.on(event, cb);
    },
    emit: (event) => {
      for (const cb of handlers.get(event) ?? []) cb();
    },
    // `setOpacity` records its ARGUMENT, not just the call — the whole
    // point of these specs is which value lands and in what order
    // relative to hide()/showInactive().
    setOpacity: (value) => {
      calls.push(`setOpacity(${value})`);
    },
    hide: () => {
      calls.push("hide");
      win.visible = false;
      win.focused = false;
    },
    showInactive: () => {
      calls.push("showInactive");
      win.visible = true;
    },
    focus: () => {
      calls.push("focus");
      win.focused = true;
    },
    isVisible: () => win.visible,
    isDestroyed: () => win.destroyed,
    destroy: () => {
      win.destroyed = true;
      win.visible = false;
    },
    isFocused: () => win.focused,
    setPosition: () => {
      calls.push("setPosition");
    },
    setVibrancy: () => {
      calls.push("setVibrancy");
    },
    setMinimumSize: () => undefined,
    setContentSize: () => undefined,
    getBounds: () => ({ x: 0, y: 0, width: 440, height: 440 }),
    webContents: {
      isDevToolsOpened: () => win.devToolsOpen,
      zoomFactor: 1
    }
  };
  return win;
}

const mocks = vi.hoisted(() => ({
  window: null as ReturnType<typeof Object> | null,
  createTrayWindow: vi.fn(),
  positionTrayWindow: vi.fn(),
  trayHandlers: new Map<string, Array<(...args: unknown[]) => void>>(),
  busDispatch: vi.fn()
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => "/fake/app",
    quit: vi.fn()
  },
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn()
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => ({ template }))
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn()
    }))
  },
  screen: {
    getDisplayMatching: vi.fn(),
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    })),
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 }))
  },
  // A plain `function` (not an arrow) — `installTray` calls `new Tray(icon)`,
  // and an arrow function is not constructible.
  Tray: vi.fn(function TrayMock() {
    return {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const list = mocks.trayHandlers.get(event) ?? [];
        list.push(cb);
        mocks.trayHandlers.set(event, list);
      },
      setToolTip: vi.fn(),
      setTitle: vi.fn(),
      setImage: vi.fn(),
      setIgnoreDoubleClickEvents: vi.fn(),
      getBounds: vi.fn(() => ({ x: 100, y: 0, width: 24, height: 24 })),
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
  getMainLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}));

vi.mock("../recording/recording-state", () => ({
  isRecordingActive: vi.fn(() => false),
  subscribeToRecordingState: vi.fn()
}));

vi.mock("../command-bus", () => ({
  bus: { dispatch: mocks.busDispatch }
}));

import { setRuntimeProcessRole } from "../process-role";
import {
  disposeTray,
  hideTrayPopoverIfVisible,
  installTray,
  prewarmTrayWindow,
  showTrayPopoverForE2E
} from "../tray";

const realPlatform = process.platform;
const realResourcesPath = process.resourcesPath;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true
  });
}

/** `installTray` resolves the menubar icon through `process.resourcesPath`,
 *  which only Electron defines. Give it a string so `join()` doesn't throw. */
function setResourcesPath(value: string | undefined): void {
  Object.defineProperty(process, "resourcesPath", {
    value,
    configurable: true
  });
}

let fake: FakeWindow;

beforeEach(() => {
  vi.useFakeTimers();
  setResourcesPath("/fake/resources");
  disposeTray();
  mocks.trayHandlers.clear();
  mocks.busDispatch.mockReset();
  mocks.positionTrayWindow.mockReset();
  fake = createFakeWindow();
  mocks.createTrayWindow.mockReset();
  mocks.createTrayWindow.mockImplementation(() => fake);
});

afterEach(() => {
  disposeTray();
  vi.useRealTimers();
  setPlatform(realPlatform);
  setResourcesPath(realResourcesPath);
  setRuntimeProcessRole("combined");
});

/** Drop bookkeeping calls so assertions read as visibility transitions. */
function visibilityCalls(win: FakeWindow): string[] {
  return win.calls.filter(
    (c) => c.startsWith("setOpacity") || c === "hide" || c === "showInactive"
  );
}

describe("tray popover dismissal (macOS NSPanel fade)", () => {
  beforeEach(() => {
    setPlatform("darwin");
  });

  test("capture-path dismiss takes the panel to alpha 0 BEFORE orderOut:", () => {
    prewarmTrayWindow();
    showTrayPopoverForE2E();
    fake.calls.length = 0;

    hideTrayPopoverIfVisible();

    // Order is the whole fix: alpha must already be 0 when the fade
    // starts, or the fade renders the popover into the screenshot.
    expect(visibilityCalls(fake)).toEqual(["setOpacity(0)", "hide"]);
  });

  test("re-showing restores alpha to 1 before the panel is ordered in", () => {
    prewarmTrayWindow();
    showTrayPopoverForE2E();
    hideTrayPopoverIfVisible();
    fake.calls.length = 0;

    showTrayPopoverForE2E();

    // Without this the popover comes back invisible — a fully
    // transparent window that still eats clicks.
    expect(visibilityCalls(fake)).toEqual(["setOpacity(1)", "showInactive"]);
  });

  test("blur-dismiss is instant too", () => {
    // A tray button click can blur the popover (the region selector
    // takes key focus) before the capture path's own dismiss runs. If
    // blur-dismiss left a fade in flight, `hideTrayPopoverIfVisible`
    // would see isVisible() === false — AppKit orders the window out
    // at the START of the fade — and skip, leaving the fade to paint
    // itself into the snapshot anyway.
    prewarmTrayWindow();
    showTrayPopoverForE2E();
    fake.calls.length = 0;

    fake.focused = false;
    fake.emit("blur");
    vi.advanceTimersByTime(200);

    expect(visibilityCalls(fake)).toEqual(["setOpacity(0)", "hide"]);
  });

  test("toggling the tray icon closed is instant", () => {
    installTray();
    const click = mocks.trayHandlers.get("click")?.[0];
    expect(click).toBeDefined();
    click!();
    fake.calls.length = 0;

    click!();

    expect(visibilityCalls(fake)).toEqual(["setOpacity(0)", "hide"]);
  });

  test("right-click dismiss is instant", () => {
    installTray();
    mocks.trayHandlers.get("click")![0]!();
    fake.calls.length = 0;

    mocks.trayHandlers.get("right-click")![0]!();

    expect(visibilityCalls(fake)).toEqual(["setOpacity(0)", "hide"]);
  });

  test("double-click dismiss is instant", () => {
    // The double-click handler (open the Library) is only wired outside
    // the single-process `combined` role — see installTray.
    setRuntimeProcessRole("library");
    installTray();
    mocks.trayHandlers.get("click")![0]!();
    fake.calls.length = 0;

    mocks.trayHandlers.get("double-click")![0]!();

    expect(visibilityCalls(fake)).toEqual(["setOpacity(0)", "hide"]);
  });

  test("dismissing an already-hidden popover stays a no-op", () => {
    prewarmTrayWindow();
    fake.calls.length = 0;

    hideTrayPopoverIfVisible();

    expect(visibilityCalls(fake)).toEqual([]);
  });
});

describe("tray popover dismissal (Windows)", () => {
  beforeEach(() => {
    setPlatform("win32");
  });

  test("never touches opacity — transparent windows break under layered alpha", () => {
    prewarmTrayWindow();
    showTrayPopoverForE2E();
    hideTrayPopoverIfVisible();
    showTrayPopoverForE2E();

    expect(fake.calls.filter((c) => c.startsWith("setOpacity"))).toEqual([]);
    expect(visibilityCalls(fake)).toEqual(["showInactive", "hide", "showInactive"]);
  });
});

// The alpha-0 park makes every show path load-bearing: a bare
// `showInactive()` / `show()` on the tray window brings the panel back
// ordered-in and key but at alphaValue 0 — invisible, yet still
// hit-testing, so clicks land on nothing the user can see. That is worse
// than the fade this whole change exists to kill, and no behavioral test
// can catch it because it only fires on a show path that does not exist
// yet.
//
// So grep the source instead. The repo already uses this shape (the
// secret store's "plaintext never appears on disk" assertion). If you
// are adding a new way to open the popover, call `showTrayWindowNow` —
// do not widen this allowlist.
describe("tray.ts source — the show/hide pairing invariant", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../tray.ts", import.meta.url)),
    "utf8"
  );

  test("no show call on the tray window outside showTrayWindowNow", () => {
    const showCalls = [...source.matchAll(/^.*\.(?:showInactive|show)\(\).*$/gm)]
      .map((m) => m[0].trim())
      // The helper itself is the one legitimate caller.
      .filter((line) => !line.startsWith("window.showInactive();"))
      // Prose in comments describes the calls; it doesn't make them.
      .filter((line) => !line.startsWith("//") && !line.startsWith("*"));
    expect(showCalls).toEqual([]);
  });

  test("no hide call on the tray window outside hideTrayWindowNow", () => {
    const hideCalls = [...source.matchAll(/^.*\.hide\(\).*$/gm)]
      .map((m) => m[0].trim())
      .filter((line) => !line.startsWith("window.hide();"))
      .filter((line) => !line.startsWith("//") && !line.startsWith("*"));
    expect(hideCalls).toEqual([]);
  });
});
