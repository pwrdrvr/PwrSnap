// The post-capture toast on Linux, and why it needed its own hide model.
//
// The float-over never called `hide()` off Windows. It pseudo-hid by
// `setOpacity(0)` + `setPosition(-20000, -20000)`, and restored with
// `setOpacity(1)` plus a ONCE-ONLY `showInactive()` guarded by `everShown`.
// On macOS all three of those work and the model is deliberate (a real
// `hide()` there is `[NSWindow orderOut:]`, which cascades key state through
// the focus sink and yanks the caret out of whatever app the user is typing
// in).
//
// On Linux none of it works:
//
//   • `setOpacity` is `@platform win32,darwin`. Measured on Electron 41.10.7
//     under a headless weston AND under xvfb, `getOpacity()` still reports 1
//     after `setOpacity(0)`. It is inert on BOTH Linux backends — so this was
//     never a Wayland-only bug.
//   • `setPosition` is documented "Not supported on Wayland (Linux)", so the
//     other half of the park is inert there too. (It does work on X11, which
//     is why the toast half-worked on an X11 session and not at all on
//     Wayland.)
//   • `everShown` is burned by the region selector's `show-idle`, which
//     pre-shows the toast UNDER the fullscreen selector. By the time
//     `show-loaded` arrives, the once-only `showInactive()` is spent and the
//     two calls left on that path are both no-ops.
//
// So Linux joins Windows on a real `hide()` / `showInactive()` cycle — the
// model Windows already proves — and this file pins the split.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type ClosedListener = () => void;

const mocks = vi.hoisted(() => {
  const windows: Array<ReturnType<typeof createWindow>> = [];
  /** Visibility-relevant calls in order, so a regression shows as a sequence. */
  const calls: string[] = [];

  function createWindow() {
    let destroyed = false;
    let closedListener: ClosedListener | null = null;
    return {
      destroy: vi.fn(() => {
        if (destroyed) return;
        destroyed = true;
        closedListener?.();
      }),
      getContentSize: vi.fn(() => [392, 200] as [number, number]),
      getSize: vi.fn(() => [392, 200] as [number, number]),
      hide: vi.fn(() => calls.push("hide")),
      isAlwaysOnTop: vi.fn(() => true),
      isDestroyed: vi.fn(() => destroyed),
      moveTop: vi.fn(() => calls.push("moveTop")),
      on: vi.fn((event: string, listener: ClosedListener) => {
        if (event === "closed") closedListener = listener;
      }),
      setAlwaysOnTop: vi.fn(() => calls.push("setAlwaysOnTop")),
      setContentSize: vi.fn(),
      setIgnoreMouseEvents: vi.fn(),
      setOpacity: vi.fn((value: number) => calls.push(`setOpacity(${value})`)),
      setPosition: vi.fn((x: number, y: number) => calls.push(`setPosition(${x},${y})`)),
      showInactive: vi.fn(() => calls.push("showInactive")),
      webContents: {
        invalidate: vi.fn(),
        isDestroyed: vi.fn(() => destroyed),
        on: vi.fn(),
        send: vi.fn(),
        zoomFactor: 1
      }
    };
  }

  return {
    calls,
    windows,
    /** Value `app.commandLine.getSwitchValue("ozone-platform")` reports. */
    ozoneSwitch: "",
    createFloatOverWindow: vi.fn(() => {
      const window = createWindow();
      windows.push(window);
      return window;
    }),
    globalShortcut: {
      register: vi.fn(() => true),
      unregister: vi.fn()
    },
    dispatch: vi.fn()
  };
});

vi.mock("electron", () => ({
  app: {
    commandLine: { getSwitchValue: vi.fn(() => mocks.ozoneSwitch) },
    on: vi.fn(),
    removeListener: vi.fn()
  },
  BrowserWindow: Object.assign(vi.fn(), { getFocusedWindow: vi.fn(() => null) }),
  globalShortcut: mocks.globalShortcut,
  ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [
      { id: 1, workArea: { x: 0, y: 0, width: 1440, height: 900 } }
    ]),
    getCursorScreenPoint: vi.fn(() => ({ x: 10, y: 10 })),
    getDisplayNearestPoint: vi.fn(() => ({
      id: 1,
      workArea: { x: 0, y: 0, width: 1440, height: 900 }
    }))
  }
}));

vi.mock("../window", () => ({ createFloatOverWindow: mocks.createFloatOverWindow }));
vi.mock("../command-bus", () => ({ bus: { dispatch: mocks.dispatch } }));
vi.mock("../log", () => ({
  getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}));

import {
  disposeFloatOver,
  floatOverHideModelForPlatform,
  setFloatOverState
} from "../float-over";
import { resetWindowPlacementLogForTests } from "../linux-window-placement";

const realPlatform = process.platform;
const realEnv = { ...process.env };

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Replace the placement-relevant environment wholesale. */
function setSessionEnv(env: Record<string, string | undefined>): void {
  for (const key of [
    "XDG_SESSION_TYPE",
    "WAYLAND_DISPLAY",
    "DISPLAY",
    "ELECTRON_OZONE_PLATFORM_HINT"
  ]) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
}

const WAYLAND = { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" };
const X11 = { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" };

/** Drive a whole capture: pre-show under the selector, then commit. */
function captureCycle(captureId: string): void {
  setFloatOverState({ kind: "show-idle" });
  setFloatOverState({ kind: "show-loaded", captureId });
}

beforeEach(() => {
  disposeFloatOver();
  resetWindowPlacementLogForTests();
  mocks.calls.length = 0;
  mocks.windows.length = 0;
  mocks.ozoneSwitch = "";
  mocks.createFloatOverWindow.mockClear();
  mocks.dispatch.mockReset();
  mocks.dispatch.mockImplementation(async (name: string, request: { id?: string }) =>
    name === "library:byId"
      ? { ok: true, value: { id: request.id, kind: "image" } }
      : { ok: true, value: undefined }
  );
});

afterEach(() => {
  disposeFloatOver();
  setPlatform(realPlatform);
  process.env = { ...realEnv };
});

describe("floatOverHideModelForPlatform", () => {
  test("macOS is the exception; everyone else really hides", () => {
    expect(floatOverHideModelForPlatform("darwin")).toBe("opacity-park");
    expect(floatOverHideModelForPlatform("linux")).toBe("hide");
    expect(floatOverHideModelForPlatform("win32")).toBe("hide");
  });

  test("an unknown platform gets the honest default, not the park", () => {
    // `hide()` has no @platform annotation. A new platform that inherited the
    // park would inherit a toast that never goes away.
    expect(floatOverHideModelForPlatform("freebsd" as NodeJS.Platform)).toBe("hide");
  });
});

describe("Linux — the toast comes back on every capture", () => {
  beforeEach(() => {
    setPlatform("linux");
    setSessionEnv(WAYLAND);
    mocks.ozoneSwitch = "wayland";
  });

  test("a dismissed toast is really hidden, and the NEXT capture shows again", () => {
    captureCycle("capture-1");
    expect(mocks.calls).toContain("showInactive");

    mocks.calls.length = 0;
    setFloatOverState({ kind: "dismiss" });
    // The regression: `setOpacity(0)` + an inert `setPosition` left the toast
    // on screen forever. It has to be a real hide.
    expect(mocks.calls).toEqual(["hide"]);

    mocks.calls.length = 0;
    captureCycle("capture-2");
    // And the once-only `showInactive` guard must not swallow this one — the
    // whole "float-over never appears again" symptom.
    expect(mocks.calls.filter((c) => c === "showInactive").length).toBeGreaterThan(0);
  });

  test("the selector's show-idle does not burn the commit's show", () => {
    // `show-idle` is dispatched from the region selector while the toast is
    // deliberately hidden UNDER the fullscreen selector. Under the old
    // once-only model it spent the single `showInactive()`, so `show-loaded`
    // — the one the user actually needs to see — did nothing.
    setFloatOverState({ kind: "show-idle" });
    mocks.calls.length = 0;
    setFloatOverState({ kind: "show-loaded", captureId: "capture-1" });
    expect(mocks.calls).toContain("showInactive");
  });

  test("never calls setOpacity — it is inert on Linux, so calling it lies", () => {
    captureCycle("capture-1");
    setFloatOverState({ kind: "dismiss" });
    captureCycle("capture-2");
    setFloatOverState({ kind: "cancel" });
    expect(mocks.calls.filter((c) => c.startsWith("setOpacity"))).toEqual([]);
  });

  test("cancel hides too — Esc out of the selector must not strand a toast", () => {
    setFloatOverState({ kind: "show-idle" });
    mocks.calls.length = 0;
    setFloatOverState({ kind: "cancel" });
    expect(mocks.calls).toEqual(["hide"]);
  });
});

describe("Linux — placement is attempted only where it can work", () => {
  test("Wayland: the corner is NOT applied, because it cannot be", () => {
    setPlatform("linux");
    setSessionEnv(WAYLAND);
    mocks.ozoneSwitch = "wayland";
    captureCycle("capture-1");
    // `setPosition` is documented inert on Wayland. Calling it anyway would
    // read as a placement that works.
    expect(mocks.calls.filter((c) => c.startsWith("setPosition"))).toEqual([]);
  });

  test("X11: the bottom-right corner IS applied", () => {
    setPlatform("linux");
    setSessionEnv(X11);
    mocks.ozoneSwitch = "x11";
    captureCycle("capture-1");
    // 1440x900 work area, 392x200 window, 24px margin.
    expect(mocks.calls).toContain("setPosition(1024,676)");
  });

  test("XWayland — a Wayland session driving the X11 backend — still places", () => {
    // The case that makes the switch authoritative rather than the session
    // type: this process CAN position its windows.
    setPlatform("linux");
    setSessionEnv(WAYLAND);
    mocks.ozoneSwitch = "x11";
    captureCycle("capture-1");
    expect(mocks.calls).toContain("setPosition(1024,676)");
  });
});

describe("the popover platforms are untouched", () => {
  test("macOS keeps the opacity park and the once-only show", () => {
    setPlatform("darwin");
    setSessionEnv({});
    captureCycle("capture-1");
    const firstShows = mocks.calls.filter((c) => c === "showInactive").length;
    expect(firstShows).toBe(1);
    expect(mocks.calls).toContain("setOpacity(1)");

    mocks.calls.length = 0;
    setFloatOverState({ kind: "dismiss" });
    // Park, never hide — a real hide() here cascades key state through the
    // focus sink and steals the caret from the user's foreground app.
    expect(mocks.calls).toEqual(["setOpacity(0)", "setPosition(-20000,-20000)"]);

    mocks.calls.length = 0;
    captureCycle("capture-2");
    expect(mocks.calls.filter((c) => c === "showInactive")).toEqual([]);
  });

  test("Windows keeps hide/show and never touches opacity", () => {
    setPlatform("win32");
    setSessionEnv({});
    captureCycle("capture-1");
    setFloatOverState({ kind: "dismiss" });
    captureCycle("capture-2");
    // setOpacity drives layered alpha on Windows, which is mutually exclusive
    // with a transparent window's per-pixel alpha — it comes back BLANK.
    expect(mocks.calls.filter((c) => c.startsWith("setOpacity"))).toEqual([]);
    expect(mocks.calls).toContain("hide");
    expect(mocks.calls).toContain("setAlwaysOnTop");
    // And never moveTop: on Windows that clears WS_EX_TOPMOST and drops the
    // toast back under the Library.
    expect(mocks.calls).not.toContain("moveTop");
  });
});
